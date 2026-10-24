
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use p256::{PublicKey, SecretKey};
use rand::rngs::OsRng;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};
use telium_server::config::Config;
use telium_server::notifications::{self, NotificationEnvelope, ALGORITHM_V1};
use telium_server::util::{b64, unb64};

static COUNTER: AtomicU32 = AtomicU32::new(0);
const PATIENCE: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(20);

struct Server {
    name: String,
    base: String,
    addr: std::net::SocketAddr,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    serve: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(serve) = &self.serve {
            serve.abort();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn pair() -> (Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let lg = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lh = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peers = BTreeMap::new();
    peers.insert("guild.example".to_string(), format!("http://{}", lg.local_addr().unwrap()));
    peers.insert("home.example".to_string(), format!("http://{}", lh.local_addr().unwrap()));
    (boot(lg, "guild.example", n, 0, peers.clone()).await, boot(lh, "home.example", n, 1, peers).await)
}

async fn boot(
    listener: tokio::net::TcpListener,
    name: &str,
    n: u32,
    idx: u32,
    peers: BTreeMap<String, String>,
) -> Server {
    let dir = std::env::temp_dir().join(format!("telium-notiffed-{}-{n}-{idx}", std::process::id()));
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
    cfg.archive.dir = dir.join("cold");
    cfg.federation.allow_http = true;
    cfg.federation.peers = peers;
    cfg.federation.dm_retry_secs = 1;
    let state = telium_server::build_state(cfg).await.unwrap();
    let serve = serve_on(listener, &state);
    Server {
        name: name.into(),
        base: format!("http://{addr}"),
        addr,
        client: reqwest::Client::new(),
        dir,
        state,
        serve: Some(serve),
    }
}

fn serve_on(listener: tokio::net::TcpListener, state: &telium_server::AppState) -> tokio::task::JoinHandle<()> {
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    })
}

struct Account {
    token: String,
    user_id: String,
    device_id: String,
}

impl Server {
    async fn send(&self, req: reqwest::RequestBuilder) -> (u16, Value) {
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn get(&self, path: &str, token: &str) -> (u16, Value) {
        self.send(self.client.get(format!("{}{path}", self.base)).bearer_auth(token)).await
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> Value {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let (status, body) = self.send(req).await;
        assert_eq!(status, 200, "POST {path} on {}: {body}", self.name);
        body
    }

    async fn register(&self, localpart: &str) -> Account {
        let body = self
            .post("/_telium/v1/register", None, json!({ "localpart": localpart, "password": "correct horse battery" }))
            .await;
        let field = |k: &str| body[k].as_str().unwrap().to_string();
        Account { token: field("access_token"), user_id: field("user_id"), device_id: field("device_id") }
    }

    async fn session_on(&self, home_token: &str, other: &Server) -> String {
        let assertion =
            self.post("/_telium/v1/assertions", Some(home_token), json!({ "audience": other.name })).await;
        let session = other.post("/_telium/v1/sessions", None, json!({ "assertion": assertion["assertion"] })).await;
        session["session_token"].as_str().unwrap().to_string()
    }

    async fn go_offline(&mut self) {
        let Some(serve) = self.serve.take() else { return };
        serve.abort();
        let _ = serve.await;
    }

    async fn come_back(&mut self) {
        let deadline = Instant::now() + PATIENCE;
        let listener = loop {
            match tokio::net::TcpListener::bind(self.addr).await {
                Ok(listener) => break listener,
                Err(e) => assert!(Instant::now() < deadline, "could not rebind {}: {e}", self.addr),
            }
            tokio::time::sleep(POLL).await;
        };
        self.serve = Some(serve_on(listener, &self.state));
    }
}

fn open_envelope(private: &SecretKey, envelope: &Value, aad: &[u8]) -> Result<Vec<u8>, String> {
    let envelope: NotificationEnvelope = serde_json::from_value(envelope.clone()).map_err(|e| e.to_string())?;
    if envelope.v != 1 || envelope.alg != ALGORITHM_V1 {
        return Err(format!("unexpected envelope version {}/{}", envelope.v, envelope.alg));
    }
    let ephemeral = PublicKey::from_sec1_bytes(&unb64(&envelope.ephemeral).ok_or("ephemeral")?)
        .map_err(|e| e.to_string())?;
    let shared = p256::ecdh::diffie_hellman(private.to_nonzero_scalar(), ephemeral.as_affine());
    let salt = unb64(&envelope.salt).ok_or("salt")?;
    let mut key = [0u8; 32];
    let mut info = b"Telium notification v1\0".to_vec();
    info.extend_from_slice(aad);
    Hkdf::<Sha256>::new(Some(&salt), shared.raw_secret_bytes())
        .expand(&info, &mut key)
        .map_err(|e| e.to_string())?;
    let nonce = unb64(&envelope.nonce).ok_or("nonce")?;
    let ciphertext = unb64(&envelope.ciphertext).ok_or("ciphertext")?;
    Aes256Gcm::new_from_slice(&key)
        .unwrap()
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ciphertext, aad })
        .map_err(|_| "did not authenticate".to_string())
}

