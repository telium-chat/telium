use p256::SecretKey;
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    name: String,
    base: String,
    client: reqwest::Client,
    dir: std::path::PathBuf,
    state: telium_server::AppState,
    serve: tokio::task::JoinHandle<()>,
    peers: BTreeMap<String, String>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.serve.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn pair() -> (Server, Server) {
    pair_with_delay(0).await
}

async fn pair_with_delay(delay: i64) -> (Server, Server) {
    pair_tuned(delay, &|_| {}).await
}

async fn pair_tuned(delay: i64, tune: &dyn Fn(&mut Config)) -> (Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lb = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let aa = la.local_addr().unwrap();
    let ab = lb.local_addr().unwrap();

    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{aa}"));
    peers.insert("b.test".to_string(), format!("http://{ab}"));

    let a = boot(la, "a.test", n, 0, peers.clone(), delay, tune).await;
    let b = boot(lb, "b.test", n, 1, peers, delay, tune).await;
    (a, b)
}

async fn trio() -> (Server, Server, Server) {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let la = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lb = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lc = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peers = BTreeMap::new();
    peers.insert("a.test".to_string(), format!("http://{}", la.local_addr().unwrap()));
    peers.insert("b.test".to_string(), format!("http://{}", lb.local_addr().unwrap()));
    peers.insert("c.test".to_string(), format!("http://{}", lc.local_addr().unwrap()));
    let a = boot(la, "a.test", n, 0, peers.clone(), 0, &|_| {}).await;
    let b = boot(lb, "b.test", n, 1, peers.clone(), 0, &|_| {}).await;
    let c = boot(lc, "c.test", n, 2, peers, 0, &|_| {}).await;
    (a, b, c)
}

struct Offline {
    addr: std::net::SocketAddr,
    name: String,
    dir: std::path::PathBuf,
    peers: BTreeMap<String, String>,
}

fn take_offline(server: Server) -> Offline {
    server.serve.abort();
    let offline = Offline {
        addr: server.base.trim_start_matches("http://").parse().unwrap(),
        name: server.name.clone(),
        dir: server.dir.clone(),
        peers: server.peers.clone(),
    };
    std::mem::forget(server);
    offline
}

async fn bring_back(offline: Offline) -> Server {
    let mut listener = None;
    for _ in 0..50 {
        match tokio::net::TcpListener::bind(offline.addr).await {
            Ok(l) => {
                listener = Some(l);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(100)).await,
        }
    }
    boot_on(listener.expect("the address is free again"), &offline.name, offline.dir, offline.peers, 0, &|_| {})
        .await
}

