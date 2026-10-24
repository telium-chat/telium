
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::FedOrigin;
use crate::replicate;
use crate::state::AppState;
use crate::util::now_ms;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

fn ensure_standby(state: &AppState, origin: &str) -> ApiResult<()> {
    if state.cfg.failover.standbys.iter().any(|s| s == origin) {
        return Ok(());
    }
    Err(ApiError::Forbidden(format!(
        "{origin} is not a configured standby of this server"
    )))
}

pub async fn head(
    State(state): State<AppState>,
    FedOrigin(origin): FedOrigin,
) -> ApiResult<Json<replicate::Head>> {
    ensure_standby(&state, &origin)?;
    Ok(Json(replicate::head(&state.pool).await?))
}

#[derive(Deserialize)]
pub struct LogQuery {
    #[serde(default)]
    pub since: i64,
    pub limit: Option<i64>,
}

pub async fn log(
    State(state): State<AppState>,
    FedOrigin(origin): FedOrigin,
    Query(q): Query<LogQuery>,
) -> ApiResult<Json<Value>> {
    ensure_standby(&state, &origin)?;
    let limit = q.limit.unwrap_or(state.cfg.failover.batch);
    let entries = replicate::read_log(&state.pool, q.since, limit).await?;
    let head = replicate::head(&state.pool).await?;
    replicate::acknowledge(
        &state.pool,
        &origin,
        q.since,
        state.cfg.failover.keep_acked_secs * 1000,
    )
    .await?;
    Ok(Json(json!({ "entries": entries, "head": head })))
}

pub async fn snapshot(
    State(state): State<AppState>,
    FedOrigin(origin): FedOrigin,
) -> ApiResult<Response> {
    ensure_standby(&state, &origin)?;
    let dir = state.cfg.backup.dir.join("replication");
    let file = replicate::snapshot(&state.pool, &dir).await?;
    let handle = tokio::fs::File::open(&file)
        .await
        .map_err(|e| ApiError::Internal(e.into()))?;
    let length = handle.metadata().await.map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&file);
    let stream = tokio_util::io::ReaderStream::new(handle);
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/vnd.sqlite3".to_string()),
            (axum::http::header::CONTENT_LENGTH, length.to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

pub async fn media(
    State(state): State<AppState>,
    FedOrigin(origin): FedOrigin,
    Path(hash): Path<String>,
) -> ApiResult<Response> {
    ensure_standby(&state, &origin)?;
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.len() < 4 {
        return Err(ApiError::BadRequest("not a content address".into()));
    }
    let path = state.cfg.media_dir.join(&hash[0..2]).join(&hash);
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::NotFound("no such object".into()))?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        bytes,
    )
        .into_response())
}

pub async fn status(
    State(state): State<AppState>,
    Path(origin): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(i64, Option<i64>, Option<i64>, Option<i64>, i64, i64, Option<String>)> =
        sqlx::query_as(
            "SELECT cursor, snapshot_at, applied_at, lag_at, promoted, sequence, record \
             FROM replica_state WHERE origin = ?",
        )
    .bind(&origin)
    .fetch_optional(&state.pool)
    .await?;
    let (cursor, snapshot_at, applied_at, lag_at, promoted, sequence, record) = row
        .ok_or_else(|| ApiError::NotFound(format!("this server holds no copy of {origin}")))?;
    let record: Value = record
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or(Value::Null);
    let authority = record
        .get("authority")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if promoted != 0 {
                state.cfg.server_name.as_str()
            } else {
                origin.as_str()
            }
        })
        .to_string();
    let writable_here = promoted != 0 && authority == state.cfg.server_name;
    let behind_ms = lag_at.map(|at| now_ms() - at);
    let age_ms = applied_at.map(|at| now_ms() - at);
    let stale = !writable_here
        && age_ms.map(|ms| ms > state.cfg.failover.stale_after_secs * 1000).unwrap_or(true);
    Ok(Json(json!({
        "origin": origin,
        // May name a later standby, but must not claim its stale copy is writable.
        "authority": authority,
        "promoted": writable_here,
        "record": record,
        "read_only": !writable_here,
        "sequence": sequence,
        "cursor": cursor,
        "snapshot_at": snapshot_at,
        "applied_at": applied_at,
        "behind_ms": behind_ms,
        "age_ms": age_ms,
        "stale": stale,
        "standby": state.cfg.server_name,
    })))
}

pub async fn promote(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(origin): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let replica = replicate::open_replicas(&state)
        .await
        .map_err(ApiError::Internal)?
        .into_iter()
        .find(|r| r.origin == origin)
        .ok_or_else(|| ApiError::NotFound(format!("this server holds no copy of {origin}")))?;
    let result = crate::promotion::promote(&state, &replica).await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "standby.promote",
        Some(&origin),
        json!({ "sequence": result.get("sequence") }),
    )
    .await;
    Ok(Json(result))
}
