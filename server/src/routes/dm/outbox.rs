use crate::error::ApiResult;
use crate::federation;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;
use super::*;

const OUTBOX_MAX_SHIFT: i64 = 10;

pub async fn flush_outbox(state: &AppState) -> ApiResult<u64> {
    let due: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, conversation_id, destination, path, payload, attempts FROM dm_outbox \
         WHERE next_attempt_at <= ? ORDER BY created_at LIMIT 50",
    )
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;

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
                    "UPDATE dm_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?",
                )
                .bind(attempts)
                .bind(now_ms() + backoff)
                .bind(e.to_string())
                .bind(&id)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(sent)
}
