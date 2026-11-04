
use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_VOICE_STATES};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::Sha1;

mod e2ee;
mod failover;

pub use e2ee::*;
pub use failover::report_relay_full;

#[derive(Clone)]
pub(crate) struct Region {
    pub(crate) name: String,
    sfu: String,
    pub(crate) turn: Option<String>,
    pub(crate) pubkey_hint: Option<String>,
}

impl Region {
    pub(crate) fn new(
        name: String,
        sfu: &str,
        turn: Option<String>,
        pubkey_hint: Option<String>,
    ) -> Option<Self> {
        let sfu = sfu.trim();
        if sfu.is_empty() {
            return None;
        }
        Some(Self { name, sfu: sfu.to_string(), turn, pubkey_hint })
    }

    pub(crate) fn sfu(&self) -> &str {
        &self.sfu
    }
}

pub(crate) async fn resolve_region(state: &AppState, guild_id: &str, requested: &str) -> Option<Region> {
    let cfg = &state.cfg.voice;
    let guild_rows: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT name, sfu, turn, pubkey_hint FROM guild_voice_regions WHERE guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let unhealthy: std::collections::HashSet<String> =
        sqlx::query_scalar::<_, String>("SELECT region FROM sfu_health WHERE healthy = 0")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect();

    struct Cand {
        region: Region,
        health_key: String,
    }
    let mut cands: Vec<Cand> = Vec::new();
    for r in &cfg.regions {
        if let Some(region) =
            Region::new(r.name.clone(), &r.sfu, r.turn.clone(), r.pubkey_hint.clone())
        {
            cands.push(Cand { region, health_key: r.name.clone() });
        }
    }
    for (name, sfu, turn, pk) in &guild_rows {
        if let Some(region) = Region::new(name.clone(), sfu, turn.clone(), pk.clone()) {
            cands.push(Cand { region, health_key: format!("g{guild_id}/{name}") });
        }
    }

    let healthy = |c: &Cand| !unhealthy.contains(&c.health_key);

    if !(requested.is_empty() || requested == "auto") {
        if let Some(c) = cands.iter().find(|c| c.region.name == requested && healthy(c)) {
            return Some(c.region.clone());
        }
    }

    // The directory answers only when the pool is empty: an operator or guild
    // owner who configured regions gets exactly the regions they configured,
    // and the directory fills the void, never overrides it.
    if cands.is_empty() {
        return directory_region(state, guild_id, requested, &unhealthy).await;
    }

    let guild_default: Option<String> = sqlx::query_scalar(
        "SELECT name FROM guild_voice_regions WHERE guild_id = ? AND is_default = 1 LIMIT 1",
    )
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await
    .unwrap_or_default();
    if let Some(d) = &guild_default {
        if let Some(c) = cands.iter().find(|c| &c.region.name == d && healthy(c)) {
            return Some(c.region.clone());
        }
    }
    if let Some(c) = cands
        .iter()
        .find(|c| c.region.name == cfg.default_region && healthy(c))
    {
        return Some(c.region.clone());
    }
    if let Some(c) = cands.iter().find(|c| healthy(c)) {
        return Some(c.region.clone());
    }
    cands.into_iter().next().map(|c| c.region)
}

/// A guild's voice relay mode, from its settings blob: `automatic` (the
/// default) lets the public directory fill a guild whose server and owner
/// configured no regions, `fixed` confines calls to the regions that were
/// configured, `direct` declines directory relays entirely -- an explicit
/// choice to keep calls out of anyone else's infrastructure. Configured
/// regions survive every mode; only the directory is optional.
pub(crate) async fn guild_voice_mode(state: &AppState, guild_id: &str) -> &'static str {
    let settings: Option<String> = sqlx::query_scalar("SELECT settings FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let Some(settings) = settings else { return "automatic" };
    let mode = serde_json::from_str::<Value>(&settings)
        .ok()
        .and_then(|v| v.get("voice_mode").and_then(Value::as_str).map(str::to_owned));
    match mode.as_deref() {
        Some("fixed") => "fixed",
        Some("direct") => "direct",
        _ => "automatic",
    }
}

/// The automatic directory pick: one qualifying relay for this guild and hour.
///
/// Weighted by the publisher's recommendation weight and rotated hourly per
/// guild, so load spreads across relays and hours while staying stable long
/// enough for a call's members to converge on the same relay and pin to it.
/// There is no background probing here: a relay the server has measured as
/// down is skipped, and an unmeasured one is trusted until the relay's own
/// admission check says otherwise.
async fn directory_region(
    state: &AppState,
    guild_id: &str,
    requested: &str,
    unhealthy: &std::collections::HashSet<String>,
) -> Option<Region> {
    if guild_voice_mode(state, guild_id).await != "automatic" {
        return None;
    }
    let relays = crate::sfu_directory::relays(state).await.unwrap_or_default();
    if relays.is_empty() {
        return None;
    }
    let alive: Vec<&crate::sfu_directory::Relay> = relays
        .iter()
        .filter(|r| !unhealthy.contains(&crate::sfu_directory::health_key(&r.url)))
        .collect();
    if alive.is_empty() {
        return None;
    }
    // An explicit request -- the relay a call already pinned, followed by late
    // joiners -- is honoured only when it names a listed relay.
    if !(requested.is_empty() || requested == "auto") {
        if let Some(r) = alive.iter().find(|r| r.url == requested) {
            return directory_relay_region(r);
        }
    }
    let hour = (now_ms() / 3_600_000) as u64;
    let seed = blake3::hash(format!("{guild_id}|{hour}").as_bytes()).to_hex();
    let offset = u64::from_str_radix(&seed[..16], 16).unwrap_or(0);
    let total: u64 = alive.iter().map(|r| r.weight.max(1) as u64).sum();
    let mut point = offset % total.max(1);
    for r in &alive {
        let w = r.weight.max(1) as u64;
        if point < w {
            return directory_relay_region(r);
        }
        point -= w;
    }
    alive.first().and_then(|r| directory_relay_region(r))
}

/// The relay's URL is the region name, so `voice_states` round-trips the
/// pinned relay through every later join's `requested`.
fn directory_relay_region(relay: &crate::sfu_directory::Relay) -> Option<Region> {
    Region::new(relay.url.clone(), &relay.url, None, relay.pubkey_hint.clone())
}

