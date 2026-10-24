
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use telium_protocol::media_feed::Action;

fn cache_path(state: &AppState, origin: &str, hash: &str) -> std::path::PathBuf {
    let key = blake3::hash(format!("{origin}/{hash}").as_bytes())
        .to_hex()
        .to_string();
    state.cfg.media_dir.join("cache").join(&key[0..2]).join(key)
}

static REMOTE_FETCHES: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();

const CONCURRENT_REMOTE_FETCHES: usize = 6;

fn remote_fetches() -> &'static tokio::sync::Semaphore {
    REMOTE_FETCHES.get_or_init(|| tokio::sync::Semaphore::new(CONCURRENT_REMOTE_FETCHES))
}

const REMOTE_FETCH_ORIGIN_BURST: f64 = 32.0;

const REMOTE_FETCH_ORIGIN_PER_SEC: f64 = 2.0;

const CACHE_SHARE_DENOMINATOR: i64 = 4;

pub fn voucher_claims(
    issuer: &str,
    guild_id: &str,
    user_id: &str,
    origin: &str,
    max_bytes: i64,
    ttl_secs: i64,
) -> Value {
    let now = now_ms();
    json!({
        "kind": "media_voucher",
        "guild_id": guild_id,
        "issuer": issuer,
        "user_id": user_id,
        "audience": origin,
        "max_bytes": max_bytes,
        "iat": now,
        "exp": now + ttl_secs * 1000,
    })
}

#[derive(Deserialize)]
pub struct VoucherRequest {
    pub guild_id: String,
    pub origin: String,
    #[serde(default)]
    pub max_bytes: Option<i64>,
}

pub async fn issue_voucher(
    State(state): State<AppState>,
    auth: crate::auth::GuildAuth,
    Json(req): Json<VoucherRequest>,
) -> ApiResult<Json<Value>> {
    crate::guildstore::membership(&state, &req.guild_id, &auth.user_id).await?;
    super::ensure_reachable(&state, &req.origin, "media").await?;
    check_origin_allowed(&state, &req.guild_id, &req.origin).await?;

    let max_bytes = req
        .max_bytes
        .unwrap_or(state.cfg.media_policy.max_file_bytes as i64)
        .min(state.cfg.media_policy.max_file_bytes as i64);
    let claims = voucher_claims(
        &state.cfg.server_name,
        &req.guild_id,
        &auth.user_id,
        &req.origin,
        max_bytes,
        300,
    );
    let signed = crate::crypto::sign_json(&state.key, claims);

    sqlx::query(
        "INSERT INTO media_vouchers (id, guild_id, user_id, origin, hash, created_at, expires_at) \
         VALUES (?, ?, ?, ?, '', ?, ?)",
    )
    .bind(ulid())
    .bind(&req.guild_id)
    .bind(&auth.user_id)
    .bind(&req.origin)
    .bind(now_ms())
    .bind(now_ms() + 300_000)
    .execute(&state.pool)
    .await?;

    Ok(Json(
        json!({ "voucher": signed, "issuer": state.cfg.server_name }),
    ))
}

pub async fn verify_voucher(state: &AppState, voucher: &Value, size: i64) -> ApiResult<String> {
    let issuer = voucher
        .get("issuer")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("voucher names no issuer".into()))?
        .to_string();
    let key_id = voucher
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("voucher is unsigned".into()))?;
    let public = super::verify_key(state, &issuer, key_id)
        .await
        .ok_or_else(|| ApiError::Unauthorized(format!("no key {key_id} for {issuer}")))?;
    if !crate::crypto::verify_json(&public, voucher) {
        return Err(ApiError::Unauthorized(
            "voucher signature is invalid".into(),
        ));
    }
    if voucher.get("audience").and_then(Value::as_str) != Some(state.cfg.server_name.as_str()) {
        return Err(ApiError::Unauthorized(
            "voucher was issued for another origin".into(),
        ));
    }
    if voucher.get("exp").and_then(Value::as_i64).unwrap_or(0) <= now_ms() {
        return Err(ApiError::Unauthorized("voucher has expired".into()));
    }
    if size
        > voucher
            .get("max_bytes")
            .and_then(Value::as_i64)
            .unwrap_or(0)
    {
        return Err(ApiError::TooLarge(
            "upload exceeds the voucher's budget".into(),
        ));
    }
    voucher
        .get("user_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| ApiError::BadRequest("voucher names no user".into()))
}

#[derive(Deserialize)]
pub struct AuthorizeRequest {
    pub hash: String,
    #[serde(default)]
    pub capability: Option<String>,
    #[serde(default)]
    pub guild_id: Option<String>,
}

