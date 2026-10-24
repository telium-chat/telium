
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);
const PASSWORD: &str = "correct horse battery";
const CONFIRM: &str = "/_telium/v1/account/recovery-email/confirm";
const DISOWN: &str = "/_telium/v1/account/recovery-email/disown";

#[derive(Clone)]
struct Mailbox {
    url: String,
    sent: Arc<Mutex<Vec<Value>>>,
    status: Arc<Mutex<u16>>,
}

impl Mailbox {
    async fn start() -> Mailbox {
        let (sent, status) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(200u16)));
        let (kept, answer) = (sent.clone(), status.clone());
        let app = axum::Router::new().route(
            "/mail",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let (kept, answer) = (kept.clone(), answer.clone());
                async move {
                    kept.lock().unwrap().push(body);
                    axum::http::StatusCode::from_u16(*answer.lock().unwrap()).unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Mailbox { url: format!("http://{addr}/mail"), sent, status }
    }
    fn to(&self, address: &str) -> Vec<Value> {
        self.sent.lock().unwrap().iter().filter(|m| m["to"].as_str() == Some(address)).cloned().collect()
    }
    fn last_text(&self, address: &str) -> String {
        let last = self.to(address).pop().unwrap_or_else(|| panic!("nothing delivered to {address}"));
        last["text"].as_str().unwrap().to_string()
    }
    fn token(&self, address: &str, path: &str) -> String {
        let text = self.last_text(address);
        let needle = format!("{path}?t=");
        let start = text.find(&needle).unwrap_or_else(|| panic!("no {path} link in:\n{text}")) + needle.len();
        text[start..].split(char::is_whitespace).next().unwrap().to_string()
    }
    fn clear(&self) {
        self.sent.lock().unwrap().clear();
    }
}

struct Server {
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

async fn boot(mailer: Option<&Mailbox>) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-recovery-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: "a.test".into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.rate_limit.enabled = false;
    if let Some(mailbox) = mailer {
        cfg.mail.mode = "webhook".into();
        cfg.mail.webhook_url = mailbox.url.clone();
    }
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state, serve }
}

struct Account {
    id: String,
    token: String,
}

