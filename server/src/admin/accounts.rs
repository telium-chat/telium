
use crate::admin::{record, require_admin, require_step_up};
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct AccountQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
}

const ACCOUNT_COLUMNS: &str = "\
    a.user_id, a.localpart, p.display_name, a.created_at, a.admin, a.deactivated, \
    a.deleted_at, a.mfa_enabled, a.suspended_at, a.suspended_by, a.suspension_reason, \
    (SELECT COUNT(*) FROM home_sessions s WHERE s.user_id = a.user_id) AS sessions, \
    (SELECT COUNT(*) FROM devices d WHERE d.user_id = a.user_id AND d.active = 1) AS devices, \
    (SELECT COUNT(*) FROM guilds g WHERE g.owner_user_id = a.user_id) AS guilds_owned, \
    (SELECT t.new_id FROM tombstones t WHERE t.subject_type = 'user' \
       AND t.subject_id = a.user_id AND t.kind = 'moved') AS moved_to";

type AccountRow = (
    String,         // user_id
    String,         // localpart
    Option<String>, // display_name
    i64,            // created_at
    i64,            // admin
    i64,            // deactivated
    Option<i64>,    // deleted_at
    i64,            // mfa_enabled
    Option<i64>,    // suspended_at
    Option<String>, // suspended_by
    Option<String>, // suspension_reason
    i64,            // sessions
    i64,            // devices
    i64,            // guilds_owned
    Option<String>, // moved_to
);

fn account_json(r: &AccountRow) -> Value {
    json!({
        "user_id": r.0,
        "localpart": r.1,
        "display_name": r.2,
        "created_at": r.3,
        "admin": r.4 != 0,
        "deactivated": r.5 != 0,
        "deleted_at": r.6,
        "mfa_enabled": r.7 != 0,
        "suspended_at": r.8,
        "suspended_by": r.9,
        "suspension_reason": r.10,
        "sessions": r.11,
        "devices": r.12,
        "guilds_owned": r.13,
        "moved_to": r.14,
    })
}

pub async fn list(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<AccountQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);

    let status = q.status.as_deref().unwrap_or("all");
    let status_clause = match status {
        "active" => " AND a.deactivated = 0 AND a.deleted_at IS NULL",
        "suspended" => " AND a.deactivated = 1 AND a.deleted_at IS NULL",
        "deleted" => " AND a.deleted_at IS NOT NULL",
        "admins" => " AND a.admin = 1",
        "all" => "",
        other => {
            return Err(ApiError::BadRequest(format!(
                "status must be all, active, suspended, deleted or admins, not {other}"
            )))
        }
    };

    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut sql = format!(
        "SELECT {ACCOUNT_COLUMNS} FROM accounts a \
         LEFT JOIN profiles p ON p.user_id = a.user_id \
         WHERE a.domain = ?{status_clause}"
    );
    if search.is_some() {
        sql.push_str(" AND (a.localpart LIKE ? OR p.display_name LIKE ?)");
    }
    if q.cursor.is_some() {
        sql.push_str(
            " AND (a.created_at, a.user_id) < \
             ((SELECT created_at FROM accounts WHERE user_id = ?), ?)",
        );
    }
    sql.push_str(" ORDER BY a.created_at DESC, a.user_id DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, AccountRow>(&sql).bind(&state.cfg.server_name);
    if let Some(term) = search {
        let pattern = format!("%{term}%");
        query = query.bind(pattern.clone()).bind(pattern);
    }
    if let Some(cursor) = &q.cursor {
        query = query.bind(cursor).bind(cursor);
    }
    let rows = query.bind(limit + 1).fetch_all(&state.pool).await?;

    let has_more = rows.len() as i64 > limit;
    let page = &rows[..rows.len().min(limit as usize)];

    let mut count_sql =
        format!("SELECT COUNT(*) FROM accounts a LEFT JOIN profiles p ON p.user_id = a.user_id \
                 WHERE a.domain = ?{status_clause}");
    if search.is_some() {
        count_sql.push_str(" AND (a.localpart LIKE ? OR p.display_name LIKE ?)");
    }
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql).bind(&state.cfg.server_name);
    if let Some(term) = search {
        let pattern = format!("%{term}%");
        count_query = count_query.bind(pattern.clone()).bind(pattern);
    }
    let total = count_query.fetch_one(&state.pool).await?;

    Ok(Json(json!({
        "accounts": page.iter().map(account_json).collect::<Vec<_>>(),
        "next_cursor": if has_more { page.last().map(|r| r.0.clone()) } else { None },
        "total": total,
    })))
}

