
use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use telium_server::backup::drill::{self, Failure, Verdict};
use telium_server::backup::{self, Placement, Source};
use telium_server::config::{Config, Remote};

static COUNTER: AtomicU32 = AtomicU32::new(0);

const BUCKET: &str = "telium-backups";
const ACCESS_KEY: &str = "AKIATESTTESTTESTTEST";
const SECRET_KEY: &str = "not-a-real-secret/but-long-enough-to-look-like-one";
const REGION: &str = "us-east-1";

fn fresh_dir(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-backup-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[derive(Default)]
struct Store {
    bucket_exists: bool,
    objects: BTreeMap<String, Vec<u8>>,
    uploads: HashMap<String, BTreeMap<u32, (String, Vec<u8>)>>,
    next_upload: u32,
    log: Vec<String>,
    fail_next: u32,
    deny: bool,
    bad_signatures: Vec<String>,
}

#[derive(Clone)]
struct FakeS3 {
    store: Arc<Mutex<Store>>,
    page_size: usize,
}

impl FakeS3 {
    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap()
    }
}

async fn start_fake_s3(page_size: usize) -> (FakeS3, String) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let fake = FakeS3 { store: Arc::new(Mutex::new(Store::default())), page_size };
    let app = Router::new().fallback(s3_handle).with_state(fake.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (fake, format!("http://{addr}"))
}

fn xml(status: StatusCode, body: String) -> Response {
    (status, [("content-type", "application/xml")], body).into_response()
}

fn s3_error(status: StatusCode, code: &str) -> Response {
    xml(status, format!("<?xml version=\"1.0\"?><Error><Code>{code}</Code><Message>{code}</Message></Error>"))
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn verify_signature(method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| format!("missing header {name}"))
    };
    let auth = header("authorization")?;
    let auth = auth.strip_prefix("AWS4-HMAC-SHA256 ").ok_or("not a SigV4 authorization header")?;
    let (mut credential, mut signed_headers, mut signature) = (None, None, None);
    for part in auth.split(',') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("Credential=") {
            credential = Some(v.to_string());
        } else if let Some(v) = part.strip_prefix("SignedHeaders=") {
            signed_headers = Some(v.to_string());
        } else if let Some(v) = part.strip_prefix("Signature=") {
            signature = Some(v.to_string());
        }
    }
    let credential = credential.ok_or("no Credential")?;
    let signed_headers = signed_headers.ok_or("no SignedHeaders")?;
    let signature = signature.ok_or("no Signature")?;
    let scope: Vec<&str> = credential.split('/').collect();
    let [access, date, region, service, terminal] = scope[..] else {
        return Err(format!("malformed credential scope {credential}"));
    };
    if access != ACCESS_KEY {
        return Err(format!("unknown access key {access}"));
    }
    if region != REGION || service != "s3" || terminal != "aws4_request" {
        return Err(format!("bad scope {credential}"));
    }
    let amz_date = header("x-amz-date")?;
    if !amz_date.starts_with(date) || amz_date.len() != 16 || !amz_date.ends_with('Z') {
        return Err(format!("x-amz-date {amz_date} does not match scope date {date}"));
    }
    let content_sha = header("x-amz-content-sha256")?;
    if content_sha != hex::encode(Sha256::digest(body)) {
        return Err("x-amz-content-sha256 does not match the body".into());
    }
    for required in ["host", "x-amz-content-sha256", "x-amz-date"] {
        if !signed_headers.split(';').any(|h| h == required) {
            return Err(format!("{required} is not a signed header"));
        }
    }
    let mut canonical_headers = String::new();
    for name in signed_headers.split(';') {
        canonical_headers.push_str(&format!("{name}:{}\n", header(name)?.trim()));
    }
    let mut query: Vec<(String, String)> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (k.to_string(), v.to_string())
        })
        .collect();
    query.sort();
    let canonical_query = query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let canonical_request = format!(
        "{}\n{}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{content_sha}",
        method.as_str(),
        uri.path()
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{date}/{REGION}/s3/aws4_request\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k = hmac_sha256(format!("AWS4{SECRET_KEY}").as_bytes(), date.as_bytes());
    let k = hmac_sha256(&k, REGION.as_bytes());
    let k = hmac_sha256(&k, b"s3");
    let k = hmac_sha256(&k, b"aws4_request");
    let expected = hex::encode(hmac_sha256(&k, string_to_sign.as_bytes()));
    if expected != signature {
        return Err("signature mismatch".into());
    }
    Ok(())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn etag_for(bytes: &[u8]) -> String {
    format!("\"{}\"", &hex::encode(Sha256::digest(bytes))[..32])
}

async fn s3_handle(State(fake): State<FakeS3>, req: Request) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let headers = req.headers().clone();
    let body: Bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(_) => return s3_error(StatusCode::BAD_REQUEST, "IncompleteBody"),
    };
    let mut store = fake.store();
    let line = format!("{method} {}", uri.path_and_query().map(|p| p.to_string()).unwrap_or_default());
    store.log.push(line.clone());
    if store.fail_next > 0 {
        store.fail_next -= 1;
        return s3_error(StatusCode::SERVICE_UNAVAILABLE, "SlowDown");
    }
    if store.deny {
        return s3_error(StatusCode::FORBIDDEN, "AccessDenied");
    }
    if let Err(reason) = verify_signature(&method, &uri, &headers, &body) {
        store.bad_signatures.push(format!("{line}: {reason}"));
        return s3_error(StatusCode::FORBIDDEN, "SignatureDoesNotMatch");
    }
    let query: HashMap<String, String> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter(|kv| !kv.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect();
    let path = percent_decode(uri.path().trim_start_matches('/'));
    let path = path.as_str();
    let (bucket, key) = match path.split_once('/') {
        Some((b, k)) => (b, Some(k.to_string())),
        None => (path, None),
    };
    if bucket != BUCKET {
        return s3_error(StatusCode::NOT_FOUND, "NoSuchBucket");
    }
    match (method, key) {
        (Method::HEAD, None) => {
            if store.bucket_exists {
                StatusCode::OK.into_response()
            } else {
                StatusCode::NOT_FOUND.into_response()
            }
        }
        (Method::PUT, None) => {
            store.bucket_exists = true;
            StatusCode::OK.into_response()
        }
        (Method::GET, None) => {
            if query.get("list-type").map(String::as_str) != Some("2") {
                return s3_error(StatusCode::BAD_REQUEST, "InvalidRequest");
            }
            let prefix = query.get("prefix").cloned().unwrap_or_default();
            let start: usize = query.get("continuation-token").and_then(|t| t.parse().ok()).unwrap_or(0);
            let keys: Vec<&String> = store.objects.keys().filter(|k| k.starts_with(&prefix)).collect();
            let page: Vec<&String> = keys.iter().skip(start).take(fake.page_size).copied().collect();
            let truncated = start + page.len() < keys.len();
            let mut out = String::from(
                "<?xml version=\"1.0\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
            );
            out.push_str(&format!("<Name>{BUCKET}</Name><Prefix>{prefix}</Prefix><KeyCount>{}</KeyCount>", page.len()));
            out.push_str(&format!("<IsTruncated>{truncated}</IsTruncated>"));
            if truncated {
                out.push_str(&format!("<NextContinuationToken>{}</NextContinuationToken>", start + page.len()));
            }
            for k in page {
                let size = store.objects[k].len();
                out.push_str(&format!(
                    "<Contents><Key>{k}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                     <ETag>{}</ETag><Size>{size}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                    etag_for(&store.objects[k])
                ));
            }
            out.push_str("</ListBucketResult>");
            xml(StatusCode::OK, out)
        }
        (_, _) if !store.bucket_exists => s3_error(StatusCode::NOT_FOUND, "NoSuchBucket"),
        (Method::PUT, Some(key)) => {
            if let (Some(number), Some(upload_id)) = (query.get("partNumber"), query.get("uploadId")) {
                let number: u32 = number.parse().unwrap_or(0);
                let Some(parts) = store.uploads.get_mut(&format!("{key}:{upload_id}")) else {
                    return s3_error(StatusCode::NOT_FOUND, "NoSuchUpload");
                };
                let etag = etag_for(&body);
                parts.insert(number, (etag.clone(), body.to_vec()));
                return (StatusCode::OK, [("etag", etag)]).into_response();
            }
            store.objects.insert(key, body.to_vec());
            (StatusCode::OK, [("etag", etag_for(&body))]).into_response()
        }
        (Method::POST, Some(key)) if query.contains_key("uploads") => {
            store.next_upload += 1;
            let upload_id = format!("upload-{}", store.next_upload);
            store.uploads.insert(format!("{key}:{upload_id}"), BTreeMap::new());
            xml(
                StatusCode::OK,
                format!(
                    "<?xml version=\"1.0\"?><InitiateMultipartUploadResult><Bucket>{BUCKET}</Bucket>\
                     <Key>{key}</Key><UploadId>{upload_id}</UploadId></InitiateMultipartUploadResult>"
                ),
            )
        }
        (Method::POST, Some(key)) if query.contains_key("uploadId") => {
            let upload_id = &query["uploadId"];
            let Some(parts) = store.uploads.remove(&format!("{key}:{upload_id}")) else {
                return s3_error(StatusCode::NOT_FOUND, "NoSuchUpload");
            };
            let text = String::from_utf8_lossy(&body).to_string();
            let claimed: Vec<(u32, String)> = telium_server::backup::s3::xml_blocks(&text, "Part")
                .into_iter()
                .map(|p| {
                    (
                        telium_server::backup::s3::xml_tag(p, "PartNumber").and_then(|n| n.parse().ok()).unwrap_or(0),
                        telium_server::backup::s3::xml_tag(p, "ETag").unwrap_or_default(),
                    )
                })
                .collect();
            let stored: Vec<(u32, String)> = parts.iter().map(|(n, (etag, _))| (*n, etag.clone())).collect();
            if claimed != stored {
                return s3_error(StatusCode::BAD_REQUEST, "InvalidPart");
            }
            let mut whole = Vec::new();
            for (_, (_, bytes)) in parts {
                whole.extend_from_slice(&bytes);
            }
            store.objects.insert(key.clone(), whole);
            xml(
                StatusCode::OK,
                format!(
                    "<?xml version=\"1.0\"?><CompleteMultipartUploadResult><Bucket>{BUCKET}</Bucket>\
                     <Key>{key}</Key></CompleteMultipartUploadResult>"
                ),
            )
        }
        (Method::DELETE, Some(key)) if query.contains_key("uploadId") => {
            store.uploads.remove(&format!("{key}:{}", query["uploadId"]));
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::DELETE, Some(key)) => {
            store.objects.remove(&key);
            StatusCode::NO_CONTENT.into_response()
        }
        (Method::GET, Some(key)) => match store.objects.get(&key) {
            Some(bytes) => match parse_range(headers.get("range"), bytes.len()) {
                None => (StatusCode::OK, bytes.clone()).into_response(),
                Some((start, end)) => (
                    StatusCode::PARTIAL_CONTENT,
                    [("content-range", format!("bytes {start}-{end}/{}", bytes.len()))],
                    bytes[start..=end].to_vec(),
                )
                    .into_response(),
            },
            None => s3_error(StatusCode::NOT_FOUND, "NoSuchKey"),
        },
        (Method::HEAD, Some(key)) => {
            if store.objects.contains_key(&key) {
                StatusCode::OK.into_response()
            } else {
                StatusCode::NOT_FOUND.into_response()
            }
        }
        _ => s3_error(StatusCode::BAD_REQUEST, "InvalidRequest"),
    }
}

