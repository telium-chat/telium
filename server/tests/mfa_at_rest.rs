
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::Sha1;
use sqlx::Row;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::{mfa, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Home {
    state: AppState,
    dir: PathBuf,
    cfg: Config,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn new_home(tag: &str) -> Home {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-mfa-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: "mfa.test.invalid".into(),
        public_base_url: "http://127.0.0.1:0".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.mfa.key_file = dir.join("mfa.key");
    cfg.rate_limit.auth_burst = 1_000;
    let state = telium_server::build_state(cfg.clone()).await.unwrap();
    Home { state, dir, cfg }
}

fn totp_now(secret: &str) -> String {
    let (mut key, mut buffer, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in secret.chars() {
        let v = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            '2'..='7' => c as u32 - '2' as u32 + 26,
            _ => continue,
        };
        buffer = (buffer << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            key.push((buffer >> bits) as u8);
        }
    }
    let counter = (telium_server::util::now_ms() / 1000 / 30) as u64;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).unwrap();
    mac.update(&counter.to_be_bytes());
    let d = mac.finalize().into_bytes();
    let o = (d[19] & 0x0f) as usize;
    let binary = u32::from_be_bytes([d[o] & 0x7f, d[o + 1], d[o + 2], d[o + 3]]);
    format!("{:06}", binary % 1_000_000)
}

async fn every_stored_string(state: &AppState) -> Vec<(String, String, String)> {
    let tables: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    let mut out = Vec::new();
    for (table,) in tables {
        for column in sqlx::query(&format!("PRAGMA table_info({table})")).fetch_all(&state.pool).await.unwrap() {
            let name: String = column.get("name");
            let values: Vec<(Option<Vec<u8>>,)> = sqlx::query_as(&format!("SELECT CAST(\"{name}\" AS BLOB) FROM \"{table}\""))
                .fetch_all(&state.pool)
                .await
                .unwrap();
            for value in values.into_iter().filter_map(|v| v.0) {
                out.push((table.clone(), name.clone(), String::from_utf8_lossy(&value).into_owned()));
            }
        }
    }
    out
}

async fn enrol(home: &Home, localpart: &str) -> String {
    use tower::ServiceExt;
    let app = telium_server::routes::router(home.state.clone());
    let post = |path: &str, token: Option<&str>, payload: Value| {
        let (app, path, token) = (app.clone(), path.to_string(), token.map(str::to_string));
        async move {
            let mut req = axum::http::Request::builder().method("POST").uri(path).header("content-type", "application/json");
            if let Some(t) = token {
                req = req.header("authorization", format!("Bearer {t}"));
            }
            let body = axum::body::Body::from(serde_json::to_vec(&payload).unwrap());
            let response = app.oneshot(req.body(body).unwrap()).await.unwrap();
            let status = response.status().as_u16();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            assert_eq!(status, 200, "{value}");
            value
        }
    };
    let password = json!({ "localpart": localpart, "password": "correct horse battery" });
    let token = post("/_telium/v1/register", None, password.clone()).await["access_token"].as_str().unwrap().to_string();
    let secret = post("/_telium/v1/mfa/setup", Some(&token), password).await["secret"].as_str().unwrap().to_string();
    post("/_telium/v1/mfa/enable", Some(&token), json!({ "code": totp_now(&secret) })).await;
    secret
}

#[tokio::test]
async fn secrets_are_sealed_a_lost_key_refuses_the_start_and_reset_all_is_the_way_out() {
    let home = new_home("sealed").await;
    let secrets = [enrol(&home, "ana").await, enrol(&home, "bo").await];
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES ('@cy:mfa.test.invalid', 'cy', 'mfa.test.invalid', 'x', 1000)",
    )
    .execute(&home.state.pool)
    .await
    .unwrap();

    for (table, column, value) in every_stored_string(&home.state).await {
        assert!(!secrets.iter().any(|s| value.contains(s)), "a TOTP secret is stored in the clear in {table}.{column}");
    }
    let row = sqlx::query("SELECT mfa_secret, mfa_sealed FROM accounts WHERE localpart = 'ana'")
        .fetch_one(&home.state.pool)
        .await
        .unwrap();
    assert!(row.get::<Option<String>, _>("mfa_secret").is_none());
    let sealed: String = row.get("mfa_sealed");
    assert!(mfa::is_sealed(Some(&sealed)));
    let opened = mfa::open(&home.state.mfa, "@ana:mfa.test.invalid", &sealed).unwrap();
    assert_eq!(opened.as_deref(), Some(secrets[0].as_str()), "the server must still open what it sealed");

    std::fs::remove_file(&home.cfg.mfa.key_file).unwrap();
    let empty = mfa::load_keyring(&home.cfg).unwrap();
    assert!(empty.is_empty());
    let err = mfa::refuse_if_locked_out(&home.state.pool, &home.cfg, &empty).await.unwrap_err().to_string();
    for needle in ["mfa.key_file", &home.cfg.mfa.key_file.display().to_string(), "previous_key_files", "reset-all"] {
        assert!(err.contains(needle), "missing {needle:?}: {err}");
    }
    let fresh = new_home("nothing-sealed").await;
    mfa::refuse_if_locked_out(&fresh.state.pool, &fresh.cfg, &mfa::Keyring::empty())
        .await
        .expect("nothing sealed, nothing to refuse over");

    let reset = mfa::reset_all(&home.state.pool, "the key file is gone").await.unwrap();
    assert_eq!(reset.accounts.len(), 2, "the enrolled accounts, and only those: {:?}", reset.accounts);
    assert!(reset.recovery_codes_destroyed > 0);
    mfa::refuse_if_locked_out(&home.state.pool, &home.cfg, &empty).await.expect("after reset-all nothing is sealed");
    for row in sqlx::query("SELECT localpart, mfa_enabled, mfa_secret, mfa_sealed, mfa_reenrol_required FROM accounts")
        .fetch_all(&home.state.pool)
        .await
        .unwrap()
    {
        let who: String = row.get("localpart");
        assert_eq!(row.get::<i64, _>("mfa_enabled"), 0, "{who} left enabled with no secret");
        assert!(row.get::<Option<String>, _>("mfa_secret").is_none() && row.get::<Option<String>, _>("mfa_sealed").is_none());
        assert_eq!(row.get::<i64, _>("mfa_reenrol_required") == 1, who != "cy", "{who}");
    }
    let codes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mfa_recovery_codes").fetch_one(&home.state.pool).await.unwrap();
    assert_eq!(codes, 0, "a surviving recovery code is a surviving second factor");

    mfa::record_reset(&home.state.pool, &telium_server::rotations::Actor::observed("a test"), 2).await.unwrap();
    let recent = telium_server::rotations::recent(&home.state.pool, None, 10).await.unwrap();
    let row = recent.iter().find(|r| r.entry == "Per-user MFA secrets").expect("the reset is recorded");
    assert!(!row.detail.to_string().contains("@ana:"), "{}", row.detail);
    assert_eq!(row.detail["affected"], 2, "{}", row.detail);
}

