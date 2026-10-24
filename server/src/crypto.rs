use crate::error::{ApiError, ApiResult};
use crate::util::{b64, now_ms, unb64};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use telium_protocol as proto;

#[derive(Clone)]
pub struct ServerKey {
    pub key_id: String,
    pub signing: SigningKey,
    pub valid_from: i64,
    pub valid_until: i64,
}

impl ServerKey {
    pub fn public_b64(&self) -> String {
        b64(self.signing.verifying_key().as_bytes())
    }
}

pub async fn load_or_create_key(pool: &SqlitePool, validity_secs: i64) -> anyhow::Result<ServerKey> {
    let now = now_ms();
    let row: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT key_id, secret_b64, valid_from, valid_until FROM server_keys \
         WHERE valid_until > ? AND domain IS NULL ORDER BY valid_until DESC LIMIT 1",
    )
    .bind(now)
    .fetch_optional(pool)
    .await?;

    if let Some((key_id, secret_b64, valid_from, valid_until)) = row {
        let bytes: [u8; 32] = unb64(&secret_b64)
            .and_then(|v| v.try_into().ok())
            .ok_or_else(|| anyhow::anyhow!("stored signing key {key_id} is malformed"))?;
        // Warn before the key window closes: the server keeps signing but peers reject it, with no local symptom.
        let remaining_ms = valid_until - now;
        const WARN_WITHIN_MS: i64 = 14 * 24 * 60 * 60 * 1000;
        if remaining_ms < WARN_WITHIN_MS {
            let days = remaining_ms / (24 * 60 * 60 * 1000);
            tracing::warn!(
                target: crate::logcat::FEDERATION,
                %key_id,
                days_remaining = days,
                "the federation signing key's validity window closes in {days} day(s). When it \
                 does, this server keeps signing with it and every peer starts rejecting those \
                 signatures, with no error on this side. Run `telium-server keys rotate` and \
                 restart; both keys stay published in the meantime, so nothing has to happen in \
                 a particular order. See docs/runbooks/rotating-a-secret.md."
            );
        }
        return Ok(ServerKey {
            key_id,
            signing: SigningKey::from_bytes(&bytes),
            valid_from,
            valid_until,
        });
    }

    let secret: [u8; 32] = rand::random();
    let signing = SigningKey::from_bytes(&secret);
    let key_id = format!("ed25519:{}", &crate::util::random_token(6));
    let valid_until = now + validity_secs * 1000;
    sqlx::query(
        "INSERT INTO server_keys (key_id, secret_b64, public_b64, valid_from, valid_until) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&key_id)
    .bind(b64(&secret))
    .bind(b64(signing.verifying_key().as_bytes()))
    .bind(now)
    .bind(valid_until)
    .execute(pool)
    .await?;

    tracing::info!(target: crate::logcat::FEDERATION, %key_id, "generated federation signing key");
    Ok(ServerKey { key_id, signing, valid_from: now, valid_until })
}

