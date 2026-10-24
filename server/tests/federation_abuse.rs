
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use telium_server::config::Config;
use telium_server::crypto::{self, AssertionClaims, ServerKey};
use telium_server::federation::{self as fed, check_envelope, normalise_origin};

static COUNTER: AtomicU32 = AtomicU32::new(0);
const MIB: usize = 1024 * 1024;

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

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

async fn start_with(tweak: impl FnOnce(&mut Config)) -> Server {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-fedabuse-{}-{n}", std::process::id()));
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
    cfg.federation.enabled = true;
    cfg.federation.allow_http = true;
    cfg.rate_limit.enabled = false;
    tweak(&mut cfg);
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state }
}

#[derive(Clone)]
enum Answer {
    Flood,
    Missing,
    DiscoverThenFlood,
    Honest(Arc<Vec<u8>>),
}

struct Peer {
    addr: std::net::SocketAddr,
    requests: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
}

async fn peer(answer: Answer) -> Peer {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (requests, sent) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let (rc, sc) = (requests.clone(), sent.clone());
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (rc, sc, answer) = (rc.clone(), sc.clone(), answer.clone());
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while head.len() < 8192 && !head.ends_with(b"\r\n\r\n") {
                    match sock.read(&mut byte).await {
                        Ok(0) | Err(_) => return,
                        Ok(_) => head.push(byte[0]),
                    }
                }
                rc.fetch_add(1, Ordering::SeqCst);
                let line = String::from_utf8_lossy(&head).lines().next().unwrap_or("").to_string();
                let discovery = line.split(' ').nth(1).unwrap_or("").starts_with("/.well-known/");
                let reply = |mime: &str, body: Vec<u8>| {
                    let mut out = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\n\
                         Connection: close\r\n\r\n",
                        body.len()
                    )
                    .into_bytes();
                    out.extend(body);
                    out
                };
                let discovery_doc = json!({ "api": format!("http://{addr}") }).to_string().into_bytes();
                let out = match (&answer, discovery) {
                    (Answer::Missing, _) => {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                    (Answer::DiscoverThenFlood | Answer::Honest(_), true) => {
                        reply("application/json", discovery_doc)
                    }
                    (Answer::Honest(obj), false) => reply("application/octet-stream", obj.to_vec()),
                    _ => {
                        let mut filler = b"[0".to_vec();
                        while filler.len() < 65536 {
                            filler.extend_from_slice(b",0");
                        }
                        let mut chunk = format!("{:x}\r\n", filler.len()).into_bytes();
                        chunk.extend_from_slice(&filler);
                        chunk.extend_from_slice(b"\r\n");
                        let head = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                                     Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
                        if sock.write_all(head).await.is_err() {
                            return;
                        }
                        while sock.write_all(&chunk).await.is_ok() {
                            sc.fetch_add(chunk.len(), Ordering::SeqCst);
                            tokio::task::yield_now().await;
                        }
                        return;
                    }
                };
                let _ = sock.write_all(&out).await;
            });
        }
    });
    Peer { addr, requests, sent }
}

fn object(len: usize) -> (Arc<Vec<u8>>, String) {
    let obj: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
    let hash = blake3::hash(&obj).to_hex().to_string();
    (Arc::new(obj), hash)
}

async fn count(s: &Server, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&s.state.pool).await.unwrap()
}