fn turn_credentials(secret: &str, user_id: &str, ttl_secs: i64) -> Value {
    let expiry = now_ms() / 1000 + ttl_secs;
    let username = format!("{expiry}:{user_id}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("hmac takes any key size");
    mac.update(username.as_bytes());
    let password = crate::util::b64(&mac.finalize().into_bytes());
    json!({ "username": username, "credential": password, "ttl": ttl_secs })
}

struct VoiceContext {
    channel_id: String,
    guild_id: String,
    permissions: u64,
    region: String,
    bitrate: i64,
}

async fn voice_channel(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
) -> ApiResult<VoiceContext> {
    let (ch, _m, permissions) =
        guildstore::require_channel_perm(state, channel_id, user_id, perms::CONNECT).await?;
    if ch.kind != "voice" {
        return Err(ApiError::BadRequest("that channel is not a voice channel".into()));
    }
    guildstore::ensure_authoritative(state, &ch.guild_id).await?;
    let row: (String, Option<i64>) =
        sqlx::query_as("SELECT voice_region, bitrate FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_one(&state.pool)
            .await?;
    let ceiling = state.cfg.voice.max_bitrate;
    Ok(VoiceContext {
        channel_id: ch.id,
        guild_id: ch.guild_id,
        permissions,
        region: row.0,
        bitrate: row.1.unwrap_or(ceiling).min(ceiling),
    })
}

fn mint_token(state: &AppState, ctx: &VoiceContext, auth: &GuildAuth, session_id: &str, muted: bool) -> String {
    let now = now_ms();
    let p = ctx.permissions;
    let claims = json!({
        "kind": "sfu_join",
        "guild": ctx.guild_id,
        "channel": ctx.channel_id,
        "user_id": auth.user_id,
        "device_id": auth.device_id,
        "session_id": session_id,
        "origin": state.cfg.server_name,
        "region": ctx.region,
        "max_bitrate": ctx.bitrate,
        "e2ee": true,
        "flags": {
            "speak": perms::has(p, perms::SPEAK) && !muted,
            "video": perms::has(p, perms::VIDEO),
            "stream": perms::has(p, perms::STREAM),
            "priority": perms::has(p, perms::PRIORITY_SPEAKER),
        },
        "issued_at": now,
        "expires_at": now + state.cfg.voice.token_ttl_secs * 1000,
    });
    let signed = crate::crypto::sign_json(&state.key, claims);
    crate::util::b64(signed.to_string().as_bytes())
}

async fn server_flags(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<(bool, bool)> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT server_mute, server_deaf FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|(m, d)| (m != 0, d != 0)).unwrap_or((false, false)))
}

pub async fn voice_state_json(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, i64, i64, i64, i64, Option<String>, i64, i64, i64, i64)> =
        sqlx::query_as(
            "SELECT channel_id, session_id, region, self_mute, self_deaf, self_video, streaming, \
             stream_preset, server_mute, server_deaf, joined_at, e2ee_member \
             FROM voice_states WHERE guild_id = ? AND user_id = ?",
        )
        .bind(guild_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some((channel_id, session_id, region, sm, sd, sv, streaming, preset, gm, gd, joined_at, member)) =
        row
    else {
        return Ok(json!({ "user_id": user_id, "channel_id": Value::Null }));
    };
    Ok(json!({
        "guild_id": guild_id, "user_id": user_id, "channel_id": channel_id,
        "session_id": session_id, "region": region,
        "self_mute": sm != 0, "self_deaf": sd != 0, "self_video": sv != 0,
        "streaming": streaming != 0, "stream_preset": preset,
        "server_mute": gm != 0, "server_deaf": gd != 0, "joined_at": joined_at,
        "e2ee_member": member != 0,
    }))
}

async fn publish_state(state: &AppState, guild_id: &str, channel_id: &str, user_id: &str) -> ApiResult<Value> {
    let payload = voice_state_json(state, guild_id, user_id).await?;
    state
        .hub
        .publish(Event::in_channel(
            "VOICE_STATE_UPDATE",
            guild_id,
            channel_id,
            INTENT_GUILD_VOICE_STATES,
            payload.clone(),
        ))
        .await;
    Ok(payload)
}

async fn publish_watchers(state: &AppState, guild_id: &str, channel_id: &str) -> ApiResult<()> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT viewer, streamer, quality FROM voice_watchers WHERE channel_id = ?",
    )
    .bind(channel_id)
    .fetch_all(&state.pool)
    .await?;
    state
        .hub
        .publish(Event::in_channel(
            "VOICE_WATCHERS_UPDATE",
            guild_id,
            channel_id,
            INTENT_GUILD_VOICE_STATES,
            json!({
                "guild_id": guild_id,
                "channel_id": channel_id,
                "watchers": rows
                    .into_iter()
                    .map(|(v, s, q)| json!({ "viewer": v, "streamer": s, "quality": q }))
                    .collect::<Vec<_>>(),
            }),
        ))
        .await;
    Ok(())
}

#[derive(Deserialize, Default)]
pub struct JoinRequest {
    #[serde(default)]
    pub self_mute: bool,
    #[serde(default)]
    pub self_deaf: bool,
    #[serde(default)]
    pub self_video: bool,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub key_package: Option<String>,
}

const MAX_KEY_PACKAGE: usize = 8 * 1024;

