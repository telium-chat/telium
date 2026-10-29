
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, now_ms, random_token};
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use ed25519_dalek::Signer;
use serde::Deserialize;
use serde_json::{json, Value};

const PUBLIC_PURPOSES: &[&str] = &["expression"];

pub fn media_path(state: &AppState, hash: &str) -> std::path::PathBuf {
    state.cfg.media_dir.join(&hash[0..2]).join(hash)
}

pub fn media_key(state: &AppState, hash: &str) -> String {
    media_path(state, hash).to_string_lossy().to_string()
}

pub(crate) fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn sanitize_mime(purpose: &str, claimed: &str) -> String {
    let base = claimed.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match purpose {
        "profile" | "expression" => match base.as_str() {
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif" => base,
            _ => "image/png".into(),
        },
        _ => {
            const SAFE_PREFIXES: &[&str] = &["audio/", "video/"];
            const SAFE_EXACT: &[&str] = &[
                "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif",
                "image/bmp", "image/x-icon", "application/pdf", "application/octet-stream",
                "text/plain",
            ];
            if SAFE_PREFIXES.iter().any(|p| base.starts_with(p)) || SAFE_EXACT.contains(&base.as_str()) {
                base
            } else {
                "application/octet-stream".into()
            }
        }
    }
}

pub fn requested_ttl(headers: &HeaderMap) -> ApiResult<Option<i64>> {
    match header_str(headers, "x-telium-ttl-secs") {
        None => Ok(None),
        Some(raw) => {
            let secs: i64 = raw
                .parse()
                .map_err(|_| ApiError::BadRequest("x-telium-ttl-secs must be an integer".into()))?;
            if secs <= 0 {
                return Err(ApiError::BadRequest("x-telium-ttl-secs must be positive".into()));
            }
            if secs > 366 * 24 * 60 * 60 {
                return Err(ApiError::BadRequest("x-telium-ttl-secs is over a year".into()));
            }
            Ok(Some(secs))
        }
    }
}

/// The narrowest expiry ceiling the destination imposes, and whether the
/// destination lives on this server at all. `local` is what makes message
/// references here authoritative for reclamation: an upload aimed at a channel
/// or guild that exists here will be referenced by rows this server owns, while
/// a tier-2 or external upload keeps its reference record wherever the bytes
/// were asked for.
async fn destination_limit(state: &AppState, headers: &HeaderMap) -> ApiResult<(Option<i64>, bool)> {
    let mut limit = state.cfg.media_policy.max_expiry_secs.non_zero();
    if let Some(channel_id) = header_str(headers, "x-telium-channel-id") {
        let row: Option<(Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT c.media_expiry_limit_secs, g.media_expiry_limit_secs \
             FROM channels c JOIN guilds g ON g.id = c.guild_id WHERE c.id = ?",
        )
        .bind(&channel_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some((channel_secs, guild_secs)) = row {
            limit = narrowest(limit, channel_secs);
            limit = narrowest(limit, guild_secs);
            return Ok((limit, true));
        }
    } else if let Some(guild_id) = header_str(headers, "x-telium-guild-id") {
        let guild_secs: Option<Option<i64>> =
            sqlx::query_scalar("SELECT media_expiry_limit_secs FROM guilds WHERE id = ?")
                .bind(&guild_id)
                .fetch_optional(&state.pool)
                .await?;
        if let Some(guild_secs) = guild_secs {
            return Ok((narrowest(limit, guild_secs), true));
        }
    }
    Ok((limit, false))
}

fn narrowest(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    }
}

fn earlier_of(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        _ => None.or(a).or(b),
    }
}

trait NonZeroExt {
    fn non_zero(self) -> Option<i64>;
}
impl NonZeroExt for i64 {
    fn non_zero(self) -> Option<i64> {
        (self > 0).then_some(self)
    }
}

fn expires_at_from(now: i64, ttl_secs: Option<i64>, limits: &[Option<i64>]) -> Option<i64> {
    let effective = limits.iter().fold(ttl_secs, |acc, l| narrowest(acc, *l));
    effective.map(|secs| now + secs * 1000)
}

pub async fn upload(
    State(state): State<AppState>,
    auth: HomeAuth,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if !state.cfg.roles.media {
        return Err(ApiError::Forbidden("this server does not host media".into()));
    }
    let purpose = header_str(&headers, "x-telium-purpose").unwrap_or_else(|| "attachment".into());
    if !["attachment", "profile", "expression"].contains(&purpose.as_str()) {
        return Err(ApiError::BadRequest("purpose must be attachment, profile or expression".into()));
    }
    enforce_media_policy(&state, &auth.user_id, &purpose, body.len() as i64).await?;
    Ok(Json(store_bytes(&state, &auth.user_id, &purpose, &headers, body).await?))
}

