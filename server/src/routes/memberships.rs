
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::Fed;
use crate::memberships;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn notice(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    fed: Fed<Value>,
) -> ApiResult<Json<Value>> {
    memberships::record_notice(&state, &fed.origin, &user_id, &fed.body).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Report {
    pub guild_server: String,
    #[serde(default)]
    pub guild_ids: Vec<String>,
}

pub async fn report(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<Report>,
) -> ApiResult<Json<Value>> {
    if req.guild_server.is_empty() || req.guild_server.contains('/') {
        return Err(ApiError::BadRequest("guild_server must be a server name".into()));
    }
    if req.guild_ids.len() > 1000 {
        return Err(ApiError::BadRequest("too many guilds in one report".into()));
    }
    memberships::reconcile_from_client(&state, &auth.user_id, &req.guild_server, &req.guild_ids).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "memberships": memberships::export(&state, &auth.user_id).await? })))
}

#[derive(Deserialize)]
pub struct Moved {
    pub old_id: String,
    pub new_id: String,
}

pub async fn moved(
    State(state): State<AppState>,
    Path(old_id): Path<String>,
    fed: Fed<Moved>,
) -> ApiResult<Json<Value>> {
    if fed.body.old_id != old_id {
        return Err(ApiError::BadRequest("body and path disagree about the old id".into()));
    }
    Ok(Json(memberships::apply_move_notice(&state, &fed.origin, &old_id, &fed.body.new_id).await?))
}

pub async fn revoked(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    fed: Fed<crate::revocation::Notice>,
) -> ApiResult<Json<Value>> {
    if fed.body.user_id != user_id {
        return Err(ApiError::BadRequest("body and path disagree about the account".into()));
    }
    Ok(Json(crate::revocation::receive(&state, &fed.origin, &fed.body).await?))
}

pub async fn move_status(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    Ok(Json(json!({ "moves": memberships::status(&state, &auth.user_id).await? })))
}

pub async fn move_retry(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let retried = memberships::retry_failed(&state, &auth.user_id).await?;
    Ok(Json(json!({ "retried": retried })))
}
