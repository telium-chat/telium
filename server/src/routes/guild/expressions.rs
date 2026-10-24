use crate::auth::GuildAuth;
use crate::expression;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_EXPRESSIONS};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, random_token, ulid, valid_localpart};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct CreateExpression {
    pub name: String,
    pub data: String,
    #[serde(default)]
    pub animated: Option<bool>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
}

pub const MAX_EXPRESSION_BYTES: usize = 256 * 1024;

pub async fn create_emoji(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<CreateExpression>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_EXPRESSIONS).await?;
    if !valid_localpart(&req.name) {
        return Err(ApiError::BadRequest("emoji name must be 1-32 chars of [a-z0-9._-]".into()));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM emojis WHERE guild_id = ?")
        .bind(&guild_id).fetch_one(&state.pool).await?;
    if count >= state.cfg.limits.max_emoji_per_guild {
        return Err(ApiError::Forbidden("this guild's emoji slots are full".into()));
    }

    let stored = store_expression_asset(&state, &auth.user_id, &req, expression::Kind::Emoji).await?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO emojis (id, guild_id, name, media_hash, animated, uploader, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&guild_id).bind(&req.name).bind(&stored.hash)
    .bind(i64::from(stored.animated)).bind(&auth.user_id).bind(now_ms())
    .execute(&state.pool).await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.message().contains("UNIQUE") => {
            ApiError::Conflict("an emoji with that name already exists".into())
        }
        other => ApiError::Db(other),
    })?;

    let out = expression_json(&state, "emoji", &id, &guild_id, &req.name, &stored.hash, stored.animated);
    state.hub.publish(Event::new("GUILD_EMOJI_UPDATE", guild_id, INTENT_GUILD_EXPRESSIONS, json!({ "emoji": out.clone() }))).await;
    Ok(Json(out))
}

pub async fn create_sticker(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<CreateExpression>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_EXPRESSIONS).await?;
    if !valid_localpart(&req.name) {
        return Err(ApiError::BadRequest("sticker name must be 1-32 chars of [a-z0-9._-]".into()));
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stickers WHERE guild_id = ?")
        .bind(&guild_id).fetch_one(&state.pool).await?;
    if count >= state.cfg.limits.max_stickers_per_guild {
        return Err(ApiError::Forbidden("this guild's sticker slots are full".into()));
    }

    let stored = store_expression_asset(&state, &auth.user_id, &req, expression::Kind::Sticker).await?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO stickers (id, guild_id, name, media_hash, format, uploader, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id).bind(&guild_id).bind(&req.name).bind(&stored.hash)
    .bind(stored.format).bind(&auth.user_id).bind(now_ms())
    .execute(&state.pool).await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.message().contains("UNIQUE") => {
            ApiError::Conflict("a sticker with that name already exists".into())
        }
        other => ApiError::Db(other),
    })?;

    let out = expression_json(&state, "sticker", &id, &guild_id, &req.name, &stored.hash, stored.animated);
    state.hub.publish(Event::new("GUILD_EMOJI_UPDATE", guild_id, INTENT_GUILD_EXPRESSIONS,
        json!({ "sticker": out.clone() }))).await;
    Ok(Json(out))
}

struct StoredExpression {
    hash: String,
    animated: bool,
    format: &'static str,
}

