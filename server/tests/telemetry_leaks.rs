
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use telium_server::config::Config;

const RISKY: [&str; 10] = [
    "password", "token", "secret", "passphrase", "recovery", "private_key", "signing_key",
    "ciphertext", "plaintext", "credential",
];

const RULES: [&str; 5] = [
    "a logging macro is handed a value whose name says it is a secret",
    "an error context string names a value whose name says it is a secret",
    "an instrumented function records an argument whose name says it is a secret",
    "the configuration is printed by Debug, which reaches every secret in it",
    "a stdout print names a value whose name says it is a secret",
];

const KNOWN_TELEMETRY_EXCEPTIONS: [(&str, usize, usize); 1] = [
    ("main.rs", 4, 2),
];

fn mask(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let blank = |c: char| if c == '\n' { '\n' } else { ' ' };
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < chars.len() && chars[i] != '\n' {
                out.push(' ');
                i += 1;
            }
            continue;
        }
        if c == '/' && next == Some('*') {
            let mut depth = 0usize;
            while i < chars.len() {
                let pair = (chars[i], chars.get(i + 1).copied());
                if pair == ('/', Some('*')) || pair == ('*', Some('/')) {
                    if pair.0 == '/' { depth += 1 } else { depth -= 1 }
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                    continue;
                }
                out.push(blank(chars[i]));
                i += 1;
            }
            continue;
        }
        if (c == 'r' || c == 'b') && !prev_is_ident(&chars, i) {
            let mut j = i;
            if chars[j] == 'b' && chars.get(j + 1) == Some(&'r') {
                j += 1;
            }
            if chars[j] == 'r' {
                let mut k = j + 1;
                while chars.get(k) == Some(&'#') {
                    k += 1;
                }
                if chars.get(k) == Some(&'"') {
                    (i..=k).for_each(|_| out.push(' '));
                    i = mask_string_body(&chars, k + 1, &mut out, Some(k - j - 1));
                    continue;
                }
            }
        }
        if c == '"' || (c == 'b' && next == Some('"') && !prev_is_ident(&chars, i)) {
            if c == 'b' {
                out.push(' ');
                i += 1;
            }
            out.push(' ');
            i = mask_string_body(&chars, i + 1, &mut out, None);
            continue;
        }
        if c == '\'' && !prev_is_ident(&chars, i) {
            let is_char = match next {
                Some('\\') => true,
                Some(_) => chars.get(i + 2) == Some(&'\''),
                None => false,
            };
            if is_char {
                out.push(' ');
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        out.push_str("  ");
                        i += 2;
                        continue;
                    }
                    out.push(' ');
                    i += 1;
                    if chars[i - 1] == '\'' {
                        break;
                    }
                }
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn prev_is_ident(chars: &[char], i: usize) -> bool {
    i > 0 && (chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')
}

fn mask_string_body(chars: &[char], mut i: usize, out: &mut String, raw_hashes: Option<usize>) -> usize {
    let mut in_brace = false;
    while i < chars.len() {
        let c = chars[i];
        if raw_hashes.is_none() && c == '\\' {
            out.push_str("  ");
            i += 2;
            continue;
        }
        if c == '"' {
            match raw_hashes {
                None => {
                    out.push(' ');
                    return i + 1;
                }
                Some(h) if (1..=h).all(|n| chars.get(i + n) == Some(&'#')) => {
                    (0..=h).for_each(|_| out.push(' '));
                    return i + h + 1;
                }
                Some(_) => {}
            }
        }
        if c == '{' || c == '}' {
            in_brace = c == '{';
            out.push(c);
        } else {
            out.push(if in_brace || c == '\n' { c } else { ' ' });
        }
        i += 1;
    }
    i
}

fn invocations<'a>(masked: &'a str, heads: &[&str]) -> Vec<(usize, &'a str)> {
    let bytes = masked.as_bytes();
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < masked.len() {
        let Some((start, head)) = heads
            .iter()
            .filter_map(|h| masked[at..].find(h).map(|o| (at + o, *h)))
            .min_by_key(|(o, _)| *o)
        else {
            break;
        };
        let mut k = start + head.len();
        while bytes.get(k).is_some_and(|b| b.is_ascii_whitespace()) {
            k += 1;
        }
        if bytes.get(k) != Some(&b'(') {
            at = start + head.len();
            continue;
        }
        let (mut depth, mut end) = (0usize, k);
        while end < bytes.len() {
            match bytes[end] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            end += 1;
        }
        out.push((masked[..start].matches('\n').count() + 1, &masked[k + 1..end.min(masked.len())]));
        at = end + 1;
    }
    out
}

