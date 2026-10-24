use axum::extract::State;
use axum::http::{header::AUTHORIZATION, HeaderMap, HeaderValue};
use axum::routing::post;
use axum::{Json, Router};
use p256::SecretKey;
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use telium_server::auth::HomeAuth;
use telium_server::config::Config;
use telium_server::notifications::{self, ALGORITHM_V1};
use telium_server::routes::push::{self, Subscribe};
use telium_server::util::{b64, hash_token, now_ms};
use tokio::sync::oneshot;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TestState {
    state: telium_server::AppState,
    dir: std::path::PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn state() -> TestState {
    state_with(|_, _| {}).await
}

async fn state_with(configure: impl FnOnce(&mut Config, &std::path::Path)) -> TestState {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "telium-notification-push-auth-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut cfg = Config {
        server_name: "bob.example".into(),
        public_base_url: "https://bob.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.federation.allow_http = true;
    cfg.mfa.key_file = dir.join("mfa.key");
    configure(&mut cfg, &dir);

    TestState {
        state: telium_server::build_state(cfg).await.unwrap(),
        dir,
    }
}

async fn seed_account(s: &telium_server::AppState, user_id: &str, device_id: &str) {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, 'bob', 'bob.example', 'irrelevant', ?)",
    )
    .bind(user_id)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO devices (device_id, user_id, name, pubkey_b64, created_at, last_seen, active) \
         VALUES (?, ?, 'phone', 'device-signing-key-not-used-here', ?, ?, 1)",
    )
    .bind(device_id)
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
}

fn notification_headers(token: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Telium-Notification {token}")).unwrap(),
    );
    headers
}

fn native_subscription(kind: &str) -> Subscribe {
    Subscribe {
        kind: kind.into(),
        endpoint: "https://push.example.invalid/device-capability".into(),
        auth: Some("webpush-auth-secret".into()),
        p256dh: Some("webpush-public-key".into()),
    }
}

async fn capture_relay(
    State(sender): State<Arc<Mutex<Option<oneshot::Sender<Value>>>>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if let Some(sender) = sender.lock().unwrap().take() {
        let _ = sender.send(body);
    }
    Json(json!({ "ok": true }))
}

async fn capture_test_wake(
    headers: HeaderMap,
    State(sender): State<Arc<Mutex<Option<oneshot::Sender<Value>>>>>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let urgency = headers
        .get("Urgency")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if let Some(sender) = sender.lock().unwrap().take() {
        let _ = sender.send(json!({ "body": body, "urgency": urgency }));
    }
    Json(json!({ "ok": true }))
}

