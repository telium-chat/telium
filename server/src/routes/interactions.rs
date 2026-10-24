
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use telium_protocol::interactivity;

use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::Event;
use crate::gateway::local_apps::{self, LocalInteraction};
use crate::guildstore;
use crate::perms;
use crate::routes::messages::{self, AppAuthorship};
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token, ulid};

const TOKEN_TTL_MS: i64 = 15 * 60 * 1000;

const EPHEMERAL_TTL_MS: i64 = 24 * 60 * 60 * 1000;

const TOKEN_BYTES: usize = 32;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/_telium/v1/channels/{channel_id}/messages/{message_id}/interact",
            post(press),
        )
        .route(
            "/_telium/v1/channels/{channel_id}/ephemeral/{ephemeral_id}/interact",
            post(press_ephemeral),
        )
        .route(
            "/_telium/v1/interactions/{id}/{token}/callback",
            post(callback).patch(follow_up),
        )
        .route("/_telium/v1/interactions/{id}/modal", post(modal_submit))
}

struct Interaction {
    id: String,
    kind: String,
    application_id: String,
    application_origin: String,
    guild_id: String,
    channel_id: String,
    message_id: Option<String>,
    ephemeral_id: Option<String>,
    user_id: String,
    expires_at: i64,
    responded_at: Option<i64>,
    response_kind: Option<String>,
    deferred_ephemeral: bool,
    response_message_id: Option<String>,
    modal_custom_id: Option<String>,
    modal_components: Option<String>,
}

type InteractionRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    i64,
    Option<i64>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

async fn load_by_token(state: &AppState, id: &str, token: &str) -> ApiResult<Interaction> {
    let row: Option<InteractionRow> = sqlx::query_as(
        "SELECT id, kind, application_id, application_origin, guild_id, channel_id, message_id, \
         ephemeral_id, user_id, expires_at, responded_at, response_kind, deferred_ephemeral, \
         response_message_id, modal_custom_id, modal_components \
         FROM interactions WHERE token_hash = ?",
    )
    .bind(hash_token(token))
    .fetch_optional(&state.pool)
    .await?;

    let row = row.ok_or_else(|| ApiError::NotFound("no such interaction".into()))?;
    let interaction = Interaction {
        id: row.0,
        kind: row.1,
        application_id: row.2,
        application_origin: row.3,
        guild_id: row.4,
        channel_id: row.5,
        message_id: row.6,
        ephemeral_id: row.7,
        user_id: row.8,
        expires_at: row.9,
        responded_at: row.10,
        response_kind: row.11,
        deferred_ephemeral: row.12 != 0,
        response_message_id: row.13,
        modal_custom_id: row.14,
        modal_components: row.15,
    };
    if interaction.id != id {
        return Err(ApiError::NotFound("no such interaction".into()));
    }
    if interaction.expires_at <= now_ms() {
        return Err(ApiError::Forbidden("this interaction token has expired".into()));
    }
    Ok(interaction)
}

#[derive(Deserialize)]
pub struct Press {
    pub custom_id: String,
    #[serde(default)]
    pub values: Vec<String>,
}

async fn press(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, message_id)): Path<(String, String)>,
    Json(req): Json<Press>,
) -> ApiResult<Json<Value>> {
    let (ch, member, member_perms) = press_preconditions(&state, &auth, &channel_id).await?;

    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT author_id, components FROM messages \
         WHERE id = ? AND channel_id = ? AND deleted = 0",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .fetch_optional(&state.pool)
    .await?;
    let (author_id, components) =
        row.ok_or_else(|| ApiError::NotFound("message not found".into()))?;

    let data = resolve_press(&components, &req)?;
    let owner = application_behind(&state, &ch.guild_id, &author_id).await?;

    mint_and_dispatch(
        &state,
        MintRequest {
            kind: "component",
            owner,
            guild_id: ch.guild_id,
            channel_id,
            message_id: Some(message_id),
            ephemeral_id: None,
            user_id: auth.user_id,
            member: member_snapshot(&member, member_perms),
            data,
            parent_id: None,
        },
    )
    .await
    .map(Json)
}

