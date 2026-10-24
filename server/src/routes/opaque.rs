
use super::identity::{self, LoginResponse};
use crate::auth::HomeAuth;
use crate::errcodes;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, hash_token, now_ms, random_token, unb64, valid_localpart};
use axum::extract::State;
use axum::Json;
use ed25519_dalek::{Signature, VerifyingKey};
use opaque_ke::ciphersuite::CipherSuite;
use opaque_ke::{
    CredentialFinalization, CredentialRequest, RegistrationRequest, ServerLogin,
    ServerLoginParameters, ServerRegistration, ServerSetup,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha512;

const ATTEMPT_TTL_MS: i64 = 5 * 60 * 1000;
const REAUTH_TTL_MS: i64 = 5 * 60 * 1000;
const RESET_TTL_MS: i64 = 10 * 60 * 1000;
pub const PASSWORD_SENTINEL: &str = "opaque:v1";
const RESET_DOMAIN: &str = "telium-password-reset:v1";
const COPY_RESTORE_DOMAIN: &str = "telium-recovery-k1-restore:v1";

struct TeliumOpaque;

impl CipherSuite for TeliumOpaque {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, Sha512>;
    type Ksf = argon2::Argon2<'static>;
}

fn decode<T: AsRef<str>>(context: &'static str, value: T) -> ApiResult<Vec<u8>> {
    unb64(value.as_ref())
        .ok_or_else(|| ApiError::BadRequest(format!("invalid base64 in {context}")))
}

fn protocol_bad(context: &'static str, error: impl std::fmt::Display) -> ApiError {
    ApiError::BadRequest(format!("{context}: {error}"))
}

fn protocol_auth(_: impl std::fmt::Display) -> ApiError {
    // Malformed, wrong-password and unknown-user must be indistinguishable.
    ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS)
}

async fn setup(state: &AppState) -> ApiResult<ServerSetup<TeliumOpaque>> {
    let mut encoded: Option<String> =
        sqlx::query_scalar("SELECT setup FROM opaque_server_state WHERE id = 1")
            .fetch_optional(&state.pool)
            .await?;

    if encoded.is_none() {
        let mut rng = rand::rngs::OsRng;
        let made = ServerSetup::<TeliumOpaque>::new(&mut rng);
        let value = b64(made.serialize().as_slice());
        sqlx::query(
            "INSERT INTO opaque_server_state (id, setup, created_at) VALUES (1, ?, ?) \
             ON CONFLICT DO NOTHING",
        )
        .bind(&value)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
        encoded = sqlx::query_scalar("SELECT setup FROM opaque_server_state WHERE id = 1")
            .fetch_optional(&state.pool)
            .await?;
    }

    let encoded = encoded.ok_or_else(|| {
        ApiError::Internal(anyhow::anyhow!("OPAQUE server setup could not be persisted"))
    })?;
    let bytes = decode("server setup", encoded)?;
    ServerSetup::<TeliumOpaque>::deserialize(&bytes)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored OPAQUE setup unreadable: {e}")))
}

async fn cleanup(state: &AppState) {
    let now = now_ms();
    let _ = sqlx::query("DELETE FROM opaque_login_attempts WHERE expires_at < ?")
        .bind(now)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query(
        "DELETE FROM opaque_reauth_tokens WHERE expires_at < ? OR used_at IS NOT NULL",
    )
    .bind(now)
    .execute(&state.pool)
    .await;
    let _ = sqlx::query("DELETE FROM password_reset_attempts WHERE expires_at < ?")
        .bind(now)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("DELETE FROM recovery_copy_attempts WHERE expires_at < ?")
        .bind(now)
        .execute(&state.pool)
        .await;
    crate::mail::cleanup(state).await;
}

#[derive(Deserialize)]
pub struct RegisterStart {
    pub localpart: String,
    pub registration_request: String,
}

