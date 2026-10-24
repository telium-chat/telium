
use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events;
use crate::gateway::events::{Event, INTENT_GUILD_MESSAGES, INTENT_GUILD_TYPING};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use telium_protocol::interactivity;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub fn redact_message_content(value: &mut Value) {
    let Some(obj) = value.as_object_mut() else { return };
    if let Some(opening) = obj.get_mut("opening") {
        redact_message_content(opening);
    }
    if !obj.contains_key("content") {
        return;
    }
    obj.insert("content".into(), Value::String(String::new()));
    for key in ["attachments"] {
        if obj.contains_key(key) {
            obj.insert(key.into(), json!([]));
        }
    }
    for key in ["sticker", "author_signature"] {
        if obj.contains_key(key) {
            obj.insert(key.into(), Value::Null);
        }
    }
    obj.insert("content_redacted".into(), Value::Bool(true));
}

pub struct MessageView {
    content_visible: bool,
}

impl MessageView {
    pub async fn for_guild(
        state: &AppState,
        auth: &GuildAuth,
        guild_id: &str,
    ) -> ApiResult<Self> {
        if !auth.is_bot {
            return Ok(Self { content_visible: true });
        }
        let Some(application_id) = auth.application_id.as_deref() else {
            return Ok(Self { content_visible: false });
        };
        let row: Option<(i64, i64)> = sqlx::query_as(
            "SELECT bot_allowed_intents, banned FROM members \
             WHERE guild_id = ? AND user_id = ? AND bot_application_id = ? \
               AND bot_application_origin = ?",
        )
        .bind(guild_id)
        .bind(&auth.user_id)
        .bind(application_id)
        .bind(&auth.home_domain)
        .fetch_optional(&state.pool)
        .await?;
        let content_visible = match row {
            Some((granted, banned)) if banned == 0 => {
                let effective = (granted as u64)
                    & auth.bot_allowed_intents
                    & events::BOT_INTENTS;
                effective & events::INTENT_MESSAGE_CONTENT != 0
            }
            _ => false,
        };
        Ok(Self { content_visible })
    }

    pub const fn unrestricted() -> Self {
        Self { content_visible: true }
    }

    pub fn apply(&self, value: &mut Value) {
        if !self.content_visible {
            redact_message_content(value);
        }
    }

    pub fn apply_all(&self, values: &mut [Value]) {
        if self.content_visible {
            return;
        }
        for value in values {
            redact_message_content(value);
        }
    }
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn history(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Query(q): Query<HistoryQuery>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) = guildstore::require_channel_perm(
        &state,
        &channel_id,
        &auth.user_id,
        perms::READ_MESSAGE_HISTORY,
    )
    .await?;
    let view = MessageView::for_guild(&state, &auth, &ch.guild_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 100);

    let scanned_backwards = q.after.is_none() || q.before.is_some();
    let mut rows: Vec<MessageRow> = match (&q.before, &q.after) {
        (Some(before), _) => sqlx::query_as(
            "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, \
             sticker, reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
             WHERE channel_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?",
        )
        .bind(&channel_id).bind(before).bind(limit).fetch_all(&state.pool).await?,
        (None, Some(after)) => sqlx::query_as(
            "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, \
             sticker, reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
             WHERE channel_id = ? AND deleted = 0 AND id > ? ORDER BY id ASC LIMIT ?",
        )
        .bind(&channel_id).bind(after).bind(limit).fetch_all(&state.pool).await?,
        (None, None) => sqlx::query_as(
            "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, \
             sticker, reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
             WHERE channel_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
        )
        .bind(&channel_id).bind(limit).fetch_all(&state.pool).await?,
    };

    if scanned_backwards {
        rows.reverse();
    }

    if rows.is_empty() {
        if let Some(before) = &q.before {
            let mut cold =
                crate::cold::page_before(&state, &channel_id, before, limit as usize).await?;
            if !cold.is_empty() {
                cold.reverse();
                view.apply_all(&mut cold);
                return Ok(Json(json!({ "messages": cold, "archived": true })));
            }
        }
    }

