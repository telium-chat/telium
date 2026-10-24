
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::routes::dm::{home_of, may_receive_dm_interaction, require_member};
use crate::routes::voice::{self, JoinRequest, Signal, StateUpdate};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const ROOM_KIND: &str = "dm";

const NOTIFY_PATH: &str = "/_telium/v1/dm/voice/notify";
const ROSTER_PATH: &str = "/_telium/v1/dm/voice";
const TOKEN_PATH: &str = "/_telium/v1/dm/voice/token";
const INCOMING_CALL_KIND: &str = "incoming_call";
const INCOMING_CALL_TTL_MS: i64 = 60_000;

const CUSTOM: &str = "custom";

async fn sequencer_of(state: &AppState, conversation_id: &str) -> ApiResult<String> {
    sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(conversation_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such conversation".into()))
}

pub fn relay_turn(state: &AppState) -> Option<String> {
    let voice = &state.cfg.voice;
    if !voice.enabled || voice.turn_secret.as_deref().is_none_or(str::is_empty) {
        return None;
    }
    if let Some(turn) = voice.turn.as_ref().filter(|t| !t.is_empty()) {
        return Some(turn.clone());
    }
    voice
        .regions
        .iter()
        .find(|r| r.name == voice.default_region && r.turn.is_some())
        .or_else(|| voice.regions.iter().find(|r| r.turn.is_some()))
        .and_then(|r| r.turn.clone())
}

fn hosts_sfu(state: &AppState) -> bool {
    state.cfg.voice.enabled && state.cfg.voice.addressed_regions().next().is_some()
}

async fn state_json(state: &AppState, conversation_id: &str, user_id: &str) -> ApiResult<Value> {
    let mut payload = voice::voice_state_json(state, conversation_id, user_id).await?;
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("guild_id");
        obj.insert("conversation_id".into(), json!(conversation_id));
    }
    Ok(payload)
}

#[derive(Deserialize, Default)]
pub struct ConvJoin {
    #[serde(flatten)]
    pub join: JoinRequest,
    #[serde(default)]
    pub wants_sfu: bool,
    #[serde(default)]
    pub custom_sfu: bool,
    #[serde(default)]
    pub home_sfu: bool,
}

async fn upsert_row(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    device_id: &str,
    req: &ConvJoin,
    session_id: Option<&str>,
) -> ApiResult<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO voice_states (guild_id, user_id, channel_id, device_id, session_id, region, \
         self_mute, self_deaf, self_video, room_kind, wants_sfu, home_sfu, custom_sfu, \
         joined_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'mesh', ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(guild_id, user_id) DO UPDATE SET device_id = excluded.device_id, \
             session_id = excluded.session_id, self_mute = excluded.self_mute, self_deaf = excluded.self_deaf, \
             self_video = excluded.self_video, streaming = 0, stream_preset = NULL, \
             wants_sfu = excluded.wants_sfu, home_sfu = excluded.home_sfu, \
             custom_sfu = excluded.custom_sfu, updated_at = excluded.updated_at, \
             reclaim_until = NULL",
    )
    .bind(conversation_id)
    .bind(user_id)
    .bind(conversation_id)
    .bind(device_id)
    .bind(session_id.map(str::to_string).unwrap_or_else(ulid))
    .bind(req.join.self_mute as i64)
    .bind(req.join.self_deaf as i64)
    .bind(req.join.self_video as i64)
    .bind(ROOM_KIND)
    .bind(req.wants_sfu as i64)
    .bind(req.home_sfu as i64)
    .bind(req.custom_sfu as i64)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn forget_locally(state: &AppState, conversation_id: &str, user_id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM voice_states WHERE guild_id = ? AND user_id = ?")
        .bind(conversation_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Call {
    mode: String,
    host: Option<String>,
    generation: i64,
}

impl Call {
    fn mesh() -> Self {
        Call { mode: "mesh".into(), host: None, generation: 0 }
    }

    fn is_sfu(&self) -> bool {
        self.mode == "sfu"
    }

    fn json(&self, state: &AppState) -> Value {
        json!({
            "mode": self.mode, "host": self.host, "generation": self.generation,
            "mesh_max": state.cfg.voice.mesh_max_participants,
        })
    }

    fn from_json(v: &Value) -> Self {
        let mode = v["mode"].as_str().unwrap_or("mesh");
        let host = v["host"].as_str().map(str::to_string);
        if mode == "sfu" && host.is_some() {
            Call { mode: "sfu".into(), host, generation: v["generation"].as_i64().unwrap_or(0) }
        } else {
            Call { generation: v["generation"].as_i64().unwrap_or(0), ..Call::mesh() }
        }
    }
}

#[derive(Clone, Debug)]
struct Seat {
    user_id: String,
    wants_sfu: bool,
    home_sfu: bool,
    custom_sfu: bool,
}

async fn seats(state: &AppState, conversation_id: &str) -> ApiResult<Vec<Seat>> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT user_id, wants_sfu, home_sfu, custom_sfu FROM voice_states WHERE guild_id = ?",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(user_id, w, h, c)| Seat { user_id, wants_sfu: w != 0, home_sfu: h != 0, custom_sfu: c != 0 })
        .collect())
}

async fn current_call(state: &AppState, conversation_id: &str) -> ApiResult<Option<Call>> {
    let row: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT mode, host, generation FROM conversation_calls WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|(mode, host, generation)| Call { mode, host, generation }))
}

