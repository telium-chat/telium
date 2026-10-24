
use crate::state::AppState;
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

mod prometheus;
pub use prometheus::{gather, prometheus, render, BackupHealth, Scrape, ScrapePolicy, StandbyHealth, StorageSample};

pub const LATENCY_BOUNDS_US: [u64; 16] = [
    250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 125_000, 250_000, 500_000,
    1_000_000, 2_000_000, 4_000_000, 8_000_000,
];

pub const LATENCY_BUCKETS: usize = LATENCY_BOUNDS_US.len() + 1;

#[derive(Debug)]
pub struct Histogram {
    buckets: [AtomicU64; LATENCY_BUCKETS],
}

impl Default for Histogram {
    fn default() -> Self {
        Self { buckets: std::array::from_fn(|_| AtomicU64::new(0)) }
    }
}

impl Histogram {
    pub fn record(&self, micros: u64) {
        let index = LATENCY_BOUNDS_US.iter().position(|&bound| micros <= bound)
            .unwrap_or(LATENCY_BUCKETS - 1);
        self.buckets[index].fetch_add(1, Ordering::Relaxed);
    }

    pub fn read(&self) -> [u64; LATENCY_BUCKETS] {
        std::array::from_fn(|i| self.buckets[i].load(Ordering::Relaxed))
    }

    pub fn delta(&self, since: &mut [u64; LATENCY_BUCKETS]) -> [u64; LATENCY_BUCKETS] {
        let now = self.read();
        let out = std::array::from_fn(|i| now[i].saturating_sub(since[i]));
        *since = now;
        out
    }
}

pub fn percentile(counts: &[u64; LATENCY_BUCKETS], q: f64) -> Option<f64> {
    let total: u64 = counts.iter().sum();
    let needed = (1.0 / (1.0 - q)).ceil() as u64;
    if total < needed {
        return None;
    }
    let rank = ((total as f64) * q).ceil().max(1.0) as u64;
    let mut seen = 0u64;
    for (i, &count) in counts.iter().enumerate() {
        seen += count;
        if seen >= rank {
            return Some(match LATENCY_BOUNDS_US.get(i) {
                Some(&bound) => bound as f64 / 1000.0,
                None => LATENCY_BOUNDS_US[LATENCY_BOUNDS_US.len() - 1] as f64 / 1000.0,
            });
        }
    }
    None
}

#[derive(Debug, Default)]
pub struct RouteStats {
    pub requests: AtomicU64,
    pub errors: AtomicU64,
    pub latency: Histogram,
}

#[derive(Debug, Default)]
pub struct Metrics {
    pub started_at_ms: AtomicU64,

    pub requests: AtomicU64,
    pub requests_federation: AtomicU64,
    pub responses_4xx: AtomicU64,
    pub responses_5xx: AtomicU64,
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
    pub bytes_out_unmeasured: AtomicU64,
    pub latency: Histogram,
    pub latency_sum_us: AtomicU64,

    pub gateway_events_out: AtomicU64,
    pub gateway_frames_in: AtomicU64,

    pub messages_guild: AtomicU64,
    pub messages_dm: AtomicU64,

    pub media_uploads: AtomicU64,
    pub media_upload_bytes: AtomicU64,

    pub media_scans: AtomicU64,
    pub media_scan_matches: AtomicU64,
    pub media_scan_failures: AtomicU64,

    pub federation_deliveries: AtomicU64,
    pub federation_delivery_failures: AtomicU64,

    pub relay_tunnels: AtomicU64,
    pub relay_bytes: AtomicU64,

    routes: RwLock<HashMap<String, Arc<RouteStats>>>,
    routes_full: AtomicU64,
}

impl Metrics {
    pub fn new() -> Self {
        let m = Self::default();
        m.started_at_ms.store(now_ms() as u64, Ordering::Relaxed);
        m
    }

    pub fn started_at(&self) -> i64 {
        self.started_at_ms.load(Ordering::Relaxed) as i64
    }

    pub fn bump(counter: &AtomicU64, by: u64) {
        counter.fetch_add(by, Ordering::Relaxed);
    }

