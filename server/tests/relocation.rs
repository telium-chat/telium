
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::crypto::ServerKey;
use telium_server::{federation, relocation};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    name: String,
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    serve: tokio::task::JoinHandle<()>,
    owns_dir: bool,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.serve.abort();
        if self.owns_dir {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

fn fresh_dir(n: u32, idx: u32) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("telium-reloc-{}-{n}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn listener() -> tokio::net::TcpListener {
    tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap()
}

async fn rebind(addr: std::net::SocketAddr) -> tokio::net::TcpListener {
    for _ in 0..50 {
        if let Ok(l) = tokio::net::TcpListener::bind(addr).await {
            return l;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    panic!("{addr} never came free");
}

async fn boot_on(
    listener: tokio::net::TcpListener,
    name: &str,
    dir: std::path::PathBuf,
    peers: BTreeMap<String, String>,
) -> Server {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
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
    cfg.federation.migration_delay_secs = 0;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server {
        name: name.into(),
        base: format!("http://{addr}"),
        client: reqwest::Client::new(),
        dir,
        state,
        serve,
        owns_dir: true,
    }
}

fn placeholder(listener: tokio::net::TcpListener) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        axum::serve(listener, axum::Router::new().into_make_service()).await.unwrap();
    })
}

fn static_discovery(listener: tokio::net::TcpListener, doc: Value) -> tokio::task::JoinHandle<()> {
    let app = axum::Router::new().route(
        "/.well-known/telium/server",
        axum::routing::get(move || {
            let doc = doc.clone();
            async move { axum::Json(doc) }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service()).await.unwrap();
    })
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

    async fn register(&self, localpart: &str) -> String {
        let (status, body) = self
            .post(
                "/_telium/v1/register",
                None,
                json!({ "localpart": localpart, "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(status, 200, "register: {body}");
        body["access_token"].as_str().unwrap().to_string()
    }

    async fn elevate(&self, token: &str) {
        let (status, body) =
            self.post("/_telium/v1/admin/step-up", Some(token), json!({ "password": "correct horse battery" })).await;
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

    async fn upload(&self, token: &str, bytes: &[u8]) -> Value {
        let resp = self
            .client
            .post(format!("{}/_telium/v1/media", self.base))
            .bearer_auth(token)
            .header("content-type", "image/png")
            .header("x-telium-filename", "pic.png")
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        resp.json().await.unwrap()
    }

    async fn relocation_state(&self, old: &str) -> Option<String> {
        sqlx::query_scalar("SELECT state FROM domain_relocations WHERE old_domain = ?")
            .bind(old)
            .fetch_optional(&self.state.pool)
            .await
            .unwrap()
    }

    async fn scalar(&self, sql: &str, bind: &str) -> Option<String> {
        sqlx::query_scalar(sql).bind(bind).fetch_optional(&self.state.pool).await.unwrap()
    }

    async fn flush_relocation(&self) {
        sqlx::query("UPDATE relocation_deliveries SET next_at = 0 WHERE delivered_at IS NULL")
            .execute(&self.state.pool)
            .await
            .unwrap();
        relocation::flush(&self.state).await.unwrap();
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn random_key(key_id: &str) -> ServerKey {
    ServerKey {
        key_id: key_id.into(),
        signing: SigningKey::from_bytes(&rand::random()),
        valid_from: 0,
        valid_until: i64::MAX,
    }
}

async fn wait_for_state(server: &Server, old: &str, want: &str) {
    for _ in 0..100 {
        if server.relocation_state(old).await.as_deref() == Some(want) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!(
        "{} never reached {want} for {old}: {:?}",
        server.name,
        server.relocation_state(old).await
    );
}

#[tokio::test]
async fn a_relocated_domain_is_followed_by_the_servers_that_knew_it() {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let (la, lb, lc, ld) = (listener().await, listener().await, listener().await, listener().await);
    let a_addr = la.local_addr().unwrap();
    let d_addr = ld.local_addr().unwrap();
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{a_addr}"));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    peers.insert("c.test".to_string(), format!("http://{}", lc.local_addr().unwrap()));
    peers.insert("d.test".to_string(), format!("http://{d_addr}"));

    let d_placeholder = placeholder(ld);
    let mut a = boot_on(la, "a.test", fresh_dir(n, 0), peers.clone()).await;
    let b = boot_on(lb, "b.test", fresh_dir(n, 1), peers.clone()).await;
    let c = boot_on(lc, "c.test", fresh_dir(n, 2), peers.clone()).await;

    let root = a.register("root").await;
    let alice = a.register("alice").await;
    a.elevate(&root).await;

    let session = a.session_on(&alice, &b).await;
    let (status, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Moving day" })).await;
    assert_eq!(status, 200, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = b.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let reference = a.upload(&alice, b"a picture that moves with its server").await;
    let attachment = json!({
        "origin": reference["origin"], "hash": reference["hash"],
        "filename": reference["filename"], "mime": reference["mime"],
        "size": reference["size"], "capability": reference["capability"],
    });
    let (status, msg) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "before the move", "attachments": [attachment] }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    assert_eq!(msg["author"], "@alice:a.test");
    federation::discover(&a.state, "b.test").await.unwrap();

    for server in [&a, &b] {
        sqlx::query(
            "INSERT INTO voice_states (guild_id, user_id, channel_id, device_id, session_id, region, \
             joined_at, updated_at, wants_sfu, home_sfu) VALUES ('', '@alice:a.test', 'conv-1', 'dev', 's1', 'a.test', 1, 1, 1, 1)",
        )
        .execute(&server.state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO conversation_calls (conversation_id, mode, host, generation, started_at, updated_at) \
             VALUES ('conv-1', 'sfu', 'a.test', 1, 1, 1)",
        )
        .execute(&server.state.pool)
        .await
        .unwrap();
    }

    let (status, _) = a
        .post("/_telium/v1/admin/sunset", Some(&alice), json!({ "mode": "relocate", "new_domain": "d.test" }))
        .await;
    assert_eq!(status, 403);

    let (status, sunset) = a
        .post(
            "/_telium/v1/admin/sunset",
            Some(&root),
            json!({ "mode": "relocate", "new_domain": "d.test", "message": "we are moving" }),
        )
        .await;
    assert_eq!(status, 200, "{sunset}");
    let record = sunset["relocation"].clone();
    assert_eq!(record["kind"], "domain_relocation");
    assert_eq!(record["old_domain"], "a.test");
    assert_eq!(record["new_domain"], "d.test");

    let (_, doc) = a.get("/.well-known/telium/server", None).await;
    assert_eq!(doc["relocation"], record);
    assert!(doc["moved_to"].is_null(), "moved_to before the cutover strands whoever follows it");
    assert_eq!(
        a.scalar("SELECT new_id FROM tombstones WHERE subject_type = 'domain' AND subject_id = ?", "a.test")
            .await,
        None,
        "announcing is not moving"
    );

    a.flush_relocation().await;
    wait_for_state(&b, "a.test", "announced").await;
    assert_eq!(
        b.scalar("SELECT user_id FROM members WHERE user_id = ?", "@alice:a.test").await.as_deref(),
        Some("@alice:a.test"),
        "nothing is rewritten on the old name's word alone"
    );

    let refused = federation::post_signed(&c.state, "b.test", "/_telium/v1/relocation", &json!({ "record": record }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("may not announce"), "{refused}");

    let forger = random_key(record["old_key_id"].as_str().unwrap());
    let successor = random_key("ed25519:forged");
    let forged = relocation::sign_record(
        &forger,
        &successor,
        json!({
            "kind": "domain_relocation",
            "old_domain": "a.test",
            "new_domain": "c.test",
            "old_key_id": record["old_key_id"],
            "new_key_id": successor.key_id,
            "new_key": successor.public_b64(),
            "effective_at": now_ms(),
            "announced_at": now_ms(),
        }),
    );
    let refused = federation::post_signed(&c.state, "b.test", "/_telium/v1/relocation", &json!({ "record": forged }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("not signed by a.test"), "{refused}");

    let mut tampered = record.clone();
    tampered["new_domain"] = json!("c.test");
    let refused = federation::post_signed(&a.state, "b.test", "/_telium/v1/relocation", &json!({ "record": tampered }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("not signed"), "{refused}");
    assert_eq!(b.relocation_state("a.test").await.as_deref(), Some("announced"));

    a.owns_dir = false;
    let a_dir = a.dir.clone();
    drop(a);
    d_placeholder.abort();
    let d = boot_on(rebind(d_addr).await, "d.test", a_dir, peers.clone()).await;

    let (status, me) = d.get("/_telium/v1/whoami", Some(&alice)).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["user_id"], "@alice:d.test");
    let (status, login) = d
        .post("/_telium/v1/login", None, json!({ "user": "@alice:a.test", "password": "correct horse battery" }))
        .await;
    assert_eq!(status, 200, "the old id still logs in: {login}");
    assert_eq!(login["user_id"], "@alice:d.test");
    assert_eq!(
        d.scalar("SELECT user_id FROM accounts WHERE user_id LIKE ?", "%:a.test").await,
        None,
        "no account is left under the old name"
    );
    let stale: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_states WHERE user_id LIKE '%:a.test'")
        .fetch_one(&d.state.pool)
        .await
        .unwrap();
    assert_eq!(stale, 0);
    assert_eq!(
        d.scalar("SELECT host FROM conversation_calls WHERE conversation_id = ?", "conv-1").await.as_deref(),
        Some("d.test"),
        "the call's SFU host is the same server under its new name"
    );
    let (_, doc) = d.get("/.well-known/telium/server", None).await;
    assert_eq!(doc["server_name"], "d.test");
    assert!(doc["relocation"].is_null());

    let old_doc: Value = d
        .client
        .get(format!("{}/.well-known/telium/server", d.base))
        .header("host", "a.test")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(old_doc["server_name"], "a.test");
    assert_eq!(old_doc["moved_to"], "d.test");
    assert_eq!(old_doc["relocation"], record);

    for _ in 0..50 {
        d.flush_relocation().await;
        if b.relocation_state("a.test").await.as_deref() == Some("applied") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(b.relocation_state("a.test").await.as_deref(), Some("applied"));
    assert_eq!(
        b.scalar("SELECT user_id FROM members WHERE guild_id = ? AND user_id LIKE '@alice:%'", &guild_id)
            .await
            .as_deref(),
        Some("@alice:d.test")
    );
    assert_eq!(
        b.scalar("SELECT owner_user_id FROM guilds WHERE id = ?", &guild_id).await.as_deref(),
        Some("@alice:d.test")
    );
    assert_eq!(
        b.scalar("SELECT user_id FROM voice_states WHERE channel_id = ?", "conv-1").await.as_deref(),
        Some("@alice:d.test")
    );
    assert_eq!(
        b.scalar("SELECT host FROM conversation_calls WHERE conversation_id = ?", "conv-1").await.as_deref(),
        Some("d.test")
    );
    let attachments = b
        .scalar("SELECT attachments FROM messages WHERE channel_id = ?", &channel_id)
        .await
        .unwrap();
    let attachments: Value = serde_json::from_str(&attachments).unwrap();
    assert_eq!(attachments[0]["origin"], "d.test");
    assert_eq!(
        federation::resolve_id(&b.state, "user", "@alice:a.test").await,
        "@alice:d.test"
    );

    let (status, msg) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "after the move" }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    assert_eq!(msg["author"], "@alice:d.test");
    d.session_on(&alice, &b).await;

    let (status, exported) = d.get("/_telium/v1/relocation/a.test/discovery", None).await;
    assert_eq!(status, 200, "{exported}");
    let _old_site = static_discovery(rebind(a_addr).await, exported);
    federation::discover(&c.state, "a.test").await.unwrap();
    assert_eq!(c.relocation_state("a.test").await.as_deref(), Some("applied"));
    assert_eq!(relocation::current_domain(&c.state, "a.test").await, "d.test");
    assert_eq!(federation::resolve_id(&c.state, "user", "@alice:a.test").await, "@alice:d.test");
    let status = federation::get_signed(&c.state, "a.test", "/_telium/v1/relocation").await.unwrap();
    assert_eq!(status["server_name"], "d.test");

    let refused = relocation::learn(&b.state, &forged, None).await.unwrap_err();
    assert!(refused.to_string().contains("already relocated"), "{refused}");
}

#[tokio::test]
async fn a_domain_cannot_relocate_into_a_name_it_does_not_own() {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let (la, lb, lc) = (listener().await, listener().await, listener().await);
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    peers.insert("c.test".to_string(), format!("http://{}", lc.local_addr().unwrap()));
    let a = boot_on(la, "a.test", fresh_dir(n, 0), peers.clone()).await;
    let b = boot_on(lb, "b.test", fresh_dir(n, 1), peers.clone()).await;
    let _c = boot_on(lc, "c.test", fresh_dir(n, 2), peers).await;

    let root = a.register("root").await;
    let alice = a.register("alice").await;
    a.elevate(&root).await;
    let session = a.session_on(&alice, &b).await;
    let (status, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "G" })).await;
    assert_eq!(status, 200, "{guild}");
    federation::discover(&a.state, "b.test").await.unwrap();

    let (status, sunset) = a
        .post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "relocate", "new_domain": "c.test" }))
        .await;
    assert_eq!(status, 200, "{sunset}");
    let record = sunset["relocation"].clone();
    a.flush_relocation().await;
    wait_for_state(&b, "a.test", "announced").await;

    for _ in 0..3 {
        let outcome = relocation::learn(&b.state, &record, Some("a.test")).await.unwrap();
        assert_eq!(outcome, "announced");
    }
    assert_eq!(b.relocation_state("a.test").await.as_deref(), Some("announced"));
    assert_eq!(relocation::current_domain(&b.state, "a.test").await, "a.test");
    assert_eq!(
        b.scalar("SELECT user_id FROM members WHERE user_id = ?", "@alice:a.test").await.as_deref(),
        Some("@alice:a.test")
    );
    assert_eq!(federation::resolve_id(&b.state, "user", "@alice:a.test").await, "@alice:a.test");
}

#[tokio::test]
async fn withdrawing_a_relocation_destroys_its_successor_key() {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = listener().await;
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    let a = boot_on(la, "a.test", fresh_dir(n, 0), peers).await;
    let root = a.register("root").await;
    a.elevate(&root).await;

    let (status, first) = a
        .post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "relocate", "new_domain": "d.test" }))
        .await;
    assert_eq!(status, 200, "{first}");
    let (_, again) = a
        .post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "relocate", "new_domain": "d.test" }))
        .await;
    assert_eq!(again["relocation"]["new_key"], first["relocation"]["new_key"]);
    let (_, elsewhere) = a
        .post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "relocate", "new_domain": "e.test" }))
        .await;
    assert_ne!(elsewhere["relocation"]["new_key"], first["relocation"]["new_key"]);
    assert_eq!(a.scalar("SELECT key_id FROM server_keys WHERE domain = ?", "d.test").await, None);

    let (status, _) = a.post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "none" })).await;
    assert_eq!(status, 200);
    assert_eq!(a.scalar("SELECT key_id FROM server_keys WHERE domain = ?", "e.test").await, None);
    assert_eq!(a.relocation_state("a.test").await, None);
    let (_, doc) = a.get("/.well-known/telium/server", None).await;
    assert!(doc["relocation"].is_null());
    let (_, keys) = a.get("/_telium/v1/keys", None).await;
    assert_eq!(keys["verify_keys"].as_object().unwrap().len(), 1);
}

