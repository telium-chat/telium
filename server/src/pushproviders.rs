
use crate::config::Config;
use crate::state::AppState;
use crate::util::{b64, now_ms};
use p256::ecdsa::signature::Signer as _;
use rsa::signature::SignatureEncoding;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";

const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

const TOKEN_REFRESH_MARGIN_MS: i64 = 120_000;

const FCM_DEFAULT_BASE: &str = "https://fcm.googleapis.com";

const APNS_PRODUCTION_BASE: &str = "https://api.push.apple.com";
const APNS_SANDBOX_BASE: &str = "https://api.sandbox.push.apple.com";

fn checked_origin(key: &str, raw: &str, allow_http: bool) -> anyhow::Result<String> {
    let origin = raw.trim().trim_end_matches('/');
    if origin.is_empty() {
        anyhow::bail!("{key} is set to an empty string; remove the line instead");
    }
    if origin.starts_with("http://") {
        if !allow_http {
            anyhow::bail!(
                "{key} is {origin:?}, which is plaintext http. Push wakes carry no content, \
                 but the origin they are sent to is where every device on this server can be \
                 silently stopped from being woken, so a non-TLS override is refused unless \
                 `federation.allow_http = true` says this process is talking to a local test \
                 rig. If this is a production server, the answer is to remove {key} entirely: \
                 unset is the correct value for every deployment that talks to the real \
                 provider."
            );
        }
        return Ok(origin.to_string());
    }
    if origin.starts_with("https://") {
        return Ok(origin.to_string());
    }
    anyhow::bail!(
        "{key} is {origin:?}; it must start with a scheme — \"https://fcm.example\", not a \
         bare host"
    )
}

const APNS_TOKEN_LIFETIME_MS: i64 = 50 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    Retry,
    Gone,
}

#[derive(Debug, Clone, Deserialize)]
struct ServiceAccount {
    #[serde(default)]
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: String,
}

struct CachedToken {
    token: String,
    good_until: i64,
}

pub struct Fcm {
    project_id: String,
    client_email: String,
    signing: rsa::pkcs1v15::SigningKey<sha2::Sha256>,
    token_uri: String,
    base_url: String,
    access: Mutex<Option<CachedToken>>,
}

