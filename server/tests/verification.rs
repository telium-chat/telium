
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    client: reqwest::Client,
    state: telium_server::AppState,
    dir: std::path::PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-verify-test-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: "test.example".into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.rate_limit.auth_burst = 1_000;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), state, dir }
}

struct User {
    user_id: String,
    home: String,
}

impl Server {
    async fn call(&self, method: reqwest::Method, path: &str, token: Option<&str>, body: Option<Value>) -> (u16, Value) {
        let mut req = self.client.request(method, format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let response = req.send().await.unwrap();
        (response.status().as_u16(), response.json().await.unwrap_or(json!(null)))
    }

    async fn user(&self, localpart: &str) -> User {
        let body = json!({ "localpart": localpart, "password": "correct horse battery" });
        let (status, body) = self.call(reqwest::Method::POST, "/_telium/v1/register", None, Some(body)).await;
        assert_eq!(status, 200, "register: {body}");
        User { user_id: body["user_id"].as_str().unwrap().into(), home: body["access_token"].as_str().unwrap().into() }
    }

    async fn verify(&self, from: &User, to_user: &str, step: &str) -> (u16, Value) {
        let payload = match step {
            "start" => json!({ "step": "start", "id": "flow-1", "methods": ["sas.v1"] }),
            other => json!({ "step": other, "id": "flow-1" }),
        };
        let body = json!({ "to_user": to_user, "payload": payload });
        self.call(reqwest::Method::POST, "/_telium/v1/verify", Some(&from.home), Some(body)).await
    }

    async fn signatures_of(&self, subject: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM user_signatures WHERE subject = ?")
            .bind(subject)
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn a_bot_is_never_verified_and_an_old_tick_on_one_is_hidden() {
    let s = start().await;
    let alice = s.user("alice").await;
    let human = s.user("bob").await;
    let app = json!({
        "name": "Ping", "localpart": "pingbot",
        "allowed_intents": ["GUILD_MESSAGES"], "default_permissions": ["VIEW_CHANNEL", "SEND_MESSAGES"],
    });
    let (status, app) = s.call(reqwest::Method::POST, "/_telium/v1/applications", Some(&alice.home), Some(app)).await;
    assert_eq!(status, 200, "{app}");
    let bot = app["bot_user_id"].as_str().unwrap().to_string();

    let sign = json!({ "subject_key": "key-bot", "signature": "sig" });
    let path = format!("/_telium/v1/crosssigning/users/{bot}");
    let (status, body) = s.call(reqwest::Method::PUT, &path, Some(&alice.home), Some(sign)).await;
    assert_eq!((status, body["code"].as_str()), (403, Some("subject_is_bot")), "{body}");
    assert_eq!(s.signatures_of(&bot).await, 0, "a refused signature was stored");
    let (status, body) = s.verify(&alice, &bot, "start").await;
    assert_eq!((status, body["code"].as_str()), (403, Some("party_is_bot")), "{body}");

    for subject in [&bot, &human.user_id] {
        sqlx::query(
            "INSERT INTO user_signatures (signer, subject, subject_key, signature, signed_at) \
             VALUES (?, ?, 'key', 'sig', 1700000000000)",
        )
        .bind(&alice.user_id)
        .bind(subject)
        .execute(&s.state.pool)
        .await
        .unwrap();
    }
    let (status, body) = s.call(reqwest::Method::GET, "/_telium/v1/crosssigning", Some(&alice.home), None).await;
    assert_eq!(status, 200, "{body}");
    let subjects: Vec<&str> = body["signatures"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap()).collect();
    assert_eq!(subjects, vec![human.user_id.as_str()], "{body}");
    assert_eq!(s.signatures_of(&bot).await, 1);
}

#[tokio::test]
async fn asking_one_person_is_rationed_until_they_answer() {
    let s = start().await;
    let (alice, bob, carol) = (s.user("alice").await, s.user("bob").await, s.user("carol").await);

    let (status, body) = s.verify(&alice, &bob.user_id, "start").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["request"]["subject"], bob.user_id);
    let window = body["request"]["may_ask_again_at"].as_i64().unwrap() - body["request"]["requested_at"].as_i64().unwrap();
    assert_eq!(window, 60 * 60 * 1000);

    let (status, body) = s.verify(&alice, &bob.user_id, "start").await;
    assert_eq!((status, body["code"].as_str()), (429, Some("verification_already_requested")), "{body}");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(message.contains("asked") && message.contains("ask again"), "{body}");

    assert_eq!(s.verify(&alice, &carol.user_id, "start").await.0, 200, "another person is another ask");
    let (_, body) = s.call(reqwest::Method::GET, "/_telium/v1/crosssigning", Some(&alice.home), None).await;
    let pending: Vec<&str> = body["requests"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap()).collect();
    assert!(pending.contains(&bob.user_id.as_str()) && pending.contains(&carol.user_id.as_str()), "{body}");

    assert_eq!(s.verify(&bob, &alice.user_id, "cancel").await.0, 200);
    assert_eq!(s.verify(&alice, &bob.user_id, "start").await.0, 429);
    assert_eq!(s.verify(&bob, &alice.user_id, "accept").await.0, 200);
    assert_eq!(s.verify(&alice, &bob.user_id, "start").await.0, 200);

    for attempt in 0..3 {
        let (status, body) = s.verify(&alice, &alice.user_id, "start").await;
        assert_eq!(status, 200, "attempt {attempt}: {body}");
        assert!(body["request"].is_null(), "{body}");
    }
}
