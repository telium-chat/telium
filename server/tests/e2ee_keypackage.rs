
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-kp-{}-{n}", std::process::id()));
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
    cfg.rate_limit.auth_burst = 10_000;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state);
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir }
}

struct Device {
    user_id: String,
    device_id: String,
    token: String,
}

impl Server {
    async fn call(&self, method: reqwest::Method, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.request(method, format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if !body.is_null() {
            req = req.json(&body);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }
    async fn device(&self, localpart: &str, device_name: Option<&str>) -> Device {
        let (path, body) = match device_name {
            None => ("/_telium/v1/register", json!({ "localpart": localpart, "password": "correct horse battery" })),
            Some(name) => ("/_telium/v1/login", json!({ "user": localpart, "password": "correct horse battery", "device_name": name })),
        };
        let (status, body) = self.call(reqwest::Method::POST, path, None, body).await;
        assert_eq!(status, 200, "{path}: {body}");
        let field = |k: &str| body[k].as_str().unwrap().to_string();
        Device { user_id: field("user_id"), device_id: field("device_id"), token: field("access_token") }
    }
    async fn publish(&self, device: &Device, n: usize) {
        let packages: Vec<String> = (0..n).map(|i| format!("package-{}-{i}", device.device_id)).collect();
        let body = json!({ "packages": packages });
        let (status, body) = self.call(reqwest::Method::POST, "/_telium/v1/keypackages", Some(&device.token), body).await;
        assert_eq!(status, 200, "publish: {body}");
    }
    async fn claim(&self, claimer: &Device, target: &str) -> Vec<(String, Option<String>)> {
        let path = format!("/_telium/v1/users/{target}/keypackages/claim");
        let (status, body) = self.call(reqwest::Method::POST, &path, Some(&claimer.token), json!({})).await;
        assert_eq!(status, 200, "claim: {body}");
        let mut rows: Vec<_> = body["key_packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| (r["device_id"].as_str().unwrap().to_string(), r["package"].as_str().map(str::to_string)))
            .collect();
        rows.sort();
        rows
    }
}

#[tokio::test]
async fn a_package_is_served_once_and_an_exhausted_device_is_reported_not_substituted() {
    let s = start().await;
    let (bob, laptop) = (s.device("bob", None).await, s.device("bob", Some("laptop")).await);
    let (alice, carol) = (s.device("alice", None).await, s.device("carol", None).await);
    s.publish(&bob, 1).await;

    let (status, mine) = s.call(reqwest::Method::GET, "/_telium/v1/keypackages", Some(&bob.token), json!(null)).await;
    assert_eq!(status, 200, "{mine}");
    let devices = mine["devices"].as_array().unwrap();
    assert_eq!((devices.len(), &devices[0]["device_id"], &devices[0]["available"]), (1, &json!(bob.device_id), &json!(1)), "{mine}");

    let mut expected = vec![(bob.device_id.clone(), Some(format!("package-{}-0", bob.device_id))), (laptop.device_id.clone(), None)];
    expected.sort();
    assert_eq!(s.claim(&alice, &bob.user_id).await, expected, "both devices reported, only the stocked one served");
    let second = s.claim(&carol, &bob.user_id).await;
    assert!(second.len() == 2 && second.iter().all(|(_, p)| p.is_none()), "a package was served twice: {second:?}");
}

#[tokio::test]
async fn a_revoked_device_stops_being_offered_and_is_marked_inactive_to_everyone() {
    let s = start().await;
    let (bob, phone, alice) = (s.device("bob", None).await, s.device("bob", Some("phone")).await, s.device("alice", None).await);
    s.publish(&bob, 4).await;
    s.publish(&phone, 4).await;
    assert_eq!(s.claim(&alice, &bob.user_id).await.len(), 2);

    let (status, body) = s.call(reqwest::Method::DELETE, &format!("/_telium/v1/devices/{}", phone.device_id), Some(&bob.token), json!(null)).await;
    assert_eq!(status, 200, "revoke: {body}");
    let after = s.claim(&alice, &bob.user_id).await;
    assert!(after.len() == 1 && after[0].0 == bob.device_id && after[0].1.is_some(), "{after:?}");

    let (_, list) = s.call(reqwest::Method::GET, &format!("/_telium/v1/users/{}/devices", bob.user_id), None, json!(null)).await;
    let revoked = list["devices"].as_array().unwrap().iter().find(|d| d["device_id"] == json!(phone.device_id));
    assert_eq!(revoked.expect("a revoked device stays listed")["active"], json!(false), "{list}");
    let (_, cross) = s.call(reqwest::Method::GET, "/_telium/v1/crosssigning", Some(&bob.token), json!(null)).await;
    assert!(!cross["devices"].as_array().unwrap().iter().any(|d| d["device_id"] == json!(phone.device_id)), "{cross}");
}

#[tokio::test]
async fn a_signed_out_session_is_not_offered_again() {
    let s = start().await;
    let (bob, again, alice) = (s.device("bob", None).await, s.device("bob", Some("again")).await, s.device("alice", None).await);
    s.publish(&bob, 2).await;
    s.publish(&again, 2).await;
    assert_eq!(s.claim(&alice, &bob.user_id).await.len(), 2);

    let (status, body) = s.call(reqwest::Method::POST, "/_telium/v1/logout", Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "logout: {body}");
    let after = s.claim(&alice, &bob.user_id).await;
    assert!(after.len() == 1 && after[0].0 == again.device_id && after[0].1.is_some(), "{after:?}");
}

#[tokio::test]
async fn parallel_claims_never_hand_the_same_key_package_to_two_people() {
    let s = start().await;
    let bob = s.device("bob", None).await;
    s.publish(&bob, 10).await;
    let mut claimers = Vec::new();
    for i in 0..10 {
        claimers.push(s.device(&format!("claimer{i}"), None).await);
    }
    let answers = futures_util::future::join_all(claimers.iter().map(|c| s.claim(c, &bob.user_id))).await;
    let served: Vec<String> = answers.into_iter().flatten().filter_map(|(_, p)| p).collect();
    let distinct: std::collections::HashSet<&String> = served.iter().collect();
    assert_eq!(distinct.len(), served.len(), "a package went to more than one claimer: {served:?}");
}

impl Server {
    async fn db(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect(&format!("sqlite://{}/telium.db", self.dir.display())).await.unwrap()
    }
    async fn rows(&self, device: &Device) -> Vec<(String, i64)> {
        sqlx::query_as("SELECT package, last_resort FROM key_packages WHERE device_id = ? ORDER BY package")
            .bind(&device.device_id)
            .fetch_all(&self.db().await)
            .await
            .unwrap()
    }
    async fn publish_last_resort(&self, device: &Device, package: &str) {
        let body = json!({ "packages": [], "last_resort": package });
        let (status, body) = self.call(reqwest::Method::POST, "/_telium/v1/keypackages", Some(&device.token), body).await;
        assert_eq!(status, 200, "publish last resort: {body}");
    }
    async fn claim_full(&self, claimer: &Device, target: &str) -> (u16, Value) {
        let path = format!("/_telium/v1/users/{target}/keypackages/claim");
        self.call(reqwest::Method::POST, &path, Some(&claimer.token), json!({})).await
    }
}

#[tokio::test]
async fn a_claimed_package_is_deleted_from_the_server() {
    let s = start().await;
    let (bob, alice) = (s.device("bob", None).await, s.device("alice", None).await);
    s.publish(&bob, 2).await;
    assert_eq!(s.rows(&bob).await.len(), 2);
    let served = s.claim(&alice, &bob.user_id).await;
    let package = served[0].1.clone().expect("a package was served");
    let left = s.rows(&bob).await;
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left.iter().all(|(p, _)| *p != package), "the served package is still stored: {left:?}");
}

#[tokio::test]
async fn the_last_resort_package_is_served_only_when_the_pool_is_empty_and_it_still_exists() {
    let s = start().await;
    let (bob, alice) = (s.device("bob", None).await, s.device("alice", None).await);
    s.publish(&bob, 1).await;
    s.publish_last_resort(&bob, "last-resort-a").await;
    s.publish_last_resort(&bob, "last-resort-b").await;

    let (_, mine) = s.call(reqwest::Method::GET, "/_telium/v1/keypackages", Some(&bob.token), json!(null)).await;
    assert_eq!((&mine["devices"][0]["available"], &mine["devices"][0]["last_resort"]), (&json!(1), &json!(true)), "{mine}");

    let (_, first) = s.claim_full(&alice, &bob.user_id).await;
    assert_eq!(first["key_packages"][0]["package"], json!(format!("package-{}-0", bob.device_id)), "one-time first: {first}");
    assert_eq!(first["key_packages"][0]["last_resort"], json!(false));
    for _ in 0..2 {
        let (_, next) = s.claim_full(&alice, &bob.user_id).await;
        assert_eq!(next["key_packages"][0]["package"], json!("last-resort-b"), "{next}");
        assert_eq!(next["key_packages"][0]["last_resort"], json!(true));
    }
    assert_eq!(s.rows(&bob).await, vec![("last-resort-b".to_string(), 1)], "a last-resort package outlives its claims");

    let (status, _) = s.call(reqwest::Method::DELETE, "/_telium/v1/keypackages/last-resort", Some(&bob.token), json!(null)).await;
    assert_eq!(status, 200);
    let (_, gone) = s.claim_full(&alice, &bob.user_id).await;
    assert_eq!(gone["key_packages"][0]["package"], json!(null), "a withdrawn last-resort package was served: {gone}");

    let phone = s.device("bob", Some("phone")).await;
    s.publish_last_resort(&phone, "phone-last-resort").await;
    let (status, _) = s.call(reqwest::Method::DELETE, &format!("/_telium/v1/devices/{}", phone.device_id), Some(&bob.token), json!(null)).await;
    assert_eq!(status, 200);
    assert!(s.rows(&phone).await.is_empty(), "a revoked device's packages survived");
    let (_, after) = s.claim_full(&alice, &bob.user_id).await;
    assert!(after["key_packages"].as_array().unwrap().iter().all(|r| r["device_id"] != json!(phone.device_id)), "{after}");
}

#[tokio::test]
async fn claims_are_rate_limited_per_claimer_and_target_pair() {
    let s = start().await;
    let (bob, carol) = (s.device("bob", None).await, s.device("carol", None).await);
    let (alice, dave) = (s.device("alice", None).await, s.device("dave", None).await);
    s.publish(&bob, 30).await;
    s.publish(&carol, 5).await;
    for i in 0..10 {
        let (status, body) = s.claim_full(&alice, &bob.user_id).await;
        assert_eq!(status, 200, "claim {i}: {body}");
    }
    let (status, body) = s.claim_full(&alice, &bob.user_id).await;
    assert_eq!(status, 429, "the eleventh claim in a burst went through: {body}");
    assert_eq!(s.claim_full(&dave, &bob.user_id).await.0, 200, "another claimer is limited by alice's claims");
    assert_eq!(s.claim_full(&alice, &carol.user_id).await.0, 200, "alice is limited against a different target");
}