#[tokio::test]
async fn notification_device_http_route_accepts_put_and_is_advertised() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    let token = "android-enrollment-home-session";
    seed_account(&t.state, user, device).await;

    sqlx::query(
        "INSERT INTO home_sessions (token_hash, user_id, device_id, created_at, expires_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash_token(token))
    .bind(user)
    .bind(device)
    .bind(now_ms())
    .bind(now_ms() + 60_000)
    .execute(&t.state.pool)
    .await
    .unwrap();

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = telium_server::routes::router(t.state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let client = reqwest::Client::new();

    let capabilities: Value = client
        .get(format!("http://{addr}/_telium/v1/capabilities"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        capabilities.pointer("/features/native_notifications"),
        Some(&Value::Bool(true)),
        "clients must be able to distinguish a notification-capable homeserver",
    );

    let response = client
        .put(format!("http://{addr}/_telium/v1/notifications/device"))
        .bearer_auth(token)
        .json(&json!({
            "algorithm": ALGORITHM_V1,
            "public_key": public,
        }))
        .send()
        .await
        .unwrap();

    assert_ne!(
        response.status(),
        reqwest::StatusCode::METHOD_NOT_ALLOWED,
        "Android enrollment must not fall through to the static 405 response",
    );
    let response = response.error_for_status().unwrap();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body.get("device_id").and_then(Value::as_str), Some(device));
    assert_eq!(
        body.get("algorithm").and_then(Value::as_str),
        Some(ALGORITHM_V1),
    );
    assert!(
        body.get("background_token").and_then(Value::as_str).is_some(),
        "successful enrollment must issue the native background credential",
    );
}

#[tokio::test]
async fn notification_credential_can_rotate_only_its_native_push_endpoint() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    seed_account(&t.state, user, device).await;

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let token = notifications::register_device(&t.state, user, device, ALGORITHM_V1, &public)
        .await
        .unwrap();

    let _ = push::subscribe(
        State(t.state.clone()),
        notification_headers(&token),
        Json(native_subscription("native-webpush")),
    )
    .await
    .expect("notification-only credential may register its own native wake endpoint");

    let row: (String, String, String) = sqlx::query_as(
        "SELECT user_id, device_id, kind FROM push_subscriptions LIMIT 1",
    )
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(row, (user.into(), device.into(), "native-webpush".into()));

    let legacy = push::subscribe(
        State(t.state.clone()),
        notification_headers(&token),
        Json(native_subscription("webpush")),
    )
    .await
    .expect_err("the scoped credential must not create a legacy browser wake subscription");
    assert!(legacy.to_string().contains("native push"), "{legacy}");

    sqlx::query("UPDATE devices SET active = 0 WHERE user_id = ? AND device_id = ?")
        .bind(user)
        .bind(device)
        .execute(&t.state.pool)
        .await
        .unwrap();

    let revoked = push::subscribe(
        State(t.state.clone()),
        notification_headers(&token),
        Json(Subscribe {
            kind: "relay".into(),
            endpoint: "https://push.example.invalid/replacement".into(),
            auth: None,
            p256dh: None,
        }),
    )
    .await;
    assert!(revoked.is_err(), "revoked devices must not rotate provider endpoints");
}

#[tokio::test]
async fn android_setup_test_wake_refuses_a_device_without_native_push() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    seed_account(&t.state, user, device).await;

    let error = push::test_notification_wake(
        State(t.state.clone()),
        HomeAuth {
            user_id: user.into(),
            device_id: device.into(),
        },
    )
    .await
    .expect_err("setup verification must not report ready without a native endpoint");
    assert!(
        error.to_string().contains("background push endpoint"),
        "{error}"
    );
}

#[tokio::test]
async fn android_setup_test_wake_uses_the_signed_in_device_and_high_urgency() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    seed_account(&t.state, user, device).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/wake", listener.local_addr().unwrap());
    let (sender, received) = oneshot::channel();
    let app = Router::new()
        .route("/wake", post(capture_test_wake))
        .with_state(Arc::new(Mutex::new(Some(sender))));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, auth, p256dh, created_at) \
         VALUES ('relay-test', ?, ?, 'relay', ?, NULL, NULL, ?)",
    )
    .bind(user)
    .bind(device)
    .bind(endpoint)
    .bind(now_ms())
    .execute(&t.state.pool)
    .await
    .unwrap();

    let reply = push::test_notification_wake(
        State(t.state.clone()),
        HomeAuth {
            user_id: user.into(),
            device_id: device.into(),
        },
    )
    .await
    .expect("the registered native endpoint should accept a setup wake");
    assert_eq!(reply.0["accepted"], Value::Bool(true));

    let captured = tokio::time::timeout(std::time::Duration::from_secs(2), received)
        .await
        .expect("test wake reached the relay")
        .expect("relay capture stayed alive");
    assert_eq!(captured["body"], json!({ "type": "wake" }));
    assert_eq!(captured["urgency"], "high");
}

