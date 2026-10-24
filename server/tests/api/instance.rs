use super::*;

#[tokio::test]
async fn keys_and_discovery_are_published() {
    let s = start().await;
    let (status, wk) = s.get("/.well-known/telium/server", None).await;
    assert_eq!(status, 200);
    assert_eq!(wk["server_name"], "test.example");
    assert_eq!(wk["onboarding"]["recommendations"]["accepting"], false);
    assert_eq!(wk["onboarding"]["recommendations"]["suggest_alternatives"], false);

    let (status, keys) = s.get("/_telium/v1/keys", None).await;
    assert_eq!(status, 200);
    let current = keys["current_key_id"].as_str().unwrap();
    assert!(keys["verify_keys"][current]["key"].is_string());
    assert!(keys["signature"].is_string(), "key publication is self-signed");
}

#[tokio::test]
async fn inbound_and_outbound_onboarding_intent_are_separate() {
    let s = start_with(|cfg| cfg.registration.recommendations.accepting = true).await;
    let (_, wk) = s.get("/.well-known/telium/server", None).await;
    assert_eq!(wk["onboarding"]["recommendations"]["accepting"], true);
    assert_eq!(
        wk["onboarding"]["recommendations"]["suggest_alternatives"], false,
        "accepting referrals does not volunteer this server's own signups"
    );

    let s = start_with(|cfg| cfg.registration.recommendations.suggest_alternatives = true).await;
    let (_, wk) = s.get("/.well-known/telium/server", None).await;
    assert_eq!(wk["onboarding"]["recommendations"]["suggest_alternatives"], true);
    let (_, caps) = s.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["onboarding"]["recommendations"]["suggest_alternatives"], true);
    assert_eq!(caps["onboarding"]["recommendations"]["accepting"], false);
}

#[tokio::test]
async fn backups_snapshot_and_prune() {
    let s = start_with(|cfg| cfg.backup.keep = 2).await;
    s.user("alice").await;
    let state_cfg = Config::default();
    let _ = state_cfg;

    let pool = telium_server::db::connect(&format!(
        "sqlite://{}/telium.db?mode=rwc",
        s.dir.display()
    ))
    .await
    .unwrap();
    let mut cfg = Config::default();
    cfg.backup.dir = s.dir.join("backups");
    cfg.backup.keep = 2;
    cfg.backup.key_file = s.dir.join("backup.key");
    cfg.media_dir = s.dir.join("media");
    cfg.archive.dir = s.dir.join("cold");
    telium_server::backup::keygen(&cfg.backup.key_file).unwrap();
    for _ in 0..3 {
        telium_server::backup::run_once(&pool, &cfg).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(3)).await;
    }
    let count = telium_server::backup::local_archives(&cfg.backup.dir).len();
    assert_eq!(count, 2, "retention keeps exactly `keep` snapshots");
    assert!(telium_server::backup::newest_age_ms(&cfg.backup.dir).unwrap() < 60_000);
}
