
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    addr: std::net::SocketAddr,
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

async fn start_with(tweak: impl FnOnce(&mut Config)) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-limits-{}-{n}", std::process::id()));
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
    cfg.rate_limit.read_burst = 100_000;
    cfg.rate_limit.write_burst = 100_000;
    cfg.rate_limit.auth_burst = 100_000;
    tweak(&mut cfg);
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server {
        addr,
        base: format!("http://{addr}"),
        ws: format!("ws://{addr}/gateway/v1"),
        client: reqwest::Client::new(),
        dir,
        state,
    }
}

async fn start() -> Server {
    start_with(|_| {}).await
}

struct User {
    user_id: String,
    home: String,
    token: String,
}

impl Server {
    async fn send(&self, req: reqwest::RequestBuilder, token: Option<&str>) -> (u16, Value) {
        let req = match token {
            Some(t) => req.bearer_auth(t),
            None => req,
        };
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        self.send(self.client.post(format!("{}{path}", self.base)).json(&body), token).await
    }

    async fn get(&self, path: &str, token: &str) -> (u16, Value) {
        self.send(self.client.get(format!("{}{path}", self.base)), Some(token)).await
    }

    async fn user(&self, localpart: &str) -> User {
        let body = json!({ "localpart": localpart, "password": "correct horse battery" });
        let (status, body) = self.post("/_telium/v1/register", None, body).await;
        assert_eq!(status, 200, "register: {body}");
        let home = body["access_token"].as_str().unwrap().to_string();
        let user_id = body["user_id"].as_str().unwrap().to_string();
        let (status, session) = self.post("/_telium/v1/sessions/local", Some(&home), json!({})).await;
        assert_eq!(status, 200, "session: {session}");
        User { user_id, home, token: session["session_token"].as_str().unwrap().to_string() }
    }

    async fn guild(&self, token: &str) -> (String, String) {
        let (status, guild) = self.post("/_telium/v1/guilds", Some(token), json!({ "name": "Limits" })).await;
        assert_eq!(status, 200, "{guild}");
        let gid = guild["id"].as_str().unwrap().to_string();
        let (_, channels) = self.get(&format!("/_telium/v1/guilds/{gid}/channels"), token).await;
        (gid, channels["channels"][0]["id"].as_str().unwrap().to_string())
    }

    fn rejections(&self, kind: &str) -> u64 {
        let all = self.state.limiter.rejections();
        all.into_iter().find(|(k, _)| *k == kind).map(|(_, n)| n).unwrap_or(0)
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next(ws: &mut Ws) -> Result<Value, Option<CloseCode>> {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => return Ok(serde_json::from_str(&t).unwrap()),
            Ok(Some(Ok(Message::Close(frame)))) => return Err(frame.map(|f| f.code)),
            Ok(Some(Ok(_))) => continue,
            Ok(None) | Ok(Some(Err(_))) => return Err(None),
            Err(_) => panic!("gateway said nothing for five seconds"),
        }
    }
}

async fn send_op(ws: &mut Ws, op: Value) {
    ws.send(Message::Text(op.to_string())).await.unwrap();
}

async fn heartbeat_ack(ws: &mut Ws) {
    send_op(ws, json!({ "op": "HEARTBEAT" })).await;
    for _ in 0..64 {
        let frame = next(ws).await.expect("socket closed while waiting for an ack");
        match frame["op"].as_str() {
            Some("HEARTBEAT_ACK") => return,
            Some("DISPATCH") => continue,
            other => panic!("unexpected {other:?} while waiting for a heartbeat ack"),
        }
    }
    panic!("no heartbeat ack behind sixty-four dispatches");
}

async fn hello(s: &Server) -> Result<Ws, Option<CloseCode>> {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next(&mut ws).await?["op"], "HELLO");
    Ok(ws)
}

async fn try_identify(s: &Server, token: &str, intents: &[&str]) -> Result<Ws, Option<CloseCode>> {
    let mut ws = hello(s).await?;
    send_op(&mut ws, json!({ "op": "IDENTIFY", "d": { "token": token, "intents": intents } })).await;
    assert_eq!(next(&mut ws).await?["op"], "READY");
    Ok(ws)
}

async fn identify(s: &Server, token: &str, intents: &[&str]) -> Ws {
    try_identify(s, token, intents).await.unwrap_or_else(|c| panic!("expected READY, closed {c:?}"))
}

fn typing(cid: &str) -> Value {
    json!({ "op": "TYPING", "d": { "channel_id": cid } })
}

