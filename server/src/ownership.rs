
use crate::admin;
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::Arc;

pub const USABLE_ADMIN: &str = "admin = 1 AND deactivated = 0 AND deleted_at IS NULL \
     AND NOT (password_hash = 'opaque:v1' AND opaque_record IS NULL)";

const DORMANT_AFTER_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AdminStanding {
    pub user_id: String,
    pub localpart: String,
    pub admin_since: Option<i64>,
    pub admin_granted_by: Option<String>,
    pub usable: bool,
    pub unusable_because: &'static str,
    pub last_seen: i64,
    pub dormant: bool,
    pub active_devices: i64,
    pub live_sessions: i64,
}

pub async fn roster(state: &AppState) -> ApiResult<Vec<AdminStanding>> {
    let now = now_ms();
    let rows: Vec<(String, String, Option<i64>, Option<String>, i64, Option<i64>, String, Option<String>)> =
        sqlx::query_as(
            "SELECT user_id, localpart, admin_since, admin_granted_by, deactivated, deleted_at, \
             password_hash, opaque_record FROM accounts WHERE admin = 1 ORDER BY admin_since, user_id",
        )
        .fetch_all(&state.pool)
        .await?;

    let mut out = Vec::with_capacity(rows.len());
    for (user_id, localpart, admin_since, admin_granted_by, deactivated, deleted_at, hash, opaque) in
        rows
    {
        let unusable_because = if deactivated != 0 {
            "the account is deactivated or suspended"
        } else if deleted_at.is_some() {
            "the account is scheduled for deletion"
        } else if hash == crate::routes::opaque::PASSWORD_SENTINEL && opaque.is_none() {
            "the account has no credential on file and cannot sign in"
        } else {
            ""
        };

        let last_seen: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(last_seen), 0) FROM devices WHERE user_id = ? AND active = 1",
        )
        .bind(&user_id)
        .fetch_one(&state.pool)
        .await?;
        let active_devices: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM devices WHERE user_id = ? AND active = 1")
                .bind(&user_id)
                .fetch_one(&state.pool)
                .await?;
        let live_sessions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM home_sessions WHERE user_id = ? AND expires_at > ?",
        )
        .bind(&user_id)
        .bind(now)
        .fetch_one(&state.pool)
        .await?;

        out.push(AdminStanding {
            user_id,
            localpart,
            admin_since,
            admin_granted_by,
            usable: unusable_because.is_empty(),
            unusable_because,
            last_seen,
            dormant: last_seen > 0 && now - last_seen > DORMANT_AFTER_MS,
            active_devices,
            live_sessions,
        });
    }
    Ok(out)
}

pub async fn usable_admin_count(pool: &SqlitePool) -> sqlx::Result<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM accounts WHERE {USABLE_ADMIN}"))
        .fetch_one(pool)
        .await
}

pub async fn is_last_usable_admin(pool: &SqlitePool, user_id: &str) -> sqlx::Result<bool> {
    let others: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM accounts WHERE {USABLE_ADMIN} AND user_id <> ?"
    ))
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    if others > 0 {
        return Ok(false);
    }
    let self_usable: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM accounts WHERE {USABLE_ADMIN} AND user_id = ?"
    ))
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(self_usable > 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Departure {
    Deactivate,
    Delete,
    Move,
    Revoke,
}

impl Departure {
    pub fn slug(self) -> &'static str {
        match self {
            Departure::Deactivate => "deactivate",
            Departure::Delete => "delete",
            Departure::Move => "move",
            Departure::Revoke => "revoke",
        }
    }

    fn prose(self) -> &'static str {
        match self {
            Departure::Deactivate => "deactivating it",
            Departure::Delete => "deleting it",
            Departure::Move => "moving it to another homeserver",
            Departure::Revoke => "removing their administrator access",
        }
    }
}