impl Fcm {
    fn load(cfg: &crate::config::Fcm, allow_http: bool) -> anyhow::Result<Self> {
        let path = cfg.service_account_file.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "[push.fcm] is enabled but push.fcm.service_account_file is not set. \
                 FCM HTTP v1 cannot be reached without the service-account JSON from the \
                 Firebase project this server's Android build was compiled against."
            )
        })?;
        let raw = std::fs::read_to_string(path).map_err(|e| {
            anyhow::anyhow!("could not read the FCM service account at {}: {e}", path.display())
        })?;
        let account: ServiceAccount = serde_json::from_str(&raw).map_err(|e| {
            anyhow::anyhow!("{} is not a Google service-account JSON: {e}", path.display())
        })?;

        let configured = cfg.project_id.trim();
        if configured.is_empty() {
            anyhow::bail!(
                "[push.fcm] is enabled but push.fcm.project_id is not set. It must match the \
                 project_id inside the service-account JSON."
            );
        }
        if !account.project_id.is_empty() && account.project_id != configured {
            anyhow::bail!(
                "push.fcm.project_id is {configured} but the service account at {} belongs to \
                 project {}. One of the two is from a different Firebase project.",
                path.display(),
                account.project_id
            );
        }

        use rsa::pkcs8::DecodePrivateKey;
        let key = rsa::RsaPrivateKey::from_pkcs8_pem(&account.private_key).map_err(|e| {
            anyhow::anyhow!(
                "the private_key in {} is not a PKCS#8 RSA key: {e}",
                path.display()
            )
        })?;

        let token_uri = match cfg.token_url.as_deref() {
            Some(raw) => checked_origin("push.fcm.token_url", raw, allow_http)?,
            None if !account.token_uri.is_empty() => account.token_uri,
            None => GOOGLE_TOKEN_URI.to_string(),
        };
        let base_url = match cfg.base_url.as_deref() {
            Some(raw) => checked_origin("push.fcm.base_url", raw, allow_http)?,
            None => FCM_DEFAULT_BASE.to_string(),
        };

        Ok(Fcm {
            project_id: configured.to_string(),
            client_email: account.client_email,
            signing: rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(key),
            token_uri,
            base_url,
            access: Mutex::new(None),
        })
    }

    fn assertion(&self, now_secs: i64) -> anyhow::Result<String> {
        let header = b64(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = json!({
            "iss": self.client_email,
            "scope": FCM_SCOPE,
            "aud": self.token_uri,
            "iat": now_secs,
            "exp": now_secs + 3600,
        });
        let signing_input = format!("{header}.{}", b64(claims.to_string().as_bytes()));
        let signature = self.signing.try_sign(signing_input.as_bytes())?;
        Ok(format!("{signing_input}.{}", b64(&signature.to_bytes())))
    }

    async fn access_token(&self, http: &reqwest::Client) -> anyhow::Result<String> {
        let mut cached = self.access.lock().await;
        let now = now_ms();
        if let Some(token) = cached.as_ref() {
            if token.good_until > now {
                return Ok(token.token.clone());
            }
        }

        let assertion = self.assertion(now / 1000)?;
        let response = http
            .post(&self.token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", &assertion),
            ])
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            anyhow::bail!(
                "FCM token endpoint refused this service account ({status}): {}",
                body.get("error_description")
                    .or_else(|| body.get("error"))
                    .and_then(Value::as_str)
                    .unwrap_or("no reason given")
            );
        }
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("FCM token response had no access_token"))?
            .to_string();
        let lifetime_ms = body.get("expires_in").and_then(Value::as_i64).unwrap_or(3600) * 1000;
        *cached = Some(CachedToken {
            token: token.clone(),
            good_until: now + (lifetime_ms - TOKEN_REFRESH_MARGIN_MS).max(0),
        });
        Ok(token)
    }

    fn send_url(&self) -> String {
        format!("{}/v1/projects/{}/messages:send", self.base_url, self.project_id)
    }
}

fn fcm_message(token: &str, body: &Value) -> Value {
    json!({
        "message": {
            "token": token,
            "data": { "telium": body.to_string() },
            "android": {
                "priority": "HIGH",
                "ttl": "86400s",
            },
        }
    })
}

fn fcm_outcome(status: u16, body: &Value) -> Outcome {
    if (200..300).contains(&status) {
        return Outcome::Delivered;
    }
    let detail = body
        .pointer("/error/details/0/errorCode")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(detail, "UNREGISTERED" | "INVALID_ARGUMENT" | "SENDER_ID_MISMATCH") {
        return Outcome::Gone;
    }
    match status {
        404 => Outcome::Gone,
        401 | 403 => {
            tracing::error!(
                target: crate::logcat::PUSH,
                "FCM refused this server's credential; no Android device with an FCM token \
                 can be woken until push.fcm is fixed"
            );
            Outcome::Retry
        }
        _ => Outcome::Retry,
    }
}

pub struct Apns {
    team_id: String,
    key_id: String,
    bundle_id: String,
    signing: p256::ecdsa::SigningKey,
    base_url: String,
    provider_token: Mutex<Option<CachedToken>>,
}