fn names_a_secret(args: &str) -> bool {
    RISKY.iter().any(|w| args.contains(w))
}

#[test]
fn no_call_site_in_the_tree_hands_a_secret_to_the_telemetry() {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let (mut files, mut stack) = (Vec::new(), vec![root.clone()]);
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                files.push(path);
            }
        }
    }
    assert!(files.len() > 20, "the walk found {} files", files.len());

    const LOGGING: [&str; 5] =
        ["tracing::trace!", "tracing::debug!", "tracing::info!", "tracing::warn!", "tracing::error!"];
    let mut found: Vec<(String, usize, usize)> = Vec::new();
    let mut detail: Vec<String> = Vec::new();
    for path in &files {
        let masked = mask(&std::fs::read_to_string(path).unwrap());
        let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        let mut counts = [0usize; RULES.len()];
        let mut note = |rule: usize, line: usize, args: &str, counts: &mut [usize; RULES.len()]| {
            counts[rule] += 1;
            let snippet = args.split_whitespace().collect::<Vec<_>>().join(" ");
            detail.push(format!("  {rel}:{line}  [{}]  {}", RULES[rule], snippet.chars().take(120).collect::<String>()));
        };
        for (line, args) in invocations(&masked, &LOGGING) {
            if names_a_secret(args) {
                note(0, line, args, &mut counts);
            }
            if ["?cfg", "?config", "?self.cfg", "?state.cfg", "?c.cfg"].iter().any(|p| args.contains(p)) {
                note(3, line, args, &mut counts);
            }
        }
        for (rule, heads) in [(1, &["anyhow!", "bail!", ".context", ".with_context"][..]), (4, &["println!", "eprintln!"][..])] {
            for (line, args) in invocations(&masked, heads) {
                if names_a_secret(args) {
                    note(rule, line, args, &mut counts);
                }
            }
        }
        for (line, args) in invocations(&masked, &["dbg!"]) {
            note(3, line, args, &mut counts);
        }
        for (idx, _) in masked.match_indices("#[instrument") {
            let attr_end = masked[idx..].find(']').map(|o| idx + o).unwrap_or(masked.len());
            let after = &masked[attr_end..];
            let signature = &after[..after.find('{').unwrap_or(after.len().min(400))];
            if !masked[idx..attr_end].contains("skip") && names_a_secret(signature) {
                note(2, masked[..idx].matches('\n').count() + 1, signature, &mut counts);
            }
        }
        for (rule, count) in counts.iter().enumerate().filter(|(_, c)| **c > 0) {
            found.push((rel.clone(), rule, *count));
        }
    }
    found.sort();
    let mut want: Vec<(String, usize, usize)> =
        KNOWN_TELEMETRY_EXCEPTIONS.iter().map(|(f, r, c)| ((*f).to_string(), *r, *c)).collect();
    want.sort();
    assert_eq!(
        found, want,
        "call sites handing a secret-shaped value to telemetry changed (rule index into {RULES:?}).\n{}\n\
         Redact the value (hash prefix, origin, length, boolean); only if it is genuinely not a \
         secret, add it to KNOWN_TELEMETRY_EXCEPTIONS with a reason.",
        detail.join("\n")
    );
}