async fn load(state: &AppState, user_id: &str) -> ApiResult<AccountRow> {
    let sql = format!(
        "SELECT {ACCOUNT_COLUMNS} FROM accounts a \
         LEFT JOIN profiles p ON p.user_id = a.user_id WHERE a.user_id = ?"
    );
    sqlx::query_as::<_, AccountRow>(&sql)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such account on this server".into()))
}

pub async fn detail(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let row = load(&state, &user_id).await?;

    let memberships: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE user_id = ?")
            .bind(&user_id)
            .fetch_one(&state.pool)
            .await?;
    let owned: Vec<(String, String)> =
        sqlx::query_as("SELECT id, name FROM guilds WHERE owner_user_id = ? ORDER BY created_at")
            .bind(&user_id)
            .fetch_all(&state.pool)
            .await?;
    let reports_against: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM reports WHERE target_type = 'account' AND target_id = ?",
    )
    .bind(&user_id)
    .fetch_one(&state.pool)
    .await?;
    let last_session_at: Option<i64> =
        sqlx::query_scalar("SELECT MAX(last_seen) FROM devices WHERE user_id = ?")
            .bind(&user_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();

    Ok(Json(json!({
        "account": account_json(&row),
        "memberships": memberships,
        "owned_guilds": owned.iter()
            .map(|(id, name)| json!({ "id": id, "name": name }))
            .collect::<Vec<_>>(),
        "reports_against": reports_against,
        "last_session_at": last_session_at,
    })))
}

#[derive(Deserialize)]
pub struct SuspendRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn suspend(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
    Json(req): Json<SuspendRequest>,
) -> ApiResult<Json<Value>> {
    require_step_up(&state, &auth.user_id).await?;
    let reason = req
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .ok_or_else(|| ApiError::BadRequest("a suspension needs a reason".into()))?;

    let row = load(&state, &user_id).await?;

    if user_id == auth.user_id {
        return Err(ApiError::Conflict(
            "an administrator cannot suspend their own account from here".into(),
        ));
    }
    // Suspending an admin is an authority change; `admin` is set in config.
    if row.4 != 0 {
        return Err(ApiError::Conflict(
            "that account is a server administrator; clear its admin column first".into(),
        ));
    }
    if row.6.is_some() {
        return Err(ApiError::Conflict("that account has been deleted".into()));
    }
    if row.5 != 0 {
        return Err(ApiError::Conflict("that account is already turned off".into()));
    }

    let now = now_ms();
    sqlx::query(
        "UPDATE accounts SET deactivated = 1, suspended_at = ?, suspended_by = ?, \
         suspension_reason = ? WHERE user_id = ?",
    )
    .bind(now)
    .bind(&auth.user_id)
    .bind(reason)
    .bind(&user_id)
    .execute(&state.pool)
    .await?;

    let sessions_revoked: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM home_sessions WHERE user_id = ?")
            .bind(&user_id)
            .fetch_one(&state.pool)
            .await?;
    crate::routes::identity::revoke_all_sessions(&state, &user_id).await?;
    crate::revocation::announce(&state, &user_id, crate::revocation::DEACTIVATED, None, None)
        .await;
    crate::admin::drop_step_up(&state, &user_id).await?;

    record(
        &state,
        &auth.user_id,
        "account.suspend",
        Some(&user_id),
        json!({ "reason": reason, "sessions_revoked": sessions_revoked }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "user_id": user_id,
        "sessions_revoked": sessions_revoked,
    })))
}

pub async fn reinstate(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_step_up(&state, &auth.user_id).await?;
    let row = load(&state, &user_id).await?;

    if row.6.is_some() {
        return Err(ApiError::Conflict(
            "that account has been deleted; reinstatement is not what undoes that".into(),
        ));
    }
    // Only operator suspensions are liftable; a self-deactivated account is reactivated by its owner.
    if row.8.is_none() {
        return Err(ApiError::Conflict(
            "that account was not suspended by an operator; its owner deactivated it".into(),
        ));
    }

    sqlx::query(
        "UPDATE accounts SET deactivated = 0, suspended_at = NULL, suspended_by = NULL, \
         suspension_reason = NULL WHERE user_id = ?",
    )
    .bind(&user_id)
    .execute(&state.pool)
    .await?;
    // Nothing announced: older peers reject an unknown `reinstated` notice kind.

    record(
        &state,
        &auth.user_id,
        "account.reinstate",
        Some(&user_id),
        json!({ "was_suspended_at": row.8, "was_reason": row.10 }),
    )
    .await;

    Ok(Json(json!({ "ok": true, "user_id": user_id })))
}

pub async fn refuse_operator_suspended(state: &AppState, user_id: &str) -> ApiResult<()> {
    let suspended: Option<i64> =
        sqlx::query_scalar("SELECT suspended_at FROM accounts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?
            .flatten();
    if suspended.is_some() {
        return Err(ApiError::Unauthorized("account_suspended".into()));
    }
    Ok(())
}