async fn three_with_a_member() -> (Server, Server, Server, String) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let (la, lb, lc) = (listener().await, listener().await, listener().await);
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    peers.insert("c.test".to_string(), format!("http://{}", lc.local_addr().unwrap()));
    let a = boot_on(la, "a.test", fresh_dir(n, 0), peers.clone()).await;
    let b = boot_on(lb, "b.test", fresh_dir(n, 1), peers.clone()).await;
    let c = boot_on(lc, "c.test", fresh_dir(n, 2), peers).await;
    let root = a.register("root").await;
    let alice = a.register("alice").await;
    a.elevate(&root).await;
    let session = a.session_on(&alice, &b).await;
    let (status, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "G" })).await;
    assert_eq!(status, 200, "{guild}");
    (a, b, c, root)
}

async fn nothing_was_remapped(b: &Server) {
    assert_eq!(b.relocation_state("a.test").await, None, "the record must not even be held");
    assert_eq!(relocation::current_domain(&b.state, "a.test").await, "a.test");
    assert_eq!(
        b.scalar("SELECT user_id FROM members WHERE user_id = ?", "@alice:a.test").await.as_deref(),
        Some("@alice:a.test")
    );
    assert_eq!(b.scalar("SELECT user_id FROM members WHERE user_id LIKE ?", "%:c.test").await, None);
    assert_eq!(federation::resolve_id(&b.state, "user", "@alice:a.test").await, "@alice:a.test");
}