pub async fn store_bytes(
    state: &AppState,
    user_id: &str,
    purpose: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> ApiResult<Value> {
    if body.is_empty() {
        return Err(ApiError::BadRequest("empty upload".into()));
    }
    if body.len() > state.cfg.media_policy.max_file_bytes {
        return Err(ApiError::TooLarge(format!(
            "file exceeds this origin's limit of {} bytes",
            state.cfg.media_policy.max_file_bytes
        )));
    }
    if purpose == "profile" && body.len() > state.cfg.media_policy.max_profile_asset_bytes {
        return Err(ApiError::TooLarge(format!(
            "profile assets are capped at {} bytes; crop or downscale it first",
            state.cfg.media_policy.max_profile_asset_bytes
        )));
    }

    let hash = blake3::hash(&body).to_hex().to_string();
    crate::scan::screen_upload(state, user_id, &hash, &body).await?;
    let filename = header_str(headers, "x-telium-filename")
        .map(|raw| decode_filename(&raw))
        .unwrap_or_else(|| hash.clone());
    let claimed_mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream");
    let mime = sanitize_mime(purpose, claimed_mime);

    let existing: Option<(String, String, Option<i64>)> =
        sqlx::query_as("SELECT capability, owner_user_id, expires_at FROM media WHERE hash = ?")
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await?;

    let ttl = requested_ttl(headers)?;
    let (destination, local_dest) = destination_limit(state, headers).await?;
    let expires_at = expires_at_from(now_ms(), ttl, &[destination]);

    let capability = match existing {
        Some((capability, _, existing_expires)) => {
            sqlx::query("UPDATE media SET refcount = refcount + 1 WHERE hash = ?")
                .bind(&hash)
                .execute(&state.pool)
                .await?;
            let settled = earlier_of(existing_expires, expires_at);
            if settled != existing_expires {
                sqlx::query("UPDATE media SET expires_at = ? WHERE hash = ?")
                    .bind(settled)
                    .bind(&hash)
                    .execute(&state.pool)
                    .await?;
            }
            capability
        }
        None => {
            let capability = random_token(24);
            let key = media_key(state, &hash);
            state.media_store.put(&key, body.to_vec()).await?;

            sqlx::query(
                "INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, \
                 thumbhash, capability, purpose, created_at, expires_at, refs, local_dest) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            )
            .bind(&hash)
            .bind(user_id)
            .bind(&filename)
            .bind(&mime)
            .bind(body.len() as i64)
            .bind(header_i64(headers, "x-telium-width"))
            .bind(header_i64(headers, "x-telium-height"))
            .bind(header_str(headers, "x-telium-thumbhash"))
            .bind(&capability)
            .bind(purpose)
            .bind(now_ms())
            .bind(expires_at)
            .bind(local_dest)
            .execute(&state.pool)
            .await?;
            capability
        }
    };

    crate::metrics::Metrics::bump(&state.metrics.media_uploads, 1);
    crate::metrics::Metrics::bump(&state.metrics.media_upload_bytes, body.len() as u64);

    Ok(reference_json(
        state, &hash, &capability, &filename, &mime, body.len() as i64, expires_at, headers,
    ))
}

/// Claims one live reference on each local media row named by a message's
/// attachments. Runs in the transaction that inserts the message, so a message
/// and its references commit together. Rows for other origins do not exist
/// here and are skipped; entries without a hash (external hosts) match nothing.
pub async fn claim_message_refs(
    exec: &mut sqlx::SqliteConnection,
    attachments: &str,
) -> ApiResult<()> {
    let parsed: Value = match serde_json::from_str(attachments) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(()),
    };
    let Some(entries) = parsed.as_array() else { return Ok(()) };
    for entry in entries {
        let Some(hash) = entry.get("hash").and_then(Value::as_str) else { continue };
        if !valid_hash(hash) {
            continue;
        }
        sqlx::query("UPDATE media SET refs = refs + 1 WHERE hash = ?")
            .bind(hash)
            .execute(&mut *exec)
            .await?;
    }
    Ok(())
}

/// Releases the references held by every message matched by `predicate`, which
/// is a compile-time constant at each call site and carries exactly one `?`
/// placeholder for `bind`. Must run in the same transaction that deletes or
/// blanks those rows, before it does: the release reads `attachments` out of
/// the rows it is about to lose. Cold-archived history is not released — its
/// segments still serve the attachment.
pub async fn release_message_refs(
    exec: &mut sqlx::SqliteConnection,
    predicate: &str,
    bind: &str,
) -> ApiResult<()> {
    let sql = format!(
        "UPDATE media SET refs = MAX(refs - 1, 0) WHERE hash IN (\
         SELECT json_extract(value, '$.hash') FROM messages, json_each(messages.attachments) \
         WHERE {predicate} AND json_valid(messages.attachments) \
         AND json_type(value) = 'object' AND json_extract(value, '$.hash') IS NOT NULL)"
    );
    sqlx::query(&sql).bind(bind).execute(exec).await?;
    Ok(())
}

fn reference_json(
    state: &AppState,
    hash: &str,
    capability: &str,
    filename: &str,
    mime: &str,
    size: i64,
    expires_at: Option<i64>,
    headers: &HeaderMap,
) -> Value {
    json!({
        "reference": format!("media://{}/{}", state.cfg.server_name, hash),
        "origin": state.cfg.server_name,
        "hash": hash,
        "capability": capability,
        "url": format!("{}/_telium/v1/media/{}?cap={}", state.cfg.public_base_url, hash, capability),
        "filename": filename,
        "mime": mime,
        "size": size,
        "expires_at": expires_at,
        "width": header_i64(headers, "x-telium-width"),
        "height": header_i64(headers, "x-telium-height"),
        "thumbhash": header_str(headers, "x-telium-thumbhash"),
    })
}

pub(crate) async fn enforce_media_policy(
    state: &AppState,
    user_id: &str,
    purpose: &str,
    incoming: i64,
) -> ApiResult<()> {
    let quota = state.cfg.media_quota_for(user_id);

    if quota.is_none() {
        let carveout = state.cfg.media_policy.profile_asset_carveout_bytes;
        if purpose == "profile" && carveout > 0 {
            let used: i64 = sqlx::query_scalar(
                "SELECT COALESCE(SUM(size), 0) FROM media WHERE owner_user_id = ? AND purpose = 'profile'",
            )
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
            if used + incoming <= carveout {
                return Ok(());
            }
            return Err(ApiError::TooLarge(
                "profile asset carveout exhausted; use a tier-2 origin".into(),
            ));
        }
        return Err(ApiError::Forbidden(
            "tier-1 uploads are disabled for this account on this server; \
             configure a media origin (see /_telium/v1/capabilities)"
                .into(),
        ));
    }

    let quota = quota.expect("checked above");
    if quota == i64::MAX {
        return Ok(());
    }
    let used: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size), 0) FROM media WHERE owner_user_id = ?")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    if used + incoming > quota {
        return Err(ApiError::TooLarge(format!(
            "media quota exhausted ({used} of {quota} bytes used)"
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct PreferenceInput {
    pub tier: i64,
    #[serde(default)]
    pub origin: Option<String>,
}

pub async fn get_preference(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let row: Option<(i64, Option<String>, i64)> =
        sqlx::query_as("SELECT tier, origin, updated_at FROM media_preferences WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await?;
    let (tier, origin, updated_at) = row.unwrap_or((1, None, 0));
    Ok(Json(json!({ "tier": tier, "origin": origin, "updated_at": updated_at })))
}

pub async fn set_preference(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<PreferenceInput>,
) -> ApiResult<Json<Value>> {
    if !(1..=3).contains(&req.tier) {
        return Err(ApiError::BadRequest("tier must be 1, 2 or 3".into()));
    }
    let origin = match req.tier {
        2 => {
            let origin = req.origin.unwrap_or_default().trim().to_lowercase();
            if origin.is_empty() {
                return Err(ApiError::BadRequest("tier 2 needs an origin".into()));
            }
            if origin.contains('/') || origin.contains(char::is_whitespace) {
                return Err(ApiError::BadRequest("origin must be a domain, not a URL".into()));
            }
            Some(origin)
        }
        _ => None,
    };

    sqlx::query(
        "INSERT INTO media_preferences (user_id, tier, origin, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id) DO UPDATE SET tier = excluded.tier, origin = excluded.origin, \
         updated_at = excluded.updated_at",
    )
    .bind(&auth.user_id)
    .bind(req.tier)
    .bind(&origin)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "tier": req.tier, "origin": origin, "updated_at": now_ms() })))
}