impl Server {
    async fn call(&self, method: reqwest::Method, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.request(method, format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }
    async fn register(&self, localpart: &str) -> Account {
        let body = json!({ "localpart": localpart, "password": PASSWORD });
        let (status, body) = self.call(reqwest::Method::POST, "/_telium/v1/register", None, body).await;
        assert_eq!(status, 200, "register: {body}");
        Account { id: body["user_id"].as_str().unwrap().into(), token: body["access_token"].as_str().unwrap().into() }
    }
    async fn set(&self, who: &Account, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::PUT, "/_telium/v1/account/recovery-email", Some(&who.token), body).await
    }
    async fn claim(&self, who: &Account, email: &str) -> Value {
        let (status, body) = self.set(who, json!({ "email": email, "password": PASSWORD })).await;
        assert_eq!(status, 200, "{body}");
        body
    }
    async fn recovery(&self, who: &Account) -> Value {
        let (status, body) = self.call(reqwest::Method::GET, "/_telium/v1/account/recovery-email", Some(&who.token), json!(null)).await;
        assert_eq!(status, 200, "{body}");
        body
    }
    async fn follow(&self, path: &str, token: &str, press: bool) -> u16 {
        let req = if press {
            self.client.post(format!("{}{path}", self.base)).form(&[("t", token)])
        } else {
            self.client.get(format!("{}{path}?t={token}", self.base))
        };
        req.send().await.unwrap().status().as_u16()
    }
    async fn confirm(&self, mailbox: &Mailbox, who: &Account, email: &str) {
        self.claim(who, email).await;
        assert_eq!(self.follow(CONFIRM, &mailbox.token(email, CONFIRM), true).await, 200);
        assert_eq!(self.verified(&who.id).await.as_deref(), Some(email));
    }
    async fn verified(&self, user_id: &str) -> Option<String> {
        sqlx::query_scalar::<_, Option<String>>("SELECT verified_email FROM recovery_addresses WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&self.state.pool)
            .await
            .unwrap()
            .flatten()
    }
    async fn destination(&self, user_id: &str) -> Option<String> {
        telium_server::mail::verified_recovery_address(&self.state, user_id).await.unwrap().map(|a| a.as_str().to_string())
    }
}

#[tokio::test]
async fn a_claim_becomes_a_destination_only_once_proved_and_only_by_a_live_link() {
    let mailbox = Mailbox::start().await;
    let s = boot(Some(&mailbox)).await;
    let alice = s.register("alice").await;

    let (status, body) = s.set(&alice, json!({ "email": "alice@mail.test" })).await;
    assert_eq!(status, 400, "a bare session set an address: {body}");
    let (status, body) = s.set(&alice, json!({ "email": "alice@mail.test", "password": "not the password" })).await;
    assert!(status == 401 || status == 403, "{status} {body}");
    assert!(mailbox.sent.lock().unwrap().is_empty(), "mail went out for a failed reauthentication");

    let body = s.claim(&alice, "first@mail.test").await;
    assert_eq!((&body["state"], &body["pending_email"], &body["challenge_sent"]), (&json!("pending"), &json!("first@mail.test"), &json!(true)));
    assert_eq!(s.destination(&alice.id).await, None, "an unproved claim was handed out as a destination");
    assert!(mailbox.last_text("first@mail.test").contains(&alice.id), "the message does not say which account asked");
    let stale = mailbox.token("first@mail.test", CONFIRM);

    s.claim(&alice, "alice@mail.test").await;
    assert_eq!(s.follow(CONFIRM, &stale, true).await, 404, "a superseded link still worked");
    let token = mailbox.token("alice@mail.test", CONFIRM);
    assert_eq!(s.follow(CONFIRM, &token, false).await, 200);
    assert_eq!(s.recovery(&alice).await["state"], "pending", "GET confirmed the address");
    assert_eq!(s.follow(CONFIRM, &token, true).await, 200);
    assert_eq!(s.follow(CONFIRM, &token, true).await, 410, "a spent link was honoured twice");
    let after = s.recovery(&alice).await;
    assert_eq!((&after["state"], &after["verified_email"], &after["pending_email"]), (&json!("verified"), &json!("alice@mail.test"), &Value::Null));

    mailbox.clear();
    let body = s.claim(&alice, "attacker@elsewhere.test").await;
    assert_eq!((&body["state"], &body["verified_email"]), (&json!("verified"), &json!("alice@mail.test")));
    assert_eq!(s.destination(&alice.id).await.as_deref(), Some("alice@mail.test"));
    assert!(mailbox.last_text("alice@mail.test").contains("attacker@elsewhere.test"));

    let (status, body) = s.set(&alice, json!({ "email": null, "password": PASSWORD })).await;
    assert_eq!((status, &body["state"]), (200, &json!("none")), "{body}");
    assert_eq!(s.verified(&alice.id).await, None);
    assert!(mailbox.last_text("alice@mail.test").contains("removed"));
}

#[tokio::test]
async fn a_stranger_can_stop_the_mail_and_one_mailbox_has_one_budget() {
    let mailbox = Mailbox::start().await;
    let s = boot(Some(&mailbox)).await;
    let (alice, mallory) = (s.register("alice").await, s.register("mallory").await);

    s.claim(&alice, "victim@elsewhere.test").await;
    assert_eq!(s.follow(DISOWN, &mailbox.token("victim@elsewhere.test", DISOWN), true).await, 200);
    assert_eq!(s.recovery(&alice).await["state"], "none");
    mailbox.clear();
    assert_eq!(s.claim(&mallory, "victim@elsewhere.test").await["challenge_sent"], false, "suppression is per mailbox");
    assert!(mailbox.to("victim@elsewhere.test").is_empty());

    for i in 0..5 {
        s.claim(&alice, &format!("other{i}@mail.test")).await;
        assert_eq!(s.claim(&alice, "target@elsewhere.test").await["challenge_sent"], true, "refused at message {i}");
    }
    s.claim(&alice, "other9@mail.test").await;
    for (who, email) in [(&alice, "target@elsewhere.test"), (&mallory, "target@elsewhere.test"), (&alice, "TARGET@Elsewhere.TEST")] {
        assert_eq!(s.claim(who, email).await["challenge_sent"], false, "{email} got past the budget");
    }
    assert_eq!(mailbox.to("target@elsewhere.test").len(), 5);
}

#[tokio::test]
async fn a_hard_bounce_or_leaving_retires_the_address() {
    let mailbox = Mailbox::start().await;
    let s = boot(Some(&mailbox)).await;
    let (root, alice, bo) = (s.register("root").await, s.register("alice").await, s.register("bo").await);
    s.confirm(&mailbox, &alice, "alice@mail.test").await;
    mailbox.clear();

    let bounce = |token: String, kind: &str, reason: &str| {
        let body = json!({ "email": "alice@mail.test", "kind": kind, "reason": reason });
        let s = &s;
        async move { s.call(reqwest::Method::POST, "/_telium/v1/admin/mail/bounce", Some(&token), body).await }
    };
    let (status, body) = bounce(root.token.clone(), "soft", "mailbox full").await;
    assert_eq!((status, &body["retired"]), (200, &json!(false)), "{body}");
    assert_eq!(bounce(alice.token.clone(), "hard", "x").await.0, 403, "a non-admin retired an address");
    let (status, body) = bounce(root.token.clone(), "hard", "no such mailbox").await;
    assert_eq!((status, &body["retired"], &body["accounts_affected"]), (200, &json!(true), &json!(1)), "{body}");
    let after = s.recovery(&alice).await;
    assert_eq!((&after["state"], &after["bounce_reason"]), (&json!("bounced"), &json!("no such mailbox")));
    assert!(after["bounced_at"].is_i64());
    assert_eq!(s.verified(&alice.id).await, None);
    assert_eq!(s.claim(&alice, "alice@mail.test").await["challenge_sent"], false);
    assert!(mailbox.to("alice@mail.test").is_empty(), "we wrote to a bouncing mailbox");

    s.confirm(&mailbox, &bo, "bo@mail.test").await;
    s.claim(&bo, "bo2@mail.test").await;
    telium_server::routes::recovery::forget(&s.state, &bo.id).await.unwrap();
    assert_eq!(s.verified(&bo.id).await, None);
    let outstanding: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_email_challenges WHERE user_id = ?")
        .bind(&bo.id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(outstanding, 0, "a link that installs an address outlived the account");
    assert!(mailbox.last_text("bo@mail.test").contains("left"));
}

#[tokio::test]
async fn the_capability_follows_the_mailer_and_a_permanent_refusal_is_not_retried() {
    let s = boot(None).await;
    let alice = s.register("alice").await;
    let caps = s.call(reqwest::Method::GET, "/_telium/v1/capabilities", None, json!(null)).await.1;
    assert_eq!(caps["features"]["recovery_email"], false);
    assert!(caps["unimplemented"].as_array().unwrap().iter().any(|f| f == "recovery_email"), "{caps}");
    let (status, body) = s.set(&alice, json!({ "email": "alice@mail.test", "password": PASSWORD })).await;
    assert_eq!(status, 400, "an address was stored that can never be verified: {body}");
    assert!(body["message"].as_str().unwrap().contains("not set up to send email"));
    let state = s.recovery(&alice).await;
    assert_eq!((&state["state"], &state["mailer"]), (&json!("none"), &json!(false)));

    let mailbox = Mailbox::start().await;
    let s = boot(Some(&mailbox)).await;
    let caps = s.call(reqwest::Method::GET, "/_telium/v1/capabilities", None, json!(null)).await.1;
    assert_eq!(caps["features"]["recovery_email"], true);
    assert!(!caps["unimplemented"].as_array().unwrap().iter().any(|f| f == "recovery_email"), "{caps}");

    *mailbox.status.lock().unwrap() = 400;
    let alice = s.register("alice").await;
    let body = s.claim(&alice, "alice@mail.test").await;
    assert_eq!((&body["state"], &body["challenge_sent"]), (&json!("pending"), &json!(false)));
    assert_eq!(mailbox.to("alice@mail.test").len(), 1, "a 4xx was retried");
    let recorded: (String, i64) = sqlx::query_as("SELECT state, attempts FROM mail_sends WHERE user_id = ? ORDER BY id DESC LIMIT 1")
        .bind(&alice.id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(recorded, ("refused".to_string(), 1));
}