pub async fn join(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<JoinRequest>,
) -> ApiResult<Json<Value>> {
    if !state.cfg.voice.enabled {
        return Err(ApiError::Forbidden("this server does not host voice".into()));
    }
    let mut ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if let Some(r) = &req.region {
        ctx.region = r.clone();
    }

    let limit: i64 = sqlx::query_scalar("SELECT user_limit FROM channels WHERE id = ?")
        .bind(&channel_id)
        .fetch_one(&state.pool)
        .await?;
    if limit > 0 {
        let here: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND user_id != ?",
        )
        .bind(&channel_id)
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
        if here >= limit && !perms::has(ctx.permissions, perms::MOVE_MEMBERS) {
            return Err(ApiError::Conflict("this voice channel is full".into()));
        }
    }

    // A running channel always uses one pinned region, even when the relay
    // is no longer accepting *new calls*. Persist the actual resolved region
    // rather than "auto", or late joiners can split across different SFUs.
    let held: Option<String> = sqlx::query_scalar(
        "SELECT region FROM voice_states WHERE channel_id = ? AND region != 'auto' LIMIT 1",
    )
    .bind(&channel_id)
    .fetch_optional(&state.pool)
    .await?;
    let chosen = if let Some(held) = held {
        failover::pinned_region(&state, &ctx.guild_id, &held).await.map(|(r, _)| r)
            .or(resolve_region(&state, &ctx.guild_id, &ctx.region).await)
    } else {
        resolve_region(&state, &ctx.guild_id, &ctx.region).await
    };
    let sfu = chosen.is_some();
    ctx.region = chosen.map(|r| r.name).unwrap_or_else(|| "auto".into());
    let key_package = if sfu {
        match req.key_package.as_deref() {
            Some(p) if !p.is_empty() && p.len() <= MAX_KEY_PACKAGE => Some(p.to_string()),
            Some(_) => return Err(ApiError::BadRequest("key_package is not a KeyPackage".into())),
            None => {
                return Err(ApiError::BadRequest(
                    "calls in this channel are end-to-end encrypted, and this device did \
                     not offer the key it would need to join one"
                        .into(),
                ))
            }
        }
    } else {
        None
    };

    let (muted, deafened) = server_flags(&state, &ctx.guild_id, &auth.user_id).await?;
    let session_id = ulid();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO voice_states (guild_id, user_id, channel_id, device_id, session_id, region, \
         self_mute, self_deaf, self_video, server_mute, server_deaf, joined_at, updated_at, \
         e2ee_package, e2ee_offered_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, \
             device_id = excluded.device_id, session_id = excluded.session_id, \
             region = excluded.region, self_mute = excluded.self_mute, \
             self_deaf = excluded.self_deaf, self_video = excluded.self_video, \
             streaming = 0, stream_preset = NULL, updated_at = excluded.updated_at, \
             reclaim_until = NULL, e2ee_package = excluded.e2ee_package, e2ee_member = 0, \
             e2ee_offered_at = excluded.e2ee_offered_at, e2ee_refused = 0",
    )
    .bind(&ctx.guild_id)
    .bind(&auth.user_id)
    .bind(&channel_id)
    .bind(&auth.device_id)
    .bind(&session_id)
    .bind(&ctx.region)
    .bind(req.self_mute as i64)
    .bind(req.self_deaf as i64)
    .bind(req.self_video as i64)
    .bind(muted as i64)
    .bind(deafened as i64)
    .bind(now)
    .bind(now)
    .bind(&key_package)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let e2ee = if sfu {
        settle_group(&state, &ctx.guild_id, &channel_id, Some(&auth.user_id)).await?;
        Some(group_for(&state, &channel_id, &auth.user_id).await?)
    } else {
        None
    };

    let state_payload = publish_state(&state, &ctx.guild_id, &channel_id, &auth.user_id).await?;
    let server = server_update(&state, &ctx, &auth, &session_id, muted).await?;
    state
        .hub
        .publish(
            Event {
                t: "VOICE_SERVER_UPDATE",
                guild_id: ctx.guild_id.clone(),
                channel_id: Some(channel_id.clone()),
                intent: INTENT_GUILD_VOICE_STATES,
                only_user: Some(auth.user_id.clone()),
                data: server.clone(),
            }
            .into(),
        )
        .await;

    Ok(Json(json!({ "voice_state": state_payload, "voice_server": server, "e2ee": e2ee })))
}

async fn server_update(
    state: &AppState,
    ctx: &VoiceContext,
    auth: &GuildAuth,
    session_id: &str,
    muted: bool,
) -> ApiResult<Value> {
    let pinned = failover::pinned_region(state, &ctx.guild_id, &ctx.region).await.map(|(r, _)| r);
    let Some(region) = pinned.or(resolve_region(state, &ctx.guild_id, &ctx.region).await) else {
        let turn = crate::routes::dmvoice::relay_turn(state);
        return Ok(json!({
            "mode": "mesh",
            "channel_id": ctx.channel_id,
            "max_participants": state.cfg.voice.mesh_max_participants,
            "max_bitrate": ctx.bitrate,
            "relay": turn.is_some(),
            "ice_servers": ice_servers(state, turn.as_deref(), &auth.user_id),
            "note": "no SFU is configured; calls above the participant cap will not scale",
        }));
    };
    Ok(json!({
        "mode": "sfu",
        "channel_id": ctx.channel_id,
        "guild_id": ctx.guild_id,
        "region": region.name,
        "endpoint": region.sfu(),
        "pubkey_hint": region.pubkey_hint,
        "token": mint_token(state, ctx, auth, session_id, muted),
        "e2ee": "required",
        "token_ttl": state.cfg.voice.token_ttl_secs,
        "max_bitrate": ctx.bitrate,
        "ice_servers": ice_servers(state, region.turn.as_deref(), &auth.user_id),
    }))
}

pub(crate) fn ice_servers(state: &AppState, turn: Option<&str>, user_id: &str) -> Value {
    let mut servers = Vec::new();
    if !state.cfg.voice.stun_servers.is_empty() {
        servers.push(json!({ "urls": state.cfg.voice.stun_servers }));
    }
    if let (Some(turn), Some(secret)) = (turn, state.cfg.voice.turn_secret.as_deref()) {
        let creds = turn_credentials(secret, user_id, state.cfg.voice.turn_ttl_secs);
        servers.push(json!({
            "urls": [format!("turn:{turn}?transport=udp"), format!("turn:{turn}?transport=tcp")],
            "username": creds["username"], "credential": creds["credential"],
        }));
        servers.push(json!({ "urls": [format!("stun:{turn}")] }));
    }
    Value::Array(servers)
}

pub async fn refresh_token(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let mut ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    let (session_id, pinned): (String, String) = sqlx::query_as(
        "SELECT session_id, region FROM voice_states WHERE guild_id = ? AND user_id = ? AND channel_id = ?",
    )
    .bind(&ctx.guild_id)
    .bind(&auth.user_id)
    .bind(&channel_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| ApiError::Conflict("you are not connected to that channel".into()))?;
    ctx.region = pinned;
    let (muted, _) = server_flags(&state, &ctx.guild_id, &auth.user_id).await?;
    Ok(Json(server_update(&state, &ctx, &auth, &session_id, muted).await?))
}

