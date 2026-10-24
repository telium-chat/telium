
use crate::config::RateLimit;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{header, HeaderValue, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Instant;

struct Bucket {
    tokens: f64,
    updated: Instant,
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<(String, &'static str), Bucket>>,
    rejections: Mutex<HashMap<&'static str, u64>>,
}

impl RateLimiter {
    pub fn new(_cfg: RateLimit) -> Self {
        Self { buckets: Mutex::new(HashMap::new()), rejections: Mutex::new(HashMap::new()) }
    }

    pub fn rejections(&self) -> Vec<(&'static str, u64)> {
        let counts = self.rejections.lock().expect("rate limiter poisoned");
        let mut out: Vec<(&'static str, u64)> = counts.iter().map(|(k, v)| (*k, *v)).collect();
        out.sort_unstable_by_key(|(kind, _)| *kind);
        out
    }

    pub fn rejected_total(&self) -> u64 {
        self.rejections.lock().expect("rate limiter poisoned").values().sum()
    }

    pub fn buckets_live(&self) -> usize {
        self.buckets.lock().expect("rate limiter poisoned").len()
    }

    fn note_rejection(&self, kind: &'static str) {
        *self.rejections.lock().expect("rate limiter poisoned").entry(kind).or_insert(0) += 1;
    }

    pub(crate) fn take(&self, key: String, kind: &'static str, burst: f64, per_sec: f64) -> Result<(), f64> {
        self.take_cost(key, kind, burst, per_sec, 1.0)
    }

    pub(crate) fn take_cost(
        &self,
        key: String,
        kind: &'static str,
        burst: f64,
        per_sec: f64,
        cost: f64,
    ) -> Result<(), f64> {
        let now = Instant::now();
        let over = {
            let mut buckets = self.buckets.lock().expect("rate limiter poisoned");
            Self::spend(&mut buckets, key, kind, burst, per_sec, now, cost)
        };
        if let Err(retry) = over {
            self.note_rejection(kind);
            return Err(retry);
        }
        Ok(())
    }

    fn spend(
        buckets: &mut HashMap<(String, &'static str), Bucket>,
        key: String,
        kind: &'static str,
        burst: f64,
        per_sec: f64,
        now: Instant,
        cost: f64,
    ) -> Result<(), f64> {
        let cost = cost.max(1.0).min(burst.max(1.0));
        if buckets.len() > 20_000 {
            buckets.retain(|_, b| now.duration_since(b.updated).as_secs() < 60);
        }
        let bucket = buckets
            .entry((key, kind))
            .or_insert(Bucket { tokens: burst, updated: now });
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * per_sec).min(burst);
        bucket.updated = now;
        if bucket.tokens < cost {
            return Err(((cost - bucket.tokens) / per_sec).max(1.0).ceil());
        }
        bucket.tokens -= cost;
        Ok(())
    }
}

fn caller(req: &Request, trusted_proxies: &[String]) -> String {
    if let Some(auth) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if auth.starts_with(crate::federation::AUTH_SCHEME) {
            return peer_key(req, trusted_proxies, "fed");
        }
        return format!("t:{}", &crate::util::hash_token(auth.trim_start_matches("Bearer "))[..16]);
    }
    peer_key(req, trusted_proxies, "ip")
}

fn peer_key(req: &Request, trusted_proxies: &[String], tag: &str) -> String {
    let addr = peer_address(req.extensions(), req.headers(), trusted_proxies);
    format!("{tag}:{}", addr.as_deref().unwrap_or("anon"))
}

pub fn peer_address(
    extensions: &axum::http::Extensions,
    headers: &axum::http::HeaderMap,
    trusted_proxies: &[String],
) -> Option<String> {
    let socket = extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .and_then(|ip| address_of(&ip));
    let trusted = socket
        .as_ref()
        .is_some_and(|ip| trusted_proxies.iter().filter_map(|c| address_of(c)).any(|c| &c == ip));
    if trusted {
        let trail: Vec<&str> = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect();
        let claimant = trail.iter().rev().find(|hop| {
            address_of(hop).is_none_or(|hop| {
                !trusted_proxies.iter().filter_map(|t| address_of(t)).any(|t| t == hop)
            })
        });
        if let Some(claimant) = claimant.and_then(|hop| address_of(hop)) {
            return Some(claimant);
        }
    }
    socket
}

fn address_of(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let bare = if let Some(rest) = raw.strip_prefix('[') {
        rest.split_once(']').map(|(inside, _)| inside)?
    } else if raw.matches(':').count() == 1 {
        match raw.split_once(':') {
            Some((host, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => {
                host
            }
            _ => raw,
        }
    } else {
        raw
    };
    let bare = bare.split('%').next().unwrap_or(bare);
    match bare.parse::<std::net::IpAddr>().ok()? {
        std::net::IpAddr::V6(v6) => {
            Some(v6.to_ipv4_mapped().map(|v4| v4.to_string()).unwrap_or_else(|| v6.to_string()))
        }
        addr => Some(addr.to_string()),
    }
}

fn is_auth_endpoint(method: &Method, path: &str) -> bool {
    if !matches!(method, &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE) {
        return false;
    }
    matches!(
        path,
        "/_telium/v1/login"
            | "/_telium/v1/register"
            | "/_telium/v1/register/opaque/start"
            | "/_telium/v1/register/opaque/finish"
            | "/_telium/v1/login/opaque/start"
            | "/_telium/v1/login/opaque/finish"
            | "/_telium/v1/auth/opaque/reauth/start"
            | "/_telium/v1/auth/opaque/reauth/finish"
            | "/_telium/v1/account/reactivate"
            | "/_telium/v1/password-reset/opaque/start"
            | "/_telium/v1/password-reset/opaque/finish"
            | "/_telium/v1/migrate"
            | "/_telium/v1/account/deactivate"
            | "/_telium/v1/account"
            | "/_telium/v1/mfa/setup"
            | "/_telium/v1/mfa/disable"
            | "/_telium/v1/mfa/enable"
            | "/_telium/v1/account/recovery-email"
            | "/_telium/v1/account/bundle"
            | "/_telium/v1/admin/step-up"
            | "/_telium/v1/admin/ownership/grant"
            | "/_telium/v1/admin/ownership/revoke"
    ) || (path.starts_with("/_telium/v1/migrate/") && path.ends_with("/retry"))
        || path.starts_with("/_telium/v1/admin/ownership/sessions/")
}

fn budget(cfg: &RateLimit, key: &str, auth_endpoint: bool, write: bool) -> (&'static str, f64, f64) {
    if auth_endpoint {
        ("auth", cfg.auth_burst as f64, cfg.auth_per_sec)
    } else if key.starts_with("fed:") {
        ("federation", cfg.federation_burst as f64, cfg.federation_per_sec)
    } else if write {
        ("write", cfg.write_burst as f64, cfg.write_per_sec)
    } else {
        ("read", cfg.read_burst as f64, cfg.read_per_sec)
    }
}

pub async fn layer(State(state): State<crate::state::AppState>, req: Request, next: Next) -> Response {
    let cfg = &state.cfg.rate_limit;
    if !cfg.enabled {
        return next.run(req).await;
    }

    let write = !matches!(req.method(), &Method::GET | &Method::HEAD | &Method::OPTIONS);
    let key = caller(&req, &cfg.trusted_proxies);
    let path = req.uri().path();
    let auth_endpoint = is_auth_endpoint(req.method(), path);
    let (kind, burst, per_sec) = budget(cfg, &key, auth_endpoint, write);

    if let Err(retry) = state.limiter.take(key, kind, burst, per_sec) {
        let refusal = crate::error::ApiError::RateLimited(format!("Too many requests. Try again in {retry:.0}s."))
            .with_code(crate::errcodes::RATE_LIMITED)
            .with_detail("retry_after", retry);
        let mut response = refusal.into_response();
        if let Ok(value) = HeaderValue::from_str(&format!("{retry:.0}")) {
            response.headers_mut().insert(header::RETRY_AFTER, value);
        }
        return response;
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_refills_rather_than_resetting() {
        let limiter = RateLimiter::new(RateLimit::default());
        assert!(limiter.take("a".into(), "write", 2.0, 1.0).is_ok());
        assert!(limiter.take("a".into(), "write", 2.0, 1.0).is_ok());
        let over = limiter.take("a".into(), "write", 2.0, 1.0);
        assert!(over.is_err(), "third call in the same instant must be refused");
        assert!(limiter.take("b".into(), "write", 2.0, 1.0).is_ok());
    }

    fn federation_header(origin: &str, ts: i64) -> String {
        format!(
            "{} origin={origin},destination=b.test,key=k,ts={ts},sig=AAAA",
            crate::federation::AUTH_SCHEME
        )
    }

    fn key_from(auth: &str, peer: &str) -> String {
        keyed(auth, peer, None, &[])
    }

    fn keyed(auth: &str, peer: &str, fwd: Option<&str>, trusted: &[String]) -> String {
        keyed_trail(auth, peer, &fwd.map(|f| vec![f]).unwrap_or_default(), trusted)
    }

    fn keyed_trail(auth: &str, peer: &str, fwd: &[&str], trusted: &[String]) -> String {
        let mut builder =
            Request::builder().uri("/_telium/v1/migrate/import").header(header::AUTHORIZATION, auth);
        for line in fwd {
            builder = builder.header("x-forwarded-for", *line);
        }
        let mut req = builder.body(axum::body::Body::empty()).unwrap();
        req.extensions_mut().insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        caller(&req, trusted)
    }

    #[test]
    fn a_trusted_proxy_is_trusted_however_its_address_was_written() {
        for config in ["::ffff:10.0.0.9", "10.0.0.9"] {
            for socket in ["[::ffff:10.0.0.9]:443", "10.0.0.9:443"] {
                let key = keyed(
                    &federation_header("a.test", 1_000_000),
                    socket,
                    Some("198.51.100.4"),
                    &[config.to_string()],
                );
                assert_eq!(
                    key, "fed:198.51.100.4",
                    "config {config} did not recognise the socket written {socket}"
                );
            }
        }
    }

    #[test]
    fn a_mapped_address_is_the_address_it_maps_to() {
        let direct = key_from(&federation_header("a.test", 1_000_000), "198.51.100.4:9000");
        let mapped =
            key_from(&federation_header("a.test", 1_000_000), "[::ffff:198.51.100.4]:9000");
        assert_eq!(direct, mapped, "one host was counted as two callers");
    }

    #[test]
    fn a_hop_that_is_not_an_address_does_not_become_one() {
        let trusted = ["192.0.2.1".to_string()];
        let first = keyed(
            &federation_header("a.test", 1_000_000),
            "192.0.2.1:443",
            Some("not-an-address"),
            &trusted,
        );
        let second = keyed(
            &federation_header("a.test", 1_000_000),
            "192.0.2.1:443",
            Some("also-not-one"),
            &trusted,
        );
        assert_eq!(first, second, "two invented hop names bought two budgets");
        assert_eq!(first, "fed:192.0.2.1", "the fallback has to be something real");
    }

    #[test]
    fn a_federation_caller_is_one_bucket_and_not_one_per_request() {
        let first = key_from(&federation_header("a.test", 1_000_000), "203.0.113.7:9000");
        let second = key_from(&federation_header("a.test", 2_000_000), "203.0.113.7:9100");
        assert_eq!(first, second, "the same sender was counted as two different callers");
    }

    #[test]
    fn a_federation_caller_cannot_pick_its_own_bucket() {
        let honest = key_from(&federation_header("a.test", 1_000_000), "203.0.113.7:9000");
        let renamed = key_from(&federation_header("b.test", 1_000_000), "203.0.113.7:9000");
        assert_eq!(honest, renamed, "changing the claimed origin bought a fresh budget");
    }

    #[test]
    fn naming_a_peer_does_not_spend_that_peers_budget() {
        let genuine = key_from(&federation_header("a.test", 1_000_000), "198.51.100.4:9000");
        let impostor = key_from(&federation_header("a.test", 1_000_000), "203.0.113.7:9000");
        assert_ne!(genuine, impostor, "a stranger was counted against the peer it named");
    }

    #[test]
    fn a_caller_cannot_pick_its_address_by_writing_one_down() {
        let trusted = vec!["127.0.0.1".to_string()];
        let auth = federation_header("a.test", 1_000_000);
        let first = keyed(&auth, "127.0.0.1:443", Some("9.9.9.9, 203.0.113.7"), &trusted);
        let second = keyed(&auth, "127.0.0.1:443", Some("8.8.8.8, 203.0.113.7"), &trusted);
        assert_eq!(first, "fed:203.0.113.7", "the caller's own entry was believed: {first}");
        assert_eq!(first, second, "rewriting the header bought a fresh budget");
    }

    #[test]
    fn the_trail_is_walked_back_through_every_hop_we_trust() {
        let trusted = vec!["127.0.0.1".to_string(), "10.0.0.1".to_string()];
        let key = keyed(
            &federation_header("a.test", 1),
            "127.0.0.1:443",
            Some("203.0.113.7, 10.0.0.1"),
            &trusted,
        );
        assert_eq!(key, "fed:203.0.113.7");
    }

    #[test]
    fn one_address_is_one_bucket_however_it_is_written() {
        let trusted = vec!["127.0.0.1".to_string()];
        let auth = federation_header("a.test", 1);
        let a = keyed(&auth, "127.0.0.1:443", Some("[2001:0db8::0001]:9000"), &trusted);
        let b = keyed(&auth, "127.0.0.1:443", Some("2001:db8:0:0:0:0:0:1"), &trusted);
        let c = keyed(&auth, "127.0.0.1:443", Some("2001:db8::1%eth0"), &trusted);
        assert_eq!(a, "fed:2001:db8::1");
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn a_federation_header_does_not_widen_the_login_bucket() {
        let cfg = RateLimit::default();
        let (kind, burst, per_sec) = budget(&cfg, "fed:203.0.113.7", true, true);
        assert_eq!(kind, "auth");
        assert_eq!(burst, cfg.auth_burst as f64);
        assert_eq!(per_sec, cfg.auth_per_sec);
    }

    #[test]
    fn a_peer_gets_the_federation_budget() {
        let cfg = RateLimit::default();
        assert_eq!(budget(&cfg, "fed:203.0.113.7", false, true).0, "federation");
        assert_eq!(budget(&cfg, "t:abc", false, true).0, "write");
        assert_eq!(budget(&cfg, "ip:203.0.113.7", false, false).0, "read");
    }

    #[test]
    fn a_client_token_is_still_keyed_on_the_token() {
        let a = key_from("Bearer abc123", "203.0.113.7:9000");
        let b = key_from("Bearer abc123", "198.51.100.4:9000");
        assert!(a.starts_with("t:"));
        assert_eq!(a, b);
    }

    #[test]
    fn a_caller_cannot_hide_the_proxy_behind_a_line_of_its_own() {
        let auth = federation_header("a.test", 1_000_000);
        let trusted = vec!["127.0.0.1".to_string()];
        let key = keyed_trail(&auth, "127.0.0.1:443", &["10.9.9.1", "198.51.100.77"], &trusted);
        assert_eq!(key, "fed:198.51.100.77", "the caller named itself past the proxy");
        let again = keyed_trail(&auth, "127.0.0.1:443", &["10.9.9.2", "198.51.100.77"], &trusted);
        assert_eq!(again, key, "changing its own line changed the caller's bucket");
    }

    #[test]
    fn every_route_that_checks_a_password_is_on_the_strict_bucket() {
        use super::is_auth_endpoint as auth;
        use axum::http::Method;

        for (method, path) in [
            (Method::POST, "/_telium/v1/login"),
            (Method::POST, "/_telium/v1/login/opaque/start"),
            (Method::POST, "/_telium/v1/login/opaque/finish"),
            (Method::POST, "/_telium/v1/auth/opaque/reauth/start"),
            (Method::POST, "/_telium/v1/auth/opaque/reauth/finish"),
            (Method::POST, "/_telium/v1/register"),
            (Method::POST, "/_telium/v1/register/opaque/start"),
            (Method::POST, "/_telium/v1/register/opaque/finish"),
            (Method::POST, "/_telium/v1/account/reactivate"),
            (Method::POST, "/_telium/v1/password-reset/opaque/start"),
            (Method::POST, "/_telium/v1/password-reset/opaque/finish"),
            (Method::POST, "/_telium/v1/account/deactivate"),
            (Method::DELETE, "/_telium/v1/account"),
            (Method::POST, "/_telium/v1/mfa/setup"),
            (Method::POST, "/_telium/v1/mfa/disable"),
            (Method::POST, "/_telium/v1/mfa/enable"),
            (Method::POST, "/_telium/v1/migrate"),
            (Method::POST, "/_telium/v1/migrate/m-abc/retry"),
            (Method::PUT, "/_telium/v1/account/recovery-email"),
            (Method::POST, "/_telium/v1/account/bundle"),
            (Method::POST, "/_telium/v1/admin/step-up"),
            (Method::POST, "/_telium/v1/admin/ownership/grant"),
            (Method::POST, "/_telium/v1/admin/ownership/revoke"),
            (Method::DELETE, "/_telium/v1/admin/ownership/sessions/d-abc"),
        ] {
            assert!(auth(&method, path), "{method} {path} takes a password off the strict bucket");
        }

        for (method, path) in [
            (Method::GET, "/_telium/v1/migrate"),
            (Method::GET, "/_telium/v1/mfa"),
            (Method::GET, "/_telium/v1/account/recovery-email"),
            (Method::POST, "/_telium/v1/migrate/m-abc/cancel"),
            (Method::POST, "/_telium/v1/guilds"),
            (Method::POST, "/_telium/v1/messages"),
            (Method::GET, "/_telium/v1/admin/ownership"),
            (Method::GET, "/_telium/v1/admin/ownership/sessions"),
            (Method::POST, "/_telium/v1/admin/ownership/recovery/c-abc/cancel"),
        ] {
            assert!(!auth(&method, path), "{method} {path} was put on the login budget");
        }
    }

    fn strict_paths() -> Vec<String> {
        let me = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/ratelimit.rs");
        let mine = std::fs::read_to_string(&me).expect("ratelimit.rs is readable");
        let at = mine.find("fn is_auth_endpoint").expect("is_auth_endpoint is still here");
        let opens = mine[at..].find("matches!(").expect("its match is still a `matches!`") + at;
        let closes = mine[opens..]
            .find(") || (path.starts_with(")
            .expect("its match still ends at the suffix check")
            + opens;
        mine[opens..closes].split('"').skip(1).step_by(2).map(str::to_string).collect()
    }

    #[test]
    fn the_strict_paths_are_paths_this_server_actually_serves() {
        let mod_rs = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src/routes/mod.rs");
        let src = std::fs::read_to_string(&mod_rs).expect("routes/mod.rs is readable");

        let paths = strict_paths();
        assert!(
            paths.len() >= 10,
            "only {} paths were read out of the match arm, so the parse is wrong \
             and what follows proves nothing: {paths:?}",
            paths.len()
        );
        assert!(
            paths.iter().any(|p| *p == "/_telium/v1/login"),
            "the strict list was read out of `is_auth_endpoint` and does not \
             contain /_telium/v1/login, so it was not read correctly: {paths:?}"
        );
        for path in paths {
            assert!(
                path.starts_with("/_telium/v1/"),
                "`{path}` was parsed out of the match arm but is not a route"
            );
            assert!(
                src.contains(&format!("\"{path}\"")),
                "`{path}` is on the strict bucket but no longer declared in \
                 routes/mod.rs -- either it was renamed and the budget did not \
                 follow it, or it is gone and the entry should be too"
            );
        }

        assert!(
            src.contains("/retry\""),
            "no route ends in /retry, but `is_auth_endpoint` puts one on the \
             strict bucket by that suffix"
        );
    }

    const CREDENTIAL_CHECKS: [(&str, &str); 3] =
        [("verify_sensitive", "_reauth"), ("verify", "_totp"), ("consume_mfa", "_code")];

    const KNOWN_CREDENTIAL_CHECKS: [(&str, usize, usize); 10] = [
        ("admin/mod.rs", 0, 1),
        ("ownership.rs", 0, 1),
        ("routes/recovery.rs", 0, 1),
        ("routes/identity/mfa.rs", 0, 2),
        ("routes/identity/mfa.rs", 1, 2),
        ("routes/identity/mfa.rs", 2, 1),
        ("routes/identity/mod.rs", 0, 2),
        ("routes/identity/mod.rs", 2, 1),
        ("routes/migrate.rs", 0, 2),
        ("sunset.rs", 0, 1),
    ];

    #[test]
    fn every_credential_check_in_the_tree_is_on_this_list() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("a readable entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    files.push(path);
                }
            }
        }
        assert!(files.len() > 20, "the walk found {} files; it is not walking the tree", files.len());

        let names: Vec<String> =
            CREDENTIAL_CHECKS.iter().map(|(head, tail)| format!("{head}{tail}")).collect();

        let mut found: Vec<(String, usize, usize)> = Vec::new();
        for path in &files {
            let src = std::fs::read_to_string(path).expect("a readable file");
            let rel =
                path.strip_prefix(&root).expect("under src").to_string_lossy().replace('\\', "/");
            for (i, name) in names.iter().enumerate() {
                let mentions = src.matches(name.as_str()).count()
                    - src.matches(&format!("fn {name}(")).count();
                if mentions > 0 {
                    found.push((rel.clone(), i, mentions));
                }
            }
        }
        found.sort();

        let mut want: Vec<(String, usize, usize)> = KNOWN_CREDENTIAL_CHECKS
            .iter()
            .map(|(f, n, c)| ((*f).to_string(), *n, *c))
            .collect();
        want.sort();

        assert_eq!(
            found, want,
            "the places a secret is checked changed -- the second number is an \
             index into `CREDENTIAL_CHECKS`, which reads {names:?}. Put the new \
             route on the strict bucket in `is_auth_endpoint`, add it to \
             `every_route_that_checks_a_password_is_on_the_strict_bucket`, and \
             then say so in `KNOWN_CREDENTIAL_CHECKS`."
        );
    }

    const WIDE_READS: [(&str, &str); 2] = [("MAT", "CH ?"), ("IN ({place", "holders})")];
    const KNOWN_WIDE_READS: [(&str, usize, usize); 2] =
        [("routes/social.rs", 0, 2), ("routes/social.rs", 1, 4)];
    const SEARCH_BUCKET: [&str; 2] = ["\"sea", "rch\""];
    const COST_CHARGE: [&str; 2] = ["take", "_cost("];

    #[test]
    fn every_wide_read_in_the_tree_is_charged_by_what_it_costs() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("src is readable") {
                let path = entry.expect("a readable entry").path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    files.push(path);
                }
            }
        }
        assert!(files.len() > 20, "the walk found {} files", files.len());

        let markers: Vec<String> =
            WIDE_READS.iter().map(|(head, tail)| format!("{head}{tail}")).collect();
        let bucket = SEARCH_BUCKET.concat();
        let charge = COST_CHARGE.concat();

        let mut found: Vec<(String, usize, usize)> = Vec::new();
        for path in &files {
            let src = std::fs::read_to_string(path).expect("a readable file");
            let rel =
                path.strip_prefix(&root).expect("under src").to_string_lossy().replace('\\', "/");
            let mut wide = false;
            for (i, marker) in markers.iter().enumerate() {
                let hits = src.matches(marker.as_str()).count();
                if hits > 0 {
                    found.push((rel.clone(), i, hits));
                    wide = true;
                }
            }
            if wide {
                assert!(
                    src.contains(&bucket) && src.contains(&charge),
                    "{rel} has a wide read but never charges the {bucket} bucket through {charge}...)"
                );
            }
        }
        found.sort();
        let mut want: Vec<(String, usize, usize)> =
            KNOWN_WIDE_READS.iter().map(|(f, n, c)| ((*f).to_string(), *n, *c)).collect();
        want.sort();
        assert_eq!(
            found, want,
            "wide reads changed (index into {markers:?}); price new ones via \
             `RateLimiter::take_cost` and list them in `KNOWN_WIDE_READS`"
        );
    }

    #[test]
    fn a_wildcard_sweep_does_not_cost_what_an_exact_term_costs() {
        use crate::routes::social::search_cost;
        let ordinary = search_cost(20, Some("proposal"), false, 25, 0);
        assert!(ordinary < 10.0, "an ordinary search costs {ordinary}");
        let wildcard = search_cost(20, Some("a"), false, 25, 0);
        assert!(wildcard > ordinary * 5.0, "one-char term {wildcard} vs {ordinary}");
        let big = search_cost(500, Some("proposal"), false, 25, 0);
        assert!(big > ordinary * 10.0, "big guild {big} vs {ordinary}");
        let sweep = search_cost(500, None, false, 100, 10_000);
        assert!(sweep > 300.0, "widest query prices at only {sweep}");
        let selective = search_cost(20, None, true, 25, 0);
        let unselective = search_cost(20, None, false, 25, 0);
        assert!(selective < unselective / 2.0, "author filter {selective} vs {unselective}");
    }

    #[test]
    fn take_cost_rules() {
        let slow = 0.000_001;
        let l = RateLimiter::new(RateLimit::default());
        for _ in 0..3 {
            assert!(l.take_cost("a".into(), "search", 3.0, 1.0, 0.0).is_ok());
        }
        assert!(l.take_cost("a".into(), "search", 3.0, 1.0, 0.0).is_err(), "zero cost is free");

        let l = RateLimiter::new(RateLimit::default());
        assert!(l.take_cost("a".into(), "search", 100.0, slow, 90.0).is_ok());
        assert!(l.take_cost("a".into(), "search", 100.0, slow, 50.0).is_err());
        for _ in 0..10 {
            assert!(l.take_cost("a".into(), "search", 100.0, slow, 1.0).is_ok(), "refusal drained");
        }
        assert!(l.take_cost("a".into(), "search", 100.0, slow, 1.0).is_err());
        assert_eq!(l.rejections(), vec![("search", 2)]);
        assert_eq!(l.rejected_total(), 2);

        let l = RateLimiter::new(RateLimit::default());
        assert!(l.take_cost("a".into(), "search", 10.0, 1.0, 10_000.0).is_ok(), "never servable");
        assert!(l.take_cost("a".into(), "search", 10.0, 1.0, 1.0).is_err(), "clamp is a discount");
    }
}
