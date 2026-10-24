use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

const LEAVE_PATH: &str = "/_telium/v1/dm/leave";
const DEPARTED_PATH: &str = "/_telium/v1/dm/departed";

#[derive(Deserialize)]
pub struct MemberChange {
    pub user_id: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub epoch: i64,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub generation: Option<i64>,
}

pub async fn add_member(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<MemberChange>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    if kind == "dm" {
        return Err(ApiError::BadRequest(
            "a dm has two participants; start a group chat instead".into(),
        ));
    }
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;
    if count as usize >= MAX_GROUP_MEMBERS {
        return Err(ApiError::Conflict(format!(
            "group chats hold up to {MAX_GROUP_MEMBERS} people; convert it to a guild to grow"
        )));
    }
    let home = home_of(&req.user_id)?;
    if home != state.cfg.server_name {
        federation::ensure_reachable(&state, &home, "dm").await?;
    }
    let change = Change { op: "add".into(), user_ids: vec![req.user_id.clone()], policy: None };
    authorize_change(&state, &id, "commit", &auth.user_id, &change).await?;

    let msg = match &req.commit {
        Some(commit) => {
            let extras = FrameExtras {
                notification_id: None,
                frame_id: req.frame_id.as_deref(),
                welcome: req.welcome.as_deref(),
                generation: req.generation,
                start_over: false,
            };
            validate_extras("commit", &extras)?;
            Some(
                forward_or_sequence(
                    &state, &id, "commit", &auth, commit, req.epoch, extras, Some(&change),
                )
                .await?,
            )
        }
        None => {
            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
                 VALUES (?, ?, ?, ?) \
                 ON CONFLICT(conversation_id, user_id) DO UPDATE SET state = 'active'",
            )
            .bind(&id)
            .bind(&req.user_id)
            .bind(&home)
            .bind(now_ms())
            .execute(&state.pool)
            .await?;
            None
        }
    };
    Ok(Json(json!({ "ok": true, "commit": msg })))
}

pub async fn remove_member(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<MemberChange>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let commit = req.commit.as_deref().ok_or_else(|| {
        ApiError::BadRequest("removing somebody takes the MLS commit that removes them".into())
    })?;
    let change = Change { op: "remove".into(), user_ids: vec![req.user_id.clone()], policy: None };
    authorize_change(&state, &id, "commit", &auth.user_id, &change).await?;
    let extras = FrameExtras {
        notification_id: None,
        frame_id: req.frame_id.as_deref(),
        welcome: None,
        generation: req.generation,
        start_over: false,
    };
    validate_extras("commit", &extras)?;
    let msg = forward_or_sequence(
        &state, &id, "commit", &auth, commit, req.epoch, extras, Some(&change),
    )
    .await?;
    if let Err(e) = sqlx::query(
        "UPDATE conversation_members SET state = 'removed' WHERE conversation_id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&req.user_id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "removal not mirrored locally");
    }
    if let Err(e) = sync_dm_pair(&state, &id).await {
        tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm pair not resynced after removal");
    }
    if let Err(e) = crate::routes::voice::disconnect(&state, &id, &req.user_id).await {
        tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "removed member not disconnected from call");
    }
    Ok(Json(json!({ "ok": true, "commit": msg })))
}

#[derive(Deserialize)]
pub struct NotificationPreference {
    pub muted: bool,
}

pub async fn set_notification_preference(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<NotificationPreference>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    sqlx::query(
        "UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?",
    )
    .bind(i64::from(req.muted))
    .bind(&id)
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "muted": req.muted })))
}

pub async fn leave_conversation(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let sequencer: String = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    if sequencer == state.cfg.server_name {
        return depart(&state, &id, &auth.user_id).await.map(|()| Json(json!({ "ok": true })));
    }
    crate::routes::voice::disconnect(&state, &id, &auth.user_id).await?;
    federation::post_signed(
        &state,
        &sequencer,
        LEAVE_PATH,
        &json!({ "conversation_id": id, "user_id": auth.user_id }),
    )
    .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn depart(state: &AppState, conversation_id: &str, user_id: &str) -> ApiResult<()> {
    crate::routes::voice::disconnect(state, conversation_id, user_id).await?;
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;

    let moved = sqlx::query(
        "UPDATE conversation_members SET state = 'left', resync = 1 \
         WHERE conversation_id = ? AND user_id = ? AND state = 'active'",
    )
    .bind(conversation_id)
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    if moved.rows_affected() == 0 {
        return Ok(());
    }
    sync_dm_pair(state, conversation_id).await?;

    let data = json!({ "conversation_id": conversation_id, "user_id": user_id });
    let mut remotes: Vec<String> = Vec::new();
    for (member, home) in members {
        if home == state.cfg.server_name {
            state
                .hub
                .publish_user(&member, Event::to_account("DM_MEMBER_LEAVE", &member, data.clone()))
                .await;
        } else if !remotes.contains(&home) {
            remotes.push(home);
        }
    }
    if !remotes.is_empty() {
        let descriptor = conversation_json(state, conversation_id).await?;
        for destination in remotes {
            queue(
                state,
                conversation_id,
                &ulid(),
                &destination,
                DEPARTED_PATH,
                &json!({ "conversation": descriptor, "user_id": user_id }),
            )
            .await?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Departure {
    pub conversation_id: String,
    pub user_id: String,
}

pub async fn inbound_leave(
    State(state): State<AppState>,
    fed: Fed<Departure>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let sequencer: Option<String> =
        sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
            .bind(&fed.body.conversation_id)
            .fetch_optional(&state.pool)
            .await?;
    match sequencer {
        Some(s) if s == state.cfg.server_name => {}
        Some(s) => {
            return Err(ApiError::Conflict(format!("this conversation is sequenced by {s}")))
        }
        None => return Err(ApiError::NotFound("no such conversation".into())),
    }
    if home_of(&fed.body.user_id)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    depart(&state, &fed.body.conversation_id, &fed.body.user_id).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Departed {
    pub conversation: Value,
    pub user_id: String,
}

pub async fn inbound_departed(
    State(state): State<AppState>,
    fed: Fed<Departed>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let conv = &fed.body.conversation;
    let id = conv
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("conversation descriptor has no id".into()))?;
    if conv.get("sequencer").and_then(Value::as_str) != Some(fed.origin.as_str()) {
        return Err(ApiError::Forbidden("only the sequencer speaks for a conversation".into()));
    }
    let locals: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND home_domain = ? \
         AND state = 'active'",
    )
    .bind(id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await?;
    upsert_conversation_from_sequencer(&state, conv).await?;
    crate::routes::voice::disconnect(&state, id, &fed.body.user_id).await?;

    let data = json!({ "conversation_id": id, "user_id": fed.body.user_id });
    for user_id in locals {
        state
            .hub
            .publish_user(&user_id, Event::to_account("DM_MEMBER_LEAVE", &user_id, data.clone()))
            .await;
    }
    Ok(Json(json!({ "ok": true })))
}
