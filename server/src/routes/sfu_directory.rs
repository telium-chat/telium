use crate::auth::{GuildAuth, HomeAuth};
use crate::error::ApiResult;
use crate::federation::routes::require_admin;
use crate::sfu_directory;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

/// GET /_telium/v1/voice/directory: the held public directory, with one
/// on-demand probe round so the numbers an owner is choosing from are current.
/// Triggered by a human opening the list, never a timer; until a relay is in
/// use, this round is the only health signal that is this fresh.
pub async fn directory(State(state): State<AppState>, _auth: GuildAuth) -> ApiResult<Json<Value>> {
    let relays = sfu_directory::relays(&state).await?;
    if relays.is_empty() {
        return Ok(Json(json!({
            "enabled": state.cfg.voice.directory.is_subscribed(),
            "entries": [],
        })));
    }
    let urls: Vec<String> = relays.iter().map(|r| r.url.clone()).collect();
    let probes = sfu_directory::probe_relays(&state, &urls).await;
    let entries: Vec<Value> = relays
        .into_iter()
        .map(|relay| {
            let probe = probes.iter().find(|(url, _)| *url == relay.url).map(|(_, probe)| *probe);
            json!({
                "url": relay.url,
                "name": relay.name,
                "description": relay.description,
                "region": relay.region,
                "region_label": relay.region_label,
                "operator_name": relay.operator_name,
                "contact": relay.contact,
                "capacity_band": relay.capacity_band,
                "weight": relay.weight,
                "pubkey_hint": relay.pubkey_hint,
                "reachable": probe.is_some_and(|p| p.ok),
                "latency_ms": probe.and_then(|p| p.latency_ms),
                "accepting": probe.and_then(|p| p.accepting),
            })
        })
        .collect();
    Ok(Json(json!({ "enabled": true, "entries": entries })))
}

pub async fn admin_directory(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    Ok(Json(json!({
        "enabled": state.cfg.voice.directory.enabled,
        "subscribed": state.cfg.voice.directory.is_subscribed(),
        "directory": sfu_directory::statuses(&state).await?,
    })))
}

pub async fn admin_refresh(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let results = sfu_directory::refresh_all(&state).await?;
    let failed = results.iter().filter(|r| !r["error"].is_null()).count();
    let skipped = results.iter().filter(|r| !r["skipped"].is_null()).count();
    crate::admin::record(
        &state,
        &auth.user_id,
        "sfu_directory.refresh",
        None,
        json!({ "directory": results.len(), "failed": failed, "skipped": skipped }),
    )
    .await;
    Ok(Json(json!({ "ok": failed == 0, "results": results })))
}
