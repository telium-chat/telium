use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::{now_ms, split_user_id, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

const CONVERSATION_MEMBER_BURST: f64 = 300.0;
const CONVERSATION_MEMBER_PER_SEC: f64 = 3.0;

#[derive(Deserialize)]
pub struct CreateConversation {
    #[serde(default = "dm_kind")]
    pub kind: String,
    pub members: Vec<String>,
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub metadata: Option<String>,
    #[serde(default)]
    pub policy: Option<Value>,
}

fn dm_kind() -> String {
    "dm".to_string()
}

const PAIR_SEPARATOR: char = '|';

pub(crate) fn dm_pair_key(members: &[String]) -> Option<String> {
    let [a, b] = members else { return None };
    if a == b || a.contains(PAIR_SEPARATOR) || b.contains(PAIR_SEPARATOR) {
        return None;
    }
    split_user_id(a)?;
    split_user_id(b)?;
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    Some(format!("{lo}{PAIR_SEPARATOR}{hi}"))
}

pub(super) async fn sync_dm_pair(state: &AppState, conversation_id: &str) -> ApiResult<()> {
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(&state.pool)
        .await?;
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active' ORDER BY user_id",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;
    let pair = match kind.as_deref() {
        Some("dm") => dm_pair_key(&members),
        _ => None,
    };
    match pair {
        Some(pair) => {
            sqlx::query(
                "INSERT INTO dm_pairs (pair, conversation_id, claimed_at) VALUES (?, ?, ?) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(pair)
            .bind(conversation_id)
            .bind(now_ms())
            .execute(&state.pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM dm_pairs WHERE conversation_id = ?")
                .bind(conversation_id)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn create_conversation(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<CreateConversation>,
) -> ApiResult<Json<Value>> {
    if req.kind != "dm" && req.kind != "gc" {
        return Err(ApiError::BadRequest("kind must be dm or gc".into()));
    }
    let mut members: Vec<String> = req.members.clone();
    members.push(auth.user_id.clone());
    members.sort();
    members.dedup();
    if req.kind == "dm" && members.len() != 2 {
        return Err(ApiError::BadRequest("a dm has exactly two participants".into()));
    }
    if members.len() > MAX_GROUP_MEMBERS {
        return Err(ApiError::BadRequest(format!(
            "group chats hold up to {MAX_GROUP_MEMBERS} people; beyond that, this wants to be a guild"
        )));
    }
    let policy = match &req.policy {
        None | Some(Value::Null) => None,
        Some(_) if req.kind != "gc" => {
            return Err(ApiError::BadRequest(
                "only a group chat has a membership policy; a dm has two people and no admins"
                    .into(),
            ))
        }
        Some(p) => Some(normalise_policy(p, &auth.user_id, &members)?),
    };

    // One atomic take_cost: a refused conversation must cost nothing.
    if state.cfg.rate_limit.enabled {
        if let Err(retry) = state.limiter.take_cost(
            format!("conversation:{}", auth.user_id),
            "conversation-create",
            CONVERSATION_MEMBER_BURST,
            CONVERSATION_MEMBER_PER_SEC,
            members.len() as f64,
        ) {
            return Err(ApiError::RateLimited(format!(
                "too many conversations: try again in {retry}s"
            )));
        }
    }

    for m in &members {
        let home = home_of(m)?;
        if home != state.cfg.server_name {
            federation::ensure_reachable(&state, &home, "dm").await?;
        }
    }

    let pair = match req.kind.as_str() {
        "dm" => Some(dm_pair_key(&members).ok_or_else(|| {
            ApiError::BadRequest(
                "a dm needs two distinct user ids this server can key a pair on".into(),
            )
        })?),
        _ => None,
    };

    let id = ulid();
    let now = now_ms();
    // Pair claim goes first in the same transaction; the loser returns the winner's conversation.
    let mut existing: Option<String> = None;
    let mut created = false;
    for _ in 0..3 {
        let mut tx = state.pool.begin().await?;
        if let Some(pair) = &pair {
            let claimed = sqlx::query(
                "INSERT INTO dm_pairs (pair, conversation_id, claimed_at) VALUES (?, ?, ?) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(pair)
            .bind(&id)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            if claimed.rows_affected() == 0 {
                tx.rollback().await?;
                existing = sqlx::query_scalar(
                    "SELECT p.conversation_id FROM dm_pairs p \
                     JOIN conversations c ON c.id = p.conversation_id WHERE p.pair = ?",
                )
                .bind(pair)
                .fetch_optional(&state.pool)
                .await?;
                if existing.is_some() {
                    break;
                }
                continue;
            }
        }
        sqlx::query(
            "INSERT INTO conversations (id, kind, sequencer, creator, metadata, policy, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&req.kind)
        .bind(&state.cfg.server_name)
        .bind(&auth.user_id)
        .bind(&req.metadata)
        .bind(policy.as_ref().map(Value::to_string))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
        for m in &members {
            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(m)
            .bind(home_of(m)?)
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        created = true;
        break;
    }

    if let Some(existing) = existing {
        return Ok(Json(conversation_json(&state, &existing).await?));
    }
    if !created {
        return Err(ApiError::Conflict(
            "another device is starting this same conversation right now; ask again".into(),
        ));
    }

    if req.kind == "dm" {
        let _ = classify_local_message_requests(&state, &id).await?;
    }

    if let Some(welcome) = req.welcome {
        sequence_and_fanout(
            &state,
            &id,
            "welcome",
            &auth.user_id,
            Some(&auth.device_id),
            &welcome,
            0,
            false,
        )
        .await?;
    }

    Ok(Json(conversation_json(&state, &id).await?))
}

pub async fn conversation_json(state: &AppState, id: &str) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, String, i64, i64, Option<String>, i64, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT id, kind, sequencer, creator, epoch, last_seq, metadata, created_at, promoted_to, \
             generation FROM conversations WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let (id, kind, sequencer, creator, epoch, last_seq, metadata, created_at, promoted_to, generation) =
        row.ok_or_else(|| ApiError::NotFound("no such conversation".into()))?;
    let policy = load_policy(state, &id).await?;
    let members: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, home_domain, state, resync FROM conversation_members WHERE conversation_id = ?",
    )
    .bind(&id)
    .fetch_all(&state.pool)
    .await?;
    let resync = members.iter().any(|(_, _, s, r)| *r != 0 && s != "active");
    Ok(json!({
        "id": id, "kind": kind, "sequencer": sequencer, "creator": creator,
        "epoch": epoch, "last_seq": last_seq, "metadata": metadata, "created_at": created_at,
        "promoted_to": promoted_to, "generation": generation,
        "policy": policy,
        "resync": resync,
        "members": members.into_iter()
            .map(|(u, h, s, r)| json!({ "user_id": u, "home": h, "state": s, "resync": r != 0 && s != "active" }))
            .collect::<Vec<_>>(),
    }))
}

pub(super) async fn classify_local_message_requests(state: &AppState, id: &str) -> ApiResult<bool> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT kind, creator FROM conversations WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((kind, creator)) = row else { return Ok(false) };
    if kind != "dm" {
        return Ok(false);
    }
    let mut duplicate_for_local_recipient = false;

    let recipients: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members \
         WHERE conversation_id = ? AND home_domain = ? AND state = 'active' \
           AND user_id != ?",
    )
    .bind(id)
    .bind(&state.cfg.server_name)
    .bind(&creator)
    .fetch_all(&state.pool)
    .await?;

    for user_id in recipients {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT state FROM dm_message_requests WHERE conversation_id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await?;
        if existing.is_some() {
            continue;
        }

        let canonical_dm: Option<String> = sqlx::query_scalar(
            "SELECT c.id FROM conversations c \
             JOIN conversation_members me \
               ON me.conversation_id = c.id AND me.user_id = ? AND me.state = 'active' \
             JOIN conversation_members peer \
               ON peer.conversation_id = c.id AND peer.user_id = ? AND peer.state = 'active' \
             WHERE c.kind = 'dm' ORDER BY c.rowid LIMIT 1",
        )
        .bind(&user_id)
        .bind(&creator)
        .fetch_optional(&state.pool)
        .await?;
        let duplicate = canonical_dm.as_deref().is_some_and(|canonical| canonical != id);
        duplicate_for_local_recipient |= duplicate;
        let mut request_state = if duplicate { "declined" } else { "pending" };

        let relation: Option<String> =
            sqlx::query_scalar("SELECT state FROM friends WHERE user_id = ? AND peer_id = ?")
                .bind(&user_id)
                .bind(&creator)
                .fetch_optional(&state.pool)
                .await?;
        if !duplicate && relation.as_deref() == Some("accepted") {
            continue;
        }

        if request_state == "declined" {
        } else {
            // Overflow is silent: the sender sees an ordinary conversation.
            let pending_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM dm_message_requests WHERE user_id = ? AND state = 'pending'",
            )
            .bind(&user_id)
            .fetch_one(&state.pool)
            .await?;
            if pending_count >= state.cfg.limits.max_message_requests {
                request_state = "declined";
            }
        }

        let now = now_ms();
        sqlx::query(
            "INSERT INTO dm_message_requests \
             (conversation_id, user_id, sender_id, state, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(&user_id)
        .bind(&creator)
        .bind(request_state)
        .bind(now)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }
    Ok(duplicate_for_local_recipient)
}

pub(super) struct LocalDmPolicy {
    pub(super) visible: bool,
    pub(super) request_state: Option<String>,
}

pub(super) async fn local_dm_policy(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
) -> ApiResult<LocalDmPolicy> {
    let row: Option<(String, Option<String>, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT c.kind, r.state, f.state, r.sender_id \
         FROM conversations c \
         LEFT JOIN conversation_members peer \
           ON peer.conversation_id = c.id AND peer.user_id != ? AND peer.state = 'active' \
         LEFT JOIN friends f ON f.user_id = ? AND f.peer_id = peer.user_id \
         LEFT JOIN dm_message_requests r \
           ON r.conversation_id = c.id AND r.user_id = ? \
         WHERE c.id = ? LIMIT 1",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .bind(conversation_id)
    .fetch_optional(&state.pool)
    .await?;

    let Some((kind, mut request_state, relation, request_sender)) = row else {
        return Ok(LocalDmPolicy { visible: true, request_state: None });
    };
    if kind != "dm" {
        return Ok(LocalDmPolicy { visible: true, request_state: None });
    }

    if relation.as_deref() == Some("accepted") {
        if request_state.as_deref() == Some("declined") {
            if let Some(sender) = request_sender.as_deref() {
                let canonical: Option<String> = sqlx::query_scalar(
                    "SELECT c.id FROM conversations c \
                     JOIN conversation_members me \
                       ON me.conversation_id = c.id AND me.user_id = ? AND me.state = 'active' \
                     JOIN conversation_members peer \
                       ON peer.conversation_id = c.id AND peer.user_id = ? AND peer.state = 'active' \
                     WHERE c.kind = 'dm' ORDER BY c.rowid LIMIT 1",
                )
                .bind(user_id)
                .bind(sender)
                .fetch_optional(&state.pool)
                .await?;
                if canonical.as_deref().is_some_and(|canonical| canonical != conversation_id) {
                    return Ok(LocalDmPolicy {
                        visible: false,
                        request_state: Some("declined".into()),
                    });
                }
            }
        }
        if request_state.is_some() && request_state.as_deref() != Some("accepted") {
            sqlx::query(
                "UPDATE dm_message_requests SET state = 'accepted', updated_at = ? \
                 WHERE conversation_id = ? AND user_id = ?",
            )
            .bind(now_ms())
            .bind(conversation_id)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
        }
        return Ok(LocalDmPolicy { visible: true, request_state: None });
    }

    if relation.as_deref() == Some("blocked") {
        return Ok(LocalDmPolicy {
            visible: false,
            request_state: Some("blocked".into()),
        });
    }

    if request_state.as_deref() == Some("blocked") {
        sqlx::query(
            "UPDATE dm_message_requests SET state = 'pending', updated_at = ? \
             WHERE conversation_id = ? AND user_id = ?",
        )
        .bind(now_ms())
        .bind(conversation_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
        request_state = Some("pending".into());
    }

    let visible = request_state.as_deref() != Some("declined");
    if request_state.as_deref() == Some("accepted") {
        request_state = None;
    }
    Ok(LocalDmPolicy { visible, request_state })
}

pub(crate) async fn may_receive_dm_interaction(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
) -> ApiResult<bool> {
    let policy = local_dm_policy(state, conversation_id, user_id).await?;
    Ok(policy.visible && policy.request_state.is_none())
}

pub async fn list_conversations(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT m.conversation_id, m.muted, \
                COALESCE((SELECT MAX(d.created_at) FROM dm_messages d \
                          WHERE d.conversation_id = m.conversation_id \
                            AND d.kind = 'application'), c.created_at) AS active_at \
         FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id \
         WHERE m.user_id = ? AND m.state = 'active' \
         ORDER BY active_at DESC, c.rowid DESC",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::new();
    for (id, muted, active_at) in rows {
        let policy = local_dm_policy(&state, &id, &auth.user_id).await?;
        if !policy.visible {
            continue;
        }
        let mut conversation = conversation_json(&state, &id).await?;
        if let Some(object) = conversation.as_object_mut() {
            object.insert("muted".into(), json!(muted == 1));
            object.insert("last_activity_at".into(), json!(active_at));
            if let Some(request_state) = policy.request_state {
                object.insert("request_state".into(), Value::String(request_state));
            }
        }
        out.push(conversation);
    }
    Ok(Json(json!({ "conversations": out })))
}

pub async fn get_conversation(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let policy = local_dm_policy(&state, &id, &auth.user_id).await?;
    if !policy.visible {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let mut conversation = conversation_json(&state, &id).await?;
    if let Some(request_state) = policy.request_state {
        conversation["request_state"] = Value::String(request_state);
    }
    Ok(Json(conversation))
}

pub async fn accept_message_request(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let current = local_dm_policy(&state, &id, &auth.user_id).await?;
    if current.request_state.as_deref() != Some("pending") {
        return Err(ApiError::NotFound("no pending message request".into()));
    }
    sqlx::query(
        "UPDATE dm_message_requests SET state = 'accepted', updated_at = ? \
         WHERE conversation_id = ? AND user_id = ? AND state = 'pending'",
    )
    .bind(now_ms())
    .bind(&id)
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;
    state
        .hub
        .publish_user(
            &auth.user_id,
            Event::to_account(
                "DM_REQUEST_UPDATE",
                &auth.user_id,
                json!({ "conversation_id": id, "state": Value::Null }),
            ),
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn decline_message_request(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let changed = sqlx::query(
        "UPDATE dm_message_requests SET state = 'declined', updated_at = ? \
         WHERE conversation_id = ? AND user_id = ? AND state = 'pending'",
    )
    .bind(now_ms())
    .bind(&id)
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;
    if changed.rows_affected() == 0 {
        return Err(ApiError::NotFound("no pending message request".into()));
    }
    state
        .hub
        .publish_user(
            &auth.user_id,
            Event::to_account(
                "DM_REQUEST_UPDATE",
                &auth.user_id,
                json!({ "conversation_id": id, "state": "declined" }),
            ),
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn require_member(
    state: &AppState,
    conversation: &str,
    user_id: &str,
) -> ApiResult<()> {
    let st: Option<String> = sqlx::query_scalar(
        "SELECT state FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
    )
    .bind(conversation)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    match st.as_deref() {
        Some("active") => Ok(()),
        _ => Err(ApiError::Forbidden("not in this conversation".into())),
    }
}
