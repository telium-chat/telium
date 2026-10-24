
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, hash_token, now_ms, random_token, ulid, unb64};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;

pub const ALGORITHM_V1: &str = "P256-HKDF-SHA256-A256GCM";
pub const MAX_CIPHERTEXT_JSON_BYTES: usize = 16 * 1024;
pub const MAX_NOTIFICATION_KIND_BYTES: usize = 64;
pub const MAX_SOURCE_ID_BYTES: usize = 256;
pub const MAX_INBOX_PAGE: i64 = 100;
pub const DEFAULT_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

const COALESCE_KEY_BYTES: usize = 16;

const MAX_COALESCE_HINT_BYTES: usize = 64;

const FEDERATED_NOTIFICATION_USER_BURST: f64 = 32.0;
const FEDERATED_NOTIFICATION_USER_PER_SEC: f64 = 4.0;
const FEDERATED_NOTIFICATION_ORIGIN_BURST: f64 = 256.0;
const FEDERATED_NOTIFICATION_ORIGIN_PER_SEC: f64 = 32.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationEnvelope {
    pub v: u8,
    pub alg: String,
    pub ephemeral: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceKey {
    pub device_id: String,
    pub algorithm: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FederatedEnvelope {
    pub device_id: String,
    pub ciphertext: Value,
}

#[derive(Debug, Clone)]
pub struct BackgroundAuth {
    pub user_id: String,
    pub device_id: String,
}

pub fn aad(
    user_id: &str,
    device_id: &str,
    origin: &str,
    source_id: &str,
    guild_id: Option<&str>,
    kind: &str,
) -> Vec<u8> {
    let mut out = b"telium-notification-v1".to_vec();
    for part in [user_id, device_id, origin, source_id, guild_id.unwrap_or(""), kind] {
        let bytes = part.as_bytes();
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

pub fn coalesce_bucket(parts: &[&str]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"telium-notification-coalesce-v1");
    for part in parts {
        hasher.update(&(part.len() as u32).to_be_bytes());
        hasher.update(part.as_bytes());
    }
    b64(&hasher.finalize().as_bytes()[..COALESCE_KEY_BYTES])
}

fn checked_bucket_hint(hint: Option<&str>) -> ApiResult<Option<String>> {
    let Some(hint) = hint.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if hint.len() > MAX_COALESCE_HINT_BYTES
        || !hint
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
    {
        return Err(ApiError::BadRequest(
            "notification coalescing hint is malformed".into(),
        ));
    }
    Ok(Some(hint.to_string()))
}

pub fn validate_public_key(algorithm: &str, public_key_b64: &str) -> ApiResult<PublicKey> {
    if algorithm != ALGORITHM_V1 {
        return Err(ApiError::BadRequest("unsupported notification encryption algorithm".into()));
    }
    let bytes = unb64(public_key_b64)
        .ok_or_else(|| ApiError::BadRequest("notification public key is malformed".into()))?;
    PublicKey::from_sec1_bytes(&bytes)
        .map_err(|_| ApiError::BadRequest("notification public key is not a P-256 key".into()))
}

pub fn seal_descriptor(
    recipient_public_key_b64: &str,
    associated_data: &[u8],
    plaintext: &[u8],
) -> ApiResult<NotificationEnvelope> {
    if plaintext.len() > MAX_CIPHERTEXT_JSON_BYTES / 2 {
        return Err(ApiError::BadRequest("notification descriptor is too large".into()));
    }
    let recipient = validate_public_key(ALGORITHM_V1, recipient_public_key_b64)?;
    let ephemeral = SecretKey::random(&mut OsRng);
    let ephemeral_public = ephemeral.public_key().to_sec1_bytes().to_vec();
    let shared = p256::ecdh::diffie_hellman(
        ephemeral.to_nonzero_scalar(),
        recipient.as_affine(),
    );

    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);

    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes());
    let mut key = [0u8; 32];
    let mut info = b"Telium notification v1\0".to_vec();
    info.extend_from_slice(associated_data);
    hkdf.expand(&info, &mut key)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("notification key derivation failed")))?;

    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("notification cipher setup failed")))?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload { msg: plaintext, aad: associated_data },
        )
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("notification encryption failed")))?;

    Ok(NotificationEnvelope {
        v: 1,
        alg: ALGORITHM_V1.into(),
        ephemeral: b64(&ephemeral_public),
        salt: b64(&salt),
        nonce: b64(&nonce),
        ciphertext: b64(&ciphertext),
    })
}

