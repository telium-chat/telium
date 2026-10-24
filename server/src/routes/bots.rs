
use crate::auth::{BotAuth, GuildAuth, HomeAuth};
use crate::crypto::{self, AssertionClaims};
use crate::error::{ApiError, ApiResult, Coded};
use crate::gateway::events;
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token, split_user_id, ulid, valid_localpart};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_BOT_INTENTS: u64 = events::INTENT_GUILD_MESSAGES
    | events::INTENT_GUILD_STRUCTURE
    | events::INTENT_GUILD_EXPRESSIONS
    | events::INTENT_GUILD_VOICE_STATES;

const DEFAULT_BOT_PERMISSIONS: u64 =
    perms::VIEW_CHANNEL | perms::SEND_MESSAGES | perms::READ_MESSAGE_HISTORY;

fn require_identity_role(state: &AppState) -> ApiResult<()> {
    if state.cfg.roles.identity {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "this server does not host identities".into(),
        ))
    }
}

fn require_guild_role(state: &AppState) -> ApiResult<()> {
    if state.cfg.roles.guild {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "this server does not host guilds".into(),
        ))
    }
}

const CODE_NOT_INSTALLED: &str = crate::errcodes::BOT_NOT_INSTALLED;
const CODE_ASSERTION_REJECTED: &str = crate::errcodes::BOT_ASSERTION_REJECTED;
const CODE_NOT_A_GUILD_SERVER: &str = crate::errcodes::NOT_A_GUILD_SERVER;

fn permission_bits(names: &[String]) -> ApiResult<u64> {
    let mut bits = 0u64;
    for name in names {
        bits |= perms::name_to_bit(name)
            .ok_or_else(|| ApiError::BadRequest(format!("unknown permission {name}")))?;
    }
    Ok(bits)
}

fn intent_bits(names: &[String]) -> ApiResult<u64> {
    let mut bits = 0u64;
    for name in names {
        let bit = events::intent_from_name(name)
            .ok_or_else(|| ApiError::BadRequest(format!("unknown bot intent {name}")))?;
        bits |= bit;
    }
    if bits & !events::BOT_INTENTS != 0 {
        return Err(ApiError::BadRequest(
            "one or more intents are not available to bots".into(),
        ));
    }
    Ok(bits)
}

async fn application_json(state: &AppState, application_id: &str) -> ApiResult<Value> {
    let row: Option<(
        String,
        String,
        String,
        String,
        Option<String>,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<String>,
        i64,
    )> = sqlx::query_as(
        "SELECT a.id, a.owner_user_id, a.name, a.description, a.icon_ref, a.bot_user_id, \
                s.allowed_intents, s.default_permissions, s.install_enabled, \
                a.created_at, a.updated_at, b.disabled, p.avatar_ref, p.profile_version \
         FROM bot_applications a \
         JOIN bot_settings s ON s.application_id = a.id \
         JOIN bot_identities b ON b.application_id = a.id \
         JOIN profiles p ON p.user_id = a.bot_user_id \
         WHERE a.id = ?",
    )
    .bind(application_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((
        id,
        owner_user_id,
        name,
        description,
        icon_ref,
        bot_user_id,
        allowed_intents,
        default_permissions,
        install_enabled,
        created_at,
        updated_at,
        disabled,
        avatar_ref,
        profile_version,
    )) = row
    else {
        return Err(ApiError::NotFound("application not found".into()));
    };
    let intents = allowed_intents as u64;
    let permissions = default_permissions as u64;
    Ok(json!({
        "id": id,
        "origin": state.cfg.server_name,
        "owner_user_id": owner_user_id,
        "name": name,
        "description": description,
        "icon_ref": icon_ref,
        "bot_user_id": bot_user_id,
        "bot_avatar_ref": avatar_ref,
        "profile_version": profile_version,
        "allowed_intents": intents.to_string(),
        "allowed_intent_names": events::intent_names(intents),
        "default_permissions": permissions.to_string(),
        "default_permission_names": perms::bits_to_names(permissions),
        "install_enabled": install_enabled != 0 && disabled == 0,
        "retired": disabled != 0,
        "created_at": created_at,
        "updated_at": updated_at,
    }))
}

async fn owned_application(state: &AppState, owner: &str, application_id: &str) -> ApiResult<()> {
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM bot_applications WHERE id = ? AND owner_user_id = ?")
            .bind(application_id)
            .bind(owner)
            .fetch_optional(&state.pool)
            .await?;
    found
        .map(|_| ())
        .ok_or_else(|| ApiError::NotFound("application not found".into()))
}

fn map_identity_conflict(e: sqlx::Error) -> ApiError {
    match e {
        sqlx::Error::Database(ref db)
            if db.message().contains("UNIQUE") || db.message().contains("constraint failed") =>
        {
            ApiError::Conflict("that bot account id is already in use".into())
        }
        other => ApiError::Db(other),
    }
}

#[derive(Deserialize)]
pub struct CreateApplication {
    pub name: String,
    pub localpart: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub allowed_intents: Option<Vec<String>>,
    #[serde(default)]
    pub default_permissions: Option<Vec<String>>,
}

pub async fn create_application(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<CreateApplication>,
) -> ApiResult<Json<Value>> {
    require_identity_role(&state)?;
    let moving: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM migrations \
         WHERE subject_type = 'user' AND subject_id = ? AND state IN ('pending', 'ready')",
    )
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    if moving > 0 {
        return Err(ApiError::Conflict(
            "finish or cancel the account migration before creating a bot application".into(),
        ));
    }
    if req.name.trim().is_empty() || req.name.chars().count() > 80 {
        return Err(ApiError::BadRequest(
            "application name must be 1-80 characters".into(),
        ));
    }
    if !valid_localpart(&req.localpart) {
        return Err(ApiError::BadRequest(
            "bot localpart must be 1-32 chars of [a-z0-9._-]".into(),
        ));
    }
    if req.description.chars().count() > 400 {
        return Err(ApiError::BadRequest(
            "application description is limited to 400 characters".into(),
        ));
    }
    let allowed = match req.allowed_intents.as_deref() {
        None => DEFAULT_BOT_INTENTS,
        Some(names) => intent_bits(names)?,
    };
    let default_permissions = match req.default_permissions.as_deref() {
        None => DEFAULT_BOT_PERMISSIONS,
        Some(names) => permission_bits(names)?,
    };

    let application_id = ulid();
    let credential_id = ulid();
    let bot_user_id = format!("@{}:{}", req.localpart, state.cfg.server_name);
    let token = format!("telium_bot_{}_{}", application_id, random_token(32));
    let now = now_ms();

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, description, bot_user_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&application_id)
    .bind(&auth.user_id)
    .bind(req.name.trim())
    .bind(req.description.trim())
    .bind(&bot_user_id)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|err| {
        let message = err.to_string();
        if message.contains("bot application owner is deleted or missing") {
            ApiError::Conflict("developer account can no longer create applications".into())
        } else if message.contains("account migration is already in flight") {
            ApiError::Conflict(
                "finish or cancel the account migration before creating a bot application".into(),
            )
        } else {
            ApiError::Db(err)
        }
    })?;
    sqlx::query(
        "INSERT INTO bot_identities \
         (user_id, application_id, localpart, domain, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&bot_user_id)
    .bind(&application_id)
    .bind(&req.localpart)
    .bind(&state.cfg.server_name)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(map_identity_conflict)?;
    sqlx::query(
        "INSERT INTO profiles (user_id, display_name, avatar_ref, profile_version, updated_at) \
         VALUES (?, ?, NULL, 1, ?)",
    )
    .bind(&bot_user_id)
    .bind(req.name.trim())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO bot_settings (application_id, allowed_intents, default_permissions) \
         VALUES (?, ?, ?)",
    )
    .bind(&application_id)
    .bind(allowed as i64)
    .bind(default_permissions as i64)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO bot_credentials (id, application_id, token_hash, created_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&credential_id)
    .bind(&application_id)
    .bind(hash_token(&token))
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let mut out = application_json(&state, &application_id).await?;
    out["token"] = Value::String(token);
    out["token_shown_once"] = Value::Bool(true);
    Ok(Json(out))
}

