
use crate::auth::HomeAuth;
use crate::crypto::{self, AssertionClaims};
use crate::errcodes;
use crate::error::{ApiError, ApiResult, Coded};
use crate::state::AppState;
use crate::util::{
    b64, hash_token, now_ms, random_token, split_user_id, ulid, valid_localpart,
};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use hmac::{Hmac, Mac};
use sha1::Sha1;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::Json;
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod mfa;
mod profile;

pub use mfa::*;
pub use profile::*;

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub localpart: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_pubkey: Option<String>,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub user_id: String,
    pub device_id: String,
    pub access_token: String,
    pub expires_at: i64,
    pub server_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opaque_upgrade_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sunset: Option<Value>,
}

pub async fn register(
    State(state): State<AppState>,
    Json(req): Json<RegisterRequest>,
) -> ApiResult<Json<LoginResponse>> {
    if !crate::sunset::registration_open(&state).await {
        return Err(ApiError::Forbidden("registration is closed on this server".into())
            .with_code(errcodes::REGISTRATION_CLOSED));
    }
    let localpart = req.localpart.to_ascii_lowercase();
    if !valid_localpart(&localpart) {
        return Err(ApiError::BadRequest(
            "localpart must be 1-32 chars of [A-Za-z0-9._-]".into(),
        )
        .with_code(errcodes::USERNAME_INVALID)
        .with_detail("reason", crate::util::localpart_fault(&localpart)));
    }
    if req.password.len() < state.cfg.registration.min_password_len {
        return Err(ApiError::BadRequest(format!(
            "password must be at least {} characters",
            state.cfg.registration.min_password_len
        )));
    }

    let user_id = format!("@{}:{}", localpart, state.cfg.server_name);
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT subject_id FROM identity_localparts WHERE localpart = ? AND domain = ?",
    )
    .bind(&localpart)
    .bind(&state.cfg.server_name)
    .fetch_optional(&state.pool)
    .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict("that username is taken".into())
            .with_code(errcodes::USERNAME_TAKEN));
    }

    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(req.password.as_bytes(), &salt)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("hashing password: {e}")))?
        .to_string();

    let now = now_ms();
    // Take the write lock before the count; a deferred read-then-write hits SQLITE_BUSY_SNAPSHOT.
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(&mut *tx)
        .await?;
    let admin =
        accounts == 0 || state.cfg.registration.admins.iter().any(|a| a.eq_ignore_ascii_case(&localpart));
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at, admin) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&localpart)
    .bind(&state.cfg.server_name)
    .bind(&hash)
    .bind(now)
    .bind(admin as i64)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO profiles (user_id, display_name, profile_version, updated_at) \
         VALUES (?, ?, 1, ?)",
    )
    .bind(&user_id)
    .bind(&req.localpart)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let (device_id, token, expires_at, device_secret) = create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or("initial device"),
        req.device_pubkey.as_deref(),
    )
    .await?;

    Ok(Json(LoginResponse {
        user_id,
        device_id,
        access_token: token,
        expires_at,
        server_name: state.cfg.server_name.clone(),
        device_secret,
        opaque_upgrade_token: None,
        sunset: crate::sunset::login_notice(&state).await,
    }))
}

pub(crate) fn canonical_login_user_id(user: &str, server_name: &str) -> String {
    if user.starts_with('@') {
        if let Some((localpart, domain)) = split_user_id(user) {
            return format!("@{}:{}", localpart.to_ascii_lowercase(), domain);
        }
        return user.to_string();
    }
    format!("@{}:{}", user.to_ascii_lowercase(), server_name)
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub user: String,
    pub password: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_pubkey: Option<String>,
    #[serde(default)]
    pub mfa_code: Option<String>,
}

pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let user_id = canonical_login_user_id(&req.user, &state.cfg.server_name);
    let user_id = crate::relocation::current_user_id(&state, user_id).await;

    let row: Option<(String, Option<String>, i64, Option<i64>, i64, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT password_hash, opaque_record, deactivated, deleted_at, mfa_enabled, mfa_secret, \
             mfa_sealed FROM accounts WHERE user_id = ?",
        )
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await?;
    // Same error for unknown user and wrong password.
    let (hash, opaque_record, deactivated, deleted_at, mfa_enabled, mfa_secret, mfa_sealed) =
        row.ok_or_else(|| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if opaque_record.is_some() || deleted_at.is_some() {
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    let parsed = PasswordHash::new(&hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored hash unreadable: {e}")))?;
    Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed)
        .map_err(|_| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if deactivated != 0 {
        return Err(ApiError::Unauthorized("account_deactivated".into())
            .with_code(errcodes::ACCOUNT_DEACTIVATED));
    }

    verify_login_mfa(
        &state,
        &user_id,
        mfa_enabled,
        mfa_secret.as_deref(),
        mfa_sealed.as_deref(),
        req.mfa_code.as_deref(),
    )
    .await?;

    let (device_id, token, expires_at, device_secret) = create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or("device"),
        req.device_pubkey.as_deref(),
    )
    .await?;

    let opaque_upgrade_token =
        Some(super::opaque::issue_enroll_token(&state, &user_id).await?);
    Ok(Json(LoginResponse {
        user_id,
        device_id,
        access_token: token,
        expires_at,
        server_name: state.cfg.server_name.clone(),
        device_secret,
        opaque_upgrade_token,
        sunset: crate::sunset::login_notice(&state).await,
    }))
}

pub async fn reactivate(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<LoginResponse>> {
    let user_id = canonical_login_user_id(&req.user, &state.cfg.server_name);
    let row: Option<(String, Option<String>, i64, Option<i64>, i64, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT password_hash, opaque_record, deactivated, deleted_at, mfa_enabled, mfa_secret, \
             mfa_sealed FROM accounts WHERE user_id = ?",
        )
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await?;
    let (hash, opaque_record, deactivated, deleted_at, mfa_enabled, mfa_secret, mfa_sealed) =
        row.ok_or_else(|| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if opaque_record.is_some() || deleted_at.is_some() {
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    let parsed = PasswordHash::new(&hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored hash unreadable: {e}")))?;
    Argon2::default()
        .verify_password(req.password.as_bytes(), &parsed)
        .map_err(|_| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if deactivated == 0 {
        return Err(ApiError::Conflict("account is already active".into())
            .with_code(errcodes::ACCOUNT_ALREADY_ACTIVE));
    }
    crate::admin::accounts::refuse_operator_suspended(&state, &user_id).await?;
    verify_login_mfa(
        &state,
        &user_id,
        mfa_enabled,
        mfa_secret.as_deref(),
        mfa_sealed.as_deref(),
        req.mfa_code.as_deref(),
    )
    .await?;

    sqlx::query("UPDATE accounts SET deactivated = 0 WHERE user_id = ?")
        .bind(&user_id)
        .execute(&state.pool)
        .await?;

    let (device_id, token, expires_at, device_secret) = create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or("reactivated device"),
        req.device_pubkey.as_deref(),
    )
    .await?;
    let opaque_upgrade_token =
        Some(super::opaque::issue_enroll_token(&state, &user_id).await?);
    Ok(Json(LoginResponse {
        user_id,
        device_id,
        access_token: token,
        expires_at,
        server_name: state.cfg.server_name.clone(),
        device_secret,
        opaque_upgrade_token,
        sunset: crate::sunset::login_notice(&state).await,
    }))
}

pub(crate) async fn verify_login_mfa(
    state: &AppState,
    user_id: &str,
    enabled: i64,
    cleartext: Option<&str>,
    sealed: Option<&str>,
    code: Option<&str>,
) -> ApiResult<()> {
    if enabled == 0 {
        return Ok(());
    }
    let code = code.ok_or_else(|| ApiError::Unauthorized("mfa_required".into()).with_code(errcodes::MFA_REQUIRED))?;
    let secret = crate::mfa::from_row(&state.mfa, user_id, cleartext, sealed);
    if secret.is_none() && cleartext.is_none() && sealed.is_none() {
        return Err(ApiError::Internal(anyhow::anyhow!("MFA enabled without a secret")));
    }
    if !mfa::consume_mfa_code(state, user_id, secret.as_deref(), code).await? {
        return Err(ApiError::Unauthorized("invalid_mfa_code".into()).with_code(errcodes::INVALID_MFA_CODE));
    }
    Ok(())
}

pub(crate) async fn create_device_session(
    state: &AppState,
    user_id: &str,
    device_name: &str,
    device_pubkey: Option<&str>,
) -> ApiResult<(String, String, i64, Option<String>)> {
    let (pubkey, secret) = match device_pubkey {
        Some(pk) => {
            if crate::util::unb64(pk).map(|v| v.len()) != Some(32) {
                return Err(ApiError::BadRequest(
                    "device_pubkey must be 32 base64url bytes of Ed25519 public key".into(),
                ));
            }
            (pk.to_string(), None)
        }
        None => {
            let bytes: [u8; 32] = rand::random();
            let signing = SigningKey::from_bytes(&bytes);
            (b64(signing.verifying_key().as_bytes()), Some(b64(&bytes)))
        }
    };

    let device_id = ulid();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO devices (device_id, user_id, name, pubkey_b64, created_at, last_seen) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&device_id)
    .bind(user_id)
    .bind(device_name)
    .bind(&pubkey)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let token = random_token(32);
    let expires_at = now + state.cfg.sessions.home_session_ttl_secs * 1000;
    sqlx::query(
        "INSERT INTO home_sessions (token_hash, user_id, device_id, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(&device_id)
    .bind(now)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok((device_id, token, expires_at, secret))
}

pub async fn logout(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM home_sessions WHERE device_id = ?")
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("UPDATE devices SET active = 0 WHERE device_id = ?")
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;
    // Also revokes guild sessions; DEVICE, not ALL_DEVICES.
    crate::revocation::announce(
        &state,
        &auth.user_id,
        crate::revocation::DEVICE,
        Some(&auth.device_id),
        None,
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn whoami(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let profile = load_profile(&state, &auth.user_id).await?;
    let security: (i64, i64) = sqlx::query_as(
        "SELECT admin, mfa_enabled FROM accounts WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "user_id": auth.user_id,
        "device_id": auth.device_id,
        "server_name": state.cfg.server_name,
        "admin": security.0 != 0,
        "mfa_enabled": security.1 != 0,
        "profile": profile,
    })))
}

#[derive(Deserialize)]
pub struct ReauthRequest {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

pub async fn deactivate(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<ReauthRequest>,
) -> ApiResult<Json<Value>> {
    verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    crate::ownership::refuse_if_last_admin(
        &state.pool,
        &auth.user_id,
        crate::ownership::Departure::Deactivate,
    )
    .await?;
    sqlx::query("UPDATE accounts SET deactivated = 1 WHERE user_id = ?")
        .bind(&auth.user_id)
        .execute(&state.pool)
        .await?;
    revoke_all_sessions(&state, &auth.user_id).await?;
    crate::revocation::announce(&state, &auth.user_id, crate::revocation::DEACTIVATED, None, None).await;
    Ok(Json(json!({ "ok": true, "status": "deactivated" })))
}

pub async fn logout_all(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    revoke_all_sessions(&state, &auth.user_id).await?;
    crate::revocation::announce(&state, &auth.user_id, crate::revocation::ALL_DEVICES, None, None).await;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn revoke_all_sessions(state: &AppState, user_id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM home_sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("UPDATE devices SET active = 0 WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

async fn verify_current_password(state: &AppState, user_id: &str, password: &str) -> ApiResult<()> {
    let row: (String, Option<String>) = sqlx::query_as(
        "SELECT password_hash, opaque_record FROM accounts WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    if row.1.is_some() {
        return Err(ApiError::Unauthorized("opaque_required".into()).with_code(errcodes::OPAQUE_REQUIRED));
    }
    let parsed = PasswordHash::new(&row.0)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored hash unreadable: {e}")))?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))
}

pub(crate) async fn verify_sensitive_reauth(
    state: &AppState,
    user_id: &str,
    password: Option<&str>,
    reauth_token: Option<&str>,
) -> ApiResult<()> {
    if let Some(token) = reauth_token {
        return super::opaque::verify_reauth_token(state, user_id, token).await;
    }
    let password =
        password.ok_or_else(|| ApiError::BadRequest("reauthentication is required".into())
            .with_code(errcodes::REAUTH_REQUIRED))?;
    verify_current_password(state, user_id, password).await
}

pub async fn export_account(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let per_day = state.cfg.retention.exports_per_day.max(1) as f64;
    if let Err(retry) = state.limiter.take(
        format!("export:{}", auth.user_id),
        "account_export",
        per_day,
        per_day / 86_400.0,
    ) {
        return Err(ApiError::RateLimited(format!(
            "too many export requests; try again in {retry} seconds"
        )));
    }

    let profile = load_profile(&state, &auth.user_id).await?;
    let account: Option<(i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT created_at, deactivated, mfa_enabled, admin FROM accounts WHERE user_id = ?",
    )
    .bind(&auth.user_id).fetch_optional(&state.pool).await?;
    let recovery: Option<(Option<String>, Option<i64>, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT verified_email, verified_at, pending_email, pending_since FROM recovery_addresses WHERE user_id = ?",
    )
    .bind(&auth.user_id).fetch_optional(&state.pool).await?;
    let devices: Vec<(String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT device_id, name, pubkey_b64, created_at, last_seen, active FROM devices WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let sync: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT key, value, updated_at FROM sync_store WHERE user_id = ? ORDER BY key",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let media_preference: Option<(i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT tier, origin, updated_at FROM media_preferences WHERE user_id = ?",
    )
    .bind(&auth.user_id).fetch_optional(&state.pool).await?;
    let friends: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT peer_id, peer_domain, state, updated_at FROM friends WHERE user_id = ? ORDER BY peer_id",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let conversations: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT c.id, c.kind, c.sequencer, c.updated_at FROM conversations c          JOIN conversation_members m ON m.conversation_id = c.id          WHERE m.user_id = ? AND m.state = 'active' ORDER BY c.updated_at DESC",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let memberships = crate::memberships::export(&state, &auth.user_id).await?;
    let uploads: Vec<(String, String, i64, String, i64)> = sqlx::query_as(
        "SELECT hash, mime, size, purpose, created_at FROM media WHERE owner_user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let read_state: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT channel_id, last_read_id, muted, updated_at FROM read_state WHERE user_id = ? ORDER BY channel_id",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let applications: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT id, name, created_at FROM bot_applications WHERE owner_user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let push_devices: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT device_id, algorithm, created_at FROM notification_devices WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id).fetch_all(&state.pool).await?;
    let imported: Option<(String, i64, i64)> = sqlx::query_as(
        "SELECT previous_id, original_created_at, imported_at FROM imported_identities WHERE user_id = ?",
    )
    .bind(&auth.user_id).fetch_optional(&state.pool).await?;

    let base = &state.cfg.public_base_url;
    Ok(Json(json!({
        "format": "telium-account-export-v2",
        "exported_at": now_ms(),
        "origin": state.cfg.server_name,
        "user_id": auth.user_id,
        "account": account.map(|(created_at, deactivated, mfa_enabled, admin)| json!({
            "created_at": created_at, "deactivated": deactivated != 0,
            "recovery_email": recovery.as_ref().and_then(|(verified, ..)| verified.clone()),
            "recovery_email_verified_at": recovery.as_ref().and_then(|(_, at, ..)| *at),
            "recovery_email_pending": recovery.as_ref().and_then(|(_, _, pending, _)| pending.clone()),
            "recovery_email_pending_since": recovery.as_ref().and_then(|(.., since)| *since),
            "mfa_enabled": mfa_enabled != 0,
            "server_admin": admin != 0,
        })),
        "imported_from": imported.map(|(previous_id, original_created_at, imported_at)| json!({
            "previous_id": previous_id, "original_created_at": original_created_at, "imported_at": imported_at
        })),
        "profile": profile,
        "devices": devices.into_iter().map(|(id,name,pubkey,created,last_seen,active)| json!({
            "device_id": id, "name": name, "public_key": pubkey,
            "created_at": created, "last_seen": last_seen, "active": active != 0
        })).collect::<Vec<_>>(),
        "sync": sync.into_iter().map(|(key,value,updated_at)| json!({
            "key": key, "value": serde_json::from_str::<Value>(&value).unwrap_or(Value::String(value)), "updated_at": updated_at
        })).collect::<Vec<_>>(),
        "media_preference": media_preference.map(|(tier, origin, updated_at)| json!({
            "tier": tier, "origin": origin, "updated_at": updated_at
        })),
        "friends": friends.into_iter().map(|(peer_id,peer_domain,state,updated_at)| json!({
            "peer_id": peer_id, "peer_domain": peer_domain, "state": state, "updated_at": updated_at
        })).collect::<Vec<_>>(),
        "conversations": conversations.into_iter().map(|(id,kind,sequencer,updated_at)| json!({
            "id": id, "kind": kind, "sequencer": sequencer, "updated_at": updated_at
        })).collect::<Vec<_>>(),
        "memberships": memberships,
        "uploads": uploads.into_iter().map(|(hash,mime,size,purpose,created_at)| json!({
            "hash": hash, "mime": mime, "size": size, "purpose": purpose,
            "created_at": created_at,
            "url": format!("{base}/_telium/v1/media/{hash}"),
        })).collect::<Vec<_>>(),
        "read_state": read_state.into_iter().map(|(channel_id,last_read_id,muted,updated_at)| json!({
            "channel_id": channel_id, "last_read_id": last_read_id,
            "muted": muted != 0, "updated_at": updated_at
        })).collect::<Vec<_>>(),
        "bot_applications": applications.into_iter().map(|(id,name,created_at)| json!({
            "id": id, "name": name, "created_at": created_at
        })).collect::<Vec<_>>(),
        "notification_devices": push_devices.into_iter().map(|(device_id,algorithm,created_at)| json!({
            "device_id": device_id, "algorithm": algorithm, "created_at": created_at
        })).collect::<Vec<_>>(),
        "not_included": [
            json!({
                "what": "messages you sent in guilds",
                "why": "A guild's messages belong to the guild server that hosts it, which \
                        may not be this one. This server has no copy of a message you sent to \
                        a guild elsewhere, and for guilds it does host, the history is the \
                        guild's record rather than an attachment to your account.",
                "instead": "Ask the guild for an export, or read your own messages through \
                            the client's search."
            }),
            json!({
                "what": "direct message contents",
                "why": "Direct messages are end-to-end encrypted. This server holds \
                        ciphertext it cannot read, and the keys that would make it readable \
                        are on your devices -- which is the property that makes the \
                        encryption worth having. Putting the ciphertext in this file would \
                        add bytes and no information.",
                "instead": "Your client holds the plaintext. The conversation list above \
                            identifies each conversation the ciphertext belongs to."
            }),
            json!({
                "what": "private keys and secrets",
                "why": "Device keys, MFA secrets, recovery codes and the key vault are \
                        deliberately absent. An export is a file that gets emailed to \
                        people, left in downloads folders and synced to other services; \
                        anything in it that could be used to sign in as you turns a routine \
                        request into a credential leak.",
                "instead": "Nothing. These are not meant to leave the device or the server."
            }),
            json!({
                "what": "copies held by other servers",
                "why": "Federation means other servers hold their own copies of things you \
                        did there -- your messages, your membership, the profile they cached \
                        to draw a member list. This server cannot read those copies and \
                        cannot compel them.",
                "instead": "Ask each server directly. The memberships list above names every \
                            one this server knows about."
            }),
            json!({
                "what": "moderation records",
                "why": "Audit entries naming you as the subject of a moderation action \
                        belong to the guild that took it, not to your account. A record a \
                        moderated member can extract on request is one they can dispute \
                        selectively.",
                "instead": "Ask the guild's moderators."
            })
        ],
        "note": "Keep this file somewhere private: it names every guild you belong to, every \
                 device you have signed in from, and everything you have uploaded."
    })))
}

pub async fn delete_account(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<ReauthRequest>,
) -> ApiResult<Json<Value>> {
    verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    if state.cfg.roles.guild {
        let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE owner_user_id = ?")
            .bind(&auth.user_id).fetch_one(&state.pool).await?;
        if owned > 0 {
            return Err(ApiError::Conflict(
                "transfer or delete guilds owned on this server before deleting the account".into(),
            ));
        }
    }
    let active_apps: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM bot_applications a \
         JOIN bot_identities b ON b.application_id = a.id \
         WHERE a.owner_user_id = ? AND b.disabled = 0",
    )
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    if active_apps > 0 {
        return Err(ApiError::Conflict(
            "retire active bot applications before deleting the account".into(),
        ));
    }
    crate::ownership::refuse_if_last_admin(
        &state.pool,
        &auth.user_id,
        crate::ownership::Departure::Delete,
    )
    .await?;
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE accounts SET deactivated = 1, deleted_at = ?, mfa_secret = NULL, \
         mfa_sealed = NULL, mfa_enabled = 0, opaque_record = NULL, \
         password_hash = 'deleted' WHERE user_id = ?",
    )
        .bind(now)
        .bind(&auth.user_id)
        .execute(&mut *tx)
        .await
        .map_err(|err| {
            if err
                .to_string()
                .contains("retire active bot applications before deleting the account")
            {
                ApiError::Conflict(
                    "retire active bot applications before deleting the account".into(),
                )
            } else {
                ApiError::Db(err)
            }
        })?;
    sqlx::query("UPDATE profiles SET display_name = 'Deleted User', avatar_ref = NULL, banner_ref = NULL, bio = NULL, pronouns = NULL, updated_at = ? WHERE user_id = ?")
        .bind(now).bind(&auth.user_id).execute(&mut *tx).await?;
    for (table, column) in crate::erasure::DELETION_TABLES {
        let sql = format!("DELETE FROM {table} WHERE {column} = ?");
        sqlx::query(&sql)
            .bind(&auth.user_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE conversation_members SET state = 'left', resync = 1 WHERE user_id = ? AND state = 'active'")
        .bind(&auth.user_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE devices SET active = 0 WHERE user_id = ?")
        .bind(&auth.user_id).execute(&mut *tx).await?;
    let record = crypto::sign_json(
        &state.key,
        json!({
            "kind": "gone", "subject_type": "user", "subject_id": auth.user_id,
            "origin": state.cfg.server_name, "reason": "account_deleted", "gone_at": now,
        }),
    );
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('user', ?, 'gone', NULL, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(&auth.user_id)
    .bind(record.to_string())
    .bind(now)
    .execute(&mut *tx)
    .await?;
    crate::erasure::begin(&mut tx, &auth.user_id).await?;
    tx.commit().await?;
    // After commit: receivers ask this server what became of the account.
    crate::revocation::announce(&state, &auth.user_id, crate::revocation::DELETED, None, None).await;
    // Failure is logged, not returned: the account is already deleted.
    if let Err(e) = crate::erasure::drive(&state, &auth.user_id).await {
        tracing::warn!(target: crate::logcat::ACCOUNT, user_id = %auth.user_id, error = %e, "account erasure did not finish inline; the maintenance loop will retry it");
    }
    Ok(Json(json!({
        "ok": true,
        "status": "deleted",
        "note": "The account is permanently disabled and home-server profile/private state was erased. Messages already sent to guilds remain on those guild servers, and servers that federated with this one hold copies this server cannot recall."
    })))
}

pub async fn my_devices(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT device_id, name, pubkey_b64, created_at, last_seen, active FROM devices \
         WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let devices: Vec<Value> = rows
        .into_iter()
        .map(|(id, name, pubkey, created_at, last_seen, active)| {
            json!({
                "device_id": id, "name": name, "pubkey": pubkey,
                "created_at": created_at, "last_seen": last_seen, "active": active != 0,
                "current": id == auth.device_id,
            })
        })
        .collect();
    Ok(Json(json!({ "devices": devices })))
}

#[derive(Deserialize)]
pub struct DeviceRevocation {
    pub mls_key: String,
    pub signature: String,
}

pub async fn revoke_device(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(device_id): Path<String>,
    body: Option<Json<DeviceRevocation>>,
) -> ApiResult<Json<Value>> {
    let owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM devices WHERE device_id = ?")
        .bind(&device_id)
        .fetch_optional(&state.pool)
        .await?;
    if owner.as_deref() != Some(auth.user_id.as_str()) {
        return Err(ApiError::NotFound("device not found".into()));
    }
    let mut targets = vec![device_id.clone()];
    if let Some(Json(revocation)) = body {
        let Some((immutable_id, root)) =
            super::identity_continuity::root_of(&state, &auth.user_id).await?
        else {
            return Err(ApiError::Conflict(
                "anchor the account identity before signing a revocation".into(),
            ));
        };
        let payload = super::identity_continuity::revocation_payload(
            &auth.user_id,
            &immutable_id,
            &device_id,
            &revocation.mls_key,
        );
        if !super::identity_continuity::verify_signature(&root, &payload, &revocation.signature) {
            return Err(ApiError::Unauthorized(
                "device revocation is not signed by the account root".into(),
            ));
        }
        sqlx::query(
            "INSERT INTO device_revocations \
             (user_id, mls_key, device_id, immutable_id, signer_key, signature, revoked_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, mls_key) DO NOTHING",
        )
        .bind(&auth.user_id)
        .bind(&revocation.mls_key)
        .bind(&device_id)
        .bind(&immutable_id)
        .bind(&root)
        .bind(&revocation.signature)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
        let same_key: Vec<String> = sqlx::query_scalar(
            "SELECT device_id FROM devices WHERE user_id = ? AND mls_key = ? AND device_id != ?",
        )
        .bind(&auth.user_id)
        .bind(&revocation.mls_key)
        .bind(&device_id)
        .fetch_all(&state.pool)
        .await?;
        targets.extend(same_key);
    }
    for device_id in &targets {
        revoke_session(&state, &auth.user_id, device_id).await?;
    }
    Ok(Json(json!({ "ok": true, "revoked": targets })))
}

async fn revoke_session(state: &AppState, user_id: &str, device_id: &str) -> ApiResult<()> {
    sqlx::query("UPDATE devices SET active = 0, cross_sig = NULL WHERE device_id = ?")
        .bind(device_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM home_sessions WHERE device_id = ?")
        .bind(device_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM key_packages WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(device_id)
        .execute(&state.pool)
        .await?;
    crate::revocation::announce(
        state,
        user_id,
        crate::revocation::DEVICE,
        Some(device_id),
        None,
    )
    .await;
    Ok(())
}

#[derive(Deserialize)]
pub struct CrossSigningUpload {
    pub identity_key: String,
    pub sealed_secret: String,
}

#[derive(Deserialize)]
pub struct DeviceSignature {
    pub mls_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct UserSignature {
    pub subject_key: String,
    #[serde(default)]
    pub subject_identity_id: Option<String>,
    #[serde(default)]
    pub signer_key: Option<String>,
    pub signature: String,
}

pub async fn get_cross_signing(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let key: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT identity_key, sealed_secret, created_at FROM cross_signing WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let devices: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT device_id, mls_key, cross_sig FROM devices WHERE user_id = ? AND active = 1 \
         ORDER BY created_at",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let signatures: Vec<(String, String, Option<String>, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT subject, subject_key, subject_identity_id, signer_key, signature, signed_at \
         FROM user_signatures WHERE signer = ? \
           AND NOT EXISTS (SELECT 1 FROM bot_identities b WHERE b.user_id = subject)",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    let requests: Vec<(String, i64)> = sqlx::query_as(
        "SELECT subject, requested_at FROM verification_requests \
         WHERE requester = ? AND requested_at > ? ORDER BY requested_at DESC",
    )
    .bind(&auth.user_id)
    .bind(now - super::dm::VERIFY_REQUEST_WINDOW_MS)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "exists": key.is_some(),
        "identity_key": key.as_ref().map(|k| k.0.clone()),
        "sealed_secret": key.as_ref().map(|k| k.1.clone()),
        "created_at": key.as_ref().map(|k| k.2),
        "devices": devices.into_iter().map(|(id, mls_key, cross_sig)| json!({
            "device_id": id, "mls_key": mls_key, "cross_sig": cross_sig,
        })).collect::<Vec<Value>>(),
        "revocations": super::identity_continuity::revocations(&state, &auth.user_id).await?,
        "signatures": signatures.into_iter().map(
            |(subject, subject_key, subject_identity_id, signer_key, signature, signed_at)| json!({
                "subject": subject,
                "subject_key": subject_key,
                "subject_identity_id": subject_identity_id,
                "signer_key": signer_key,
                "signature": signature,
                "signed_at": signed_at,
            })
        ).collect::<Vec<Value>>(),
        "requests": requests.into_iter().map(|(subject, requested_at)| json!({
            "subject": subject,
            "requested_at": requested_at,
            "may_ask_again_at": requested_at + super::dm::VERIFY_REQUEST_WINDOW_MS,
        })).collect::<Vec<Value>>(),
    })))
}

pub async fn put_cross_signing(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(body): Json<CrossSigningUpload>,
) -> ApiResult<Json<Value>> {
    if body.identity_key.trim().is_empty() || body.sealed_secret.trim().is_empty() {
        return Err(ApiError::BadRequest("cross-signing key and sealed secret are required".into()));
    }
    if let Some(protected) =
        super::identity_continuity::current_key(&state, &auth.user_id).await?
    {
        if protected != body.identity_key {
            return Err(ApiError::Conflict(
                "this account identity is continuity-protected; use an authorized identity rotation".into(),
            ));
        }
    }
    let existing: Option<String> =
        sqlx::query_scalar("SELECT identity_key FROM cross_signing WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await?;
    let now = now_ms();
    if existing.as_deref() != Some(body.identity_key.as_str()) {
        sqlx::query("UPDATE devices SET cross_sig = NULL WHERE user_id = ?")
            .bind(&auth.user_id)
            .execute(&state.pool)
            .await?;
        sqlx::query("DELETE FROM user_signatures WHERE signer = ?")
            .bind(&auth.user_id)
            .execute(&state.pool)
            .await?;
    }
    sqlx::query(
        "INSERT INTO cross_signing (user_id, identity_key, sealed_secret, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET \
         identity_key = excluded.identity_key, sealed_secret = excluded.sealed_secret, \
         updated_at = excluded.updated_at",
    )
    .bind(&auth.user_id)
    .bind(&body.identity_key)
    .bind(&body.sealed_secret)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "identity_key": body.identity_key })))
}

pub async fn sign_device(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(device_id): Path<String>,
    Json(body): Json<DeviceSignature>,
) -> ApiResult<Json<Value>> {
    let owner: Option<String> = sqlx::query_scalar("SELECT user_id FROM devices WHERE device_id = ?")
        .bind(&device_id)
        .fetch_optional(&state.pool)
        .await?;
    if owner.as_deref() != Some(auth.user_id.as_str()) {
        return Err(ApiError::NotFound("device not found".into()));
    }
    if super::identity_continuity::is_revoked_key(&state, &auth.user_id, &body.mls_key).await? {
        return Err(ApiError::Forbidden("this device key has been revoked".into()));
    }
    sqlx::query("UPDATE devices SET mls_key = ?, cross_sig = ? WHERE device_id = ?")
        .bind(&body.mls_key)
        .bind(&body.signature)
        .bind(&device_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn sign_user(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
    Json(body): Json<UserSignature>,
) -> Result<Json<Value>, Coded> {
    if split_user_id(&user_id).is_none() {
        return Err(ApiError::BadRequest("malformed user id".into()).into());
    }
    if is_local_bot(&state, &user_id).await? {
        return Err(Coded::new(
            ApiError::Forbidden("bots cannot be verified: there is nobody to compare emoji with".into()),
            crate::errcodes::SUBJECT_IS_BOT,
        ));
    }
    sqlx::query(
        "INSERT INTO user_signatures \
         (signer, subject, subject_key, subject_identity_id, signer_key, signature, signed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(signer, subject) DO UPDATE SET \
         subject_key = excluded.subject_key, \
         subject_identity_id = excluded.subject_identity_id, \
         signer_key = excluded.signer_key, signature = excluded.signature, \
         signed_at = excluded.signed_at",
    )
    .bind(&auth.user_id)
    .bind(&user_id)
    .bind(&body.subject_key)
    .bind(&body.subject_identity_id)
    .bind(&body.signer_key)
    .bind(&body.signature)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn unsign_user(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM user_signatures WHERE signer = ? AND subject = ?")
        .bind(&auth.user_id)
        .bind(&user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn device_list(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !is_local(&state, &user_id)? {
        return Ok(Json(ask_home(&state, &user_id, "devices").await?));
    }
    let rows: Vec<(String, String, i64, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT device_id, pubkey_b64, created_at, active, mls_key, cross_sig FROM devices \
         WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await?;
    let devices: Vec<Value> = rows
        .into_iter()
        .map(|(id, pubkey, created_at, active, mls_key, cross_sig)| {
            json!({
                "device_id": id, "pubkey": pubkey, "created_at": created_at,
                "active": active != 0, "mls_key": mls_key, "cross_sig": cross_sig,
            })
        })
        .collect();
    let identity_key: Option<String> =
        sqlx::query_scalar("SELECT identity_key FROM cross_signing WHERE user_id = ?")
            .bind(&user_id)
            .fetch_optional(&state.pool)
            .await?;

    let revocations = super::identity_continuity::revocations(&state, &user_id).await?;
    let body = json!({
        "user_id": user_id,
        "devices": devices,
        "revocations": revocations,
        "identity_key": identity_key,
        "origin": state.cfg.server_name,
        "generated_at": now_ms(),
    });
    Ok(Json(crypto::sign_json(&state.key, body)))
}

pub async fn account_status(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !is_local(&state, &user_id)? {
        return Ok(Json(ask_home(&state, &user_id, "status").await?));
    }
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT a.deactivated, COALESCE(i.original_created_at, a.created_at) \
         FROM accounts a LEFT JOIN imported_identities i ON i.user_id = a.user_id \
         WHERE a.user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    let moved: Option<(String, String)> = sqlx::query_as(
        "SELECT new_id, record FROM tombstones WHERE subject_type = 'user' AND subject_id = ? AND kind = 'moved'",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some((new_id, record)) = moved {
        let record: Value = serde_json::from_str(&record).unwrap_or(Value::Null);
        return Ok(Json(crypto::sign_json(
            &state.key,
            json!({
                "user_id": user_id, "status": "moved", "moved_to": new_id,
                "tombstone": record, "origin": state.cfg.server_name,
            }),
        )));
    }

    let gone: Option<String> = sqlx::query_scalar(
        "SELECT record FROM tombstones WHERE subject_type = 'user' AND subject_id = ? AND kind = 'gone'",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(record) = gone {
        let record: Value = serde_json::from_str(&record).unwrap_or(Value::Null);
        return Ok(Json(crypto::sign_json(
            &state.key,
            json!({
                "user_id": user_id, "status": "gone",
                "tombstone": record, "origin": state.cfg.server_name,
            }),
        )));
    }

    let body = match row {
        Some((0, created_at)) => json!({
            "user_id": user_id, "status": "active",
            "created_at": created_at, "origin": state.cfg.server_name,
        }),
        Some((_, created_at)) => json!({
            "user_id": user_id, "status": "deactivated",
            "created_at": created_at, "origin": state.cfg.server_name,
        }),
        None => json!({ "user_id": user_id, "status": "unknown", "origin": state.cfg.server_name }),
    };
    Ok(Json(crypto::sign_json(&state.key, body)))
}

#[derive(Deserialize)]
pub struct AssertionRequest {
    pub audience: String,
}

pub async fn issue_assertion(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<AssertionRequest>,
) -> ApiResult<Json<Value>> {
    if req.audience.trim().is_empty() {
        return Err(ApiError::BadRequest("audience is required".into()));
    }
    let device: Option<(String, i64)> =
        sqlx::query_as("SELECT pubkey_b64, active FROM devices WHERE device_id = ?")
            .bind(&auth.device_id)
            .fetch_optional(&state.pool)
            .await?;
    let (device_pubkey, active) =
        device.ok_or_else(|| ApiError::Unauthorized("device no longer exists".into()))?;
    if active == 0 {
        return Err(ApiError::Unauthorized("device has been revoked".into()));
    }

    let profile = load_profile(&state, &auth.user_id).await?.unwrap_or(json!({}));
    let now = now_ms();
    let claims = AssertionClaims {
        user_id: auth.user_id.clone(),
        device_id: auth.device_id.clone(),
        device_pubkey,
        audience: req.audience.clone(),
        origin: state.cfg.server_name.clone(),
        profile_version: profile["profile_version"].as_i64().unwrap_or(1),
        display_name: profile["display_name"].as_str().unwrap_or("").to_string(),
        avatar_ref: profile["avatar_ref"].as_str().map(str::to_string),
        iat: now,
        exp: now + state.cfg.sessions.assertion_ttl_secs * 1000,
    };

    Ok(Json(json!({
        "assertion": crypto::issue_assertion(&state.key, &claims),
        "expires_at": claims.exp,
        "audience": req.audience,
    })))
}

pub const SEALED_ONLY_SYNC_KEYS: [&str; 3] =
    ["drafts.v2", "stickers.saved.v1", "identity.pins.v1"];

pub fn is_sealed_sync_value(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let b64url = |s: &str| s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    let version = object.get("sealed").and_then(Value::as_str).unwrap_or_default();
    let ct = object.get("ct").and_then(Value::as_str).unwrap_or_default();
    version.len() >= 2
        && version.len() <= 8
        && version.starts_with('v')
        && b64url(version)
        && !ct.is_empty()
        && object.len() <= 8
        && object
            .iter()
            .all(|(field, v)| field.len() <= 16 && v.as_str().is_some_and(b64url))
}

#[derive(Deserialize, Default)]
pub struct SyncQuery {
    #[serde(default)]
    sealed: Option<String>,
}

impl SyncQuery {
    fn wants_sealed(&self) -> bool {
        matches!(self.sealed.as_deref(), Some("1" | "true"))
    }
}

pub async fn sync_is_sealed<'e, E>(executor: E, user_id: &str) -> ApiResult<bool>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let stamp: Option<Option<i64>> =
        sqlx::query_scalar("SELECT sync_sealed_at FROM accounts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(executor)
            .await?;
    Ok(stamp.flatten().is_some())
}

pub async fn sync_get_all(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(query): Query<SyncQuery>,
) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT key, value, updated_at FROM sync_store WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_all(&state.pool)
            .await?;
    let mut map = serde_json::Map::new();
    for (key, value, updated_at) in rows {
        let parsed: Value = serde_json::from_str(&value).unwrap_or(Value::Null);
        if !query.wants_sealed() && is_sealed_sync_value(&parsed) {
            continue;
        }
        map.insert(key, json!({ "value": parsed, "updated_at": updated_at }));
    }
    Ok(Json(Value::Object(map)))
}

pub async fn sync_get(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(key): Path<String>,
    Query(query): Query<SyncQuery>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, i64)> =
        sqlx::query_as("SELECT value, updated_at FROM sync_store WHERE user_id = ? AND key = ?")
            .bind(&auth.user_id)
            .bind(&key)
            .fetch_optional(&state.pool)
            .await?;
    let (value, updated_at) = row.ok_or_else(|| ApiError::NotFound("no such key".into()))?;
    let value = serde_json::from_str::<Value>(&value).unwrap_or(Value::Null);
    if !query.wants_sealed() && is_sealed_sync_value(&value) {
        return Err(ApiError::NotFound("no such key".into()));
    }
    Ok(Json(json!({
        "key": key,
        "value": value,
        "updated_at": updated_at,
    })))
}

pub async fn sync_put(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(key): Path<String>,
    Json(value): Json<Value>,
) -> ApiResult<Json<Value>> {
    if key.len() > 64 {
        return Err(ApiError::BadRequest("sync key must be at most 64 characters".into()));
    }
    let sealed = is_sealed_sync_value(&value);
    if !sealed {
        if SEALED_ONLY_SYNC_KEYS.contains(&key.as_str()) {
            return Err(ApiError::BadRequest(format!("{key} holds sealed values only")));
        }
        if sync_is_sealed(&state.pool, &auth.user_id).await? {
            return Err(ApiError::Conflict("this account's sync store takes sealed values only".into()));
        }
    }
    let encoded = value.to_string();
    let used: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM sync_store WHERE user_id = ? AND key != ?",
    )
    .bind(&auth.user_id)
    .bind(&key)
    .fetch_one(&state.pool)
    .await?;
    if used + encoded.len() as i64 > state.cfg.limits.max_sync_store_bytes {
        return Err(ApiError::TooLarge(format!(
            "client sync store is limited to {} bytes",
            state.cfg.limits.max_sync_store_bytes
        )));
    }

    let now = now_ms();
    sqlx::query(
        "INSERT INTO sync_store (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(&auth.user_id)
    .bind(&key)
    .bind(&encoded)
    .bind(now)
    .execute(&state.pool)
    .await?;
    if sealed {
        sqlx::query("UPDATE accounts SET sync_sealed_at = ? WHERE user_id = ? AND sync_sealed_at IS NULL")
            .bind(now)
            .bind(&auth.user_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(json!({ "ok": true, "key": key })))
}

pub async fn sync_delete(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(key): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM sync_store WHERE user_id = ? AND key = ?")
        .bind(&auth.user_id)
        .bind(&key)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub(crate) async fn is_local_bot(state: &AppState, user_id: &str) -> ApiResult<bool> {
    if !is_local(state, user_id)? {
        return Ok(false);
    }
    let found: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM bot_identities WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(found.is_some())
}

fn is_local(state: &AppState, user_id: &str) -> ApiResult<bool> {
    match split_user_id(user_id) {
        Some((_, domain)) => Ok(crate::federation::normalise_origin(domain)
            == crate::federation::normalise_origin(&state.cfg.server_name)),
        None => Err(ApiError::BadRequest("malformed user id".into())),
    }
}

async fn ask_home(state: &AppState, user_id: &str, what: &str) -> ApiResult<Value> {
    let (_, domain) = split_user_id(user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?;
    let doc = crate::federation::get_signed(
        state,
        domain,
        &format!("/_telium/v1/users/{user_id}/{what}"),
    )
    .await?;
    let key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest(format!("{domain} returned an unsigned document")))?;
    let public = crate::federation::verify_key(state, domain, key_id)
        .await
        .ok_or_else(|| ApiError::BadRequest(format!("{domain} signed with an unpublished key")))?;
    if !crate::crypto::verify_json(&public, &doc) {
        return Err(ApiError::BadRequest(format!("{domain} returned a bad signature")));
    }
    let subject = doc.get("user_id").and_then(Value::as_str);
    if subject != Some(user_id) {
        return Err(ApiError::BadRequest(format!(
            "{domain} answered about {} when asked about {user_id}",
            subject.unwrap_or("nobody")
        )));
    }
    Ok(doc)
}
