use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

const TYPING_PATH: &str = "/_telium/v1/dm/typing";

pub async fn gateway_typing(
    state: &AppState,
    conversation_id: &str,
    sender: &str,
    active: bool,
) -> ApiResult<()> {
    if home_of(sender)? != state.cfg.server_name {
        return Err(ApiError::Forbidden("only an account's home may announce its typing".into()));
    }
    require_member(state, conversation_id, sender).await?;

    let event_name = if active { "DM_TYPING_START" } else { "DM_TYPING_STOP" };
    let data = json!({
        "conversation_id": conversation_id,
        "user_id": sender,
        "timestamp": now_ms(),
    });
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;

    let mut remotes = Vec::new();
    for (user_id, home) in members {
        if home == state.cfg.server_name {
            if user_id == sender
                || may_receive_dm_interaction(state, conversation_id, &user_id).await?
            {
                state.hub.publish_user(
                    &user_id,
                    Event::to_account(event_name, &user_id, data.clone()),
                ).await;
            }
        } else if !remotes.contains(&home) {
            remotes.push(home);
        }
    }

    for destination in remotes {
        let state = state.clone();
        let conversation_id = conversation_id.to_string();
        let sender = sender.to_string();
        tokio::spawn(async move {
            let body = json!({
                "conversation_id": conversation_id,
                "user_id": sender,
                "active": active,
            });
            if let Err(err) = federation::post_signed(&state, &destination, TYPING_PATH, &body).await {
                tracing::debug!(target: crate::logcat::SOCIAL, %err, %destination, "could not carry dm typing event");
            }
        });
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct InboundTyping {
    pub conversation_id: String,
    pub user_id: String,
    pub active: bool,
}

pub async fn inbound_typing(
    State(state): State<AppState>,
    fed: Fed<InboundTyping>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.user_id)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    require_member(&state, &fed.body.conversation_id, &fed.body.user_id).await?;

    let event_name = if fed.body.active { "DM_TYPING_START" } else { "DM_TYPING_STOP" };
    let data = json!({
        "conversation_id": fed.body.conversation_id,
        "user_id": fed.body.user_id,
        "timestamp": now_ms(),
    });
    let locals: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members \
         WHERE conversation_id = ? AND home_domain = ? AND state = 'active'",
    )
    .bind(&fed.body.conversation_id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await?;
    for user_id in locals {
        // Omit silently; don't reveal pending/declined/blocked to a remote sender.
        if may_receive_dm_interaction(&state, &fed.body.conversation_id, &user_id).await? {
            state.hub.publish_user(
                &user_id,
                Event::to_account(event_name, &user_id, data.clone()),
            ).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}
