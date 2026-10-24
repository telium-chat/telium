
pub mod events;
pub mod hub;
pub mod local_apps;

mod presence;

pub use presence::{broadcast_presence, spawn_presence_flusher};
use presence::apply_presence;

use crate::auth::GuildAuth;
use crate::guildstore;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use events::{Event, DEFAULT_INTENTS};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use telium_protocol::compat;
use tokio::sync::mpsc;

const HEARTBEAT_INTERVAL_MS: u64 = 45_000;
const IDENTIFY_TIMEOUT_MS: u64 = 30_000;

const MAX_MEMBER_RANGES: usize = 8;

pub async fn handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    // Frame limits apply before upgrade, and must act before IDENTIFY.
    const WRITE_BUFFER: usize = 8 * 1024;
    const MAX_WRITE_BUFFER: usize = 512 * 1024;
    let frame_cap = state.cfg.gateway.max_frame_bytes;
    let ws = ws
        .max_message_size(frame_cap)
        .max_frame_size(frame_cap)
        .write_buffer_size(WRITE_BUFFER)
        .max_write_buffer_size(MAX_WRITE_BUFFER);
    ws.on_upgrade(move |socket| async move {
        // Not accepting during shutdown: it would recreate the connection just dropped.
        if state.shutting_down.load(std::sync::atomic::Ordering::Relaxed) {
            let mut socket = socket;
            let _ = socket
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 4005,
                    reason: "server restarting".into(),
                })))
                .await;
            return;
        }
        if let Err(err) = run_session(socket, state).await {
            tracing::debug!(target: crate::logcat::GATEWAY, %err, "gateway session ended");
        }
    })
}

struct Session {
    id: u64,
    user_id: String,
    device_id: String,
    home_domain: String,
    intents: u64,
    seq: u64,
    is_bot: bool,
    application_id: Option<String>,
    bot_global_intents: u64,
    bot_session_expires_at: Option<i64>,
    visible: HashMap<String, HashSet<String>>,
    member_of: HashMap<String, bool>,
    member_ranges: HashMap<String, Vec<(i64, i64)>>,
    guild_typing: HashSet<String>,
    dm_typing: HashSet<String>,
}

fn version_str(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
}

