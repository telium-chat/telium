
use crate::admin::require_admin;
use crate::auth::HomeAuth;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

pub async fn get(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let now = now_ms();

    let authority = crate::promotion::authority(&state).await?.map(|a| {
        json!({ "domain": a.domain, "sequence": a.sequence, "record": a.record })
    });

    let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM repl_log")
        .fetch_one(&state.pool)
        .await
        .unwrap_or(0);

    let mut standbys = Vec::new();
    for domain in &state.cfg.failover.standbys {
        let ack: Option<(i64, i64)> =
            sqlx::query_as("SELECT seq, at FROM repl_ack WHERE standby = ?")
                .bind(domain)
                .fetch_optional(&state.pool)
                .await?;
        let authorised: Option<i64> = sqlx::query_scalar(
            "SELECT sequence FROM failover WHERE subject_type = ? AND subject_id = ? \
             AND standby = ?",
        )
        .bind(crate::promotion::SUBJECT)
        .bind(&state.cfg.server_name)
        .bind(domain)
        .fetch_optional(&state.pool)
        .await?;

        standbys.push(json!({
            "domain": domain,
            "paired": authorised.is_some(),
            "authorized_sequence": authorised,
            "acked_sequence": ack.map(|(seq, _)| seq),
            "last_ack_at": ack.map(|(_, at)| at),
            "silent_ms": ack.map(|(_, at)| (now - at).max(0)),
            "behind_entries": ack.map(|(seq, _)| (head - seq).max(0)),
        }));
    }

    let mirror_rows: Vec<(String, i64, Option<i64>, Option<i64>, Option<i64>, i64, Option<String>)> =
        sqlx::query_as(
            "SELECT origin, cursor, snapshot_at, applied_at, lag_at, promoted, last_error \
             FROM replica_state ORDER BY origin",
        )
        .fetch_all(&state.pool)
        .await?;
    let stale_after_ms = state.cfg.failover.stale_after_secs.max(1) * 1000;
    let mirrors: Vec<Value> = mirror_rows
        .into_iter()
        .map(|(origin, cursor, snapshot_at, applied_at, lag_at, promoted, last_error)| {
            let behind_ms = if promoted != 0 {
                None
            } else {
                applied_at.filter(|at| *at > 0).map(|at| (now - at).max(0))
            };
            json!({
                "origin": origin,
                "cursor": cursor,
                "snapshot_at": snapshot_at,
                "applied_at": applied_at,
                "lag_at": lag_at,
                "promoted": promoted != 0,
                "behind_ms": behind_ms,
                "stale": behind_ms.map(|b| b > stale_after_ms).unwrap_or(false),
                "last_error": last_error,
            })
        })
        .collect();

    let tombstones: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT subject_type, kind, COUNT(*) FROM tombstones GROUP BY subject_type, kind",
    )
    .fetch_all(&state.pool)
    .await?;

    let accounts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM accounts WHERE domain = ? AND deleted_at IS NULL",
    )
    .bind(&state.cfg.server_name)
    .fetch_one(&state.pool)
    .await?;
    let guilds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&state.pool)
        .await?;

    Ok(Json(json!({
        "server_name": state.cfg.server_name,
        "signing_origin": state.signing_origin.as_str(),
        "read_only": state.demoted.load(std::sync::atomic::Ordering::Relaxed),
        "shut_down": state.shut_down.load(std::sync::atomic::Ordering::Relaxed),
        "authority": authority,
        "sunset": crate::sunset::current(&state).await,
        "registration_open": crate::sunset::registration_open(&state).await,
        "log_head": head,
        "standbys": standbys,
        "mirrors": mirrors,
        "replicating": state.cfg.failover.replicate,
        "tombstones": tombstones.iter()
            .map(|(subject, kind, n)| json!({ "subject": subject, "kind": kind, "count": n }))
            .collect::<Vec<_>>(),
        "accounts": accounts,
        "guilds": guilds,
    })))
}
