use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct Submission {
    pub conversation_id: String,
    pub kind: String,
    pub sender: String,
    pub sender_device: Option<String>,
    pub ciphertext: String,
    #[serde(default)]
    pub epoch: i64,
    #[serde(default)]
    pub notification_id: Option<String>,
    #[serde(default)]
    pub change: Option<Change>,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub generation: Option<i64>,
    #[serde(default)]
    pub start_over: bool,
}

pub async fn inbound_submit(
    State(state): State<AppState>,
    fed: Fed<Submission>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;

    let sequencer: Option<String> =
        sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
            .bind(&req.conversation_id)
            .fetch_optional(&state.pool)
            .await?;
    match sequencer {
        Some(s) if s == state.cfg.server_name => {}
        Some(s) => return Err(not_sequencer(&s)),
        None => return Err(ApiError::NotFound("no such conversation".into())),
    }

    if home_of(&req.sender)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    require_member(&state, &req.conversation_id, &req.sender).await?;
    if let Some(notification_id) = req.notification_id.as_deref() {
        validate_notification_id(notification_id)?;
        if req.kind != "application" {
            return Err(ApiError::BadRequest(
                "only application frames carry a DM notification id".into(),
            ));
        }
    }

    if req.ciphertext.len() > MAX_FRAME_BYTES {
        return Err(ApiError::TooLarge("frame is too large".into()));
    }
    let extras = FrameExtras {
        notification_id: req.notification_id.as_deref(),
        frame_id: req.frame_id.as_deref(),
        welcome: req.welcome.as_deref(),
        generation: req.generation,
        start_over: req.start_over,
    };
    let msg = sequence_with_change(
        &state,
        &req.conversation_id,
        &req.kind,
        &req.sender,
        req.sender_device.as_deref(),
        &req.ciphertext,
        req.epoch,
        extras,
        req.change.as_ref(),
        req.notify,
    )
    .await?;
    Ok(Json(msg))
}

#[derive(Deserialize)]
pub struct Delivery {
    pub conversation: Value,
    pub message: Value,
    #[serde(default)]
    pub handoff: Option<Value>,
}

pub async fn inbound_deliver(
    State(state): State<AppState>,
    fed: Fed<Delivery>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let conv = &fed.body.conversation;
    let id = conv
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("conversation descriptor has no id".into()))?;
    let sequencer = conv.get("sequencer").and_then(Value::as_str).unwrap_or_default();
    if sequencer != fed.origin {
        return Err(ApiError::Forbidden("only the sequencer delivers for a conversation".into()));
    }

    // Sequencer identity is checked in the upsert's WHERE to avoid a read-then-write race.
    let known: Option<String> =
        sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let seq = fed.body.message.get("seq").and_then(Value::as_i64).unwrap_or(0);
    if let Err(e) = upsert_conversation_from_sequencer(&state, conv).await {
        if e.status() != axum::http::StatusCode::CONFLICT {
            return Err(e);
        }
        let carried = fed
            .body
            .handoff
            .as_ref()
            .filter(|d| d.get("to").and_then(Value::as_str) == Some(fed.origin.as_str()));
        if let Some(doc) = carried {
            receive_handoff(&state, doc).await?;
            upsert_conversation_from_sequencer(&state, conv).await?;
        } else if !ordered_before_handoff(&state, id, &fed.origin, seq).await? {
            return Err(e);
        }
    }
    let duplicate = if known.is_none() {
        classify_local_message_requests(&state, id).await?
    } else {
        false
    };
    if duplicate {
        let mut tx = state.pool.begin().await?;
        sqlx::query("DELETE FROM dm_message_requests WHERE conversation_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM conversation_members WHERE conversation_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM conversations WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(json!({ "ok": true })));
    }

    let msg = &fed.body.message;
    let held: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(seq), 0) FROM dm_messages WHERE conversation_id = ?",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    store_frame(&state, id, msg).await?;
    if msg.get("kind").and_then(Value::as_str) == Some("application") {
        if let Some(notification_id) = msg.get("notification_id").and_then(Value::as_str) {
            validate_notification_id(notification_id)?;
            consume_dm_notification_hints(
                &state,
                id,
                notification_id,
                msg.get("sender").and_then(Value::as_str).unwrap_or_default(),
            )
            .await?;
        }
    }
    sqlx::query("UPDATE conversations SET last_seq = MAX(last_seq, ?), updated_at = ? WHERE id = ?")
        .bind(seq)
        .bind(now_ms())
        .bind(id)
        .execute(&state.pool)
        .await?;
    if held > 0 && seq > held + 1 {
        let state = state.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            if let Err(e) = repair(&state, &id, held, Some(seq)).await {
                tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm gap repair failed");
            }
        });
    }

    let locals: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND home_domain = ? \
         AND state = 'active'",
    )
    .bind(id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await?;
    let mut told: Vec<String> = Vec::with_capacity(locals.len());
    for user_id in locals {
        let policy = local_dm_policy(&state, id, &user_id).await?;
        if policy.visible {
            let mut delivered = msg.clone();
            if let Some(request_state) = policy.request_state {
                delivered["request_state"] = Value::String(request_state);
            }
            state
                .hub
                .publish_user(&user_id, Event::to_account("DM_MESSAGE", &user_id, delivered))
                .await;
            told.push(user_id);
        }
    }
    crate::routes::push::wake_conversation(&state, id, msg, &told).await;
    Ok(Json(json!({ "ok": true })))
}