async fn run_session(socket: WebSocket, state: AppState) -> anyhow::Result<()> {
    let (mut sink, mut stream) = socket.split();

    let Some(pending) = state.hub.admit_pending(state.cfg.gateway.max_pending_sockets) else {
        state.hub.note_refused();
        let _ = close(&mut sink, 4013, "too many unidentified connections").await;
        return Ok(());
    };

    let local = compat::PeerCompat::local();
    send(&mut sink, json!({
        "op": "HELLO",
        "d": {
            "heartbeat_interval_ms": HEARTBEAT_INTERVAL_MS,
            "gateway_version": 1,
            "protocol": {
                "version": local.version,
                "min_supported": local.min_supported,
                "capabilities": local.capabilities.iter().collect::<Vec<_>>(),
            },
        }
    }))
    .await?;

    // Needs the notify arm: this socket is in no subscription table, so `close_all` cannot reach it.
    let shutdown = state.shutdown.clone();
    let frame = tokio::select! {
        biased;
        _ = shutdown.notified() => {
            let _ = close(&mut sink, 4005, "server restarting").await;
            return Ok(());
        }
        identify = tokio::time::timeout(
            std::time::Duration::from_millis(IDENTIFY_TIMEOUT_MS),
            next_json(&mut stream),
        ) => match identify {
            Ok(Some(v)) => v,
            Ok(None) => return Ok(()),
            Err(_) => {
                let _ = close(&mut sink, 4008, "identify timed out").await;
                return Ok(());
            }
        },
    };

    if frame.get("op").and_then(Value::as_str) != Some("IDENTIFY") {
        let _ = close(&mut sink, 4001, "expected IDENTIFY").await;
        return Ok(());
    }
    let d = frame.get("d").cloned().unwrap_or(json!({}));

    // Version check before the token avoids a session lookup per reconnect.
    let client = compat::PeerCompat::from_wire(
        d.get("protocol").and_then(|p| p.get("version")).and_then(version_str).as_deref(),
        d.get("protocol")
            .and_then(|p| p.get("min_supported"))
            .and_then(version_str)
            .as_deref(),
        d.get("protocol")
            .and_then(|p| p.get("capabilities"))
            .and_then(Value::as_array)
            .map(|items| {
                items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(",")
            })
            .as_deref(),
    );
    if let Err(why) = client.negotiate() {
        tracing::info!(target: crate::logcat::GATEWAY, code = why.code(), "closing a gateway session outside the protocol window");
        let _ = close(&mut sink, 4015, &format!("{why}. {}", why.remedy())).await;
        return Ok(());
    }

    let token = d.get("token").and_then(Value::as_str).unwrap_or_default();
    let auth = match GuildAuth::from_token(&state, token).await {
        Ok(a) => a,
        Err(_) => {
            let _ = close(&mut sink, 4004, "authentication failed").await;
            return Ok(());
        }
    };

    let mut intents = match d.get("intents") {
        Some(Value::Array(names)) => events::intents_from_names(
            &names.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>(),
        ),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(DEFAULT_INTENTS),
        _ => DEFAULT_INTENTS,
    };
    if auth.is_bot {
        intents &= events::BOT_INTENTS & auth.bot_allowed_intents;
    }

    let session_id = state.hub.next_session_id();
    let mut session = Session {
        id: session_id,
        user_id: auth.user_id.clone(),
        device_id: auth.device_id.clone(),
        home_domain: auth.home_domain.clone(),
        intents,
        seq: 0,
        is_bot: auth.is_bot,
        application_id: auth.application_id.clone(),
        bot_global_intents: auth.bot_allowed_intents,
        bot_session_expires_at: auth.bot_session_expires_at,
        visible: HashMap::new(),
        member_of: HashMap::new(),
        member_ranges: HashMap::new(),
        guild_typing: HashSet::new(),
        dm_typing: HashSet::new(),
    };

    let guild_ids: Vec<String> = if session.is_bot {
        let Some(application_id) = session.application_id.as_deref() else {
            let _ = close(&mut sink, 4004, "bot session has no application").await;
            return Ok(());
        };
        sqlx::query_scalar(
            "SELECT guild_id FROM members \
             WHERE user_id = ? AND banned = 0 AND bot_application_id = ? \
               AND bot_application_origin = ?",
        )
        .bind(&session.user_id)
        .bind(application_id)
        .bind(&auth.home_domain)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT guild_id FROM members WHERE user_id = ? AND banned = 0",
        )
        .bind(&session.user_id)
        .fetch_all(&state.pool)
        .await?
    };

    let (tx, mut rx) = mpsc::channel::<Arc<Event>>(state.cfg.gateway.outbox_depth);
    let (outbox, lagging) = hub::Outbox::new(tx);

    if !state
        .hub
        .watch_account(
            session.id,
            &session.user_id,
            outbox.clone(),
            state.cfg.gateway.max_connections_per_account,
        )
        .await
    {
        state.hub.note_refused();
        let _ = close(&mut sink, 4011, "too many connections for this account").await;
        return Ok(());
    }
    state.hub.subscribe(session.id, &session.user_id, &guild_ids, outbox.clone()).await;
    if !session.is_bot && auth.home_domain == state.cfg.server_name {
        state.hub.subscribe_user(session.id, &session.user_id, outbox).await;
    }
    // Release the anonymous slot now, or the pending ceiling caps all connections.
    drop(pending);
    state.hub.connection_opened(&session.user_id).await;
    state.hub.device_opened(&session.user_id, &session.device_id).await;

    let claims = crate::routes::voice::VoiceClaim::list(&d);
    let reclaimed = if claims.is_empty() {
        Vec::new()
    } else {
        crate::routes::voice::reclaim(&state, &session.user_id, &session.device_id, &claims).await
    };

    if let Some(p) = d.get("presence") {
        let immediate = apply_presence(&state, &session.user_id, p).await;
        if immediate {
            let presence = state.hub.presence_of(&session.user_id).await;
            broadcast_presence(&state, &session.user_id, presence).await;
        }
    }

    let ready = build_ready(&state, &session, &guild_ids, &reclaimed).await?;
    send(&mut sink, ready).await?;

    let mut last_heartbeat = now_ms();
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(5));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let close_reason = loop {
        tokio::select! {
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break None };
                match msg {
                    Message::Text(text) => {
                        crate::metrics::Metrics::bump(&state.metrics.gateway_frames_in, 1);
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else {
                            break Some((4002, "malformed frame"));
                        };
                        match handle_client_frame(&state, &mut session, &frame, &mut sink).await {
                            Ok(HeartbeatSeen(true)) => last_heartbeat = now_ms(),
                            Ok(_) => {}
                            Err(err) => {
                                tracing::debug!(target: crate::logcat::GATEWAY, %err, "client frame rejected");
                            }
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => last_heartbeat = now_ms(),
                    Message::Close(_) => break None,
                    Message::Binary(_) => break Some((4002, "binary frames are not supported in v1")),
                }
            }
            event = rx.recv() => {
                let Some(event) = event else { break None };
                // Checked before rendering: once flagged, the queue has a hole in it.
                if lagging.load(std::sync::atomic::Ordering::Relaxed) {
                    break Some((4010, "falling behind"));
                }
                if event.t == events::SESSION_REVOKED {
                    if revocation_applies(&session, &event.data) {
                        break Some((4004, "session revoked"));
                    }
                    continue;
                }
                if event.t == events::SERVER_GOING_AWAY {
                    break Some((4005, "server restarting"));
                }
                if let Some(frame) = render(&state, &mut session, &event).await {
                    if send(&mut sink, frame).await.is_err() {
                        break None;
                    }
                    crate::metrics::Metrics::bump(&state.metrics.gateway_events_out, 1);
                }
            }
            _ = ticker.tick() => {
                if session
                    .bot_session_expires_at
                    .is_some_and(|expires_at| expires_at <= now_ms())
                {
                    break Some((4004, "session expired"));
                }
                if now_ms() - last_heartbeat > (HEARTBEAT_INTERVAL_MS as i64) * 2 {
                    break Some((4009, "heartbeat timed out"));
                }
                if lagging.load(std::sync::atomic::Ordering::Relaxed) {
                    state.hub.note_lagged_close();
                    break Some((4010, "connection fell too far behind"));
                }
            }
        }
    };

    for channel_id in session.guild_typing.drain() {
        if let Ok(ch) = guildstore::channel(&state, &channel_id).await {
            state.hub.publish(Event::in_channel(
                "TYPING_STOP",
                ch.guild_id,
                channel_id.clone(),
                events::INTENT_GUILD_TYPING,
                json!({
                    "channel_id": channel_id,
                    "user_id": session.user_id,
                    "timestamp": now_ms(),
                }),
            )).await;
        }
    }
    for conversation_id in session.dm_typing.drain() {
        let _ = crate::routes::dm::gateway_typing(
            &state, &conversation_id, &session.user_id, false,
        ).await;
    }
    state.hub.unsubscribe_all(session.id).await;
    if state.hub.device_closed(&session.user_id, &session.device_id).await {
        let state = state.clone();
        let user_id = session.user_id.clone();
        let device_id = session.device_id.clone();
        let grace = state.cfg.voice.reconnect_grace_secs;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(grace)).await;
            if !state.hub.device_live(&user_id, &device_id).await {
                crate::routes::voice::disconnect_device(&state, &user_id, &device_id).await;
            }
        });
    }
    if state.hub.connection_closed(&session.user_id).await {
        let presence = state.hub.presence_of(&session.user_id).await;
        for guild_id in &guild_ids {
            state
                .hub
                .publish(Event::new(
                    "PRESENCE_UPDATE",
                    guild_id.clone(),
                    events::INTENT_GUILD_PRESENCES,
                    presence.to_json(&session.user_id),
                ))
                .await;
        }
    }
    if let Some((code, reason)) = close_reason {
        let _ = close(&mut sink, code, reason).await;
    }
    Ok(())
}