pub async fn authorize(
    State(state): State<AppState>,
    fed: super::Fed<AuthorizeRequest>,
) -> ApiResult<Json<Value>> {
    let row: Option<(
        String,
        String,
        i64,
        String,
        Option<i64>,
        Option<i64>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT capability, mime, size, purpose, width, height, thumbhash \
             FROM media WHERE hash = ?",
    )
    .bind(&fed.body.hash)
    .fetch_optional(&state.pool)
    .await?;
    let Some((capability, mime, size, purpose, width, height, thumbhash)) = row else {
        return Ok(Json(json!({ "ok": false, "reason": "unknown" })));
    };
    let public = purpose == "expression";
    if !public && fed.body.capability.as_deref() != Some(capability.as_str()) {
        return Ok(Json(json!({ "ok": false, "reason": "unauthorized" })));
    }
    Ok(Json(json!({
        "ok": true,
        "origin": state.cfg.server_name,
        "hash": fed.body.hash,
        "mime": mime,
        "size": size,
        "width": width,
        "height": height,
        "thumbhash": thumbhash,
        "public": public,
        "asked_by": fed.origin,
    })))
}

pub async fn check_origin_allowed(state: &AppState, guild_id: &str, origin: &str) -> ApiResult<()> {
    if super::is_defederated(state, origin, "media").await {
        return Err(ApiError::Forbidden(format!(
            "{origin} is defederated from this server"
        )));
    }
    if origin == state.cfg.server_name {
        return Ok(());
    }
    let key = super::normalise_origin(origin);
    let policy: Option<String> =
        sqlx::query_scalar("SELECT origin_policy FROM guilds WHERE id = ?")
            .bind(guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let policy = policy.unwrap_or_else(|| "open".into());
    let rule: Option<String> = sqlx::query_scalar(
        "SELECT action FROM guild_origin_rules \
         WHERE guild_id = ? AND domain = ? AND feed_url IS NULL",
    )
    .bind(guild_id)
    .bind(&key)
    .fetch_optional(&state.pool)
    .await?;
    let decision = match rule.as_deref() {
        Some("block") => Some(Action::Block),
        Some(_) => Some(Action::Allow),
        None => super::media_feeds::verdict(state, guild_id, &key).await?,
    };

    match (policy.as_str(), decision) {
        (_, Some(Action::Block)) if rule.is_some() => Err(ApiError::Forbidden(format!(
            "this guild does not accept media from {origin}; upload to an origin it accepts, \
             or ask a moderator to allow this one"
        ))),
        (_, Some(Action::Block)) => Err(ApiError::Forbidden(format!(
            "a media origin feed this guild subscribes to blocks {origin}; upload to an origin \
             it accepts, or ask a moderator to allow this one by name"
        ))),
        ("allowlist", Some(Action::Allow)) | ("blocklist", _) | ("open", _) => Ok(()),
        ("allowlist", _) => Err(ApiError::Forbidden(format!(
            "this guild only accepts media from approved origins, and {origin} is not one; \
             upload to an approved origin, or ask a moderator to add this one"
        ))),
        _ => Ok(()),
    }
}

#[derive(Deserialize)]
pub struct RemoteParams {
    #[serde(default)]
    pub cap: Option<String>,
}

pub async fn fetch_remote(
    State(state): State<AppState>,
    Path((origin, hash)): Path<(String, String)>,
    Query(params): Query<RemoteParams>,
) -> ApiResult<Response> {
    if !crate::routes::media::valid_hash(&hash) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    if origin == state.cfg.server_name {
        return crate::routes::media::fetch(
            State(state),
            Path(hash),
            HeaderMap::new(),
            Query(crate::routes::media::FetchParams { cap: params.cap }),
        )
        .await;
    }
    super::ensure_reachable(&state, &origin, "media").await?;

    let path = cache_path(&state, &origin, &hash);
    let cached: Option<(String, i64)> =
        sqlx::query_as("SELECT mime, expires_at FROM media_cache WHERE origin = ? AND hash = ?")
            .bind(&origin)
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await?;

    if let Some((mime, expires_at)) = cached {
        if expires_at > now_ms() {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                sqlx::query("UPDATE media_cache SET hits = hits + 1 WHERE origin = ? AND hash = ?")
                    .bind(&origin)
                    .bind(&hash)
                    .execute(&state.pool)
                    .await?;
                return Ok(serve(bytes, &mime));
            }
        }
    }

    // Rate budget before the concurrency permit, so an over-budget caller never holds a slot.
    if let Err(retry) = state.limiter.take(
        format!("remote-media-origin:{origin}"),
        "remote-media-origin",
        REMOTE_FETCH_ORIGIN_BURST,
        REMOTE_FETCH_ORIGIN_PER_SEC,
    ) {
        return Err(ApiError::RateLimited(format!(
            "too many uncached objects have been asked for from {origin}; \
             try again in {retry:.0}s"
        )));
    }
    // `try_acquire`: a full pool answers instead of queueing.
    let _permit = remote_fetches().try_acquire().map_err(|_| {
        ApiError::RateLimited(
            "this server is already fetching as much remote media as it will at once; \
             try again shortly"
                .into(),
        )
    })?;

    let query = params.cap.as_ref().map(|c| format!("cap={c}"));
    // +1 so the policy check below can refuse an oversized object by name.
    let ceiling = state.cfg.media_policy.max_file_bytes.saturating_add(1);
    let (bytes, mime, status) = super::get_signed_bytes_capped(
        &state,
        &origin,
        &format!("/_telium/v1/media/{hash}"),
        query.as_deref(),
        ceiling,
    )
    .await?;
    if status == 404 {
        purge_local(&state, &origin, &hash).await?;
        return Err(ApiError::NotFound("no such media".into()));
    }
    if !(200..300).contains(&status) {
        return Err(ApiError::BadRequest(format!("{origin} refused the object")));
    }
    if bytes.len() > state.cfg.media_policy.max_file_bytes {
        return Err(ApiError::TooLarge(
            "remote object exceeds this server's cache limit".into(),
        ));
    }
    // Verifying the origin's hash prevents cache poisoning.
    let actual = blake3::hash(&bytes).to_hex().to_string();
    if actual != hash {
        return Err(ApiError::BadRequest(format!(
            "{origin} returned bytes that are not {hash}"
        )));
    }

    if origin_has_room(&state, &origin, bytes.len() as i64).await? {
        if let Err(e) = crate::objectstore::write_atomically(&path, &bytes).await {
            tracing::warn!(target: crate::logcat::MEDIA, %origin, %hash, error = %e, "could not cache a foreign media object");
        }
        sqlx::query(
            "INSERT INTO media_cache (origin, hash, mime, size, fetched_at, expires_at, hits) \
             VALUES (?, ?, ?, ?, ?, ?, 1) \
             ON CONFLICT(origin, hash) DO UPDATE SET mime = excluded.mime, size = excluded.size, \
                 fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, hits = hits + 1",
        )
        .bind(&origin)
        .bind(&hash)
        .bind(&mime)
        .bind(bytes.len() as i64)
        .bind(now_ms())
        .bind(now_ms() + state.cfg.federation.media_cache_ttl_secs * 1000)
        .execute(&state.pool)
        .await?;
    } else {
        tracing::debug!(
            target: crate::logcat::MEDIA,
            %origin,
            bytes = bytes.len(),
            "serving a remote object without caching it: the origin is at its share of the cache"
        );
    }

    Ok(serve(bytes, &mime))
}