pub(crate) fn parse_envelope(value: &Value) -> ApiResult<NotificationEnvelope> {
    if value.to_string().len() > MAX_CIPHERTEXT_JSON_BYTES {
        return Err(ApiError::BadRequest("notification envelope is too large".into()));
    }
    let envelope: NotificationEnvelope = serde_json::from_value(value.clone())
        .map_err(|_| ApiError::BadRequest("notification envelope is malformed".into()))?;
    if envelope.v != 1 || envelope.alg != ALGORITHM_V1 {
        return Err(ApiError::BadRequest("unsupported notification envelope version".into()));
    }
    if unb64(&envelope.salt).is_none_or(|v| v.len() != 16)
        || unb64(&envelope.nonce).is_none_or(|v| v.len() != 12)
        || unb64(&envelope.ciphertext).is_none()
    {
        return Err(ApiError::BadRequest("notification envelope encoding is malformed".into()));
    }
    let ephemeral = unb64(&envelope.ephemeral)
        .ok_or_else(|| ApiError::BadRequest("notification envelope key is malformed".into()))?;
    PublicKey::from_sec1_bytes(&ephemeral)
        .map_err(|_| ApiError::BadRequest("notification envelope key is not P-256".into()))?;
    Ok(envelope)
}

pub async fn register_device(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    algorithm: &str,
    public_key_b64: &str,
) -> ApiResult<String> {
    validate_public_key(algorithm, public_key_b64)?;
    let active: Option<i64> = sqlx::query_scalar(
        "SELECT active FROM devices WHERE device_id = ? AND user_id = ?",
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    if active != Some(1) {
        return Err(ApiError::Unauthorized("notification device is not active".into()));
    }

    let token = random_token(32);
    let token_hash = hash_token(&token);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO notification_devices \
            (user_id, device_id, algorithm, public_key_b64, background_token_hash, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, device_id) DO UPDATE SET \
            algorithm = excluded.algorithm, public_key_b64 = excluded.public_key_b64, \
            background_token_hash = excluded.background_token_hash, updated_at = excluded.updated_at",
    )
    .bind(user_id)
    .bind(device_id)
    .bind(algorithm)
    .bind(public_key_b64)
    .bind(token_hash)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    Ok(token)
}

pub async fn authenticate_background(state: &AppState, token: &str) -> ApiResult<BackgroundAuth> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT n.user_id, n.device_id, d.active \
         FROM notification_devices n JOIN devices d ON d.device_id = n.device_id \
         WHERE n.background_token_hash = ? AND d.user_id = n.user_id",
    )
    .bind(hash_token(token))
    .fetch_optional(&state.pool)
    .await?;
    let (user_id, device_id, active) =
        row.ok_or_else(|| ApiError::Unauthorized("unknown notification credential".into()))?;
    if active != 1 {
        return Err(ApiError::Unauthorized("notification device is revoked".into()));
    }
    Ok(BackgroundAuth { user_id, device_id })
}

async fn require_guild_authority(
    state: &AppState,
    origin: &str,
    user_id: &str,
    guild_id: &str,
) -> ApiResult<()> {
    if !crate::federation::is_local(state, user_id) {
        return Err(ApiError::NotFound("notification recipient is not local".into()));
    }

    let exists: Option<i64> = if origin == state.cfg.server_name {
        sqlx::query_scalar(
            "SELECT 1 FROM members WHERE user_id = ? AND guild_id = ? AND banned = 0",
        )
        .bind(user_id)
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT 1 FROM remote_memberships \
             WHERE user_id = ? AND guild_server = ? AND guild_id = ?",
        )
        .bind(user_id)
        .bind(origin)
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?
    };

    if exists.is_none() {
        return Err(ApiError::Forbidden(
            "notification origin is not an authoritative guild membership for this user".into(),
        ));
    }
    Ok(())
}

