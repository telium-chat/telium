use super::{sample_gauges, Gauges, LATENCY_BOUNDS_US, LATENCY_BUCKETS};
use axum::extract::State;
use crate::state::AppState;
use crate::util::now_ms;
use std::sync::atomic::Ordering;

const EXPOSITION_CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";

pub struct ScrapePolicy {
    enabled: bool,
    token: String,
    previous: String,
    allow: Vec<std::net::IpAddr>,
}

impl ScrapePolicy {
    pub fn from_config(cfg: &crate::config::Metrics) -> Self {
        Self {
            enabled: cfg.scrape_enabled,
            token: cfg.scrape_token.trim().to_string(),
            previous: cfg.scrape_token_previous.trim().to_string(),
            allow: cfg.scrape_allow.iter().filter_map(|a| a.trim().parse().ok()).collect(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    fn admits(&self, peer: Option<std::net::IpAddr>, headers: &axum::http::HeaderMap) -> bool {
        if !self.enabled {
            return false;
        }
        if peer.is_some_and(|ip| self.allow.contains(&ip)) {
            return true;
        }
        if self.token.is_empty() {
            return false;
        }
        let presented = headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        let matches_current = constant_time_eq(presented.as_bytes(), self.token.as_bytes());
        let matches_previous = !self.previous.is_empty()
            && constant_time_eq(presented.as_bytes(), self.previous.as_bytes());
        matches_current | matches_previous
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub struct StorageSample {
    pub at_ms: i64,
    pub db_bytes: Option<i64>,
    pub media_objects: Option<i64>,
    pub media_bytes: Option<i64>,
    pub media_cache_bytes: Option<i64>,
    pub cold_bytes: Option<i64>,
}

pub struct BackupHealth {
    pub enabled: bool,
    pub age_ms: Option<i64>,
    pub stale: bool,
    pub offsite: bool,
    pub key_stranded: bool,
    pub remote_age_ms: Option<i64>,
    pub remote_stale: bool,
}

pub struct StandbyHealth {
    pub replicas: i64,
    pub promoted: i64,
    pub worst_lag_ms: Option<i64>,
}

pub struct Scrape {
    pub started_at_ms: i64,
    pub now_ms: i64,
    pub requests: u64,
    pub requests_federation: u64,
    pub responses_4xx: u64,
    pub responses_5xx: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub bytes_out_unmeasured: u64,
    pub latency: [u64; LATENCY_BUCKETS],
    pub latency_sum_us: u64,
    pub gateway_events_out: u64,
    pub gateway_frames_in: u64,
    pub gateway_refused: u64,
    pub gateway_slow_consumer_closed: u64,
    pub messages_guild: u64,
    pub messages_dm: u64,
    pub media_uploads: u64,
    pub media_upload_bytes: u64,
    pub media_scans: u64,
    pub media_scan_matches: u64,
    pub media_scan_failures: u64,
    pub media_scan_list_entries: u64,
    pub federation_deliveries: u64,
    pub federation_delivery_failures: u64,
    pub routes: Vec<(String, u64, u64)>,
    pub rejections: Vec<(&'static str, u64)>,
    pub rejected_total: u64,
    pub ratelimit_buckets: u64,
    pub gauges: Gauges,
    pub pool_max: u32,
    pub storage: Option<StorageSample>,
    pub backup: Option<BackupHealth>,
    pub standby: StandbyHealth,
    pub sfu: Option<(i64, i64)>,
}

pub async fn gather(state: &AppState) -> Scrape {
    let m = &state.metrics;
    let gauges = sample_gauges(state, false).await;

    let storage: Option<StorageSample> = sqlx::query_as::<_, (i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>)>(
        "SELECT bucket_start, db_bytes, media_objects, media_bytes, media_cache_bytes, cold_bytes \
         FROM metrics_rollup \
         WHERE db_bytes IS NOT NULL OR media_bytes IS NOT NULL OR cold_bytes IS NOT NULL \
         ORDER BY bucket_start DESC LIMIT 1",
    )
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
    .map(|(at_ms, db_bytes, media_objects, media_bytes, media_cache_bytes, cold_bytes)| {
        StorageSample { at_ms, db_bytes, media_objects, media_bytes, media_cache_bytes, cold_bytes }
    });

    let backup = {
        let r = crate::backup::report(&state.cfg);
        let remote = r.get("remote");
        Some(BackupHealth {
            enabled: r["enabled"].as_bool().unwrap_or(false),
            age_ms: r["age_ms"].as_i64(),
            stale: r["stale"].as_bool().unwrap_or(false),
            offsite: r["offsite"].as_bool().unwrap_or(false),
            key_stranded: r["key_stranded"].as_bool().unwrap_or(false),
            remote_age_ms: remote.and_then(|v| v["age_ms"].as_i64()),
            remote_stale: remote.and_then(|v| v["stale"].as_bool()).unwrap_or(false),
        })
    };

    let standby = {
        let row: Option<(i64, i64, Option<i64>)> = sqlx::query_as(
            "SELECT COUNT(*), COALESCE(SUM(promoted), 0), MIN(lag_at) FROM replica_state",
        )
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
        match row {
            Some((replicas, promoted, oldest)) => StandbyHealth {
                replicas,
                promoted,
                worst_lag_ms: if replicas > 0 {
                    oldest.map(|at| (now_ms() - at).max(0))
                } else {
                    None
                },
            },
            None => StandbyHealth { replicas: 0, promoted: 0, worst_lag_ms: None },
        }
    };

    let sfu = if state.cfg.voice.enabled {
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT COUNT(*), COALESCE(SUM(healthy), 0) FROM sfu_health",
        )
        .fetch_one(&state.pool)
        .await
        .ok()
    } else {
        None
    };

    let routes = {
        let table = m.routes.read().await;
        let mut rows: Vec<(String, u64, u64)> = table
            .iter()
            .map(|(pattern, stats)| {
                (
                    pattern.clone(),
                    stats.requests.load(Ordering::Relaxed),
                    stats.errors.load(Ordering::Relaxed),
                )
            })
            .collect();
        rows.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        rows
    };

    let (gateway_refused, gateway_slow_consumer_closed) = state.hub.refusal_counts();

    Scrape {
        started_at_ms: m.started_at(),
        now_ms: now_ms(),
        requests: m.requests.load(Ordering::Relaxed),
        requests_federation: m.requests_federation.load(Ordering::Relaxed),
        responses_4xx: m.responses_4xx.load(Ordering::Relaxed),
        responses_5xx: m.responses_5xx.load(Ordering::Relaxed),
        bytes_in: m.bytes_in.load(Ordering::Relaxed),
        bytes_out: m.bytes_out.load(Ordering::Relaxed),
        bytes_out_unmeasured: m.bytes_out_unmeasured.load(Ordering::Relaxed),
        latency: m.latency.read(),
        latency_sum_us: m.latency_sum_us.load(Ordering::Relaxed),
        gateway_events_out: m.gateway_events_out.load(Ordering::Relaxed),
        gateway_frames_in: m.gateway_frames_in.load(Ordering::Relaxed),
        gateway_refused,
        gateway_slow_consumer_closed,
        messages_guild: m.messages_guild.load(Ordering::Relaxed),
        messages_dm: m.messages_dm.load(Ordering::Relaxed),
        media_uploads: m.media_uploads.load(Ordering::Relaxed),
        media_upload_bytes: m.media_upload_bytes.load(Ordering::Relaxed),
        media_scans: m.media_scans.load(Ordering::Relaxed),
        media_scan_matches: m.media_scan_matches.load(Ordering::Relaxed),
        media_scan_failures: m.media_scan_failures.load(Ordering::Relaxed),
        media_scan_list_entries: state.hash_lists.entries() as u64,
        federation_deliveries: m.federation_deliveries.load(Ordering::Relaxed),
        federation_delivery_failures: m.federation_delivery_failures.load(Ordering::Relaxed),
        routes,
        rejections: state.limiter.rejections(),
        rejected_total: state.limiter.rejected_total(),
        ratelimit_buckets: state.limiter.buckets_live() as u64,
        gauges,
        pool_max: state.pool.options().get_max_connections(),
        storage,
        backup,
        standby,
        sfu,
    }
}

fn family(out: &mut String, name: &str, kind: &str, help: &str) {
    use std::fmt::Write as _;
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} {kind}");
}

fn counter(out: &mut String, name: &str, help: &str, value: u64) {
    use std::fmt::Write as _;
    family(out, name, "counter", help);
    let _ = writeln!(out, "{name} {value}");
}

fn gauge(out: &mut String, name: &str, help: &str, value: i64) {
    use std::fmt::Write as _;
    family(out, name, "gauge", help);
    let _ = writeln!(out, "{name} {value}");
}

fn opt_gauge(out: &mut String, name: &str, help: &str, value: Option<i64>) {
    if let Some(v) = value {
        gauge(out, name, help, v);
    } else {
        family(out, name, "gauge", help);
    }
}

fn boolean(out: &mut String, name: &str, help: &str, value: bool) {
    gauge(out, name, help, i64::from(value));
}

fn escape_label(value: &str) -> std::borrow::Cow<'_, str> {
    if !value.contains(['\\', '"', '\n']) {
        return std::borrow::Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(value.len() + 8);
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    std::borrow::Cow::Owned(out)
}

fn histogram(out: &mut String, name: &str, help: &str, counts: &[u64; LATENCY_BUCKETS], sum_us: u64) {
    use std::fmt::Write as _;
    family(out, name, "histogram", help);
    let mut cumulative = 0u64;
    for (i, &bound_us) in LATENCY_BOUNDS_US.iter().enumerate() {
        cumulative += counts[i];
        let le = bound_us as f64 / 1_000_000.0;
        let _ = writeln!(out, "{name}_bucket{{le=\"{le}\"}} {cumulative}");
    }
    cumulative += counts[LATENCY_BUCKETS - 1];
    let _ = writeln!(out, "{name}_bucket{{le=\"+Inf\"}} {cumulative}");
    let _ = writeln!(out, "{name}_sum {}", sum_us as f64 / 1_000_000.0);
    let _ = writeln!(out, "{name}_count {cumulative}");
}

pub fn render(s: &Scrape) -> String {
    let mut out = String::with_capacity(8 * 1024);

    counter(
        &mut out,
        "telium_http_requests_total",
        "HTTP requests handled since this process started, including those refused by the rate limiter.",
        s.requests,
    );
    counter(
        &mut out,
        "telium_http_requests_federation_total",
        "HTTP requests carrying this server's federation authorization scheme, i.e. server-to-server traffic.",
        s.requests_federation,
    );
    family(
        &mut out,
        "telium_http_responses_total",
        "counter",
        "Responses by status class. Only the classes an operator alerts on are counted.",
    );
    let _ = {
        use std::fmt::Write as _;
        writeln!(&mut out, "telium_http_responses_total{{class=\"4xx\"}} {}", s.responses_4xx)
            .and_then(|_| {
                writeln!(&mut out, "telium_http_responses_total{{class=\"5xx\"}} {}", s.responses_5xx)
            })
    };
    counter(
        &mut out,
        "telium_http_request_bytes_total",
        "Request body bytes, from declared Content-Length. Requests that declared none contribute nothing.",
        s.bytes_in,
    );
    counter(
        &mut out,
        "telium_http_response_bytes_total",
        "Response body bytes, from declared Content-Length. A floor, not a total: see telium_http_responses_unmeasured_total.",
        s.bytes_out,
    );
    counter(
        &mut out,
        "telium_http_responses_unmeasured_total",
        "Responses that declared no length -- streams and proxied media -- and so are missing from telium_http_response_bytes_total. This is how far down that floor is.",
        s.bytes_out_unmeasured,
    );
    histogram(
        &mut out,
        "telium_http_request_duration_seconds",
        "Request latency. Bucket bounds are fixed in LATENCY_BOUNDS_US and run from 250us to 8s; anything slower lands only in +Inf.",
        &s.latency,
        s.latency_sum_us,
    );

    family(
        &mut out,
        "telium_http_route_requests_total",
        "counter",
        "Requests per matched route pattern. The pattern, never the path: one series per route however many objects exist.",
    );
    for (pattern, requests, _) in &s.routes {
        use std::fmt::Write as _;
        let _ = writeln!(
            &mut out,
            "telium_http_route_requests_total{{route=\"{}\"}} {requests}",
            escape_label(pattern)
        );
    }
    family(
        &mut out,
        "telium_http_route_errors_total",
        "counter",
        "Responses of 400 or worse per matched route pattern.",
    );
    for (pattern, _, errors) in &s.routes {
        use std::fmt::Write as _;
        let _ = writeln!(
            &mut out,
            "telium_http_route_errors_total{{route=\"{}\"}} {errors}",
            escape_label(pattern)
        );
    }

    counter(
        &mut out,
        "telium_ratelimit_rejections_total",
        "Requests refused by the rate limiter since boot, whatever the bucket.",
        s.rejected_total,
    );
    family(
        &mut out,
        "telium_ratelimit_rejections_by_kind_total",
        "counter",
        "Rate-limit refusals by bucket kind. Kinds are &'static str literals from ratelimit.rs and are bounded by the source, never by caller input.",
    );
    for (kind, count) in &s.rejections {
        use std::fmt::Write as _;
        let _ = writeln!(
            &mut out,
            "telium_ratelimit_rejections_by_kind_total{{kind=\"{}\"}} {count}",
            escape_label(kind)
        );
    }
    gauge(
        &mut out,
        "telium_ratelimit_buckets",
        "Token buckets the limiter is tracking right now. Its own footprint, and the only way to see its eviction sweep evicting live callers.",
        s.ratelimit_buckets as i64,
    );

    counter(
        &mut out,
        "telium_gateway_frames_received_total",
        "Client frames read off gateway sockets. Counted before parsing, so malformed frames count.",
        s.gateway_frames_in,
    );
    counter(
        &mut out,
        "telium_gateway_events_sent_total",
        "Events dispatched to gateway sockets.",
        s.gateway_events_out,
    );
    counter(
        &mut out,
        "telium_gateway_refused_total",
        "Gateway sockets turned away by a ceiling: too many connections for one account, or too many sockets that had not yet identified. Steady growth here is either an abusive client or a cap set below what a real client does -- the two look identical from here, which is why the next thing to read is whether anybody is complaining.",
        s.gateway_refused,
    );
    counter(
        &mut out,
        "telium_gateway_slow_consumer_closed_total",
        "Gateway sockets closed for falling too far behind their own outbound queue. This server disconnects a slow consumer rather than silently dropping its events, so this is the count of clients that were told to reconnect instead of being quietly lied to.",
        s.gateway_slow_consumer_closed,
    );
    opt_gauge(
        &mut out,
        "telium_gateway_connections",
        "Gateway sockets open right now.",
        s.gauges.gateway_connections,
    );
    opt_gauge(
        &mut out,
        "telium_gateway_accounts_connected",
        "Distinct accounts with at least one gateway socket open. Lower than the connection count by however many devices people use.",
        s.gauges.accounts_connected,
    );

    family(
        &mut out,
        "telium_messages_total",
        "counter",
        "Messages accepted, by transport. A count of frames and nothing else: no conversation, channel or account is a dimension here.",
    );
    let _ = {
        use std::fmt::Write as _;
        writeln!(&mut out, "telium_messages_total{{kind=\"guild\"}} {}", s.messages_guild).and_then(
            |_| writeln!(&mut out, "telium_messages_total{{kind=\"dm\"}} {}", s.messages_dm),
        )
    };
    counter(
        &mut out,
        "telium_media_uploads_total",
        "Objects accepted by the media origin.",
        s.media_uploads,
    );
    counter(
        &mut out,
        "telium_media_upload_bytes_total",
        "Bytes accepted by the media origin.",
        s.media_upload_bytes,
    );
    counter(
        &mut out,
        "telium_media_scans_total",
        "Objects put through the upload hash-list scanner. The denominator for the two lines below; on its own it is only a measure of upload volume.",
        s.media_scans,
    );
    counter(
        &mut out,
        "telium_media_scan_matches_total",
        "Uploads refused because they matched a hash list. Each one also files a report into the takedown queue, so this should track the queue's growth from that source.",
        s.media_scan_matches,
    );
    counter(
        &mut out,
        "telium_media_scan_failures_total",
        "Scanner matches whose report could not be filed. The upload was still refused, but the finding never reached the operator's queue -- so this is the count of hash-list hits nobody will ever see. Any non-zero rate needs looking at.",
        s.media_scan_failures,
    );
    gauge(
        &mut out,
        "telium_media_scan_list_entries",
        "Digests across every configured upload hash list. Zero means the scanner runs on every upload and can never match anything, which looks identical to a clean server from every other series here.",
        s.media_scan_list_entries as i64,
    );

    counter(
        &mut out,
        "telium_federation_deliveries_total",
        "Outbound federation deliveries attempted.",
        s.federation_deliveries,
    );
    counter(
        &mut out,
        "telium_federation_delivery_failures_total",
        "Outbound federation deliveries that failed. The ratio against the line above is the number to alert on; neither alone means much.",
        s.federation_delivery_failures,
    );
    opt_gauge(
        &mut out,
        "telium_federation_backlog",
        "Items waiting in both outboxes. Depth alone does not say whether the queue is moving -- pair it with the age below.",
        s.gauges.federation_backlog,
    );
    opt_gauge(
        &mut out,
        "telium_federation_backlog_oldest_seconds",
        "Age of the oldest item in the outboxes. A queue that is deep and young is busy; one that is shallow and old is stuck, and only this tells them apart.",
        s.gauges.federation_backlog_oldest_ms.map(|ms| ms / 1000),
    );
    opt_gauge(
        &mut out,
        "telium_federation_peers",
        "Peer servers this server has a record of.",
        s.gauges.federation_peers,
    );
    opt_gauge(
        &mut out,
        "telium_federation_peers_failing",
        "Peers with a non-zero failure count. Which peers is deliberately not a label -- see the note on labels in render().",
        s.gauges.federation_peers_failing,
    );

    opt_gauge(
        &mut out,
        "telium_database_pool_connections",
        "Connections the pool currently holds.",
        s.gauges.pool_connections,
    );
    opt_gauge(
        &mut out,
        "telium_database_pool_idle",
        "Pooled connections not currently checked out. Saturation is this reaching zero while the max below stays put.",
        s.gauges.pool_idle,
    );
    gauge(
        &mut out,
        "telium_database_pool_max",
        "The pool's configured ceiling. Emitted so an alert can be written as a ratio rather than against a number somebody has to remember.",
        s.pool_max as i64,
    );

    let storage = s.storage.as_ref();
    opt_gauge(
        &mut out,
        "telium_database_bytes",
        "Size of the database file plus its write-ahead log, as of the last storage sample.",
        storage.and_then(|x| x.db_bytes),
    );
    opt_gauge(
        &mut out,
        "telium_media_objects",
        "Objects in the media table, as of the last storage sample. Absent on a server with no media role.",
        storage.and_then(|x| x.media_objects),
    );
    opt_gauge(
        &mut out,
        "telium_media_bytes",
        "Bytes in the media table, as of the last storage sample. Absent on a server with no media role.",
        storage.and_then(|x| x.media_bytes),
    );
    opt_gauge(
        &mut out,
        "telium_media_cache_bytes",
        "Bytes of cached remote media, as of the last storage sample. Bounded by federation.media_cache_max_bytes and swept, so growth past that bound is the signal.",
        storage.and_then(|x| x.media_cache_bytes),
    );
    opt_gauge(
        &mut out,
        "telium_cold_storage_bytes",
        "Bytes in cold archive segments, as of the last storage sample. Absent when archiving is off.",
        storage.and_then(|x| x.cold_bytes),
    );
    opt_gauge(
        &mut out,
        "telium_storage_sample_age_seconds",
        "How old the storage gauges above are. They are sampled on metrics.storage_interval_secs, not per scrape; Prometheus stamps them with the scrape time and this is the only thing that says otherwise.",
        storage.map(|x| ((s.now_ms - x.at_ms).max(0)) / 1000),
    );

    opt_gauge(
        &mut out,
        "telium_moderation_reports_open",
        "Reports awaiting a decision. A queue, not a list: no report, reporter or subject is a dimension.",
        s.gauges.reports_open,
    );

    if let Some(b) = &s.backup {
        boolean(&mut out, "telium_backup_enabled", "Whether backups are configured to run at all.", b.enabled);
        opt_gauge(
            &mut out,
            "telium_backup_age_seconds",
            "Age of the newest local archive. Absent when no archive has ever been written, which is a different and worse condition than an old one.",
            b.age_ms.map(|ms| ms / 1000),
        );
        boolean(
            &mut out,
            "telium_backup_stale",
            "The server's own verdict on whether a restorable copy is recent enough, local or remote, against backup.stale_after_secs.",
            b.stale,
        );
        boolean(
            &mut out,
            "telium_backup_offsite",
            "Whether archives are also written somewhere that is not this machine. A backup inside the volume it is a copy of survives exactly one failure mode.",
            b.offsite,
        );
        boolean(
            &mut out,
            "telium_backup_key_stranded",
            "Whether the backup key is stored where losing the data store loses it too, leaving archives nobody can decrypt.",
            b.key_stranded,
        );
        opt_gauge(
            &mut out,
            "telium_backup_remote_age_seconds",
            "Age of the newest archive in the remote store. Absent when no remote is configured.",
            b.remote_age_ms.map(|ms| ms / 1000),
        );
        boolean(&mut out, "telium_backup_remote_stale", "Whether the offsite copy is behind backup.stale_after_secs.", b.remote_stale);
    }

    gauge(
        &mut out,
        "telium_standby_replicas",
        "Origins this process mirrors. Zero is a real measurement -- it means warm standby is not configured -- and is reported rather than omitted.",
        s.standby.replicas,
    );
    gauge(
        &mut out,
        "telium_standby_promoted",
        "Mirrors this process has been promoted to serve as the authority for.",
        s.standby.promoted,
    );
    opt_gauge(
        &mut out,
        "telium_standby_lag_seconds",
        "Wall-clock age of the newest change applied, taken across every mirror and reported for the worst. Absent when nothing is mirrored.",
        s.standby.worst_lag_ms.map(|ms| ms / 1000),
    );

    match s.sfu {
        Some((regions, healthy)) => {
            gauge(&mut out, "telium_sfu_regions", "SFU regions configured with an address.", regions);
            gauge(
                &mut out,
                "telium_sfu_regions_healthy",
                "SFU regions whose last health probe succeeded. Calls fall back to mesh when this reaches zero, which works for small calls and not for large ones.",
                healthy,
            );
        }
        None => {
            family(&mut out, "telium_sfu_regions", "gauge", "SFU regions configured with an address. Absent when voice is disabled.");
            family(&mut out, "telium_sfu_regions_healthy", "gauge", "SFU regions whose last health probe succeeded. Absent when voice is disabled.");
        }
    }

    gauge(
        &mut out,
        "telium_process_start_time_seconds",
        "Unix time this process started. A change in it is a restart, which is the cheapest crash-loop alert there is.",
        s.started_at_ms / 1000,
    );
    gauge(
        &mut out,
        "telium_uptime_seconds",
        "How long this process has been up. Every counter above is 'since this moment'; a counter without it is a number with no unit.",
        (s.now_ms - s.started_at_ms).max(0) / 1000,
    );

    out
}

pub async fn prometheus(
    State(state): State<AppState>,
    req: axum::extract::Request,
) -> axum::response::Response {
    use axum::response::IntoResponse as _;
    let peer = req
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|axum::extract::ConnectInfo(addr)| addr.ip());
    let headers = req.headers();
    let policy = ScrapePolicy::from_config(&state.cfg.metrics);
    if !policy.enabled() {
        return (axum::http::StatusCode::NOT_FOUND, "not found\n").into_response();
    }
    if !policy.admits(peer, headers) {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            [(axum::http::header::WWW_AUTHENTICATE, "Bearer realm=\"telium-metrics\"")],
            "metrics scrape refused\n",
        )
            .into_response();
    }
    if !state.cfg.metrics.enabled {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "metrics are disabled on this server (metrics.enabled = false); \
             nothing is being measured, so there is nothing to report\n",
        )
            .into_response();
    }
    let body = render(&gather(&state).await);
    (
        axum::http::StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, EXPOSITION_CONTENT_TYPE)],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_scrape() -> Scrape {
        Scrape {
            started_at_ms: 1_000_000,
            now_ms: 1_060_000,
            requests: 0,
            requests_federation: 0,
            responses_4xx: 0,
            responses_5xx: 0,
            bytes_in: 0,
            bytes_out: 0,
            bytes_out_unmeasured: 0,
            latency: [0; LATENCY_BUCKETS],
            latency_sum_us: 0,
            gateway_events_out: 0,
            gateway_frames_in: 0,
            gateway_refused: 0,
            gateway_slow_consumer_closed: 0,
            messages_guild: 0,
            messages_dm: 0,
            media_uploads: 0,
            media_upload_bytes: 0,
            media_scans: 0,
            media_scan_matches: 0,
            media_scan_failures: 0,
            media_scan_list_entries: 0,
            federation_deliveries: 0,
            federation_delivery_failures: 0,
            routes: Vec::new(),
            rejections: Vec::new(),
            rejected_total: 0,
            ratelimit_buckets: 0,
            gauges: Gauges::default(),
            pool_max: 5,
            storage: None,
            backup: None,
            standby: StandbyHealth { replicas: 0, promoted: 0, worst_lag_ms: None },
            sfu: None,
        }
    }