async fn origin_has_room(state: &AppState, origin: &str, incoming: i64) -> ApiResult<bool> {
    let share = state.cfg.federation.media_cache_max_bytes / CACHE_SHARE_DENOMINATOR;
    if share <= 0 {
        return Ok(false);
    }
    let held: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size), 0) FROM media_cache WHERE origin = ?")
            .bind(origin)
            .fetch_one(&state.pool)
            .await?;
    Ok(held + incoming <= share)
}

fn serve(bytes: Vec<u8>, mime: &str) -> Response {
    let mime = crate::routes::media::sanitize_mime("attachment", mime);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        mime.parse()
            .unwrap_or(header::HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=86400"),
    );
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    // Backstop: `sandbox` puts the response in an opaque origin.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    (StatusCode::OK, headers, bytes).into_response()
}

#[derive(Deserialize)]
pub struct PurgeRequest {
    pub hash: String,
}

pub async fn purge(
    State(state): State<AppState>,
    fed: super::Fed<PurgeRequest>,
) -> ApiResult<Json<Value>> {
    purge_local(&state, &fed.origin, &fed.body.hash).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn purge_local(state: &AppState, origin: &str, hash: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM media_cache WHERE origin = ? AND hash = ?")
        .bind(origin)
        .bind(hash)
        .execute(&state.pool)
        .await?;
    let _ = tokio::fs::remove_file(cache_path(state, origin, hash)).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct MovedNotice {
    pub new_origin: String,
    pub hashes: Vec<String>,
    #[serde(default)]
    pub owner: String,
}

pub async fn moved(
    State(state): State<AppState>,
    fed: super::Fed<MovedNotice>,
) -> ApiResult<Json<Value>> {
    let rewritten = crate::migration::media::apply_move_notice(
        &state,
        &fed.origin,
        &fed.body.new_origin,
        &fed.body.hashes,
    )
    .await?;
    Ok(Json(json!({ "ok": true, "messages_rewritten": rewritten })))
}

#[derive(Deserialize)]
pub struct MovedListRequest {
    pub owner: String,
    #[serde(default)]
    pub hashes: Vec<String>,
}

pub async fn moved_list(
    State(state): State<AppState>,
    fed: super::Fed<MovedListRequest>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        crate::migration::media::moved_list(&state, &fed.body.owner, &fed.body.hashes).await?,
    ))
}

