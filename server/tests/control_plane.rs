
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
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
    let dir = std::env::temp_dir().join(format!("telium-control-plane-{}-{n}", std::process::id()));
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

    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    let server =
        Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state };
    server.user("founder").await;
    server
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

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn patch(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.patch(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn user(&self, localpart: &str) -> String {
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

    async fn guild_session(&self, home_token: &str) -> String {
        let (status, session) =
            self.post("/_telium/v1/sessions/local", Some(home_token), json!({})).await;
        assert_eq!(status, 200, "guild session: {session}");
        session["session_token"].as_str().unwrap().to_string()
    }

    async fn admin(&self, localpart: &str) -> String {
        let token = self.user(localpart).await;
        sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = ?")
            .bind(format!("@{localpart}:test.example"))
            .execute(&self.state.pool)
            .await
            .unwrap();
        token
    }

    async fn delete(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.delete(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
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
        assert_eq!(body["elevated"], true, "{body}");
    }

    async fn seed_guild(&self, guild_id: &str, name: &str, owner: &str) {
        sqlx::query(
            "INSERT INTO guilds (id, name, owner_user_id, settings, created_at) \
             VALUES (?, ?, ?, '{}', 1000)",
        )
        .bind(guild_id)
        .bind(name)
        .bind(owner)
        .execute(&self.state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO members (guild_id, user_id, joined_at, display_name) \
             VALUES (?, ?, 1000, 'owner')",
        )
        .bind(guild_id)
        .bind(owner)
        .execute(&self.state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO roles (id, guild_id, name, permissions, position) \
             VALUES (?, ?, 'everything', ?, 1)",
        )
        .bind(format!("{guild_id}-all"))
        .bind(guild_id)
        .bind(i64::MAX)
        .execute(&self.state.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)")
            .bind(guild_id)
            .bind(owner)
            .bind(format!("{guild_id}-all"))
            .execute(&self.state.pool)
            .await
            .unwrap();
    }

    async fn audit(&self) -> Vec<(String, String, Option<String>, String)> {
        sqlx::query_as(
            "SELECT actor, action, target, data FROM server_audit_log ORDER BY id DESC",
        )
        .fetch_all(&self.state.pool)
        .await
        .unwrap()
    }

    async fn seed_report(&self, id: &str, status: &str, created_at: i64, handled_at: Option<i64>) {
        sqlx::query(
            "INSERT INTO reports (id, direction, origin, destination, reporter, target_type, \
             target_id, category, detail, evidence, status, created_at, handled_at) \
             VALUES (?, 'inbound', 'peer.example', 'test.example', '@r:peer.example', 'message', \
             'm1', 'spam', NULL, '[]', ?, ?, ?)",
        )
        .bind(id)
        .bind(status)
        .bind(created_at)
        .bind(handled_at)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }
}

fn histogram(bucket: usize, count: u64) -> String {
    let mut buckets = vec![0u64; telium_server::metrics::LATENCY_BUCKETS];
    buckets[bucket] = count;
    serde_json::to_string(&buckets).unwrap()
}

const CONTROL_PLANE: &[(&str, &str, &str)] = &[
    ("GET", "/_telium/v1/admin/metrics", "{}"),
    ("GET", "/_telium/v1/admin/metrics/series", "{}"),
    ("GET", "/_telium/v1/admin/storage", "{}"),
    ("POST", "/_telium/v1/admin/storage/sweep", "{}"),
    ("GET", "/_telium/v1/admin/moderation/summary", "{}"),
    ("GET", "/_telium/v1/admin/peers", "{}"),
    ("GET", "/_telium/v1/admin/reports", "{}"),
    ("GET", "/_telium/v1/admin/status", "{}"),
    ("GET", "/_telium/v1/admin/version", "{}"),
    ("GET", "/_telium/v1/admin/health", "{}"),
    ("GET", "/_telium/v1/admin/continuity", "{}"),
    ("GET", "/_telium/v1/admin/audit", "{}"),
    ("GET", "/_telium/v1/admin/accounts", "{}"),
    ("GET", "/_telium/v1/admin/guilds", "{}"),
    ("GET", "/_telium/v1/admin/step-up", "{}"),
    ("GET", "/_telium/v1/admin/hosting-catalogs", "{}"),
    ("POST", "/_telium/v1/admin/hosting-catalogs/refresh", "{}"),
    ("PATCH", "/_telium/v1/admin/reports/whatever", r#"{"status":"actioned"}"#),
];

const ELEVATED_ROUTES: &[(&str, &str, &str)] = &[
    ("POST", "/_telium/v1/admin/defederation", r#"{"domain":"peer.example"}"#),
    ("DELETE", "/_telium/v1/admin/defederation/peer.example", "{}"),
    ("POST", "/_telium/v1/admin/blocklist-feeds", r#"{"url":"https://feed.example/list"}"#),
    ("DELETE", "/_telium/v1/admin/blocklist-feeds", r#"{"url":"https://feed.example/list"}"#),
    ("POST", "/_telium/v1/admin/media/curator-key/rotate", "{}"),
    ("POST", "/_telium/v1/admin/accounts/@nobody:test.example/suspend", r#"{"reason":"x"}"#),
    ("POST", "/_telium/v1/admin/accounts/@nobody:test.example/reinstate", "{}"),
    ("POST", "/_telium/v1/admin/guilds/nosuchguild/purge", "{}"),
    ("POST", "/_telium/v1/admin/sunset", r#"{"mode":"shutdown"}"#),
    ("POST", "/_telium/v1/admin/sunset/execute", "{}"),
    ("POST", "/_telium/v1/admin/sunset/finalize", r#"{"confirm":"test.example"}"#),
    (
        "POST",
        "/_telium/v1/admin/failover",
        r#"{"subject_type":"server","subject_id":"test.example","standby":"standby.example"}"#,
    ),
    ("POST", "/_telium/v1/admin/failover/server/test.example/promote", "{}"),
    ("POST", "/_telium/v1/admin/standby/peer.example/promote", "{}"),
];

const DETAIL_ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/_telium/v1/admin/accounts/@nobody:test.example", "{}"),
    ("GET", "/_telium/v1/admin/guilds/nosuchguild", "{}"),
];

fn every_admin_route() -> impl Iterator<Item = &'static (&'static str, &'static str, &'static str)>
{
    CONTROL_PLANE.iter().chain(ELEVATED_ROUTES).chain(DETAIL_ROUTES)
}

async fn call(s: &Server, row: &(&str, &str, &str), token: Option<&str>) -> (u16, Value) {
    let (method, path, body) = *row;
    let body: Value = serde_json::from_str(body).unwrap();
    match method {
        "GET" => s.get(path, token).await,
        "POST" => s.post(path, token, body).await,
        "DELETE" => s.delete(path, token, body).await,
        _ => s.patch(path, token, body).await,
    }
}

#[tokio::test]
async fn an_ordinary_account_gets_nothing_from_any_control_plane_route() {
    let s = start().await;
    let mallory = s.user("mallory").await;
    let guildlord = s.user("guildlord").await;
    s.seed_guild("01GUILD0000000000000000001", "the whole of it", "@guildlord:test.example").await;

    for token in [&mallory, &guildlord] {
        for row in every_admin_route() {
            let (method, path, _) = *row;
            let (status, body) = call(&s, row, Some(token)).await;
            assert_eq!(status, 403, "{method} {path} answered a non-admin: {body}");
            assert_eq!(body["error"], "forbidden", "{method} {path}: {body}");
            for leak in
                ["requests", "latency", "storage", "peers", "reports", "counts", "points", "catalogs", "published"]
            {
                assert!(body.get(leak).is_none(), "{method} {path} leaked {leak}: {body}");
            }
        }
    }
}

#[tokio::test]
async fn no_session_or_a_forged_token_gets_nothing_from_any_control_plane_route() {
    let s = start().await;
    for token in [None, Some("not-a-real-token")] {
        for row in every_admin_route() {
            let (method, path, _) = *row;
            let (status, body) = call(&s, row, token).await;
            assert_eq!(status, 401, "{method} {path} answered {token:?}: {body}");
        }
    }
}

#[tokio::test]
async fn revoking_the_admin_column_closes_the_control_plane_again() {
    let s = start().await;
    let token = s.admin("root").await;
    let (status, _) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    assert_eq!(status, 200);

    sqlx::query("UPDATE accounts SET admin = 0 WHERE user_id = '@root:test.example'")
        .execute(&s.state.pool)
        .await
        .unwrap();
    let (status, _) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn a_server_administrator_is_not_an_administrator_of_somebody_elses_guild() {
    let s = start().await;
    let owner = s.guild_session(&s.user("wren").await).await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&owner), json!({ "name": "Not Yours" })).await;
    let guild_id = guild["id"].as_str().expect("guild id").to_string();
    let operator = s.guild_session(&s.admin("root").await).await;
    let base = format!("/_telium/v1/guilds/{guild_id}");
    let attempts = [
        ("GET", base.clone(), "{}"),
        ("PATCH", base.clone(), r#"{"name":"Mine Now"}"#),
        ("POST", format!("{base}/channels"), r#"{"name":"operator-only","type":"text"}"#),
        ("GET", format!("{base}/members"), "{}"),
    ];
    for (method, path, body) in &attempts {
        let (status, body) = call(&s, &(*method, path.as_str(), *body), Some(&operator)).await;
        assert!(status == 403 || status == 404, "{method} {path} as a non-member operator: {status} {body}");
    }
    let (_, body) = s.get(&base, Some(&owner)).await;
    assert_eq!(body["name"], "Not Yours");
}

#[tokio::test]
async fn an_administrator_gets_every_control_plane_route() {
    let s = start().await;
    let token = s.admin("root").await;
    for row in CONTROL_PLANE {
        let (method, path, _) = *row;
        if method == "PATCH" {
            let (status, body) = call(&s, row, Some(&token)).await;
            assert_eq!(status, 404, "{path}: {body}");
            continue;
        }
        let (status, body) = call(&s, row, Some(&token)).await;
        assert_eq!(status, 200, "{method} {path}: {body}");
    }
    for row in DETAIL_ROUTES {
        let (method, path, _) = *row;
        let (status, body) = call(&s, row, Some(&token)).await;
        assert_eq!(status, 404, "{method} {path}: {body}");
    }
}

#[tokio::test]
async fn an_unmeasured_latency_is_null_rather_than_zero() {
    let s = start().await;
    let token = s.admin("root").await;
    for _ in 0..12 {
        s.get("/_telium/v1/health", None).await;
    }
    let (status, body) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["latency"]["samples"].as_u64().unwrap() >= 12, "{body}");
    assert!(body["latency"]["p99_ms"].is_null(), "p99 from a handful of samples: {body}");
    assert!(!body["latency"]["p50_ms"].is_null(), "p50 should be measurable: {body}");
}

#[tokio::test]
async fn an_empty_report_queue_has_no_oldest_item_rather_than_an_age_of_zero() {
    let s = start().await;
    let token = s.admin("root").await;
    let (status, body) = s.get("/_telium/v1/admin/moderation/summary", Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["oldest_open_ms"].is_null(), "{body}");
    assert!(body["resolution"]["p50_ms"].is_null(), "{body}");
    assert_eq!(body["resolution"]["samples"], 0);
}

#[tokio::test]
async fn a_history_nobody_has_written_yet_is_no_points_rather_than_a_flat_line() {
    let s = start().await;
    let token = s.admin("root").await;
    let (status, body) = s.get("/_telium/v1/admin/metrics/series", Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["points"].as_array().unwrap().len(), 0, "{body}");
    assert!(body["earliest"].is_null(), "{body}");
}

#[tokio::test]
async fn a_server_that_hosts_no_media_reports_absent_rather_than_empty() {
    let s = start().await;
    let token = s.admin("root").await;
    sqlx::query("SELECT 1").execute(&s.state.pool).await.unwrap();
    let (status, body) = s.get("/_telium/v1/admin/storage", Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["media_enabled"], true);
    assert_eq!(body["media_objects"], 0);
    assert!(body["db_bytes"].as_i64().unwrap() > 0, "{body}");
}

#[tokio::test]
async fn turning_metrics_off_says_so_instead_of_reporting_a_silent_server() {
    let s = start().await;
    let token = s.admin("root").await;
    let mut cfg = (*s.state.cfg).clone();
    cfg.metrics.enabled = false;
    let state = telium_server::AppState { cfg: std::sync::Arc::new(cfg), ..s.state.clone() };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = telium_server::routes::router(state);
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    let body: Value = reqwest::Client::new()
        .get(format!("http://{addr}/_telium/v1/admin/metrics"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["enabled"], false, "{body}");
    assert!(body.get("requests").is_none(), "a disabled collector invented a total: {body}");
}

#[tokio::test]
async fn requests_are_counted_and_split_by_who_is_calling() {
    let s = start().await;
    let token = s.admin("root").await;
    let (_, before) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    let before = before["requests"]["total"].as_u64().unwrap();
    for _ in 0..5 {
        s.get("/_telium/v1/health", None).await;
    }
    let (_, after) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    let after = after["requests"]["total"].as_u64().unwrap();
    assert!(after >= before + 5, "{before} -> {after}");
    let (_, body) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    assert_eq!(body["requests"]["federation"], 0, "{body}");
}

#[tokio::test]
async fn a_refusal_is_still_a_request_this_server_paid_for() {
    let s = start().await;
    let token = s.admin("root").await;
    let (_, before) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    let before = before["requests"]["responses_4xx"].as_u64().unwrap();
    for _ in 0..3 {
        s.get("/_telium/v1/admin/storage", None).await;
    }
    let (_, after) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    assert!(after["requests"]["responses_4xx"].as_u64().unwrap() >= before + 3, "{after}");
}

#[tokio::test]
async fn the_route_table_holds_patterns_and_never_identifiers() {
    let s = start().await;
    let token = s.admin("root").await;
    for id in ["01ARZ3NDEKTSV4RRFFQ69G5FAV", "01BX5ZZKBKACTAV9WEVGEMMVRZ"] {
        s.get(&format!("/_telium/v1/admin/peers/{id}"), Some(&token)).await;
    }
    let (_, body) = s.get("/_telium/v1/admin/metrics", Some(&token)).await;
    let table = body["routes"].as_array().unwrap();
    let rendered = serde_json::to_string(table).unwrap();
    assert!(
        rendered.contains("/_telium/v1/admin/peers/{origin}"),
        "the matched pattern should be the key: {rendered}"
    );
    assert!(
        !rendered.contains("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        "an identifier reached the route table: {rendered}"
    );
}

#[tokio::test]
async fn resolving_a_report_records_the_outcome_and_who_reached_it() {
    let s = start().await;
    let token = s.admin("root").await;
    s.seed_report("r1", "open", 1_000, None).await;

    let (status, body) = s
        .patch(
            "/_telium/v1/admin/reports/r1",
            Some(&token),
            json!({ "status": "actioned", "note": "removed the message and warned the account" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let (_, body) = s.get("/_telium/v1/admin/reports", Some(&token)).await;
    let report = &body["reports"][0];
    assert_eq!(report["status"], "actioned");
    assert_eq!(report["handled_by"], "@root:test.example");
    assert_eq!(report["resolution_note"], "removed the message and warned the account");
    assert!(report["handled_at"].as_i64().unwrap() > 0, "{report}");
}

#[tokio::test]
async fn an_open_report_has_not_been_handled_by_nobody_at_the_epoch() {
    let s = start().await;
    let token = s.admin("root").await;
    s.seed_report("r1", "open", 1_000, None).await;
    let (_, body) = s.get("/_telium/v1/admin/reports", Some(&token)).await;
    let report = &body["reports"][0];
    assert!(report["handled_by"].is_null(), "{report}");
    assert!(report["handled_at"].is_null(), "{report}");
    assert!(report["resolution_note"].is_null(), "{report}");
}

#[tokio::test]
async fn reopening_a_report_clears_the_outcome_it_no_longer_has() {
    let s = start().await;
    let token = s.admin("root").await;
    s.seed_report("r1", "open", 1_000, None).await;
    s.patch(
        "/_telium/v1/admin/reports/r1",
        Some(&token),
        json!({ "status": "rejected", "note": "looked fine to me" }),
    )
    .await;
    s.patch("/_telium/v1/admin/reports/r1", Some(&token), json!({ "status": "open" })).await;

    let (_, body) = s.get("/_telium/v1/admin/reports", Some(&token)).await;
    let report = &body["reports"][0];
    assert_eq!(report["status"], "open");
    assert!(report["handled_by"].is_null(), "a live item kept a stale verdict: {report}");
    assert!(report["resolution_note"].is_null(), "{report}");
}

#[tokio::test]
async fn time_to_resolution_needs_more_than_a_couple_of_samples() {
    let s = start().await;
    let token = s.admin("root").await;
    for i in 0..4 {
        s.seed_report(&format!("r{i}"), "actioned", 1_000, Some(1_000 + (i + 1) * 60_000)).await;
    }
    let (_, body) = s.get("/_telium/v1/admin/moderation/summary", Some(&token)).await;
    assert_eq!(body["resolution"]["samples"], 4);
    assert!(body["resolution"]["p50_ms"].is_null(), "{body}");

    s.seed_report("r4", "actioned", 1_000, Some(1_000 + 5 * 60_000)).await;
    let (_, body) = s.get("/_telium/v1/admin/moderation/summary", Some(&token)).await;
    assert_eq!(body["resolution"]["samples"], 5);
    assert_eq!(body["resolution"]["p50_ms"], 180_000, "{body}");
    assert_eq!(body["resolution"]["p90_ms"], 300_000, "{body}");
}

#[tokio::test]
async fn a_resolution_note_cannot_be_used_as_storage() {
    let s = start().await;
    let token = s.admin("root").await;
    s.seed_report("r1", "open", 1_000, None).await;
    let (status, _) = s
        .patch(
            "/_telium/v1/admin/reports/r1",
            Some(&token),
            json!({ "status": "actioned", "note": "x".repeat(5000) }),
        )
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn merging_buckets_recomputes_percentiles_instead_of_averaging_them() {
    let s = start().await;
    let token = s.admin("root").await;

    let fast = histogram(0, 100);
    let slow = histogram(telium_server::metrics::LATENCY_BUCKETS - 2, 100);
    for (start, hist) in [(0i64, &fast), (60_000, &slow)] {
        sqlx::query(
            "INSERT INTO metrics_rollup (bucket_start, window_ms, covered_ms, requests, \
             latency_hist, accounts_connected) VALUES (?, 60000, 60000, 100, ?, ?)",
        )
        .bind(start)
        .bind(hist)
        .bind(if start == 0 { Some(4i64) } else { None })
        .execute(&s.state.pool)
        .await
        .unwrap();
    }

    let (_, split) =
        s.get("/_telium/v1/admin/metrics/series?since=0&until=120000&points=2", Some(&token)).await;
    let points = split["points"].as_array().unwrap();
    assert_eq!(points.len(), 2);
    assert_eq!(points[0]["p50_ms"], 0.25);
    assert_eq!(points[1]["p50_ms"], 8000.0);

    let (_, merged) =
        s.get("/_telium/v1/admin/metrics/series?since=0&until=120000&points=1", Some(&token)).await;
    let point = &merged["points"][0];
    assert_eq!(merged["points"].as_array().unwrap().len(), 1);
    assert_eq!(point["requests"], 200);
    assert_eq!(point["covered_ms"], 120_000);
    assert_eq!(point["latency_samples"], 200);
    assert_eq!(point["p50_ms"], 0.25, "the percentiles were averaged: {merged}");
    assert_eq!(point["p90_ms"], 8000.0, "the slow requests did not survive: {merged}");
}

#[tokio::test]
async fn a_gauge_nobody_sampled_stays_null_through_a_merge() {
    let s = start().await;
    let token = s.admin("root").await;
    let hist = histogram(0, 0);
    for start in [0i64, 60_000] {
        sqlx::query(
            "INSERT INTO metrics_rollup (bucket_start, window_ms, covered_ms, requests, \
             latency_hist, accounts_connected) VALUES (?, 60000, 60000, 1, ?, ?)",
        )
        .bind(start)
        .bind(&hist)
        .bind(if start == 0 { Some(4i64) } else { None })
        .execute(&s.state.pool)
        .await
        .unwrap();
    }
    let (_, merged) =
        s.get("/_telium/v1/admin/metrics/series?since=0&until=120000&points=1", Some(&token)).await;
    let point = &merged["points"][0];
    assert_eq!(point["accounts_connected"], 4);
    assert!(point["media_bytes"].is_null(), "{point}");
    assert!(point["db_bytes"].is_null(), "{point}");
    assert_eq!(point["requests"], 2);
}

#[tokio::test]
async fn a_backwards_range_is_refused_rather_than_answered_emptily() {
    let s = start().await;
    let token = s.admin("root").await;
    let (status, _) =
        s.get("/_telium/v1/admin/metrics/series?since=120000&until=0", Some(&token)).await;
    assert_eq!(status, 400);
}

const SUSPEND_NOBODY: (&str, &str, &str) =
    ("POST", "/_telium/v1/admin/accounts/@nobody:test.example/suspend", r#"{"reason":"x"}"#);

#[tokio::test]
async fn a_destructive_route_refuses_an_administrator_who_has_not_re_authenticated() {
    let s = start().await;
    let token = s.admin("root").await;
    for row in ELEVATED_ROUTES {
        let (method, path, _) = *row;
        let (status, body) = call(&s, row, Some(&token)).await;
        assert_eq!((status, body["error"].as_str()), (403, Some("step_up_required")), "{method} {path}: {body}");
    }

    let (status, _) = s.post("/_telium/v1/admin/step-up", Some(&token), json!({ "password": "hunter2" })).await;
    assert_eq!(status, 401);
    let (_, body) = s.get("/_telium/v1/admin/step-up", Some(&token)).await;
    assert_eq!(body["elevated"], false, "{body}");
    assert!(body["expires_at"].is_null(), "{body}");
    assert!(s.audit().await.iter().any(|(actor, action, _, _)| action == "step_up.deny" && actor == "@root:test.example"));

    let still_required = |why: &'static str| {
        let s = &s;
        let token = token.clone();
        async move {
            let (status, body) = call(s, &SUSPEND_NOBODY, Some(&token)).await;
            assert_eq!((status, body["error"].as_str()), (403, Some("step_up_required")), "{why}: {body}");
        }
    };
    s.elevate(&token).await;
    sqlx::query("UPDATE admin_step_up SET expires_at = 1 WHERE user_id = '@root:test.example'")
        .execute(&s.state.pool)
        .await
        .unwrap();
    let (_, body) = s.get("/_telium/v1/admin/step-up", Some(&token)).await;
    assert_eq!(body["elevated"], false, "{body}");
    still_required("an expired window").await;

    s.elevate(&token).await;
    let (_, body) = s.delete("/_telium/v1/admin/step-up", Some(&token), json!({})).await;
    assert_eq!(body["elevated"], false, "{body}");
    still_required("a window put away early").await;

    s.elevate(&token).await;
    sqlx::query("UPDATE accounts SET admin = 0 WHERE user_id = '@root:test.example'")
        .execute(&s.state.pool)
        .await
        .unwrap();
    let (status, body) = call(&s, &SUSPEND_NOBODY, Some(&token)).await;
    assert_eq!((status, body["error"].as_str()), (403, Some("forbidden")), "a live window outlived the authority");
}

#[tokio::test]
async fn an_administrator_action_records_who_did_what_to_whom() {
    let s = start().await;
    let token = s.admin("root").await;
    for _ in 0..3 {
        s.elevate(&token).await;
    }
    let (_, first) = s.get("/_telium/v1/admin/audit?limit=2", Some(&token)).await;
    assert_eq!(first["entries"].as_array().unwrap().len(), 2, "{first}");
    let cursor = first["next_before"].as_str().expect("there is a third entry");
    let (_, second) = s.get(&format!("/_telium/v1/admin/audit?limit=2&before={cursor}"), Some(&token)).await;
    let rest = second["entries"].as_array().unwrap();
    assert_eq!(rest.len(), 1, "{second}");
    assert!(rest[0]["id"].as_str().unwrap() < cursor && second["next_before"].is_null(), "{second}");

    let (status, body) = s
        .post("/_telium/v1/admin/defederation", Some(&token), json!({ "domain": "nasty.example", "reason": "spam" }))
        .await;
    assert_eq!(status, 200, "{body}");
    let entries = s.audit().await;
    let (actor, _, target, data) =
        entries.iter().find(|(_, action, _, _)| action == "federation.defederate").expect("no record");
    assert_eq!((actor.as_str(), target.as_deref()), ("@root:test.example", Some("nasty.example")));
    assert_eq!(serde_json::from_str::<Value>(data).unwrap()["reason"], "spam");

    s.post("/_telium/v1/admin/storage/sweep", Some(&token), json!({})).await;
    let (_, body) = s.get("/_telium/v1/admin/audit?action=storage.sweep", Some(&token)).await;
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{body}");
    assert!(entries[0]["data"].is_object(), "stored JSON comes back as an object: {body}");
}

#[tokio::test]
async fn purging_a_guild_leaves_behind_the_record_of_the_purge() {
    let s = start().await;
    let token = s.admin("root").await;
    s.elevate(&token).await;
    let guild = "01GUILD0000000000000000002";
    s.seed_guild(guild, "departed", "@founder:test.example").await;
    for sql in [
        "INSERT INTO audit_log (id, guild_id, actor, action, target, data, created_at) \
         VALUES ('a1', ?, '@founder:test.example', 'guild.update', NULL, '{}', 1000)",
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'newguild:other.example', '{}', 1000)",
    ] {
        sqlx::query(sql).bind(guild).execute(&s.state.pool).await.unwrap();
    }
    let (status, body) = s.post(&format!("/_telium/v1/admin/guilds/{guild}/purge"), Some(&token), json!({})).await;
    assert_eq!(status, 200, "{body}");
    let guild_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM audit_log WHERE guild_id = ?")
        .bind(guild)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(guild_rows, 0);
    let entries = s.audit().await;
    let (_, _, target, data) =
        entries.iter().find(|(_, action, _, _)| action == "guild.purge").expect("the purge erased its own record");
    assert_eq!(target.as_deref(), Some(guild));
    assert_eq!(serde_json::from_str::<Value>(data).unwrap()["name"], "departed");
}

#[tokio::test]
async fn suspending_an_account_signs_it_out_everywhere_and_says_why() {
    let s = start().await;
    let token = s.admin("root").await;
    let victim = s.user("nuisance").await;
    s.admin("second").await;
    s.user("hermit").await;
    sqlx::query("UPDATE accounts SET deactivated = 1 WHERE user_id = '@hermit:test.example'")
        .execute(&s.state.pool)
        .await
        .unwrap();
    s.elevate(&token).await;
    let admin = |path: String, body: Value| {
        let (s, token) = (&s, token.clone());
        async move { s.post(&format!("/_telium/v1/admin/accounts/{path}"), Some(&token), body).await }
    };

    let (status, _) = admin("@nuisance:test.example/suspend".into(), json!({ "reason": "   " })).await;
    assert_eq!(status, 400, "a suspension needs a reviewable reason");
    for (who, what) in [("second", "another administrator"), ("root", "their own account")] {
        let (status, body) = admin(format!("@{who}:test.example/suspend"), json!({ "reason": "x" })).await;
        assert_eq!(status, 409, "suspended {what}: {body}");
    }
    let (status, body) = admin("@hermit:test.example/reinstate".into(), json!({})).await;
    assert_eq!(status, 409, "reinstated an account its owner turned off: {body}");

    assert_eq!(s.get("/_telium/v1/account/export", Some(&victim)).await.0, 200);
    let reason = "posting the same link in forty guilds";
    let (status, body) = admin("@nuisance:test.example/suspend".into(), json!({ "reason": reason })).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["sessions_revoked"].as_i64().unwrap() >= 1, "{body}");
    assert_eq!(s.get("/_telium/v1/account/export", Some(&victim)).await.0, 401);
    let (_, body) = s.get("/_telium/v1/admin/accounts?status=suspended", Some(&token)).await;
    let row = body["accounts"].as_array().unwrap().iter().find(|r| r["user_id"] == "@nuisance:test.example").unwrap();
    assert_eq!((&row["suspended_by"], &row["suspension_reason"]), (&json!("@root:test.example"), &json!(reason)));

    let login = json!({ "user": "nuisance", "password": "correct horse battery" });
    let (status, body) = s.post("/_telium/v1/account/reactivate", None, login.clone()).await;
    assert_eq!((status, body["message"].as_str()), (401, Some("account_suspended")), "{body}");
    let (status, body) = admin("@nuisance:test.example/reinstate".into(), json!({})).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = s.post("/_telium/v1/login", None, login).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn account_search_finds_an_account_by_the_part_a_person_would_remember() {
    let s = start().await;
    let token = s.admin("root").await;
    s.user("bartholomew").await;
    s.user("someone-else").await;
    let (_, body) = s.get("/_telium/v1/admin/accounts?q=tholo", Some(&token)).await;
    let rows = body["accounts"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{body}");
    assert_eq!(rows[0]["user_id"], "@bartholomew:test.example");
    assert_eq!(body["total"], 1, "total counts matches, not the page: {body}");
}

#[tokio::test]
async fn an_operator_sees_the_shape_of_a_hosted_guild_and_not_what_is_said_in_it() {
    let s = start().await;
    let token = s.admin("root").await;
    let guild = "01GUILD0000000000000000003";
    s.seed_guild(guild, "the local pub", "@founder:test.example").await;
    for sql in [
        "INSERT INTO channels (id, guild_id, type, name, topic, created_at) \
         VALUES ('c1', ?, 'text', 'general', 'what we talk about', 1000)",
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
         VALUES ('m1', 'c1', ?, '@founder:test.example', 'a private thing somebody said', 2000)",
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'elsewhere:other.example', '{}', 1000)",
    ] {
        sqlx::query(sql).bind(guild).execute(&s.state.pool).await.unwrap();
    }
    let (status, body) = s.get(&format!("/_telium/v1/admin/guilds/{guild}"), Some(&token)).await;
    assert_eq!(status, 200, "{body}");
    let g = &body["guild"];
    assert_eq!((&g["name"], &g["members"], &g["channels"], &g["messages"]), (&json!("the local pub"), &json!(1), &json!(1), &json!(1)));
    assert_eq!(body["owner"]["local"], true);
    let rendered = body.to_string();
    assert!(!rendered.contains("a private thing somebody said") && !rendered.contains("what we talk about"), "{rendered}");

    let (_, list) = s.get("/_telium/v1/admin/guilds", Some(&token)).await;
    let row = list["guilds"].as_array().unwrap().iter().find(|g| g["id"] == guild).expect("listed until purged");
    assert_eq!((&row["moved_to"], &row["gone"]), (&json!("elsewhere:other.example"), &json!(false)), "{row}");
}

#[tokio::test]
async fn a_health_signal_carries_a_severity_a_cause_and_a_next_action() {
    let s = start().await;
    let token = s.admin("root").await;
    let (_, body) = s.get("/_telium/v1/admin/health", Some(&token)).await;
    assert!(body["checked_at"].as_i64().unwrap() > 0, "{body}");
    let signals = body["signals"].as_array().unwrap();
    let rank = |s: &Value| match s["severity"].as_str().unwrap() {
        "critical" => 0,
        "warning" => 1,
        "notice" => 2,
        other => panic!("unknown severity {other}"),
    };
    for signal in signals {
        for field in ["key", "severity", "title", "cause", "action"] {
            assert!(!signal[field].as_str().unwrap_or("").is_empty(), "a signal is missing its {field}: {signal}");
        }
    }
    assert!(signals.windows(2).all(|p| rank(&p[0]) <= rank(&p[1])), "out of order: {signals:?}");
    for key in ["backup.disabled", "standby.none"] {
        assert!(signals.iter().any(|s| s["key"] == key), "nothing said {key}: {body}");
    }
    assert_ne!(body["verdict"], "ok", "{body}");

    let (_, continuity) = s.get("/_telium/v1/admin/continuity", Some(&token)).await;
    assert_eq!(continuity["server_name"], "test.example");
    assert_eq!(continuity["standbys"].as_array().unwrap().len(), 0, "{continuity}");
    assert_eq!(continuity["read_only"], false);
    assert!(continuity["authority"].is_null(), "{continuity}");
}

#[tokio::test]
async fn the_status_page_answers_which_server_this_is_and_what_it_is_running() {
    let s = start().await;
    let token = s.admin("root").await;
    let (_, body) = s.get("/_telium/v1/admin/status", Some(&token)).await;
    assert_eq!((&body["server_name"], &body["protocol_version"]), (&json!("test.example"), &json!("v1")));
    assert!(!body["version"].as_str().unwrap().is_empty() && body["uptime_ms"].as_i64().unwrap() >= 0, "{body}");
    assert_eq!((&body["registration_open"], &body["roles"]["identity"], &body["shut_down"]), (&json!(true), &json!(true), &json!(false)));

    s.elevate(&token).await;
    let (status, body) = s.post("/_telium/v1/admin/sunset", Some(&token), json!({ "mode": "shutdown" })).await;
    assert_eq!(status, 200, "{body}");
    let (_, body) = s.get("/_telium/v1/admin/status", Some(&token)).await;
    assert_eq!(body["registration_open"], false, "{body}");
    assert!(s.audit().await.iter().any(|(_, action, _, _)| action == "sunset.announce"));
}