async fn press_ephemeral(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((channel_id, ephemeral_id)): Path<(String, String)>,
    Json(req): Json<Press>,
) -> ApiResult<Json<Value>> {
    let (ch, member, member_perms) = press_preconditions(&state, &auth, &channel_id).await?;

    let row: Option<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, components, application_id, application_origin, channel_id, expires_at \
         FROM ephemeral_messages WHERE id = ?",
    )
    .bind(&ephemeral_id)
    .fetch_optional(&state.pool)
    .await?;
    let (owner_user, components, application_id, application_origin, stored_channel, expires_at) =
        row.ok_or_else(|| ApiError::NotFound("message not found".into()))?;

    if owner_user != auth.user_id || stored_channel != channel_id || expires_at <= now_ms() {
        return Err(ApiError::NotFound("message not found".into()));
    }

    let data = resolve_press(&components, &req)?;
    let owner = application_behind_by_id(
        &state,
        &ch.guild_id,
        &application_id,
        &application_origin,
    )
    .await?;

    mint_and_dispatch(
        &state,
        MintRequest {
            kind: "component",
            owner,
            guild_id: ch.guild_id,
            channel_id,
            message_id: None,
            ephemeral_id: Some(ephemeral_id),
            user_id: auth.user_id,
            member: member_snapshot(&member, member_perms),
            data,
            parent_id: None,
        },
    )
    .await
    .map(Json)
}

async fn press_preconditions(
    state: &AppState,
    auth: &GuildAuth,
    channel_id: &str,
) -> ApiResult<(guildstore::ChannelInfo, guildstore::Membership, u64)> {
    if auth.is_bot {
        return Err(ApiError::Forbidden(
            "applications may not press message components".into(),
        ));
    }
    rate_limit_user(state, &auth.user_id)?;
    let (ch, member, member_perms) =
        guildstore::require_channel_perm(state, channel_id, &auth.user_id, perms::VIEW_CHANNEL)
            .await?;
    guildstore::ensure_authoritative(state, &ch.guild_id).await?;
    Ok((ch, member, member_perms))
}

fn resolve_press(components: &str, req: &Press) -> ApiResult<Value> {
    let rows: Vec<interactivity::TopLevel> = serde_json::from_str(components)
        .map_err(|_| ApiError::NotFound("no such component".into()))?;
    let component = interactivity::find_pressable(&rows, &req.custom_id)
        .ok_or_else(|| ApiError::NotFound("no such component".into()))?;

    match component {
        interactivity::Component::Button { .. } => {
            if !req.values.is_empty() {
                return Err(ApiError::BadRequest("a button press carries no values".into()));
            }
            Ok(json!({ "custom_id": req.custom_id }))
        }
        interactivity::Component::Select { options, min, max, .. } => {
            let min = min.unwrap_or(1) as usize;
            let max = max.unwrap_or(1) as usize;
            if req.values.len() < min || req.values.len() > max {
                return Err(ApiError::BadRequest(format!(
                    "this select takes between {min} and {max} values"
                )));
            }
            let mut seen = std::collections::HashSet::new();
            for value in &req.values {
                if !options.iter().any(|o| &o.value == value) {
                    return Err(ApiError::BadRequest(
                        "a submitted value is not one of this select's options".into(),
                    ));
                }
                if !seen.insert(value) {
                    return Err(ApiError::BadRequest("a value was submitted twice".into()));
                }
            }
            Ok(json!({ "custom_id": req.custom_id, "values": req.values }))
        }
        interactivity::Component::TextInput { .. } => {
            Err(ApiError::BadRequest("a text input is submitted with its modal".into()))
        }
    }
}