fn pick_host(sequencer: &str, sequencer_hosts: bool, seats: &[Seat]) -> Option<String> {
    if seats.iter().any(|s| s.custom_sfu) {
        return Some(CUSTOM.into());
    }
    if sequencer_hosts {
        return Some(sequencer.into());
    }
    seats
        .iter()
        .filter(|s| s.home_sfu)
        .filter_map(|s| home_of(&s.user_id).ok())
        .min()
}

fn decide(cap: i64, seats: &[Seat], host: Option<String>, current: Option<&Call>) -> Option<Call> {
    if let Some(call) = current.filter(|c| c.is_sfu()) {
        return Some(call.clone());
    }
    let generation = current.map_or(0, |c| c.generation);
    let over = cap > 0 && seats.len() as i64 > cap;
    let wanted = seats.iter().any(|s| s.wants_sfu);
    match host {
        Some(host) if over || wanted => {
            Some(Call { mode: "sfu".into(), host: Some(host), generation: generation + 1 })
        }
        None if over => None,
        _ => Some(Call { generation, ..Call::mesh() }),
    }
}

async fn settle(state: &AppState, conversation_id: &str) -> ApiResult<Option<Call>> {
    let seats = seats(state, conversation_id).await?;
    let current = current_call(state, conversation_id).await?;
    if seats.is_empty() {
        sqlx::query("DELETE FROM conversation_calls WHERE conversation_id = ?")
            .bind(conversation_id)
            .execute(&state.pool)
            .await?;
        return Ok(None);
    }
    let host = pick_host(&state.cfg.server_name, hosts_sfu(state), &seats);
    let next = decide(state.cfg.voice.mesh_max_participants, &seats, host, current.as_ref())
        .unwrap_or_else(|| current.clone().unwrap_or_else(Call::mesh));
    if current.as_ref() == Some(&next) {
        return Ok(Some(next));
    }
    let now = now_ms();
    sqlx::query(
        "INSERT INTO conversation_calls (conversation_id, mode, host, generation, started_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(conversation_id) DO UPDATE SET mode = excluded.mode, host = excluded.host, \
             generation = excluded.generation, updated_at = excluded.updated_at",
    )
    .bind(conversation_id)
    .bind(&next.mode)
    .bind(&next.host)
    .bind(next.generation)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    let moved = current.as_ref().map_or(next.is_sfu(), |c| c.mode != next.mode);
    if moved && seats.len() > 1 {
        fanout(
            state,
            conversation_id,
            "VOICE_SERVER_UPDATE",
            json!({
                "conversation_id": conversation_id, "channel_id": conversation_id,
                "mode": next.mode, "host": next.host, "generation": next.generation,
                "reconnect": true,
            }),
        )
        .await;
    }
    Ok(Some(next))
}

async fn fanout(state: &AppState, conversation_id: &str, t: &'static str, data: Value) {
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(conversation_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut remotes: Vec<String> = Vec::new();
    for (user_id, home) in members {
        if home == state.cfg.server_name {
            if may_receive_dm_interaction(state, conversation_id, &user_id)
                .await
                .unwrap_or(false)
            {
                state
                    .hub
                    .publish_user(&user_id, Event::to_account(t, &user_id, data.clone()))
                    .await;
            }
        } else if !remotes.contains(&home) {
            remotes.push(home);
        }
    }
    for home in remotes {
        notify(state, &home, conversation_id, t, &data, None).await;
    }
}

async fn notify(
    state: &AppState,
    destination: &str,
    conversation_id: &str,
    t: &str,
    data: &Value,
    target: Option<&str>,
) {
    let body = json!({
        "conversation_id": conversation_id, "t": t, "data": data, "target": target,
    });
    if let Err(err) = federation::post_signed(state, destination, NOTIFY_PATH, &body).await {
        tracing::warn!(target: crate::logcat::VOICE, %err, %destination, %conversation_id, "could not carry a call event");
    }
}

fn incoming_call_source_id(conversation_id: &str, started_at: i64) -> String {
    let mut digest = Sha256::new();
    digest.update(b"telium-incoming-call-v1\0");
    digest.update(conversation_id.as_bytes());
    digest.update(started_at.to_be_bytes());
    format!("call-{}", hex::encode(digest.finalize()))
}

fn incoming_call_routes(
    members: Vec<(String, String)>, caller: &str, local_server: &str,
) -> (Vec<String>, Vec<String>) {
    let mut local = Vec::new();
    let mut remotes = Vec::new();
    for (user_id, home) in members {
        if user_id == caller {
            continue;
        }
        if home == local_server {
            local.push(user_id);
        } else if !remotes.contains(&home) {
            remotes.push(home);
        }
    }
    (local, remotes)
}

fn incoming_call_title(caller: &str) -> String {
    caller.trim_start_matches('@').split(':').next()
        .filter(|s| !s.is_empty()).unwrap_or(caller).to_string()
}

async fn wake_incoming_call_device(
    state: &AppState, user_id: &str, device_id: &str, origin: &str, source_id: &str,
) {
    if !state.hub.device_live(user_id, device_id).await {
        crate::routes::push::wake_notification_device_incoming_call(state, user_id, device_id).await;
        return;
    }

    let state = state.clone();
    let user_id = user_id.to_string();
    let device_id = device_id.to_string();
    let origin = origin.to_string();
    let source_id = source_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM notification_inbox \
             WHERE user_id = ? AND device_id = ? AND origin = ? AND source_id = ? \
             AND kind = 'incoming_call')",
        )
        .bind(&user_id).bind(&device_id).bind(&origin).bind(&source_id)
        .fetch_one(&state.pool).await.unwrap_or(false);
        if exists {
            crate::routes::push::wake_notification_device_incoming_call(
                &state, &user_id, &device_id,
            ).await;
        }
    });
}

