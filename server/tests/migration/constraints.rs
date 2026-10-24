use super::*;

#[tokio::test]
async fn racing_imports_do_not_delete_each_others_bytes() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bytes = b"bytes two imports both want".as_slice();
    let hash = blake3::hash(bytes).to_hex().to_string();
    let expression = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@ana:a.example",
                   "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                   "capability": "cap", "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(bytes),
    }]);

    let mut good = migration::export_guild(&a, &s.guild).await.unwrap();
    good["expressions"] = expression.clone();

    let mut bad = migration::export_guild(&a, &s.guild).await.unwrap();
    bad["expressions"] = expression;
    bad["roles"] = json!([{ "nothing_this_server_has": 1 }]);

    let (ok, failed) = tokio::join!(
        import_guild(&b, &good, "@ana:b.example"),
        import_guild(&b, &bad, "@ana:b.example"),
    );
    let new_guild = ok.unwrap();
    failed.unwrap_err();

    let referenced: Option<String> = sqlx::query_scalar("SELECT hash FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(&b.pool)
        .await
        .unwrap();
    assert_eq!(referenced.as_deref(), Some(hash.as_str()), "the committed import lost its row");
    assert!(
        b.cfg.media_dir.join(&hash[0..2]).join(&hash).exists(),
        "a failed import deleted bytes a committed import still points at"
    );
    let _ = new_guild;
}

#[tokio::test]
async fn bytes_no_row_accounts_for_are_collected_later() {
    let b = home("b.example").await;

    let fresh = "0".repeat(64);
    let old = "1".repeat(64);
    let kept = "2".repeat(64);
    for hash in [&fresh, &old, &kept] {
        let dir = b.cfg.media_dir.join(&hash[0..2]);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(hash), b"bytes").unwrap();
    }
    sqlx::query(
        "INSERT INTO media (hash, owner_user_id, filename, mime, size, capability, purpose, \
         created_at, refcount) VALUES (?, '@ana:b.example', 'x', 'image/png', 5, 'c', \
         'expression', 1000, 1)",
    )
    .bind(&kept)
    .execute(&b.pool)
    .await
    .unwrap();

    let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86400);
    for hash in [&old, &kept] {
        let path = b.cfg.media_dir.join(&hash[0..2]).join(hash);
        filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(long_ago)).unwrap();
    }

    telium_server::routes::media::sweep_orphans(&b).await.unwrap();

    assert!(
        !b.cfg.media_dir.join(&old[0..2]).join(&old).exists(),
        "an object nothing accounts for was left in the store forever"
    );
    assert!(
        b.cfg.media_dir.join(&fresh[0..2]).join(&fresh).exists(),
        "the sweep took bytes an import may still be in the middle of writing"
    );
    assert!(
        b.cfg.media_dir.join(&kept[0..2]).join(&kept).exists(),
        "the sweep took bytes a row points at"
    );
}

#[tokio::test]
async fn a_bundle_cannot_hang_a_thread_in_someone_elses_channel() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bystander = seed(&b.pool).await;
    let victim_channel: String =
        sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ? LIMIT 1")
            .bind(&bystander.guild)
            .fetch_one(&b.pool)
            .await
            .unwrap();

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let carried = bundle["threads"][0]["id"].as_str().unwrap().to_string();
    bundle["threads"][0]["parent_id"] = json!(victim_channel);
    bundle["threads"][0]["title"] = json!("CLICK HERE FOR FREE NITRO");

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let planted: Vec<String> = sqlx::query_scalar("SELECT title FROM threads WHERE parent_id = ?")
        .bind(&victim_channel)
        .fetch_all(&b.pool)
        .await
        .unwrap();
    assert!(
        planted.is_empty(),
        "a bundle hung a thread in a guild it has nothing to do with: {planted:?}"
    );
    let _ = carried;
}

#[tokio::test]
async fn a_thread_whose_channel_moved_with_it_still_arrives() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    assert!(!bundle["threads"].as_array().unwrap().is_empty(), "the fixture carries no thread");
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let arrived: Vec<String> = sqlx::query_scalar("SELECT title FROM threads WHERE guild_id = ?")
        .bind(&new_guild)
        .fetch_all(&b.pool)
        .await
        .unwrap();
    assert_eq!(arrived, vec!["a question".to_string()], "the guild's own thread did not arrive");
}

