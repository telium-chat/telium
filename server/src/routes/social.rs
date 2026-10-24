
use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_MESSAGES, INTENT_GUILD_STRUCTURE};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

async fn message_channel(state: &AppState, message_id: &str) -> ApiResult<(String, String)> {
    sqlx::query_as("SELECT channel_id, guild_id FROM messages WHERE id = ? AND deleted = 0")
        .bind(message_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("message not found".into()))
}

async fn check_emoji(
    state: &AppState,
    guild_id: &str,
    user_id: &str,
    emoji: &str,
    perms_bits: u64,
) -> ApiResult<()> {
    if emoji.is_empty() || emoji.chars().count() > 64 {
        return Err(ApiError::BadRequest("that is not an emoji".into()));
    }
    let Some(rest) = emoji.strip_prefix('<').and_then(|e| e.strip_suffix('>')) else {
        return Ok(());
    };
    let (id, origin) = match rest.rsplit_once('@') {
        Some((head, origin)) => (head.rsplit(':').next().unwrap_or_default(), Some(origin)),
        None => (rest.rsplit(':').next().unwrap_or_default(), None),
    };

    if origin.is_some() && origin != Some(state.cfg.server_name.as_str()) {
        accepts_foreign_emoji(state, guild_id, perms_bits).await?;
        return crate::emoji::ensure_may_carry(state, id, origin, user_id).await;
    }

    let owner: Option<String> = sqlx::query_scalar("SELECT guild_id FROM emojis WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(owner) = owner else {
        return Err(ApiError::NotFound("no such custom emoji".into()));
    };
    if owner != guild_id {
        accepts_foreign_emoji(state, guild_id, perms_bits).await?;
        crate::emoji::ensure_may_carry(state, id, None, user_id).await?;
    }
    Ok(())
}