    async fn route(&self, pattern: &str, max_routes: usize) -> Option<Arc<RouteStats>> {
        if let Some(found) = self.routes.read().await.get(pattern) {
            return Some(found.clone());
        }
        let mut routes = self.routes.write().await;
        if let Some(found) = routes.get(pattern) {
            return Some(found.clone());
        }
        if routes.len() >= max_routes {
            if self.routes_full.swap(1, Ordering::Relaxed) == 0 {
                tracing::warn!(target: crate::logcat::TELEMETRY, max_routes, "metrics route table full; per-route detail truncated");
            }
            return None;
        }
        let entry = Arc::new(RouteStats::default());
        routes.insert(pattern.to_string(), entry.clone());
        Some(entry)
    }

    pub async fn route_table(&self) -> Vec<Value> {
        let routes = self.routes.read().await;
        let mut rows: Vec<(f64, Value)> = routes
            .iter()
            .map(|(pattern, stats)| {
                let counts = stats.latency.read();
                let p99 = percentile(&counts, 0.99);
                let row = json!({
                    "route": pattern,
                    "requests": stats.requests.load(Ordering::Relaxed),
                    "errors": stats.errors.load(Ordering::Relaxed),
                    "p50_ms": percentile(&counts, 0.50),
                    "p90_ms": percentile(&counts, 0.90),
                    "p99_ms": p99,
                    "over_ceiling": counts[LATENCY_BUCKETS - 1],
                });
                (p99.unwrap_or(-1.0), row)
            })
            .collect();
        rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        rows.into_iter().map(|(_, row)| row).collect()
    }
}

pub async fn layer(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    if !state.cfg.metrics.enabled {
        return next.run(req).await;
    }
    let metrics = state.metrics.clone();
    let max_routes = state.cfg.metrics.max_routes;

    let federation = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with(crate::federation::AUTH_SCHEME));
    let bytes_in = req
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let pattern = req
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|m| m.as_str().to_string())
        .unwrap_or_else(|| "(unmatched)".to_string());

    let started = std::time::Instant::now();
    let response = next.run(req).await;
    let micros = started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;

    let status = response.status().as_u16();
    let bytes_out = response
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());

    Metrics::bump(&metrics.requests, 1);
    if federation {
        Metrics::bump(&metrics.requests_federation, 1);
    }
    if (400..500).contains(&status) {
        Metrics::bump(&metrics.responses_4xx, 1);
    } else if status >= 500 {
        Metrics::bump(&metrics.responses_5xx, 1);
    }
    Metrics::bump(&metrics.bytes_in, bytes_in);
    match bytes_out {
        Some(n) => Metrics::bump(&metrics.bytes_out, n),
        None => Metrics::bump(&metrics.bytes_out_unmeasured, 1),
    }
    metrics.latency.record(micros);
    Metrics::bump(&metrics.latency_sum_us, micros);
    if let Some(route) = metrics.route(&pattern, max_routes).await {
        Metrics::bump(&route.requests, 1);
        if status >= 400 {
            Metrics::bump(&route.errors, 1);
        }
        route.latency.record(micros);
    }
    response
}

#[derive(Default)]
struct Baseline {
    requests: u64,
    requests_federation: u64,
    responses_4xx: u64,
    responses_5xx: u64,
    bytes_in: u64,
    bytes_out: u64,
    bytes_out_unmeasured: u64,
    latency: [u64; LATENCY_BUCKETS],
    gateway_events_out: u64,
    gateway_frames_in: u64,
    messages_guild: u64,
    messages_dm: u64,
    media_uploads: u64,
    media_upload_bytes: u64,
    federation_deliveries: u64,
    federation_delivery_failures: u64,
}

fn step(counter: &AtomicU64, since: &mut u64) -> i64 {
    let now = counter.load(Ordering::Relaxed);
    let delta = now.saturating_sub(*since);
    *since = now;
    delta.min(i64::MAX as u64) as i64
}

