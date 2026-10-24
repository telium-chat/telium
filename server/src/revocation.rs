
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::now_ms;
use serde::Deserialize;
use serde_json::{json, Value};

pub const DEVICE: &str = "device";
pub const ALL_DEVICES: &str = "all_devices";
pub const DEACTIVATED: &str = "deactivated";
pub const DELETED: &str = "deleted";
pub const MOVED: &str = "moved";

const KINDS: &[&str] = &[DEVICE, ALL_DEVICES, DEACTIVATED, DELETED, MOVED];

pub const MAX_FANOUT: i64 = 256;

pub const MAX_ATTEMPTS: i64 = 12;

pub const NOTICE_BURST: f64 = 60.0;
pub const NOTICE_PER_SEC: f64 = 1.0;

#[derive(Debug, Clone, Deserialize)]
pub struct Notice {
    pub user_id: String,
    pub kind: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub new_id: Option<String>,
    #[serde(default)]
    pub at: i64,
}

pub fn body(user_id: &str, kind: &str, device_id: Option<&str>, new_id: Option<&str>) -> Value {
    json!({
        "user_id": user_id,
        "kind": kind,
        "device_id": device_id,
        "new_id": new_id,
        "at": now_ms(),
    })
}

pub async fn announce(
    state: &AppState,
    user_id: &str,
    kind: &'static str,
    device_id: Option<&str>,
    new_id: Option<&str>,
) {
    if let Err(e) = queue(state, user_id, kind, device_id, new_id).await {
        tracing::warn!(target: crate::logcat::AUTH, %user_id, kind, error = %e, "could not queue identity revocation notices; revalidation will catch up");
    }
}

async fn queue(
    state: &AppState,
    user_id: &str,
    kind: &'static str,
    device_id: Option<&str>,
    new_id: Option<&str>,
) -> ApiResult<()> {
    let notice = body(user_id, kind, device_id, new_id);

    let own = state.cfg.server_name.clone();
    let parsed = Notice {
        user_id: user_id.to_string(),
        kind: kind.to_string(),
        device_id: device_id.map(str::to_string),
        new_id: new_id.map(str::to_string),
        at: notice["at"].as_i64().unwrap_or_default(),
    };
    if let Err(e) = receive(state, &own, &parsed).await {
        tracing::debug!(target: crate::logcat::AUTH, %user_id, kind, error = %e, "local guild sessions are left to revalidation");
    }

    let mut targets: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT guild_server FROM remote_memberships \
         WHERE user_id = ? AND guild_server != ? ORDER BY guild_server LIMIT ?",
    )
    .bind(user_id)
    .bind(&own)
    .bind(MAX_FANOUT + 1)
    .fetch_all(&state.pool)
    .await?;
    if targets.len() as i64 > MAX_FANOUT {
        tracing::warn!(target: crate::logcat::AUTH, %user_id, kind, "more guild servers than one notice goes to; the rest rely on revalidation");
        targets.truncate(MAX_FANOUT as usize);
    }
    if targets.is_empty() {
        return Ok(());
    }

    let now = now_ms();
    let text = notice.to_string();
    for server in &targets {
        sqlx::query(
            "INSERT INTO identity_notices \
                 (user_id, device_id, kind, guild_server, body, attempts, next_at, created_at) \
             VALUES (?, ?, ?, ?, ?, 0, ?, ?) \
             ON CONFLICT(user_id, device_id, kind, guild_server) DO UPDATE SET \
                 body = excluded.body, attempts = 0, next_at = excluded.next_at, \
                 delivered_at = NULL, last_error = NULL",
        )
        .bind(user_id)
        .bind(device_id.unwrap_or(""))
        .bind(kind)
        .bind(server)
        .bind(&text)
        .bind(now)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }

    let state = state.clone();
    let user_id = user_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = flush_due(&state, Some(&user_id)).await {
            tracing::debug!(target: crate::logcat::AUTH, %user_id, error = %e, "immediate identity notice delivery failed; the outbox retries");
        }
    });
    Ok(())
}

pub async fn flush(state: &AppState) -> ApiResult<u64> {
    flush_due(state, None).await
}