struct Server {
    base: String,
    dir: PathBuf,
    client: reqwest::Client,
    state: telium_server::AppState,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn point_at(cfg: &mut Config, dir: &Path) {
    cfg.database_url = format!("sqlite://{}/telium.db?mode=rwc", dir.display());
    cfg.media_dir = dir.join("media");
    cfg.archive.dir = dir.join("cold");
    cfg.backup.dir = dir.join("backups");
    cfg.backup.key_file = dir.join("backup.key");
}

fn with_remote(cfg: &mut Config, endpoint: &str) {
    cfg.backup.remote = Remote {
        enabled: true,
        endpoint: endpoint.to_string(),
        bucket: BUCKET.into(),
        region: REGION.into(),
        access_key_id: ACCESS_KEY.into(),
        secret_access_key: SECRET_KEY.into(),
        ..Remote::default()
    };
}

async fn start(tweak: impl FnOnce(&mut Config)) -> Server {
    let dir = fresh_dir("server");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: "test.example".into(),
        public_base_url: format!("http://{addr}"),
        ..Config::default()
    };
    point_at(&mut cfg, &dir);
    cfg.backup.enabled = true;
    cfg.backup.keep = 2;
    tweak(&mut cfg);
    cfg.validate().unwrap();

    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>())
            .await
            .unwrap();
    });
    Server { base: format!("http://{addr}"), dir, client: reqwest::Client::new(), state }
}

struct Account {
    user_id: String,
    token: String,
}

impl Server {
    fn cfg(&self) -> &Config {
        &self.state.cfg
    }

