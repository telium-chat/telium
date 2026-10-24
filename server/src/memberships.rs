
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use serde_json::{json, Value};
use sqlx::{Sqlite, Transaction};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub guild_server: String,
    pub guild_id: String,
    pub joined_at: i64,
    pub proof: Option<Value>,
    pub reported_by: String,
}

impl Membership {
    pub fn to_json(&self) -> Value {
        json!({
            "guild_server": self.guild_server,
            "guild_id": self.guild_id,
            "joined_at": self.joined_at,
            "proof": self.proof,
            "reported_by": self.reported_by,
        })
    }

    pub fn from_json(value: &Value) -> Option<Self> {
        let guild_server = value.get("guild_server").and_then(Value::as_str)?;
        let guild_id = value.get("guild_id").and_then(Value::as_str)?;
        if guild_server.is_empty() || guild_id.is_empty() {
            return None;
        }
        let reported_by = value
            .get("reported_by")
            .and_then(Value::as_str)
            .filter(|r| *r == "guild" || *r == "client")
            .unwrap_or("client");
        Some(Membership {
            guild_server: guild_server.to_string(),
            guild_id: guild_id.to_string(),
            joined_at: value.get("joined_at").and_then(Value::as_i64).unwrap_or_else(now_ms),
            proof: value.get("proof").filter(|p| p.is_object()).cloned(),
            reported_by: reported_by.to_string(),
        })
    }
}

pub fn notice(state: &AppState, action: &str, user_id: &str, guild_id: &str) -> Value {
    crate::crypto::sign_json(
        &state.key,
        json!({
            "kind": "membership",
            "action": action,
            "user_id": user_id,
            "guild_id": guild_id,
            "guild_server": state.cfg.server_name,
            "at": now_ms(),
        }),
    )
}

pub fn notify_home(state: &AppState, user_id: &str, guild_id: &str, action: &'static str) {
    let Some(home) = federation::domain_of(user_id).map(str::to_string) else {
        return;
    };
    if home == state.cfg.server_name || !state.cfg.federation.enabled {
        return;
    }
    let state = state.clone();
    let user_id = user_id.to_string();
    let guild_id = guild_id.to_string();
    tokio::spawn(async move {
        let body = notice(&state, action, &user_id, &guild_id);
        let path = format!("/_telium/v1/users/{user_id}/memberships");
        if let Err(e) = federation::post_signed(&state, &home, &path, &body).await {
            tracing::warn!(target: crate::logcat::FEDERATION, %user_id, %guild_id, %home, error = %e,
                "could not tell the member's home about a membership change");
        }
    });
}

pub async fn record_notice(state: &AppState, origin: &str, user_id: &str, notice: &Value) -> ApiResult<()> {
    if !federation::is_local(state, user_id) {
        return Err(ApiError::NotFound("not this server's account".into()));
    }
    let guild_server = notice.get("guild_server").and_then(Value::as_str).unwrap_or_default();
    if guild_server != origin {
        return Err(ApiError::Forbidden("a membership notice must come from the guild server it names".into()));
    }
    if notice.get("user_id").and_then(Value::as_str) != Some(user_id) {
        return Err(ApiError::BadRequest("notice names a different user".into()));
    }
    let guild_id = notice
        .get("guild_id")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty())
        .ok_or_else(|| ApiError::BadRequest("notice names no guild".into()))?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM accounts WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("no such account".into()));
    }
    let now = now_ms();
    match notice.get("action").and_then(Value::as_str) {
        Some("joined") => {
            let joined_at = notice.get("at").and_then(Value::as_i64).unwrap_or(now);
            sqlx::query(
                "INSERT INTO remote_memberships (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
                 VALUES (?, ?, ?, ?, ?, 'guild', ?) \
                 ON CONFLICT(user_id, guild_server, guild_id) DO UPDATE SET \
                     joined_at = excluded.joined_at, proof = excluded.proof, \
                     reported_by = 'guild', updated_at = excluded.updated_at",
            )
            .bind(user_id)
            .bind(guild_server)
            .bind(guild_id)
            .bind(joined_at)
            .bind(notice.to_string())
            .bind(now)
            .execute(&state.pool)
            .await?;
        }
        Some("left") => {
            sqlx::query(
                "DELETE FROM remote_memberships WHERE user_id = ? AND guild_server = ? AND guild_id = ?",
            )
            .bind(user_id)
            .bind(guild_server)
            .bind(guild_id)
            .execute(&state.pool)
            .await?;
        }
        _ => return Err(ApiError::BadRequest("action must be joined or left".into())),
    }
    Ok(())
}