pub fn spawn(state: AppState) {
    if !state.cfg.metrics.enabled {
        return;
    }
    tokio::spawn(async move {
        let interval_ms = (state.cfg.metrics.interval_secs.max(1) * 1000) as i64;
        let storage_ms = (state.cfg.metrics.storage_interval_secs.max(1) * 1000) as i64;
        let mut baseline = Baseline::default();
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(state.cfg.metrics.interval_secs.max(1)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let mut window_opened = now_ms();
        let mut last_storage_sample: Option<i64> = None;
        loop {
            ticker.tick().await;
            let closed = now_ms();
            let sample_storage = last_storage_sample
                .map(|at| closed - at >= storage_ms)
                .unwrap_or(true);
            if let Err(err) =
                write_bucket(&state, &mut baseline, window_opened, closed, interval_ms, sample_storage)
                    .await
            {
                tracing::warn!(target: crate::logcat::TELEMETRY, %err, "metrics rollup failed");
            } else if sample_storage {
                last_storage_sample = Some(closed);
            }
            window_opened = closed;
        }
    });
}

async fn write_bucket(
    state: &AppState,
    baseline: &mut Baseline,
    window_opened: i64,
    closed: i64,
    interval_ms: i64,
    sample_storage: bool,
) -> anyhow::Result<()> {
    let m = &state.metrics;
    let bucket_start = (window_opened / interval_ms) * interval_ms;
    let covered = (closed - window_opened).max(0);

    let latency = m.latency.delta(&mut baseline.latency);
    let gauges = sample_gauges(state, sample_storage).await;

    sqlx::query(
        "INSERT INTO metrics_rollup (\
            bucket_start, window_ms, covered_ms, requests, requests_federation, \
            responses_4xx, responses_5xx, bytes_in, bytes_out, bytes_out_unmeasured, \
            latency_hist, gateway_events_out, gateway_frames_in, messages_guild, messages_dm, \
            media_uploads, media_upload_bytes, federation_deliveries, federation_delivery_failures, \
            gateway_connections, accounts_connected, db_bytes, media_objects, media_bytes, \
            media_cache_bytes, cold_bytes, federation_backlog, federation_backlog_oldest_ms, \
            federation_peers, federation_peers_failing, reports_open, pool_connections, pool_idle\
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) \
         ON CONFLICT(bucket_start) DO NOTHING",
    )
    .bind(bucket_start)
    .bind(interval_ms)
    .bind(covered)
    .bind(step(&m.requests, &mut baseline.requests))
    .bind(step(&m.requests_federation, &mut baseline.requests_federation))
    .bind(step(&m.responses_4xx, &mut baseline.responses_4xx))
    .bind(step(&m.responses_5xx, &mut baseline.responses_5xx))
    .bind(step(&m.bytes_in, &mut baseline.bytes_in))
    .bind(step(&m.bytes_out, &mut baseline.bytes_out))
    .bind(step(&m.bytes_out_unmeasured, &mut baseline.bytes_out_unmeasured))
    .bind(serde_json::to_string(&latency.to_vec())?)
    .bind(step(&m.gateway_events_out, &mut baseline.gateway_events_out))
    .bind(step(&m.gateway_frames_in, &mut baseline.gateway_frames_in))
    .bind(step(&m.messages_guild, &mut baseline.messages_guild))
    .bind(step(&m.messages_dm, &mut baseline.messages_dm))
    .bind(step(&m.media_uploads, &mut baseline.media_uploads))
    .bind(step(&m.media_upload_bytes, &mut baseline.media_upload_bytes))
    .bind(step(&m.federation_deliveries, &mut baseline.federation_deliveries))
    .bind(step(&m.federation_delivery_failures, &mut baseline.federation_delivery_failures))
    .bind(gauges.gateway_connections)
    .bind(gauges.accounts_connected)
    .bind(gauges.db_bytes)
    .bind(gauges.media_objects)
    .bind(gauges.media_bytes)
    .bind(gauges.media_cache_bytes)
    .bind(gauges.cold_bytes)
    .bind(gauges.federation_backlog)
    .bind(gauges.federation_backlog_oldest_ms)
    .bind(gauges.federation_peers)
    .bind(gauges.federation_peers_failing)
    .bind(gauges.reports_open)
    .bind(gauges.pool_connections)
    .bind(gauges.pool_idle)
    .execute(&state.pool)
    .await?;

    let cutoff = closed - state.cfg.metrics.retention_days.max(1) * 24 * 60 * 60 * 1000;
    sqlx::query("DELETE FROM metrics_rollup WHERE bucket_start < ?")
        .bind(cutoff)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[derive(Debug, Default)]
pub struct Gauges {
    pub gateway_connections: Option<i64>,
    pub accounts_connected: Option<i64>,
    pub gateway_events_dropped: Option<i64>,
    pub gateway_sessions_shed: Option<i64>,
    pub db_bytes: Option<i64>,
    pub media_objects: Option<i64>,
    pub media_bytes: Option<i64>,
    pub media_cache_bytes: Option<i64>,
    pub cold_bytes: Option<i64>,
    pub federation_backlog: Option<i64>,
    pub federation_backlog_oldest_ms: Option<i64>,
    pub federation_peers: Option<i64>,
    pub federation_peers_failing: Option<i64>,
    pub reports_open: Option<i64>,
    pub pool_connections: Option<i64>,
    pub pool_idle: Option<i64>,
}

pub async fn sample_gauges(state: &AppState, with_storage: bool) -> Gauges {
    let mut g = Gauges::default();

    let (connections, accounts) = state.hub.live_connections().await;
    g.gateway_connections = Some(connections as i64);
    g.accounts_connected = Some(accounts as i64);

    let (dropped, shed) = state.hub.backpressure();
    g.gateway_events_dropped = Some(dropped as i64);
    g.gateway_sessions_shed = Some(shed as i64);

    g.pool_connections = Some(state.pool.size() as i64);
    g.pool_idle = Some(state.pool.num_idle() as i64);

    let backlog: Option<(i64, Option<i64>)> = sqlx::query_as(
        "SELECT COUNT(*), MIN(created_at) FROM (\
            SELECT created_at FROM dm_outbox UNION ALL SELECT created_at FROM friend_outbox)",
    )
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    if let Some((depth, oldest)) = backlog {
        g.federation_backlog = Some(depth);
        g.federation_backlog_oldest_ms = oldest.map(|at| (now_ms() - at).max(0));
    }

    if let Ok(row) = sqlx::query_as::<_, (i64, i64)>(
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN failures > 0 THEN 1 ELSE 0 END), 0) FROM remote_servers",
    )
    .fetch_one(&state.pool)
    .await
    {
        g.federation_peers = Some(row.0);
        g.federation_peers_failing = Some(row.1);
    }

    if let Ok(open) =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM reports WHERE status = 'open'")
            .fetch_one(&state.pool)
            .await
    {
        g.reports_open = Some(open);
    }

    if with_storage {
        g.db_bytes = database_bytes(&state.cfg);
        if state.cfg.roles.media {
            if let Ok((objects, bytes)) = sqlx::query_as::<_, (i64, i64)>(
                "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media",
            )
            .fetch_one(&state.pool)
            .await
            {
                g.media_objects = Some(objects);
                g.media_bytes = Some(bytes);
            }
            if let Ok(cached) = sqlx::query_scalar::<_, i64>(
                "SELECT COALESCE(SUM(size), 0) FROM media_cache",
            )
            .fetch_one(&state.pool)
            .await
            {
                g.media_cache_bytes = Some(cached);
            }
        }
        if state.cfg.archive.enabled {
            if let Ok(cold) =
                sqlx::query_scalar::<_, i64>("SELECT COALESCE(SUM(bytes), 0) FROM cold_segments")
                    .fetch_one(&state.pool)
                    .await
            {
                g.cold_bytes = Some(cold);
            }
        }
    }
    g
}