struct Scene {
    guild_id: String,
    channel_id: String,
    author_session: String,
    member: Account,
    private: SecretKey,
    background_token: String,
}

impl Scene {
    fn aad(&self, origin: &str, message_id: &str, device: &str, kind: &str) -> Vec<u8> {
        notifications::aad(&self.member.user_id, device, origin, message_id, Some(&self.guild_id), kind)
    }

    fn open(&self, guild: &Server, row: &Value) -> Value {
        let aad = self.aad(&guild.name, row["source_id"].as_str().unwrap(), &self.member.device_id, "mention");
        serde_json::from_slice(&open_envelope(&self.private, &row["ciphertext"], &aad).unwrap()).unwrap()
    }
}

async fn scene(guild: &Server, home: &Server) -> Scene {
    guild.register("operator").await;
    home.register("operator").await;
    let author = guild.register("alice").await;
    let author_session = guild.post("/_telium/v1/sessions/local", Some(&author.token), json!({})).await
        ["session_token"]
        .as_str()
        .unwrap()
        .to_string();
    let member = home.register("bob").await;
    let guild_id = guild.post("/_telium/v1/guilds", Some(&author_session), json!({ "name": "Cartography" })).await
        ["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, channels) = guild.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), &author_session).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let invite = guild.post(&format!("/_telium/v1/guilds/{guild_id}/invites"), Some(&author_session), json!({})).await;
    let member_session = home.session_on(&member.token, guild).await;
    guild
        .post(&format!("/_telium/v1/invites/{}/join", invite["code"].as_str().unwrap()), Some(&member_session), json!({}))
        .await;

    let deadline = Instant::now() + PATIENCE;
    loop {
        let reported_by: Option<String> = sqlx::query_scalar(
            "SELECT reported_by FROM remote_memberships WHERE user_id = ? AND guild_server = ? AND guild_id = ?",
        )
        .bind(&member.user_id)
        .bind(&guild.name)
        .bind(&guild_id)
        .fetch_optional(&home.state.pool)
        .await
        .unwrap();
        if let Some(reported_by) = reported_by {
            assert_eq!(reported_by, "guild", "the membership must come from the guild's own signed notice");
            break;
        }
        assert!(Instant::now() < deadline, "the guild never told the home about the join");
        tokio::time::sleep(POLL).await;
    }

    let private = SecretKey::random(&mut OsRng);
    let (status, body) = home
        .send(
            home.client
                .put(format!("{}/_telium/v1/notifications/device", home.base))
                .bearer_auth(&member.token)
                .json(&json!({ "algorithm": ALGORITHM_V1, "public_key": b64(private.public_key().to_sec1_bytes().as_ref()) })),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["device_id"].as_str(), Some(member.device_id.as_str()), "{body}");
    let background_token = body["background_token"].as_str().unwrap().to_string();
    Scene { guild_id, channel_id, author_session, member, private, background_token }
}

async fn await_notifications(home: &Server, scene: &Scene, want: usize) -> Vec<Value> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let req = home
            .client
            .get(format!("{}/_telium/v1/notifications", home.base))
            .header("authorization", format!("Telium-Notification {}", scene.background_token));
        let (status, body) = home.send(req).await;
        assert_eq!(status, 200, "{body}");
        let rows = body["notifications"].as_array().cloned().unwrap_or_default();
        if rows.len() >= want {
            return rows;
        }
        assert!(Instant::now() < deadline, "the account home never received the notification: {body}");
        tokio::time::sleep(POLL).await;
    }
}