pub async fn keys_for_guild(
    state: &AppState,
    origin: &str,
    user_id: &str,
    guild_id: &str,
) -> ApiResult<Vec<DeviceKey>> {
    require_guild_authority(state, origin, user_id, guild_id).await?;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT n.device_id, n.algorithm, n.public_key_b64 \
         FROM notification_devices n JOIN devices d ON d.device_id = n.device_id \
         WHERE n.user_id = ? AND d.user_id = n.user_id AND d.active = 1 \
         ORDER BY n.device_id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, algorithm, public_key)| DeviceKey { device_id, algorithm, public_key })
        .collect())
}

pub(crate) async fn keys_for_local_user(
    state: &AppState,
    user_id: &str,
) -> ApiResult<Vec<DeviceKey>> {
    if !crate::federation::is_local(state, user_id) {
        return Err(ApiError::NotFound("notification recipient is not local".into()));
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT n.device_id, n.algorithm, n.public_key_b64 \
         FROM notification_devices n JOIN devices d ON d.device_id = n.device_id \
         WHERE n.user_id = ? AND d.user_id = n.user_id AND d.active = 1 \
         ORDER BY n.device_id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(device_id, algorithm, public_key)| DeviceKey { device_id, algorithm, public_key })
        .collect())
}

fn take_federated_user_budget_with_limits(
    limiter: &crate::ratelimit::RateLimiter,
    user_id: &str,
    burst: f64,
    per_sec: f64,
) -> ApiResult<()> {
    if let Err(retry) = limiter.take(
        format!("notification-user:{user_id}"),
        "notification-user",
        burst,
        per_sec,
    ) {
        return Err(ApiError::RateLimited(format!(
            "too many federated notifications for this user; try again in {retry:.0}s"
        )));
    }
    Ok(())
}

fn take_federated_origin_budget_with_limits(
    limiter: &crate::ratelimit::RateLimiter,
    origin: &str,
    burst: f64,
    per_sec: f64,
) -> ApiResult<()> {
    if let Err(retry) = limiter.take(
        format!("notification-origin:{origin}"),
        "notification-origin",
        burst,
        per_sec,
    ) {
        return Err(ApiError::RateLimited(format!(
            "too many federated notification events from this origin; try again in {retry:.0}s"
        )));
    }
    Ok(())
}

fn take_federated_user_budget(
    limiter: &crate::ratelimit::RateLimiter,
    user_id: &str,
) -> ApiResult<()> {
    take_federated_user_budget_with_limits(
        limiter,
        user_id,
        FEDERATED_NOTIFICATION_USER_BURST,
        FEDERATED_NOTIFICATION_USER_PER_SEC,
    )
}

fn take_federated_origin_budget(
    limiter: &crate::ratelimit::RateLimiter,
    origin: &str,
) -> ApiResult<()> {
    take_federated_origin_budget_with_limits(
        limiter,
        origin,
        FEDERATED_NOTIFICATION_ORIGIN_BURST,
        FEDERATED_NOTIFICATION_ORIGIN_PER_SEC,
    )
}

pub async fn enqueue_federated(
    state: &AppState,
    origin: &str,
    user_id: &str,
    guild_id: &str,
    source_id: &str,
    kind: &str,
    bucket_hint: Option<&str>,
    envelopes: &[FederatedEnvelope],
) -> ApiResult<Vec<String>> {
    require_guild_authority(state, origin, user_id, guild_id).await?;
    let bucket = match checked_bucket_hint(bucket_hint)? {
        Some(hint) => coalesce_bucket(&["guild", origin, guild_id, &hint]),
        None => coalesce_bucket(&["guild", origin, guild_id]),
    };
    enqueue(state, origin, user_id, Some(guild_id), source_id, kind, Some(&bucket), envelopes).await
}