fn into_c(old_key_id: &str, c: &Server, announced_at: i64) -> Value {
    json!({
        "kind": "domain_relocation",
        "old_domain": "a.test",
        "new_domain": "c.test",
        "old_key_id": old_key_id,
        "new_key_id": c.state.key.key_id,
        "new_key": c.state.key.public_b64(),
        "effective_at": announced_at,
        "announced_at": announced_at,
    })
}

#[tokio::test]
async fn a_retired_key_cannot_relocate_a_domain_that_does_not_vouch_for_it() {
    let (a, b, c, root) = three_with_a_member().await;
    let day = 24 * 60 * 60 * 1000;

    let retired = ServerKey {
        key_id: "ed25519:retired".into(),
        signing: SigningKey::from_bytes(&rand::random()),
        valid_from: now_ms() - 60 * day,
        valid_until: now_ms() - 30 * day,
    };
    sqlx::query(
        "INSERT INTO server_keys (key_id, secret_b64, public_b64, valid_from, valid_until) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&retired.key_id)
    .bind(telium_server::util::b64(&retired.signing.to_bytes()))
    .bind(retired.public_b64())
    .bind(retired.valid_from)
    .bind(retired.valid_until)
    .execute(&a.state.pool)
    .await
    .unwrap();
    federation::refresh_keys(&b.state, "a.test").await.unwrap();
    let backdated = now_ms() - 45 * day;
    assert_eq!(
        federation::verify_key_at(&b.state, "a.test", &retired.key_id, backdated).await,
        Some(retired.public_b64()),
        "b.test holds the retired key for its old window"
    );
    assert_eq!(federation::verify_key(&b.state, "a.test", &retired.key_id).await, None);

    let forged = relocation::sign_record(&retired, &c.state.key, into_c(&retired.key_id, &c, backdated));
    let parsed = relocation::parse(&forged).unwrap();
    assert!(relocation::new_domain_confirms(&b.state, &parsed).await, "c.test confirms its own key");
    let (_, doc) = a.get("/.well-known/telium/server", None).await;
    assert!(doc["relocation"].is_null());

    let refused = federation::post_signed(&c.state, "b.test", "/_telium/v1/relocation", &json!({ "record": forged }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("does not publish this relocation"), "{refused}");
    let refused = relocation::learn(&b.state, &forged, None).await.unwrap_err();
    assert!(refused.to_string().contains("does not publish this relocation"), "{refused}");
    nothing_was_remapped(&b).await;

    let (status, sunset) = a
        .post("/_telium/v1/admin/sunset", Some(&root), json!({ "mode": "relocate", "new_domain": "d.test" }))
        .await;
    assert_eq!(status, 200, "{sunset}");
    let (_, doc) = a.get("/.well-known/telium/server", None).await;
    assert_eq!(doc["relocation"]["new_domain"], "d.test");
    let refused = relocation::learn(&b.state, &forged, None).await.unwrap_err();
    assert!(refused.to_string().contains("does not publish this relocation"), "{refused}");
    assert_ne!(
        b.scalar("SELECT new_domain FROM domain_relocations WHERE old_domain = ?", "a.test").await.as_deref(),
        Some("c.test")
    );
    assert_eq!(relocation::current_domain(&b.state, "a.test").await, "a.test");
    assert_eq!(
        b.scalar("SELECT user_id FROM members WHERE user_id = ?", "@alice:a.test").await.as_deref(),
        Some("@alice:a.test")
    );
    assert_eq!(b.scalar("SELECT user_id FROM members WHERE user_id LIKE ?", "%:c.test").await, None);
}

#[tokio::test]
async fn a_relocation_dated_in_the_future_is_refused() {
    let (a, b, c, _) = three_with_a_member().await;

    let later = now_ms() + 60 * 60 * 1000;
    let record = relocation::sign_record(&a.state.key, &c.state.key, into_c(&a.state.key.key_id, &c, later));
    let refused = federation::post_signed(&a.state, "b.test", "/_telium/v1/relocation", &json!({ "record": record }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("dated in the future"), "{refused}");
    let refused = relocation::learn(&b.state, &record, None).await.unwrap_err();
    assert!(refused.to_string().contains("dated in the future"), "{refused}");
    nothing_was_remapped(&b).await;

    let skewed = relocation::sign_record(
        &a.state.key,
        &c.state.key,
        into_c(&a.state.key.key_id, &c, now_ms() + 60 * 1000),
    );
    relocation::verify(&b.state, &skewed).await.unwrap();
}

async fn block(server: &Server, domain: &str, scope: &str) {
    sqlx::query("INSERT INTO defederation (domain, scope, reason, source, created_at) VALUES (?, ?, 'abuse', 'local', ?)")
        .bind(domain)
        .bind(scope)
        .bind(now_ms())
        .execute(&server.state.pool)
        .await
        .unwrap();
}

async fn blocked(server: &Server, domain: &str, scope: &str) -> bool {
    federation::ensure_reachable(&server.state, domain, scope).await.is_err()
}

async fn relocate_a_into_c(a: &Server, b: &Server, c: &Server) {
    let record = relocation::sign_record(&a.state.key, &c.state.key, into_c(&a.state.key.key_id, c, now_ms()));
    assert_eq!(relocation::learn(&b.state, &record, None).await.unwrap(), "applied");
    assert_eq!(relocation::current_domain(&b.state, "a.test").await, "c.test");
}

#[tokio::test]
async fn a_defederated_domain_cannot_shed_the_block_by_relocating() {
    let (a, b, c, _) = three_with_a_member().await;
    block(&b, "a.test", "all").await;
    assert!(!blocked(&b, "c.test", "identity").await);
    relocate_a_into_c(&a, &b, &c).await;
    assert!(blocked(&b, "c.test", "identity").await, "the block did not follow the move");
    assert!(blocked(&b, "c.test", "media").await);
    assert!(blocked(&b, "a.test", "identity").await);
    let q = |col: &str| format!("SELECT {col} FROM defederation WHERE domain = ?");
    assert_eq!(b.scalar(&q("source"), "c.test").await.as_deref(), Some("relocation"));
    assert!(b.scalar(&q("reason"), "c.test").await.is_some_and(|r| r.contains("a.test")));
}

#[tokio::test]
async fn blocking_one_end_of_a_relocation_blocks_the_other() {
    let (a, b, c, _) = three_with_a_member().await;
    relocate_a_into_c(&a, &b, &c).await;
    assert!(!blocked(&b, "c.test", "identity").await);
    let root = b.register("root").await;
    b.elevate(&root).await;
    let (status, body) = b
        .post("/_telium/v1/admin/defederation", Some(&root), json!({ "domain": "a.test", "scope": "all", "reason": "abuse" }))
        .await;
    assert_eq!(status, 200, "{body}");
    assert!(blocked(&b, "a.test", "identity").await);
    assert!(blocked(&b, "c.test", "identity").await, "the successor name was left reachable");
    let (status, list) = b.get("/_telium/v1/admin/defederation", Some(&root)).await;
    assert_eq!(status, 200, "{list}");
    let domains: Vec<&str> =
        list["defederation"].as_array().unwrap().iter().filter_map(|b| b["domain"].as_str()).collect();
    assert!(domains.contains(&"a.test") && domains.contains(&"c.test"), "{list}");
}

#[tokio::test]
async fn inheriting_a_block_widens_a_narrower_one_rather_than_replacing_it() {
    let (a, b, c, _) = three_with_a_member().await;
    block(&b, "a.test", "all").await;
    block(&b, "c.test", "media").await;
    relocate_a_into_c(&a, &b, &c).await;
    assert!(blocked(&b, "c.test", "identity").await);
    assert_eq!(b.scalar("SELECT scope FROM defederation WHERE domain = ?", "c.test").await.as_deref(), Some("all"));
}