pub async fn refuse_if_last_admin(
    pool: &SqlitePool,
    user_id: &str,
    what: Departure,
) -> ApiResult<()> {
    if is_last_usable_admin(pool, user_id).await? {
        let prose = what.prose();
        return Err(ApiError::Conflict(format!(
            "{user_id} is the only administrator this server has left, so {prose} would leave it \
             with nobody able to administer it. Grant server-administrator access to another \
             account that can sign in, then try again."
        ))
        .with_code(crate::errcodes::LAST_ADMIN)
        .with_detail("user_id", user_id)
        .with_detail("attempted", what.slug()));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct AuthorityChange {
    pub user_id: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

async fn require_fresh_credential(state: &AppState, req: &AuthorityChange, actor: &str) -> ApiResult<()> {
    crate::federation::routes::require_admin(state, actor).await?;
    if let Err(e) = crate::routes::identity::verify_sensitive_reauth(
        state,
        actor,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await
    {
        admin::record(
            state,
            actor,
            "ownership.deny",
            Some(&req.user_id),
            json!({ "refused": "credentials rejected" }),
        )
        .await;
        return Err(e);
    }
    Ok(())
}

pub async fn grant(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<AuthorityChange>,
) -> ApiResult<Json<Value>> {
    require_fresh_credential(&state, &req, &auth.user_id).await?;

    let subject: Option<(i64, i64, Option<i64>, String, Option<String>)> = sqlx::query_as(
        "SELECT admin, deactivated, deleted_at, password_hash, opaque_record FROM accounts \
         WHERE user_id = ?",
    )
    .bind(&req.user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((admin, deactivated, deleted_at, hash, opaque)) = subject else {
        return Err(ApiError::NotFound("no such account on this server".into()));
    };
    if admin != 0 {
        return Err(ApiError::Conflict("that account already administers this server".into()));
    }
    if deactivated != 0 || deleted_at.is_some() {
        return Err(ApiError::Conflict(
            "that account is deactivated or scheduled for deletion, so it could not use the \
             access. Reactivate it first."
                .into(),
        ));
    }
    if hash == crate::routes::opaque::PASSWORD_SENTINEL && opaque.is_none() {
        return Err(ApiError::Conflict(
            "that account has no credential on file and cannot sign in, so it could not use the \
             access."
                .into(),
        ));
    }

    let now = now_ms();
    sqlx::query("UPDATE accounts SET admin = 1, admin_since = ?, admin_granted_by = ? WHERE user_id = ?")
        .bind(now)
        .bind(&auth.user_id)
        .bind(&req.user_id)
        .execute(&state.pool)
        .await?;
    admin::record(&state, &auth.user_id, "ownership.grant", Some(&req.user_id), json!({ "at": now })).await;
    announce_to_admins(
        &state,
        "OWNERSHIP_GRANTED",
        json!({ "user_id": req.user_id, "by": auth.user_id, "at": now }),
        &format!(
            "{} granted server-administrator access on {} to {}.",
            auth.user_id, state.cfg.server_name, req.user_id
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true, "user_id": req.user_id, "admin_since": now })))
}

pub async fn revoke(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<AuthorityChange>,
) -> ApiResult<Json<Value>> {
    require_fresh_credential(&state, &req, &auth.user_id).await?;

    let admin: Option<i64> = sqlx::query_scalar("SELECT admin FROM accounts WHERE user_id = ?")
        .bind(&req.user_id)
        .fetch_optional(&state.pool)
        .await?;
    match admin {
        None => return Err(ApiError::NotFound("no such account on this server".into())),
        Some(0) => {
            return Err(ApiError::Conflict("that account does not administer this server".into()))
        }
        Some(_) => {}
    }

    if let Err(e) =
        refuse_if_last_admin(&state.pool, &req.user_id, Departure::Revoke).await
    {
        admin::record(
            &state,
            &auth.user_id,
            "ownership.revoke.refused",
            Some(&req.user_id),
            json!({ "refused": "would leave no usable administrator" }),
        )
        .await;
        return Err(e);
    }

    sqlx::query(
        "UPDATE accounts SET admin = 0, admin_since = NULL, admin_granted_by = NULL \
         WHERE user_id = ?",
    )
    .bind(&req.user_id)
    .execute(&state.pool)
    .await?;
    cancel_claims_for(&state, &req.user_id, &auth.user_id, "the account is no longer an administrator")
        .await?;
    admin::record(&state, &auth.user_id, "ownership.revoke", Some(&req.user_id), json!({})).await;
    announce_to_admins(
        &state,
        "OWNERSHIP_REVOKED",
        json!({ "user_id": req.user_id, "by": auth.user_id }),
        &format!(
            "{} removed server-administrator access on {} from {}.",
            auth.user_id, state.cfg.server_name, req.user_id
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true, "user_id": req.user_id })))
}

pub async fn overview(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    let administrators = roster(&state).await?;
    let usable = administrators.iter().filter(|a| a.usable).count();
    Ok(Json(json!({
        "administrators": administrators,
        "usable": usable,
        "sole_administrator": usable <= 1,
        "pending_recovery_claims": pending_claims(&state).await?,
        "recovery_delay_secs": state.cfg.ownership.recovery_delay_secs,
    })))
}

pub async fn sessions(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    let now = now_ms();
    let admins: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM accounts WHERE admin = 1 ORDER BY user_id")
            .fetch_all(&state.pool)
            .await?;
    let mut out = Vec::new();
    for user_id in admins {
        let devices: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
            "SELECT device_id, name, created_at, last_seen, active FROM devices \
             WHERE user_id = ? ORDER BY last_seen DESC",
        )
        .bind(&user_id)
        .fetch_all(&state.pool)
        .await?;
        let mut listed = Vec::with_capacity(devices.len());
        for (device_id, name, created_at, last_seen, active) in devices {
            let live: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM home_sessions WHERE device_id = ? AND expires_at > ?",
            )
            .bind(&device_id)
            .bind(now)
            .fetch_one(&state.pool)
            .await?;
            listed.push(json!({
                "device_id": device_id,
                "name": name,
                "created_at": created_at,
                "last_seen": last_seen,
                "active": active != 0,
                "live_sessions": live,
            }));
        }
        out.push(json!({ "user_id": user_id, "devices": listed }));
    }
    Ok(Json(json!({ "administrators": out })))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(device_id): Path<String>,
    Json(req): Json<AuthorityChange>,
) -> ApiResult<Json<Value>> {
    require_fresh_credential(&state, &req, &auth.user_id).await?;
    let owner: Option<(String, i64)> =
        sqlx::query_as("SELECT d.user_id, a.admin FROM devices d JOIN accounts a ON a.user_id = d.user_id \
                        WHERE d.device_id = ?")
            .bind(&device_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((owner_id, owner_is_admin)) = owner else {
        return Err(ApiError::NotFound("device not found".into()));
    };
    if owner_id != req.user_id {
        return Err(ApiError::Conflict(
            "that device belongs to a different account than the one named; reload the list".into(),
        ));
    }
    if owner_is_admin == 0 {
        return Err(ApiError::Forbidden(
            "this route only acts on administrator devices".into(),
        ));
    }

    sqlx::query("UPDATE devices SET active = 0 WHERE device_id = ?")
        .bind(&device_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM home_sessions WHERE device_id = ?")
        .bind(&device_id)
        .execute(&state.pool)
        .await?;
    crate::revocation::announce(&state, &owner_id, crate::revocation::DEVICE, Some(&device_id), None)
        .await;
    admin::record(
        &state,
        &auth.user_id,
        "ownership.session.revoke",
        Some(&owner_id),
        json!({ "device_id": device_id }),
    )
    .await;
    announce_to_admins(
        &state,
        "OWNERSHIP_SESSION_REVOKED",
        json!({ "user_id": owner_id, "device_id": device_id, "by": auth.user_id }),
        &format!(
            "{} ended a signed-in device belonging to {} on {}. If that was not agreed, treat \
             this server as compromised and read docs/runbooks/compromised-admin-account.md.",
            auth.user_id, owner_id, state.cfg.server_name
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true, "device_id": device_id })))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct HostEvidence {
    pub database: String,
    pub config: String,
    pub uid: Option<u32>,
    pub hostname: Option<String>,
    #[serde(default)]
    pub database_mode: Option<u32>,
    #[serde(default)]
    pub directory_mode: Option<u32>,
}

#[cfg(unix)]
pub fn host_modes(database: &std::path::Path) -> (Option<u32>, Option<u32>) {
    use std::os::unix::fs::PermissionsExt as _;
    let mode = |p: &std::path::Path| {
        std::fs::metadata(p).ok().map(|m| m.permissions().mode() & 0o777)
    };
    (mode(database), database.parent().and_then(mode))
}

#[cfg(not(unix))]
pub fn host_modes(_database: &std::path::Path) -> (Option<u32>, Option<u32>) {
    (None, None)
}

fn refuse_weak_host_authority(evidence: &HostEvidence) -> Result<(), String> {
    for (what, mode, fix) in [
        ("database", evidence.database_mode, evidence.database.clone()),
        (
            "directory holding the database",
            evidence.directory_mode,
            std::path::Path::new(&evidence.database)
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default(),
        ),
    ] {
        let Some(mode) = mode else { continue };
        if mode & 0o022 == 0 {
            continue;
        }
        let suggested = mode & 0o700;
        return Err(format!(
            "the {what} is mode {mode:04o}, so users other than its owner can write it. \
             Administrator recovery works by believing that whoever can write this server's \
             database controls this machine; on a {what} anybody can write, that belief is \
             wrong and this claim would be recording a fact that is not true. Fix it with \
             `chmod {suggested:04o} {fix}` and run this again. If you do not know who else \
             could write it, treat this server's federation signing key as compromised too -- \
             see docs/runbooks/compromised-federation-key.md."
        ));
    }
    Ok(())
}

pub async fn open_claim(
    pool: &SqlitePool,
    subject: &str,
    reason: &str,
    evidence: &HostEvidence,
    delay_secs: i64,
) -> anyhow::Result<(String, i64, i64)> {
    let row: Option<(i64, i64, Option<i64>, String, Option<String>)> = sqlx::query_as(
        "SELECT admin, deactivated, deleted_at, password_hash, opaque_record FROM accounts \
         WHERE user_id = ?",
    )
    .bind(subject)
    .fetch_optional(pool)
    .await?;
    let Some((admin, deactivated, deleted_at, hash, opaque)) = row else {
        anyhow::bail!(
            "{subject} does not exist on this server. Recovery nominates an account you can \
             already sign in to; register one through the normal signup first, then name it here."
        );
    };
    if let Err(why) = refuse_weak_host_authority(evidence) {
        tracing::error!(
            target: crate::logcat::ADMIN,
            subject = %subject,
            database = %evidence.database,
            database_mode = evidence.database_mode.map(|m| format!("{m:04o}")),
            directory_mode = evidence.directory_mode.map(|m| format!("{m:04o}")),
            "administrator recovery refused: {why}"
        );
        admin::record_to_pool(
            pool,
            "filesystem",
            "ownership.recovery.refused",
            Some(subject),
            json!({ "refused": why, "host_evidence": evidence }),
        )
        .await?;
        anyhow::bail!("{why}");
    }
    if admin != 0 {
        anyhow::bail!("{subject} already administers this server");
    }
    if deactivated != 0 || deleted_at.is_some() {
        anyhow::bail!("{subject} is deactivated or scheduled for deletion and could not use the access");
    }
    if hash == crate::routes::opaque::PASSWORD_SENTINEL && opaque.is_none() {
        anyhow::bail!("{subject} has no credential on file and could not sign in to use the access");
    }

    let usable = usable_admin_count(pool).await?;
    let now = now_ms();
    let effective_at = if usable == 0 { now } else { now + delay_secs * 1000 };

    let id = ulid();
    sqlx::query(
        "INSERT INTO admin_recovery_claims \
         (id, subject, reason, host_evidence, requested_at, effective_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(subject)
    .bind(reason)
    .bind(serde_json::to_string(evidence)?)
    .bind(now)
    .bind(effective_at)
    .execute(pool)
    .await?;
    admin::record_to_pool(
        pool,
        "filesystem",
        "ownership.recovery.open",
        Some(subject),
        json!({
            "claim": id,
            "reason": reason,
            "effective_at": effective_at,
            "usable_admins_at_request": usable,
            "host_evidence": evidence,
        }),
    )
    .await?;
    Ok((id, effective_at, usable))
}

pub async fn pending_claims(state: &AppState) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, String, i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, subject, reason, host_evidence, requested_at, effective_at, announced_at \
         FROM admin_recovery_claims WHERE applied_at IS NULL AND cancelled_at IS NULL \
         ORDER BY requested_at",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, subject, reason, evidence, requested_at, effective_at, announced_at)| {
            json!({
                "id": id,
                "subject": subject,
                "reason": reason,
                "host_evidence": serde_json::from_str::<Value>(&evidence).unwrap_or_else(|_| json!({})),
                "requested_at": requested_at,
                "effective_at": effective_at,
                "announced_at": announced_at,
            })
        })
        .collect())
}

