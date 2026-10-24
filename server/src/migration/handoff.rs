
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token, split_user_id, ulid};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const HANDOFF_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Clone, Deserialize, Serialize)]
pub struct Delivery {
    pub handoff_id: String,
    pub secret: String,
    #[serde(default = "user_kind")]
    pub subject_type: String,
    pub source_id: String,
    pub target_id: String,
    pub import_token: String,
    #[serde(default)]
    pub claim_expires_at: Option<i64>,
}

impl std::fmt::Debug for Delivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Ids are logged for tracing; the two capabilities are not.
        f.debug_struct("Delivery")
            .field("handoff_id", &self.handoff_id)
            .field("secret", &"<redacted>")
            .field("subject_type", &self.subject_type)
            .field("source_id", &self.source_id)
            .field("target_id", &self.target_id)
            .field("import_token", &"<redacted>")
            .field("claim_expires_at", &self.claim_expires_at)
            .finish()
    }
}

fn user_kind() -> String {
    "user".to_string()
}

fn plausible_server_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

pub fn plausible_guild_id(id: &str) -> bool {
    (10..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric())
}

pub async fn open(
    state: &AppState,
    user_id: &str,
    subject_type: &str,
    subject_id: &str,
    destination: &str,
) -> ApiResult<Value> {
    match subject_type {
        "user" if subject_id == user_id => {}
        "guild" if plausible_guild_id(subject_id) => {}
        _ => return Err(ApiError::BadRequest("a handoff moves your account or a guild you own".into())),
    }
    let destination = federation::normalise_origin(destination);
    if !plausible_server_name(&destination) {
        return Err(ApiError::BadRequest("destination must be a server name".into()));
    }
    if destination == state.cfg.server_name {
        return Err(ApiError::BadRequest("that is already this server".into()));
    }
    federation::ensure_reachable(state, &destination, "identity").await?;

    let id = ulid();
    let secret = random_token(24);
    let now = now_ms();
    let expires_at = now + HANDOFF_TTL_MS;
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "DELETE FROM migration_handoffs WHERE subject_type = ? AND subject_id = ? AND consumed_at IS NULL",
    )
    .bind(subject_type)
    .bind(subject_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO migration_handoffs (id, user_id, subject_type, subject_id, destination, \
         secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(&destination)
    .bind(hash_token(&secret))
    .bind(now)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(json!({
        "id": id,
        // Returned once, stored only by hash; goes in the link fragment, which browsers do not send.
        "secret": secret,
        "source": state.cfg.server_name,
        "subject_type": subject_type,
        "source_id": subject_id,
        "destination": destination,
        "expires_at": expires_at,
    }))
}

pub async fn status(state: &AppState, user_id: &str, id: &str) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, i64, Option<i64>, Option<String>, Option<i64>, Option<String>)> =
        sqlx::query_as(
            "SELECT subject_type, subject_id, destination, expires_at, delivered_at, target_id, \
             consumed_at, migration_id FROM migration_handoffs WHERE id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let (subject_type, subject_id, destination, expires_at, delivered_at, target_id, consumed_at, migration_id) =
        row.ok_or_else(|| ApiError::NotFound("no such handoff".into()))?;
    let st = if consumed_at.is_some() {
        "used"
    } else if expires_at <= now_ms() {
        "expired"
    } else if delivered_at.is_some() {
        "delivered"
    } else {
        "waiting"
    };
    Ok(json!({
        "id": id,
        "state": st,
        "subject_type": subject_type,
        "subject_id": subject_id,
        "destination": destination,
        "target_id": target_id,
        "expires_at": expires_at,
        "delivered_at": delivered_at,
        "migration_id": migration_id,
    }))
}