    let mut messages = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut m = message_json(row, &view);
        m["reactions"] = crate::routes::social::reactions_for(&state, &row.id, &auth.user_id).await?;
        messages.push(m);
    }
    Ok(Json(json!({ "messages": messages })))
}

#[derive(sqlx::FromRow)]
pub struct MessageRow {
    pub id: String,
    pub channel_id: String,
    pub guild_id: String,
    pub author_id: String,
    pub content: String,
    pub attachments: String,
    pub components: String,
    pub cards: String,
    pub sticker: Option<String>,
    pub reply_to: Option<String>,
    pub thread_id: Option<String>,
    pub author_signature: Option<String>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
}

pub fn message_json(m: &MessageRow, view: &MessageView) -> Value {
    let mut out = json!({
        "id": m.id,
        "channel_id": m.channel_id,
        "guild_id": m.guild_id,
        "author": m.author_id,
        "content": m.content,
        "attachments": serde_json::from_str::<Value>(&m.attachments).unwrap_or(json!([])),
        "components": serde_json::from_str::<Value>(&m.components).unwrap_or(json!([])),
        "cards": serde_json::from_str::<Value>(&m.cards).unwrap_or(json!([])),
        "sticker": m.sticker.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()),
        "reply_to": m.reply_to,
        "thread_id": m.thread_id,
        "author_signature": m.author_signature,
        "created_at": m.created_at,
        "edited_at": m.edited_at,
    });
    view.apply(&mut out);
    out
}

