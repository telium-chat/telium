
use axum::http::StatusCode;

use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::Fed;
use crate::guildstore;
use crate::notifications::{self, DeviceKey, FederatedEnvelope};
use crate::routes::messages::MessageRow;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, Query, State};
use axum::http::{header::AUTHORIZATION, HeaderMap};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

mod outbox;

pub use outbox::{flush_notification_outbox, spawn_notification_outbox};
use outbox::{queue_broadcast_notification, queue_remote_notification};

const FEDERATED_NOTIFICATION_BATCH_RECIPIENTS: usize = 128;
const FEDERATED_NOTIFICATION_BATCH_ENVELOPES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WakeUrgency {
    Routine,
    IncomingCall,
}

impl WakeUrgency {
    fn header(self, transport: &str) -> &'static str {
        match (self, transport) {
            (Self::IncomingCall, _) | (_, "native-webpush" | "relay") => "high",
            _ => "normal",
        }
    }
}

#[derive(Deserialize)]
pub struct Subscribe {
    pub kind: String,
    pub endpoint: String,
    #[serde(default)]
    pub auth: Option<String>,
    #[serde(default)]
    pub p256dh: Option<String>,
}

pub async fn vapid_public_key(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "public_key": state.vapid.public_b64 }))
}

async fn push_registration_auth(
    state: &AppState,
    headers: &HeaderMap,
) -> ApiResult<(String, String, bool)> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::Unauthorized("missing push registration credential".into()))?;

    if let Some(token) = value.strip_prefix("Bearer ").map(str::trim).filter(|v| !v.is_empty()) {
        let auth = HomeAuth::from_token(state, token).await?;
        return Ok((auth.user_id, auth.device_id, false));
    }
    if let Some(token) = value
        .strip_prefix("Telium-Notification ")
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let auth = notifications::authenticate_background(state, token).await?;
        return Ok((auth.user_id, auth.device_id, true));
    }
    Err(ApiError::Unauthorized("unsupported push registration credential".into()))
}

pub async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<Subscribe>,
) -> ApiResult<Json<Value>> {
    let (user_id, device_id, background) = push_registration_auth(&state, &headers).await?;
    if !["webpush", "native-webpush", "relay", "fcm", "apns"].contains(&req.kind.as_str()) {
        return Err(ApiError::BadRequest(
            "kind must be webpush, native-webpush, relay, fcm or apns".into(),
        ));
    }
    if !state.push_providers.supports(&req.kind) {
        return Err(ApiError::BadRequest(format!(
            "this server has no {} credentials, so it cannot wake a device that way. \
             Register a Web Push or UnifiedPush endpoint instead, or ask the operator to \
             configure [push.{}].",
            if req.kind == "fcm" { "Firebase" } else { "Apple Push" },
            req.kind,
        )));
    }
    if background && req.kind == "webpush" {
        return Err(ApiError::Forbidden(
            "notification credentials may register only native push transports".into(),
        ));
    }
    if matches!(req.kind.as_str(), "webpush" | "native-webpush")
        && (req.p256dh.is_none() || req.auth.is_none())
    {
        return Err(ApiError::BadRequest(
            "a webpush subscription needs both p256dh and auth".into(),
        ));
    }
    if matches!(req.kind.as_str(), "fcm" | "apns") {
        let token = req.endpoint.trim();
        if token.is_empty() || token.len() > 4096 {
            return Err(ApiError::BadRequest(
                "a device token must be between one and 4096 characters".into(),
            ));
        }
        if !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.')) {
            return Err(ApiError::BadRequest(
                "a device token may only contain letters, digits and -_:.".into(),
            ));
        }
    } else {
        crate::webpush::checked_endpoint(&state, &req.endpoint).await?;
    }

    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ? AND device_id = ?")
        .bind(&user_id)
        .bind(&device_id)
        .execute(&state.pool)
        .await?;
    let id = ulid();
    sqlx::query(
        "INSERT INTO push_subscriptions \
           (id, user_id, device_id, kind, endpoint, auth, p256dh, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user_id)
    .bind(&device_id)
    .bind(&req.kind)
    .bind(&req.endpoint)
    .bind(&req.auth)
    .bind(&req.p256dh)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "id": id })))
}

pub async fn unsubscribe(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    sqlx::query("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?")
        .bind(&id)
        .bind(&auth.user_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, device_id, kind, endpoint, created_at FROM push_subscriptions \
         WHERE user_id = ? ORDER BY created_at",
    )
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "subscriptions": rows.into_iter().map(|(id, device, kind, endpoint, at)| json!({
            "id": id, "device_id": device, "kind": kind, "endpoint": endpoint, "created_at": at,
        })).collect::<Vec<_>>()
    })))
}

