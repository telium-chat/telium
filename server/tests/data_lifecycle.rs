
use sqlx::Row;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{config::Config, erasure, retention, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Home {
    state: AppState,
    dir: std::path::PathBuf,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl std::ops::Deref for Home {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.state
    }
}

async fn home_with(adjust: impl FnOnce(&mut Config)) -> Home {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-lifecycle-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: "home.test".into(),
        public_base_url: "http://home.test".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    adjust(&mut cfg);
    Home { state: telium_server::build_state(cfg).await.unwrap(), dir }
}

const CONSTRAINED: &[(&str, &str, &str)] = &[("interactions", "kind", "component")];

async fn seed_residue(state: &AppState, user_id: &str) {
    let mut conn = state.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await.unwrap();
    for (table, column) in erasure::RESIDUE_TABLES {
        let info = sqlx::query(&format!("PRAGMA table_info({table})")).fetch_all(&mut *conn).await.unwrap();
        assert!(info.iter().any(|c| c.get::<String, _>("name") == *column), "{table} has no {column}");
        let (mut names, mut values) = (Vec::new(), Vec::<String>::new());
        for col in &info {
            let name: String = col.get("name");
            let ty = col.get::<String, _>("type").to_ascii_uppercase();
            let optional = col.get::<i64, _>("notnull") == 0 && col.get::<i64, _>("pk") == 0
                || col.get::<Option<String>, _>("dflt_value").is_some();
            if name != *column && optional {
                continue;
            }
            let constrained = CONSTRAINED.iter().find(|(t, c, _)| t == table && *c == name);
            values.push(match constrained {
                _ if name == *column => format!("'{user_id}'"),
                Some((_, _, v)) => format!("'{v}'"),
                None if ty.contains("INT") => "0".into(),
                None if ty.contains("REAL") => "0.0".into(),
                None => format!("'{user_id}-x'"),
            });
            names.push(name);
        }
        let sql = format!("INSERT OR REPLACE INTO {table} ({}) VALUES ({})", names.join(", "), values.join(", "));
        sqlx::query(&sql).execute(&mut *conn).await.unwrap_or_else(|e| panic!("seed {table}: {e} ({sql})"));
    }
}

async fn residue_rows(state: &AppState, user_id: &str) -> Vec<&'static str> {
    let mut left = Vec::new();
    for (table, column) in erasure::RESIDUE_TABLES {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?");
        let n: i64 = sqlx::query_scalar(&sql).bind(user_id).fetch_one(&state.pool).await.unwrap();
        if n > 0 {
            left.push(*table);
        }
    }
    left
}

async fn stage(state: &AppState, user_id: &str) -> Option<String> {
    let sql = "SELECT stage FROM account_erasures WHERE user_id = ?";
    sqlx::query_scalar(sql).bind(user_id).fetch_optional(&state.pool).await.unwrap()
}

async fn begin(state: &AppState, user_id: &str) {
    let mut tx = state.pool.begin().await.unwrap();
    erasure::begin(&mut tx, user_id).await.unwrap();
    tx.commit().await.unwrap();
}

async fn set_stage(state: &AppState, user_id: &str, to: &str) {
    let sql = "UPDATE account_erasures SET stage = ?, finished_at = NULL WHERE user_id = ?";
    sqlx::query(sql).bind(to).bind(user_id).execute(&state.pool).await.unwrap();
}

async fn seed_media(state: &AppState, owner: &str, hash: &str, purpose: &str) {
    let sql = "INSERT INTO media (hash, owner_user_id, filename, mime, size, capability, purpose, created_at) \
               VALUES (?, ?, 'f', 'image/png', 3, 'cap', ?, 0)";
    sqlx::query(sql).bind(hash).bind(owner).bind(purpose).execute(&state.pool).await.unwrap();
    let key = telium_server::routes::media::media_key(state, hash);
    state.media_store.put(&key, b"abc".to_vec()).await.unwrap();
}

