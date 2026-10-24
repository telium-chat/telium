use crate::error::{ApiError, ApiResult};
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use serde_json::{json, Value};
use super::*;

pub(super) type StoredFrame = (String, i64, i64, String, String, Option<String>, String, Option<String>, i64, i64);

pub(super) fn stored_frame_json(conversation_id: &str, row: &StoredFrame, notify: bool) -> Value {
    let (id, seq, epoch, kind, sender, device, ct, notification_id, created, generation) = row;
    json!({
        "id": id, "conversation_id": conversation_id, "seq": seq, "epoch": epoch,
        "kind": kind, "sender": sender, "sender_device": device,
        "ciphertext": ct, "notification_id": notification_id, "created_at": created,
        "generation": generation, "notify": notify,
    })
}

async fn replay(
    state: &AppState,
    conversation_id: &str,
    row: &StoredFrame,
    notify: bool,
) -> ApiResult<Value> {
    let mut message = stored_frame_json(conversation_id, row, notify);
    message["replayed"] = Value::Bool(true);
    if row.3 == "commit" {
        let welcome: Option<StoredFrame> = sqlx::query_as(
            "SELECT id, seq, epoch, kind, sender, sender_device, ciphertext, notification_id, \
             created_at, generation FROM dm_messages \
             WHERE conversation_id = ? AND seq = ? AND kind = 'welcome' AND sender = ?",
        )
        .bind(conversation_id)
        .bind(row.1 + 1)
        .bind(&row.4)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(w) = welcome {
            message["welcome"] = stored_frame_json(conversation_id, &w, false);
        }
    }
    Ok(message)
}

