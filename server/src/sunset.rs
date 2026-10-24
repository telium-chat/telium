
use crate::auth::HomeAuth;
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::migration;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::atomic::Ordering;

pub async fn current(state: &AppState) -> Option<Value> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'sunset'")
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    raw.and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .filter(|v| v["mode"].as_str().is_some_and(|m| m != "none"))
}

async fn shutting_down(state: &AppState) -> Option<Value> {
    current(state).await.filter(|v| v["mode"] == "shutdown")
}

pub async fn registration_open(state: &AppState) -> bool {
    state.cfg.registration.open && shutting_down(state).await.is_none()
}

pub async fn login_notice(state: &AppState) -> Option<Value> {
    let mut notice = current(state).await?;
    notice["finalized"] = json!(state.shut_down.load(Ordering::Relaxed));
    Some(notice)
}

pub async fn finalized(pool: &SqlitePool) -> bool {
    sqlx::query_scalar::<_, String>("SELECT value FROM server_meta WHERE key = 'shutdown_final'")
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .is_some()
}

#[derive(Deserialize, Default)]
pub struct BundleRequest {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

pub async fn bundle(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<BundleRequest>,
) -> ApiResult<Json<Value>> {
    crate::routes::identity::verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let account = migration::export_user(&state, &auth.user_id).await?;
    let keys = crate::routes::wellknown::build_key_document(&state).await.ok();
    Ok(Json(crypto::sign_json(
        &state.key,
        json!({
            "format": "telium-account-bundle-v1",
            "user_id": auth.user_id,
            "origin": state.cfg.server_name,
            "exported_at": now_ms(),
            "sunset": current(&state).await,
            "account": account,
            "keys": keys,
        }),
    )))
}

async fn consented(
    state: &AppState,
    subject_type: &str,
    subject_id: &str,
    destination: &str,
    grant_token: &str,
    device_id: &str,
    device_sig: &str,
    created_at: i64,
) -> ApiResult<()> {
    let signer = match subject_type {
        "user" => subject_id.to_string(),
        "guild" => sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
            .bind(subject_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("the guild is gone".into()))?,
        _ => return Err(ApiError::BadRequest("unknown subject".into())),
    };
    let payload = migration::grant_payload(subject_id, destination, grant_token, created_at);
    migration::verify_device_signature(state, &signer, device_id, &payload, device_sig).await
}

pub async fn execute(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let sunset = shutting_down(&state)
        .await
        .ok_or_else(|| ApiError::Conflict("no shutdown has been announced".into()))?;
    let deadline = sunset["effective_at"].as_i64().unwrap_or(i64::MAX);

    let rows: Vec<(String, String, String, String, String, String, String, i64, i64)> =
        sqlx::query_as(
            "SELECT id, subject_type, subject_id, destination, grant_token, device_id, device_sig, \
             created_at, executes_at FROM migrations WHERE state IN ('pending', 'ready') \
             ORDER BY executes_at",
        )
        .fetch_all(&state.pool)
        .await?;

    let (mut executed, mut waiting, mut refused, mut failed) = (vec![], vec![], vec![], vec![]);
    for (id, subject_type, subject_id, destination, grant, device_id, sig, created_at, executes_at) in rows {
        let summary = json!({ "id": id, "subject_type": subject_type, "subject_id": subject_id,
                              "destination": destination });
        if let Err(e) = consented(
            &state, &subject_type, &subject_id, &destination, &grant, &device_id, &sig, created_at,
        )
        .await
        {
            tracing::warn!(target: crate::logcat::ACCOUNT, migration = %id, subject = %subject_id, error = %e,
                "migration row carries no valid consent; not running it");
            refused.push(json!({ "migration": summary, "reason": e.to_string() }));
            continue;
        }
        if executes_at > now_ms() {
            waiting.push(json!({
                "migration": summary,
                "executes_at": executes_at,
                "misses_deadline": executes_at > deadline,
            }));
            continue;
        }
        sqlx::query("UPDATE migrations SET deferred_until = 0 WHERE id = ?")
            .bind(&id)
            .execute(&state.pool)
            .await?;
        match crate::routes::migrate::run(&state, &id).await {
            Ok(result) => executed.push(json!({ "migration": summary, "result": result })),
            Err(e) => failed.push(json!({ "migration": summary, "error": e.to_string() })),
        }
    }

    crate::admin::record(
        &state,
        &auth.user_id,
        "sunset.execute",
        None,
        json!({ "executed": executed.len(), "waiting": waiting.len(),
                "refused": refused.len(), "failed": failed.len() }),
    )
    .await;
    Ok(Json(json!({
        "executed": executed,
        "waiting": waiting,
        "refused": refused,
        "failed": failed,
        "remaining_accounts": remaining_accounts(&state).await?,
    })))
}

async fn remaining_accounts(state: &AppState) -> ApiResult<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM accounts a WHERE NOT EXISTS \
         (SELECT 1 FROM tombstones t WHERE t.subject_type = 'user' AND t.subject_id = a.user_id)",
    )
    .fetch_one(&state.pool)
    .await?)
}

#[derive(Deserialize)]
pub struct FinalizeRequest {
    pub confirm: String,
    #[serde(default)]
    pub abandon_pending: bool,
}