#[derive(Deserialize, Default)]
pub struct StateUpdate {
    #[serde(default)]
    pub self_mute: Option<bool>,
    #[serde(default)]
    pub self_deaf: Option<bool>,
    #[serde(default)]
    pub self_video: Option<bool>,
}

pub async fn update_state(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<StateUpdate>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if req.self_video == Some(true) && !perms::has(ctx.permissions, perms::VIDEO) {
        return Err(crate::guildstore::missing_permission(perms::VIDEO));
    }
    apply_state(&state, &ctx.guild_id, &auth.user_id, &req).await?;
    Ok(Json(publish_state(&state, &ctx.guild_id, &channel_id, &auth.user_id).await?))
}

pub(crate) async fn apply_state(
    state: &AppState,
    room: &str,
    user_id: &str,
    req: &StateUpdate,
) -> ApiResult<()> {
    for (column, value) in [
        ("self_mute", req.self_mute),
        ("self_deaf", req.self_deaf),
        ("self_video", req.self_video),
    ] {
        let Some(v) = value else { continue };
        sqlx::query(&format!(
            "UPDATE voice_states SET {column} = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?"
        ))
        .bind(v as i64)
        .bind(now_ms())
        .bind(room)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

pub async fn leave(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let ch = guildstore::channel(&state, &channel_id).await?;
    disconnect(&state, &ch.guild_id, &auth.user_id).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn disconnect(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<()> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT channel_id, room_kind FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((channel_id, room_kind)) = row else { return Ok(()) };

    sqlx::query("DELETE FROM voice_states WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM voice_watchers WHERE viewer = ? OR streamer = ?")
        .bind(user_id)
        .bind(user_id)
        .execute(&state.pool)
        .await?;

    if room_kind == "dm" {
        crate::routes::dmvoice::announce_departure(state, guild_id, user_id).await;
        return Ok(());
    }

    sfu_control(state, guild_id, &channel_id, json!({ "command": "disconnect", "user_id": user_id })).await;
    if let Err(err) = settle_group(state, guild_id, &channel_id, None).await {
        tracing::warn!(target: crate::logcat::VOICE, %err, %user_id, %channel_id, "could not settle a call's group after a leave");
    }
    publish_watchers(state, guild_id, &channel_id).await?;
    state
        .hub
        .publish(Event::in_channel(
            "VOICE_STATE_UPDATE",
            guild_id,
            &channel_id,
            INTENT_GUILD_VOICE_STATES,
            json!({ "guild_id": guild_id, "user_id": user_id, "channel_id": Value::Null }),
        ))
        .await;
    Ok(())
}

pub async fn disconnect_device(state: &AppState, user_id: &str, device_id: &str) {
    let guilds: Vec<String> = sqlx::query_scalar(
        "SELECT guild_id FROM voice_states WHERE user_id = ? AND device_id = ?",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for guild_id in guilds {
        if let Err(err) = disconnect(state, &guild_id, user_id).await {
            tracing::warn!(target: crate::logcat::VOICE, %err, %user_id, %guild_id, "could not end an unattended call");
        }
    }
}

pub struct VoiceClaim {
    pub room_id: String,
    pub session_id: String,
}

impl VoiceClaim {
    fn from_json(v: &Value) -> Option<Self> {
        let room_id = v.get("room_id").and_then(Value::as_str)?;
        let session_id = v.get("session_id").and_then(Value::as_str)?;
        if room_id.is_empty() || session_id.is_empty() {
            return None;
        }
        Some(VoiceClaim { room_id: room_id.to_string(), session_id: session_id.to_string() })
    }

    pub fn list(d: &Value) -> Vec<VoiceClaim> {
        d.get("voice")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().filter_map(VoiceClaim::from_json).collect())
            .unwrap_or_default()
    }
}

pub async fn mark_unclaimed(
    pool: &sqlx::SqlitePool,
    grace_secs: u64,
) -> Result<(u64, u64), sqlx::Error> {
    let now = now_ms();
    let deadline = now + (grace_secs as i64) * 1000;

    let expired = sqlx::query(
        "DELETE FROM voice_states WHERE reclaim_until IS NOT NULL AND reclaim_until <= ?",
    )
    .bind(now)
    .execute(pool)
    .await?
    .rows_affected();
    sqlx::query("DELETE FROM voice_watchers WHERE reclaim_until IS NOT NULL AND reclaim_until <= ?")
        .bind(now)
        .execute(pool)
        .await?;

    let unclaimed = sqlx::query("UPDATE voice_states SET reclaim_until = ? WHERE reclaim_until IS NULL")
        .bind(deadline)
        .execute(pool)
        .await?
        .rows_affected();
    sqlx::query("UPDATE voice_watchers SET reclaim_until = ? WHERE reclaim_until IS NULL")
        .bind(deadline)
        .execute(pool)
        .await?;
    Ok((expired, unclaimed))
}

pub async fn reclaim(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    claims: &[VoiceClaim],
) -> Vec<String> {
    let mut kept = Vec::new();
    for claim in claims {
        let touched = sqlx::query(
            "UPDATE voice_states SET reclaim_until = NULL, updated_at = ? \
             WHERE guild_id = ? AND user_id = ? AND device_id = ? AND session_id = ?",
        )
        .bind(now_ms())
        .bind(&claim.room_id)
        .bind(user_id)
        .bind(device_id)
        .bind(&claim.session_id)
        .execute(&state.pool)
        .await
        .map(|r| r.rows_affected())
        .unwrap_or(0);
        if touched == 0 {
            continue;
        }
        let _ = sqlx::query(
            "UPDATE voice_watchers SET reclaim_until = NULL WHERE viewer = ? AND channel_id IN \
             (SELECT channel_id FROM voice_states WHERE guild_id = ? AND user_id = ?)",
        )
        .bind(user_id)
        .bind(&claim.room_id)
        .bind(user_id)
        .execute(&state.pool)
        .await;
        kept.push(claim.room_id.clone());
    }
    if !kept.is_empty() {
        tracing::info!(target: crate::logcat::VOICE, %user_id, %device_id, rooms = kept.len(), "a device reclaimed its calls");
    }
    kept
}

pub async fn sweep_unclaimed(state: &AppState) -> usize {
    let now = now_ms();
    let _ = sqlx::query(
        "DELETE FROM voice_watchers WHERE reclaim_until IS NOT NULL AND reclaim_until <= ?",
    )
    .bind(now)
    .execute(&state.pool)
    .await;

    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT guild_id, user_id, device_id, room_kind FROM voice_states \
         WHERE reclaim_until IS NOT NULL AND reclaim_until <= ?",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let mut swept = 0;
    for (room_id, user_id, device_id, room_kind) in rows {
        if room_kind == "dm"
            && crate::routes::dmvoice::remote_seat_still_held(state, &room_id, &user_id, &device_id)
                .await
        {
            continue;
        }
        if let Err(err) = disconnect(state, &room_id, &user_id).await {
            tracing::warn!(target: crate::logcat::VOICE, %err, %user_id, %room_id, "could not sweep an unclaimed call");
            continue;
        }
        swept += 1;
    }
    if swept > 0 {
        tracing::info!(target: crate::logcat::VOICE, swept, "swept calls nobody came back for");
    }
    swept
}

pub fn spawn_reclaim_sweeper(state: AppState) {
    tokio::spawn(async move {
        loop {
            let due: Option<i64> = sqlx::query_scalar(
                "SELECT MIN(reclaim_until) FROM ( \
                   SELECT reclaim_until FROM voice_states WHERE reclaim_until IS NOT NULL \
                   UNION ALL \
                   SELECT reclaim_until FROM voice_watchers WHERE reclaim_until IS NOT NULL)",
            )
            .fetch_one(&state.pool)
            .await
            .ok()
            .flatten();
            let Some(due) = due else { return };
            let now = now_ms();
            let wait = if due > now { (due - now) as u64 + 50 } else { 1_000 };
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            sweep_unclaimed(&state).await;
        }
    });
}

pub async fn channel_states(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    let users: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM voice_states WHERE channel_id = ?")
            .bind(&channel_id)
            .fetch_all(&state.pool)
            .await?;
    let mut states = Vec::new();
    for u in users {
        states.push(voice_state_json(&state, &ctx.guild_id, &u).await?);
    }
    let watchers: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT viewer, streamer, quality FROM voice_watchers WHERE channel_id = ?",
    )
    .bind(&channel_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "channel_id": channel_id,
        "voice_states": states,
        "watchers": watchers.into_iter()
            .map(|(v, s, q)| json!({ "viewer": v, "streamer": s, "quality": q }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct StreamRequest {
    pub enabled: bool,
    #[serde(default)]
    pub preset: Option<String>,
}

pub async fn set_stream(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<StreamRequest>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if req.enabled {
        if !perms::has(ctx.permissions, perms::STREAM) {
            return Err(crate::guildstore::missing_permission(perms::STREAM));
        }
        let live: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND streaming = 1 AND user_id != ?",
        )
        .bind(&channel_id)
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
        if live >= state.cfg.voice.max_streamers_per_channel {
            return Err(ApiError::Conflict(format!(
                "this channel allows {} concurrent streams",
                state.cfg.voice.max_streamers_per_channel
            )));
        }
    } else {
        sqlx::query("DELETE FROM voice_watchers WHERE channel_id = ? AND streamer = ?")
            .bind(&channel_id)
            .bind(&auth.user_id)
            .execute(&state.pool)
            .await?;
        publish_watchers(&state, &ctx.guild_id, &channel_id).await?;
    }

    sqlx::query(
        "UPDATE voice_states SET streaming = ?, stream_preset = ?, updated_at = ? \
         WHERE guild_id = ? AND user_id = ?",
    )
    .bind(req.enabled as i64)
    .bind(&req.preset)
    .bind(now_ms())
    .bind(&ctx.guild_id)
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;

    let payload = publish_state(&state, &ctx.guild_id, &channel_id, &auth.user_id).await?;
    Ok(Json(json!({ "voice_state": payload, "max_bitrate": ctx.bitrate })))
}

#[derive(Deserialize)]
pub struct WatchRequest {
    pub streamer: String,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default = "yes")]
    pub watching: bool,
}

fn yes() -> bool {
    true
}

pub async fn watch(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<WatchRequest>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if !req.watching {
        sqlx::query(
            "DELETE FROM voice_watchers WHERE channel_id = ? AND viewer = ? AND streamer = ?",
        )
        .bind(&channel_id)
        .bind(&auth.user_id)
        .bind(&req.streamer)
        .execute(&state.pool)
        .await?;
        sfu_control(
            &state,
            &ctx.guild_id,
            &channel_id,
            json!({ "command": "unsubscribe", "viewer": auth.user_id, "streamer": req.streamer }),
        )
        .await;
        publish_watchers(&state, &ctx.guild_id, &channel_id).await?;
        return Ok(Json(json!({ "watching": false })));
    }

    let streaming: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND user_id = ? AND streaming = 1",
    )
    .bind(&channel_id)
    .bind(&req.streamer)
    .fetch_one(&state.pool)
    .await?;
    if streaming == 0 {
        return Err(ApiError::NotFound("that member is not streaming".into()));
    }
    let quality = req.quality.unwrap_or_else(|| "auto".into());
    if !telium_protocol::is_watch_quality(&quality) {
        return Err(ApiError::BadRequest(format!(
            "quality must be one of {}",
            telium_protocol::WATCH_QUALITIES.join(", ")
        )));
    }
    sqlx::query(
        "INSERT INTO voice_watchers (channel_id, viewer, streamer, quality, started_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(channel_id, viewer, streamer) DO UPDATE SET quality = excluded.quality",
    )
    .bind(&channel_id)
    .bind(&auth.user_id)
    .bind(&req.streamer)
    .bind(&quality)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    sfu_control(
        &state,
        &ctx.guild_id,
        &channel_id,
        json!({
            "command": "subscribe", "viewer": auth.user_id,
            "streamer": req.streamer, "quality": quality, "guild": ctx.guild_id,
        }),
    )
    .await;
    publish_watchers(&state, &ctx.guild_id, &channel_id).await?;
    Ok(Json(json!({ "watching": true, "streamer": req.streamer, "quality": quality })))
}

#[derive(Deserialize)]
pub struct ModerateRequest {
    #[serde(default)]
    pub mute: Option<bool>,
    #[serde(default)]
    pub deaf: Option<bool>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub disconnect: bool,
}

pub async fn moderate(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
    Json(req): Json<ModerateRequest>,
) -> ApiResult<Json<Value>> {
    let mut actor = None;
    if req.mute.is_some() {
        actor = Some(
            guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MUTE_MEMBERS)
                .await?,
        );
    }
    if req.deaf.is_some() {
        actor = Some(
            guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::DEAFEN_MEMBERS)
                .await?,
        );
    }
    if req.disconnect && req.channel_id.is_some() {
        return Err(ApiError::BadRequest("choose a destination or disconnect, not both".into()));
    }
    if req.disconnect || req.channel_id.is_some() {
        actor = Some(
            guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MOVE_MEMBERS)
                .await?,
        );
    }

    // Apply the role hierarchy (outranks); MUTE_MEMBERS alone must not act on the owner.
    if let Some(actor) = &actor {
        crate::routes::guild::require_outranks(&state, &guild_id, actor, &user_id).await?;
    }

    let channel_id: Option<String> = sqlx::query_scalar(
        "SELECT channel_id FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&guild_id)
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(mute) = req.mute {
        sqlx::query(
            "UPDATE voice_states SET server_mute = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?",
        )
        .bind(mute as i64)
        .bind(now_ms())
        .bind(&guild_id)
        .bind(&user_id)
        .execute(&state.pool)
        .await?;
        if let Some(ch) = &channel_id {
            sfu_control(&state, &guild_id, ch, json!({ "command": "mute", "user_id": user_id, "mute": mute }))
                .await;
        }
    }
    if let Some(deaf) = req.deaf {
        sqlx::query(
            "UPDATE voice_states SET server_deaf = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?",
        )
        .bind(deaf as i64)
        .bind(now_ms())
        .bind(&guild_id)
        .bind(&user_id)
        .execute(&state.pool)
        .await?;
        if let Some(ch) = &channel_id {
            sfu_control(&state, &guild_id, ch, json!({ "command": "deafen", "user_id": user_id, "deaf": deaf }))
                .await;
        }
    }

    if let Some(destination) = &req.channel_id {
        let current = channel_id
            .as_ref()
            .ok_or_else(|| ApiError::NotFound("that member is not in voice".into()))?;
        let target = voice_channel(&state, destination, &user_id).await?;
        if target.guild_id != guild_id {
            return Err(ApiError::BadRequest("destination is in another guild".into()));
        }

        if current != destination {
            sfu_control(
                &state,
                &guild_id,
                current,
                json!({ "command": "disconnect", "user_id": user_id }),
            )
            .await;
            sqlx::query("DELETE FROM voice_watchers WHERE viewer = ? OR streamer = ?")
                .bind(&user_id)
                .bind(&user_id)
                .execute(&state.pool)
                .await?;
            publish_watchers(&state, &guild_id, current).await?;
            sqlx::query(
                "UPDATE voice_states SET channel_id = ?, region = ?, streaming = 0, \
                 stream_preset = NULL, e2ee_package = NULL, e2ee_member = 0, e2ee_refused = 0, \
                 updated_at = ? \
                 WHERE guild_id = ? AND user_id = ?",
            )
            .bind(destination)
            .bind(&target.region)
            .bind(now_ms())
            .bind(&guild_id)
            .bind(&user_id)
            .execute(&state.pool)
            .await?;

            settle_group(&state, &guild_id, current, None).await?;
            let payload = voice_state_json(&state, &guild_id, &user_id).await?;
            state.hub.publish(Event::in_channel(
                "VOICE_STATE_UPDATE",
                &guild_id,
                current,
                INTENT_GUILD_VOICE_STATES,
                payload.clone(),
            )).await;
            state.hub.publish(Event::in_channel(
                "VOICE_STATE_UPDATE",
                &guild_id,
                destination,
                INTENT_GUILD_VOICE_STATES,
                payload,
            )).await;
        }

        guildstore::audit(
            &state.pool,
            &guild_id,
            &auth.user_id,
            "voice_moderate",
            Some(&user_id),
            json!({
                "mute": req.mute, "deaf": req.deaf,
                "disconnect": false, "channel_id": destination,
            }),
        )
        .await?;
        return Ok(Json(json!({ "ok": true, "moved_to": destination })));
    }

    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "voice_moderate",
        Some(&user_id),
        json!({
            "mute": req.mute, "deaf": req.deaf,
            "disconnect": req.disconnect, "channel_id": Value::Null,
        }),
    )
    .await?;

    if req.disconnect {
        disconnect(&state, &guild_id, &user_id).await?;
        return Ok(Json(json!({ "ok": true, "disconnected": true })));
    }
    if let Some(ch) = &channel_id {
        publish_state(&state, &guild_id, ch, &user_id).await?;
    }
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn sfu_control(state: &AppState, guild_id: &str, channel_id: &str, command: Value) {
    let region: Option<String> = sqlx::query_scalar("SELECT voice_region FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
    let Some(region) = resolve_region(state, guild_id, region.as_deref().unwrap_or("auto")).await else {
        return;
    };
    let body = crate::crypto::sign_json(
        &state.key,
        json!({
            "origin": state.cfg.server_name,
            "guild": guild_id,
            "channel": channel_id,
            "issued_at": now_ms(),
            "command": command,
        }),
    );
    let url = format!("{}/control", region.sfu().trim_end_matches('/'));
    let result = state
        .http
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await;
    match result {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::warn!(target: crate::logcat::VOICE, url = %url, status = %r.status(), "sfu rejected a control command"),
        Err(e) => tracing::warn!(target: crate::logcat::VOICE, url = %url, error = %e, "sfu control command did not land"),
    }
}

pub async fn regions(State(state): State<AppState>, _auth: GuildAuth) -> ApiResult<Json<Value>> {
    let health: Vec<(String, i64, Option<i64>, i64)> =
        sqlx::query_as("SELECT region, healthy, latency_ms, checked_at FROM sfu_health")
            .fetch_all(&state.pool)
            .await?;
    let regions: Vec<Value> = state
        .cfg
        .voice
        .regions
        .iter()
        .map(|r| {
            let h = health.iter().find(|(name, _, _, _)| name == &r.name);
            json!({
                "name": r.name, "sfu": r.sfu, "turn": r.turn,
                "healthy": h.map(|(_, ok, _, _)| *ok != 0).unwrap_or(true),
                "latency_ms": h.and_then(|(_, _, l, _)| *l),
                "checked_at": h.map(|(_, _, _, c)| *c),
            })
        })
        .collect();
    Ok(Json(json!({
        "default": state.cfg.voice.default_region,
        "regions": regions,
        "mesh_max_participants": state.cfg.voice.mesh_max_participants,
        "max_bitrate": state.cfg.voice.max_bitrate,
    })))
}

#[derive(Deserialize)]
pub struct GuildRegionAdd {
    pub name: String,
    pub sfu: String,
    #[serde(default)]
    pub turn: Option<String>,
    #[serde(default)]
    pub pubkey_hint: Option<String>,
    #[serde(default)]
    pub set_default: bool,
    /// True when the region was added from the public directory's browse
    /// cards; only these rows earn a "no longer listed" warning.
    #[serde(default)]
    pub from_directory: bool,
}

#[derive(Deserialize)]
pub struct GuildRegionDefault {
    pub name: String,
}

pub async fn guild_voice_regions_list(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::CONNECT).await?;

    let health: Vec<(String, i64, Option<i64>)> =
        sqlx::query_as("SELECT region, healthy, latency_ms FROM sfu_health")
            .fetch_all(&state.pool)
            .await?;
    let health_of = |key: &str| health.iter().find(|(k, _, _)| k == key);

    let mut regions: Vec<Value> = state
        .cfg
        .voice
        .regions
        .iter()
        .map(|r| {
            let h = health_of(&r.name);
            json!({
                "name": r.name, "sfu": r.sfu, "turn": r.turn,
                "guild": false, "default": r.name == state.cfg.voice.default_region,
                "healthy": h.map(|(_, ok, _)| *ok != 0).unwrap_or(true),
                "latency_ms": h.and_then(|(_, _, l)| *l),
            })
        })
        .collect();

    let guild_rows: Vec<(String, String, Option<String>, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT name, sfu, turn, pubkey_hint, is_default, from_directory FROM guild_voice_regions WHERE guild_id = ?",
    )
    .bind(&guild_id)
    .fetch_all(&state.pool)
    .await?;
    // Only rows added from the directory can be "no longer listed"; a URL an
    // owner typed by hand was never listed to begin with.
    let directory_held: Option<std::collections::HashSet<String>> =
        if state.cfg.voice.directory.is_subscribed() {
            Some(
                crate::sfu_directory::relays(&state)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|r| r.url)
                    .collect(),
            )
        } else {
            None
        };
    let mut guild_default: Option<String> = None;
    for (name, sfu, turn, pk, is_def, from_directory) in &guild_rows {
        if *is_def != 0 {
            guild_default = Some(name.clone());
        }
        let key = format!("g{guild_id}/{name}");
        let h = health_of(&key);
        let listed = if *from_directory != 0 {
            directory_held.as_ref().map(|held| held.contains(sfu))
        } else {
            None
        };
        regions.push(json!({
            "name": name, "sfu": sfu, "turn": turn, "pubkey_hint": pk,
            "guild": true, "default": *is_def != 0,
            "healthy": h.map(|(_, ok, _)| *ok != 0).unwrap_or(true),
            "latency_ms": h.and_then(|(_, _, l)| *l),
            "listed": listed,
        }));
    }

    Ok(Json(json!({
        "server_default": state.cfg.voice.default_region,
        "guild_default": guild_default,
        "voice_mode": guild_voice_mode(&state, &guild_id).await,
        "mesh_max_participants": state.cfg.voice.mesh_max_participants,
        "regions": regions,
    })))
}

