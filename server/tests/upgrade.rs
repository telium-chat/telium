
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::db;

static COUNTER: AtomicU32 = AtomicU32::new(0);

const SUPPORTED_UPGRADE_POINTS: &[i64] = &[1, 2, 29, 40, 49, 56];

const FUTURE_MIGRATION: &str = "INSERT INTO _sqlx_migrations \
    (version, description, installed_on, success, checksum, execution_time) \
    VALUES (?, 'from the future', CURRENT_TIMESTAMP, 1, X'00', 0)";

struct TempDb {
    url: String,
    dir: PathBuf,
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn empty_db() -> TempDb {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-upgrade-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    TempDb { url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()), dir }
}

async fn current_db() -> TempDb {
    let db = empty_db();
    db::connect(&db.url).await.unwrap().close().await;
    db
}

async fn raw(url: &str) -> SqlitePool {
    SqlitePoolOptions::new().max_connections(1).connect(url).await.unwrap()
}

async fn doctor(db: &TempDb, sql: &str, bind: Option<i64>) {
    let pool = raw(&db.url).await;
    let mut q = sqlx::query(sql);
    if let Some(v) = bind {
        q = q.bind(v);
    }
    q.execute(&pool).await.unwrap();
    pool.close().await;
}

async fn provenance(pool: &SqlitePool) -> db::Provenance {
    db::read_provenance(pool).await.unwrap()
}