const FRAMES_PAGE: i64 = 500;

pub async fn inbound_frames(
    State(state): State<AppState>,
    federation::FedOrigin(origin): federation::FedOrigin,
    Path((id, since)): Path<(String, i64)>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &origin, "dm").await?;
    let sequencer: Option<String> =
        sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    match sequencer {
        Some(s) if s == state.cfg.server_name => {}
        Some(s) if s == origin && handed_to(&state, &id, &origin).await? => {}
        Some(s) => return Err(not_sequencer(&s)),
        None => return Err(ApiError::NotFound("no such conversation".into())),
    }
    let hosts: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM conversation_members WHERE conversation_id = ? AND home_domain = ? \
         AND state = 'active' LIMIT 1",
    )
    .bind(&id)
    .bind(&origin)
    .fetch_optional(&state.pool)
    .await?;
    if hosts.is_none() {
        return Err(ApiError::Forbidden("you host no member of that conversation".into()));
    }
    let rows: Vec<StoredFrame> = sqlx::query_as(
        "SELECT id, seq, epoch, kind, sender, sender_device, ciphertext, notification_id, \
         created_at, generation FROM dm_messages WHERE conversation_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(&id)
    .bind(since.max(0))
    .bind(FRAMES_PAGE)
    .fetch_all(&state.pool)
    .await?;
    let descriptor = conversation_json(&state, &id).await?;
    Ok(Json(json!({
        "last_seq": descriptor["last_seq"].clone(),
        "conversation": descriptor,
        "messages": rows.iter().map(|r| stored_frame_json(&id, r, false)).collect::<Vec<_>>(),
    })))
}

async fn ordered_before_handoff(state: &AppState, id: &str, former: &str, seq: i64) -> ApiResult<bool> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM dm_handoffs WHERE conversation_id = ? AND from_server = ? AND last_seq >= ? \
         LIMIT 1",
    )
    .bind(id)
    .bind(former)
    .bind(seq)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.is_some() && seq > 0)
}

async fn handed_to(state: &AppState, id: &str, to: &str) -> ApiResult<bool> {
    let row: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM dm_handoffs WHERE conversation_id = ? AND from_server = ? AND to_server = ? \
         LIMIT 1",
    )
    .bind(id)
    .bind(&state.cfg.server_name)
    .bind(to)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.is_some())
}

pub(crate) fn not_sequencer(sequencer: &str) -> ApiError {
    ApiError::Conflict(format!("this conversation is sequenced by {sequencer}"))
        .with_code(crate::errcodes::NOT_SEQUENCER)
        .with_detail("sequencer", sequencer.to_string())
}

