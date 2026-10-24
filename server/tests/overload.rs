
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use telium_server::config::Config;
use telium_server::gateway::events::{Event, INTENT_GUILD_MESSAGES};
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
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-overload-{}-{n}", std::process::id()));
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
    cfg.rate_limit.enabled = false;
    let state = telium_server::build_state(cfg).await.unwrap();
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
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let resp = req.send().await.unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(Value::Null))
    }

    async fn user(&self, localpart: &str) -> String {
        let body = json!({ "localpart": localpart, "password": "correct horse battery" });
        let (status, registered) = self.post("/_telium/v1/register", None, body).await;
        assert_eq!(status, 200, "register: {registered}");
        let home = registered["access_token"].as_str().unwrap();
        let (status, session) = self.post("/_telium/v1/sessions/local", Some(home), json!({})).await;
        assert_eq!(status, 200, "guild session: {session}");
        session["session_token"].as_str().unwrap().to_string()
    }

    async fn guild(&self, owner: &str, name: &str) -> String {
        let (status, guild) = self.post("/_telium/v1/guilds", Some(owner), json!({ "name": name })).await;
        assert_eq!(status, 200, "create guild: {guild}");
        guild["id"].as_str().unwrap().to_string()
    }

    async fn join(&self, guild_id: &str, owner: &str, member: &str) {
        let path = format!("/_telium/v1/guilds/{guild_id}/invites");
        let (status, invite) = self.post(&path, Some(owner), json!({})).await;
        assert_eq!(status, 200, "invite: {invite}");
        let path = format!("/_telium/v1/invites/{}/join", invite["code"].as_str().unwrap());
        assert_eq!(self.post(&path, Some(member), json!({})).await.0, 200);
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next_frame(ws: &mut Ws) -> Option<Message> {
    match tokio::time::timeout(std::time::Duration::from_millis(1500), ws.next()).await {
        Ok(Some(Ok(m))) => Some(m),
        _ => None,
    }
}

async fn connect(s: &Server, token: &str) -> Ws {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert!(matches!(next_frame(&mut ws).await, Some(Message::Text(t)) if t.contains("HELLO")));
    let identify = json!({ "op": "IDENTIFY", "d": { "token": token, "intents": ["GUILD_MESSAGES"] } });
    ws.send(Message::Text(identify.to_string())).await.unwrap();
    assert!(matches!(next_frame(&mut ws).await, Some(Message::Text(t)) if t.contains("READY")));
    ws
}

fn fat_event(guild_id: &str) -> Arc<Event> {
    let d = json!({ "id": "01J0", "channel_id": "c", "content": "x".repeat(2048) });
    Event::new("MESSAGE_CREATE", guild_id, INTENT_GUILD_MESSAGES, d)
}

async fn receives_message(ws: &mut Ws, frames: usize) -> bool {
    for _ in 0..frames {
        match next_frame(ws).await {
            Some(Message::Text(t)) if t.contains("MESSAGE_CREATE") => return true,
            Some(_) => continue,
            None => return false,
        }
    }
    false
}

#[tokio::test]
async fn a_stalled_client_is_shed_alone_and_the_server_recovers() {
    let s = start().await;
    let (alice, bob, carol) = (s.user("alice").await, s.user("bob").await, s.user("carol").await);
    let loud = s.guild(&alice, "Loud Guild").await;
    let quiet = s.guild(&carol, "Quiet Guild").await;
    s.join(&loud, &alice, &bob).await;

    let mut stalled = connect(&s, &bob).await;
    let mut bystander = connect(&s, &carol).await;
    while next_frame(&mut bystander).await.is_some() {}
    let before = telium_server::metrics::sample_gauges(&s.state, false).await;
    assert_eq!(before.gateway_events_dropped, Some(0));

    let fanout = tokio::spawn({
        let (state, loud) = (s.state.clone(), loud.clone());
        async move {
            for _ in 0..4_000 {
                state.hub.publish(fat_event(&loud)).await;
            }
        }
    });
    for _ in 0..20 {
        s.state.hub.publish(fat_event(&quiet)).await;
        assert!(receives_message(&mut bystander, 10).await, "unrelated guild stopped being served");
    }
    fanout.await.unwrap();

    let mut closed_with = None;
    for _ in 0..20_000 {
        match next_frame(&mut stalled).await {
            Some(Message::Close(frame)) => {
                closed_with = frame.map(|f| u16::from(f.code));
                break;
            }
            Some(_) => continue,
            None => break,
        }
    }
    assert_eq!(closed_with, Some(4010), "stalled client not closed with the falling-behind code");

    let after = telium_server::metrics::sample_gauges(&s.state, false).await;
    assert!(after.gateway_events_dropped.unwrap_or(0) > 0, "drops not reported in metrics");
    assert_eq!(after.gateway_sessions_shed, Some(1), "exactly one session should be shed");

    let mut reconnected = connect(&s, &bob).await;
    s.state.hub.publish(fat_event(&loud)).await;
    assert!(receives_message(&mut reconnected, 50).await, "a reconnected client is not served");
    let (status, _) = s.post("/_telium/v1/guilds", Some(&alice), json!({ "name": "Still Here" })).await;
    assert_eq!(status, 200);
}

#[tokio::test]
#[ignore = "a benchmark, not a test: run by hand when sizing a deployment"]
async fn capacity_probe() {
    const SOCKETS: usize = 32;
    const RATES: [usize; 8] = [50, 100, 250, 500, 1_000, 2_000, 4_000, 8_000];
    const SLICES_PER_SEC: usize = 20;
    const SECONDS: usize = 2;

    let s = start().await;
    let alice = s.user("alice").await;
    let guild_id = s.guild(&alice, "Probe").await;
    let counts: Vec<Arc<AtomicU64>> = (0..SOCKETS).map(|_| Arc::new(AtomicU64::new(0))).collect();
    for (i, count) in counts.iter().enumerate() {
        let member = s.user(&format!("m{i}")).await;
        s.join(&guild_id, &alice, &member).await;
        let (mut ws, count) = (connect(&s, &member).await, count.clone());
        tokio::spawn(async move {
            while let Some(Ok(Message::Text(t))) = ws.next().await {
                if t.contains("MESSAGE_CREATE") {
                    count.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let total = || -> u64 { counts.iter().map(|c| c.load(Ordering::Relaxed)).sum() };

    println!("{SOCKETS} sockets, ~2 KiB events, {SECONDS}s per rate");
    println!("{:>8}  {:>10}  {:>10}  {:>9}  {:>7}  {:>5}", "msg/s", "fanout/s", "delivered", "achieved", "dropped", "shed");
    let mut last_clean = None;
    for rate in RATES {
        let per_slice = rate / SLICES_PER_SEC;
        let delivered_before = total();
        let (dropped_before, shed_before) = s.state.hub.backpressure();
        let started = std::time::Instant::now();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(1000 / SLICES_PER_SEC as u64));
        for _ in 0..SECONDS * SLICES_PER_SEC {
            ticker.tick().await;
            for _ in 0..per_slice {
                s.state.hub.publish(fat_event(&guild_id)).await;
            }
        }
        let achieved = (per_slice * SLICES_PER_SEC * SECONDS) as f64 / started.elapsed().as_secs_f64();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let (dropped_after, shed_after) = s.state.hub.backpressure();
        let (dropped, shed) = (dropped_after - dropped_before, shed_after - shed_before);
        let delivered = total() - delivered_before;
        println!("{rate:>8}  {:>10}  {delivered:>10}  {achieved:>9.0}  {dropped:>7}  {shed:>5}", rate * SOCKETS);
        if shed > 0 || dropped > 0 {
            match last_clean {
                Some(clean) => println!("highest clean rate: {clean} msg/s ({} events/s of fanout)", clean * SOCKETS),
                None => println!("no rate was clean; start the ramp lower"),
            }
            return;
        }
        last_clean = Some(rate);
    }
    println!("every rate was clean; raise RATES to find the ceiling");
}