#[tokio::test]
async fn native_relay_provider_receives_only_the_doorbell() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    seed_account(&t.state, user, device).await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/wake", listener.local_addr().unwrap());
    let (sender, received) = oneshot::channel();
    let app = Router::new()
        .route("/wake", post(capture_relay))
        .with_state(Arc::new(Mutex::new(Some(sender))));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, auth, p256dh, created_at) \
         VALUES ('relay-1', ?, ?, 'relay', ?, NULL, NULL, ?)",
    )
    .bind(user)
    .bind(device)
    .bind(endpoint)
    .bind(now_ms())
    .execute(&t.state.pool)
    .await
    .unwrap();

    push::notify(
        &t.state,
        user,
        json!({ "type": "migration", "migration_id": "must-not-leave-home" }),
    )
    .await;

    let body = tokio::time::timeout(std::time::Duration::from_secs(2), received)
        .await
        .expect("relay was called")
        .expect("relay capture stayed alive");
    assert_eq!(body, json!({ "type": "wake" }));
    assert!(!body.to_string().contains("must-not-leave-home"));
}

async fn registered(t: &TestState, user: &str, device: &str) -> String {
    seed_account(&t.state, user, device).await;
    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    notifications::register_device(&t.state, user, device, ALGORITHM_V1, &public).await.unwrap()
}

async fn subscription_rows(t: &TestState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM push_subscriptions").fetch_one(&t.state.pool).await.unwrap()
}

mod ssrf {
    use super::*;

    async fn guarded() -> TestState {
        state_with(|cfg, _| cfg.federation.allow_http = false).await
    }

    #[tokio::test]
    async fn a_push_endpoint_pointing_inside_the_network_is_refused() {
        let t = guarded().await;
        for endpoint in [
            "https://127.0.0.2/admin", "https://127.1/admin", "https://[::1]:8080/admin",
            "https://[::ffff:7f00:1]/admin", "https://[::127.0.0.1]/admin",
            "https://169.254.169.254/latest/api/token", "https://[fe80::1]/", "https://[fd00::1]/",
            "https://10.0.0.5:9200/", "https://172.31.255.254/", "https://192.168.1.1/",
            "https://100.64.0.1/", "https://0.0.0.0/", "https://[::]/", "https://[2002:7f00:1::]/",
            "https://[64:ff9b::7f00:1]/", "https://224.0.0.1/", "https://255.255.255.255/",
            "https://240.0.0.1/", "https://93.184.216.34@127.0.0.1/", "http://93.184.216.34/push",
            "ftp://93.184.216.34/push", "file:///etc/passwd", "not a url at all",
        ] {
            let result = telium_server::webpush::checked_endpoint(&t.state, endpoint).await;
            assert!(result.is_err(), "{endpoint} must be refused as a push endpoint");
        }
    }

    #[tokio::test]
    async fn an_ordinary_public_push_endpoint_still_resolves_and_is_pinned() {
        let t = guarded().await;
        for endpoint in ["https://93.184.216.34/push/abc", "https://[2606:2800:220:1:248:1893:25c8:1946]/p", "https://8.8.8.8:8443/p"] {
            let (url, pinned) = telium_server::webpush::checked_endpoint(&t.state, endpoint)
                .await
                .unwrap_or_else(|e| panic!("{endpoint}: {e}"));
            let addr = pinned.expect("the checked address must come back so delivery can pin it");
            assert_eq!(addr.port(), url.port_or_known_default().unwrap());
            assert!(telium_server::webpush::pinned_client(url.host_str().unwrap(), Some(addr)).is_ok());
        }
    }

    #[tokio::test]
    async fn subscribing_to_the_cloud_metadata_service_stores_no_subscription() {
        let t = guarded().await;
        let token = registered(&t, "@bob:bob.example", "phone-1").await;
        let refused = push::subscribe(
            State(t.state.clone()),
            notification_headers(&token),
            Json(Subscribe {
                endpoint: "https://169.254.169.254/latest/api/token".into(),
                ..native_subscription("native-webpush")
            }),
        )
        .await;
        assert!(refused.is_err());
        assert_eq!(subscription_rows(&t).await, 0);
    }
}