pub async fn reconcile_from_client(
    state: &AppState,
    user_id: &str,
    guild_server: &str,
    guild_ids: &[String],
) -> ApiResult<()> {
    if guild_server == state.cfg.server_name {
        return Ok(());
    }
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let known: Vec<(String, String)> = sqlx::query_as(
        "SELECT guild_id, reported_by FROM remote_memberships WHERE user_id = ? AND guild_server = ?",
    )
    .bind(user_id)
    .bind(guild_server)
    .fetch_all(&mut *tx)
    .await?;
    for (guild_id, reported_by) in &known {
        if reported_by == "client" && !guild_ids.contains(guild_id) {
            sqlx::query(
                "DELETE FROM remote_memberships WHERE user_id = ? AND guild_server = ? AND guild_id = ?",
            )
            .bind(user_id)
            .bind(guild_server)
            .bind(guild_id)
            .execute(&mut *tx)
            .await?;
        }
    }
    for guild_id in guild_ids {
        if known.iter().any(|(g, _)| g == guild_id) {
            continue;
        }
        sqlx::query(
            "INSERT INTO remote_memberships (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
             VALUES (?, ?, ?, ?, NULL, 'client', ?) ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(guild_server)
        .bind(guild_id)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn export(state: &AppState, user_id: &str) -> ApiResult<Vec<Value>> {
    let remote: Vec<(String, String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT guild_server, guild_id, joined_at, proof, reported_by FROM remote_memberships \
         WHERE user_id = ? ORDER BY guild_server, guild_id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut out: Vec<Value> = remote
        .into_iter()
        .map(|(guild_server, guild_id, joined_at, proof, reported_by)| {
            Membership {
                guild_server,
                guild_id,
                joined_at,
                proof: proof.and_then(|p| serde_json::from_str(&p).ok()),
                reported_by,
            }
            .to_json()
        })
        .collect();
    let local: Vec<(String, i64)> =
        sqlx::query_as("SELECT guild_id, joined_at FROM members WHERE user_id = ? AND banned = 0 ORDER BY guild_id")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    for (guild_id, joined_at) in local {
        out.push(
            Membership {
                guild_server: state.cfg.server_name.clone(),
                guild_id,
                joined_at,
                proof: None,
                reported_by: "guild".into(),
            }
            .to_json(),
        );
    }
    Ok(out)
}

pub async fn land(
    tx: &mut Transaction<'_, Sqlite>,
    bundle: &Value,
    target_id: &str,
    old_id: &str,
    source: &str,
    now: i64,
) -> ApiResult<usize> {
    let Some(entries) = bundle.get("remote_memberships").and_then(Value::as_array) else {
        return Ok(0);
    };
    let mut servers: Vec<String> = Vec::new();
    let mut landed = 0usize;
    for entry in entries {
        let Some(m) = Membership::from_json(entry) else {
            tracing::warn!(target: crate::logcat::FEDERATION, %target_id, "skipping a remote membership entry that names no guild or server");
            continue;
        };
        sqlx::query(
            "INSERT INTO remote_memberships (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(user_id, guild_server, guild_id) DO UPDATE SET \
                 joined_at = excluded.joined_at, proof = excluded.proof, \
                 reported_by = excluded.reported_by, updated_at = excluded.updated_at",
        )
        .bind(target_id)
        .bind(&m.guild_server)
        .bind(&m.guild_id)
        .bind(m.joined_at)
        .bind(m.proof.as_ref().map(Value::to_string))
        .bind(&m.reported_by)
        .bind(now)
        .execute(&mut **tx)
        .await?;
        landed += 1;
        if !servers.contains(&m.guild_server) {
            servers.push(m.guild_server.clone());
        }
    }
    if bundle.get("memberships").and_then(Value::as_array).is_some_and(|m| !m.is_empty())
        && !servers.iter().any(|s| s == source)
    {
        servers.push(source.to_string());
    }
    for guild_server in servers {
        sqlx::query(
            "INSERT INTO membership_moves (id, user_id, old_id, guild_server, state, attempts, \
             next_attempt_at, last_error, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, ?) \
             ON CONFLICT(user_id, guild_server) DO UPDATE SET old_id = excluded.old_id, \
                 state = 'pending', attempts = 0, next_attempt_at = excluded.next_attempt_at, \
                 last_error = NULL, completed_at = NULL",
        )
        .bind(ulid())
        .bind(target_id)
        .bind(old_id)
        .bind(guild_server)
        .bind(now + FIRST_ATTEMPT_DELAY_MS)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(landed)
}

pub const FIRST_ATTEMPT_DELAY_MS: i64 = 30_000;
pub const MAX_ATTEMPTS: i64 = 40;

fn backoff_ms(attempts: i64) -> i64 {
    let step = 30_000i64.saturating_mul(1i64 << attempts.clamp(0, 20));
    step.min(60 * 60 * 1000)
}

pub async fn old_home_says_moved(state: &AppState, old_id: &str, new_id: &str) -> ApiResult<Option<Value>> {
    let Some(old_home) = federation::domain_of(old_id) else {
        return Err(ApiError::BadRequest("malformed old id".into()));
    };
    if old_home == state.cfg.server_name {
        let row: Option<(String, String)> = sqlx::query_as(
            "SELECT new_id, record FROM tombstones WHERE subject_type = 'user' AND subject_id = ? AND kind = 'moved'",
        )
        .bind(old_id)
        .fetch_optional(&state.pool)
        .await?;
        return Ok(match row {
            Some((to, record)) if to == new_id => {
                Some(serde_json::from_str(&record).unwrap_or(Value::Null))
            }
            _ => None,
        });
    }
    let doc = federation::get_signed(state, old_home, &format!("/_telium/v1/users/{old_id}/status")).await?;
    let key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest(format!("{old_home} returned an unsigned status")))?;
    let public = federation::verify_key(state, old_home, key_id)
        .await
        .ok_or_else(|| ApiError::BadRequest(format!("{old_home} signed with an unpublished key")))?;
    if !crate::crypto::verify_json(&public, &doc) {
        return Err(ApiError::BadRequest(format!("{old_home} returned a bad signature")));
    }
    Ok(match (doc.get("status").and_then(Value::as_str), doc.get("moved_to").and_then(Value::as_str)) {
        (Some("moved"), Some(to)) if to == new_id => Some(doc),
        _ => None,
    })
}

pub async fn apply_move_notice(state: &AppState, origin: &str, old_id: &str, new_id: &str) -> ApiResult<Value> {
    if federation::domain_of(new_id) != Some(origin) {
        return Err(ApiError::Forbidden("a server may only claim a move to itself".into()));
    }
    if old_id == new_id {
        return Err(ApiError::BadRequest("that is not a move".into()));
    }
    let Some(record) = old_home_says_moved(state, old_id, new_id).await? else {
        return Err(ApiError::TryAgain(format!("{old_id}'s home does not yet say it moved to {new_id}")));
    };
    if !federation::is_local(state, old_id) {
        federation::learn_tombstone(state, "user", old_id, "moved", Some(new_id), &record).await?;
    }
    let guilds: Vec<String> = sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ?")
        .bind(old_id)
        .fetch_all(&state.pool)
        .await?;
    let moved = crate::migration::apply_user_move(state, old_id, new_id).await?;
    Ok(json!({ "old_id": old_id, "new_id": new_id, "moved": moved, "guild_ids": guilds }))
}

pub async fn run_due(state: &AppState) -> ApiResult<u64> {
    let now = now_ms();
    let due: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, user_id, old_id, guild_server, attempts FROM membership_moves \
         WHERE state = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;
    let mut done = 0u64;
    for (id, user_id, old_id, guild_server, attempts) in due {
        let outcome = if guild_server == state.cfg.server_name {
            apply_move_notice(state, &state.cfg.server_name, &old_id, &user_id).await
        } else {
            match old_home_says_moved(state, &old_id, &user_id).await {
                Ok(Some(_)) => {
                    federation::post_signed(
                        state,
                        &guild_server,
                        &format!("/_telium/v1/users/{old_id}/moved"),
                        &json!({ "old_id": old_id, "new_id": user_id }),
                    )
                    .await
                }
                Ok(None) => Err(ApiError::TryAgain(format!(
                    "{old_id}'s home does not yet say it moved here"
                ))),
                Err(e) => Err(e),
            }
        };
        match outcome {
            Ok(_) => {
                sqlx::query(
                    "UPDATE membership_moves SET state = 'done', completed_at = ?, last_error = NULL, \
                     attempts = attempts + 1 WHERE id = ?",
                )
                .bind(now_ms())
                .bind(&id)
                .execute(&state.pool)
                .await?;
                done += 1;
            }
            Err(e) => {
                let attempts = attempts + 1;
                let state_now = if attempts >= MAX_ATTEMPTS { "failed" } else { "pending" };
                sqlx::query(
                    "UPDATE membership_moves SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ? \
                     WHERE id = ?",
                )
                .bind(state_now)
                .bind(attempts)
                .bind(now_ms() + backoff_ms(attempts))
                .bind(format!("{e}"))
                .bind(&id)
                .execute(&state.pool)
                .await?;
                tracing::warn!(target: crate::logcat::FEDERATION, %user_id, %guild_server, attempts, error = %e,
                    "membership move not yet re-established");
            }
        }
    }
    Ok(done)
}

pub async fn status(state: &AppState, user_id: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, String, i64, i64, Option<String>, i64, Option<i64>)> = sqlx::query_as(
        "SELECT id, old_id, guild_server, state, attempts, next_attempt_at, last_error, created_at, completed_at \
         FROM membership_moves WHERE user_id = ? ORDER BY created_at, guild_server",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, old_id, guild_server, st, attempts, next_attempt_at, last_error, created_at, completed_at) in rows {
        let guilds: Vec<String> = sqlx::query_scalar(
            "SELECT guild_id FROM remote_memberships WHERE user_id = ? AND guild_server = ? ORDER BY guild_id",
        )
        .bind(user_id)
        .bind(&guild_server)
        .fetch_all(&state.pool)
        .await?;
        out.push(json!({
            "id": id, "old_id": old_id, "guild_server": guild_server, "state": st,
            "attempts": attempts, "next_attempt_at": next_attempt_at, "last_error": last_error,
            "created_at": created_at, "completed_at": completed_at, "guild_ids": guilds,
        }));
    }
    Ok(out)
}

pub async fn retry_failed(state: &AppState, user_id: &str) -> ApiResult<u64> {
    let done = sqlx::query(
        "UPDATE membership_moves SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL \
         WHERE user_id = ? AND state = 'failed'",
    )
    .bind(now_ms())
    .bind(user_id)
    .execute(&state.pool)
    .await?;
    Ok(done.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps_at_an_hour() {
        assert_eq!(backoff_ms(0), 30_000);
        assert_eq!(backoff_ms(1), 60_000);
        assert_eq!(backoff_ms(2), 120_000);
        assert_eq!(backoff_ms(7), 3_600_000);
        assert_eq!(backoff_ms(40), 3_600_000);
    }

    #[test]
    fn an_entry_without_a_guild_is_not_a_membership() {
        assert!(Membership::from_json(&json!({ "guild_server": "g.example" })).is_none());
        assert!(Membership::from_json(&json!({ "guild_id": "x", "guild_server": "" })).is_none());
        let m = Membership::from_json(&json!({ "guild_id": "x", "guild_server": "g.example", "reported_by": "bogus" }))
            .unwrap();
        assert_eq!(m.reported_by, "client");
    }
}