async fn dispatch_message_json(state: &AppState, m: &MessageRow) -> ApiResult<Value> {
    let mut out = message_json(m, &MessageView::unrestricted());
    if let Some(reply_to) = m.reply_to.as_deref() {
        let reply_author: Option<String> = sqlx::query_scalar(
            "SELECT author_id FROM messages              WHERE id = ? AND channel_id = ? AND guild_id = ? AND deleted = 0",
        )
        .bind(reply_to)
        .bind(&m.channel_id)
        .bind(&m.guild_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(reply_author) = reply_author {
            out["reply_author"] = json!(reply_author);
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct SendMessage {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<Value>,
    #[serde(default)]
    pub sticker: Option<Value>,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub components: Value,
    #[serde(default)]
    pub cards: Value,
    #[serde(default)]
    pub author_signature: Option<String>,
    #[serde(default)]
    pub nonce: Option<String>,
}

pub async fn send(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<SendMessage>,
) -> ApiResult<Json<Value>> {
    let (ch, member, perms_bits) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::SEND_MESSAGES).await?;
    guildstore::ensure_authoritative(&state, &ch.guild_id).await?;
    if ch.kind == "category" {
        return Err(ApiError::BadRequest("cannot post messages in this channel type".into()));
    }
    // Idempotency claim goes after the permission check and before slow mode/AutoMod/hold.
    let ticket = match req.nonce.as_deref() {
        None => None,
        Some(nonce) => {
            crate::sendonce::validate(nonce)?;
            match state.send_once.claim(&auth.user_id, &channel_id, nonce) {
                crate::sendonce::Claim::Fresh(ticket) => Some(ticket),
                crate::sendonce::Claim::Busy => {
                    return Err(ApiError::TryAgain(
                        "that message is being sent right now; this is the same send arriving \
                         twice, and answering it would mean posting it twice"
                            .into(),
                    ))
                }
                crate::sendonce::Claim::Repeat(outcome) => return repeat(&state, outcome).await,
            }
        }
    };
    if req.content.chars().count() > state.cfg.limits.max_message_len {
        return Err(ApiError::BadRequest(format!(
            "messages are limited to {} characters",
            state.cfg.limits.max_message_len
        )));
    }
    if req.content.trim().is_empty()
        && req.attachments.is_empty()
        && req.sticker.is_none()
        && !has_entries(&req.components)
        && !has_entries(&req.cards)
    {
        return Err(ApiError::BadRequest(
            "message must have content, an attachment, a sticker, a card or components".into(),
        ));
    }
    if let Some(sticker) = &req.sticker {
        validate_sticker(sticker)?;
    }
    let authored_by = application_author(&auth);
    let (components, cards) =
        prepare_app_payload(&state, &ch.guild_id, &req.components, &req.cards, authored_by.as_ref())
            .await?;
    require_embed_links(perms_bits, &cards)?;
    if !req.attachments.is_empty() {
        if !perms::has(perms_bits, perms::ATTACH_FILES) {
            return Err(crate::guildstore::missing_permission(perms::ATTACH_FILES));
        }
        if req.attachments.len() > state.cfg.limits.max_attachments_per_message {
            return Err(ApiError::BadRequest("too many attachments".into()));
        }
        for a in &req.attachments {
            validate_attachment(&state, &ch.guild_id, a).await?;
        }
    }

    if ch.kind == "thread" {
        let locked: i64 = sqlx::query_scalar("SELECT locked FROM threads WHERE id = ?")
            .bind(&channel_id)
            .fetch_one(&state.pool)
            .await?;
        if locked != 0 && !perms::has(perms_bits, perms::MANAGE_MESSAGES) {
            return Err(ApiError::Forbidden("this thread is locked".into()));
        }
    }
    if (req.content.contains("@everyone") || req.content.contains("@here"))
        && !perms::has(perms_bits, perms::MENTION_EVERYONE)
    {
        return Err(crate::guildstore::missing_permission(perms::MENTION_EVERYONE));
    }

    if ch.slowmode > 0 && !perms::has(perms_bits, perms::MANAGE_MESSAGES) {
        let last: Option<i64> = sqlx::query_scalar(
            "SELECT MAX(created_at) FROM messages WHERE channel_id = ? AND author_id = ? AND deleted = 0",
        )
        .bind(&channel_id).bind(&auth.user_id).fetch_one(&state.pool).await?;
        if let Some(last) = last {
            let wait = ch.slowmode * 1000 - (now_ms() - last);
            if wait > 0 {
                return Err(ApiError::RateLimited(format!("slow mode: try again in {}s", wait / 1000 + 1)));
            }
        }
    }

    if let Some(verdict) =
        crate::routes::moderation::evaluate(&state, &ch.guild_id, &channel_id, &member, perms_bits, &req.content)
            .await?
    {
        return Err(ApiError::Forbidden(format!(
            "blocked by AutoMod rule {:?}: {}",
            verdict.rule_name, verdict.reason
        )));
    }
    if crate::routes::moderation::should_hold(&state, &ch.guild_id, &auth.user_id).await? {
        let payload = json!({
            "content": req.content, "attachments": req.attachments,
            "sticker": req.sticker,
            "reply_to": req.reply_to, "thread_id": req.thread_id,
        });
        const HELD_REASON: &str = "new member: held for review";
        let held = crate::routes::moderation::hold(
            &state, &ch.guild_id, &channel_id, &auth.user_id, &payload, HELD_REASON,
        )
        .await?;
        if let (Some(ticket), Some(id)) = (ticket, held.get("id").and_then(Value::as_str)) {
            ticket.settle(crate::sendonce::Outcome::Held {
                id: id.to_string(),
                reason: HELD_REASON.into(),
            });
        }
        return Ok(Json(held));
    }

    let id = ulid();
    let attachments = serde_json::to_string(&req.attachments).unwrap_or_else(|_| "[]".into());
    let sticker = req.sticker.as_ref().map(ToString::to_string);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, \
         components, cards, sticker, reply_to, thread_id, author_signature, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&channel_id).bind(&ch.guild_id).bind(&auth.user_id)
    .bind(&req.content).bind(&attachments).bind(&components).bind(&cards)
    .bind(&sticker).bind(&req.reply_to).bind(&req.thread_id)
    .bind(&req.author_signature).bind(now)
    .execute(&state.pool).await?;
    // The claim must stand from here or a retry duplicates the message.
    if let Some(ticket) = ticket {
        ticket.settle(crate::sendonce::Outcome::Sent(id.clone()));
    }

    let row = MessageRow {
        id: id.clone(),
        channel_id: channel_id.clone(),
        guild_id: ch.guild_id.clone(),
        author_id: auth.user_id.clone(),
        content: req.content,
        attachments,
        components,
        cards,
        sticker,
        reply_to: req.reply_to,
        thread_id: req.thread_id,
        author_signature: req.author_signature,
        created_at: now,
        edited_at: None,
    };
    after_insert(&state, &row, perms_bits).await?;

    let payload = dispatch_message_json(&state, &row).await?;
    state.hub.publish(Event::in_channel(
        "MESSAGE_CREATE", ch.guild_id, channel_id, INTENT_GUILD_MESSAGES, payload.clone(),
    )).await;
    if ch.kind == "announcement" {
        crate::routes::social::crosspost(&state, &row.channel_id, &payload).await?;
    }
    Ok(Json(payload))
}

async fn repeat(state: &AppState, outcome: crate::sendonce::Outcome) -> ApiResult<Json<Value>> {
    let id = match outcome {
        crate::sendonce::Outcome::Held { id, reason } => {
            return Ok(Json(json!({ "held": true, "id": id, "reason": reason })))
        }
        crate::sendonce::Outcome::Sent(id) => id,
    };
    let row: Option<MessageRow> = sqlx::query_as(
        "SELECT id, channel_id, guild_id, author_id, content, attachments, components, cards, \
         sticker, reply_to, thread_id, author_signature, created_at, edited_at FROM messages \
         WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(row) = row else {
        return Err(ApiError::NotFound(
            "that message was sent and has since been removed".into(),
        ));
    };
    Ok(Json(dispatch_message_json(state, &row).await?))
}

pub(crate) async fn post_opening(
    state: &AppState,
    channel_id: &str,
    guild_id: &str,
    author_id: &str,
    content: &str,
    attachments: &[Value],
    author_perms: u64,
) -> ApiResult<Value> {
    if !attachments.is_empty() {
        if !perms::has(author_perms, perms::ATTACH_FILES) {
            return Err(crate::guildstore::missing_permission(perms::ATTACH_FILES));
        }
        if attachments.len() > state.cfg.limits.max_attachments_per_message {
            return Err(ApiError::BadRequest("too many attachments".into()));
        }
    }
    for a in attachments {
        validate_attachment(state, guild_id, a).await?;
    }
    let id = ulid();
    let now = now_ms();
    let attachments = serde_json::to_string(attachments).unwrap_or_else(|_| "[]".into());
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, \
         created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(channel_id).bind(guild_id).bind(author_id)
    .bind(content).bind(&attachments).bind(now)
    .execute(&state.pool).await?;

    let row = MessageRow {
        id,
        channel_id: channel_id.to_string(),
        guild_id: guild_id.to_string(),
        author_id: author_id.to_string(),
        content: content.to_string(),
        components: "[]".to_string(),
        cards: "[]".to_string(),
        attachments,
        sticker: None,
        reply_to: None,
        thread_id: None,
        author_signature: None,
        created_at: now,
        edited_at: None,
    };
    after_insert(state, &row, author_perms).await?;
    let payload = dispatch_message_json(state, &row).await?;
    state.hub.publish(Event::in_channel(
        "MESSAGE_CREATE", guild_id.to_string(), channel_id.to_string(),
        INTENT_GUILD_MESSAGES, payload.clone(),
    )).await;
    Ok(payload)
}

async fn after_insert(state: &AppState, row: &MessageRow, author_perms: u64) -> ApiResult<()> {
    crate::metrics::Metrics::bump(&state.metrics.messages_guild, 1);
    crate::routes::social::index_message(
        state, &row.id, &row.channel_id, &row.guild_id, &row.author_id, &row.content,
    )
    .await?;
    let mentioned =
        crate::routes::social::record_mentions(
            state, &row.id, &row.channel_id, &row.guild_id, &row.content, author_perms,
        )
        .await?;
    crate::routes::social::touch_thread(state, &row.channel_id).await?;
    crate::routes::push::wake_mentioned(state, row, &mentioned).await;
    Ok(())
}

pub async fn publish_held(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
    author_id: &str,
    payload: &Value,
) -> ApiResult<Value> {
    let id = ulid();
    let now = now_ms();
    let attachments = payload
        .get("attachments")
        .cloned()
        .unwrap_or(json!([]))
        .to_string();
    let content = payload.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    let sticker = payload.get("sticker").filter(|s| !s.is_null()).map(ToString::to_string);
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, sticker, \
         reply_to, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(channel_id).bind(guild_id).bind(author_id)
    .bind(&content).bind(&attachments).bind(&sticker)
    .bind(payload.get("reply_to").and_then(Value::as_str))
    .bind(payload.get("thread_id").and_then(Value::as_str))
    .bind(now)
    .execute(&state.pool).await?;

    let row = MessageRow {
        id,
        channel_id: channel_id.to_string(),
        guild_id: guild_id.to_string(),
        author_id: author_id.to_string(),
        content,
        attachments,
        components: "[]".to_string(),
        cards: "[]".to_string(),
        sticker,
        reply_to: payload.get("reply_to").and_then(Value::as_str).map(str::to_string),
        thread_id: payload.get("thread_id").and_then(Value::as_str).map(str::to_string),
        author_signature: None,
        created_at: now,
        edited_at: None,
    };
    let author_perms = match guildstore::require_channel_perm(
        state, channel_id, author_id, perms::VIEW_CHANNEL,
    )
    .await
    {
        Ok((_, _, p)) => p,
        Err(_) => 0,
    };
    after_insert(state, &row, author_perms).await?;
    let out = dispatch_message_json(state, &row).await?;
    state.hub.publish(Event::in_channel(
        "MESSAGE_CREATE", guild_id.to_string(), channel_id.to_string(),
        INTENT_GUILD_MESSAGES, out.clone(),
    )).await;
    Ok(out)
}

async fn validate_attachment(state: &AppState, guild_id: &str, a: &Value) -> ApiResult<()> {
    for field in ["origin", "hash", "filename", "mime"] {
        if !a.get(field).map(Value::is_string).unwrap_or(false) {
            return Err(ApiError::BadRequest(format!("attachment is missing string field {field}")));
        }
    }
    if !a.get("size").map(|v| v.is_i64() || v.is_u64()).unwrap_or(false) {
        return Err(ApiError::BadRequest("attachment is missing numeric size".into()));
    }
    let origin = a["origin"].as_str().unwrap_or_default().to_string();

    if a.get("external").and_then(Value::as_bool) == Some(true) {
        let url = a
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("external attachment is missing url".into()))?;
        let parsed = url::Url::parse(url)
            .map_err(|_| ApiError::BadRequest("external attachment has an invalid url".into()))?;
        if parsed.scheme() != "https"
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.host_str() != Some(origin.as_str())
        {
            return Err(ApiError::BadRequest("external attachment must use its HTTPS origin".into()));
        }
        return Ok(());
    }

    crate::federation::media::check_origin_allowed(state, guild_id, &origin).await?;

    if origin != state.cfg.server_name && state.cfg.federation.enabled {
        let answer = crate::federation::post_signed(
            state,
            &origin,
            "/_telium/v1/media/authorize",
            &json!({
                "hash": a["hash"],
                "capability": a.get("capability"),
                "guild_id": guild_id,
            }),
        )
        .await?;
        if !answer.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            return Err(ApiError::Forbidden(format!(
                "{origin} did not authorize that reference ({})",
                answer.get("reason").and_then(Value::as_str).unwrap_or("refused")
            )));
        }
    }
    Ok(())
}