#[tokio::test]
async fn erasure_clears_its_tables_for_one_account_and_survives_interruption() {
    let home = home_with(|cfg| cfg.retention.erasure_journal_days = 30).await;
    let (user, other) = ("@gone:home.test", "@stays:home.test");
    seed_residue(&home, user).await;
    seed_residue(&home, other).await;
    let all = erasure::RESIDUE_TABLES.len();
    assert_eq!(residue_rows(&home, user).await.len(), all, "the fixture failed to seed every table");
    let (avatar, attachment, sticker) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
    for (hash, purpose) in [(&avatar, "profile"), (&attachment, "attachment"), (&sticker, "expression")] {
        seed_media(&home, user, hash, purpose).await;
    }

    begin(&home, user).await;
    assert_eq!(stage(&home, user).await.as_deref(), Some(erasure::RESIDUE));
    assert_eq!(erasure::run_due(&home).await.unwrap(), 1);
    assert_eq!(residue_rows(&home, user).await, Vec::<&str>::new());
    assert_eq!(residue_rows(&home, other).await.len(), all, "a neighbouring account lost rows");
    assert_eq!(stage(&home, user).await.as_deref(), Some(erasure::FINISHED));
    let mut left: Vec<String> =
        sqlx::query_scalar("SELECT hash FROM media WHERE owner_user_id = ?").bind(user).fetch_all(&home.pool).await.unwrap();
    left.sort();
    assert_eq!(left, vec![attachment.clone(), sticker]);
    let key = |h: &str| telium_server::routes::media::media_key(&home, h);
    assert!(home.media_store.get(&key(&avatar)).await.is_err(), "the avatar bytes survived");
    assert!(home.media_store.get(&key(&attachment)).await.is_ok(), "the attachment bytes did not");
    let sql = "SELECT blobs_erased FROM account_erasures WHERE user_id = ?";
    let blobs: i64 = sqlx::query_scalar(sql).bind(user).fetch_one(&home.pool).await.unwrap();
    assert_eq!(blobs, 1);

    set_stage(&home, user, erasure::MEDIA).await;
    assert_eq!(erasure::run_due(&home).await.unwrap(), 1);
    assert_eq!(stage(&home, user).await.as_deref(), Some(erasure::FINISHED));

    erasure::drive(&home, user).await.unwrap();
    set_stage(&home, user, erasure::RESIDUE).await;
    erasure::drive(&home, user).await.unwrap();
    assert_eq!(stage(&home, user).await.as_deref(), Some(erasure::FINISHED));
    assert_eq!(residue_rows(&home, other).await.len(), all);

    erasure::run_due(&home).await.unwrap();
    assert!(stage(&home, user).await.is_some(), "a fresh record was thrown away");
    let (sql, month_ago) = ("UPDATE account_erasures SET finished_at = ? WHERE user_id = ?", telium_server::util::now_ms() - 31 * DAY);
    sqlx::query(sql).bind(month_ago).bind(user).execute(&home.pool).await.unwrap();
    erasure::run_due(&home).await.unwrap();
    assert!(stage(&home, user).await.is_none());
}


const DAY: i64 = 24 * 60 * 60 * 1000;

async fn seed_retention(pool: &sqlx::SqlitePool) {
    let now = telium_server::util::now_ms();
    for (kind, delivered, at) in [
        ("old-delivered", true, now - 20 * DAY),
        ("new-delivered", true, now - DAY),
        ("old-undelivered", false, now - 400 * DAY),
    ] {
        sqlx::query(
            "INSERT INTO identity_notices (user_id, device_id, kind, guild_server, body, next_at, delivered_at, created_at) \
             VALUES ('@u:home.test', '', ?, 'peer.test', '{}', 0, ?, ?)",
        )
        .bind(kind)
        .bind(delivered.then_some(at))
        .bind(at)
        .execute(pool)
        .await
        .unwrap();
    }
    for (sql, old, new, age) in [
        ("INSERT INTO tombstones (subject_type, subject_id, kind, record, created_at) VALUES ('user', ?, 'gone', '{}', ?)", "@old:home.test", "@new:home.test", 400),
        ("INSERT INTO remote_tombstones (subject_type, subject_id, kind, record, learned_at) VALUES ('user', ?, 'gone', '{}', ?)", "@far:peer.test", "@near:peer.test", 60),
        ("INSERT INTO audit_log (id, guild_id, actor, action, data, created_at) VALUES (?, 'g', '@u:home.test', 'member.kick', '{}', ?)", "a-old", "a-new", 800),
    ] {
        for (id, at) in [(old, now - age * DAY), (new, now - DAY)] {
            sqlx::query(sql).bind(id).bind(at).execute(pool).await.unwrap();
        }
    }
}

#[tokio::test]
async fn the_retention_sweep_removes_only_what_is_past_its_horizon() {
    let home = home_with(|cfg| {
        cfg.retention.delivered_notice_days = 14;
        cfg.retention.tombstone_days = 365;
        cfg.retention.remote_cache_days = 30;
        cfg.retention.audit_log_days = 730;
    })
    .await;
    seed_retention(&home.pool).await;
    let swept = retention::sweep(&home).await.unwrap();
    assert_eq!((swept.notices, swept.tombstones, swept.remote_tombstones, swept.audit_entries), (1, 1, 1, 1));
    let notices: Vec<String> = sqlx::query_scalar("SELECT kind FROM identity_notices ORDER BY kind")
        .fetch_all(&home.pool)
        .await
        .unwrap();
    assert_eq!(notices, vec!["new-delivered", "old-undelivered"]);
    assert_eq!(retention::sweep(&home).await.unwrap(), retention::Swept::default(), "second pass");

    let keep_all = home_with(|cfg| {
        cfg.retention.delivered_notice_days = 0;
        cfg.retention.tombstone_days = 0;
        cfg.retention.remote_cache_days = 0;
        cfg.retention.audit_log_days = 0;
    })
    .await;
    seed_retention(&keep_all.pool).await;
    assert_eq!(retention::sweep(&keep_all).await.unwrap(), retention::Swept::default());
}
