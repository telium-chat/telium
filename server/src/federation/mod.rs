
pub mod curators;
pub mod embed;
pub mod feeds;
pub mod media;
pub mod media_feeds;
pub mod routes;

mod extract;
mod homes;
mod maintenance;
mod negotiation;

pub use extract::{BigBodies, BigBodyGuard, Fed, FedOrigin, Gate, Anyone, Pace, CONCURRENT_BIG_BODIES};
pub use homes::{apply_verdict, check_home, learn_tombstone, resolve_id, revalidate_sessions, Verdict};
pub use maintenance::{spawn_maintenance, spawn_slow_housekeeping};
pub use negotiation::{compat_from_discovery, peer_compat, peer_supports, record_peer_compat};
use extract::{BIG_BODY_READ_SECS, UNGATED_MB};
use negotiation::{compat_status, with_compat_headers};

use crate::crypto::{self, ServerKey};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, now_ms, unb64};
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;
use telium_protocol::compat::{self, PeerCompat};

pub const AUTH_SCHEME: &str = "X-Telium-Federation";

const MAX_PUBLISHED_KEYS: usize = 16;

#[derive(Debug, Clone)]
pub struct Peer {
    pub origin: String,
    pub api_base: String,
    pub gateway: Option<String>,
    pub moved_to: Option<String>,
}

pub fn normalise_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('.').to_ascii_lowercase()
}

const INTERNAL_SUFFIXES: [&str; 8] = [
    ".localhost",
    ".local",
    ".internal",
    ".intranet",
    ".lan",
    ".home.arpa",
    ".corp",
    ".private",
];

pub fn dialable_server_name(state: &AppState, origin: &str) -> ApiResult<()> {
    // One refusal for every reason, so this is not a scanner.
    let refuse = || {
        Err(ApiError::BadRequest(format!(
            "{origin} is not a server name"
        )))
    };

    if origin.is_empty() || origin.len() > 253 {
        return refuse();
    }
    // Before the ':' split so a v6 literal is not read as host:port.
    if origin.starts_with('[') || origin.contains("::") {
        return refuse();
    }
    if origin
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || "/\\@?#%[]".contains(c))
    {
        return refuse();
    }

    let (host, port) = match origin.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (origin, None),
    };
    if let Some(port) = port {
        if !state.cfg.federation.allow_http {
            return refuse();
        }
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
            return refuse();
        }
        if port.parse::<u16>().map(|p| p == 0).unwrap_or(true) {
            return refuse();
        }
    }

    if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() {
        return refuse();
    }
    if host == "localhost" || INTERNAL_SUFFIXES.iter().any(|s| host.ends_with(s)) {
        return refuse();
    }
    if !host.contains('.') && !state.cfg.federation.allow_http {
        return refuse();
    }
    for label in host.split('.') {
        if label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return refuse();
        }
    }
    Ok(())
}

pub(crate) fn seed_base(state: &AppState, origin: &str) -> ApiResult<String> {
    if let Some(explicit) = state.cfg.federation.peers.get(origin) {
        return Ok(explicit.trim_end_matches('/').to_string());
    }
    if !state.cfg.federation.enabled {
        return Err(ApiError::Forbidden(
            "federation is disabled on this server".into(),
        ));
    }
    dialable_server_name(state, origin)?;
    let scheme = if state.cfg.federation.allow_http {
        "http"
    } else {
        "https"
    };
    Ok(format!("{scheme}://{origin}"))
}

fn undiscoverable(origin: &str, detail: &str) -> ApiError {
    tracing::debug!(target: crate::logcat::FEDERATION, %origin, %detail, "federation discovery failed");
    ApiError::BadGateway(format!("{origin} is not reachable as a Telium server"))
}

fn api_base_scheme_ok(api_base: &str, allow_http: bool) -> bool {
    api_base.starts_with("https://") || (allow_http && api_base.starts_with("http://"))
}

pub async fn known_base(state: &AppState, origin: &str) -> ApiResult<String> {
    let origin = normalise_origin(origin);
    if origin == state.cfg.server_name {
        return Ok(state.cfg.public_base_url.trim_end_matches('/').to_string());
    }
    let cached: Option<String> =
        sqlx::query_scalar("SELECT api_base FROM remote_servers WHERE origin = ?")
            .bind(&origin)
            .fetch_optional(&state.pool)
            .await?;
    match cached {
        Some(base) => Ok(base),
        None => seed_base(state, &origin),
    }
}