pub async fn guild_voice_region_add(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<GuildRegionAdd>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let name = req.name.trim().to_string();
    if name.is_empty() || name == "auto" {
        return Err(ApiError::BadRequest("invalid region name".into()));
    }
    if !req.sfu.starts_with("http://") && !req.sfu.starts_with("https://") {
        return Err(ApiError::BadRequest("sfu must be an http(s) URL".into()));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guild_voice_regions WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    if count >= 20 {
        return Err(ApiError::BadRequest("guild voice region limit reached".into()));
    }

    // Advisory reachability probe: the server's vantage is a courtesy, not a
    // gate. An SFU reachable by clients but not by this server is legitimate
    // (the media path is client-to-relay), and a relay that fails this probe
    // is recorded unhealthy and skipped by the resolver, never fatal.
    let probe = crate::sfu_directory::probe_relay(&state, &req.sfu).await;

    if req.set_default {
        sqlx::query("UPDATE guild_voice_regions SET is_default = 0 WHERE guild_id = ?")
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    sqlx::query(
        "INSERT INTO guild_voice_regions (guild_id, name, sfu, turn, pubkey_hint, is_default, from_directory, created_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(guild_id, name) DO UPDATE SET sfu = excluded.sfu, turn = excluded.turn, \
             pubkey_hint = excluded.pubkey_hint, is_default = excluded.is_default, \
             from_directory = excluded.from_directory, \
             created_by = excluded.created_by, created_at = excluded.created_at",
    )
    .bind(&guild_id)
    .bind(&name)
    .bind(&req.sfu)
    .bind(&req.turn)
    .bind(&req.pubkey_hint)
    .bind(req.set_default as i64)
    .bind(req.from_directory as i64)
    .bind(&auth.user_id)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    // Seed the region's health only on a measured-good probe. A failed probe
    // records nothing: the server's vantage is not authoritative (a relay
    // reachable by clients but not by this server is legitimate), so an
    // unmeasured relay stays unknown -- counted healthy until the maintenance
    // loop's probes say otherwise -- and the add response carries the warning.
    if probe.ok {
        sqlx::query(
            "INSERT INTO sfu_health (region, endpoint, healthy, failures, latency_ms, checked_at) \
             VALUES (?, ?, 1, 0, ?, ?) \
             ON CONFLICT(region) DO UPDATE SET endpoint = excluded.endpoint, healthy = 1, \
                 failures = 0, latency_ms = excluded.latency_ms, checked_at = excluded.checked_at",
        )
        .bind(format!("g{guild_id}/{name}"))
        .bind(&req.sfu)
        .bind(probe.latency_ms)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
    }

    Ok(Json(json!({
        "ok": true, "name": name, "sfu": req.sfu,
        "reachable": probe.ok, "accepting": probe.accepting,
    })))
}

#[derive(Deserialize)]
pub struct GuildVoiceModeSet {
    pub voice_mode: String,
}

/// Sets the guild's voice relay mode by merging one key into its settings
/// blob server-side, so the client never has to read-modify-write (and
/// clobber) the whole blob to reach this switch.
pub async fn guild_voice_mode_set(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<GuildVoiceModeSet>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    if !matches!(req.voice_mode.as_str(), "automatic" | "fixed" | "direct") {
        return Err(ApiError::BadRequest(
            "voice_mode must be automatic, fixed or direct".into(),
        ));
    }
    let settings: Option<String> = sqlx::query_scalar("SELECT settings FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let mut parsed: Value = settings
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    parsed["voice_mode"] = json!(req.voice_mode);
    sqlx::query("UPDATE guilds SET settings = ? WHERE id = ?")
        .bind(parsed.to_string())
        .bind(&guild_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true, "voice_mode": req.voice_mode })))
}