pub async fn deliver(state: &AppState, origin: &str, d: &Delivery) -> ApiResult<()> {
    if d.import_token.is_empty() || d.import_token.len() > 256 || d.secret.len() > 256 {
        return Err(ApiError::BadRequest("that delivery is not well formed".into()));
    }
    // One answer for every failure, so handoffs cannot be enumerated.
    let row: Option<(String, String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT user_id, subject_type, subject_id, expires_at, delivered_at FROM migration_handoffs \
         WHERE id = ? AND secret_hash = ? AND destination = ? AND consumed_at IS NULL",
    )
    .bind(&d.handoff_id)
    .bind(hash_token(&d.secret))
    .bind(origin)
    .fetch_optional(&state.pool)
    .await?;
    let (user_id, subject_type, subject_id, expires_at, delivered_at) =
        row.ok_or_else(|| ApiError::NotFound("no handoff matches".into()))?;
    if delivered_at.is_some() {
        return Err(ApiError::Conflict("that handoff has already been delivered".into()));
    }
    if expires_at <= now_ms() {
        return Err(ApiError::Conflict("that handoff has expired".into()));
    }
    if d.subject_type != subject_type {
        return Err(ApiError::Forbidden(format!("that handoff moves a {}", noun(&subject_type))));
    }
    if d.source_id != subject_id {
        return Err(ApiError::Forbidden(format!("that handoff is for a different {}", noun(&subject_type))));
    }
    match split_user_id(&d.target_id) {
        Some((_, domain)) if federation::normalise_origin(domain) == origin => {}
        _ => {
            return Err(ApiError::Forbidden(
                "a destination may only name one of its own accounts".into(),
            ))
        }
    }

    let now = now_ms();
    let done = sqlx::query(
        "UPDATE migration_handoffs SET delivered_at = ?, import_token = ?, target_id = ?, \
         claim_expires_at = ?, expires_at = ? \
         WHERE id = ? AND delivered_at IS NULL AND consumed_at IS NULL",
    )
    .bind(now)
    .bind(&d.import_token)
    .bind(&d.target_id)
    .bind(d.claim_expires_at)
    .bind(now + HANDOFF_TTL_MS)
    .bind(&d.handoff_id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() != 1 {
        return Err(ApiError::Conflict("that handoff has already been delivered".into()));
    }
    tracing::info!(
        target: crate::logcat::MIGRATION,
        handoff = d.handoff_id,
        user = user_id,
        subject_type,
        subject = subject_id,
        target = d.target_id,
        origin,
        "migration handoff delivered"
    );
    Ok(())
}

pub async fn claim(
    state: &AppState,
    user_id: &str,
    subject_type: &str,
    subject_id: &str,
    id: &str,
) -> ApiResult<(String, String, String)> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, i64, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "SELECT subject_type, subject_id, destination, expires_at, import_token, target_id, \
             consumed_at FROM migration_handoffs WHERE id = ? AND user_id = ?",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let (kind, subject, destination, expires_at, token, target, consumed_at) =
        row.ok_or_else(|| ApiError::NotFound("no such handoff".into()))?;
    if kind != subject_type || subject != subject_id {
        return Err(ApiError::Forbidden(format!("that handoff is for a different {}", noun(&kind))));
    }
    if consumed_at.is_some() {
        return Err(ApiError::Conflict("that handoff has already been used".into()));
    }
    if expires_at <= now_ms() {
        return Err(ApiError::Conflict("that handoff has expired; start again".into()));
    }
    match (token, target) {
        (Some(token), Some(target)) => Ok((token, destination, target)),
        _ => Err(ApiError::Conflict(
            "the destination has not confirmed this move yet".into(),
        )),
    }
}

pub async fn consume(
    conn: &mut sqlx::SqliteConnection,
    user_id: &str,
    subject_type: &str,
    subject_id: &str,
    id: &str,
    migration_id: &str,
) -> ApiResult<()> {
    let done = sqlx::query(
        "UPDATE migration_handoffs SET consumed_at = ?, migration_id = ? \
         WHERE id = ? AND user_id = ? AND subject_type = ? AND subject_id = ? \
         AND consumed_at IS NULL AND delivered_at IS NOT NULL AND expires_at > ?",
    )
    .bind(now_ms())
    .bind(migration_id)
    .bind(id)
    .bind(user_id)
    .bind(subject_type)
    .bind(subject_id)
    .bind(now_ms())
    .execute(&mut *conn)
    .await?;
    if done.rows_affected() != 1 {
        return Err(ApiError::Conflict("that handoff has already been used".into()));
    }
    Ok(())
}

pub async fn send(
    state: &AppState,
    source: &str,
    delivery: &Delivery,
) -> ApiResult<()> {
    let body = serde_json::to_value(delivery).map_err(|e| ApiError::Internal(e.into()))?;
    let sent =
        federation::post_signed(state, source, "/_telium/v1/migrate/handoff/deliver", &body).await;
    if let Err(e) = sent {
        sqlx::query("DELETE FROM import_claims WHERE token_hash = ? AND used_at IS NULL")
            .bind(hash_token(&delivery.import_token))
            .execute(&state.pool)
            .await?;
        return Err(e);
    }
    Ok(())
}

fn noun(subject_type: &str) -> &'static str {
    if subject_type == "guild" {
        "guild"
    } else {
        "account"
    }
}

pub async fn sweep(state: &AppState) -> anyhow::Result<u64> {
    Ok(sqlx::query("DELETE FROM migration_handoffs WHERE expires_at < ?")
        .bind(now_ms() - 24 * 3600 * 1000)
        .execute(&state.pool)
        .await?
        .rows_affected())
}