async fn deliver_subscription(
    state: AppState,
    id: String,
    kind: String,
    endpoint: String,
    auth: Option<String>,
    p256dh: Option<String>,
    body: Value,
    urgency: WakeUrgency,
) -> bool {
    let provider_body = if kind == "webpush" {
        body
    } else {
        json!({ "type": "wake" })
    };

    if matches!(kind.as_str(), "fcm" | "apns") {
        let outcome = crate::pushproviders::deliver(&state, &kind, &endpoint, &provider_body).await;
        return settle_delivery(&state, &id, outcome).await;
    }

    let ok = if matches!(kind.as_str(), "webpush" | "native-webpush") {
        match (p256dh.as_deref(), auth.as_deref()) {
            (Some(p256dh), Some(auth)) => {
                crate::webpush::deliver(
                    &state,
                    &endpoint,
                    p256dh,
                    auth,
                    &provider_body,
                    urgency.header(&kind),
                )
                .await
            }
            _ => false,
        }
    } else {
        let checked = crate::webpush::checked_endpoint(&state, &endpoint)
            .await
            .ok()
            .and_then(|(url, pinned)| {
                let host = url.host_str().unwrap_or_default().to_string();
                crate::webpush::pinned_client(&host, pinned)
                    .ok()
                    .map(|client| (url, client))
            });
        match checked {
            None => {
                tracing::warn!(target: crate::logcat::PUSH, "refusing to relay a wake to an endpoint that is not routable");
                false
            }
            Some((url, client)) => {
                let mut request = client
                    .post(url)
                    .header("Urgency", urgency.header(&kind))
                    .json(&provider_body);
                if let Some(auth) = auth {
                    request = request.header("Authorization", auth);
                }
                match request.send().await {
                    Ok(response) if response.status().is_success() => true,
                    Ok(response) => {
                        tracing::warn!(
                            target: crate::logcat::PUSH,
                            status = %response.status(),
                            "native relay rejected wake"
                        );
                        false
                    }
                    Err(error) => {
                        tracing::warn!(target: crate::logcat::PUSH, %error, "could not reach native push relay");
                        false
                    }
                }
            }
        }
    };

    settle_delivery(
        &state,
        &id,
        if ok {
            crate::pushproviders::Outcome::Delivered
        } else {
            crate::pushproviders::Outcome::Retry
        },
    )
    .await
}

async fn settle_delivery(
    state: &AppState,
    id: &str,
    outcome: crate::pushproviders::Outcome,
) -> bool {
    use crate::pushproviders::Outcome;
    match outcome {
        Outcome::Delivered => {
            let _ = sqlx::query("UPDATE push_subscriptions SET failures = 0 WHERE id = ?")
                .bind(id)
                .execute(&state.pool)
                .await;
            true
        }
        Outcome::Retry => {
            let _ =
                sqlx::query("UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?")
                    .bind(id)
                    .execute(&state.pool)
                    .await;
            let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = ? AND failures > 20")
                .bind(id)
                .execute(&state.pool)
                .await;
            false
        }
        Outcome::Gone => {
            tracing::info!(
                target: crate::logcat::PUSH,
                subscription = id,
                "the push provider says this device token was revoked; dropping the registration"
            );
            let _ = sqlx::query("DELETE FROM push_subscriptions WHERE id = ?")
                .bind(id)
                .execute(&state.pool)
                .await;
            false
        }
    }
}

