use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{config::Config, AppState};

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
    let dir = std::env::temp_dir().join(format!(
        "telium-bot-account-migration-{}-{n}",
        std::process::id()
    ));
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

async fn account(s: &AppState, user_id: &str) {
    let localpart = user_id
        .strip_prefix('@')
        .and_then(|value| value.split(':').next())
        .unwrap();
    sqlx::query(
        "INSERT OR IGNORE INTO accounts \
         (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, ?, 'test.example', 'unused', 1)",
    )
    .bind(user_id)
    .bind(localpart)
    .execute(&s.pool)
    .await
    .unwrap();
}

async fn app(s: &AppState, id: &str, owner: &str, localpart: &str) {
    account(s, owner).await;
    let bot = format!("@{localpart}:test.example");
    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 1, 1)",
    )
    .bind(id)
    .bind(owner)
    .bind(localpart)
    .bind(&bot)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_identities \
         (user_id, application_id, localpart, domain, created_at) \
         VALUES (?, ?, ?, 'test.example', 1)",
    )
    .bind(bot)
    .bind(id)
    .bind(localpart)
    .execute(&s.pool)
    .await
    .unwrap();
}

async fn migration(s: &AppState, id: &str, user: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO migrations \
         (id, subject_type, subject_id, destination, grant_token, device_id, device_sig, \
          state, created_at, executes_at) \
         VALUES (?, 'user', ?, 'new.example', 'grant', 'device', 'sig', 'pending', 1, 2)",
    )
    .bind(id)
    .bind(user)
    .execute(&s.pool)
    .await
    .map(|_| ())
}

#[tokio::test]
async fn active_apps_block_account_migration_but_retired_identities_do_not() {
    let s = state().await;
    let owner = "@developer:test.example";
    let app_id = "01BOTMIGRATION0000000000001";
    app(&s, app_id, owner, "migrationbot").await;

    let active = migration(&s, "migration-active", owner).await;
    let error = active.expect_err("an active bot identity must stop its owner moving away");
    let message = error.to_string();
    assert!(
        message.contains("retire") || message.contains("disable"),
        "the trigger should explain that the bot application must be retired first: {message}"
    );

    sqlx::query("UPDATE bot_identities SET disabled = 1 WHERE application_id = ?")
        .bind(app_id)
        .execute(&s.pool)
        .await
        .unwrap();
    migration(&s, "migration-retired", owner)
        .await
        .expect("a permanently retired bot identity should not strand its developer account");
}

#[tokio::test]
async fn a_pending_account_migration_blocks_new_bot_applications() {
    let s = state().await;
    let owner = "@moving:test.example";
    account(&s, owner).await;
    migration(&s, "migration-pending", owner).await.unwrap();

    let result = sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES ('01BOTMIGRATION0000000000002', ?, 'Too Late', '@toolate:test.example', 1, 1)",
    )
    .bind(owner)
    .execute(&s.pool)
    .await;
    assert!(result.is_err(), "a new bot app must not race into a pending account migration");
}


#[tokio::test]
async fn active_apps_block_permanent_account_deletion_but_retired_apps_do_not() {
    let s = state().await;
    let owner = "@deleteowner:test.example";
    let app_id = "01BOTDELETE0000000000000001";
    app(&s, app_id, owner, "deletebot").await;

    let active = sqlx::query("UPDATE accounts SET deleted_at = 10 WHERE user_id = ?")
        .bind(owner)
        .execute(&s.pool)
        .await;
    let error = active.expect_err("active bot apps must stop permanent owner deletion");
    assert!(
        error
            .to_string()
            .contains("retire active bot applications before deleting the account"),
        "delete guard should explain how to resolve it: {error}"
    );

    sqlx::query("UPDATE bot_identities SET disabled = 1 WHERE application_id = ?")
        .bind(app_id)
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET deleted_at = 10 WHERE user_id = ?")
        .bind(owner)
        .execute(&s.pool)
        .await
        .expect("retired apps should not permanently pin the developer account");
}

