
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::replicate::{self, Replica};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    name: String,
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct FullAccount {
    token: String,
    device_secret: String,
}

async fn register_full(server: &Server, localpart: &str) -> FullAccount {
    let (status, body) = server
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": localpart, "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "register: {body}");
    FullAccount {
        token: body["access_token"].as_str().unwrap().to_string(),
        device_secret: body["device_secret"]
            .as_str()
            .expect("registration returns the device secret in this test API")
            .to_string(),
    }
}

fn device_sign(secret_b64: &str, payload: &[u8]) -> String {
    let raw = telium_server::util::unb64(secret_b64).expect("device secret is base64");
    let bytes: [u8; 32] = raw.try_into().expect("ed25519 secret is 32 bytes");
    let key = ed25519_dalek::SigningKey::from_bytes(&bytes);
    let sig = ed25519_dalek::Signer::sign(&key, payload);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

async fn paired() -> (Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lb = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let aa = la.local_addr().unwrap();
    let ab = lb.local_addr().unwrap();

    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{aa}"));
    peers.insert("b.test".to_string(), format!("http://{ab}"));

    let a = boot(la, "a.test", n, 0, peers.clone(), |cfg| {
        cfg.failover.standbys = vec!["b.test".into()];
        cfg.federation.migration_delay_secs = 0;
    })
    .await;
    let b = boot(lb, "b.test", n, 1, peers, |cfg| {
        cfg.failover.replicate = vec!["a.test".into()];
    })
    .await;
    (a, b)
}

async fn trio() -> (Server, Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lb = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lc = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let aa = la.local_addr().unwrap();
    let ab = lb.local_addr().unwrap();
    let ac = lc.local_addr().unwrap();

    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{aa}"));
    peers.insert("b.test".to_string(), format!("http://{ab}"));
    peers.insert("c.test".to_string(), format!("http://{ac}"));

    let a = boot(la, "a.test", n, 0, peers.clone(), |cfg| {
        cfg.failover.standbys = vec!["b.test".into()];
    })
    .await;
    let b = boot(lb, "b.test", n, 1, peers.clone(), |cfg| {
        cfg.failover.replicate = vec!["a.test".into()];
        cfg.federation.migration_delay_secs = 0;
    })
    .await;
    let c = boot(lc, "c.test", n, 2, peers, |cfg| {
        cfg.federation.migration_delay_secs = 0;
    }).await;
    (a, b, c)
}

async fn boot(
    listener: tokio::net::TcpListener,
    name: &str,
    n: u32,
    idx: u32,
    peers: BTreeMap<String, String>,
    tune: impl FnOnce(&mut Config),
) -> Server {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    let addr = listener.local_addr().unwrap();
    let dir = std::env::temp_dir().join(format!("telium-fo-{}-{n}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut cfg = Config {
        server_name: name.into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.backup.dir = dir.join("backups");
    cfg.federation.allow_http = true;
    cfg.federation.peers = peers;
    cfg.failover.dir = dir.join("replicas");
    tune(&mut cfg);

    let state = telium_server::build_state(cfg).await.unwrap();
    let replicas = replicate::open_replicas(&state).await.unwrap();
    let app = telium_server::routes::router_with_standbys(state.clone(), &replicas);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    Server { name: name.into(), base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state }
}

impl Server {
    async fn replica(&self, origin: &str) -> Replica {
        replicate::open_replicas(&self.state)
            .await
            .unwrap()
            .into_iter()
            .find(|r| r.origin == origin)
            .unwrap_or_else(|| panic!("{} holds no copy of {origin}", self.name))
    }

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

    async fn put(&self, path: &str, token: &str) -> (u16, Value) {
        let resp = self
            .client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn delete(&self, path: &str, token: &str) -> (u16, Value) {
        let resp = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
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

    async fn guild_session(&self, home_token: &str) -> String {
        let (status, body) = self.post("/_telium/v1/sessions/local", Some(home_token), json!({})).await;
        assert_eq!(status, 200, "local session: {body}");
        body["session_token"].as_str().unwrap().to_string()
    }

    async fn guild_with_channel(&self, token: &str, name: &str) -> (String, String) {
        let (status, guild) = self.post("/_telium/v1/guilds", Some(token), json!({ "name": name })).await;
        assert_eq!(status, 200, "{guild}");
        let guild_id = guild["id"].as_str().unwrap().to_string();
        let (status, channels) =
            self.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(token)).await;
        assert_eq!(status, 200, "{channels}");
        let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
        (guild_id, channel_id)
    }

    async fn authorise(&self, admin: &str, standby: &str) -> Value {
        self.elevate(admin).await;
        let (status, body) = self
            .post(
                "/_telium/v1/admin/failover",
                Some(admin),
                json!({ "subject_type": "server", "subject_id": self.name, "standby": standby }),
            )
            .await;
        assert_eq!(status, 200, "authorise: {body}");
        body
    }

    async fn say(&self, token: &str, channel_id: &str, content: &str) -> String {
        let (status, msg) = self
            .post(
                &format!("/_telium/v1/channels/{channel_id}/messages"),
                Some(token),
                json!({ "content": content }),
            )
            .await;
        assert_eq!(status, 200, "{msg}");
        msg["id"].as_str().unwrap().to_string()
    }
}

#[tokio::test]
async fn a_standby_serves_a_read_only_copy_of_its_primary() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let session = a.guild_session(&alice).await;
    let (_guild, channel) = a.guild_with_channel(&session, "Continuity").await;
    a.say(&session, &channel, "before the outage").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let mirror = format!("{}/_telium/standby/a.test", b.base);
    let resp = b
        .client
        .get(format!("{mirror}/_telium/v1/whoami"))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "the copy holds alice's session");
    let who: Value = resp.json().await.unwrap();
    assert_eq!(who["user_id"], "@alice:a.test", "and answers as a.test, not as b.test");

    let resp = b
        .client
        .get(format!("{mirror}/_telium/v1/channels/{channel}/messages"))
        .bearer_auth(&session)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let history: Value = resp.json().await.unwrap();
    let texts: Vec<&str> =
        history["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
    assert!(texts.contains(&"before the outage"), "replicated history: {history}");

    let resp = b
        .client
        .post(format!("{mirror}/_telium/v1/channels/{channel}/messages"))
        .bearer_auth(&session)
        .json(&json!({ "content": "this must not land" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 503, "a standby is not a second authority");
    let refusal: Value = resp.json().await.unwrap();
    assert_eq!(refusal["error"], "standby_read_only");
}

#[tokio::test]
async fn later_writes_and_removals_both_replicate() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let session = a.guild_session(&alice).await;
    let (_guild, channel) = a.guild_with_channel(&session, "Continuity").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let kept = a.say(&session, &channel, "this one stays").await;
    let removed = a.say(&session, &channel, "this one goes").await;
    let (status, body) = a
        .put(&format!("/_telium/v1/messages/{kept}/reactions/%F0%9F%91%8D/@me"), &session)
        .await;
    assert!(status == 200 || status == 204, "react: {status} {body}");
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let present: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id IN (?, ?)")
        .bind(&kept)
        .bind(&removed)
        .fetch_one(&replica.state.pool)
        .await
        .unwrap();
    assert_eq!(present, 2, "both messages reached the copy through the log");
    let reactions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE message_id = ?")
        .bind(&kept)
        .fetch_one(&replica.state.pool)
        .await
        .unwrap();
    assert_eq!(reactions, 1, "and so did the reaction");

    let (status, body) =
        a.delete(&format!("/_telium/v1/channels/{channel}/messages/{removed}"), &session).await;
    assert!(status == 200 || status == 204, "delete: {status} {body}");
    let (status, body) = a
        .delete(&format!("/_telium/v1/messages/{kept}/reactions/%F0%9F%91%8D/@me"), &session)
        .await;
    assert!(status == 200 || status == 204, "unreact: {status} {body}");
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let (deleted, content): (i64, String) =
        sqlx::query_as("SELECT deleted, content FROM messages WHERE id = ?")
            .bind(&removed)
            .fetch_one(&replica.state.pool)
            .await
            .unwrap();
    assert_eq!(deleted, 1, "the copy knows the message was deleted");
    assert_eq!(content, "", "and does not still hold what it said");

    let reactions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM reactions WHERE message_id = ?")
        .bind(&kept)
        .fetch_one(&replica.state.pool)
        .await
        .unwrap();
    assert_eq!(reactions, 0, "a row deleted on the primary is deleted on the copy");

    let kept_there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id = ?")
        .bind(&kept)
        .fetch_one(&replica.state.pool)
        .await
        .unwrap();
    assert_eq!(kept_there, 1, "and nothing else went with it");

    let indexed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?")
            .bind("\"stays\"")
            .fetch_one(&replica.state.pool)
            .await
            .unwrap();
    assert_eq!(indexed, 1, "the copy can be searched");
    let gone: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH ?")
            .bind("\"goes\"")
            .fetch_one(&replica.state.pool)
            .await
            .unwrap();
    assert_eq!(gone, 0, "and a deleted message is not still findable in it");
}

#[tokio::test]
async fn stored_objects_follow_the_rows_that_reference_them() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let bytes = b"\x89PNG\r\n\x1a\n and then some bytes that are not really a png";
    let resp = a
        .client
        .post(format!("{}/_telium/v1/media", a.base))
        .bearer_auth(&alice)
        .header("content-type", "image/png")
        .header("x-telium-filename", "pic.png")
        .body(bytes.to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let uploaded: Value = resp.json().await.unwrap();

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let hash: String = sqlx::query_scalar("SELECT hash FROM media LIMIT 1")
        .fetch_one(&replica.state.pool)
        .await
        .unwrap_or_else(|e| panic!("no media row on the copy ({e}): {uploaded}"));
    let path = replica.state.cfg.media_dir.join(&hash[0..2]).join(&hash);
    assert!(path.exists(), "the object itself should be on the standby's disk at {path:?}");
    assert_eq!(std::fs::read(&path).unwrap(), bytes, "and be the same bytes");
}

#[tokio::test]
async fn a_client_can_ask_how_far_behind_the_copy_is_without_a_session() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let session = a.guild_session(&alice).await;
    let (_guild, channel) = a.guild_with_channel(&session, "Continuity").await;
    a.say(&session, &channel, "hello").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let (status, body) = b.get("/_telium/v1/failover/status/a.test", None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["authority"], "a.test", "the primary is still the one who speaks for it");
    assert_eq!(body["promoted"], false);
    assert_eq!(body["record"], Value::Null, "and there is no promotion to show");
    assert_eq!(body["read_only"], true);
    assert_eq!(body["standby"], "b.test");
    assert_eq!(body["stale"], false, "a copy that was just updated is not stale");
    assert!(body["behind_ms"].as_i64().is_some(), "and it says how old it is: {body}");

    let (status, doc) = a.get("/.well-known/telium/server", None).await;
    assert_eq!(status, 200);
    assert_eq!(doc["fallback"]["standby"], "b.test");
    assert_eq!(doc["fallback"]["path"], "/_telium/standby/a.test");
    assert_eq!(doc["keys"]["server_name"], "a.test");
    assert_eq!(doc["keys"]["signer"], "a.test");
    let key_id = doc["keys"]["key_id"].as_str().expect("embedded key document is signed");
    let key = doc["keys"]["verify_keys"][key_id]["key"]
        .as_str()
        .expect("the signing key is embedded too");
    assert!(
        telium_server::crypto::verify_json(key, &doc["keys"]),
        "a first-contact peer can verify the static discovery key document"
    );
}

#[tokio::test]
async fn streaming_the_database_needs_a_signature_and_an_invitation() {
    let (a, b) = paired().await;

    let (status, _) = a.get("/_telium/v1/failover/head", None).await;
    assert!(status == 401 || status == 403, "an unsigned request cannot stream a database");

    telium_server::federation::get_signed(&b.state, "a.test", "/_telium/v1/failover/head")
        .await
        .expect("b.test is a.test's configured standby");

    let err = telium_server::federation::get_signed(&a.state, "b.test", "/_telium/v1/failover/head")
        .await
        .expect_err("b.test never named a.test as a standby");
    assert!(
        format!("{err:?}").contains("not a configured standby"),
        "refused for the right reason: {err:?}"
    );
}

#[tokio::test]
async fn a_snapshot_does_not_carry_the_primarys_private_key() {
    let (a, b) = paired().await;
    a.register("alice").await;

    let secret: String = sqlx::query_scalar("SELECT secret_b64 FROM server_keys LIMIT 1")
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert!(!secret.is_empty(), "the primary does have a private key to leak");

    let (bytes, _mime, status) = telium_server::federation::get_signed_bytes(
        &b.state,
        "a.test",
        "/_telium/v1/failover/snapshot",
        None,
    )
    .await
    .unwrap();
    assert_eq!(status, 200);
    let needle = secret.as_bytes();
    assert!(
        !bytes.windows(needle.len()).any(|w| w == needle),
        "the primary's signing key is in the snapshot it sent its standby",
    );

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    let copied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM server_keys")
        .fetch_one(&replica.state.pool)
        .await
        .unwrap();
    assert_eq!(copied, 0, "and it is not in the copy afterwards either");
}

#[tokio::test]
async fn the_copy_becomes_the_original_when_an_operator_says_so() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let session = a.guild_session(&alice).await;
    let (_guild, channel) = a.guild_with_channel(&session, "Continuity").await;
    a.say(&session, &channel, "before the outage").await;
    a.authorise(&alice, "b.test").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let mirror = format!("{}/_telium/standby/a.test", b.base);
    assert_eq!(
        write_to(&b, &mirror, &channel, &session).await,
        503,
        "still only a copy",
    );

    let root = b.register("root").await;
    b.elevate(&root).await;
    let (status, record) =
        b.post("/_telium/v1/admin/standby/a.test/promote", Some(&root), json!({})).await;
    assert_eq!(status, 200, "promote: {record}");
    assert_eq!(record["authority"], "b.test");
    assert_eq!(record["subject_id"], "a.test");
    assert_eq!(record["sequence"], 1, "the chain starts somewhere");
    assert_eq!(
        record["authorization"]["primary"], "a.test",
        "and carries a.test's own consent inside it: {record}",
    );

    assert_eq!(
        write_to(&b, &mirror, &channel, &session).await,
        200,
        "the copy is the original now",
    );

    let (status, body) = b.get("/_telium/v1/failover/status/a.test", None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["authority"], "b.test", "and says so to anyone who asks");
    assert_eq!(body["read_only"], false);
    assert_eq!(body["record"]["sequence"], 1, "with the proof attached: {body}");
}

async fn write_to(b: &Server, mirror: &str, channel: &str, session: &str) -> u16 {
    b.client
        .post(format!("{mirror}/_telium/v1/channels/{channel}/messages"))
        .bearer_auth(session)
        .json(&json!({ "content": "after the outage" }))
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn promoting_twice_does_not_move_the_chain_twice() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    a.authorise(&alice, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let first = telium_server::promotion::promote(&b.state, &replica).await.unwrap();
    let second = telium_server::promotion::promote(&b.state, &replica).await.unwrap();
    assert_eq!(first, second, "the same event, the same record");
}

#[tokio::test]
async fn a_standby_cannot_take_over_for_a_server_that_never_agreed() {
    let (a, b) = paired().await;
    a.register("alice").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();

    let err = telium_server::promotion::promote(&b.state, &replica)
        .await
        .expect_err("nobody ever ran the pairing");
    assert!(
        format!("{err:?}").contains("never authorised"),
        "refused for the right reason: {err:?}",
    );

    let root = b.register("root").await;
    b.elevate(&root).await;
    let (status, body) =
        b.post("/_telium/v1/admin/standby/a.test/promote", Some(&root), json!({})).await;
    assert_eq!(status, 409, "and over HTTP too: {body}");
}

#[tokio::test]
async fn a_primary_that_comes_back_finds_out_it_was_replaced() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    let session = a.guild_session(&alice).await;
    let (_guild, channel) = a.guild_with_channel(&session, "Continuity").await;
    a.authorise(&alice, "b.test").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    telium_server::promotion::promote(&b.state, &replica).await.unwrap();

    let found = telium_server::promotion::check(&a.state)
        .await
        .unwrap()
        .expect("a.test should discover that b.test took over");
    assert_eq!(found.domain, "b.test");
    assert_eq!(found.sequence, 1);

    let (status, history) =
        a.get(&format!("/_telium/v1/channels/{channel}/messages"), Some(&session)).await;
    assert_eq!(status, 200, "a demoted server is still readable: {history}");

    let (status, refusal) = a
        .post(
            &format!("/_telium/v1/channels/{channel}/messages"),
            Some(&session),
            json!({ "content": "this must not land" }),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");
    assert_eq!(refusal["error"], "demoted");
    assert_eq!(refusal["authority"], "b.test", "and says where to go instead");

    let (status, refusal) = a
        .post(
            "/_telium/v1/login",
            None,
            json!({ "localpart": "alice", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 409, "{refusal}");

    let (status, doc) = a.get("/.well-known/telium/server", None).await;
    assert_eq!(status, 200);
    assert_eq!(doc["authority"]["domain"], "b.test", "{doc}");
    assert_eq!(doc["authority"]["path"], "/_telium/standby/a.test");
    let (status, health) = a.get("/_telium/v1/health", None).await;
    assert_eq!(status, 200);
    assert_eq!(health["ok"], true, "alive, which is exactly the problem");
    assert_eq!(health["authority"], "b.test", "so liveness is not the question: {health}");
}

#[tokio::test]
async fn a_promotion_nobody_authorised_moves_nothing() {
    let (a, b) = paired().await;
    let alice = a.register("alice").await;
    a.authorise(&alice, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    let real = telium_server::promotion::promote(&b.state, &replica).await.unwrap();

    telium_server::promotion::verify(&a.state, &real, "a.test")
        .await
        .expect("a.test signed the authorisation this chains onto");

    let mut bare = strip_signature(real.clone());
    bare.as_object_mut().unwrap().remove("authorization");
    let bare = telium_server::crypto::sign_json(&b.state.key, bare);
    let err = telium_server::promotion::verify(&a.state, &bare, "a.test")
        .await
        .expect_err("a promotion with no consent in it proves nothing");
    assert!(format!("{err:?}").contains("without"), "{err:?}");

    let mut ambitious = strip_signature(bare.clone());
    ambitious["sequence"] = json!(99);
    let ambitious = telium_server::crypto::sign_json(&b.state.key, ambitious);
    telium_server::promotion::verify(&a.state, &ambitious, "a.test")
        .await
        .expect_err("nor does asking for more");

    let mut tampered = real.clone();
    tampered["sequence"] = json!(99);
    telium_server::promotion::verify(&a.state, &tampered, "a.test")
        .await
        .expect_err("an edited record is not a record");

    assert!(telium_server::promotion::check(&a.state).await.unwrap().is_some());
}

#[tokio::test]
async fn a_promoted_replica_can_federate_as_the_dead_logical_origin() {
    let (a, b, c) = trio().await;
    let alice = a.register("alice").await;
    let charlie = c.register("charlie").await;

    telium_server::federation::discover(&c.state, "a.test")
        .await
        .expect("c can discover a while it is alive");

    a.authorise(&alice, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    let record = telium_server::promotion::promote(&b.state, &replica).await.unwrap();
    assert_eq!(record["authority"], "b.test");

    let body = json!({
        "action": "request",
        "from": "@alice:a.test",
        "to": "@charlie:c.test",
    });
    telium_server::federation::post_signed(
        &replica.state,
        "c.test",
        "/_telium/v1/friends/relay",
        &body,
    )
    .await
    .expect("the promoted authority can speak for a.test");

    let (status, friends) = c.get("/_telium/v1/friends", Some(&charlie)).await;
    assert_eq!(status, 200, "{friends}");
    let incoming = friends["friends"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["user_id"] == "@alice:a.test")
        .expect("charlie should receive alice's request");
    assert_eq!(incoming["state"], "pending_in");
}

#[tokio::test]
async fn a_new_friend_request_reaches_a_promoted_fallback_when_the_primary_is_dead() {
    let (a, b, c) = trio().await;
    let alice = a.register("alice").await;
    let charlie = c.register("charlie").await;

    telium_server::federation::discover(&c.state, "a.test")
        .await
        .expect("c can learn a's fallback before the outage");

    a.authorise(&alice, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    telium_server::promotion::promote(&b.state, &replica).await.unwrap();

    sqlx::query(
        "UPDATE remote_servers SET api_base = ?, fetched_at = ? WHERE origin = 'a.test'",
    )
    .bind("http://127.0.0.1:1")
    .bind(telium_server::util::now_ms())
    .execute(&c.state.pool)
    .await
    .unwrap();

    let (status, row) = c
        .post(
            "/_telium/v1/friends",
            Some(&charlie),
            json!({ "user_id": "@alice:a.test" }),
        )
        .await;
    assert_eq!(status, 200, "friend request should follow the fallback: {row}");
    assert_eq!(row["state"], "pending_out");

    let mirror = format!("{}/_telium/standby/a.test", b.base);
    let mut friends = json!({ "friends": [] });
    for _ in 0..50 {
        let resp = b
            .client
            .get(format!("{mirror}/_telium/v1/friends"))
            .bearer_auth(&alice)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        friends = resp.json().await.unwrap();
        if friends["friends"].as_array().is_some_and(|rows| !rows.is_empty()) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let incoming = friends["friends"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["user_id"] == "@charlie:c.test")
        .expect("the request must land on the promoted authority");
    assert_eq!(incoming["state"], "pending_in");
}

#[tokio::test]
async fn an_account_can_migrate_away_from_a_promoted_fallback() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    register_full(&a, "spare").await;
    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = '@spare:a.test'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    let landing = register_full(&c, "alice2").await;

    a.authorise(&alice.token, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    telium_server::promotion::promote(&b.state, &replica).await.unwrap();

    let (status, claim) = c
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({
                "subject_type": "user",
                "source": "a.test",
                "source_id": "@alice:a.test"
            }),
        )
        .await;
    assert_eq!(status, 200, "destination claim: {claim}");
    let import_token = claim["import_token"].as_str().unwrap();

    let created_at = telium_server::util::now_ms();
    let payload = telium_server::migration::grant_payload(
        "@alice:a.test",
        "c.test",
        import_token,
        created_at,
    );
    let signature = device_sign(&alice.device_secret, &payload);
    let mirror = format!("{}/_telium/standby/a.test", b.base);

    let resp = b
        .client
        .post(format!("{mirror}/_telium/v1/migrate"))
        .bearer_auth(&alice.token)
        .json(&json!({
            "subject_type": "user",
            "destination": "c.test",
            "import_token": import_token,
            "password": "correct horse battery",
            "device_signature": signature,
            "created_at": created_at,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let started: Value = resp.json().await.unwrap();
    let id = started["id"].as_str().unwrap();

    let resp = b
        .client
        .post(format!("{mirror}/_telium/v1/migrate/{id}/execute"))
        .bearer_auth(&alice.token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let done: Value = resp.json().await.unwrap();
    assert_eq!(done["new_id"], "@alice2:c.test", "{done}");

    let (status, who) = c.get("/_telium/v1/whoami", Some(&landing.token)).await;
    assert_eq!(status, 200, "destination account remains usable: {who}");
    let resp = b
        .client
        .get(format!("{mirror}/_telium/v1/whoami"))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        401,
        "the old home session is revoked after the acknowledged migration"
    );
}

#[tokio::test]
async fn a_guild_owner_can_migrate_their_guild_away_from_a_promoted_fallback() {
    let (a, b, c) = trio().await;
    let owner = register_full(&a, "owner").await;
    let source_session = a.guild_session(&owner.token).await;
    let (guild_id, channel_id) = a.guild_with_channel(&source_session, "Escapable").await;
    a.say(&source_session, &channel_id, "history survives the outage").await;

    let landing = register_full(&c, "owner2").await;
    a.authorise(&owner.token, "b.test").await;
    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    telium_server::promotion::promote(&b.state, &replica).await.unwrap();

    let (status, claim) = c
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({
                "subject_type": "guild",
                "source": "a.test",
                "source_id": guild_id
            }),
        )
        .await;
    assert_eq!(status, 200, "guild destination claim: {claim}");
    let import_token = claim["import_token"].as_str().unwrap();

    let created_at = telium_server::util::now_ms();
    let payload = telium_server::migration::grant_payload(
        &guild_id,
        "c.test",
        import_token,
        created_at,
    );
    let signature = device_sign(&owner.device_secret, &payload);
    let mirror = format!("{}/_telium/standby/a.test", b.base);

    let resp = b
        .client
        .post(format!("{mirror}/_telium/v1/migrate"))
        .bearer_auth(&owner.token)
        .json(&json!({
            "subject_type": "guild",
            "subject_id": guild_id,
            "destination": "c.test",
            "import_token": import_token,
            "password": "correct horse battery",
            "device_signature": signature,
            "created_at": created_at,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let started: Value = resp.json().await.unwrap();
    let id = started["id"].as_str().unwrap();

    let resp = b
        .client
        .post(format!("{mirror}/_telium/v1/migrate/{id}/execute"))
        .bearer_auth(&owner.token)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let done: Value = resp.json().await.unwrap();
    let new_guild = done["new_id"].as_str().expect("destination guild id").to_string();

    let destination_session = c.guild_session(&landing.token).await;
    let (status, channels) = c
        .get(
            &format!("/_telium/v1/guilds/{new_guild}/channels"),
            Some(&destination_session),
        )
        .await;
    assert_eq!(status, 200, "migrated guild is usable at c.test: {channels}");
    let destination_channel = channels["channels"][0]["id"].as_str().unwrap();
    let (status, history) = c
        .get(
            &format!("/_telium/v1/channels/{destination_channel}/messages"),
            Some(&destination_session),
        )
        .await;
    assert_eq!(status, 200, "{history}");
    assert!(
        history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["content"] == "history survives the outage"),
        "guild history did not survive migration: {history}"
    );
}

#[tokio::test]
async fn authority_can_chain_from_a_to_b_to_c_without_a_private_key_leaving_a() {
    let (a, b, c) = trio().await;
    let alice = a.register("alice").await;
    a.authorise(&alice, "b.test").await;

    let replica = b.replica("a.test").await;
    replicate::sync_once(&b.state, &replica).await.unwrap();
    let first = telium_server::promotion::promote(&b.state, &replica).await.unwrap();
    assert_eq!(first["sequence"], 1);

    let second_authorization = telium_server::crypto::sign_json(
        &b.state.key,
        json!({
            "kind": "failover_authorization",
            "subject_type": "server",
            "subject_id": "a.test",
            "primary": "a.test",
            "standby": "c.test",
            "signer": "b.test",
            "previous_authority": first,
            "created_at": telium_server::util::now_ms(),
        }),
    );
    let previous = telium_server::promotion::verify_authorization(
        &a.state,
        &second_authorization,
        "a.test",
        "c.test",
    )
    .await
    .expect("b's successor authorization chains to a's original consent");
    assert_eq!(previous, 1);

    let second = telium_server::crypto::sign_json(
        &c.state.key,
        json!({
            "kind": "failover_promotion",
            "subject_type": "server",
            "subject_id": "a.test",
            "authority": "c.test",
            "signer": "c.test",
            "primary": "a.test",
            "sequence": 2,
            "authorization": second_authorization,
            "promoted_at": telium_server::util::now_ms(),
        }),
    );
    let authority = telium_server::promotion::verify(&a.state, &second, "a.test")
        .await
        .expect("the entire a -> b -> c chain verifies from a's original key");
    assert_eq!(authority.domain, "c.test");
    assert_eq!(authority.sequence, 2);
}

fn strip_signature(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.remove("signature");
        map.remove("key_id");
    }
    value
}

#[tokio::test]
async fn a_primary_with_a_standby_can_be_restarted() {
    let dir = std::env::temp_dir().join(format!("telium-fo-restart-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = || {
        let mut cfg = Config {
            server_name: "a.test".into(),
            database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
            media_dir: dir.join("media"),
            ..Config::default()
        };
        cfg.backup.enabled = false;
        cfg.backup.dir = dir.join("backups");
        cfg.failover.standbys = vec!["b.test".into()];
        cfg
    };

    let first = telium_server::build_state(cfg()).await.unwrap();
    drop(first);
    let state = telium_server::build_state(cfg())
        .await
        .expect("a server that has been started once must start again");

    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM repl_log")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO server_meta (key, value) VALUES ('restart_probe', '1')")
        .execute(&state.pool)
        .await
        .unwrap();
    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM repl_log")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(after - before, 1, "one write, one log entry");

    drop(state);
    let _ = std::fs::remove_dir_all(&dir);
}
