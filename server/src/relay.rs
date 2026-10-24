//! ```text
//! client  --WSS-->  this server  --TCP-->  guild:443
//!                        |
//!                        +-- forwards bytes. Cannot read them.
//! ```

use crate::auth::HomeAuth;
use crate::config::Relay as RelayConfig;
use crate::federation::embed::is_internal;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

mod close {
    pub const UNAUTHORIZED: u16 = 4001;
    pub const DESTINATION_REFUSED: u16 = 4003;
    pub const SHUTTING_DOWN: u16 = 4005;
    pub const IDLE: u16 = 4008;
    pub const BUDGET_SPENT: u16 = 4013;
    pub const TOO_MANY: u16 = 4029;
    pub const UNREACHABLE: u16 = 4504;
}

const OPEN_TIMEOUT: Duration = Duration::from_secs(10);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const READ_CHUNK: usize = 32 * 1024;

const FLUSH_EVERY: u64 = 8 * 1024 * 1024;

const DISCOVERY_LIMIT: usize = 64 * 1024;

#[derive(Default)]
pub struct RelayState {
    per_account: Mutex<HashMap<String, u32>>,
    total: AtomicU64,
    destinations: Mutex<HashMap<String, (i64, HashSet<String>)>>,
    discovery: Mutex<HashMap<String, (i64, Option<HashSet<(String, u16)>>)>>,
}

impl RelayState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn gauges(&self) -> (u64, usize) {
        (
            self.total.load(Ordering::Relaxed),
            self.per_account.lock().map(|m| m.len()).unwrap_or(0),
        )
    }
}

struct Slot {
    state: Arc<RelayState>,
    user_id: String,
}

impl Slot {
    fn acquire(state: &Arc<RelayState>, user_id: &str, cfg: &RelayConfig) -> Option<Self> {
        let mut per = state.per_account.lock().ok()?;
        let total = state.total.load(Ordering::Relaxed);
        if total >= cfg.max_concurrent_total as u64 {
            return None;
        }
        let mine = per.entry(user_id.to_string()).or_insert(0);
        if *mine >= cfg.max_concurrent_per_account {
            return None;
        }
        *mine += 1;
        state.total.fetch_add(1, Ordering::Relaxed);
        Some(Slot { state: state.clone(), user_id: user_id.to_string() })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.state.total.fetch_sub(1, Ordering::Relaxed);
        if let Ok(mut per) = self.state.per_account.lock() {
            if let Some(count) = per.get_mut(&self.user_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    per.remove(&self.user_id);
                }
            }
        }
    }
}

struct Refusal(&'static str, String);

async fn authorize(
    state: &AppState,
    relay: &Arc<RelayState>,
    server_name: &str,
    host: &str,
    port: u16,
) -> Result<SocketAddr, Refusal> {
    let cfg = &state.cfg.relay;

    if cfg.deny.iter().any(|d| d.eq_ignore_ascii_case(server_name)) {
        return Err(Refusal("destination_refused", format!("this relay does not carry traffic to {server_name}")));
    }
    if !cfg.allow.is_empty() && !cfg.allow.iter().any(|a| a.eq_ignore_ascii_case(server_name)) {
        return Err(Refusal("destination_refused", format!("this relay only carries traffic to servers its operator has listed, and {server_name} is not one")));
    }
    if !cfg.ports.contains(&port) {
        return Err(Refusal("destination_refused", format!("this relay does not open connections to port {port}")));
    }

    let endpoints = discovery(state, relay, server_name).await?;
    let wanted = (host.to_ascii_lowercase(), port);
    if !endpoints.contains(&wanted) {
        return Err(Refusal(
            "destination_refused",
            format!("{host}:{port} is not an endpoint that {server_name} publishes"),
        ));
    }

    resolve_public(host, port).await
}

async fn resolve_public(host: &str, port: u16) -> Result<SocketAddr, Refusal> {
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Refusal("unreachable", format!("cannot resolve {host}")))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err(Refusal("unreachable", format!("cannot resolve {host}")));
    }
    for addr in &addrs {
        if is_internal(addr.ip()) {
            return Err(Refusal(
                "destination_refused",
                format!("{host} resolves to an address that is not routable from here"),
            ));
        }
    }
    Ok(addrs[0])
}

