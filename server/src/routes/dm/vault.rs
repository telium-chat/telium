use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub async fn get_vault(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, i64, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT mode, ciphertext, version, updated_at, escrow_key, independent_ciphertext \
         FROM key_vault WHERE user_id = ?",
    )
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((mode, ciphertext, version, updated_at, escrow_key, independent_ciphertext)) = row else {
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
        "escrow_key": escrow_key,
        "independent_ciphertext": independent_ciphertext,
        "server_can_recover": escrow_key.is_some(),
        "backup": {
            "items": backup_items,
            "updated_at": backup_at,
            "server_can_read": escrow_key.is_some() && backup_items > 0,
        },
    })))
}

#[derive(Deserialize)]
pub struct PutVault {
    pub ciphertext: String,
    #[serde(default)]
    pub independent_ciphertext: Option<String>,
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

pub async fn put_vault(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<PutVault>,
) -> ApiResult<Json<Value>> {
    let mode = req.mode.unwrap_or_else(|| {
        if req.escrow_key.is_some() { "escrowed".into() } else { "device_custody".into() }
    });
    if mode != "escrowed"
        && mode != "opaque_custody"
        && mode != "device_custody"
        && mode != "self_custody"
    {
        return Err(ApiError::BadRequest(
            "mode must be opaque_custody, device_custody, self_custody, or escrowed".into(),
        ));
    }
    if mode == "escrowed" && req.escrow_key.is_none() {
        return Err(ApiError::BadRequest("escrowed mode needs an escrow key".into()));
    }
    if mode != "escrowed" && req.escrow_key.is_some() {
        return Err(ApiError::BadRequest(
            "client-held custody means we must not be given the key".into(),
        ));
    }
    let version: Option<i64> = match req.expected_version {
        None => sqlx::query_scalar(
            "INSERT INTO key_vault \
             (user_id, mode, ciphertext, escrow_key, independent_ciphertext, version, updated_at) \
             VALUES (?, ?, ?, ?, ?, 1, ?) \
             ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, ciphertext = excluded.ciphertext, \
                 escrow_key = excluded.escrow_key, \
                 independent_ciphertext = excluded.independent_ciphertext, \
                 version = key_vault.version + 1, updated_at = excluded.updated_at \
             RETURNING version",
        )
        .bind(&auth.user_id)
        .bind(&mode)
        .bind(&req.ciphertext)
        .bind(&req.escrow_key)
        .bind(&req.independent_ciphertext)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?,
        Some(0) => sqlx::query_scalar(
            "INSERT INTO key_vault \
             (user_id, mode, ciphertext, escrow_key, independent_ciphertext, version, updated_at) \
             VALUES (?, ?, ?, ?, ?, 1, ?) \
             ON CONFLICT(user_id) DO NOTHING RETURNING version",
        )
        .bind(&auth.user_id)
        .bind(&mode)
        .bind(&req.ciphertext)
        .bind(&req.escrow_key)
        .bind(&req.independent_ciphertext)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?,
        Some(expected) => sqlx::query_scalar(
            "UPDATE key_vault SET mode = ?, ciphertext = ?, escrow_key = ?, \
                 independent_ciphertext = ?, version = version + 1, updated_at = ? \
             WHERE user_id = ? AND version = ? RETURNING version",
        )
        .bind(&mode)
        .bind(&req.ciphertext)
        .bind(&req.escrow_key)
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
    pub escrow_key: Option<String>,
    #[serde(default)]
    pub recovery_confirmed: bool,
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

pub async fn set_vault_mode(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<VaultMode>,
) -> ApiResult<Json<Value>> {
    let held_escrow: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM key_vault WHERE user_id = ? AND escrow_key IS NOT NULL",
    )
    .bind(&auth.user_id)
    .fetch_one(&state.pool)
    .await?;
    let server_had_key = held_escrow > 0;

    match req.mode.as_str() {
        "self_custody" => {
            if !req.recovery_confirmed {
                return Err(ApiError::BadRequest(
                    "confirm the recovery phrase before switching: lost phrase means lost history".into(),
                ));
            }
            let version: Option<i64> = sqlx::query_scalar(
                "UPDATE key_vault SET mode = 'self_custody', ciphertext = ?, escrow_key = NULL, \
                 version = version + 1, updated_at = ? WHERE user_id = ? \
                 AND (? IS NULL OR version = ?) RETURNING version",
            )
            .bind(&req.ciphertext)
            .bind(now_ms())
            .bind(&auth.user_id)
            .bind(req.expected_version)
            .bind(req.expected_version)
            .fetch_optional(&state.pool)
            .await?;
            let version = cas_outcome(&state, &auth.user_id, req.expected_version, version).await?;
            Ok(Json(json!({
                "mode": "self_custody",
                "version": version,
                "escrow_key_destroyed": server_had_key,
                "caveat": if server_had_key {
                    Value::String(
                        "history written before this switch may already have been readable by this server"
                            .into(),
                    )
                } else {
                    Value::Null
                },
            })))
        }
        "opaque_custody" => {
            if req.clear_independent && req.independent_ciphertext.is_some() {
                return Err(ApiError::BadRequest(
                    "send a new independent copy or clear it, not both".into(),
                ));
            }
            let version: Option<i64> = sqlx::query_scalar(
                "UPDATE key_vault SET mode = 'opaque_custody', ciphertext = ?, \
                 independent_ciphertext = CASE WHEN ? THEN NULL \
                     ELSE COALESCE(?, independent_ciphertext) END, \
                 escrow_key = NULL, \
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
            Ok(Json(json!({
                "mode": "opaque_custody",
                "version": version,
                "server_can_recover": false,
                "escrow_key_destroyed": server_had_key,
                "caveat": if server_had_key {
                    Value::String(
                        "older material may already have been readable by this server; the client rotates the live recovery key"
                            .into(),
                    )
                } else {
                    Value::Null
                },
            })))
        }
        "device_custody" => {
            let version: Option<i64> = sqlx::query_scalar(
                "UPDATE key_vault SET mode = 'device_custody', ciphertext = ?, escrow_key = NULL, \
                 version = version + 1, updated_at = ? WHERE user_id = ? \
                 AND (? IS NULL OR version = ?) RETURNING version",
            )
            .bind(&req.ciphertext)
            .bind(now_ms())
            .bind(&auth.user_id)
            .bind(req.expected_version)
            .bind(req.expected_version)
            .fetch_optional(&state.pool)
            .await?;
            let version = cas_outcome(&state, &auth.user_id, req.expected_version, version).await?;
            Ok(Json(json!({
                "mode": "device_custody",
                "version": version,
                "server_can_recover": false,
                "escrow_key_destroyed": server_had_key,
                "caveat": if server_had_key {
                    Value::String(
                        "older material may already have been readable by this server; the client must rotate the live recovery key"
                            .into(),
                    )
                } else {
                    Value::Null
                },
            })))
        }
        "escrowed" => {
            let escrow_key = req
                .escrow_key
                .ok_or_else(|| ApiError::BadRequest("escrowed mode needs an escrow key".into()))?;
            let version: Option<i64> = sqlx::query_scalar(
                "UPDATE key_vault SET mode = 'escrowed', ciphertext = ?, escrow_key = ?, \
                 version = version + 1, updated_at = ? WHERE user_id = ? \
                 AND (? IS NULL OR version = ?) RETURNING version",
            )
            .bind(&req.ciphertext)
            .bind(&escrow_key)
            .bind(now_ms())
            .bind(&auth.user_id)
            .bind(req.expected_version)
            .bind(req.expected_version)
            .fetch_optional(&state.pool)
            .await?;
            let version = cas_outcome(&state, &auth.user_id, req.expected_version, version).await?;
            Ok(Json(json!({ "mode": "escrowed", "server_can_recover": true, "version": version })))
        }
        _ => Err(ApiError::BadRequest(
            "mode must be opaque_custody, device_custody, self_custody, or escrowed".into(),
        )),
    }
}