async fn table_names(pool: &SqlitePool) -> Vec<String> {
    sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_fresh_database_is_stamped_and_a_restart_keeps_the_stamp() {
    let db = current_db().await;
    let pool = db::connect(&db.url).await.unwrap();
    let found = provenance(&pool).await;
    assert_eq!(found.migration_version, Some(db::latest_migration_version()));
    assert_eq!(found.state_format_version, Some(db::STATE_FORMAT_VERSION));
    assert_eq!(found.release_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
    assert_eq!(found.protocol_version, Some(i64::from(telium_protocol::compat::PROTOCOL_VERSION)));
    assert!(found.applied_at.unwrap_or(0) > 0);
}

#[tokio::test]
async fn every_supported_previous_release_still_upgrades_forward_cleanly() {
    let all = sqlx::migrate!("./migrations");
    let complete = {
        let db = current_db().await;
        let pool = raw(&db.url).await;
        table_names(&pool).await
    };
    for &point in SUPPORTED_UPGRADE_POINTS {
        assert!(all.migrations.iter().any(|m| m.version == point), "migration {point} does not exist");
        assert!(point < db::latest_migration_version());
        let db = empty_db();

        let prefix: Vec<_> = all.migrations.iter().filter(|m| m.version <= point).cloned().collect();
        let old = raw(&db.url).await;
        Migrator { migrations: Cow::Owned(prefix), ..Migrator::DEFAULT }.run(&old).await.unwrap();
        let before = provenance(&old).await;
        assert_eq!(before.applied_migration, Some(point));
        assert_eq!(before.migration_high_water(), point, "the migration log answers without provenance");
        old.close().await;

        let pool = db::connect(&db.url).await.unwrap_or_else(|e| panic!("upgrade from {point} failed: {e}"));
        let found = provenance(&pool).await;
        assert_eq!(found.migration_version, Some(db::latest_migration_version()), "from {point}");
        assert_eq!(found.release_version.as_deref(), Some(env!("CARGO_PKG_VERSION")), "from {point}");
        assert_eq!(table_names(&pool).await, complete, "upgraded from {point} differs from fresh");
        pool.close().await;
    }
}

#[tokio::test]
async fn a_database_from_a_newer_release_is_refused_at_startup() {
    let latest = db::latest_migration_version();
    let fmt = db::STATE_FORMAT_VERSION;
    let cases: &[(&[(&str, Option<i64>)], &[&str])] = &[
        (
            &[
                (FUTURE_MIGRATION, Some(latest + 4)),
                ("UPDATE schema_provenance SET migration_version = ?, release_version = '9.9.9'", Some(latest + 4)),
            ],
            &["refusing to start", "telium-server 9.9.9", "telium-server restore", "docs/upgrade.md"],
        ),
        (
            &[("UPDATE schema_provenance SET state_format_version = ?, release_version = '9.9.9'", Some(fmt + 1))],
            &["durable state format", "telium-server 9.9.9"],
        ),
        (&[(FUTURE_MIGRATION, Some(latest + 1))], &[]),
    ];
    for (doctoring, says) in cases {
        let db = current_db().await;
        for (sql, bind) in doctoring.iter() {
            doctor(&db, sql, *bind).await;
        }
        let text = db::connect(&db.url).await.unwrap_err().to_string();
        for s in says.iter() {
            assert!(text.contains(s), "missing {s:?}: {text}");
        }
        if !says.is_empty() {
            assert!(!text.contains(&format!("telium-server {} again", env!("CARGO_PKG_VERSION"))), "{text}");
        }
    }

    let db = current_db().await;
    doctor(&db, "UPDATE schema_provenance SET state_format_version = ?", Some(fmt + 1)).await;
    let err = db::connect_without_foreign_keys(&db.url).await.unwrap_err();
    assert!(err.to_string().contains("refusing to start"), "{err}");
}

#[tokio::test]
async fn an_allowed_rollback_cannot_lower_the_numbers_the_guard_compares() {
    let db = current_db().await;
    doctor(&db, "UPDATE schema_provenance SET release_version = '9.9.9', protocol_version = 9", None).await;
    let pool = db::connect(&db.url).await.unwrap();
    let found = provenance(&pool).await;
    assert_eq!(found.protocol_version, Some(9));
    assert_eq!(found.migration_version, Some(db::latest_migration_version()));
    assert_eq!(found.release_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
}

/// Migration 0099 withdraws the legacy custody key material and keeps a copy of everything it withdrew, so the step can
/// be undone. Nothing else changes: no row is removed, a vault keeps its mode, and a recovery-key copy is untouched.
#[tokio::test]
async fn retiring_legacy_custody_archives_what_it_withdraws_and_keeps_everything_else() {
    let all = sqlx::migrate!("./migrations");
    let before = all.migrations.iter().find(|m| m.description.starts_with("retire legacy custody")).unwrap().version - 1;
    let db = empty_db();
    let prefix: Vec<_> = all.migrations.iter().filter(|m| m.version <= before).cloned().collect();
    let old = raw(&db.url).await;
    Migrator { migrations: Cow::Owned(prefix), ..Migrator::DEFAULT }.run(&old).await.unwrap();
    for (user, mode, ct, escrow, independent) in [
        ("@escrowed:a.test", "escrowed", "esc.ct", Some("ESCROW-KEY"), None),
        ("@selfcust:a.test", "self_custody", "self.ct", None, None),
        ("@opaque-p2:a.test", "opaque_custody", "op.ct", None, Some("p2.salt.iv.ct")),
        ("@opaque-old:a.test", "opaque_custody", "op2.ct", None, Some("iv.ct")),
        ("@opaque-k1:a.test", "opaque_custody", "op3.ct", None, Some("k1.iv.ct")),
        ("@device:a.test", "device_custody", "dev.ct", None, None),
    ] {
        sqlx::query(
            "INSERT INTO key_vault (user_id, mode, ciphertext, escrow_key, independent_ciphertext, version, updated_at) \
             VALUES (?, ?, ?, ?, ?, 3, 1)",
        )
        .bind(user)
        .bind(mode)
        .bind(ct)
        .bind(escrow)
        .bind(independent)
        .execute(&old)
        .await
        .unwrap();
    }
    old.close().await;

    let pool = db::connect(&db.url).await.unwrap();
    let rows: Vec<(String, String, String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT user_id, mode, ciphertext, escrow_key, independent_ciphertext, version FROM key_vault ORDER BY user_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 6, "no vault row is removed");
    for (user, mode, ct, escrow, independent, version) in &rows {
        assert!(escrow.is_none(), "{user} still has an escrow key");
        assert!(independent.as_deref().map_or(true, |c| c.starts_with("k1.")), "{user} kept a passphrase copy");
        assert_eq!(*version, 3, "{user}: a withdrawal is not a vault write");
        let expected_mode = match user.as_str() {
            "@escrowed:a.test" => "escrowed",
            "@selfcust:a.test" => "self_custody",
            "@device:a.test" => "device_custody",
            _ => "opaque_custody",
        };
        assert_eq!(mode, expected_mode, "{user}: the mode is left for the client to read as locked");
        assert!(!ct.is_empty());
    }
    let kept: Option<String> = sqlx::query_scalar("SELECT independent_ciphertext FROM key_vault WHERE user_id = '@opaque-k1:a.test'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept.as_deref(), Some("k1.iv.ct"), "a recovery-key copy is not touched");

    let archived: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT user_id, ciphertext, escrow_key, independent_ciphertext FROM key_vault_legacy_archive ORDER BY user_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        archived,
        vec![
            ("@escrowed:a.test".into(), "esc.ct".into(), Some("ESCROW-KEY".into()), None),
            ("@opaque-old:a.test".into(), "op2.ct".into(), None, Some("iv.ct".into())),
            ("@opaque-p2:a.test".into(), "op.ct".into(), None, Some("p2.salt.iv.ct".into())),
        ],
        "exactly the rows it changed are archived, whole",
    );

    // The documented restore puts the withdrawn columns back.
    sqlx::query(
        "UPDATE key_vault SET \
           escrow_key = (SELECT escrow_key FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id), \
           independent_ciphertext = COALESCE( \
             (SELECT independent_ciphertext FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id), \
             independent_ciphertext) \
         WHERE user_id = '@escrowed:a.test' \
           AND EXISTS (SELECT 1 FROM key_vault_legacy_archive a WHERE a.user_id = key_vault.user_id)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let back: Option<String> = sqlx::query_scalar("SELECT escrow_key FROM key_vault WHERE user_id = '@escrowed:a.test'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(back.as_deref(), Some("ESCROW-KEY"));
    pool.close().await;
}