async fn seed_cache(s: &Server, origin: &str, n: u64, size: i64, hits: i64, expires: i64) {
    sqlx::query(
        "INSERT INTO media_cache (origin, hash, mime, size, fetched_at, expires_at, hits) \
         VALUES (?, ?, 'application/octet-stream', ?, 0, ?, ?)",
    )
    .bind(origin)
    .bind(format!("{n:064x}"))
    .bind(size)
    .bind(expires)
    .bind(hits)
    .execute(&s.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn discovery_bodies_are_capped_while_honest_discovery_resolves() {
    let flood = peer(Answer::Flood).await;
    let (obj, _) = object(0);
    let good = peer(Answer::Honest(obj)).await;
    let (fa, ga) = (flood.addr, good.addr);
    let s = start_with(|cfg| {
        cfg.federation.peers.insert("flood.test".into(), format!("http://{fa}"));
        cfg.federation.peers.insert("good.test".into(), format!("http://{ga}"));
        cfg.federation.request_timeout_secs = 60;
    })
    .await;

    let started = std::time::Instant::now();
    assert!(fed::discover(&s.state, "flood.test").await.is_err());
    assert!(flood.sent.load(Ordering::SeqCst) < 16 * MIB, "discovery read is unbounded");
    assert!(started.elapsed().as_secs() < 30, "stopped on the timeout, not a ceiling");

    let resolved = fed::discover(&s.state, "good.test").await.expect("honest discovery refused");
    assert_eq!(resolved.api_base, format!("http://{ga}"));
}

#[tokio::test]
async fn unsigned_requests_naming_unknown_keys_are_rationed_outbound_fetches() {
    let target = peer(Answer::Missing).await;
    let addr = target.addr;
    let s = start_with(|cfg| {
        cfg.federation.peers.insert("victim.test".into(), format!("http://{addr}"));
        cfg.federation.request_timeout_secs = 5;
    })
    .await;
    let purge = |key_id: String| {
        let header = format!(
            "X-Telium-Federation origin=victim.test,destination=test.example,\
             key={key_id},ts={},sig=AAAA",
            now_ms()
        );
        s.client
            .post(format!("{}/_telium/v1/media/purge", s.base))
            .header(reqwest::header::AUTHORIZATION, header)
            .json(&json!({ "hash": "0".repeat(64) }))
            .send()
    };

    let _ = purge("k0".into()).await;
    assert_eq!(target.requests.load(Ordering::SeqCst), 1, "a new peer's keys were not fetched");
    for n in 1..40 {
        let _ = purge(format!("never-seen-{n}")).await;
    }
    let dialled = target.requests.load(Ordering::SeqCst);
    assert!(dialled <= 12, "forty unsigned requests became {dialled} outbound ones");
}

#[tokio::test]
async fn the_media_cache_budget_evicts_the_heavy_origin_and_leaves_small_caches_alone() {
    let far = now_ms() + 86_400_000;
    let s = start_with(|cfg| cfg.federation.media_cache_max_bytes = 1000).await;
    for n in 0..10 {
        seed_cache(&s, "loud.test", n, 200, 0, far).await;
    }
    seed_cache(&s, "quiet.test", 99, 100, 5, far).await;
    fed::media::sweep_cache(&s.state).await.unwrap();
    assert!(count(&s, "SELECT COALESCE(SUM(size), 0) FROM media_cache").await <= 1000);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_cache WHERE origin = 'quiet.test'").await, 1);

    let s = start_with(|cfg| cfg.federation.media_cache_max_bytes = 1_000_000).await;
    for n in 0..5 {
        seed_cache(&s, "ordinary.test", n, 200, 1, far).await;
    }
    seed_cache(&s, "ordinary.test", 77, 200, 1, 1).await;
    assert_eq!(fed::media::sweep_cache(&s.state).await.unwrap(), 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_cache").await, 5);
}

#[tokio::test]
async fn remote_objects_are_refused_while_arriving_and_honest_ones_are_cached() {
    let flood = peer(Answer::DiscoverThenFlood).await;
    let (obj, hash) = object(4096);
    let good = peer(Answer::Honest(obj.clone())).await;
    let (fa, ga) = (flood.addr, good.addr);
    let s = start_with(|cfg| {
        cfg.federation.peers.insert("flood.test".into(), format!("http://{fa}"));
        cfg.federation.peers.insert("good.test".into(), format!("http://{ga}"));
        cfg.media_policy.max_file_bytes = 64 * 1024;
        cfg.federation.request_timeout_secs = 60;
    })
    .await;
    let remote = |origin: &str, hash: &str| {
        s.client.get(format!("{}/_telium/v1/media/remote/{origin}/{hash}", s.base)).send()
    };

    let started = std::time::Instant::now();
    let resp = remote("flood.test", &"0".repeat(64)).await.unwrap();
    assert!(!resp.status().is_success(), "an endless remote object was served");
    assert!(started.elapsed().as_secs() < 30, "stopped on the timeout, not on size");
    assert!(flood.sent.load(Ordering::SeqCst) < 2 * MIB, "object read is unbounded");

    let refused = fed::get_signed_bytes(&s.state, "flood.test", "/_telium/v1/media/x", None)
        .await
        .expect_err("an endless body was accepted");
    assert!(refused.to_string().contains("more than"), "{refused}");
    assert!(flood.sent.load(Ordering::SeqCst) < 4 * MIB);

    let resp = remote("good.test", &hash).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.bytes().await.unwrap().to_vec(), *obj);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_cache WHERE origin = 'good.test'").await, 1);
}

#[tokio::test]
async fn an_origin_at_its_cache_share_is_served_but_not_cached_again() {
    let (obj, hash) = object(4096);
    let good = peer(Answer::Honest(obj)).await;
    let addr = good.addr;
    let s = start_with(|cfg| {
        cfg.federation.media_cache_max_bytes = 32 * 1024;
        cfg.federation.peers.insert("greedy.test".into(), format!("http://{addr}"));
    })
    .await;
    seed_cache(&s, "greedy.test", 1, 8 * 1024, 0, now_ms() + 86_400_000).await;
    let resp = s
        .client
        .get(format!("{}/_telium/v1/media/remote/greedy.test/{hash}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM media_cache WHERE origin = 'greedy.test'").await, 1);
}

#[tokio::test]
async fn withdrawn_keys_are_pruned_and_oversized_key_documents_leave_nothing_behind() {
    fn key(id: &str) -> ServerKey {
        ServerKey {
            key_id: id.into(),
            signing: ed25519_dalek::SigningKey::from_bytes(&rand::random()),
            valid_from: 0,
            valid_until: i64::MAX,
        }
    }
    fn document(signer: &ServerKey, keys: &[&ServerKey]) -> Value {
        let verify_keys: serde_json::Map<String, Value> = std::iter::once(signer)
            .chain(keys.iter().copied())
            .map(|k| {
                let entry = json!({ "key": k.public_b64(), "valid_from": 0, "valid_until": i64::MAX });
                (k.key_id.clone(), entry)
            })
            .collect();
        crypto::sign_json(signer, json!({ "server_name": "peer.test", "verify_keys": verify_keys }))
    }

    let current = key("ed25519:current");
    let extra = key("ed25519:extra");
    let doc = Arc::new(Mutex::new(document(&current, &[&extra])));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let served = doc.clone();
    let app = axum::Router::new().route(
        "/_telium/v1/keys",
        axum::routing::get(move || {
            let doc = served.clone();
            async move { axum::Json(doc.lock().unwrap().clone()) }
        }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app.into_make_service()).await;
    });
    let s = start_with(|_| {}).await;
    sqlx::query(
        "INSERT INTO remote_servers (origin, api_base, gateway, fetched_at, failures) \
         VALUES ('peer.test', ?, NULL, ?, 0)",
    )
    .bind(format!("http://{addr}"))
    .bind(now_ms())
    .execute(&s.state.pool)
    .await
    .unwrap();
    let st = &s.state;

    fed::refresh_keys(st, "peer.test").await.unwrap();
    assert_eq!(fed::verify_key(st, "peer.test", &extra.key_id).await, Some(extra.public_b64()));

    *doc.lock().unwrap() = document(&current, &[]);
    fed::refresh_keys(st, "peer.test").await.unwrap();
    assert_eq!(fed::verify_key(st, "peer.test", &extra.key_id).await, None);
    assert_eq!(fed::verify_key_at(st, "peer.test", &extra.key_id, now_ms() - 1000).await, None);
    assert_eq!(fed::verify_key(st, "peer.test", &current.key_id).await, Some(current.public_b64()));

    let many: Vec<ServerKey> = (0..500).map(|i| key(&format!("ed25519:k{i}"))).collect();
    *doc.lock().unwrap() = document(&current, &many.iter().collect::<Vec<_>>());
    let refused = fed::refresh_keys(st, "peer.test").await.unwrap_err();
    assert!(refused.to_string().contains("more than"), "{refused}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM remote_keys WHERE origin = 'peer.test'").await, 1);
    assert_eq!(fed::verify_key(st, "peer.test", &current.key_id).await, Some(current.public_b64()));
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { (self.next() % n as u64) as usize }
    }
}