#[test]
fn the_masker_and_scanner_see_values_but_not_prose() {
    let secret_in = |src: &str| names_a_secret(&mask(src));
    assert!(!secret_in(r#"tracing::warn!("could not check the password token");"#));
    assert!(secret_in(r#"tracing::warn!("login for {password}");"#));
    assert!(!secret_in("// the token goes here\nlet x = 1;"));
    assert!(!secret_in("/* nested /* token */ still a comment */ let x = 1;"));
    assert!(secret_in("match c { '\"' => 1, _ => 0 };\ntracing::warn!(token);"));
    assert!(mask("fn f<'a>(x: &'a str) {}").contains("'a"));
    assert!(mask("let q = r#\"select \"token\" from t\"#;\ntracing::warn!(secret);").contains("tracing::warn!(secret)"));
    assert_eq!(mask("a\nb\nc\n").matches('\n').count(), 3);
    for (src, leaks) in [
        (r#"foo().context(format!("could not verify {token}"))?;"#, true),
        (r#"bail!("could not verify {}", recovery_code);"#, true),
        (r#"bail!("that token has expired");"#, false),
        (r#"bail!("could not verify {}", c);"#, false),
    ] {
        let masked = mask(src);
        let sites = invocations(&masked, &[".context", "anyhow!", "bail!"]);
        assert_eq!(sites.len(), 1, "{src}");
        assert_eq!(names_a_secret(sites[0].1), leaks, "{src}");
    }
}

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn log_text() -> String {
    static BUF: std::sync::OnceLock<Arc<Mutex<Vec<u8>>>> = std::sync::OnceLock::new();
    let buf = BUF.get_or_init(|| {
        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_writer(Capture(buf.clone()))
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .finish();
        let _ = tracing::subscriber::set_global_default(subscriber);
        buf
    });
    String::from_utf8_lossy(&buf.lock().unwrap()).into_owned()
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn scratch(tag: &str) -> std::path::PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn config(dir: &std::path::Path, name: &str, base: String) -> Config {
    let mut cfg = Config {
        server_name: name.into(),
        public_base_url: base,
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg
}

#[tokio::test]
async fn a_registration_and_login_flow_writes_no_secret_into_the_log() {
    let _ = log_text();
    tracing::info!("telemetry-leak-canary-cb6a2f");
    const PASSWORD: &str = "sentinel-password-9f2c41d7a8be-correct-horse";
    const WRONG_PASSWORD: &str = "sentinel-wrongpass-41b7de92c5fa-nope";
    const FAKE_BEARER: &str = "sentinel-bearer-7d3e10c4fa96-not-a-token";

    let dir = scratch("leaks");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = telium_server::build_state(config(&dir, "test.example", base.clone())).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    let client = reqwest::Client::new();
    let call = |method: reqwest::Method, path: &str, token: Option<&str>, body: Option<Value>| {
        let mut req = client.request(method, format!("{base}{path}"));
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        async move {
            let resp = req.send().await.unwrap();
            (resp.status().as_u16(), resp.json::<Value>().await.unwrap_or(json!(null)))
        }
    };
    use reqwest::Method as M;
    let (status, reg) =
        call(M::POST, "/_telium/v1/register", None, Some(json!({"localpart": "leaks", "password": PASSWORD}))).await;
    assert_eq!(status, 200, "{reg}");
    let user_id = reg["user_id"].as_str().unwrap().to_string();
    let token = reg["access_token"].as_str().unwrap().to_string();
    let (status, login) =
        call(M::POST, "/_telium/v1/login", None, Some(json!({"user": "leaks", "password": PASSWORD}))).await;
    assert_eq!(status, 200, "{login}");
    let second_token = login["access_token"].as_str().unwrap().to_string();
    let (status, _) =
        call(M::POST, "/_telium/v1/login", None, Some(json!({"user": "leaks", "password": WRONG_PASSWORD}))).await;
    assert_ne!(status, 200);
    call(M::GET, "/_telium/v1/me", Some(FAKE_BEARER), None).await;
    call(M::GET, "/_telium/v1/me", Some(&token), None).await;
    call(M::GET, "/_telium/v1/definitely-not-a-route", Some(&token), None).await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;

    let log = log_text();
    assert!(log.contains("telemetry-leak-canary-cb6a2f"), "the capturing subscriber is not installed");
    for (what, needle) in [
        ("the password", PASSWORD),
        ("the wrong password", WRONG_PASSWORD),
        ("the access token", token.as_str()),
        ("the second access token", second_token.as_str()),
        ("the rejected bearer token", FAKE_BEARER),
    ] {
        assert!(!log.contains(needle), "{what} reached the log:\n{log}");
    }

    let exposition = telium_server::metrics::render(&telium_server::metrics::gather(&state).await);
    assert!(exposition.contains("telium_http_requests_total"), "{exposition}");
    for needle in [user_id.as_str(), token.as_str(), PASSWORD] {
        assert!(!exposition.contains(needle), "{needle} reached the exposition");
    }
    let series: Vec<&str> = exposition.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).collect();
    assert!(series.iter().all(|l| !l.contains('@')), "an account-shaped value reached a metric line");
    assert!(series.len() < 400, "{} series: something unbounded is a label", series.len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_rotation_record_holds_nothing_derived_from_a_key() {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    use sha2::Digest as _;
    use sqlx::{Column as _, Row as _};
    const SENTINEL: &str = "sentinel-backup-key-5b91ea0c7d43-not-a-real-key";

    let dir = scratch("rot");
    let key_file = dir.join("backup.key");
    std::fs::write(&key_file, SENTINEL).unwrap();
    let mut cfg = config(&dir, "rot.example", "http://127.0.0.1:0".into());
    cfg.backup.key_file = key_file.clone();
    let state = telium_server::build_state(cfg).await.unwrap();

    telium_server::rotations::record(
        &state.pool,
        telium_server::secrets::by_heading("Backup encryption key").unwrap(),
        &telium_server::rotations::Actor::local(Some("sentinel-operator-4ef2")),
        telium_server::rotations::Detail {
            change: "replaced",
            note: "a test",
            path: Some(key_file.display().to_string()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    telium_server::rotations::witness_key_files(&state.pool, &state.cfg).await.unwrap();
    std::fs::write(&key_file, format!("{SENTINEL}-rotated-once-more")).unwrap();
    let noticed = telium_server::rotations::witness_key_files(&state.pool, &state.cfg).await.unwrap();
    assert!(!noticed.is_empty(), "the witness missed a key file whose length changed");

    let mut dump = String::new();
    for table in ["secret_rotations", "secret_file_witness"] {
        for row in sqlx::query(&format!("SELECT * FROM {table}")).fetch_all(&state.pool).await.unwrap() {
            for (i, column) in row.columns().iter().enumerate() {
                let value = row
                    .try_get::<String, _>(i)
                    .or_else(|_| row.try_get::<i64, _>(i).map(|v| v.to_string()))
                    .or_else(|_| row.try_get::<Vec<u8>, _>(i).map(|v| String::from_utf8_lossy(&v).into_owned()))
                    .unwrap_or_default();
                dump.push_str(&format!("{}={value} ", column.name()));
            }
            dump.push('\n');
        }
    }
    assert!(dump.contains("sentinel-operator-4ef2"), "the dump missed the row this test wrote:\n{dump}");
    let digest = sha2::Sha256::digest(SENTINEL.as_bytes());
    for (what, needle) in [
        ("contents", SENTINEL.to_string()),
        ("base64", STANDARD.encode(SENTINEL)),
        ("base64url", URL_SAFE_NO_PAD.encode(SENTINEL)),
        ("hex", hex::encode(SENTINEL)),
        ("sha256 hex", hex::encode(digest)),
        ("sha256 base64", STANDARD.encode(digest)),
    ] {
        assert!(!dump.contains(&needle), "the key ({what}) reached the rotation record:\n{dump}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