struct HeartbeatSeen(bool);

async fn handle_client_frame(
    state: &AppState,
    session: &mut Session,
    frame: &Value,
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
) -> anyhow::Result<HeartbeatSeen> {
    let op = frame.get("op").and_then(Value::as_str).unwrap_or_default();
    let d = frame.get("d").cloned().unwrap_or(json!({}));

    // Heartbeats are answered before charging the budget, or too-fast becomes disconnected.
    if op == "HEARTBEAT" {
        send(sink, json!({ "op": "HEARTBEAT_ACK" })).await?;
        return Ok(HeartbeatSeen(true));
    }

    // Charged per account, not per connection, which attackers multiply.
    if state.cfg.rate_limit.enabled
        && state
            .limiter
            .take(
                format!("gateway:{}", session.user_id),
                "gateway-frame",
                state.cfg.gateway.frame_burst as f64,
                state.cfg.gateway.frames_per_sec,
            )
            .is_err()
    {
        return Ok(HeartbeatSeen(false));
    }

    match op {
        "PRESENCE_UPDATE" => {
            let immediate = apply_presence(state, &session.user_id, &d).await;
            if immediate {
                let presence = state.hub.presence_of(&session.user_id).await;
                broadcast_presence(state, &session.user_id, presence).await;
            }
        }
        "TYPING" | "TYPING_STOP" => {
            if let Some(channel_id) = d.get("channel_id").and_then(Value::as_str) {
                if state.cfg.rate_limit.enabled
                    && state
                        .limiter
                        .take(
                            format!("typing:{}:{}", session.user_id, channel_id),
                            "gateway-typing",
                            state.cfg.gateway.typing_burst as f64,
                            state.cfg.gateway.typing_per_sec,
                        )
                        .is_err()
                {
                    return Ok(HeartbeatSeen(false));
                }
                if let Ok((ch, _, _)) = guildstore::require_channel_perm(
                    state,
                    channel_id,
                    &session.user_id,
                    crate::perms::SEND_MESSAGES,
                )
                .await
                {
                    state
                        .hub
                        .publish(Event::in_channel(
                            if op == "TYPING_STOP" { "TYPING_STOP" } else { "TYPING_START" },
                            ch.guild_id,
                            channel_id,
                            events::INTENT_GUILD_TYPING,
                            json!({
                                "channel_id": channel_id,
                                "user_id": session.user_id,
                                "timestamp": now_ms(),
                            }),
                        ))
                        .await;
                    if op == "TYPING_STOP" {
                        session.guild_typing.remove(channel_id);
                    } else {
                        session.guild_typing.insert(channel_id.to_string());
                    }
                }
            }
        }
        "DM_TYPING_START" | "DM_TYPING_STOP" => {
            if session.is_bot {
                return Ok(HeartbeatSeen(false));
            }
            if let Some(conversation_id) = d.get("conversation_id").and_then(Value::as_str) {
                if state.cfg.rate_limit.enabled
                    && state
                        .limiter
                        .take(
                            format!("typing:{}:{}", session.user_id, conversation_id),
                            "gateway-typing",
                            state.cfg.gateway.typing_burst as f64,
                            state.cfg.gateway.typing_per_sec,
                        )
                        .is_err()
                {
                    return Ok(HeartbeatSeen(false));
                }
                let active = op == "DM_TYPING_START";
                if crate::routes::dm::gateway_typing(
                    state, conversation_id, &session.user_id, active,
                ).await.is_ok() {
                    if active {
                        session.dm_typing.insert(conversation_id.to_string());
                    } else {
                        session.dm_typing.remove(conversation_id);
                    }
                }
            }
        }
        "SUBSCRIBE" => {
            let Some(guild_id) = d.get("guild_id").and_then(Value::as_str) else {
                return Ok(HeartbeatSeen(false));
            };
            if guildstore::membership(state, guild_id, &session.user_id).await.is_err() {
                return Ok(HeartbeatSeen(false));
            }
            if session.is_bot
                && bot_guild_grant(state, session, guild_id).await.unwrap_or(0)
                    & events::INTENT_GUILD_MEMBERS
                    == 0
            {
                return Ok(HeartbeatSeen(false));
            }
            let ranges: Vec<(i64, i64)> = d
                .get("member_ranges")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|r| {
                            let pair = r.as_array()?;
                            Some((pair.first()?.as_i64()?, pair.get(1)?.as_i64()?))
                        })
                        .filter(|(s, e)| *s >= 0 && e >= s && e - s <= 200)
                        // Cap the number of ranges: each costs a member query.
                        .take(MAX_MEMBER_RANGES)
                        .collect()
                })
                .unwrap_or_default();
            session.member_ranges.insert(guild_id.to_string(), ranges.clone());

            let payload = member_list_payload(state, guild_id, &ranges).await?;
            let seq = session.next_seq();
            send(sink, json!({ "op": "DISPATCH", "s": seq, "t": "MEMBER_LIST_UPDATE", "d": payload }))
                .await?;
        }
        "REQUEST_GUILD_CHANNELS" => {
            if let Some(guild_id) = d.get("guild_id").and_then(Value::as_str) {
                let bot_grant = if session.is_bot {
                    bot_guild_grant(state, session, guild_id).await.unwrap_or(0)
                } else {
                    u64::MAX
                };
                if session.is_bot && bot_grant & events::INTENT_GUILD_STRUCTURE == 0 {
                    return Ok(HeartbeatSeen(false));
                }
                session.visible.remove(guild_id);
                session.member_of.remove(guild_id);
                let visible = visible_for(state, session, guild_id).await;
                let mut channels = Vec::new();
                for channel_id in &visible {
                    let ch: Option<(String, String, String, Option<String>, i64, Option<String>, i64, Option<String>, Option<i64>, Option<String>)> =
                        sqlx::query_as(
                            "SELECT id, type, name, topic, position, parent_id, strip_embeds, \
                             voice_status, voice_status_at, voice_status_author \
                             FROM channels WHERE id = ?",
                        )
                        .bind(channel_id)
                        .fetch_optional(&state.pool)
                        .await?;
                    if let Some((id, kind, name, topic, position, parent_id, strip_embeds, voice_status, voice_status_at, voice_status_author)) = ch {
                        let ow = guildstore::effective_overwrites(&state.pool, &id).await?;
                        channels.push(json!({
                            "id": id, "type": kind, "name": name, "topic": topic,
                            "position": position, "parent_id": parent_id,
                            "strip_embeds": strip_embeds != 0,
                            "voice_status": voice_status,
                            "voice_status_at": voice_status_at,
                            "voice_status_author": voice_status_author,
                            "permission_overwrites": ow.iter().map(|o| json!({
                                "target_type": o.target_type, "target_id": o.target_id,
                                "allow": o.allow.to_string(), "deny": o.deny.to_string(),
                            })).collect::<Vec<_>>(),
                        }));
                    }
                }
                let mut voice_states = Vec::new();
                if session.intents & events::INTENT_GUILD_VOICE_STATES != 0
                    && (!session.is_bot || bot_grant & events::INTENT_GUILD_VOICE_STATES != 0)
                {
                    let live: Vec<(String, String)> = sqlx::query_as(
                        "SELECT user_id, channel_id FROM voice_states WHERE guild_id = ?",
                    )
                    .bind(guild_id)
                    .fetch_all(&state.pool)
                    .await?;
                    for (user_id, channel_id) in live {
                        if visible.contains(&channel_id) {
                            voice_states.push(crate::routes::voice::voice_state_json(
                                state, guild_id, &user_id,
                            ).await?);
                        }
                    }
                }

                let seq = session.next_seq();
                send(
                    sink,
                    json!({
                        "op": "DISPATCH", "s": seq, "t": "CHANNEL_VISIBILITY",
                        "d": {
                            "guild_id": guild_id,
                            "channels": channels,
                            "voice_states": voice_states,
                        }
                    }),
                )
                .await?;
            }
        }
        "RESUME" => {
            send(sink, json!({ "op": "INVALID_SESSION", "d": { "resumable": false } })).await?;
        }
        _ => {}
    }
    Ok(HeartbeatSeen(false))
}