pub fn database_bytes(cfg: &crate::config::Config) -> Option<i64> {
    let path = crate::backup::db_path(cfg).ok()?;
    let main = std::fs::metadata(&path).ok()?.len();
    let wal = std::fs::metadata(format!("{}-wal", path.display()))
        .map(|m| m.len())
        .unwrap_or(0);
    Some((main + wal) as i64)
}

#[derive(Debug, Serialize)]
pub struct Point {
    pub start: i64,
    pub end: i64,
    pub covered_ms: i64,
    pub requests: i64,
    pub requests_federation: i64,
    pub responses_4xx: i64,
    pub responses_5xx: i64,
    pub bytes_in: i64,
    pub bytes_out: i64,
    pub bytes_out_unmeasured: i64,
    pub p50_ms: Option<f64>,
    pub p90_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub latency_samples: i64,
    pub over_ceiling: i64,
    pub gateway_events_out: i64,
    pub gateway_frames_in: i64,
    pub messages_guild: i64,
    pub messages_dm: i64,
    pub media_uploads: i64,
    pub media_upload_bytes: i64,
    pub federation_deliveries: i64,
    pub federation_delivery_failures: i64,
    pub gateway_connections: Option<i64>,
    pub accounts_connected: Option<i64>,
    pub db_bytes: Option<i64>,
    pub media_objects: Option<i64>,
    pub media_bytes: Option<i64>,
    pub media_cache_bytes: Option<i64>,
    pub cold_bytes: Option<i64>,
    pub federation_backlog: Option<i64>,
    pub federation_backlog_oldest_ms: Option<i64>,
    pub reports_open: Option<i64>,
    pub pool_connections: Option<i64>,
    pub pool_idle: Option<i64>,
}

