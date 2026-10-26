mod channels;
mod expressions;
mod invites;
mod lifecycle;
mod members;
mod roles;

pub use channels::*;
pub use expressions::*;
pub use invites::*;
pub use lifecycle::*;
pub use members::*;
pub use roles::*;

use invites::join_guild_member;

use crate::auth::{GuildAuth, HomeAuth};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_MEMBERS, INTENT_GUILD_STRUCTURE};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token, ulid};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct GuildSessionRequest {
    pub assertion: String,
}

pub async fn create_guild_session(
    State(state): State<AppState>,
    Json(req): Json<GuildSessionRequest>,
) -> ApiResult<Json<Value>> {
    if !state.cfg.roles.guild {
        return Err(ApiError::Forbidden("this server does not host guilds".into()));
    }
    let expected_audience = state.cfg.server_name.clone();
    let claims =
        crate::federation::verify_assertion(&state, &req.assertion, &expected_audience).await?;

    // Refuse bot assertions here; they must redeem at /_telium/v1/bots/session or bot-only rules are skipped.
    if claims.device_pubkey == "bot" || claims.device_id.starts_with("bot:") {
        return Err(ApiError::Unauthorized(
            "this is a bot assertion; exchange it at /_telium/v1/bots/session".into(),
        ));
    }

    let now = now_ms();
    let token = random_token(32);
    let expires_at = now + state.cfg.sessions.guild_session_ttl_secs * 1000;
    let revalidate_at = now + state.cfg.sessions.revalidate_interval_secs * 1000;
    let home_domain = crate::util::split_user_id(&claims.user_id)
        .map(|(_, d)| d.to_string())
        .ok_or_else(|| ApiError::BadRequest("assertion carries a malformed user id".into()))?;

    sqlx::query(
        "INSERT INTO guild_sessions (token_hash, user_id, device_id, home_domain, display_name, \
         avatar_ref, created_at, expires_at, revalidate_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(&claims.user_id)
    .bind(&claims.device_id)
    .bind(&home_domain)
    .bind(&claims.display_name)
    .bind(&claims.avatar_ref)
    .bind(now)
    .bind(expires_at)
    .bind(revalidate_at)
    .execute(&state.pool)
    .await?;

    let refreshed = guildstore::refresh_member_essentials(
        &state.pool,
        &claims.user_id,
        &claims.display_name,
        claims.avatar_ref.as_deref(),
        claims.profile_version,
    )
    .await?;
    for guild_id in refreshed {
        state.hub.publish(Event::new(
            "MEMBER_UPDATE",
            guild_id,
            INTENT_GUILD_MEMBERS,
            json!({
                "user_id": claims.user_id, "display_name": claims.display_name,
                "avatar_ref": claims.avatar_ref, "profile_version": claims.profile_version
            }),
        )).await;
    }

    Ok(Json(json!({
        "session_token": token,
        "user_id": claims.user_id,
        "expires_at": expires_at,
        "revalidate_at": revalidate_at,
        "gateway": format!("{}/gateway/v1", state.cfg.public_base_url.replace("http", "ws")),
    })))
}

#[derive(Deserialize)]
pub struct CreateGuild {
    pub name: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub icon_ref: Option<String>,
}

pub async fn create_guild(
    State(state): State<AppState>,
    auth: GuildAuth,
    Json(req): Json<CreateGuild>,
) -> ApiResult<Json<Value>> {
    // Bots must not own guilds (the owner row has NULL bot_application_id).
    if auth.is_bot {
        return Err(bot_managed_conflict());
    }
    if req.name.trim().is_empty() || req.name.chars().count() > 100 {
        return Err(ApiError::BadRequest("guild name must be 1-100 characters".into()));
    }
    let alias = match &req.alias {
        Some(alias) => Some(crate::vanity::normalise(alias)?),
        None => None,
    };
    let owned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ?",
    )
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
    if owned >= state.cfg.limits.max_guilds_per_user {
        return Err(ApiError::Forbidden("guild limit reached for this account".into()));
    }

    let guild_id = ulid();
    let now = now_ms();
    let mut tx = state.pool.begin().await?;

    // Explicit check for a clean 409; UNIQUE remains the race arbiter.
    if let Some(alias) = &alias {
        let live: Option<String> =
            sqlx::query_scalar("SELECT id FROM guilds WHERE alias = ?")
                .bind(alias)
                .fetch_optional(&mut *tx)
                .await?;
        if live.is_some() {
            return Err(ApiError::Conflict("that guild alias is taken".into()));
        }
        let retired: Option<String> =
            sqlx::query_scalar("SELECT guild_id FROM guild_alias_redirects WHERE alias = ?")
                .bind(alias)
                .fetch_optional(&mut *tx)
                .await?;
        if retired.is_some() {
            return Err(ApiError::Conflict("that guild alias is taken".into()));
        }
    }

    sqlx::query(
        "INSERT INTO guilds (id, alias, name, icon_ref, owner_user_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&guild_id)
    .bind(&alias)
    .bind(req.name.trim())
    .bind(&req.icon_ref)
    .bind(&auth.user_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db) if db.is_unique_violation() => {
            ApiError::Conflict("that guild alias is taken".into())
        }
        other => ApiError::Db(other),
    })?;

    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, color, position, permissions) \
         VALUES (?, ?, '@everyone', 0, 0, ?)",
    )
    .bind(&guild_id)
    .bind(&guild_id)
    .bind(perms::DEFAULT_EVERYONE as i64)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO members (guild_id, user_id, joined_at, display_name, avatar_ref) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&guild_id)
    .bind(&auth.user_id)
    .bind(now)
    .bind(&auth.display_name)
    .bind(&auth.avatar_ref)
    .execute(&mut *tx)
    .await?;

    let channel_id = ulid();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, position, created_at) \
         VALUES (?, ?, 'text', 'general', 0, ?)",
    )
    .bind(&channel_id)
    .bind(&guild_id)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "guild.create", Some(&guild_id), json!({ "name": req.name })).await?;
    crate::memberships::notify_home(&state, &auth.user_id, &guild_id, "joined");
    Ok(Json(guild_json(&state, &guild_id).await?))
}

