use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{bot_receipts, config::Config, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TestState {
    state: AppState,
    dir: std::path::PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl std::ops::Deref for TestState {
    type Target = AppState;

    fn deref(&self) -> &Self::Target {
        &self.state
    }
}

async fn state() -> TestState {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-bot-receipts-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = Config {
        server_name: "test.example".into(),
        public_base_url: "http://test.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    let state = telium_server::build_state(cfg).await.unwrap();
    TestState { state, dir }
}

struct Node {
    name: String,
    state: AppState,
    dir: std::path::PathBuf,
    serve: tokio::task::JoinHandle<()>,
}

impl Drop for Node {
    fn drop(&mut self) {
        self.serve.abort();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn node(
    name: &str,
    listener: tokio::net::TcpListener,
    peers: std::collections::BTreeMap<String, String>,
) -> Node {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-bot-receipts-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut cfg = Config {
        server_name: name.into(),
        public_base_url: format!("http://{addr}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.federation.allow_http = true;
    cfg.federation.peers = peers;
    let state = telium_server::build_state(cfg).await.unwrap();
    let app = telium_server::routes::router(state.clone());
    let serve = tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    Node {
        name: name.into(),
        state,
        dir,
        serve,
    }
}

async fn pair() -> (Node, Node) {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();
    let lg = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let lh = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut peers = std::collections::BTreeMap::new();
    peers.insert(
        "guildhost.test".to_string(),
        format!("http://{}", lg.local_addr().unwrap()),
    );
    peers.insert(
        "bothome.test".to_string(),
        format!("http://{}", lh.local_addr().unwrap()),
    );
    let guild = node("guildhost.test", lg, peers.clone()).await;
    let home = node("bothome.test", lh, peers).await;
    (guild, home)
}

const APP: &str = "01BOTRECEIPT0000000000CROSS";
const BOT: &str = "@crossbot:bothome.test";
const GUILD: &str = "01BOTRECEIPT0000000000GUILD";

async fn seed_application(home: &Node) {
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES ('@owner:bothome.test', 'owner', 'bothome.test', 'unused', 1)",
    )
    .execute(&home.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES (?, '@owner:bothome.test', 'Cross Bot', ?, 1, 1)",
    )
    .bind(APP)
    .bind(BOT)
    .execute(&home.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_identities (user_id, application_id, localpart, domain, created_at) \
         VALUES (?, ?, 'crossbot', 'bothome.test', 1)",
    )
    .bind(BOT)
    .bind(APP)
    .execute(&home.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_settings \
         (application_id, allowed_intents, default_permissions, install_enabled) \
         VALUES (?, 31, 7, 1)",
    )
    .bind(APP)
    .execute(&home.state.pool)
    .await
    .unwrap();
}

async fn seed_install(guild: &Node) {
    let role = "01BOTRECEIPT00000000000ROLE";
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES ('@admin:guildhost.test', 'admin', 'guildhost.test', 'unused', 1)",
    )
    .execute(&guild.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO guilds (id, name, owner_user_id, created_at) \
         VALUES (?, 'Cross', '@admin:guildhost.test', 1)",
    )
    .bind(GUILD)
    .execute(&guild.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, permissions) VALUES (?, ?, 'Cross Bot', 7)",
    )
    .bind(role)
    .bind(GUILD)
    .execute(&guild.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO members \
         (guild_id, user_id, joined_at, display_name, profile_version, \
          bot_application_id, bot_application_origin, bot_allowed_intents, \
          bot_role_id, bot_installed_by) \
         VALUES (?, ?, 2, 'Cross Bot', 1, ?, 'bothome.test', 5, ?, '@admin:guildhost.test')",
    )
    .bind(GUILD)
    .bind(BOT)
    .bind(APP)
    .bind(role)
    .execute(&guild.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_receipt_crosses_a_real_signed_request() {
    let (guild, home) = pair().await;
    seed_application(&home).await;
    seed_install(&guild).await;

    let queued: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT application_origin, active, allowed_intents, permissions \
         FROM bot_receipt_outbox WHERE application_id = ? AND remote_guild_id = ?",
    )
    .bind(APP)
    .bind(GUILD)
    .fetch_one(&guild.state.pool)
    .await
    .unwrap();
    assert_eq!(queued, ("bothome.test".to_string(), 1, 5, 7));

    assert_eq!(
        bot_receipts::flush_due(&guild.state).await.unwrap(),
        1,
        "a signed cross-server receipt must be delivered, not deferred"
    );
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_receipt_outbox")
        .fetch_one(&guild.state.pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "a delivered receipt leaves the outbox");

    let indexed: (String, String, i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT remote_guild_id, guild_domain, allowed_intents, permissions, removed_at \
         FROM bot_installations WHERE application_id = ?",
    )
    .bind(APP)
    .fetch_one(&home.state.pool)
    .await
    .unwrap();
    assert_eq!(indexed.0, GUILD);
    assert_eq!(indexed.1, "guildhost.test");
    assert_eq!(indexed.2, 5);
    assert_eq!(indexed.3, 7);
    assert!(indexed.4.is_none());

    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
        .bind(GUILD)
        .bind(BOT)
        .execute(&guild.state.pool)
        .await
        .unwrap();
    assert_eq!(bot_receipts::flush_due(&guild.state).await.unwrap(), 1);
    let removed_at: Option<i64> = sqlx::query_scalar(
        "SELECT removed_at FROM bot_installations \
         WHERE application_id = ? AND remote_guild_id = ? AND guild_domain = 'guildhost.test'",
    )
    .bind(APP)
    .bind(GUILD)
    .fetch_one(&home.state.pool)
    .await
    .unwrap();
    assert!(removed_at.is_some());
}

#[tokio::test]
async fn a_receipt_may_not_name_a_guild_domain_it_did_not_sign_for() {
    let (guild, home) = pair().await;
    seed_application(&home).await;

    let forged = serde_json::json!({
        "application_id": APP,
        "bot_user_id": BOT,
        "guild_id": GUILD,
        "guild_domain": "somewhere-else.test",
        "active": true,
        "allowed_intents": "5",
        "permissions": "7",
    });
    let sent = telium_server::federation::post_signed(
        &guild.state,
        "bothome.test",
        "/_telium/v1/bots/installations/receipt",
        &forged,
    )
    .await;
    assert!(
        sent.is_err(),
        "a receipt speaking for another domain must be refused"
    );

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_installations")
        .fetch_one(&home.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "a refused receipt writes nothing");
    let _ = home;
}

#[tokio::test]
async fn a_receipt_is_refused_for_an_application_that_is_not_accepting_installs() {
    let (guild, home) = pair().await;
    seed_application(&home).await;
    sqlx::query("UPDATE bot_settings SET install_enabled = 0 WHERE application_id = ?")
        .bind(APP)
        .execute(&home.state.pool)
        .await
        .unwrap();

    let body = serde_json::json!({
        "application_id": APP,
        "bot_user_id": BOT,
        "guild_id": GUILD,
        "guild_domain": guild.name,
        "active": true,
        "allowed_intents": "5",
        "permissions": "7",
    });
    let sent = telium_server::federation::post_signed(
        &guild.state,
        "bothome.test",
        "/_telium/v1/bots/installations/receipt",
        &body,
    )
    .await;
    assert!(
        sent.is_err(),
        "an application not accepting installs gains none"
    );

    let retire = serde_json::json!({
        "application_id": APP,
        "bot_user_id": BOT,
        "guild_id": GUILD,
        "guild_domain": guild.name,
        "active": false,
        "allowed_intents": "0",
        "permissions": "0",
    });
    telium_server::federation::post_signed(
        &guild.state,
        "bothome.test",
        "/_telium/v1/bots/installations/receipt",
        &retire,
    )
    .await
    .expect("a deactivating receipt is always accepted");
    let removed_at: Option<i64> =
        sqlx::query_scalar("SELECT removed_at FROM bot_installations WHERE application_id = ?")
            .bind(APP)
            .fetch_one(&home.state.pool)
            .await
            .unwrap();
    assert!(removed_at.is_some());
}

#[tokio::test]
async fn receipts_follow_authoritative_grants_and_a_guild_move() {
    let s = state().await;
    let guild_id = "01BOTRECEIPT00000000000001";
    let role_id = "01BOTRECEIPT00000000000002";
    let app_id = "01BOTRECEIPT00000000000003";
    let bot_id = "@receiptbot:test.example";

    sqlx::query(
        "INSERT INTO accounts \
         (user_id, localpart, domain, password_hash, created_at) \
         VALUES ('@owner:test.example', 'owner', 'test.example', 'unused', 1)",
    )
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES (?, '@owner:test.example', 'Receipt Bot', ?, 1, 1)",
    )
    .bind(app_id)
    .bind(bot_id)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO guilds (id, name, owner_user_id, created_at) \
         VALUES (?, 'Receipts', '@owner:test.example', 1)",
    )
    .bind(guild_id)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, permissions) VALUES (?, ?, 'Receipt Bot', 7)",
    )
    .bind(role_id)
    .bind(guild_id)
    .execute(&s.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO members \
         (guild_id, user_id, joined_at, display_name, profile_version, \
          bot_application_id, bot_application_origin, bot_allowed_intents, \
          bot_role_id, bot_installed_by) \
         VALUES (?, ?, 2, 'Receipt Bot', 1, ?, 'test.example', 5, ?, '@owner:test.example')",
    )
    .bind(guild_id)
    .bind(bot_id)
    .bind(app_id)
    .bind(role_id)
    .execute(&s.pool)
    .await
    .unwrap();

    let queued: (i64, i64, i64) = sqlx::query_as(
        "SELECT active, allowed_intents, permissions FROM bot_receipt_outbox \
         WHERE application_id = ? AND remote_guild_id = ?",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(queued, (1, 5, 7));

    assert_eq!(bot_receipts::flush_due(&s).await.unwrap(), 1);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM bot_receipt_outbox")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    let indexed: (String, String, i64, i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT remote_guild_id, guild_domain, allowed_intents, permissions, installed_at, removed_at \
         FROM bot_installations WHERE application_id = ?",
    )
    .bind(app_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(indexed.0, guild_id);
    assert_eq!(indexed.1, "test.example");
    assert_eq!(indexed.2, 5);
    assert_eq!(indexed.3, 7);
    let first_installed_at = indexed.4;
    assert!(indexed.5.is_none());

    let mut tx = s.pool.begin().await.unwrap();
    sqlx::query("UPDATE members SET bot_allowed_intents = 9 WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id)
        .bind(bot_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE roles SET permissions = 3 WHERE id = ? AND guild_id = ?")
        .bind(role_id)
        .bind(guild_id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    let queued: (i64, i64, i64) = sqlx::query_as(
        "SELECT active, allowed_intents, permissions FROM bot_receipt_outbox \
         WHERE application_id = ? AND remote_guild_id = ?",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(queued, (1, 9, 3));
    assert_eq!(bot_receipts::flush_due(&s).await.unwrap(), 1);

    let indexed: (i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT allowed_intents, permissions, removed_at FROM bot_installations \
         WHERE application_id = ? AND remote_guild_id = ? AND guild_domain = 'test.example'",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(indexed.0, 9);
    assert_eq!(indexed.1, 3);
    assert!(indexed.2.is_none());

    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id)
        .bind(bot_id)
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(bot_receipts::flush_due(&s).await.unwrap(), 1);
    let removed_at: Option<i64> = sqlx::query_scalar(
        "SELECT removed_at FROM bot_installations \
         WHERE application_id = ? AND remote_guild_id = ? AND guild_domain = 'test.example'",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(removed_at.is_some());

    sqlx::query(
        "INSERT INTO members \
         (guild_id, user_id, joined_at, display_name, profile_version, \
          bot_application_id, bot_application_origin, bot_allowed_intents, \
          bot_role_id, bot_installed_by) \
         VALUES (?, ?, 3, 'Receipt Bot', 1, ?, 'test.example', 9, ?, '@owner:test.example')",
    )
    .bind(guild_id)
    .bind(bot_id)
    .bind(app_id)
    .bind(role_id)
    .execute(&s.pool)
    .await
    .unwrap();
    assert_eq!(bot_receipts::flush_due(&s).await.unwrap(), 1);

    let reinstalled: (i64, Option<i64>) = sqlx::query_as(
        "SELECT installed_at, removed_at FROM bot_installations \
         WHERE application_id = ? AND remote_guild_id = ? AND guild_domain = 'test.example'",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert!(
        reinstalled.0 > first_installed_at,
        "a reinstall must advance the installation generation"
    );
    assert!(reinstalled.1.is_none());

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', '01BOTRECEIPT00000000000099', '{}', 10)",
    )
    .bind(guild_id)
    .execute(&s.pool)
    .await
    .unwrap();

    let queued: (i64, i64, i64) = sqlx::query_as(
        "SELECT active, allowed_intents, permissions FROM bot_receipt_outbox \
         WHERE application_id = ? AND remote_guild_id = ?",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(queued, (0, 0, 0));
    assert_eq!(bot_receipts::flush_due(&s).await.unwrap(), 1);

    let retired: (i64, i64, Option<i64>) = sqlx::query_as(
        "SELECT allowed_intents, permissions, removed_at FROM bot_installations \
         WHERE application_id = ? AND remote_guild_id = ? AND guild_domain = 'test.example'",
    )
    .bind(app_id)
    .bind(guild_id)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(retired.0, 0);
    assert_eq!(retired.1, 0);
    assert!(retired.2.is_some());
}

fn bot_assertion_for(home: &Node, audience: &str, intents: u64, permissions: u64) -> String {
    let now = telium_server::util::now_ms();
    let claims = telium_server::crypto::AssertionClaims {
        user_id: BOT.into(),
        device_id: format!("bot:{APP}:{intents}:{permissions}"),
        device_pubkey: "bot".into(),
        audience: audience.into(),
        origin: home.name.clone(),
        profile_version: 1,
        display_name: "Cross Bot".into(),
        avatar_ref: None,
        iat: now,
        exp: now + 300_000,
    };
    telium_server::crypto::issue_assertion(&home.state.key, &claims)
}

async fn post_session(guild: &Node, assertion: &str) -> (u16, serde_json::Value) {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/_telium/v1/bots/session",
            guild.state.cfg.public_base_url
        ))
        .json(&serde_json::json!({ "assertion": assertion }))
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

#[tokio::test]
async fn a_refused_session_says_why_in_a_field_a_program_can_read() {
    let (guild, home) = pair().await;
    seed_application(&home).await;

    let assertion = bot_assertion_for(&home, &guild.name, 5, 7);
    let (status, body) = post_session(&guild, &assertion).await;
    assert_eq!(status, 403);
    assert_eq!(body["code"], "bot_not_installed");
    assert_eq!(body["error"], "forbidden");
    assert_eq!(body["message"], "bot is not installed on this guild server");

    let (status, body) = post_session(&guild, "not-an-assertion").await;
    assert!(status == 401 || status == 400, "unexpected status {status}");
    assert_eq!(body["code"], "assertion_rejected");

    seed_install(&guild).await;
    let (status, body) = post_session(&guild, &assertion).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["session_token"].is_string());
    assert!(body.get("code").is_none());
}