pub async fn list_applications(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_identity_role(&state)?;
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM bot_applications WHERE owner_user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut applications = Vec::with_capacity(ids.len());
    for id in ids {
        applications.push(application_json(&state, &id).await?);
    }
    Ok(Json(json!({ "applications": applications })))
}

pub async fn get_application(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(application_id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_application(&state, &auth.user_id, &application_id).await?;
    Ok(Json(application_json(&state, &application_id).await?))
}

#[derive(Deserialize)]
pub struct PatchApplication {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon_ref: Option<Option<String>>,
    #[serde(default)]
    pub allowed_intents: Option<Vec<String>>,
    #[serde(default)]
    pub default_permissions: Option<Vec<String>>,
    #[serde(default)]
    pub install_enabled: Option<bool>,
}

pub async fn patch_application(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(application_id): Path<String>,
    Json(req): Json<PatchApplication>,
) -> ApiResult<Json<Value>> {
    owned_application(&state, &auth.user_id, &application_id).await?;
    let now = now_ms();
    let bot_user_id: String =
        sqlx::query_scalar("SELECT bot_user_id FROM bot_applications WHERE id = ?")
            .bind(&application_id)
            .fetch_one(&state.pool)
            .await?;

    if let Some(name) = &req.name {
        if name.trim().is_empty() || name.chars().count() > 80 {
            return Err(ApiError::BadRequest(
                "application name must be 1-80 characters".into(),
            ));
        }
        sqlx::query("UPDATE bot_applications SET name = ?, updated_at = ? WHERE id = ?")
            .bind(name.trim())
            .bind(now)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
        sqlx::query(
            "UPDATE profiles SET display_name = ?, profile_version = profile_version + 1, \
                    updated_at = ? WHERE user_id = ?",
        )
        .bind(name.trim())
        .bind(now)
        .bind(&bot_user_id)
        .execute(&state.pool)
        .await?;
    }
    if let Some(description) = &req.description {
        if description.chars().count() > 400 {
            return Err(ApiError::BadRequest(
                "application description is limited to 400 characters".into(),
            ));
        }
        sqlx::query("UPDATE bot_applications SET description = ?, updated_at = ? WHERE id = ?")
            .bind(description.trim())
            .bind(now)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(icon_ref) = &req.icon_ref {
        sqlx::query("UPDATE bot_applications SET icon_ref = ?, updated_at = ? WHERE id = ?")
            .bind(icon_ref)
            .bind(now)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
        sqlx::query(
            "UPDATE profiles SET avatar_ref = ?, profile_version = profile_version + 1, \
                    updated_at = ? WHERE user_id = ?",
        )
        .bind(icon_ref)
        .bind(now)
        .bind(&bot_user_id)
        .execute(&state.pool)
        .await?;
    }
    if let Some(names) = &req.allowed_intents {
        let bits = intent_bits(names)?;
        sqlx::query("UPDATE bot_settings SET allowed_intents = ? WHERE application_id = ?")
            .bind(bits as i64)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(names) = &req.default_permissions {
        let bits = permission_bits(names)?;
        sqlx::query("UPDATE bot_settings SET default_permissions = ? WHERE application_id = ?")
            .bind(bits as i64)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(enabled) = req.install_enabled {
        sqlx::query("UPDATE bot_settings SET install_enabled = ? WHERE application_id = ?")
            .bind(i64::from(enabled))
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(application_json(&state, &application_id).await?))
}

async fn drop_bot_sessions(state: &AppState, bot_user_id: &str, application_id: &str) {
    let _ = sqlx::query("DELETE FROM bot_guild_sessions WHERE user_id = ? AND application_id = ?")
        .bind(bot_user_id)
        .bind(application_id)
        .execute(&state.pool)
        .await;
    state.hub.revoke(bot_user_id, None, None).await;
}

pub async fn reset_token(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(application_id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_application(&state, &auth.user_id, &application_id).await?;
    let bot_user_id: String =
        sqlx::query_scalar("SELECT bot_user_id FROM bot_applications WHERE id = ?")
            .bind(&application_id)
            .fetch_one(&state.pool)
            .await?;
    let token = format!("telium_bot_{}_{}", application_id, random_token(32));
    let credential_id = ulid();
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE bot_credentials SET revoked_at = ? \
         WHERE application_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(&application_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO bot_credentials (id, application_id, token_hash, created_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&credential_id)
    .bind(&application_id)
    .bind(hash_token(&token))
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    drop_bot_sessions(&state, &bot_user_id, &application_id).await;

    // Failure is swallowed: the token was already rotated and shown once.
    if let Err(e) = crate::rotations::record(
        &state.pool,
        crate::secrets::by_heading("Bot credentials").expect("bot credentials are in the inventory"),
        &crate::rotations::Actor::authenticated(&auth.user_id),
        crate::rotations::Detail {
            change: "replaced",
            note: "a bot application's token was reset from the console. The previous \
                   credential was revoked in the same transaction and the bot's guild \
                   sessions were dropped",
            affected: Some(1),
            ..Default::default()
        },
    )
    .await
    {
        tracing::warn!(
            target: crate::logcat::BOTS,
            error = %e,
            "bot token was rotated and the rotation record could not be written"
        );
    }

    Ok(Json(json!({
        "application_id": application_id,
        "token": token,
        "token_shown_once": true
    })))
}

pub async fn delete_application(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(application_id): Path<String>,
) -> ApiResult<Json<Value>> {
    owned_application(&state, &auth.user_id, &application_id).await?;
    let bot_user_id: String =
        sqlx::query_scalar("SELECT bot_user_id FROM bot_applications WHERE id = ?")
            .bind(&application_id)
            .fetch_one(&state.pool)
            .await?;
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE bot_settings SET install_enabled = 0 WHERE application_id = ?")
        .bind(&application_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE bot_identities SET disabled = 1 WHERE application_id = ?")
        .bind(&application_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE bot_credentials SET revoked_at = ? \
         WHERE application_id = ? AND revoked_at IS NULL",
    )
    .bind(now)
    .bind(&application_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    drop_bot_sessions(&state, &bot_user_id, &application_id).await;
    Ok(Json(json!({ "ok": true, "bot_user_id": bot_user_id })))
}

pub async fn federated_application(
    State(state): State<AppState>,
    _origin: crate::federation::FedOrigin,
    Path(application_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_identity_role(&state)?;
    Ok(Json(application_json(&state, &application_id).await?))
}

#[derive(Deserialize)]
pub struct BotAssertionRequest {
    pub audience: String,
}

pub async fn bot_assertion(
    State(state): State<AppState>,
    auth: BotAuth,
    Json(req): Json<BotAssertionRequest>,
) -> ApiResult<Json<Value>> {
    let audience = crate::federation::normalise_origin(&req.audience);
    if audience.is_empty() || audience.contains('/') {
        return Err(ApiError::BadRequest(
            "audience must be a server name".into(),
        ));
    }
    let profile: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT display_name, avatar_ref, profile_version FROM profiles WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (display_name, avatar_ref, profile_version) =
        profile.ok_or_else(|| ApiError::NotFound("bot profile not found".into()))?;
    let (allowed_intents, allowed_permissions): (i64, i64) = sqlx::query_as(
        "SELECT allowed_intents, default_permissions FROM bot_settings WHERE application_id = ?",
    )
    .bind(&auth.application_id)
    .fetch_one(&state.pool)
    .await?;
    let now = now_ms();
    let claims = AssertionClaims {
        user_id: auth.user_id,
        device_id: format!(
            "bot:{}:{}:{}",
            auth.application_id, allowed_intents as u64, allowed_permissions as u64
        ),
        device_pubkey: "bot".into(),
        audience,
        origin: state.cfg.server_name.clone(),
        profile_version,
        display_name,
        avatar_ref,
        iat: now,
        exp: now + state.cfg.sessions.assertion_ttl_secs * 1000,
    };
    Ok(Json(json!({
        "assertion": crypto::issue_assertion(&state.key, &claims),
        "expires_at": claims.exp,
    })))
}

#[derive(Deserialize)]
pub struct BotSessionRequest {
    pub assertion: String,
}

fn bot_claim_device(value: &str) -> ApiResult<(String, u64, u64)> {
    let mut parts = value.split(':');
    let (Some("bot"), Some(application_id), Some(intents), Some(permissions), None) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(ApiError::Unauthorized(
            "assertion is not a bot assertion".into(),
        ));
    };
    let allowed_intents = intents
        .parse::<u64>()
        .map_err(|_| ApiError::Unauthorized("bot assertion has invalid intents".into()))?;
    if allowed_intents & !events::BOT_INTENTS != 0 {
        return Err(ApiError::Unauthorized(
            "bot assertion contains forbidden intents".into(),
        ));
    }
    let allowed_permissions = permissions
        .parse::<u64>()
        .map_err(|_| ApiError::Unauthorized("bot assertion has invalid permissions".into()))?;
    Ok((
        application_id.to_string(),
        allowed_intents,
        allowed_permissions,
    ))
}

pub async fn create_bot_session(
    State(state): State<AppState>,
    Json(req): Json<BotSessionRequest>,
) -> Result<Json<Value>, Coded> {
    require_guild_role(&state).map_err(|e| Coded::new(e, CODE_NOT_A_GUILD_SERVER))?;
    let claims =
        crate::federation::verify_assertion(&state, &req.assertion, &state.cfg.server_name)
            .await
            .map_err(|e| Coded::new(e, CODE_ASSERTION_REJECTED))?;
    if claims.device_pubkey != "bot" {
        return Err(Coded::new(
            ApiError::Unauthorized("assertion is not a bot assertion".into()),
            CODE_ASSERTION_REJECTED,
        ));
    }
    let (application_id, allowed_intents, allowed_permissions) =
        bot_claim_device(&claims.device_id).map_err(|e| Coded::new(e, CODE_ASSERTION_REJECTED))?;
    let (_, user_domain) = split_user_id(&claims.user_id).ok_or_else(|| {
        Coded::new(
            ApiError::Unauthorized("bot assertion has malformed user id".into()),
            CODE_ASSERTION_REJECTED,
        )
    })?;
    if user_domain != claims.origin {
        return Err(Coded::new(
            ApiError::Unauthorized("bot identity does not belong to its assertion origin".into()),
            CODE_ASSERTION_REJECTED,
        ));
    }
    let installed: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members \
         WHERE user_id = ? AND banned = 0 AND bot_application_id = ? \
           AND bot_application_origin = ? \
           AND bot_role_id IS NOT NULL AND bot_installed_by IS NOT NULL LIMIT 1",
    )
    .bind(&claims.user_id)
    .bind(&application_id)
    .bind(&claims.origin)
    .fetch_optional(&state.pool)
    .await?;
    if installed.is_none() {
        return Err(Coded::new(
            ApiError::Forbidden("bot is not installed on this guild server".into()),
            CODE_NOT_INSTALLED,
        ));
    }

    sqlx::query(
        "UPDATE roles SET permissions = permissions & ? \
         WHERE EXISTS ( \
           SELECT 1 FROM members m \
            WHERE m.guild_id = roles.guild_id AND m.bot_role_id = roles.id \
              AND m.user_id = ? AND m.banned = 0 \
              AND m.bot_application_id = ? AND m.bot_application_origin = ? \
         ) AND (permissions & ?) <> permissions",
    )
    .bind(allowed_permissions as i64)
    .bind(&claims.user_id)
    .bind(&application_id)
    .bind(&claims.origin)
    .bind(allowed_permissions as i64)
    .execute(&state.pool)
    .await?;

    let token = random_token(32);
    let now = now_ms();
    let ttl_secs = state
        .cfg
        .sessions
        .guild_session_ttl_secs
        .min(state.cfg.sessions.assertion_ttl_secs)
        .max(1);
    let expires_at = now + ttl_secs * 1000;
    sqlx::query(
        "INSERT INTO bot_guild_sessions \
         (token_hash, user_id, application_id, home_domain, display_name, avatar_ref, \
          allowed_intents, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(&claims.user_id)
    .bind(&application_id)
    .bind(&claims.origin)
    .bind(&claims.display_name)
    .bind(&claims.avatar_ref)
    .bind(allowed_intents as i64)
    .bind(now)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "session_token": token,
        "user_id": claims.user_id,
        "application_id": application_id,
        "expires_at": expires_at,
        "gateway": format!("{}/gateway/v1", state.cfg.public_base_url.replace("http", "ws")),
    })))
}

pub async fn bot_installations(
    State(state): State<AppState>,
    auth: BotAuth,
) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT remote_guild_id, guild_domain, allowed_intents, permissions, installed_at \
         FROM bot_installations \
         WHERE application_id = ? AND removed_at IS NULL ORDER BY installed_at",
    )
    .bind(&auth.application_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "application_id": auth.application_id,
        "bot_user_id": auth.user_id,
        "installations": rows.into_iter().map(|(guild_id, guild_domain, intents, permissions, installed_at)| json!({
            "guild_id": guild_id,
            "guild_domain": guild_domain,
            "allowed_intents": (intents as u64).to_string(),
            "allowed_intent_names": events::intent_names(intents as u64),
            "permissions": (permissions as u64).to_string(),
            "permission_names": perms::bits_to_names(permissions as u64),
            "installed_at": installed_at,
        })).collect::<Vec<_>>()
    })))
}

