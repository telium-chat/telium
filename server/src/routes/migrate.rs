
use crate::auth::HomeAuth;
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::migration;
use crate::state::AppState;
use crate::util::{hash_token, now_ms, ulid};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct AcceptRequest {
    #[serde(default = "user_kind")]
    pub subject_type: String,
    pub source: String,
    pub source_id: String,
    #[serde(default)]
    pub handoff: Option<HandoffRef>,
}

#[derive(Deserialize)]
pub struct HandoffRef {
    pub id: String,
    pub secret: String,
}

fn user_kind() -> String {
    "user".to_string()
}

pub async fn accept(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<AcceptRequest>,
) -> ApiResult<Json<Value>> {
    if req.subject_type != "user" && req.subject_type != "guild" {
        return Err(ApiError::BadRequest("subject_type must be user or guild".into()));
    }
    if req.subject_type == "guild" && !state.cfg.roles.guild {
        return Err(ApiError::BadRequest("this server does not host guilds".into()));
    }
    federation::ensure_reachable(&state, &req.source, "identity").await?;

    let source = federation::normalise_origin(&req.source);

    if let Some(handoff) = &req.handoff {
        if source == state.cfg.server_name {
            return Err(ApiError::BadRequest("that is already on this server".into()));
        }
        match req.subject_type.as_str() {
            "user" => match crate::util::split_user_id(&req.source_id) {
                Some((_, domain)) if federation::normalise_origin(domain) == source => {}
                _ => {
                    return Err(ApiError::BadRequest(
                        "source_id is not an account on that server".into(),
                    ))
                }
            },
            _ => {
                if !migration::handoff::plausible_guild_id(&req.source_id) {
                    return Err(ApiError::BadRequest("source_id is not a guild id".into()));
                }
            }
        }
        let (token, expires_at) = migration::create_claim(
            &state,
            &req.subject_type,
            &source,
            &req.source_id,
            &auth.user_id,
        )
        .await?;
        let delivery = migration::handoff::Delivery {
            handoff_id: handoff.id.clone(),
            secret: handoff.secret.clone(),
            subject_type: req.subject_type.clone(),
            source_id: req.source_id.clone(),
            target_id: auth.user_id.clone(),
            import_token: token,
            claim_expires_at: Some(expires_at),
        };
        migration::handoff::send(&state, &source, &delivery).await?;
        return Ok(Json(json!({
            "delivered": true,
            "expires_at": expires_at,
            "destination": state.cfg.server_name,
            "target_id": auth.user_id,
            "subject_type": req.subject_type,
            "source": source,
            "source_id": req.source_id,
        })));
    }

    let (token, expires_at) =
        migration::create_claim(&state, &req.subject_type, &source, &req.source_id, &auth.user_id)
            .await?;
    Ok(Json(json!({
        "import_token": token,
        "expires_at": expires_at,
        "destination": state.cfg.server_name,
        "target_id": auth.user_id,
        "subject_type": req.subject_type,
        "source_id": req.source_id,
    })))
}