async fn enqueue_local_incoming_call(
    state: &AppState,
    origin: &str,
    conversation_id: &str,
    caller: &str,
    recipient: &str,
    source_id: &str,
    created_at: i64,
) -> ApiResult<usize> {
    if home_of(recipient)? != state.cfg.server_name {
        return Err(ApiError::Forbidden("incoming-call recipient is not local".into()));
    }
    require_member(state, conversation_id, caller).await?;
    require_member(state, conversation_id, recipient).await?;
    if source_id != incoming_call_source_id(conversation_id, created_at) {
        return Err(ApiError::BadRequest("incoming-call source id is invalid".into()));
    }

    let now = now_ms();
    let expires_at = created_at.saturating_add(INCOMING_CALL_TTL_MS);
    if created_at <= 0 || expires_at <= now {
        return Ok(0);
    }
    let descriptor = json!({
        "v": 1,
        "kind": INCOMING_CALL_KIND,
        "title": incoming_call_title(caller),
        "body": "Incoming call",
        "destination": { "type": "conversation", "conversation_id": conversation_id },
        "created_at": created_at,
    });
    let plaintext = serde_json::to_vec(&descriptor)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("call notification descriptor: {e}")))?;
    let devices = crate::notifications::keys_for_local_user(state, recipient).await?;
    let mut inserted = Vec::new();
    for device in devices {
        if device.algorithm != crate::notifications::ALGORITHM_V1 {
            continue;
        }
        let aad = crate::notifications::aad(
            recipient, &device.device_id, origin, source_id, None, INCOMING_CALL_KIND,
        );
        let sealed = crate::notifications::seal_descriptor(&device.public_key, &aad, &plaintext)?;
        let ciphertext = serde_json::to_string(&sealed)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("call notification envelope: {e}")))?;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO notification_inbox \
             (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(ulid()).bind(recipient).bind(&device.device_id).bind(origin).bind(source_id)
        .bind(INCOMING_CALL_KIND).bind(ciphertext).bind(now).bind(expires_at)
        .execute(&state.pool).await?;
        if result.rows_affected() == 1 {
            inserted.push(device.device_id);
        }
    }

    for device_id in &inserted {
        wake_incoming_call_device(state, recipient, device_id, origin, source_id).await;
    }
    Ok(inserted.len())
}

async fn dispatch_incoming_call(state: &AppState, conversation_id: &str, caller: &str) {
    let started_at: Option<i64> = sqlx::query_scalar(
        "SELECT started_at FROM conversation_calls WHERE conversation_id = ?",
    )
    .bind(conversation_id).fetch_optional(&state.pool).await.unwrap_or(None);
    let Some(started_at) = started_at else { return };
    let source_id = incoming_call_source_id(conversation_id, started_at);
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, home_domain FROM conversation_members \
         WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(conversation_id).fetch_all(&state.pool).await.unwrap_or_default();
    let (local, remotes) = incoming_call_routes(members, caller, &state.cfg.server_name);
    for recipient in local {
        if let Err(err) = enqueue_local_incoming_call(
            state, &state.cfg.server_name, conversation_id, caller, &recipient, &source_id, started_at,
        ).await {
            tracing::warn!(target: crate::logcat::VOICE, %err, %conversation_id, %recipient, "could not enqueue incoming-call notification");
        }
    }
    let data = json!({ "caller": caller, "source_id": source_id, "created_at": started_at });
    for home in remotes {
        notify(state, &home, conversation_id, "INCOMING_CALL", &data, None).await;
    }
}

async fn admit(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    device_id: &str,
    req: &ConvJoin,
) -> ApiResult<(Value, Call)> {
    let cap = state.cfg.voice.mesh_max_participants;
    let existing = seats(state, conversation_id).await?;
    let starts_call = existing.is_empty();
    let mut prospective: Vec<Seat> = existing
        .into_iter()
        .filter(|s| s.user_id != user_id)
        .collect();
    prospective.push(Seat {
        user_id: user_id.to_string(),
        wants_sfu: req.wants_sfu,
        home_sfu: req.home_sfu,
        custom_sfu: req.custom_sfu,
    });
    let current = current_call(state, conversation_id).await?;
    let host = pick_host(&state.cfg.server_name, hosts_sfu(state), &prospective);
    if decide(cap, &prospective, host, current.as_ref()).is_none() {
        return Err(ApiError::Conflict(format!(
            "this call is full: a peer-to-peer call holds at most {cap} people, and larger \
             calls need an SFU configured (on a participant's server, or as this \
             conversation's own SFU)"
        )));
    }
    upsert_row(state, conversation_id, user_id, device_id, req, None).await?;
    let call = settle(state, conversation_id).await?.unwrap_or_else(Call::mesh);
    let payload = state_json(state, conversation_id, user_id).await?;
    fanout(state, conversation_id, "VOICE_STATE_UPDATE", payload.clone()).await;
    if starts_call {
        dispatch_incoming_call(state, conversation_id, user_id).await;
    }
    Ok((payload, call))
}