async fn mention(guild: &Server, scene: &Scene, text: &str) -> String {
    let content = format!("{} {text}", scene.member.user_id);
    let body = guild
        .post(
            &format!("/_telium/v1/channels/{}/messages", scene.channel_id),
            Some(&scene.author_session),
            json!({ "content": content }),
        )
        .await;
    body["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn a_mention_crosses_federation_sealed_and_rings_once() {
    let (guild, home) = pair().await;
    let scene = scene(&guild, &home).await;
    let body_text = "the azimuth survey needs redrawing";
    let message_id = mention(&guild, &scene, body_text).await;

    let rows = await_notifications(&home, &scene, 1).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(
        (&row["origin"], &row["source_id"], &row["kind"], &row["guild_id"]),
        (&json!(guild.name), &json!(message_id), &json!("mention"), &json!(scene.guild_id)),
        "{row}"
    );
    let descriptor = scene.open(&guild, row);
    assert!(descriptor["body"].as_str().unwrap().contains(body_text), "{descriptor}");
    assert_eq!(
        descriptor["destination"],
        json!({
            "type": "guild_message",
            "guild_origin": guild.name,
            "guild_id": scene.guild_id,
            "channel_id": scene.channel_id,
            "message_id": message_id,
        }),
    );
    let device = scene.member.device_id.as_str();
    for (what, tampered) in [
        ("kind", scene.aad(&guild.name, &message_id, device, "reply")),
        ("origin", scene.aad("impostor.example", &message_id, device, "mention")),
        ("device", scene.aad(&guild.name, &message_id, "some-other-device", "mention")),
        ("message", scene.aad(&guild.name, "01JSOMEOTHERMESSAGE", device, "mention")),
    ] {
        assert!(open_envelope(&scene.private, &row["ciphertext"], &tampered).is_err(), "opened under another {what}");
    }

    let (stored, whole_row): (String, String) = sqlx::query_as(
        "SELECT ciphertext, id || '|' || origin || '|' || source_id || '|' || kind || '|' \
         || COALESCE(guild_id, '') || '|' || ciphertext FROM notification_inbox WHERE user_id = ?",
    )
    .bind(&scene.member.user_id)
    .fetch_one(&home.state.pool)
    .await
    .unwrap();
    let mut fields: Vec<_> = serde_json::from_str::<Value>(&stored).unwrap().as_object().unwrap().keys().cloned().collect();
    fields.sort();
    assert_eq!(fields, ["alg", "ciphertext", "ephemeral", "nonce", "salt", "v"]);
    for secret in [body_text, "Cartography", "general"] {
        assert!(!whole_row.contains(secret), "the home can read {secret:?}: {whole_row}");
    }
    let (status, _) = home.get("/_telium/v1/devices", &scene.background_token).await;
    assert_eq!(status, 401, "the notification-only credential worked as a bearer token");

    let envelopes = json!([{ "device_id": device, "ciphertext": row["ciphertext"] }]);
    let item = json!({ "guild_id": scene.guild_id, "source_id": message_id, "kind": "mention", "envelopes": envelopes });
    let mut batch_item = item.clone();
    batch_item["user_id"] = json!(scene.member.user_id);
    for (path, body) in [
        ("/_telium/v1/notifications/batch".to_string(), json!({ "items": [batch_item] })),
        (format!("/_telium/v1/users/{}/notifications", scene.member.user_id), item),
    ] {
        let reply = telium_server::federation::post_signed(&guild.state, &home.name, &path, &body).await.unwrap();
        assert_eq!((reply["ok"].clone(), reply["queued"].clone()), (json!(true), json!(0)), "{path}: {reply}");
        if path.ends_with("batch") {
            assert_eq!(reply["ignored"], 0, "the replay was dropped by a membership check: {reply}");
        }
    }
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_inbox WHERE source_id = ?")
        .bind(&message_id)
        .fetch_one(&home.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, 1);
}

#[tokio::test]
async fn a_mention_sent_while_the_account_home_is_down_arrives_when_it_returns() {
    let (guild, mut home) = pair().await;
    let scene = scene(&guild, &home).await;
    home.go_offline().await;
    let body_text = "the ferry timetable changed";
    let message_id = mention(&guild, &scene, body_text).await;

    let deadline = Instant::now() + PATIENCE;
    loop {
        let row: Option<(i64, Option<String>)> =
            sqlx::query_as("SELECT attempts, last_error FROM notification_outbox WHERE source_id = ?")
                .bind(&message_id)
                .fetch_optional(&guild.state.pool)
                .await
                .unwrap();
        if let Some((attempts, last_error)) = row.filter(|r| r.0 >= 1) {
            assert!(attempts >= 1 && last_error.is_some_and(|e| !e.is_empty()));
            break;
        }
        assert!(Instant::now() < deadline, "the outbox never recorded a failed attempt");
        tokio::time::sleep(POLL).await;
    }

    home.come_back().await;
    let rows = await_notifications(&home, &scene, 1).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["source_id"], message_id.as_str());
    assert!(scene.open(&guild, &rows[0])["body"].as_str().unwrap().contains(body_text));

    let deadline = Instant::now() + PATIENCE;
    loop {
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_outbox WHERE source_id = ?")
            .bind(&message_id)
            .fetch_one(&guild.state.pool)
            .await
            .unwrap();
        if remaining == 0 {
            break;
        }
        assert!(Instant::now() < deadline, "the delivered job was never retired");
        tokio::time::sleep(POLL).await;
    }
}