async fn flush_due(state: &AppState, only: Option<&str>) -> ApiResult<u64> {
    let now = now_ms();
    let due: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, device_id, kind, guild_server, body, attempts FROM identity_notices \
         WHERE delivered_at IS NULL AND next_at <= ? AND attempts < ? \
           AND (? IS NULL OR user_id = ?) \
         ORDER BY next_at LIMIT 50",
    )
    .bind(now)
    .bind(MAX_ATTEMPTS)
    .bind(only)
    .bind(only)
    .fetch_all(&state.pool)
    .await?;

    let mut delivered = 0;
    for (user_id, device_id, kind, server, text, attempts) in due {
        let notice: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        let outcome = federation::post_signed(
            state,
            &server,
            &format!("/_telium/v1/users/{user_id}/revoked"),
            &notice,
        )
        .await;
        match outcome {
            Ok(_) => {
                delivered += 1;
                sqlx::query(
                    "UPDATE identity_notices SET delivered_at = ?, last_error = NULL \
                     WHERE user_id = ? AND device_id = ? AND kind = ? AND guild_server = ?",
                )
                .bind(now_ms())
                .bind(&user_id)
                .bind(&device_id)
                .bind(&kind)
                .bind(&server)
                .execute(&state.pool)
                .await?;
            }
            Err(e) => {
                let backoff = (60_000i64 << attempts.clamp(0, 8)).min(6 * 3600 * 1000);
                tracing::debug!(target: crate::logcat::AUTH, %user_id, %server, %kind, error = %e, "identity notice not delivered; backing off");
                sqlx::query(
                    "UPDATE identity_notices SET next_at = ?, attempts = attempts + 1, last_error = ? \
                     WHERE user_id = ? AND device_id = ? AND kind = ? AND guild_server = ?",
                )
                .bind(now_ms() + backoff)
                .bind(e.to_string())
                .bind(&user_id)
                .bind(&device_id)
                .bind(&kind)
                .bind(&server)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(delivered)
}

pub async fn receive(state: &AppState, origin: &str, notice: &Notice) -> ApiResult<Value> {
    if !KINDS.contains(&notice.kind.as_str()) {
        return Err(ApiError::BadRequest(format!("unknown notice kind {}", notice.kind)));
    }
    let origin = federation::normalise_origin(origin);
    if origin != state.cfg.server_name {
        if let Err(retry) =
            state.limiter.take(format!("notice:{origin}"), "identity_notice", NOTICE_BURST, NOTICE_PER_SEC)
        {
            return Err(ApiError::RateLimited(format!(
                "too many identity notices from {origin}; try again in {retry:.0}s"
            )));
        }
    }

    let Some(domain) = federation::domain_of(&notice.user_id) else {
        return Err(ApiError::BadRequest("malformed user id".into()));
    };
    let domain = federation::normalise_origin(domain);
    let home = crate::relocation::current_domain(state, &domain).await;
    if home != origin && domain != origin {
        return Err(ApiError::Forbidden(
            "only an account's home server may revoke its sessions".into(),
        ));
    }
    let homes = [origin.as_str(), domain.as_str()];

    let dropped = match notice.kind.as_str() {
        DEVICE => {
            let device = notice
                .device_id
                .as_deref()
                .filter(|d| !d.is_empty())
                .ok_or_else(|| ApiError::BadRequest("a device notice names the device".into()))?;
            drop_sessions(state, &notice.user_id, &homes, Some(device)).await?
        }
        ALL_DEVICES => drop_sessions(state, &notice.user_id, &homes, None).await?,
        DEACTIVATED | DELETED => {
            match federation::check_home(state, &notice.user_id, &origin).await? {
                Some(verdict) => federation::apply_verdict(state, &notice.user_id, &origin, &verdict).await?,
                None => drop_sessions(state, &notice.user_id, &homes, None).await?,
            }
        }
        MOVED => {
            let new_id = notice
                .new_id
                .as_deref()
                .filter(|n| !n.is_empty() && *n != notice.user_id)
                .ok_or_else(|| ApiError::BadRequest("a move notice names where to".into()))?;
            let Some(verdict) = federation::check_home(state, &notice.user_id, &origin).await? else {
                return Err(ApiError::TryAgain("the account's home could not be asked".into()));
            };
            if verdict.status != "moved" || verdict.moved_to.as_deref() != Some(new_id) {
                return Err(ApiError::TryAgain(format!(
                    "{}'s home does not say it moved to {new_id}",
                    notice.user_id
                )));
            }
            federation::apply_verdict(state, &notice.user_id, &origin, &verdict).await?
        }
        _ => unreachable!("kind was checked against KINDS"),
    };
    if dropped > 0 {
        tracing::info!(target: crate::logcat::AUTH, user_id = %notice.user_id, kind = %notice.kind, %origin, dropped, "dropped guild sessions on the home's notice");
    }
    Ok(json!({ "ok": true, "dropped": dropped }))
}

async fn drop_sessions(
    state: &AppState,
    user_id: &str,
    homes: &[&str; 2],
    device: Option<&str>,
) -> ApiResult<u64> {
    let done = sqlx::query(
        "DELETE FROM guild_sessions WHERE user_id = ? AND home_domain IN (?, ?) \
         AND (? IS NULL OR device_id = ?)",
    )
    .bind(user_id)
    .bind(homes[0])
    .bind(homes[1])
    .bind(device)
    .bind(device)
    .execute(&state.pool)
    .await?;
    state.hub.revoke(user_id, device, Some(&homes[..])).await;
    Ok(done.rows_affected())
}
