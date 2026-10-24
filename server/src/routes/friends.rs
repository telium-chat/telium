
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::gateway::hub::Presence;
use crate::state::AppState;
use crate::util::{now_ms, split_user_id, ulid};
use axum::extract::{Path, State};
use axum::Json;
use futures_util::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const MAX_FRIENDS: i64 = 1000;

const MAX_PENDING_IN: i64 = 200;

const MAX_PENDING_IN_PER_ORIGIN: i64 = 50;

const FRIEND_REQUEST_BURST: f64 = 10.0;
const FRIEND_REQUEST_PER_SEC: f64 = 1.0 / 6.0;

const PENDING_OUT: &str = "pending_out";
const PENDING_IN: &str = "pending_in";
const ACCEPTED: &str = "accepted";
const BLOCKED: &str = "blocked";

fn home_of(user_id: &str) -> ApiResult<String> {
    split_user_id(user_id)
        .map(|(_, domain)| domain.to_string())
        .ok_or_else(|| ApiError::BadRequest(format!("{user_id} is not a user id")))
}

async fn relation(state: &AppState, user_id: &str, peer_id: &str) -> ApiResult<Option<String>> {
    Ok(
        sqlx::query_scalar("SELECT state FROM friends WHERE user_id = ? AND peer_id = ?")
            .bind(user_id)
            .bind(peer_id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

async fn write(state: &AppState, user_id: &str, peer_id: &str, next: &str) -> ApiResult<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO friends (user_id, peer_id, peer_domain, state, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, peer_id) DO UPDATE SET \
         state = excluded.state, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(peer_id)
    .bind(home_of(peer_id)?)
    .bind(next)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn forget(state: &AppState, user_id: &str, peer_id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM friends WHERE user_id = ? AND peer_id = ?")
        .bind(user_id)
        .bind(peer_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

async fn notify(state: &AppState, user_id: &str, t: &'static str, data: Value) {
    state
        .hub
        .publish_user(user_id, Event::to_account(t, user_id, data))
        .await;
}

pub async fn list(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT peer_id, peer_domain, state, created_at, updated_at FROM friends \
         WHERE user_id = ? ORDER BY peer_id",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;

    let mut friends = Vec::with_capacity(rows.len());
    for (peer_id, domain, rel, created_at, updated_at) in rows {
        // Pending or blocked relations must not reveal presence.
        let presence = if rel == ACCEPTED {
            state.hub.presence_of(&peer_id).await.to_json(&peer_id)
        } else {
            Value::Null
        };
        let profile = crate::routes::identity::load_profile(&state, &peer_id).await?;
        friends.push(json!({
            "user_id": peer_id,
            "domain": domain,
            "state": rel,
            "presence": presence,
            "display_name": profile.as_ref().and_then(|p| p["display_name"].as_str()),
            "avatar_ref": profile.as_ref().and_then(|p| p["avatar_ref"].as_str()),
            "created_at": created_at,
            "updated_at": updated_at,
        }));
    }
    Ok(Json(json!({ "friends": friends })))
}

#[derive(Deserialize)]
pub struct Target {
    pub user_id: String,
}

pub async fn request(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<Target>,
) -> ApiResult<Json<Value>> {
    let peer = req.user_id.trim().to_string();
    if peer == auth.user_id {
        return Err(ApiError::BadRequest("you cannot add yourself".into()));
    }
    // Charged before lookup so id probing costs the same as success.
    if state.cfg.rate_limit.enabled {
        if let Err(retry) = state.limiter.take(
            format!("friend-request:{}", auth.user_id),
            "friend-request",
            FRIEND_REQUEST_BURST,
            FRIEND_REQUEST_PER_SEC,
        ) {
            return Err(ApiError::RateLimited(format!(
                "too many friend requests: try again in {retry}s"
            )));
        }
    }
    let home = home_of(&peer)?;
    federation::ensure_reachable(&state, &home, "dm").await?;

    match relation(&state, &auth.user_id, &peer).await?.as_deref() {
        Some(BLOCKED) => return Err(ApiError::Conflict("unblock them before adding them".into())),
        Some(ACCEPTED) => return Ok(Json(json!({ "user_id": peer, "state": ACCEPTED }))),
        Some(PENDING_IN) => return settle(&state, &auth.user_id, &peer).await,
        Some(PENDING_OUT) => {
            queue(&state, &home, &auth.user_id, &peer, "request").await?;
            return Ok(Json(json!({ "user_id": peer, "state": PENDING_OUT })));
        }
        _ => {}
    }

    ensure_room(&state, &auth.user_id).await?;
    ensure_exists(&state, &peer, &home).await?;

    write(&state, &auth.user_id, &peer, PENDING_OUT).await?;
    if let Err(refused) = queue(&state, &home, &auth.user_id, &peer, "request").await {
        forget(&state, &auth.user_id, &peer).await?;
        return Err(refused);
    }
    let row = json!({ "user_id": peer, "state": PENDING_OUT });
    notify(&state, &auth.user_id, "FRIEND_UPDATE", row.clone()).await;
    Ok(Json(row))
}

pub async fn accept(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(peer): Path<String>,
) -> ApiResult<Json<Value>> {
    match relation(&state, &auth.user_id, &peer).await?.as_deref() {
        Some(PENDING_IN) => settle(&state, &auth.user_id, &peer).await,
        Some(ACCEPTED) => Ok(Json(json!({ "user_id": peer, "state": ACCEPTED }))),
        _ => Err(ApiError::NotFound("no request from that user".into())),
    }
}

async fn settle(state: &AppState, user_id: &str, peer: &str) -> ApiResult<Json<Value>> {
    ensure_room(state, user_id).await?;
    write(state, user_id, peer, ACCEPTED).await?;
    queue(state, &home_of(peer)?, user_id, peer, "accept").await?;
    let row = json!({ "user_id": peer, "state": ACCEPTED });
    notify(state, user_id, "FRIEND_UPDATE", row.clone()).await;
    let presence = state.hub.presence_of(user_id).await;
    crate::gateway::broadcast_presence(state, user_id, presence).await;
    Ok(Json(row))
}

pub async fn remove(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(peer): Path<String>,
) -> ApiResult<Json<Value>> {
    let current = relation(&state, &auth.user_id, &peer)
        .await?
        .ok_or_else(|| ApiError::NotFound("they are not on your list".into()))?;
    let action = match current.as_str() {
        PENDING_OUT => "cancel",
        PENDING_IN => "decline",
        ACCEPTED => "remove",
        _ => return Err(ApiError::Conflict("unblock them instead".into())),
    };
    forget(&state, &auth.user_id, &peer).await?;
    queue(&state, &home_of(&peer)?, &auth.user_id, &peer, action).await?;
    notify(&state, &auth.user_id, "FRIEND_REMOVE", json!({ "user_id": peer })).await;
    Ok(Json(json!({ "user_id": peer, "state": Value::Null })))
}

pub async fn block(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(peer): Path<String>,
) -> ApiResult<Json<Value>> {
    if peer == auth.user_id {
        return Err(ApiError::BadRequest("you cannot block yourself".into()));
    }
    let had = relation(&state, &auth.user_id, &peer).await?;
    write(&state, &auth.user_id, &peer, BLOCKED).await?;
    if had.as_deref() != Some(BLOCKED) {
        queue(&state, &home_of(&peer)?, &auth.user_id, &peer, "remove").await?;
    }
    let row = json!({ "user_id": peer, "state": BLOCKED });
    notify(&state, &auth.user_id, "FRIEND_UPDATE", row.clone()).await;
    Ok(Json(row))
}

pub async fn unblock(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(peer): Path<String>,
) -> ApiResult<Json<Value>> {
    if relation(&state, &auth.user_id, &peer).await?.as_deref() != Some(BLOCKED) {
        return Err(ApiError::NotFound("they are not blocked".into()));
    }
    forget(&state, &auth.user_id, &peer).await?;
    notify(&state, &auth.user_id, "FRIEND_REMOVE", json!({ "user_id": peer })).await;
    Ok(Json(json!({ "user_id": peer, "state": Value::Null })))
}

async fn ensure_pending_room(state: &AppState, user_id: &str, from_domain: &str) -> ApiResult<()> {
    let waiting: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM friends WHERE user_id = ? AND state = ?")
            .bind(user_id)
            .bind(PENDING_IN)
            .fetch_one(&state.pool)
            .await?;
    if waiting >= MAX_PENDING_IN {
        return Err(ApiError::Conflict("that account is not taking new requests".into()));
    }
    let from_here: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM friends WHERE user_id = ? AND state = ? AND peer_domain = ?",
    )
    .bind(user_id)
    .bind(PENDING_IN)
    .bind(from_domain)
    .fetch_one(&state.pool)
    .await?;
    if from_here >= MAX_PENDING_IN_PER_ORIGIN {
        return Err(ApiError::Conflict("that account is not taking new requests".into()));
    }
    Ok(())
}

async fn ensure_room(state: &AppState, user_id: &str) -> ApiResult<()> {
    let held: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM friends WHERE user_id = ? AND state != ?")
            .bind(user_id)
            .bind(BLOCKED)
            .fetch_one(&state.pool)
            .await?;
    if held >= MAX_FRIENDS {
        return Err(ApiError::Conflict(format!(
            "a friends list holds {MAX_FRIENDS} people"
        )));
    }
    Ok(())
}

async fn ensure_exists(state: &AppState, peer: &str, home: &str) -> ApiResult<()> {
    if home == state.cfg.server_name {
        let deactivated: Option<i64> =
            sqlx::query_scalar("SELECT deactivated FROM accounts WHERE user_id = ?")
                .bind(peer)
                .fetch_optional(&state.pool)
                .await?;
        return match deactivated {
            Some(0) => Ok(()),
            Some(_) => Err(ApiError::NotFound(format!("{peer} is deactivated"))),
            None => Err(ApiError::NotFound(format!("there is no {peer}"))),
        };
    }
    let answer =
        federation::get_signed(state, home, &format!("/_telium/v1/users/{peer}/status")).await?;
    match answer["status"].as_str() {
        Some("active") => Ok(()),
        Some("moved") => Err(ApiError::NotFound(format!(
            "{peer} has moved to {}",
            answer["moved_to"].as_str().unwrap_or("another server")
        ))),
        _ => Err(ApiError::NotFound(format!("there is no {peer}"))),
    }
}

async fn local_mutuals(state: &AppState, viewer: &str, target: &str) -> ApiResult<Vec<Value>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT a.user_id FROM friends a \
         JOIN friends b ON b.user_id = a.user_id \
         WHERE a.peer_id = ? AND a.state = ? AND b.peer_id = ? AND b.state = ? \
         ORDER BY a.user_id LIMIT ?",
    )
    .bind(viewer)
    .bind(ACCEPTED)
    .bind(target)
    .bind(ACCEPTED)
    .bind(MAX_FRIENDS)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::with_capacity(ids.len());
    for user_id in ids {
        if home_of(&user_id)? != state.cfg.server_name {
            continue;
        }
        let profile = crate::routes::identity::load_profile(state, &user_id).await?;
        out.push(json!({
            "user_id": user_id,
            "display_name": profile.as_ref().and_then(|p| p["display_name"].as_str()),
            "avatar_ref": profile.as_ref().and_then(|p| p["avatar_ref"].as_str()),
        }));
    }
    Ok(out)
}

pub async fn mutual(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(target): Path<String>,
) -> ApiResult<Json<Value>> {
    if target == auth.user_id {
        return Ok(Json(json!({ "friends": [], "complete": true })));
    }
    home_of(&target)?;

    if relation(&state, &auth.user_id, &target).await?.as_deref() == Some(BLOCKED) {
        return Ok(Json(json!({ "friends": [], "complete": true })));
    }

    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT peer_id, peer_domain FROM friends WHERE user_id = ? AND state = ? ORDER BY peer_id",
    )
    .bind(&auth.user_id)
    .bind(ACCEPTED)
    .fetch_all(&state.pool)
    .await?;
    let accepted: HashSet<String> = rows.iter().map(|(id, _)| id.clone()).collect();

    let domains: HashSet<String> = rows.iter().map(|(_, domain)| domain.clone()).collect();
    let shards = stream::iter(domains.into_iter().map(|domain| {
        let state = state.clone();
        let viewer = auth.user_id.clone();
        let target = target.clone();
        async move {
            let local = domain.as_str() == state.cfg.server_name.as_str();
            let answer: ApiResult<Value> = if local {
                local_mutuals(&state, &viewer, &target)
                    .await
                    .map(|friends| json!({ "friends": friends }))
            } else {
                let payload = json!({ "viewer": &viewer, "target": &target });
                federation::post_signed(
                    &state,
                    &domain,
                    "/_telium/v1/friends/mutual-check",
                    &payload,
                )
                .await
            };
            (domain, local, answer)
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;

    let mut found: HashMap<String, Value> = HashMap::new();
    let mut complete = true;
    for (domain, local, answer) in shards {
        let answer = match answer {
            Ok(value) => value,
            Err(e) if local => return Err(e),
            Err(e) => {
                complete = false;
                tracing::debug!(target: crate::logcat::SOCIAL, %domain, error = %e, "mutual-friend shard unavailable");
                continue;
            }
        };

        for row in answer["friends"].as_array().cloned().unwrap_or_default() {
            let Some(user_id) = row["user_id"].as_str() else { continue };
            // A peer can't inject strangers: our half must already list the viewer's accepted friend.
            if !accepted.contains(user_id)
                || home_of(user_id).ok().as_deref() != Some(domain.as_str())
            {
                continue;
            }
            found.insert(user_id.to_string(), row);
        }
    }

    let mut friends: Vec<Value> = found.into_values().collect();
    friends.sort_by(|a, b| {
        a["user_id"].as_str().unwrap_or_default().cmp(b["user_id"].as_str().unwrap_or_default())
    });
    Ok(Json(json!({ "friends": friends, "complete": complete })))
}

#[derive(Deserialize)]
pub struct MutualCheck {
    pub viewer: String,
    pub target: String,
}

pub async fn inbound_mutual_check(
    State(state): State<AppState>,
    fed: Fed<MutualCheck>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.viewer)? != fed.origin {
        return Err(ApiError::Forbidden(
            "a server may only ask mutuals for its own users".into(),
        ));
    }
    let target_home = home_of(&fed.body.target)?;
    federation::ensure_reachable(&state, &target_home, "dm").await?;

    if target_home == state.cfg.server_name
        && relation(&state, &fed.body.target, &fed.body.viewer).await?.as_deref() == Some(BLOCKED)
    {
        return Ok(Json(json!({ "friends": [] })));
    }

    Ok(Json(json!({
        "friends": local_mutuals(&state, &fed.body.viewer, &fed.body.target).await?,
    })))
}

#[derive(Deserialize)]
pub struct Relay {
    pub action: String,
    pub from: String,
    pub to: String,
}

pub async fn inbound_relay(
    State(state): State<AppState>,
    fed: Fed<Relay>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.from)? != fed.origin {
        return Err(ApiError::Forbidden(
            "a server may only speak for its own users".into(),
        ));
    }
    if home_of(&fed.body.to)? != state.cfg.server_name {
        return Err(ApiError::NotFound("that user is not ours".into()));
    }
    apply(&state, &fed.body.from, &fed.body.to, &fed.body.action, false).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn apply(state: &AppState, from: &str, to: &str, action: &str, local: bool) -> ApiResult<()> {
    let current = relation(state, to, from).await?;

    if current.as_deref() == Some(BLOCKED) {
        return Ok(());
    }

    match action {
        "request" => {
            ensure_room(state, to).await?;
            if matches!(current.as_deref(), Some(PENDING_OUT) | Some(ACCEPTED)) {
                write(state, to, from, ACCEPTED).await?;
                announce(state, to, from, ACCEPTED).await;
                if local {
                    write(state, from, to, ACCEPTED).await?;
                    announce(state, from, to, ACCEPTED).await;
                } else {
                    relay(state, &home_of(from)?, to, from, "accept").await?;
                }
            } else {
                ensure_pending_room(state, to, &home_of(from)?).await?;
                write(state, to, from, PENDING_IN).await?;
                announce(state, to, from, PENDING_IN).await;
            }
        }
        "accept" => {
            if current.as_deref() == Some(PENDING_OUT) {
                write(state, to, from, ACCEPTED).await?;
                announce(state, to, from, ACCEPTED).await;
            }
        }
        "decline" | "cancel" | "remove" => {
            if current.is_some() {
                forget(state, to, from).await?;
                notify(state, to, "FRIEND_REMOVE", json!({ "user_id": from })).await;
            }
        }
        other => return Err(ApiError::BadRequest(format!("unknown friend action {other}"))),
    }
    Ok(())
}

async fn announce(state: &AppState, us: &str, them: &str, rel: &str) {
    notify(
        state,
        us,
        "FRIEND_UPDATE",
        json!({ "user_id": them, "state": rel }),
    )
    .await;
    if rel == ACCEPTED {
        let presence = state.hub.presence_of(us).await;
        crate::gateway::broadcast_presence(state, us, presence).await;
    }
}

#[derive(Deserialize)]
pub struct RemotePresence {
    pub user_id: String,
    pub presence: Value,
}

pub async fn inbound_presence(
    State(state): State<AppState>,
    fed: Fed<RemotePresence>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.user_id)? != fed.origin {
        return Err(ApiError::Forbidden(
            "a server may only speak for its own users".into(),
        ));
    }
    let watched: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM friends WHERE peer_id = ? AND state = ?")
            .bind(&fed.body.user_id)
            .bind(ACCEPTED)
            .fetch_one(&state.pool)
            .await?;
    if watched == 0 {
        return Ok(Json(json!({ "ok": true })));
    }

    let status = match fed.body.presence["status"].as_str().unwrap_or("offline") {
        s @ ("online" | "idle" | "dnd") => s,
        _ => "offline",
    };
    let rich_activities = fed.body.presence["rich_activities"]
        .as_array()
        .map(|values| {
            values.iter()
                .filter(|value| value.is_object())
                .filter(|value| serde_json::to_string(value).is_ok_and(|encoded| encoded.len() <= 4096))
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let presence = Presence {
        status: status.to_string(),
        custom_status: fed.body.presence["custom_status"].as_str().map(str::to_string),
        activity: fed.body.presence["activity"].as_str().map(str::to_string),
        rich_activities,
        updated_at: now_ms(),
    };
    if state.hub.set_presence(&fed.body.user_id, presence.clone(), true).await {
        crate::gateway::broadcast_presence(&state, &fed.body.user_id, presence).await;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn fanout_presence(state: &AppState, user_id: &str, presence: &Presence) {
    let body = presence.to_json(user_id);
    let watchers: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM friends WHERE peer_id = ? AND state = ?")
            .bind(user_id)
            .bind(ACCEPTED)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
    for watcher in watchers {
        state
            .hub
            .publish_user(
                &watcher,
                Event::to_account("PRESENCE_UPDATE", &watcher, body.clone()),
            )
            .await;
    }

    if !federation::is_local(state, user_id) {
        return;
    }
    let homes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT peer_domain FROM friends \
         WHERE user_id = ? AND state = ? AND peer_domain != ?",
    )
    .bind(user_id)
    .bind(ACCEPTED)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for home in homes {
        let state = state.clone();
        let payload = json!({ "user_id": user_id, "presence": body.clone() });
        tokio::spawn(async move {
            let _ =
                federation::post_signed(&state, &home, "/_telium/v1/friends/presence", &payload)
                    .await;
        });
    }
}

async fn queue(
    state: &AppState,
    destination: &str,
    from: &str,
    to: &str,
    action: &str,
) -> ApiResult<()> {
    if destination == state.cfg.server_name {
        return apply(state, from, to, action, true).await;
    }
    relay(state, destination, from, to, action).await
}

async fn relay(
    state: &AppState,
    destination: &str,
    from: &str,
    to: &str,
    action: &str,
) -> ApiResult<()> {
    let pair = format!("{from}|{to}");
    // A newer relation for the pair replaces the queued one, or a cancel could land before its request.
    sqlx::query("DELETE FROM friend_outbox WHERE destination = ? AND pair = ?")
        .bind(destination)
        .bind(&pair)
        .execute(&state.pool)
        .await?;
    let payload = json!({ "action": action, "from": from, "to": to });
    sqlx::query(
        "INSERT INTO friend_outbox (id, destination, pair, payload, next_attempt_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(destination)
    .bind(&pair)
    .bind(payload.to_string())
    .bind(now_ms())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = flush_outbox(&state).await {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "friend outbox flush failed");
        }
    });
    Ok(())
}

pub async fn flush_outbox(state: &AppState) -> ApiResult<u64> {
    let due: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT id, destination, payload, attempts FROM friend_outbox \
         WHERE next_attempt_at <= ? ORDER BY created_at LIMIT 50",
    )
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;

    let mut sent = 0;
    for (id, destination, payload, attempts) in due {
        let body: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        match federation::post_signed(state, &destination, "/_telium/v1/friends/relay", &body).await
        {
            Ok(_) => {
                sqlx::query("DELETE FROM friend_outbox WHERE id = ?")
                    .bind(&id)
                    .execute(&state.pool)
                    .await?;
                crate::metrics::Metrics::bump(&state.metrics.federation_deliveries, 1);
                sent += 1;
            }
            Err(e) => {
                crate::metrics::Metrics::bump(&state.metrics.federation_delivery_failures, 1);
                let attempts = attempts + 1;
                let backoff =
                    state.cfg.federation.dm_retry_secs as i64 * 1000 * (1i64 << attempts.min(10));
                if attempts > 40 {
                    tracing::warn!(target: crate::logcat::SOCIAL, destination = %destination, "dropping an undeliverable friend relay");
                    sqlx::query("DELETE FROM friend_outbox WHERE id = ?")
                        .bind(&id)
                        .execute(&state.pool)
                        .await?;
                    continue;
                }
                sqlx::query(
                    "UPDATE friend_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? \
                     WHERE id = ?",
                )
                .bind(attempts)
                .bind(now_ms() + backoff)
                .bind(e.to_string())
                .bind(&id)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(sent)
}