async fn accepts_foreign_emoji(state: &AppState, guild_id: &str, perms_bits: u64) -> ApiResult<()> {
    if !perms::has(perms_bits, perms::USE_EXTERNAL_EMOJI) {
        return Err(crate::guildstore::missing_permission(perms::USE_EXTERNAL_EMOJI));
    }
    let allowed: i64 = sqlx::query_scalar("SELECT external_emoji FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_one(&state.pool)
        .await?;
    if allowed == 0 {
        return Err(ApiError::Forbidden("this guild does not accept external emoji".into()));
    }
    Ok(())
}

pub async fn add_reaction(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((message_id, emoji)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (channel_id, guild_id) = message_channel(&state, &message_id).await?;
    let (_, _, bits) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::ADD_REACTIONS)
            .await?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    check_emoji(&state, &guild_id, &auth.user_id, &emoji, bits).await?;

    let inserted = sqlx::query(
        "INSERT INTO reactions (message_id, emoji, user_id, created_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&message_id)
    .bind(&emoji)
    .bind(&auth.user_id)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    if inserted.rows_affected() == 0 {
        return Ok(Json(json!({ "ok": true })));
    }

    state
        .hub
        .publish(Event::in_channel(
            "MESSAGE_REACTION_ADD",
            &guild_id,
            &channel_id,
            INTENT_GUILD_MESSAGES,
            json!({
                "message_id": message_id, "channel_id": channel_id,
                "emoji": emoji, "user_id": auth.user_id
            }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn remove_reaction(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((message_id, emoji)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (channel_id, guild_id) = message_channel(&state, &message_id).await?;
    guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL).await?;
    let removed = sqlx::query("DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?")
        .bind(&message_id)
        .bind(&emoji)
        .bind(&auth.user_id)
        .execute(&state.pool)
        .await?;
    if removed.rows_affected() == 0 {
        return Ok(Json(json!({ "ok": true })));
    }

    state
        .hub
        .publish(Event::in_channel(
            "MESSAGE_REACTION_REMOVE",
            &guild_id,
            &channel_id,
            INTENT_GUILD_MESSAGES,
            json!({
                "message_id": message_id, "channel_id": channel_id,
                "emoji": emoji, "user_id": auth.user_id
            }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn clear_reactions(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(message_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (channel_id, guild_id) = message_channel(&state, &message_id).await?;
    guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::MANAGE_MESSAGES)
        .await?;
    sqlx::query("DELETE FROM reactions WHERE message_id = ?")
        .bind(&message_id)
        .execute(&state.pool)
        .await?;
    state
        .hub
        .publish(Event::in_channel(
            "MESSAGE_REACTION_CLEAR",
            &guild_id,
            &channel_id,
            INTENT_GUILD_MESSAGES,
            json!({ "message_id": message_id, "channel_id": channel_id, "cleared": true }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_reactions(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(message_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (channel_id, _) = message_channel(&state, &message_id).await?;
    guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL).await?;
    Ok(Json(json!({ "reactions": reactions_for(&state, &message_id, &auth.user_id).await? })))
}

pub async fn reactions_for(state: &AppState, message_id: &str, viewer: &str) -> ApiResult<Value> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY created_at",
    )
    .bind(message_id)
    .fetch_all(&state.pool)
    .await?;
    const MAX_REACTOR_NAMES: usize = 100;
    let mut out: Vec<Value> = Vec::new();
    for (emoji, user_id) in rows {
        if let Some(group) = out.iter_mut().find(|g| g["emoji"] == emoji) {
            group["count"] = json!(group["count"].as_i64().unwrap_or(0) + 1);
            let users = group["users"].as_array_mut().unwrap();
            if users.len() < MAX_REACTOR_NAMES {
                users.push(json!(user_id));
            }
            if user_id == viewer {
                group["me"] = json!(true);
            }
        } else {
            out.push(json!({
                "emoji": emoji,
                "count": 1,
                "me": user_id == viewer,
                "users": vec![json!(user_id)],
            }));
        }
    }
    Ok(Value::Array(out))
}

pub async fn pin(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, message_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::MANAGE_MESSAGES)
            .await?;

    let (owning_channel, _) = message_channel(&state, &message_id).await?;
    if owning_channel != channel_id {
        return Err(ApiError::NotFound("message not found".into()));
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pins WHERE channel_id = ?")
        .bind(&channel_id)
        .fetch_one(&state.pool)
        .await?;
    if count >= 200 {
        return Err(ApiError::Conflict("this channel is at its pin limit".into()));
    }
    sqlx::query(
        "INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&channel_id)
    .bind(&message_id)
    .bind(&auth.user_id)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    state
        .hub
        .publish(Event::in_channel(
            "CHANNEL_PINS_UPDATE",
            ch.guild_id,
            &channel_id,
            INTENT_GUILD_MESSAGES,
            json!({ "channel_id": channel_id, "message_id": message_id, "pinned": true }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unpin(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, message_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::MANAGE_MESSAGES)
            .await?;
    sqlx::query("DELETE FROM pins WHERE channel_id = ? AND message_id = ?")
        .bind(&channel_id)
        .bind(&message_id)
        .execute(&state.pool)
        .await?;
    state
        .hub
        .publish(Event::in_channel(
            "CHANNEL_PINS_UPDATE",
            ch.guild_id,
            &channel_id,
            INTENT_GUILD_MESSAGES,
            json!({ "channel_id": channel_id, "message_id": message_id, "pinned": false }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_pins(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) = guildstore::require_channel_perm(
        &state,
        &channel_id,
        &auth.user_id,
        perms::READ_MESSAGE_HISTORY,
    )
    .await?;
    // m.channel_id = p.channel_id guards rows written before pin checked the channel.
    let view = crate::routes::messages::MessageView::for_guild(&state, &auth, &ch.guild_id).await?;
    let rows: Vec<crate::routes::messages::MessageRow> = sqlx::query_as(
        "SELECT m.id, m.channel_id, m.guild_id, m.author_id, m.content, m.attachments, m.components, \
         m.cards, m.sticker, m.reply_to, m.thread_id, m.author_signature, m.created_at, m.edited_at \
         FROM pins p JOIN messages m ON m.id = p.message_id \
         WHERE p.channel_id = ? AND m.channel_id = p.channel_id AND m.deleted = 0 \
         ORDER BY p.pinned_at DESC",
    )
    .bind(&channel_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "pins": rows
            .iter()
            .map(|row| crate::routes::messages::message_json(row, &view))
            .collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
pub struct CreateThread {
    pub title: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default)]
    pub auto_archive: Option<i64>,
}

const MAX_POST_TAGS: usize = 5;

async fn check_tags(
    state: &AppState,
    channel_id: &str,
    tags: &[String],
    moderator: bool,
) -> ApiResult<()> {
    if tags.is_empty() {
        return Ok(());
    }
    if tags.len() > MAX_POST_TAGS {
        return Err(ApiError::BadRequest(format!("a post may wear at most {MAX_POST_TAGS} tags")));
    }
    let available: String = sqlx::query_scalar("SELECT available_tags FROM channels WHERE id = ?")
        .bind(channel_id)
        .fetch_one(&state.pool)
        .await?;
    let available: Vec<Value> = serde_json::from_str(&available).unwrap_or_default();
    for tag in tags {
        let Some(found) = available.iter().find(|t| t["id"].as_str() == Some(tag.as_str())) else {
            return Err(ApiError::BadRequest("no such tag in this forum".into()));
        };
        if found["moderated"].as_bool().unwrap_or(false) && !moderator {
            let name = found["name"].as_str().unwrap_or("that tag");
            return Err(ApiError::Forbidden(format!("only a moderator applies {name}")));
        }
    }
    Ok(())
}

pub async fn create_thread(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<CreateThread>,
) -> ApiResult<Json<Value>> {
    let (ch, _, bits) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::SEND_MESSAGES)
            .await?;
    guildstore::ensure_authoritative(&state, &ch.guild_id).await?;
    if !matches!(ch.kind.as_str(), "text" | "forum" | "announcement") {
        return Err(ApiError::BadRequest("threads live under a text or forum channel".into()));
    }
    if req.title.trim().is_empty() || req.title.chars().count() > 100 {
        return Err(ApiError::BadRequest("thread title must be 1-100 characters".into()));
    }
    if ch.kind == "forum"
        && req.content.as_deref().unwrap_or("").trim().is_empty()
        && req.attachments.is_empty()
    {
        return Err(ApiError::BadRequest("a forum post needs a body".into()));
    }
    check_tags(&state, &channel_id, &req.tags, perms::has(bits, perms::MANAGE_MESSAGES)).await?;

    let id = ulid();
    let now = now_ms();
    let position: i64 = sqlx::query_scalar("SELECT position FROM channels WHERE id = ?")
        .bind(&channel_id)
        .fetch_one(&state.pool)
        .await?;
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, position, parent_id, slowmode, created_at) \
         VALUES (?, ?, 'thread', ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(&ch.guild_id)
    .bind(req.title.trim())
    .bind(position)
    .bind(&channel_id)
    .bind(now)
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "INSERT INTO threads (id, parent_id, guild_id, starter_id, owner, title, tags, \
         auto_archive, last_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&channel_id)
    .bind(&ch.guild_id)
    .bind(&req.message_id)
    .bind(&auth.user_id)
    .bind(req.title.trim())
    .bind(serde_json::to_string(&req.tags).unwrap_or_else(|_| "[]".into()))
    .bind(req.auto_archive.unwrap_or(86_400).clamp(3_600, 604_800))
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;

    if let Some(starter) = &req.message_id {
        sqlx::query("UPDATE messages SET thread_id = ? WHERE id = ? AND channel_id = ?")
            .bind(&id)
            .bind(starter)
            .bind(&channel_id)
            .execute(&state.pool)
            .await?;
    }

    if req.content.as_deref().map(str::trim).is_some_and(|c| !c.is_empty())
        || !req.attachments.is_empty()
    {
        crate::routes::messages::post_opening(
            &state,
            &id,
            &ch.guild_id,
            &auth.user_id,
            req.content.as_deref().unwrap_or("").trim(),
            &req.attachments,
            bits,
        )
        .await?;
    }

    let thread = thread_json(&state, &id, &crate::routes::messages::MessageView::unrestricted())
        .await?;
    state
        .hub
        .publish(Event::in_channel(
            "THREAD_CREATE",
            &ch.guild_id,
            &channel_id,
            INTENT_GUILD_STRUCTURE,
            thread.clone(),
        ))
        .await;
    let mut response = thread;
    crate::routes::messages::MessageView::for_guild(&state, &auth, &ch.guild_id)
        .await?
        .apply(&mut response);
    Ok(Json(response))
}

pub async fn thread_json(
    state: &AppState,
    id: &str,
    view: &crate::routes::messages::MessageView,
) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, Option<String>, String, String, String, i64, i64, i64, i64, i64, i64, i64)> =
        sqlx::query_as(
            "SELECT id, parent_id, guild_id, starter_id, owner, title, tags, archived, locked, \
             auto_archive, message_count, last_active, pinned, created_at FROM threads WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let (id, parent_id, guild_id, starter, owner, title, tags, archived, locked, auto, count,
         last, pinned, created_at) =
        row.ok_or_else(|| ApiError::NotFound("no such thread".into()))?;
    let opening: Option<crate::routes::messages::MessageRow> = sqlx::query_as(
        "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, sticker, \
         reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
         WHERE channel_id = ? AND deleted = 0 ORDER BY created_at ASC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(json!({
        "id": id, "parent_id": parent_id, "guild_id": guild_id, "starter_id": starter,
        "owner": owner, "title": title,
        "tags": serde_json::from_str::<Value>(&tags).unwrap_or(json!([])),
        "archived": archived != 0, "locked": locked != 0, "auto_archive": auto,
        "message_count": count, "last_active": last, "pinned": pinned != 0,
        "created_at": created_at,
        "opening": opening
            .as_ref()
            .map(|row| crate::routes::messages::message_json(row, view)),
    }))
}

#[derive(Deserialize)]
pub struct ThreadQuery {
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub sort: Option<String>,
}

pub async fn list_threads(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Query(q): Query<ThreadQuery>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL)
            .await?;
    let order = match q.sort.as_deref() {
        Some("creation") => "pinned DESC, created_at DESC",
        _ => "pinned DESC, last_active DESC",
    };
    let ids: Vec<String> = sqlx::query_scalar(&format!(
        "SELECT id FROM threads WHERE parent_id = ? AND archived = ? ORDER BY {order} LIMIT 100",
    ))
    .bind(&channel_id)
    .bind(q.archived.unwrap_or(false) as i64)
    .fetch_all(&state.pool)
    .await?;
    let view = crate::routes::messages::MessageView::for_guild(&state, &auth, &ch.guild_id).await?;
    let mut threads = Vec::new();
    for id in ids {
        threads.push(thread_json(&state, &id, &view).await?);
    }
    Ok(Json(json!({ "threads": threads })))
}

#[derive(Deserialize)]
pub struct PatchThread {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub archived: Option<bool>,
    #[serde(default)]
    pub locked: Option<bool>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

pub async fn patch_thread(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(id): Path<String>,
    Json(req): Json<PatchThread>,
) -> ApiResult<Json<Value>> {
    let (owner, guild_id, parent): (String, String, String) =
        sqlx::query_as("SELECT owner, guild_id, parent_id FROM threads WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("no such thread".into()))?;
    let (_, _, bits) =
        guildstore::require_channel_perm(&state, &parent, &auth.user_id, perms::VIEW_CHANNEL).await?;
    let is_moderator = perms::has(bits, perms::MANAGE_MESSAGES);
    if owner != auth.user_id && !is_moderator {
        return Err(ApiError::Forbidden("not your thread".into()));
    }
    if (req.locked.is_some() || req.pinned.is_some()) && !is_moderator {
        return Err(crate::guildstore::missing_permission(perms::MANAGE_MESSAGES));
    }

    if let Some(title) = &req.title {
        sqlx::query("UPDATE threads SET title = ? WHERE id = ?")
            .bind(title.trim())
            .bind(&id)
            .execute(&state.pool)
            .await?;
        sqlx::query("UPDATE channels SET name = ? WHERE id = ?")
            .bind(title.trim())
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }
    for (column, value) in [("archived", req.archived), ("locked", req.locked), ("pinned", req.pinned)] {
        let Some(v) = value else { continue };
        sqlx::query(&format!("UPDATE threads SET {column} = ? WHERE id = ?"))
            .bind(v as i64)
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(tags) = &req.tags {
        check_tags(&state, &parent, tags, is_moderator).await?;
        sqlx::query("UPDATE threads SET tags = ? WHERE id = ?")
            .bind(serde_json::to_string(tags).unwrap_or_else(|_| "[]".into()))
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }

    let thread = thread_json(&state, &id, &crate::routes::messages::MessageView::unrestricted())
        .await?;
    let view = crate::routes::messages::MessageView::for_guild(&state, &auth, &guild_id).await?;
    state
        .hub
        .publish(Event::in_channel(
            "THREAD_UPDATE",
            guild_id,
            parent,
            INTENT_GUILD_STRUCTURE,
            thread.clone(),
        ))
        .await;
    let mut response = thread;
    view.apply(&mut response);
    Ok(Json(response))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (owner, guild_id, parent): (String, String, String) =
        sqlx::query_as("SELECT owner, guild_id, parent_id FROM threads WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("no such thread".into()))?;
    let (_, _, bits) =
        guildstore::require_channel_perm(&state, &parent, &auth.user_id, perms::VIEW_CHANNEL).await?;
    if owner != auth.user_id && !perms::has(bits, perms::MANAGE_MESSAGES) {
        return Err(ApiError::Forbidden("not your post".into()));
    }
    purge_thread(&state, &id).await?;
    state
        .hub
        .publish(Event::in_channel(
            "THREAD_DELETE",
            guild_id,
            parent.clone(),
            INTENT_GUILD_STRUCTURE,
            json!({ "id": id, "parent_id": parent }),
        ))
        .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn purge_thread(state: &AppState, id: &str) -> ApiResult<()> {
    let messages: Vec<String> = sqlx::query_scalar("SELECT id FROM messages WHERE channel_id = ?")
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
    for message in &messages {
        unindex_message(state, message).await?;
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM messages WHERE channel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM pins WHERE channel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channel_overwrites WHERE channel_id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM threads WHERE id = ?").bind(id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channels WHERE id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn touch_thread(state: &AppState, channel_id: &str) -> ApiResult<()> {
    let touched = sqlx::query(
        "UPDATE threads SET message_count = message_count + 1, last_active = ?, archived = 0 \
         WHERE id = ?",
    )
    .bind(now_ms())
    .bind(channel_id)
    .execute(&state.pool)
    .await?;
    if touched.rows_affected() == 0 {
        return Ok(());
    }
    let Ok(thread) =
        thread_json(state, channel_id, &crate::routes::messages::MessageView::unrestricted()).await
    else {
        return Ok(());
    };
    let guild_id = thread["guild_id"].as_str().unwrap_or_default().to_string();
    let parent = thread["parent_id"].as_str().unwrap_or_default().to_string();
    state
        .hub
        .publish(Event::in_channel(
            "THREAD_UPDATE",
            guild_id,
            parent,
            INTENT_GUILD_STRUCTURE,
            thread,
        ))
        .await;
    Ok(())
}

pub async fn archive_idle_threads(state: &AppState) -> ApiResult<u64> {
    let now = now_ms();
    let archived: Vec<String> = sqlx::query_scalar(
        "UPDATE threads SET archived = 1 WHERE archived = 0 AND last_active + auto_archive * 1000 < ? \
         RETURNING id",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;
    for id in &archived {
        let Ok(thread) =
            thread_json(state, id, &crate::routes::messages::MessageView::unrestricted()).await
        else {
            continue;
        };
        let guild_id = thread["guild_id"].as_str().unwrap_or_default().to_string();
        let parent = thread["parent_id"].as_str().unwrap_or_default().to_string();
        state
            .hub
            .publish(Event::in_channel(
                "THREAD_UPDATE",
                guild_id,
                parent,
                INTENT_GUILD_STRUCTURE,
                thread,
            ))
            .await;
    }
    Ok(archived.len() as u64)
}

#[derive(Deserialize)]
pub struct Follow {
    pub target_id: String,
}

pub async fn follow_channel(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<Follow>,
) -> ApiResult<Json<Value>> {
    let (source, _, _) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL)
            .await?;
    if source.kind != "announcement" {
        return Err(ApiError::BadRequest("only announcement channels can be followed".into()));
    }
    let (target, _, _) = guildstore::require_channel_perm(
        &state,
        &req.target_id,
        &auth.user_id,
        perms::MANAGE_CHANNELS,
    )
    .await?;
    if target.guild_id != source.guild_id {
        return Err(ApiError::BadRequest("both channels must be in this guild".into()));
    }
    sqlx::query(
        "INSERT INTO channel_follows (source_id, target_id, created_by, created_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(&channel_id)
    .bind(&req.target_id)
    .bind(&auth.user_id)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unfollow_channel(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, target_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_channel_perm(&state, &target_id, &auth.user_id, perms::MANAGE_CHANNELS)
        .await?;
    sqlx::query("DELETE FROM channel_follows WHERE source_id = ? AND target_id = ?")
        .bind(&channel_id)
        .bind(&target_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn crosspost(state: &AppState, source: &str, message: &Value) -> ApiResult<()> {
    let targets: Vec<String> =
        sqlx::query_scalar("SELECT target_id FROM channel_follows WHERE source_id = ?")
            .bind(source)
            .fetch_all(&state.pool)
            .await?;
    for target in targets {
        let id = ulid();
        let now = now_ms();
        sqlx::query(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, sticker, \
             reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&target)
        .bind(message["guild_id"].as_str().unwrap_or_default())
        .bind(message["author"].as_str().unwrap_or_default())
        .bind(message["content"].as_str().unwrap_or_default())
        .bind(message["attachments"].to_string())
        .bind(message.get("sticker").filter(|v| !v.is_null()).map(ToString::to_string))
        .bind(message["id"].as_str())
        .bind(now)
        .execute(&state.pool)
        .await?;
        let mut copy = message.clone();
        copy["id"] = json!(id);
        copy["channel_id"] = json!(target);
        copy["crossposted_from"] = json!(source);
        copy["created_at"] = json!(now);
        state
            .hub
            .publish(Event::in_channel(
                "MESSAGE_CREATE",
                message["guild_id"].as_str().unwrap_or_default().to_string(),
                target,
                INTENT_GUILD_MESSAGES,
                copy,
            ))
            .await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct Ack {
    pub message_id: String,
    #[serde(default)]
    pub muted: Option<bool>,
}

pub async fn ack(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<Ack>,
) -> ApiResult<Json<Value>> {
    guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL).await?;
    sqlx::query(
        "INSERT INTO read_state (user_id, channel_id, last_read_id, muted, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, channel_id) DO UPDATE SET \
             last_read_id = MAX(read_state.last_read_id, excluded.last_read_id), \
             muted = COALESCE(?, read_state.muted), updated_at = excluded.updated_at",
    )
    .bind(&auth.user_id)
    .bind(&channel_id)
    .bind(&req.message_id)
    .bind(req.muted.unwrap_or(false) as i64)
    .bind(now_ms())
    .bind(req.muted.map(|m| m as i64))
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn read_state(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let visible = guildstore::visible_channels(&state, &guild_id, &auth.user_id).await?;
    let mut out = Vec::new();
    for channel_id in visible {
        let row: Option<(String, i64)> = sqlx::query_as(
            "SELECT last_read_id, muted FROM read_state WHERE user_id = ? AND channel_id = ?",
        )
        .bind(&auth.user_id)
        .bind(&channel_id)
        .fetch_optional(&state.pool)
        .await?;
        let (cursor, muted) = row.unwrap_or_else(|| (String::new(), 0));
        let unread: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND deleted = 0 AND id > ? \
             AND author_id != ?",
        )
        .bind(&channel_id)
        .bind(&cursor)
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
        let mentions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM message_mentions WHERE channel_id = ? AND message_id > ? \
             AND (user_id = ? OR user_id = '@everyone' OR user_id IN \
               (SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?))",
        )
        .bind(&channel_id)
        .bind(&cursor)
        .bind(&auth.user_id)
        .bind(&guild_id)
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
        out.push(json!({
            "channel_id": channel_id, "last_read_id": cursor, "muted": muted != 0,
            "unread": unread, "mentions": mentions,
        }));
    }
    Ok(Json(json!({ "guild_id": guild_id, "channels": out })))
}

static MENTION: OnceLock<regex::Regex> = OnceLock::new();
static ROLE_MENTION: OnceLock<regex::Regex> = OnceLock::new();

const MAX_MENTION_TARGETS: usize = 50;

const MAX_ROLE_MENTIONS: usize = 10;

const MAX_MENTIONED_PEOPLE: usize = 500;

pub async fn record_mentions(
    state: &AppState,
    message_id: &str,
    channel_id: &str,
    guild_id: &str,
    content: &str,
    author_perms: u64,
) -> ApiResult<Vec<String>> {
    let re = MENTION.get_or_init(|| {
        regex::Regex::new(r"@([a-z0-9._-]{1,32}):([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*(?::[0-9]{2,5})?)")
            .expect("static regex")
    });
    let role_re = ROLE_MENTION
        .get_or_init(|| regex::Regex::new(r"<@&([A-Z0-9]{26})>").expect("static regex"));

    let may_broadcast = crate::perms::has(author_perms, crate::perms::MENTION_EVERYONE);

    let mut found: Vec<(String, &'static str)> =
        re.find_iter(content).map(|m| (m.as_str().to_string(), "user")).collect();

    if may_broadcast && (content.contains("@everyone") || content.contains("@here")) {
        found.push(("@everyone".to_string(), "everyone"));
    }

    let mut roles: Vec<String> =
        role_re.captures_iter(content).map(|cap| cap[1].to_string()).collect();
    roles.sort();
    roles.dedup();
    roles.truncate(MAX_ROLE_MENTIONS);

    for role_id in roles {
        let mentionable: Option<i64> =
            sqlx::query_scalar("SELECT mentionable FROM roles WHERE id = ? AND guild_id = ?")
                .bind(&role_id)
                .bind(guild_id)
                .fetch_optional(&state.pool)
                .await?;
        match mentionable {
            Some(flag) if flag != 0 || may_broadcast => found.push((role_id, "role")),
            _ => {}
        }
    }

    found.sort();
    found.dedup();
    found.truncate(MAX_MENTION_TARGETS);
    for (target, kind) in &found {
        sqlx::query(
            "INSERT INTO message_mentions (message_id, channel_id, user_id, kind) \
             VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(message_id)
        .bind(channel_id)
        .bind(target)
        .bind(kind)
        .execute(&state.pool)
        .await?;
    }

    let mut people = Vec::new();
    for (target, kind) in found {
        if people.len() >= MAX_MENTIONED_PEOPLE {
            break;
        }
        if kind == "role" {
            let members: Vec<String> = sqlx::query_scalar(
                "SELECT user_id FROM member_roles WHERE guild_id = ? AND role_id = ? LIMIT 200",
            )
            .bind(guild_id)
            .bind(&target)
            .fetch_all(&state.pool)
            .await?;
            people.extend(members);
        } else {
            people.push(target);
        }
    }
    people.sort();
    people.dedup();
    people.truncate(MAX_MENTIONED_PEOPLE);
    Ok(people)
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub mentions: Option<String>,
    #[serde(default)]
    pub has: Option<String>,
    #[serde(default)]
    pub order: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

const HAS_VALUES: &str = "link, file, image, video, sound";

fn has_predicate(token: &str) -> Option<&'static str> {
    Some(match token {
        "file" => "json_array_length(attachments) > 0",
        "image" => {
            "EXISTS (SELECT 1 FROM json_each(attachments) \
             WHERE json_extract(value, '$.mime') LIKE 'image/%')"
        }
        "video" => {
            "EXISTS (SELECT 1 FROM json_each(attachments) \
             WHERE json_extract(value, '$.mime') LIKE 'video/%')"
        }
        "sound" => {
            "EXISTS (SELECT 1 FROM json_each(attachments) \
             WHERE json_extract(value, '$.mime') LIKE 'audio/%')"
        }
        "link" => "(content LIKE '%http://%' OR content LIKE '%https://%')",
        _ => return None,
    })
}

const ORDER_VALUES: &str = "newest, oldest";

pub(crate) fn search_cost(channels: usize, text: Option<&str>, selective: bool, limit: i64, offset: i64) -> f64 {
    let breadth = match text {
        Some(text) => {
            let shortest = text
                .split_whitespace()
                .map(|token| token.chars().count())
                .min()
                .unwrap_or(0);
            match shortest {
                0 | 1 => 120.0,
                2 => 60.0,
                3 => 25.0,
                4 => 10.0,
                5 => 4.0,
                _ => 1.0,
            }
        }
        None if selective => 20.0,
        None => 100.0,
    };
    1.0 + 0.25 * channels as f64 + breadth + (offset + limit) as f64 / 100.0
}

fn order_direction(token: &str) -> Option<&'static str> {
    match token {
        "newest" => Some("DESC"),
        "oldest" => Some("ASC"),
        _ => None,
    }
}

pub async fn search(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Value>> {
    let member = guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let text = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mentions = q.mentions.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let author = q.author.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let has = q.has.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let has_sql = match has {
        Some(token) => Some(has_predicate(token).ok_or_else(|| {
            ApiError::BadRequest(format!("unknown has filter {token}; accepted: {HAS_VALUES}"))
        })?),
        None => None,
    };
    let order = q.order.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let direction = match order {
        Some(token) => order_direction(token).ok_or_else(|| {
            ApiError::BadRequest(format!("unknown order {token}; accepted: {ORDER_VALUES}"))
        })?,
        None => "DESC",
    };
    let filtered =
        q.channel_id.is_some() || author.is_some() || mentions.is_some() || has_sql.is_some();
    if text.is_none() && !filtered {
        return Err(ApiError::BadRequest("search needs a query or a filter".into()));
    }
    let channel_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ?")
            .bind(&guild_id)
            .fetch_all(&state.pool)
            .await?;
    // Keyed on the searcher, not the guild; limit/offset clamped so the price matches.
    if state.cfg.rate_limit.enabled {
        let cost = search_cost(
            channel_ids.len(),
            text,
            author.is_some() || mentions.is_some(),
            q.limit.unwrap_or(25).clamp(1, 100),
            q.offset.unwrap_or(0).max(0),
        );
        if let Err(retry) = state.limiter.take_cost(
            format!("search:{}", auth.user_id),
            "search",
            state.cfg.rate_limit.search_burst as f64,
            state.cfg.rate_limit.search_per_sec,
            cost,
        ) {
            return Err(ApiError::RateLimited(format!(
                "too much searching: try again in {retry}s"
            )));
        }
    }
    let mut readable: Vec<String> = Vec::with_capacity(channel_ids.len());
    for id in channel_ids {
        let overwrites = guildstore::effective_overwrites(&state.pool, &id).await?;
        let bits = perms::channel_permissions(&member.context(), &overwrites);
        if perms::has(bits, perms::VIEW_CHANNEL) && perms::has(bits, perms::READ_MESSAGE_HISTORY) {
            readable.push(id);
        }
    }
    let visible: Vec<String> = match &q.channel_id {
        Some(c) if readable.contains(c) => vec![c.clone()],
        Some(_) => return Err(ApiError::NotFound("channel not found".into())),
        None => readable,
    };
    if visible.is_empty() {
        return Ok(Json(
            json!({ "results": [], "count": 0, "total": 0, "has_more": false }),
        ));
    }

    let limit = q.limit.unwrap_or(25).clamp(1, 100);
    let offset = q.offset.unwrap_or(0).max(0);
    let placeholders = visible.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let id_col = if text.is_some() { "message_id" } else { "id" };
    let mut filters = String::new();
    let mut filter_binds: Vec<String> = Vec::new();
    if let Some(author) = author {
        filters.push_str(" AND author_id = ?");
        filter_binds.push(author.to_string());
    }
    if let Some(user) = mentions {
        filters.push_str(&format!(
            " AND {id_col} IN (SELECT message_id FROM message_mentions WHERE user_id = ?)"
        ));
        filter_binds.push(user.to_string());
    }
    if let Some(pred) = has_sql {
        if text.is_some() {
            filters.push_str(&format!(" AND message_id IN (SELECT id FROM messages WHERE {pred})"));
        } else {
            filters.push_str(&format!(" AND {pred}"));
        }
    }

    let sql = match text {
        Some(_) => format!(
            "SELECT message_id, channel_id, author_id, content FROM messages_fts \
             WHERE messages_fts MATCH ? AND guild_id = ? AND channel_id IN ({placeholders}) \
             {filters} ORDER BY message_id {direction} LIMIT ? OFFSET ?"
        ),
        None => format!(
            "SELECT id, channel_id, author_id, content FROM messages \
             WHERE guild_id = ? AND deleted = 0 AND channel_id IN ({placeholders}) \
             {filters} ORDER BY id {direction} LIMIT ? OFFSET ?"
        ),
    };
    let count_sql = match text {
        Some(_) => format!(
            "SELECT COUNT(*) FROM messages_fts \
             WHERE messages_fts MATCH ? AND guild_id = ? AND channel_id IN ({placeholders}) \
             {filters}"
        ),
        None => format!(
            "SELECT COUNT(*) FROM messages \
             WHERE guild_id = ? AND deleted = 0 AND channel_id IN ({placeholders}) {filters}"
        ),
    };
    let mut counter = sqlx::query_scalar::<_, i64>(&count_sql);
    if let Some(text) = text {
        counter = counter.bind(format!("\"{}\"", text.replace('"', "\"\"")));
    }
    counter = counter.bind(&guild_id);
    for c in &visible {
        counter = counter.bind(c);
    }
    for b in &filter_binds {
        counter = counter.bind(b);
    }
    let total: i64 = counter.fetch_one(&state.pool).await?;

    let mut query = sqlx::query_as::<_, (String, String, String, String)>(&sql);
    if let Some(text) = text {
        query = query.bind(format!("\"{}\"", text.replace('"', "\"\"")));
    }
    query = query.bind(&guild_id);
    for c in &visible {
        query = query.bind(c);
    }
    for b in &filter_binds {
        query = query.bind(b);
    }
    let rows = query.bind(limit).bind(offset).fetch_all(&state.pool).await?;

    let view = crate::routes::messages::MessageView::for_guild(&state, &auth, &guild_id).await?;
    let mut results = Vec::new();
    for (message_id, channel_id, author_id, content) in rows {
        let live: Option<crate::routes::messages::MessageRow> = sqlx::query_as(
            "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, \
             sticker, reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
             WHERE id = ? AND deleted = 0",
        )
        .bind(&message_id)
        .fetch_optional(&state.pool)
        .await?;
        match live {
            Some(row) => results.push(crate::routes::messages::message_json(&row, &view)),
            None => {
                let cold: Option<String> = sqlx::query_scalar(
                    "SELECT id FROM cold_segments WHERE channel_id = ? AND first_id <= ? AND last_id >= ?",
                )
                .bind(&channel_id)
                .bind(&message_id)
                .bind(&message_id)
                .fetch_optional(&state.pool)
                .await?;
                let Some(segment) = cold else { continue };
                let mut hit = json!({
                    "id": message_id, "channel_id": channel_id, "guild_id": guild_id,
                    "author": author_id, "content": content,
                    "archived": true, "segment": segment,
                });
                view.apply(&mut hit);
                results.push(hit);
            }
        }
    }
    let has_more = offset + limit < total;
    Ok(Json(json!({
        "results": results,
        "count": results.len(),
        "total": total,
        "has_more": has_more,
    })))
}

pub async fn index_message(
    state: &AppState,
    id: &str,
    channel_id: &str,
    guild_id: &str,
    author_id: &str,
    content: &str,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO messages_fts (content, message_id, channel_id, guild_id, author_id) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(content)
    .bind(id)
    .bind(channel_id)
    .bind(guild_id)
    .bind(author_id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn reindex_message(state: &AppState, id: &str, content: &str) -> ApiResult<()> {
    sqlx::query("UPDATE messages_fts SET content = ? WHERE message_id = ?")
        .bind(content)
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

pub async fn unindex_message(state: &AppState, id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM messages_fts WHERE message_id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM reactions WHERE message_id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM message_mentions WHERE message_id = ?")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(())
}