pub(super) async fn store_frame(state: &AppState, conversation_id: &str, msg: &Value) -> ApiResult<()> {
    let seq = msg.get("seq").and_then(Value::as_i64).unwrap_or(0);
    if seq <= 0 {
        return Err(ApiError::BadRequest("frame has no sequence number".into()));
    }
    sqlx::query(
        "INSERT INTO dm_messages (id, conversation_id, seq, epoch, kind, sender, \
         sender_device, ciphertext, notification_id, created_at, generation) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(msg.get("id").and_then(Value::as_str).unwrap_or_default())
    .bind(conversation_id)
    .bind(seq)
    .bind(msg.get("epoch").and_then(Value::as_i64).unwrap_or(0))
    .bind(msg.get("kind").and_then(Value::as_str).unwrap_or("application"))
    .bind(msg.get("sender").and_then(Value::as_str).unwrap_or_default())
    .bind(msg.get("sender_device").and_then(Value::as_str))
    .bind(msg.get("ciphertext").and_then(Value::as_str).unwrap_or_default())
    .bind(msg.get("notification_id").and_then(Value::as_str))
    .bind(msg.get("created_at").and_then(Value::as_i64).unwrap_or_else(now_ms))
    .bind(msg.get("generation").and_then(Value::as_i64).unwrap_or(0))
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub(super) async fn first_hole(
    state: &AppState,
    conversation_id: &str,
    from: i64,
    ceiling: i64,
) -> ApiResult<Option<i64>> {
    if from >= ceiling {
        return Ok(None);
    }
    let hole: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(s) FROM ( \
           SELECT ? + 1 AS s WHERE NOT EXISTS \
             (SELECT 1 FROM dm_messages WHERE conversation_id = ? AND seq = ? + 1) \
           UNION ALL \
           SELECT m.seq + 1 FROM dm_messages m \
           WHERE m.conversation_id = ? AND m.seq > ? AND m.seq < ? AND NOT EXISTS \
             (SELECT 1 FROM dm_messages n WHERE n.conversation_id = m.conversation_id \
              AND n.seq = m.seq + 1))",
    )
    .bind(from)
    .bind(conversation_id)
    .bind(from)
    .bind(conversation_id)
    .bind(from)
    .bind(ceiling)
    .fetch_one(&state.pool)
    .await?;
    Ok(hole.filter(|h| *h <= ceiling))
}

pub(crate) async fn repair(
    state: &AppState,
    conversation_id: &str,
    from: i64,
    upto: Option<i64>,
) -> ApiResult<Option<i64>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT sequencer, last_seq FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((mut sequencer, last_seq)) = row else { return Ok(None) };
    if sequencer == state.cfg.server_name {
        return Ok(None);
    }
    let floor: Option<i64> =
        sqlx::query_scalar("SELECT MIN(seq) FROM dm_messages WHERE conversation_id = ?")
            .bind(conversation_id)
            .fetch_one(&state.pool)
            .await?;
    let Some(floor) = floor else { return Ok(None) };
    let from = from.max(floor);
    let ceiling = upto.map_or(last_seq, |u| u.min(last_seq));
    let mut rounds = 0;
    let mut tried: Option<i64> = None;
    loop {
        let Some(hole) = first_hole(state, conversation_id, from, ceiling).await? else {
            return Ok(None);
        };
        if tried == Some(hole) || rounds >= 8 {
            return Ok(Some(hole));
        }
        rounds += 1;
        tried = Some(hole);
        let path = format!("/_telium/v1/dm/frames/{conversation_id}/{}", hole - 1);
        let answer = match federation::get_signed(state, &sequencer, &path).await {
            Ok(answer) => answer,
            Err(e) if e.code() == crate::errcodes::NOT_SEQUENCER => {
                match learn_handoff(state, conversation_id, &sequencer).await? {
                    Some(next) if next == state.cfg.server_name => return Ok(None),
                    Some(next) if next != sequencer => {
                        sequencer = next;
                        tried = None;
                        continue;
                    }
                    _ => return Ok(Some(hole)),
                }
            }
            Err(e) => {
                tracing::warn!(
                    target: crate::logcat::SOCIAL, error = %e, hole,
                    "could not repair a gap in a conversation from its sequencer"
                );
                return Ok(Some(hole));
            }
        };
        let messages = answer.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut top = 0;
        for m in &messages {
            store_frame(state, conversation_id, m).await?;
            top = top.max(m.get("seq").and_then(Value::as_i64).unwrap_or(0));
        }
        if top > 0 {
            sqlx::query("UPDATE conversations SET last_seq = MAX(last_seq, ?) WHERE id = ?")
                .bind(top)
                .bind(conversation_id)
                .execute(&state.pool)
                .await?;
        }
    }
}

pub(super) async fn upsert_conversation_from_sequencer(state: &AppState, conv: &Value) -> ApiResult<()> {
    let id = conv.get("id").and_then(Value::as_str).unwrap_or_default();
    let now = now_ms();
    let applied: Option<String> = sqlx::query_scalar(
        "INSERT INTO conversations (id, kind, sequencer, creator, epoch, metadata, policy, created_at, \
             updated_at, generation) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, metadata = excluded.metadata, \
             policy = excluded.policy, updated_at = excluded.updated_at, \
             generation = MAX(conversations.generation, excluded.generation) \
         WHERE conversations.sequencer = excluded.sequencer \
         RETURNING id",
    )
    .bind(id)
    .bind(conv.get("kind").and_then(Value::as_str).unwrap_or("dm"))
    .bind(conv.get("sequencer").and_then(Value::as_str).unwrap_or_default())
    .bind(conv.get("creator").and_then(Value::as_str).unwrap_or_default())
    .bind(conv.get("epoch").and_then(Value::as_i64).unwrap_or(0))
    .bind(conv.get("metadata").and_then(Value::as_str))
    .bind(conv.get("policy").filter(|p| p.is_object()).map(Value::to_string))
    .bind(conv.get("created_at").and_then(Value::as_i64).unwrap_or(now))
    .bind(now)
    .bind(conv.get("generation").and_then(Value::as_i64).unwrap_or(0))
    .fetch_optional(&state.pool)
    .await?;
    if applied.is_none() {
        return Err(ApiError::Conflict("that is not this conversation's sequencer".into()));
    }

    if let Some(members) = conv.get("members").and_then(Value::as_array) {
        for m in members {
            let Some(user_id) = m.get("user_id").and_then(Value::as_str) else { continue };
            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, user_id, home_domain, state, added_at, resync) \
                 VALUES (?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(conversation_id, user_id) DO UPDATE SET state = excluded.state, \
                     resync = excluded.resync",
            )
            .bind(id)
            .bind(user_id)
            .bind(m.get("home").and_then(Value::as_str).unwrap_or_default())
            .bind(m.get("state").and_then(Value::as_str).unwrap_or("active"))
            .bind(now)
            .bind(i64::from(m.get("resync").and_then(Value::as_bool).unwrap_or(false)))
            .execute(&state.pool)
            .await?;
        }
    }
    Ok(())
}
