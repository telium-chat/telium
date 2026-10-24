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
        "telium-bot-relocation-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = Config {
        server_name: "old.example".into(),
        public_base_url: "https://old.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    let state = telium_server::build_state(cfg).await.unwrap();
    TestState { state, dir }
}

#[tokio::test]
async fn domain_relocation_rewrites_bot_identity_and_transport_state() {
    let s = state().await;
    let owner = "@developer:old.example";
    let bot = "@helper:old.example";
    let app = "01BOTRELOCATION000000000001";

    sqlx::query(
        "INSERT INTO accounts \
         (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, 'developer', 'old.example', 'unused', 1)",
    )
    .bind(owner)
    .execute(&s.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO bot_applications \
         (id, owner_user_id, name, bot_user_id, created_at, updated_at) \
         VALUES (?, ?, 'Helper', ?, 1, 1)",
    )
    .bind(app)
    .bind(owner)
    .bind(bot)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_identities \
         (user_id, application_id, localpart, domain, created_at) \
         VALUES (?, ?, 'helper', 'old.example', 1)",
    )
    .bind(bot)
    .bind(app)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO bot_settings (application_id, allowed_intents, default_permissions) \
         VALUES (?, 1, 1)",
    )
    .bind(app)
    .execute(&s.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO bot_guild_sessions \
         (token_hash, user_id, application_id, home_domain, display_name, avatar_ref, \
          allowed_intents, created_at, expires_at) \
         VALUES ('session-hash', ?, ?, 'old.example', 'Helper', NULL, 1, 1, 9999999999999)",
    )
    .bind(bot)
    .bind(app)
    .execute(&s.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO bot_installations \
         (application_id, bot_user_id, remote_guild_id, guild_domain, \
          allowed_intents, permissions, installed_at, removed_at) \
         VALUES (?, ?, 'guild-local', 'old.example', 1, 1, 1, NULL)",
    )
    .bind(app)
    .bind(bot)
    .execute(&s.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO bot_receipt_outbox \
         (application_origin, application_id, bot_user_id, remote_guild_id, active, \
          allowed_intents, permissions, queued_at, attempts, next_attempt_at) \
         VALUES ('old.example', ?, ?, 'guild-local', 1, 1, 1, 1, 0, 1)",
    )
    .bind(app)
    .bind(bot)
    .execute(&s.pool)
    .await
    .unwrap();

    let mut conn = s.pool.acquire().await.unwrap();
    telium_server::relocation::remap(
        &mut conn,
        "old.example",
        "new.example",
        "https://new.example",
    )
    .await
    .unwrap();
    drop(conn);

    let app_bot: String =
        sqlx::query_scalar("SELECT bot_user_id FROM bot_applications WHERE id = ?")
            .bind(app)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(app_bot, "@helper:new.example");

    let identity: (String, String) = sqlx::query_as(
        "SELECT user_id, domain FROM bot_identities WHERE application_id = ?",
    )
    .bind(app)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(identity.0, "@helper:new.example");
    assert_eq!(identity.1, "new.example");

    let namespace: (String, String) = sqlx::query_as(
        "SELECT domain, subject_id FROM identity_localparts \
         WHERE subject_kind = 'bot' AND localpart = 'helper'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(namespace.0, "new.example");
    assert_eq!(namespace.1, "@helper:new.example");

    let session: (String, String) = sqlx::query_as(
        "SELECT user_id, home_domain FROM bot_guild_sessions WHERE application_id = ?",
    )
    .bind(app)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(session.0, "@helper:new.example");
    assert_eq!(session.1, "new.example");

    let install: (String, String) = sqlx::query_as(
        "SELECT bot_user_id, guild_domain FROM bot_installations WHERE application_id = ?",
    )
    .bind(app)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(install.0, "@helper:new.example");
    assert_eq!(install.1, "new.example");

    let receipt: (String, String) = sqlx::query_as(
        "SELECT application_origin, bot_user_id FROM bot_receipt_outbox WHERE application_id = ?",
    )
    .bind(app)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(receipt.0, "new.example");
    assert_eq!(receipt.1, "@helper:new.example");

    let owner_after: (String, String) =
        sqlx::query_as("SELECT user_id, domain FROM accounts WHERE localpart = 'developer'")
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(owner_after.0, "@developer:new.example");
    assert_eq!(owner_after.1, "new.example");
}
