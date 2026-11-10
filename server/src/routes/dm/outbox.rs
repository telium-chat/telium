use futures_util::stream::{self, StreamExt};
use crate::error::ApiResult;
use crate::federation;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;
use super::*;

const OUTBOX_MAX_SHIFT: i64 = 10;

pub async fn flush_outbox(state: &AppState) -> ApiResult<u64> {
    // A flush still attempts at most 50 due rows, oldest first -- the same
    // budget as a plain sequential pump. The rows are grouped per destination
    // and the groups fan out, so a slow or offline peer cannot block a healthy
    // one; the budget does not grow with the fan-out.
    let due: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, conversation_id, destination, path, payload, attempts FROM dm_outbox \
         WHERE next_attempt_at <= ? ORDER BY created_at, rowid LIMIT 50",
    )
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;

    // One group per destination, in first-touched (oldest) order.
    let mut groups: Vec<(String, Vec<String>)> = Vec::new();
    for (id, _, destination, _, _, _) in &due {
        match groups.iter_mut().find(|(known, _)| known == destination) {
            Some((_, ids)) => ids.push(id.clone()),
            None => groups.push((destination.clone(), vec![id.clone()])),
        }
    }

    let outcomes = stream::iter(groups.into_iter().map(|(destination, picked)| async move {
        let lock = state.dm_outbox_pump.lock_for(&destination).await;
        let _destination_guard = lock.lock().await;
        // Read only after the lock: another pump may already have sent or
        // retried these rows. Only the rows this flush picked count against
        // its budget, so re-read just those ids, still skipping rows that
        // are no longer due.
        let mut sql = format!(
            "SELECT id, conversation_id, destination, path, payload, attempts FROM dm_outbox \
             WHERE next_attempt_at <= ? AND id IN ({}) ORDER BY created_at, rowid",
            std::iter::repeat("?").take(picked.len()).collect::<Vec<_>>().join(", ")
        );
        let mut requery =
            sqlx::query_as::<_, (String, String, String, String, String, i64)>(&sql).bind(now_ms());
        for id in &picked {
            requery = requery.bind(id);
        }
        let due: Vec<(String, String, String, String, String, i64)> =
            requery.fetch_all(&state.pool).await?;

        let mut sent = 0;
        for (id, conversation_id, destination, path, payload, attempts) in due {
            let body: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            match federation::post_signed(state, &destination, &path, &body).await {
                Ok(_) => {
                    sqlx::query("DELETE FROM dm_outbox WHERE id = ?")
                        .bind(&id)
                        .execute(&state.pool)
                        .await?;
                    crate::metrics::Metrics::bump(&state.metrics.federation_deliveries, 1);
                    sent += 1;
                }
                Err(e) => {
                    crate::metrics::Metrics::bump(&state.metrics.federation_delivery_failures, 1);
                    let attempts = attempts + 1;
                    let essential = essential_delivery(&path, &body);
                    let refused = definite_refusal(&e);
                    let drop = if essential {
                        let exists: Option<i64> =
                            sqlx::query_scalar("SELECT 1 FROM conversations WHERE id = ?")
                                .bind(&conversation_id)
                                .fetch_optional(&state.pool)
                                .await?;
                        exists.is_none()
                    } else {
                        refused || attempts > 40
                    };
                    if drop {
                        tracing::warn!(
                            target: crate::logcat::SOCIAL, destination = %destination,
                            status = e.status().as_u16(), essential,
                            "dropping undeliverable dm frame"
                        );
                        sqlx::query("DELETE FROM dm_outbox WHERE id = ?")
                            .bind(&id)
                            .execute(&state.pool)
                            .await?;
                        continue;
                    }
                    let shift = if refused { OUTBOX_MAX_SHIFT } else { attempts.min(OUTBOX_MAX_SHIFT) };
                    let backoff = state.cfg.federation.dm_retry_secs as i64 * 1000 * (1i64 << shift);
                    sqlx::query(
                        // A flush that read an older attempt count must not
                        // clobber a newer retry state written meanwhile.
                        "UPDATE dm_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? \
                         WHERE id = ? AND attempts = ?",
                    )
                    .bind(attempts)
                    .bind(now_ms() + backoff)
                    .bind(e.to_string())
                    .bind(&id)
                    .bind(attempts - 1)
                    .execute(&state.pool)
                    .await?;
                }
            }
        }
        Ok::<u64, crate::error::ApiError>(sent)
    }))
    .buffer_unordered(8)
    // Complete every in-flight batch before propagating an error. Aborting a
    // successful HTTP send before its DELETE can cause an avoidable duplicate.
    .collect::<Vec<_>>()
    .await;
    outcomes.into_iter().try_fold(0u64, |sum, result| result.map(|n| sum + n))
}