pub async fn discover(state: &AppState, origin: &str) -> ApiResult<Peer> {
    let origin = normalise_origin(origin);
    if origin == state.cfg.server_name {
        return Ok(Peer {
            origin,
            api_base: state.cfg.public_base_url.trim_end_matches('/').to_string(),
            gateway: None,
            moved_to: None,
        });
    }
    ensure_reachable(state, &origin, "all").await?;

    let ttl = state.cfg.federation.key_cache_secs * 1000;
    let cached: Option<(
        String,
        Option<String>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT api_base, gateway, fetched_at, moved_to, fallback_standby, fallback_path \
             FROM remote_servers WHERE origin = ?",
    )
    .bind(&origin)
    .fetch_optional(&state.pool)
    .await?;

    if let Some((api_base, gateway, fetched_at, moved_to, _, _)) = &cached {
        if now_ms() - fetched_at < ttl {
            return Ok(Peer {
                origin,
                api_base: api_base.clone(),
                gateway: gateway.clone(),
                moved_to: moved_to.clone(),
            });
        }
    }

    let seed = seed_base(state, &origin)?;
    let fetched = state
        .http
        .get(format!("{seed}/.well-known/telium/server"))
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success());

    let Some(resp) = fetched else {
        if let Ok(Some(peer)) = promoted_fallback(state, &origin).await {
            return Ok(peer);
        }
        if let Some((api_base, gateway, _, moved_to, _, _)) = cached {
            sqlx::query("UPDATE remote_servers SET failures = failures + 1 WHERE origin = ?")
                .bind(&origin)
                .execute(&state.pool)
                .await?;
            return Ok(Peer {
                origin,
                api_base,
                gateway,
                moved_to,
            });
        }
        return Err(undiscoverable(
            &origin,
            "no usable answer at the seed address",
        ));
    };

    let doc: Value = json_capped(resp, FED_JSON_MAX_BYTES, &origin)
        .await
        .map_err(|_| {
            undiscoverable(
                &origin,
                "the seed address answered but not with discovery json that fits",
            )
        })?;
    let api_base = doc
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or(&seed)
        .trim_end_matches('/')
        .to_string();
    // A peer's document must not downgrade `seed_base`'s https.
    if !api_base_scheme_ok(&api_base, state.cfg.federation.allow_http) {
        return Err(undiscoverable(
            &origin,
            "published an api base that is not https",
        ));
    }
    // Also check the api host: a dialable name could redirect signed requests to loopback.
    if !state.cfg.federation.peers.contains_key(&origin) {
        let parsed = reqwest::Url::parse(&api_base)
            .map_err(|_| undiscoverable(&origin, "published an unparseable api base"))?;
        let host = parsed.host_str().unwrap_or_default().to_string();
        let authority = match parsed.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        dialable_server_name(state, &normalise_origin(&authority))
            .map_err(|_| undiscoverable(&origin, "published an api base we will not dial"))?;
    }
    let gateway = doc
        .get("gateway")
        .and_then(Value::as_str)
        .map(str::to_string);
    let advertised = compat_from_discovery(&doc);
    let fallback_standby = doc
        .pointer("/fallback/standby")
        .and_then(Value::as_str)
        .map(str::to_string);
    let fallback_path = doc
        .pointer("/fallback/path")
        .and_then(Value::as_str)
        .map(str::to_string);

    sqlx::query(
        "INSERT INTO remote_servers \
             (origin, api_base, gateway, fetched_at, failures, fallback_standby, fallback_path, \
              protocol_version, protocol_min_supported, capabilities, compat_status, \
              compat_checked_at) \
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(origin) DO UPDATE SET api_base = excluded.api_base, \
             gateway = excluded.gateway, fetched_at = excluded.fetched_at, failures = 0, \
             fallback_standby = excluded.fallback_standby, fallback_path = excluded.fallback_path, \
             protocol_version = excluded.protocol_version, \
             protocol_min_supported = excluded.protocol_min_supported, \
             capabilities = excluded.capabilities, compat_status = excluded.compat_status, \
             compat_checked_at = excluded.compat_checked_at",
    )
    .bind(&origin)
    .bind(&api_base)
    .bind(&gateway)
    .bind(now_ms())
    .bind(&fallback_standby)
    .bind(&fallback_path)
    .bind(i64::from(advertised.version))
    .bind(i64::from(advertised.min_supported))
    .bind(advertised.capability_header())
    .bind(compat_status(&advertised))
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let embedded_keys_ok = match doc.get("keys").filter(|v| v.is_object()) {
        Some(keys) => match Box::pin(store_key_document(state, &origin, keys)).await {
            Ok(()) => true,
            Err(e) => {
                tracing::debug!(target: crate::logcat::FEDERATION, %origin, error = %e, "embedded federation keys did not verify");
                false
            }
        },
        None => false,
    };
    if fallback_standby.is_some() && !embedded_keys_ok {
        if let Err(e) = cache_keys_from_base(state, &origin, &api_base).await {
            tracing::debug!(target: crate::logcat::FEDERATION, %origin, error = %e, "could not pre-cache fallback origin keys");
        }
    }

    if let Some(authority) = doc.get("authority").filter(|a| !a.is_null()) {
        if authority.get("domain").and_then(Value::as_str) != Some(origin.as_str()) {
            if let (Some(record), Some(path)) = (
                authority.get("record"),
                authority.get("path").and_then(Value::as_str),
            ) {
                if let Ok(peer) = authority_peer(state, &origin, record, path).await {
                    return Ok(peer);
                }
            }
        }
    }

    if let Some(record) = doc.get("relocation").filter(|r| r.is_object()) {
        if let Err(e) = Box::pin(crate::relocation::learn(state, record, None)).await {
            tracing::debug!(target: crate::logcat::FEDERATION, %origin, error = %e, "published relocation did not verify");
        }
    }

    let moved_to: Option<String> =
        sqlx::query_scalar("SELECT moved_to FROM remote_servers WHERE origin = ?")
            .bind(&origin)
            .fetch_optional(&state.pool)
            .await?
            .flatten();

    Ok(Peer {
        origin,
        api_base,
        gateway,
        moved_to,
    })
}

