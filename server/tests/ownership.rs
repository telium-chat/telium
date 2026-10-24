
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::gateway;
use telium_server::ownership::{self, HostEvidence};

static COUNTER: AtomicU32 = AtomicU32::new(0);
const PASSWORD: &str = "correct horse battery";

struct Server {
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    founder: String,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-ownership-{}-{n}", std::process::id()));
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
    cfg.ownership.recovery_delay_secs = 0;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    let mut s = Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state, founder: String::new() };
    s.founder = s.register("founder").await;
    s
}

fn id(localpart: &str) -> String {
    format!("@{localpart}:test.example")
}

fn evidence(database_mode: Option<u32>, directory_mode: Option<u32>) -> HostEvidence {
    HostEvidence {
        database: "/tmp/telium/telium.db".into(),
        config: "/tmp/telium.toml".into(),
        uid: Some(0),
        hostname: Some("test-host".into()),
        database_mode,
        directory_mode,
    }
}

impl Server {
    async fn call(&self, method: &str, path: &str, token: &str, body: Value) -> (u16, Value) {
        let mut req = self.client.request(method.parse().unwrap(), format!("{}/_telium/v1{path}", self.base));
        if !body.is_null() {
            req = req.json(&body);
        }
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(Value::Null))
    }

    async fn register(&self, localpart: &str) -> String {
        let (status, body) =
            self.call("POST", "/register", "", json!({ "localpart": localpart, "password": PASSWORD })).await;
        assert_eq!(status, 200, "register {localpart}: {body}");
        body["access_token"].as_str().unwrap().to_string()
    }

    async fn admin_op(&self, op: &str, localpart: &str) -> (u16, Value) {
        let body = json!({ "user_id": id(localpart), "password": PASSWORD });
        self.call("POST", &format!("/admin/ownership/{op}"), &self.founder, body).await
    }

    async fn sql(&self, query: &str, localpart: &str) {
        sqlx::query(query).bind(id(localpart)).execute(&self.state.pool).await.unwrap();
    }

    async fn deactivate(&self, localpart: &str) {
        self.sql("UPDATE accounts SET deactivated = 1 WHERE user_id = ?", localpart).await;
    }

    async fn strip_credential(&self, localpart: &str) {
        self.sql("UPDATE accounts SET password_hash = 'opaque:v1', opaque_record = NULL WHERE user_id = ?", localpart)
            .await;
    }

    async fn is_admin(&self, localpart: &str) -> bool {
        sqlx::query_scalar::<_, i64>("SELECT admin FROM accounts WHERE user_id = ?")
            .bind(id(localpart))
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
            != 0
    }

    async fn count_audit(&self, action: &str) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM server_audit_log WHERE action = ?")
            .bind(action)
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }

    async fn open_claim(&self, subject: &str, ev: &HostEvidence) -> Result<String, String> {
        ownership::open_claim(&self.state.pool, &id(subject), "recovering", ev, 0)
            .await
            .map(|(claim, _, _)| claim)
            .map_err(|e| e.to_string())
    }

    async fn run_claims(&self) -> usize {
        ownership::run_pending(&self.state).await.unwrap()
    }
}

#[tokio::test]
async fn ownership_routes_refuse_ordinary_and_anonymous_callers() {
    let s = start().await;
    let mallory = s.register("mallory").await;
    for (method, path) in [
        ("GET", "/admin/ownership"),
        ("POST", "/admin/ownership/grant"),
        ("POST", "/admin/ownership/revoke"),
        ("GET", "/admin/ownership/sessions"),
        ("DELETE", "/admin/ownership/sessions/whatever"),
        ("POST", "/admin/ownership/recovery/whatever/cancel"),
    ] {
        let body = if method == "GET" { Value::Null } else { json!({ "user_id": id("founder"), "password": PASSWORD }) };
        for (token, want) in [(mallory.as_str(), 403), ("", 401)] {
            let (status, resp) = s.call(method, path, token, body.clone()).await;
            assert_eq!(status, want, "{method} {path}: {resp}");
            for leak in ["administrators", "usable", "pending_recovery_claims", "devices"] {
                assert!(resp.get(leak).is_none(), "{method} {path} leaked {leak}: {resp}");
            }
        }
    }
}