pub async fn notify(state: &AppState, user_id: &str, body: Value) {
    let rows: Result<Vec<(String, String, String, Option<String>, Option<String>)>, _> =
        sqlx::query_as(
            "SELECT id, kind, endpoint, auth, p256dh FROM push_subscriptions WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else { return };
    for (id, kind, endpoint, auth, p256dh) in rows {
        let state = state.clone();
        let body = body.clone();
        tokio::spawn(deliver_subscription(
            state,
            id,
            kind,
            endpoint,
            auth,
            p256dh,
            body,
            WakeUrgency::Routine,
        ));
    }
}

async fn notify_kind(state: &AppState, user_id: &str, wanted_kind: &str, body: Value) {
    let rows: Result<Vec<(String, String, String, Option<String>, Option<String>)>, _> =
        sqlx::query_as(
            "SELECT id, kind, endpoint, auth, p256dh FROM push_subscriptions \
             WHERE user_id = ? AND kind = ?",
        )
        .bind(user_id)
        .bind(wanted_kind)
        .fetch_all(&state.pool)
        .await;
    let Ok(rows) = rows else { return };
    for (id, kind, endpoint, auth, p256dh) in rows {
        let state = state.clone();
        let body = body.clone();
        tokio::spawn(deliver_subscription(
            state,
            id,
            kind,
            endpoint,
            auth,
            p256dh,
            body,
            WakeUrgency::Routine,
        ));
    }
}

async fn deliver_device_now(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    body: Value,
) -> ApiResult<bool> {
    let row: Option<(String, String, String, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT id, kind, endpoint, auth, p256dh FROM push_subscriptions \
             WHERE user_id = ? AND device_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some((id, kind, endpoint, auth, p256dh)) = row else {
        return Err(ApiError::Conflict(
            "this device has not registered a background push endpoint yet".into(),
        ));
    };
    if kind == "webpush" {
        return Err(ApiError::Conflict(
            "this device only has a browser push subscription, not a native Android endpoint".into(),
        ));
    }
    Ok(deliver_subscription(
        state.clone(),
        id,
        kind,
        endpoint,
        auth,
        p256dh,
        body,
        WakeUrgency::Routine,
    )
    .await)
}

async fn notify_device_with_urgency(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    body: Value,
    urgency: WakeUrgency,
) {
    let row: Result<Option<(String, String, String, Option<String>, Option<String>)>, _> =
        sqlx::query_as(
            "SELECT id, kind, endpoint, auth, p256dh FROM push_subscriptions \
             WHERE user_id = ? AND device_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(device_id)
        .fetch_optional(&state.pool)
        .await;
    let Ok(Some((id, kind, endpoint, auth, p256dh))) = row else { return };
    let state = state.clone();
    tokio::spawn(deliver_subscription(
        state, id, kind, endpoint, auth, p256dh, body, urgency,
    ));
}

pub async fn notify_device(state: &AppState, user_id: &str, device_id: &str, body: Value) {
    notify_device_with_urgency(state, user_id, device_id, body, WakeUrgency::Routine).await;
}

pub async fn wake(state: &AppState, user_id: &str, guild_id: &str, channel_id: &str) {
    notify_kind(
        state,
        user_id,
        "webpush",
        json!({ "type": "wake", "guild_id": guild_id, "channel_id": channel_id }),
    )
    .await;
}

fn wake_recently(user_id: &str, device_id: &str) -> bool {
    static RECENT: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    let recent = RECENT.get_or_init(|| Mutex::new(HashMap::new()));
    let now = now_ms();
    let Ok(mut recent) = recent.lock() else {
        return false;
    };
    if recent.len() > WAKE_COALESCE_SWEEP_AT {
        recent.retain(|_, at| now - *at < WAKE_COALESCE_MS);
    }
    let key = format!("{user_id}\u{0}{device_id}");
    match recent.get(&key) {
        Some(at) if now - *at < WAKE_COALESCE_MS => true,
        _ => {
            recent.insert(key, now);
            false
        }
    }
}

const WAKE_COALESCE_MS: i64 = 4_000;

const WAKE_COALESCE_SWEEP_AT: usize = 1_024;

pub async fn notify_migration(
    state: &AppState,
    user_id: &str,
    migration_id: &str,
) -> ApiResult<()> {
    let created_at = now_ms();
    let descriptor = json!({
        "v": 1,
        "kind": "migration",
        "title": "Telium",
        "body": "A move of your account was requested. Open Telium to review or cancel it.",
        "created_at": created_at,
    });
    let plaintext = serde_json::to_vec(&descriptor)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("migration notification descriptor: {e}")))?;
    let devices = notifications::keys_for_local_user(state, user_id).await?;
    let expires_at = created_at + notifications::DEFAULT_RETENTION_MS;

    for device in devices {
        if device.algorithm != notifications::ALGORITHM_V1 {
            continue;
        }
        let associated_data = notifications::aad(
            user_id,
            &device.device_id,
            &state.cfg.server_name,
            migration_id,
            None,
            "migration",
        );
        let sealed = notifications::seal_descriptor(
            &device.public_key,
            &associated_data,
            &plaintext,
        )?;
        let ciphertext = serde_json::to_string(&sealed)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("migration notification envelope: {e}")))?;
        let inserted = sqlx::query(
            "INSERT OR IGNORE INTO notification_inbox \
             (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, 'migration', NULL, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(user_id)
        .bind(&device.device_id)
        .bind(&state.cfg.server_name)
        .bind(migration_id)
        .bind(ciphertext)
        .bind(created_at)
        .bind(expires_at)
        .execute(&state.pool)
        .await?;
        if inserted.rows_affected() == 1 {
            wake_notification_device(state, user_id, &device.device_id).await;
        }
    }

    notify_kind(
        state,
        user_id,
        "webpush",
        json!({ "type": "migration", "migration_id": migration_id }),
    )
    .await;
    Ok(())
}

pub async fn wake_notification_device(state: &AppState, user_id: &str, device_id: &str) {
    if wake_recently(user_id, device_id) {
        return;
    }
    notify_device(state, user_id, device_id, json!({ "type": "wake" })).await;
}