async fn store_expression_asset(
    state: &AppState,
    uploader: &str,
    req: &CreateExpression,
    kind: expression::Kind,
) -> ApiResult<StoredExpression> {
    let bytes = crate::util::unb64(&req.data)
        .ok_or_else(|| ApiError::BadRequest("data must be base64url".into()))?;
    if bytes.is_empty() {
        return Err(ApiError::BadRequest("empty asset".into()));
    }
    if bytes.len() > MAX_EXPRESSION_BYTES {
        return Err(ApiError::TooLarge(format!(
            "expression assets are capped at {MAX_EXPRESSION_BYTES} bytes"
        )));
    }

    let uploaded_hash = blake3::hash(&bytes).to_hex().to_string();
    crate::scan::screen_upload(state, uploader, &uploaded_hash, &bytes).await?;

    let limits = expression::Limits::from_config(&state.cfg.limits);
    let noun = kind.noun();
    let normalized = tokio::task::spawn_blocking(move || expression::normalize(&bytes, kind, &limits))
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("normalizing {noun}: {e}")))?
        .map_err(|e| ApiError::BadRequest(format!("{noun} was not accepted: {e}")))?;
    if normalized.bytes.len() > MAX_EXPRESSION_BYTES {
        return Err(ApiError::TooLarge(format!(
            "the {noun} is {} bytes after re-encoding, over the {MAX_EXPRESSION_BYTES}-byte cap; \
             use fewer frames or a smaller image",
            normalized.bytes.len()
        )));
    }

    let hash = blake3::hash(&normalized.bytes).to_hex().to_string();
    if hash != uploaded_hash {
        crate::scan::screen_upload(state, uploader, &hash, &normalized.bytes).await?;
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT hash FROM media WHERE hash = ?")
        .bind(&hash).fetch_optional(&state.pool).await?;
    if existing.is_none() {
        let key = crate::routes::media::media_key(state, &hash);
        state.media_store.put(&key, normalized.bytes.clone()).await?;
        sqlx::query(
            "INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, \
             capability, purpose, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'expression', ?)",
        )
        .bind(&hash).bind(uploader).bind(format!("{}.{}", req.name, normalized.format()))
        .bind(normalized.mime)
        .bind(normalized.bytes.len() as i64)
        .bind(i64::from(normalized.width)).bind(i64::from(normalized.height))
        .bind(random_token(24)).bind(now_ms())
        .execute(&state.pool).await?;
    } else {
        sqlx::query("UPDATE media SET purpose = 'expression', mime = ? WHERE hash = ?")
            .bind(normalized.mime).bind(&hash).execute(&state.pool).await?;
    }
    Ok(StoredExpression { hash, animated: normalized.animated, format: normalized.format() })
}

fn expression_json(
    state: &AppState,
    kind: &str,
    id: &str,
    guild_id: &str,
    name: &str,
    hash: &str,
    animated: bool,
) -> Value {
    json!({
        "kind": kind,
        "id": id,
        "guild_id": guild_id,
        "name": name,
        "reference": format!("media://{}/{}", state.cfg.server_name, hash),
        "url": format!("{}/_telium/v1/media/{}", state.cfg.public_base_url, hash),
        "animated": animated,
    })
}

pub async fn list_expressions(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let emojis: Vec<(String, String, String, i64)> =
        sqlx::query_as("SELECT id, name, media_hash, animated FROM emojis WHERE guild_id = ?")
            .bind(&guild_id).fetch_all(&state.pool).await?;
    let stickers: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT id, name, media_hash, format FROM stickers WHERE guild_id = ?")
            .bind(&guild_id).fetch_all(&state.pool).await?;
    Ok(Json(json!({
        "emojis": emojis.iter().map(|(id, name, hash, animated)|
            expression_json(&state, "emoji", id, &guild_id, name, hash, *animated != 0)).collect::<Vec<_>>(),
        "stickers": stickers.iter().map(|(id, name, hash, format)|
            expression_json(&state, "sticker", id, &guild_id, name, hash, format == "gif")).collect::<Vec<_>>(),
    })))
}

pub async fn fetch_emoji(
    State(state): State<AppState>,
    Path(emoji_id): Path<String>,
) -> ApiResult<axum::response::Redirect> {
    let hash: Option<String> = sqlx::query_scalar("SELECT media_hash FROM emojis WHERE id = ?")
        .bind(&emoji_id)
        .fetch_optional(&state.pool)
        .await?;
    let hash = hash.ok_or_else(|| ApiError::NotFound("no such emoji".into()))?;
    Ok(axum::response::Redirect::permanent(&format!("/_telium/v1/media/{hash}")))
}

pub async fn fetch_sticker(
    State(state): State<AppState>,
    Path(sticker_id): Path<String>,
) -> ApiResult<axum::response::Redirect> {
    let hash: Option<String> = sqlx::query_scalar("SELECT media_hash FROM stickers WHERE id = ?")
        .bind(&sticker_id)
        .fetch_optional(&state.pool)
        .await?;
    let hash = hash.ok_or_else(|| ApiError::NotFound("no such sticker".into()))?;
    Ok(axum::response::Redirect::permanent(&format!("/_telium/v1/media/{hash}")))
}

pub async fn delete_emoji(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, emoji_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_EXPRESSIONS).await?;
    sqlx::query("DELETE FROM emojis WHERE id = ? AND guild_id = ?")
        .bind(&emoji_id).bind(&guild_id).execute(&state.pool).await?;
    state.hub.publish(Event::new("GUILD_EMOJI_UPDATE", guild_id, INTENT_GUILD_EXPRESSIONS,
        json!({ "removed": emoji_id }))).await;
    Ok(Json(json!({ "ok": true })))
}