pub async fn guild_json(state: &AppState, guild_id: &str) -> ApiResult<Value> {
    let row: Option<(String, Option<String>, String, Option<String>, String, String, i64, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, alias, name, icon_ref, owner_user_id, settings, created_at, \
             media_expiry_limit_secs FROM guilds WHERE id = ?",
        )
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?;
    let (id, alias, name, icon_ref, owner, settings, created_at, expiry_limit) =
        row.ok_or_else(|| ApiError::NotFound("guild not found".into()))?;
    let moved_to = guildstore::moved_to(state, guild_id).await?;
    Ok(json!({
        "moved_to": moved_to,
        "id": id,
        "origin": state.cfg.server_name,
        "alias": alias.as_ref().map(|a| format!("#{}:{}", a, state.cfg.server_name)),
        "vanity_url": alias.as_ref().map(|a| state.cfg.invite_link(a)),
        "invite_portal": state.cfg.invite_portal_field(),
        "public_base_url": state.cfg.public_base_url,
        "name": name,
        "icon_ref": icon_ref,
        "owner": owner,
        "settings": serde_json::from_str::<Value>(&settings).unwrap_or(json!({})),
        "emoji_export": crate::emoji::policy_json(state, guild_id).await?,
        "created_at": created_at,
        "member_count": guildstore::member_count(&state.pool, guild_id).await?,
        "media_expiry_limit_secs": expiry_limit,
    }))
}

pub fn moved_guild_stub(origin: &str, guild_id: &str, new_id: &str) -> Value {
    json!({
        "moved_to": new_id,
        "id": guild_id,
        "origin": origin,
        "alias": Value::Null,
        "vanity_url": Value::Null,
        "invite_portal": Value::Null,
        "public_base_url": Value::Null,
        "name": Value::Null,
        "icon_ref": Value::Null,
        "owner": Value::Null,
        "settings": json!({}),
        "emoji_export": Value::Null,
        "created_at": Value::Null,
        "member_count": 0,
        "media_expiry_limit_secs": Value::Null,
        "channels": [],
        "voice_states": [],
        "roles": [],
        "me": Value::Null,
    })
}

pub async fn my_guilds(State(state): State<AppState>, auth: GuildAuth) -> ApiResult<Json<Value>> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ? AND banned = 0")
            .bind(&auth.user_id)
            .fetch_all(&state.pool)
            .await?;
    let mut guilds = Vec::new();
    for id in ids {
        if let Ok(mut g) = guild_json(&state, &id).await {
            g["roles"] = json!(guildstore::roles_json(&state, &id).await?);
            g["me"] = guildstore::me_json(&state, &id, &auth.user_id).await?;
            guilds.push(g);
        } else if let Some(new_id) = guildstore::moved_to(&state, &id).await? {
            guilds.push(moved_guild_stub(&state.cfg.server_name, &id, &new_id));
        }
    }
    Ok(Json(json!({ "guilds": guilds })))
}

pub async fn get_guild(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let mut g = guild_json(&state, &guild_id).await?;
    g["roles"] = json!(guildstore::roles_json(&state, &guild_id).await?);
    g["me"] = guildstore::me_json(&state, &guild_id, &auth.user_id).await?;
    Ok(Json(g))
}