async fn cache_keys_from_base(state: &AppState, origin: &str, api_base: &str) -> ApiResult<()> {
    let resp = state
        .http
        .get(format!("{api_base}/_telium/v1/keys"))
        .send()
        .await
        .map_err(|e| ApiError::BadRequest(format!("key fetch from {origin} failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(ApiError::BadRequest(format!("{origin} published no keys")));
    }
    let doc: Value = json_capped(resp, FED_JSON_MAX_BYTES, origin)
        .await
        .map_err(|_| ApiError::BadRequest(format!("{origin} published malformed keys")))?;
    Box::pin(store_key_document(state, origin, &doc)).await
}

async fn store_key_document(state: &AppState, origin: &str, doc: &Value) -> ApiResult<()> {
    if doc.get("server_name").and_then(Value::as_str) != Some(origin) {
        return Err(ApiError::BadRequest(format!(
            "{origin} published keys claiming to be someone else"
        )));
    }
    let signing_key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let verify_keys = doc
        .get("verify_keys")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let self_key = verify_keys
        .get(signing_key_id)
        .and_then(|k| k.get("key"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::BadRequest(format!(
                "{origin} signed its keys with a key it did not publish"
            ))
        })?;
    if !crypto::verify_json(self_key, doc) {
        return Err(ApiError::BadRequest(format!(
            "{origin} key document is not self-signed"
        )));
    }

    let signer = normalise_origin(doc.get("signer").and_then(Value::as_str).unwrap_or(origin));
    if signer != origin {
        let record = doc
            .get("authority")
            .filter(|r| !r.is_null())
            .ok_or_else(|| {
                ApiError::Forbidden(format!(
                    "{origin} published delegated keys without an authority proof"
                ))
            })?;
        let authority = crate::promotion::verify(state, record, origin).await?;
        if authority.domain != signer {
            return Err(ApiError::Forbidden(format!(
                "{origin}'s key document is signed by {signer}, but its promotion names {}",
                authority.domain
            )));
        }
        let published = Box::pin(verify_key(state, &signer, signing_key_id))
            .await
            .ok_or_else(|| {
                ApiError::Forbidden(format!(
                    "{signer} does not publish delegated key {signing_key_id}"
                ))
            })?;
        if published != self_key {
            return Err(ApiError::Forbidden(format!(
                "{signer}'s delegated key does not match its own publication"
            )));
        }
    } else if doc.get("authority").is_some_and(|a| !a.is_null()) {
        return Err(ApiError::BadRequest(
            "an ordinary key document cannot carry somebody else's authority".into(),
        ));
    }

    if verify_keys.len() > MAX_PUBLISHED_KEYS {
        return Err(ApiError::BadRequest(format!(
            "{origin} published {} keys at once; no more than {MAX_PUBLISHED_KEYS} are accepted",
            verify_keys.len()
        )));
    }

    let now = now_ms();
    for (key_id, entry) in verify_keys {
        let Some(public) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if key_id.is_empty() {
            continue;
        }
        let valid_from = entry.get("valid_from").and_then(Value::as_i64).unwrap_or(0);
        let valid_until = entry
            .get("valid_until")
            .and_then(Value::as_i64)
            .unwrap_or(now);
        sqlx::query(
            "INSERT INTO remote_keys (origin, key_id, public_b64, valid_from, valid_until, fetched_at) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(origin, key_id) DO UPDATE SET public_b64 = excluded.public_b64, \
                 valid_from = excluded.valid_from, valid_until = excluded.valid_until, \
                 fetched_at = excluded.fetched_at",
        )
        .bind(origin)
        .bind(&key_id)
        .bind(public)
        .bind(valid_from)
        .bind(valid_until)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }

    // Drop unpublished keys, or a promoted standby could keep an extra long-lived key.
    sqlx::query("DELETE FROM remote_keys WHERE origin = ? AND fetched_at < ?")
        .bind(origin)
        .bind(now)
        .execute(&state.pool)
        .await?;
    Ok(())
}

async fn authority_peer(
    state: &AppState,
    origin: &str,
    record: &Value,
    path: &str,
) -> ApiResult<Peer> {
    let authority = crate::promotion::verify(state, record, origin).await?;
    let host = Box::pin(discover(state, &authority.domain)).await?;
    Ok(Peer {
        origin: origin.to_string(),
        api_base: format!("{}{}", host.api_base.trim_end_matches('/'), path),
        gateway: None,
        moved_to: None,
    })
}

async fn promoted_fallback(state: &AppState, origin: &str) -> ApiResult<Option<Peer>> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT fallback_standby, fallback_path FROM remote_servers WHERE origin = ?",
    )
    .bind(origin)
    .fetch_optional(&state.pool)
    .await?;
    let Some((Some(standby), Some(path))) = row else {
        return Ok(None);
    };
    let host = Box::pin(discover(state, &standby)).await?;
    let url = format!(
        "{}/_telium/v1/failover/status/{origin}",
        host.api_base.trim_end_matches('/')
    );
    let resp = match state.http.get(url).send().await {
        Ok(resp) if resp.status().is_success() => resp,
        _ => return Ok(None),
    };
    let status: Value = match json_capped(resp, FED_JSON_MAX_BYTES, &standby).await {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let Some(record) = status.get("record").filter(|r| !r.is_null()) else {
        return Ok(None);
    };
    let authority = crate::promotion::verify(state, record, origin).await?;
    let authority_host = if authority.domain == standby {
        host
    } else {
        Box::pin(discover(state, &authority.domain)).await?
    };
    Ok(Some(Peer {
        origin: origin.to_string(),
        api_base: format!("{}{}", authority_host.api_base.trim_end_matches('/'), path),
        gateway: None,
        moved_to: None,
    }))
}

pub async fn refresh_keys(state: &AppState, origin: &str) -> ApiResult<()> {
    // Boxed: discovery, promotion verification and key refresh form a cycle.
    let peer = Box::pin(discover(state, origin)).await?;
    cache_keys_from_base(state, origin, &peer.api_base).await
}

const KEY_REFRESH_ORIGIN_BURST: f64 = 8.0;

const KEY_REFRESH_ORIGIN_PER_SEC: f64 = 1.0 / 30.0;

const KEY_REFRESH_TOTAL_BURST: f64 = 64.0;
const KEY_REFRESH_TOTAL_PER_SEC: f64 = 2.0;

async fn refresh_keys_for_stranger(state: &AppState, origin: &str) -> ApiResult<()> {
    if state
        .limiter
        .take(
            "fed-key-refresh".to_string(),
            "fed-key-refresh",
            KEY_REFRESH_TOTAL_BURST,
            KEY_REFRESH_TOTAL_PER_SEC,
        )
        .is_err()
    {
        return Err(ApiError::RateLimited(
            "this server is already fetching as many federation keys as it will at once".into(),
        ));
    }
    if state
        .limiter
        .take(
            format!("fed-key-refresh-origin:{origin}"),
            "fed-key-refresh-origin",
            KEY_REFRESH_ORIGIN_BURST,
            KEY_REFRESH_ORIGIN_PER_SEC,
        )
        .is_err()
    {
        return Err(ApiError::RateLimited(format!(
            "too many key fetches for {origin} have been asked for"
        )));
    }
    refresh_keys(state, origin).await
}

pub async fn verify_key(state: &AppState, origin: &str, key_id: &str) -> Option<String> {
    let origin = normalise_origin(origin);
    if origin == state.signing_origin.as_str() && key_id == state.key.key_id {
        return Some(state.key.public_b64());
    }
    if origin == state.cfg.server_name && state.signing_origin.as_str() == state.cfg.server_name {
        return sqlx::query_scalar("SELECT public_b64 FROM server_keys WHERE key_id = ?")
            .bind(key_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    }

    if let Some(found) =
        crate::relocation::previous_name_key(state, &origin, key_id, now_ms()).await
    {
        return Some(found);
    }
    if let Some(found) = lookup_key(state, &origin, key_id).await {
        return Some(found);
    }
    // Budgeted: attacker-chosen `origin`/`key_id` must not trigger free outbound requests.
    if let Err(e) = refresh_keys_for_stranger(state, &origin).await {
        tracing::debug!(target: crate::logcat::FEDERATION, %origin, %key_id, error = %e, "key refresh failed");
        return None;
    }
    lookup_key(state, &origin, key_id).await
}

pub async fn verify_key_at(
    state: &AppState,
    origin: &str,
    key_id: &str,
    at: i64,
) -> Option<String> {
    let origin = normalise_origin(origin);

    if origin == state.signing_origin.as_str()
        && key_id == state.key.key_id
        && state.key.valid_from <= at
        && state.key.valid_until > at
    {
        return Some(state.key.public_b64());
    }

    if origin == state.cfg.server_name && state.signing_origin.as_str() == state.cfg.server_name {
        return sqlx::query_scalar(
            "SELECT public_b64 FROM server_keys \
             WHERE key_id = ? AND valid_from <= ? AND valid_until > ?",
        )
        .bind(key_id)
        .bind(at)
        .bind(at)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    }

    if let Some(found) = crate::relocation::previous_name_key(state, &origin, key_id, at).await {
        return Some(found);
    }
    if let Some(found) = lookup_key_at(state, &origin, key_id, at).await {
        return Some(found);
    }
    if let Err(e) = refresh_keys_for_stranger(state, &origin).await {
        tracing::debug!(target: crate::logcat::FEDERATION, %origin, %key_id, at, error = %e, "historical key refresh failed");
        return None;
    }
    lookup_key_at(state, &origin, key_id, at).await
}

async fn lookup_key_at(state: &AppState, origin: &str, key_id: &str, at: i64) -> Option<String> {
    sqlx::query_scalar(
        "SELECT public_b64 FROM remote_keys \
         WHERE origin = ? AND key_id = ? AND valid_from <= ? AND valid_until > ?",
    )
    .bind(origin)
    .bind(key_id)
    .bind(at)
    .bind(at)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

async fn lookup_key(state: &AppState, origin: &str, key_id: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT public_b64 FROM remote_keys \
         WHERE origin = ? AND key_id = ? AND valid_from <= ? AND valid_until > ?",
    )
    .bind(origin)
    .bind(key_id)
    .bind(now_ms())
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

pub async fn verify_assertion(
    state: &AppState,
    token: &str,
    audience: &str,
) -> ApiResult<crypto::AssertionClaims> {
    let (origin, key_id) = crypto::assertion_parts(token)?;
    ensure_reachable(state, &origin, "identity").await?;
    let public = verify_key(state, &origin, &key_id).await.ok_or_else(|| {
        ApiError::Unauthorized(format!("no published key {key_id} for origin {origin}"))
    })?;
    let claims = crypto::verify_assertion(token, audience, |_, _| Some(public.clone()))?;

    // The account must live at `origin`, or any homeserver could mint sessions for another's users.
    let Some(claimed_home) = domain_of(&claims.user_id) else {
        return Err(ApiError::Unauthorized(format!(
            "assertion carries a malformed user id {}",
            claims.user_id
        )));
    };
    let claimed_home = normalise_origin(claimed_home);
    let signer = normalise_origin(&origin);
    if claimed_home != signer
        && crate::relocation::current_domain(state, &claimed_home).await != signer
    {
        return Err(ApiError::Unauthorized(format!(
            "{} is not an account of {signer}, which signed the assertion",
            claims.user_id
        )));
    }
    Ok(claims)
}

pub fn signing_payload(
    method: &str,
    path: &str,
    body: &[u8],
    timestamp: i64,
    origin: &str,
    destination: &str,
) -> Vec<u8> {
    let value = json!({
        "method": method.to_ascii_uppercase(),
        "path": path,
        "body_hash": blake3::hash(body).to_hex().to_string(),
        "timestamp": timestamp,
        "origin": origin,
        "destination": destination,
    });
    serde_json::to_vec(&value).expect("json value is serialisable")
}

pub fn auth_header(
    key: &ServerKey,
    method: &str,
    path: &str,
    body: &[u8],
    origin: &str,
    destination: &str,
) -> String {
    let ts = now_ms();
    let payload = signing_payload(method, path, body, ts, origin, destination);
    let sig = ed25519_dalek::Signer::sign(&key.signing, &payload);
    format!(
        "{AUTH_SCHEME} origin={origin},destination={destination},key={},ts={ts},sig={}",
        key.key_id,
        b64(&sig.to_bytes())
    )
}

fn parse_header(value: &str) -> Option<std::collections::HashMap<&str, &str>> {
    let rest = value.strip_prefix(AUTH_SCHEME)?.trim_start();
    let mut map = std::collections::HashMap::new();
    for part in rest.split(',') {
        let (k, v) = part.trim().split_once('=')?;
        map.insert(k.trim(), v.trim());
    }
    Some(map)
}

pub fn check_envelope(state: &AppState, header: &str) -> ApiResult<String> {
    let fields = parse_header(header)
        .ok_or_else(|| ApiError::Unauthorized("malformed federation authorization".into()))?;
    let get = |k: &str| -> ApiResult<String> {
        fields
            .get(k)
            .map(|v| v.to_string())
            .ok_or_else(|| ApiError::Unauthorized(format!("federation authorization lacks {k}")))
    };
    let destination = get("destination")?;
    if destination != state.cfg.server_name {
        return Err(ApiError::Unauthorized(format!(
            "request was addressed to {destination}, not {}",
            state.cfg.server_name
        )));
    }
    let ts: i64 = get("ts")?
        .parse()
        .map_err(|_| ApiError::Unauthorized("federation timestamp is not a number".into()))?;
    // Saturating: `ts` is attacker-chosen and `i64::MIN` overflows.
    if now_ms().saturating_sub(ts).saturating_abs()
        > state.cfg.federation.max_clock_skew_secs * 1000
    {
        return Err(ApiError::Unauthorized(
            "federation timestamp is outside the skew window".into(),
        ));
    }
    Ok(normalise_origin(&get("origin")?))
}

pub async fn verify_request(
    state: &AppState,
    header: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> ApiResult<String> {
    let origin = check_envelope(state, header)?;
    verify_signed_by(state, header, method, path, body, origin).await
}

async fn verify_signed_by(
    state: &AppState,
    header: &str,
    method: &str,
    path: &str,
    body: &[u8],
    origin: String,
) -> ApiResult<String> {
    let fields = parse_header(header)
        .ok_or_else(|| ApiError::Unauthorized("malformed federation authorization".into()))?;
    let get = |k: &str| -> ApiResult<String> {
        fields
            .get(k)
            .map(|v| v.to_string())
            .ok_or_else(|| ApiError::Unauthorized(format!("federation authorization lacks {k}")))
    };
    let signer = normalise_origin(fields.get("signer").copied().unwrap_or(origin.as_str()));
    let destination = get("destination")?;
    let key_id = get("key")?;
    let sig = get("sig")?;
    let ts: i64 = get("ts")?
        .parse()
        .map_err(|_| ApiError::Unauthorized("federation timestamp is not a number".into()))?;
    ensure_reachable(state, &origin, "all").await?;

    if signer != origin {
        ensure_reachable(state, &signer, "all").await?;
        let encoded = get("authority")?;
        let bytes = unb64(&encoded)
            .ok_or_else(|| ApiError::Unauthorized("authority proof is not base64".into()))?;
        let record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| ApiError::Unauthorized("authority proof is malformed".into()))?;
        let authority = crate::promotion::verify(state, &record, &origin).await?;
        if authority.domain != signer {
            return Err(ApiError::Unauthorized(format!(
                "promotion authorises {}, not {signer}",
                authority.domain
            )));
        }
    }

    let public = verify_key(state, &signer, &key_id)
        .await
        .ok_or_else(|| ApiError::Unauthorized(format!("no key {key_id} published by {signer}")))?;
    let payload = signing_payload(method, path, body, ts, &origin, &destination);
    if unb64(&sig).is_none() || !crypto::verify_bytes(&public, &payload, &sig) {
        return Err(ApiError::Unauthorized(
            "federation signature is invalid".into(),
        ));
    }
    Ok(origin)
}

async fn outbound_auth_header(
    state: &AppState,
    method: &str,
    path: &str,
    body: &[u8],
    destination: &str,
) -> ApiResult<String> {
    if state.demoted.load(std::sync::atomic::Ordering::Relaxed) {
        return Err(ApiError::Conflict(
            "this server has been superseded and may not originate federation".into(),
        ));
    }
    let mut header = auth_header(
        &state.key,
        method,
        path,
        body,
        &state.cfg.server_name,
        destination,
    );
    if state.signing_origin.as_str() != state.cfg.server_name {
        let record = crate::promotion::current_record(state)
            .await?
            .ok_or_else(|| {
                ApiError::Conflict("this delegated authority has no promotion proof".into())
            })?;
        if record.get("authority").and_then(Value::as_str) != Some(state.signing_origin.as_str()) {
            return Err(ApiError::Conflict(
                "this server is not the authority named by its promotion proof".into(),
            ));
        }
        let encoded = b64(record.to_string().as_bytes());
        header.push_str(&format!(
            ",signer={},authority={encoded}",
            state.signing_origin
        ));
    }
    Ok(header)
}

const FED_JSON_MAX_BYTES: usize = UNGATED_MB * 1024 * 1024;

async fn read_capped(
    mut resp: reqwest::Response,
    max_bytes: usize,
    who: &str,
) -> ApiResult<Vec<u8>> {
    let too_large =
        || ApiError::TooLarge(format!("{who} answered with more than {max_bytes} bytes"));
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(too_large());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| ApiError::BadRequest(format!("{who}: {e}")))?
    {
        if out.len() + chunk.len() > max_bytes {
            return Err(too_large());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

async fn json_capped(resp: reqwest::Response, max_bytes: usize, who: &str) -> ApiResult<Value> {
    let bytes = read_capped(resp, max_bytes, who).await?;
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::BadRequest(format!("{who} answered with unreadable json: {e}")))
}

async fn json_capped_or_null(resp: reqwest::Response, max_bytes: usize, who: &str) -> Value {
    match json_capped(resp, max_bytes, who).await {
        Ok(value) => value,
        Err(e) => {
            tracing::debug!(target: crate::logcat::FEDERATION, peer = %who, error = %e, "discarding a peer's answer");
            Value::Null
        }
    }
}

async fn send_once(
    state: &AppState,
    peer: &Peer,
    destination: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    within: Option<std::time::Duration>,
) -> ApiResult<(axum::http::StatusCode, Value)> {
    let bytes = body
        .map(|b| serde_json::to_vec(b).unwrap_or_default())
        .unwrap_or_default();
    let header = outbound_auth_header(state, method, path, &bytes, &peer.origin).await?;
    let parsed_method: axum::http::Method = method
        .parse()
        .map_err(|_| ApiError::BadRequest("bad method".into()))?;
    let url = format!("{}{path}", peer.api_base);
    let mut req = with_compat_headers(
        state
            .http
            .request(parsed_method, url)
            .header(axum::http::header::AUTHORIZATION, header),
    );
    if let Some(within) = within {
        req = req.timeout(within);
    }
    if body.is_some() {
        req = req
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(bytes);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| unreachable_peer(destination, &e))?;
    let status = resp.status();
    // Load-bearing: reached from anonymous handlers via `routes::identity::ask_home`.
    let value: Value = json_capped_or_null(resp, FED_JSON_MAX_BYTES, destination).await;
    Ok((status, value))
}

fn unreachable_peer(destination: &str, e: &reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::GatewayTimeout(format!("{destination}: {e}"))
    } else {
        ApiError::BadGateway(format!("{destination}: {e}"))
    }
}

async fn send(
    state: &AppState,
    destination: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> ApiResult<Value> {
    send_within(state, destination, method, path, body, None).await
}

async fn send_within(
    state: &AppState,
    destination: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    within: Option<std::time::Duration>,
) -> ApiResult<Value> {
    let _: axum::http::Method = method
        .parse()
        .map_err(|_| ApiError::BadRequest("bad method".into()))?;
    if state.signing_origin.as_str() != state.cfg.server_name
        && crate::promotion::current_record(state).await?.is_none()
    {
        return Err(ApiError::Conflict(
            "this delegated authority has no promotion proof".into(),
        ));
    }

    let (destination, path) = crate::relocation::follow(state, destination, path).await;
    let (destination, path) = (destination.as_str(), path.as_str());

    let peer = discover(state, destination).await?;
    let first = send_once(state, &peer, destination, method, path, body, within).await;
    let (mut status, mut value) = match first {
        Ok(result) => result,
        Err(first_err) => {
            if let Some(fallback) = promoted_fallback(state, destination).await? {
                send_once(state, &fallback, destination, method, path, body, within).await?
            } else {
                return Err(first_err);
            }
        }
    };

    if status == axum::http::StatusCode::CONFLICT
        && value.get("error").and_then(Value::as_str) == Some("demoted")
    {
        if let (Some(record), Some(authority)) = (
            value.get("record"),
            value.get("authority").and_then(Value::as_str),
        ) {
            let path_prefix = crate::replicate::mount_path(destination);
            let verified = crate::promotion::verify(state, record, destination).await?;
            if verified.domain == authority {
                let host = discover(state, authority).await?;
                let delegated = Peer {
                    origin: destination.to_string(),
                    api_base: format!("{}{}", host.api_base.trim_end_matches('/'), path_prefix),
                    gateway: None,
                    moved_to: None,
                };
                (status, value) =
                    send_once(state, &delegated, destination, method, path, body, within).await?;
            }
        }
    }

    if !status.is_success() {
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("remote server refused")
            .to_string();
        let refusal = match status.as_u16() {
            401 | 403 => ApiError::Forbidden(format!("{destination}: {message}")),
            404 => ApiError::NotFound(format!("{destination}: {message}")),
            409 if value.get("error").and_then(Value::as_str) == Some("try_again") => {
                ApiError::TryAgain(format!("{destination}: {message}"))
            }
            // Older peers send `conflict` for these; match the sentence narrowly.
            409 if message.contains("is arriving here right now")
                || message.contains("landed here while this one was arriving") =>
            {
                if !peer_supports(state, destination, compat::CAP_MIGRATE_TRY_AGAIN).await {
                    tracing::debug!(
                        target: crate::logcat::FEDERATION,
                        %destination,
                        "reading a conflict as retryable from its wording; the peer does not \
                         advertise the try_again capability"
                    );
                }
                ApiError::TryAgain(format!("{destination}: {message}"))
            }
            409 => ApiError::Conflict(format!("{destination}: {message}")),
            413 => ApiError::TooLarge(format!("{destination}: {message}")),
            429 => ApiError::RateLimited(format!("{destination}: {message}")),
            503 => ApiError::UpstreamUnavailable(format!("{destination}: {message}")),
            504 => ApiError::GatewayTimeout(format!("{destination}: {message}")),
            500..=599 => ApiError::BadGateway(format!("{destination}: {message}")),
            _ => ApiError::BadRequest(format!("{destination}: {message}")),
        };
        return Err(refusal.with_remote_code(&value));
    }
    Ok(value)
}

pub async fn get_signed(state: &AppState, destination: &str, path: &str) -> ApiResult<Value> {
    send(state, destination, "GET", path, None).await
}

fn default_body_cap(state: &AppState) -> usize {
    state.cfg.media_policy.max_file_bytes.saturating_add(1 << 20)
}

pub async fn get_signed_bytes(
    state: &AppState,
    destination: &str,
    path: &str,
    query: Option<&str>,
) -> ApiResult<(Vec<u8>, String, u16)> {
    let cap = default_body_cap(state);
    get_signed_bytes_capped(state, destination, path, query, cap).await
}

enum SignedResponse {
    Body(reqwest::Response),
    Conflict,
}

async fn signed_response(
    state: &AppState,
    destination: &str,
    path: &str,
    query: Option<&str>,
) -> ApiResult<SignedResponse> {
    let (destination, path) = crate::relocation::follow(state, destination, path).await;
    let (destination, path) = (destination.as_str(), path.as_str());
    async fn fetch(
        state: &AppState,
        peer: &Peer,
        path: &str,
        query: Option<&str>,
    ) -> ApiResult<reqwest::Response> {
        let header = outbound_auth_header(state, "GET", path, b"", &peer.origin).await?;
        let mut url = format!("{}{path}", peer.api_base);
        if let Some(q) = query {
            url.push('?');
            url.push_str(q);
        }
        with_compat_headers(
            state
                .http
                .get(url)
                .header(axum::http::header::AUTHORIZATION, header),
        )
        .send()
        .await
        .map_err(|e| unreachable_peer(&peer.origin, &e))
    }

    let peer = discover(state, destination).await?;
    let first = fetch(state, &peer, path, query).await;
    let mut resp = match first {
        Ok(resp) => resp,
        Err(first_err) => {
            let Some(fallback) = promoted_fallback(state, destination).await? else {
                return Err(first_err);
            };
            fetch(state, &fallback, path, query).await?
        }
    };

    if resp.status() == axum::http::StatusCode::CONFLICT {
        let value: Value = json_capped_or_null(resp, 64 * 1024, destination).await;
        if value.get("error").and_then(Value::as_str) == Some("demoted") {
            let (Some(record), Some(authority)) = (
                value.get("record"),
                value.get("authority").and_then(Value::as_str),
            ) else {
                return Err(ApiError::Forbidden(
                    "demoted server did not say who took over for it".into(),
                ));
            };
            let verified = crate::promotion::verify(state, record, destination).await?;
            if verified.domain != authority {
                return Err(ApiError::Forbidden(
                    "demoted server named an authority its proof does not authorize".into(),
                ));
            }
            let host = Box::pin(discover(state, authority)).await?;
            let delegated = Peer {
                origin: destination.to_string(),
                api_base: format!(
                    "{}{}",
                    host.api_base.trim_end_matches('/'),
                    crate::replicate::mount_path(destination)
                ),
                gateway: None,
                moved_to: None,
            };
            resp = fetch(state, &delegated, path, query).await?;
        } else {
            return Ok(SignedResponse::Conflict);
        }
    }
    Ok(SignedResponse::Body(resp))

}

pub async fn get_signed_to_file(
    state: &AppState,
    destination: &str,
    path: &str,
    query: Option<&str>,
    dest: &std::path::Path,
    max_bytes: usize,
) -> ApiResult<(u16, u64)> {
    use tokio::io::AsyncWriteExt as _;

    let mut resp = match signed_response(state, destination, path, query).await? {
        SignedResponse::Body(resp) => resp,
        SignedResponse::Conflict => return Ok((409, 0)),
    };
    let status = resp.status().as_u16();
    if status != 200 {
        return Ok((status, 0));
    }
    let too_large =
        || ApiError::TooLarge(format!("{destination} answered with more than {max_bytes} bytes"));
    if resp.content_length().is_some_and(|n| n > max_bytes as u64) {
        return Err(too_large());
    }

    let mut file =
        tokio::fs::File::create(dest).await.map_err(|e| ApiError::Internal(e.into()))?;
    let mut written: u64 = 0;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => {
                let _ = tokio::fs::remove_file(dest).await;
                return Err(ApiError::BadRequest(format!("{destination}: {e}")));
            }
        };
        if written + chunk.len() as u64 > max_bytes as u64 {
            let _ = file.shutdown().await;
            let _ = tokio::fs::remove_file(dest).await;
            return Err(too_large());
        }
        if let Err(e) = file.write_all(&chunk).await {
            let _ = tokio::fs::remove_file(dest).await;
            return Err(ApiError::Internal(e.into()));
        }
        written += chunk.len() as u64;
    }
    // Flush explicitly: drop cannot report a write error.
    file.flush().await.map_err(|e| ApiError::Internal(e.into()))?;
    file.sync_all().await.map_err(|e| ApiError::Internal(e.into()))?;
    Ok((status, written))
}

pub async fn get_signed_bytes_capped(
    state: &AppState,
    destination: &str,
    path: &str,
    query: Option<&str>,
    max_bytes: usize,
) -> ApiResult<(Vec<u8>, String, u16)> {
    let resp = match signed_response(state, destination, path, query).await? {
        SignedResponse::Body(resp) => resp,
        SignedResponse::Conflict => return Ok((Vec::new(), "application/json".into(), 409)),
    };
    let status = resp.status().as_u16();
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = read_capped(resp, max_bytes, destination).await?;
    Ok((bytes, mime, status))
}

pub async fn optional_origin(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    method: &str,
    path: &str,
) -> Option<String> {
    let header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())?;
    if !header.starts_with(AUTH_SCHEME) {
        return None;
    }
    match verify_request(state, header, method, path, b"").await {
        Ok(origin) => Some(origin),
        Err(e) => {
            tracing::debug!(target: crate::logcat::FEDERATION, error = %e, "ignoring an invalid federation signature");
            None
        }
    }
}

pub async fn post_signed(
    state: &AppState,
    destination: &str,
    path: &str,
    body: &Value,
) -> ApiResult<Value> {
    send(state, destination, "POST", path, Some(body)).await
}

pub const MIGRATION_PUSH: std::time::Duration =
    std::time::Duration::from_secs(BIG_BODY_READ_SECS + 900);

pub async fn post_signed_within(
    state: &AppState,
    destination: &str,
    path: &str,
    body: &Value,
    within: std::time::Duration,
) -> ApiResult<Value> {
    send_within(state, destination, "POST", path, Some(body), Some(within)).await
}

pub async fn ensure_reachable(state: &AppState, domain: &str, scope: &str) -> ApiResult<()> {
    let domain = normalise_origin(domain);
    if domain == state.cfg.server_name {
        return Ok(());
    }
    let blocked: Option<String> = sqlx::query_scalar(
        "SELECT scope FROM defederation WHERE domain = ? AND (scope = 'all' OR scope = ?)",
    )
    .bind(&domain)
    .bind(scope)
    .fetch_optional(&state.pool)
    .await?;
    match blocked {
        Some(_) => Err(ApiError::Forbidden(format!(
            "{domain} is defederated from this server"
        ))),
        None => Ok(()),
    }
}

pub async fn is_defederated(state: &AppState, domain: &str, scope: &str) -> bool {
    ensure_reachable(state, domain, scope).await.is_err()
}

pub fn domain_of(id: &str) -> Option<&str> {
    id.rsplit_once(':').map(|(_, d)| d)
}

pub fn is_local(state: &AppState, id: &str) -> bool {
    domain_of(id)
        .map(|d| d == state.cfg.server_name)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_peer_cannot_move_us_off_https_by_saying_so() {
        assert!(api_base_scheme_ok("https://peer.test", false));
        assert!(!api_base_scheme_ok("http://peer.test", false));
        assert!(!api_base_scheme_ok("http://169.254.169.254", false));
        assert!(!api_base_scheme_ok("file:///etc/passwd", false));
        assert!(!api_base_scheme_ok("peer.test", false));
        assert!(!api_base_scheme_ok("", false));
        assert!(api_base_scheme_ok("http://127.0.0.1:8080", true));
        assert!(api_base_scheme_ok("https://peer.test", true));
        assert!(!api_base_scheme_ok("ftp://peer.test", true));
    }
}