pub async fn registry(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let hosts: Vec<Value> = state
        .cfg
        .media_registry
        .hosts
        .iter()
        .map(|h| {
            json!({
                "origin": h.origin,
                "name": if h.name.is_empty() { &h.origin } else { &h.name },
                "description": h.description,
                "max_file_bytes": h.max_file_bytes,
                "abuse_contact": h.abuse_contact,
            })
        })
        .collect();
    let external_hosts: Vec<Value> = state
        .cfg
        .media_registry
        .external_hosts
        .iter()
        .filter(|h| h.provider.eq_ignore_ascii_case("gofile"))
        .map(|h| {
            json!({
                "id": h.id,
                "provider": h.provider,
                "name": if h.name.is_empty() { &h.id } else { &h.name },
                "domain": h.domain,
                "upload_url": h.upload_url,
                "description": h.description,
                "max_file_bytes": h.max_file_bytes,
                "browser_direct": h.browser_direct_enabled(),
            })
        })
        .collect();
    Ok(Json(json!({
        "hosts": hosts,
        "external_hosts": external_hosts,
        "gofile_playback_proxy": state.cfg.media_registry.gofile_playback_proxy,
        "watch_together": {
            "enabled": state.cfg.media_registry.watch_together.enabled,
            "providers": state.cfg.media_registry.watch_together.providers,
        },
        "feed": crate::federation::media_feeds::published_at(&state).await?,
        "directory": crate::federation::curators::published_at(&state).await?,
    })))
}

pub async fn registry_feed(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(crate::federation::media_feeds::publish(&state).await?))
}

pub async fn curator_directory(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(crate::federation::curators::publish(&state).await?))
}

pub async fn registry_feed_hosts(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let hosts = crate::federation::media_feeds::vouched_hosts(&state, &auth.user_id).await?;
    Ok(Json(json!({ "hosts": hosts })))
}

pub async fn external_upload(
    State(state): State<AppState>,
    _auth: HomeAuth,
    Path(host_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if body.is_empty() {
        return Err(ApiError::BadRequest("empty upload".into()));
    }

    let host = state
        .cfg
        .media_registry
        .external_hosts
        .iter()
        .find(|host| host.id == host_id)
        .cloned()
        .ok_or_else(|| ApiError::NotFound("no such external upload host".into()))?;

    if let Some(max) = host.max_file_bytes {
        if body.len() as i64 > max {
            return Err(ApiError::TooLarge(format!(
                "{} accepts files up to {} bytes",
                host.name, max
            )));
        }
    }

    let filename = header_str(&headers, "x-telium-filename")
        .map(|raw| decode_filename(&raw))
        .unwrap_or_else(|| "file".into());
    let mime = header_str(&headers, "content-type")
        .unwrap_or_else(|| "application/octet-stream".into());
    let (url, expires_at) = match host.provider.as_str() {
        "gofile" => upload_gofile(&state, &host, body, &filename, &mime).await?,
        _ => {
            return Err(ApiError::BadRequest(format!(
                "unsupported external upload provider: {}",
                host.provider
            )))
        }
    };

    validate_external_url(&url)?;
    Ok(Json(json!({
        "url": url,
        "expires_at": expires_at,
    })))
}

#[derive(Deserialize)]
pub struct GofilePlaybackRequest {
    pub url: String,
}

#[derive(Deserialize)]
pub struct GofilePlaybackQuery {
    pub source: String,
    pub expires_at: i64,
    pub sig: String,
}

pub async fn gofile_guest_session(
    State(state): State<AppState>,
    _auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "token": gofile_guest_token(&state).await? })))
}

pub async fn gofile_playback_prepare(
    State(state): State<AppState>,
    _auth: HomeAuth,
    Json(req): Json<GofilePlaybackRequest>,
) -> ApiResult<Json<Value>> {
    let source = validate_gofile_playback_source(&req.url)?;
    let expires_at = (now_ms() + 2 * 60 * 60 * 1000).min(state.key.valid_until);
    let message = gofile_playback_message(source.as_str(), expires_at);
    let signature = state.key.signing.sign(&message);

    let mut playback = url::Url::parse(&format!(
        "{}/_telium/v1/media/external/gofile/play",
        state.cfg.public_base_url.trim_end_matches('/')
    ))
    .map_err(|_| ApiError::Internal(anyhow::anyhow!("public_base_url is invalid")))?;
    playback
        .query_pairs_mut()
        .append_pair("source", source.as_str())
        .append_pair("expires_at", &expires_at.to_string())
        .append_pair("sig", &b64(&signature.to_bytes()));

    Ok(Json(json!({
        "url": playback.to_string(),
        "expires_at": expires_at,
    })))
}

pub async fn gofile_playback_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(req): Query<GofilePlaybackQuery>,
) -> ApiResult<Response> {
    if req.expires_at <= now_ms() {
        return Err(ApiError::Unauthorized("Gofile playback link expired".into()));
    }

    let source = validate_gofile_playback_source(&req.source)?;
    let message = gofile_playback_message(source.as_str(), req.expires_at);
    if !crate::crypto::verify_bytes(&state.key.public_b64(), &message, &req.sig) {
        return Err(ApiError::Unauthorized("invalid Gofile playback signature".into()));
    }

    let mut token = gofile_guest_token(&state).await?;
    let mut upstream = gofile_download_request(&state, &source, &headers, &token).await?;
    if gofile_upstream_rejected(&upstream) {
        clear_gofile_guest_token(&state, &token).await;
        token = gofile_guest_token(&state).await?;
        upstream = gofile_download_request(&state, &source, &headers, &token).await?;
    }
    if gofile_upstream_rejected(&upstream) {
        return Err(ApiError::BadRequest(
            "Gofile did not authorize this playback request".into(),
        ));
    }

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let body = Body::from_stream(upstream.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;

    for name in [
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::ETAG,
        header::LAST_MODIFIED,
        header::CACHE_CONTROL,
        header::CONTENT_ENCODING,
    ] {
        if let Some(value) = upstream_headers.get(&name) {
            response.headers_mut().insert(name, value.clone());
        }
    }
    let upstream_type = upstream_headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let served_type = playable_media_type(upstream_type);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(served_type)
            .unwrap_or(header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    Ok(response)
}

pub(crate) fn playable_media_type(upstream: &str) -> &'static str {
    const PLAYABLE: &[(&str, &str)] = &[
        ("video/mp4", "video/mp4"),
        ("video/webm", "video/webm"),
        ("video/ogg", "video/ogg"),
        ("video/quicktime", "video/quicktime"),
        ("video/x-m4v", "video/x-m4v"),
        ("audio/mpeg", "audio/mpeg"),
        ("audio/mp4", "audio/mp4"),
        ("audio/aac", "audio/aac"),
        ("audio/ogg", "audio/ogg"),
        ("audio/opus", "audio/ogg"),
        ("audio/wav", "audio/wav"),
        ("audio/x-wav", "audio/wav"),
        ("audio/webm", "audio/webm"),
        ("audio/flac", "audio/flac"),
        ("audio/x-flac", "audio/flac"),
    ];
    let base = upstream
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    PLAYABLE
        .iter()
        .find(|(from, _)| *from == base)
        .map(|(_, to)| *to)
        .unwrap_or("application/octet-stream")
}

fn gofile_playback_message(source: &str, expires_at: i64) -> Vec<u8> {
    format!("telium:gofile-playback:v1\n{expires_at}\n{source}").into_bytes()
}

fn validate_gofile_playback_source(raw: &str) -> ApiResult<url::Url> {
    let parsed = url::Url::parse(raw)
        .map_err(|_| ApiError::BadRequest("Gofile playback URL is invalid".into()))?;
    let host = parsed.host_str().unwrap_or_default();
    let gofile_host = host == "gofile.io" || host.ends_with(".gofile.io");
    if parsed.scheme() != "https"
        || !gofile_host
        || !parsed.path().starts_with("/download/")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(ApiError::BadRequest(
            "Gofile playback only accepts HTTPS gofile.io download URLs".into(),
        ));
    }
    Ok(parsed)
}

