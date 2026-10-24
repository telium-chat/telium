
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, now_ms, unb64};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes128Gcm, Nonce};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha256;

const TTL_SECS: u64 = 86_400;

const RECORD_SIZE: u32 = 4096;

#[derive(Clone)]
pub struct VapidKey {
    pub secret: SecretKey,
    pub public_b64: String,
}

pub async fn load_or_create(pool: &sqlx::SqlitePool) -> anyhow::Result<VapidKey> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT secret_b64, public_b64 FROM vapid_key WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    if let Some((secret_b64, public_b64)) = row {
        let bytes =
            unb64(&secret_b64).ok_or_else(|| anyhow::anyhow!("stored VAPID key is malformed"))?;
        let secret = SecretKey::from_slice(&bytes)?;
        return Ok(VapidKey { secret, public_b64 });
    }
    let secret = SecretKey::random(&mut OsRng);
    let public_b64 = b64(secret.public_key().to_sec1_bytes().as_ref());
    sqlx::query(
        "INSERT INTO vapid_key (id, secret_b64, public_b64, created_at) VALUES (1, ?, ?, ?)",
    )
    .bind(b64(&secret.to_bytes()))
    .bind(&public_b64)
    .bind(now_ms())
    .execute(pool)
    .await?;
    tracing::info!(target: crate::logcat::PUSH, "generated VAPID push identity");
    Ok(VapidKey { secret, public_b64 })
}

fn vapid_header(key: &VapidKey, endpoint: &str, subject: &str) -> ApiResult<String> {
    let url = url::Url::parse(endpoint)
        .map_err(|_| ApiError::BadRequest("push endpoint is not a URL".into()))?;
    let audience = match url.host_str() {
        Some(host) => format!("{}://{host}", url.scheme()),
        None => return Err(ApiError::BadRequest("push endpoint has no host".into())),
    };
    let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = json!({
        "aud": audience,
        "exp": now_ms() / 1000 + 12 * 60 * 60,
        "sub": subject,
    });
    let claims = b64(claims.to_string().as_bytes());
    let signing_input = format!("{header}.{claims}");
    let signing = SigningKey::from(&key.secret);
    let signature: Signature = signing.sign(signing_input.as_bytes());
    let jwt = format!("{signing_input}.{}", b64(&signature.to_bytes()));
    Ok(format!("vapid t={jwt}, k={}", key.public_b64))
}

fn encrypt(payload: &[u8], p256dh_b64: &str, auth_b64: &str) -> ApiResult<Vec<u8>> {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    seal(payload, p256dh_b64, auth_b64, salt, &SecretKey::random(&mut OsRng))
}

fn seal(
    payload: &[u8],
    p256dh_b64: &str,
    auth_b64: &str,
    salt: [u8; 16],
    ephemeral: &SecretKey,
) -> ApiResult<Vec<u8>> {
    let bad = |what: &str| ApiError::BadRequest(format!("subscription {what} is malformed"));
    let ua_public_bytes = unb64(p256dh_b64).ok_or_else(|| bad("public key"))?;
    let ua_public = PublicKey::from_sec1_bytes(&ua_public_bytes).map_err(|_| bad("public key"))?;
    let auth_secret = unb64(auth_b64).ok_or_else(|| bad("auth secret"))?;

    let as_public = ephemeral.public_key().to_sec1_bytes().to_vec();
    let shared = p256::ecdh::diffie_hellman(
        ephemeral.to_nonzero_scalar(),
        ua_public.as_affine(),
    );

    let mut ikm = [0u8; 32];
    let mut key_info = Vec::with_capacity(14 + ua_public_bytes.len() + as_public.len());
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&ua_public_bytes);
    key_info.extend_from_slice(&as_public);
    Hkdf::<Sha256>::new(Some(&auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("push key derivation failed")))?;

    let hkdf = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    hkdf.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .and_then(|()| hkdf.expand(b"Content-Encoding: nonce\0", &mut nonce))
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("push key derivation failed")))?;

    let mut plaintext = payload.to_vec();
    plaintext.push(0x02);
    let ciphertext = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("push cipher setup failed")))?
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: b"" })
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("push encryption failed")))?;

    let mut body = Vec::with_capacity(21 + as_public.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(&as_public);
    body.extend_from_slice(&ciphertext);
    Ok(body)
}

const DELIVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