async fn settle_generation(
    tx: &mut sqlx::SqliteConnection,
    conversation_id: &str,
    kind: &str,
    epoch: i64,
    extras: &FrameExtras<'_>,
) -> ApiResult<i64> {
    let (current, at): (i64, i64) =
        sqlx::query_as("SELECT generation, epoch FROM conversations WHERE id = ?")
            .bind(conversation_id)
            .fetch_one(&mut *tx)
            .await?;
    let conflict = || {
        ApiError::Conflict("this frame belongs to a group the conversation has replaced".into())
            .with_code(crate::errcodes::GENERATION_CONFLICT)
            .with_detail("generation", current)
    };
    let claimed = extras.generation;
    if extras.start_over {
        if kind != "welcome" || epoch != 1 {
            return Err(ApiError::BadRequest(
                "a start-over is the Welcome of a new group, at epoch 1".into(),
            ));
        }
        if claimed != Some(current) {
            return Err(conflict());
        }
        sqlx::query("UPDATE conversations SET generation = ?, epoch = 1 WHERE id = ? AND generation = ?")
            .bind(current + 1)
            .bind(conversation_id)
            .bind(current)
            .execute(&mut *tx)
            .await?;
        return Ok(current + 1);
    }
    if let Some(claimed) = claimed {
        if claimed != current {
            return Err(conflict());
        }
        return Ok(current);
    }
    if kind == "welcome" && epoch == 1 && at != 1 {
        sqlx::query("UPDATE conversations SET generation = ?, epoch = 1 WHERE id = ?")
            .bind(current + 1)
            .bind(conversation_id)
            .execute(&mut *tx)
            .await?;
        return Ok(current + 1);
    }
    Ok(current)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn sequence_inner(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    sender: &str,
    sender_device: Option<&str>,
    ciphertext: &str,
    epoch: i64,
    extras: FrameExtras<'_>,
    next_policy: Option<&str>,
    change: Option<&Change>,
    notify: bool,
) -> ApiResult<Value> {
    let now = now_ms();
    let message_id = ulid();
    let notification_id = extras.notification_id;
    let mut added: Vec<(String, String)> = Vec::new();
    let mut removing: Vec<String> = Vec::new();
    if let (Some(change), "commit") = (change, kind) {
        match change.op.as_str() {
            "add" => {
                for user_id in &change.user_ids {
                    added.push((user_id.clone(), home_of(user_id)?));
                }
            }
            "remove" => removing.clone_from(&change.user_ids),
            _ => {}
        }
    }

    let mut tx = state.pool.begin().await?;
    // Write lock is held from here; the sequencer check must stay inside it (hand_off freezes order under the same lock).
    let seq: Option<i64> = sqlx::query_scalar(
        "UPDATE conversations SET last_seq = last_seq + 1, updated_at = ? \
         WHERE id = ? AND sequencer = ? RETURNING last_seq",
    )
    .bind(now)
    .bind(conversation_id)
    .bind(&state.cfg.server_name)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(seq) = seq else {
        let current: Option<String> =
            sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
                .bind(conversation_id)
                .fetch_optional(&mut *tx)
                .await?;
        drop(tx);
        return Err(match current {
            Some(s) => not_sequencer(&s),
            None => ApiError::NotFound("no such conversation".into()),
        });
    };
    if let Some(frame_id) = extras.frame_id {
        let prior: Option<StoredFrame> = sqlx::query_as(
            "SELECT id, seq, epoch, kind, sender, sender_device, ciphertext, notification_id, \
             created_at, generation FROM dm_messages WHERE conversation_id = ? AND frame_id = ?",
        )
        .bind(conversation_id)
        .bind(frame_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(prior) = prior {
            drop(tx);
            if prior.6 == ciphertext && prior.4 == sender && prior.3 == kind {
                return replay(state, conversation_id, &prior, notify).await;
            }
            return Err(ApiError::Conflict(
                "that frame id already names a different frame in this conversation".into(),
            )
            .with_code(crate::errcodes::FRAME_ID_REUSED)
            .with_detail("seq", prior.1));
        }
    }
    let generation = match settle_generation(&mut tx, conversation_id, kind, epoch, &extras).await {
        Ok(g) => g,
        Err(e) => {
            drop(tx);
            return Err(e);
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO dm_messages (id, conversation_id, seq, epoch, kind, sender, sender_device, \
         ciphertext, notification_id, created_at, frame_id, generation) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(seq)
    .bind(epoch)
    .bind(kind)
    .bind(sender)
    .bind(sender_device)
    .bind(ciphertext)
    .bind(notification_id)
    .bind(now)
    .bind(extras.frame_id)
    .bind(generation)
    .execute(&mut *tx)
    .await;
    match inserted {
        Ok(_) => {}
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(ApiError::Conflict("that frame was ordered concurrently; retry".into())
                .with_code(crate::errcodes::TRY_AGAIN));
        }
        Err(e) => return Err(e.into()),
    }
    let mut removed: Vec<(String, String)> = Vec::new();
    let mut welcome_msg: Option<Value> = None;
    if kind == "commit" {
        // A commit must be exactly last epoch + 1, or the key schedule forks.
        let moved: Option<i64> = sqlx::query_scalar(
            "UPDATE conversations SET epoch = ? WHERE id = ? AND epoch + 1 = ? RETURNING epoch",
        )
        .bind(epoch)
        .bind(conversation_id)
        .bind(epoch)
        .fetch_optional(&mut *tx)
        .await?;
        if moved.is_none() {
            let current: i64 =
                sqlx::query_scalar("SELECT epoch FROM conversations WHERE id = ?")
                    .bind(conversation_id)
                    .fetch_one(&mut *tx)
                    .await?;
            let winner: Option<(i64, i64, String, Option<String>, String)> = sqlx::query_as(
                "SELECT seq, epoch, sender, frame_id, ciphertext FROM dm_messages \
                 WHERE conversation_id = ? AND kind = 'commit' AND epoch = ? AND seq != ? \
                 ORDER BY seq DESC LIMIT 1",
            )
            .bind(conversation_id)
            .bind(epoch)
            .bind(seq)
            .fetch_optional(&mut *tx)
            .await?;
            drop(tx);
            let mut refusal = ApiError::Conflict(
                "this commit was not built on the conversation's current epoch".into(),
            )
            .with_code(crate::errcodes::EPOCH_CONFLICT)
            .with_detail("epoch", current);
            if let Some((w_seq, w_epoch, w_sender, w_frame, w_ct)) = winner {
                refusal = refusal
                    .with_detail("winner_seq", w_seq)
                    .with_detail("winner_epoch", w_epoch)
                    .with_detail("winner_sender", w_sender)
                    .with_detail("winner_digest", frame_digest(&w_ct));
                if let Some(frame) = w_frame {
                    refusal = refusal.with_detail("winner_frame_id", frame);
                }
            }
            return Err(refusal);
        }
        if let Some(policy) = next_policy {
            sqlx::query("UPDATE conversations SET policy = ? WHERE id = ?")
                .bind(policy)
                .bind(conversation_id)
                .execute(&mut *tx)
                .await?;
        }
        for (user_id, home) in &added {
            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
                 VALUES (?, ?, ?, ?) \
                 ON CONFLICT(conversation_id, user_id) DO UPDATE SET state = 'active', resync = 0",
            )
            .bind(conversation_id)
            .bind(user_id)
            .bind(home)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        for user_id in &removing {
            let home: Option<String> = sqlx::query_scalar(
                "UPDATE conversation_members SET state = 'removed' \
                 WHERE conversation_id = ? AND user_id = ? AND state = 'active' \
                 RETURNING home_domain",
            )
            .bind(conversation_id)
            .bind(user_id)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(home) = home {
                removed.push((user_id.clone(), home));
            }
            sqlx::query(
                "UPDATE conversation_members SET resync = 0 WHERE conversation_id = ? AND user_id = ?",
            )
            .bind(conversation_id)
            .bind(user_id)
            .execute(&mut *tx)
            .await?;
        }
        if let Some(welcome) = extras.welcome {
            let welcome_seq: i64 = sqlx::query_scalar(
                "UPDATE conversations SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
            )
            .bind(conversation_id)
            .fetch_one(&mut *tx)
            .await?;
            let welcome_id = ulid();
            sqlx::query(
                "INSERT INTO dm_messages (id, conversation_id, seq, epoch, kind, sender, \
                 sender_device, ciphertext, created_at, generation) \
                 VALUES (?, ?, ?, ?, 'welcome', ?, ?, ?, ?, ?)",
            )
            .bind(&welcome_id)
            .bind(conversation_id)
            .bind(welcome_seq)
            .bind(epoch)
            .bind(sender)
            .bind(sender_device)
            .bind(welcome)
            .bind(now)
            .bind(generation)
            .execute(&mut *tx)
            .await?;
            welcome_msg = Some(json!({
                "id": welcome_id, "conversation_id": conversation_id, "seq": welcome_seq,
                "epoch": epoch, "kind": "welcome", "sender": sender,
                "sender_device": sender_device, "ciphertext": welcome,
                "notification_id": null, "created_at": now, "generation": generation,
                "notify": false,
            }));
        }
    }
    tx.commit().await?;

    let mut message = json!({
        "id": message_id, "conversation_id": conversation_id, "seq": seq, "epoch": epoch,
        "kind": kind, "sender": sender, "sender_device": sender_device,
        "ciphertext": ciphertext, "notification_id": notification_id, "created_at": now,
        "generation": generation,
        "notify": notify,
    });

    // Nothing below may fail the request; a resend would double-commit.
    if kind == "application" {
        if let Some(notification_id) = notification_id {
            if let Err(e) =
                consume_dm_notification_hints(state, conversation_id, notification_id, sender).await
            {
                tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm notification hints not consumed");
            }
        }
    }
    if let Err(e) = deliver(state, conversation_id, &message, &removed).await {
        tracing::warn!(target: crate::logcat::SOCIAL, error = %e, seq, "dm frame ordered but not yet delivered");
    }
    if let Some(welcome) = &welcome_msg {
        if let Err(e) = deliver(state, conversation_id, welcome, &[]).await {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm welcome ordered but not yet delivered");
        }
    }
    if !removed.is_empty() {
        if let Err(e) = sync_dm_pair(state, conversation_id).await {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm pair not resynced after removal");
        }
        for (user_id, _) in &removed {
            if let Err(e) = crate::routes::voice::disconnect(state, conversation_id, user_id).await {
                tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "removed member not disconnected from call");
            }
        }
    }
    if let Some(welcome) = welcome_msg {
        message["welcome"] = welcome;
    }
    Ok(message)
}

async fn deliver(
    state: &AppState,
    conversation_id: &str,
    message: &Value,
    also: &[(String, String)],
) -> ApiResult<()> {
    crate::metrics::Metrics::bump(&state.metrics.messages_dm, 1);
    let mut descriptor = conversation_json(state, conversation_id).await?;
    let mut members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;
    if !also.is_empty() {
        if let Some(rows) = descriptor.get_mut("members").and_then(Value::as_array_mut) {
            for row in rows {
                let user = row.get("user_id").and_then(Value::as_str).unwrap_or_default();
                if also.iter().any(|(u, _)| u == user) {
                    row["state"] = Value::String("active".into());
                }
            }
        }
        members.extend(also.iter().cloned());
    }

    let mut remotes: Vec<String> = Vec::new();
    let mut locals: Vec<String> = Vec::new();
    for (user_id, home) in members {
        if home == state.cfg.server_name {
            let policy = local_dm_policy(state, conversation_id, &user_id).await?;
            if policy.visible {
                let mut delivered = message.clone();
                if let Some(request_state) = policy.request_state {
                    delivered["request_state"] = Value::String(request_state);
                }
                state
                    .hub
                    .publish_user(
                        &user_id,
                        Event::to_account("DM_MESSAGE", &user_id, delivered),
                    )
                    .await;
                locals.push(user_id);
            }
        } else if !remotes.contains(&home) {
            remotes.push(home);
        }
    }

    crate::routes::push::wake_conversation(state, conversation_id, message, &locals).await;

    let handoff = match latest_handoff(state, conversation_id).await? {
        Some((_, doc)) if doc.get("to").and_then(Value::as_str) == Some(state.cfg.server_name.as_str()) => doc,
        _ => Value::Null,
    };
    for destination in remotes {
        queue(
            state,
            conversation_id,
            message["id"].as_str().unwrap_or_default(),
            &destination,
            "/_telium/v1/dm/deliver",
            &json!({ "conversation": descriptor, "message": message, "handoff": handoff }),
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn queue(
    state: &AppState,
    conversation_id: &str,
    message_id: &str,
    destination: &str,
    path: &str,
    payload: &Value,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, path, payload, \
         next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(conversation_id)
    .bind(message_id)
    .bind(destination)
    .bind(path)
    .bind(payload.to_string())
    .bind(now_ms())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = flush_outbox(&state).await {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "dm outbox flush failed");
        }
    });
    Ok(())
}

pub(super) fn essential_delivery(path: &str, payload: &Value) -> bool {
    if path.starts_with("/_telium/v1/dm/handoff") {
        return true;
    }
    path == "/_telium/v1/dm/deliver"
        && matches!(
            payload.pointer("/message/kind").and_then(Value::as_str),
            Some("commit" | "welcome")
        )
}

pub(crate) fn definite_refusal(e: &ApiError) -> bool {
    let status = e.status().as_u16();
    (400..500).contains(&status) && !matches!(status, 408 | 409 | 425 | 429)
}