#[tokio::test]
async fn a_grant_needs_the_password_and_a_usable_target_and_is_audited() {
    let s = start().await;
    for lp in ["second", "ghost", "off"] {
        s.register(lp).await;
    }
    for body in [json!({ "user_id": id("second") }), json!({ "user_id": id("second"), "password": "wrong" })] {
        let (status, answer) = s.call("POST", "/admin/ownership/grant", &s.founder, body).await;
        assert!((400..500).contains(&status), "{status}: {answer}");
    }
    assert!(!s.is_admin("second").await);
    assert_eq!(s.count_audit("ownership.deny").await, 2);

    assert_eq!(s.admin_op("grant", "second").await.0, 200);
    let granted_by: Option<String> = sqlx::query_scalar("SELECT admin_granted_by FROM accounts WHERE user_id = ?")
        .bind(id("second"))
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(granted_by, Some(id("founder")));
    assert_eq!(s.admin_op("grant", "second").await.0, 409, "double grant");

    s.strip_credential("ghost").await;
    s.deactivate("off").await;
    for lp in ["ghost", "off"] {
        assert_eq!(s.admin_op("grant", lp).await.0, 409, "{lp} cannot sign in, so cannot hold the column");
        assert!(!s.is_admin(lp).await);
    }

    s.deactivate("second").await;
    assert_eq!(s.admin_op("revoke", "second").await.0, 200);
    assert!(!s.is_admin("second").await);
    assert_eq!((s.count_audit("ownership.grant").await, s.count_audit("ownership.revoke").await), (1, 1));
}

#[tokio::test]
async fn the_last_usable_administrator_cannot_leave_by_any_door() {
    let s = start().await;
    let pw = json!({ "password": PASSWORD });
    for (attempted, (status, body)) in [
        ("deactivate", s.call("POST", "/account/deactivate", &s.founder, pw.clone()).await),
        ("delete", s.call("DELETE", "/account", &s.founder, pw.clone()).await),
        ("revoke", s.admin_op("revoke", "founder").await),
    ] {
        assert_eq!(status, 409, "{attempted}: {body}");
        assert_eq!(body["code"], "last_admin", "{body}");
        assert_eq!(body["attempted"], attempted, "{body}");
        assert_eq!(body["user_id"], id("founder"), "{body}");
        let message = body["message"].as_str().unwrap_or_default();
        assert!(message.to_lowercase().contains("grant"), "{attempted}: no way forward in {message}");
        if attempted != "revoke" {
            assert!(message.contains("only administrator") && message.contains("Grant"), "{attempted}: {message}");
        }
    }
    let moved = ownership::refuse_if_last_admin(&s.state.pool, &id("founder"), ownership::Departure::Move)
        .await
        .unwrap_err();
    assert_eq!(moved.body()["attempted"], "move", "{}", moved.body());
    let deactivated: i64 = sqlx::query_scalar("SELECT deactivated FROM accounts WHERE user_id = ?")
        .bind(id("founder"))
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(deactivated, 0);
    assert!(s.is_admin("founder").await);

    s.register("second").await;
    assert_eq!(s.admin_op("grant", "second").await.0, 200);
    s.deactivate("second").await;
    assert_eq!(s.admin_op("revoke", "founder").await.0, 409, "deactivated admin counted as usable");
    let (_, overview) = s.call("GET", "/admin/ownership", &s.founder, Value::Null).await;
    assert_eq!(overview["usable"], 1, "{overview}");
    assert_eq!(overview["sole_administrator"], true, "{overview}");
    s.sql("UPDATE accounts SET deactivated = 0 WHERE user_id = ?", "second").await;
    s.strip_credential("second").await;
    assert_eq!(s.admin_op("revoke", "founder").await.0, 409, "credential-less admin counted as usable");

    let ordinary = s.register("leaving").await;
    assert_eq!(s.call("POST", "/account/deactivate", &ordinary, pw).await.0, 200);
}

