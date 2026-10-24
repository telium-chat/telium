use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::*;

const DM_NOTIFICATION_KEYS_PATH: &str = "/_telium/v1/dm/notification-keys";
const DM_NOTIFICATION_HINTS_PATH: &str = "/_telium/v1/dm/notification-hints";
const MAX_DM_NOTIFICATION_TARGETS: usize = 256;
const MAX_PENDING_DM_NOTIFICATION_EVENTS_PER_SENDER: i64 = 16;

#[derive(Deserialize)]
pub struct DmNotificationKeysRequest {
    pub conversation_id: String,
    pub requester: String,
}

async fn local_dm_notification_targets(
    state: &AppState,
    conversation_id: &str,
    requester: &str,
) -> ApiResult<Vec<Value>> {
    require_member(state, conversation_id, requester).await?;
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members \
         WHERE conversation_id = ? AND home_domain = ? AND state = 'active' AND user_id != ? \
         ORDER BY user_id",
    )
    .bind(conversation_id)
    .bind(&state.cfg.server_name)
    .bind(requester)
    .fetch_all(&state.pool)
    .await?;

    let mut targets = Vec::new();
    for user_id in users {
        for device in crate::notifications::keys_for_local_user(state, &user_id).await? {
            if targets.len() >= MAX_DM_NOTIFICATION_TARGETS {
                return Err(ApiError::TooLarge(
                    "conversation has too many notification-capable devices".into(),
                ));
            }
            targets.push(json!({
                "user_id": user_id,
                "device_id": device.device_id,
                "algorithm": device.algorithm,
                "public_key": device.public_key,
            }));
        }
    }
    Ok(targets)
}

pub async fn conversation_notification_keys(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let hint_origin = format!("dm:{id}");

    let homes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active' AND user_id != ? ORDER BY home_domain",
    )
    .bind(&id)
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;

    let mut targets = Vec::new();
    let mut complete = true;
    for home in homes {
        if home == state.cfg.server_name {
            targets.extend(local_dm_notification_targets(&state, &id, &auth.user_id).await?);
            continue;
        }
        if federation::ensure_reachable(&state, &home, "dm").await.is_err() {
            complete = false;
            continue;
        }
        let reply = match federation::post_signed(
            &state,
            &home,
            DM_NOTIFICATION_KEYS_PATH,
            &json!({ "conversation_id": id, "requester": auth.user_id }),
        )
        .await
        {
            Ok(reply) => reply,
            Err(error) => {
                complete = false;
                tracing::debug!(target: crate::logcat::FEDERATION, %home, %error, "could not fetch remote DM notification keys");
                continue;
            }
        };
        for target in reply
            .get("targets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if targets.len() >= MAX_DM_NOTIFICATION_TARGETS {
                return Err(ApiError::TooLarge(
                    "conversation has too many notification-capable devices".into(),
                ));
            }
            targets.push(target.clone());
        }
    }

    Ok(Json(json!({
        "hint_origin": hint_origin,
        "targets": targets,
        "complete": complete,
    })))
}

pub async fn inbound_dm_notification_keys(
    State(state): State<AppState>,
    fed: Fed<DmNotificationKeysRequest>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.requester)? != fed.origin {
        return Err(ApiError::Forbidden(
            "a homeserver may request DM notification keys only for its own member".into(),
        ));
    }
    let targets = local_dm_notification_targets(
        &state,
        &fed.body.conversation_id,
        &fed.body.requester,
    )
    .await?;
    Ok(Json(json!({ "targets": targets })))
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct DmNotificationHintTarget {
    pub user_id: String,
    pub device_id: String,
    pub public_key: String,
    pub ciphertext: Value,
}

#[derive(Deserialize)]
pub struct DmNotificationHintsRequest {
    pub notification_id: String,
    #[serde(default)]
    pub envelopes: Vec<DmNotificationHintTarget>,
}

#[derive(Deserialize)]
pub struct InboundDmNotificationHints {
    pub conversation_id: String,
    pub sender: String,
    pub notification_id: String,
    #[serde(default)]
    pub envelopes: Vec<DmNotificationHintTarget>,
}

pub(super) fn validate_notification_id(id: &str) -> ApiResult<()> {
    if id.len() < 16
        || id.len() > crate::notifications::MAX_SOURCE_ID_BYTES
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::BadRequest("invalid DM notification id".into()));
    }
    Ok(())
}

