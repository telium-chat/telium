use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{SqliteConnection, SqlitePool};

const MAX_USES: i64 = 10_000;
const MAX_LIFETIME_SECS: i64 = 365 * 24 * 60 * 60;
const DEFAULT_LIFETIME_SECS: i64 = 7 * 24 * 60 * 60;
const BOOTSTRAP_LIFETIME_SECS: i64 = 30 * 24 * 60 * 60;

/// The full secret is returned once. Nothing that lists codes or records an
/// audit event can reconstruct it: only the BLAKE3 hash is stored.
pub struct Issued {
    pub id: String,
    pub code: String,
    pub expires_at: Option<i64>,
    pub max_uses: i64,
}

fn new_issued(max_uses: i64, lifetime_secs: i64) -> anyhow::Result<Issued> {
    anyhow::ensure!((1..=MAX_USES).contains(&max_uses), "max_uses must be between 1 and 10000");
    anyhow::ensure!(
        (0..=MAX_LIFETIME_SECS).contains(&lifetime_secs),
        "expires_in_secs must be 0 (no expiry), or between 1 and 31536000"
    );
    // 24 cryptographically random bytes; the prefix prevents confusion with
    // guild invite codes. Normalisation is intentionally exact, not casefolded.
    let code = format!("treg_{}", random_token(24));
    Ok(Issued {
        id: ulid(),
        code,
        expires_at: (lifetime_secs > 0).then(|| now_ms() + lifetime_secs * 1000),
        max_uses,
    })
}

pub async fn create(
    pool: &SqlitePool,
    actor: &str,
    label: &str,
    max_uses: i64,
    lifetime_secs: i64,
) -> anyhow::Result<Issued> {
    anyhow::ensure!(label.chars().count() <= 80, "label must be at most 80 characters");
    let issued = new_issued(max_uses, lifetime_secs)?;
    sqlx::query(
        "INSERT INTO registration_codes \
         (id, code_hash, label, created_by, kind, max_uses, uses, created_at, expires_at) \
         VALUES (?, ?, ?, ?, 'admin', ?, 0, ?, ?)",
    )
    .bind(&issued.id)
    .bind(hash_token(&issued.code))
    .bind(label.trim())
    .bind(actor)
    .bind(max_uses)
    .bind(now_ms())
    .bind(issued.expires_at)
    .execute(pool)
    .await?;
    Ok(issued)
}

/// Idempotent across installer re-runs: the setup code is minted just once,
/// never reprinted, and never stored in plaintext. A lost/expired setup code
/// can be replaced with the local registration-code create CLI.
pub async fn bootstrap(pool: &SqlitePool, registration_closed: bool) -> anyhow::Result<Option<Issued>> {
    if !registration_closed {
        return Ok(None);
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM registration_codes WHERE kind = 'setup'",
    )
    .fetch_one(&mut *tx)
    .await?;
    if existing != 0 {
        tx.commit().await?;
        return Ok(None);
    }
    let issued = new_issued(1, BOOTSTRAP_LIFETIME_SECS)?;
    sqlx::query(
        "INSERT INTO registration_codes \
         (id, code_hash, label, created_by, kind, max_uses, uses, created_at, expires_at) \
         VALUES (?, ?, 'Initial server setup', 'local-installer', 'setup', 1, 0, ?, ?)",
    )
    .bind(&issued.id)
    .bind(hash_token(&issued.code))
    .bind(now_ms())
    .bind(issued.expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(issued))
}

fn code_hash(code: Option<&str>) -> ApiResult<String> {
    let code = code.map(str::trim).unwrap_or("");
    if code.len() < 16 || code.len() > 96 || !code.starts_with("treg_")
        || !code.is_ascii() {
        return Err(invalid());
    }
    Ok(hash_token(code))
}

fn invalid() -> ApiError {
    ApiError::Forbidden("registration requires a valid, unused admission code".into())
        .with_code(crate::errcodes::REGISTRATION_CODE_INVALID)
}

/// Called at the start of OPAQUE registration and at entry to the legacy
/// route. The actual use is still deducted atomically during the account
/// insertion transaction; checking availability here cannot reserve a code.
pub async fn allow_start(state: &AppState, code: Option<&str>) -> ApiResult<()> {
    if crate::sunset::current(state).await
        .is_some_and(|v| v["mode"] == "shutdown") {
        return Err(ApiError::Forbidden("registration is closed during shutdown".into())
            .with_code(crate::errcodes::REGISTRATION_CLOSED));
    }
    if state.cfg.registration.open {
        return Ok(());
    }
    let hash = code_hash(code)?;
    let available: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM registration_codes WHERE code_hash = ? AND revoked_at IS NULL \
         AND (expires_at IS NULL OR expires_at > ?) AND uses < max_uses",
    )
    .bind(hash)
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await?;
    if available.is_none() {
        return Err(invalid());
    }
    Ok(())
}

