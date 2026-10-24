
use crate::state::AppState;
use rand::RngCore;
use sqlx::SqlitePool;
use std::time::Duration;

const USER_AGENT: &str = "telium-server";

pub fn spawn(state: AppState) {
    if !state.cfg.usage.report {
        tracing::info!(
            target: crate::logcat::STARTUP,
            "deployment counting is off (usage.report = false); the project will not hear from \
             this server, which is the deal you made"
        );
        return;
    }
    tokio::spawn(async move {
        let mut jitter = [0u8; 8];
        rand::rngs::OsRng.fill_bytes(&mut jitter);
        let jitter = u64::from_le_bytes(jitter) % 3600;
        tokio::time::sleep(Duration::from_secs(jitter)).await;
        loop {
            report(&state).await;
            let interval = state.cfg.usage.interval_secs.max(60) as u64;
            tokio::time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

pub fn ping_body(id: &str, users: i64) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({ "id": id, "users": users }))
        .expect("a two-field body always serialises")
}

pub async fn count_users(pool: &SqlitePool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE deactivated = 0")
        .fetch_one(pool)
        .await
}

pub async fn identity(pool: &SqlitePool) -> sqlx::Result<String> {
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM usage_identity LIMIT 1")
        .fetch_optional(pool)
        .await?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = crate::util::ulid();
    sqlx::query("INSERT INTO usage_identity (id) VALUES (?)")
        .bind(&id)
        .execute(pool)
        .await?;
    Ok(id)
}

async fn report(state: &AppState) {
    if let Err(e) = send(state).await {
        tracing::debug!(
            target: crate::logcat::TELEMETRY,
            error = %e,
            "usage report did not go out; the next attempt is tomorrow"
        );
    }
}

async fn send(state: &AppState) -> anyhow::Result<()> {
    let id = identity(&state.pool).await?;
    let users = count_users(&state.pool).await?;
    let url = crate::federation::feeds::check_url_loose(
        &state.cfg.usage.count_url,
        state.cfg.federation.allow_http,
    )?;
    crate::federation::feeds::post_json(
        state.cfg.federation.allow_http,
        url,
        ping_body(&id, users),
        Duration::from_secs(state.cfg.usage.timeout_secs.max(1)),
        USER_AGENT,
    )
    .await?;
    Ok(())
}