#[derive(Deserialize, Default)]
pub struct Patch {
    #[serde(flatten)]
    pub flags: StateUpdate,
    #[serde(default)]
    pub streaming: Option<bool>,
    #[serde(default)]
    pub wants_sfu: Option<bool>,
    #[serde(default)]
    pub custom_sfu: Option<bool>,
}

async fn amend(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    req: &Patch,
) -> ApiResult<Value> {
    voice::apply_state(state, conversation_id, user_id, &req.flags).await?;
    for (column, value) in [
        ("streaming", req.streaming),
        ("wants_sfu", req.wants_sfu),
        ("custom_sfu", req.custom_sfu),
    ] {
        let Some(v) = value else { continue };
        sqlx::query(&format!(
            "UPDATE voice_states SET {column} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?"
        ))
        .bind(v as i64)
        .bind(now_ms())
        .bind(conversation_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    }
    if req.wants_sfu.is_some() || req.custom_sfu.is_some() {
        settle(state, conversation_id).await?;
    }
    let payload = state_json(state, conversation_id, user_id).await?;
    fanout(state, conversation_id, "VOICE_STATE_UPDATE", payload.clone()).await;
    Ok(payload)
}

async fn roster(state: &AppState, conversation_id: &str) -> ApiResult<Value> {
    let users: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM voice_states WHERE guild_id = ?")
            .bind(conversation_id)
            .fetch_all(&state.pool)
            .await?;
    let mut states = Vec::new();
    for user_id in users {
        states.push(state_json(state, conversation_id, &user_id).await?);
    }
    let call = current_call(state, conversation_id).await?.unwrap_or_else(Call::mesh);
    Ok(json!({
        "conversation_id": conversation_id, "voice_states": states, "watchers": [],
        "call": call.json(state),
    }))
}

pub async fn remote_seat_still_held(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    device_id: &str,
) -> bool {
    let Ok(sequencer) = sequencer_of(state, conversation_id).await else { return false };
    if sequencer != state.cfg.server_name {
        return false;
    }
    let Ok(home) = home_of(user_id) else { return false };
    if home == state.cfg.server_name {
        return false;
    }
    let body = json!({
        "conversation_id": conversation_id, "op": "held",
        "user_id": user_id, "device_id": device_id,
    });
    let answer = match federation::post_signed(state, &home, ROSTER_PATH, &body).await {
        Ok(answer) => answer,
        Err(err) => {
            tracing::debug!(target: crate::logcat::VOICE, %err, %home, %user_id, "could not ask a home about a seat; dropping it");
            return false;
        }
    };
    if answer["held"].as_bool() != Some(true) {
        return false;
    }
    let cleared = sqlx::query(
        "UPDATE voice_states SET reclaim_until = NULL \
         WHERE guild_id = ? AND user_id = ? AND device_id = ? AND reclaim_until IS NOT NULL",
    )
    .bind(conversation_id)
    .bind(user_id)
    .bind(device_id)
    .execute(&state.pool)
    .await
    .map(|r| r.rows_affected())
    .unwrap_or(0);
    if cleared > 0 {
        tracing::info!(target: crate::logcat::VOICE, %user_id, %conversation_id, "a home vouched for a seat we were about to drop");
    }
    cleared > 0
}

async fn seat_held_here(state: &AppState, conversation_id: &str, user_id: &str, device_id: &str) -> bool {
    let row: Option<(String, Option<i64>)> = sqlx::query_as(
        "SELECT device_id, reclaim_until FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or_default();
    let Some((held_device, reclaim_until)) = row else { return false };
    if held_device != device_id {
        return false;
    }
    reclaim_until.is_some() || state.hub.device_live(user_id, device_id).await
}

pub async fn announce_departure(state: &AppState, conversation_id: &str, user_id: &str) {
    let Ok(sequencer) = sequencer_of(state, conversation_id).await else { return };
    if sequencer == state.cfg.server_name {
        fanout(
            state,
            conversation_id,
            "VOICE_STATE_UPDATE",
            json!({
                "conversation_id": conversation_id, "user_id": user_id,
                "channel_id": Value::Null,
            }),
        )
        .await;
        if let Ok(Some(call)) = current_call(state, conversation_id).await {
            if call.is_sfu() && call.host.as_deref() == Some(state.cfg.server_name.as_str()) {
                voice::sfu_control(
                    state,
                    conversation_id,
                    conversation_id,
                    json!({ "command": "disconnect", "user_id": user_id }),
                )
                .await;
            }
        }
        if let Err(err) = settle(state, conversation_id).await {
            tracing::warn!(target: crate::logcat::VOICE, %err, %conversation_id, "could not settle a call after a departure");
        }
        return;
    }
    let body = json!({
        "conversation_id": conversation_id, "op": "leave", "user_id": user_id,
    });
    if let Err(err) = federation::post_signed(state, &sequencer, ROSTER_PATH, &body).await {
        tracing::warn!(target: crate::logcat::VOICE, %err, %conversation_id, %user_id, "could not hand back a call");
    }
}

fn mesh_server(state: &AppState, conversation_id: &str, user_id: &str, generation: i64) -> Value {
    let turn = relay_turn(state);
    json!({
        "mode": "mesh",
        "channel_id": conversation_id,
        "conversation_id": conversation_id,
        "generation": generation,
        "host": Value::Null,
        "max_participants": state.cfg.voice.mesh_max_participants,
        "max_bitrate": state.cfg.voice.max_bitrate,
        "relay": turn.is_some(),
        "ice_servers": voice::ice_servers(state, turn.as_deref(), user_id),
        "note": "peer-to-peer; each client pins itself to relays if its own posture asks",
    })
}

async fn grant(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    device_id: &str,
    host: &str,
) -> ApiResult<Value> {
    let voice_cfg = &state.cfg.voice;
    if !voice_cfg.enabled {
        return Err(ApiError::Forbidden("this server does not host voice".into()));
    }
    let sequencer = sequencer_of(state, conversation_id).await?;
    if sequencer == state.cfg.server_name {
        let seated: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM voice_states WHERE guild_id = ? AND user_id = ?",
        )
        .bind(conversation_id)
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
        if seated == 0 {
            return Err(ApiError::Forbidden("that account is not in this call".into()));
        }
    }
    let (endpoint, region, pubkey_hint, turn) = if host == CUSTOM {
        if sequencer != state.cfg.server_name {
            return Err(ApiError::Conflict(format!(
                "a conversation's own SFU is vouched for by its sequencer, {sequencer}"
            )));
        }
        (Value::Null, CUSTOM.to_string(), Value::Null, None)
    } else {
        if host != state.cfg.server_name {
            return Err(ApiError::Conflict(format!("this call is hosted by {host}")));
        }
        let region = voice::resolve_region(state, conversation_id, "auto")
            .await
            .ok_or_else(|| ApiError::Conflict("this server has no SFU to host a call on".into()))?;
        (json!(region.sfu()), region.name, json!(region.pubkey_hint), region.turn)
    };

    let now = now_ms();
    let claims = json!({
        "kind": "sfu_join",
        "room_kind": "conversation",
        "guild": conversation_id,
        "channel": conversation_id,
        "user_id": user_id,
        "device_id": device_id,
        "session_id": ulid(),
        "origin": state.cfg.server_name,
        "region": region,
        "max_bitrate": voice_cfg.max_bitrate,
        "e2ee": true,
        "flags": { "speak": true, "video": true, "stream": true, "priority": false },
        "issued_at": now,
        "expires_at": now + voice_cfg.token_ttl_secs * 1000,
    });
    let signed = crate::crypto::sign_json(&state.key, claims);
    Ok(json!({
        "token": crate::util::b64(signed.to_string().as_bytes()),
        "token_ttl": voice_cfg.token_ttl_secs,
        "endpoint": endpoint,
        "region": region,
        "pubkey_hint": pubkey_hint,
        "max_bitrate": voice_cfg.max_bitrate,
        "ice_servers": voice::ice_servers(state, turn.as_deref(), user_id),
    }))
}

async fn voice_server(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
    device_id: &str,
    call: &Call,
) -> ApiResult<Value> {
    if !call.is_sfu() {
        return Ok(mesh_server(state, conversation_id, user_id, call.generation));
    }
    let host = call.host.clone().unwrap_or_default();
    let custom = host == CUSTOM;
    let minter = if custom { sequencer_of(state, conversation_id).await? } else { host.clone() };
    let grant = if minter == state.cfg.server_name {
        grant(state, conversation_id, user_id, device_id, &host).await?
    } else {
        let body = json!({
            "conversation_id": conversation_id, "user_id": user_id,
            "device_id": device_id, "host": host,
        });
        federation::post_signed(state, &minter, TOKEN_PATH, &body).await?
    };
    let ice_servers = if custom {
        voice::ice_servers(state, relay_turn(state).as_deref(), user_id)
    } else {
        grant["ice_servers"].clone()
    };
    Ok(json!({
        "mode": "sfu",
        "channel_id": conversation_id,
        "conversation_id": conversation_id,
        "generation": call.generation,
        "host": host,
        "custom": custom,
        "endpoint": grant["endpoint"],
        "region": grant["region"],
        "pubkey_hint": grant["pubkey_hint"],
        "token": grant["token"],
        "token_ttl": grant["token_ttl"],
        "max_bitrate": grant["max_bitrate"],
        "ice_servers": ice_servers,
        "relay": relay_turn(state).is_some(),
        "e2ee": "required",
    }))
}

async fn call_of(state: &AppState, conversation_id: &str, user_id: &str) -> ApiResult<Call> {
    let sequencer = sequencer_of(state, conversation_id).await?;
    if sequencer == state.cfg.server_name {
        return Ok(current_call(state, conversation_id).await?.unwrap_or_else(Call::mesh));
    }
    let body = json!({ "conversation_id": conversation_id, "op": "call", "user_id": user_id });
    let answer = federation::post_signed(state, &sequencer, ROSTER_PATH, &body).await?;
    Ok(Call::from_json(&answer))
}

pub async fn states(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if !may_receive_dm_interaction(&state, &id, &auth.user_id).await? {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let sequencer = sequencer_of(&state, &id).await?;
    if sequencer == state.cfg.server_name {
        return Ok(Json(roster(&state, &id).await?));
    }
    let body = json!({ "conversation_id": id, "op": "list", "user_id": auth.user_id });
    Ok(Json(federation::post_signed(&state, &sequencer, ROSTER_PATH, &body).await?))
}

pub async fn join(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(mut req): Json<ConvJoin>,
) -> ApiResult<Json<Value>> {
    if !state.cfg.voice.enabled {
        return Err(ApiError::Forbidden("this server does not host voice".into()));
    }
    require_member(&state, &id, &auth.user_id).await?;
    if !may_receive_dm_interaction(&state, &id, &auth.user_id).await? {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let sequencer = sequencer_of(&state, &id).await?;
    req.home_sfu = hosts_sfu(&state);

    let (voice_state, call) = if sequencer == state.cfg.server_name {
        admit(&state, &id, &auth.user_id, &auth.device_id, &req).await?
    } else {
        let body = json!({
            "conversation_id": id, "op": "join", "user_id": auth.user_id,
            "device_id": auth.device_id, "join": {
                "self_mute": req.join.self_mute, "self_deaf": req.join.self_deaf,
                "self_video": req.join.self_video, "wants_sfu": req.wants_sfu,
                "custom_sfu": req.custom_sfu, "home_sfu": req.home_sfu,
            },
        });
        let answer = federation::post_signed(&state, &sequencer, ROSTER_PATH, &body).await?;
        let granted = answer
            .get("voice_state")
            .unwrap_or(&answer)
            .get("session_id")
            .and_then(Value::as_str);
        upsert_row(&state, &id, &auth.user_id, &auth.device_id, &req, granted).await?;
        match answer.get("voice_state") {
            Some(voice_state) => (voice_state.clone(), Call::from_json(&answer["call"])),
            None => (answer, Call::mesh()),
        }
    };

    match voice_server(&state, &id, &auth.user_id, &auth.device_id, &call).await {
        Ok(voice_server) => Ok(Json(json!({ "voice_state": voice_state, "voice_server": voice_server }))),
        Err(err) => {
            voice::disconnect(&state, &id, &auth.user_id).await?;
            Err(err)
        }
    }
}

pub async fn server(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if !may_receive_dm_interaction(&state, &id, &auth.user_id).await? {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let held: Option<String> = sqlx::query_scalar(
        "SELECT device_id FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    if held.is_none() {
        return Err(ApiError::Forbidden("you are not connected to this call".into()));
    }
    let call = call_of(&state, &id, &auth.user_id).await?;
    Ok(Json(json!({
        "voice_server": voice_server(&state, &id, &auth.user_id, &auth.device_id, &call).await?,
    })))
}

pub async fn leave(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let held: Option<String> = sqlx::query_scalar(
        "SELECT channel_id FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    voice::disconnect(&state, &id, &auth.user_id).await?;
    if held.is_none() {
        announce_departure(&state, &id, &auth.user_id).await;
    }
    Ok(Json(json!({ "ok": true })))
}

pub async fn update_state(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<Patch>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if !may_receive_dm_interaction(&state, &id, &auth.user_id).await? {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let sequencer = sequencer_of(&state, &id).await?;
    if sequencer == state.cfg.server_name {
        return Ok(Json(amend(&state, &id, &auth.user_id, &req).await?));
    }
    voice::apply_state(&state, &id, &auth.user_id, &req.flags).await?;
    let body = json!({
        "conversation_id": id, "op": "state", "user_id": auth.user_id,
        "patch": { "self_mute": req.flags.self_mute, "self_deaf": req.flags.self_deaf,
                   "self_video": req.flags.self_video, "streaming": req.streaming,
                   "wants_sfu": req.wants_sfu, "custom_sfu": req.custom_sfu },
    });
    Ok(Json(federation::post_signed(&state, &sequencer, ROSTER_PATH, &body).await?))
}

pub async fn signal(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<Signal>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    require_member(&state, &id, &req.target).await?;
    if !may_receive_dm_interaction(&state, &id, &auth.user_id).await? {
        return Err(ApiError::NotFound("no such conversation".into()));
    }
    let connected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&id)
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    if connected == 0 {
        return Err(ApiError::Forbidden("you are not connected to this call".into()));
    }

    let data = json!({
        "channel_id": id, "conversation_id": id, "from": auth.user_id, "payload": req.payload,
    });
    let home = home_of(&req.target)?;
    if home == state.cfg.server_name {
        if may_receive_dm_interaction(&state, &id, &req.target).await? {
            state
                .hub
                .publish_user(&req.target, Event::to_account("VOICE_SIGNAL", &req.target, data))
                .await;
        }
    } else {
        notify(&state, &home, &id, "VOICE_SIGNAL", &data, Some(&req.target)).await;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RosterOp {
    pub conversation_id: String,
    pub op: String,
    pub user_id: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub join: ConvJoin,
    #[serde(default)]
    pub patch: Patch,
}

pub async fn inbound_roster(
    State(state): State<AppState>,
    fed: Fed<RosterOp>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;

    // Reversed direction: answered before the sequencer/home guards below.
    if req.op == "held" {
        let sequencer = sequencer_of(&state, &req.conversation_id).await?;
        if sequencer != fed.origin {
            return Err(ApiError::Forbidden("this conversation is not yours to sequence".into()));
        }
        if home_of(&req.user_id)? != state.cfg.server_name {
            return Err(ApiError::Forbidden("that account is not homed here".into()));
        }
        let held = seat_held_here(&state, &req.conversation_id, &req.user_id, &req.device_id).await;
        return Ok(Json(json!({ "held": held })));
    }

    let sequencer = sequencer_of(&state, &req.conversation_id).await?;
    if sequencer != state.cfg.server_name {
        return Err(ApiError::Conflict(format!(
            "this conversation is sequenced by {sequencer}"
        )));
    }
    if home_of(&req.user_id)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    require_member(&state, &req.conversation_id, &req.user_id).await?;

    match req.op.as_str() {
        "join" => {
            let (voice_state, call) =
                admit(&state, &req.conversation_id, &req.user_id, &req.device_id, &req.join).await?;
            Ok(Json(json!({ "voice_state": voice_state, "call": call.json(&state) })))
        }
        "state" => Ok(Json(
            amend(&state, &req.conversation_id, &req.user_id, &req.patch).await?,
        )),
        "leave" => {
            voice::disconnect(&state, &req.conversation_id, &req.user_id).await?;
            Ok(Json(json!({ "ok": true })))
        }
        "list" => Ok(Json(roster(&state, &req.conversation_id).await?)),
        "call" => {
            let call = current_call(&state, &req.conversation_id).await?.unwrap_or_else(Call::mesh);
            Ok(Json(call.json(&state)))
        }
        other => Err(ApiError::BadRequest(format!("unknown roster op {other}"))),
    }
}

#[derive(Deserialize)]
pub struct TokenRequest {
    pub conversation_id: String,
    pub user_id: String,
    #[serde(default)]
    pub device_id: String,
    pub host: String,
}

pub async fn inbound_token(
    State(state): State<AppState>,
    fed: Fed<TokenRequest>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&req.user_id)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    require_member(&state, &req.conversation_id, &req.user_id).await?;
    Ok(Json(grant(&state, &req.conversation_id, &req.user_id, &req.device_id, &req.host).await?))
}

#[derive(Deserialize)]
pub struct Notice {
    pub conversation_id: String,
    pub t: String,
    pub data: Value,
    #[serde(default)]
    pub target: Option<String>,
}

pub async fn inbound_notify(
    State(state): State<AppState>,
    fed: Fed<Notice>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;

    if req.t == "INCOMING_CALL" {
        let sequencer = sequencer_of(&state, &req.conversation_id).await?;
        if sequencer != fed.origin {
            return Err(ApiError::Forbidden("incoming-call notice is not from the sequencer".into()));
        }
        let caller = req.data["caller"].as_str().unwrap_or_default();
        let source_id = req.data["source_id"].as_str().unwrap_or_default();
        let created_at = req.data["created_at"].as_i64().unwrap_or_default();
        if caller.is_empty() || source_id != incoming_call_source_id(&req.conversation_id, created_at) {
            return Err(ApiError::BadRequest("incoming-call notice is malformed".into()));
        }
        require_member(&state, &req.conversation_id, caller).await?;
        let members: Vec<(String, String)> = sqlx::query_as(
            "SELECT user_id, home_domain FROM conversation_members \
             WHERE conversation_id = ? AND home_domain = ? AND state = 'active'",
        )
        .bind(&req.conversation_id).bind(&state.cfg.server_name).fetch_all(&state.pool).await?;
        let (locals, _) = incoming_call_routes(members, caller, &state.cfg.server_name);
        for recipient in locals {
            enqueue_local_incoming_call(
                &state, &fed.origin, &req.conversation_id, caller, &recipient, source_id, created_at,
            ).await?;
        }
        return Ok(Json(json!({ "ok": true })));
    }

    let t: &'static str = match req.t.as_str() {
        "VOICE_STATE_UPDATE" => "VOICE_STATE_UPDATE",
        "VOICE_SERVER_UPDATE" => "VOICE_SERVER_UPDATE",
        "VOICE_SIGNAL" => "VOICE_SIGNAL",
        other => return Err(ApiError::BadRequest(format!("unknown call event {other}"))),
    };

    if let Some(target) = req.target {
        if t != "VOICE_SIGNAL" {
            return Err(ApiError::BadRequest("only a signal is addressed to one person".into()));
        }
        let from = req.data["from"].as_str().unwrap_or_default();
        if from.is_empty() || home_of(from)? != fed.origin {
            return Err(ApiError::Forbidden("that is not your account to speak for".into()));
        }
        require_member(&state, &req.conversation_id, &target).await?;
        if may_receive_dm_interaction(&state, &req.conversation_id, &target).await? {
            state.hub.publish_user(&target, Event::to_account(t, &target, req.data)).await;
        }
        return Ok(Json(json!({ "ok": true })));
    }

    let sequencer = sequencer_of(&state, &req.conversation_id).await?;
    if sequencer != fed.origin {
        return Err(ApiError::Forbidden("the roster is not yours to report".into()));
    }
    let departed = t == "VOICE_STATE_UPDATE" && req.data.get("channel_id").is_some_and(Value::is_null);
    let subject = req.data["user_id"].as_str().unwrap_or_default().to_string();

    let members: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM conversation_members \
         WHERE conversation_id = ? AND home_domain = ? AND state = 'active'",
    )
    .bind(&req.conversation_id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await?;
    for user_id in &members {
        if may_receive_dm_interaction(&state, &req.conversation_id, user_id).await? {
            state
                .hub
                .publish_user(user_id, Event::to_account(t, user_id, req.data.clone()))
                .await;
        }
    }
    if departed && members.contains(&subject) {
        forget_locally(&state, &req.conversation_id, &subject).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seat(user_id: &str, wants_sfu: bool, home_sfu: bool, custom_sfu: bool) -> Seat {
        Seat { user_id: user_id.into(), wants_sfu, home_sfu, custom_sfu }
    }

    #[tokio::test]
    async fn connected_device_does_not_discard_unacknowledged_call() {
        let dir = std::env::temp_dir().join(format!("telium-call-handoff-{}", ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = crate::config::Config {
            server_name: "home.test".into(),
            database_url: format!("sqlite://{}/test.db?mode=rwc", dir.display()),
            media_dir: dir.join("media"),
            ..Default::default()
        };
        cfg.backup.enabled = false;
        cfg.archive.dir = dir.join("cold");
        let state = crate::build_state(cfg).await.unwrap();
        state.hub.device_opened("@bob:home.test", "phone").await;
        sqlx::query(
            "INSERT INTO notification_inbox \
             (id, user_id, device_id, origin, source_id, kind, ciphertext, created_at, expires_at) \
             VALUES ('row', '@bob:home.test', 'phone', 'home.test', 'call', 'incoming_call', '{}', ?, ?)",
        )
        .bind(now_ms()).bind(now_ms() + 60_000)
        .execute(&state.pool).await.unwrap();
        wake_incoming_call_device(&state, "@bob:home.test", "phone", "home.test", "call").await;
        tokio::time::sleep(std::time::Duration::from_millis(3300)).await;
        let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_inbox WHERE id = 'row'")
            .fetch_one(&state.pool).await.unwrap();
        state.pool.close().await;
        let _ = std::fs::remove_dir_all(dir);
        assert_eq!(pending, 1, "socket presence is not a notification acknowledgement");
    }

    #[test]
    fn incoming_call_routes_exclude_caller_and_deduplicate_remote_homes() {
        let members = vec![
            ("@caller:a.test".into(), "a.test".into()),
            ("@local:a.test".into(), "a.test".into()),
            ("@remote1:b.test".into(), "b.test".into()),
            ("@remote2:b.test".into(), "b.test".into()),
        ];
        let (local, remotes) = incoming_call_routes(members, "@caller:a.test", "a.test");
        assert_eq!(local, vec!["@local:a.test"]);
        assert_eq!(remotes, vec!["b.test"]);
    }

    #[test]
    fn incoming_call_source_id_is_stable_for_one_call_start() {
        let first = incoming_call_source_id("conversation-1", 1_700_000_000_000);
        assert_eq!(first, incoming_call_source_id("conversation-1", 1_700_000_000_000));
        assert_ne!(first, incoming_call_source_id("conversation-1", 1_700_000_000_001));
        assert_ne!(first, incoming_call_source_id("conversation-2", 1_700_000_000_000));
    }

    #[test]
    fn a_small_call_stays_a_mesh_even_when_an_sfu_is_on_offer() {
        let seats = vec![seat("@a:a.test", false, true, false), seat("@b:b.test", false, false, false)];
        let call = decide(4, &seats, pick_host("a.test", true, &seats), None).unwrap();
        assert_eq!(call.mode, "mesh");
    }

    #[test]
    fn one_participant_asking_moves_the_call_onto_an_sfu() {
        let seats = vec![seat("@a:a.test", false, false, false), seat("@b:b.test", true, false, false)];
        let call = decide(4, &seats, pick_host("a.test", true, &seats), None).unwrap();
        assert_eq!((call.mode.as_str(), call.host.as_deref(), call.generation), ("sfu", Some("a.test"), 1));
    }

    #[test]
    fn outgrowing_the_mesh_needs_somewhere_to_go() {
        let seats: Vec<Seat> = (0..5).map(|i| seat(&format!("@u{i}:a.test"), false, false, false)).collect();
        assert!(decide(4, &seats, pick_host("a.test", false, &seats), None).is_none());
        let call = decide(4, &seats, pick_host("a.test", true, &seats), None).unwrap();
        assert_eq!(call.mode, "sfu");
    }

    #[test]
    fn the_host_is_the_conversations_own_then_the_sequencers_then_the_first_home() {
        let plain = vec![seat("@z:z.test", false, true, false), seat("@m:m.test", false, true, false)];
        assert_eq!(pick_host("a.test", false, &plain).as_deref(), Some("m.test"));
        assert_eq!(pick_host("a.test", true, &plain).as_deref(), Some("a.test"));
        let custom = vec![seat("@z:z.test", false, false, true)];
        assert_eq!(pick_host("a.test", true, &custom).as_deref(), Some(CUSTOM));
        let none = vec![seat("@z:z.test", true, false, false)];
        assert_eq!(pick_host("a.test", false, &none), None);
    }

    #[test]
    fn an_sfu_call_stays_on_its_sfu_until_it_empties() {
        let current = Call { mode: "sfu".into(), host: Some("a.test".into()), generation: 1 };
        let seats = vec![seat("@a:a.test", false, false, false)];
        assert_eq!(decide(4, &seats, None, Some(&current)), Some(current.clone()));
    }

    #[test]
    fn nobody_asking_for_an_sfu_that_does_not_exist_leaves_a_mesh() {
        let seats = vec![seat("@a:a.test", true, false, false)];
        let call = decide(4, &seats, None, None).unwrap();
        assert_eq!(call.mode, "mesh");
    }
}
