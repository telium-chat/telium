use futures_util::stream::{self, StreamExt};
use crate::error::ApiResult;
use crate::federation;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;
use super::*;

const OUTBOX_MAX_SHIFT: i64 = 10;

pub async fn flush_outbox(state: &AppState) -> ApiResult<u64> {
    // One batch per destination. A slow or offline peer must not block a healthy one.
    let destinations: Vec<String> = sqlx::query_scalar(
        "SELECT destination FROM dm_outbox WHERE next_attempt_at <= ? \
         GROUP BY destination ORDER BY MIN(created_at), destination LIMIT 50",
    )
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;

    let outcomes = stream::iter(destinations.into_iter().map(|destination| async move {
        let lock = state.dm_outbox_pump.lock_for(&destination).await;
        let _destination_guard = lock.lock().await;
        // Read only after the lock: another pump may already have sent or retried the row.
        let due: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
            "SELECT id, conversation_id, destination, path, payload, attempts FROM dm_outbox \
                 WHERE destination = ? AND next_attempt_at <= ? ORDER BY created_at, rowid LIMIT 50",
        )
        .bind(&destination)
        .bind(now_ms())
        .fetch_all(&state.pool)
        .await?;

        let mut sent = 0;
        for (id, conversation_id, destination, path, payload, attempts) in due {
            let body: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            // One permit per HTTP attempt, not per 50-row batch. Slow peers
            // must yield network slots between retries for other destinations.
            let outcome = {
                let _slot = state.dm_outbox_pump.permit().await;
                federation::post_signed(state, &destination, &path, &body).await
            };
            match outcome {
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
                        // A background delivery may have read an older attempt count
                        // while another flush (or an operator) updated this row.
                        // Never clobber a newer retry state with stale information.
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
    .buffer_unordered(50)
    // Complete every in-flight batch before propagating an error. Aborting a
    // successful HTTP send before its DELETE can cause an avoidable duplicate.
    .collect::<Vec<_>>()
    .await;
    outcomes.into_iter().try_fold(0u64, |sum, result| result.map(|n| sum + n))
}