type Row = (
    i64,            // bucket_start
    i64,            // window_ms
    i64,            // covered_ms
    i64,            // requests
    i64,            // requests_federation
    i64,            // responses_4xx
    i64,            // responses_5xx
    i64,            // bytes_in
    i64,            // bytes_out
    i64,            // bytes_out_unmeasured
    String,         // latency_hist
    i64,            // gateway_events_out
    i64,            // gateway_frames_in
    i64,            // messages_guild
    i64,            // messages_dm
    i64,            // media_uploads
);

type GaugeRow = (
    i64,            // bucket_start
    i64,            // media_upload_bytes
    i64,            // federation_deliveries
    i64,            // federation_delivery_failures
    Option<i64>,    // gateway_connections
    Option<i64>,    // accounts_connected
    Option<i64>,    // db_bytes
    Option<i64>,    // media_objects
    Option<i64>,    // media_bytes
    Option<i64>,    // media_cache_bytes
    Option<i64>,    // cold_bytes
    Option<i64>,    // federation_backlog
    Option<i64>,    // federation_backlog_oldest_ms
    Option<i64>,    // reports_open
    Option<i64>,    // pool_connections
    Option<i64>,    // pool_idle
);

pub async fn series(
    pool: &SqlitePool,
    since: i64,
    until: i64,
    points: usize,
) -> anyhow::Result<Vec<Point>> {
    let counters: Vec<Row> = sqlx::query_as(
        "SELECT bucket_start, window_ms, covered_ms, requests, requests_federation, \
         responses_4xx, responses_5xx, bytes_in, bytes_out, bytes_out_unmeasured, \
         latency_hist, gateway_events_out, gateway_frames_in, messages_guild, messages_dm, \
         media_uploads \
         FROM metrics_rollup WHERE bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start",
    )
    .bind(since)
    .bind(until)
    .fetch_all(pool)
    .await?;
    let gauges: Vec<GaugeRow> = sqlx::query_as(
        "SELECT bucket_start, media_upload_bytes, federation_deliveries, \
         federation_delivery_failures, gateway_connections, accounts_connected, db_bytes, \
         media_objects, media_bytes, media_cache_bytes, cold_bytes, federation_backlog, \
         federation_backlog_oldest_ms, reports_open, pool_connections, pool_idle \
         FROM metrics_rollup WHERE bucket_start >= ? AND bucket_start < ? ORDER BY bucket_start",
    )
    .bind(since)
    .bind(until)
    .fetch_all(pool)
    .await?;
    if counters.is_empty() {
        return Ok(Vec::new());
    }

    let points = points.max(1);
    let span = (until - since).max(1);
    let step_ms = ((span as f64 / points as f64).ceil() as i64)
        .max(counters[0].1)
        .max(1);

    let mut out: Vec<Point> = Vec::new();
    let mut merged_hist = [0u64; LATENCY_BUCKETS];
    let mut current: Option<i64> = None;

    for (i, row) in counters.iter().enumerate() {
        let g = gauges.get(i).filter(|g| g.0 == row.0);
        let slot = since + ((row.0 - since) / step_ms) * step_ms;
        if current != Some(slot) {
            if let Some(last) = out.last_mut() {
                finish(last, &merged_hist);
            }
            merged_hist = [0u64; LATENCY_BUCKETS];
            current = Some(slot);
            out.push(Point {
                start: slot,
                end: slot + step_ms,
                covered_ms: 0,
                requests: 0,
                requests_federation: 0,
                responses_4xx: 0,
                responses_5xx: 0,
                bytes_in: 0,
                bytes_out: 0,
                bytes_out_unmeasured: 0,
                p50_ms: None,
                p90_ms: None,
                p99_ms: None,
                latency_samples: 0,
                over_ceiling: 0,
                gateway_events_out: 0,
                gateway_frames_in: 0,
                messages_guild: 0,
                messages_dm: 0,
                media_uploads: 0,
                media_upload_bytes: 0,
                federation_deliveries: 0,
                federation_delivery_failures: 0,
                gateway_connections: None,
                accounts_connected: None,
                db_bytes: None,
                media_objects: None,
                media_bytes: None,
                media_cache_bytes: None,
                cold_bytes: None,
                federation_backlog: None,
                federation_backlog_oldest_ms: None,
                reports_open: None,
                pool_connections: None,
                pool_idle: None,
            });
        }
        let p = out.last_mut().expect("pushed above");
        p.covered_ms += row.2;
        p.requests += row.3;
        p.requests_federation += row.4;
        p.responses_4xx += row.5;
        p.responses_5xx += row.6;
        p.bytes_in += row.7;
        p.bytes_out += row.8;
        p.bytes_out_unmeasured += row.9;
        if let Ok(counts) = serde_json::from_str::<Vec<u64>>(&row.10) {
            for (b, count) in counts.into_iter().enumerate().take(LATENCY_BUCKETS) {
                merged_hist[b] += count;
            }
        }
        p.gateway_events_out += row.11;
        p.gateway_frames_in += row.12;
        p.messages_guild += row.13;
        p.messages_dm += row.14;
        p.media_uploads += row.15;
        if let Some(g) = g {
            p.media_upload_bytes += g.1;
            p.federation_deliveries += g.2;
            p.federation_delivery_failures += g.3;
            p.gateway_connections = g.4.or(p.gateway_connections);
            p.accounts_connected = g.5.or(p.accounts_connected);
            p.db_bytes = g.6.or(p.db_bytes);
            p.media_objects = g.7.or(p.media_objects);
            p.media_bytes = g.8.or(p.media_bytes);
            p.media_cache_bytes = g.9.or(p.media_cache_bytes);
            p.cold_bytes = g.10.or(p.cold_bytes);
            p.federation_backlog = g.11.or(p.federation_backlog);
            p.federation_backlog_oldest_ms = g.12.or(p.federation_backlog_oldest_ms);
            p.reports_open = g.13.or(p.reports_open);
            p.pool_connections = g.14.or(p.pool_connections);
            p.pool_idle = g.15.or(p.pool_idle);
        }
    }
    if let Some(last) = out.last_mut() {
        finish(last, &merged_hist);
    }
    Ok(out)
}