fn validate_sticker(sticker: &Value) -> ApiResult<()> {
    for field in ["id", "name", "origin"] {
        let value = sticker
            .get(field)
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest(format!("sticker is missing string field {field}")))?;
        if value.is_empty() || value.len() > 128 {
            return Err(ApiError::BadRequest(format!("sticker field {field} is out of range")));
        }
    }
    Ok(())
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct AppAuthorship {
    pub application_id: String,
    pub application_origin: String,
}

pub(crate) fn application_author(auth: &GuildAuth) -> Option<AppAuthorship> {
    if !auth.is_bot {
        return None;
    }
    let application_id = auth.application_id.clone()?;
    Some(AppAuthorship { application_id, application_origin: auth.home_domain.clone() })
}

pub(crate) fn has_entries(value: &Value) -> bool {
    value.as_array().is_some_and(|a| !a.is_empty())
}

pub(crate) fn require_embed_links(perms_bits: u64, cards: &str) -> ApiResult<()> {
    if cards == "[]" || cards.is_empty() {
        return Ok(());
    }
    if !perms::has(perms_bits, perms::EMBED_LINKS) {
        return Err(ApiError::Forbidden("missing permission EMBED_LINKS".into()));
    }
    Ok(())
}

pub(crate) async fn prepare_app_payload(
    state: &AppState,
    guild_id: &str,
    components: &Value,
    cards: &Value,
    author: Option<&AppAuthorship>,
) -> ApiResult<(String, String)> {
    if !has_entries(components) && !has_entries(cards) {
        return Ok(("[]".to_string(), "[]".to_string()));
    }
    if author.is_none() {
        return Err(ApiError::Forbidden(
            "only an application may attach components or cards to a message".into(),
        ));
    }
    let rows = interactivity::parse_components(components)
        .map_err(|e| ApiError::Unprocessable(format!("components: {e}")))?;
    interactivity::validate_components(&rows, interactivity::TreeContext::Message)
        .map_err(|e| ApiError::Unprocessable(e.to_string()))?;

    let parsed = interactivity::parse_cards(cards)
        .map_err(|e| ApiError::Unprocessable(format!("cards: {e}")))?;
    interactivity::validate_cards(&parsed)
        .map_err(|e| ApiError::Unprocessable(e.to_string()))?;

    let mut resolved = Vec::with_capacity(parsed.len());
    for card in &parsed {
        resolved.push(resolve_card(state, guild_id, card).await?);
    }

    let components_json = serde_json::to_string(&rows)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialising components: {e}")))?;
    let cards_json = serde_json::to_string(&resolved)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialising cards: {e}")))?;
    Ok((components_json, cards_json))
}