pub async fn cancel_claim(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    let done = sqlx::query(
        "UPDATE admin_recovery_claims SET cancelled_at = ?, cancelled_by = ? \
         WHERE id = ? AND applied_at IS NULL AND cancelled_at IS NULL",
    )
    .bind(now_ms())
    .bind(&auth.user_id)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::Conflict(
            "that claim has already been applied or cancelled".into(),
        ));
    }
    admin::record(&state, &auth.user_id, "ownership.recovery.cancel", Some(&id), json!({})).await;
    announce_to_admins(
        &state,
        "OWNERSHIP_RECOVERY_CANCELLED",
        json!({ "claim": id, "by": auth.user_id }),
        &format!(
            "{} cancelled the pending administrator-recovery claim on {}.",
            auth.user_id, state.cfg.server_name
        ),
    )
    .await;
    Ok(Json(json!({ "ok": true, "claim": id })))
}

async fn cancel_claims_for(
    state: &AppState,
    subject: &str,
    by: &str,
    why: &str,
) -> ApiResult<()> {
    let done = sqlx::query(
        "UPDATE admin_recovery_claims SET cancelled_at = ?, cancelled_by = ? \
         WHERE subject = ? AND applied_at IS NULL AND cancelled_at IS NULL",
    )
    .bind(now_ms())
    .bind(by)
    .bind(subject)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() > 0 {
        admin::record(
            state,
            by,
            "ownership.recovery.cancel",
            Some(subject),
            json!({ "automatic": true, "why": why, "claims": done.rows_affected() }),
        )
        .await;
    }
    Ok(())
}