pub async fn register_start(
    State(state): State<AppState>,
    Json(req): Json<RegisterStart>,
) -> ApiResult<Json<Value>> {
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

    let setup = setup(&state).await?;
    let request = RegistrationRequest::deserialize(&decode(
        "registration request",
        &req.registration_request,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration request", e))?;
    let response = ServerRegistration::<TeliumOpaque>::start(
        &setup,
        request,
        user_id.as_bytes(),
    )
    .map_err(|e| protocol_bad("could not start OPAQUE registration", e))?;

    Ok(Json(json!({
        "registration_response": b64(response.message.serialize().as_slice()),
        "server_name": state.cfg.server_name.clone(),
        "min_password_len": state.cfg.registration.min_password_len,
    })))
}

#[derive(Deserialize)]
pub struct RegisterFinish {
    pub localpart: String,
    pub registration_record: String,
    #[serde(default)]
    pub recovery_public_key: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_pubkey: Option<String>,
}

pub async fn register_finish(
    State(state): State<AppState>,
    Json(req): Json<RegisterFinish>,
) -> ApiResult<Json<Value>> {
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

    ServerRegistration::<TeliumOpaque>::deserialize(&decode(
        "registration record",
        &req.registration_record,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration record", e))?;
    if let Some(public) = req.recovery_public_key.as_deref() {
        if unb64(public).map(|bytes| bytes.len()) != Some(32) {
            return Err(ApiError::BadRequest(
                "recovery_public_key must be 32 base64url bytes".into(),
            ));
        }
    }

    let user_id = format!("@{}:{}", localpart, state.cfg.server_name);
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT subject_id FROM identity_localparts WHERE localpart = ? AND domain = ?",
    )
    .bind(&localpart)
    .bind(&state.cfg.server_name)
    .fetch_optional(&mut *tx)
    .await?;
    if exists.is_some() {
        return Err(ApiError::Conflict("that username is taken".into())
            .with_code(errcodes::USERNAME_TAKEN));
    }

    let accounts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts")
        .fetch_one(&mut *tx)
        .await?;
    let admin = accounts == 0
        || state
            .cfg
            .registration
            .admins
            .iter()
            .any(|a| a.eq_ignore_ascii_case(&localpart));

    sqlx::query(
        "INSERT INTO accounts \
         (user_id, localpart, domain, password_hash, opaque_record, recovery_public_key, created_at, admin) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&user_id)
    .bind(&localpart)
    .bind(&state.cfg.server_name)
    .bind(PASSWORD_SENTINEL)
    .bind(&req.registration_record)
    .bind(req.recovery_public_key.as_deref())
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

    let (device_id, token, expires_at, device_secret) = identity::create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or("initial device"),
        req.device_pubkey.as_deref(),
    )
    .await?;

    Ok(Json(json!({
        "user_id": user_id,
        "device_id": device_id,
        "access_token": token,
        "expires_at": expires_at,
        "server_name": state.cfg.server_name,
        "device_secret": device_secret,
        "opaque_upgrade_token": Value::Null,
        "recovery_key_enrolled": req.recovery_public_key.is_some(),
    })))
}

#[derive(Deserialize)]
pub struct LoginStart {
    pub user: String,
    pub start_login_request: String,
}

async fn begin_login(
    state: &AppState,
    user_id: &str,
    start_login_request: &str,
    purpose: &str,
    registration_record: Option<String>,
) -> ApiResult<Json<Value>> {
    cleanup(state).await;
    let identifier = credential_identifier(state, user_id).await;
    let setup = setup(state).await?;
    let record = registration_record
        .as_deref()
        .map(|record| {
            let bytes = decode("registration record", record)?;
            ServerRegistration::<TeliumOpaque>::deserialize(&bytes)
                .map_err(|e| protocol_auth(e))
        })
        .transpose()?;
    let request = CredentialRequest::deserialize(&decode(
        "login request",
        start_login_request,
    )?)
    .map_err(protocol_auth)?;

    let mut rng = rand::rngs::OsRng;
    let started = ServerLogin::<TeliumOpaque>::start(
        &mut rng,
        &setup,
        record,
        request,
        identifier.as_bytes(),
        ServerLoginParameters::default(),
    )
    .map_err(protocol_auth)?;

    let id = random_token(24);
    sqlx::query(
        "INSERT INTO opaque_login_attempts (id, user_id, state, purpose, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(b64(started.state.serialize().as_slice()))
    .bind(purpose)
    .bind(now_ms() + ATTEMPT_TTL_MS)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "login_id": id,
        "login_response": b64(started.message.serialize().as_slice()),
    })))
}

