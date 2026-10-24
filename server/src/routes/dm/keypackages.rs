use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct PublishPackages {
    #[serde(default)]
    pub packages: Vec<String>,
    #[serde(default)]
    pub last_resort: Option<String>,
}

const MAX_KEY_PACKAGE_BYTES: usize = 16 * 1024;

const CLAIM_PAIR_BURST: f64 = 10.0;
const CLAIM_PAIR_PER_SEC: f64 = 1.0 / 60.0;

pub(crate) fn key_package_signature_key(package: &str) -> Option<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(package).ok()?;
    fn varint(b: &[u8], at: &mut usize) -> Option<usize> {
        let first = *b.get(*at)?;
        let width = match first >> 6 {
            0 => 1,
            1 => 2,
            2 => 4,
            _ => return None,
        };
        let mut value = (first & 0x3f) as usize;
        for i in 1..width {
            value = (value << 8) | *b.get(*at + i)? as usize;
        }
        *at += width;
        Some(value)
    }
    fn opaque<'a>(b: &'a [u8], at: &mut usize) -> Option<&'a [u8]> {
        let len = varint(b, at)?;
        let out = b.get(*at..at.checked_add(len)?)?;
        *at += len;
        Some(out)
    }
    if bytes.get(0..4)? != [0, 1, 0, 5] {
        return None;
    }
    let mut at = 8;
    opaque(&bytes, &mut at)?;
    opaque(&bytes, &mut at)?;
    let key = opaque(&bytes, &mut at)?;
    Some(base64::engine::general_purpose::STANDARD.encode(key))
}

pub async fn publish_key_packages(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<PublishPackages>,
) -> ApiResult<Json<Value>> {
    if req.packages.len() > 100 || (req.packages.is_empty() && req.last_resort.is_none()) {
        return Err(ApiError::BadRequest("publish between 1 and 100 packages".into()));
    }
    if req.packages.iter().chain(req.last_resort.iter()).any(|p| p.len() > MAX_KEY_PACKAGE_BYTES) {
        return Err(ApiError::BadRequest("key package is implausibly large".into()));
    }
    for package in req.packages.iter().chain(req.last_resort.iter()) {
        if let Some(key) = key_package_signature_key(package) {
            if super::super::identity_continuity::is_revoked_key(&state, &auth.user_id, &key).await? {
                return Err(ApiError::Forbidden("this device key has been revoked".into()));
            }
        }
    }
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    for package in &req.packages {
        sqlx::query(
            "INSERT INTO key_packages (id, user_id, device_id, package, created_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .bind(package)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    if let Some(package) = &req.last_resort {
        sqlx::query("DELETE FROM key_packages WHERE user_id = ? AND device_id = ? AND last_resort = 1")
            .bind(&auth.user_id)
            .bind(&auth.device_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO key_packages (id, user_id, device_id, package, created_at, last_resort) \
             VALUES (?, ?, ?, ?, ?, 1)",
        )
        .bind(ulid())
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .bind(package)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "published": req.packages.len(), "available": available(&state, &auth.user_id).await? })))
}

pub async fn withdraw_last_resort(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM key_packages WHERE user_id = ? AND device_id = ? AND last_resort = 1")
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "deleted": gone.rows_affected() })))
}

async fn available(state: &AppState, user_id: &str) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM key_packages WHERE user_id = ? AND last_resort = 0",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?)
}

pub async fn my_key_packages(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let per_device: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT device_id, SUM(CASE WHEN last_resort = 0 THEN 1 ELSE 0 END), MAX(last_resort) \
         FROM key_packages WHERE user_id = ? GROUP BY device_id",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "available": available(&state, &auth.user_id).await?,
        "devices": per_device.into_iter()
            .map(|(d, n, lr)| json!({ "device_id": d, "available": n, "last_resort": lr == 1 }))
            .collect::<Vec<_>>(),
    })))
}

async fn claim_local(state: &AppState, user_id: &str, claimer: &str) -> ApiResult<Value> {
    if state.cfg.rate_limit.enabled {
        if let Err(retry) = state.limiter.take(
            format!("keypackage-claim:{claimer}:{user_id}"),
            "keypackage-claim",
            CLAIM_PAIR_BURST,
            CLAIM_PAIR_PER_SEC,
        ) {
            return Err(ApiError::RateLimited(format!(
                "too many key package claims against this account: try again in {retry}s"
            )));
        }
    }
    let devices: Vec<String> =
        sqlx::query_scalar("SELECT device_id FROM devices WHERE user_id = ? AND active = 1")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    let mut claimed = Vec::new();
    for device_id in devices {
        let mut package = Value::Null;
        let mut last_resort = false;
        loop {
            let id: Option<String> = sqlx::query_scalar(
                "SELECT id FROM key_packages WHERE user_id = ? AND device_id = ? \
                 AND last_resort = 0 ORDER BY created_at LIMIT 1",
            )
            .bind(user_id)
            .bind(&device_id)
            .fetch_optional(&state.pool)
            .await?;
            let Some(id) = id else { break };
            let spent: Option<String> = sqlx::query_scalar(
                "DELETE FROM key_packages WHERE id = ? AND last_resort = 0 RETURNING package",
            )
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
            if let Some(candidate) = spent {
                package = Value::String(candidate);
                break;
            }
        }
        if package.is_null() {
            let fallback: Option<String> = sqlx::query_scalar(
                "SELECT package FROM key_packages WHERE user_id = ? AND device_id = ? AND last_resort = 1",
            )
            .bind(user_id)
            .bind(&device_id)
            .fetch_optional(&state.pool)
            .await?;
            if let Some(candidate) = fallback {
                package = Value::String(candidate);
                last_resort = true;
            }
        }
        claimed.push(json!({ "device_id": device_id, "package": package, "last_resort": last_resort }));
    }
    Ok(json!({ "user_id": user_id, "key_packages": claimed }))
}

pub async fn claim_key_packages(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let home = home_of(&user_id)?;
    if home == state.cfg.server_name {
        return Ok(Json(claim_local(&state, &user_id, &auth.user_id).await?));
    }
    federation::ensure_reachable(&state, &home, "dm").await?;
    let answer = federation::post_signed(
        &state,
        &home,
        "/_telium/v1/dm/keypackages/claim",
        &json!({ "user_id": user_id, "claimer": auth.user_id }),
    )
    .await?;
    Ok(Json(answer))
}

#[derive(Deserialize)]
pub struct RemoteClaim {
    pub user_id: String,
    pub claimer: String,
}

pub async fn inbound_claim(
    State(state): State<AppState>,
    fed: Fed<RemoteClaim>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.user_id)? != state.cfg.server_name {
        return Err(ApiError::NotFound("that user is not ours".into()));
    }
    if home_of(&fed.body.claimer)? != fed.origin {
        return Err(ApiError::Forbidden("a server claims only for its own users".into()));
    }
    Ok(Json(claim_local(&state, &fed.body.user_id, &fed.body.claimer).await?))
}