pub async fn enqueue_local_conversation(
    state: &AppState,
    user_id: &str,
    conversation_id: &str,
    source_id: &str,
    kind: &str,
    envelopes: &[FederatedEnvelope],
) -> ApiResult<Vec<String>> {
    let origin = state.cfg.server_name.clone();
    let bucket = coalesce_bucket(&["conversation", conversation_id]);
    enqueue(state, &origin, user_id, None, source_id, kind, Some(&bucket), envelopes).await
}

#[allow(clippy::too_many_arguments)]
async fn enqueue(
    state: &AppState,
    origin: &str,
    user_id: &str,
    guild_id: Option<&str>,
    source_id: &str,
    kind: &str,
    coalesce_key: Option<&str>,
    envelopes: &[FederatedEnvelope],
) -> ApiResult<Vec<String>> {
    if source_id.is_empty() || source_id.len() > MAX_SOURCE_ID_BYTES {
        return Err(ApiError::BadRequest("invalid notification source_id".into()));
    }
    if kind.is_empty() || kind.len() > MAX_NOTIFICATION_KIND_BYTES {
        return Err(ApiError::BadRequest("invalid notification kind".into()));
    }
    if envelopes.is_empty() || envelopes.len() > 64 {
        return Err(ApiError::BadRequest("notification envelope count is invalid".into()));
    }

    if origin != state.cfg.server_name {
        let recipient_already_accepted: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM notification_inbox \
             WHERE user_id = ? AND origin = ? AND source_id = ? LIMIT 1",
        )
        .bind(user_id)
        .bind(origin)
        .bind(source_id)
        .fetch_optional(&state.pool)
        .await?;
        let source_already_accepted: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM notification_inbox \
             WHERE origin = ? AND source_id = ? LIMIT 1",
        )
        .bind(origin)
        .bind(source_id)
        .fetch_optional(&state.pool)
        .await?;

        if recipient_already_accepted.is_none() {
            take_federated_user_budget(&state.limiter, user_id)?;
        }
        if source_already_accepted.is_none() {
            take_federated_origin_budget(&state.limiter, origin)?;
        }
    }

    let now = now_ms();
    let expires = now + DEFAULT_RETENTION_MS;
    let mut inserted = Vec::new();
    for target in envelopes {
        let _ = parse_envelope(&target.ciphertext)?;
        let registered: Option<String> = sqlx::query_scalar(
            "SELECT n.algorithm FROM notification_devices n \
             JOIN devices d ON d.device_id = n.device_id \
             WHERE n.user_id = ? AND n.device_id = ? AND d.user_id = n.user_id AND d.active = 1",
        )
        .bind(user_id)
        .bind(&target.device_id)
        .fetch_optional(&state.pool)
        .await?;
        if registered.as_deref() != Some(ALGORITHM_V1) {
            continue;
        }
        let id = ulid();

        let mut tx = state.pool.begin().await?;
        let result = sqlx::query(
            "INSERT OR IGNORE INTO notification_inbox \
                (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, \
                 coalesce_key, created_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(user_id)
        .bind(&target.device_id)
        .bind(origin)
        .bind(source_id)
        .bind(kind)
        .bind(guild_id)
        .bind(target.ciphertext.to_string())
        .bind(coalesce_key)
        .bind(now)
        .bind(expires)
        .execute(&mut *tx)
        .await?;

        if result.rows_affected() != 1 {
            tx.rollback().await?;
            continue;
        }

        if let Some(bucket) = coalesce_key {
            let (superseding, carried): (i64, i64) = sqlx::query_as(
                "SELECT COUNT(*), COALESCE(SUM(coalesced), 0) FROM notification_inbox \
                 WHERE user_id = ? AND device_id = ? AND coalesce_key = ? \
                   AND superseded_at IS NULL AND id <> ?",
            )
            .bind(user_id)
            .bind(&target.device_id)
            .bind(bucket)
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;

            if superseding > 0 {
                sqlx::query("UPDATE notification_inbox SET coalesced = ? WHERE id = ?")
                    .bind(superseding + carried)
                    .bind(&id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    "UPDATE notification_inbox SET superseded_at = ? \
                     WHERE user_id = ? AND device_id = ? AND coalesce_key = ? \
                       AND superseded_at IS NULL AND id <> ?",
                )
                .bind(now)
                .bind(user_id)
                .bind(&target.device_id)
                .bind(bucket)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            }
        }

        tx.commit().await?;
        inserted.push(target.device_id.clone());
    }
    Ok(inserted)
}