async fn resolve_card(state: &AppState, guild_id: &str, card: &interactivity::Card) -> ApiResult<Value> {
    let mut out = serde_json::to_value(card)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialising card: {e}")))?;
    for field in ["image", "thumbnail"] {
        if let Some(image) = card_image(card, field) {
            out[field] = resolve_card_image(state, guild_id, image).await?;
        }
    }
    if let Some(author) = &card.author {
        if let Some(icon) = &author.icon {
            out["author"]["icon"] = resolve_card_image(state, guild_id, icon).await?;
        }
    }
    if let Some(footer) = &card.footer {
        if let Some(icon) = &footer.icon {
            out["footer"]["icon"] = resolve_card_image(state, guild_id, icon).await?;
        }
    }
    Ok(out)
}

fn card_image<'a>(
    card: &'a interactivity::Card,
    field: &str,
) -> Option<&'a interactivity::CardImage> {
    match field {
        "image" => card.image.as_ref(),
        "thumbnail" => card.thumbnail.as_ref(),
        _ => None,
    }
}

async fn resolve_card_image(
    state: &AppState,
    guild_id: &str,
    image: &interactivity::CardImage,
) -> ApiResult<Value> {
    match image {
        interactivity::CardImage::Media { origin, hash, width, height } => {
            if hash.is_empty() || hash.len() > 128 || origin.is_empty() || origin.len() > 253 {
                return Err(ApiError::BadRequest("card image reference is malformed".into()));
            }
            crate::federation::media::check_origin_allowed(state, guild_id, origin).await?;
            if origin != &state.cfg.server_name && state.cfg.federation.enabled {
                let answer = crate::federation::post_signed(
                    state,
                    origin,
                    "/_telium/v1/media/authorize",
                    &json!({ "hash": hash, "guild_id": guild_id }),
                )
                .await?;
                if !answer.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    return Err(ApiError::Forbidden(format!(
                        "{origin} did not authorize that card image"
                    )));
                }
            }
            Ok(json!({
                "kind": "media", "origin": origin, "hash": hash,
                "width": width, "height": height,
            }))
        }
        interactivity::CardImage::Camo { camo, width, height } => {
            // Hash must already be cached, or someone else's unfurl could smuggle in a chosen image.
            let known: Option<String> = sqlx::query_scalar(
                "SELECT hash FROM media_cache WHERE origin = 'camo' AND hash = ?",
            )
            .bind(camo)
            .fetch_optional(&state.pool)
            .await?;
            if known.is_none() {
                return Err(ApiError::BadRequest(
                    "card image names a camo hash this server has not cached".into(),
                ));
            }
            Ok(json!({
                "kind": "camo",
                "url": format!("{}/_telium/v1/camo/{camo}", state.cfg.public_base_url),
                "width": width, "height": height,
            }))
        }
    }
}

