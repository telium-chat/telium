
pub mod accounts;
pub mod continuity;
pub mod guilds;
pub mod health;

use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub const STEP_UP_WINDOW_MS: i64 = 5 * 60 * 1000;

pub async fn require_admin(state: &AppState, user_id: &str) -> ApiResult<()> {
    let admin: i64 = sqlx::query_scalar("SELECT admin FROM accounts WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(0);
    if admin == 0 {
        return Err(ApiError::Forbidden("server administrators only".into()));
    }
    Ok(())
}

pub async fn require_step_up(state: &AppState, user_id: &str) -> ApiResult<()> {
    require_admin(state, user_id).await?;
    let expires_at: Option<i64> =
        sqlx::query_scalar("SELECT expires_at FROM admin_step_up WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    match expires_at {
        Some(at) if at > now_ms() => Ok(()),
        _ => Err(ApiError::StepUpRequired(
            "this operation needs your password again; re-authenticate and retry".into(),
        )),
    }
}

pub async fn record(
    state: &AppState,
    actor: &str,
    action: &str,
    target: Option<&str>,
    data: Value,
) {
    let result = sqlx::query(
        "INSERT INTO server_audit_log (id, actor, action, target, data, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(data.to_string())
    .bind(now_ms())
    .execute(&state.pool)
    .await;
    if let Err(e) = result {
        tracing::error!(
            target: crate::logcat::ADMIN,
            error = %e, actor, action, target, data = %data,
            "administrator action was performed but could not be recorded"
        );
    }
}

pub async fn record_to_pool(
    pool: &SqlitePool,
    actor: &str,
    action: &str,
    target: Option<&str>,
    data: Value,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO server_audit_log (id, actor, action, target, data, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(data.to_string())
    .bind(now_ms())
    .execute(pool)
    .await
    .map(|_| ())
}

pub async fn record_refusal(state: &AppState, actor: &str, action: &str, why: &str) {
    record(state, actor, action, None, json!({ "refused": why })).await;
}

#[derive(Deserialize)]
pub struct StepUpRequest {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

pub async fn step_up_state(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let expires_at: Option<i64> =
        sqlx::query_scalar("SELECT expires_at FROM admin_step_up WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await?;
    let live = expires_at.filter(|at| *at > now_ms());
    Ok(Json(json!({
        "elevated": live.is_some(),
        "expires_at": live,
        "window_secs": STEP_UP_WINDOW_MS / 1000,
    })))
}

pub async fn step_up(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<StepUpRequest>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    if let Err(e) = crate::routes::identity::verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await
    {
        // Recorded before refusing: a failed elevation is a signal.
        record_refusal(&state, &auth.user_id, "step_up.deny", "credentials rejected").await;
        return Err(e);
    }

    let now = now_ms();
    let expires_at = now + STEP_UP_WINDOW_MS;
    sqlx::query(
        "INSERT INTO admin_step_up (user_id, granted_at, expires_at) VALUES (?, ?, ?) \
         ON CONFLICT(user_id) DO UPDATE SET granted_at = excluded.granted_at, \
         expires_at = excluded.expires_at",
    )
    .bind(&auth.user_id)
    .bind(now)
    .bind(expires_at)
    .execute(&state.pool)
    .await?;
    record(
        &state,
        &auth.user_id,
        "step_up.grant",
        None,
        json!({ "expires_at": expires_at }),
    )
    .await;

    Ok(Json(json!({
        "elevated": true,
        "expires_at": expires_at,
        "window_secs": STEP_UP_WINDOW_MS / 1000,
    })))
}

pub async fn end_step_up(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    sqlx::query("DELETE FROM admin_step_up WHERE user_id = ?")
        .bind(&auth.user_id)
        .execute(&state.pool)
        .await?;
    record(&state, &auth.user_id, "step_up.end", None, json!({})).await;
    Ok(Json(json!({ "elevated": false })))
}

pub async fn drop_step_up(state: &AppState, user_id: &str) -> ApiResult<()> {
    sqlx::query("DELETE FROM admin_step_up WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

pub async fn list_audit(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);

    // Binds only; no caller text reaches SQL.
    let mut sql = String::from(
        "SELECT id, actor, action, target, data, created_at FROM server_audit_log WHERE 1 = 1",
    );
    if q.before.is_some() {
        sql.push_str(" AND id < ?");
    }
    if q.action.is_some() {
        sql.push_str(" AND action = ?");
    }
    if q.actor.is_some() {
        sql.push_str(" AND actor = ?");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, (String, String, String, Option<String>, String, i64)>(&sql);
    if let Some(before) = &q.before {
        query = query.bind(before);
    }
    if let Some(action) = &q.action {
        query = query.bind(action);
    }
    if let Some(actor) = &q.actor {
        query = query.bind(actor);
    }
    let rows = query.bind(limit + 1).fetch_all(&state.pool).await?;

    let has_more = rows.len() as i64 > limit;
    let page = &rows[..rows.len().min(limit as usize)];
    let entries: Vec<Value> = page
        .iter()
        .map(|(id, actor, action, target, data, created_at)| {
            json!({
                "id": id,
                "actor": actor,
                "action": action,
                "target": target,
                "data": serde_json::from_str::<Value>(data).unwrap_or_else(|_| json!({})),
                "created_at": created_at,
            })
        })
        .collect();

    Ok(Json(json!({
        "entries": entries,
        "next_before": if has_more { page.last().map(|r| r.0.clone()) } else { None },
    })))
}