pub async fn pull(
    state: &AppState,
    auth: &BackgroundAuth,
    after: Option<&str>,
    limit: i64,
) -> ApiResult<Value> {
    let _ = sqlx::query("DELETE FROM notification_inbox WHERE expires_at <= ?")
        .bind(now_ms())
        .execute(&state.pool)
        .await;
    let limit = limit.clamp(1, MAX_INBOX_PAGE);

    type Row = (String, String, String, String, Option<String>, String, Option<String>, i64, i64);
    let rows: Vec<Row> = if let Some(after) = after {
        sqlx::query_as(
            "SELECT id, origin, source_id, kind, guild_id, ciphertext, coalesce_key, coalesced, created_at \
             FROM notification_inbox WHERE user_id = ? AND device_id = ? AND id > ? \
               AND superseded_at IS NULL \
             ORDER BY id ASC LIMIT ?",
        )
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .bind(after)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, origin, source_id, kind, guild_id, ciphertext, coalesce_key, coalesced, created_at \
             FROM notification_inbox WHERE user_id = ? AND device_id = ? \
               AND superseded_at IS NULL \
             ORDER BY id ASC LIMIT ?",
        )
        .bind(&auth.user_id)
        .bind(&auth.device_id)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    };
    let mut cursor = after.map(str::to_string);
    let notifications = rows
        .into_iter()
        .map(|(id, origin, source_id, kind, guild_id, ciphertext, coalesce_key, coalesced, created_at)| {
            cursor = Some(id.clone());
            json!({
                "id": id,
                "origin": origin,
                "source_id": source_id,
                "kind": kind,
                "guild_id": guild_id,
                "ciphertext": serde_json::from_str::<Value>(&ciphertext).unwrap_or(Value::Null),
                "coalesce_key": coalesce_key,
                "coalesced": coalesced,
                "created_at": created_at,
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "notifications": notifications, "cursor": cursor }))
}

pub async fn ack(state: &AppState, auth: &BackgroundAuth, through: &str) -> ApiResult<u64> {
    if through.is_empty() || through.len() > 64 {
        return Err(ApiError::BadRequest("invalid notification cursor".into()));
    }
    Ok(sqlx::query(
        "DELETE FROM notification_inbox WHERE user_id = ? AND device_id = ? AND id <= ?",
    )
    .bind(&auth.user_id)
    .bind(&auth.device_id)
    .bind(through)
    .execute(&state.pool)
    .await?
    .rows_affected())
}