impl Session {
    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
}

fn revocation_applies(session: &Session, data: &Value) -> bool {
    let device = data.get("device_id").and_then(Value::as_str);
    if device.is_some_and(|d| d != session.device_id) {
        return false;
    }
    match data.get("homes").and_then(Value::as_array) {
        Some(homes) => homes.iter().any(|h| h.as_str() == Some(session.home_domain.as_str())),
        None => true,
    }
}

async fn bot_guild_grant(state: &AppState, session: &Session, guild_id: &str) -> Option<u64> {
    if !session.is_bot {
        return None;
    }
    let application_id = session.application_id.as_deref()?;
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT bot_allowed_intents, banned FROM members \
         WHERE guild_id = ? AND user_id = ? AND bot_application_id = ? \
           AND bot_application_origin = ?",
    )
    .bind(guild_id)
    .bind(&session.user_id)
    .bind(application_id)
    .bind(&session.home_domain)
    .fetch_optional(&state.pool)
    .await
    .ok()?;
    let (granted, banned) = row?;
    if banned != 0 {
        return None;
    }
    Some((granted as u64) & session.bot_global_intents & session.intents & events::BOT_INTENTS)
}

async fn render(state: &AppState, session: &mut Session, event: &Arc<Event>) -> Option<Value> {
    // Invalidate before any filter, or client-chosen intents decide whether caches are invalidated.
    if matches!(
        event.t,
        "CHANNEL_CREATE" | "CHANNEL_UPDATE" | "CHANNEL_DELETE" | "ROLE_CREATE" | "ROLE_UPDATE"
            | "ROLE_DELETE" | "MEMBER_UPDATE" | "MEMBER_REMOVE"
    ) {
        session.visible.remove(&event.guild_id);
        session.member_of.remove(&event.guild_id);
    }

    if event.intent != 0 && session.intents & event.intent == 0 {
        return None;
    }

    // Re-check membership: the hub's guild subscription outlives kick, ban and leave.
    if !event.guild_id.is_empty()
        && !announces_this_session_is_out(session, event)
        && !still_member(state, session, &event.guild_id).await
    {
        return None;
    }

    let bot_grant = if session.is_bot {
        let grant = bot_guild_grant(state, session, &event.guild_id).await?;
        if event.intent != 0 && grant & event.intent == 0 {
            return None;
        }
        Some(grant)
    } else {
        None
    };

    if let Some(channel_id) = &event.channel_id {
        let visible = visible_for(state, session, &event.guild_id).await;
        if !visible.contains(channel_id) {
            return None;
        }
    }

    let seq = session.next_seq();
    let mut payload = payload_for(event);
    let can_read_message_content = !session.is_bot
        || (session.intents & events::INTENT_MESSAGE_CONTENT != 0
            && bot_grant.is_some_and(|grant| grant & events::INTENT_MESSAGE_CONTENT != 0));
    if !can_read_message_content {
        // Redaction lives in `routes::messages` and runs on every dispatch.
        crate::routes::messages::redact_message_content(&mut payload);
    }
    Some(json!({ "op": "DISPATCH", "s": seq, "t": event.t, "d": payload }))
}