/// Consume in the *same* SQLite transaction that inserts the account. Exactly
/// one concurrent registration may consume the final use. A rolled-back
/// registration also rolls back code consumption.
pub async fn consume(
    tx: &mut SqliteConnection,
    code: Option<&str>,
    registration_open: bool,
) -> ApiResult<()> {
    if registration_open {
        return Ok(());
    }
    let hash = code_hash(code)?;
    let result = sqlx::query(
        "UPDATE registration_codes SET uses = uses + 1 \
         WHERE code_hash = ? AND revoked_at IS NULL \
         AND (expires_at IS NULL OR expires_at > ?) AND uses < max_uses",
    )
    .bind(hash)
    .bind(now_ms())
    .execute(tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(invalid());
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct CreateRequest {
    #[serde(default = "default_uses")]
    max_uses: i64,
    /// 0 means no expiration; otherwise 1 hour to 1 year.
    #[serde(default = "default_hours")]
    expires_in_hours: i64,
    #[serde(default)]
    label: String,
}

fn default_uses() -> i64 { 1 }
fn default_hours() -> i64 { 7 * 24 }

pub async fn create_api(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<CreateRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    if !(1..=MAX_USES).contains(&req.max_uses)
        || !(0..=24 * 365).contains(&req.expires_in_hours)
        || req.label.chars().count() > 80 {
        return Err(ApiError::BadRequest(
            "max_uses must be 1–10000; expiry hours 0–8760; label at most 80 characters".into(),
        ));
    }
    let issued = create(
        &state.pool, &auth.user_id, &req.label, req.max_uses, req.expires_in_hours * 3600,
    )
    .await
    .map_err(ApiError::Internal)?;
    crate::admin::record(
        &state, &auth.user_id, "registration_code.create", Some(&issued.id),
        json!({ "max_uses": issued.max_uses, "expires_at": issued.expires_at, "label": req.label }),
    )
    .await;
    Ok(Json(json!({
        "id": issued.id,
        "code": issued.code,
        "max_uses": issued.max_uses,
        "expires_at": issued.expires_at,
    })))
}

pub async fn list_api(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    crate::admin::require_admin(&state, &auth.user_id).await?;
    let rows: Vec<(String, String, String, String, i64, i64, i64, Option<i64>, Option<i64>)> =
        sqlx::query_as(
            "SELECT id, label, created_by, kind, max_uses, uses, created_at, expires_at, revoked_at \
             FROM registration_codes ORDER BY created_at DESC LIMIT 500",
        )
        .fetch_all(&state.pool)
        .await?;
    let codes: Vec<Value> = rows.into_iter().map(
        |(id, label, created_by, kind, max_uses, uses, created_at, expires_at, revoked_at)| json!({
            "id": id,
            "label": label,
            "created_by": created_by,
            "kind": kind,
            "max_uses": max_uses,
            "uses": uses,
            "created_at": created_at,
            "expires_at": expires_at,
            "revoked_at": revoked_at,
        })
    ).collect();
    Ok(Json(json!({ "codes": codes })))
}

pub async fn revoke_api(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let result = sqlx::query(
        "UPDATE registration_codes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .bind(now_ms())
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound("registration code not found or already revoked".into()));
    }
    crate::admin::record(
        &state, &auth.user_id, "registration_code.revoke", Some(&id), json!({}),
    )
    .await;
    Ok(Json(json!({ "ok": true, "id": id })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tokens_have_unpredictable_material_and_hash_only_is_storable() {
        let one = new_issued(1, DEFAULT_LIFETIME_SECS).unwrap();
        let two = new_issued(1, DEFAULT_LIFETIME_SECS).unwrap();
        assert!(one.code.starts_with("treg_") && one.code.len() >= 30);
        assert_ne!(one.code, two.code);
        assert_ne!(hash_token(&one.code), one.code);
        assert!(new_issued(0, 100).is_err());
        assert!(new_issued(1, MAX_LIFETIME_SECS + 1).is_err());
    }
}