fn mangled(seed: &str, rng: &mut Rng) -> String {
    const SPICY: &[u8] = b"=,. \t\r\n\"\\{}[]:/+-0\x00\x7f\xff";
    let mut bytes = seed.as_bytes().to_vec();
    for _ in 0..1 + rng.below(6) {
        if bytes.is_empty() {
            bytes.push(b'x');
            continue;
        }
        let at = rng.below(bytes.len());
        match rng.below(7) {
            0 => bytes[at] = rng.next() as u8,
            1 => bytes[at] = SPICY[rng.below(SPICY.len())],
            2 => bytes.truncate(at),
            3 => {
                bytes.remove(at);
            }
            4 => bytes.insert(at, SPICY[rng.below(SPICY.len())]),
            5 => {
                let end = (at + 1 + rng.below(bytes.len() - at)).min(bytes.len());
                let run: Vec<u8> = bytes[at..end].iter().copied().take(512).collect();
                let into = rng.below(bytes.len());
                bytes.splice(into..into, run);
            }
            _ => {
                let run = vec![bytes[at]; 1 + rng.below(4096)];
                bytes.splice(at..at, run);
            }
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

#[tokio::test]
async fn mangled_envelopes_and_assertions_never_panic_or_bypass_binding() {
    const ROUNDS: usize = 5_000;
    let s = start_with(|_| {}).await;

    let seed = fed::auth_header(&s.state.key, "POST", "/_telium/v1/media/authorize",
        br#"{"hash":"nothing"}"#, "attacker.test", "test.example");
    let (mut rng, mut accepted) = (Rng(0x5eed_fed_0001), 0);
    for round in 0..ROUNDS {
        let header = mangled(&seed, &mut rng);
        let Ok(origin) = check_envelope(&s.state, &header) else { continue };
        accepted += 1;
        assert!(header.contains("test.example"), "round {round}: misaddressed {header:?}");
        assert_eq!(normalise_origin(&origin), origin, "round {round}: {header:?}");
    }
    assert!(accepted > 0, "no mangled envelope reached the parser");

    let now = now_ms();
    let token = crypto::issue_assertion(&s.state.key, &AssertionClaims {
        user_id: "@alice:issuer.test".into(),
        device_id: "dev-1".into(),
        device_pubkey: "AAAA".into(),
        audience: "guild.test".into(),
        origin: "issuer.test".into(),
        profile_version: 1,
        display_name: "Alice".into(),
        avatar_ref: None,
        iat: now,
        exp: now + 300_000,
    });
    let public = s.state.key.public_b64();
    let (mut rng, mut accepted) = (Rng(0xa55e_1710_0002), 0);
    for round in 0..ROUNDS {
        let t = mangled(&token, &mut rng);
        let Ok(got) = crypto::verify_assertion(&t, "guild.test", |_, _| Some(public.clone())) else {
            continue;
        };
        accepted += 1;
        assert_eq!(got.audience, "guild.test", "round {round}");
        assert!(got.exp > now_ms(), "round {round}: expired assertion accepted");
    }
    assert!(accepted > 0, "no mangled assertion reached the parser");
}