pub(crate) async fn insert_application_message(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
    author_id: &str,
    content: &str,
    components: &str,
    cards: &str,
    reply_to: Option<&str>,
    author_perms: u64,
) -> ApiResult<Value> {
    require_embed_links(author_perms, cards)?;
    let id = ulid();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, \
         components, cards, reply_to, created_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)",
    )
    .bind(&id).bind(channel_id).bind(guild_id).bind(author_id)
    .bind(content).bind(components).bind(cards).bind(reply_to).bind(now)
    .execute(&state.pool).await?;

    let row = MessageRow {
        id,
        channel_id: channel_id.to_string(),
        guild_id: guild_id.to_string(),
        author_id: author_id.to_string(),
        content: content.to_string(),
        attachments: "[]".to_string(),
        components: components.to_string(),
        cards: cards.to_string(),
        sticker: None,
        reply_to: reply_to.map(str::to_string),
        thread_id: None,
        author_signature: None,
        created_at: now,
        edited_at: None,
    };
    after_insert(state, &row, author_perms).await?;
    let payload = dispatch_message_json(state, &row).await?;
    state.hub.publish(Event::in_channel(
        "MESSAGE_CREATE", guild_id.to_string(), channel_id.to_string(),
        INTENT_GUILD_MESSAGES, payload.clone(),
    )).await;
    Ok(payload)
}