#[tokio::test]
async fn a_secret_left_in_the_clear_by_an_older_build_is_sealed_at_the_next_start() {
    let home = new_home("backfill").await;
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at, mfa_secret, mfa_enabled) \
         VALUES ('@old:mfa.test.invalid', 'old', 'mfa.test.invalid', 'x', 1000, 'JBSWY3DPEHPK3PXP', 1)",
    )
    .execute(&home.state.pool)
    .await
    .unwrap();
    let ring = mfa::load_keyring(&home.cfg).unwrap();
    assert_eq!(mfa::seal_pending(&home.state.pool, &ring).await.unwrap(), 1);
    assert_eq!(mfa::seal_pending(&home.state.pool, &ring).await.unwrap(), 0);
    let row = sqlx::query("SELECT mfa_secret, mfa_sealed FROM accounts WHERE localpart = 'old'")
        .fetch_one(&home.state.pool)
        .await
        .unwrap();
    assert!(row.get::<Option<String>, _>("mfa_secret").is_none());
    let opened = mfa::open(&ring, "@old:mfa.test.invalid", &row.get::<String, _>("mfa_sealed")).unwrap();
    assert_eq!(opened.as_deref(), Some("JBSWY3DPEHPK3PXP"), "the backfill seals the value that was there");

    assert_eq!(mfa::unseal_all(&home.state.pool, &ring).await.unwrap(), (1, 0));
    let back: Option<String> =
        sqlx::query_scalar("SELECT mfa_secret FROM accounts WHERE localpart = 'old'").fetch_one(&home.state.pool).await.unwrap();
    assert_eq!(back.as_deref(), Some("JBSWY3DPEHPK3PXP"));
}