pub async fn finalize(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<FinalizeRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let sunset = shutting_down(&state)
        .await
        .ok_or_else(|| ApiError::Conflict("no shutdown has been announced".into()))?;
    if req.confirm != state.cfg.server_name {
        return Err(ApiError::BadRequest("confirm must be this server's name".into()));
    }
    if sunset["effective_at"].as_i64().unwrap_or(i64::MAX) > now_ms() {
        return Err(ApiError::Conflict("the announced shutdown date has not arrived".into()));
    }
    let in_flight: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM migrations WHERE state IN ('pending', 'ready')")
            .fetch_one(&state.pool)
            .await?;
    if in_flight > 0 && !req.abandon_pending {
        return Err(ApiError::Conflict(format!(
            "{in_flight} move(s) are still in flight; run them first, or pass abandon_pending"
        )));
    }

    let now = now_ms();
    let origin = state.cfg.server_name.clone();
    let mut tx = state.pool.begin().await?;
    let abandoned = sqlx::query(
        "UPDATE migrations SET state = 'failed', \
         detail = 'the server shut down before this move could run' \
         WHERE state IN ('pending', 'ready')",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();

    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM accounts a WHERE NOT EXISTS \
         (SELECT 1 FROM tombstones t WHERE t.subject_type = 'user' AND t.subject_id = a.user_id)",
    )
    .fetch_all(&mut *tx)
    .await?;
    for user_id in &users {
        let record = crypto::sign_json(
            &state.key,
            json!({
                "kind": "gone", "subject_type": "user", "subject_id": user_id,
                "origin": origin, "reason": "server_shutdown", "gone_at": now,
            }),
        );
        insert_gone(&mut tx, "user", user_id, &record, now).await?;
    }

    let guilds: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, name FROM guilds g WHERE NOT EXISTS \
         (SELECT 1 FROM tombstones t WHERE t.subject_type = 'guild' AND t.subject_id = g.id)",
    )
    .fetch_all(&mut *tx)
    .await?;
    for (guild_id, name) in &guilds {
        let record = crypto::sign_json(
            &state.key,
            json!({
                "subject_type": "guild", "subject_id": guild_id, "kind": "gone",
                "name": name, "origin": origin, "reason": "server_shutdown", "deleted_at": now,
            }),
        );
        insert_gone(&mut tx, "guild", guild_id, &record, now).await?;
    }

    let domain = crypto::sign_json(
        &state.key,
        json!({
            "kind": "gone", "subject_type": "domain", "subject_id": origin,
            "origin": origin, "reason": "server_shutdown", "gone_at": now,
            "sunset": sunset,
        }),
    );
    insert_gone(&mut tx, "domain", &origin, &domain, now).await?;
    sqlx::query(
        "INSERT INTO server_meta (key, value) VALUES ('shutdown_final', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(domain.to_string())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    state.shut_down.store(true, Ordering::Relaxed);
    tracing::warn!(target: crate::logcat::ACCOUNT, users = users.len(), guilds = guilds.len(), "server shut down for good");

    crate::admin::record(
        &state,
        &auth.user_id,
        "sunset.finalize",
        Some(&origin),
        json!({ "users": users.len(), "guilds": guilds.len(), "abandoned_moves": abandoned }),
    )
    .await;
    Ok(Json(json!({
        "users": users.len(),
        "guilds": guilds.len(),
        "abandoned_moves": abandoned,
        "tombstone": domain,
    })))
}

async fn insert_gone(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    subject_type: &str,
    subject_id: &str,
    record: &Value,
    now: i64,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES (?, ?, 'gone', NULL, ?, ?) ON CONFLICT DO NOTHING",
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(record.to_string())
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

const AFTER_SHUTDOWN: &[&str] = &[
    "/_telium/v1/login",
    "/_telium/v1/login/opaque/start",
    "/_telium/v1/login/opaque/finish",
    "/_telium/v1/auth/opaque/reauth/start",
    "/_telium/v1/auth/opaque/reauth/finish",
    "/_telium/v1/account/bundle",
    "/_telium/v1/logout",
    "/_telium/v1/logout-all",
];

pub fn guard(
    state: AppState,
) -> impl Fn(
    axum::extract::Request,
    axum::middleware::Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>
       + Clone
       + Send
       + 'static {
    move |req: axum::extract::Request, next: axum::middleware::Next| {
        let state = state.clone();
        Box::pin(async move {
            let writing = !matches!(
                *req.method(),
                axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
            );
            if writing
                && state.shut_down.load(Ordering::Relaxed)
                && !AFTER_SHUTDOWN.contains(&req.uri().path())
            {
                let tombstone: Option<String> =
                    sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'shutdown_final'")
                        .fetch_optional(&state.pool)
                        .await
                        .ok()
                        .flatten();
                return (
                    axum::http::StatusCode::GONE,
                    Json(json!({
                        "error": "shut_down",
                        "code": crate::errcodes::SHUT_DOWN,
                        "message": format!("{} has shut down", state.cfg.server_name),
                        "tombstone": tombstone.and_then(|t| serde_json::from_str::<Value>(&t).ok()),
                    })),
                )
                    .into_response();
            }
            next.run(req).await
        })
    }
}
