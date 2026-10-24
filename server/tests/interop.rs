
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_protocol::compat::{self, PeerCompat};
use telium_server::config::Config;
use telium_server::federation as fed;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::Message;

static COUNTER: AtomicU32 = AtomicU32::new(0);
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/interop");
const SHAPES: &[&str] = &["v0-legacy", "v1", "hypothetical-v2"];
const CLOSE_INCOMPATIBLE: u16 = 4015;

fn fixture(shape: &str, name: &str) -> Value {
    let path = format!("{FIXTURES}/{shape}/{name}");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

struct Server {
    name: String,
    base: String,
    ws: String,
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

async fn boot(listener: tokio::net::TcpListener, name: &str, peers: BTreeMap<String, String>) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-interop-{}-{n}", std::process::id()));
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
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    let (base, ws) = (format!("http://{addr}"), format!("ws://{addr}/gateway/v1"));
    Server { name: name.into(), base, ws, client: reqwest::Client::new(), dir, state, serve }
}

impl Server {
    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = self.client.get(format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn user(&self, localpart: &str) -> (String, String) {
        let post = |path: &str, token: Option<&str>, body: Value| {
            let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
            if let Some(t) = token {
                req = req.bearer_auth(t);
            }
            async move { req.send().await.unwrap().json::<Value>().await.unwrap() }
        };
        let body = json!({ "localpart": localpart, "password": "correct horse battery" });
        let home = post("/_telium/v1/register", None, body).await["access_token"].as_str().unwrap().to_string();
        let session = post("/_telium/v1/sessions/local", Some(&home), json!({})).await;
        (home, session["session_token"].as_str().unwrap().to_string())
    }
}

async fn next_frame(ws: &mut Ws) -> Message {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Ping(_)))) => continue,
            Ok(Some(Ok(m))) => return m,
            other => panic!("no frame: {other:?}"),
        }
    }
}