async fn create_gofile_guest_token(state: &AppState) -> ApiResult<String> {
    let account = external_metadata_request(state.http.post("https://api.gofile.io/accounts"))
        .send()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Gofile guest session failed: {e}")))?;
    let status = account.status();
    let body: Value = account.json().await.map_err(|e| {
        ApiError::Internal(anyhow::anyhow!("reading Gofile guest session failed: {e}"))
    })?;
    if !status.is_success() {
        return Err(ApiError::BadRequest(provider_json_error(
            "Gofile guest session",
            status,
            &body,
        )));
    }
    body.get("data")
        .and_then(|data| first_string(data, &["token", "guestToken"]))
        .or_else(|| first_string(&body, &["token", "guestToken"]))
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ApiError::BadRequest("Gofile did not provide a guest session".into()))
}

async fn gofile_guest_token(state: &AppState) -> ApiResult<String> {
    let mut slot = state.gofile_guest_token.lock().await;
    if let Some(token) = slot.as_ref() {
        return Ok(token.clone());
    }
    let token = create_gofile_guest_token(state).await?;
    *slot = Some(token.clone());
    Ok(token)
}

async fn clear_gofile_guest_token(state: &AppState, rejected: &str) {
    let mut slot = state.gofile_guest_token.lock().await;
    if slot.as_deref() == Some(rejected) {
        *slot = None;
    }
}

fn gofile_upstream_rejected(response: &reqwest::Response) -> bool {
    matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        || validate_gofile_playback_source(response.url().as_str()).is_err()
}

async fn gofile_download_request(
    state: &AppState,
    source: &url::Url,
    headers: &HeaderMap,
    token: &str,
) -> ApiResult<reqwest::Response> {
    let mut request = external_request(state.http.get(source.clone()))
        .header(header::COOKIE, format!("accountToken={token}"))
        .header(header::REFERER, "https://gofile.io/");
    for name in [header::RANGE, header::IF_RANGE, header::ACCEPT] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value.clone());
        }
    }
    request
        .send()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Gofile playback failed: {e}")))
}

#[derive(Deserialize)]
pub struct ExternalResolveRequest {
    pub download_page: String,
    pub guest_token: String,
    pub website_token: String,
    pub browser_language: Option<String>,
    pub browser_user_agent: Option<String>,
    pub file_id: Option<String>,
    pub filename: Option<String>,
}

pub async fn external_resolve(
    State(state): State<AppState>,
    _auth: HomeAuth,
    Path(host_id): Path<String>,
    Json(req): Json<ExternalResolveRequest>,
) -> ApiResult<Json<Value>> {
    let host = state
        .cfg
        .media_registry
        .external_hosts
        .iter()
        .find(|host| host.id == host_id)
        .ok_or_else(|| ApiError::NotFound("no such external upload host".into()))?;
    if host.provider != "gofile" {
        return Err(ApiError::BadRequest(
            "metadata resolution is only supported for Gofile".into(),
        ));
    }
    if req.download_page.trim().is_empty()
        || req.guest_token.trim().is_empty()
        || req.website_token.trim().is_empty()
    {
        return Err(ApiError::BadRequest(
            "Gofile metadata resolution requires a download page and session tokens".into(),
        ));
    }
    let url = resolve_gofile_direct_link(
        &state,
        &req.download_page,
        Some(&req.guest_token),
        Some(&req.website_token),
        req.browser_language.as_deref(),
        req.browser_user_agent.as_deref(),
        req.file_id.as_deref(),
        req.filename.as_deref(),
    )
    .await?;
    Ok(Json(json!({ "url": url })))
}

async fn upload_gofile(
    state: &AppState,
    host: &crate::config::ExternalHost,
    body: Bytes,
    filename: &str,
    mime: &str,
) -> ApiResult<(String, Option<i64>)> {
    let part = provider_part(body, filename, mime)?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let response = external_request(state.http.post(&host.upload_url))
        .multipart(form)
        .send()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Gofile upload failed: {e}")))?;
    let status = response.status();
    let payload: Value = response.json().await.map_err(|e| {
        ApiError::Internal(anyhow::anyhow!("reading Gofile response failed: {e}"))
    })?;
    if !status.is_success() {
        return Err(ApiError::BadRequest(provider_json_error("Gofile", status, &payload)));
    }
    if payload.get("status").and_then(Value::as_str).is_some_and(|value| value != "ok") {
        return Err(ApiError::BadRequest(
            payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Gofile upload failed")
                .into(),
        ));
    }

    let data = payload.get("data").unwrap_or(&payload);
    let url = if let Some(direct) = first_string(data, &["directLink", "direct_link"]) {
        direct
    } else if let Some(page) = first_string(data, &["downloadPage", "download_page"]) {
        let token = first_string(data, &["guestToken", "token"]);
        resolve_gofile_direct_link(state, &page, token.as_deref(), None, None, None, None, None).await?
    } else {
        return Err(ApiError::BadRequest("Gofile returned no download link".into()));
    };
    Ok((url, None))
}

fn provider_part(body: Bytes, filename: &str, mime: &str) -> ApiResult<reqwest::multipart::Part> {
    let mut part = reqwest::multipart::Part::bytes(body.to_vec()).file_name(filename.to_string());
    if !mime.is_empty() {
        part = part
            .mime_str(mime)
            .map_err(|e| ApiError::BadRequest(format!("invalid upload content type: {e}")))?;
    }
    Ok(part)
}