#[tokio::test]
async fn deleted_accounts_cannot_gain_new_bot_applications() {
    let s = state().await;
    let owner = "@gone:test.example";
    account(&s, owner).await;
    sqlx::query("UPDATE accounts SET deleted_at = 10 WHERE user_id = ?")
        .bind(owner)
        .execute(&s.pool)
        .await
        .unwrap();

    let result = sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES ('01BOTDELETE0000000000000002', ?, 'Too Late', '@latebot:test.example', 1, 1)",
    )
    .bind(owner)
    .execute(&s.pool)
    .await;
    assert!(
        result.is_err(),
        "a concurrently deleted account must not become the owner of a new bot app"
    );
}

#[tokio::test]
async fn a_standby_bootstraps_from_a_primary_that_has_bots_and_a_closed_developer() {
    let s = state().await;

    app(&s, "app-retired", "@dev:test.example", "retiredbot").await;
    sqlx::query("UPDATE bot_identities SET disabled = 1 WHERE application_id = 'app-retired'")
        .execute(&s.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET deleted_at = 5 WHERE user_id = '@dev:test.example'")
        .execute(&s.pool)
        .await
        .unwrap();

    account(&s, "@owner:test.example").await;
    sqlx::query(
        "INSERT INTO guilds (id, name, owner_user_id, created_at) \
         VALUES ('guild-1', 'Guild', '@owner:test.example', 1)",
    )
    .execute(&s.pool)
    .await
    .unwrap();
    app(&s, "app-live", "@owner:test.example", "livebot").await;
    sqlx::query(
        "INSERT INTO members \
         (guild_id, user_id, joined_at, bot_application_id, bot_application_origin, \
          bot_allowed_intents, bot_installed_by) \
         VALUES ('guild-1', '@livebot:test.example', 1, 'app-live', 'test.example', 1, \
                 '@owner:test.example')",
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let queued: i64 = sqlx::query_scalar("SELECT count(*) FROM bot_receipt_outbox")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(queued, 1, "installing a bot on the primary queues its receipt");
    sqlx::query("DELETE FROM bot_receipt_outbox").execute(&s.pool).await.unwrap();

    let file = telium_server::replicate::snapshot(&s.pool, &s.dir.join("snapshots"))
        .await
        .unwrap();
    let mirror = s.dir.join("mirror");
    std::fs::create_dir_all(&mirror).unwrap();
    let standby = telium_server::db::connect_without_foreign_keys(&format!(
        "sqlite://{}/telium.db?mode=rwc",
        mirror.display()
    ))
    .await
    .unwrap();
    let before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type = 'trigger'")
            .fetch_one(&standby)
            .await
            .unwrap();
    assert!(before > 0, "a migrated standby has the primary's triggers");

    telium_server::replicate::install_snapshot(&standby, &file)
        .await
        .expect("a standby bootstraps from a primary whose developer has closed their account");

    let apps: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM bot_applications WHERE id IN ('app-retired', 'app-live') ORDER BY id",
    )
    .fetch_all(&standby)
    .await
    .unwrap();
    assert_eq!(apps, ["app-live", "app-retired"], "both applications arrived");
    let deleted: Option<i64> =
        sqlx::query_scalar("SELECT deleted_at FROM accounts WHERE user_id = '@dev:test.example'")
            .fetch_one(&standby)
            .await
            .unwrap();
    assert_eq!(deleted, Some(5), "the closed account arrived closed");

    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM bot_receipt_outbox")
        .fetch_one(&standby)
        .await
        .unwrap();
    assert_eq!(
        receipts, 0,
        "copying a membership in is not an installation, and must not tell the bot's home it was"
    );

    let after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type = 'trigger'")
            .fetch_one(&standby)
            .await
            .unwrap();
    assert_eq!(after, before, "every trigger is back once the copy has landed");
}
