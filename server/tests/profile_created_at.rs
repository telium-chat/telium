use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{config::Config, routes::identity, AppState};

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

async fn home() -> Home {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "telium-profile-created-at-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut cfg = Config {
        server_name: "home.example".into(),
        public_base_url: "http://home.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    let state = telium_server::build_state(cfg).await.unwrap();
    Home { state, dir }
}

#[tokio::test]
async fn profile_created_at_uses_original_identity_date_after_migration() {
    let home = home().await;
    let user_id = "@alice:home.example";

    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, 'alice', 'home.example', 'hash', 2000)",
    )
    .bind(user_id)
    .execute(&home.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO profiles (user_id, display_name, profile_version, updated_at) \
         VALUES (?, 'Alice', 1, 2000)",
    )
    .bind(user_id)
    .execute(&home.state.pool)
    .await
    .unwrap();

    let local = identity::load_profile(&home.state, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(local["created_at"].as_i64(), Some(2000));

    sqlx::query(
        "INSERT INTO imported_identities \
         (user_id, previous_id, original_created_at, chain, imported_at) \
         VALUES (?, '@alice:old.example', 1000, '[]', 2000)",
    )
    .bind(user_id)
    .execute(&home.state.pool)
    .await
    .unwrap();

    let migrated = identity::load_profile(&home.state, user_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(migrated["created_at"].as_i64(), Some(1000));
}

#[tokio::test]
async fn profile_is_bot_comes_from_the_account_not_a_guild_membership() {
    let home = home().await;
    let human = "@alice:home.example";
    let bot = "@helper:home.example";

    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, 'alice', 'home.example', 'hash', 2000)",
    )
    .bind(human)
    .execute(&home.state.pool)
    .await
    .unwrap();
    for (user_id, name) in [(human, "Alice"), (bot, "Helper")] {
        sqlx::query(
            "INSERT INTO profiles (user_id, display_name, profile_version, updated_at) \
             VALUES (?, ?, 1, 2000)",
        )
        .bind(user_id)
        .bind(name)
        .execute(&home.state.pool)
        .await
        .unwrap();
    }

    let alice = identity::load_profile(&home.state, human)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(alice["is_bot"].as_bool(), Some(false));

    sqlx::query(
        "INSERT INTO bot_identities (user_id, application_id, localpart, domain, created_at) \
         VALUES (?, 'app-1', 'helper', 'home.example', 2000)",
    )
    .bind(bot)
    .execute(&home.state.pool)
    .await
    .unwrap();

    let helper = identity::load_profile(&home.state, bot)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(helper["is_bot"].as_bool(), Some(true));

    sqlx::query("UPDATE bot_identities SET disabled = 1 WHERE user_id = ?")
        .bind(bot)
        .execute(&home.state.pool)
        .await
        .unwrap();
    let disabled = identity::load_profile(&home.state, bot)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(disabled["is_bot"].as_bool(), Some(true));
}