async fn resolve_gofile_direct_link(
    state: &AppState,
    page: &str,
    upload_token: Option<&str>,
    website_token: Option<&str>,
    browser_language: Option<&str>,
    browser_user_agent: Option<&str>,
    file_id: Option<&str>,
    filename: Option<&str>,
) -> ApiResult<String> {
    let page_url = url::Url::parse(page)
        .map_err(|_| ApiError::BadRequest("Gofile returned an invalid download page".into()))?;
    if page_url.scheme() != "https"
        || !matches!(page_url.host_str(), Some("gofile.io") | Some("www.gofile.io"))
    {
        return Err(ApiError::BadRequest("Gofile returned an unrecognised download page".into()));
    }
    let mut segments = page_url.path_segments().ok_or_else(|| {
        ApiError::BadRequest("Gofile returned an unrecognised download page".into())
    })?;
    if segments.next() != Some("d") {
        return Err(ApiError::BadRequest("Gofile returned an unrecognised download page".into()));
    }
    let code = segments.next().filter(|value| !value.is_empty()).ok_or_else(|| {
        ApiError::BadRequest("Gofile returned an unrecognised download page".into())
    })?;

    let token = match upload_token {
        Some(token) if !token.is_empty() => token.to_string(),
        _ => create_gofile_guest_token(state).await?,
    };

    let mut contents_url = url::Url::parse("https://api.gofile.io").expect("static URL");
    contents_url.set_path(&format!("/contents/{code}"));
    contents_url.query_pairs_mut()
        .append_pair("page", "1")
        .append_pair("pageSize", "100")
        .append_pair("sortField", "name")
        .append_pair("sortDirection", "1");
    if let Some(website_token) = website_token.filter(|value| !value.is_empty()) {
        contents_url.query_pairs_mut()
            .append_pair("wt", website_token)
            .append_pair("cache", "true");
    }
    let mut contents_request = external_metadata_request(state.http.get(contents_url))
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"));
    if let Some(website_token) = website_token.filter(|value| !value.is_empty()) {
        contents_request = contents_request.header("X-Website-Token", website_token);
        contents_request = contents_request.header("X-BL", browser_language.unwrap_or(""));
        if let Some(user_agent) = browser_user_agent.filter(|value| !value.is_empty()) {
            contents_request = contents_request.header(reqwest::header::USER_AGENT, user_agent);
        }
        contents_request = contents_request
            .header(reqwest::header::ORIGIN, "https://gofile.io")
            .header(reqwest::header::REFERER, "https://gofile.io/");
    }
    let contents = contents_request.send()
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("Gofile file lookup failed: {e}")))?;
    let contents_status = contents.status();
    let contents_body: Value = contents.json().await.map_err(|e| {
        ApiError::Internal(anyhow::anyhow!("reading Gofile file lookup failed: {e}"))
    })?;
    if contents_body.get("status").and_then(Value::as_str) != Some("ok") {
        let status = contents_body
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if matches!(status, "error-token" | "error-wrongToken") {
            return Err(ApiError::Unauthorized(
                "Gofile website token was rejected".into(),
            ));
        }
        return Err(ApiError::BadRequest(format!(
            "Gofile file lookup failed: {status}"
        )));
    }
    if !contents_status.is_success() {
        return Err(ApiError::BadRequest(provider_json_error(
            "Gofile file lookup",
            contents_status,
            &contents_body,
        )));
    }

    let data = contents_body.get("data").unwrap_or(&contents_body);
    let child = data
        .get("children")
        .and_then(Value::as_object)
        .and_then(|children| {
            children.values().find(|entry| {
                entry.get("type").and_then(Value::as_str) == Some("file")
                    && gofile_file_link(entry).is_some()
                    && ((file_id.is_some() && first_string(entry, &["id", "fileId"]).as_deref() == file_id)
                        || (filename.is_some() && first_string(entry, &["name", "fileName"]).as_deref() == filename))
            }).or_else(|| {
                children.values().find(|entry| {
                    entry.get("type").and_then(Value::as_str) == Some("file")
                        && gofile_file_link(entry).is_some()
                })
            })
        });
    let url = child
        .and_then(gofile_file_link)
        .or_else(|| gofile_file_link(data))
        .ok_or_else(|| ApiError::BadRequest("Gofile did not return a direct file URL".into()))?;
    validate_external_url(&url)?;
    Ok(url)
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str).map(str::to_string))
}

fn gofile_file_link(value: &Value) -> Option<String> {
    first_string(value, &["directLink", "direct_link", "link"])
}

#[cfg(test)]
mod tests {
    use super::{
        decode_filename, gofile_file_link, playable_media_type, prefix_end, sanitize_mime,
        still_abandoned, validate_gofile_playback_source,
    };
    use serde_json::json;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("telium-media-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn bytes_nobody_has_touched_for_a_day_are_abandoned() {
        let dir = scratch("aged");
        let path = dir.join("aged");
        std::fs::write(&path, b"x").unwrap();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        let long_ago = std::time::SystemTime::now() - day * 3;
        filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(long_ago)).unwrap();

        let cutoff = std::time::SystemTime::now() - day;
        assert!(still_abandoned(&path, cutoff).await);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn bytes_an_import_has_just_claimed_are_not() {
        let dir = scratch("restamped");
        let path = dir.join("restamped");
        std::fs::write(&path, b"x").unwrap();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        let long_ago = std::time::SystemTime::now() - day * 3;
        filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(long_ago)).unwrap();
        let cutoff = std::time::SystemTime::now() - day;
        assert!(still_abandoned(&path, cutoff).await, "the file has to start out abandoned");

        std::fs::write(&path, b"x").unwrap();
        assert!(
            !still_abandoned(&path, cutoff).await,
            "an object restamped since the shard was listed was still treated as abandoned"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_file_that_is_no_longer_there_is_not_swept() {
        let dir = scratch("missing");
        let cutoff = std::time::SystemTime::now();
        assert!(!still_abandoned(&dir.join("never-written"), cutoff).await);
    }

    #[test]
    fn a_shard_range_stops_at_the_next_name() {
        assert_eq!(prefix_end("a").as_deref(), Some("b"));
        assert_eq!(prefix_end("ab").as_deref(), Some("ac"));
        assert_eq!(prefix_end("ff").as_deref(), Some("fg"));
        assert_eq!(prefix_end(""), None);
        assert_eq!(prefix_end("\u{7f}"), None);
        assert_eq!(prefix_end("é"), None);
    }

    #[test]
    fn prefers_provider_issued_direct_link_without_rewriting_web_links() {
        let direct = "https://store9.gofile.io/download/file1/cyberpunk2.mp4";
        let value = json!({
            "directLink": direct,
            "link": "https://store9.gofile.io/download/web/file1/cyberpunk2.mp4"
        });
        assert_eq!(gofile_file_link(&value).as_deref(), Some(direct));

        let web = "https://store9.gofile.io/download/web/file1/cyberpunk2.mp4";
        assert_eq!(gofile_file_link(&json!({ "link": web })).as_deref(), Some(web));
    }

    #[test]
    fn gofile_playback_rejects_non_download_and_lookalike_hosts() {
        assert!(validate_gofile_playback_source(
            "https://store-na-phx-5.gofile.io/download/web/file/movie.mp4"
        ).is_ok());
        assert!(validate_gofile_playback_source(
            "https://evilgofile.io/download/web/file/movie.mp4"
        ).is_err());
        assert!(validate_gofile_playback_source("https://gofile.io/d/share-code").is_err());
        assert!(validate_gofile_playback_source(
            "http://store1.gofile.io/download/web/file/movie.mp4"
        ).is_err());
    }

    #[test]
    fn decodes_percent_encoded_upload_filenames() {
        assert_eq!(
            decode_filename("NBSPLV%20-%20Lost%20Soul%20-%20Slowed%20%26%20Reverb.flac"),
            "NBSPLV - Lost Soul - Slowed & Reverb.flac"
        );
        assert_eq!(decode_filename("literal%2Bplus.flac"), "literal+plus.flac");
    }


    #[test]
    fn a_playback_proxy_only_declares_types_a_media_element_actually_plays() {
        const CASES: &[(&str, &str)] = &[
            ("VIDEO/MP4", "video/mp4"),
            ("  video/webm  ", "video/webm"),
            ("video/mp4; codecs=\"avc1.42E01E\"", "video/mp4"),
            ("audio/opus", "audio/ogg"),
            ("audio/x-flac", "audio/flac"),
            ("text/html; charset=utf-8", "application/octet-stream"),
            ("image/svg+xml", "application/octet-stream"),
            ("application/javascript", "application/octet-stream"),
            ("video/mp4, text/html", "application/octet-stream"),
            ("video/mp4x", "application/octet-stream"),
            ("", "application/octet-stream"),
        ];
        for (upstream, expected) in CASES {
            assert_eq!(playable_media_type(upstream), *expected, "upstream {upstream:?}");
        }
    }

    #[test]
    fn an_uploader_cannot_claim_a_type_the_browser_will_execute() {
        for claimed in [" TEXT/HTML ", "text/html; charset=utf-8", "IMAGE/SVG+XML", "application/xhtml+xml", "text/javascript"] {
            assert_eq!(sanitize_mime("attachment", claimed), "application/octet-stream", "{claimed:?}");
            assert_eq!(sanitize_mime("profile", claimed), "image/png", "{claimed:?}");
            assert_eq!(sanitize_mime("expression", claimed), "image/png", "{claimed:?}");
        }
        assert_eq!(sanitize_mime("attachment", "video/mp4; codecs=avc1"), "video/mp4");
        assert_eq!(sanitize_mime("profile", "image/WEBP"), "image/webp");
    }

    #[test]
    fn nothing_but_a_blake3_digest_is_accepted_as_a_hash() {
        assert!(super::valid_hash(&"0123456789abcdef".repeat(4)));
        for bad in ["", "../../../../etc/passwd", "aaaa/aaaa", "\u{0}"] {
            assert!(!super::valid_hash(bad), "{bad:?}");
        }
        for bad in ["a".repeat(63), "a".repeat(65), "g".repeat(64), "\u{ff41}".repeat(64)] {
            assert!(!super::valid_hash(&bad), "{bad:?}");
        }
    }
}

fn external_request(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder.timeout(std::time::Duration::from_secs(30 * 60))
}

fn external_metadata_request(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder.timeout(std::time::Duration::from_secs(10))
}

fn validate_external_url(url: &str) -> ApiResult<()> {
    let parsed = url::Url::parse(url)
        .map_err(|_| ApiError::BadRequest("external provider returned an invalid URL".into()))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(ApiError::BadRequest(
            "external providers must return an HTTPS file URL".into(),
        ));
    }
    Ok(())
}