#[derive(Deserialize)]
pub struct PatchGuild {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub icon_ref: Option<String>,
    #[serde(default)]
    pub settings: Option<Value>,
    #[serde(default)]
    pub external_emoji: Option<bool>,
    #[serde(default)]
    pub emoji_export_policy: Option<String>,
    #[serde(default, deserialize_with = "super::identity::double_option")]
    pub emoji_export_role_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::identity::double_option")]
    pub media_expiry_limit_secs: Option<Option<i64>>,
}

pub async fn patch_guild(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<PatchGuild>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    if let Some(name) = &req.name {
        if name.trim().is_empty() || name.chars().count() > 100 {
            return Err(ApiError::BadRequest("guild name must be 1-100 characters".into()));
        }
        sqlx::query("UPDATE guilds SET name = ? WHERE id = ?").bind(name.trim()).bind(&guild_id)
            .execute(&state.pool).await?;
    }
    if let Some(icon) = &req.icon_ref {
        sqlx::query("UPDATE guilds SET icon_ref = ? WHERE id = ?").bind(icon).bind(&guild_id)
            .execute(&state.pool).await?;
    }
    if let Some(settings) = &req.settings {
        sqlx::query("UPDATE guilds SET settings = ? WHERE id = ?").bind(settings.to_string()).bind(&guild_id)
            .execute(&state.pool).await?;
    }
    if let Some(external_emoji) = req.external_emoji {
        sqlx::query("UPDATE guilds SET external_emoji = ? WHERE id = ?")
            .bind(i64::from(external_emoji)).bind(&guild_id)
            .execute(&state.pool).await?;
    }
    if let Some(policy) = &req.emoji_export_policy {
        let role_id = req.emoji_export_role_id.clone().flatten();
        crate::emoji::validate_policy(&state, &guild_id, policy, role_id.as_deref()).await?;
        sqlx::query("UPDATE guilds SET emoji_export_policy = ?, emoji_export_role_id = ? WHERE id = ?")
            .bind(policy)
            .bind(&role_id)
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(secs) = req.media_expiry_limit_secs {
        validate_expiry_limit(secs)?;
        sqlx::query("UPDATE guilds SET media_expiry_limit_secs = ? WHERE id = ?")
            .bind(secs).bind(&guild_id)
            .execute(&state.pool).await?;
    }
    let g = guild_json(&state, &guild_id).await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "guild.update", Some(&guild_id), json!({})).await?;
    state.hub.publish(Event::new("GUILD_UPDATE", guild_id, INTENT_GUILD_STRUCTURE, g.clone())).await;
    Ok(Json(g))
}

pub(super) fn validate_expiry_limit(secs: Option<i64>) -> ApiResult<()> {
    match secs {
        None => Ok(()),
        Some(0) => Err(ApiError::BadRequest(
            "media_expiry_limit_secs cannot be zero; omit it to remove the limit".into(),
        )),
        Some(n) if n < 0 => Err(ApiError::BadRequest(
            "media_expiry_limit_secs cannot be negative".into(),
        )),
        Some(n) if n > 366 * 24 * 60 * 60 => Err(ApiError::BadRequest(
            "media_expiry_limit_secs is over a year".into(),
        )),
        Some(_) => Ok(()),
    }
}

pub async fn guild_status(
    State(state): State<AppState>,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(guild_status_json(&state, &guild_id).await?))
}

pub async fn guild_status_json(state: &AppState, guild_id: &str) -> ApiResult<Value> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT name, created_at FROM guilds WHERE id = ?")
            .bind(guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let stone: Option<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT kind, new_id, record FROM tombstones WHERE subject_type = 'guild' AND subject_id = ?",
    )
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await?;
    let alias: Option<String> = sqlx::query_scalar("SELECT alias FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?
        .flatten();
    let body = match (stone, row) {
        (Some((kind, new_id, record)), _) => json!({
            "guild_id": guild_id,
            "status": if kind == "moved" { "moved" } else { "gone" },
            "moved_to": new_id,
            "tombstone": serde_json::from_str::<Value>(&record).unwrap_or(Value::Null),
            "host": state.cfg.server_name,
        }),
        (None, Some((name, created_at))) => json!({
            "guild_id": guild_id, "status": "active", "name": name,
            "alias": alias.map(|a| crate::vanity::format_address(&a, &state.cfg.server_name)),
            "created_at": created_at, "host": state.cfg.server_name,
        }),
        (None, None) => {
            json!({ "guild_id": guild_id, "status": "unknown", "host": state.cfg.server_name })
        }
    };
    Ok(crypto::sign_json(&state.key, body))
}