async fn boot(
    listener: tokio::net::TcpListener,
    name: &str,
    n: u32,
    idx: u32,
    peers: BTreeMap<String, String>,
    migration_delay: i64,
    tune: &dyn Fn(&mut Config),
) -> Server {
    let dir = std::env::temp_dir().join(format!("telium-fed-{}-{n}-{idx}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    boot_on(listener, name, dir, peers, migration_delay, tune).await
}

async fn boot_on(
    listener: tokio::net::TcpListener,
    name: &str,
    dir: std::path::PathBuf,
    peers: BTreeMap<String, String>,
    migration_delay: i64,
    tune: &dyn Fn(&mut Config),
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
    cfg.federation.peers = peers.clone();
    cfg.federation.migration_delay_secs = migration_delay;
    tune(&mut cfg);

    let mut state = telium_server::build_state(cfg).await.unwrap();
    state.big_bodies = std::sync::Arc::new(telium_server::federation::BigBodies::paced(
        telium_server::federation::CONCURRENT_BIG_BODIES,
        telium_server::federation::Pace {
            deadline: std::time::Duration::from_secs(10),
            floor_bytes_per_sec: 16 * 1024,
            ordinary_floor_bytes_per_sec: 1024,
            grace: std::time::Duration::from_secs(3),
        },
    ));
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
        peers,
    }
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

    async fn put(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .put(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
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

    async fn delete_json(&self, path: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = self
            .client
            .delete(format!("{}{path}", self.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn elevate(&self, token: &str) {
        let (status, body) = self
            .post(
                "/_telium/v1/admin/step-up",
                Some(token),
                json!({ "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(status, 200, "step-up: {body}");
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
}

use base64::Engine;

mod addresses;
mod basics;
mod bundle_limits;
mod calls;
mod dm;
mod friends;
mod guild_handoff;
mod handoff;
mod moves;
mod public_pages;
mod push;
mod reclaim;
mod requested_moves;
mod resume;
mod revocation;
mod sequencer;

fn device_sign(device_secret_b64: &str, payload: &[u8]) -> String {
    let raw = telium_server::util::unb64(device_secret_b64).expect("device secret is base64");
    let bytes: [u8; 32] = raw.try_into().expect("ed25519 secret is 32 bytes");
    let key = ed25519_dalek::SigningKey::from_bytes(&bytes);
    let sig = ed25519_dalek::Signer::sign(&key, payload);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes())
}

struct Account {
    token: String,
    secret: String,
}

async fn register_full(server: &Server, localpart: &str) -> Account {
    let (status, body) = server
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": localpart, "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "register: {body}");
    Account {
        token: body["access_token"].as_str().unwrap().to_string(),
        secret: body["device_secret"].as_str().expect("server-generated device key").to_string(),
    }
}

async fn spare_admin(server: &Server) {
    let localpart = "spare-admin";
    register_full(server, localpart).await;
    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = ?")
        .bind(format!("@{localpart}:{}", server.name))
        .execute(&server.state.pool)
        .await
        .expect("mark the spare account an administrator");
}

async fn move_user(a: &Server, b: &Server, alice: &Account, newcomer_token: &str, old_id: &str) -> Value {
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(newcomer_token),
            json!({ "subject_type": "user", "source": "a.test", "source_id": old_id }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();
    let created_at = now_ms();
    let payload = telium_server::migration::grant_payload(old_id, "b.test", &import_token, created_at);
    let signature = device_sign(&alice.secret, &payload);
    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let id = started["id"].as_str().unwrap().to_string();
    let (status, done) =
        a.post(&format!("/_telium/v1/migrate/{id}/execute"), Some(&alice.token), json!({})).await;
    assert_eq!(status, 200, "{done}");
    done
}

async fn member_ids(server: &Server, guild_id: &str, session: &str) -> Vec<String> {
    let (status, members) =
        server.get(&format!("/_telium/v1/guilds/{guild_id}/members"), Some(session)).await;
    assert_eq!(status, 200, "{members}");
    members["members"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["user_id"].as_str().map(str::to_string))
        .collect()
}

fn weighty_bundle(subject: &str, rows: usize) -> Value {
    let messages: Vec<Value> = (0..rows)
        .map(|n| {
            json!({
                "id": format!("{subject}-{n:06}"), "channel_id": format!("{subject}-chan"),
                "guild_id": subject, "author_id": "@someone:a.test", "content": "hello",
                "created_at": 1,
            })
        })
        .collect();
    json!({
        "version": 1, "kind": "guild", "subject": subject,
        "channels": [{
            "id": format!("{subject}-chan"), "guild_id": subject, "type": "text",
            "name": "general", "created_at": 1,
        }],
        "messages": messages,
    })
}

async fn claim_on(b: &Server, token: &str, source_id: &str) -> String {
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": source_id }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    claim["import_token"].as_str().unwrap().to_string()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn eventually(server: &Server, path: &str, token: &str, done: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..60 {
        let (status, body) = server.get(path, Some(token)).await;
        if status == 200 && done(&body) {
            return body;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("federated delivery never arrived at {path}");
}

async fn history(server: &Server, who: &Account, conv_id: &str, query: &str) -> Value {
    server
        .get(&format!("/_telium/v1/conversations/{conv_id}/messages{query}"), Some(&who.token))
        .await
        .1
}

async fn dribble(base: &str, forwarded: Option<&str>) -> tokio::net::TcpStream {
    declaring(base, forwarded, 40_000_000).await
}

async fn declaring(base: &str, forwarded: Option<&str>, length: usize) -> tokio::net::TcpStream {
    declaring_as("a.test", base, forwarded, length).await
}

async fn declaring_as(
    origin: &str,
    base: &str,
    forwarded: Option<&str>,
    length: usize,
) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt as _;
    let addr = base.trim_start_matches("http://").to_string();
    let mut sock = tokio::net::TcpStream::connect(&addr).await.unwrap();
    let fwd = forwarded.map(|f| format!("X-Forwarded-For: {f}\r\n")).unwrap_or_default();
    let head = format!(
        "POST /_telium/v1/migrate/import HTTP/1.1\r\nHost: {addr}\r\n\
         Authorization: {} origin={origin},destination=b.test,key=nope,ts={},sig=AAAA\r\n\
         Content-Type: application/json\r\n{fwd}Content-Length: {length}\r\n\r\n",
        telium_server::federation::AUTH_SCHEME,
        now_ms(),
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    sock.flush().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    sock
}

async fn chunked_to(base: &str, path: &str) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt as _;
    let addr = base.trim_start_matches("http://").to_string();
    let mut sock = tokio::net::TcpStream::connect(&addr).await.unwrap();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\n\
         Authorization: {} origin=a.test,destination=b.test,key=nope,ts={},sig=AAAA\r\n\
         Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
        telium_server::federation::AUTH_SCHEME,
        now_ms(),
    );
    sock.write_all(head.as_bytes()).await.unwrap();
    sock.flush().await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    sock
}

async fn expecting_from_a(b: &Server) {
    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();
}

fn was_read_to_the_end(said: &str, what: &str) {
    assert!(
        said.contains("missing field `migration_id`"),
        "{what}: the bundle was not read to the end -- {said}"
    );
}

async fn push_a_bundle(a: &Server) -> String {
    let filler = "x".repeat(5 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;
    format!("{sent:?}")
}

async fn landed_guild(server: &Server, id: &str, owner: &str) {
    sqlx::query(
        "INSERT INTO guilds (id, alias, name, icon_ref, owner_user_id, settings, created_at) \
         VALUES (?, NULL, 'landed', NULL, ?, '{}', 0)",
    )
    .bind(id)
    .bind(owner)
    .execute(&server.state.pool)
    .await
    .unwrap();
}

async fn a_destination_that_refuses_the_push(
    status: &'static str,
    body: &'static str,
) -> String {
    a_destination_answering("", a_destination_that_refuses_the_push_receipt(), status, body).await
}

fn a_destination_that_refuses_the_push_receipt() -> &'static str {
    "{\"error\":\"not_found\",\"message\":\"nothing has landed here\"}"
}

async fn a_destination_answering(
    receipt_status: &'static str,
    receipt: &'static str,
    status: &'static str,
    body: &'static str,
) -> String {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut asked = Vec::new();
                let mut scratch = [0u8; 8192];
                loop {
                    let read = match sock.read(&mut scratch).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    asked.extend_from_slice(&scratch[..read]);
                    let text = String::from_utf8_lossy(&asked).into_owned();
                    let Some(head) = text.find("\r\n\r\n") else { continue };
                    let want: usize = text
                        .to_ascii_lowercase()
                        .split("content-length:")
                        .nth(1)
                        .and_then(|rest| rest.split("\r\n").next())
                        .and_then(|n| n.trim().parse().ok())
                        .unwrap_or(0);
                    if asked.len() >= head + 4 + want {
                        break;
                    }
                }
                let asked = String::from_utf8_lossy(&asked).into_owned();
                let (line, said) = if asked.contains("/.well-known/") {
                    ("200 OK", format!("{{\"api_base\":\"http://{addr}\"}}"))
                } else if asked.contains("/migrate/receipt") {
                    let line =
                        if receipt_status.is_empty() { "404 Not Found" } else { receipt_status };
                    (line, receipt.to_string())
                } else {
                    (status, body.to_string())
                };
                let _ = sock
                    .write_all(
                        format!(
                            "HTTP/1.1 {line}\r\nContent-Type: application/json\r\n\
                             Content-Length: {}\r\nConnection: close\r\n\r\n{said}",
                            said.len()
                        )
                        .as_bytes(),
                    )
                    .await;
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

async fn frame(ws: &mut Ws) -> Value {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), futures_util::StreamExt::next(ws)).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => {
                return serde_json::from_str(&t).unwrap()
            }
            Ok(Some(Ok(_))) => continue,
            other => panic!("expected a text frame, got {other:?}"),
        }
    }
}

async fn gateway(server: &Server, token: &str) -> Ws {
    let url = format!("{}/gateway/v1", server.base.replacen("http://", "ws://", 1));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    assert_eq!(frame(&mut ws).await["op"], "HELLO");
    futures_util::SinkExt::send(
        &mut ws,
        tokio_tungstenite::tungstenite::Message::Text(
            json!({ "op": "IDENTIFY", "d": { "token": token, "intents": ["GUILD_MESSAGES"] } })
                .to_string(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(frame(&mut ws).await["op"], "READY");
    ws
}

async fn local_session(server: &Server, token: &str) -> String {
    let (status, session) = server.post("/_telium/v1/sessions/local", Some(token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    session["session_token"].as_str().expect("a session token").to_string()
}

async fn follow(server: &Server, link: &str, submit: bool) -> (u16, String) {
    let resp = if submit {
        let token = link.split("t=").nth(1).expect("a token in the link");
        server
            .client
            .post(format!("{}/_telium/v1/migrate/cancel-link", server.base))
            .form(&[("t", token)])
            .send()
            .await
            .unwrap()
    } else {
        server.client.get(link).send().await.unwrap()
    };
    (resp.status().as_u16(), resp.text().await.unwrap())
}

async fn accept_handoff(
    b: &Server,
    token: &str,
    source_id: &str,
    id: &str,
    secret: &str,
) -> (u16, Value) {
    b.post(
        "/_telium/v1/migrate/accept",
        Some(token),
        json!({
            "subject_type": "user", "source": "a.test", "source_id": source_id,
            "handoff": { "id": id, "secret": secret },
        }),
    )
    .await
}

async fn start_from_handoff(a: &Server, owner: &Account, id: &str, password: &str) -> (u16, Value) {
    let (status, grant) = a
        .post(
            "/_telium/v1/migrate/grant-payload",
            Some(&owner.token),
            json!({ "subject_type": "user", "destination": "b.test", "handoff_id": id }),
        )
        .await;
    if status != 200 {
        return (status, grant);
    }
    let payload = telium_server::util::unb64(grant["payload"].as_str().unwrap()).unwrap();
    let signature = device_sign(&owner.secret, &payload);
    a.post(
        "/_telium/v1/migrate",
        Some(&owner.token),
        json!({
            "subject_type": "user", "destination": "b.test", "handoff_id": id,
            "password": password, "device_signature": signature,
            "created_at": grant["created_at"],
        }),
    )
    .await
}

async fn live_claims(server: &Server) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM import_claims WHERE used_at IS NULL")
        .fetch_one(&server.state.pool)
        .await
        .unwrap()
}

async fn drained(a: &Server, conv_id: &str) {
    // A healthy outbox drains in milliseconds; the deadline exists to fail a
    // broken pipeline, not to time a runner out for being busy with the other
    // suites this job runs beside.
    for _ in 0..3_000 {
        let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_outbox WHERE conversation_id = ?")
            .bind(conv_id)
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
        if queued == 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the delivery of {conv_id} never completed");
}

async fn group_with_frames(a: &Server, b: &Server, alice: &Account, bob: &Account, n: usize) -> String {
    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@bob:b.test"], "welcome": "gc-welcome" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    for i in 0..n {
        let (status, sent) = a
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/messages"),
                Some(&alice.token),
                json!({ "ciphertext": format!("frame-{i}"), "epoch": 1 }),
            )
            .await;
        assert_eq!(status, 200, "{sent}");
    }
    drained(a, &conv_id).await;
    let held = history(b, bob, &conv_id, "").await;
    assert_eq!(held["messages"].as_array().unwrap().len(), n + 1, "{held}");
    conv_id
}

async fn seqs(server: &Server, conv_id: &str) -> Vec<i64> {
    sqlx::query_scalar("SELECT seq FROM dm_messages WHERE conversation_id = ? ORDER BY seq")
        .bind(conv_id)
        .fetch_all(&server.state.pool)
        .await
        .unwrap()
}
