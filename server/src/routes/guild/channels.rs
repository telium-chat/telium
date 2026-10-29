use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_STRUCTURE};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use super::{validate_expiry_limit, validate_media_max_file_bytes};

#[derive(Deserialize)]
pub struct CreateChannel {
    pub name: String,
    #[serde(default = "default_channel_type")]
    pub r#type: String,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub slowmode: Option<i64>,
    #[serde(default)]
    pub voice_region: Option<String>,
    #[serde(default)]
    pub bitrate: Option<i64>,
    #[serde(default)]
    pub user_limit: Option<i64>,
    #[serde(default)]
    pub media_expiry_limit_secs: Option<Option<i64>>,
    #[serde(default)]
    pub media_max_file_bytes: Option<i64>,
    #[serde(default)]
    pub available_tags: Option<Vec<ForumTag>>,
    #[serde(default)]
    pub default_sort: Option<String>,
    #[serde(default)]
    pub default_layout: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ForumTag {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub emoji: Option<String>,
    #[serde(default)]
    pub moderated: bool,
}

const MAX_FORUM_TAGS: usize = 20;

fn normalise_tags(kind: &str, tags: &[ForumTag]) -> ApiResult<String> {
    if kind != "forum" && !tags.is_empty() {
        return Err(ApiError::BadRequest("only a forum channel has tags".into()));
    }
    if tags.len() > MAX_FORUM_TAGS {
        return Err(ApiError::BadRequest(format!("a forum may offer at most {MAX_FORUM_TAGS} tags")));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for tag in tags {
        let name = tag.name.trim();
        if name.is_empty() || name.chars().count() > 20 {
            return Err(ApiError::BadRequest("a tag name must be 1-20 characters".into()));
        }
        let folded = name.to_lowercase();
        if seen.contains(&folded) {
            return Err(ApiError::BadRequest(format!("two tags are both called {name}")));
        }
        seen.push(folded);
        out.push(json!({
            "id": tag.id.clone().unwrap_or_else(ulid),
            "name": name,
            "emoji": tag.emoji,
            "moderated": tag.moderated,
        }));
    }
    Ok(Value::Array(out).to_string())
}

fn validate_forum_view(sort: Option<&String>, layout: Option<&String>) -> ApiResult<()> {
    if let Some(sort) = sort {
        if !["activity", "creation"].contains(&sort.as_str()) {
            return Err(ApiError::BadRequest("sort must be activity or creation".into()));
        }
    }
    if let Some(layout) = layout {
        if !["list", "gallery"].contains(&layout.as_str()) {
            return Err(ApiError::BadRequest("layout must be list or gallery".into()));
        }
    }
    Ok(())
}

fn default_channel_type() -> String {
    "text".into()
}

pub async fn list_channels(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let visible = guildstore::visible_channels(&state, &guild_id, &auth.user_id).await?;
    let mut channels = Vec::new();
    for id in visible {
        channels.push(channel_json(&state, &id).await?);
    }
    channels.sort_by_key(|c| c["position"].as_i64().unwrap_or(0));
    Ok(Json(json!({ "channels": channels })))
}

pub async fn create_channel(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<CreateChannel>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_CHANNELS).await?;
    if !["text", "voice", "forum", "announcement", "category"].contains(&req.r#type.as_str()) {
        return Err(ApiError::BadRequest("unknown channel type".into()));
    }
    if req.name.trim().is_empty() || req.name.chars().count() > 100 {
        return Err(ApiError::BadRequest("channel name must be 1-100 characters".into()));
    }

    if let Some(region) = &req.voice_region {
        validate_region(&state, &guild_id, region).await?;
    }
    validate_expiry_limit(req.media_expiry_limit_secs.flatten())?;
    validate_media_max_file_bytes(req.media_max_file_bytes)?;
    validate_forum_view(req.default_sort.as_ref(), req.default_layout.as_ref())?;
    let tags = normalise_tags(&req.r#type, req.available_tags.as_deref().unwrap_or(&[]))?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, slowmode, \
         voice_region, bitrate, user_limit, media_expiry_limit_secs, available_tags, \
         default_sort, default_layout, media_max_file_bytes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&guild_id)
    .bind(&req.r#type)
    .bind(req.name.trim())
    .bind(&req.topic)
    .bind(req.position.unwrap_or(0))
    .bind(&req.parent_id)
    .bind(req.slowmode.unwrap_or(0))
    .bind(req.voice_region.as_deref().unwrap_or("auto"))
    .bind(req.bitrate.map(|b| b.min(state.cfg.voice.max_bitrate)))
    .bind(req.user_limit.unwrap_or(0).max(0))
    .bind(req.media_expiry_limit_secs.flatten())
    .bind(&tags)
    .bind(req.default_sort.as_deref().unwrap_or("activity"))
    .bind(req.default_layout.as_deref().unwrap_or("list"))
    .bind(req.media_max_file_bytes)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let ch = channel_json(&state, &id).await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "channel.create", Some(&id), json!({ "name": req.name })).await?;
    state.hub.publish(Event::in_channel("CHANNEL_CREATE", guild_id, id, INTENT_GUILD_STRUCTURE, ch.clone())).await;
    Ok(Json(ch))
}

#[derive(Deserialize)]
pub struct ChannelPlace {
    pub id: String,
    pub position: i64,
    #[serde(default, deserialize_with = "crate::routes::identity::double_option")]
    pub parent_id: Option<Option<String>>,
}

#[derive(Deserialize)]
pub struct ReorderChannels {
    pub channels: Vec<ChannelPlace>,
}

async fn channel_kinds(state: &AppState, guild_id: &str) -> ApiResult<HashMap<String, String>> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT id, type FROM channels WHERE guild_id = ?")
            .bind(guild_id)
            .fetch_all(&state.pool)
            .await?;
    Ok(rows.into_iter().collect())
}