#[derive(Deserialize)]
pub struct StartRequest {
    #[serde(default = "user_kind")]
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub destination: String,
    #[serde(default)]
    pub import_token: String,
    #[serde(default)]
    pub handoff_id: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
    pub device_signature: String,
    pub created_at: i64,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RetryRequest {
    #[serde(default)]
    pub import_token: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
    #[serde(default)]
    pub device_signature: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
}

#[derive(Deserialize)]
pub struct GrantPayloadRequest {
    #[serde(default = "user_kind")]
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub destination: String,
    #[serde(default)]
    pub import_token: String,
    #[serde(default)]
    pub handoff_id: Option<String>,
}

async fn claim_for(
    state: &AppState,
    user_id: &str,
    subject_type: &str,
    subject_id: &str,
    destination: &str,
    import_token: &str,
    handoff_id: Option<&str>,
) -> ApiResult<(String, String, Option<String>)> {
    let Some(handoff_id) = handoff_id else {
        if import_token.is_empty() {
            return Err(ApiError::BadRequest("import_token or handoff_id is required".into()));
        }
        return Ok((import_token.to_string(), destination.to_string(), None));
    };
    if !import_token.is_empty() {
        return Err(ApiError::BadRequest("name a handoff or an import token, not both".into()));
    }
    let (token, handoff_destination, target) =
        migration::handoff::claim(state, user_id, subject_type, subject_id, handoff_id).await?;
    if federation::normalise_origin(destination) != handoff_destination {
        return Err(ApiError::BadRequest(
            "that handoff is for a different destination".into(),
        ));
    }
    Ok((token, handoff_destination, Some(target)))
}

pub async fn grant_payload(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<GrantPayloadRequest>,
) -> ApiResult<Json<Value>> {
    let subject_id = match req.subject_type.as_str() {
        "user" => auth.user_id.clone(),
        "guild" => req
            .subject_id
            .clone()
            .ok_or_else(|| ApiError::BadRequest("subject_id is required for a guild".into()))?,
        _ => return Err(ApiError::BadRequest("subject_type must be user or guild".into())),
    };
    let (token, destination, target_id) = claim_for(
        &state,
        &auth.user_id,
        &req.subject_type,
        &subject_id,
        &req.destination,
        &req.import_token,
        req.handoff_id.as_deref(),
    )
    .await?;
    let created_at = now_ms();
    let payload = migration::grant_payload(&subject_id, &destination, &token, created_at);
    Ok(Json(json!({
        "payload": crate::util::b64(&payload),
        "created_at": created_at,
        "device_id": auth.device_id,
        "destination": destination,
        "target_id": target_id,
    })))
}

pub async fn start(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<StartRequest>,
) -> ApiResult<Json<Value>> {
    if req.destination == state.cfg.server_name {
        return Err(ApiError::BadRequest("that is already this server".into()));
    }
    federation::ensure_reachable(&state, &req.destination, "identity").await?;

    crate::routes::identity::verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;

    if req.subject_type == "user" {
        crate::ownership::refuse_if_last_admin(
            &state.pool,
            &auth.user_id,
            crate::ownership::Departure::Move,
        )
        .await?;
    }

    let subject_id = match req.subject_type.as_str() {
        "user" => auth.user_id.clone(),
        "guild" => {
            let guild_id = req
                .subject_id
                .clone()
                .ok_or_else(|| ApiError::BadRequest("subject_id is required for a guild".into()))?;
            let owner: Option<String> =
                sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
                    .bind(&guild_id)
                    .fetch_optional(&state.pool)
                    .await?;
            match owner {
                Some(owner) if owner == auth.user_id => guild_id,
                Some(_) => return Err(ApiError::Forbidden("only the owner may move a guild".into())),
                None => return Err(ApiError::NotFound("no such guild".into())),
            }
        }
        _ => return Err(ApiError::BadRequest("subject_type must be user or guild".into())),
    };

    if req.subject_type == "user" {
        let active_bots: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) \
             FROM bot_applications a \
             JOIN bot_identities b ON b.application_id = a.id \
             WHERE a.owner_user_id = ? AND b.disabled = 0",
        )
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
        if active_bots > 0 {
            return Err(ApiError::Conflict(
                "retire active bot applications before migrating this account; \
                 bot identities do not migrate with developer accounts yet"
                    .into(),
            ));
        }
    }

    let (import_token, destination, _) = claim_for(
        &state,
        &auth.user_id,
        &req.subject_type,
        &subject_id,
        &req.destination,
        &req.import_token,
        req.handoff_id.as_deref(),
    )
    .await?;

    let created_at = req.created_at;
    if (now_ms() - created_at).abs() > 300_000 {
        return Err(ApiError::BadRequest("grant timestamp is too far from now".into()));
    }
    let payload = migration::grant_payload(&subject_id, &destination, &import_token, created_at);
    migration::verify_device_signature(
        &state,
        &auth.user_id,
        &auth.device_id,
        &payload,
        &req.device_signature,
    )
    .await?;

    if let Some(new_id) = moved_to(&state, &req.subject_type, &subject_id).await? {
        return Err(ApiError::Conflict(format!(
            "this has already moved, to {new_id}; it is that server's to move now"
        )));
    }

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM migrations WHERE subject_id = ? AND state IN ('pending', 'ready')",
    )
    .bind(&subject_id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(id) = existing {
        return Err(ApiError::Conflict(format!("migration {id} is already in flight")));
    }

    let id = ulid();
    let executes_at = created_at + state.cfg.federation.migration_delay_secs * 1000;
    let mut tx = state.pool.begin().await?;
    if let Some(handoff_id) = req.handoff_id.as_deref() {
        migration::handoff::consume(
            &mut tx,
            &auth.user_id,
            &req.subject_type,
            &subject_id,
            handoff_id,
            &id,
        )
        .await?;
    }
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    )
    .bind(&id)
    .bind(&req.subject_type)
    .bind(&subject_id)
    .bind(&destination)
    .bind(&import_token)
    .bind(&auth.device_id)
    .bind(&req.device_signature)
    .bind(created_at)
    .bind(executes_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    crate::routes::alerts::migration_requested(&state, &id, &auth.user_id).await;

    Ok(Json(json!({
        "id": id,
        "state": "pending",
        "subject_type": req.subject_type,
        "subject_id": subject_id,
        "destination": destination,
        "created_at": created_at,
        "executes_at": executes_at,
    })))
}

#[derive(Deserialize)]
pub struct HandoffOpenRequest {
    pub destination: String,
    #[serde(default = "user_kind")]
    pub subject_type: String,
    #[serde(default)]
    pub subject_id: Option<String>,
}

pub async fn handoff_open(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<HandoffOpenRequest>,
) -> ApiResult<Json<Value>> {
    let subject_id = match req.subject_type.as_str() {
        "user" => auth.user_id.clone(),
        "guild" => {
            let guild_id = req
                .subject_id
                .clone()
                .ok_or_else(|| ApiError::BadRequest("subject_id is required for a guild".into()))?;
            let owner: Option<String> =
                sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
                    .bind(&guild_id)
                    .fetch_optional(&state.pool)
                    .await?;
            match owner {
                Some(owner) if owner == auth.user_id => guild_id,
                Some(_) => return Err(ApiError::Forbidden("only the owner may move a guild".into())),
                None => return Err(ApiError::NotFound("no such guild".into())),
            }
        }
        _ => return Err(ApiError::BadRequest("subject_type must be user or guild".into())),
    };
    if let Some(new_id) = moved_to(&state, &req.subject_type, &subject_id).await? {
        return Err(ApiError::Conflict(format!(
            "this has already moved, to {new_id}; it is that server's to move now"
        )));
    }
    Ok(Json(
        migration::handoff::open(
            &state,
            &auth.user_id,
            &req.subject_type,
            &subject_id,
            &req.destination,
        )
        .await?,
    ))
}

pub async fn handoff_status(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    Ok(Json(migration::handoff::status(&state, &auth.user_id, &id).await?))
}