async fn discovery(
    state: &AppState,
    relay: &Arc<RelayState>,
    server_name: &str,
) -> Result<HashSet<(String, u16)>, Refusal> {
    let ttl = state.cfg.relay.discovery_cache_secs as i64 * 1000;
    let key = server_name.to_ascii_lowercase();
    if let Ok(cache) = relay.discovery.lock() {
        if let Some((at, value)) = cache.get(&key) {
            if now_ms() - at < ttl {
                return value.clone().ok_or_else(|| {
                    Refusal("destination_refused", format!("{server_name} does not publish a Telium server"))
                });
            }
        }
    }

    let found = fetch_discovery(&key).await;
    if let Ok(mut cache) = relay.discovery.lock() {
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(key.clone(), (now_ms(), found.clone()));
    }
    found.ok_or_else(|| {
        Refusal("destination_refused", format!("{server_name} does not publish a Telium server"))
    })
}

async fn fetch_discovery(server_name: &str) -> Option<HashSet<(String, u16)>> {
    let addr = resolve_public(server_name, 443).await.ok()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(server_name, addr)
        .user_agent("telium-server")
        .build()
        .ok()?;
    let url = format!("https://{server_name}/.well-known/telium/server");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body = resp.bytes().await.ok()?;
    if body.len() > DISCOVERY_LIMIT {
        return None;
    }
    let doc: Value = serde_json::from_slice(&body).ok()?;

    if doc.get("server_name").and_then(|v| v.as_str()).map(str::to_ascii_lowercase).as_deref()
        != Some(server_name)
    {
        return None;
    }

    let mut out = HashSet::new();
    for field in ["api", "gateway", "client"] {
        let Some(raw) = doc.get(field).and_then(|v| v.as_str()) else { continue };
        let Ok(parsed) = url::Url::parse(raw) else { continue };
        let Some(host) = parsed.host_str() else { continue };
        let Some(port) = parsed.port_or_known_default() else { continue };
        out.insert((host.to_ascii_lowercase(), port));
    }
    if out.is_empty() { None } else { Some(out) }
}

fn note_destination(relay: &Arc<RelayState>, user_id: &str, server_name: &str, ceiling: u32) -> bool {
    let hour = now_ms() / 3_600_000;
    let Ok(mut map) = relay.destinations.lock() else { return true };
    let entry = map.entry(user_id.to_string()).or_insert_with(|| (hour, HashSet::new()));
    if entry.0 != hour {
        *entry = (hour, HashSet::new());
    }
    if entry.1.contains(server_name) {
        return true;
    }
    if entry.1.len() as u32 >= ceiling {
        return false;
    }
    entry.1.insert(server_name.to_string());
    true
}

async fn spent_today(state: &AppState, user_id: &str) -> i64 {
    let since = now_ms() / 3_600_000 - 24;
    sqlx::query_scalar::<_, Option<i64>>(
        "SELECT SUM(bytes) FROM relay_usage WHERE user_id = ? AND hour > ?",
    )
    .bind(user_id)
    .bind(since)
    .fetch_one(&state.pool)
    .await
    .ok()
    .flatten()
    .unwrap_or(0)
}

async fn record_usage(state: &AppState, user_id: &str, bytes: u64, tunnels: i64) {
    let hour = now_ms() / 3_600_000;
    let _ = sqlx::query(
        "INSERT INTO relay_usage (user_id, hour, bytes, tunnels) VALUES (?, ?, ?, ?) \
         ON CONFLICT(user_id, hour) DO UPDATE SET bytes = bytes + excluded.bytes, \
         tunnels = tunnels + excluded.tunnels",
    )
    .bind(user_id)
    .bind(hour)
    .bind(bytes as i64)
    .bind(tunnels)
    .execute(&state.pool)
    .await;
}

async fn sweep(state: &AppState) {
    let since = now_ms() / 3_600_000 - 25;
    let _ = sqlx::query("DELETE FROM relay_usage WHERE hour <= ?")
        .bind(since)
        .execute(&state.pool)
        .await;
}

pub async fn handler(
    State(state): State<AppState>,
    auth: HomeAuth,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| async move {
        if let Err(err) = session(socket, state, auth).await {
            tracing::debug!(target: crate::logcat::RELAY, %err, "relay tunnel ended");
        }
    })
}

