
use sqlx::SqlitePool;
use telium_server::{build_state, build_state_as, Config, Role};

fn config(tag: &str) -> Config {
    let dir = std::env::temp_dir().join(format!("telium-role-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: "role.test.invalid".into(),
        public_base_url: "http://127.0.0.1:0".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.mfa.key_file = dir.join("mfa.key");
    cfg
}

async fn put_live_call(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO voice_states (guild_id, user_id, channel_id, device_id, session_id, region, joined_at, updated_at) \
         VALUES ('g1', '@alice:role.test.invalid', 'c1', 'dev', 's1', 'role.test.invalid', 1, 1)",
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn reclaim_until(pool: &SqlitePool) -> Option<i64> {
    sqlx::query_scalar("SELECT reclaim_until FROM voice_states").fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn a_tool_run_takes_no_lease_and_leaves_a_live_call_alone() {
    let cfg = config("tool");
    let server = build_state(cfg.clone()).await.unwrap();
    assert!(server.lease.is_some(), "the serving build must hold the lease");
    put_live_call(&server.pool).await;
    let tool = build_state_as(cfg, Role::Tool).await.unwrap();
    assert!(tool.lease.is_none(), "a one-off command claimed the lease");
    assert_eq!(reclaim_until(&tool.pool).await, None, "a tool run scheduled a live call for deletion");
    server.pool.close().await;
    tool.pool.close().await;
}

#[tokio::test]
async fn a_boot_still_sweeps_what_the_last_run_left() {
    let cfg = config("serve");
    let first = build_state(cfg.clone()).await.unwrap();
    put_live_call(&first.pool).await;
    first.pool.close().await;
    drop(first);
    let second = build_state(cfg).await.unwrap();
    assert!(reclaim_until(&second.pool).await.is_some(), "a restart left a stale voice state undated");
    second.pool.close().await;
}
