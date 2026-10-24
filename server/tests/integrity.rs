
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::objectstore::ObjectStore;

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Server {
    base: String,
    client: reqwest::Client,
    dir: PathBuf,
    state: telium_server::AppState,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct User {
    user_id: String,
    token: String,
}

fn scratch(tag: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-integrity-{tag}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn start() -> Server {
    let dir = scratch("srv");
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
    cfg.backup.dir = dir.join("backups");
    cfg.archive.dir = dir.join("cold");
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap();
    });
    Server { base: format!("http://{addr}"), client: reqwest::Client::new(), dir, state }
}

impl Server {
    async fn call(&self, method: reqwest::Method, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.client.request(method.clone(), format!("{}{path}", self.base));
        if method != reqwest::Method::GET {
            req = req.json(&body);
        }
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        let resp = req.send().await.unwrap();
        (resp.status().as_u16(), resp.json().await.unwrap_or(json!(null)))
    }

    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        self.call(reqwest::Method::POST, path, token, body).await
    }

    async fn user(&self, localpart: &str) -> User {
        let (status, body) = self
            .post("/_telium/v1/register", None, json!({ "localpart": localpart, "password": "correct horse battery" }))
            .await;
        assert_eq!(status, 200, "register: {body}");
        let (status, session) =
            self.post("/_telium/v1/sessions/local", body["access_token"].as_str(), json!({})).await;
        assert_eq!(status, 200, "session: {session}");
        User {
            user_id: body["user_id"].as_str().unwrap().to_string(),
            token: session["session_token"].as_str().unwrap().to_string(),
        }
    }

    async fn guild(&self, owner: &User, members: &[&User]) -> String {
        let (status, guild) = self.post("/_telium/v1/guilds", Some(&owner.token), json!({ "name": "G" })).await;
        assert_eq!(status, 200, "create guild: {guild}");
        let gid = guild["id"].as_str().unwrap().to_string();
        let (status, invite) = self
            .post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&owner.token), json!({ "max_uses": 10 }))
            .await;
        assert_eq!(status, 200, "invite: {invite}");
        let code = invite["code"].as_str().unwrap();
        for m in members {
            let (status, joined) = self.post(&format!("/_telium/v1/invites/{code}/join"), Some(&m.token), json!({})).await;
            assert_eq!(status, 200, "join: {joined}");
        }
        gid
    }

    async fn transfer(&self, gid: &str, by: &User, to: &User) -> u16 {
        self.post(&format!("/_telium/v1/guilds/{gid}/transfer-ownership"), Some(&by.token), json!({ "user_id": to.user_id }))
            .await
            .0
    }

    async fn owner_and_audits(&self, gid: &str) -> (String, i64) {
        let owner = sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
            .bind(gid)
            .fetch_one(&self.state.pool)
            .await
            .unwrap();
        let audits = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_log WHERE guild_id = ? AND action = 'guild.transfer_owner'",
        )
        .bind(gid)
        .fetch_one(&self.state.pool)
        .await
        .unwrap();
        (owner, audits)
    }
}

#[tokio::test]
async fn ownership_transfers_are_guarded_and_audited_exactly_once() {
    let s = start().await;
    let (alice, bob, carol, stranger) = (s.user("alice").await, s.user("bob").await, s.user("carol").await, s.user("x").await);
    let gid = s.guild(&alice, &[&bob, &carol]).await;

    assert_eq!(s.transfer(&gid, &alice, &stranger).await / 100, 4, "non-member recipient");
    assert_eq!(s.owner_and_audits(&gid).await, (alice.user_id.clone(), 0));

    assert_eq!(s.transfer(&gid, &alice, &bob).await, 200);
    assert_eq!(s.transfer(&gid, &alice, &carol).await / 100, 4, "replay from the previous owner");
    assert_eq!(s.owner_and_audits(&gid).await, (bob.user_id.clone(), 1));

    sqlx::query(
        "INSERT INTO audit_log (id, guild_id, actor, action, data, created_at) \
         VALUES ('01ZZZZZZZZZZZZZZZZZZZZZZZZ', ?, ?, 'member.kick', '{not json at all', 2)",
    )
    .bind(&gid)
    .bind(&alice.user_id)
    .execute(&s.state.pool)
    .await
    .unwrap();
    let (status, log) =
        s.call(reqwest::Method::GET, &format!("/_telium/v1/guilds/{gid}/audit-log"), Some(&bob.token), json!(null)).await;
    assert_eq!(status, 200, "{log}");
    let actions: Vec<&str> = log["entries"].as_array().unwrap().iter().filter_map(|e| e["action"].as_str()).collect();
    assert!(actions.contains(&"guild.transfer_owner") && actions.contains(&"member.kick"), "{log}");
}