async fn session(socket: WebSocket, state: AppState, auth: HomeAuth) -> anyhow::Result<()> {
    let (mut sink, mut stream) = socket.split();

    if state.shutting_down.load(Ordering::Relaxed) {
        let _ = sink.send(close_frame(close::SHUTTING_DOWN, "server restarting")).await;
        return Ok(());
    }

    let cfg = state.cfg.relay.clone();
    let relay = state.relay.clone();

    if state
        .limiter
        .take(
            format!("relay-open:{}", auth.user_id),
            "relay",
            cfg.opens_burst,
            cfg.opens_per_minute / 60.0,
        )
        .is_err()
    {
        refuse(&mut sink, close::TOO_MANY, "rate_limited", "too many protected connections too quickly; wait a moment").await;
        return Ok(());
    }

    let open = match tokio::time::timeout(OPEN_TIMEOUT, stream.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => {
            let _ = sink.send(close_frame(close::UNAUTHORIZED, "no destination")).await;
            return Ok(());
        }
    };
    let doc: Value = serde_json::from_str(&open).unwrap_or(Value::Null);
    if doc.get("op").and_then(|v| v.as_str()) != Some("OPEN") {
        let _ = sink.send(close_frame(close::UNAUTHORIZED, "expected OPEN")).await;
        return Ok(());
    }
    let d = doc.get("d").cloned().unwrap_or(Value::Null);
    let server_name = d.get("server_name").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
    let host = d.get("host").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
    let port = d.get("port").and_then(|v| v.as_u64()).unwrap_or(443) as u16;
    if server_name.is_empty() || host.is_empty() {
        refuse(&mut sink, close::DESTINATION_REFUSED, "bad_request", "the destination was not named").await;
        return Ok(());
    }

    if !note_destination(&relay, &auth.user_id, &server_name, cfg.destinations_per_hour) {
        refuse(&mut sink, close::TOO_MANY, "too_many_destinations", "this account has reached too many different servers this hour").await;
        return Ok(());
    }

    sweep(&state).await;
    if spent_today(&state, &auth.user_id).await >= cfg.daily_bytes_per_account {
        refuse(&mut sink, close::BUDGET_SPENT, "budget_spent", "this account has used its protected-connection allowance for today").await;
        return Ok(());
    }

    let addr = match authorize(&state, &relay, &server_name, &host, port).await {
        Ok(addr) => addr,
        Err(Refusal(code, message)) => {
            let status = if code == "unreachable" { close::UNREACHABLE } else { close::DESTINATION_REFUSED };
            refuse(&mut sink, status, code, &message).await;
            return Ok(());
        }
    };

    let Some(_slot) = Slot::acquire(&relay, &auth.user_id, &cfg) else {
        refuse(&mut sink, close::TOO_MANY, "too_many_tunnels", "too many protected connections are already open").await;
        return Ok(());
    };

    let tcp = match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(addr)).await {
        Ok(Ok(tcp)) => tcp,
        _ => {
            refuse(&mut sink, close::UNREACHABLE, "unreachable", &format!("{host} did not answer")).await;
            return Ok(());
        }
    };
    let _ = tcp.set_nodelay(true);

    if cfg.log_destinations {
        tracing::info!(target: crate::logcat::RELAY, user = %auth.user_id, destination = %server_name, "relay tunnel open");
    }
    crate::metrics::Metrics::bump(&state.metrics.relay_tunnels, 1);
    record_usage(&state, &auth.user_id, 0, 1).await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(cfg.max_lifetime_secs);
    let _ = sink
        .send(Message::Text(
            json!({
                "op": "READY",
                "d": {
                    "max_bytes": cfg.max_tunnel_bytes,
                    "idle_timeout_secs": cfg.idle_timeout_secs,
                    "deadline_ms": now_ms() + cfg.max_lifetime_secs as i64 * 1000,
                }
            })
            .to_string()
            .into(),
        ))
        .await;

    pump(state, auth, cfg, sink, stream, tcp, deadline).await
}