#[tokio::test]
async fn connections_are_capped_per_account_and_the_slot_returns_on_close() {
    let s = start_with(|cfg| cfg.gateway.max_connections_per_account = 2).await;
    let (alice, bob) = (s.user("alice").await, s.user("bob").await);
    let first = identify(&s, &alice.token, &[]).await;
    let _second = identify(&s, &alice.token, &[]).await;
    let refused = try_identify(&s, &alice.token, &[]).await.err();
    assert_eq!(refused, Some(Some(CloseCode::Library(4011))));
    let _bob = identify(&s, &bob.token, &[]).await;

    drop(first);
    for attempt in 0..50 {
        if try_identify(&s, &alice.token, &[]).await.is_ok() {
            return;
        }
        assert!(attempt < 49, "the slot never came back after the socket closed");
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn unidentified_sockets_are_capped_and_identify_releases_the_slot() {
    let s = start_with(|cfg| cfg.gateway.max_pending_sockets = 1).await;
    let alice = s.user("alice").await;
    let _identified = identify(&s, &alice.token, &[]).await;
    assert_eq!(s.state.hub.pending_sockets(), 0);
    let _silent = hello(&s).await.expect("the one pending slot is free");
    assert_eq!(hello(&s).await.err(), Some(Some(CloseCode::Library(4013))));
}

#[tokio::test]
async fn oversized_frames_close_the_socket_and_ordinary_ones_pass() {
    let s = start_with(|cfg| cfg.gateway.max_frame_bytes = 4096).await;
    let alice = s.user("alice").await;
    let mut ws = identify(&s, &alice.token, &[]).await;
    heartbeat_ack(&mut ws).await;
    let huge = json!({ "op": "PRESENCE_UPDATE", "d": { "custom_status": "x".repeat(64 * 1024) } });
    let _ = ws.send(Message::Text(huge.to_string())).await;
    assert!(next(&mut ws).await.is_err(), "an oversized frame was processed");
}

#[tokio::test]
async fn a_frame_flood_is_dropped_but_heartbeats_and_the_socket_survive() {
    let s = start_with(|cfg| {
        cfg.gateway.frame_burst = 2;
        cfg.gateway.frames_per_sec = 0.01;
    })
    .await;
    let alice = s.user("alice").await;
    let (_gid, cid) = s.guild(&alice.token).await;
    let mut ws = identify(&s, &alice.token, &["GUILD_TYPING"]).await;
    for _ in 0..25 {
        send_op(&mut ws, json!({ "op": "HEARTBEAT" })).await;
        assert_eq!(next(&mut ws).await.unwrap()["op"], "HEARTBEAT_ACK");
    }
    for _ in 0..40 {
        send_op(&mut ws, typing(&cid)).await;
    }
    heartbeat_ack(&mut ws).await;
    assert!(s.rejections("gateway-frame") > 0);
}

#[tokio::test]
async fn typing_is_throttled_per_channel_before_fanout() {
    let s = start_with(|cfg| {
        cfg.gateway.typing_burst = 1;
        cfg.gateway.typing_per_sec = 0.01;
        cfg.gateway.frame_burst = 1_000;
    })
    .await;
    let alice = s.user("alice").await;
    let (gid, first) = s.guild(&alice.token).await;
    let path = format!("/_telium/v1/guilds/{gid}/channels");
    let (status, second) = s.post(&path, Some(&alice.token), json!({ "name": "elsewhere" })).await;
    assert_eq!(status, 200, "{second}");
    let second = second["id"].as_str().unwrap().to_string();

    let mut watcher = identify(&s, &alice.token, &["GUILD_TYPING"]).await;
    let mut sender = identify(&s, &alice.token, &[]).await;
    send_op(&mut sender, typing(&first)).await;
    send_op(&mut sender, typing(&second)).await;
    heartbeat_ack(&mut sender).await;
    assert_eq!(s.rejections("gateway-typing"), 0, "each channel has its own budget");

    for _ in 0..30 {
        send_op(&mut sender, typing(&first)).await;
    }
    heartbeat_ack(&mut sender).await;
    let mut events = 0;
    while let Ok(Some(Ok(m))) =
        tokio::time::timeout(std::time::Duration::from_millis(300), watcher.next()).await
    {
        if let Message::Text(t) = m {
            events += (serde_json::from_str::<Value>(&t).unwrap()["t"] == "TYPING_START") as usize;
        }
    }
    assert!(events <= 2, "thirty-two typing frames fanned out {events} events past a burst of one");
    assert!(s.rejections("gateway-typing") > 0);
}

#[tokio::test]
async fn default_gateway_budgets_never_refuse_an_ordinary_client() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_gid, cid) = s.guild(&alice.token).await;
    let mut ws = identify(&s, &alice.token, &[]).await;
    for _ in 0..20 {
        send_op(&mut ws, json!({ "op": "PRESENCE_UPDATE", "d": { "status": "idle" } })).await;
    }
    for _ in 0..5 {
        send_op(&mut ws, typing(&cid)).await;
    }
    heartbeat_ack(&mut ws).await;
    assert_eq!((s.rejections("gateway-frame"), s.rejections("gateway-typing")), (0, 0));
}