pub async fn handoff_deliver(
    State(state): State<AppState>,
    fed: Fed<migration::handoff::Delivery>,
) -> ApiResult<Json<Value>> {
    migration::handoff::deliver(&state, &fed.origin, &fed.body).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, String, String, i64, i64, Option<i64>, Option<String>)> =
        sqlx::query_as(
            "SELECT m.id, m.subject_type, m.subject_id, m.destination, m.state, m.created_at, \
             m.executes_at, m.completed_at, m.detail FROM migrations m \
             LEFT JOIN guilds g ON g.id = m.subject_id \
             WHERE m.subject_id = ? OR g.owner_user_id = ? ORDER BY m.created_at DESC LIMIT 50",
        )
        .bind(&auth.user_id)
        .bind(&auth.user_id)
        .fetch_all(&state.pool)
        .await?;
    let migrations: Vec<Value> = rows
        .into_iter()
        .map(|(id, ty, subject, destination, st, created, executes, completed, detail)| {
            json!({ "id": id, "subject_type": ty, "subject_id": subject,
                    "destination": destination, "state": st, "created_at": created,
                    "executes_at": executes, "completed_at": completed, "detail": detail })
        })
        .collect();
    Ok(Json(json!({ "migrations": migrations })))
}

pub async fn cancel(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT subject_type, subject_id, state FROM migrations WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let (subject_type, subject_id, st) =
        row.ok_or_else(|| ApiError::NotFound("no such migration".into()))?;
    authorize_subject(&state, &auth.user_id, &subject_type, &subject_id).await?;
    if st != "pending" && st != "ready" {
        return Err(ApiError::Conflict(format!("migration is {st}")));
    }
    if !mark_cancelled(&state, &id, &format!("cancelled by {}", auth.device_id)).await? {
        return Err(ApiError::Conflict("migration is no longer waiting".into()));
    }
    crate::routes::alerts::migration_settled(&state, &id).await;
    Ok(Json(json!({ "id": id, "state": "cancelled" })))
}

pub async fn mark_cancelled(state: &AppState, id: &str, detail: &str) -> ApiResult<bool> {
    let done = sqlx::query(
        "UPDATE migrations SET state = 'cancelled', detail = ? \
         WHERE id = ? AND state IN ('pending', 'ready')",
    )
    .bind(detail)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(done.rows_affected() == 1)
}

fn is_json(headers: &axum::http::HeaderMap) -> bool {
    let Some(value) = headers.get(axum::http::header::CONTENT_TYPE) else {
        return false;
    };
    let Ok(value) = value.to_str() else {
        return false;
    };
    let essence = value.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    essence == "application/json" || essence.strip_suffix("+json").is_some_and(|rest| {
        rest.starts_with("application/") && rest.len() > "application/".len()
    })
}

pub async fn retry(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<Json<Value>> {
    let req = if body.is_empty() {
        RetryRequest::default()
    } else {
        if !is_json(&headers) {
            return Err(ApiError::BadRequest(
                "a retry with a body needs a content type of application/json".into(),
            ));
        }
        serde_json::from_slice::<RetryRequest>(&body).map_err(|e| {
            if e.classify() == serde_json::error::Category::Data {
                ApiError::Unprocessable(format!("{e}"))
            } else {
                ApiError::BadRequest(format!("{e}"))
            }
        })?
    };
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT subject_type, subject_id, state, destination FROM migrations WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    let (subject_type, subject_id, st, destination) =
        row.ok_or_else(|| ApiError::NotFound("no such migration".into()))?;
    authorize_subject(&state, &auth.user_id, &subject_type, &subject_id).await?;
    if st != "failed" {
        return Err(ApiError::Conflict(format!(
            "migration is {st}; only a stopped one can be started again"
        )));
    }
    if let Some(new_id) = moved_to(&state, &subject_type, &subject_id).await? {
        return Err(ApiError::Conflict(format!(
            "this already moved, to {new_id}; starting this one again would land it twice"
        )));
    }
    let live: Option<String> = sqlx::query_scalar(
        "SELECT id FROM migrations \
         WHERE subject_id = ? AND state IN ('pending', 'ready') AND id != ?",
    )
    .bind(&subject_id)
    .bind(&id)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(other) = live {
        return Err(ApiError::Conflict(format!(
            "migration {other} is already in flight for this subject"
        )));
    }

    let fresh = match (req.import_token, req.device_signature, req.created_at) {
        (Some(token), Some(signature), Some(created_at)) => Some((token, signature, created_at)),
        (None, None, None) => None,
        _ => {
            return Err(ApiError::BadRequest(
                "a new claim needs import_token, device_signature and created_at together".into(),
            ))
        }
    };
    if let Some((token, signature, created_at)) = &fresh {
        crate::routes::identity::verify_sensitive_reauth(
            &state,
            &auth.user_id,
            req.password.as_deref(),
            req.reauth_token.as_deref(),
        )
        .await?;
        if (now_ms() - created_at).abs() > 300_000 {
            return Err(ApiError::BadRequest("grant timestamp is too far from now".into()));
        }
        let payload = migration::grant_payload(&subject_id, &destination, token, *created_at);
        migration::verify_device_signature(
            &state,
            &auth.user_id,
            &auth.device_id,
            &payload,
            signature,
        )
        .await?;
    }

    // Every retry restarts the cooling-off window.
    let restart_at = now_ms() + state.cfg.federation.migration_delay_secs * 1000;

    let put_back = sqlx::query(
        "UPDATE migrations SET state = 'ready', detail = ?, \
         grant_token = COALESCE(?, grant_token), \
         device_id = COALESCE(?, device_id), \
         device_sig = COALESCE(?, device_sig), \
         executes_at = ?, \
         deferred_until = 0, defer_count = 0 \
         WHERE id = ? AND state = 'failed'",
    )
    .bind(format!("started again by {}", auth.device_id))
    .bind(fresh.as_ref().map(|(token, _, _)| token.clone()))
    .bind(fresh.as_ref().map(|_| auth.device_id.clone()))
    .bind(fresh.as_ref().map(|(_, signature, _)| signature.clone()))
    .bind(restart_at)
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if put_back.rows_affected() == 0 {
        return Err(ApiError::Conflict("migration is no longer stopped".into()));
    }
    crate::routes::alerts::migration_requested(&state, &id, &auth.user_id).await;
    Ok(Json(json!({
        "id": id,
        "state": "ready",
        "executes_at": restart_at,
    })))
}

pub async fn execute(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT subject_type, subject_id FROM migrations WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let (subject_type, subject_id) =
        row.ok_or_else(|| ApiError::NotFound("no such migration".into()))?;
    authorize_subject(&state, &auth.user_id, &subject_type, &subject_id).await?;
    let result = run(&state, &id).await?;
    Ok(Json(result))
}

async fn authorize_subject(
    state: &AppState,
    user_id: &str,
    subject_type: &str,
    subject_id: &str,
) -> ApiResult<()> {
    let allowed = match subject_type {
        "user" => subject_id == user_id,
        "guild" => {
            let owner: Option<String> =
                sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
                    .bind(subject_id)
                    .fetch_optional(&state.pool)
                    .await?;
            owner.as_deref() == Some(user_id)
        }
        _ => false,
    };
    if !allowed {
        return Err(ApiError::Forbidden("not your migration".into()));
    }
    Ok(())
}

async fn moved_to(
    state: &AppState,
    subject_type: &str,
    subject_id: &str,
) -> ApiResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT new_id FROM tombstones \
         WHERE subject_type = ? AND subject_id = ? AND kind = 'moved'",
    )
    .bind(subject_type)
    .bind(subject_id)
    .fetch_optional(&state.pool)
    .await?)
}