async fn next_text(ws: &mut Ws) -> Value {
    match next_frame(ws).await {
        Message::Text(t) => serde_json::from_str(&t).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

async fn closing(ws: &mut Ws) -> (u16, String) {
    loop {
        if let Message::Close(Some(frame)) = next_frame(ws).await {
            let code = match frame.code {
                CloseCode::Library(n) => n,
                other => u16::from(other),
            };
            return (code, frame.reason.to_string());
        }
    }
}

async fn identify_with(server: &Server, frame: Value) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(&server.ws).await.unwrap();
    assert_eq!(next_text(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(frame.to_string().into())).await.unwrap();
    ws
}

async fn identify(server: &Server, shape: &str, token: &str) -> Ws {
    let mut frame = fixture(shape, "gateway-identify.json");
    frame["d"]["token"] = json!(token);
    identify_with(server, frame).await
}

fn key_paths(value: &Value, prefix: &str, into: &mut Vec<String>) {
    for (k, v) in value.as_object().into_iter().flatten() {
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        into.push(path.clone());
        key_paths(v, &path, into);
    }
}

#[test]
fn the_frozen_fixtures_parse_as_their_era_says() {
    let mut on_disk: Vec<String> = std::fs::read_dir(FIXTURES)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    on_disk.sort();
    let mut known: Vec<String> = SHAPES.iter().map(|s| s.to_string()).collect();
    known.sort();
    assert_eq!(on_disk, known, "every fixture directory must be in SHAPES, and vice versa");

    let headers = |shape: &str| {
        let h = fixture(shape, "federation-headers.json");
        let get = |k: &str| h.get(k).and_then(Value::as_str).map(str::to_string);
        PeerCompat::from_wire(
            get("x-telium-protocol").as_deref(),
            get("x-telium-min-protocol").as_deref(),
            get("x-telium-capabilities").as_deref(),
        )
    };
    for shape in SHAPES {
        let peer = fed::compat_from_discovery(&fixture(shape, "discovery.json"));
        assert!(peer.version >= 1 && peer.min_supported <= peer.version, "{shape}: {peer:?}");
        assert!(headers(shape).version >= 1, "{shape}: headers");
        let _ = fixture(shape, "gateway-identify.json");
    }

    let legacy = fed::compat_from_discovery(&fixture("v0-legacy", "discovery.json"));
    assert_eq!((legacy.version, legacy.min_supported), (1, 1));
    assert!(legacy.capabilities.is_empty());
    assert!(compat::negotiate(&PeerCompat::local(), &legacy).is_ok());
    let legacy_headers = headers("v0-legacy");
    assert_eq!(legacy_headers.version, PeerCompat::legacy().version);
    assert_eq!(legacy_headers.min_supported, PeerCompat::legacy().min_supported);
    assert!(legacy_headers.capabilities.is_empty());

    let future = fed::compat_from_discovery(&fixture("hypothetical-v2", "discovery.json"));
    let why = compat::negotiate(&PeerCompat::local(), &future).unwrap_err();
    assert!(why.to_string().contains('2') && why.to_string().contains('1'), "{why}");
    assert!(!why.remedy().is_empty());
    assert!(future.has("some.capability.this.build.has.never.heard.of"), "{:?}", future.capabilities);
}

#[tokio::test]
async fn one_server_serves_every_era_of_client() {
    let s = boot(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(), "solo.test", BTreeMap::new()).await;
    let (admin, token) = s.user("root").await;

    let (status, live) = s.get("/.well-known/telium/server", None).await;
    assert_eq!(status, 200, "{live}");
    let mut present = Vec::new();
    key_paths(&live, "", &mut present);
    for shape in ["v0-legacy", "v1"] {
        let mut expected = Vec::new();
        key_paths(&fixture(shape, "discovery.json"), "", &mut expected);
        for path in expected.iter().filter(|p| !p.starts_with("keys.verify_keys.")) {
            assert!(present.contains(path), "{shape} published `{path}`; removing it is incompatible");
        }
    }
    assert_eq!(live["protocol"]["version"], compat::PROTOCOL_VERSION);
    assert_eq!(live["protocol"]["min_supported"], compat::MIN_SUPPORTED_PROTOCOL_VERSION);
    assert_eq!(live["protocol_version"], format!("v{}", compat::PROTOCOL_VERSION));
    let caps: Vec<&str> = live["protocol"]["capabilities"].as_array().unwrap().iter().map(|c| c.as_str().unwrap()).collect();
    assert_eq!(caps, compat::CAPABILITIES);

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let hello = next_text(&mut ws).await;
    assert_eq!(hello["d"]["gateway_version"], 1, "old clients read gateway_version");
    assert_eq!(hello["d"]["protocol"]["version"], compat::PROTOCOL_VERSION);
    assert!(hello["d"]["heartbeat_interval_ms"].is_number());

    let ready = next_text(&mut identify(&s, "v0-legacy", &token).await).await;
    assert_eq!(ready["op"], "READY", "an old client was refused: {ready}");
    let ready = next_text(&mut identify(&s, "v1", &token).await).await;
    assert_eq!(ready["op"], "READY", "{ready}");
    assert_eq!(ready["d"]["protocol"]["version"], compat::PROTOCOL_VERSION);

    for token in [token.as_str(), "this-token-is-nonsense"] {
        let (code, reason) = closing(&mut identify(&s, "hypothetical-v2", token).await).await;
        assert_eq!(code, CLOSE_INCOMPATIBLE, "{reason}");
        assert!(reason.contains('2') || reason.contains('1'), "{reason:?}");
        assert!(reason.len() <= 123, "{reason:?}");
    }

    let unknown = json!({ "op": "IDENTIFY", "d": {
        "token": token,
        "intents": ["GUILD_PRESENCES"],
        "a_field_from_a_later_release": { "deeply": ["nested", 7, null] },
        "protocol": { "version": 1, "min_supported": 1,
            "capabilities": ["sync.sealed", "something.invented.next.year"], "an_unknown_sub_field": true },
    }});
    let ready = next_text(&mut identify_with(&s, unknown).await).await;
    assert_eq!(ready["op"], "READY", "an unknown field was treated as an error: {ready}");

    let (status, body) = s.get("/_telium/v1/admin/status", Some(&admin)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["protocol"]["version"], compat::PROTOCOL_VERSION);
    assert_eq!(body["protocol"]["min_supported"], compat::MIN_SUPPORTED_PROTOCOL_VERSION);
    assert_eq!(body["incompatible_peers"], 0);
}

#[tokio::test]
async fn two_servers_record_and_surface_each_others_window() {
    let (la, lb) = (tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap(), tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap());
    let peers: BTreeMap<String, String> = [("a.test", &la), ("b.test", &lb)]
        .into_iter()
        .map(|(n, l)| (n.to_string(), format!("http://{}", l.local_addr().unwrap())))
        .collect();
    let a = boot(la, "a.test", peers.clone()).await;
    let b = boot(lb, "b.test", peers).await;
    let (admin, _) = a.user("root").await;
    let pool = &a.state.pool;
    let column = |col: &'static str| async move {
        sqlx::query_scalar::<_, Option<String>>(&format!("SELECT CAST({col} AS TEXT) FROM remote_servers WHERE origin = ?"))
            .bind("b.test")
            .fetch_optional(pool)
            .await
            .unwrap()
            .flatten()
    };
    let peer_row = |body: &Value| body["peers"].as_array().unwrap().iter().find(|p| p["origin"] == "b.test").cloned().unwrap();

    fed::discover(&a.state, &b.name).await.unwrap();
    let peer = fed::peer_compat(&a.state, &b.name).await.unwrap();
    assert_eq!(peer.version, compat::PROTOCOL_VERSION);
    assert!(peer.has(compat::CAP_MIGRATE_TRY_AGAIN), "{:?}", peer.capabilities);
    assert!(fed::peer_supports(&a.state, &b.name, compat::CAP_MIGRATE_TRY_AGAIN).await);

    let first = column("compat_checked_at").await;
    assert!(first.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    fed::record_peer_compat(&a.state, &b.name, &peer).await.unwrap();
    assert_eq!(column("compat_checked_at").await, first, "an unchanged answer was written again");
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    fed::record_peer_compat(&a.state, &b.name, &PeerCompat::legacy()).await.unwrap();
    assert_ne!(column("compat_checked_at").await, first, "a changed answer was skipped");
    let legacy = fed::peer_compat(&a.state, &b.name).await.unwrap();
    assert_eq!(legacy.version, 1);
    assert!(legacy.capabilities.is_empty());
    assert!(!fed::peer_supports(&a.state, &b.name, compat::CAP_MIGRATE_TRY_AGAIN).await);
    assert_eq!(column("compat_status").await.as_deref(), Some("ok"));

    sqlx::query(
        "UPDATE remote_servers SET protocol_version = NULL, protocol_min_supported = NULL, \
         capabilities = NULL, compat_status = NULL, compat_checked_at = NULL WHERE origin = ?",
    )
    .bind(&b.name)
    .execute(pool)
    .await
    .unwrap();
    let (_, body) = a.get("/_telium/v1/admin/peers", Some(&admin)).await;
    assert_eq!(peer_row(&body)["protocol"]["status"], "unknown");
    assert_eq!(body["incompatible"], 0);

    let future = fed::compat_from_discovery(&fixture("hypothetical-v2", "discovery.json"));
    fed::record_peer_compat(&a.state, &b.name, &future).await.unwrap();
    let (status, body) = a.get("/_telium/v1/admin/peers", Some(&admin)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["incompatible"], 1, "{body}");
    let row = peer_row(&body);
    assert_ne!(row["protocol"]["status"], "ok");
    assert!(row["protocol"]["message"].as_str().unwrap_or_default().contains('2'), "{}", row["protocol"]);
    assert!(row["protocol"]["remedy"].is_string());
    assert_eq!(body["peers"][0]["origin"], "b.test");
    assert_eq!(body["local"]["version"], compat::PROTOCOL_VERSION);

    let bytes = serde_json::to_vec(&json!({ "kind": "spam", "subject": "https://example.org/x" })).unwrap();
    let auth = fed::auth_header(&b.state.key, "POST", "/_telium/v1/report", &bytes, &b.name, &a.name);
    let resp = a
        .client
        .post(format!("{}/_telium/v1/report", a.base))
        .header("authorization", auth)
        .header("content-type", "application/json")
        .header("x-telium-protocol", "v2")
        .header("x-telium-min-protocol", "v2")
        .header("x-telium-capabilities", "migrate.try_again")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 400);
    let refusal: Value = resp.json().await.unwrap();
    assert_eq!(refusal["error"], "incompatible_protocol", "{refusal}");
    let message = refusal["message"].as_str().unwrap_or_default();
    assert!(message.contains(&b.name) && message.contains('2') && message.contains('1'), "{message}");
    assert_eq!(column("compat_status").await.as_deref(), Some("peer_protocol_too_new"));
}