/// Mints a new signing key for the next start; the old one stays published until its window ends.
pub async fn rotate_key(
    pool: &SqlitePool,
    validity_secs: i64,
    retire_current: bool,
) -> anyhow::Result<(String, Option<String>)> {
    let now = now_ms();
    let current: Option<(String, i64)> = sqlx::query_as(
        "SELECT key_id, valid_until FROM server_keys WHERE valid_until > ? AND domain IS NULL \
         ORDER BY valid_until DESC LIMIT 1",
    )
    .bind(now)
    .fetch_optional(pool)
    .await?;

    let secret: [u8; 32] = rand::random();
    let signing = SigningKey::from_bytes(&secret);
    let key_id = format!("ed25519:{}", &crate::util::random_token(6));
    // Strictly later than existing keys: `load_or_create_key` picks by `valid_until DESC`, so otherwise rotation could be a no-op.
    let floor = current.as_ref().map(|(_, until)| *until).unwrap_or(0);
    let valid_until = (now + validity_secs * 1000).max(floor + 1000);
    sqlx::query(
        "INSERT INTO server_keys (key_id, secret_b64, public_b64, valid_from, valid_until) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&key_id)
    .bind(b64(&secret))
    .bind(b64(signing.verifying_key().as_bytes()))
    .bind(now)
    .bind(valid_until)
    .execute(pool)
    .await?;

    let retired = match (&current, retire_current) {
        (Some((old, _)), true) => {
            sqlx::query("UPDATE server_keys SET valid_until = ? WHERE key_id = ?")
                .bind(now)
                .bind(old)
                .execute(pool)
                .await?;
            Some(old.clone())
        }
        _ => None,
    };
    tracing::warn!(target: crate::logcat::FEDERATION, new_key = %key_id, retired = ?retired, "federation signing key rotated");
    Ok((key_id, retired))
}

/// Blanks the secret of every expired key; the public half stays for historical verification. Rows with a `domain` are left alone.
pub async fn forget_expired_secrets(pool: &SqlitePool) -> anyhow::Result<u64> {
    let done = sqlx::query(
        "UPDATE server_keys SET secret_b64 = '' \
         WHERE valid_until <= ? AND domain IS NULL AND secret_b64 <> ''",
    )
    .bind(now_ms())
    .execute(pool)
    .await?;
    Ok(done.rows_affected())
}

pub async fn published_keys(pool: &SqlitePool) -> ApiResult<Vec<(String, String, i64, i64)>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT key_id, public_b64, valid_from, valid_until FROM server_keys \
         WHERE valid_until > ? AND domain IS NULL ORDER BY valid_from",
    )
    .bind(now_ms())
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Historical public keys, including expired ones, with their validity windows.
pub async fn historical_keys(pool: &SqlitePool) -> ApiResult<Vec<(String, String, i64, i64)>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT key_id, public_b64, valid_from, valid_until FROM server_keys WHERE domain IS NULL ORDER BY valid_from",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Attaches `{key_id, signature}`; signs the canonical form with prior signature fields removed.
pub fn sign_json(key: &ServerKey, value: Value) -> Value {
    sign_json_impl(&key.signing, &key.key_id, value)
}

fn sign_json_impl(signing: &SigningKey, key_id: &str, value: Value) -> Value {
    proto::sign_json(signing, key_id, value)
}

pub fn verify_json(public_b64: &str, value: &Value) -> bool {
    proto::verify_json(public_b64, value)
}

pub fn verify_bytes(public_b64: &str, message: &[u8], sig_b64: &str) -> bool {
    proto::verify_bytes(public_b64, message, sig_b64)
}

/// Short-lived token a client presents to a guild server; `audience` stops replay against another guild.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssertionClaims {
    pub user_id: String,
    pub device_id: String,
    pub device_pubkey: String,
    pub audience: String,
    pub origin: String,
    pub profile_version: i64,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_ref: Option<String>,
    pub iat: i64,
    pub exp: i64,
}

pub fn issue_assertion(key: &ServerKey, claims: &AssertionClaims) -> String {
    let payload = serde_json::to_vec(claims).expect("claims are serialisable");
    let sig = key.signing.sign(&payload);
    format!("{}.{}.{}", b64(&payload), b64(&sig.to_bytes()), key.key_id)
}

/// Peeks at issuer and key id without verifying; key resolution is async, `verify_assertion` is pure.
pub fn assertion_parts(token: &str) -> ApiResult<(String, String)> {
    let mut parts = token.split('.');
    let (Some(payload_b64), Some(_sig), Some(key_id), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ApiError::Unauthorized("malformed identity assertion".into()));
    };
    let payload = unb64(payload_b64)
        .ok_or_else(|| ApiError::Unauthorized("assertion payload is not base64".into()))?;
    let claims: AssertionClaims = serde_json::from_slice(&payload)
        .map_err(|_| ApiError::Unauthorized("assertion payload is not valid claims".into()))?;
    Ok((claims.origin, key_id.to_string()))
}