impl Apns {
    fn load(cfg: &crate::config::Apns, allow_http: bool) -> anyhow::Result<Self> {
        let path = cfg.key_file.as_ref().ok_or_else(|| {
            anyhow::anyhow!(
                "[push.apns] is enabled but push.apns.key_file is not set. APNs cannot be \
                 reached without the .p8 key issued to the Apple developer team that signs \
                 this server's iOS build."
            )
        })?;
        for (name, value) in
            [("team_id", &cfg.team_id), ("key_id", &cfg.key_id), ("bundle_id", &cfg.bundle_id)]
        {
            if value.trim().is_empty() {
                anyhow::bail!("[push.apns] is enabled but push.apns.{name} is not set");
            }
        }
        let pem = std::fs::read_to_string(path).map_err(|e| {
            anyhow::anyhow!("could not read the APNs key at {}: {e}", path.display())
        })?;
        use p256::pkcs8::DecodePrivateKey;
        let secret = p256::SecretKey::from_pkcs8_pem(&pem).map_err(|e| {
            anyhow::anyhow!(
                "{} is not an Apple .p8 ECDSA P-256 key: {e}. A .p8 downloaded from the \
                 developer portal is PKCS#8 PEM and can only be downloaded once.",
                path.display()
            )
        })?;
        let gateway = match cfg.environment.trim() {
            "sandbox" | "development" => APNS_SANDBOX_BASE,
            "production" | "" => APNS_PRODUCTION_BASE,
            other => anyhow::bail!(
                "push.apns.environment is {other:?}; it must be \"production\" or \"sandbox\""
            ),
        };
        let base_url = match cfg.base_url.as_deref() {
            Some(raw) => checked_origin("push.apns.base_url", raw, allow_http)?,
            None => gateway.to_string(),
        };
        Ok(Apns {
            team_id: cfg.team_id.trim().to_string(),
            key_id: cfg.key_id.trim().to_string(),
            bundle_id: cfg.bundle_id.trim().to_string(),
            signing: p256::ecdsa::SigningKey::from(&secret),
            base_url,
            provider_token: Mutex::new(None),
        })
    }

    fn mint_token(&self, now_secs: i64) -> anyhow::Result<String> {
        let header = json!({ "alg": "ES256", "kid": self.key_id });
        let claims = json!({ "iss": self.team_id, "iat": now_secs });
        let signing_input = format!(
            "{}.{}",
            b64(header.to_string().as_bytes()),
            b64(claims.to_string().as_bytes())
        );
        let signature: p256::ecdsa::Signature = self.signing.sign(signing_input.as_bytes());
        Ok(format!("{signing_input}.{}", b64(&signature.to_bytes())))
    }

    async fn token(&self) -> anyhow::Result<String> {
        let mut cached = self.provider_token.lock().await;
        let now = now_ms();
        if let Some(token) = cached.as_ref() {
            if token.good_until > now {
                return Ok(token.token.clone());
            }
        }
        let token = self.mint_token(now / 1000)?;
        *cached =
            Some(CachedToken { token: token.clone(), good_until: now + APNS_TOKEN_LIFETIME_MS });
        Ok(token)
    }

    fn send_url(&self, device_token: &str) -> String {
        format!("{}/3/device/{device_token}", self.base_url)
    }
}

fn apns_payload() -> Value {
    json!({
        "aps": {
            "alert": { "loc-key": "notification.placeholder", "body": "New message" },
            "mutable-content": 1,
            "thread-id": "telium",
            "sound": "default",
        }
    })
}

fn apns_outcome(status: u16, body: &Value) -> Outcome {
    if (200..300).contains(&status) {
        return Outcome::Delivered;
    }
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or_default();
    match reason {
        "Unregistered" | "BadDeviceToken" | "DeviceTokenNotForTopic" => Outcome::Gone,
        "ExpiredProviderToken" | "InvalidProviderToken" => {
            tracing::error!(
                target: crate::logcat::PUSH,
                reason,
                "APNs refused this server's provider token; no iOS device can be woken until \
                 push.apns is fixed or its clock is corrected"
            );
            Outcome::Retry
        }
        "BadTopic" | "TopicDisallowed" => {
            tracing::error!(
                target: crate::logcat::PUSH,
                reason,
                topic_note = "push.apns.bundle_id must be the app's bundle identifier",
                "APNs rejected this server's topic"
            );
            Outcome::Retry
        }
        _ => match status {
            410 => Outcome::Gone,
            _ => Outcome::Retry,
        },
    }
}