fn finish(point: &mut Point, hist: &[u64; LATENCY_BUCKETS]) {
    point.latency_samples = hist.iter().sum::<u64>().min(i64::MAX as u64) as i64;
    point.over_ceiling = hist[LATENCY_BUCKETS - 1].min(i64::MAX as u64) as i64;
    point.p50_ms = percentile(hist, 0.50);
    point.p90_ms = percentile(hist, 0.90);
    point.p99_ms = percentile(hist, 0.99);
}

use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::routes::require_admin;
use axum::extract::{Query, State};
use axum::Json;

pub async fn admin_metrics(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    if !state.cfg.metrics.enabled {
        return Ok(Json(json!({ "enabled": false })));
    }
    let m = &state.metrics;
    let counts = m.latency.read();
    let gauges = sample_gauges(&state, true).await;
    let (relay_open, relay_accounts) = state.relay.gauges();
    let uptime = (now_ms() - m.started_at()).max(0);

    Ok(Json(json!({
        "enabled": true,
        "server_name": state.cfg.server_name,
        "uptime_ms": uptime,
        "interval_secs": state.cfg.metrics.interval_secs,
        "retention_days": state.cfg.metrics.retention_days,
        "requests": {
            "total": m.requests.load(Ordering::Relaxed),
            "federation": m.requests_federation.load(Ordering::Relaxed),
            "responses_4xx": m.responses_4xx.load(Ordering::Relaxed),
            "responses_5xx": m.responses_5xx.load(Ordering::Relaxed),
        },
        "latency": {
            "samples": counts.iter().sum::<u64>(),
            "p50_ms": percentile(&counts, 0.50),
            "p90_ms": percentile(&counts, 0.90),
            "p99_ms": percentile(&counts, 0.99),
            "over_ceiling": counts[LATENCY_BUCKETS - 1],
            "ceiling_ms": LATENCY_BOUNDS_US[LATENCY_BOUNDS_US.len() - 1] / 1000,
        },
        "bandwidth": {
            "bytes_in": m.bytes_in.load(Ordering::Relaxed),
            "bytes_out": m.bytes_out.load(Ordering::Relaxed),
            "responses_unmeasured": m.bytes_out_unmeasured.load(Ordering::Relaxed),
        },
        "messages": {
            "guild": m.messages_guild.load(Ordering::Relaxed),
            "dm": m.messages_dm.load(Ordering::Relaxed),
            "media_uploads": m.media_uploads.load(Ordering::Relaxed),
            "media_upload_bytes": m.media_upload_bytes.load(Ordering::Relaxed),
        },
        "scan": {
            "screened": m.media_scans.load(Ordering::Relaxed),
            "matches": m.media_scan_matches.load(Ordering::Relaxed),
            "failures": m.media_scan_failures.load(Ordering::Relaxed),
            "list_entries": state.hash_lists.entries(),
        },
        "gateway": {
            "frames_in": m.gateway_frames_in.load(Ordering::Relaxed),
            "events_out": m.gateway_events_out.load(Ordering::Relaxed),
            "connections": gauges.gateway_connections,
            "accounts": gauges.accounts_connected,
            "events_dropped": gauges.gateway_events_dropped,
            "sessions_shed": gauges.gateway_sessions_shed,
        },
        "relay": {
            "tunnels": m.relay_tunnels.load(Ordering::Relaxed),
            "bytes": m.relay_bytes.load(Ordering::Relaxed),
            "open": relay_open,
            "accounts": relay_accounts,
        },
        "federation": {
            "deliveries": m.federation_deliveries.load(Ordering::Relaxed),
            "failures": m.federation_delivery_failures.load(Ordering::Relaxed),
            "backlog": gauges.federation_backlog,
            "backlog_oldest_ms": gauges.federation_backlog_oldest_ms,
            "peers": gauges.federation_peers,
            "peers_failing": gauges.federation_peers_failing,
        },
        "storage": {
            "db_bytes": gauges.db_bytes,
            "media_objects": gauges.media_objects,
            "media_bytes": gauges.media_bytes,
            "media_cache_bytes": gauges.media_cache_bytes,
            "cold_bytes": gauges.cold_bytes,
        },
        "pool": {
            "connections": gauges.pool_connections,
            "idle": gauges.pool_idle,
            "max": state.pool.options().get_max_connections(),
        },
        "reports_open": gauges.reports_open,
        "routes": m.route_table().await,
    })))
}