mod providers {
    use super::*;
    use axum::extract::Request;
    use axum::response::IntoResponse;
    use std::collections::BTreeMap;
    use telium_server::util::unb64;

    const THROWAWAY_RSA_PKCS8_PEM: &str = "\
         -----BEGIN PRIVATE KEY-----\n\
         MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDTyPJPRLKpUEc0\n\
         3FgeSDUY93UnkxOIqj6dPXkZShdip9UAP+9a0SDjyBMEG71I/T9AZQq3p6X3192F\n\
         wK6gddUdusdpdIdsSOosD53ZgMnpN+PQ45z4QW/xd0+K/KLLetaEoQr3rlky/QBq\n\
         dShui7nRHfM+U8oz8TEzTylLpFkcOUiCfYJSK2xPs+oKk0urPxLvKIRxpMiaZ2PI\n\
         elwnj8veWkTaW9nIgn7bmp+swG44pqj/RzzYOjyQ2fTilfdAhfj6/6FfmuEJY+WA\n\
         NFr5PEmI2sTw4inRZu1MiyxQVJIcsG49caX13WMXMhVoBRIxDdm9dr7DjJds8K2n\n\
         UCbElo77AgMBAAECggEADWNAWggcM9LKJYp2RuJxT3+ObYQrxxxdR+r+ZZMG8RVt\n\
         7rhGmlrqStaMyS+IYtL2ICJ4WngOaEvs33XONCuECinn+Cpwcxpq3y0qNnkgimMe\n\
         Ph1dVgjWRDvdZd+m2i5iMtEhVIXgx/XcBF7H7FuzJofPpsAnjJVccwNijLsPZ6wO\n\
         kBSubS0mJUbYjdwlmZ74FyFidn7ytwkEgMcgOw6eulhCSfbXH77vVMetLwv+hwnF\n\
         Z0ZiNCRkErGHOWmS86kMRR/bQ0V1xEFPG/2TRnve/oZ5/Y4PAXYyh4HVlOPGZy6a\n\
         4qOp7GPht1UY7YEVN7J0SFlgLPbG4eBhW19jXKbS4QKBgQDtC71OCD06hSEcHZq2\n\
         fUBX+A8qF+4sarlErgODl2WhUmb0q3wAR3AFM2CrJgwQasxwfz2Sme6LqReroS2z\n\
         KNM6dKLk+TL3UbsTek7RPQoueJP2bAgzf1TB4oBYc0c71/IsKe+E2xqVIWz4Dvnd\n\
         Vj5K8x0A4AbOpnTwZoAwSuxTmwKBgQDkuB+c51LzDhAPVOUr+FVcrC0PLQA+nIPU\n\
         8XoW7q0+T/2yUWNsTK2Pzp7Io5egvBbFh9Obe8DzkJ+3wZRSpAf7eTPlvgPof8h/\n\
         eBRcbTRPoBUCsPgKo5rt6sbcDtCjQWqIu3MZbbMnZzQRvrbFyMbttQBdxMXiRrgt\n\
         8EJ+Jo/YIQKBgFHCFszvMo8Yk87qtw3yLVsqB7DxCAjx1mzFyBh/A2Kc1T3WV7KQ\n\
         8SYaDmF5gfe3nkO+3zHNPeWVsMBVmzmL/y7OQ9DN0rJS0j9pk/2/G9/jXsVDhaCd\n\
         blJhGPto50zQsopg/GfKWmTNXpRANhYNRPb82ygOHMrxxquT7uq5LMG5AoGBAJTT\n\
         Ch76lor5F5IiV4yo5kKK9jbtvT8AcPfauOq7G5d0TUv+kYcizbzJYaCEcmFwghC+\n\
         NP7zI7ZY4NSc7XpoqZkEYLSZU8mxfDEVXYpWtLcrHwDFTmD93A37urHuIexY4I1g\n\
         C6D8NJrrGIKDakKARpDeOgLJy0lVYvrhXyLezLKBAoGAJkC/egJ+8wJgkjt9f47v\n\
         9AFvJieHus/tF0HR6hKK7x3GPW59UanlKqT8cVjs46/11lHUFXaP8QiHuioatwft\n\
         e/zB02w7s2SMblZ1+b9lNiTU/mYYXVrnbVVWe6ZVrzaX/nIZssVYXmpDGxNEcW3B\n\
         dndA13Y9bEZJaTTFbyr2+FI=\n\
         -----END PRIVATE KEY-----\n\
    ";

