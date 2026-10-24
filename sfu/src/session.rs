
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json};
use serde_json::{json, Value};

use crate::livekit::JoinFlags;
use crate::livekit::room_name;
use crate::server::AppState;
use crate::trust::maybe_discover;

#[derive(Debug, serde::Deserialize)]
pub struct SessionRequest {
    pub token: String,
}

#[derive(Debug, serde::Serialize)]
pub struct SessionResponse {
    pub url: String,
    pub token: String,
    pub room: String,
    pub max_bitrate: i64,
}

pub fn effective_bitrate(requested: i64, region_ceiling: i64) -> i64 {
    if region_ceiling > 0 { requested.min(region_ceiling) } else { requested }
}

pub async fn session_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, (StatusCode, Json<Value>)> {
    let raw = match telium_protocol::unb64(&req.token) {
        Some(b) => b,
        None => return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "token is not base64" })))),
    };
    let value: Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(_) => return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "token is not json" })))),
    };

    maybe_discover(&state.trust, &value).await;

    if !state.trust.read().await.verify_json(&value) {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "bad signature" }))));
    }

    // Otherwise a future signed command sharing field names could replay into a join.
    if value.get("kind").and_then(Value::as_str) != Some("sfu_join") {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "not a join token" }))));
    }

    let origin = value.get("origin").and_then(Value::as_str).unwrap_or("");
    let guild = value.get("guild").and_then(Value::as_str).unwrap_or("");
    let channel = value.get("channel").and_then(Value::as_str).unwrap_or("");
    let user_id = value.get("user_id").and_then(Value::as_str).unwrap_or("");
    let expires_at = value.get("expires_at").and_then(Value::as_i64).unwrap_or(0);
    let flags = value.get("flags");
    let flags = JoinFlags {
        speak: flags.and_then(|f| f.get("speak")).and_then(Value::as_bool).unwrap_or(false),
        video: flags.and_then(|f| f.get("video")).and_then(Value::as_bool).unwrap_or(false),
        stream: flags.and_then(|f| f.get("stream")).and_then(Value::as_bool).unwrap_or(false),
        priority: flags.and_then(|f| f.get("priority")).and_then(Value::as_bool).unwrap_or(false),
    };

    if guild.is_empty() || channel.is_empty() || user_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "missing guild/channel/user_id" }))));
    }

    let now = now_ms();
    if expires_at <= now {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "token expired" }))));
    }
    let remaining = (expires_at - now) / 1000;
    let exp_secs = remaining.min(3600).max(1);

    // A token without a positive ceiling is malformed, not unlimited.
    let requested = match value.get("max_bitrate").and_then(Value::as_i64) {
        Some(n) if n > 0 => n,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "token must carry a positive max_bitrate" })),
            ))
        }
    };
    let max_bitrate = effective_bitrate(requested, state.cfg.limits.max_bitrate);

    let room = room_name(origin, guild, channel);
    let lk_token = match state.livekit.mint_token(&room, user_id, &flags, exp_secs, max_bitrate) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error = %e, "failed to mint livekit token");
            return Err((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "mint failed" }))));
        }
    };
    state.sessions.record_join(&room, user_id, max_bitrate);

    Ok(Json(SessionResponse {
        url: state.livekit.connect_url(),
        token: lk_token,
        room,
        max_bitrate,
    }))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{LivekitConfig, LivekitMode, SfuConfig, TrustConfig, TrustedOrigin};
    use crate::livekit::LivekitManager;
    use crate::sessions::SessionRegistry;
    use crate::trust::TrustedKeys;
    use ed25519_dalek::SigningKey;
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    use std::time::{SystemTime, UNIX_EPOCH};
    use telium_protocol as proto;
    use tokio::sync::RwLock;
    use tokio::sync::watch;

    #[derive(serde::Deserialize)]
    struct DecodeClaims {
        iss: String,
        sub: String,
        exp: i64,
        video: DecodeGrant,
        #[serde(default)]
        attributes: std::collections::HashMap<String, String>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DecodeGrant {
        room: String,
        can_publish: bool,
        can_subscribe: bool,
        can_publish_data: bool,
        can_publish_sources: Vec<String>,
    }

    async fn wired_state(signing: &SigningKey, origin: &str, key_id: &str) -> Arc<AppState> {
        wired_state_with_ceiling(signing, origin, key_id, 8_000_000).await
    }

    async fn wired_state_with_ceiling(
        signing: &SigningKey,
        origin: &str,
        key_id: &str,
        region_max_bitrate: i64,
    ) -> Arc<AppState> {
        let public_b64 = proto::b64(signing.verifying_key().as_bytes());
        let trust = TrustedKeys::from_config(&TrustConfig {
            discovery: false,
            cache_ttl_secs: 1,
            public: false,
            allow_insecure_discovery: false,
            origins: vec![TrustedOrigin {
                server_name: origin.to_string(),
                key_id: key_id.to_string(),
                public_key_b64: public_b64,
                discovery_url: None,
            }],
        });

        let mut cfg = SfuConfig::default();
        cfg.livekit = LivekitConfig {
            mode: LivekitMode::External,
            url: "http://127.0.0.1:7880".into(),
            api_key: "devkey".into(),
            api_secret: "devsecret".into(),
            ..LivekitConfig::default()
        };
        cfg.limits.max_bitrate = region_max_bitrate;
        let (_tx, rx) = watch::channel(false);
        let livekit = LivekitManager::start(&cfg, rx).await.unwrap();

        Arc::new(AppState {
            cfg,
            trust: Arc::new(RwLock::new(trust)),
            livekit,
            sessions: Arc::new(SessionRegistry::new()),
        })
    }

    fn forge_token(
        signing: &SigningKey,
        key_id: &str,
        origin: &str,
        speak: bool,
        video: bool,
        stream: bool,
    ) -> String {
        forge_token_with_bitrate(signing, key_id, origin, speak, video, stream, json!(64000))
    }

    fn forge_token_with_bitrate(
        signing: &SigningKey,
        key_id: &str,
        origin: &str,
        speak: bool,
        video: bool,
        stream: bool,
        max_bitrate: Value,
    ) -> String {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let mut claims = json!({
            "kind": "sfu_join",
            "guild": "g1",
            "channel": "c1",
            "user_id": "@alice:home",
            "device_id": "d1",
            "session_id": "s1",
            "origin": origin,
            "region": "auto",
            "flags": { "speak": speak, "video": video, "stream": stream, "priority": false },
            "issued_at": now,
            "expires_at": now + 120_000,
        });
        if !max_bitrate.is_null() {
            claims["max_bitrate"] = max_bitrate;
        }
        let signed = proto::sign_json(signing, key_id, claims);
        proto::b64(signed.to_string().as_bytes())
    }

    fn decode_claims(token: &str) -> DecodeClaims {
        decode::<DecodeClaims>(
            token,
            &DecodingKey::from_secret(b"devsecret"),
            &Validation::new(Algorithm::HS256),
        )
        .expect("livekit token must verify with api_secret")
        .claims
    }

    #[tokio::test]
    async fn token_carries_the_guild_ceiling_as_a_participant_attribute() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;
        let token = forge_token(&signing, "ed25519:test", "home.example", true, true, true);
        let res = session_handler(State(state.clone()), Json(SessionRequest { token }))
            .await
            .expect("session should succeed");

        assert_eq!(res.max_bitrate, 64_000, "under the region ceiling, the guild's number stands");
        let claims = decode_claims(&res.token);
        assert_eq!(claims.attributes.get("telium.max_bitrate").map(String::as_str), Some("64000"));
        assert_eq!(state.sessions.cap_for("telium_home-2eexample_g1_c1", "@alice:home"), Some(64_000));
    }

    #[tokio::test]
    async fn region_ceiling_clamps_a_greedy_guild() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state_with_ceiling(&signing, "home.example", "ed25519:test", 1_000_000).await;
        let token = forge_token_with_bitrate(
            &signing, "ed25519:test", "home.example", true, true, true, json!(6_000_000),
        );
        let res = session_handler(State(state.clone()), Json(SessionRequest { token }))
            .await
            .expect("session should succeed");
        assert_eq!(res.max_bitrate, 1_000_000);
        let claims = decode_claims(&res.token);
        assert_eq!(claims.attributes.get("telium.max_bitrate").map(String::as_str), Some("1000000"));
        assert_eq!(state.sessions.cap_for("telium_home-2eexample_g1_c1", "@alice:home"), Some(1_000_000));
    }

    #[tokio::test]
    async fn token_without_a_positive_max_bitrate_is_rejected() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;
        for bad in [Value::Null, json!(0), json!(-96_000), json!("96000")] {
            let token = forge_token_with_bitrate(
                &signing, "ed25519:test", "home.example", true, true, false, bad.clone(),
            );
            let err = session_handler(State(state.clone()), Json(SessionRequest { token }))
                .await
                .unwrap_err();
            assert_eq!(err.0, StatusCode::BAD_REQUEST, "max_bitrate {bad:?} must be refused");
        }
        assert_eq!(state.sessions.rooms().len(), 0, "a refused join records nothing");
    }

    #[test]
    fn effective_bitrate_takes_the_smaller_positive_ceiling() {
        assert_eq!(effective_bitrate(64_000, 8_000_000), 64_000);
        assert_eq!(effective_bitrate(9_000_000, 8_000_000), 8_000_000);
        assert_eq!(effective_bitrate(9_000_000, 0), 9_000_000);
    }

    #[tokio::test]
    async fn session_mints_livekit_token_for_valid_join() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;

        let token = forge_token(&signing, "ed25519:test", "home.example", true, true, false);
        let res = session_handler(
            State(state.clone()),
            Json(SessionRequest { token }),
        )
        .await
        .expect("session should succeed");

        assert_eq!(res.room, "telium_home-2eexample_g1_c1");
        assert_eq!(res.url, "ws://127.0.0.1:7880");

        let claims: DecodeClaims = decode(
            &res.token,
            &DecodingKey::from_secret(b"devsecret"),
            &Validation::new(Algorithm::HS256),
        )
        .expect("livekit token must verify with api_secret")
        .claims;
        assert_eq!(claims.iss, "devkey");
        assert_eq!(claims.sub, "@alice:home");
        assert_eq!(claims.video.room, "telium_home-2eexample_g1_c1");
        assert!(claims.video.can_publish);
        assert!(claims.video.can_subscribe);
        assert!(claims.video.can_publish_data);
        assert!(claims.video.can_publish_sources.iter().any(|s| s == "microphone"));
        assert!(claims.video.can_publish_sources.iter().any(|s| s == "camera"));
        assert!(!claims.video.can_publish_sources.iter().any(|s| s == "screen_share"));
        assert!(!claims.video.can_publish_sources.iter().any(|s| s == "screen_share_audio"));
    }

    #[tokio::test]
    async fn screenshare_grant_names_both_livekit_screen_sources() {
        let signing = SigningKey::from_bytes(&[8u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;

        let token = forge_token(
            &signing, "ed25519:test", "home.example", true, false, true,
        );
        let res = session_handler(State(state), Json(SessionRequest { token }))
            .await
            .expect("session should succeed");
        let claims: DecodeClaims = decode(
            &res.token,
            &DecodingKey::from_secret(b"devsecret"),
            &Validation::new(Algorithm::HS256),
        )
        .unwrap()
        .claims;

        assert!(claims.video.can_publish_sources.iter().any(|s| s == "microphone"));
        assert!(!claims.video.can_publish_sources.iter().any(|s| s == "camera"));
        assert!(claims.video.can_publish_sources.iter().any(|s| s == "screen_share"));
        assert!(claims.video.can_publish_sources.iter().any(|s| s == "screen_share_audio"));
    }

    #[tokio::test]
    async fn server_mute_drops_audio_at_ingress() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;

        let token = forge_token(&signing, "ed25519:test", "home.example", false, true, false);
        let res = session_handler(State(state), Json(SessionRequest { token }))
            .await
            .expect("session should succeed");
        let claims: DecodeClaims = decode(
            &res.token,
            &DecodingKey::from_secret(b"devsecret"),
            &Validation::new(Algorithm::HS256),
        )
        .unwrap()
        .claims;
        assert!(
            !claims.video.can_publish_sources.iter().any(|s| s == "microphone"),
            "muted member cannot publish microphone audio",
        );
        assert!(claims.video.can_publish_sources.iter().any(|s| s == "camera"));
    }

    #[tokio::test]
    async fn signed_non_join_envelope_is_rejected() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let claims = json!({
            "kind": "federation_command",
            "guild": "g1",
            "channel": "c1",
            "user_id": "@alice:home",
            "device_id": "d1",
            "session_id": "s1",
            "origin": "home.example",
            "region": "auto",
            "max_bitrate": 64_000,
            "flags": { "speak": true, "video": true, "stream": false, "priority": false },
            "issued_at": now,
            "expires_at": now + 120_000,
        });
        let signed = proto::sign_json(&signing, "ed25519:test", claims);
        let token = proto::b64(signed.to_string().as_bytes());

        let err = session_handler(State(state.clone()), Json(SessionRequest { token }))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.0["error"], "not a join token");
        assert_eq!(state.sessions.rooms().len(), 0, "a domain-mismatched token records no join");
    }

    #[tokio::test]
    async fn bad_signature_is_rejected() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let other = SigningKey::from_bytes(&[3u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;

        let token = forge_token(&other, "ed25519:evil", "home.example", true, true, false);
        let err = session_handler(State(state), Json(SessionRequest { token }))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn expired_token_is_rejected() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let state = wired_state(&signing, "home.example", "ed25519:test").await;

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let claims = json!({
            "kind": "sfu_join", "guild": "g1", "channel": "c1", "user_id": "u",
            "device_id": "d", "session_id": "s", "origin": "home.example",
            "flags": { "speak": true, "video": false, "stream": false, "priority": false },
            "issued_at": now - 200_000, "expires_at": now - 100_000,
        });
        let signed = proto::sign_json(&signing, "ed25519:test", claims);
        let token = proto::b64(signed.to_string().as_bytes());
        let err = session_handler(State(state), Json(SessionRequest { token }))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }
}
