use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct Promotion {
    pub guild_id: String,
    pub announcement: String,
}

pub async fn promote_to_guild(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<Promotion>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    if kind != "gc" {
        return Err(ApiError::BadRequest("only a group chat becomes a guild".into()));
    }
    sqlx::query("UPDATE conversations SET promoted_to = ?, promoted_at = ? WHERE id = ?")
        .bind(&req.guild_id)
        .bind(now_ms())
        .bind(&id)
        .execute(&state.pool)
        .await?;
    let msg =
        forward_or_sequence(
            &state,
            &id,
            "application",
            &auth,
            &req.announcement,
            0,
            FrameExtras::default(),
            None,
        )
        .await?;
    Ok(Json(json!({
        "promoted_to": req.guild_id,
        "announcement": msg,
        "note": "the group's history stays here and stays encrypted; it does not move into the guild",
    })))
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn forward_or_sequence(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    auth: &HomeAuth,
    ciphertext: &str,
    epoch: i64,
    extras: FrameExtras<'_>,
    change: Option<&Change>,
) -> ApiResult<Value> {
    route_frame(state, conversation_id, kind, auth, ciphertext, epoch, extras, change, false).await
}