#[tokio::test]
async fn a_recovery_claim_is_announced_before_it_applies_and_can_be_stopped() {
    let good = evidence(Some(0o600), Some(0o700));

    let s = start().await;
    s.register("rescuer").await;
    let claim = s.open_claim("rescuer", &good).await.unwrap();
    assert_eq!(s.run_claims().await, 0, "applied in the announcing pass");
    let announced: Option<i64> = sqlx::query_scalar("SELECT announced_at FROM admin_recovery_claims WHERE id = ?")
        .bind(&claim)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert!(announced.is_some() && !s.is_admin("rescuer").await);
    assert_eq!(s.run_claims().await, 1);
    assert!(s.is_admin("rescuer").await);
    assert_eq!(
        (s.count_audit("ownership.recovery.open").await, s.count_audit("ownership.recovery.apply").await),
        (1, 1)
    );

    let s = start().await;
    s.register("rescuer").await;
    let claim = s.open_claim("rescuer", &good).await.unwrap();
    s.run_claims().await;
    let (_, overview) = s.call("GET", "/admin/ownership", &s.founder, Value::Null).await;
    assert_eq!(overview["pending_recovery_claims"].as_array().unwrap().len(), 1, "{overview}");
    let cancel = format!("/admin/ownership/recovery/{claim}/cancel");
    assert_eq!(s.call("POST", &cancel, &s.founder, json!({})).await.0, 200);
    assert_eq!(s.run_claims().await, 0);
    assert!(!s.is_admin("rescuer").await);

    let s = start().await;
    s.register("rescuer").await;
    s.open_claim("rescuer", &good).await.unwrap();
    s.run_claims().await;
    s.deactivate("rescuer").await;
    assert_eq!(s.run_claims().await, 0);
    let by: Option<String> = sqlx::query_scalar("SELECT cancelled_by FROM admin_recovery_claims WHERE subject = ?")
        .bind(id("rescuer"))
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(by.as_deref(), Some("system"));

    let s = start().await;
    s.register("second").await;
    s.admin_op("grant", "second").await;
    s.sql("UPDATE accounts SET admin = 0, admin_since = NULL WHERE user_id = ?", "second").await;
    s.open_claim("second", &good).await.unwrap();
    s.sql("UPDATE accounts SET admin = 1 WHERE user_id = ?", "second").await;
    assert_eq!(s.admin_op("revoke", "second").await.0, 200);
    assert_eq!(s.run_claims().await, 0, "a stale claim reinstated a revoked admin");
    assert!(!s.is_admin("second").await);
}

#[tokio::test]
async fn a_claim_on_an_ownerless_server_lands_at_once_and_touches_no_credentials() {
    let s = start().await;
    s.register("rescuer").await;
    let credentials = || async {
        let row: (String, Option<String>) =
            sqlx::query_as("SELECT password_hash, opaque_record FROM accounts WHERE user_id = ?")
                .bind(id("founder"))
                .fetch_one(&s.state.pool)
                .await
                .unwrap();
        let recovery: Option<(Option<String>, Option<String>, Option<i64>)> =
            sqlx::query_as("SELECT verified_email, pending_email, bounced_at FROM recovery_addresses WHERE user_id = ?")
                .bind(id("founder"))
                .fetch_optional(&s.state.pool)
                .await
                .unwrap();
        let sessions: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM home_sessions").fetch_one(&s.state.pool).await.unwrap();
        (row, recovery, sessions)
    };
    let before = credentials().await;
    s.deactivate("founder").await;
    s.open_claim("rescuer", &evidence(Some(0o600), Some(0o700))).await.unwrap();
    assert_eq!(s.run_claims().await, 1, "an ownerless server made its rescuer wait");
    assert!(s.is_admin("rescuer").await);
    assert_eq!(credentials().await, before, "recovery altered credentials or sessions");
}

#[tokio::test]
async fn a_claim_is_refused_for_an_unusable_subject_or_a_loosely_held_host() {
    let s = start().await;
    for lp in ["ghost", "rescuer", "standin"] {
        s.register(lp).await;
    }
    s.strip_credential("ghost").await;
    let good = evidence(Some(0o600), Some(0o700));
    for (subject, needle) in [("ghost", "credential"), ("nobody", "does not exist"), ("founder", "already administers")] {
        let err = s.open_claim(subject, &good).await.unwrap_err();
        assert!(err.contains(needle), "{subject}: {err}");
    }
    for (db, dir) in [(0o666, 0o700), (0o660, 0o700), (0o600, 0o777)] {
        let err = s.open_claim("rescuer", &evidence(Some(db), Some(dir))).await.unwrap_err();
        assert!(err.contains("chmod") && err.contains("write"), "{db:o}/{dir:o}: {err}");
    }
    let claims: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM admin_recovery_claims").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(claims, 0);
    assert_eq!(s.count_audit("ownership.recovery.refused").await, 3);
    s.open_claim("rescuer", &good).await.expect("a locked-down host was refused");
    let unknown = HostEvidence { uid: None, hostname: None, ..evidence(None, None) };
    s.open_claim("standin", &unknown).await.expect("an unknowable host was treated as a bad one");
}