#[allow(clippy::too_many_arguments)]
#[doc(hidden)]
pub async fn pump(
    state: AppState,
    auth: HomeAuth,
    cfg: RelayConfig,
    mut sink: futures_util::stream::SplitSink<WebSocket, Message>,
    mut stream: futures_util::stream::SplitStream<WebSocket>,
    tcp: tokio::net::TcpStream,
    deadline: tokio::time::Instant,
) -> anyhow::Result<()> {
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (tx, mut rx) = mpsc::channel::<Message>(32);

    let moved = Arc::new(AtomicU64::new(0));
    let unflushed = Arc::new(AtomicU64::new(0));
    let touched = Arc::new(AtomicU64::new(now_ms() as u64));

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let up = {
        let (moved, unflushed, touched) = (moved.clone(), unflushed.clone(), touched.clone());
        let (state, user_id, ceiling) = (state.clone(), auth.user_id.clone(), cfg.max_tunnel_bytes as u64);
        async move {
            while let Some(frame) = stream.next().await {
                match frame {
                    Ok(Message::Binary(bytes)) => {
                        if tcp_write.write_all(&bytes).await.is_err() {
                            return Some((close::UNREACHABLE, "destination closed the connection"));
                        }
                        touched.store(now_ms() as u64, Ordering::Relaxed);
                        let total = moved.fetch_add(bytes.len() as u64, Ordering::Relaxed) + bytes.len() as u64;
                        flush_due(&state, &user_id, &unflushed, bytes.len() as u64).await;
                        if total >= ceiling {
                            return Some((close::BUDGET_SPENT, "this connection reached its size limit"));
                        }
                    }
                    Ok(Message::Text(_)) => return Some((close::IDLE, "closed by the client")),
                    Ok(Message::Close(_)) | Err(_) => return None,
                    Ok(_) => {}
                }
            }
            None
        }
    };

    let down = {
        let (moved, unflushed, touched, tx) = (moved.clone(), unflushed.clone(), touched.clone(), tx.clone());
        let (state, user_id, ceiling) = (state.clone(), auth.user_id.clone(), cfg.max_tunnel_bytes as u64);
        async move {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                let n = match tcp_read.read(&mut buf).await {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => n,
                };
                if tx.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                    return None;
                }
                touched.store(now_ms() as u64, Ordering::Relaxed);
                let total = moved.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                flush_due(&state, &user_id, &unflushed, n as u64).await;
                if total >= ceiling {
                    return Some((close::BUDGET_SPENT, "this connection reached its size limit"));
                }
            }
        }
    };

    let watchdog = {
        let touched = touched.clone();
        let idle_ms = cfg.idle_timeout_secs * 1000;
        async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        if now_ms() as u64 - touched.load(Ordering::Relaxed) > idle_ms {
                            return Some((close::IDLE, "this connection was idle for too long"));
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        return Some((close::IDLE, "this connection reached its time limit; reconnect"));
                    }
                }
            }
        }
    };

    let ending = tokio::select! {
        r = up => r,
        r = down => r,
        r = watchdog => r,
    };

    if let Some((code, reason)) = ending {
        let _ = tx.send(close_frame(code, reason)).await;
    } else {
        let _ = tx.send(close_frame(1000, "closed")).await;
    }
    drop(tx);
    let _ = writer.await;

    let left = unflushed.swap(0, Ordering::Relaxed);
    if left > 0 {
        record_usage(&state, &auth.user_id, left, 0).await;
    }
    crate::metrics::Metrics::bump(&state.metrics.relay_bytes, moved.load(Ordering::Relaxed));
    Ok(())
}

async fn flush_due(state: &AppState, user_id: &str, unflushed: &AtomicU64, add: u64) -> bool {
    let total = unflushed.fetch_add(add, Ordering::Relaxed) + add;
    if total < FLUSH_EVERY {
        return false;
    }
    let owed = unflushed.swap(0, Ordering::Relaxed);
    if owed > 0 {
        record_usage(state, user_id, owed, 0).await;
    }
    true
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame { code, reason: reason.to_string().into() }))
}

async fn refuse(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: u16,
    error: &str,
    message: &str,
) {
    let _ = sink
        .send(Message::Text(
            json!({ "op": "REFUSED", "d": { "error": error, "message": message } })
                .to_string()
                .into(),
        ))
        .await;
    let _ = sink.send(close_frame(code, message)).await;
}