pub async fn run_pending(state: &AppState) -> ApiResult<usize> {
    let now = now_ms();
    let delay_ms = state.cfg.ownership.recovery_delay_secs * 1000;
    let rows: Vec<(String, String, String, i64, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, subject, reason, requested_at, effective_at, announced_at \
         FROM admin_recovery_claims WHERE applied_at IS NULL AND cancelled_at IS NULL \
         ORDER BY requested_at",
    )
    .fetch_all(&state.pool)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }

    let mut applied = 0usize;
    for (id, subject, reason, _requested_at, effective_at, announced_at) in rows {
        let ownerless = usable_admin_count(&state.pool).await? == 0;

        if announced_at.is_none() {
            sqlx::query("UPDATE admin_recovery_claims SET announced_at = ? WHERE id = ?")
                .bind(now)
                .bind(&id)
                .execute(&state.pool)
                .await?;
            tracing::error!(
                target: crate::logcat::ADMIN,
                claim = %id, %subject, %reason, ownerless,
                "AN ADMINISTRATOR-RECOVERY CLAIM WAS OPENED FROM THIS MACHINE'S FILESYSTEM. \
                 If you did not do this, cancel it now: someone with access to this host is \
                 taking over the server."
            );
            announce_to_admins(
                state,
                "OWNERSHIP_RECOVERY_OPENED",
                json!({ "claim": id, "subject": subject, "reason": reason,
                        "effective_at": effective_at }),
                &format!(
                    "Someone with filesystem access to {server} has asked for \
                     server-administrator access to be granted to {subject}.\n\n\
                     Their stated reason: {reason}\n\n\
                     If that was you, there is nothing to do.\n\n\
                     If it was not, sign in to {server} and cancel the claim now, and treat \
                     the machine as compromised: whoever opened it can read the server's \
                     database, which holds every key this server signs with.",
                    server = state.cfg.server_name,
                ),
            )
            .await;
            if !ownerless {
                continue;
            }
        }

        if !ownerless {
            let announced = announced_at.unwrap_or(now);
            if now < effective_at || now < announced + delay_ms {
                continue;
            }
        }

        let still_grantable: Option<(i64, i64, Option<i64>)> = sqlx::query_as(
            "SELECT admin, deactivated, deleted_at FROM accounts WHERE user_id = ?",
        )
        .bind(&subject)
        .fetch_optional(&state.pool)
        .await?;
        let grantable = matches!(still_grantable, Some((0, 0, None)));
        if !grantable {
            sqlx::query(
                "UPDATE admin_recovery_claims SET cancelled_at = ?, cancelled_by = 'system' \
                 WHERE id = ?",
            )
            .bind(now)
            .bind(&id)
            .execute(&state.pool)
            .await?;
            admin::record(
                state,
                "system",
                "ownership.recovery.cancel",
                Some(&subject),
                json!({ "claim": id, "why": "the account can no longer hold the access" }),
            )
            .await;
            continue;
        }

        sqlx::query(
            "UPDATE accounts SET admin = 1, admin_since = ?, admin_granted_by = NULL \
             WHERE user_id = ?",
        )
        .bind(now)
        .bind(&subject)
        .execute(&state.pool)
        .await?;
        sqlx::query("UPDATE admin_recovery_claims SET applied_at = ? WHERE id = ?")
            .bind(now)
            .bind(&id)
            .execute(&state.pool)
            .await?;
        admin::record(
            state,
            "filesystem",
            "ownership.recovery.apply",
            Some(&subject),
            json!({ "claim": id, "ownerless": ownerless }),
        )
        .await;
        tracing::error!(
            target: crate::logcat::ADMIN,
            claim = %id, %subject, ownerless,
            "ADMINISTRATOR ACCESS WAS GRANTED BY FILESYSTEM RECOVERY"
        );
        announce_to_admins(
            state,
            "OWNERSHIP_RECOVERY_APPLIED",
            json!({ "claim": id, "subject": subject }),
            &format!(
                "{subject} now has server-administrator access to {server}, granted by a \
                 recovery claim opened from that machine's filesystem.",
                server = state.cfg.server_name,
            ),
        )
        .await;
        applied += 1;
    }
    Ok(applied)
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = run_pending(&state).await {
                tracing::warn!(target: crate::logcat::ADMIN, error = %e, "could not process administrator-recovery claims");
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

async fn announce_to_admins(state: &AppState, kind: &'static str, data: Value, email_text: &str) {
    let admins: Vec<(String,)> =
        match sqlx::query_as("SELECT user_id FROM accounts WHERE admin = 1")
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!(target: crate::logcat::ADMIN, error = %e, kind, "could not list administrators to notify");
                return;
            }
        };

    for (user_id,) in admins {
        state
            .hub
            .publish_user(
                &user_id,
                Arc::new(Event {
                    t: kind,
                    guild_id: String::new(),
                    channel_id: None,
                    intent: 0,
                    only_user: Some(user_id.clone()),
                    data: data.clone(),
                }),
            )
            .await;
        crate::routes::push::notify(state, &user_id, json!({ "type": "ownership" })).await;

        if !crate::mail::configured(state) {
            continue;
        }
        let address = match crate::mail::verified_recovery_address(state, &user_id).await {
            Ok(Some(address)) => address,
            Ok(None) => continue,
            Err(e) => {
                tracing::warn!(
                    target: crate::logcat::ADMIN,
                    error = %e, kind, user_id,
                    "could not look up an administrator's recovery address"
                );
                continue;
            }
        };
        let state = state.clone();
        let subject = format!("Server-administrator access on {} changed", state.cfg.server_name);
        let text = email_text.to_string();
        tokio::spawn(async move {
            match crate::mail::send_notice(&state, &address, &user_id, &subject, &text).await {
                Ok(Ok(())) => {}
                Ok(Err(refused)) => {
                    tracing::warn!(
                        target: crate::logcat::ADMIN,
                        refused = %refused.words(),
                        "an ownership alert email was not sent"
                    );
                }
                Err(e) => {
                    tracing::warn!(target: crate::logcat::ADMIN, error = %e, "an ownership alert email was not sent");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_matches_the_predicate() {
        assert!(
            USABLE_ADMIN.contains(&format!("'{}'", crate::routes::opaque::PASSWORD_SENTINEL)),
            "USABLE_ADMIN must quote the current OPAQUE password sentinel"
        );
    }
}