pub async fn wake_notification_device_incoming_call(
    state: &AppState,
    user_id: &str,
    device_id: &str,
) {
    notify_device_with_urgency(
        state,
        user_id,
        device_id,
        json!({ "type": "wake" }),
        WakeUrgency::IncomingCall,
    )
    .await;
}

pub async fn test_notification_wake(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    let accepted = deliver_device_now(
        &state,
        &auth.user_id,
        &auth.device_id,
        json!({ "type": "wake" }),
    )
    .await?;
    if !accepted {
        return Err(ApiError::TryAgain(
            "the configured push provider did not accept the test wake".into(),
        ));
    }
    Ok(Json(json!({ "accepted": true, "sent_at": now_ms() })))
}

#[derive(Deserialize)]
pub struct RegisterNotificationDevice {
    pub algorithm: String,
    pub public_key: String,
}

pub async fn register_notification_device(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<RegisterNotificationDevice>,
) -> ApiResult<Json<Value>> {
    let background_token = notifications::register_device(
        &state,
        &auth.user_id,
        &auth.device_id,
        &req.algorithm,
        &req.public_key,
    )
    .await?;
    Ok(Json(json!({
        "device_id": auth.device_id,
        "algorithm": req.algorithm,
        "background_token": background_token,
    })))
}

pub async fn delete_notification_device(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    notifications::revoke_device(&state, &auth.user_id, &auth.device_id).await?;
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ? AND device_id = ?")
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true })))
}

fn notification_bearer(headers: &HeaderMap) -> ApiResult<String> {
    headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Telium-Notification "))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| ApiError::Unauthorized("missing notification credential".into()))
}

#[derive(Deserialize)]
pub struct InboxQuery {
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default = "default_inbox_limit")]
    pub limit: i64,
}

fn default_inbox_limit() -> i64 { 50 }

pub async fn notification_inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<InboxQuery>,
) -> ApiResult<Json<Value>> {
    let token = notification_bearer(&headers)?;
    let auth = notifications::authenticate_background(&state, &token).await?;
    Ok(Json(notifications::pull(&state, &auth, query.after.as_deref(), query.limit).await?))
}

#[derive(Deserialize)]
pub struct AckNotificationInbox {
    pub through: String,
}

pub async fn acknowledge_notification_inbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<AckNotificationInbox>,
) -> ApiResult<Json<Value>> {
    let token = notification_bearer(&headers)?;
    let auth = notifications::authenticate_background(&state, &token).await?;
    let deleted = notifications::ack(&state, &auth, &req.through).await?;
    Ok(Json(json!({ "ok": true, "acknowledged": deleted })))
}

#[derive(Deserialize)]
pub struct NotificationKeysRequest {
    pub guild_id: String,
}

pub async fn notification_keys(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    fed: Fed<NotificationKeysRequest>,
) -> ApiResult<Json<Value>> {
    let devices = notifications::keys_for_guild(
        &state,
        &fed.origin,
        &user_id,
        &fed.body.guild_id,
    )
    .await?;
    Ok(Json(json!({ "devices": devices })))
}

#[derive(Deserialize)]
pub struct FederatedNotificationRequest {
    pub guild_id: String,
    pub source_id: String,
    pub kind: String,
    #[serde(default)]
    pub bucket: Option<String>,
    pub envelopes: Vec<FederatedEnvelope>,
}

pub async fn federated_notifications(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
    fed: Fed<FederatedNotificationRequest>,
) -> ApiResult<Json<Value>> {
    let inserted = notifications::enqueue_federated(
        &state,
        &fed.origin,
        &user_id,
        &fed.body.guild_id,
        &fed.body.source_id,
        &fed.body.kind,
        fed.body.bucket.as_deref(),
        &fed.body.envelopes,
    )
    .await?;
    for device_id in &inserted {
        wake_notification_device(&state, &user_id, device_id).await;
    }
    Ok(Json(json!({ "ok": true, "queued": inserted.len() })))
}

#[derive(Deserialize)]
pub struct BatchNotificationKeyTarget {
    pub user_id: String,
    pub guild_id: String,
}

#[derive(Deserialize)]
pub struct BatchNotificationKeysRequest {
    pub targets: Vec<BatchNotificationKeyTarget>,
}