const CONCURRENT_PURGE_NOTICES: usize = 8;

pub async fn broadcast_purge(state: &AppState, hash: &str) {
    let peers: Vec<String> = sqlx::query_scalar("SELECT origin FROM remote_servers")
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
    let state = state.clone();
    let hash = hash.to_string();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        futures_util::stream::iter(peers)
            .for_each_concurrent(CONCURRENT_PURGE_NOTICES, |peer| {
                let state = state.clone();
                let hash = hash.clone();
                async move {
                    let _ = super::post_signed(
                        &state,
                        &peer,
                        "/_telium/v1/media/purge",
                        &json!({ "hash": hash }),
                    )
                    .await;
                }
            })
            .await;
    });
}

pub async fn sweep_cache(state: &AppState) -> ApiResult<u64> {
    let expired: Vec<(String, String)> =
        sqlx::query_as("SELECT origin, hash FROM media_cache WHERE expires_at <= ?")
            .bind(now_ms())
            .fetch_all(&state.pool)
            .await?;
    let mut n = expired.len() as u64;
    for (origin, hash) in expired {
        purge_local(state, &origin, &hash).await?;
    }
    n += sweep_over_budget(state).await?;
    Ok(n)
}

async fn sweep_over_budget(state: &AppState) -> ApiResult<u64> {
    let budget = state.cfg.federation.media_cache_max_bytes;
    let mut total: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(size), 0) FROM media_cache")
        .fetch_one(&state.pool)
        .await?;
    if total <= budget {
        return Ok(0);
    }
    let candidates: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT m.origin, m.hash, m.size FROM media_cache m \
         JOIN (SELECT origin, SUM(size) AS total FROM media_cache GROUP BY origin) t \
           ON t.origin = m.origin \
         ORDER BY t.total DESC, m.origin, m.hits ASC, m.fetched_at ASC",
    )
    .fetch_all(&state.pool)
    .await?;
    let mut evicted = 0;
    for (origin, hash, size) in candidates {
        if total <= budget {
            break;
        }
        purge_local(state, &origin, &hash).await?;
        total -= size;
        evicted += 1;
    }
    if evicted > 0 {
        tracing::info!(
            target: crate::logcat::MEDIA,
            evicted,
            budget,
            "evicted cached remote media to stay inside the cache budget"
        );
    }
    Ok(evicted)
}

pub async fn voucher_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let voucher_b64 = headers
        .get("x-telium-voucher")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Unauthorized("this origin requires a voucher".into()))?;
    let voucher: Value = crate::util::unb64(voucher_b64)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or_else(|| ApiError::BadRequest("voucher is not base64 JSON".into()))?;
    let user_id = verify_voucher(&state, &voucher, body.len() as i64).await?;
    let purpose = headers
        .get("x-telium-purpose")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("attachment");
    if !["attachment", "profile"].contains(&purpose) {
        return Err(ApiError::BadRequest(
            "voucher purpose must be attachment or profile".into(),
        ));
    }
    crate::routes::media::store_bytes(&state, &user_id, purpose, &headers, body)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::serve;
    use axum::http::header;

    #[test]
    fn a_peers_content_type_cannot_make_our_origin_serve_a_document() {
        for (claimed, served) in [
            ("TEXT/HTML; charset=utf-8", "application/octet-stream"),
            ("image/svg+xml", "application/octet-stream"),
            ("application/javascript", "application/octet-stream"),
            ("image/png", "image/png"),
        ] {
            let response = serve(b"<script></script>".to_vec(), claimed);
            let h = response.headers();
            assert_eq!(h[header::CONTENT_TYPE], served, "{claimed:?}");
            assert_eq!(h[header::CONTENT_SECURITY_POLICY], "default-src 'none'; sandbox");
            assert_eq!(h["x-content-type-options"], "nosniff");
        }
    }
}