pub(super) async fn consume_dm_notification_hints(
    state: &AppState,
    conversation_id: &str,
    notification_id: &str,
    sender: &str,
) -> ApiResult<u64> {
    let matched: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM dm_messages \
         WHERE conversation_id = ? AND notification_id = ? AND sender = ? AND kind = 'application' \
         LIMIT 1",
    )
    .bind(conversation_id)
    .bind(notification_id)
    .bind(sender)
    .fetch_optional(&state.pool)
    .await?;
    if matched.is_none() {
        return Ok(0);
    }

    let hint_origin = format!("dm:{conversation_id}");
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id, recipient_id, device_id, ciphertext FROM dm_notification_hints \
         WHERE conversation_id = ? AND notification_id = ? AND sender = ? ORDER BY id",
    )
    .bind(conversation_id)
    .bind(notification_id)
    .bind(sender)
    .fetch_all(&state.pool)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }

    let now = now_ms();
    let expires = now + crate::notifications::DEFAULT_RETENTION_MS;
    let mut wake = Vec::new();
    let mut tx = state.pool.begin().await?;
    for (hint_id, recipient_id, device_id, ciphertext) in &rows {
        let active: Option<i64> = sqlx::query_scalar(
            "SELECT d.active FROM notification_devices n \
             JOIN devices d ON d.device_id = n.device_id AND d.user_id = n.user_id \
             WHERE n.user_id = ? AND n.device_id = ?",
        )
        .bind(recipient_id)
        .bind(device_id)
        .fetch_optional(&mut *tx)
        .await?;
        if active == Some(1) {
            let envelope: Value = serde_json::from_str(ciphertext)
                .map_err(|_| ApiError::BadRequest("stored DM notification hint is malformed".into()))?;
            let wrapped = json!({
                "envelope": envelope,
                "conversation_id": conversation_id,
                "sender": sender,
            });
            let result = sqlx::query(
                "INSERT OR IGNORE INTO notification_inbox \
                 (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, created_at, expires_at) \
                 VALUES (?, ?, ?, ?, ?, 'dm_hint', NULL, ?, ?, ?)",
            )
            .bind(ulid())
            .bind(recipient_id)
            .bind(device_id)
            .bind(&hint_origin)
            .bind(notification_id)
            .bind(wrapped.to_string())
            .bind(now)
            .bind(expires)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() == 1 {
                wake.push((recipient_id.clone(), device_id.clone()));
            }
        }
        sqlx::query("DELETE FROM dm_notification_hints WHERE id = ?")
            .bind(hint_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    for (user_id, device_id) in &wake {
        if !state.hub.device_live(user_id, device_id).await {
            crate::routes::push::wake_notification_device(state, user_id, device_id).await;
            continue;
        }

        let state = state.clone();
        let user_id = user_id.clone();
        let device_id = device_id.clone();
        let source_id = notification_id.to_string();
        let origin = hint_origin.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM notification_inbox \
                 WHERE user_id = ? AND device_id = ? AND origin = ? AND source_id = ? \
                 AND kind = 'dm_hint')",
            )
            .bind(&user_id)
            .bind(&device_id)
            .bind(&origin)
            .bind(&source_id)
            .fetch_one(&state.pool)
            .await
            .unwrap_or(false);
            if exists {
                crate::routes::push::wake_notification_device(&state, &user_id, &device_id)
                    .await;
            }
        });
    }
    Ok(wake.len() as u64)
}

