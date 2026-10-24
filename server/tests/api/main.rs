use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use opaque_ke::argon2::Argon2;
use opaque_ke::ciphersuite::CipherSuite;
use opaque_ke::rand::rngs::OsRng;
use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialResponse, RegistrationResponse,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_protocol::curator_directory;
use telium_protocol::media_feed::{self, Action};
use telium_server::config::{Config, MediaDefault};
use tokio_tungstenite::tungstenite::Message;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    ws: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn start() -> Server {
    start_with(|_| {}).await
}

async fn start_with(tweak: impl FnOnce(&mut Config)) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-test-{}-{n}", std::process::id()));
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
    tweak(&mut cfg);

    let state = telium_server::build_state(cfg).await.unwrap();
    telium_server::gateway::spawn_presence_flusher(state.clone());
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });

    Server {
        base: format!("http://{addr}"),
        ws: format!("ws://{addr}/gateway/v1"),
        client: reqwest::Client::new(),
        dir,
        state,
    }
}

impl Server {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn patch(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .patch(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = self.client.get(format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn get_with_headers(
        &self,
        path: &str,
        token: Option<&str>,
    ) -> (u16, Value, reqwest::header::HeaderMap) {
        let mut req = self.client.get(format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        (status, resp.json().await.unwrap_or(json!(null)), headers)
    }

    async fn put(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn delete(&self, path: &str, token: &str) -> (u16, Value) {
        let resp = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn user(&self, localpart: &str) -> User {
        let (status, body) = self
            .post("/_telium/v1/register", None, json!({ "localpart": localpart, "password": "correct horse battery" }))
            .await;
        assert_eq!(status, 200, "register: {body}");
        let home = body["access_token"].as_str().unwrap().to_string();
        let user_id = body["user_id"].as_str().unwrap().to_string();

        let (status, session) = self.post("/_telium/v1/sessions/local", Some(&home), json!({})).await;
        assert_eq!(status, 200, "session: {session}");
        User {
            user_id,
            home,
            token: session["session_token"].as_str().unwrap().to_string(),
        }
    }
}

struct User {
    user_id: String,
    home: String,
    token: String,
}

struct BrowserOpaqueSuite;

impl CipherSuite for BrowserOpaqueSuite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = Argon2<'static>;
}

fn opaque_b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn identity_signing_key() -> SigningKey {
    SigningKey::from_bytes(&rand::random::<[u8; 32]>())
}

fn identity_public(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes())
}

fn identity_signature(key: &SigningKey, payload: &str) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(payload.as_bytes()).to_bytes())
}

async fn opaque_login(
    s: &Server,
    user: &str,
    password: &str,
    mfa_code: Option<&str>,
) -> Option<(Value, Vec<u8>)> {
    let mut rng = OsRng;
    let started =
        ClientLogin::<BrowserOpaqueSuite>::start(&mut rng, password.as_bytes()).unwrap();
    let (status, response) = s
        .post(
            "/_telium/v1/login/opaque/start",
            None,
            json!({
                "user": user,
                "start_login_request": opaque_b64(started.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque login start: {response}");
    assert_eq!(
        response["legacy_upgrade_required"],
        false,
        "OPAQUE accounts must never ask the client to raw-password fallback"
    );

    let response_bytes = URL_SAFE_NO_PAD
        .decode(response["login_response"].as_str().unwrap())
        .unwrap();
    let finished = started
        .state
        .finish(
            &mut rng,
            password.as_bytes(),
            CredentialResponse::deserialize(&response_bytes).unwrap(),
            ClientLoginFinishParameters::default(),
        )
        .ok()?;

    let export_key = finished.export_key.to_vec();
    let (status, session) = s
        .post(
            "/_telium/v1/login/opaque/finish",
            None,
            json!({
                "login_id": response["login_id"],
                "finish_login_request": opaque_b64(finished.message.serialize().as_slice()),
                "device_name": "opaque login test",
                "mfa_code": mfa_code,
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque login finish: {session}");
    Some((session, export_key))
}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn next_frame(ws: &mut Ws) -> Value {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return serde_json::from_str(&t).unwrap(),
            Ok(Some(Ok(_))) => continue,
            other => panic!("expected a text frame, got {other:?}"),
        }
    }
}

async fn connect(s: &Server, token: &str) -> Ws {
    connect_with(s, token, None).await
}

async fn connect_with(s: &Server, token: &str, presence: Option<Value>) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "HELLO");
    let mut d = json!({ "token": token, "intents": ["GUILD_PRESENCES"] });
    if let Some(p) = presence {
        d["presence"] = p;
    }
    ws.send(Message::Text(json!({ "op": "IDENTIFY", "d": d }).to_string()))
        .await
        .unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "READY");
    ws
}

async fn connect_watching(s: &Server, token: &str, intents: &[&str]) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": token, "intents": intents } }).to_string(),
    ))
    .await
    .unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "READY");
    ws
}

async fn wait_for(ws: &mut Ws, t: &str) -> Value {
    for _ in 0..20 {
        let frame = next_frame(ws).await;
        if frame["t"] == t {
            return frame;
        }
    }
    panic!("never saw {t}");
}

fn png_fixture(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(width, height, |x, y| {
        let a = if x < width / 4 && y < height / 4 { 90 } else { 255 };
        image::Rgba([(x * 255 / width) as u8, (y * 255 / height) as u8, 128, a])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image).write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

async fn social_fixture() -> (Server, User, User, String, String) {
    social_fixture_with(|_| {}).await
}

async fn social_fixture_with(tweak: impl FnOnce(&mut Config)) -> (Server, User, User, String, String) {
    let s = start_with(tweak).await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, joined) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{joined}");
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    (s, alice, bob, gid, cid)
}

async fn open_dm(s: &Server, from: &User, to: &User) -> String {
    let (status, made) = s
        .post("/_telium/v1/conversations", Some(&from.home), json!({ "kind": "dm", "members": [&to.user_id] }))
        .await;
    assert_eq!(status, 200, "{made}");
    made["id"].as_str().unwrap().to_string()
}

async fn dm_send(s: &Server, conv: &str, who: &User, ct: &str) {
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let (status, sent) =
        s.post(&path, Some(&who.home), json!({ "kind": "application", "ciphertext": ct })).await;
    assert_eq!(status, 200, "{sent}");
}

use telium_protocol::hosting_catalog::{self, Catalog, Period, Plan, Provider};
use telium_server::config::{Hosting, HostingCatalog, HostingPlan, HostingProvider};

mod account;
mod auth;
mod dm;
mod emoji;
mod feeds;
mod friends;
mod gateway;
mod guilds;
mod identity;
mod instance;
mod live_updates;
mod media;
mod profile;
mod roles;
mod social;
mod voice;

async fn listed(s: &Server) -> Value {
    let (status, body) = s.get("/_telium/v1/hosting/providers", None).await;
    assert_eq!(status, 200, "provider list: {body}");
    body
}

async fn count(s: &Server, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&s.state.pool).await.unwrap()
}