/// Verifies structure, signature, audience and expiry.
pub fn verify_assertion(
    token: &str,
    expected_audience: &str,
    resolve_key: impl Fn(&str, &str) -> Option<String>,
) -> ApiResult<AssertionClaims> {
    let mut parts = token.split('.');
    let (Some(payload_b64), Some(sig_b64), Some(key_id), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(ApiError::Unauthorized("malformed identity assertion".into()));
    };

    let payload = unb64(payload_b64)
        .ok_or_else(|| ApiError::Unauthorized("assertion payload is not base64".into()))?;
    let claims: AssertionClaims = serde_json::from_slice(&payload)
        .map_err(|_| ApiError::Unauthorized("assertion payload is not valid claims".into()))?;

    let public = resolve_key(&claims.origin, key_id).ok_or_else(|| {
        ApiError::Unauthorized(format!(
            "no published key {key_id} for origin {}",
            claims.origin
        ))
    })?;

    if !verify_bytes(&public, &payload, sig_b64) {
        return Err(ApiError::Unauthorized("assertion signature is invalid".into()));
    }
    if claims.audience != expected_audience {
        return Err(ApiError::Unauthorized(format!(
            "assertion audience {} is not {expected_audience}",
            claims.audience
        )));
    }
    let now = now_ms();
    if claims.exp <= now {
        return Err(ApiError::Unauthorized("assertion has expired".into()));
    }
    if claims.iat > now + 60_000 {
        return Err(ApiError::Unauthorized("assertion is not yet valid".into()));
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> ServerKey {
        let secret: [u8; 32] = rand::random();
        ServerKey {
            key_id: "ed25519:test".into(),
            signing: SigningKey::from_bytes(&secret),
            valid_from: 0,
            valid_until: i64::MAX,
        }
    }

    fn claims(audience: &str, exp_offset: i64) -> AssertionClaims {
        AssertionClaims {
            user_id: "@alice:home.example".into(),
            device_id: "dev1".into(),
            device_pubkey: "AAAA".into(),
            audience: audience.into(),
            origin: "home.example".into(),
            profile_version: 3,
            display_name: "Alice".into(),
            avatar_ref: None,
            iat: now_ms(),
            exp: now_ms() + exp_offset,
        }
    }

    #[test]
    fn assertion_round_trips() {
        let key = test_key();
        let token = issue_assertion(&key, &claims("guilds.example", 300_000));
        let pk = key.public_b64();
        let out = verify_assertion(&token, "guilds.example", |_, _| Some(pk.clone())).unwrap();
        assert_eq!(out.user_id, "@alice:home.example");
        assert_eq!(out.profile_version, 3);
    }

    #[test]
    fn assertion_is_bound_to_its_audience() {
        let key = test_key();
        let token = issue_assertion(&key, &claims("guilds.example", 300_000));
        let pk = key.public_b64();
        let err = verify_assertion(&token, "other.example", |_, _| Some(pk.clone()));
        assert!(matches!(err, Err(ApiError::Unauthorized(_))));
    }

    #[test]
    fn expired_assertion_is_rejected() {
        let key = test_key();
        let token = issue_assertion(&key, &claims("guilds.example", -1000));
        let pk = key.public_b64();
        assert!(verify_assertion(&token, "guilds.example", |_, _| Some(pk.clone())).is_err());
    }

    #[test]
    fn tampered_assertion_is_rejected() {
        let key = test_key();
        let token = issue_assertion(&key, &claims("guilds.example", 300_000));
        let mut parts: Vec<&str> = token.split('.').collect();
        let mut other = claims("guilds.example", 300_000);
        other.user_id = "@mallory:home.example".into();
        let forged = serde_json::to_vec(&other).unwrap();
        let forged_b64 = b64(&forged);
        parts[0] = &forged_b64;
        let pk = key.public_b64();
        let tampered = format!("{}.{}.{}", parts[0], parts[1], parts[2]);
        assert!(verify_assertion(&tampered, "guilds.example", |_, _| Some(pk.clone())).is_err());
    }

    #[test]
    fn signed_json_round_trips_and_detects_edits() {
        let key = test_key();
        let signed = sign_json(&key, serde_json::json!({"display_name": "Alice", "v": 2}));
        assert!(verify_json(&key.public_b64(), &signed));
        let mut edited = signed.clone();
        edited["display_name"] = serde_json::json!("Mallory");
        assert!(!verify_json(&key.public_b64(), &edited));
    }
}