#[tokio::test]
async fn one_account_cannot_expect_a_bundle_from_everybody() {
    let b = home("b.example").await;

    for i in 0..12 {
        let source = format!("s{i}.example");
        migration::create_claim(&b, "guild", &source, "g", "@ana:b.example")
            .await
            .expect("an account was refused outright instead of forgetting an old expectation");
    }
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM import_claims WHERE target_id = ? AND used_at IS NULL",
    )
    .bind("@ana:b.example")
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert!(live <= 4, "one account held {live} live claims at once");

    let newest: Option<String> =
        sqlx::query_scalar("SELECT source FROM import_claims WHERE target_id = ? AND source = ?")
            .bind("@ana:b.example")
            .bind("s11.example")
            .fetch_optional(&b.pool)
            .await
            .unwrap();
    assert_eq!(newest.as_deref(), Some("s11.example"), "the newest claim was the one dropped");

    migration::create_claim(&b, "guild", "s0.example", "g", "@bo:b.example").await.unwrap();
    let theirs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM import_claims WHERE target_id = ? AND used_at IS NULL",
    )
    .bind("@bo:b.example")
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(theirs, 1, "one busy account spent somebody else's allowance");

    sqlx::query("UPDATE import_claims SET expires_at = 1 WHERE target_id = ?")
        .bind("@ana:b.example")
        .execute(&b.pool)
        .await
        .unwrap();
    assert_eq!(migration::sweep_claims(&b).await.unwrap(), live as u64);
}

#[tokio::test]
async fn a_retry_over_stranded_bytes_keeps_them() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bytes = b"bytes a first attempt left behind".as_slice();
    let hash = blake3::hash(bytes).to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@ana:a.example",
                   "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                   "capability": "cap", "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(bytes),
    }]);

    let mut doomed = bundle.clone();
    doomed["roles"] = json!([{ "nothing_this_server_has": 1 }]);
    import_guild(&b, &doomed, "@ana:b.example").await.unwrap_err();

    let path = b.cfg.media_dir.join(&hash[0..2]).join(&hash);
    assert!(path.exists(), "the failed attempt did not leave its bytes behind");
    let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 86400);
    filetime::set_file_mtime(&path, filetime::FileTime::from_system_time(long_ago)).unwrap();

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let row: Option<String> = sqlx::query_scalar("SELECT hash FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(&b.pool)
        .await
        .unwrap();
    assert_eq!(row.as_deref(), Some(hash.as_str()), "the retry did not claim the bytes");

    let age = std::fs::metadata(&path).unwrap().modified().unwrap().elapsed().unwrap();
    assert!(
        age < std::time::Duration::from_secs(600),
        "the retry left its bytes looking abandoned for {age:?}; a sweep running before the \
         row committed would have taken them out from under it"
    );
    telium_server::routes::media::sweep_orphans(&b).await.unwrap();
    assert!(path.exists(), "the sweep took bytes the retry's committed row points at");
}

#[tokio::test]
async fn a_bundle_cannot_point_a_follow_at_someone_elses_channel() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bystander = ulid();
    let theirs = ulid();
    sqlx::query(
        "INSERT INTO guilds (id, alias, name, owner_user_id, settings, created_at) \
         VALUES (?, 'theirs', 'Theirs', '@bo:b.example', '{}', 1000)",
    )
    .bind(&bystander)
    .execute(&b.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, position, created_at) \
         VALUES (?, ?, 'text', 'private', 0, 1000)",
    )
    .bind(&theirs)
    .bind(&bystander)
    .execute(&b.pool)
    .await
    .unwrap();

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["follows"] = json!([{
        "source_id": s.channel.clone(),
        "target_id": theirs.clone(),
        "created_by": "@ana:a.example",
        "created_at": 9000,
    }]);

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let into_theirs: i64 =
        sqlx::query_scalar("SELECT count(*) FROM channel_follows WHERE target_id = ?")
            .bind(&theirs)
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(into_theirs, 0, "a bundle got a standing write into another guild's channel");
}

#[tokio::test]
async fn a_follow_between_two_channels_that_moved_still_arrives() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let followed: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM channel_follows f JOIN channels c ON c.id = f.source_id \
         WHERE c.guild_id = ?",
    )
    .bind(&new_guild)
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(followed, 1, "the guild's own follow did not travel with it");
}

#[tokio::test]
async fn asking_for_every_claim_at_once_does_not_get_more_than_the_limit() {
    let home = home("a.example").await;
    let target = "@mover:a.example";

    let mut asks = Vec::new();
    for i in 0..12 {
        let state = home.state.clone();
        let source_id = format!("g{i}");
        asks.push(async move {
            migration::create_claim(&state, "guild", "a.example", &source_id, target).await
        });
    }
    let got = futures_util::future::join_all(asks).await;
    assert!(got.iter().any(|r| r.is_ok()), "not one of the requests got a claim");

    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM import_claims \
         WHERE target_id = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(target)
    .bind(0i64)
    .fetch_one(&home.pool)
    .await
    .unwrap();
    assert!(
        live <= 4,
        "twelve requests arriving together left the account holding {live} live claims"
    );
}