fn provider_error(provider: &str, status: reqwest::StatusCode, body: &str) -> String {
    let detail = body.trim();
    if detail.is_empty() {
        format!("{provider} upload failed ({status})")
    } else {
        format!("{provider} upload failed ({status}): {}", truncate_provider_error(detail))
    }
}

fn provider_json_error(provider: &str, status: reqwest::StatusCode, body: &Value) -> String {
    provider_error(provider, status, &body.to_string())
}

fn truncate_provider_error(value: &str) -> String {
    value.chars().take(500).collect()
}

fn decode_filename(value: &str) -> String {
    let decoded = url::form_urlencoded::parse(format!("name={value}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| value.to_string());
    if decoded.trim().is_empty() { "file".into() } else { decoded }
}

#[derive(Deserialize)]
pub struct FetchParams {
    #[serde(default)]
    pub cap: Option<String>,
}

fn byte_range(value: Option<&axum::http::HeaderValue>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(value) = value else { return Ok(None); };
    let value = value.to_str().map_err(|_| ())?;
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || size == 0 { return Err(()); }
    let (start, end) = value.split_once('-').ok_or(())?;

    if start.is_empty() {
        let length = end.parse::<u64>().map_err(|_| ())?;
        if length == 0 { return Err(()); }
        let length = length.min(size);
        return Ok(Some((size - length, size - 1)));
    }

    let start = start.parse::<u64>().map_err(|_| ())?;
    if start >= size { return Err(()); }
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if end < start { return Err(()); }
    Ok(Some((start, end)))
}

pub async fn fetch(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
    Query(params): Query<FetchParams>,
) -> ApiResult<Response> {
    if !valid_hash(&hash) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    let _cacher = crate::federation::optional_origin(
        &state,
        &headers,
        "GET",
        &format!("/_telium/v1/media/{hash}"),
    )
    .await;
    let row: Option<(String, String, String, String, i64, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT capability, purpose, filename, mime, size, expires_at, moved_to FROM media WHERE hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    let (capability, purpose, filename, mime, _size, expires_at, moved_to) =
        row.ok_or_else(|| ApiError::NotFound("no such media".into()))?;
    if expired(expires_at) {
        return Err(ApiError::NotFound("no such media".into()));
    }

    if !PUBLIC_PURPOSES.contains(&purpose.as_str()) {
        let presented = params.cap.unwrap_or_default();
        if !constant_time_eq(presented.as_bytes(), capability.as_bytes()) {
            return Err(ApiError::NotFound("no such media".into()));
        }
    }

    if let Some(origin) = moved_to.filter(|o| !o.is_empty()) {
        if let Ok(base) = crate::federation::known_base(&state, &origin).await {
            let mut location = format!("{base}/_telium/v1/media/{hash}");
            if !PUBLIC_PURPOSES.contains(&purpose.as_str()) {
                location.push_str("?cap=");
                location.extend(url::form_urlencoded::byte_serialize(capability.as_bytes()));
            }
            return Ok(axum::response::Redirect::temporary(&location).into_response());
        }
        tracing::warn!(target: crate::logcat::MEDIA, hash, origin, "an object that moved cannot be forwarded from here; serving the copy left behind");
    }

    let size = u64::try_from(_size).map_err(|_| ApiError::Internal(anyhow::anyhow!("media size is negative")))?;
    let range = match byte_range(headers.get(header::RANGE), size) {
        Ok(range) => range,
        Err(()) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
            headers.insert(
                header::CONTENT_RANGE,
                format!("bytes */{size}").parse().unwrap(),
            );
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, headers).into_response());
        }
    };

    let key = media_key(&state, &hash);
    let (status, bytes, content_range) = if let Some((start, end)) = range {
        let bytes = state
            .media_store
            .get_range(&key, start, end)
            .await
            .map_err(|_| ApiError::NotFound("media object is missing from storage".into()))?;
        (StatusCode::PARTIAL_CONTENT, bytes, Some(format!("bytes {start}-{end}/{size}")))
    } else {
        let bytes = state
            .media_store
            .get(&key)
            .await
            .map_err(|_| ApiError::NotFound("media object is missing from storage".into()))?;
        (StatusCode::OK, bytes, None)
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, mime.parse().unwrap_or(header::HeaderValue::from_static("application/octet-stream")));
    headers.insert(header::ACCEPT_RANGES, header::HeaderValue::from_static("bytes"));
    headers.insert(
        header::CONTENT_LENGTH,
        bytes.len().to_string().parse().unwrap(),
    );
    if let Some(content_range) = content_range {
        headers.insert(header::CONTENT_RANGE, content_range.parse().unwrap());
    }
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("public, max-age=31536000, immutable"));
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        header::HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    if let Ok(v) = format!("inline; filename=\"{}\"", filename.replace('"', "")).parse() {
        headers.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok((status, headers, bytes).into_response())
}