fn payload_for(event: &Event) -> Value {
    let mut data = event.data.clone();
    if let (false, Some(obj)) = (event.guild_id.is_empty(), data.as_object_mut()) {
        obj.entry("guild_id")
            .or_insert_with(|| Value::String(event.guild_id.clone()));
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::events::INTENT_GUILD_STRUCTURE;

    #[test]
    fn guild_scoped_payloads_gain_a_guild_id() {
        let ev = Event::new("ROLE_UPDATE", "g1", INTENT_GUILD_STRUCTURE, json!({ "id": "r1" }));
        assert_eq!(payload_for(&ev)["guild_id"], "g1");
    }

    #[test]
    fn an_explicit_guild_id_is_not_overwritten() {
        let ev = Event::new("MEMBER_ADD", "g1", INTENT_GUILD_STRUCTURE, json!({ "guild_id": "g2" }));
        assert_eq!(payload_for(&ev)["guild_id"], "g2");
    }

    #[test]
    fn account_events_stay_guildless() {
        let ev = Event::to_account("DM_MESSAGE", "@a:x", json!({ "id": "m1" }));
        assert!(payload_for(&ev).get("guild_id").is_none());
    }
}

fn announces_this_session_is_out(session: &Session, event: &Event) -> bool {
    match event.t {
        "GUILD_DELETE" => true,
        "MEMBER_REMOVE" => {
            event.data.get("user_id").and_then(Value::as_str) == Some(session.user_id.as_str())
        }
        _ => false,
    }
}

async fn still_member(state: &AppState, session: &mut Session, guild_id: &str) -> bool {
    if let Some(known) = session.member_of.get(guild_id) {
        return *known;
    }
    let banned: Option<i64> =
        sqlx::query_scalar("SELECT banned FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(guild_id)
            .bind(&session.user_id)
            .fetch_optional(&state.pool)
            .await
            .unwrap_or(None);
    let member = banned == Some(0);
    session.member_of.insert(guild_id.to_string(), member);
    member
}

async fn visible_for(state: &AppState, session: &mut Session, guild_id: &str) -> HashSet<String> {
    if let Some(set) = session.visible.get(guild_id) {
        return set.clone();
    }
    let list = guildstore::visible_channels(state, guild_id, &session.user_id)
        .await
        .unwrap_or_default();
    let set: HashSet<String> = list.into_iter().collect();
    session.visible.insert(guild_id.to_string(), set.clone());
    set
}

async fn build_ready(
    state: &AppState,
    session: &Session,
    guild_ids: &[String],
    reclaimed: &[String],
) -> anyhow::Result<Value> {
    let local = compat::PeerCompat::local();
    let mut guilds = Vec::new();
    for guild_id in guild_ids {
        let bot_grant = if session.is_bot {
            let Some(grant) = bot_guild_grant(state, session, guild_id).await else {
                continue;
            };
            grant
        } else {
            u64::MAX
        };

        let row: Option<(String, String, Option<String>, String)> =
            sqlx::query_as("SELECT id, name, icon_ref, owner_user_id FROM guilds WHERE id = ?")
                .bind(guild_id)
                .fetch_optional(&state.pool)
                .await?;
        let Some((id, name, icon_ref, owner)) = row else {
            if let Some(new_id) = guildstore::moved_to(state, guild_id).await? {
                guilds.push(crate::routes::guild::moved_guild_stub(
                    &state.cfg.server_name,
                    guild_id,
                    &new_id,
                ));
            }
            continue;
        };

        let include_structure =
            !session.is_bot || bot_grant & events::INTENT_GUILD_STRUCTURE != 0;
        let visible = if include_structure {
            guildstore::visible_channels(state, guild_id, &session.user_id)
                .await
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let mut channels = Vec::new();
        if include_structure {
            for channel_id in &visible {
            let ch: Option<(String, String, String, Option<String>, i64, Option<String>, i64, Option<String>, Option<i64>, Option<String>)> =
                sqlx::query_as(
                    "SELECT id, type, name, topic, position, parent_id, strip_embeds, \
                     voice_status, voice_status_at, voice_status_author \
                     FROM channels WHERE id = ?",
                )
                .bind(channel_id)
                .fetch_optional(&state.pool)
                .await?;
            if let Some((id, kind, name, topic, position, parent_id, strip_embeds, voice_status, voice_status_at, voice_status_author)) = ch {
                let ow = guildstore::effective_overwrites(&state.pool, &id).await?;
                channels.push(json!({
                    "id": id, "type": kind, "name": name, "topic": topic,
                    "position": position, "parent_id": parent_id,
                    "strip_embeds": strip_embeds != 0,
                    "voice_status": voice_status,
                    "voice_status_at": voice_status_at,
                    "voice_status_author": voice_status_author,
                    "permission_overwrites": ow.iter().map(|o| json!({
                        "target_type": o.target_type, "target_id": o.target_id,
                        "allow": o.allow.to_string(), "deny": o.deny.to_string(),
                    })).collect::<Vec<_>>(),
                }));
            }
        }

        }

        let mut voice_states = Vec::new();
        if !session.is_bot || bot_grant & events::INTENT_GUILD_VOICE_STATES != 0 {
            let live: Vec<(String, String)> = sqlx::query_as(
                "SELECT user_id, channel_id FROM voice_states WHERE guild_id = ?",
            )
            .bind(guild_id)
            .fetch_all(&state.pool)
            .await?;
            for (user_id, channel_id) in live {
                if visible.contains(&channel_id) {
                    voice_states.push(crate::routes::voice::voice_state_json(
                        state, guild_id, &user_id,
                    ).await?);
                }
            }
        }

        guilds.push(json!({
            "moved_to": guildstore::moved_to(state, guild_id).await?,
            "id": id,
            "name": name,
            "icon_ref": icon_ref,
            "owner": owner,
            "channels": channels,
            "voice_states": voice_states,
            "roles": if include_structure {
                guildstore::roles_json(&state, guild_id).await?
            } else {
                Vec::new()
            },
            "me": guildstore::me_json(&state, guild_id, &session.user_id).await?,
            "member_count": if !session.is_bot || bot_grant & events::INTENT_GUILD_MEMBERS != 0 {
                Some(guildstore::member_count(&state.pool, guild_id).await?)
            } else {
                None
            },
            "bot_allowed_intents": session.is_bot.then(|| bot_grant.to_string()),
            "bot_allowed_intent_names": session
                .is_bot
                .then(|| events::intent_names(bot_grant)),
        }));
    }

    Ok(json!({
        "op": "READY",
        "d": {
            "session_id": session.id,
            "user": {
                "user_id": session.user_id,
                "device_id": session.device_id,
                "is_bot": session.is_bot,
                "application_id": session.application_id,
            },
            "server_name": state.cfg.server_name,
            // Repeated from HELLO on purpose: HELLO is unauthenticated and the answering server may differ.
            "protocol": {
                "version": local.version,
                "min_supported": local.min_supported,
                "capabilities": local.capabilities.iter().collect::<Vec<_>>(),
            },
            "intents": session.intents,
            "guilds": guilds,
            "voice_reclaimed": reclaimed,
            "resume_supported": false,
        }
    }))
}

async fn member_list_payload(
    state: &AppState,
    guild_id: &str,
    ranges: &[(i64, i64)],
) -> anyhow::Result<Value> {
    let online = state.hub.online_users_in(guild_id).await;
    let mut ops = Vec::new();
    for (start, end) in ranges {
        let rows = guildstore::member_range(&state.pool, guild_id, *start, end - start + 1).await?;
        let mut items = Vec::new();
        for row in &rows {
            let presence = {
                let p = state.hub.presence_of(&row.user_id).await;
                if online.contains(&row.user_id) || p.custom_status.is_some() {
                    Some(p.to_json(&row.user_id))
                } else {
                    None
                }
            };
            items.push(guildstore::member_json(row, presence));
        }
        ops.push(json!({ "op": "SYNC", "range": [start, end], "items": items }));
    }
    Ok(json!({
        "guild_id": guild_id,
        "ops": ops,
        "member_count": guildstore::member_count(&state.pool, guild_id).await?,
        "online_count": online.len(),
    }))
}

async fn next_json(
    stream: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Option<Value> {
    while let Some(Ok(msg)) = stream.next().await {
        if let Message::Text(text) = msg {
            return serde_json::from_str(&text).ok();
        }
    }
    None
}

async fn send(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: Value,
) -> anyhow::Result<()> {
    sink.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn close(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: u16,
    reason: &str,
) -> anyhow::Result<()> {
    // Close reasons cap at 123 bytes; truncate on a char boundary.
    let mut reason = reason.to_string();
    if reason.len() > 123 {
        let mut cut = 123;
        while !reason.is_char_boundary(cut) {
            cut -= 1;
        }
        reason.truncate(cut);
    }
    sink.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await?;
    Ok(())
}