#[derive(Default)]
pub struct Providers {
    pub fcm: Option<Arc<Fcm>>,
    pub apns: Option<Arc<Apns>>,
}

impl Providers {
    pub fn load(cfg: &Config) -> anyhow::Result<Self> {
        let fcm = if cfg.push.fcm.enabled {
            let fcm = Fcm::load(&cfg.push.fcm, cfg.federation.allow_http)?;
            tracing::info!(
                target: crate::logcat::PUSH,
                project = %fcm.project_id,
                send_origin = %fcm.base_url,
                "FCM HTTP v1 push is configured"
            );
            Some(Arc::new(fcm))
        } else {
            None
        };
        let apns = if cfg.push.apns.enabled {
            let apns = Apns::load(&cfg.push.apns, cfg.federation.allow_http)?;
            tracing::info!(
                target: crate::logcat::PUSH,
                topic = %apns.bundle_id,
                gateway = %apns.base_url,
                "APNs push is configured"
            );
            Some(Arc::new(apns))
        } else {
            None
        };
        Ok(Providers { fcm, apns })
    }

    pub fn supports(&self, kind: &str) -> bool {
        match kind {
            "fcm" => self.fcm.is_some(),
            "apns" => self.apns.is_some(),
            _ => true,
        }
    }
}

pub async fn deliver(state: &AppState, kind: &str, token: &str, body: &Value) -> Outcome {
    match kind {
        "fcm" => deliver_fcm(state, token, body).await,
        "apns" => deliver_apns(state, token).await,
        _ => Outcome::Retry,
    }
}

async fn deliver_fcm(state: &AppState, token: &str, body: &Value) -> Outcome {
    let Some(fcm) = state.push_providers.fcm.clone() else {
        tracing::warn!(target: crate::logcat::PUSH, "an FCM registration exists but [push.fcm] is not configured");
        return Outcome::Retry;
    };
    let access = match fcm.access_token(&state.http).await {
        Ok(access) => access,
        Err(error) => {
            tracing::warn!(target: crate::logcat::PUSH, %error, "could not mint an FCM access token");
            return Outcome::Retry;
        }
    };
    let response = state
        .http
        .post(fcm.send_url())
        .bearer_auth(access)
        .json(&fcm_message(token, body))
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            fcm_outcome(status, &body)
        }
        Err(error) => {
            tracing::warn!(target: crate::logcat::PUSH, %error, "could not reach FCM");
            Outcome::Retry
        }
    }
}