pub(crate) async fn update_application_message(
    state: &AppState,
    message_id: &str,
    channel_id: &str,
    guild_id: &str,
    content: Option<&str>,
    components: &str,
    cards: &str,
) -> ApiResult<Value> {
    match content {
        Some(content) => {
            sqlx::query(
                "UPDATE messages SET content = ?, components = ?, cards = ? \
                 WHERE id = ? AND deleted = 0",
            )
            .bind(content).bind(components).bind(cards).bind(message_id)
            .execute(&state.pool).await?;
            crate::routes::social::reindex_message(state, message_id, content).await?;
        }
        None => {
            sqlx::query(
                "UPDATE messages SET components = ?, cards = ? WHERE id = ? AND deleted = 0",
            )
            .bind(components).bind(cards).bind(message_id)
            .execute(&state.pool).await?;
        }
    }
    let mut payload = json!({
        "id": message_id, "channel_id": channel_id, "guild_id": guild_id,
        "components": serde_json::from_str::<Value>(components).unwrap_or(json!([])),
        "cards": serde_json::from_str::<Value>(cards).unwrap_or(json!([])),
    });
    if let Some(content) = content {
        payload["content"] = json!(content);
    }
    state.hub.publish(Event::in_channel(
        "MESSAGE_UPDATE", guild_id.to_string(), channel_id.to_string(),
        INTENT_GUILD_MESSAGES, payload.clone(),
    )).await;
    Ok(payload)
}

#[derive(Deserialize)]
pub struct EditMessage {
    pub content: String,
    #[serde(default)]
    pub components: Value,
    #[serde(default)]
    pub cards: Value,
}