async fn application_behind(
    state: &AppState,
    guild_id: &str,
    author_id: &str,
) -> ApiResult<Owner> {
    let row: Option<(Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT bot_application_id, bot_application_origin, banned FROM members \
         WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(author_id)
    .fetch_optional(&state.pool)
    .await?;

    let (application_id, application_origin, banned) = row.ok_or_else(|| {
        ApiError::NotFound("the application behind this message is no longer in this guild".into())
    })?;
    if banned != 0 {
        return Err(ApiError::Forbidden(
            "the application behind this message is banned from this guild".into(),
        ));
    }
    match (application_id, application_origin) {
        (Some(application_id), Some(application_origin)) => Ok(Owner {
            user_id: author_id.to_string(),
            application_id,
            application_origin,
        }),
        _ => Err(ApiError::BadRequest(
            "this message was not written by an application".into(),
        )),
    }
}

async fn application_behind_by_id(
    state: &AppState,
    guild_id: &str,
    application_id: &str,
    application_origin: &str,
) -> ApiResult<Owner> {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT user_id, banned FROM members \
         WHERE guild_id = ? AND bot_application_id = ? AND bot_application_origin = ?",
    )
    .bind(guild_id)
    .bind(application_id)
    .bind(application_origin)
    .fetch_optional(&state.pool)
    .await?;
    let (user_id, banned) = row.ok_or_else(|| {
        ApiError::NotFound("the application behind this message is no longer in this guild".into())
    })?;
    if banned != 0 {
        return Err(ApiError::Forbidden(
            "the application behind this message is banned from this guild".into(),
        ));
    }
    Ok(Owner {
        user_id,
        application_id: application_id.to_string(),
        application_origin: application_origin.to_string(),
    })
}

struct Owner {
    user_id: String,
    application_id: String,
    application_origin: String,
}

struct MintRequest {
    kind: &'static str,
    owner: Owner,
    guild_id: String,
    channel_id: String,
    message_id: Option<String>,
    ephemeral_id: Option<String>,
    user_id: String,
    member: Value,
    data: Value,
    parent_id: Option<String>,
}