#[tokio::test]
async fn mentions_are_deduplicated_and_capped() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_gid, cid) = s.guild(&alice.token).await;
    let stuffed: String = (0..200).map(|n| format!("@v{n:03}:test.example ")).collect();
    for (content, check) in [
        ("@bob:test.example @carol:test.example @dave:test.example ping".to_string(), 3..=3),
        ("@bob:test.example ".repeat(200), 1..=1),
        (stuffed, 1..=50),
    ] {
        let path = format!("/_telium/v1/channels/{cid}/messages");
        let (status, msg) = s.post(&path, Some(&alice.token), json!({ "content": content })).await;
        assert_eq!(status, 200, "{msg}");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM message_mentions WHERE message_id = ?")
            .bind(msg["id"].as_str().unwrap())
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
        assert!(check.contains(&rows), "{rows} mention rows, expected {check:?}");
    }
}

#[tokio::test]
async fn friend_requests_and_conversations_have_their_own_tighter_budgets() {
    let s = start().await;
    let alice = s.user("alice").await;
    for n in 0..35 {
        let _ = s.user(&format!("target{n:02}")).await;
    }
    let mut refused = 0;
    for n in 0..35 {
        let body = json!({ "user_id": format!("@target{n:02}:test.example") });
        let (status, body) = s.post("/_telium/v1/friends", Some(&alice.home), body).await;
        assert!(n >= 5 || status == 200, "an ordinary handful of friends was refused: {body}");
        refused += (status == 429) as usize;
    }
    assert!(refused > 0, "thirty-five friend requests were all allowed");
    assert!(s.rejections("friend-request") > 0);

    let bob = s.user("bob").await;
    let mut members = Vec::new();
    for n in 0..20 {
        members.push(s.user(&format!("member{n:02}")).await.user_id);
    }
    for n in 0..12 {
        let body = json!({ "kind": "dm", "members": [format!("@target{n:02}:test.example")] });
        let (status, body) = s.post("/_telium/v1/conversations", Some(&bob.home), body).await;
        assert_eq!(status, 200, "an ordinary DM was refused: {body}");
    }
    let mut refused = 0;
    for _ in 0..30 {
        let body = json!({ "kind": "gc", "members": members });
        refused += (s.post("/_telium/v1/conversations", Some(&bob.home), body).await.0 == 429) as usize;
    }
    assert!(refused > 0, "thirty twenty-person group chats were all allowed");
    assert!(s.rejections("conversation-create") > 0);
}

#[tokio::test]
async fn invites_are_capped_per_creator_and_expired_ones_are_swept() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (gid, _) = s.guild(&alice.token).await;
    let (mut minted, mut refused) = (0, 0);
    for _ in 0..120 {
        match s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await.0 {
            200 => minted += 1,
            409 => refused += 1,
            other => panic!("unexpected status {other} while minting invites"),
        }
    }
    assert!(refused > 0 && minted >= 100, "minted {minted}, refused {refused}");

    let bob = s.user("bob").await;
    let (gid, _) = s.guild(&bob.token).await;
    let invites = format!("/_telium/v1/guilds/{gid}/invites");
    let mint = || s.post(&invites, Some(&bob.token), json!({ "expires_in_secs": 60 }));
    for _ in 0..60 {
        assert_eq!(mint().await.0, 200);
    }
    sqlx::query("UPDATE invites SET expires_at = 1 WHERE guild_id = ?")
        .bind(&gid)
        .execute(&s.state.pool)
        .await
        .unwrap();
    for _ in 0..60 {
        assert_eq!(mint().await.0, 200, "an expired invite must not occupy a slot");
    }
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE guild_id = ?")
        .bind(&gid)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(live, 60);
}