pub async fn edit(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, message_id)): Path<(String, String)>,
    Json(req): Json<EditMessage>,
) -> ApiResult<Json<Value>> {
    let (_, _, perms_bits) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL)
            .await?;
    let author: Option<String> = sqlx::query_scalar(
        "SELECT author_id FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0",
    )
    .bind(&message_id).bind(&channel_id).fetch_optional(&state.pool).await?;
    let author = author.ok_or_else(|| ApiError::NotFound("message not found".into()))?;
    if author != auth.user_id {
        return Err(ApiError::Forbidden("only the author may edit a message".into()));
    }
    if req.content.chars().count() > state.cfg.limits.max_message_len {
        return Err(ApiError::BadRequest("message too long".into()));
    }

    let ch = guildstore::channel(&state, &channel_id).await?;
    let authored_by = application_author(&auth);
    let touches_payload = !req.components.is_null() || !req.cards.is_null();
    let payload_columns = if touches_payload {
        Some(
            prepare_app_payload(
                &state, &ch.guild_id, &req.components, &req.cards, authored_by.as_ref(),
            )
            .await?,
        )
    } else {
        None
    };
    if let Some((_, cards)) = &payload_columns {
        require_embed_links(perms_bits, cards)?;
    }

    let now = now_ms();
    match &payload_columns {
        Some((components, cards)) => {
            sqlx::query(
                "UPDATE messages SET content = ?, components = ?, cards = ?, edited_at = ?, \
                 author_signature = NULL WHERE id = ?",
            )
            .bind(&req.content).bind(components).bind(cards).bind(now).bind(&message_id)
            .execute(&state.pool).await?;
        }
        None => {
            sqlx::query(
                "UPDATE messages SET content = ?, edited_at = ?, author_signature = NULL WHERE id = ?",
            )
            .bind(&req.content).bind(now).bind(&message_id)
            .execute(&state.pool).await?;
        }
    }

    crate::routes::social::reindex_message(&state, &message_id, &req.content).await?;

    let mut payload = json!({
        "id": message_id, "channel_id": channel_id, "guild_id": ch.guild_id,
        "content": req.content, "edited_at": now,
    });
    if let Some((components, cards)) = &payload_columns {
        payload["components"] = serde_json::from_str::<Value>(components).unwrap_or(json!([]));
        payload["cards"] = serde_json::from_str::<Value>(cards).unwrap_or(json!([]));
    }
    state.hub.publish(Event::in_channel(
        "MESSAGE_UPDATE", ch.guild_id, channel_id, INTENT_GUILD_MESSAGES, payload.clone(),
    )).await;
    Ok(Json(payload))
}

pub async fn delete(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, message_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (ch, _m, perms_bits) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::VIEW_CHANNEL).await?;
    let author: Option<String> = sqlx::query_scalar(
        "SELECT author_id FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0",
    )
    .bind(&message_id).bind(&channel_id).fetch_optional(&state.pool).await?;
    let author = author.ok_or_else(|| ApiError::NotFound("message not found".into()))?;

    if author != auth.user_id && !perms::has(perms_bits, perms::MANAGE_MESSAGES) {
        return Err(crate::guildstore::missing_permission(perms::MANAGE_MESSAGES));
    }

    // Blank the columns: archived copies are served without a deleted = 0 filter.
    sqlx::query(
        "UPDATE messages SET deleted = 1, content = '', attachments = '[]', \
         components = '[]', cards = '[]', sticker = NULL WHERE id = ?",
    )
        .bind(&message_id).execute(&state.pool).await?;
    crate::routes::social::unindex_message(&state, &message_id).await?;
    sqlx::query("DELETE FROM pins WHERE message_id = ?")
        .bind(&message_id).execute(&state.pool).await?;

    if author != auth.user_id {
        guildstore::audit(&state.pool, &ch.guild_id, &auth.user_id, "message.delete",
            Some(&message_id), json!({ "author": author })).await?;
    }
    state.hub.publish(Event::in_channel(
        "MESSAGE_DELETE", ch.guild_id, channel_id.clone(), INTENT_GUILD_MESSAGES,
        json!({ "id": message_id, "channel_id": channel_id }),
    )).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn typing(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (ch, _, _) =
        guildstore::require_channel_perm(&state, &channel_id, &auth.user_id, perms::SEND_MESSAGES).await?;
    state.hub.publish(Event::in_channel(
        "TYPING_START", ch.guild_id, channel_id.clone(), INTENT_GUILD_TYPING,
        json!({ "channel_id": channel_id, "user_id": auth.user_id, "timestamp": now_ms() }),
    )).await;
    Ok(Json(json!({ "ok": true })))
}