#[derive(Deserialize, Default)]
pub struct SeriesQuery {
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub until: Option<i64>,
    #[serde(default)]
    pub points: Option<usize>,
}

pub async fn admin_series(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<SeriesQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    if !state.cfg.metrics.enabled {
        return Ok(Json(json!({ "enabled": false })));
    }
    let until = q.until.unwrap_or_else(now_ms);
    let since = q.since.unwrap_or(until - 6 * 60 * 60 * 1000);
    if since >= until {
        return Err(ApiError::BadRequest("since must be before until".into()));
    }
    let points = q.points.unwrap_or(180).clamp(1, 1000);
    let series = series(&state.pool, since, until, points)
        .await
        .map_err(ApiError::Internal)?;
    let earliest: Option<i64> = sqlx::query_scalar("SELECT MIN(bucket_start) FROM metrics_rollup")
        .fetch_one(&state.pool)
        .await?;
    Ok(Json(json!({
        "enabled": true,
        "since": since,
        "until": until,
        "interval_ms": (state.cfg.metrics.interval_secs.max(1) * 1000) as i64,
        "retention_days": state.cfg.metrics.retention_days,
        "earliest": earliest,
        "points": series,
    })))
}

pub async fn admin_storage(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let gauges = sample_gauges(&state, true).await;

    let by_purpose: Option<Vec<Value>> = if state.cfg.roles.media {
        let rows: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT purpose, COUNT(*), COALESCE(SUM(size), 0) FROM media GROUP BY purpose",
        )
        .fetch_all(&state.pool)
        .await?;
        Some(
            rows.into_iter()
                .map(|(purpose, objects, bytes)| {
                    json!({ "purpose": purpose, "objects": objects, "bytes": bytes })
                })
                .collect(),
        )
    } else {
        None
    };

    let unreferenced: Option<(i64, i64)> = if state.cfg.roles.media {
        sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media WHERE refcount <= 0",
        )
        .fetch_one(&state.pool)
        .await
        .ok()
    } else {
        None
    };

    let cold: Option<Value> = if state.cfg.archive.enabled {
        let (segments, bytes): (i64, i64) =
            sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM cold_segments")
                .fetch_one(&state.pool)
                .await?;
        let messages: i64 =
            sqlx::query_scalar("SELECT COALESCE(SUM(messages), 0) FROM cold_segments")
                .fetch_one(&state.pool)
                .await?;
        Some(json!({
            "enabled": true,
            "segments": segments,
            "bytes": bytes,
            "messages": messages,
            "dir": state.cfg.archive.dir.to_string_lossy(),
            "horizon_days": state.cfg.archive.horizon_days,
            "keep_hot_messages": state.cfg.archive.keep_hot_messages,
        }))
    } else {
        Some(json!({ "enabled": false }))
    };

    let cache_expired: Option<i64> = sqlx::query_scalar(
        "SELECT COUNT(*) FROM media_cache WHERE expires_at <= ?",
    )
    .bind(now_ms())
    .fetch_one(&state.pool)
    .await
    .ok();

    Ok(Json(json!({
        "media_enabled": state.cfg.roles.media,
        "db_bytes": gauges.db_bytes,
        "media_objects": gauges.media_objects,
        "media_bytes": gauges.media_bytes,
        "media_by_purpose": by_purpose,
        "unreferenced_objects": unreferenced.map(|(n, _)| n),
        "unreferenced_bytes": unreferenced.map(|(_, b)| b),
        "media_cache_bytes": gauges.media_cache_bytes,
        "media_cache_expired": cache_expired,
        "media_cache_max_bytes": state.cfg.federation.media_cache_max_bytes,
        "cold": cold,
        "backup": crate::backup::report(&state.cfg),
    })))
}

