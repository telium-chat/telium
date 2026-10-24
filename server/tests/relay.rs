
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
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

async fn start_with(tweak: impl FnOnce(&mut Config)) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-relay-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: "relay.test".into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.roles.relay = true;
    tweak(&mut cfg);
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server {
        base: format!("http://{addr}"),
        ws: format!("ws://{addr}/_telium/v1/relay/v1"),
        client: reqwest::Client::new(),
        dir,
        state,
    }
}

async fn register(server: &Server, localpart: &str) -> (String, String) {
    let resp = server
        .client
        .post(format!("{}/_telium/v1/register", server.base))
        .json(&json!({ "localpart": localpart, "password": "correct horse battery" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.unwrap();
    (body["access_token"].as_str().unwrap().into(), body["user_id"].as_str().unwrap().into())
}

async fn discovery(server: &Server) -> Value {
    let url = format!("{}/.well-known/telium/server", server.base);
    server.client.get(url).send().await.unwrap().json().await.unwrap()
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(server: &Server, token: Option<&str>) -> Result<Socket, u16> {
    let mut request = server.ws.as_str().into_client_request().unwrap();
    if let Some(token) = token {
        request.headers_mut().insert("authorization", format!("Bearer {token}").parse().unwrap());
    }
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => Err(resp.status().as_u16()),
        Err(e) => panic!("relay upgrade failed without an HTTP status: {e}"),
    }
}

async fn send(socket: &mut Socket, frame: Value) -> (String, u16) {
    socket.send(Message::Text(frame.to_string())).await.unwrap();
    let mut error = String::new();
    while let Some(Ok(message)) = socket.next().await {
        match message {
            Message::Text(text) => {
                let doc: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if doc["op"] == "REFUSED" {
                    error = doc["d"]["error"].as_str().unwrap_or_default().to_string();
                } else if doc["op"] == "READY" {
                    return ("ready".into(), 0);
                }
            }
            Message::Close(frame) => {
                let code = match frame.map(|f| f.code) {
                    Some(CloseCode::Library(code)) => code,
                    Some(other) => u16::from(other),
                    None => 0,
                };
                return (error, code);
            }
            _ => {}
        }
    }
    (error, 0)
}

async fn open(server: &Server, token: &str, name: &str, port: u16) -> (String, u16) {
    let mut socket = connect(server, Some(token)).await.unwrap();
    let dest = json!({ "server_name": name, "host": name, "port": port });
    send(&mut socket, json!({ "op": "OPEN", "d": dest })).await
}

#[tokio::test]
async fn the_relay_exists_only_with_the_role_and_is_advertised_with_it() {
    let off = start_with(|cfg| cfg.roles.relay = false).await;
    let resp = off.client.get(format!("{}/_telium/v1/relay/v1", off.base)).send().await.unwrap();
    assert_eq!(resp.status(), 404);
    assert!(discovery(&off).await["relay"].is_null());

    let on = start_with(|_| {}).await;
    let relay = discovery(&on).await["relay"].clone();
    assert_eq!(relay["enabled"], true);
    assert!(relay["url"].as_str().unwrap().starts_with("ws"));
    assert!(relay["max_tunnel_bytes"].as_i64().unwrap() > 0);
    assert_eq!(relay["logs_destinations"], false);

    let mut cfg = Config { server_name: "relay.test".into(), ..Config::default() };
    cfg.roles.relay = true;
    cfg.roles.identity = false;
    assert!(cfg.validate().is_err(), "relay without identity should not start");
}

#[tokio::test]
async fn anonymous_callers_and_unacceptable_destinations_are_refused() {
    let s = start_with(|cfg| cfg.relay.deny = vec!["blocked.example".into()]).await;
    assert_eq!(connect(&s, None).await.err(), Some(401));
    assert_eq!(connect(&s, Some("not-a-real-token")).await.err(), Some(401));

    let (token, _) = register(&s, "alice").await;
    for (name, port, why) in [
        ("blocked.example", 443, "deny list"),
        ("mail.example", 25, "port not on the list"),
        ("localhost", 443, "internal address"),
    ] {
        assert_eq!(open(&s, &token, name, port).await, ("destination_refused".into(), 4003), "{why}");
    }
    let mut socket = connect(&s, Some(&token)).await.unwrap();
    let nameless = send(&mut socket, json!({ "op": "OPEN", "d": { "port": 443 } })).await;
    assert_eq!(nameless, ("bad_request".into(), 4003));
    let mut socket = connect(&s, Some(&token)).await.unwrap();
    assert_eq!(send(&mut socket, json!({ "op": "HELLO" })).await.1, 4001, "non-OPEN first frame");

    let s = start_with(|cfg| cfg.relay.allow = vec!["friends.example".into()]).await;
    let (token, _) = register(&s, "alice").await;
    let refused = open(&s, &token, "strangers.example", 443).await;
    assert_eq!(refused, ("destination_refused".into(), 4003), "allow list");
}

#[tokio::test]
async fn opens_destinations_and_bytes_are_budgeted_per_account() {
    let s = start_with(|cfg| {
        cfg.relay.opens_burst = 1.0;
        cfg.relay.opens_per_minute = 1.0;
    })
    .await;
    let (token, _) = register(&s, "alice").await;
    assert_eq!(open(&s, &token, "blocked.example", 25).await.1, 4003);
    assert_eq!(open(&s, &token, "blocked.example", 25).await, ("rate_limited".into(), 4029));

    let s = start_with(|cfg| {
        cfg.relay.destinations_per_hour = 1;
        cfg.relay.opens_burst = 50.0;
    })
    .await;
    let (token, _) = register(&s, "alice").await;
    assert_eq!(open(&s, &token, "one.example", 25).await.1, 4003);
    assert_eq!(open(&s, &token, "two.example", 25).await, ("too_many_destinations".into(), 4029));
    assert_eq!(open(&s, &token, "one.example", 25).await.0, "destination_refused");

    let s = start_with(|cfg| cfg.relay.daily_bytes_per_account = 1024).await;
    let (token, user) = register(&s, "alice").await;
    let hour = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
        as i64
        / 3600;
    sqlx::query("INSERT INTO relay_usage (user_id, hour, bytes, tunnels) VALUES (?, ?, 4096, 1)")
        .bind(&user)
        .bind(hour)
        .execute(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(open(&s, &token, "anywhere.example", 443).await, ("budget_spent".into(), 4013));
}

#[tokio::test]
#[ignore]
async fn relay_cost() {
    use axum::extract::ws::WebSocketUpgrade;
    const CHUNK: usize = 64 * 1024;
    const CHUNKS: usize = 4096;

    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_addr = echo.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = echo.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });

    let server = start_with(|cfg| cfg.relay.max_tunnel_bytes = 8 * 1024 * 1024 * 1024).await;
    let state = server.state.clone();
    let cfg = state.cfg.relay.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/pump",
        axum::routing::get(move |ws: WebSocketUpgrade| {
            let (state, cfg) = (state.clone(), cfg.clone());
            async move {
                ws.on_upgrade(move |socket| async move {
                    let (sink, stream) = socket.split();
                    let tcp = tokio::net::TcpStream::connect(echo_addr).await.unwrap();
                    let _ = tcp.set_nodelay(true);
                    let auth = telium_server::auth::HomeAuth {
                        user_id: "measurement".into(),
                        device_id: "measurement".into(),
                    };
                    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
                    let _ = telium_server::relay::pump(state, auth, cfg, sink, stream, tcp, deadline)
                        .await;
                })
            }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/pump")).await.unwrap();

    let cpu_seconds = || unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return 0.0;
        }
        let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
        t(usage.ru_utime) + t(usage.ru_stime)
    };
    let payload = vec![0x5au8; CHUNK];
    let (started, cpu_before) = (std::time::Instant::now(), cpu_seconds());
    let mut received = 0usize;
    for _ in 0..CHUNKS {
        socket.send(Message::Binary(payload.clone())).await.unwrap();
        while received < CHUNK {
            match socket.next().await {
                Some(Ok(Message::Binary(bytes))) => received += bytes.len(),
                Some(Ok(_)) => {}
                _ => panic!("the tunnel closed after {received} bytes of a chunk"),
            }
        }
        received -= CHUNK;
    }
    let elapsed = started.elapsed().as_secs_f64();
    let cpu = cpu_seconds() - cpu_before;
    let carried = (CHUNK * CHUNKS * 2) as f64;
    let gib = carried / (1024.0 * 1024.0 * 1024.0);
    println!("relay cost: {gib:.2} GiB both directions in {elapsed:.2} s");
    println!("  throughput   {:.0} MiB/s", carried / elapsed / (1024.0 * 1024.0));
    println!("  process CPU  {cpu:.2} s ({:.2} s per GiB)", cpu / gib);
    println!("  transfer     2x the user's own traffic");
}