pub async fn checked_endpoint(
    state: &AppState,
    endpoint: &str,
) -> ApiResult<(url::Url, Option<std::net::SocketAddr>)> {
    let refuse = || ApiError::BadRequest("that push endpoint is not reachable from here".into());
    let url = url::Url::parse(endpoint).map_err(|_| refuse())?;
    let scheme_ok =
        url.scheme() == "https" || (url.scheme() == "http" && state.cfg.federation.allow_http);
    if !scheme_ok {
        return Err(ApiError::BadRequest("push endpoints must be https".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refuse());
    }
    let host = url.host_str().ok_or_else(refuse)?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    if state.cfg.federation.allow_http {
        return Ok((url, None));
    }

    let lookup = match url.host() {
        Some(url::Host::Ipv6(v6)) => v6.to_string(),
        _ => host.clone(),
    };
    let addrs: Vec<std::net::SocketAddr> = tokio::time::timeout(
        DELIVERY_TIMEOUT,
        tokio::net::lookup_host((lookup.as_str(), port)),
    )
    .await
    .map_err(|_| refuse())?
    .map_err(|_| refuse())?
    .collect();
    if addrs.is_empty() || addrs.iter().any(|a| crate::federation::embed::is_internal(a.ip())) {
        return Err(refuse());
    }
    Ok((url, addrs.first().copied()))
}

pub fn pinned_client(
    host: &str,
    pinned: Option<std::net::SocketAddr>,
) -> ApiResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DELIVERY_TIMEOUT)
        .connect_timeout(DELIVERY_TIMEOUT);
    if let Some(addr) = pinned {
        builder = builder.resolve(host, addr);
    }
    builder
        .build()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("building a push client: {e}")))
}

pub async fn deliver(
    state: &AppState,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &Value,
    urgency: &str,
) -> bool {
    let key = &state.vapid;
    let subject = format!("https://{}", state.cfg.server_name);

    let endpoint_origin = url::Url::parse(endpoint)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            Some(format!("{}://{}", url.scheme(), host))
        })
        .unwrap_or_else(|| "<invalid>".into());

    let (Ok(header), Ok(body)) = (
        vapid_header(key, endpoint, &subject),
        encrypt(payload.to_string().as_bytes(), p256dh, auth),
    ) else {
        tracing::warn!(target: crate::logcat::PUSH, endpoint_origin = %endpoint_origin, "could not build a push request");
        return false;
    };
    let (url, pinned) = match checked_endpoint(state, endpoint).await {
        Ok(checked) => checked,
        Err(_) => {
            tracing::warn!(target: crate::logcat::PUSH, "refusing to deliver a wake to an endpoint that is not routable");
            return false;
        }
    };
    let host = url.host_str().unwrap_or_default().to_string();
    let Ok(client) = pinned_client(&host, pinned) else {
        return false;
    };
    let resp = client
        .post(url)
        .header("Authorization", header)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", TTL_SECS.to_string())
        .header("Urgency", urgency)
        .body(body)
        .send()
        .await;

    match resp {
        Ok(response) if response.status().is_success() => true,
        Ok(response) => {
            tracing::warn!(
                target: crate::logcat::PUSH,
                endpoint_origin = %endpoint_origin,
                status = %response.status(),
                urgency,
                "push service rejected wake"
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                target: crate::logcat::PUSH,
                endpoint_origin = %endpoint_origin,
                %error,
                urgency,
                "could not reach push service"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_8291_vector() {
        let ua_public = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx\
                         aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
        let auth = "BTBZMqHH6r4Tts7J_aSIgg";
        let as_private = unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw").unwrap();
        let salt: [u8; 16] = unb64("DGv6ra1nlYgDCS1FRnbzlw").unwrap().try_into().unwrap();

        let body = seal(
            b"When I grow up, I want to be a watermelon",
            ua_public,
            auth,
            salt,
            &SecretKey::from_slice(&as_private).unwrap(),
        )
        .unwrap();

        assert_eq!(
            b64(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
             pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
                .replace(['\n', ' '], "")
        );
    }

    #[test]
    fn encrypts_into_the_aes128gcm_framing() {
        let ua = SecretKey::random(&mut OsRng);
        let p256dh = b64(ua.public_key().to_sec1_bytes().as_ref());
        let auth = b64(&[7u8; 16]);

        let body = encrypt(b"{\"type\":\"wake\"}", &p256dh, &auth).unwrap();

        assert_eq!(u32::from_be_bytes(body[16..20].try_into().unwrap()), RECORD_SIZE);
        assert_eq!(body[20], 65, "an uncompressed P-256 point is 65 bytes");
        assert!(body.len() > 21 + 65, "and the record follows it");
        let again = encrypt(b"{\"type\":\"wake\"}", &p256dh, &auth).unwrap();
        assert_ne!(body[..16], again[..16]);
        assert_ne!(body[21..86], again[21..86]);
    }

    #[test]
    fn vapid_audience_is_the_origin_not_the_subscription() {
        let key = VapidKey {
            secret: SecretKey::random(&mut OsRng),
            public_b64: "irrelevant".into(),
        };
        let header =
            vapid_header(&key, "https://push.example/send/abcdef?secret=1", "https://home.example")
                .unwrap();
        let jwt = header.trim_start_matches("vapid t=").split(',').next().unwrap();
        let claims: Value =
            serde_json::from_slice(&unb64(jwt.split('.').nth(1).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://push.example");
        assert!(!claims["aud"].as_str().unwrap().contains("abcdef"));
    }
}