    #[derive(Clone, Debug)]
    struct Recorded {
        path: String,
        headers: BTreeMap<String, String>,
        body: String,
    }

    impl Recorded {
        fn json(&self) -> Value {
            serde_json::from_str(&self.body).unwrap_or(Value::Null)
        }
        fn header(&self, name: &str) -> &str {
            self.headers.get(name).map(String::as_str).unwrap_or_default()
        }
    }

    type Shared = Arc<Mutex<(Vec<Recorded>, (u16, Value))>>;

    struct Fake {
        base: String,
        inner: Shared,
    }

    impl Fake {
        async fn start() -> Fake {
            let inner: Shared = Arc::new(Mutex::new((Vec::new(), (200, json!({ "name": "ok" })))));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let app = Router::new().fallback(handle).with_state(inner.clone());
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Fake { base, inner }
        }
        fn requests(&self) -> Vec<Recorded> {
            self.inner.lock().unwrap().0.clone()
        }
        fn push(&self) -> Recorded {
            let sends: Vec<_> = self.requests().into_iter().filter(|r| !r.path.ends_with("/token")).collect();
            assert_eq!(sends.len(), 1, "{sends:#?}");
            sends[0].clone()
        }
        fn answer_with(&self, status: u16, body: Value) {
            self.inner.lock().unwrap().1 = (status, body);
        }
    }

    async fn handle(State(inner): State<Shared>, request: Request) -> axum::response::Response {
        let (parts, body) = request.into_parts();
        let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap_or_default();
        let mut guard = inner.lock().unwrap();
        guard.0.push(Recorded {
            path: parts.uri.path().to_string(),
            headers: parts
                .headers
                .iter()
                .map(|(k, v)| (k.as_str().to_ascii_lowercase(), v.to_str().unwrap_or("").to_string()))
                .collect(),
            body: String::from_utf8_lossy(&bytes).to_string(),
        });
        let (status, body) = if parts.uri.path().ends_with("/token") {
            (200, json!({ "access_token": "ya29.a-fake-access-token", "expires_in": 3600 }))
        } else {
            guard.1.clone()
        };
        (axum::http::StatusCode::from_u16(status).unwrap(), Json(body)).into_response()
    }

    fn fcm(base: String) -> impl FnOnce(&mut Config, &std::path::Path) {
        move |cfg, dir| {
            let path = dir.join("fcm-service-account.json");
            let account = json!({
                "type": "service_account", "project_id": "telium-test-project",
                "private_key_id": "throwaway", "private_key": THROWAWAY_RSA_PKCS8_PEM,
                "client_email": "telium-test@example.invalid",
                "token_uri": "https://oauth2.googleapis.com/token",
            });
            std::fs::write(&path, account.to_string()).unwrap();
            cfg.push.fcm.enabled = true;
            cfg.push.fcm.project_id = "telium-test-project".into();
            cfg.push.fcm.service_account_file = Some(path);
            cfg.push.fcm.token_url = Some(format!("{base}/token"));
            cfg.push.fcm.base_url = Some(base);
        }
    }

    fn apns(base: String) -> impl FnOnce(&mut Config, &std::path::Path) {
        move |cfg, dir| {
            use p256::pkcs8::EncodePrivateKey;
            let pem = SecretKey::random(&mut OsRng).to_pkcs8_pem(p256::pkcs8::LineEnding::LF).unwrap();
            let path = dir.join("apns-key.p8");
            std::fs::write(&path, pem.as_bytes()).unwrap();
            cfg.push.apns.enabled = true;
            cfg.push.apns.team_id = "ABCDE12345".into();
            cfg.push.apns.key_id = "FGHIJ67890".into();
            cfg.push.apns.bundle_id = "chat.telium.ios".into();
            cfg.push.apns.key_file = Some(path);
            cfg.push.apns.base_url = Some(base);
        }
    }