#[tokio::test]
async fn an_object_being_overwritten_is_never_observed_half_written() {
    let dir = scratch("objectstore");
    let key = dir.join("attachment.bin").to_string_lossy().to_string();
    let store = ObjectStore::Local;
    let (small, large) = (vec![b'a'; 64 * 1024], vec![b'b'; 192 * 1024]);
    store.put(&key, small.clone()).await.unwrap();

    let reader_key = key.clone();
    let reader = tokio::spawn(async move {
        let mut reads = 0;
        for _ in 0..4_000 {
            match tokio::fs::read(&reader_key).await {
                Ok(bytes) => {
                    let whole = (bytes.len() == 64 * 1024 && bytes.iter().all(|b| *b == b'a'))
                        || (bytes.len() == 192 * 1024 && bytes.iter().all(|b| *b == b'b'));
                    assert!(whole, "observed a torn {}-byte object", bytes.len());
                    reads += 1;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => panic!("unexpected read error: {e}"),
            }
            tokio::task::yield_now().await;
        }
        reads
    });
    for i in 0..200 {
        store.put(&key, if i % 2 == 0 { large.clone() } else { small.clone() }).await.unwrap();
    }
    assert!(reader.await.unwrap() > 0, "the reader never read the object, so this proved nothing");

    let path = dir.join("nested/object");
    telium_server::objectstore::write_atomically(&path, b"first").await.unwrap();
    telium_server::objectstore::write_atomically(&path, b"second and longer").await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"second and longer");
    let left: Vec<String> =
        std::fs::read_dir(dir.join("nested")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
    assert_eq!(left, vec!["object".to_string()]);
    let _ = std::fs::remove_dir_all(&dir);
}

async fn populated_database(dir: &Path) -> String {
    let url = format!("sqlite://{}/telium.db?mode=rwc", dir.display());
    let pool = telium_server::db::connect(&url).await.expect("a fresh database opens");
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)").execute(&pool).await.unwrap();
    pool.close().await;
    url
}

#[tokio::test]
async fn a_database_with_damaged_pages_is_refused_before_anything_migrates_it() {
    use std::io::{Seek, SeekFrom, Write};
    use telium_server::config::{Integrity, IntegrityMode};

    let dir = scratch("corrupt");
    let url = populated_database(&dir).await;
    let path = dir.join("telium.db");
    let len = std::fs::metadata(&path).unwrap().len();
    assert!(len > 8192);
    let mut file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
    file.seek(SeekFrom::Start(4096)).unwrap();
    file.write_all(&vec![0x5au8; (len as usize - 4096).min(16384)]).unwrap();
    file.sync_all().unwrap();

    let err = telium_server::db::connect(&url).await.expect_err("damaged database opened").to_string();
    assert!(err.contains("quick_check") || err.contains("integrity_check"), "{err}");
    for want in ["integrity check failed", "backup", "restore", "TELIUM_DB_INTEGRITY"] {
        assert!(err.to_lowercase().contains(&want.to_lowercase()), "refusal lacks {want:?}: {err}");
    }

    let permissive = Integrity {
        startup_check: IntegrityMode::Quick,
        foreign_key_check: true,
        refuse_start_on_corruption: false,
    };
    if let Err(e) = telium_server::db::connect_checked(&url, &permissive).await {
        assert!(!e.to_string().contains("will not start"), "{e}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn rows_whose_foreign_keys_point_at_nothing_are_refused_at_startup() {
    let dir = scratch("orphans");
    let url = populated_database(&dir).await;
    let pool = telium_server::db::connect(&url).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();
    for sql in [
        "PRAGMA foreign_keys = OFF",
        "INSERT INTO identity_roots (user_id, immutable_id, genesis_key, anchor_signature, current_key, created_at, updated_at) \
         VALUES ('@nobody:test.example', 'i', 'g', 'a', 'c', 0, 0)",
        "PRAGMA wal_checkpoint(TRUNCATE)",
    ] {
        sqlx::query(sql).execute(&mut *conn).await.unwrap();
    }
    drop(conn);
    pool.close().await;

    let err = telium_server::db::connect(&url).await.expect_err("dangling foreign keys opened").to_string();
    assert!(err.contains("foreign key") || err.contains("missing"), "{err}");
    assert!(err.contains("TELIUM_DB_INTEGRITY"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_example_config_still_describes_the_config_this_binary_has() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("telium.example.toml");
    let text = std::fs::read_to_string(&path).unwrap();
    let cfg: Config = toml::from_str(&text).expect("telium.example.toml no longer parses");
    let (b, d) = (&cfg.backup, &Config::default().backup);
    assert!(b.enabled, "the example turns backups on deliberately");
    assert_eq!(
        (
            b.interval_secs, b.keep, b.stale_after_secs, b.include_media, b.drill, b.drill_interval_secs,
            b.drill_stale_after_secs, b.pre_migration_backup, b.require_backup_before_migration,
        ),
        (
            d.interval_secs, d.keep, d.stale_after_secs, d.include_media, d.drill, d.drill_interval_secs,
            d.drill_stale_after_secs, d.pre_migration_backup, d.require_backup_before_migration,
        )
    );
    let edits: &[(&str, &str, fn(&Config) -> String)] = &[
        ("drill = true", "drill = false", |c| c.backup.drill.to_string()),
        ("drill_interval_secs = 86400", "drill_interval_secs = 3600", |c| c.backup.drill_interval_secs.to_string()),
        ("drill_stale_after_secs = 259200", "drill_stale_after_secs = 9", |c| c.backup.drill_stale_after_secs.to_string()),
        ("pre_migration_backup = true", "pre_migration_backup = false", |c| c.backup.pre_migration_backup.to_string()),
        ("before_migration = false", "before_migration = true", |c| c.backup.require_backup_before_migration.to_string()),
    ];
    for (from, to, read) in edits {
        assert!(text.contains(from), "`{from}` is not in telium.example.toml");
        let edited: Config = toml::from_str(&text.replace(from, to)).unwrap();
        assert_eq!(read(&edited), to.rsplit(" = ").next().unwrap(), "`{from}` is not the key the parser reads");
    }
}