pub async fn meta(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    Query(params): Query<FetchParams>,
) -> ApiResult<Json<Value>> {
    if !valid_hash(&hash) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    let row: Option<(String, String, i64, Option<i64>, Option<i64>, Option<String>, String, i64, Option<i64>, String)> =
        sqlx::query_as(
            "SELECT filename, mime, size, width, height, thumbhash, purpose, created_at, expires_at, \
             capability FROM media WHERE hash = ?",
        )
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await?;
    let (filename, mime, size, width, height, thumbhash, purpose, created_at, expires_at, capability) =
        row.ok_or_else(|| ApiError::NotFound("no such media".into()))?;
    if expired(expires_at) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    if !PUBLIC_PURPOSES.contains(&purpose.as_str()) {
        let presented = params.cap.unwrap_or_default();
        if !constant_time_eq(presented.as_bytes(), capability.as_bytes()) {
            return Err(ApiError::NotFound("no such media".into()));
        }
    }
    Ok(Json(json!({
        "hash": hash, "origin": state.cfg.server_name, "filename": filename, "mime": mime,
        "size": size, "width": width, "height": height, "thumbhash": thumbhash,
        "purpose": purpose, "created_at": created_at, "expires_at": expires_at,
    })))
}

fn expired(expires_at: Option<i64>) -> bool {
    matches!(expires_at, Some(at) if at <= now_ms())
}

/// How long an unreferenced upload is left alone before the sweep reclaims it:
/// the window a client has between uploading a file and sending the message
/// that claims it, and the window an operator has to notice a mass deletion.
const RECLAIM_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

/// Reclaims uploads nothing on this server refers to anymore: attachment-purpose
/// objects whose destination was local, whose message references have all been
/// released, and whose upload is older than the grace window. Rows this server
/// cannot vouch for (`local_dest = 0`) are never touched — an end-to-end
/// encrypted conversation or a foreign guild may still refer to them.
pub async fn sweep_unreferenced(state: &AppState) -> anyhow::Result<u64> {
    sweep_unreferenced_before(state, now_ms() - RECLAIM_GRACE_MS).await
}

pub async fn sweep_unreferenced_before(state: &AppState, cutoff_ms: i64) -> anyhow::Result<u64> {
    let doomed: Vec<String> = sqlx::query_scalar(
        "SELECT hash FROM media WHERE purpose = 'attachment' AND local_dest = 1 \
         AND refs <= 0 AND created_at <= ?",
    )
    .bind(cutoff_ms)
    .fetch_all(&state.pool)
    .await?;
    let mut swept = 0u64;
    for hash in &doomed {
        sqlx::query("DELETE FROM media WHERE hash = ?").bind(hash).execute(&state.pool).await?;
        let _ = state.media_store.delete(&media_key(state, hash)).await;
        broadcast_purge_quietly(state, hash);
        swept += 1;
    }
    if swept > 0 {
        tracing::info!(target: crate::logcat::MAINTENANCE, count = swept, "swept unreferenced media");
    }
    Ok(swept)
}

pub async fn sweep_expired(state: &AppState) -> anyhow::Result<u64> {    let doomed: Vec<String> = sqlx::query_scalar(
        "SELECT hash FROM media WHERE expires_at IS NOT NULL AND expires_at <= ?",
    )
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;
    let mut swept = 0u64;
    for hash in &doomed {
        sqlx::query("DELETE FROM media WHERE hash = ?").bind(hash).execute(&state.pool).await?;
        let _ = state.media_store.delete(&media_key(state, hash)).await;
        broadcast_purge_quietly(state, hash);
        swept += 1;
    }
    if swept > 0 {
        tracing::info!(target: crate::logcat::MAINTENANCE, count = swept, "swept expired media");
    }
    Ok(swept)
}

pub async fn sweep_orphans(state: &AppState) -> anyhow::Result<u64> {
    if !state.media_store.is_local() {
        return Ok(0);
    }
    const UNCLAIMED_FOR_MS: i64 = 24 * 60 * 60 * 1000;

    let cutoff =
        std::time::SystemTime::now() - std::time::Duration::from_millis(UNCLAIMED_FOR_MS as u64);
    let mut swept = 0u64;
    let mut shards = match tokio::fs::read_dir(&state.cfg.media_dir).await {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    while let Ok(Some(shard)) = shards.next_entry().await {
        if !shard.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut candidates: Vec<(String, std::path::PathBuf)> = Vec::new();
        let Ok(mut objects) = tokio::fs::read_dir(shard.path()).await else { continue };
        while let Ok(Some(object)) = objects.next_entry().await {
            let Ok(meta) = object.metadata().await else { continue };
            if !meta.is_file() || meta.modified().map(|m| m > cutoff).unwrap_or(true) {
                continue;
            }
            let Some(hash) = object.file_name().to_str().map(str::to_string) else { continue };
            candidates.push((hash, object.path()));
        }
        if candidates.is_empty() {
            continue;
        }
        let Some(prefix) = shard.file_name().to_str().map(str::to_string) else { continue };
        let Some(after) = prefix_end(&prefix) else { continue };
        let claimed: std::collections::HashSet<String> = match sqlx::query_scalar::<_, String>(
            "SELECT hash FROM media WHERE hash >= ? AND hash < ?",
        )
        .bind(&prefix)
        .bind(&after)
        .fetch_all(&state.pool)
        .await
        {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                tracing::warn!(target: crate::logcat::MAINTENANCE, shard = prefix, error = %e, "skipping a shard this sweep");
                continue;
            }
        };
        for (hash, path) in candidates {
            if claimed.contains(&hash) {
                continue;
            }
            if !still_abandoned(&path, cutoff).await {
                continue;
            }
            if tokio::fs::remove_file(&path).await.is_ok() {
                swept += 1;
            }
        }
    }
    if swept > 0 {
        tracing::info!(target: crate::logcat::MAINTENANCE, count = swept, "swept media objects no row accounts for");
    }
    Ok(swept)
}

async fn still_abandoned(path: &std::path::Path, cutoff: std::time::SystemTime) -> bool {
    tokio::fs::metadata(path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|m| m <= cutoff)
        .unwrap_or(false)
}

fn prefix_end(prefix: &str) -> Option<String> {
    let mut bytes = prefix.as_bytes().to_vec();
    while let Some(last) = bytes.pop() {
        if last < 0x7f {
            bytes.push(last + 1);
            return String::from_utf8(bytes).ok();
        }
    }
    None
}

fn broadcast_purge_quietly(state: &AppState, hash: &str) {
    let owned = hash.to_string();
    let state = state.clone();
    tokio::spawn(async move { crate::federation::media::broadcast_purge(&state, &owned).await });
}

