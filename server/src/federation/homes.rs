use super::get_signed;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;

pub async fn revalidate_sessions(state: &AppState) -> ApiResult<u64> {
    let now = now_ms();
    let due: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT user_id, home_domain FROM guild_sessions \
         WHERE revalidate_at <= ? AND expires_at > ? LIMIT 200",
    )
    .bind(now)
    .bind(now)
    .fetch_all(&state.pool)
    .await?;

    let mut dropped = 0u64;
    for (user_id, home) in due {
        match check_home(state, &user_id, &home).await? {
            Some(verdict) => dropped += apply_verdict(state, &user_id, &home, &verdict).await?,
            None => {
                sqlx::query(
                    "UPDATE guild_sessions SET revalidate_at = ? WHERE user_id = ? AND home_domain = ?",
                )
                .bind(now + 60_000)
                .bind(&user_id)
                .bind(&home)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(dropped)
}

#[derive(Debug, Clone)]
pub struct Verdict {
    pub status: String,
    pub moved_to: Option<String>,
}

pub async fn check_home(state: &AppState, user_id: &str, home: &str) -> ApiResult<Option<Verdict>> {
    if home == state.cfg.server_name {
        let deactivated: Option<i64> =
            sqlx::query_scalar("SELECT deactivated FROM accounts WHERE user_id = ?")
                .bind(user_id)
                .fetch_optional(&state.pool)
                .await?;
        let moved: Option<String> = sqlx::query_scalar(
            "SELECT new_id FROM tombstones WHERE subject_type = 'user' AND subject_id = ? AND kind = 'moved'",
        )
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
        let status = match (&moved, deactivated) {
            (Some(_), _) => "moved",
            (None, Some(0)) => "active",
            (None, Some(_)) => "deactivated",
            (None, None) => "unknown",
        };
        return Ok(Some(Verdict {
            status: status.to_string(),
            moved_to: moved,
        }));
    }
    let Ok(doc) = get_signed(state, home, &format!("/_telium/v1/users/{user_id}/status")).await
    else {
        return Ok(None);
    };
    let moved_to = doc
        .get("moved_to")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(new_id) = &moved_to {
        learn_tombstone(state, "user", user_id, "moved", Some(new_id), &doc).await?;
    }
    Ok(Some(Verdict {
        status: doc
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        moved_to,
    }))
}

pub async fn apply_verdict(
    state: &AppState,
    user_id: &str,
    home: &str,
    verdict: &Verdict,
) -> ApiResult<u64> {
    if let Some(new_id) = &verdict.moved_to {
        crate::migration::apply_user_move(state, user_id, new_id).await?;
        if home != state.cfg.server_name {
            if let Err(e) =
                crate::migration::media::pull_moved_from_home(state, home, user_id).await
            {
                tracing::debug!(target: crate::logcat::FEDERATION, %user_id, %home, error = %e, "could not ask the old home which uploads moved; the redirect covers it");
            }
        }
    }

    if verdict.status == "active" {
        sqlx::query("UPDATE guild_sessions SET revalidate_at = ? WHERE user_id = ?")
            .bind(now_ms() + state.cfg.sessions.revalidate_interval_secs * 1000)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
        return Ok(0);
    }
    let done = sqlx::query("DELETE FROM guild_sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    state.hub.revoke(user_id, None, None).await;
    if done.rows_affected() > 0 {
        tracing::info!(target: crate::logcat::FEDERATION, %user_id, status = %verdict.status, "dropped guild sessions after revalidation");
    }
    Ok(done.rows_affected())
}

pub async fn learn_tombstone(
    state: &AppState,
    subject_type: &str,
    subject_id: &str,
    kind: &str,
    new_id: Option<&str>,
    record: &Value,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO remote_tombstones (subject_type, subject_id, kind, new_id, record, learned_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET kind = excluded.kind, \
             new_id = excluded.new_id, record = excluded.record, learned_at = excluded.learned_at",
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(kind)
    .bind(new_id)
    .bind(record.to_string())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn resolve_id(state: &AppState, subject_type: &str, id: &str) -> String {
    let mut current = id.to_string();
    // A cycle must not hang a request.
    for _ in 0..8 {
        let next: Option<Option<String>> = sqlx::query_scalar(
            "SELECT new_id FROM tombstones WHERE subject_type = ? AND subject_id = ? AND kind = 'moved' \
             UNION ALL \
             SELECT new_id FROM remote_tombstones WHERE subject_type = ? AND subject_id = ? AND kind = 'moved' \
             LIMIT 1",
        )
        .bind(subject_type)
        .bind(&current)
        .bind(subject_type)
        .bind(&current)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
        match next.flatten() {
            Some(new_id) if new_id != current => current = new_id,
            _ => match crate::relocation::current_id(state, &current).await {
                Some(renamed) if subject_type != "domain" && renamed != current => {
                    current = renamed
                }
                _ => break,
            },
        }
    }
    current
}