async fn record_receipt_inner(state: &AppState, origin: &str, body: &Value) -> ApiResult<()> {
    require_identity_role(state)?;
    let origin = crate::federation::normalise_origin(origin);
    let application_id = body
        .get("application_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("receipt has no application_id".into()))?;
    let bot_user_id = body
        .get("bot_user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("receipt has no bot_user_id".into()))?;
    let guild_id = body
        .get("guild_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("receipt has no guild_id".into()))?;
    let active = body.get("active").and_then(Value::as_bool).unwrap_or(false);

    if let Some(claimed) = body.get("guild_domain").and_then(Value::as_str) {
        if crate::federation::normalise_origin(claimed) != origin {
            return Err(ApiError::Forbidden(
                "a receipt must come from the guild server it names".into(),
            ));
        }
    }

    if origin == state.cfg.server_name {
        return Err(ApiError::Forbidden(
            "a receipt for this server's own guilds is not a federation message".into(),
        ));
    }

    crate::federation::ensure_reachable(state, &origin, "identity").await?;

    // Only activating receipts are gated; retiring ones must always land.
    let row: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT a.bot_user_id, COALESCE(s.install_enabled, 0), COALESCE(b.disabled, 1) \
         FROM bot_applications a \
         LEFT JOIN bot_settings s ON s.application_id = a.id \
         LEFT JOIN bot_identities b ON b.application_id = a.id \
         WHERE a.id = ?",
    )
    .bind(application_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((expected_bot, install_enabled, disabled)) = row else {
        return Err(ApiError::Forbidden(
            "receipt does not name this application's bot".into(),
        ));
    };
    if expected_bot != bot_user_id {
        return Err(ApiError::Forbidden(
            "receipt does not name this application's bot".into(),
        ));
    }
    if active && (install_enabled == 0 || disabled != 0) {
        return Err(ApiError::Forbidden(
            "this application is not accepting installations".into(),
        ));
    }

    let allowed_intents = body
        .get("allowed_intents")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let permissions = body
        .get("permissions")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO bot_installations \
         (application_id, bot_user_id, remote_guild_id, guild_domain, allowed_intents, permissions, installed_at, removed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(application_id, guild_domain, remote_guild_id) DO UPDATE SET \
           bot_user_id = excluded.bot_user_id, allowed_intents = excluded.allowed_intents, \
           permissions = excluded.permissions, \
           installed_at = CASE \
             WHEN bot_installations.removed_at IS NOT NULL AND excluded.removed_at IS NULL \
             THEN MAX(excluded.installed_at, bot_installations.installed_at + 1) \
             ELSE bot_installations.installed_at END, \
           removed_at = excluded.removed_at",
    )
    .bind(application_id)
    .bind(bot_user_id)
    .bind(guild_id)
    .bind(&origin)
    .bind(allowed_intents as i64)
    .bind(permissions as i64)
    .bind(now)
    .bind(if active { None } else { Some(now) })
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn installation_receipt(
    State(state): State<AppState>,
    fed: crate::federation::Fed<Value>,
) -> ApiResult<Json<Value>> {
    record_receipt_inner(&state, &fed.origin, &fed.body).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn flush_receipt_now(
    state: &AppState,
    application_origin: &str,
    application_id: &str,
    guild_id: &str,
) -> bool {
    let _ = crate::bot_receipts::flush_due(state).await;
    crate::bot_receipts::delivered(state, application_origin, application_id, guild_id)
        .await
        .unwrap_or(false)
}

#[derive(Deserialize)]
pub struct InstallBot {
    pub application_id: String,
    pub application_origin: String,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
    #[serde(default)]
    pub intents: Option<Vec<String>>,
}

async fn descriptor_for(
    state: &AppState,
    application_origin: &str,
    application_id: &str,
) -> ApiResult<Value> {
    if application_origin == state.cfg.server_name {
        return application_json(state, application_id).await;
    }
    let opaque = || {
        ApiError::BadRequest(format!(
            "{application_origin} did not answer as a Telium application home"
        ))
    };
    let descriptor = crate::federation::get_signed(
        state,
        application_origin,
        &format!("/_telium/v1/applications/{application_id}/federation"),
    )
    .await
    .map_err(|error| {
        tracing::debug!(target: crate::logcat::BOTS, %application_origin, %application_id, %error, "bot descriptor fetch failed");
        opaque()
    })?;
    if descriptor.get("origin").and_then(Value::as_str) != Some(application_origin)
        || !descriptor.get("bot_user_id").is_some_and(Value::is_string)
    {
        tracing::debug!(
            target: crate::logcat::BOTS,
            %application_origin,
            %application_id,
            "bot descriptor fetch returned something that is not an application descriptor"
        );
        return Err(opaque());
    }
    Ok(descriptor)
}

fn descriptor_intents(descriptor: &Value) -> u64 {
    descriptor
        .get("allowed_intents")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn descriptor_permissions(descriptor: &Value) -> u64 {
    descriptor
        .get("default_permissions")
        .and_then(Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn descriptor_identity<'a>(
    descriptor: &'a Value,
    application_origin: &str,
) -> ApiResult<(&'a str, &'a str)> {
    if descriptor.get("origin").and_then(Value::as_str) != Some(application_origin) {
        return Err(ApiError::BadRequest(
            "application origin did not match its descriptor".into(),
        ));
    }
    let bot_user_id = descriptor
        .get("bot_user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("application descriptor has no bot identity".into()))?;
    let name = descriptor
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Bot");
    let (_, bot_domain) = split_user_id(bot_user_id)
        .ok_or_else(|| ApiError::BadRequest("application published a malformed bot id".into()))?;
    if bot_domain != application_origin {
        return Err(ApiError::BadRequest(
            "bot identity does not belong to the application origin".into(),
        ));
    }
    Ok((bot_user_id, name))
}

fn validate_descriptor<'a>(
    descriptor: &'a Value,
    application_origin: &str,
) -> ApiResult<(&'a str, &'a str)> {
    let identity = descriptor_identity(descriptor, application_origin)?;
    if !descriptor
        .get("install_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(ApiError::Forbidden(
            "this application is not accepting installations".into(),
        ));
    }
    Ok(identity)
}

#[derive(Deserialize)]
pub struct PreviewBot {
    pub application_id: String,
    pub application_origin: String,
}

pub async fn preview_bot(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<PreviewBot>,
) -> ApiResult<Json<Value>> {
    require_guild_role(&state)?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let application_origin = crate::federation::normalise_origin(&req.application_origin);
    let descriptor = descriptor_for(&state, &application_origin, &req.application_id).await?;
    let (bot_user_id, name) = descriptor_identity(&descriptor, &application_origin)?;
    Ok(Json(json!({
        "application_id": req.application_id,
        "application_origin": application_origin,
        "name": name,
        "description": descriptor.get("description").and_then(Value::as_str).unwrap_or(""),
        "bot_user_id": bot_user_id,
        "bot_avatar_ref": descriptor.get("bot_avatar_ref").cloned().unwrap_or(Value::Null),
        "allowed_intent_names": events::intent_names(descriptor_intents(&descriptor)),
        "default_permission_names": perms::bits_to_names(descriptor_permissions(&descriptor)),
        "install_enabled": descriptor.get("install_enabled").and_then(Value::as_bool).unwrap_or(false),
        "retired": descriptor.get("retired").and_then(Value::as_bool).unwrap_or(false),
    })))
}

fn ensure_grantable(actor_permissions: u64, requested: u64) -> ApiResult<()> {
    if actor_permissions != u64::MAX && requested & !actor_permissions != 0 {
        return Err(ApiError::Forbidden(
            "cannot grant a bot permissions the installer does not have".into(),
        ));
    }
    Ok(())
}

pub async fn install_bot(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<InstallBot>,
) -> ApiResult<Json<Value>> {
    require_guild_role(&state)?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let actor =
        guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD)
            .await?;
    let application_origin = crate::federation::normalise_origin(&req.application_origin);
    let descriptor = descriptor_for(&state, &application_origin, &req.application_id).await?;
    let (bot_user_id, app_name) = validate_descriptor(&descriptor, &application_origin)?;
    let bot_user_id = bot_user_id.to_string();
    let app_name = app_name.to_string();
    let global_intents = descriptor_intents(&descriptor);
    let requested_intents = match req.intents.as_deref() {
        None => global_intents & DEFAULT_BOT_INTENTS,
        Some(names) => intent_bits(names)?,
    };
    if requested_intents & !global_intents != 0 {
        return Err(ApiError::Forbidden(
            "requested intents exceed the application's declared ceiling".into(),
        ));
    }
    let permission_ceiling = descriptor_permissions(&descriptor);
    let requested_permissions = match req.permissions.as_deref() {
        None => permission_ceiling,
        Some(names) => permission_bits(names)?,
    };
    if requested_permissions & !permission_ceiling != 0 {
        return Err(ApiError::Forbidden(
            "requested permissions exceed the application's declared ceiling".into(),
        ));
    }
    ensure_grantable(actor.guild_permissions(), requested_permissions)?;

    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(&guild_id)
            .bind(&bot_user_id)
            .fetch_optional(&state.pool)
            .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict(
            "bot is already a member of this guild".into(),
        ));
    }

    let role_id = ulid();
    let now = now_ms();
    let avatar_ref = descriptor.get("bot_avatar_ref").and_then(Value::as_str);
    let profile_version = descriptor
        .get("profile_version")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let shifted_role_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM roles WHERE guild_id = ? AND id <> ? AND position >= 1")
            .bind(&guild_id)
            .bind(&guild_id)
            .fetch_all(&state.pool)
            .await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE roles SET position = position + 1 \
         WHERE guild_id = ? AND id <> ? AND position >= 1",
    )
    .bind(&guild_id)
    .bind(&guild_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, color, position, permissions) \
         VALUES (?, ?, ?, 0, 1, ?)",
    )
    .bind(&role_id)
    .bind(&guild_id)
    .bind(format!("{app_name} Bot"))
    .bind(requested_permissions as i64)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO members \
         (guild_id, user_id, joined_at, display_name, avatar_ref, profile_version, \
          bot_application_id, bot_application_origin, bot_allowed_intents, bot_role_id, bot_installed_by) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&guild_id)
    .bind(&bot_user_id)
    .bind(now)
    .bind(&app_name)
    .bind(avatar_ref)
    .bind(profile_version)
    .bind(&req.application_id)
    .bind(&application_origin)
    .bind(requested_intents as i64)
    .bind(&role_id)
    .bind(&auth.user_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)")
        .bind(&guild_id)
        .bind(&bot_user_id)
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "bot.install",
        Some(&bot_user_id),
        json!({
            "application_id": req.application_id,
            "application_origin": application_origin,
            "permissions": perms::bits_to_names(requested_permissions),
            "intents": events::intent_names(requested_intents),
        }),
    )
    .await?;

    if let Ok(roles) = guildstore::roles_json(&state, &guild_id).await {
        if let Some(role) = roles.iter().find(|role| role["id"] == role_id) {
            state
                .hub
                .publish(events::Event::new(
                    "ROLE_CREATE",
                    guild_id.clone(),
                    events::INTENT_GUILD_STRUCTURE,
                    role.clone(),
                ))
                .await;
        }
        for shifted in &shifted_role_ids {
            if let Some(role) = roles.iter().find(|role| role["id"] == shifted.as_str()) {
                state
                    .hub
                    .publish(events::Event::new(
                        "ROLE_UPDATE",
                        guild_id.clone(),
                        events::INTENT_GUILD_STRUCTURE,
                        role.clone(),
                    ))
                    .await;
            }
        }
    }

    state
        .hub
        .publish(events::Event::new(
            "MEMBER_ADD",
            guild_id.clone(),
            events::INTENT_GUILD_MEMBERS,
            json!({
                "guild_id": guild_id,
                "user_id": bot_user_id,
                "display_name": app_name,
                "avatar_ref": avatar_ref,
                "profile_version": profile_version,
                "is_bot": true,
                "application_id": req.application_id,
                "roles": [role_id],
            }),
        ))
        .await;

    let delivered =
        flush_receipt_now(&state, &application_origin, &req.application_id, &guild_id).await;
    Ok(Json(json!({
        "ok": true,
        "bot_user_id": bot_user_id,
        "application_id": req.application_id,
        "role_id": role_id,
        "allowed_intents": requested_intents.to_string(),
        "permissions": requested_permissions.to_string(),
        "receipt_delivered": delivered,
    })))
}