fn validate_parent(
    kinds: &HashMap<String, String>,
    id: &str,
    kind: &str,
    parent: Option<&str>,
) -> ApiResult<()> {
    let Some(parent) = parent else { return Ok(()) };
    if kind == "category" {
        return Err(ApiError::BadRequest("a category cannot sit inside another".into()));
    }
    if parent == id {
        return Err(ApiError::BadRequest("a channel cannot be its own category".into()));
    }
    match kinds.get(parent) {
        Some(k) if k == "category" => Ok(()),
        Some(_) => Err(ApiError::BadRequest("parent_id must name a category".into())),
        None => Err(ApiError::NotFound("category not found in this guild".into())),
    }
}

pub async fn reorder_channels(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<ReorderChannels>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_CHANNELS).await?;
    if req.channels.len() > 500 {
        return Err(ApiError::BadRequest("too many channels in one move".into()));
    }
    let kinds = channel_kinds(&state, &guild_id).await?;
    for place in &req.channels {
        let kind = kinds
            .get(&place.id)
            .ok_or_else(|| ApiError::NotFound("channel not found in this guild".into()))?;
        if let Some(parent) = &place.parent_id {
            validate_parent(&kinds, &place.id, kind, parent.as_deref())?;
        }
    }

    let mut tx = state.pool.begin().await?;
    for place in &req.channels {
        sqlx::query("UPDATE channels SET position = ? WHERE id = ?")
            .bind(place.position)
            .bind(&place.id)
            .execute(&mut *tx)
            .await?;
        if let Some(parent) = &place.parent_id {
            sqlx::query("UPDATE channels SET parent_id = ? WHERE id = ?")
                .bind(parent.as_deref())
                .bind(&place.id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;

    let mut out = Vec::new();
    for place in &req.channels {
        let ch = channel_json(&state, &place.id).await?;
        state
            .hub
            .publish(Event::in_channel(
                "CHANNEL_UPDATE",
                guild_id.clone(),
                place.id.clone(),
                INTENT_GUILD_STRUCTURE,
                ch.clone(),
            ))
            .await;
        out.push(ch);
    }
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "channel.reorder",
        None,
        json!({ "count": req.channels.len() }),
    )
    .await?;
    Ok(Json(json!({ "channels": out })))
}

pub async fn channel_json(state: &AppState, channel_id: &str) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String, String, String, String, Option<String>, i64, Option<String>, i64,
        String, Option<i64>, i64, i64, Option<i64>, String, String, String,
    )> = sqlx::query_as(
        "SELECT id, guild_id, type, name, topic, position, parent_id, slowmode, \
         voice_region, bitrate, user_limit, strip_embeds, media_expiry_limit_secs, \
         available_tags, default_sort, default_layout \
         FROM channels WHERE id = ?",
    )
    .bind(channel_id)
    .fetch_optional(&state.pool)
    .await?;
    let (id, guild_id, kind, name, topic, position, parent_id, slowmode, region, bitrate,
         user_limit, strip_embeds, expiry_limit, tags, sort, layout) =
        row.ok_or_else(|| ApiError::NotFound("channel not found".into()))?;
    let status: Option<(Option<String>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT voice_status, voice_status_at, voice_status_author FROM channels WHERE id = ?",
    )
    .bind(channel_id)
    .fetch_optional(&state.pool)
    .await?;
    let (voice_status, voice_status_at, voice_status_author) =
        status.unwrap_or((None, None, None));
    let max_file_bytes: Option<Option<i64>> =
        sqlx::query_scalar("SELECT media_max_file_bytes FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    let overwrites = guildstore::channel_overwrites(&state.pool, channel_id).await?;
    Ok(json!({
        "id": id, "guild_id": guild_id, "type": kind, "name": name, "topic": topic,
        "position": position, "parent_id": parent_id, "slowmode": slowmode,
        "voice_region": region,
        "bitrate": bitrate.unwrap_or(state.cfg.voice.max_bitrate),
        "user_limit": user_limit,
        "strip_embeds": strip_embeds != 0,
        "media_expiry_limit_secs": expiry_limit,
        "media_max_file_bytes": max_file_bytes,
        "available_tags": serde_json::from_str::<Value>(&tags).unwrap_or(json!([])),
        "default_sort": sort,
        "default_layout": layout,
        "voice_status": voice_status,
        "voice_status_at": voice_status_at,
        "voice_status_author": voice_status_author,
        "permission_overwrites": overwrites.iter().map(|o| json!({
            "target_type": o.target_type, "target_id": o.target_id,
            "allow": o.allow.to_string(), "deny": o.deny.to_string(),
        })).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
pub struct PatchChannel {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default, deserialize_with = "crate::routes::identity::double_option")]
    pub parent_id: Option<Option<String>>,
    #[serde(default)]
    pub slowmode: Option<i64>,
    #[serde(default)]
    pub voice_region: Option<String>,
    #[serde(default)]
    pub bitrate: Option<i64>,
    #[serde(default)]
    pub user_limit: Option<i64>,
    #[serde(default)]
    pub strip_embeds: Option<bool>,
    #[serde(default, deserialize_with = "crate::routes::identity::double_option")]
    pub media_expiry_limit_secs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "crate::routes::identity::double_option")]
    pub media_max_file_bytes: Option<Option<i64>>,
    #[serde(default)]
    pub available_tags: Option<Vec<ForumTag>>,
    #[serde(default)]
    pub default_sort: Option<String>,
    #[serde(default)]
    pub default_layout: Option<String>,
}