pub async fn notification_keys_batch(
    State(state): State<AppState>,
    fed: Fed<BatchNotificationKeysRequest>,
) -> ApiResult<Json<Value>> {
    if fed.body.targets.is_empty()
        || fed.body.targets.len() > FEDERATED_NOTIFICATION_BATCH_RECIPIENTS
    {
        return Err(ApiError::BadRequest(
            "notification key batch size is invalid".into(),
        ));
    }

    let mut results = Vec::new();
    for target in &fed.body.targets {
        match notifications::keys_for_guild(
            &state,
            &fed.origin,
            &target.user_id,
            &target.guild_id,
        )
        .await
        {
            Ok(devices) => results.push(json!({
                "user_id": target.user_id,
                "guild_id": target.guild_id,
                "devices": devices,
            })),
            Err(error)
                if matches!(error.status(), StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(Json(json!({ "targets": results })))
}

#[derive(Deserialize)]
pub struct BatchFederatedNotification {
    pub user_id: String,
    pub guild_id: String,
    pub source_id: String,
    pub kind: String,
    #[serde(default)]
    pub bucket: Option<String>,
    pub envelopes: Vec<FederatedEnvelope>,
}

#[derive(Deserialize)]
pub struct FederatedNotificationBatchRequest {
    pub items: Vec<BatchFederatedNotification>,
}

pub async fn federated_notifications_batch(
    State(state): State<AppState>,
    fed: Fed<FederatedNotificationBatchRequest>,
) -> ApiResult<Json<Value>> {
    if fed.body.items.is_empty()
        || fed.body.items.len() > FEDERATED_NOTIFICATION_BATCH_RECIPIENTS
        || fed
            .body
            .items
            .iter()
            .map(|item| item.envelopes.len())
            .sum::<usize>()
            > FEDERATED_NOTIFICATION_BATCH_ENVELOPES
    {
        return Err(ApiError::BadRequest(
            "notification delivery batch size is invalid".into(),
        ));
    }

    let mut queued = 0usize;
    let mut ignored = 0usize;
    for item in &fed.body.items {
        match notifications::enqueue_federated(
            &state,
            &fed.origin,
            &item.user_id,
            &item.guild_id,
            &item.source_id,
            &item.kind,
            item.bucket.as_deref(),
            &item.envelopes,
        )
        .await
        {
            Ok(inserted) => {
                queued += inserted.len();
                for device_id in inserted {
                    wake_notification_device(&state, &item.user_id, &device_id).await;
                }
            }
            Err(error)
                if matches!(error.status(), StatusCode::FORBIDDEN | StatusCode::NOT_FOUND) =>
            {
                ignored += 1;
            }
            Err(error) => return Err(error),
        }
    }

    Ok(Json(json!({ "ok": true, "queued": queued, "ignored": ignored })))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct NotificationSource {
    id: String,
    guild_id: String,
    channel_id: String,
    author_id: String,
    content: String,
    has_attachment: bool,
    has_sticker: bool,
    created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct BroadcastNotificationJob {
    source: NotificationSource,
    #[serde(default)]
    after_user_id: Option<String>,
    #[serde(default)]
    exclude_user_ids: Vec<String>,
}

impl From<&MessageRow> for NotificationSource {
    fn from(row: &MessageRow) -> Self {
        let has_attachment = serde_json::from_str::<Value>(&row.attachments)
            .ok()
            .and_then(|v| v.as_array().map(|a| !a.is_empty()))
            .unwrap_or(false);
        Self {
            id: row.id.clone(),
            guild_id: row.guild_id.clone(),
            channel_id: row.channel_id.clone(),
            author_id: row.author_id.clone(),
            content: row.content.chars().take(241).collect(),
            has_attachment,
            has_sticker: row.sticker.is_some(),
            created_at: row.created_at,
        }
    }
}

fn notification_preview(source: &NotificationSource) -> String {
    let trimmed = source.content.trim();
    if !trimmed.is_empty() {
        let mut preview = trimmed.chars().take(240).collect::<String>();
        if trimmed.chars().count() > 240 {
            preview.push('…');
        }
        return preview;
    }
    match (source.has_attachment, source.has_sticker) {
        (true, true) => "Sent an attachment and sticker".into(),
        (true, false) => "Sent an attachment".into(),
        (false, true) => "Sent a sticker".into(),
        (false, false) => "New message".into(),
    }
}

fn notification_bucket(source: &NotificationSource) -> String {
    notifications::coalesce_bucket(&["channel", &source.guild_id, &source.channel_id])
}

async fn notification_device_keys(
    state: &AppState,
    user_id: &str,
    source: &NotificationSource,
) -> ApiResult<(String, Vec<DeviceKey>)> {
    let Some(home) = crate::federation::domain_of(user_id).map(str::to_string) else {
        return Err(ApiError::BadRequest("notification recipient id has no homeserver".into()));
    };

    if home == state.cfg.server_name {
        let keys = notifications::keys_for_guild(
            state,
            &state.cfg.server_name,
            user_id,
            &source.guild_id,
        )
        .await?;
        return Ok((home, keys));
    }
    if !state.cfg.federation.enabled {
        return Ok((home, Vec::new()));
    }

    let key_path = format!("/_telium/v1/users/{user_id}/notification-keys");
    let key_reply = crate::federation::post_signed(
        state,
        &home,
        &key_path,
        &json!({ "guild_id": source.guild_id }),
    )
    .await?;
    let keys = key_reply
        .get("devices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value::<DeviceKey>(value.clone()).ok())
        .collect::<Vec<_>>();
    Ok((home, keys))
}

async fn notification_descriptor(
    state: &AppState,
    source: &NotificationSource,
    kind: &str,
) -> ApiResult<Vec<u8>> {
    if !matches!(kind, "mention" | "reply") {
        return Err(ApiError::BadRequest("unsupported guild notification kind".into()));
    }

    let guild_name: Option<String> = sqlx::query_scalar("SELECT name FROM guilds WHERE id = ?")
        .bind(&source.guild_id)
        .fetch_optional(&state.pool)
        .await?;
    let channel_name: Option<String> = sqlx::query_scalar("SELECT name FROM channels WHERE id = ?")
        .bind(&source.channel_id)
        .fetch_optional(&state.pool)
        .await?;
    let author_name: Option<String> = sqlx::query_scalar(
        "SELECT display_name FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(&source.guild_id)
    .bind(&source.author_id)
    .fetch_optional(&state.pool)
    .await?;

    let descriptor = json!({
        "v": 1,
        "kind": kind,
        "title": author_name.as_deref().unwrap_or(&source.author_id),
        "body": notification_preview(source),
        "context": {
            "guild_name": guild_name,
            "channel_name": channel_name,
        },
        "destination": {
            "type": "guild_message",
            "guild_origin": state.cfg.server_name,
            "guild_id": source.guild_id,
            "channel_id": source.channel_id,
            "message_id": source.id,
        },
        "created_at": source.created_at,
    });
    serde_json::to_vec(&descriptor)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("notification descriptor: {e}")))
}

async fn deliver_private_notification(
    state: &AppState,
    user_id: &str,
    source: &NotificationSource,
    kind: &str,
) -> ApiResult<()> {
    let (home, devices) = notification_device_keys(state, user_id, source).await?;
    if devices.is_empty() {
        return Ok(());
    }

    let plaintext = notification_descriptor(state, source, kind).await?;

    let mut sealed_targets = Vec::new();
    for device in devices {
        if device.algorithm != notifications::ALGORITHM_V1 {
            continue;
        }
        let associated_data = notifications::aad(
            user_id,
            &device.device_id,
            &state.cfg.server_name,
            &source.id,
            Some(&source.guild_id),
            kind,
        );
        let sealed = notifications::seal_descriptor(
            &device.public_key,
            &associated_data,
            &plaintext,
        )?;
        sealed_targets.push(FederatedEnvelope {
            device_id: device.device_id,
            ciphertext: serde_json::to_value(sealed)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("notification envelope: {e}")))?,
        });
    }
    if sealed_targets.is_empty() {
        return Ok(());
    }

    if home == state.cfg.server_name {
        let inserted = notifications::enqueue_federated(
            state,
            &state.cfg.server_name,
            user_id,
            &source.guild_id,
            &source.id,
            kind,
            Some(&notification_bucket(source)),
            &sealed_targets,
        )
        .await?;
        for device_id in inserted {
            wake_notification_device(state, user_id, &device_id).await;
        }
        return Ok(());
    }

    let envelopes = sealed_targets
        .into_iter()
        .map(|target| json!({
            "device_id": target.device_id,
            "ciphertext": target.ciphertext,
        }))
        .collect::<Vec<_>>();
    let enqueue_path = format!("/_telium/v1/users/{user_id}/notifications");
    crate::federation::post_signed(
        state,
        &home,
        &enqueue_path,
        &json!({
            "guild_id": source.guild_id,
            "source_id": source.id,
            "kind": kind,
            "bucket": notification_bucket(source),
            "envelopes": envelopes,
        }),
    )
    .await?;
    Ok(())
}

async fn recipient_allows_background_notification(
    state: &AppState,
    source: &NotificationSource,
    user_id: &str,
) -> bool {
    if user_id == source.author_id {
        return false;
    }
    if guildstore::require_channel_perm(
        state,
        &source.channel_id,
        user_id,
        crate::perms::VIEW_CHANNEL,
    )
    .await
    .is_err()
    {
        return false;
    }
    if state.hub.presence_of(user_id).await.status != "offline" {
        return false;
    }
    let muted: Option<i64> = sqlx::query_scalar(
        "SELECT muted FROM read_state WHERE user_id = ? AND channel_id = ?",
    )
    .bind(user_id)
    .bind(&source.channel_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    muted != Some(1)
}


fn merge_notification_targets(
    author_id: &str,
    mentioned: &[String],
    reply_author: Option<String>,
) -> Vec<(String, &'static str)> {
    let mut targets: BTreeMap<String, &'static str> = BTreeMap::new();

    for user_id in mentioned {
        if user_id == "@everyone" || user_id == author_id {
            continue;
        }
        targets.insert(user_id.clone(), "mention");
    }

    if let Some(user_id) = reply_author {
        if user_id != author_id {
            targets.entry(user_id).or_insert("reply");
        }
    }

    targets.into_iter().collect()
}

async fn notification_targets(
    state: &AppState,
    message: &MessageRow,
    mentioned: &[String],
) -> ApiResult<Vec<(String, &'static str)>> {
    let reply_author = if let Some(reply_to) = message.reply_to.as_deref() {
        sqlx::query_scalar(
            "SELECT author_id FROM messages \
             WHERE id = ? AND channel_id = ? AND guild_id = ? AND deleted = 0",
        )
        .bind(reply_to)
        .bind(&message.channel_id)
        .bind(&message.guild_id)
        .fetch_optional(&state.pool)
        .await?
    } else {
        None
    };

    Ok(merge_notification_targets(
        &message.author_id,
        mentioned,
        reply_author,
    ))
}

pub async fn wake_mentioned(
    state: &AppState,
    message: &MessageRow,
    mentioned: &[String],
) {
    let targets = match notification_targets(state, message, mentioned).await {
        Ok(targets) => targets,
        Err(error) => {
            tracing::warn!(
                target: crate::logcat::PUSH,
                guild_id = %message.guild_id,
                channel_id = %message.channel_id,
                message_id = %message.id,
                %error,
                "could not resolve guild notification targets"
            );
            return;
        }
    };
    let source = NotificationSource::from(message);

    if mentioned.iter().any(|target| target == "@everyone")
        && message.content.contains("@everyone")
    {
        let mut excluded = targets
            .iter()
            .map(|(user_id, _)| user_id.clone())
            .collect::<Vec<_>>();
        excluded.push(message.author_id.clone());
        excluded.sort();
        excluded.dedup();
        if let Err(error) = queue_broadcast_notification(state, &source, excluded).await {
            tracing::warn!(
                target: crate::logcat::PUSH,
                guild_id = %source.guild_id,
                channel_id = %source.channel_id,
                message_id = %source.id,
                %error,
                "could not queue @everyone notification broadcast"
            );
        }
    }

    for (user_id, kind) in targets {
        if !recipient_allows_background_notification(state, &source, &user_id).await {
            continue;
        }

        let local = crate::federation::is_local(state, &user_id);
        if local {
            wake(state, &user_id, &message.guild_id, &message.channel_id).await;
        }

        if local {
            let state = state.clone();
            let source = source.clone();
            tokio::spawn(async move {
                if let Err(error) =
                    deliver_private_notification(&state, &user_id, &source, kind).await
                {
                    tracing::warn!(
                        target: crate::logcat::PUSH,
                        %user_id,
                        %kind,
                        guild_id = %source.guild_id,
                        channel_id = %source.channel_id,
                        message_id = %source.id,
                        %error,
                        "could not deliver local private guild notification"
                    );
                }
            });
        } else if let Err(error) =
            queue_remote_notification(state, &user_id, &source, kind).await
        {
            tracing::warn!(
                target: crate::logcat::PUSH,
                %user_id,
                %kind,
                guild_id = %source.guild_id,
                channel_id = %source.channel_id,
                message_id = %source.id,
                %error,
                "could not queue private guild notification"
            );
        }
    }
}

const ENCRYPTED_MESSAGE_BODY: &str = "Encrypted message";

pub async fn wake_conversation(
    state: &AppState,
    conversation_id: &str,
    message: &Value,
    local_members: &[String],
) {
    if message.get("notify").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if message.get("kind").and_then(Value::as_str) != Some("application") {
        return;
    }
    let sender = message.get("sender").and_then(Value::as_str).unwrap_or_default();
    let source_id = message.get("id").and_then(Value::as_str).unwrap_or_default();
    if sender.is_empty() || source_id.is_empty() {
        return;
    }
    let created_at = message.get("created_at").and_then(Value::as_i64).unwrap_or_else(now_ms);

    let sender_name: Option<String> =
        sqlx::query_scalar("SELECT display_name FROM profiles WHERE user_id = ?")
            .bind(sender)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .filter(|name: &String| !name.trim().is_empty());

    let descriptor = conversation_descriptor(
        sender_name.as_deref().unwrap_or(sender),
        conversation_id,
        created_at,
    );
    let Ok(plaintext) = serde_json::to_vec(&descriptor) else { return };

    for user_id in local_members {
        if user_id == sender {
            continue;
        }
        if !conversation_wants_background_notification(state, conversation_id, user_id).await {
            continue;
        }
        if let Err(error) =
            seal_conversation_notification(state, user_id, conversation_id, source_id, &plaintext)
                .await
        {
            tracing::warn!(
                target: crate::logcat::PUSH,
                conversation = conversation_id,
                recipient = user_id,
                %error,
                "could not queue a conversation notification"
            );
        }
    }
}

fn conversation_descriptor(title: &str, conversation_id: &str, created_at: i64) -> Value {
    json!({
        "v": 1,
        "kind": "encrypted_message",
        "title": title,
        "body": ENCRYPTED_MESSAGE_BODY,
        "destination": {
            "type": "conversation",
            "conversation_id": conversation_id,
        },
        "created_at": created_at,
    })
}

async fn seal_conversation_notification(
    state: &AppState,
    user_id: &str,
    conversation_id: &str,
    source_id: &str,
    plaintext: &[u8],
) -> ApiResult<()> {
    let devices = notifications::keys_for_local_user(state, user_id).await?;
    let mut sealed = Vec::new();
    for device in devices {
        if device.algorithm != notifications::ALGORITHM_V1 {
            continue;
        }
        let associated_data = notifications::aad(
            user_id,
            &device.device_id,
            &state.cfg.server_name,
            source_id,
            None,
            "encrypted_message",
        );
        let envelope =
            notifications::seal_descriptor(&device.public_key, &associated_data, plaintext)?;
        sealed.push(FederatedEnvelope {
            device_id: device.device_id,
            ciphertext: serde_json::to_value(envelope)
                .map_err(|e| ApiError::Internal(anyhow::anyhow!("notification envelope: {e}")))?,
        });
    }
    if sealed.is_empty() {
        return Ok(());
    }

    let inserted = notifications::enqueue_local_conversation(
        state,
        user_id,
        conversation_id,
        source_id,
        "encrypted_message",
        &sealed,
    )
    .await?;
    for device_id in inserted {
        wake_notification_device(state, user_id, &device_id).await;
    }
    Ok(())
}

async fn conversation_wants_background_notification(
    state: &AppState,
    conversation_id: &str,
    user_id: &str,
) -> bool {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT state, muted FROM conversation_members \
         WHERE conversation_id = ? AND user_id = ?",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    let Some((membership, muted)) = row else { return false };
    if membership != "active" || muted == 1 {
        return false;
    }
    state.hub.presence_of(user_id).await.status == "offline"
}

#[cfg(test)]
mod conversation_descriptor_tests {
    use super::conversation_descriptor;

    #[test]
    fn a_conversation_descriptor_says_who_and_where_and_nothing_about_what() {
        let descriptor = conversation_descriptor("Alice", "01JCONV", 1_700_000_000_000);
        assert_eq!(descriptor["kind"], "encrypted_message");
        assert_eq!(descriptor["title"], "Alice");
        assert_eq!(descriptor["body"], "Encrypted message");
        assert_eq!(descriptor["destination"]["type"], "conversation");
        assert_eq!(descriptor["destination"]["conversation_id"], "01JCONV");

        let other = conversation_descriptor("Bob", "01JOTHER", 1);
        assert_eq!(descriptor["body"], other["body"]);

        let rendered = descriptor.to_string();
        for leaked in ["epoch", "count", "unread", "length", "guild", "channel", "ciphertext"] {
            assert!(!rendered.contains(leaked), "descriptor mentions {leaked}");
        }
    }
}

#[cfg(test)]
mod notification_target_tests {
    use super::{merge_notification_targets, WakeUrgency};

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn direct_mentions_take_precedence_over_replies() {
        let targets = merge_notification_targets(
            "@alice:home.example",
            &ids(&["@bob:home.example", "@everyone"]),
            Some("@bob:home.example".into()),
        );
        assert_eq!(
            targets,
            vec![("@bob:home.example".into(), "mention")]
        );
    }

    #[test]
    fn replies_are_targets_and_synthetic_broadcast_marker_never_is() {
        let targets = merge_notification_targets(
            "@alice:home.example",
            &ids(&["@everyone"]),
            Some("@carol:home.example".into()),
        );
        assert_eq!(
            targets,
            vec![("@carol:home.example".into(), "reply")]
        );
        assert!(targets.iter().all(|(user_id, _)| user_id != "@everyone"));
    }

    #[test]
    fn native_chat_doorbells_keep_high_priority_independent_of_call_presentation() {
        for transport in ["native-webpush", "relay"] {
            assert_eq!(WakeUrgency::Routine.header(transport), "high");
            assert_eq!(WakeUrgency::IncomingCall.header(transport), "high");
        }
        assert_eq!(WakeUrgency::Routine.header("webpush"), "normal");
        assert_eq!(WakeUrgency::IncomingCall.header("webpush"), "high");
    }
}