pub async fn guild_voice_region_set_default(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<GuildRegionDefault>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM guild_voice_regions WHERE guild_id = ? AND name = ?",
    )
    .bind(&guild_id)
    .bind(&req.name)
    .fetch_optional(&state.pool)
    .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("no such guild voice region".into()));
    }
    sqlx::query("UPDATE guild_voice_regions SET is_default = 0 WHERE guild_id = ?")
        .bind(&guild_id)
        .execute(&state.pool)
        .await?;
    sqlx::query(
        "UPDATE guild_voice_regions SET is_default = 1 WHERE guild_id = ? AND name = ?",
    )
    .bind(&guild_id)
    .bind(&req.name)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "default": req.name })))
}

pub async fn guild_voice_region_delete(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, name)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let used: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channels WHERE voice_region = ? AND guild_id = ?",
    )
    .bind(&name)
    .bind(&guild_id)
    .fetch_one(&state.pool)
    .await?;
    if used > 0 {
        return Err(ApiError::Conflict(
            "region is still used by one or more channels; reassign them first".into(),
        ));
    }
    sqlx::query("DELETE FROM guild_voice_regions WHERE guild_id = ? AND name = ?")
        .bind(&guild_id)
        .bind(&name)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct Signal {
    pub target: String,
    pub payload: Value,
}