#[derive(Deserialize)]
pub struct SetGuildAlias {
    pub alias: String,
}

pub async fn put_guild_alias(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<SetGuildAlias>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let alias = crate::vanity::claim(&state, &guild_id, &req.alias).await?;
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "guild.alias.set",
        Some(&guild_id),
        json!({ "alias": alias }),
    )
    .await?;
    let g = guild_json(&state, &guild_id).await?;
    state
        .hub
        .publish(Event::new("GUILD_UPDATE", guild_id, INTENT_GUILD_STRUCTURE, g.clone()))
        .await;
    Ok(Json(g))
}

pub async fn delete_guild_alias(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    crate::vanity::release(&state, &guild_id).await?;
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "guild.alias.clear",
        Some(&guild_id),
        json!({}),
    )
    .await?;
    let g = guild_json(&state, &guild_id).await?;
    state
        .hub
        .publish(Event::new("GUILD_UPDATE", guild_id, INTENT_GUILD_STRUCTURE, g.clone()))
        .await;
    Ok(Json(g))
}

pub async fn alias_status(
    State(state): State<AppState>,
    Path(alias): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(crate::vanity::local_answer(&state, &alias).await?))
}

#[derive(Deserialize)]
pub struct ResolveAddressQuery {
    pub address: String,
}

pub async fn resolve_guild_address(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ResolveAddressQuery>,
) -> ApiResult<Json<Value>> {
    let (_, origin) = crate::vanity::split_address(&q.address)
        .ok_or_else(|| ApiError::BadRequest(
            "a guild address looks like #gaming:guilds.example".into()
        ))?;
    let current = crate::relocation::current_domain(&state, &origin).await;
    if current != state.cfg.server_name {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ApiError::Forbidden(
                "ask the server named by the guild address to resolve it".into()
            ))?;
        GuildAuth::from_token(&state, token).await?;
    }
    Ok(Json(crate::vanity::resolve(&state, &q.address).await?.to_json()))
}

pub async fn vanity_join_preview(
    State(state): State<AppState>,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT alias, name, icon_ref FROM guilds WHERE id = ?")
            .bind(&guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let (alias, name, icon_ref) =
        row.ok_or_else(|| ApiError::NotFound("guild not found".into()))?;
    let alias = alias.ok_or_else(|| ApiError::NotFound("vanity link is disabled".into()))?;
    let address = crate::vanity::format_address(&alias, &state.cfg.server_name);
    Ok(Json(json!({
        "address": address,
        "url": state.cfg.invite_link(&alias),
        "guild": {
            "id": guild_id,
            "name": name,
            "icon_ref": icon_ref,
            "member_count": guildstore::member_count(&state.pool, &guild_id).await?,
            "host": state.cfg.server_name,
        },
    })))
}

pub async fn join_with_vanity(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let alias: Option<Option<String>> =
        sqlx::query_scalar("SELECT alias FROM guilds WHERE id = ?")
            .bind(&guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let alias = alias
        .ok_or_else(|| ApiError::NotFound("guild not found".into()))?
        .ok_or_else(|| ApiError::NotFound("vanity link is disabled".into()))?;
    let address = crate::vanity::format_address(&alias, &state.cfg.server_name);
    join_guild_member(
        &state,
        &auth,
        &guild_id,
        None,
        json!({ "vanity": address }),
    )
    .await
}


pub async fn audit_log(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::VIEW_AUDIT_LOG).await?;
    let rows: Vec<(String, String, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT id, actor, action, target, data, created_at FROM audit_log \
         WHERE guild_id = ? ORDER BY id DESC LIMIT 100",
    )
    .bind(&guild_id).fetch_all(&state.pool).await?;
    Ok(Json(json!({
        "entries": rows.into_iter().map(|(id, actor, action, target, data, created_at)| json!({
            "id": id, "actor": actor, "action": action, "target": target,
            "data": serde_json::from_str::<Value>(&data).unwrap_or(json!({})),
            "created_at": created_at,
        })).collect::<Vec<_>>()
    })))
}

pub async fn local_session(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    if !(state.cfg.roles.identity && state.cfg.roles.guild) {
        return Err(ApiError::Forbidden(
            "this shortcut requires the identity and guild roles on one server".into(),
        ));
    }
    let assertion = super::identity::issue_assertion(
        State(state.clone()),
        auth,
        Json(super::identity::AssertionRequest { audience: state.cfg.server_name.clone() }),
    )
    .await?;
    let token = assertion.0["assertion"].as_str().unwrap_or_default().to_string();
    create_guild_session(State(state), Json(GuildSessionRequest { assertion: token })).await
}

