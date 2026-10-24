use super::normalise_origin;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;
use telium_protocol::compat::{self, PeerCompat};

pub(super) fn with_compat_headers(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    let local = PeerCompat::local();
    req.header(compat::PROTOCOL_HEADER, local.version.to_string())
        .header(compat::MIN_PROTOCOL_HEADER, local.min_supported.to_string())
        .header(compat::CAPABILITIES_HEADER, local.capability_header())
}

fn compat_from_headers(headers: &axum::http::HeaderMap) -> PeerCompat {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    PeerCompat::from_wire(
        get(compat::PROTOCOL_HEADER),
        get(compat::MIN_PROTOCOL_HEADER),
        get(compat::CAPABILITIES_HEADER),
    )
}

pub fn compat_from_discovery(doc: &Value) -> PeerCompat {
    if let Some(block) = doc.get("protocol").filter(|b| b.is_object()) {
        let capabilities = block
            .get("capabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(",")
            });
        return PeerCompat::from_wire(
            block.get("version").and_then(as_version_str).as_deref(),
            block.get("min_supported").and_then(as_version_str).as_deref(),
            capabilities.as_deref(),
        );
    }
    if let Some(legacy) = doc.get("protocol_version").and_then(Value::as_str) {
        return PeerCompat::from_wire(Some(legacy), Some(legacy), None);
    }
    PeerCompat::legacy()
}

fn as_version_str(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
}

pub(super) fn compat_status(peer: &PeerCompat) -> &'static str {
    match peer.negotiate() {
        Ok(_) => "ok",
        Err(why) => why.code(),
    }
}

pub async fn record_peer_compat(
    state: &AppState,
    origin: &str,
    peer: &PeerCompat,
) -> ApiResult<()> {
    let origin = normalise_origin(origin);
    if origin == state.cfg.server_name {
        return Ok(());
    }
    let capabilities = peer.capability_header();
    let status = compat_status(peer);

    // Read first, write only on change: SQLite has one writer.
    let stored: Option<(Option<i64>, Option<i64>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT protocol_version, protocol_min_supported, capabilities, compat_status \
             FROM remote_servers WHERE origin = ?",
        )
        .bind(&origin)
        .fetch_optional(&state.pool)
        .await?;
    match stored {
        None => return Ok(()),
        Some((version, min, caps, had)) => {
            if version == Some(i64::from(peer.version))
                && min == Some(i64::from(peer.min_supported))
                && caps.as_deref() == Some(capabilities.as_str())
                && had.as_deref() == Some(status)
            {
                return Ok(());
            }
        }
    }

    sqlx::query(
        "UPDATE remote_servers SET protocol_version = ?, protocol_min_supported = ?, \
             capabilities = ?, compat_status = ?, compat_checked_at = ? WHERE origin = ?",
    )
    .bind(i64::from(peer.version))
    .bind(i64::from(peer.min_supported))
    .bind(capabilities)
    .bind(status)
    .bind(now_ms())
    .bind(&origin)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn peer_compat(state: &AppState, origin: &str) -> ApiResult<PeerCompat> {
    let origin = normalise_origin(origin);
    if origin == state.cfg.server_name {
        return Ok(PeerCompat::local());
    }
    let row: Option<(Option<i64>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT protocol_version, protocol_min_supported, capabilities \
         FROM remote_servers WHERE origin = ?",
    )
    .bind(&origin)
    .fetch_optional(&state.pool)
    .await?;
    Ok(match row {
        Some((Some(version), min, capabilities)) => PeerCompat::from_wire(
            Some(&version.to_string()),
            min.map(|m| m.to_string()).as_deref(),
            capabilities.as_deref(),
        ),
        _ => PeerCompat::legacy(),
    })
}

pub async fn peer_supports(state: &AppState, origin: &str, capability: &str) -> bool {
    match peer_compat(state, origin).await {
        Ok(peer) => peer.has(capability),
        Err(e) => {
            tracing::debug!(target: crate::logcat::FEDERATION, %origin, %capability, error = %e, "could not read peer capabilities; assuming absent");
            false
        }
    }
}

pub(super) async fn note_inbound_compat(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    origin: &str,
) -> ApiResult<()> {
    let peer = compat_from_headers(headers);
    record_peer_compat(state, origin, &peer).await?;
    match peer.negotiate() {
        Ok(_) => Ok(()),
        Err(why) => {
            tracing::warn!(target: crate::logcat::FEDERATION, %origin, code = why.code(), "refused a federation request from an incompatible peer");
            Err(ApiError::Incompatible(format!(
                "{origin}: {why}. {}",
                why.remedy()
            )))
        }
    }
}