pub async fn signal(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<Signal>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    let together: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND user_id IN (?, ?)",
    )
    .bind(&channel_id)
    .bind(&auth.user_id)
    .bind(&req.target)
    .fetch_one(&state.pool)
    .await?;
    if together < 2 {
        return Err(ApiError::Forbidden(
            "both parties must be connected to that channel".into(),
        ));
    }
    state
        .hub
        .publish(
            Event {
                t: "VOICE_SIGNAL",
                guild_id: ctx.guild_id,
                channel_id: Some(channel_id.clone()),
                intent: INTENT_GUILD_VOICE_STATES,
                only_user: Some(req.target),
                data: json!({
                    "channel_id": channel_id,
                    "from": auth.user_id,
                    "payload": req.payload,
                }),
            }
            .into(),
        )
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn health_check(state: &AppState) -> ApiResult<()> {
    for region in &state.cfg.voice.regions {
        if region.sfu.is_empty() { continue; }
        probe_region(state, &region.name, &region.sfu, &region.name, None).await?;
    }

    let guild_regions: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT guild_id, name, sfu FROM guild_voice_regions",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    for (guild_id, name, sfu) in guild_regions {
        if sfu.is_empty() { continue; }
        let key = format!("g{guild_id}/{name}");
        probe_region(state, &key, &sfu, &name, Some(&guild_id)).await?;
    }

    // Only poll directory SFUs actually carrying calls; an idle listing is
    // sampled by the directory publisher, not every participating guild.
    for relay in crate::sfu_directory::relays(state).await? {
        let active: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_states WHERE region = ?")
            .bind(&relay.url)
            .fetch_one(&state.pool)
            .await?;
        if active > 0 {
            let key = crate::sfu_directory::health_key(&relay.url);
            probe_region(state, &key, &relay.url, &relay.url, None).await?;
        }
    }
    Ok(())
}