async fn validate_region(state: &AppState, guild_id: &str, region: &str) -> ApiResult<()> {
    if region == "auto" {
        return Ok(());
    }
    if state.cfg.voice.regions.iter().any(|r| r.name == region) {
        return Ok(());
    }
    let exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM guild_voice_regions WHERE guild_id = ? AND name = ?",
    )
    .bind(guild_id)
    .bind(region)
    .fetch_optional(&state.pool)
    .await?;
    if exists.is_some() {
        return Ok(());
    }
    Err(ApiError::BadRequest(format!("no voice region named {region} is configured")))
}

pub async fn patch_channel(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<PatchChannel>,
) -> ApiResult<Json<Value>> {
    let ch = guildstore::channel(&state, &channel_id).await?;
    guildstore::require_guild_perm(&state, &ch.guild_id, &auth.user_id, perms::MANAGE_CHANNELS).await?;
    validate_forum_view(req.default_sort.as_ref(), req.default_layout.as_ref())?;

    if let Some(name) = &req.name {
        sqlx::query("UPDATE channels SET name = ? WHERE id = ?").bind(name.trim()).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(topic) = &req.topic {
        sqlx::query("UPDATE channels SET topic = ? WHERE id = ?").bind(topic).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(position) = req.position {
        sqlx::query("UPDATE channels SET position = ? WHERE id = ?").bind(position).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(parent) = &req.parent_id {
        let kinds = channel_kinds(&state, &ch.guild_id).await?;
        validate_parent(&kinds, &channel_id, &ch.kind, parent.as_deref())?;
        sqlx::query("UPDATE channels SET parent_id = ? WHERE id = ?")
            .bind(parent.as_deref()).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(slowmode) = req.slowmode {
        sqlx::query("UPDATE channels SET slowmode = ? WHERE id = ?").bind(slowmode.max(0)).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(region) = &req.voice_region {
        validate_region(&state, &ch.guild_id, region).await?;
        sqlx::query("UPDATE channels SET voice_region = ? WHERE id = ?").bind(region).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(bitrate) = req.bitrate {
        sqlx::query("UPDATE channels SET bitrate = ? WHERE id = ?")
            .bind(bitrate.clamp(8_000, state.cfg.voice.max_bitrate)).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(user_limit) = req.user_limit {
        sqlx::query("UPDATE channels SET user_limit = ? WHERE id = ?").bind(user_limit.max(0)).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(strip_embeds) = req.strip_embeds {
        sqlx::query("UPDATE channels SET strip_embeds = ? WHERE id = ?")
            .bind(i64::from(strip_embeds)).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(secs) = req.media_expiry_limit_secs {
        validate_expiry_limit(secs)?;
        sqlx::query("UPDATE channels SET media_expiry_limit_secs = ? WHERE id = ?")
            .bind(secs).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(bytes) = req.media_max_file_bytes {
        validate_media_max_file_bytes(bytes)?;
        sqlx::query("UPDATE channels SET media_max_file_bytes = ? WHERE id = ?")
            .bind(bytes).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    if let Some(tags) = &req.available_tags {
        sqlx::query("UPDATE channels SET available_tags = ? WHERE id = ?")
            .bind(normalise_tags(&ch.kind, tags)?).bind(&channel_id)
            .execute(&state.pool).await?;
    }
    for (column, value) in [("default_sort", &req.default_sort), ("default_layout", &req.default_layout)] {
        let Some(v) = value else { continue };
        sqlx::query(&format!("UPDATE channels SET {column} = ? WHERE id = ?"))
            .bind(v).bind(&channel_id)
            .execute(&state.pool).await?;
    }

    let out = channel_json(&state, &channel_id).await?;
    state.hub.publish(Event::in_channel("CHANNEL_UPDATE", ch.guild_id, channel_id, INTENT_GUILD_STRUCTURE, out.clone())).await;
    Ok(Json(out))
}

pub const MAX_VOICE_STATUS: usize = 140;

#[derive(Deserialize)]
pub struct SetVoiceStatus {
    #[serde(default)]
    pub status: Option<String>,
}

pub async fn set_voice_status(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<SetVoiceStatus>,
) -> ApiResult<Json<Value>> {
    let ch = guildstore::channel(&state, &channel_id).await?;
    if ch.kind != "voice" {
        return Err(ApiError::BadRequest("only voice channels have a voice status".into()));
    }
    let m = guildstore::membership(&state, &ch.guild_id, &auth.user_id).await?;
    let ow = guildstore::effective_overwrites(&state.pool, &channel_id).await?;
    let p = perms::channel_permissions(&m.context(), &ow);
    if !perms::has(p, perms::VIEW_CHANNEL) {
        return Err(ApiError::NotFound("channel not found".into()));
    }
    let in_channel: Option<String> = sqlx::query_scalar(
        "SELECT channel_id FROM voice_states WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&ch.guild_id)
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let channel_bits = p;
    let may_write = in_channel.as_deref() == Some(channel_id.as_str())
        || perms::has(channel_bits, perms::CONNECT)
        || perms::has(channel_bits, perms::MANAGE_CHANNELS)
        || perms::has(channel_bits, perms::MUTE_MEMBERS);
    if !may_write {
        return Err(ApiError::Forbidden(
            "join the channel or hold CONNECT to set its status".into(),
        ));
    }
    let text = req.status.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(ref s) = text {
        if s.chars().count() > MAX_VOICE_STATUS {
            return Err(ApiError::BadRequest(format!(
                "voice status must be {MAX_VOICE_STATUS} characters or fewer"
            )));
        }
    }
    let now = now_ms();
    match text {
        Some(s) => {
            sqlx::query(
                "UPDATE channels SET voice_status = ?, voice_status_at = ?, voice_status_author = ? WHERE id = ?",
            )
            .bind(s)
            .bind(now)
            .bind(&auth.user_id)
            .bind(&channel_id)
            .execute(&state.pool)
            .await?;
        }
        None => {
            sqlx::query(
                "UPDATE channels SET voice_status = NULL, voice_status_at = NULL, voice_status_author = NULL WHERE id = ?",
            )
            .bind(&channel_id)
            .execute(&state.pool)
            .await?;
        }
    }
    let out = channel_json(&state, &channel_id).await?;
    state.hub.publish(Event::in_channel("CHANNEL_UPDATE", ch.guild_id, channel_id, INTENT_GUILD_STRUCTURE, out.clone())).await;
    Ok(Json(out))
}

pub async fn delete_channel(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let ch = guildstore::channel(&state, &channel_id).await?;
    guildstore::require_guild_perm(&state, &ch.guild_id, &auth.user_id, perms::MANAGE_CHANNELS).await?;

    let posts: Vec<String> = sqlx::query_scalar("SELECT id FROM threads WHERE parent_id = ?")
        .bind(&channel_id)
        .fetch_all(&state.pool)
        .await?;
    for post in &posts {
        crate::routes::social::purge_thread(&state, post).await?;
    }

    let orphans: Vec<String> = sqlx::query_scalar("SELECT id FROM channels WHERE parent_id = ?")
        .bind(&channel_id)
        .fetch_all(&state.pool)
        .await?;

    let mut tx = state.pool.begin().await?;
    crate::routes::media::release_message_refs(&mut *tx, "messages.channel_id = ?", &channel_id).await?;
    sqlx::query("DELETE FROM messages WHERE channel_id = ?").bind(&channel_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channel_overwrites WHERE channel_id = ?").bind(&channel_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE channels SET parent_id = NULL WHERE parent_id = ?").bind(&channel_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channels WHERE id = ?").bind(&channel_id).execute(&mut *tx).await?;
    tx.commit().await?;

    guildstore::audit(&state.pool, &ch.guild_id, &auth.user_id, "channel.delete", Some(&channel_id), json!({})).await?;
    for id in &orphans {
        let out = channel_json(&state, id).await?;
        state.hub.publish(Event::in_channel(
            "CHANNEL_UPDATE", ch.guild_id.clone(), id.clone(), INTENT_GUILD_STRUCTURE, out,
        )).await;
    }
    state.hub.publish(Event::new("CHANNEL_DELETE", ch.guild_id, INTENT_GUILD_STRUCTURE, json!({ "id": channel_id }))).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct SetOverwrite {
    pub allow: String,
    pub deny: String,
}

pub async fn set_overwrite(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, target_type, target_id)): Path<(String, String, String)>,
    Json(req): Json<SetOverwrite>,
) -> ApiResult<Json<Value>> {
    let ch = guildstore::channel(&state, &channel_id).await?;
    guildstore::require_guild_perm(&state, &ch.guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    if !["role", "member"].contains(&target_type.as_str()) {
        return Err(ApiError::BadRequest("target_type must be role or member".into()));
    }
    let allow: u64 = req.allow.parse().map_err(|_| ApiError::BadRequest("allow must be a u64 string".into()))?;
    let deny: u64 = req.deny.parse().map_err(|_| ApiError::BadRequest("deny must be a u64 string".into()))?;

    sqlx::query(
        "INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) \
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (channel_id, target_type, target_id) \
         DO UPDATE SET allow = excluded.allow, deny = excluded.deny",
    )
    .bind(&channel_id)
    .bind(&target_type)
    .bind(&target_id)
    .bind(allow as i64)
    .bind(deny as i64)
    .execute(&state.pool)
    .await?;

    let out = channel_json(&state, &channel_id).await?;
    state.hub.publish(Event::in_channel("CHANNEL_UPDATE", ch.guild_id, channel_id, INTENT_GUILD_STRUCTURE, out.clone())).await;
    Ok(Json(out))
}