    const USER: &str = "@bob:bob.example";
    const DEVICE: &str = "phone-1";

    async fn subscribed(
        configure: impl FnOnce(&mut Config, &std::path::Path),
        kind: &str,
        token: &str,
    ) -> (TestState, Result<(), String>) {
        let t = state_with(configure).await;
        let credential = registered(&t, USER, DEVICE).await;
        let result = push::subscribe(
            State(t.state.clone()),
            notification_headers(&credential),
            Json(Subscribe { kind: kind.into(), endpoint: token.into(), auth: None, p256dh: None }),
        )
        .await
        .map(|_| ())
        .map_err(|e| format!("{e:?}"));
        (t, result)
    }

    async fn wake(t: &TestState) -> bool {
        let auth = HomeAuth { user_id: USER.into(), device_id: DEVICE.into() };
        push::test_notification_wake(State(t.state.clone()), auth).await.is_ok()
    }

    async fn failures(t: &TestState) -> i64 {
        sqlx::query_scalar("SELECT failures FROM push_subscriptions").fetch_one(&t.state.pool).await.unwrap()
    }

    fn jwt_part(jwt: &str, index: usize) -> Value {
        serde_json::from_slice(&unb64(jwt.split('.').nth(index).unwrap()).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn an_unconfigured_server_refuses_provider_registrations_and_stores_nothing() {
        for (kind, product, section) in [("fcm", "Firebase", "push.fcm"), ("apns", "Apple Push", "push.apns")] {
            let (t, result) = subscribed(|_, _| {}, kind, "0123456789abcdef0123456789abcdef").await;
            let message = result.expect_err("an unconfigured provider cannot wake anything");
            assert!(message.contains(product) && message.contains(section), "{message}");
            assert_eq!(subscription_rows(&t).await, 0);
            assert!(!wake(&t).await);
        }
    }

    #[tokio::test]
    async fn a_wake_reaches_fcm_as_a_bearer_authenticated_content_free_doorbell() {
        let fake = Fake::start().await;
        let device_token = "cZ9fake-device-token:APA91bFAKE_registration";
        let (t, result) = subscribed(fcm(fake.base.clone()), "fcm", device_token).await;
        result.unwrap();
        assert!(wake(&t).await);

        let token_request = fake.requests().into_iter().find(|r| r.path == "/token").expect("no token minted");
        let form: BTreeMap<String, String> =
            url::form_urlencoded::parse(token_request.body.as_bytes()).into_owned().collect();
        assert_eq!(form["grant_type"], "urn:ietf:params:oauth:grant-type:jwt-bearer");
        assert_eq!(jwt_part(&form["assertion"], 0)["alg"], "RS256");
        let claims = jwt_part(&form["assertion"], 1);
        assert_eq!(claims["iss"], "telium-test@example.invalid");
        assert_eq!(claims["scope"], "https://www.googleapis.com/auth/firebase.messaging");
        assert_eq!(claims["aud"], format!("{}/token", fake.base));

        let send = fake.push();
        assert_eq!(send.path, "/v1/projects/telium-test-project/messages:send");
        assert_eq!(send.header("authorization"), "Bearer ya29.a-fake-access-token");
        assert_eq!(
            send.json(),
            json!({ "message": {
                "token": device_token,
                "data": { "telium": "{\"type\":\"wake\"}" },
                "android": { "priority": "HIGH", "ttl": "86400s" }
            } }),
            "the FCM message is the doorbell and nothing else"
        );
        assert_eq!(failures(&t).await, 0);
    }

    #[tokio::test]
    async fn a_wake_reaches_apns_with_apples_headers_and_a_constant_payload() {
        let fake = Fake::start().await;
        let device_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let (t, result) = subscribed(apns(fake.base.clone()), "apns", device_token).await;
        result.unwrap();
        assert!(wake(&t).await);

        let send = fake.push();
        assert_eq!(send.path, format!("/3/device/{device_token}"));
        assert_eq!(send.header("apns-topic"), "chat.telium.ios");
        assert_eq!(send.header("apns-push-type"), "alert");
        assert_eq!(send.header("apns-priority"), "10");
        let expiration: i64 = send.header("apns-expiration").parse().unwrap();
        assert!((expiration - (now_ms() / 1000 + 86_400)).abs() < 120, "{expiration}");
        let jwt = send.header("authorization").strip_prefix("bearer ").expect("bearer provider token");
        assert_eq!(jwt_part(jwt, 0)["alg"], "ES256");
        assert_eq!(jwt_part(jwt, 0)["kid"], "FGHIJ67890");
        assert_eq!(jwt_part(jwt, 1)["iss"], "ABCDE12345");
        assert_eq!(
            send.json(),
            json!({ "aps": {
                "alert": { "loc-key": "notification.placeholder", "body": "New message" },
                "mutable-content": 1, "thread-id": "telium", "sound": "default"
            } }),
            "the APNs payload is fixed text and carries nothing about the event"
        );
    }

    #[tokio::test]
    async fn revocations_drop_the_registration_and_outages_keep_it() {
        let unregistered = json!({ "error": { "status": "NOT_FOUND", "details": [{ "errorCode": "UNREGISTERED" }] } });
        for (kind, status, body, kept) in [
            ("fcm", 404, unregistered, false),
            ("apns", 410, json!({ "reason": "Unregistered" }), false),
            ("apns", 400, json!({ "reason": "BadDeviceToken" }), false),
            ("fcm", 503, json!({ "error": { "status": "UNAVAILABLE" } }), true),
        ] {
            let fake = Fake::start().await;
            let configure: Box<dyn FnOnce(&mut Config, &std::path::Path)> =
                if kind == "fcm" { Box::new(fcm(fake.base.clone())) } else { Box::new(apns(fake.base.clone())) };
            let (t, result) = subscribed(configure, kind, "0123456789abcdef0123456789abcdef").await;
            result.unwrap();
            fake.answer_with(status, body);
            assert!(!wake(&t).await, "{kind} {status} is not a delivery");
            assert_eq!(subscription_rows(&t).await == 1, kept, "{kind} {status}");
            if kept {
                assert_eq!(failures(&t).await, 1, "an outage is counted so a dead endpoint ages out");
                fake.answer_with(200, json!({ "name": "ok" }));
                assert!(wake(&t).await);
                assert_eq!(failures(&t).await, 0);
            }
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let (t, result) = subscribed(fcm(dead), "fcm", "a-perfectly-good-token").await;
        result.unwrap();
        assert!(!wake(&t).await);
        assert_eq!(subscription_rows(&t).await, 1, "an unreachable provider says nothing about the token");
    }

    #[tokio::test]
    async fn a_plaintext_override_without_the_developer_flag_refuses_to_boot() {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("telium-push-guard-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = Config {
            server_name: "bob.example".into(),
            public_base_url: "https://bob.example".into(),
            database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
            media_dir: dir.join("media"),
            ..Config::default()
        };
        cfg.backup.enabled = false;
        cfg.archive.dir = dir.join("cold");
        cfg.mfa.key_file = dir.join("mfa.key");
        fcm("http://127.0.0.1:9".into())(&mut cfg, &dir);
        let error = telium_server::build_state(cfg.clone()).await.err().expect("must refuse to boot").to_string();
        assert!(error.contains("federation.allow_http"), "{error}");
        cfg.federation.allow_http = true;
        assert!(telium_server::build_state(cfg).await.is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