async fn probe_region(
    state: &AppState, key: &str, sfu: &str, region_name: &str, guild_filter: Option<&str>,
) -> ApiResult<()> {
    let url = format!("{}/health", sfu.trim_end_matches('/'));
    let started = now_ms();
    let (operational, accepting) = match state.http
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            let body = response.json::<Value>().await.ok();
            let operational = body.as_ref()
                .and_then(|v| v.get("ok").and_then(Value::as_bool)) != Some(false);
            let accepting = body.as_ref()
                .and_then(|v| v.get("accepting").and_then(Value::as_bool)) != Some(false);
            (operational, accepting)
        }
        _ => (false, false),
    };
    let available = operational && accepting;
    let latency = now_ms() - started;

    let was_healthy: Option<i64> =
        sqlx::query_scalar("SELECT healthy FROM sfu_health WHERE region = ?")
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
    sqlx::query(
        "INSERT INTO sfu_health (region, endpoint, healthy, failures, latency_ms, checked_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(region) DO UPDATE SET endpoint = excluded.endpoint, \
             healthy = excluded.healthy, \
             failures = CASE WHEN excluded.healthy = 1 THEN 0 ELSE sfu_health.failures + 1 END, \
             latency_ms = excluded.latency_ms, checked_at = excluded.checked_at",
    )
    .bind(key)
    .bind(sfu)
    .bind(available as i64)
    .bind(if available { 0 } else { 1 })
    .bind(latency)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    // At capacity means no *new* calls; never interrupt existing ones.
    // A genuinely down SFU, however, must move its active rooms as a unit.
    if !operational && was_healthy != Some(0) {
        failover::reassign_for_failure(state, region_name, guild_filter).await?;
    }
    Ok(())
}