#[tokio::test]
async fn revoking_an_admin_device_ends_its_sessions_alerts_every_admin_and_keeps_the_authority() {
    let s = start().await;
    s.register("second").await;
    s.register("bystander").await;
    let (_, body) = s.call("GET", "/admin/ownership/sessions", &s.founder, Value::Null).await;
    let listed: Vec<&str> =
        body["administrators"].as_array().unwrap().iter().map(|a| a["user_id"].as_str().unwrap()).collect();
    assert_eq!(listed, vec![id("founder")], "the session list is not scoped to administrators");

    let bystander_device: String = sqlx::query_scalar("SELECT device_id FROM devices WHERE user_id = ?")
        .bind(id("bystander"))
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    let body = json!({ "user_id": id("founder"), "password": PASSWORD });
    let (status, _) = s.call("DELETE", &format!("/admin/ownership/sessions/{bystander_device}"), &s.founder, body).await;
    assert!(status == 409 || status == 403, "an ordinary device was revocable: {status}");

    assert_eq!(s.admin_op("grant", "second").await.0, 200);
    let mut inboxes = Vec::new();
    for (conn, who) in [(9001, "second"), (9002, "founder")] {
        let (tx, rx) = tokio::sync::mpsc::channel(gateway::hub::OUTBOX_DEPTH);
        let (out, _lagging) = gateway::hub::Outbox::new(tx);
        s.state.hub.subscribe_user(conn, &id(who), out).await;
        inboxes.push((who, rx));
    }
    let (_, body) = s.call("GET", "/admin/ownership/sessions", &s.founder, Value::Null).await;
    let entry = body["administrators"].as_array().unwrap().iter().find(|a| a["user_id"] == id("second")).unwrap();
    let device = entry["devices"][0]["device_id"].as_str().unwrap().to_string();
    let path = format!("/admin/ownership/sessions/{device}");
    let (status, answer) =
        s.call("DELETE", &path, &s.founder, json!({ "user_id": id("second"), "password": PASSWORD })).await;
    assert_eq!(status, 200, "{answer}");

    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM home_sessions WHERE device_id = ?")
        .bind(&device)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(live, 0, "the device kept its sessions");
    assert!(s.is_admin("second").await, "revoking a device removed the authority");
    for (who, rx) in inboxes.iter_mut() {
        let mut seen = None;
        while let Ok(event) = rx.try_recv() {
            if event.t == "OWNERSHIP_SESSION_REVOKED" {
                seen = Some(event);
                break;
            }
        }
        let event = seen.unwrap_or_else(|| panic!("{who} was not told"));
        assert_eq!(event.data["by"], json!(id("founder")));
        assert_eq!(event.data["user_id"], json!(id("second")));
        assert_eq!(event.data["device_id"], json!(device));
    }
    let (actor, target, data): (String, Option<String>, String) =
        sqlx::query_as("SELECT actor, target, data FROM server_audit_log WHERE action = 'ownership.session.revoke'")
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!((actor, target), (id("founder"), Some(id("second"))));
    assert!(data.contains(&device), "{data}");
}

#[tokio::test]
async fn key_rotation_publishes_the_new_key_and_a_compromise_cuts_the_old_one_off() {
    use telium_server::crypto;
    let s = start().await;
    let pool = &s.state.pool;
    let before = crypto::load_or_create_key(pool, 7776000).await.unwrap();
    let (new_id, retired) = crypto::rotate_key(pool, 60, false).await.unwrap();
    assert!(retired.is_none() && new_id != before.key_id);
    assert_eq!(crypto::load_or_create_key(pool, 7776000).await.unwrap().key_id, new_id);
    let published = crypto::historical_keys(pool).await.unwrap();
    assert!(published.iter().any(|(k, ..)| *k == before.key_id), "old key unpublished");

    let s = start().await;
    let pool = &s.state.pool;
    let before = crypto::load_or_create_key(pool, 7776000).await.unwrap();
    let (_, retired) = crypto::rotate_key(pool, 7776000, true).await.unwrap();
    assert_eq!(retired.as_deref(), Some(before.key_id.as_str()));
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_keys WHERE key_id = ? AND valid_until > ?")
        .bind(&before.key_id)
        .bind(telium_server::util::now_ms())
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(open, 0, "the compromised key still has an open window");

    assert_eq!(crypto::forget_expired_secrets(pool).await.unwrap(), 1);
    let halves = |key: String| async move {
        sqlx::query_as::<_, (String, String)>("SELECT secret_b64, public_b64 FROM server_keys WHERE key_id = ?")
            .bind(key)
            .fetch_one(pool)
            .await
            .unwrap()
    };
    let (secret, public) = halves(before.key_id).await;
    assert!(secret.is_empty() && !public.is_empty(), "forgetting must drop the secret and keep the public half");
    let current = crypto::load_or_create_key(pool, 7776000).await.unwrap();
    assert!(!halves(current.key_id).await.0.is_empty(), "the live signing key was forgotten");
}
