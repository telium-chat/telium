use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::{json, Value};

const RECEIPT_PATH: &str = "/_telium/v1/bots/installations/receipt";
const BATCH: i64 = 50;
const RETRY_BASE_MS: i64 = 5_000;
const RETRY_MAX_MS: i64 = 60 * 60 * 1000;

#[derive(Debug, Clone)]
struct Pending {
    application_origin: String,
    application_id: String,
    bot_user_id: String,
    remote_guild_id: String,
    active: i64,
    allowed_intents: i64,
    permissions: i64,
    queued_at: i64,
    attempts: i64,
}

impl Pending {
    fn body(&self, state: &AppState) -> Value {
        json!({
            "application_id": self.application_id,
            "bot_user_id": self.bot_user_id,
            "guild_id": self.remote_guild_id,
            "guild_domain": state.cfg.server_name,
            "active": self.active != 0,
            "allowed_intents": (self.allowed_intents as u64).to_string(),
            "permissions": (self.permissions as u64).to_string(),
        })
    }

    fn retry_delay_ms(&self) -> i64 {
        let shift = self.attempts.clamp(0, 9) as u32;
        RETRY_BASE_MS
            .saturating_mul(1_i64 << shift)
            .min(RETRY_MAX_MS)
    }
}

/// Uses `cfg.server_name`, not `signing_origin`: a promoted standby signs for the original authority.
async fn apply_local(state: &AppState, row: &Pending) -> ApiResult<()> {
    let expected_bot: Option<String> =
        sqlx::query_scalar("SELECT bot_user_id FROM bot_applications WHERE id = ?")
            .bind(&row.application_id)
            .fetch_optional(&state.pool)
            .await?;
    if expected_bot.as_deref() != Some(row.bot_user_id.as_str()) {
        return Err(ApiError::Forbidden(
            "receipt does not name this application's bot".into(),
        ));
    }

    let now = now_ms();
    let removed_at = (row.active == 0).then_some(now);
    sqlx::query(
        "INSERT INTO bot_installations \
         (application_id, bot_user_id, remote_guild_id, guild_domain, allowed_intents, \
          permissions, installed_at, removed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(application_id, guild_domain, remote_guild_id) DO UPDATE SET \
           bot_user_id = excluded.bot_user_id, allowed_intents = excluded.allowed_intents, \
           permissions = excluded.permissions, \
           installed_at = CASE \
             WHEN bot_installations.removed_at IS NOT NULL AND excluded.removed_at IS NULL \
             THEN excluded.installed_at ELSE bot_installations.installed_at END, \
           removed_at = excluded.removed_at",
    )
    .bind(&row.application_id)
    .bind(&row.bot_user_id)
    .bind(&row.remote_guild_id)
    .bind(&state.cfg.server_name)
    .bind(row.allowed_intents)
    .bind(row.permissions)
    .bind(now)
    .bind(removed_at)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn deliver_one(state: &AppState, row: &Pending) -> ApiResult<()> {
    if row.application_origin == state.cfg.server_name {
        return apply_local(state, row).await;
    }
    crate::federation::post_signed(
        state,
        &row.application_origin,
        RECEIPT_PATH,
        &row.body(state),
    )
    .await
    .map(|_| ())
}

async fn remove_if_current(state: &AppState, row: &Pending) -> ApiResult<()> {
    sqlx::query(
        "DELETE FROM bot_receipt_outbox \
         WHERE application_origin = ? AND application_id = ? AND remote_guild_id = ? \
           AND bot_user_id = ? AND active = ? AND allowed_intents = ? AND permissions = ? \
           AND queued_at = ?",
    )
    .bind(&row.application_origin)
    .bind(&row.application_id)
    .bind(&row.remote_guild_id)
    .bind(&row.bot_user_id)
    .bind(row.active)
    .bind(row.allowed_intents)
    .bind(row.permissions)
    .bind(row.queued_at)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn defer_if_current(state: &AppState, row: &Pending) -> ApiResult<()> {
    sqlx::query(
        "UPDATE bot_receipt_outbox \
         SET attempts = attempts + 1, next_attempt_at = ? \
         WHERE application_origin = ? AND application_id = ? AND remote_guild_id = ? \
           AND bot_user_id = ? AND active = ? AND allowed_intents = ? AND permissions = ? \
           AND queued_at = ?",
    )
    .bind(now_ms() + row.retry_delay_ms())
    .bind(&row.application_origin)
    .bind(&row.application_id)
    .bind(&row.remote_guild_id)
    .bind(&row.bot_user_id)
    .bind(row.active)
    .bind(row.allowed_intents)
    .bind(row.permissions)
    .bind(row.queued_at)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn delivered(
    state: &AppState,
    application_origin: &str,
    application_id: &str,
    remote_guild_id: &str,
) -> ApiResult<bool> {
    let pending: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM bot_receipt_outbox \
         WHERE application_origin = ? AND application_id = ? AND remote_guild_id = ?",
    )
    .bind(application_origin)
    .bind(application_id)
    .bind(remote_guild_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(pending.is_none())
}

pub async fn flush_due(state: &AppState) -> ApiResult<u64> {
    let rows: Vec<(String, String, String, String, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT application_origin, application_id, bot_user_id, remote_guild_id, active, \
                    allowed_intents, permissions, queued_at, attempts \
             FROM bot_receipt_outbox WHERE next_attempt_at <= ? \
             ORDER BY next_attempt_at, queued_at LIMIT ?",
    )
    .bind(now_ms())
    .bind(BATCH)
    .fetch_all(&state.pool)
    .await?;

    let mut delivered = 0;
    for (
        application_origin,
        application_id,
        bot_user_id,
        remote_guild_id,
        active,
        allowed_intents,
        permissions,
        queued_at,
        attempts,
    ) in rows
    {
        let row = Pending {
            application_origin,
            application_id,
            bot_user_id,
            remote_guild_id,
            active,
            allowed_intents,
            permissions,
            queued_at,
            attempts,
        };
        match deliver_one(state, &row).await {
            Ok(()) => {
                remove_if_current(state, &row).await?;
                delivered += 1;
            }
            Err(error) => {
                tracing::debug!(
                    target: crate::logcat::BOTS,
                    application = %row.application_id,
                    home = %row.application_origin,
                    guild = %row.remote_guild_id,
                    %error,
                    "bot installation receipt deferred"
                );
                defer_if_current(state, &row).await?;
            }
        }
    }
    Ok(delivered)
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            ticker.tick().await;
            if let Err(error) = flush_due(&state).await {
                tracing::warn!(target: crate::logcat::BOTS, %error, "bot installation receipt flush failed");
            }
        }
    });
}