    fn has_sample(text: &str, family: &str) -> bool {
        text.lines()
            .filter(|l| !l.starts_with('#'))
            .any(|l| l.split(['{', ' ']).next() == Some(family))
    }

    #[test]
    fn unsampled_gauges_are_declared_but_omitted_while_real_zeros_are_written() {
        let text = render(&empty_scrape());
        assert!(text.contains("# TYPE telium_gateway_connections gauge"));
        for absent in ["telium_gateway_connections", "telium_storage_sample_age_seconds", "telium_sfu_regions_healthy", "telium_standby_lag_seconds"] {
            assert!(!has_sample(&text, absent), "{absent} written without a sample:\n{text}");
        }
        assert!(text.contains("telium_standby_replicas 0"));
        let mut s = empty_scrape();
        s.gauges.gateway_connections = Some(0);
        s.sfu = Some((3, 0));
        let text = render(&s);
        assert!(text.contains("telium_gateway_connections 0"));
        assert!(text.contains("telium_sfu_regions 3") && text.contains("telium_sfu_regions_healthy 0"));
    }

    #[test]
    fn a_full_scrape_is_well_formed_and_carries_no_per_subject_labels() {
        let mut s = empty_scrape();
        s.gauges.gateway_connections = Some(3);
        s.storage = Some(StorageSample {
            at_ms: 1_000_000,
            db_bytes: Some(4096),
            media_objects: Some(1),
            media_bytes: Some(2),
            media_cache_bytes: Some(3),
            cold_bytes: Some(4),
        });
        s.backup = Some(BackupHealth {
            enabled: true,
            age_ms: Some(60_000),
            stale: false,
            offsite: true,
            key_stranded: false,
            remote_age_ms: Some(120_000),
            remote_stale: false,
        });
        s.sfu = Some((2, 1));
        s.routes = vec![("/_telium/v1/channels/{channel_id}/messages".into(), 5, 1)];
        s.rejections = vec![("login", 4), ("register", 1)];
        s.rejected_total = 5;
        s.gauges.federation_peers = Some(9);
        let text = render(&s);

        let mut typed = std::collections::HashMap::new();
        let mut helped = std::collections::HashSet::new();
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("# HELP ") {
                helped.insert(rest.split(' ').next().unwrap().to_string());
            }
            if let Some((name, kind)) = line.strip_prefix("# TYPE ").and_then(|r| r.split_once(' ')) {
                assert!(name.starts_with("telium_"), "unprefixed family: {name}");
                assert!(kind != "counter" || name.ends_with("_total"), "counter without _total: {name}");
                if name.contains("_age") || name.contains("uptime") || name.contains("lag") {
                    assert!(name.ends_with("_seconds"), "a duration without a unit: {name}");
                }
                typed.insert(name.to_string(), kind.to_string());
            }
        }
        let mut labels = std::collections::BTreeSet::new();
        for line in text.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()) {
            let name = line.split(['{', ' ']).next().unwrap();
            let family = ["_bucket", "_sum", "_count"]
                .iter()
                .find_map(|x| name.strip_suffix(x).filter(|f| typed.contains_key(*f)))
                .unwrap_or(name);
            assert!(helped.contains(family) && typed.contains_key(family), "undeclared family: {line}");
            if let Some((_, rest)) = line.split_once('{') {
                labels.extend(rest.split(',').filter_map(|p| p.split_once('=')).map(|(k, _)| k.trim().to_string()));
            }
        }
        assert_eq!(labels.into_iter().collect::<Vec<_>>(), ["class", "kind", "le", "route"]);
        for want in [
            "telium_http_route_requests_total{route=\"/_telium/v1/channels/{channel_id}/messages\"} 5",
            "telium_ratelimit_rejections_by_kind_total{kind=\"login\"} 4",
            "telium_database_bytes 4096",
            "telium_storage_sample_age_seconds 60",
        ] {
            assert!(text.contains(want), "missing {want}:\n{text}");
        }
    }

    #[test]
    fn histogram_buckets_are_cumulative_in_seconds_with_a_measured_sum() {
        let mut s = empty_scrape();
        s.latency[0] = 1;
        s.latency[LATENCY_BOUNDS_US.len() - 1] = 1;
        s.latency[LATENCY_BUCKETS - 1] = 1;
        s.latency_sum_us = 30_000_000;
        let text = render(&s);
        let seen: Vec<u64> = text
            .lines()
            .filter_map(|l| l.strip_prefix("telium_http_request_duration_seconds_bucket"))
            .map(|r| r.rsplit(' ').next().unwrap().parse().unwrap())
            .collect();
        assert_eq!(seen.len(), LATENCY_BOUNDS_US.len() + 1);
        assert!(seen.windows(2).all(|w| w[0] <= w[1]), "not monotonic: {seen:?}");
        assert_eq!((seen[0], *seen.last().unwrap()), (1, 3));
        assert!(text.contains("telium_http_request_duration_seconds_bucket{le=\"+Inf\"} 3"));
        assert!(text.contains("telium_http_request_duration_seconds_sum 30\n"), "sum must be measured:\n{text}");
        assert!(text.contains("le=\"0.00025\"") && text.contains("le=\"8\"") && !text.contains("le=\"250\""));
    }

    #[test]
    fn label_values_are_escaped() {
        for (raw, want) in [("plain", "plain"), ("a\"b", "a\\\"b"), ("a\\b", "a\\\\b"), ("a\nb", "a\\nb")] {
            assert_eq!(escape_label(raw), want);
        }
    }

    #[test]
    fn a_constant_time_comparison_accepts_only_an_exact_match() {
        assert!(constant_time_eq(b"", b"") && constant_time_eq(b"hunter2", b"hunter2"));
        for other in [&b"hunter3"[..], b"aunter2", b"hunter", b"hunter22"] {
            assert!(!constant_time_eq(other, b"hunter2"));
        }
    }

    #[test]
    fn the_scrape_policy_admits_only_by_real_peer_address_or_exact_bearer() {
        use std::net::{IpAddr, Ipv4Addr};
        let local: IpAddr = Ipv4Addr::LOCALHOST.into();
        let far: IpAddr = Ipv4Addr::new(203, 0, 113, 9).into();
        let hdr = |pairs: &[(&str, &str)]| {
            let mut h = axum::http::HeaderMap::new();
            for (k, v) in pairs {
                h.insert(axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
            }
            h
        };
        let auth = |v: &str| hdr(&[("authorization", v)]);
        let policy = |enabled: bool, token: &str, previous: &str, allow: Vec<IpAddr>| ScrapePolicy {
            enabled,
            token: token.into(),
            previous: previous.into(),
            allow,
        };
        let allow = policy(true, "", "", vec![local]);
        let tok = policy(true, "placeholder-new", "placeholder-old", Vec::new());
        let cases: &[(&str, &ScrapePolicy, Option<IpAddr>, axum::http::HeaderMap, bool)] = &[
            ("off admits nobody", &policy(false, "placeholder-new", "", vec![local]), Some(local), auth("Bearer placeholder-new"), false),
            ("allow-listed, no token", &allow, Some(local), hdr(&[]), true),
            ("not allow-listed", &allow, Some(Ipv4Addr::new(10, 0, 0, 7).into()), hdr(&[]), false),
            ("missing peer fails closed", &allow, None, hdr(&[]), false),
            ("forwarded-for is ignored", &allow, Some(far), hdr(&[("x-forwarded-for", "127.0.0.1"), ("x-real-ip", "127.0.0.1")]), false),
            ("empty token never matches nothing", &allow, Some(far), auth("Bearer "), false),
            ("current token", &tok, Some(far), auth("Bearer placeholder-new"), true),
            ("previous token during rotation", &tok, Some(far), auth("Bearer placeholder-old"), true),
            ("wrong token", &tok, Some(far), auth("Bearer placeholder-third"), false),
            ("bare token without scheme", &tok, Some(far), auth("placeholder-new"), false),
            ("no credential", &tok, Some(far), hdr(&[]), false),
            ("closed window drops old", &policy(true, "placeholder-new", "", Vec::new()), Some(far), auth("Bearer placeholder-old"), false),
            ("unset previous is not empty bearer", &policy(true, "placeholder-new", "", Vec::new()), Some(far), auth("Bearer "), false),
        ];
        for (name, p, peer, h, want) in cases {
            assert_eq!(p.admits(*peer, h), *want, "{name}");
        }
    }
}
