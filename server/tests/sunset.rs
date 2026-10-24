
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

const PASSWORD: &str = "correct horse battery";

struct Server {
    name: String,
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    serve: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.serve.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn boot_on(
    listener: tokio::net::TcpListener,
    name: &str,
    idx: u32,
    peers: BTreeMap<String, String>,
    delay_secs: i64,
) -> Server {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-sunset-{}-{n}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: name.into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.federation.allow_http = true;
    cfg.federation.peers = peers;
    cfg.federation.migration_delay_secs = delay_secs;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server { name: name.into(), base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state, serve }
}

async fn listener() -> tokio::net::TcpListener {
    tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
}

async fn single() -> Server {
    let l = listener().await;
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", l.local_addr().unwrap()));
    boot_on(l, "a.test", 0, peers, 0).await
}

async fn pair(delay_secs: i64) -> (Server, Server) {
    let (la, lb) = (listener().await, listener().await);
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    let a = boot_on(la, "a.test", 0, peers.clone(), delay_secs).await;
    let b = boot_on(lb, "b.test", 1, peers, 0).await;
    (a, b)
}

struct Account {
    id: String,
    token: String,
    secret: String,
}

impl Server {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = self.client.get(format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn register(&self, localpart: &str) -> Account {
        let (status, body) = self
            .post("/_telium/v1/register", None, json!({ "localpart": localpart, "password": PASSWORD }))
            .await;
        assert_eq!(status, 200, "register: {body}");
        Account {
            id: body["user_id"].as_str().unwrap().to_string(),
            token: body["access_token"].as_str().unwrap().to_string(),
            secret: body["device_secret"].as_str().expect("server-generated device key").to_string(),
        }
    }

    async fn elevate(&self, account: &Account) {
        let (status, body) = self
            .post("/_telium/v1/admin/step-up", Some(&account.token), json!({ "password": PASSWORD }))
            .await;
        assert_eq!(status, 200, "step-up: {body}");
    }

    async fn session_on(&self, home_token: &str, other: &Server) -> String {
        let (status, assertion) = self
            .post("/_telium/v1/assertions", Some(home_token), json!({ "audience": other.name }))
            .await;
        assert_eq!(status, 200, "assertion: {assertion}");
        let (status, session) = other
            .post("/_telium/v1/sessions", None, json!({ "assertion": assertion["assertion"] }))
            .await;
        assert_eq!(status, 200, "remote session: {session}");
        session["session_token"].as_str().unwrap().to_string()
    }

    async fn announce_shutdown(&self, root: &Account, effective_at: i64) -> Value {
        let (status, body) = self
            .post(
                "/_telium/v1/admin/sunset",
                Some(&root.token),
                json!({ "mode": "shutdown", "effective_at": effective_at, "message": "Thanks for everything" }),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn tombstone(&self, subject_type: &str, subject_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT kind FROM tombstones WHERE subject_type = ? AND subject_id = ?")
            .bind(subject_type)
            .bind(subject_id)
            .fetch_optional(&self.state.pool)
            .await
            .unwrap()
    }

    async fn migration_state(&self, subject_id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT state FROM migrations WHERE subject_id = ? ORDER BY created_at DESC")
            .bind(subject_id)
            .fetch_optional(&self.state.pool)
            .await
            .unwrap()
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn device_sign(device_secret_b64: &str, payload: &[u8]) -> String {
    let raw = telium_server::util::unb64(device_secret_b64).expect("device secret is base64");
    let bytes: [u8; 32] = raw.try_into().expect("ed25519 secret is 32 bytes");
    let key = ed25519_dalek::SigningKey::from_bytes(&bytes);
    let sig = ed25519_dalek::Signer::sign(&key, payload);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

async fn consent_to_move(a: &Server, b: &Server, owner: &Account, receiver: &Account) -> Value {
    let (status, accepted) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&receiver.token),
            json!({ "subject_type": "user", "source": "a.test", "source_id": owner.id }),
        )
        .await;
    assert_eq!(status, 200, "{accepted}");
    let import_token = accepted["import_token"].as_str().unwrap().to_string();
    let (status, grant) = a
        .post(
            "/_telium/v1/migrate/grant-payload",
            Some(&owner.token),
            json!({ "subject_type": "user", "destination": "b.test", "import_token": import_token }),
        )
        .await;
    assert_eq!(status, 200, "{grant}");
    let payload = telium_server::util::unb64(grant["payload"].as_str().unwrap()).unwrap();
    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&owner.token),
            json!({
                "subject_type": "user", "destination": "b.test", "import_token": import_token,
                "password": PASSWORD, "device_signature": device_sign(&owner.secret, &payload),
                "created_at": grant["created_at"],
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    started
}

#[tokio::test]
async fn a_shutdown_closes_registration_and_every_login_carries_the_date() {
    let a = single().await;
    let root = a.register("root").await;
    a.elevate(&root).await;
    let alice = a.register("alice").await;
    let effective_at = now_ms() + 30 * 24 * 3600 * 1000;

    let (status, _) = a
        .post("/_telium/v1/admin/sunset", Some(&alice.token), json!({ "mode": "shutdown" }))
        .await;
    assert_eq!(status, 403);
    a.announce_shutdown(&root, effective_at).await;

    let (status, body) = a
        .post("/_telium/v1/register", None, json!({ "localpart": "latecomer", "password": PASSWORD }))
        .await;
    assert_eq!(status, 403, "nobody signs up to a server that is ending: {body}");
    let (status, _) = a.post("/_telium/v1/register/opaque/start", None, json!({})).await;
    assert!(status == 403 || status == 422 || status == 400, "{status}");
    let (_, caps) = a.get("/_telium/v1/capabilities", None).await;
    if !caps.is_null() && caps.get("registration_open").is_some() {
        assert_eq!(caps["registration_open"], false);
    }

    let (status, login) = a
        .post("/_telium/v1/login", None, json!({ "user": "alice", "password": PASSWORD }))
        .await;
    assert_eq!(status, 200, "{login}");
    assert_eq!(login["sunset"]["mode"], "shutdown");
    assert_eq!(login["sunset"]["effective_at"], effective_at);
    assert_eq!(login["sunset"]["message"], "Thanks for everything");
    assert_eq!(login["sunset"]["finalized"], false);

    let (status, _) = a.post("/_telium/v1/admin/sunset", Some(&root.token), json!({ "mode": "none" })).await;
    assert_eq!(status, 200);
    let (_, login) = a
        .post("/_telium/v1/login", None, json!({ "user": "alice", "password": PASSWORD }))
        .await;
    assert!(login.get("sunset").is_none(), "{login}");
    a.register("latecomer").await;
}

#[tokio::test]
async fn an_account_bundle_needs_the_password_and_is_signed_by_the_server() {
    let a = single().await;
    let alice = a.register("alice").await;

    let (status, _) = a.post("/_telium/v1/account/bundle", Some(&alice.token), json!({})).await;
    assert_eq!(status, 400, "a session alone does not take the key vault away");
    let (status, _) = a
        .post("/_telium/v1/account/bundle", Some(&alice.token), json!({ "password": "wrong password here" }))
        .await;
    assert_eq!(status, 401);
    let (status, _) = a.post("/_telium/v1/account/bundle", None, json!({ "password": PASSWORD })).await;
    assert_eq!(status, 401);

    let (status, bundle) = a
        .post("/_telium/v1/account/bundle", Some(&alice.token), json!({ "password": PASSWORD }))
        .await;
    assert_eq!(status, 200, "{bundle}");
    assert_eq!(bundle["format"], "telium-account-bundle-v1");
    assert_eq!(bundle["user_id"], alice.id);
    assert_eq!(bundle["origin"], "a.test");
    assert!(bundle["account"].is_object());
    assert!(bundle["keys"].is_object(), "the key to check it with rides along");
    assert!(telium_server::crypto::verify_json(&a.state.key.public_b64(), &bundle));
    let mut edited = bundle.clone();
    edited["user_id"] = json!("@mallory:a.test");
    assert!(!telium_server::crypto::verify_json(&a.state.key.public_b64(), &edited));
}

#[tokio::test]
async fn bulk_execution_moves_only_the_people_who_asked_and_the_end_is_signed() {
    let (a, b) = pair(0).await;
    let root = a.register("root").await;
    a.elevate(&root).await;
    let alice = a.register("alice").await;
    let bob = a.register("bob").await;
    let carol = a.register("carol").await;
    let alice_there = b.register("alice").await;

    let carol_session = a.session_on(&carol.token, &a).await;
    let (status, guild) = a.post("/_telium/v1/guilds", Some(&carol_session), json!({ "name": "Last orders" })).await;
    assert_eq!(status, 200, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();

    consent_to_move(&a, &b, &alice, &alice_there).await;

    let bob_device: String = sqlx::query_scalar("SELECT device_id FROM devices WHERE user_id = ?")
        .bind(&bob.id)
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    let forged = device_sign(&alice.secret, b"not bob's consent");
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, device_id, \
         device_sig, state, created_at, executes_at) VALUES ('forged', 'user', ?, 'b.test', 'x', ?, ?, \
         'pending', ?, ?)",
    )
    .bind(&bob.id)
    .bind(&bob_device)
    .bind(&forged)
    .bind(now_ms())
    .bind(now_ms())
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (status, _) = a.post("/_telium/v1/admin/sunset/execute", Some(&root.token), json!({})).await;
    assert_eq!(status, 409);
    a.announce_shutdown(&root, now_ms()).await;
    let (status, _) = a.post("/_telium/v1/admin/sunset/execute", Some(&alice.token), json!({})).await;
    assert_eq!(status, 403);

    let (status, report) = a.post("/_telium/v1/admin/sunset/execute", Some(&root.token), json!({})).await;
    assert_eq!(status, 200, "{report}");
    let executed: Vec<&str> =
        report["executed"].as_array().unwrap().iter().map(|r| r["migration"]["subject_id"].as_str().unwrap()).collect();
    assert_eq!(executed, vec![alice.id.as_str()], "{report}");
    let refused: Vec<&str> =
        report["refused"].as_array().unwrap().iter().map(|r| r["migration"]["id"].as_str().unwrap()).collect();
    assert_eq!(refused, vec!["forged"], "{report}");

    assert_eq!(a.tombstone("user", &alice.id).await.as_deref(), Some("moved"));
    assert_eq!(a.migration_state(&alice.id).await.as_deref(), Some("completed"));
    assert_eq!(a.tombstone("user", &bob.id).await, None, "a server must not move anyone who did not ask");
    assert_eq!(a.migration_state(&bob.id).await.as_deref(), Some("pending"));
    assert_eq!(a.tombstone("user", &carol.id).await, None);
    assert_eq!(a.migration_state(&carol.id).await, None);

    let (status, _) = a
        .post("/_telium/v1/admin/sunset/finalize", Some(&root.token), json!({ "confirm": "b.test" }))
        .await;
    assert_eq!(status, 400);
    let (status, body) = a
        .post("/_telium/v1/admin/sunset/finalize", Some(&root.token), json!({ "confirm": "a.test" }))
        .await;
    assert_eq!(status, 409, "the forged row is still in flight: {body}");
    let (status, done) = a
        .post(
            "/_telium/v1/admin/sunset/finalize",
            Some(&root.token),
            json!({ "confirm": "a.test", "abandon_pending": true }),
        )
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["abandoned_moves"], 1);
    assert_eq!(a.migration_state(&bob.id).await.as_deref(), Some("failed"));

    assert_eq!(a.tombstone("user", &alice.id).await.as_deref(), Some("moved"));
    for who in [&root, &bob, &carol] {
        assert_eq!(a.tombstone("user", &who.id).await.as_deref(), Some("gone"), "{}", who.id);
    }
    assert_eq!(a.tombstone("guild", &guild_id).await.as_deref(), Some("gone"));
    assert_eq!(a.tombstone("domain", "a.test").await.as_deref(), Some("gone"));
    assert!(telium_server::crypto::verify_json(&a.state.key.public_b64(), &done["tombstone"]));

    let (status, carol_status) = a.get(&format!("/_telium/v1/users/{}/status", carol.id), None).await;
    assert_eq!(status, 200, "{carol_status}");
    assert_eq!(carol_status["status"], "gone");
    assert_eq!(carol_status["tombstone"]["kind"], "gone");
    let (_, guild_status) = a.get(&format!("/_telium/v1/guilds/{guild_id}/status"), None).await;
    assert_eq!(guild_status["status"], "gone");

    let (status, refused) = a.post("/_telium/v1/guilds", Some(&carol_session), json!({ "name": "again" })).await;
    assert_eq!(status, 410, "{refused}");
    assert_eq!(refused["error"], "shut_down");
    let (status, _) = a.post("/_telium/v1/admin/sunset", Some(&root.token), json!({ "mode": "none" })).await;
    assert_eq!(status, 410, "a finished shutdown is not withdrawn");
    let (status, login) = a
        .post("/_telium/v1/login", None, json!({ "user": "carol", "password": PASSWORD }))
        .await;
    assert_eq!(status, 200, "{login}");
    assert_eq!(login["sunset"]["finalized"], true);
    let token = login["access_token"].as_str().unwrap();
    let (status, bundle) = a
        .post("/_telium/v1/account/bundle", Some(token), json!({ "password": PASSWORD }))
        .await;
    assert_eq!(status, 200, "{bundle}");
    assert_eq!(bundle["user_id"], carol.id);
}

#[tokio::test]
async fn a_shutdown_date_does_not_shorten_anybody_s_cooling_off() {
    let (a, b) = pair(60 * 24 * 3600).await;
    let root = a.register("root").await;
    a.elevate(&root).await;
    let alice = a.register("alice").await;
    let alice_there = b.register("alice").await;
    a.announce_shutdown(&root, now_ms() + 24 * 3600 * 1000).await;
    let started = consent_to_move(&a, &b, &alice, &alice_there).await;

    let (status, report) = a.post("/_telium/v1/admin/sunset/execute", Some(&root.token), json!({})).await;
    assert_eq!(status, 200, "{report}");
    assert!(report["executed"].as_array().unwrap().is_empty(), "{report}");
    let waiting = &report["waiting"][0];
    assert_eq!(waiting["migration"]["id"], started["id"]);
    assert_eq!(waiting["misses_deadline"], true);
    assert_eq!(a.migration_state(&alice.id).await.as_deref(), Some("pending"));
    assert_eq!(a.tombstone("user", &alice.id).await, None);

    let (status, _) = a
        .post(
            "/_telium/v1/admin/sunset/finalize",
            Some(&root.token),
            json!({ "confirm": "a.test", "abandon_pending": true }),
        )
        .await;
    assert_eq!(status, 409);
    let _ = b.name.clone();
}
