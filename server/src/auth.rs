use crate::error::{ApiError, Coded};
use crate::state::AppState;
use crate::util::{hash_token, now_ms};
use axum::extract::FromRequestParts;
use axum::http::{request::Parts, Method};

fn bearer(parts: &Parts) -> Result<String, ApiError> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::Unauthorized("missing bearer token".into()))
}

fn bot_bearer(parts: &Parts) -> Result<String, ApiError> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bot "))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::Unauthorized("missing bot token".into()))
}

#[derive(Debug, Clone)]
pub struct HomeAuth {
    pub user_id: String,
    pub device_id: String,
}

impl HomeAuth {
    pub async fn from_token(state: &AppState, token: &str) -> Result<Self, ApiError> {
        let row: Option<(String, String, i64)> = sqlx::query_as(
            "SELECT user_id, device_id, expires_at FROM home_sessions WHERE token_hash = ?",
        )
        .bind(hash_token(token))
        .fetch_optional(&state.pool)
        .await?;

        let (user_id, device_id, expires_at) =
            row.ok_or_else(|| ApiError::Unauthorized("unknown session".into()))?;
        if expires_at <= now_ms() {
            return Err(ApiError::Unauthorized("session expired".into()));
        }

        let deactivated: Option<i64> =
            sqlx::query_scalar("SELECT deactivated FROM accounts WHERE user_id = ?")
                .bind(&user_id)
                .fetch_optional(&state.pool)
                .await?;
        match deactivated {
            Some(0) => {}
            Some(_) => return Err(ApiError::Unauthorized("account deactivated".into())),
            None => return Err(ApiError::Unauthorized("account no longer exists".into())),
        }

        sqlx::query("UPDATE devices SET last_seen = ? WHERE device_id = ?")
            .bind(now_ms())
            .bind(&device_id)
            .execute(&state.pool)
            .await?;

        Ok(HomeAuth { user_id, device_id })
    }
}

impl FromRequestParts<AppState> for HomeAuth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(parts)?;
        HomeAuth::from_token(state, &token).await
    }
}

#[derive(Debug, Clone)]
pub struct BotAuth {
    pub application_id: String,
    pub user_id: String,
}

const CODE_UNKNOWN_TOKEN: &str = crate::errcodes::UNKNOWN_BOT_TOKEN;
const CODE_REVOKED: &str = crate::errcodes::BOT_CREDENTIAL_REVOKED;

impl FromRequestParts<AppState> for BotAuth {
    // `Coded` so bots can tell the two 401s apart without matching prose.
    type Rejection = Coded;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        if !state.cfg.roles.identity {
            return Err(ApiError::Forbidden("this server does not host identities".into()).into());
        }
        let token = bot_bearer(parts)?;
        let token_hash = hash_token(&token);
        let row: Option<(String, String, i64, i64)> = sqlx::query_as(
            "SELECT c.application_id, a.bot_user_id, COALESCE(c.revoked_at, 0), b.disabled \
             FROM bot_credentials c \
             JOIN bot_applications a ON a.id = c.application_id \
             JOIN bot_identities b ON b.application_id = c.application_id \
             WHERE c.token_hash = ?",
        )
        .bind(&token_hash)
        .fetch_optional(&state.pool)
        .await?;
        let (application_id, user_id, revoked_at, disabled) = row.ok_or_else(|| {
            Coded::new(
                ApiError::Unauthorized("unknown bot token".into()),
                CODE_UNKNOWN_TOKEN,
            )
        })?;
        if revoked_at != 0 || disabled != 0 {
            return Err(Coded::new(
                ApiError::Unauthorized("bot credential revoked".into()),
                CODE_REVOKED,
            ));
        }

        // Second bucket keyed by application ID: rotation can't reset it, forged headers can't mint buckets.
        // Reads and writes stay separate so the SDK's install-index polling can't starve writes.
        if state.cfg.rate_limit.enabled {
            let cfg = &state.cfg.rate_limit;
            let write = !matches!(&parts.method, &Method::GET | &Method::HEAD | &Method::OPTIONS);
            let (kind, burst, per_sec) = if write {
                ("bot-app-write", cfg.write_burst as f64, cfg.write_per_sec)
            } else {
                ("bot-app-read", cfg.read_burst as f64, cfg.read_per_sec)
            };
            if let Err(retry) =
                state.limiter.take(format!("bot-app:{application_id}"), kind, burst, per_sec)
            {
                return Err(ApiError::RateLimited(format!(
                    "slow down: try again in {retry:.0}s"
                ))
                .into());
            }
        }

        // Minute precision avoids a SQLite write on every read.
        let now = now_ms();
        sqlx::query(
            "UPDATE bot_credentials SET last_used_at = ?              WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < ?)",
        )
        .bind(now)
        .bind(token_hash)
        .bind(now - 60_000)
        .execute(&state.pool)
        .await?;
        Ok(BotAuth { application_id, user_id })
    }
}

#[derive(Debug, Clone)]
pub struct GuildAuth {
    pub user_id: String,
    pub device_id: String,
    pub home_domain: String,
    pub display_name: String,
    pub avatar_ref: Option<String>,
    pub is_bot: bool,
    pub application_id: Option<String>,
    pub bot_allowed_intents: u64,
    pub bot_session_expires_at: Option<i64>,
}

impl GuildAuth {
    pub async fn from_token(state: &AppState, token: &str) -> Result<Self, ApiError> {
        let token_hash = hash_token(token);
        let row: Option<(String, String, String, String, Option<String>, i64)> = sqlx::query_as(
            "SELECT user_id, device_id, home_domain, display_name, avatar_ref, expires_at \
             FROM guild_sessions WHERE token_hash = ?",
        )
        .bind(&token_hash)
        .fetch_optional(&state.pool)
        .await?;

        if let Some((user_id, device_id, home_domain, display_name, avatar_ref, expires_at)) = row {
            if expires_at <= now_ms() {
                return Err(ApiError::Unauthorized("guild session expired".into()));
            }
            return Ok(GuildAuth {
                user_id,
                device_id,
                home_domain,
                display_name,
                avatar_ref,
                is_bot: false,
                application_id: None,
                bot_allowed_intents: 0,
                bot_session_expires_at: None,
            });
        }

        let bot: Option<(String, String, String, String, Option<String>, i64, i64)> = sqlx::query_as(
            "SELECT user_id, application_id, home_domain, display_name, avatar_ref, \
                    allowed_intents, expires_at \
             FROM bot_guild_sessions WHERE token_hash = ?",
        )
        .bind(token_hash)
        .fetch_optional(&state.pool)
        .await?;
        let (
            user_id,
            application_id,
            home_domain,
            display_name,
            avatar_ref,
            allowed_intents,
            expires_at,
        ) = bot.ok_or_else(|| ApiError::Unauthorized("unknown guild session".into()))?;
        if expires_at <= now_ms() {
            return Err(ApiError::Unauthorized("guild session expired".into()));
        }
        Ok(GuildAuth {
            user_id,
            device_id: format!("bot:{application_id}"),
            home_domain,
            display_name,
            avatar_ref,
            is_bot: true,
            application_id: Some(application_id),
            bot_allowed_intents: allowed_intents as u64,
            bot_session_expires_at: Some(expires_at),
        })
    }
}

impl FromRequestParts<AppState> for GuildAuth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = bearer(parts)?;
        GuildAuth::from_token(state, &token).await
    }
}