#[tokio::test]
async fn search_is_priced_by_cost_not_by_request() {
    let s = start().await;
    let refused_of = |results: Vec<u16>| results.iter().filter(|s| **s == 429).count();

    let bob = s.user("bob").await;
    let (gid, cid) = s.guild(&bob.token).await;
    let path = format!("/_telium/v1/channels/{cid}/messages");
    s.post(&path, Some(&bob.token), json!({ "content": "the quarterly roadmap is attached" })).await;
    for _ in 0..40 {
        let (status, body) = s.get(&format!("/_telium/v1/guilds/{gid}/search?q=roadmap"), &bob.token).await;
        assert_eq!((status, body["count"].clone()), (200, json!(1)), "{body}");
    }

    let alice = s.user("alice").await;
    let (gid, _) = s.guild(&alice.token).await;
    let mut results = Vec::new();
    for _ in 0..12 {
        results.push(s.get(&format!("/_telium/v1/guilds/{gid}/search?q=a"), &alice.token).await.0);
    }
    assert!(refused_of(results) > 0, "one-character sweeps were all served");
    assert!(s.rejections("search") > 0);

    let carol = s.user("carol").await;
    let (gid, _) = s.guild(&carol.token).await;
    let q = format!("/_telium/v1/guilds/{gid}/search?q=roadmap&limit=100");
    for _ in 0..20 {
        assert_eq!(s.get(&q, &carol.token).await.0, 200);
    }
    let mut results = Vec::new();
    for _ in 0..8 {
        results.push(s.get(&format!("{q}&offset=20000"), &carol.token).await.0);
    }
    assert!(refused_of(results) > 0, "deep offsets cost no more than first pages");
}

#[tokio::test]
async fn the_body_ceiling_is_global_except_where_a_route_raises_it() {
    let s = start().await;
    let register = |body: reqwest::Body| {
        s.client
            .post(format!("{}/_telium/v1/register", s.base))
            .header("content-type", "application/json")
            .body(body)
            .send()
    };
    let oversized = json!({ "localpart": "alice", "password": "x".repeat(4 * 1024 * 1024) });
    assert_eq!(register(oversized.to_string().into()).await.unwrap().status().as_u16(), 413);

    let alice = s.user("alice").await;
    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("content-type", "application/octet-stream")
        .body(vec![0u8; 3 * 1024 * 1024])
        .send()
        .await
        .unwrap();
    assert_ne!(resp.status().as_u16(), 413, "the upload route's own ceiling was not applied");

    let bomb = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
    assert!(register(bomb.into()).await.unwrap().status().is_client_error());
    let mut nested = json!("leaf");
    for _ in 0..40 {
        nested = json!([nested]);
    }
    let body = json!({ "name": "Nested", "ignored": nested });
    assert_eq!(s.post("/_telium/v1/guilds", Some(&alice.token), body).await.0, 200);

    let resp = s
        .client
        .post(format!("{}/_telium/v1/register", s.base))
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .body(r#"{"localpart":"bob","password":"correct horse battery"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
}

#[tokio::test]
async fn a_stalled_body_is_let_go_but_a_slow_steady_one_is_answered() {
    let s = start_with(|cfg| cfg.limits.request_body_timeout_secs = 1).await;
    let announce = |len: usize| async move {
        let mut sock = tokio::net::TcpStream::connect(s.addr).await.unwrap();
        let head = format!(
            "POST /_telium/v1/register HTTP/1.1\r\nHost: test.example\r\n\
             Content-Type: application/json\r\nContent-Length: {len}\r\n\r\n"
        );
        sock.write_all(head.as_bytes()).await.unwrap();
        sock
    };

    let body = json!({ "localpart": "bob", "password": "correct horse battery" }).to_string();
    let mut stalled = announce(body.len()).await;
    stalled.write_all(&body.as_bytes()[..body.len() / 2]).await.unwrap();
    let mut buf = [0u8; 1024];
    let read = tokio::time::timeout(std::time::Duration::from_secs(10), stalled.read(&mut buf)).await;
    assert!(read.is_ok(), "the server was still waiting ten seconds after the body stalled");

    let body = json!({ "localpart": "alice", "password": "correct horse battery" }).to_string();
    let mut sock = announce(body.len()).await;
    for chunk in body.as_bytes().chunks(body.len().div_ceil(6)) {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        sock.write_all(chunk).await.unwrap();
    }
    let mut response = Vec::new();
    let read = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut buf = [0u8; 4096];
        while !response.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = sock.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            response.extend_from_slice(&buf[..n]);
        }
    })
    .await;
    assert!(read.is_ok(), "the slow but steady body never got an answer");
    assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
}