const DEFER_FLOOR_MS: i64 = 60_000;
const DEFER_CEILING_MS: i64 = 60 * 60_000;

async fn defer(state: &AppState, id: &str) -> ApiResult<()> {
    sqlx::query(
        "UPDATE migrations \
         SET defer_count = defer_count + 1, \
             deferred_until = ? + MIN(? << MIN(defer_count, 6), ?) \
         WHERE id = ? AND state IN ('pending', 'ready')",
    )
    .bind(now_ms())
    .bind(DEFER_FLOOR_MS)
    .bind(DEFER_CEILING_MS)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn record(state: &AppState, id: &str, to: Option<&str>, detail: &str) -> ApiResult<()> {
    sqlx::query(
        "UPDATE migrations SET state = COALESCE(?, state), detail = ? \
         WHERE id = ? AND state IN ('pending', 'ready')",
    )
    .bind(to)
    .bind(detail)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn run(state: &AppState, id: &str) -> ApiResult<Value> {
    let row: Option<(String, String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT subject_type, subject_id, destination, grant_token, device_sig, state, executes_at \
         FROM migrations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let (subject_type, subject_id, destination, grant_token, device_sig, st, executes_at) =
        row.ok_or_else(|| ApiError::NotFound("no such migration".into()))?;
    if st != "pending" && st != "ready" {
        return Err(ApiError::Conflict(format!("migration is {st}")));
    }
    if executes_at > now_ms() {
        return Err(ApiError::Conflict(
            "still in the cooling-off window; it will run on its own".into(),
        ));
    }

    // Ask for the receipt first; a push may have landed with its reply lost.
    let collected = match federation::post_signed(
        state,
        &destination,
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": id }),
    )
    .await
    {
        Ok(ack) => {
            tracing::info!(target: crate::logcat::MIGRATION, migration = id, "destination already had a receipt; not re-pushing");
            Some(ack)
        }
        Err(ApiError::NotFound(_)) => None,
        Err(e @ ApiError::Conflict(_)) => {
            record(
                state,
                id,
                Some("failed"),
                &format!("destination cannot acknowledge this import: {e}"),
            )
            .await?;
            return Err(e);
        }
        Err(e) => {
            record(state, id, None, &format!("could not ask for a receipt: {e}")).await?;
            return Err(e);
        }
    };

    let mut carried_media: Vec<String> = Vec::new();
    let ack = match collected {
        Some(ack) => ack,
        None => {
            if let Some(new_id) = moved_to(state, &subject_type, &subject_id).await? {
                let e = ApiError::Conflict(format!(
                    "this already moved, to {new_id}; sending it again would land it twice"
                ));
                record(state, id, Some("failed"), &format!("{e}")).await?;
                return Err(e);
            }
            let bundle = match subject_type.as_str() {
                "user" => migration::export_user(state, &subject_id).await?,
                "guild" => migration::export_guild(state, &subject_id).await?,
                other => {
                    return Err(ApiError::BadRequest(format!("unknown subject type {other}")))
                }
            };
            carried_media = migration::carried_media(&bundle);
            migration::media::record_export(state, id, &bundle).await?;
            let bundle = crypto::sign_json(&state.key, bundle);

            let push = federation::post_signed_within(
                state,
                &destination,
                "/_telium/v1/migrate/import",
                &json!({ "migration_id": id, "import_token": grant_token, "bundle": bundle }),
                federation::MIGRATION_PUSH,
            )
            .await;
            match push {
                Ok(ack) => ack,
                Err(
                    e @ (ApiError::Conflict(_) | ApiError::Forbidden(_) | ApiError::TooLarge(_)),
                ) => {
                    record(state, id, Some("failed"), &format!("destination refused the bundle: {e}"))
                        .await?;
                    return Err(e);
                }
                Err(e) => {
                    record(state, id, Some("ready"), &format!("transfer failed: {e}")).await?;
                    return Err(e);
                }
            }
        }
    };

    let new_id = ack
        .get("new_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("destination returned no new id")))?
        .to_string();

    let says = |field: &str| ack.get(field).and_then(Value::as_str).unwrap_or_default();
    if says("migration_id") != id
        || says("subject_type") != subject_type
        || says("old_id") != subject_id
    {
        let e = ApiError::Conflict(format!(
            "destination acknowledged {} {} under migration {}; that is not what was sent",
            says("subject_type"),
            says("old_id"),
            says("migration_id")
        ));
        record(state, id, Some("failed"), &format!("{e}")).await?;
        return Err(e);
    }

    let tombstone =
        migration::write_tombstone(state, &subject_type, &subject_id, &new_id, &device_sig, &ack)
            .await?;

    match subject_type.as_str() {
        "user" => {
            sqlx::query("UPDATE accounts SET deactivated = 1 WHERE user_id = ?")
                .bind(&subject_id)
                .execute(&state.pool)
                .await?;
            sqlx::query("DELETE FROM home_sessions WHERE user_id = ?")
                .bind(&subject_id)
                .execute(&state.pool)
                .await?;

            let (
                notification_rows,
                notification_devices,
                push_subscriptions,
                dm_notification_hints,
            ) = crate::notifications::retire_moved_account(state, &subject_id).await?;
            if notification_rows
                + notification_devices
                + push_subscriptions
                + dm_notification_hints
                > 0
            {
                tracing::info!(
                    target: crate::logcat::MIGRATION,
                    migration = id,
                    user_id = %subject_id,
                    notification_rows,
                    notification_devices,
                    push_subscriptions,
                    dm_notification_hints,
                    "retired old-home notification state after account move"
                );
            }

            crate::revocation::announce(
                state,
                &subject_id,
                crate::revocation::MOVED,
                None,
                Some(&new_id),
            )
            .await;
            if let Err(e) = crate::routes::recovery::forget(state, &subject_id).await {
                tracing::warn!(target: crate::logcat::MIGRATION, migration = id, error = %e, "the recovery address was not cleared after the move");
            }
            let new_server = ack
                .get("server_name")
                .and_then(Value::as_str)
                .unwrap_or(destination.as_str());
            let settled =
                migration::media::settle_ack(state, id, &subject_id, &carried_media, &ack, new_server).await?;
            tracing::info!(
                target: crate::logcat::MIGRATION,
                migration = id,
                landed = settled.landed.len(),
                refused = settled.refused.len(),
                "the destination's word on the uploads the bundle carried"
            );
        }
        "guild" => {
            let new_server = ack
                .get("server_name")
                .and_then(Value::as_str)
                .unwrap_or(destination.as_str());
            if let Err(e) = crate::vanity::follow_move(state, &subject_id, new_server, &new_id).await
            {
                tracing::warn!(target: crate::logcat::MIGRATION, migration = id, error = %e, "guild addresses did not follow the move");
            }

            let cleared = sqlx::query("DELETE FROM notification_outbox WHERE guild_id = ?")
                .bind(&subject_id)
                .execute(&state.pool)
                .await?;
            if cleared.rows_affected() > 0 {
                tracing::info!(
                    target: crate::logcat::MIGRATION,
                    migration = id,
                    guild_id = %subject_id,
                    notifications = cleared.rows_affected(),
                    "discarded pending notification retries after guild move"
                );
            }
        }
        _ => {}
    }

    sqlx::query("UPDATE migrations SET state = 'completed', completed_at = ?, detail = ? WHERE id = ?")
        .bind(now_ms())
        .bind(format!("moved to {new_id} on {destination}"))
        .bind(id)
        .execute(&state.pool)
        .await?;

    Ok(json!({
        "id": id, "state": "completed", "new_id": new_id,
        "destination": destination, "tombstone": tombstone,
    }))
}

#[derive(Deserialize)]
pub struct ImportRequest {
    pub migration_id: String,
    pub import_token: String,
    pub bundle: Value,
}

const MIGRATION_BUNDLE_MB: usize = 160;

pub const MAX_IMPORT_ATTEMPTS: i64 = 5;

pub struct ExpectingABundle;

impl crate::federation::Gate for ExpectingABundle {
    async fn allows(state: &AppState, claimed: &str) -> bool {
        if crate::federation::ensure_reachable(state, claimed, "all").await.is_err() {
            return false;
        }
        sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM import_claims \
             WHERE source = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? LIMIT 1",
        )
        .bind(claimed)
        .bind(now_ms())
        .bind(MAX_IMPORT_ATTEMPTS)
        .fetch_optional(&state.pool)
        .await
        .unwrap_or(None)
        .is_some()
    }
}

async fn still_here(state: &AppState, subject_type: &str, new_id: &str) -> ApiResult<bool> {
    let found: Option<i64> = match subject_type {
        "guild" => sqlx::query_scalar("SELECT 1 FROM guilds WHERE id = ?")
            .bind(new_id)
            .fetch_optional(&state.pool)
            .await?,
        "user" => sqlx::query_scalar("SELECT 1 FROM accounts WHERE user_id = ?")
            .bind(new_id)
            .fetch_optional(&state.pool)
            .await?,
        _ => None,
    };
    Ok(found.is_some())
}

fn acknowledgement(
    state: &AppState,
    migration_id: &str,
    subject_type: &str,
    old_id: &str,
    new_id: &str,
    media_outcome: &str,
) -> Value {
    let mut ack = json!({
        "kind": "migration_ack",
        "migration_id": migration_id,
        "subject_type": subject_type,
        "old_id": old_id,
        "new_id": new_id,
        "server_name": state.cfg.server_name,
        "key_id": state.key.key_id,
        "imported_at": now_ms(),
    });
    if let Ok(outcome) = serde_json::from_str::<Value>(media_outcome) {
        if outcome.is_object() {
            ack["media"] = outcome;
        }
    }
    crypto::sign_json(&state.key, ack)
}

struct LoggedImport {
    source: String,
    subject_type: String,
    subject_id: String,
    ack: String,
    new_id: String,
    token_hash: String,
    media_outcome: String,
}

async fn logged_import(state: &AppState, migration_id: &str) -> ApiResult<Option<LoggedImport>> {
    let row: Option<(String, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT source, subject_type, source_id, ack, new_id, token_hash, media_outcome \
         FROM import_log WHERE id = ?",
    )
    .bind(migration_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(
        |(source, subject_type, subject_id, ack, new_id, token_hash, media_outcome)| LoggedImport {
            source,
            subject_type,
            subject_id,
            ack,
            new_id,
            token_hash,
            media_outcome,
        },
    ))
}

async fn answer_from_the_log(
    state: &AppState,
    migration_id: &str,
    logged: &LoggedImport,
) -> ApiResult<Value> {
    let LoggedImport {
        source: logged_source,
        subject_type: logged_type,
        subject_id: logged_subject,
        ack,
        new_id: logged_new_id,
        token_hash: logged_token_hash,
        media_outcome,
    } = logged;
    if !ack.is_empty() {
        return serde_json::from_str(ack).map_err(|e| {
            ApiError::Internal(anyhow::anyhow!("stored acknowledgement is unreadable: {e}"))
        });
    }
    if logged_new_id.is_empty() {
        return Err(ApiError::Conflict(
            "an import with that migration id landed here but was never acknowledged, \
             and the record does not say what it became; the subject is on this server \
             already -- ask an operator rather than sending it again"
                .into(),
        ));
    }
    if !still_here(state, logged_type, logged_new_id).await? {
        return Err(ApiError::Conflict(
            "an import with that migration id landed here but was never acknowledged, \
             and what it became is no longer on this server; ask an operator rather \
             than sending it again"
                .into(),
        ));
    }
    let reissued =
        acknowledgement(state, migration_id, logged_type, logged_subject, logged_new_id, media_outcome);
    let mut tx = state.pool.begin().await?;
    if logged_token_hash.is_empty() {
        sqlx::query(
            "UPDATE import_claims SET used_at = ? \
             WHERE source = ? AND source_id = ? AND subject_type = ? AND used_at IS NULL",
        )
        .bind(now_ms())
        .bind(logged_source)
        .bind(logged_subject)
        .bind(logged_type)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("UPDATE import_claims SET used_at = ? WHERE token_hash = ? AND used_at IS NULL")
            .bind(now_ms())
            .bind(logged_token_hash)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE import_log SET ack = ? WHERE id = ?")
        .bind(reissued.to_string())
        .bind(migration_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(reissued)
}

const MAX_MIGRATION_ID_BYTES: usize = 128;

fn a_usable_migration_id(id: &str) -> ApiResult<()> {
    if id.is_empty() {
        return Err(ApiError::BadRequest("migration_id is required".into()));
    }
    if id.len() > MAX_MIGRATION_ID_BYTES {
        return Err(ApiError::BadRequest("migration_id is too long".into()));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct ReceiptRequest {
    migration_id: String,
}

pub async fn receipt(
    State(state): State<AppState>,
    fed: Fed<ReceiptRequest>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    let source = fed.origin;
    a_usable_migration_id(&req.migration_id)?;
    let logged = logged_import(&state, &req.migration_id).await?.ok_or_else(|| {
        ApiError::NotFound("no import with that migration id has landed here".into())
    })?;
    if logged.source != source {
        return Err(ApiError::NotFound(
            "no import with that migration id has landed here".into(),
        ));
    }
    Ok(Json(
        answer_from_the_log(&state, &req.migration_id, &logged).await?,
    ))
}

#[derive(Deserialize)]
pub struct MediaFetchRequest {
    migration_id: String,
    hash: String,
}

pub async fn media_fetch(
    State(state): State<AppState>,
    fed: Fed<MediaFetchRequest>,
) -> ApiResult<Json<Value>> {
    a_usable_migration_id(&fed.body.migration_id)?;
    Ok(Json(
        migration::media::serve_omitted(&state, &fed.origin, &fed.body.migration_id, &fed.body.hash).await?,
    ))
}

#[derive(Deserialize)]
pub struct MediaConfirmRequest {
    migration_id: String,
    #[serde(default)]
    landed: Vec<String>,
    #[serde(default)]
    refused: Vec<Value>,
}

pub async fn media_confirm(
    State(state): State<AppState>,
    fed: Fed<MediaConfirmRequest>,
) -> ApiResult<Json<Value>> {
    a_usable_migration_id(&fed.body.migration_id)?;
    let refused: Vec<(String, String)> = fed
        .body
        .refused
        .iter()
        .map(|r| {
            (
                r.get("hash").and_then(Value::as_str).unwrap_or_default().to_string(),
                r.get("reason").and_then(Value::as_str).unwrap_or_default().to_string(),
            )
        })
        .collect();
    let settled = migration::media::confirm_pulled(
        &state,
        &fed.origin,
        &fed.body.migration_id,
        &fed.body.landed,
        &refused,
    )
    .await?;
    Ok(Json(json!({
        "ok": true,
        "landed": settled.landed.len(),
        "refused": settled.refused.len(),
    })))
}

pub async fn import(
    State(state): State<AppState>,
    fed: Fed<ImportRequest, MIGRATION_BUNDLE_MB, ExpectingABundle>,
) -> ApiResult<Json<Value>> {
    let req = fed.body;
    let source = fed.origin;
    a_usable_migration_id(&req.migration_id)?;

    // Validate the claim before the dedup lookup, which would otherwise be an id-existence oracle.
    let token_hash = hash_token(&req.import_token);
    let claim: Option<(String, String, String, String, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT subject_type, source, source_id, target_id, expires_at, used_at, attempts \
         FROM import_claims WHERE token_hash = ?",
    )
    .bind(&token_hash)
    .fetch_optional(&state.pool)
    .await?;
    let (subject_type, claim_source, source_id, target_id, expires_at, used_at, attempts) =
        claim.ok_or_else(|| ApiError::Forbidden("no claim matches that token".into()))?;
    if claim_source != source {
        return Err(ApiError::Forbidden("that claim names a different source".into()));
    }

    // Idempotent per (source, id); settle id collisions before importing.
    if let Some(logged) = logged_import(&state, &req.migration_id).await? {
        let pushed_type = req.bundle.get("kind").and_then(Value::as_str).unwrap_or_default();
        let pushed_subject = req.bundle.get("subject").and_then(Value::as_str).unwrap_or_default();
        if logged.source != source {
            return Err(ApiError::Conflict(
                "another server has already used that migration id here; choose another".into(),
            ));
        }
        if (logged.subject_type.as_str(), logged.subject_id.as_str())
            != (pushed_type, pushed_subject)
        {
            return Err(ApiError::Conflict(
                "that migration id was already used here for a different subject; choose another"
                    .into(),
            ));
        }
        return Ok(Json(
            answer_from_the_log(&state, &req.migration_id, &logged).await?,
        ));
    }

    if used_at.is_some() {
        return Err(ApiError::Conflict("that claim has already been used".into()));
    }
    if attempts >= MAX_IMPORT_ATTEMPTS {
        return Err(ApiError::Conflict(
            "that claim has failed too many times; ask for another".into(),
        ));
    }
    if expires_at <= now_ms() {
        return Err(ApiError::Forbidden("that claim has expired".into()));
    }

    let bundle = &req.bundle;
    if bundle.get("version").and_then(Value::as_i64).unwrap_or(0) > migration::BUNDLE_VERSION {
        return Err(ApiError::Conflict(
            "bundle is from a newer protocol version than this server speaks".into(),
        ));
    }
    if bundle.get("subject").and_then(Value::as_str) != Some(source_id.as_str()) {
        return Err(ApiError::BadRequest("bundle subject does not match the claim".into()));
    }
    if bundle.get("kind").and_then(Value::as_str) != Some(subject_type.as_str()) {
        return Err(ApiError::BadRequest("bundle kind does not match the claim".into()));
    }

    let _in_flight = state.imports_in_flight.begin(&req.migration_id)?;

    sqlx::query("UPDATE import_claims SET attempts = attempts + 1 WHERE token_hash = ?")
        .bind(&token_hash)
        .execute(&state.pool)
        .await?;

    let reservation = migration::Reservation {
        migration_id: &req.migration_id,
        subject_type: &subject_type,
        source: &source,
        source_id: &source_id,
        token_hash: &token_hash,
    };
    let new_id = match subject_type.as_str() {
        "user" => migration::import_user(&state, bundle, &target_id, &source, &reservation).await,
        "guild" => migration::import_guild(&state, bundle, &target_id, &reservation).await,
        other => Err(ApiError::BadRequest(format!("unknown subject type {other}"))),
    }?;

    let media_outcome: String =
        sqlx::query_scalar("SELECT media_outcome FROM import_log WHERE id = ?")
            .bind(&req.migration_id)
            .fetch_optional(&state.pool)
            .await?
            .unwrap_or_default();
    let ack = acknowledgement(&state, &req.migration_id, &subject_type, &source_id, &new_id, &media_outcome);

    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE import_claims SET used_at = ? WHERE token_hash = ?")
        .bind(now_ms())
        .bind(hash_token(&req.import_token))
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE import_log SET new_id = ?, imported_at = ?, ack = ? WHERE id = ?")
        .bind(&new_id)
        .bind(now_ms())
        .bind(ack.to_string())
        .bind(&req.migration_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(ack))
}

#[derive(Deserialize)]
pub struct SunsetRequest {
    pub mode: String,
    pub new_domain: Option<String>,
    pub effective_at: Option<i64>,
    pub message: Option<String>,
}

pub async fn set_sunset(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<SunsetRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    if req.mode != "relocate" && req.mode != "shutdown" && req.mode != "none" {
        return Err(ApiError::BadRequest("mode must be relocate, shutdown or none".into()));
    }
    if req.mode == "relocate" && req.new_domain.is_none() {
        return Err(ApiError::BadRequest("relocation needs a new_domain".into()));
    }
    if req.mode != "relocate" {
        crate::relocation::cancel(&state).await?;
    }
    if req.mode == "none" {
        sqlx::query("DELETE FROM server_meta WHERE key = 'sunset'")
            .execute(&state.pool)
            .await?;
        crate::admin::record(&state, &auth.user_id, "sunset.cancel", None, json!({})).await;
        return Ok(Json(json!({ "mode": "none" })));
    }
    let effective_at = req.effective_at.unwrap_or_else(|| now_ms() + 30 * 24 * 3600 * 1000);

    let relocation = match (req.mode.as_str(), req.new_domain.as_deref()) {
        ("relocate", Some(new_domain)) => Some(
            crate::relocation::announce(&state, new_domain, effective_at, req.message.as_deref())
                .await?,
        ),
        _ => None,
    };

    let record = crypto::sign_json(
        &state.key,
        json!({
            "kind": "domain_sunset",
            "mode": req.mode,
            "domain": state.cfg.server_name,
            "new_domain": req.new_domain,
            "effective_at": effective_at,
            "message": req.message,
            "announced_at": now_ms(),
        }),
    );
    sqlx::query(
        "INSERT INTO server_meta (key, value) VALUES ('sunset', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(record.to_string())
    .execute(&state.pool)
    .await?;

    if relocation.is_some() {
        let flusher = state.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::relocation::flush(&flusher).await {
                tracing::debug!(target: crate::logcat::MIGRATION, error = %e, "relocation notices not delivered yet");
            }
        });
    }
    crate::admin::record(
        &state,
        &auth.user_id,
        "sunset.announce",
        req.new_domain.as_deref(),
        json!({ "mode": req.mode, "effective_at": effective_at,
                "relocation": relocation.is_some() }),
    )
    .await;
    let mut out = record;
    if let Some(relocation) = relocation {
        out["relocation"] = relocation;
    }
    Ok(Json(out))
}

pub async fn get_sunset(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'sunset'")
            .fetch_optional(&state.pool)
            .await?;
    Ok(Json(match value {
        Some(v) => serde_json::from_str(&v).unwrap_or(Value::Null),
        None => json!({ "mode": "none", "domain": state.cfg.server_name }),
    }))
}

#[derive(Deserialize)]
pub struct FailoverRequest {
    pub subject_type: String,
    pub subject_id: String,
    pub standby: String,
}

pub async fn set_failover(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<FailoverRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    federation::ensure_reachable(&state, &req.standby, "identity").await?;
    if req.standby == state.cfg.server_name {
        return Err(ApiError::BadRequest("a server cannot stand behind itself".into()));
    }
    if req.subject_type == "server" && req.subject_id != state.cfg.server_name {
        return Err(ApiError::BadRequest(format!(
            "this server can only authorise a standby for {}",
            state.cfg.server_name
        )));
    }
    let authorisation =
        crate::promotion::authorise(&state, &req.subject_type, &req.subject_id, &req.standby)
            .await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "failover.authorize",
        Some(&req.subject_id),
        json!({ "subject_type": req.subject_type, "standby": req.standby,
                "sequence": authorisation.get("sequence") }),
    )
    .await;
    Ok(Json(authorisation))
}

pub async fn promote(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path((subject_type, subject_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT standby, sequence FROM failover WHERE subject_type = ? AND subject_id = ?",
    )
    .bind(&subject_type)
    .bind(&subject_id)
    .fetch_optional(&state.pool)
    .await?;
    let (standby, sequence) =
        row.ok_or_else(|| ApiError::NotFound("no standby is configured for that".into()))?;
    let next = sequence + 1;
    let record = crypto::sign_json(
        &state.key,
        json!({
            "kind": "failover_promotion",
            "subject_type": subject_type,
            "subject_id": subject_id,
            "authority": standby,
            "sequence": next,
            "promoted_at": now_ms(),
        }),
    );
    sqlx::query(
        "UPDATE failover SET sequence = ?, promoted = 1, record = ?, updated_at = ? \
         WHERE subject_type = ? AND subject_id = ?",
    )
    .bind(next)
    .bind(record.to_string())
    .bind(now_ms())
    .bind(&subject_type)
    .bind(&subject_id)
    .execute(&state.pool)
    .await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "failover.promote",
        Some(&subject_id),
        json!({ "subject_type": subject_type, "standby": standby, "sequence": next }),
    )
    .await;
    Ok(Json(record))
}

const SWEEP_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

pub async fn run_due(state: &AppState) -> ApiResult<u64> {
    run_due_within(state, SWEEP_BUDGET).await
}

pub async fn run_due_within(state: &AppState, budget: std::time::Duration) -> ApiResult<u64> {
    let until = std::time::Instant::now() + budget;
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM migrations \
         WHERE state IN ('pending', 'ready') AND executes_at <= ? AND deferred_until <= ? \
         ORDER BY executes_at LIMIT 10",
    )
    .bind(now_ms())
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;
    let mut done = 0;
    for id in due {
        if std::time::Instant::now() >= until {
            tracing::info!(target: crate::logcat::MIGRATION, "sweep out of time; the rest of the batch waits for the next tick");
            break;
        }
        match run(state, &id).await {
            Ok(_) => done += 1,
            Err(e) => {
                // Not `?`: one database error must not strand the other migrations.
                let state_now: Result<Option<String>, _> =
                    sqlx::query_scalar("SELECT state FROM migrations WHERE id = ?")
                        .bind(&id)
                        .fetch_optional(&state.pool)
                        .await;
                match state_now.as_ref().map(|s| s.as_deref()) {
                    Ok(Some("failed")) => tracing::warn!(
                        target: crate::logcat::MIGRATION,
                        migration = %id, error = %e,
                        "migration stopped and will not be tried again without a person"
                    ),
                    Ok(_) => match defer(state, &id).await {
                        Ok(()) => {
                            tracing::warn!(target: crate::logcat::MIGRATION, migration = %id, error = %e, "migration deferred")
                        }
                        Err(stand) => tracing::warn!(
                            target: crate::logcat::MIGRATION,
                            migration = %id, error = %e, standing_aside = %stand,
                            "migration failed and this server could not stand it down"
                        ),
                    },
                    Err(read) => tracing::warn!(
                        target: crate::logcat::MIGRATION,
                        migration = %id, error = %e, reading = %read,
                        "migration did not run and this server could not read back what state it is in"
                    ),
                }
            }
        }
    }
    Ok(done)
}