pub async fn admin_storage_sweep(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let cache = crate::federation::media::sweep_cache(&state).await?;
    let orphans = crate::routes::media::sweep_orphans(&state)
        .await
        .map_err(ApiError::Internal)?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "storage.sweep",
        None,
        json!({ "cache_entries": cache, "orphan_files": orphans }),
    )
    .await;
    Ok(Json(json!({ "cache_entries": cache, "orphan_files": orphans })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_percentile_of_too_few_samples_is_not_a_measurement() {
        let mut counts = [0u64; LATENCY_BUCKETS];
        counts[0] = 4;
        assert!(percentile(&counts, 0.50).is_some());
        assert!(percentile(&counts, 0.99).is_none());
        counts[0] = 100;
        assert!(percentile(&counts, 0.99).is_some());
    }

    #[test]
    fn an_empty_histogram_answers_nothing_rather_than_zero() {
        let counts = [0u64; LATENCY_BUCKETS];
        assert_eq!(percentile(&counts, 0.50), None);
        assert_eq!(percentile(&counts, 0.99), None);
    }

    #[test]
    fn percentiles_land_in_the_bucket_holding_the_ranked_sample() {
        let hist = Histogram::default();
        for _ in 0..99 {
            hist.record(300);
        }
        hist.record(3_000_000);
        let counts = hist.read();
        assert_eq!(percentile(&counts, 0.50), Some(0.5));
        assert_eq!(percentile(&counts, 0.99), Some(0.5));

        let hist = Histogram::default();
        for _ in 0..98 {
            hist.record(300);
        }
        hist.record(3_000_000);
        hist.record(3_000_000);
        assert_eq!(percentile(&hist.read(), 0.99), Some(4000.0));
    }

    #[test]
    fn a_sample_past_the_top_bound_lands_in_the_overflow_bucket() {
        let hist = Histogram::default();
        for _ in 0..100 {
            hist.record(60_000_000);
        }
        let counts = hist.read();
        assert_eq!(counts[LATENCY_BUCKETS - 1], 100);
        assert_eq!(percentile(&counts, 0.50), Some(8000.0));
    }

    #[test]
    fn a_delta_subtracts_a_baseline_rather_than_resetting() {
        let hist = Histogram::default();
        let mut baseline = [0u64; LATENCY_BUCKETS];
        hist.record(200);
        hist.record(200);
        assert_eq!(hist.delta(&mut baseline)[0], 2);
        hist.record(200);
        assert_eq!(hist.delta(&mut baseline)[0], 1);
        assert_eq!(hist.delta(&mut baseline)[0], 0);
        assert_eq!(hist.read()[0], 3);
    }

    #[test]
    fn counter_steps_are_deltas() {
        let counter = AtomicU64::new(0);
        let mut since = 0u64;
        counter.fetch_add(7, Ordering::Relaxed);
        assert_eq!(step(&counter, &mut since), 7);
        counter.fetch_add(3, Ordering::Relaxed);
        assert_eq!(step(&counter, &mut since), 3);
        assert_eq!(step(&counter, &mut since), 0);
    }
}
