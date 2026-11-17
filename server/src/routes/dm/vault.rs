use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn get_vault(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT mode, ciphertext, version, updated_at, independent_ciphertext \
         FROM key_vault WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((mode, ciphertext, version, updated_at, independent_ciphertext)) = row else {
        return Ok(Json(json!({ "mode": "none", "exists": false })));
    };
    let (backup_items, backup_at): (i64, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*), MAX(updated_at) FROM key_backup WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    let recovery_key_enrolled: bool = sqlx::query_scalar(
        "SELECT recovery_public_key IS NOT NULL FROM accounts WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?
    .unwrap_or(false);
    Ok(Json(json!({
        "exists": true,
        "recovery_key_enrolled": recovery_key_enrolled,
        "mode": mode,
        "ciphertext": ciphertext,
        "version": version,
        "updated_at": updated_at,
        "independent_ciphertext": independent_ciphertext,
        "backup": {
            "items": backup_items,
            "updated_at": backup_at,
        },
    })))
}

#[derive(Deserialize)]
pub struct PutVault {
    pub ciphertext: String,
    #[serde(default)]
    pub independent_ciphertext: Option<String>,
    /// Read only to be refused: the server holds no escrow key and takes none.
    #[serde(default)]
    pub escrow_key: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

async fn vault_conflict(state: &AppState, user_id: &str) -> ApiError {
    let stored: i64 = sqlx::query_scalar("SELECT version FROM key_vault WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten()
        .unwrap_or(0);
    ApiError::Conflict("the key vault changed since it was read".into())
        .with_code(crate::errcodes::VAULT_VERSION_CONFLICT)
        .with_detail("version", stored)
}

/// Phase 4 of the key-custody design: `opaque_custody` is the only custody a write may name. `device_custody`,
/// `self_custody` and `escrowed` (and a write that names none, which used to mean one of them) are refused, so an old
/// client gets a clear answer instead of a vault nothing can open. Rows already stored in a retired mode are left as
/// they are and still readable; writing `opaque_custody` over one is how it is converted.
fn require_opaque_mode(mode: Option<&str>) -> ApiResult<()> {
    if mode == Some("opaque_custody") {
        return Ok(());
    }
    Err(ApiError::BadRequest(
        "this server keeps only the account-password key vault (opaque_custody); the other custody modes are retired, \
         so update Telium to keep using encrypted direct messages"
            .into(),
    )
    .with_code(crate::errcodes::CUSTODY_RETIRED)
    .with_detail("mode", mode.unwrap_or("")))
}

/// A second copy is the recovery-key copy (`k1.`) or nothing; the passphrase copies (`p2.` and the unprefixed form) are
/// retired with the modes that made them.
fn require_recovery_key_copy(copy: Option<&str>) -> ApiResult<()> {
    match copy {
        Some(text) if !text.starts_with("k1.") => Err(ApiError::BadRequest(
            "this server keeps only the recovery-key copy of the vault; passphrase copies are retired".into(),
        )
        .with_code(crate::errcodes::CUSTODY_RETIRED)),
        _ => Ok(()),
    }
}

pub async fn put_vault(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<PutVault>,
) -> ApiResult<Json<Value>> {
    require_opaque_mode(req.mode.as_deref())?;
    require_recovery_key_copy(req.independent_ciphertext.as_deref())?;
    if req.escrow_key.is_some() {
        return Err(ApiError::BadRequest(
            "client-held custody means we must not be given the key".into(),
        ));
    }
    let mode = "opaque_custody";
    let version: Option<i64> = match req.expected_version {
        None => sqlx::query_scalar(
            "INSERT INTO key_vault \
             (user_id, mode, ciphertext, independent_ciphertext, version, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?) \
             ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, ciphertext = excluded.ciphertext, \
                 independent_ciphertext = excluded.independent_ciphertext, \
                 version = key_vault.version + 1, updated_at = excluded.updated_at \
             RETURNING version",
        )
        .bind(&auth.user_id)
        .bind(mode)
        .bind(&req.ciphertext)
        .bind(&req.independent_ciphertext)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?,
        Some(0) => sqlx::query_scalar(
            "INSERT INTO key_vault \
             (user_id, mode, ciphertext, independent_ciphertext, version, updated_at) \
             VALUES (?, ?, ?, ?, 1, ?) \
             ON CONFLICT(user_id) DO NOTHING RETURNING version",
        )
        .bind(&auth.user_id)
        .bind(mode)
        .bind(&req.ciphertext)
        .bind(&req.independent_ciphertext)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?,
        Some(expected) => sqlx::query_scalar(
            "UPDATE key_vault SET mode = ?, ciphertext = ?, \
                 independent_ciphertext = ?, version = version + 1, updated_at = ? \
             WHERE user_id = ? AND version = ? RETURNING version",
        )
        .bind(mode)
        .bind(&req.ciphertext)
        .bind(&req.independent_ciphertext)
        .bind(now_ms())
        .bind(&auth.user_id)
        .bind(expected)
        .fetch_optional(&state.pool)
        .await?,
    };
    let Some(version) = version else {
        return Err(vault_conflict(&state, &auth.user_id).await);
    };
    Ok(Json(json!({ "ok": true, "mode": mode, "version": version })))
}

#[derive(Deserialize)]
pub struct VaultMode {
    pub mode: String,
    pub ciphertext: String,
    #[serde(default)]
    pub independent_ciphertext: Option<String>,
    #[serde(default)]
    pub clear_independent: bool,
    #[serde(default)]
    pub expected_version: Option<i64>,
}

async fn cas_outcome(
    state: &AppState,
    user_id: &str,
    expected: Option<i64>,
    written: Option<i64>,
) -> ApiResult<Option<i64>> {
    match (written, expected) {
        (Some(v), _) => Ok(Some(v)),
        (None, Some(_)) => Err(vault_conflict(state, user_id).await),
        (None, None) => Ok(None),
    }
}

/// Rewrites the vault under `opaque_custody`. This is also how a vault stored in a retired mode is converted: the
/// update takes the row whatever mode it holds, since it is the only way a device that still holds the keys moves its
/// account out of one.
pub async fn set_vault_mode(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<VaultMode>,
) -> ApiResult<Json<Value>> {
    require_opaque_mode(Some(req.mode.as_str()))?;
    require_recovery_key_copy(req.independent_ciphertext.as_deref())?;
    if req.clear_independent && req.independent_ciphertext.is_some() {
        return Err(ApiError::BadRequest(
            "send a new independent copy or clear it, not both".into(),
        ));
    }
    let version: Option<i64> = sqlx::query_scalar(
        "UPDATE key_vault SET mode = 'opaque_custody', ciphertext = ?, \
         independent_ciphertext = CASE WHEN ? THEN NULL \
             ELSE COALESCE(?, independent_ciphertext) END, \
         version = version + 1, updated_at = ? WHERE user_id = ? \
         AND (? IS NULL OR version = ?) RETURNING version",
    )
    .bind(&req.ciphertext)
    .bind(req.clear_independent)
    .bind(&req.independent_ciphertext)
    .bind(now_ms())
    .bind(&auth.user_id)
    .bind(req.expected_version)
    .bind(req.expected_version)
    .fetch_optional(&state.pool)
    .await?;
    let version = cas_outcome(&state, &auth.user_id, req.expected_version, version).await?;
    Ok(Json(json!({ "mode": "opaque_custody", "version": version })))
}