async fn store_local_dm_notification_hints(
    state: &AppState,
    conversation_id: &str,
    sender: &str,
    notification_id: &str,
    envelopes: &[DmNotificationHintTarget],
) -> ApiResult<u64> {
    require_member(state, conversation_id, sender).await?;
    validate_notification_id(notification_id)?;
    if envelopes.len() > MAX_DM_NOTIFICATION_TARGETS {
        return Err(ApiError::TooLarge("too many DM notification envelopes".into()));
    }

    let _ = sqlx::query("DELETE FROM dm_notification_hints WHERE created_at <= ?")
        .bind(now_ms() - crate::notifications::DEFAULT_RETENTION_MS)
        .execute(&state.pool)
        .await;

    let already_pending: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM dm_notification_hints \
         WHERE conversation_id = ? AND sender = ? AND notification_id = ? LIMIT 1",
    )
    .bind(conversation_id)
    .bind(sender)
    .bind(notification_id)
    .fetch_optional(&state.pool)
    .await?;
    if already_pending.is_none() {
        let pending_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT notification_id) FROM dm_notification_hints \
             WHERE conversation_id = ? AND sender = ?",
        )
        .bind(conversation_id)
        .bind(sender)
        .fetch_one(&state.pool)
        .await?;
        if pending_events >= MAX_PENDING_DM_NOTIFICATION_EVENTS_PER_SENDER {
            return Err(ApiError::RateLimited(
                "too many DM notification hints are waiting for matching frames".into(),
            ));
        }
    }

    let now = now_ms();
    for target in envelopes {
        if target.user_id == sender || home_of(&target.user_id)? != state.cfg.server_name {
            return Err(ApiError::Forbidden("DM notification target is not a local peer".into()));
        }
        require_member(state, conversation_id, &target.user_id).await?;
        crate::notifications::parse_envelope(&target.ciphertext)?;

        let registered: Option<(i64, String)> = sqlx::query_as(
            "SELECT d.active, n.public_key_b64 FROM notification_devices n \
             JOIN devices d ON d.device_id = n.device_id AND d.user_id = n.user_id \
             WHERE n.user_id = ? AND n.device_id = ?",
        )
        .bind(&target.user_id)
        .bind(&target.device_id)
        .fetch_optional(&state.pool)
        .await?;
        if registered.as_ref().map(|(active, key)| (*active, key.as_str()))
            != Some((1, target.public_key.as_str()))
        {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO dm_notification_hints \
             (id, conversation_id, notification_id, sender, recipient_id, device_id, ciphertext, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(conversation_id)
        .bind(notification_id)
        .bind(sender)
        .bind(&target.user_id)
        .bind(&target.device_id)
        .bind(target.ciphertext.to_string())
        .bind(now)
        .execute(&state.pool)
        .await?;
    }

    consume_dm_notification_hints(state, conversation_id, notification_id, sender).await
}

pub async fn conversation_notification_hints(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<DmNotificationHintsRequest>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    validate_notification_id(&req.notification_id)?;
    if req.envelopes.len() > MAX_DM_NOTIFICATION_TARGETS {
        return Err(ApiError::TooLarge("too many DM notification envelopes".into()));
    }

    let mut local = Vec::new();
    let mut remote: Vec<(String, Vec<DmNotificationHintTarget>)> = Vec::new();
    for target in req.envelopes {
        if target.user_id == auth.user_id {
            continue;
        }
        require_member(&state, &id, &target.user_id).await?;
        crate::notifications::parse_envelope(&target.ciphertext)?;
        let home = home_of(&target.user_id)?;
        if home == state.cfg.server_name {
            local.push(target);
        } else if let Some((_, targets)) = remote.iter_mut().find(|(domain, _)| domain == &home) {
            targets.push(target);
        } else {
            remote.push((home, vec![target]));
        }
    }

    let mut accepted =
        store_local_dm_notification_hints(&state, &id, &auth.user_id, &req.notification_id, &local)
            .await?;
    for (destination, envelopes) in remote {
        federation::ensure_reachable(&state, &destination, "dm").await?;
        queue(
            &state,
            &id,
            &req.notification_id,
            &destination,
            DM_NOTIFICATION_HINTS_PATH,
            &json!({
                "conversation_id": id,
                "sender": auth.user_id,
                "notification_id": req.notification_id,
                "envelopes": envelopes,
            }),
        )
        .await?;
        accepted += 1;
    }
    Ok(Json(json!({ "ok": true, "accepted": accepted })))
}

pub async fn inbound_dm_notification_hints(
    State(state): State<AppState>,
    fed: Fed<InboundDmNotificationHints>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.sender)? != fed.origin {
        return Err(ApiError::Forbidden(
            "a homeserver may submit DM notification hints only for its own sender".into(),
        ));
    }
    let consumed = store_local_dm_notification_hints(
        &state,
        &fed.body.conversation_id,
        &fed.body.sender,
        &fed.body.notification_id,
        &fed.body.envelopes,
    )
    .await?;
    Ok(Json(json!({ "ok": true, "consumed": consumed })))
}
