
use crate::auth::HomeAuth;
use crate::error::ApiResult;
use crate::federation::routes::require_admin;
use crate::hosting;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

pub async fn providers(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let listed = if state.cfg.hosting.enabled { hosting::providers(&state).await? } else { Vec::new() };
    Ok(Json(json!({
        "enabled": state.cfg.hosting.enabled,
        "self_hosted": {
            "server_name": state.cfg.server_name,
            "available": state.cfg.roles.guild,
        },
        "providers": listed,
        "portability": {
            "guided_handoff": state.cfg.federation.enabled,
        },
    })))
}

pub async fn catalog(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(hosting::publish(&state).await?))
}

pub async fn publication(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(hosting::published_at(&state).await?))
}

pub async fn admin_catalogs(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    Ok(Json(json!({
        "enabled": state.cfg.hosting.enabled,
        "catalogs": hosting::statuses(&state).await?,
        "published": hosting::published_at(&state).await?,
    })))
}

pub async fn admin_refresh(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let results = hosting::refresh_all(&state).await?;
    let failed = results.iter().filter(|r| !r["error"].is_null()).count();
    let skipped = results.iter().filter(|r| !r["skipped"].is_null()).count();
    crate::admin::record(
        &state,
        &auth.user_id,
        "hosting.catalogs.refresh",
        None,
        json!({ "catalogs": results.len(), "failed": failed, "skipped": skipped }),
    )
    .await;
    Ok(Json(json!({ "ok": failed == 0, "results": results })))
}
