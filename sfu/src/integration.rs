
#[cfg(test)]
mod tests {
use std::sync::Arc;
use tokio::sync::RwLock;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use ed25519_dalek::SigningKey;
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::sync::Mutex;

use crate::config::{LivekitConfig, LivekitMode, SfuConfig, TrustConfig, TrustedOrigin};
use crate::livekit::{room_name, LivekitManager};
use crate::server::AppState;
use crate::sessions::SessionRegistry;
use crate::trust::TrustedKeys;
use telium_protocol as proto;

    type Record = Arc<Mutex<Vec<(String, Value)>>>;
    type Roster = Arc<Mutex<Value>>;

    async fn mock_livekit() -> (String, Record) {
        let (url, record, _roster) = mock_livekit_with_roster().await;
        (url, record)
    }

    async fn mock_livekit_with_roster() -> (String, Record, Roster) {
        let record: Record = Arc::new(Mutex::new(Vec::new()));
        let roster: Roster = Arc::new(Mutex::new(json!([])));
        let rec = record.clone();
        let ros = roster.clone();
        let app = Router::new().route(
            "/twirp/livekit.RoomService/{method}",
            axum::routing::post(
                move |Path(method): Path<String>, body: axum::body::Bytes| {
                    let rec = rec.clone();
                    let ros = ros.clone();
                    async move {
                        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let identity = body.get("identity").cloned();
                        rec.lock().await.push((method.clone(), body));
                        let resp = if method == "GetParticipant" {
                            json!({
                                "identity": identity,
                                "permission": {
                                    "canPublish": true,
                                    "canSubscribe": true,
                                    "canPublishSources": ["MICROPHONE", "CAMERA", "SCREEN_SHARE"],
                                },
                                "tracks": [
                                    { "sid": "TR_audio", "type": "AUDIO", "source": "MICROPHONE" },
                                    { "sid": "TR_camera", "type": "VIDEO", "source": "CAMERA" },
                                    { "sid": "TR_screen", "type": "VIDEO", "source": "SCREEN_SHARE" },
                                ],
                            })
                        } else if method == "ListParticipants" {
                            json!({ "participants": ros.lock().await.clone() })
                        } else {
                            Value::Null
                        };
                        (StatusCode::OK, axum::Json(resp))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), record, roster)
    }

    struct Harness {
        base: String,
        record: Record,
        roster: Roster,
        state: Arc<AppState>,
        _shutdown: watch::Sender<bool>,
    }

    async fn harness() -> Harness {
        let (lk_url, record, roster) = mock_livekit_with_roster().await;
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let public_b64 = proto::b64(signing.verifying_key().as_bytes());
        let trust = TrustedKeys::from_config(&TrustConfig {
            discovery: false,
            cache_ttl_secs: 1,
            public: false,
            allow_insecure_discovery: false,
            origins: vec![TrustedOrigin {
                server_name: "home.example".into(),
                key_id: "ed25519:test".into(),
                public_key_b64: public_b64,
                discovery_url: None,
            }],
        });

        let mut cfg = SfuConfig::default();
        cfg.livekit = LivekitConfig {
            mode: LivekitMode::External,
            url: lk_url,
            api_key: "k".into(),
            api_secret: "s".into(),
            ..LivekitConfig::default()
        };
        cfg.limits.max_bitrate = 2_000_000;
        let (tx, rx) = watch::channel(false);
        let livekit = LivekitManager::start(&cfg, rx).await.unwrap();
        let state = Arc::new(AppState {
            cfg,
            trust: Arc::new(RwLock::new(trust)),
            livekit,
            sessions: Arc::new(SessionRegistry::new()),
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let served = state.clone();
        tokio::spawn(async move { axum::serve(listener, crate::server::router(served)).await.unwrap() });

        Harness { base: format!("http://{addr}"), record, roster, state, _shutdown: tx }
    }

    async fn join(h: &Harness, user_id: &str, max_bitrate: i64) -> (StatusCode, Value) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let claims = json!({
            "kind": "sfu_join",
            "guild": "g1", "channel": "c1", "user_id": user_id,
            "device_id": "d", "session_id": "s", "origin": "home.example",
            "max_bitrate": max_bitrate,
            "flags": { "speak": true, "video": true, "stream": true, "priority": false },
            "issued_at": now, "expires_at": now + 120_000,
        });
        let signed = proto::sign_json(&signing, "ed25519:test", claims);
        let token = proto::b64(signed.to_string().as_bytes());
        let resp = reqwest::Client::new()
            .post(format!("{}/session", h.base))
            .json(&json!({ "token": token }))
            .send()
            .await
            .unwrap();
        let status = resp.status();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    fn signed_control(inner: Value) -> Value {
        signed_control_at(inner, 0)
    }

    fn signed_control_at(inner: Value, offset_ms: i64) -> Value {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let body = json!({
            "origin": "home.example",
            "guild": "g1",
            "channel": "c1",
            "issued_at": now + offset_ms,
            "command": inner,
        });
        proto::sign_json(&signing, "ed25519:test", body)
    }

    async fn post_control(h: &Harness, inner: Value) -> StatusCode {
        let body = signed_control(inner);
        let resp = reqwest::Client::new()
            .post(format!("{}/control", h.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        resp.status()
    }

    #[tokio::test]
    async fn control_translates_to_twirp_calls() {
        let h = harness().await;

        let code = post_control(&h, json!({"command":"disconnect","user_id":"u1"})).await;
        assert_eq!(code, StatusCode::OK);
        let code = post_control(&h, json!({"command":"mute","user_id":"u1","mute":true})).await;
        assert_eq!(code, StatusCode::OK);
        let code = post_control(&h, json!({"command":"deafen","user_id":"u1","deaf":true})).await;
        assert_eq!(code, StatusCode::OK);
        let code = post_control(&h, json!({"command":"subscribe","viewer":"v","streamer":"s","quality":"auto"})).await;
        assert_eq!(code, StatusCode::OK);

        let rec = h.record.lock().await.clone();
        let methods: Vec<&String> = rec.iter().map(|(m, _)| m).collect();
        assert!(methods.contains(&&"RemoveParticipant".to_string()), "got {methods:?}");
        assert!(methods.contains(&&"GetParticipant".to_string()));
        assert!(methods.contains(&&"MutePublishedTrack".to_string()));
        assert!(methods.contains(&&"UpdateParticipant".to_string()));
        assert!(methods.contains(&&"UpdateSubscriptions".to_string()));

        let remove = rec.iter().find(|(m, _)| m == "RemoveParticipant").unwrap().1.clone();
        assert_eq!(remove["room"], "telium_home-2eexample_g1_c1");
        assert_eq!(remove["identity"], "u1");

        let mute = rec.iter().find(|(m, _)| m == "MutePublishedTrack").unwrap().1.clone();
        assert_eq!(mute["trackSid"], "TR_audio");
        assert_eq!(mute["muted"], true);

        let update = rec.iter().find(|(m, _)| m == "UpdateParticipant").unwrap().1.clone();
        assert_eq!(update["permission"]["canSubscribe"], false);

        let sub = rec.iter().find(|(m, _)| m == "UpdateSubscriptions").unwrap().1.clone();
        assert_eq!(sub["subscribe"], true);
        assert_eq!(sub["trackSids"][0], "TR_screen");
        assert_eq!(sub["trackSids"].as_array().unwrap().len(), 1);

        let update = rec.iter().find(|(m, _)| m == "UpdateParticipant").unwrap().1.clone();
        assert_eq!(update["permission"]["canPublishSources"][0], "MICROPHONE");
    }

    #[tokio::test]
    async fn control_freshness_window_is_two_sided() {
        let h = harness().await;
        for (offset, want) in [
            (365 * 24 * 60 * 60 * 1000i64, StatusCode::UNAUTHORIZED),
            (-(10 * 60 * 1000), StatusCode::UNAUTHORIZED),
            (-2_000, StatusCode::OK),
            (2_000, StatusCode::OK),
        ] {
            let body = signed_control_at(json!({"command":"disconnect","user_id":"u1"}), offset);
            let resp = reqwest::Client::new().post(format!("{}/control", h.base)).json(&body).send().await.unwrap();
            assert_eq!(resp.status(), want, "offset {offset}ms");
            if want != StatusCode::OK {
                assert!(h.record.lock().await.is_empty(), "a stale command must not reach LiveKit");
            }
        }
    }

    #[tokio::test]
    async fn control_rejects_bad_signature() {
        let h = harness().await;
        let bad = json!({
            "origin": "home.example", "channel": "c1", "issued_at": 1,
            "key_id": "ed25519:test", "signature": "x",
            "command": {"command":"disconnect","user_id":"u1"},
        });
        let resp = reqwest::Client::new()
            .post(format!("{}/control", h.base))
            .json(&bad)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    fn decode_data(body: &Value) -> Value {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;
        let bytes = STANDARD.decode(body["data"].as_str().unwrap()).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn each_watch_quality_is_pushed_to_the_viewer_as_a_data_message() {
        let h = harness().await;
        for quality in proto::WATCH_QUALITIES {
            h.record.lock().await.clear();
            let code = post_control(
                &h,
                json!({"command":"subscribe","viewer":"v","streamer":"s","quality":quality}),
            )
            .await;
            assert_eq!(code, StatusCode::OK, "{quality}");

            let rec = h.record.lock().await.clone();
            let methods: Vec<&str> = rec.iter().map(|(m, _)| m.as_str()).collect();
            assert_eq!(methods, vec!["GetParticipant", "UpdateSubscriptions", "SendData"], "{quality}");

            let sub = &rec[1].1;
            assert_eq!(sub["identity"], "v");
            assert_eq!(sub["trackSids"], json!(["TR_screen"]));
            assert_eq!(sub["subscribe"], true);

            let data = &rec[2].1;
            assert_eq!(data["room"], "telium_home-2eexample_g1_c1");
            assert_eq!(data["destinationIdentities"], json!(["v"]));
            assert_eq!(data["topic"], proto::WATCH_TOPIC);
            assert_eq!(data["kind"], "RELIABLE");
            let payload = decode_data(data);
            assert_eq!(payload["streamer"], "s");
            assert_eq!(payload["quality"], quality);

            assert_eq!(
                h.state.sessions.watch_quality("telium_home-2eexample_g1_c1", "v", "s").as_deref(),
                Some(quality)
            );
        }

        let code = post_control(&h, json!({"command":"unsubscribe","viewer":"v","streamer":"s"})).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(h.state.sessions.watch_quality("telium_home-2eexample_g1_c1", "v", "s"), None);
    }

    #[tokio::test]
    async fn unknown_watch_quality_is_a_bad_request_and_touches_livekit_not_at_all() {
        let h = harness().await;
        let code = post_control(
            &h,
            json!({"command":"subscribe","viewer":"v","streamer":"s","quality":"motion"}),
        )
        .await;
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert!(h.record.lock().await.is_empty());
    }

    #[tokio::test]
    async fn session_clamps_and_records_the_ceiling() {
        let h = harness().await;
        let (code, body) = join(&h, "u_small", 500_000).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["max_bitrate"], 500_000);
        let (code, body) = join(&h, "u_big", 9_000_000).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["max_bitrate"], 2_000_000);
        assert_eq!(h.state.sessions.cap_for("telium_home-2eexample_g1_c1", "u_small"), Some(500_000));
        assert_eq!(h.state.sessions.cap_for("telium_home-2eexample_g1_c1", "u_big"), Some(2_000_000));
        assert_eq!(h.state.sessions.rooms(), vec!["telium_home-2eexample_g1_c1".to_string()]);
    }

    #[tokio::test]
    async fn bitrate_sweep_mutes_tracks_declared_over_the_ceiling() {
        let h = harness().await;
        let room = "telium_home-2eexample_g1_c1";
        let (code, _) = join(&h, "honest", 1_000_000).await;
        assert_eq!(code, StatusCode::OK);
        let (code, _) = join(&h, "greedy", 1_000_000).await;
        assert_eq!(code, StatusCode::OK);

        *h.roster.lock().await = json!([
            {
                "identity": "honest",
                "attributes": { proto::MAX_BITRATE_ATTRIBUTE: "1000000" },
                "tracks": [
                    { "sid": "TR_h_mic", "type": "AUDIO", "source": "MICROPHONE" },
                    { "sid": "TR_h_screen", "type": "VIDEO", "source": "SCREEN_SHARE",
                      "layers": [ { "bitrate": 100000 }, { "bitrate": 250000 }, { "bitrate": 600000 } ] },
                ],
            },
            {
                "identity": "greedy",
                "tracks": [
                    { "sid": "TR_g_cam", "type": "VIDEO", "source": "CAMERA",
                      "layers": [ { "bitrate": 150000 }, { "bitrate": 500000 } ] },
                    { "sid": "TR_g_screen", "type": "VIDEO", "source": "SCREEN_SHARE",
                      "layers": [ { "bitrate": 500000 }, { "bitrate": 1500000 }, { "bitrate": 4000000 } ] },
                    { "sid": "TR_g_old", "type": "VIDEO", "source": "CAMERA", "muted": true,
                      "layers": [ { "bitrate": 9000000 } ] },
                ],
            },
            {
                "identity": "stranger",
                "tracks": [
                    { "sid": "TR_s_screen", "type": "VIDEO", "source": "SCREEN_SHARE",
                      "layers": [ { "bitrate": 50000000 } ] },
                ],
            }
        ]);
        h.record.lock().await.clear();

        let muted = crate::enforce::sweep_once(&h.state).await;
        assert_eq!(muted, 1);

        let rec = h.record.lock().await.clone();
        let mutes: Vec<&Value> = rec.iter().filter(|(m, _)| m == "MutePublishedTrack").map(|(_, b)| b).collect();
        assert_eq!(mutes.len(), 1);
        assert_eq!(mutes[0]["room"], room);
        assert_eq!(mutes[0]["identity"], "greedy");
        assert_eq!(mutes[0]["trackSid"], "TR_g_screen", "the largest declared ladder goes first");
        assert_eq!(mutes[0]["muted"], true);

        assert_eq!(h.state.sessions.cap_for(room, "honest"), Some(1_000_000));
        assert_eq!(h.state.sessions.cap_for(room, "greedy"), Some(1_000_000));
        assert_eq!(h.state.sessions.cap_for(room, "stranger"), None);
    }

    #[derive(Clone)]
    struct OriginState {
        signing: Arc<SigningKey>,
        key_id: String,
        host: String,
    }

    async fn origin_wellknown(State(st): State<OriginState>) -> axum::Json<Value> {
        axum::Json(json!({
            "server_name": st.host,
            "api": format!("http://{}", st.host),
            "gateway": format!("http://{}/gateway/v1", st.host),
            "protocol_version": "v1",
        }))
    }

    async fn origin_keys(State(st): State<OriginState>) -> axum::Json<Value> {
        let public_b64 = proto::b64(st.signing.verifying_key().as_bytes());
        let mut entry = Map::new();
        entry.insert("key".into(), json!(public_b64));
        entry.insert("valid_from".into(), json!(0));
        entry.insert("valid_until".into(), json!(9_999_999_999_999u64));
        let mut vk = Map::new();
        vk.insert(st.key_id.clone(), Value::Object(entry));
        let body = json!({
            "server_name": st.host,
            "current_key_id": st.key_id,
            "verify_keys": Value::Object(vk),
            "generated_at": 0,
        });
        axum::Json(proto::sign_json(&st.signing, &st.key_id, body))
    }

    async fn public_discovery_attempt(allow_insecure: bool) -> (StatusCode, Option<Value>, String) {
        let signing = SigningKey::from_bytes(&[11u8; 32]);
        let key_id = "ed25519:disc".to_string();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let ostate = OriginState { signing: Arc::new(signing), key_id: key_id.clone(), host: host.clone() };
        let app = Router::new()
            .route("/.well-known/telium/server", get(origin_wellknown))
            .route("/_telium/v1/keys", get(origin_keys))
            .with_state(ostate);
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (lk_url, _record) = mock_livekit().await;
        let trust = TrustedKeys::from_config(&TrustConfig {
            discovery: false,
            cache_ttl_secs: 1,
            public: true,
            allow_insecure_discovery: allow_insecure,
            origins: vec![],
        });
        let mut cfg = SfuConfig::default();
        cfg.livekit = LivekitConfig {
            mode: LivekitMode::External,
            url: lk_url,
            api_key: "k".into(),
            api_secret: "s".into(),
            ..LivekitConfig::default()
        };
        let (_tx, rx) = watch::channel(false);
        let livekit = LivekitManager::start(&cfg, rx).await.unwrap();
        let state = Arc::new(AppState {
            cfg,
            trust: Arc::new(RwLock::new(trust)),
            livekit,
            sessions: Arc::new(SessionRegistry::new()),
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, crate::server::router(state)).await.unwrap() });
        let base = format!("http://{addr}");

        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
        let claims = json!({
            "kind": "sfu_join",
            "guild": "g1", "channel": "c1", "user_id": "u1",
            "device_id": "d", "session_id": "s", "origin": host,
            "max_bitrate": 64000,
            "flags": { "speak": true, "video": false, "stream": false, "priority": false },
            "issued_at": now, "expires_at": now + 120_000,
        });
        let signed = proto::sign_json(&SigningKey::from_bytes(&[11u8; 32]), &key_id, claims);
        let token = proto::b64(signed.to_string().as_bytes());

        let resp = reqwest::Client::new()
            .post(format!("{base}/session"))
            .json(&json!({ "token": token }))
            .send()
            .await
            .unwrap();
        let status = resp.status();
        let body = resp.json::<Value>().await.ok();
        (status, body, host)
    }

    #[tokio::test]
    async fn public_discovery_refuses_private_addresses_unless_operator_opts_in() {
        let (status, _, _) = public_discovery_attempt(false).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, body, host) = public_discovery_attempt(true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.unwrap()["room"], room_name(&host, "g1", "c1"));
    }
}