async fn mint_and_dispatch(state: &AppState, req: MintRequest) -> ApiResult<Value> {
    rate_limit_application(state, &req.owner.application_id)?;
    sweep_occasionally(state).await;

    let id = ulid();
    let token = random_token(TOKEN_BYTES);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO interactions (id, token_hash, kind, application_id, application_origin, \
         guild_id, channel_id, message_id, ephemeral_id, user_id, created_at, expires_at, \
         parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(hash_token(&token))
    .bind(req.kind)
    .bind(&req.owner.application_id)
    .bind(&req.owner.application_origin)
    .bind(&req.guild_id)
    .bind(&req.channel_id)
    .bind(&req.message_id)
    .bind(&req.ephemeral_id)
    .bind(&req.user_id)
    .bind(now)
    .bind(now + TOKEN_TTL_MS)
    .bind(&req.parent_id)
    .execute(&state.pool)
    .await?;

    let payload = json!({
        "id": id,
        "token": token,
        "kind": req.kind,
        "application_id": req.owner.application_id,
        "application_origin": req.owner.application_origin,
        "guild_id": req.guild_id,
        "channel_id": req.channel_id,
        "message_id": req.message_id,
        "member": req.member,
        "user_id": req.user_id,
        "data": req.data,
    });

    let delivered = local_apps::dispatch(
        state,
        LocalInteraction {
            id: id.clone(),
            token,
            kind: req.kind.to_string(),
            application_id: req.owner.application_id.clone(),
            application_origin: req.owner.application_origin.clone(),
            guild_id: req.guild_id.clone(),
            channel_id: req.channel_id.clone(),
            message_id: req.message_id.clone(),
            user_id: req.user_id.clone(),
            member: req.member.clone(),
            data: req.data.clone(),
        },
    );
    if !delivered {
        state
            .hub
            .publish(Event::in_channel_to_user(
                "INTERACTION_CREATE",
                req.guild_id.clone(),
                req.channel_id.clone(),
                0,
                req.owner.user_id.clone(),
                payload,
            ))
            .await;
    }

    Ok(json!({ "id": id, "kind": req.kind, "local": delivered }))
}

fn member_snapshot(member: &guildstore::Membership, permissions: u64) -> Value {
    json!({
        "user_id": member.user_id,
        "roles": member.roles.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        "permissions": permissions.to_string(),
    })
}

#[derive(Deserialize)]
pub struct Callback {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

async fn callback(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((id, token)): Path<(String, String)>,
    Json(req): Json<Callback>,
) -> ApiResult<Json<Value>> {
    let interaction = load_by_token(&state, &id, &token).await?;
    authorise_caller(&auth, &interaction)?;
    respond_inner(&state, interaction, json!({ "type": req.kind, "data": req.data }))
        .await
        .map(Json)
}

async fn follow_up(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((id, token)): Path<(String, String)>,
    Json(data): Json<Value>,
) -> ApiResult<Json<Value>> {
    let interaction = load_by_token(&state, &id, &token).await?;
    authorise_caller(&auth, &interaction)?;
    follow_up_inner(&state, interaction, data).await.map(Json)
}

fn authorise_caller(auth: &GuildAuth, interaction: &Interaction) -> ApiResult<()> {
    let ours = auth.is_bot
        && auth.application_id.as_deref() == Some(interaction.application_id.as_str())
        && auth.home_domain == interaction.application_origin;
    if !ours {
        return Err(ApiError::NotFound("no such interaction".into()));
    }
    Ok(())
}

pub async fn respond_to_interaction(
    state: &AppState,
    id: &str,
    token: &str,
    response: Value,
) -> ApiResult<Value> {
    let interaction = load_by_token(state, id, token).await?;
    respond_inner(state, interaction, response).await
}

pub async fn follow_up_interaction(
    state: &AppState,
    id: &str,
    token: &str,
    data: Value,
) -> ApiResult<Value> {
    let interaction = load_by_token(state, id, token).await?;
    follow_up_inner(state, interaction, data).await
}

async fn respond_inner(
    state: &AppState,
    interaction: Interaction,
    response: Value,
) -> ApiResult<Value> {
    let kind = response.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
    let data = response.get("data").cloned().unwrap_or(json!({}));

    let claimed = sqlx::query(
        "UPDATE interactions SET responded_at = ?, response_kind = ? \
         WHERE id = ? AND responded_at IS NULL",
    )
    .bind(now_ms())
    .bind(&kind)
    .bind(&interaction.id)
    .execute(&state.pool)
    .await?;
    if claimed.rows_affected() == 0 {
        return Err(ApiError::Conflict("this interaction has already been answered".into()));
    }

    let author = AppAuthorship {
        application_id: interaction.application_id.clone(),
        application_origin: interaction.application_origin.clone(),
    };

    match kind.as_str() {
        "message" => new_message_response(state, &interaction, &author, &data, false).await,
        "update_message" => update_message_response(state, &interaction, &author, &data).await,
        "deferred" => {
            let ephemeral = data.get("ephemeral").and_then(Value::as_bool).unwrap_or(false);
            sqlx::query("UPDATE interactions SET deferred_ephemeral = ? WHERE id = ?")
                .bind(i64::from(ephemeral))
                .bind(&interaction.id)
                .execute(&state.pool)
                .await?;
            state
                .hub
                .publish(Event::in_channel_to_user(
                    "INTERACTION_DEFERRED",
                    interaction.guild_id.clone(),
                    interaction.channel_id.clone(),
                    0,
                    interaction.user_id.clone(),
                    json!({
                        "interaction_id": interaction.id,
                        "channel_id": interaction.channel_id,
                        "message_id": interaction.message_id,
                        "ephemeral": ephemeral,
                    }),
                ))
                .await;
            Ok(json!({ "ok": true, "type": "deferred", "ephemeral": ephemeral }))
        }
        "modal" => modal_response(state, &interaction, &data).await,
        other => Err(ApiError::Unprocessable(format!(
            "unknown interaction response type {other:?}"
        ))),
    }
}

async fn follow_up_inner(
    state: &AppState,
    interaction: Interaction,
    data: Value,
) -> ApiResult<Value> {
    if interaction.responded_at.is_none() {
        return Err(ApiError::Conflict(
            "nothing to follow up: this interaction has not been answered yet".into(),
        ));
    }
    let author = AppAuthorship {
        application_id: interaction.application_id.clone(),
        application_origin: interaction.application_origin.clone(),
    };

    if let Some(message_id) = interaction.response_message_id.clone() {
        let mut edited = interaction;
        edited.message_id = Some(message_id);
        return update_message_response(state, &edited, &author, &data).await;
    }
    if interaction.response_kind.as_deref() == Some("deferred") {
        let ephemeral = interaction.deferred_ephemeral;
        return new_message_response(state, &interaction, &author, &data, ephemeral).await;
    }
    Err(ApiError::Conflict(
        "this interaction's response cannot be followed up".into(),
    ))
}

async fn new_message_response(
    state: &AppState,
    interaction: &Interaction,
    author: &AppAuthorship,
    data: &Value,
    force_ephemeral: bool,
) -> ApiResult<Value> {
    let content = data.get("content").and_then(Value::as_str).unwrap_or("");
    let components = data.get("components").cloned().unwrap_or(json!([]));
    let cards = data.get("cards").cloned().unwrap_or(json!([]));
    let ephemeral =
        force_ephemeral || data.get("ephemeral").and_then(Value::as_bool).unwrap_or(false);

    if content.chars().count() > state.cfg.limits.max_message_len {
        return Err(ApiError::BadRequest("message too long".into()));
    }
    let (components, cards) = messages::prepare_app_payload(
        state,
        &interaction.guild_id,
        &components,
        &cards,
        Some(author),
    )
    .await?;
    if content.trim().is_empty() && components == "[]" && cards == "[]" {
        return Err(ApiError::BadRequest("a response must say something".into()));
    }

    if ephemeral {
        return deliver_ephemeral(state, interaction, content, &components, &cards).await;
    }

    let (ch, _member, app_perms) = guildstore::require_channel_perm(
        state,
        &interaction.channel_id,
        &application_member(state, interaction).await?,
        perms::SEND_MESSAGES,
    )
    .await?;
    guildstore::ensure_authoritative(state, &ch.guild_id).await?;

    let payload = messages::insert_application_message(
        state,
        &interaction.guild_id,
        &interaction.channel_id,
        &application_member(state, interaction).await?,
        content,
        &components,
        &cards,
        interaction.message_id.as_deref(),
        app_perms,
    )
    .await?;
    sqlx::query("UPDATE interactions SET response_message_id = ? WHERE id = ?")
        .bind(payload.get("id").and_then(Value::as_str))
        .bind(&interaction.id)
        .execute(&state.pool)
        .await?;
    Ok(payload)
}

async fn update_message_response(
    state: &AppState,
    interaction: &Interaction,
    author: &AppAuthorship,
    data: &Value,
) -> ApiResult<Value> {
    let content = data.get("content").and_then(Value::as_str);
    let components = data.get("components").cloned().unwrap_or(json!([]));
    let cards = data.get("cards").cloned().unwrap_or(json!([]));
    if content.map(|c| c.chars().count()).unwrap_or(0) > state.cfg.limits.max_message_len {
        return Err(ApiError::BadRequest("message too long".into()));
    }
    let (components, cards) = messages::prepare_app_payload(
        state,
        &interaction.guild_id,
        &components,
        &cards,
        Some(author),
    )
    .await?;

    if cards != "[]" {
        let app = application_member(state, interaction).await?;
        let (_, _, app_perms) = guildstore::require_channel_perm(
            state,
            &interaction.channel_id,
            &app,
            perms::VIEW_CHANNEL,
        )
        .await?;
        messages::require_embed_links(app_perms, &cards)?;
    }

    if let Some(ephemeral_id) = &interaction.ephemeral_id {
        sqlx::query("UPDATE ephemeral_messages SET components = ? WHERE id = ? AND user_id = ?")
            .bind(&components)
            .bind(ephemeral_id)
            .bind(&interaction.user_id)
            .execute(&state.pool)
            .await?;
        let payload = json!({
            "id": ephemeral_id,
            "channel_id": interaction.channel_id,
            "guild_id": interaction.guild_id,
            "ephemeral": true,
            "content": content,
            "components": serde_json::from_str::<Value>(&components).unwrap_or(json!([])),
            "cards": serde_json::from_str::<Value>(&cards).unwrap_or(json!([])),
        });
        state
            .hub
            .publish(Event::in_channel_to_user(
                "EPHEMERAL_MESSAGE_UPDATE",
                interaction.guild_id.clone(),
                interaction.channel_id.clone(),
                0,
                interaction.user_id.clone(),
                payload.clone(),
            ))
            .await;
        return Ok(payload);
    }

    let message_id = interaction
        .message_id
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("this interaction has no message to update".into()))?;

    let author_id: Option<String> = sqlx::query_scalar(
        "SELECT author_id FROM messages WHERE id = ? AND channel_id = ? AND deleted = 0",
    )
    .bind(message_id)
    .bind(&interaction.channel_id)
    .fetch_optional(&state.pool)
    .await?;
    let author_id = author_id.ok_or_else(|| ApiError::NotFound("message not found".into()))?;
    if author_id != application_member(state, interaction).await? {
        return Err(ApiError::Forbidden(
            "an application may only update its own message".into(),
        ));
    }

    messages::update_application_message(
        state,
        message_id,
        &interaction.channel_id,
        &interaction.guild_id,
        content,
        &components,
        &cards,
    )
    .await
}

async fn modal_response(
    state: &AppState,
    interaction: &Interaction,
    data: &Value,
) -> ApiResult<Value> {
    if interaction.kind == "modal_submit" {
        return Err(ApiError::BadRequest(
            "a modal submission cannot be answered with another modal".into(),
        ));
    }
    let custom_id = data
        .get("custom_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Unprocessable("a modal needs a custom_id".into()))?;
    if custom_id.is_empty() || custom_id.chars().count() > interactivity::MAX_CUSTOM_ID_CHARS {
        return Err(ApiError::Unprocessable("modal custom_id is out of range".into()));
    }
    let title = data.get("title").and_then(Value::as_str).unwrap_or("");
    if title.is_empty() || title.chars().count() > interactivity::MAX_LABEL_CHARS {
        return Err(ApiError::Unprocessable("a modal needs a title".into()));
    }
    let components = data.get("components").cloned().unwrap_or(json!([]));
    let rows = interactivity::parse_components(&components)
        .map_err(|e| ApiError::Unprocessable(format!("modal components: {e}")))?;
    interactivity::validate_components(&rows, interactivity::TreeContext::Modal)
        .map_err(|e| ApiError::Unprocessable(e.to_string()))?;
    if rows.is_empty() {
        return Err(ApiError::Unprocessable("a modal needs at least one input".into()));
    }
    let stored = serde_json::to_string(&rows)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serialising modal: {e}")))?;

    sqlx::query(
        "UPDATE interactions SET modal_custom_id = ?, modal_components = ? WHERE id = ?",
    )
    .bind(custom_id)
    .bind(&stored)
    .bind(&interaction.id)
    .execute(&state.pool)
    .await?;

    let payload = json!({
        "interaction_id": interaction.id,
        "custom_id": custom_id,
        "title": title,
        "channel_id": interaction.channel_id,
        "components": serde_json::from_str::<Value>(&stored).unwrap_or(json!([])),
    });
    state
        .hub
        .publish(Event::in_channel_to_user(
            "MODAL_OPEN",
            interaction.guild_id.clone(),
            interaction.channel_id.clone(),
            0,
            interaction.user_id.clone(),
            payload.clone(),
        ))
        .await;
    Ok(json!({ "ok": true, "type": "modal", "interaction_id": interaction.id }))
}

async fn application_member(state: &AppState, interaction: &Interaction) -> ApiResult<String> {
    let owner = application_behind_by_id(
        state,
        &interaction.guild_id,
        &interaction.application_id,
        &interaction.application_origin,
    )
    .await?;
    Ok(owner.user_id)
}

async fn deliver_ephemeral(
    state: &AppState,
    interaction: &Interaction,
    content: &str,
    components: &str,
    cards: &str,
) -> ApiResult<Value> {
    let id = ulid();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO ephemeral_messages (id, interaction_id, application_id, \
         application_origin, guild_id, channel_id, user_id, components, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&interaction.id)
    .bind(&interaction.application_id)
    .bind(&interaction.application_origin)
    .bind(&interaction.guild_id)
    .bind(&interaction.channel_id)
    .bind(&interaction.user_id)
    .bind(components)
    .bind(now)
    .bind(now + EPHEMERAL_TTL_MS)
    .execute(&state.pool)
    .await?;

    let author = application_member(state, interaction).await?;
    let payload = json!({
        "id": id,
        "channel_id": interaction.channel_id,
        "guild_id": interaction.guild_id,
        "author": author,
        "content": content,
        "components": serde_json::from_str::<Value>(components).unwrap_or(json!([])),
        "cards": serde_json::from_str::<Value>(cards).unwrap_or(json!([])),
        "ephemeral": true,
        "interaction_id": interaction.id,
        "created_at": now,
    });
    state
        .hub
        .publish(Event::in_channel_to_user(
            "EPHEMERAL_MESSAGE_CREATE",
            interaction.guild_id.clone(),
            interaction.channel_id.clone(),
            0,
            interaction.user_id.clone(),
            payload.clone(),
        ))
        .await;
    Ok(payload)
}

#[derive(Deserialize)]
pub struct ModalSubmit {
    #[serde(default)]
    pub components: Vec<Value>,
}

async fn modal_submit(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(id): Path<String>,
    Json(req): Json<ModalSubmit>,
) -> ApiResult<Json<Value>> {
    if auth.is_bot {
        return Err(ApiError::Forbidden("applications may not submit modals".into()));
    }
    rate_limit_user(&state, &auth.user_id)?;

    let row: Option<InteractionRow> = sqlx::query_as(
        "SELECT id, kind, application_id, application_origin, guild_id, channel_id, message_id, \
         ephemeral_id, user_id, expires_at, responded_at, response_kind, deferred_ephemeral, \
         response_message_id, modal_custom_id, modal_components \
         FROM interactions WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    let row = row.ok_or_else(|| ApiError::NotFound("no such interaction".into()))?;
    let parent = Interaction {
        id: row.0,
        kind: row.1,
        application_id: row.2,
        application_origin: row.3,
        guild_id: row.4,
        channel_id: row.5,
        message_id: row.6,
        ephemeral_id: row.7,
        user_id: row.8,
        expires_at: row.9,
        responded_at: row.10,
        response_kind: row.11,
        deferred_ephemeral: row.12 != 0,
        response_message_id: row.13,
        modal_custom_id: row.14,
        modal_components: row.15,
    };
    if parent.user_id != auth.user_id {
        return Err(ApiError::NotFound("no such interaction".into()));
    }
    if parent.expires_at <= now_ms() {
        return Err(ApiError::Forbidden("this interaction has expired".into()));
    }
    let (Some(modal_custom_id), Some(modal_components)) =
        (parent.modal_custom_id.clone(), parent.modal_components.clone())
    else {
        return Err(ApiError::BadRequest("no modal was opened for this interaction".into()));
    };

    let already: Option<String> =
        sqlx::query_scalar("SELECT id FROM interactions WHERE parent_id = ?")
            .bind(&parent.id)
            .fetch_optional(&state.pool)
            .await?;
    if already.is_some() {
        return Err(ApiError::Conflict("this modal has already been submitted".into()));
    }

    let values = validate_modal_submission(&modal_components, &req.components)?;

    let (ch, member, member_perms) =
        press_preconditions(&state, &auth, &parent.channel_id).await?;
    let owner = application_behind_by_id(
        &state,
        &ch.guild_id,
        &parent.application_id,
        &parent.application_origin,
    )
    .await?;

    mint_and_dispatch(
        &state,
        MintRequest {
            kind: "modal_submit",
            owner,
            guild_id: parent.guild_id.clone(),
            channel_id: parent.channel_id.clone(),
            message_id: parent.message_id.clone(),
            ephemeral_id: parent.ephemeral_id.clone(),
            user_id: auth.user_id.clone(),
            member: member_snapshot(&member, member_perms),
            data: json!({ "custom_id": modal_custom_id, "components": values }),
            parent_id: Some(parent.id.clone()),
        },
    )
    .await
    .map(Json)
}

fn validate_modal_submission(stored: &str, submitted: &[Value]) -> ApiResult<Vec<Value>> {
    let rows: Vec<interactivity::TopLevel> = serde_json::from_str(stored)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("stored modal is unreadable")))?;
    let fields: Vec<&interactivity::Component> = rows.iter().flat_map(|r| r.children()).collect();

    let mut out = Vec::with_capacity(fields.len());
    let mut seen = std::collections::HashSet::new();
    for entry in submitted {
        let custom_id = entry
            .get("custom_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("a submitted field has no custom_id".into()))?;
        let value = entry.get("value").and_then(Value::as_str).unwrap_or("");
        if !seen.insert(custom_id.to_string()) {
            return Err(ApiError::BadRequest("a field was submitted twice".into()));
        }
        let field = fields
            .iter()
            .find(|f| f.dispatching_custom_id() == Some(custom_id))
            .ok_or_else(|| ApiError::BadRequest("this modal has no such field".into()))?;
        let interactivity::Component::TextInput { required, min, max, .. } = field else {
            return Err(ApiError::BadRequest("this modal has no such field".into()));
        };
        let len = value.chars().count();
        let min = min.unwrap_or(0) as usize;
        let max = max.unwrap_or(interactivity::MAX_TEXT_INPUT_VALUE_CHARS as u32) as usize;
        if required.unwrap_or(false) && value.trim().is_empty() {
            return Err(ApiError::BadRequest("a required field was left empty".into()));
        }
        if len > max || (len > 0 && len < min) {
            return Err(ApiError::BadRequest("a field's length is outside its range".into()));
        }
        out.push(json!({ "custom_id": custom_id, "value": value }));
    }

    for field in &fields {
        if let interactivity::Component::TextInput { custom_id, required, .. } = field {
            if required.unwrap_or(false) && !seen.contains(custom_id.as_str()) {
                return Err(ApiError::BadRequest("a required field is missing".into()));
            }
        }
    }
    Ok(out)
}

fn rate_limit_user(state: &AppState, user_id: &str) -> ApiResult<()> {
    if !state.cfg.rate_limit.enabled {
        return Ok(());
    }
    let cfg = &state.cfg.rate_limit;
    state
        .limiter
        .take(
            format!("interaction-user:{user_id}"),
            "interaction-user",
            cfg.write_burst as f64,
            cfg.write_per_sec,
        )
        .map_err(|retry| ApiError::RateLimited(format!("slow down: try again in {retry:.0}s")))
}

fn rate_limit_application(state: &AppState, application_id: &str) -> ApiResult<()> {
    if !state.cfg.rate_limit.enabled {
        return Ok(());
    }
    let cfg = &state.cfg.rate_limit;
    state
        .limiter
        .take(
            format!("interaction-app:{application_id}"),
            "interaction-app",
            cfg.write_burst as f64 * 8.0,
            cfg.write_per_sec * 8.0,
        )
        .map_err(|retry| {
            ApiError::RateLimited(format!(
                "this application is receiving too many interactions: try again in {retry:.0}s"
            ))
        })
}

static PRESSES: AtomicU64 = AtomicU64::new(0);

async fn sweep_occasionally(state: &AppState) {
    if PRESSES.fetch_add(1, Ordering::Relaxed) % 128 != 0 {
        return;
    }
    let now = now_ms();
    let _ = sqlx::query("DELETE FROM interactions WHERE expires_at < ?")
        .bind(now)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("DELETE FROM ephemeral_messages WHERE expires_at < ?")
        .bind(now)
        .execute(&state.pool)
        .await;
}
