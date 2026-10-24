
use sqlx::SqlitePool;
use telium_server::usage;

async fn migrated_pool() -> SqlitePool {
    let pool = SqlitePool::connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite opens");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations run");
    pool
}

async fn account(pool: &SqlitePool, localpart: &str, deactivated: bool) {
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at, deactivated) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(format!("@{localpart}:count.test"))
    .bind(localpart)
    .bind("count.test")
    .bind("not-a-real-hash")
    .bind(0_i64)
    .bind(i64::from(deactivated))
    .execute(pool)
    .await
    .expect("account row inserts");
}

#[tokio::test]
async fn the_count_is_enabled_accounts_and_nothing_else() {
    let pool = migrated_pool().await;
    assert_eq!(usage::count_users(&pool).await.unwrap(), 0);
    account(&pool, "alice", false).await;
    account(&pool, "bob", false).await;
    account(&pool, "carol", true).await;
    assert_eq!(usage::count_users(&pool).await.unwrap(), 2);
}

#[tokio::test]
async fn the_report_id_is_minted_once_and_survives_a_restart() {
    let pool = migrated_pool().await;
    let first = usage::identity(&pool).await.unwrap();
    let again = usage::identity(&pool).await.unwrap();
    assert_eq!(first, again, "a restart must not mint a second identity");
    let stored: String = sqlx::query_scalar("SELECT id FROM usage_identity LIMIT 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, first);
}

#[test]
fn the_body_is_exactly_two_fields_and_names_nobody() {
    let body = usage::ping_body("01JBEXAMPLEEXAMPLEEXAMPLEEXA", 41);
    let text = String::from_utf8(body.clone()).unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let fields = parsed.as_object().unwrap();
    assert_eq!(
        fields.len(),
        2,
        "the body is {{id, users}} and nothing else"
    );
    assert_eq!(parsed["id"], "01JBEXAMPLEEXAMPLEEXAMPLEEXA");
    assert_eq!(parsed["users"], 41);
    assert!(
        !text.contains(env!("CARGO_PKG_VERSION")),
        "the usage body must not carry the server's version"
    );
}