pub async fn list_guild_bots(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let rows: Vec<(
        String,
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        i64,
    )> = sqlx::query_as(
        "SELECT user_id, bot_application_id, bot_application_origin, bot_role_id, \
                    bot_allowed_intents, display_name, avatar_ref, joined_at \
             FROM members WHERE guild_id = ? AND bot_application_id IS NOT NULL \
             ORDER BY joined_at",
    )
    .bind(&guild_id)
    .fetch_all(&state.pool)
    .await?;
    let mut bots = Vec::with_capacity(rows.len());
    for (
        user_id,
        application_id,
        application_origin,
        role_id,
        intents,
        display_name,
        avatar_ref,
        installed_at,
    ) in rows
    {
        let permissions: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
            .bind(&role_id)
            .fetch_optional(&state.pool)
            .await?
            .unwrap_or(0);
        bots.push(json!({
            "bot_user_id": user_id,
            "application_id": application_id,
            "application_origin": application_origin,
            "role_id": role_id,
            "display_name": display_name,
            "avatar_ref": avatar_ref,
            "allowed_intents": (intents as u64).to_string(),
            "allowed_intent_names": events::intent_names(intents as u64),
            "permissions": (permissions as u64).to_string(),
            "permission_names": perms::bits_to_names(permissions as u64),
            "installed_at": installed_at,
        }));
    }
    Ok(Json(json!({ "bots": bots })))
}