    async fn register(&self, localpart: &str) -> Account {
        let resp = self
            .client
            .post(format!("{}/_telium/v1/register", self.base))
            .json(&json!({ "localpart": localpart, "password": "correct horse battery staple" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
        let v: Value = resp.json().await.unwrap();
        Account { user_id: v["user_id"].as_str().unwrap().into(), token: v["access_token"].as_str().unwrap().into() }
    }

    async fn admin_status(&self, token: &str) -> (u16, Value) {
        let resp = self
            .client
            .get(format!("{}/_telium/v1/admin/status", self.base))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    fn keygen(&self) -> backup::Key {
        backup::keygen(&self.cfg().backup.key_file).unwrap()
    }

    async fn backup(&self) -> backup::Outcome {
        let out = backup::run_once(&self.state.pool, self.cfg()).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        out
    }
}

fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

fn seed_files(cfg: &Config) -> Vec<(String, Vec<u8>)> {
    let root = cfg.media_dir.parent().unwrap();
    let files = vec![
        ("cold/segments/0001.seg".to_string(), noise(1, 40_000)),
        ("cold/segments/0002.seg".to_string(), noise(2, 12_345)),
        ("cold/index.json".to_string(), br#"{"segments":2}"#.to_vec()),
        ("media/ab/cd/attachment.bin".to_string(), noise(3, 2_600_000)),
        ("media/ab/ef/avatar.png".to_string(), noise(4, 7_777)),
        ("media/empty.txt".to_string(), Vec::new()),
    ];
    for (rel, bytes) in &files {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
    for rel in ["media/cache/remote-thumb.bin", "media/camo/proxied.jpg"] {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"re-fetchable").unwrap();
    }
    files
}

fn parse_range(header: Option<&axum::http::HeaderValue>, len: usize) -> Option<(usize, usize)> {
    let spec = header?.to_str().ok()?.strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    let start: usize = start.parse().ok()?;
    let end: usize = if end.is_empty() { len.saturating_sub(1) } else { end.parse().ok()? };
    if start > end || end >= len {
        return None;
    }
    Some((start, end))
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn second_box(from: &Config) -> (Config, PathBuf) {
    let dir = fresh_dir("restore");
    let mut cfg = from.clone();
    point_at(&mut cfg, &dir);
    (cfg, dir)
}

async fn localpart_of(cfg: &Config, user_id: &str) -> Option<String> {
    let pool = telium_server::db::connect(&cfg.database_url).await.unwrap();
    let row = sqlx::query_scalar("SELECT localpart FROM accounts WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&pool)
        .await
        .unwrap();
    pool.close().await;
    row
}

fn assert_files_restored(dir: &Path, seeded: &[(String, Vec<u8>)]) {
    for (rel, bytes) in seeded {
        let got = std::fs::read(dir.join(rel)).unwrap_or_else(|e| panic!("{rel} missing after restore: {e}"));
        assert!(got == *bytes, "{rel} differs after restore");
    }
    assert!(!dir.join("media/cache").exists(), "the media cache is not part of a backup");
    assert!(!dir.join("media/camo").exists(), "the camo cache is not part of a backup");
}

#[tokio::test]
async fn a_local_archive_rebuilds_rows_cold_segments_and_media() {
    let s = start(|_| {}).await;
    let alice = s.register("alice").await;
    let seeded = seed_files(s.cfg());
    let key = s.keygen();

    let out = s.backup().await;
    assert_eq!(out.path.extension().and_then(|e| e.to_str()), Some("tbk"));
    assert!(out.remote_key.is_none() && out.remote_error.is_none(), "no remote is configured");
    let m = &out.manifest;
    assert_eq!(m.server_name, "test.example");
    assert_eq!(m.schema_version, telium_server::db::latest_migration_version());
    let kinds: Vec<(&str, u64)> = m.parts.iter().map(|p| (p.kind.as_str(), p.files)).collect();
    assert_eq!(kinds, [("database", 1), ("cold", 3), ("media", 3)], "{:?}", m.parts);
    assert!(m.payload_bytes > 2_600_000, "the media bytes are in there: {}", m.payload_bytes);

    let raw = std::fs::read(&out.path).unwrap();
    assert!(raw.starts_with(b"TELIUMBK"));
    assert!(!contains(&raw, b"telium.db"));
    assert!(!contains(&raw, b"alice"));
    assert!(!contains(&raw, b"attachment.bin"));

    assert_eq!(backup::verify(&out.path, &key).unwrap(), out.manifest);
    let report = backup::report(s.cfg());
    assert_eq!(report["enabled"], true);
    assert_eq!(report["encrypted"], true);
    assert_eq!(report["stale"], false);
    assert_eq!(report["remote"]["enabled"], false);
    assert!(report["age_ms"].as_i64().unwrap() < 60_000);

    let latest = backup::fetch(s.cfg(), &Source::parse("latest")).await.unwrap();
    assert_eq!(latest.path, out.path);

    let (cfg2, dir2) = second_box(s.cfg());
    let source = Source::parse(out.path.to_str().unwrap());
    let restored = backup::restore(&cfg2, &source, &backup::Keyring::of(key), false).await.unwrap();
    assert!(restored.moved_aside.is_empty(), "nothing was there to move aside");
    assert_eq!(restored.db_path, dir2.join("telium.db"));
    assert_eq!(restored.media_dir.as_deref(), Some(dir2.join("media").as_path()));
    assert_eq!(restored.cold_dir.as_deref(), Some(dir2.join("cold").as_path()));
    assert_eq!(localpart_of(&cfg2, &alice.user_id).await.as_deref(), Some("alice"));
    assert_files_restored(&dir2, &seeded);
    let leftovers: Vec<_> = std::fs::read_dir(&dir2)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".telium-restore"))
        .collect();
    assert!(leftovers.is_empty(), "staging directory was left behind: {leftovers:?}");
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn archives_go_to_the_bucket_are_pruned_there_and_come_back_from_s3_latest() {
    let (fake, endpoint) = start_fake_s3(2).await;
    let s = start(|cfg| {
        with_remote(cfg, &endpoint);
        cfg.backup.remote.keep = 2;
        cfg.backup.keep = 1;
    })
    .await;
    let alice = s.register("alice").await;
    let seeded = seed_files(s.cfg());
    let key = s.keygen();
    let prefix = "telium/test.example/";

    let mut outcomes = Vec::new();
    for _ in 0..3 {
        let out = s.backup().await;
        assert!(out.remote_error.is_none(), "upload failed: {:?}", out.remote_error);
        let remote_key = out.remote_key.clone().expect("uploaded");
        assert_eq!(remote_key, format!("{prefix}{}", out.path.file_name().unwrap().to_string_lossy()));
        outcomes.push(out);
    }

    {
        let store = fake.store();
        assert!(store.bad_signatures.is_empty(), "{:?}", store.bad_signatures);
        assert!(store.bucket_exists, "the bucket was created on first use");
        let keys: Vec<&String> = store.objects.keys().collect();
        let expected: Vec<String> = outcomes[1..].iter().map(|o| o.remote_key.clone().unwrap()).collect();
        assert_eq!(keys, expected.iter().collect::<Vec<_>>(), "the oldest of three was pruned, keep = 2");
        let newest = &outcomes[2];
        assert_eq!(
            store.objects[newest.remote_key.as_ref().unwrap()],
            std::fs::read(&newest.path).unwrap(),
            "bucket bytes equal disk bytes"
        );
        let ops = |needle: &str| store.log.iter().filter(|l| l.contains(needle)).count();
        assert_eq!(ops(&format!("HEAD /{BUCKET}")), 3, "one bucket check per run");
        assert_eq!(store.log.iter().filter(|l| **l == format!("PUT /{BUCKET}")).count(), 1, "one CreateBucket");
        assert_eq!(ops("DELETE "), 1);
        assert!(ops("continuation-token=") >= 1, "three objects at two per page needs a second page: {:?}", store.log);
    }
    assert_eq!(backup::local_archives(&s.cfg().backup.dir).len(), 1);

    let status = backup::read_status(&s.cfg().backup.dir);
    assert!(status.last_remote_at.is_some());
    assert_eq!(status.last_remote_key, outcomes[2].remote_key);
    assert!(status.last_error.is_none() && status.last_remote_error.is_none());
    let report = backup::report(s.cfg());
    assert_eq!(report["remote"]["enabled"], true);
    assert_eq!(report["remote"]["stale"], false);
    assert_eq!(report["stale"], false);
    assert!(report["remote"]["age_ms"].as_i64().unwrap() < 60_000);

    let client = backup::remote(s.cfg()).unwrap().unwrap();
    let listed = backup::remote_archives(&client, prefix).await.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed[0].1 < listed[1].1, "oldest first");

    let (cfg2, dir2) = second_box(s.cfg());
    let restored =
        backup::restore(&cfg2, &Source::parse("s3://latest"), &backup::Keyring::of(key), false).await.unwrap();
    assert_eq!(restored.source, format!("s3://{BUCKET}/{}", outcomes[2].remote_key.as_ref().unwrap()));
    assert_eq!(restored.manifest, outcomes[2].manifest);
    assert_eq!(localpart_of(&cfg2, &alice.user_id).await.as_deref(), Some("alice"));
    assert_files_restored(&dir2, &seeded);
    let downloads: Vec<_> = std::fs::read_dir(&cfg2.backup.dir)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect())
        .unwrap_or_default();
    assert!(downloads.iter().all(|n| !n.starts_with(".fetch-")), "downloaded copy was cleaned up: {downloads:?}");

    let name = outcomes[1].path.file_name().unwrap().to_string_lossy().to_string();
    let by_name = backup::fetch(&cfg2, &Source::parse(&format!("s3://{name}"))).await.unwrap();
    assert_eq!(backup::peek(&by_name.path, &key).unwrap(), outcomes[1].manifest);
    let by_key = backup::fetch(&cfg2, &Source::parse(&format!("s3://{prefix}{name}"))).await.unwrap();
    assert_eq!(backup::verify(&by_key.path, &key).unwrap(), outcomes[1].manifest);
    assert!(fake.store().bad_signatures.is_empty());
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn big_uploads_go_in_parts_and_the_client_speaks_the_rest_of_the_protocol() {
    let (fake, endpoint) = start_fake_s3(100).await;
    let mut remote = Remote::default();
    with_remote_only(&mut remote, &endpoint);
    let mut client = backup::S3Client::from_config(&remote).unwrap();
    client.multipart_threshold = 1000;
    client.part_size = 700;

    assert!(client.ensure_bucket().await.unwrap(), "created");
    assert!(!client.ensure_bucket().await.unwrap(), "already there");

    let dir = fresh_dir("multipart");
    let big = dir.join("big.bin");
    let big_bytes = noise(9, 2500);
    std::fs::write(&big, &big_bytes).unwrap();
    client.upload_file("telium/x/big.bin", &big, None).await.unwrap();
    let small = dir.join("small.bin");
    let small_bytes = noise(10, 500);
    std::fs::write(&small, &small_bytes).unwrap();
    client.upload_file("telium/x/small.bin", &small, None).await.unwrap();
    {
        let store = fake.store();
        assert!(store.bad_signatures.is_empty(), "{:?}", store.bad_signatures);
        assert_eq!(store.objects["telium/x/big.bin"], big_bytes, "four parts reassembled in order");
        assert_eq!(store.objects["telium/x/small.bin"], small_bytes);
        assert!(store.uploads.is_empty(), "no multipart upload left open");
        let ops = |needle: &str| store.log.iter().filter(|l| l.contains(needle)).count();
        assert_eq!(ops("/big.bin?uploads="), 1, "{:?}", store.log);
        assert_eq!(ops("partNumber="), 4, "2500 bytes in 700-byte parts");
        assert_eq!(ops("POST /telium-backups/telium/x/big.bin?uploadId="), 1);
        assert_eq!(ops("PUT /telium-backups/telium/x/small.bin"), 1, "below the threshold is one PUT");
    }

    let listed = client.list("telium/x/").await.unwrap();
    let mut sizes: Vec<(String, u64)> = listed.iter().map(|o| (o.key.clone(), o.size)).collect();
    sizes.sort();
    assert_eq!(sizes, [("telium/x/big.bin".to_string(), 2500), ("telium/x/small.bin".to_string(), 500)]);

    let dest = dir.join("down.bin");
    let (n, sha) = client.download("telium/x/big.bin", &dest).await.unwrap();
    assert_eq!(n, 2500);
    assert_eq!(sha, <[u8; 32]>::from(Sha256::digest(&big_bytes)));
    assert_eq!(std::fs::read(&dest).unwrap(), big_bytes);

    fake.store().fail_next = 2;
    let began = std::time::Instant::now();
    client.delete("telium/x/big.bin").await.unwrap();
    assert!(began.elapsed() >= std::time::Duration::from_millis(1400), "0.5 s then 1 s of backoff");
    assert_eq!(fake.store().log.iter().filter(|l| l.starts_with("DELETE ")).count(), 3, "two failures, one success");
    assert_eq!(client.list("telium/x/").await.unwrap().len(), 1);
    match client.download("telium/x/big.bin", &dest).await {
        Err(backup::s3::S3Error::Status { status: 404, .. }) => {}
        other => panic!("expected 404 for a deleted object, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

fn age_last_remote(cfg: &Config, by_ms: i64) {
    let dir = &cfg.backup.dir;
    let mut status = backup::read_status(dir);
    let at = status.last_remote_at.expect("an upload has already succeeded");
    status.last_remote_at = Some(at - by_ms);
    std::fs::write(dir.join("status.json"), serde_json::to_vec(&status).unwrap()).unwrap();
}

fn with_remote_only(remote: &mut Remote, endpoint: &str) {
    let mut cfg = Config::default();
    with_remote(&mut cfg, endpoint);
    *remote = cfg.backup.remote;
}

#[tokio::test]
async fn a_failing_remote_makes_the_backup_stale_even_with_a_fresh_disk_copy() {
    let (fake, endpoint) = start_fake_s3(100).await;
    let s = start(|cfg| {
        with_remote(cfg, &endpoint);
        cfg.backup.stale_after_secs = 60;
    })
    .await;
    let alice = s.register("alice").await;
    s.keygen();

    let out = s.backup().await;
    assert!(out.remote_error.is_none());
    assert_eq!(backup::report(s.cfg())["stale"], false);

    fake.store().deny = true;
    age_last_remote(s.cfg(), 3_600_000);
    let out = s.backup().await;
    assert!(out.path.is_file(), "the local snapshot is still taken");
    let err = out.remote_error.clone().expect("the upload failed");
    assert!(err.contains("403"), "{err}");

    let report = backup::report(s.cfg());
    assert!(report["age_ms"].as_i64().unwrap() < 10_000, "the disk copy is seconds old");
    assert_eq!(report["remote"]["stale"], true, "{report}");
    assert_eq!(report["stale"], true, "the off-box copy going quiet is what the flag is for");
    assert!(report["remote"]["last_error"].as_str().unwrap().contains("403"));
    assert!(report["last_error"].as_str().unwrap().contains("upload failed"));

    let (code, body) = s.admin_status(&alice.token).await;
    assert_eq!(code, 200, "{body}");
    let b = &body["backup"];
    assert_eq!(b["enabled"], true);
    assert_eq!(b["encrypted"], true);
    assert_eq!(b["stale"], true);
    assert_eq!(b["remote"]["enabled"], true);
    assert_eq!(b["remote"]["stale"], true);
    assert!(b["remote"]["last_error"].is_string());

    fake.store().deny = false;
    let out = s.backup().await;
    assert!(out.remote_error.is_none());
    let report = backup::report(s.cfg());
    assert_eq!(report["stale"], false);
    assert!(report["remote"]["last_error"].is_null());
    assert!(report["last_error"].is_null());
}

#[tokio::test]
async fn restore_refuses_the_wrong_key_an_occupied_box_and_an_open_database() {
    let s = start(|_| {}).await;
    let alice = s.register("alice").await;
    seed_files(s.cfg());
    let key = s.keygen();
    let out = s.backup().await;
    let source = Source::parse(out.path.to_str().unwrap());
    let (cfg2, dir2) = second_box(s.cfg());
    let db2 = dir2.join("telium.db");

    let err = backup::restore(&cfg2, &source, &backup::Keyring::of([7u8; 32]), true).await.unwrap_err().to_string();
    assert!(err.contains("none of the 1 configured backup key"), "{err}");
    assert!(err.contains("previous_key_files"), "{err}");
    assert!(!db2.exists(), "nothing written under the wrong key");
    assert_eq!(std::fs::read_dir(&dir2).unwrap().count(), 0, "no staging left behind");

    let truncated = dir2.join("cut.tbk");
    let raw = std::fs::read(&out.path).unwrap();
    std::fs::write(&truncated, &raw[..raw.len() - 40]).unwrap();
    let err = backup::verify(&truncated, &key).unwrap_err().to_string();
    assert!(err.contains("truncated"), "{err}");
    let err = backup::restore(&cfg2, &Source::parse(truncated.to_str().unwrap()), &backup::Keyring::of(key), true)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("truncated"), "{err}");
    assert!(!db2.exists() && !dir2.join("media").exists());
    std::fs::remove_file(&truncated).unwrap();

    std::fs::write(&db2, b"the old database").unwrap();
    let err = backup::restore(&cfg2, &source, &backup::Keyring::of(key), false).await.unwrap_err().to_string();
    assert!(err.contains("--yes"), "{err}");
    assert_eq!(std::fs::read(&db2).unwrap(), b"the old database");

    let wal = dir2.join("telium.db-wal");
    std::fs::write(&wal, b"").unwrap();
    let err = backup::restore(&cfg2, &source, &backup::Keyring::of(key), true).await.unwrap_err().to_string();
    assert!(err.contains("-wal"), "{err}");
    assert_eq!(std::fs::read(&db2).unwrap(), b"the old database");
    std::fs::remove_file(&wal).unwrap();

    let restored = backup::restore(&cfg2, &source, &backup::Keyring::of(key), true).await.unwrap();
    assert_eq!(restored.moved_aside.len(), 1, "{:?}", restored.moved_aside);
    let parked = &restored.moved_aside[0];
    assert!(parked.to_string_lossy().contains("telium.db.pre-restore-"));
    assert_eq!(std::fs::read(parked).unwrap(), b"the old database", "moved aside, not deleted");
    assert_eq!(localpart_of(&cfg2, &alice.user_id).await.as_deref(), Some("alice"));
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn keys_are_private_and_never_overwritten() {
    let dir = fresh_dir("keys");
    let path = dir.join("nested/backup.key");
    let key = backup::keygen(&path).unwrap();
    assert_eq!(backup::read_key_file(&path).unwrap(), Some(key));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let err = backup::keygen(&path).unwrap_err().to_string();
    assert!(err.contains("already exists"), "{err}");
    assert_eq!(backup::read_key_file(&path).unwrap(), Some(key), "the first key survived");

    std::fs::write(&path, "not base64!").unwrap();
    assert!(backup::read_key_file(&path).is_err(), "a malformed key is an error, not a missing one");
    assert_eq!(backup::read_key_file(&dir.join("absent.key")).unwrap(), None);

    let mut cfg = Config::default();
    point_at(&mut cfg, &dir);
    cfg.backup.key_file = dir.join("absent.key");
    let pool = telium_server::db::connect(&cfg.database_url).await.unwrap();
    let err = backup::run_once(&pool, &cfg).await.unwrap_err().to_string();
    assert!(err.contains("no backup key"), "{err}");
    assert!(backup::local_archives(&cfg.backup.dir).is_empty());
    pool.close().await;
    let _ = std::fs::remove_dir_all(&dir);
}

fn split_dirs(cfg: &mut Config, data: &Path, archives: &Path) {
    point_at(cfg, data);
    cfg.backup.dir = archives.join("archives");
    cfg.backup.key_file = archives.join("backup.key");
}

#[tokio::test]
async fn an_archive_outside_the_data_survives_the_data_being_destroyed_and_rebuilds_the_box() {
    let archives = fresh_dir("offvolume");
    let mut archive_dir = PathBuf::new();
    let s = start(|cfg| {
        let data = cfg.media_dir.parent().unwrap().to_path_buf();
        split_dirs(cfg, &data, &archives);
        archive_dir = cfg.backup.dir.clone();
    })
    .await;
    let data_dir = s.dir.clone();
    let alice = s.register("alice").await;
    let seeded = seed_files(s.cfg());
    let key = s.keygen();

    assert_eq!(backup::placement(s.cfg()), Placement::SameDevice, "two trees, one temp filesystem");
    assert_eq!(backup::report(s.cfg())["placement"], "same-device");
    assert!(!backup::key_is_stranded(s.cfg()), "the key went with the archives");

    let out = s.backup().await;
    assert!(out.path.starts_with(&archive_dir), "{} is not under {}", out.path.display(), archive_dir.display());
    assert!(!out.path.starts_with(&data_dir), "the archive is not inside what it is a copy of");

    s.state.pool.close().await;
    std::fs::remove_dir_all(&data_dir).unwrap();
    assert!(!data_dir.exists(), "the database, the media and the cold store are gone");
    assert!(out.path.is_file(), "the archive is not");
    assert!(backup::read_key_file(&s.cfg().backup.key_file).unwrap().is_some(), "and neither is the key");

    let (cfg2, dir2) = second_box(s.cfg());
    let source = Source::parse(out.path.to_str().unwrap());
    let restored = backup::restore(&cfg2, &source, &backup::Keyring::of(key), false).await.unwrap();
    assert!(restored.moved_aside.is_empty(), "the new box was empty");
    assert_eq!(restored.manifest.server_name, "test.example");
    assert_eq!(localpart_of(&cfg2, &alice.user_id).await.as_deref(), Some("alice"));
    assert_files_restored(&dir2, &seeded);
    let _ = std::fs::remove_dir_all(&dir2);
    let _ = std::fs::remove_dir_all(&archives);
}

#[tokio::test]
async fn a_backup_inside_the_data_it_copies_says_so_on_the_admin_pane() {
    let s = start(|_| {}).await;
    let alice = s.register("alice").await;
    s.keygen();
    s.backup().await;

    assert_eq!(backup::placement(s.cfg()), Placement::Inside);
    let report = backup::report(s.cfg());
    assert_eq!(report["placement"], "inside");
    assert_eq!(report["offsite"], false);
    assert_eq!(report["stale"], false, "fresh, and still worth nothing");

    let (code, body) = s.admin_status(&alice.token).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["backup"]["placement"], "inside");
    assert_eq!(body["backup"]["offsite"], false);
    assert_eq!(body["backup"]["key_stranded"], false);
}

#[tokio::test]
async fn a_key_left_behind_in_the_data_is_reported_separately() {
    let archives = fresh_dir("stranded");
    let s = start(|cfg| {
        let data = cfg.media_dir.parent().unwrap().to_path_buf();
        split_dirs(cfg, &data, &archives);
        cfg.backup.key_file = data.join("backup.key");
    })
    .await;
    let alice = s.register("alice").await;
    s.keygen();

    assert_ne!(backup::placement(s.cfg()), Placement::Inside);
    assert!(backup::key_is_stranded(s.cfg()));
    let (code, body) = s.admin_status(&alice.token).await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["backup"]["key_stranded"], true);
    let _ = std::fs::remove_dir_all(&archives);
}

#[tokio::test]
async fn a_box_with_no_backup_is_due_for_one_immediately() {
    let s = start(|cfg| cfg.backup.interval_secs = 6 * 60 * 60).await;
    s.keygen();

    assert!(backup::local_archives(&s.cfg().backup.dir).is_empty());
    assert_eq!(backup::due_in(s.cfg()), std::time::Duration::ZERO, "nothing to restore from yet");
    assert_eq!(backup::report(s.cfg())["stale"], true, "and the nag says so before the first run");

    s.backup().await;
    let next = backup::due_in(s.cfg()).as_secs();
    assert!(
        (6 * 60 * 60 - 60..=6 * 60 * 60).contains(&next),
        "a restart a moment later waits out the rest of the interval, not a fresh one: {next}s"
    );
}

#[tokio::test]
async fn cold_storage_on_s3_round_trips_through_the_bucket_and_back() {
    let (fake, endpoint) = start_fake_s3(100).await;
    let s = start(|cfg| {
        cfg.archive.enabled = true;
        cfg.archive.horizon_days = 0;
        cfg.archive.keep_hot_messages = 1;
        cfg.archive.batch = 100;
        cfg.archive.store = telium_server::config::StoreBackend::S3;
        cfg.archive.s3 = Remote {
            enabled: true,
            endpoint: endpoint.clone(),
            bucket: BUCKET.into(),
            region: REGION.into(),
            access_key_id: ACCESS_KEY.into(),
            secret_access_key: SECRET_KEY.into(),
            path_style: true,
            ..Remote::default()
        };
    })
    .await;

    let channel_id = "01CHANNELCHANNELCHANNELCH";
    let guild_id = "01GUILDGUILDGUILDGUILDGU0";
    for i in 0..5 {
        sqlx::query(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(telium_server::util::ulid())
        .bind(channel_id)
        .bind(guild_id)
        .bind("@alice:test.example")
        .bind(format!("message {i}"))
        .bind(telium_server::util::now_ms())
        .execute(&s.state.pool)
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }

    let moved = telium_server::cold::sweep(&s.state).await.unwrap();
    assert_eq!(moved, 4, "keep_hot_messages = 1 leaves the newest behind");

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE channel_id = ?")
        .bind(channel_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 1, "the hot tail stays in the messages table");

    let (segment_id, key): (String, String) =
        sqlx::query_as("SELECT id, path FROM cold_segments WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();

    {
        let store = fake.store();
        assert!(store.bad_signatures.is_empty(), "{:?}", store.bad_signatures);
        assert_eq!(store.objects.len(), 1, "one segment written to the bucket, not the local disk");
        assert!(store.objects.contains_key(&key), "the segment is filed under the same key the DB row names");
    }
    assert!(!std::path::Path::new(&key).exists(), "an S3-backed segment never touches the local filesystem");

    let last_id: String =
        sqlx::query_scalar("SELECT id FROM messages WHERE channel_id = ? ORDER BY id LIMIT 1")
            .bind(channel_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    let paged = telium_server::cold::page_before(&s.state, channel_id, &last_id, 10).await.unwrap();
    assert_eq!(paged.len(), 4, "all four archived messages page back in from S3");

    let raw = telium_server::cold::read_segment(&s.state, &segment_id).await.unwrap();
    assert_eq!(raw.len(), 4);
}

#[tokio::test]
#[ignore]
async fn cold_storage_on_real_minio_round_trips() {
    let s = start(|cfg| {
        cfg.archive.enabled = true;
        cfg.archive.horizon_days = 0;
        cfg.archive.keep_hot_messages = 1;
        cfg.archive.batch = 100;
        cfg.archive.store = telium_server::config::StoreBackend::S3;
        cfg.archive.s3 = Remote {
            enabled: true,
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: "telium-cold-dev-test".into(),
            region: "us-east-1".into(),
            access_key_id: "telium-dev".into(),
            secret_access_key: "telium-dev-secret".into(),
            path_style: true,
            ..Remote::default()
        };
    })
    .await;

    let channel_id = "01CHANNELCHANNELCHANNELCH";
    let guild_id = "01GUILDGUILDGUILDGUILDGU0";
    for i in 0..5 {
        sqlx::query(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(telium_server::util::ulid())
        .bind(channel_id)
        .bind(guild_id)
        .bind("@alice:test.example")
        .bind(format!("message {i}"))
        .bind(telium_server::util::now_ms())
        .execute(&s.state.pool)
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }

    let moved = telium_server::cold::sweep(&s.state).await.unwrap();
    assert_eq!(moved, 4);

    let last_id: String =
        sqlx::query_scalar("SELECT id FROM messages WHERE channel_id = ? ORDER BY id LIMIT 1")
            .bind(channel_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    let paged = telium_server::cold::page_before(&s.state, channel_id, &last_id, 10).await.unwrap();
    assert_eq!(paged.len(), 4, "all four archived messages page back in from a real bucket");
}

#[tokio::test]
#[ignore]
async fn media_on_real_minio_uploads_ranges_and_deletes() {
    let s = start(|cfg| {
        cfg.media_store.store = telium_server::config::StoreBackend::S3;
        cfg.media_store.s3 = Remote {
            enabled: true,
            endpoint: "http://127.0.0.1:9000".into(),
            bucket: "telium-media-dev-test".into(),
            region: "us-east-1".into(),
            access_key_id: "telium-dev".into(),
            secret_access_key: "telium-dev-secret".into(),
            path_style: true,
            ..Remote::default()
        };
    })
    .await;
    let alice = s.register("alice").await;

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.token)
        .header("X-Telium-Filename", "note.txt")
        .header("Content-Type", "text/plain")
        .body("the bytes, on a real bucket")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap().to_string();
    let cap = media["capability"].as_str().unwrap().to_string();

    let ok = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    assert_eq!(ok.text().await.unwrap(), "the bytes, on a real bucket");

    let partial = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .header("Range", "bytes=4-8")
        .send()
        .await
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(partial.text().await.unwrap(), "bytes");

    let deleted = s
        .client
        .delete(format!("{}/_telium/v1/media/{hash}", s.base))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status().as_u16(), 200);
}

#[tokio::test]
async fn media_on_s3_uploads_ranges_and_deletes_through_the_bucket() {
    let (fake, endpoint) = start_fake_s3(100).await;
    let s = start(|cfg| {
        cfg.media_store.store = telium_server::config::StoreBackend::S3;
        cfg.media_store.s3 = Remote {
            enabled: true,
            endpoint: endpoint.clone(),
            bucket: BUCKET.into(),
            region: REGION.into(),
            access_key_id: ACCESS_KEY.into(),
            secret_access_key: SECRET_KEY.into(),
            path_style: true,
            ..Remote::default()
        };
    })
    .await;
    let alice = s.register("alice").await;

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.token)
        .header("X-Telium-Filename", "note.txt")
        .header("Content-Type", "text/plain")
        .body("the bytes, on a bucket")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap().to_string();
    let cap = media["capability"].as_str().unwrap().to_string();

    assert!(!media_path_for(&s, &hash).exists(), "an S3-backed upload never touches the local filesystem");
    {
        let store = fake.store();
        assert!(store.bad_signatures.is_empty(), "{:?}", store.bad_signatures);
        assert_eq!(store.objects.len(), 1);
    }

    let ok = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    assert_eq!(ok.text().await.unwrap(), "the bytes, on a bucket");

    let partial = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .header("Range", "bytes=4-8")
        .send()
        .await
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(partial.text().await.unwrap(), "bytes");

    let deleted = s
        .client
        .delete(format!("{}/_telium/v1/media/{hash}", s.base))
        .bearer_auth(&alice.token)
        .send()
        .await
        .unwrap();
    assert_eq!(deleted.status().as_u16(), 200);
    assert!(fake.store().objects.is_empty(), "the bucket object is gone too, not just the row");

    let gone = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status().as_u16(), 404);
}

fn media_path_for(s: &Server, hash: &str) -> PathBuf {
    s.cfg().media_dir.join(&hash[0..2]).join(hash)
}

fn scratch_left(cfg: &Config) -> Vec<String> {
    std::fs::read_dir(&cfg.backup.dir)
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with(".drill-")).collect())
        .unwrap_or_default()
}

fn age_last_drill(cfg: &Config, by_ms: i64) {
    let path = cfg.backup.dir.join("status.json");
    let mut v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let at = v["last_drill"]["at"].as_i64().unwrap() - by_ms;
    v["last_drill"]["at"] = json!(at);
    v["last_drill_pass"] = json!(at);
    std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
}

#[tokio::test]
async fn the_drill_verdict_moves_from_never_run_to_passed_stale_and_failed() {
    let s = start(|cfg| cfg.backup.drill_interval_secs = 6 * 3_600).await;
    s.keygen();
    let alice = s.register("alice").await;
    seed_files(s.cfg());
    let latest = telium_server::db::latest_migration_version();
    let due = || drill::due_in(s.cfg(), &backup::read_status(&s.cfg().backup.dir)).as_secs();

    assert_eq!(drill::verdict(s.cfg(), None), Verdict::NeverRun);
    let (code, body) = s.admin_status(&alice.token).await;
    let d = &body["backup"]["drill"];
    assert_eq!((code, &d["verdict"], &d["enabled"], d["verified"].is_null()), (200, &json!("never-run"), &json!(true), true));
    assert_eq!(d["interval_secs"], s.cfg().backup.drill_interval_secs);
    assert!((1..=600).contains(&due()), "the first drill runs soon after startup, not instantly");

    assert!(backup::pending_migrations(s.cfg()).await.unwrap().is_none());
    backup::before_migrations(s.cfg()).await.unwrap();
    let out = s.backup().await;
    let key = backup::load_key(s.cfg()).unwrap().unwrap();
    assert_eq!(backup::peek(&out.path, &key).unwrap().schema_version, latest);
    assert_eq!(backup::report(s.cfg())["last_archive_schema"], latest);
    assert_eq!(backup::fetch(s.cfg(), &Source::Path(out.path.clone())).await.unwrap().path, out.path);

    let run = drill::run(s.cfg(), Some(&s.state.pool)).await;
    assert!(run.ok, "{:?} {:?}", run.failure, run.error);
    assert_eq!((run.source.as_str(), run.archive.clone()), ("local", out.path.display().to_string()));
    let v = run.verified.expect("a passing drill records what it saw");
    assert!(v.integrity && v.database_bytes > 0 && v.signing_keys >= 1 && v.push_keys >= 1 && v.devices >= 1);
    assert_eq!((v.accounts, v.schema_version, v.binary_schema_version), (1, latest, latest));
    let media = v.parts.iter().find(|p| p.kind == "media").expect("the media part");
    assert!(media.files_seen == media.files_declared && media.bytes >= 2_000_000, "{media:?}");
    assert!(scratch_left(s.cfg()).is_empty(), "the plaintext copy is gone");

    let (_, body) = s.admin_status(&alice.token).await;
    let d = &body["backup"]["drill"];
    assert_eq!((&d["verdict"], &d["source"]), (&json!("passed"), &json!("local")));
    assert_eq!(d["verified"]["binary_schema_version"], latest);
    assert!(d["passed_at"].is_i64() && d["age_ms"].as_i64().unwrap() < 60_000);
    assert!(due() > 5 * 3_600);

    age_last_drill(s.cfg(), 40 * 24 * 3_600_000);
    assert!(due() <= 600, "an overdue drill is due");
    let report = backup::report(s.cfg());
    assert_eq!(report["drill"]["verdict"], "stale");
    assert!(report["drill"]["passed_age_ms"].as_i64().unwrap() > 30 * 24 * 3_600_000);

    for (path, _) in backup::local_archives(&s.cfg().backup.dir) {
        std::fs::remove_file(path).unwrap();
    }
    assert_eq!(drill::run(s.cfg(), None).await.failure, Some(Failure::Fetch));
    let d = &backup::report(s.cfg())["drill"];
    assert_eq!((&d["verdict"], &d["failure"]), (&json!("failed"), &json!("fetch")));
    assert!(d["advice"].as_str().unwrap().contains("could not be fetched"));
    assert!(d["passed_at"].is_i64(), "the last pass is still remembered");
}

async fn failing_drill(cfg: &Config) -> (Failure, String) {
    let d = drill::run(cfg, None).await;
    assert!(!d.ok && d.verified.is_none(), "{d:?}");
    assert!(scratch_left(cfg).is_empty(), "no scratch directory survives a failure");
    (d.failure.expect("a stage"), d.error.unwrap_or_default())
}

#[tokio::test]
async fn each_way_an_archive_fails_a_drill_is_named_and_the_live_server_is_untouched() {
    let s = start(|_| {}).await;
    s.keygen();
    let alice = s.register("alice").await;
    seed_files(s.cfg());
    let out = s.backup().await;
    let with = |edit: &dyn Fn(&mut Config)| {
        let mut cfg = s.cfg().clone();
        edit(&mut cfg);
        cfg
    };

    let other = s.dir.join("other.key");
    backup::keygen(&other).unwrap();
    assert_eq!(failing_drill(&with(&|c| c.backup.key_file = other.clone())).await.0, Failure::CannotDecrypt);
    assert!(Failure::CannotDecrypt.advice().contains("does not open"));
    let nowhere = s.dir.join("nowhere.key");
    assert_eq!(failing_drill(&with(&|c| c.backup.key_file = nowhere.clone())).await.0, Failure::NoKey);

    let rotated = with(&|c| {
        c.backup.key_file = other.clone();
        c.backup.previous_key_files = vec![s.cfg().backup.key_file.clone()];
    });
    let d = drill::run(&rotated, None).await;
    assert!(d.ok, "{:?}", d.error);
    assert_eq!(d.archive, out.path.display().to_string());
    let lost = with(&|c| {
        c.backup.key_file = other.clone();
        c.backup.previous_key_files = vec![nowhere.clone()];
    });
    let (failure, err) = failing_drill(&lost).await;
    assert_eq!(failure, Failure::NoKey, "{err}");
    assert!(err.contains("previous_key_files") && err.contains("nowhere.key"), "{err}");

    let f = std::fs::OpenOptions::new().write(true).open(&out.path).unwrap();
    f.set_len(std::fs::metadata(&out.path).unwrap().len() / 2).unwrap();
    drop(f);
    let (failure, _) = failing_drill(s.cfg()).await;
    assert!(matches!(failure, Failure::Corrupt | Failure::Unpack), "{failure:?}");
    let (code, body) = s.admin_status(&alice.token).await;
    assert_eq!((code, &body["backup"]["drill"]["verdict"]), (200, &json!("failed")), "{body}");
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM accounts").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(live, 1, "the live server is untouched");

    sqlx::query("DELETE FROM server_keys").execute(&s.state.pool).await.unwrap();
    s.backup().await;
    let (failure, err) = failing_drill(s.cfg()).await;
    assert_eq!(failure, Failure::MissingSigningKey);
    assert!(err.contains("server_keys"), "{err}");
    let d = &backup::report(s.cfg())["drill"];
    assert_eq!(d["failure"], "missing-signing-key");
    assert!(d["advice"].as_str().unwrap().contains("new identity"));
}

#[tokio::test]
async fn with_a_bucket_the_drill_reads_the_bucket_and_an_unreachable_one_fails() {
    let (fake, endpoint) = start_fake_s3(100).await;
    let s = start(|cfg| with_remote(cfg, &endpoint)).await;
    s.keygen();
    s.register("alice").await;
    let out = s.backup().await;
    assert!(out.remote_error.is_none(), "{:?}", out.remote_error);
    let gets = || fake.store().log.iter().filter(|l| l.starts_with(&format!("GET /{BUCKET}/"))).count();
    let before = gets();
    std::fs::write(&out.path, b"this is not an archive").unwrap();

    let d = drill::run(s.cfg(), Some(&s.state.pool)).await;
    assert!(d.ok, "{:?} {:?}", d.failure, d.error);
    assert!(d.source == "remote" && d.archive.starts_with("s3://"), "{} {}", d.source, d.archive);
    assert!(gets() > before, "the bucket was actually read");
    assert_eq!(backup::report(s.cfg())["drill"]["source"], "remote");
    assert!(scratch_left(s.cfg()).is_empty());

    let s = start(|cfg| with_remote(cfg, "http://127.0.0.1:1")).await;
    s.keygen();
    let out = s.backup().await;
    assert!(backup::verify(&out.path, &backup::load_key(s.cfg()).unwrap().unwrap()).is_ok());
    let d = drill::run(s.cfg(), None).await;
    assert_eq!((d.ok, d.source.as_str(), d.failure), (false, "remote", Some(Failure::Fetch)));
}

#[tokio::test]
async fn what_an_archive_cannot_carry_is_named_in_the_manifest_report_and_drill() {
    use telium_server::config::StoreBackend;
    let s = start(|_| {}).await;
    s.keygen();
    s.register("alice").await;
    assert!(s.backup().await.manifest.excluded.is_empty(), "nothing is excluded on a default server");

    let mut cfg = s.cfg().clone();
    cfg.media_store.store = StoreBackend::S3;
    cfg.media_store.s3.bucket = "telium-media".into();
    cfg.media_store.s3.prefix = "/attachments/".into();
    cfg.archive.enabled = true;
    cfg.archive.store = StoreBackend::S3;
    cfg.archive.s3.bucket = "telium-cold".into();
    let out = backup::run_once(&s.state.pool, &cfg).await.unwrap();
    for (kind, detail) in [("media", "s3://telium-media/attachments"), ("cold", "s3://telium-cold")] {
        let e = out.manifest.excluded.iter().find(|e| e.kind == kind).unwrap_or_else(|| panic!("{kind} not excluded"));
        assert_eq!((e.reason.as_str(), e.detail.as_deref()), ("object-store", Some(detail)));
        let says = backup::excluded_sentence(e);
        assert!(says.contains(detail) && says.contains(kind), "{says}");
        let part = out.manifest.parts.iter().find(|p| p.kind == kind).map(|p| p.files).unwrap_or(0);
        assert_eq!(part, 0, "the bucket is not walked");
    }
    let report = backup::report(&cfg);
    let excluded = report["excluded"].as_array().unwrap();
    assert_eq!(excluded.len(), 2, "{excluded:?}");
    let cold = excluded.iter().find(|e| e["kind"] == "cold").unwrap();
    assert!(cold["says"].as_str().unwrap().contains("only copy"), "cold segments are deleted history: {cold}");
    let d = drill::run(&cfg, Some(&s.state.pool)).await;
    assert!(d.ok, "{:?} {:?}", d.failure, d.error);
    assert!(d.warnings.iter().any(|w| w.contains("s3://telium-cold")), "{:?}", d.warnings);

    let mut cfg = s.cfg().clone();
    cfg.backup.include_media = false;
    let out = backup::run_once(&s.state.pool, &cfg).await.unwrap();
    let e = out.manifest.excluded.iter().find(|e| e.kind == "media").expect("recorded");
    assert_eq!((e.reason.as_str(), e.detail.as_deref()), ("disabled", None));
    assert!(!out.manifest.parts.iter().any(|p| p.kind == "media"));
    assert!(backup::report(&cfg)["excluded"][0]["says"].as_str().unwrap().contains("include_media"));
}

#[tokio::test]
async fn the_backup_key_rotates_without_orphaning_the_archives_sealed_before() {
    let s = start(|cfg| cfg.backup.keep = 16).await;
    let old_path = s.cfg().backup.key_file.clone();
    let old_key = s.keygen();
    let before = s.backup().await.path;

    let new_path = s.dir.join("backup.key.new");
    let new_key = backup::keygen(&new_path).unwrap();
    assert_ne!(old_key, new_key);
    let mut rotated = s.cfg().clone();
    rotated.backup.key_file = new_path.clone();
    rotated.backup.previous_key_files = vec![old_path.clone()];
    rotated.validate().expect("a rotation in progress is a valid configuration");
    let ring = backup::load_keyring(&rotated).unwrap();
    assert_eq!((ring.current, ring.retired.clone()), (Some(new_key), vec![old_key]));
    assert_eq!(ring.open(&before).unwrap(), old_key, "an archive from before the rotation still opens");
    backup::verify(&before, &old_key).unwrap();

    let after = backup::run_once(&s.state.pool, &rotated).await.unwrap().path;
    assert_ne!(after, before);
    assert_eq!(ring.open(&after).unwrap(), new_key, "new archives are sealed under the current key");

    let mut wrong = s.cfg().clone();
    wrong.backup.key_file = new_path.clone();
    let err = backup::load_keyring(&wrong).unwrap().open(&before).unwrap_err().to_string();
    assert!(err.contains("1 configured backup key") && err.contains("previous_key_files"), "{err}");
    assert!(err.contains(&before.display().to_string()), "{err}");
    let mut none = s.cfg().clone();
    none.backup.key_file = s.dir.join("not-there.key");
    let empty = backup::load_keyring(&none).unwrap();
    assert!(empty.is_empty());
    assert!(empty.open(&before).unwrap_err().to_string().contains("no backup key is configured"));

    let mut typo = s.cfg().clone();
    typo.backup.previous_key_files = vec![s.dir.join("typo-in-this-path.key")];
    let err = typo.validate().unwrap_err().to_string();
    assert!(err.contains("previous_key_files") && err.contains("typo-in-this-path.key"), "{err}");

    let copy = s.dir.join("backup.key.copy");
    std::fs::copy(&old_path, &copy).unwrap();
    let mut dup = s.cfg().clone();
    dup.backup.previous_key_files = vec![copy.clone(), copy];
    let ring = backup::load_keyring(&dup).unwrap();
    assert!(ring.retired.is_empty() && ring.all().len() == 1);
}

const IRREPLACEABLE: &[&str] = &[
    "SELECT quote(key_id)||quote(secret_b64)||quote(public_b64)||quote(valid_from)||quote(valid_until)||quote(domain) FROM server_keys ORDER BY key_id",
    "SELECT quote(secret_b64)||quote(public_b64) FROM vapid_key",
    "SELECT quote(setup) FROM opaque_server_state",
    "SELECT quote(user_id)||quote(localpart)||quote(password_hash)||quote(opaque_record)||quote(recovery_public_key) FROM accounts ORDER BY user_id",
    "SELECT quote(user_id)||quote(mode)||quote(ciphertext)||quote(escrow_key) FROM key_vault ORDER BY user_id",
    "SELECT quote(user_id)||quote(identity_key)||quote(sealed_secret) FROM cross_signing ORDER BY user_id",
    "SELECT quote(user_id)||quote(scope)||quote(item)||quote(ciphertext) FROM key_backup ORDER BY user_id, scope, item",
];

async fn irreplaceable(pool: &sqlx::SqlitePool) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    for sql in IRREPLACEABLE {
        out.push(sqlx::query_scalar(sql).fetch_all(pool).await.unwrap());
    }
    out
}

async fn populated_and_backed_up(s: &Server) -> (PathBuf, backup::Key) {
    let key = s.keygen();
    let alice = s.register("alice").await;
    for (path, body) in [
        ("/_telium/v1/vault", json!({ "mode": "escrowed", "ciphertext": "sealed-keyring", "escrow_key": "escrowed-half" })),
        ("/_telium/v1/vault/backup", json!({ "items": [{ "scope": "c1", "item": "frame-1", "ciphertext": "sealed-item" }] })),
        ("/_telium/v1/crosssigning", json!({ "identity_key": telium_server::util::b64(&[7u8; 32]), "sealed_secret": "sealed-secret" })),
    ] {
        let resp = s.client.put(format!("{}{path}", s.base)).bearer_auth(&alice.token).json(&body).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200, "{path}");
    }
    let resp = s.client.get(format!("{}/_telium/v1/push/vapid", s.base)).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "vapid");
    let long_ago = telium_server::util::now_ms() - 400 * 86_400_000;
    sqlx::query("INSERT INTO server_keys (key_id, secret_b64, public_b64, valid_from, valid_until) VALUES ('ed25519:retired', ?, ?, ?, ?)")
        .bind(telium_server::util::b64(&[3u8; 32]))
        .bind(telium_server::util::b64(&[4u8; 32]))
        .bind(long_ago)
        .bind(long_ago + 86_400_000)
        .execute(&s.state.pool)
        .await
        .unwrap();
    (s.backup().await.path, key)
}

#[tokio::test]
async fn a_fresh_box_restored_from_the_archive_is_the_same_server() {
    let s = start(|_| {}).await;
    let (archive, key) = populated_and_backed_up(&s).await;
    let before = irreplaceable(&s.state.pool).await;
    assert!(before.iter().enumerate().all(|(i, rows)| i == 2 || !rows.is_empty()), "{before:?}");

    let (cfg2, dir2) = second_box(s.cfg());
    let err = backup::fetch(&cfg2, &Source::parse("s3://latest")).await.err().expect("no bucket is configured");
    assert!(format!("{err:#}").contains("backup.remote"), "{err:#}");
    backup::restore(&cfg2, &Source::Path(archive), &backup::Keyring::of(key), false).await.unwrap();
    std::fs::copy(&s.cfg().backup.key_file, &cfg2.backup.key_file).unwrap();
    let state = telium_server::build_state(cfg2).await.unwrap();

    assert_eq!(irreplaceable(&state.pool).await, before);
    assert_eq!((state.key.key_id.clone(), state.key.public_b64()), (s.state.key.key_id.clone(), s.state.key.public_b64()));
    assert_eq!(telium_server::crypto::historical_keys(&state.pool).await.unwrap().len(), before[0].len());
    state.pool.close().await;
    let _ = std::fs::remove_dir_all(&dir2);
}

fn reseal_at_schema_version(archive: &Path, key: &backup::Key, version: i64, to: &Path) {
    use telium_server::backup::format;
    let mut reader = format::Reader::open(std::io::BufReader::new(std::fs::File::open(archive).unwrap()), key).unwrap();
    let mut payload = Vec::new();
    std::io::Read::read_to_end(&mut reader, &mut payload).unwrap();
    let mut manifest = reader.manifest().clone();
    manifest.schema_version = version;
    let out = std::io::BufWriter::new(std::fs::File::create(to).unwrap());
    let mut writer = format::Writer::new(out, key, &manifest).unwrap();
    std::io::Write::write_all(&mut writer, &payload).unwrap();
    writer.finish().unwrap();
}

#[tokio::test]
async fn an_archive_newer_than_the_binary_is_refused_and_an_older_one_migrates_forward() {
    let s = start(|_| {}).await;
    let key = s.keygen();
    s.register("alice").await;
    let archive = s.backup().await.path;
    let ours = telium_server::db::latest_migration_version();

    let (cfg2, dir2) = second_box(s.cfg());
    let newer = s.dir.join("newer.tbk");
    reseal_at_schema_version(&archive, &key, ours + 1, &newer);
    let msg = format!("{:#}", backup::restore(&cfg2, &Source::Path(newer), &backup::Keyring::of(key), false).await.unwrap_err());
    assert!(msg.contains(&(ours + 1).to_string()) && msg.contains("upgrade"), "{msg}");
    assert_eq!(std::fs::read_dir(&dir2).unwrap().count(), 0, "the fresh box is untouched");

    let older = s.dir.join("older.tbk");
    reseal_at_schema_version(&archive, &key, ours - 1, &older);
    let restored = backup::restore(&cfg2, &Source::Path(older), &backup::Keyring::of(key), false).await.unwrap();
    assert_eq!(restored.manifest.schema_version, ours - 1);
    let pool = telium_server::db::connect(&cfg2.database_url).await.unwrap();
    let at: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations").fetch_one(&pool).await.unwrap();
    assert_eq!(at, ours);
    pool.close().await;
    let _ = std::fs::remove_dir_all(&dir2);
}

#[tokio::test]
async fn the_cli_with_no_key_says_where_it_looked_and_how_else_to_supply_one() {
    let s = start(|_| {}).await;
    s.keygen();
    let archive = s.backup().await.path;
    let (cfg2, dir2) = second_box(s.cfg());
    assert!(backup::load_key(&cfg2).unwrap().is_none());
    let config = dir2.join("telium.toml");
    std::fs::write(
        &config,
        format!(
            "server_name = \"test.example\"\ndatabase_url = \"{}\"\nmedia_dir = \"{}\"\n[archive]\ndir = \"{}\"\n[backup]\ndir = \"{}\"\nkey_file = \"{}\"\n",
            cfg2.database_url,
            cfg2.media_dir.display(),
            cfg2.archive.dir.display(),
            cfg2.backup.dir.display(),
            cfg2.backup.key_file.display(),
        ),
    )
    .unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_telium-server"))
        .args(["--config", config.to_str().unwrap(), "restore", archive.to_str().unwrap(), "--yes"])
        .env_remove("TELIUM_BACKUP_KEY")
        .output()
        .unwrap();
    assert!(!out.status.success());
    let said = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(said.contains(&cfg2.backup.key_file.display().to_string()) && said.contains("TELIUM_BACKUP_KEY"), "{said}");
    assert!(!dir2.join("telium.db").exists());
    let _ = std::fs::remove_dir_all(&dir2);
}