pub async fn retire_moved_account(
    state: &AppState,
    user_id: &str,
) -> ApiResult<(u64, u64, u64, u64)> {
    let mut tx = state.pool.begin().await?;
    let inbox = sqlx::query("DELETE FROM notification_inbox WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let dm_hints = sqlx::query("DELETE FROM dm_notification_hints WHERE recipient_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let devices = sqlx::query("DELETE FROM notification_devices WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    let push = sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    tx.commit().await?;
    Ok((inbox, devices, push, dm_hints))
}
pub async fn revoke_device(state: &AppState, user_id: &str, device_id: &str) -> ApiResult<()> {
    sqlx::query(
        "DELETE FROM dm_notification_hints WHERE recipient_id = ? AND device_id = ?",
    )
    .bind(user_id)
    .bind(device_id)
    .execute(&state.pool)
    .await?;
    sqlx::query("DELETE FROM notification_devices WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(device_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM notification_inbox WHERE user_id = ? AND device_id = ?")
        .bind(user_id)
        .bind(device_id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_for_test(
        recipient: &SecretKey,
        envelope: &NotificationEnvelope,
        associated_data: &[u8],
    ) -> Result<Vec<u8>, ()> {
        let ephemeral_bytes = unb64(&envelope.ephemeral).ok_or(())?;
        let ephemeral = PublicKey::from_sec1_bytes(&ephemeral_bytes).map_err(|_| ())?;
        let shared = p256::ecdh::diffie_hellman(recipient.to_nonzero_scalar(), ephemeral.as_affine());
        let salt = unb64(&envelope.salt).ok_or(())?;
        let nonce = unb64(&envelope.nonce).ok_or(())?;
        let ciphertext = unb64(&envelope.ciphertext).ok_or(())?;
        let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes());
        let mut key = [0u8; 32];
        let mut info = b"Telium notification v1\0".to_vec();
        info.extend_from_slice(associated_data);
        hkdf.expand(&info, &mut key).map_err(|_| ())?;
        Aes256Gcm::new_from_slice(&key)
            .map_err(|_| ())?
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload { msg: &ciphertext, aad: associated_data },
            )
            .map_err(|_| ())
    }

    #[test]
    fn notification_envelope_round_trips_and_binds_routing_metadata() {
        let recipient = SecretKey::random(&mut OsRng);
        let public = b64(recipient.public_key().to_sec1_bytes().as_ref());
        let meta = aad(
            "@bob:bob.example",
            "phone",
            "guild.example",
            "message-1",
            Some("guild-1"),
            "mention",
        );
        let plain = br#"{"v":1,"title":"Alice","body":"hello @bob"}"#;
        let envelope = seal_descriptor(&public, &meta, plain).unwrap();
        assert_eq!(open_for_test(&recipient, &envelope, &meta).unwrap(), plain);

        let wrong = aad(
            "@bob:bob.example",
            "phone",
            "evil.example",
            "message-1",
            Some("guild-1"),
            "mention",
        );
        assert!(open_for_test(&recipient, &envelope, &wrong).is_err());
    }

    #[test]
    fn malformed_public_keys_and_envelopes_are_rejected() {
        assert!(validate_public_key(ALGORITHM_V1, "not-a-key").is_err());
        assert!(validate_public_key("future-algorithm", "whatever").is_err());
        assert!(parse_envelope(&json!({
            "v": 1,
            "alg": ALGORITHM_V1,
            "ephemeral": "bad",
            "salt": "bad",
            "nonce": "bad",
            "ciphertext": "bad"
        })).is_err());
    }

    #[test]
    fn federated_user_budget_is_recipient_scoped() {
        let limiter = crate::ratelimit::RateLimiter::new(crate::config::RateLimit::default());

        for _ in 0..2 {
            take_federated_user_budget_with_limits(
                &limiter,
                "@bob:home.example",
                2.0,
                0.000_001,
            )
            .unwrap();
        }
        assert!(matches!(
            take_federated_user_budget_with_limits(
                &limiter,
                "@bob:home.example",
                2.0,
                0.000_001,
            ),
            Err(ApiError::RateLimited(_))
        ));

        take_federated_user_budget_with_limits(
            &limiter,
            "@carol:home.example",
            2.0,
            0.000_001,
        )
        .expect("one recipient must not spend another recipient's budget");
    }

    #[test]
    fn federated_origin_budget_is_event_scoped_and_origin_scoped() {
        let limiter = crate::ratelimit::RateLimiter::new(crate::config::RateLimit::default());

        for _ in 0..2 {
            take_federated_origin_budget_with_limits(
                &limiter,
                "guild-a.example",
                2.0,
                0.000_001,
            )
            .unwrap();
        }
        assert!(matches!(
            take_federated_origin_budget_with_limits(
                &limiter,
                "guild-a.example",
                2.0,
                0.000_001,
            ),
            Err(ApiError::RateLimited(_))
        ));

        take_federated_origin_budget_with_limits(
            &limiter,
            "guild-b.example",
            2.0,
            0.000_001,
        )
        .expect("one verified origin must not spend another origin's event budget");
    }
}