#[derive(Deserialize)]
pub struct PatchBotInstallation {
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
    #[serde(default)]
    pub intents: Option<Vec<String>>,
}

pub async fn patch_bot(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, bot_user_id)): Path<(String, String)>,
    Json(req): Json<PatchBotInstallation>,
) -> ApiResult<Json<Value>> {
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let actor =
        guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD)
            .await?;
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT bot_application_id, bot_application_origin, bot_role_id, bot_allowed_intents \
         FROM members WHERE guild_id = ? AND user_id = ? AND bot_application_id IS NOT NULL",
    )
    .bind(&guild_id)
    .bind(&bot_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (application_id, application_origin, role_id, current_intents) =
        row.ok_or_else(|| ApiError::NotFound("bot installation not found".into()))?;
    let current_permissions: i64 = sqlx::query_scalar("SELECT permissions FROM roles WHERE id = ?")
        .bind(&role_id)
        .fetch_one(&state.pool)
        .await?;
    let intents = match &req.intents {
        Some(names) => intent_bits(names)?,
        None => current_intents as u64,
    };
    let permissions = match &req.permissions {
        Some(names) => permission_bits(names)?,
        None => current_permissions as u64,
    };
    let added_intents = intents & !(current_intents as u64);
    let added_permissions = permissions & !(current_permissions as u64);
    ensure_grantable(actor.guild_permissions(), added_permissions)?;
    if added_intents != 0 || added_permissions != 0 {
        let descriptor = descriptor_for(&state, &application_origin, &application_id).await?;
        let (published_bot, _) = validate_descriptor(&descriptor, &application_origin)?;
        if published_bot != bot_user_id {
            return Err(ApiError::Conflict(
                "application descriptor no longer matches this installed bot identity".into(),
            ));
        }
        let global_intents = descriptor_intents(&descriptor);
        if added_intents & !global_intents != 0 {
            return Err(ApiError::Forbidden(
                "requested intents exceed the application's declared ceiling".into(),
            ));
        }
        let permission_ceiling = descriptor_permissions(&descriptor);
        if added_permissions & !permission_ceiling != 0 {
            return Err(ApiError::Forbidden(
                "requested permissions exceed the application's declared ceiling".into(),
            ));
        }
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE members SET bot_allowed_intents = ? WHERE guild_id = ? AND user_id = ?")
        .bind(intents as i64)
        .bind(&guild_id)
        .bind(&bot_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE roles SET permissions = ? WHERE id = ? AND guild_id = ?")
        .bind(permissions as i64)
        .bind(&role_id)
        .bind(&guild_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "bot.update",
        Some(&bot_user_id),
        json!({
            "application_id": application_id,
            "permissions": perms::bits_to_names(permissions),
            "intents": events::intent_names(intents),
        }),
    )
    .await?;
    if let Ok(roles) = guildstore::roles_json(&state, &guild_id).await {
        if let Some(role) = roles.iter().find(|role| role["id"] == role_id) {
            state
                .hub
                .publish(events::Event::new(
                    "ROLE_UPDATE",
                    guild_id.clone(),
                    events::INTENT_GUILD_STRUCTURE,
                    role.clone(),
                ))
                .await;
        }
    }
    let delivered =
        flush_receipt_now(&state, &application_origin, &application_id, &guild_id).await;
    Ok(Json(json!({
        "ok": true,
        "allowed_intents": intents.to_string(),
        "permissions": permissions.to_string(),
        "receipt_delivered": delivered,
    })))
}

pub async fn uninstall_bot(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, bot_user_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT m.bot_application_id, m.bot_application_origin, m.bot_role_id, r.position \
         FROM members m JOIN roles r ON r.id = m.bot_role_id AND r.guild_id = m.guild_id \
         WHERE m.guild_id = ? AND m.user_id = ? AND m.bot_application_id IS NOT NULL",
    )
    .bind(&guild_id)
    .bind(&bot_user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (application_id, application_origin, role_id, role_position) =
        row.ok_or_else(|| ApiError::NotFound("bot installation not found".into()))?;
    let shifted_role_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM roles WHERE guild_id = ? AND id <> ? AND position > ?")
            .bind(&guild_id)
            .bind(&guild_id)
            .bind(role_position)
            .fetch_all(&state.pool)
            .await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?")
        .bind(&guild_id)
        .bind(&bot_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = ?")
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
        .bind(&guild_id)
        .bind(&bot_user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM roles WHERE guild_id = ? AND id = ?")
        .bind(&guild_id)
        .bind(&role_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE roles SET position = position - 1 \
         WHERE guild_id = ? AND id <> ? AND position > ?",
    )
    .bind(&guild_id)
    .bind(&guild_id)
    .bind(role_position)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "bot.uninstall",
        Some(&bot_user_id),
        json!({
            "application_id": application_id,
            "application_origin": application_origin,
        }),
    )
    .await?;
    state.hub.revoke(&bot_user_id, None, None).await;
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM members WHERE user_id = ? AND bot_application_id = ?",
    )
    .bind(&bot_user_id)
    .bind(&application_id)
    .fetch_one(&state.pool)
    .await?;
    if remaining == 0 {
        sqlx::query("DELETE FROM bot_guild_sessions WHERE user_id = ? AND application_id = ?")
            .bind(&bot_user_id)
            .bind(&application_id)
            .execute(&state.pool)
            .await?;
    }
    state
        .hub
        .publish(events::Event::new(
            "MEMBER_REMOVE",
            guild_id.clone(),
            events::INTENT_GUILD_MEMBERS,
            json!({ "guild_id": guild_id, "user_id": bot_user_id }),
        ))
        .await;
    state
        .hub
        .publish(events::Event::new(
            "ROLE_DELETE",
            guild_id.clone(),
            events::INTENT_GUILD_STRUCTURE,
            json!({ "guild_id": guild_id, "id": role_id }),
        ))
        .await;
    if let Ok(roles) = guildstore::roles_json(&state, &guild_id).await {
        for shifted in &shifted_role_ids {
            if let Some(role) = roles.iter().find(|role| role["id"] == shifted.as_str()) {
                state
                    .hub
                    .publish(events::Event::new(
                        "ROLE_UPDATE",
                        guild_id.clone(),
                        events::INTENT_GUILD_STRUCTURE,
                        role.clone(),
                    ))
                    .await;
            }
        }
    }

    let delivered =
        flush_receipt_now(&state, &application_origin, &application_id, &guild_id).await;
    Ok(Json(json!({ "ok": true, "receipt_delivered": delivered })))
}