async fn deliver_apns(state: &AppState, token: &str) -> Outcome {
    let Some(apns) = state.push_providers.apns.clone() else {
        tracing::warn!(target: crate::logcat::PUSH, "an APNs registration exists but [push.apns] is not configured");
        return Outcome::Retry;
    };
    let provider_token = match apns.token().await {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(target: crate::logcat::PUSH, %error, "could not mint an APNs provider token");
            return Outcome::Retry;
        }
    };
    let response = state
        .http
        .post(apns.send_url(token))
        .header("authorization", format!("bearer {provider_token}"))
        .header("apns-topic", &apns.bundle_id)
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
        .header("apns-expiration", ((now_ms() / 1000) + 86_400).to_string())
        .json(&apns_payload())
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body: Value = response.json().await.unwrap_or(Value::Null);
            apns_outcome(status, &body)
        }
        Err(error) => {
            tracing::warn!(target: crate::logcat::PUSH, %error, "could not reach APNs");
            Outcome::Retry
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::unb64;

    #[test]
    fn an_apns_token_names_the_team_and_the_key_and_nothing_else() {
        let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
        let apns = Apns {
            team_id: "TEAM123456".into(),
            key_id: "KEY7654321".into(),
            bundle_id: "chat.telium.ios".into(),
            signing: p256::ecdsa::SigningKey::from(&secret),
            base_url: APNS_PRODUCTION_BASE.into(),
            provider_token: Mutex::new(None),
        };
        let jwt = apns.mint_token(1_700_000_000).unwrap();
        let part = |i: usize| unb64(jwt.split('.').nth(i).unwrap()).unwrap();
        let header: Value = serde_json::from_slice(&part(0)).unwrap();
        let claims: Value = serde_json::from_slice(&part(1)).unwrap();
        assert_eq!((header["alg"].as_str(), header["kid"].as_str()), (Some("ES256"), Some("KEY7654321")));
        assert_eq!(claims, json!({ "iss": "TEAM123456", "iat": 1_700_000_000 }));
        use p256::ecdsa::signature::Verifier;
        let sig = p256::ecdsa::Signature::from_slice(&part(2)).unwrap();
        let input = jwt.rsplit_once('.').unwrap().0;
        assert!(p256::ecdsa::VerifyingKey::from(&secret.public_key()).verify(input.as_bytes(), &sig).is_ok());
    }

    #[test]
    fn provider_payloads_carry_no_routing_or_rendered_text() {
        let payload = apns_payload().to_string();
        assert!(payload.contains("mutable-content"));
        for leaked in ["guild", "channel", "conversation", "message_id", "sender"] {
            assert!(!payload.contains(leaked), "APNs payload mentions {leaked}");
        }
        let message = fcm_message("device-token", &json!({ "type": "wake" }));
        assert_eq!(message["message"]["android"]["priority"], "HIGH");
        assert!(message["message"].get("notification").is_none());
        assert_eq!(message["message"]["data"]["telium"], r#"{"type":"wake"}"#);
    }

    #[test]
    fn a_revoked_token_is_deleted_and_a_broken_credential_is_not() {
        let unregistered = json!({ "error": { "details": [ { "errorCode": "UNREGISTERED" } ] } });
        assert_eq!(fcm_outcome(404, &unregistered), Outcome::Gone);
        assert_eq!(fcm_outcome(200, &Value::Null), Outcome::Delivered);
        for status in [400, 401, 403, 503] {
            assert_eq!(fcm_outcome(status, &Value::Null), Outcome::Retry, "fcm {status}");
        }
        assert_eq!(apns_outcome(410, &json!({ "reason": "Unregistered" })), Outcome::Gone);
        assert_eq!(apns_outcome(400, &json!({ "reason": "BadDeviceToken" })), Outcome::Gone);
        assert_eq!(apns_outcome(403, &json!({ "reason": "ExpiredProviderToken" })), Outcome::Retry);
    }

    #[test]
    fn provider_configuration_is_checked_at_startup() {
        let empty = Providers::default();
        assert!(!empty.supports("fcm") && !empty.supports("apns"));
        assert!(["webpush", "native-webpush", "relay"].iter().all(|t| empty.supports(t)));

        let key = "push.fcm.base_url";
        assert_eq!(checked_origin(key, "https://staging.example/", false).unwrap(), "https://staging.example");
        let error = checked_origin(key, "http://127.0.0.1:9", false).unwrap_err().to_string();
        assert!(error.contains("federation.allow_http"), "{error}");
        assert!(checked_origin(key, "http://127.0.0.1:9", true).is_ok());
        for bad in ["fcm.example", "file:///etc/passwd", "   "] {
            assert!(checked_origin(key, bad, true).is_err(), "{bad:?}");
        }

        let mut cfg = Config::default();
        cfg.push.fcm.enabled = true;
        assert!(Providers::load(&cfg).err().unwrap().to_string().contains("service_account_file"));
        let mut cfg = Config::default();
        cfg.push.apns.enabled = true;
        assert!(Providers::load(&cfg).err().unwrap().to_string().contains("key_file"));
        assert!(Providers::load(&Config::default()).is_ok());
    }
}
