use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub tail: Option<i64>,
}

pub async fn history(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if !local_dm_policy(&state, &id, &auth.user_id).await?.visible {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let after = q.after.unwrap_or(0);
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    // No holes in the catch-up window: fill from the sequencer or stop below the gap.
    let missing = if q.tail.is_none() {
        repair(&state, &id, after, Some(after.saturating_add(limit))).await?
    } else {
        None
    };
    #[allow(clippy::type_complexity)]
    let mut rows: Vec<(String, i64, i64, String, String, Option<String>, String, i64, i64)> =
        match q.tail {
            Some(tail) => sqlx::query_as(
                "SELECT id, seq, epoch, kind, sender, sender_device, ciphertext, created_at, \
                 generation FROM dm_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?",
            )
            .bind(&id)
            .bind(after)
            .bind(tail.clamp(1, 500))
            .fetch_all(&state.pool)
            .await?,
            None => sqlx::query_as(
                "SELECT id, seq, epoch, kind, sender, sender_device, ciphertext, created_at, \
                 generation FROM dm_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?",
            )
            .bind(&id)
            .bind(after)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?,
        };
    if q.tail.is_some() {
        rows.reverse();
    }
    if let Some(hole) = missing {
        rows.retain(|r| r.1 < hole);
    }
    let mut answer = json!({
        "conversation_id": id,
        "messages": rows.into_iter()
            .map(|(id, seq, epoch, kind, sender, device, ct, created, generation)| json!({
                "id": id, "seq": seq, "epoch": epoch, "kind": kind, "sender": sender,
                "sender_device": device, "ciphertext": ct, "created_at": created,
                "generation": generation,
            }))
            .collect::<Vec<_>>(),
    });
    if let Some(hole) = missing {
        answer["incomplete"] = Value::Bool(true);
        answer["missing_from"] = json!(hole);
    }
    Ok(Json(answer))
}