pub async fn login_start(
    State(state): State<AppState>,
    Json(req): Json<LoginStart>,
) -> ApiResult<Json<Value>> {
    let user_id = identity::canonical_login_user_id(&req.user, &state.cfg.server_name);
    let user_id = crate::relocation::current_user_id(&state, user_id).await;
    let account: Option<(Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT opaque_record, deleted_at FROM accounts WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    let legacy_upgrade_required = matches!(&account, Some((None, None)));
    let record = account.and_then(|(record, deleted_at)| {
        if deleted_at.is_none() { record } else { None }
    });
    let Json(mut body) =
        begin_login(&state, &user_id, &req.start_login_request, "login", record).await?;
    if let Value::Object(ref mut map) = body {
        map.insert(
            "legacy_upgrade_required".into(),
            Value::Bool(legacy_upgrade_required),
        );
    }
    Ok(Json(body))
}

#[derive(Deserialize)]
pub struct LoginFinish {
    pub login_id: String,
    pub finish_login_request: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_pubkey: Option<String>,
    #[serde(default)]
    pub mfa_code: Option<String>,
    #[serde(default)]
    pub reactivate: bool,
}

async fn take_attempt(
    state: &AppState,
    id: &str,
    purpose: &str,
) -> ApiResult<(String, ServerLogin<TeliumOpaque>)> {
    let mut tx = state.pool.begin().await?;
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, state, purpose, expires_at FROM opaque_login_attempts WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (user_id, encoded, got_purpose, expires_at) =
        row.ok_or_else(|| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if got_purpose != purpose || expires_at < now_ms() {
        sqlx::query("DELETE FROM opaque_login_attempts WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    let deleted = sqlx::query("DELETE FROM opaque_login_attempts WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if deleted.rows_affected() != 1 {
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    tx.commit().await?;

    let bytes = decode("server login state", encoded)?;
    let state = ServerLogin::<TeliumOpaque>::deserialize(&bytes).map_err(protocol_auth)?;
    Ok((user_id, state))
}

fn finish_protocol(
    server_login: ServerLogin<TeliumOpaque>,
    finish_login_request: &str,
) -> ApiResult<()> {
    let finalization = CredentialFinalization::deserialize(&decode(
        "login finalization",
        finish_login_request,
    )?)
    .map_err(protocol_auth)?;
    server_login
        .finish(finalization, ServerLoginParameters::default())
        .map_err(protocol_auth)?;
    Ok(())
}

pub async fn login_finish(
    State(state): State<AppState>,
    Json(req): Json<LoginFinish>,
) -> ApiResult<Json<LoginResponse>> {
    let (user_id, attempt) = take_attempt(&state, &req.login_id, "login").await?;
    finish_protocol(attempt, &req.finish_login_request)?;

    let row: Option<(
        i64,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT deactivated, deleted_at, mfa_enabled, mfa_secret, mfa_sealed, opaque_record \
         FROM accounts WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (deactivated, deleted_at, mfa_enabled, mfa_secret, mfa_sealed, opaque_record) =
        row.ok_or_else(|| ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS))?;
    if opaque_record.is_none() {
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    if deleted_at.is_some() {
        return Err(ApiError::Unauthorized("account_deleted".into()).with_code(errcodes::ACCOUNT_DELETED));
    }
    if req.reactivate {
        if deactivated == 0 {
            return Err(ApiError::Conflict("account is already active".into())
                .with_code(errcodes::ACCOUNT_ALREADY_ACTIVE));
        }
        crate::admin::accounts::refuse_operator_suspended(&state, &user_id).await?;
    } else if deactivated != 0 {
        return Err(ApiError::Unauthorized("account_deactivated".into())
            .with_code(errcodes::ACCOUNT_DEACTIVATED));
    }

    identity::verify_login_mfa(
        &state,
        &user_id,
        mfa_enabled,
        mfa_secret.as_deref(),
        mfa_sealed.as_deref(),
        req.mfa_code.as_deref(),
    )
    .await?;

    if req.reactivate {
        sqlx::query("UPDATE accounts SET deactivated = 0 WHERE user_id = ?")
            .bind(&user_id)
            .execute(&state.pool)
            .await?;
    }

    let (device_id, token, expires_at, device_secret) = identity::create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or(if req.reactivate {
            "reactivated device"
        } else {
            "device"
        }),
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

pub(crate) async fn issue_enroll_token(
    state: &AppState,
    user_id: &str,
) -> ApiResult<String> {
    cleanup(state).await;
    let token = random_token(32);
    sqlx::query(
        "DELETE FROM opaque_reauth_tokens WHERE user_id = ? AND purpose = 'enroll'",
    )
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "INSERT INTO opaque_reauth_tokens (token_hash, user_id, purpose, expires_at) \
         VALUES (?, ?, 'enroll', ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(now_ms() + REAUTH_TTL_MS)
    .execute(&state.pool)
    .await?;
    Ok(token)
}

async fn token_exists(
    state: &AppState,
    user_id: &str,
    token: &str,
    purpose: &str,
) -> ApiResult<bool> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM opaque_reauth_tokens \
         WHERE token_hash = ? AND user_id = ? AND purpose = ? \
         AND used_at IS NULL AND expires_at >= ?",
    )
    .bind(hash_token(token))
    .bind(user_id)
    .bind(purpose)
    .bind(now_ms())
    .fetch_one(&state.pool)
    .await?;
    Ok(count == 1)
}

async fn consume_token(
    state: &AppState,
    user_id: &str,
    token: &str,
    purpose: &str,
) -> ApiResult<()> {
    let done = sqlx::query(
        "UPDATE opaque_reauth_tokens SET used_at = ? \
         WHERE token_hash = ? AND user_id = ? AND purpose = ? \
         AND used_at IS NULL AND expires_at >= ?",
    )
    .bind(now_ms())
    .bind(hash_token(token))
    .bind(user_id)
    .bind(purpose)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    if done.rows_affected() != 1 {
        return Err(ApiError::Unauthorized("reauthentication expired".into())
            .with_code(errcodes::REAUTH_EXPIRED));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct EnrollStart {
    pub upgrade_token: String,
    pub registration_request: String,
}

pub async fn enroll_start(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<EnrollStart>,
) -> ApiResult<Json<Value>> {
    if !token_exists(&state, &auth.user_id, &req.upgrade_token, "enroll").await? {
        return Err(ApiError::Unauthorized("OPAQUE enrollment is not authorized".into()));
    }
    let existing: Option<String> =
        sqlx::query_scalar("SELECT opaque_record FROM accounts WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_one(&state.pool)
            .await?;
    if existing.is_some() {
        return Err(ApiError::Conflict("OPAQUE is already enrolled".into()));
    }

    let identifier = credential_identifier(&state, &auth.user_id).await;
    let setup = setup(&state).await?;
    let request = RegistrationRequest::deserialize(&decode(
        "registration request",
        &req.registration_request,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration request", e))?;
    let response = ServerRegistration::<TeliumOpaque>::start(
        &setup,
        request,
        identifier.as_bytes(),
    )
    .map_err(|e| protocol_bad("could not start OPAQUE enrollment", e))?;

    Ok(Json(json!({
        "registration_response": b64(response.message.serialize().as_slice()),
        "server_name": state.cfg.server_name,
    })))
}

#[derive(Deserialize)]
pub struct EnrollFinish {
    pub upgrade_token: String,
    pub registration_record: String,
}

pub async fn enroll_finish(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<EnrollFinish>,
) -> ApiResult<Json<Value>> {
    ServerRegistration::<TeliumOpaque>::deserialize(&decode(
        "registration record",
        &req.registration_record,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration record", e))?;

    consume_token(&state, &auth.user_id, &req.upgrade_token, "enroll").await?;
    let done = sqlx::query(
        "UPDATE accounts SET opaque_record = ?, password_hash = ? \
         WHERE user_id = ? AND opaque_record IS NULL",
    )
    .bind(&req.registration_record)
    .bind(PASSWORD_SENTINEL)
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() != 1 {
        return Err(ApiError::Conflict("OPAQUE is already enrolled".into()));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct ReauthStart {
    pub start_login_request: String,
}

pub async fn reauth_start(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<ReauthStart>,
) -> ApiResult<Json<Value>> {
    let record: Option<String> =
        sqlx::query_scalar("SELECT opaque_record FROM accounts WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_one(&state.pool)
            .await?;
    let record =
        record.ok_or_else(|| ApiError::Conflict("OPAQUE is not enrolled yet".into()))?;
    begin_login(
        &state,
        &auth.user_id,
        &req.start_login_request,
        "reauth",
        Some(record),
    )
    .await
}

#[derive(Deserialize)]
pub struct ReauthFinish {
    pub login_id: String,
    pub finish_login_request: String,
    #[serde(default)]
    pub recovery_public_key: Option<String>,
    #[serde(default)]
    pub recovery_vault_ciphertext: Option<String>,
    #[serde(default)]
    pub replace_recovery_key: bool,
}

pub async fn reauth_finish(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<ReauthFinish>,
) -> ApiResult<Json<Value>> {
    let (user_id, attempt) = take_attempt(&state, &req.login_id, "reauth").await?;
    if user_id != auth.user_id {
        return Err(ApiError::Unauthorized("invalid credentials".into()).with_code(errcodes::INVALID_CREDENTIALS));
    }
    finish_protocol(attempt, &req.finish_login_request)?;

    match (&req.recovery_public_key, &req.recovery_vault_ciphertext) {
        (Some(public), Some(ciphertext)) => {
            if unb64(public).map(|bytes| bytes.len()) != Some(32) {
                return Err(ApiError::BadRequest(
                    "recovery_public_key must be 32 base64url bytes".into(),
                ));
            }
            if !ciphertext.starts_with("k1.") || ciphertext.len() > 128 * 1024 {
                return Err(ApiError::BadRequest(
                    "recovery_vault_ciphertext is malformed or too large".into(),
                ));
            }

            let mut tx = state.pool.begin().await?;
            let account = sqlx::query(
                "UPDATE accounts SET recovery_public_key = ? \
                 WHERE user_id = ? AND (recovery_public_key IS NULL OR ?)",
            )
            .bind(public)
            .bind(&auth.user_id)
            .bind(req.replace_recovery_key)
            .execute(&mut *tx)
            .await?;
            if account.rows_affected() != 1 {
                return Err(ApiError::Conflict(
                    "a recovery key is already enrolled for this account".into(),
                ));
            }

            let vault = sqlx::query(
                "UPDATE key_vault SET independent_ciphertext = ?, \
                 version = version + 1, updated_at = ? \
                 WHERE user_id = ? AND mode = 'opaque_custody' \
                 AND (independent_ciphertext IS NULL \
                      OR (? AND independent_ciphertext LIKE 'k1.%'))",
            )
            .bind(ciphertext)
            .bind(now_ms())
            .bind(&auth.user_id)
            .bind(req.replace_recovery_key)
            .execute(&mut *tx)
            .await?;
            if vault.rows_affected() != 1 {
                return Err(ApiError::Conflict(
                    "the encrypted recovery vault is not ready for recovery-key enrollment".into(),
                ));
            }

            tx.commit().await?;
            return Ok(Json(json!({ "recovery_key_enrolled": true })));
        }
        (None, None) => {}
        _ => {
            return Err(ApiError::BadRequest(
                "recovery key enrollment needs both the public key and encrypted vault wrapper".into(),
            ));
        }
    }

    let token = random_token(32);
    sqlx::query(
        "INSERT INTO opaque_reauth_tokens (token_hash, user_id, purpose, expires_at) \
         VALUES (?, ?, 'sensitive', ?)",
    )
    .bind(hash_token(&token))
    .bind(&auth.user_id)
    .bind(now_ms() + REAUTH_TTL_MS)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({
        "reauth_token": token,
        "expires_at": now_ms() + REAUTH_TTL_MS,
    })))
}

pub(crate) async fn verify_reauth_token(
    state: &AppState,
    user_id: &str,
    token: &str,
) -> ApiResult<()> {
    consume_token(state, user_id, token, "sensitive").await
}


fn recovery_copy_payload(
    user_id: &str,
    attempt_id: &str,
    challenge: &str,
    ciphertext: &str,
) -> Vec<u8> {
    format!("{COPY_RESTORE_DOMAIN}|{user_id}|{attempt_id}|{challenge}|{ciphertext}")
        .into_bytes()
}

pub async fn recovery_copy_start(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    cleanup(&state).await;
    let attempt_id = random_token(24);
    let challenge = random_token(32);
    sqlx::query(
        "INSERT INTO recovery_copy_attempts (id, user_id, challenge, expires_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&attempt_id)
    .bind(&auth.user_id)
    .bind(&challenge)
    .bind(now_ms() + RESET_TTL_MS)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({
        "user_id": auth.user_id,
        "attempt_id": attempt_id,
        "challenge": challenge,
    })))
}

#[derive(Deserialize)]
pub struct RecoveryCopyFinish {
    pub attempt_id: String,
    pub recovery_vault_ciphertext: String,
    pub signature: String,
}

pub async fn recovery_copy_finish(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<RecoveryCopyFinish>,
) -> ApiResult<Json<Value>> {
    let ciphertext = &req.recovery_vault_ciphertext;
    if !ciphertext.starts_with("k1.") || ciphertext.len() > 128 * 1024 {
        return Err(ApiError::BadRequest(
            "recovery_vault_ciphertext is malformed or too large".into(),
        ));
    }
    let attempt: Option<(String, String, i64)> = sqlx::query_as(
        "DELETE FROM recovery_copy_attempts WHERE id = ? \
         RETURNING user_id, challenge, expires_at",
    )
    .bind(&req.attempt_id)
    .fetch_optional(&state.pool)
    .await?;
    let invalid = || {
        ApiError::Unauthorized("invalid recovery proof".into())
            .with_code(errcodes::INVALID_RECOVERY_PROOF)
    };
    let (attempt_user, challenge, expires_at) = attempt.ok_or_else(invalid)?;
    if attempt_user != auth.user_id || expires_at < now_ms() {
        return Err(invalid());
    }

    let public: Option<String> =
        sqlx::query_scalar("SELECT recovery_public_key FROM accounts WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    let Some(public) = public else {
        return Err(invalid());
    };
    let payload = recovery_copy_payload(&auth.user_id, &req.attempt_id, &challenge, ciphertext);
    if !verify_recovery_signature(&public, &payload, &req.signature) {
        return Err(invalid());
    }

    let written = sqlx::query(
        "UPDATE key_vault SET independent_ciphertext = ?, \
         version = version + 1, updated_at = ? \
         WHERE user_id = ? AND mode = 'opaque_custody' \
         AND independent_ciphertext IS NULL",
    )
    .bind(ciphertext)
    .bind(now_ms())
    .bind(&auth.user_id)
    .execute(&state.pool)
    .await?;
    if written.rows_affected() != 1 {
        return Err(ApiError::Conflict(
            "this vault already has an independent copy, or is not in account-password custody".into(),
        ));
    }
    Ok(Json(json!({ "recovery_copy_restored": true })))
}

fn recovery_reset_payload(
    user_id: &str,
    reset_id: &str,
    challenge: &str,
    registration_record: &str,
) -> Vec<u8> {
    format!(
        "{RESET_DOMAIN}|{user_id}|{reset_id}|{challenge}|{registration_record}"
    )
    .into_bytes()
}

fn verify_recovery_signature(public: &str, payload: &[u8], signature: &str) -> bool {
    let Some(public_bytes) = unb64(public).and_then(|v| <[u8; 32]>::try_from(v).ok())
    else {
        return false;
    };
    let Some(signature_bytes) =
        unb64(signature).and_then(|v| <[u8; 64]>::try_from(v).ok())
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&public_bytes) else {
        return false;
    };
    key.verify_strict(payload, &Signature::from_bytes(&signature_bytes))
        .is_ok()
}

#[derive(Deserialize)]
pub struct PasswordResetStart {
    pub user: String,
    pub registration_request: String,
}

pub async fn password_reset_start(
    State(state): State<AppState>,
    Json(req): Json<PasswordResetStart>,
) -> ApiResult<Json<Value>> {
    cleanup(&state).await;
    let user_id = identity::canonical_login_user_id(&req.user, &state.cfg.server_name);
    let user_id = crate::relocation::current_user_id(&state, user_id).await;
    let identifier = credential_identifier(&state, &user_id).await;
    let setup = setup(&state).await?;
    let request = RegistrationRequest::deserialize(&decode(
        "registration request",
        &req.registration_request,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration request", e))?;
    let response = ServerRegistration::<TeliumOpaque>::start(
        &setup,
        request,
        identifier.as_bytes(),
    )
    .map_err(|e| protocol_bad("could not start OPAQUE password reset", e))?;

    let reset_id = random_token(24);
    let challenge = random_token(32);
    sqlx::query(
        "INSERT INTO password_reset_attempts (id, user_id, challenge, expires_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&reset_id)
    .bind(&user_id)
    .bind(&challenge)
    .bind(now_ms() + RESET_TTL_MS)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({
        "user_id": user_id,
        "reset_id": reset_id,
        "challenge": challenge,
        "registration_response": b64(response.message.serialize().as_slice()),
    })))
}

#[derive(Deserialize)]
pub struct PasswordResetFinish {
    pub user: String,
    pub reset_id: String,
    pub registration_record: String,
    pub signature: String,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub device_pubkey: Option<String>,
}

pub async fn password_reset_finish(
    State(state): State<AppState>,
    Json(req): Json<PasswordResetFinish>,
) -> ApiResult<Json<LoginResponse>> {
    ServerRegistration::<TeliumOpaque>::deserialize(&decode(
        "registration record",
        &req.registration_record,
    )?)
    .map_err(|e| protocol_bad("invalid OPAQUE registration record", e))?;

    let user_id = identity::canonical_login_user_id(&req.user, &state.cfg.server_name);
    let user_id = crate::relocation::current_user_id(&state, user_id).await;
    let now = now_ms();

    let attempt: Option<(String, String, i64)> = sqlx::query_as(
        "DELETE FROM password_reset_attempts WHERE id = ? \
         RETURNING user_id, challenge, expires_at",
    )
    .bind(&req.reset_id)
    .fetch_optional(&state.pool)
    .await?;
    let (attempt_user, challenge, expires_at) =
        attempt.ok_or_else(|| ApiError::Unauthorized("invalid recovery proof".into())
            .with_code(errcodes::INVALID_RECOVERY_PROOF))?;

    if attempt_user != user_id || expires_at < now {
        return Err(ApiError::Unauthorized("invalid recovery proof".into())
            .with_code(errcodes::INVALID_RECOVERY_PROOF));
    }

    let mut tx = state.pool.begin().await?;
    let account: Option<(Option<String>, Option<i64>, i64)> = sqlx::query_as(
        "SELECT recovery_public_key, deleted_at, deactivated \
         FROM accounts WHERE user_id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some((Some(public), deleted_at, deactivated)) = account else {
        return Err(ApiError::Unauthorized("invalid recovery proof".into())
            .with_code(errcodes::INVALID_RECOVERY_PROOF));
    };

    let payload = recovery_reset_payload(
        &user_id,
        &req.reset_id,
        &challenge,
        &req.registration_record,
    );
    if !verify_recovery_signature(&public, &payload, &req.signature) {
        return Err(ApiError::Unauthorized("invalid recovery proof".into())
            .with_code(errcodes::INVALID_RECOVERY_PROOF));
    }

    if deleted_at.is_some() {
        return Err(ApiError::Unauthorized("account_deleted".into()).with_code(errcodes::ACCOUNT_DELETED));
    }
    if deactivated != 0 {
        return Err(ApiError::Unauthorized("account_deactivated".into())
            .with_code(errcodes::ACCOUNT_DEACTIVATED));
    }

    sqlx::query(
        "UPDATE accounts SET opaque_record = ?, password_hash = ? WHERE user_id = ?",
    )
    .bind(&req.registration_record)
    .bind(PASSWORD_SENTINEL)
    .bind(&user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM home_sessions WHERE user_id = ?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE devices SET active = 0 WHERE user_id = ?")
        .bind(&user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    crate::revocation::announce(&state, &user_id, crate::revocation::ALL_DEVICES, None, None).await;

    let (device_id, token, expires_at, device_secret) = identity::create_device_session(
        &state,
        &user_id,
        req.device_name.as_deref().unwrap_or("recovered device"),
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

async fn credential_identifier(state: &AppState, user_id: &str) -> String {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT opaque_identifier FROM accounts WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .flatten()
    .unwrap_or_else(|| user_id.to_string())
}