pub async fn delete(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(hash): Path<String>,
) -> ApiResult<Json<Value>> {
    if !valid_hash(&hash) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT owner_user_id, refcount FROM media WHERE hash = ?")
            .bind(&hash)
            .fetch_optional(&state.pool)
            .await?;
    let (owner, refcount) = row.ok_or_else(|| ApiError::NotFound("no such media".into()))?;
    let is_admin: i64 = sqlx::query_scalar("SELECT admin FROM accounts WHERE user_id = ?")
        .bind(&auth.user_id)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(0);
    if owner != auth.user_id && is_admin == 0 {
        return Err(ApiError::Forbidden("only the uploader may delete this object".into()));
    }
    // Identical bytes are stored once and claimed by every upload of them, so
    // the object under this hash is not the requester's alone. An owner's
    // delete stops here rather than breaking someone else's messages; an
    // operator's takedown does not ask.
    if refcount > 1 && is_admin == 0 {
        return Err(ApiError::Conflict(format!(
            "this file's bytes are shared with {} other upload{} of the same content; \
             deleting it here would break their messages. Each uploader can delete \
             their own; an operator can remove it outright.",
            refcount - 1,
            if refcount > 2 { "s" } else { "" },
        )));
    }

    sqlx::query("DELETE FROM media WHERE hash = ?").bind(&hash).execute(&state.pool).await?;
    let _ = state.media_store.delete(&media_key(&state, &hash)).await;
    crate::federation::media::broadcast_purge(&state, &hash).await;
    Ok(Json(json!({ "ok": true, "hash": hash })))
}

pub async fn capabilities(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user_media = match headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        Some(token) => {
            let user_id: Option<String> = sqlx::query_scalar(
                "SELECT user_id FROM home_sessions WHERE token_hash = ? AND expires_at > ?",
            )
            .bind(crate::util::hash_token(token))
            .bind(now_ms())
            .fetch_optional(&state.pool)
            .await?;
            user_id.map(|u| {
                let quota = state.cfg.media_quota_for(&u);
                json!({
                    "tier1_upload": quota.is_some(),
                    "quota_bytes": quota.filter(|q| *q != i64::MAX),
                    "profile_asset_carveout_bytes": state.cfg.media_policy.profile_asset_carveout_bytes,
                })
            })
        }
        None => None,
    };

    let unimplemented: Vec<&str> = [
        (!state.cfg.federation.enabled).then_some("federation"),
        (!state.cfg.voice.enabled).then_some("voice"),
        (!state.cfg.federation.embed_enabled).then_some("embed_proxy"),
        (!state.cfg.roles.identity).then_some("dms"),
        (!state.cfg.roles.identity).then_some("migration"),
        (!crate::mail::configured(&state)).then_some("recovery_email"),
        (!state.cfg.roles.relay).then_some("relay"),
    ]
    .into_iter()
    .flatten()
    .collect();

    Ok(Json(json!({
        "server_name": state.cfg.server_name,
        "gateway": format!("{}/gateway/v1", state.cfg.public_base_url.replace("http", "ws")),
        "invite_portal": state.cfg.invite_portal_field(),
        "roles": {
            "identity": state.cfg.roles.identity,
            "guild": state.cfg.roles.guild,
            "media": state.cfg.roles.media,
            "relay": state.cfg.roles.relay,
        },
        "media": {
            "enabled": state.cfg.roles.media,
            "default_policy": state.cfg.media_policy.default,
            "max_file_bytes": state.cfg.media_policy.max_file_bytes,
            "max_expiry_secs": state.cfg.media_policy.max_expiry_secs,
            "upload_scanning": true,
            "hash_list_entries": state.hash_lists.entries(),
            "abuse_contact": state.cfg.moderation.abuse_contact,
            "external_hosts": state.cfg.media_registry.external_hosts.iter().filter(|h| h.provider.eq_ignore_ascii_case("gofile")).map(|h| json!({
                "id": h.id,
                "provider": h.provider,
                "name": if h.name.is_empty() { &h.id } else { &h.name },
                "domain": h.domain,
                "upload_url": h.upload_url,
                "description": h.description,
                "max_file_bytes": h.max_file_bytes,
                "browser_direct": h.browser_direct_enabled(),
            })).collect::<Vec<_>>(),
        },
        "calls": {
            "relay": crate::routes::dmvoice::relay_turn(&state).is_some(),
            "sfu": state.cfg.voice.enabled && state.cfg.voice.addressed_regions().next().is_some(),
            "mesh_max_participants": state.cfg.voice.mesh_max_participants,
            "e2ee": "mls-exporter",
        },
        "registration_open": crate::sunset::registration_open(&state).await,
        "registration_min_password_len": state.cfg.registration.min_password_len,
        "onboarding": {
            "recommendations": {
                "accepting": state.cfg.registration.recommendations.accepting,
                "referral_weight": state.cfg.registration.recommendations.referral_weight,
                "suggest_alternatives": state.cfg.registration.recommendations.suggest_alternatives,
            }
        },
        "auth": {
            "opaque": state.cfg.roles.identity,
            "recovery_key_reset": state.cfg.roles.identity,
            "protocol": "rfc9807",
        },
        "profile": {
            "bio_max_chars": crate::routes::identity::BIO_MAX_CHARS,
        },
        "identity": {
            "continuity": state.cfg.roles.identity,
            "protocol": "telium-identity-v1",
            "threshold_recovery": state.cfg.roles.identity,
            "max_guardians": 5,
        },
        "account": user_media,
        "server_version": env!("CARGO_PKG_VERSION"),
        "protocol": "telium/v1",
        "features": {
            "federation": state.cfg.federation.enabled,
            "dms": state.cfg.roles.identity,
            "voice": state.cfg.voice.enabled,
            "embed_proxy": state.cfg.federation.embed_enabled,
            "migration": state.cfg.roles.identity,
            "threads": state.cfg.roles.guild,
            "reactions": state.cfg.roles.guild,
            "read_state": state.cfg.roles.guild,
            "search": state.cfg.roles.guild,
            "automod": state.cfg.roles.guild,
            "push": state.cfg.roles.identity,
            "native_notifications": state.cfg.roles.identity,
            "rate_limit": state.cfg.rate_limit.enabled,
            "recovery_email": crate::mail::configured(&state),
            "archive": state.cfg.archive.enabled,
            "gif_picker": state.cfg.klipy.enabled,
            "relay": state.cfg.roles.relay,
        },
        "gif_provider": {
            "enabled": state.cfg.klipy.enabled,
            "provider": "klipy",
            "api_key": state.cfg.klipy.api_key,
            "api_base_url": state.cfg.klipy.api_base_url,
            "media_hosts": state.cfg.klipy.media_hosts,
        },
        "unimplemented": unimplemented,
    })))
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn header_i64(headers: &HeaderMap, name: &str) -> Option<i64> {
    header_str(headers, name).and_then(|v| v.parse().ok())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
