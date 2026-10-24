use super::*;

fn delivery(id: &str, secret: &str, source_id: &str, target_id: &str) -> handoff::Delivery {
    handoff::Delivery {
        handoff_id: id.into(),
        secret: secret.into(),
        subject_type: "user".into(),
        source_id: source_id.into(),
        target_id: target_id.into(),
        import_token: "claim-from-b".into(),
        claim_expires_at: None,
    }
}

async fn opened(a: &Home, user: &str, destination: &str) -> (String, String) {
    let h = handoff::open(a, user, "user", user, destination).await.unwrap();
    (h["id"].as_str().unwrap().to_string(), h["secret"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn a_handoff_takes_its_claim_only_from_the_destination_it_names() {
    let a = home("a.example").await;
    let (id, secret) = opened(&a, "@ana:a.example", "B.Example.").await;

    let wrong_server = handoff::deliver(&a, "c.example", &delivery(&id, &secret, "@ana:a.example", "@ana:c.example")).await;
    assert!(matches!(wrong_server, Err(ApiError::NotFound(_))), "{wrong_server:?}");
    let wrong_secret = handoff::deliver(&a, "b.example", &delivery(&id, "nope", "@ana:a.example", "@ana:b.example")).await;
    assert!(matches!(wrong_secret, Err(ApiError::NotFound(_))), "{wrong_secret:?}");
    let unknown = handoff::deliver(&a, "b.example", &delivery("01NOPE", &secret, "@ana:a.example", "@ana:b.example")).await;
    assert!(matches!(unknown, Err(ApiError::NotFound(_))), "{unknown:?}");

    let other_account = handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@bo:a.example", "@ana:b.example")).await;
    assert!(matches!(other_account, Err(ApiError::Forbidden(_))), "{other_account:?}");
    let not_its_own = handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:c.example")).await;
    assert!(matches!(not_its_own, Err(ApiError::Forbidden(_))), "{not_its_own:?}");
    let mut empty = delivery(&id, &secret, "@ana:a.example", "@ana:b.example");
    empty.import_token.clear();
    assert!(matches!(handoff::deliver(&a, "b.example", &empty).await, Err(ApiError::BadRequest(_))));

    handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:b.example")).await.unwrap();
    let replay = handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana2:b.example")).await;
    assert!(matches!(replay, Err(ApiError::Conflict(_))), "a handoff is filled in once: {replay:?}");

    let (token, destination, target) = handoff::claim(&a, "@ana:a.example", "user", "@ana:a.example", &id).await.unwrap();
    assert_eq!((token.as_str(), destination.as_str(), target.as_str()), ("claim-from-b", "b.example", "@ana:b.example"));
    assert!(matches!(handoff::claim(&a, "@bo:a.example", "user", "@ana:a.example", &id).await, Err(ApiError::NotFound(_))));
}

#[tokio::test]
async fn a_handoff_is_spent_by_one_migration() {
    let a = home("a.example").await;
    let (id, secret) = opened(&a, "@ana:a.example", "b.example").await;

    let mut conn = a.pool.acquire().await.unwrap();
    let early = handoff::consume(&mut conn, "@ana:a.example", "user", "@ana:a.example", &id, "m1").await;
    assert!(matches!(early, Err(ApiError::Conflict(_))), "nothing delivered, nothing to spend");
    assert!(matches!(handoff::claim(&a, "@ana:a.example", "user", "@ana:a.example", &id).await, Err(ApiError::Conflict(_))));

    handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:b.example")).await.unwrap();
    let theirs = handoff::consume(&mut conn, "@bo:a.example", "user", "@ana:a.example", &id, "m1").await;
    assert!(matches!(theirs, Err(ApiError::Conflict(_))), "{theirs:?}");
    handoff::consume(&mut conn, "@ana:a.example", "user", "@ana:a.example", &id, "m1").await.unwrap();
    let again = handoff::consume(&mut conn, "@ana:a.example", "user", "@ana:a.example", &id, "m2").await;
    assert!(matches!(again, Err(ApiError::Conflict(_))), "{again:?}");
    assert!(matches!(handoff::claim(&a, "@ana:a.example", "user", "@ana:a.example", &id).await, Err(ApiError::Conflict(_))));
    let status = handoff::status(&a, "@ana:a.example", &id).await.unwrap();
    assert_eq!(status["state"], "used");
    assert_eq!(status["migration_id"], "m1");
}

#[tokio::test]
async fn a_handoff_does_not_outlive_its_half_hour() {
    let a = home("a.example").await;
    let (id, secret) = opened(&a, "@ana:a.example", "b.example").await;
    sqlx::query("UPDATE migration_handoffs SET expires_at = 1 WHERE id = ?")
        .bind(&id)
        .execute(&a.pool)
        .await
        .unwrap();
    let late = handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:b.example")).await;
    assert!(matches!(late, Err(ApiError::Conflict(_))), "{late:?}");
    assert_eq!(handoff::status(&a, "@ana:a.example", &id).await.unwrap()["state"], "expired");

    let (id, secret) = opened(&a, "@ana:a.example", "b.example").await;
    handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:b.example")).await.unwrap();
    sqlx::query("UPDATE migration_handoffs SET expires_at = 1 WHERE id = ?")
        .bind(&id)
        .execute(&a.pool)
        .await
        .unwrap();
    assert!(matches!(handoff::claim(&a, "@ana:a.example", "user", "@ana:a.example", &id).await, Err(ApiError::Conflict(_))));

    assert!(handoff::sweep(&a).await.unwrap() >= 1);
    assert!(matches!(handoff::status(&a, "@ana:a.example", &id).await, Err(ApiError::NotFound(_))));
}

#[tokio::test]
async fn a_new_handoff_replaces_the_one_before_it() {
    let a = home("a.example").await;
    let (first, first_secret) = opened(&a, "@ana:a.example", "b.example").await;
    let (second, _) = opened(&a, "@ana:a.example", "c.example").await;
    let _ = opened(&a, "@bo:a.example", "b.example").await;

    assert!(matches!(handoff::status(&a, "@ana:a.example", &first).await, Err(ApiError::NotFound(_))));
    let stale = handoff::deliver(&a, "b.example", &delivery(&first, &first_secret, "@ana:a.example", "@ana:b.example")).await;
    assert!(matches!(stale, Err(ApiError::NotFound(_))), "{stale:?}");
    assert_eq!(handoff::status(&a, "@ana:a.example", &second).await.unwrap()["state"], "waiting");

    assert!(matches!(handoff::open(&a, "@ana:a.example", "user", "@ana:a.example", "a.example").await, Err(ApiError::BadRequest(_))));
    assert!(matches!(handoff::open(&a, "@ana:a.example", "user", "@ana:a.example", "b.example/evil").await, Err(ApiError::BadRequest(_))));
}

fn guild_delivery(id: &str, secret: &str, guild_id: &str, target_id: &str) -> handoff::Delivery {
    handoff::Delivery { subject_type: "guild".into(), ..delivery(id, secret, guild_id, target_id) }
}

async fn opened_for(a: &Home, subject_type: &str, subject: &str, destination: &str) -> (String, String) {
    let h = handoff::open(a, "@ana:a.example", subject_type, subject, destination).await.unwrap();
    (h["id"].as_str().unwrap().to_string(), h["secret"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn a_guild_handoff_carries_a_claim_for_that_guild_and_nothing_else() {
    let a = home("a.example").await;
    let (guild, other) = (ulid(), ulid());
    let h = handoff::open(&a, "@ana:a.example", "guild", &guild, "b.example").await.unwrap();
    assert_eq!(h["subject_type"], "guild");
    assert_eq!(h["source_id"], guild.as_str(), "the link names the guild, not its owner");
    let (id, secret) = (h["id"].as_str().unwrap().to_string(), h["secret"].as_str().unwrap().to_string());

    let wrong_server = handoff::deliver(&a, "c.example", &guild_delivery(&id, &secret, &guild, "@ana:c.example")).await;
    assert!(matches!(wrong_server, Err(ApiError::NotFound(_))), "{wrong_server:?}");
    let wrong_secret = handoff::deliver(&a, "b.example", &guild_delivery(&id, "nope", &guild, "@ana:b.example")).await;
    assert!(matches!(wrong_secret, Err(ApiError::NotFound(_))), "{wrong_secret:?}");

    let other_guild = handoff::deliver(&a, "b.example", &guild_delivery(&id, &secret, &other, "@ana:b.example")).await;
    assert!(matches!(other_guild, Err(ApiError::Forbidden(_))), "{other_guild:?}");
    let the_owner = handoff::deliver(&a, "b.example", &delivery(&id, &secret, "@ana:a.example", "@ana:b.example")).await;
    assert!(matches!(the_owner, Err(ApiError::Forbidden(_))), "{the_owner:?}");
    let not_its_own = handoff::deliver(&a, "b.example", &guild_delivery(&id, &secret, &guild, "@ana:c.example")).await;
    assert!(matches!(not_its_own, Err(ApiError::Forbidden(_))), "{not_its_own:?}");

    handoff::deliver(&a, "b.example", &guild_delivery(&id, &secret, &guild, "@ana:b.example")).await.unwrap();
    let replay = handoff::deliver(&a, "b.example", &guild_delivery(&id, &secret, &guild, "@mallory:b.example")).await;
    assert!(matches!(replay, Err(ApiError::Conflict(_))), "a handoff is filled in once: {replay:?}");
    let status = handoff::status(&a, "@ana:a.example", &id).await.unwrap();
    assert_eq!((status["state"].as_str(), status["subject_id"].as_str()), (Some("delivered"), Some(guild.as_str())));
    assert_eq!(status["target_id"], "@ana:b.example");

    let (token, destination, target) = handoff::claim(&a, "@ana:a.example", "guild", &guild, &id).await.unwrap();
    assert_eq!((token.as_str(), destination.as_str(), target.as_str()), ("claim-from-b", "b.example", "@ana:b.example"));
    let wrong_guild = handoff::claim(&a, "@ana:a.example", "guild", &other, &id).await;
    assert!(matches!(wrong_guild, Err(ApiError::Forbidden(_))), "{wrong_guild:?}");
    let as_account = handoff::claim(&a, "@ana:a.example", "user", "@ana:a.example", &id).await;
    assert!(matches!(as_account, Err(ApiError::Forbidden(_))), "{as_account:?}");
    let not_the_owner = handoff::claim(&a, "@bo:a.example", "guild", &guild, &id).await;
    assert!(matches!(not_the_owner, Err(ApiError::NotFound(_))), "{not_the_owner:?}");

    let mut conn = a.pool.acquire().await.unwrap();
    let spent_elsewhere = handoff::consume(&mut conn, "@ana:a.example", "guild", &other, &id, "m1").await;
    assert!(matches!(spent_elsewhere, Err(ApiError::Conflict(_))), "{spent_elsewhere:?}");
    let theirs = handoff::consume(&mut conn, "@bo:a.example", "guild", &guild, &id, "m1").await;
    assert!(matches!(theirs, Err(ApiError::Conflict(_))), "{theirs:?}");
    handoff::consume(&mut conn, "@ana:a.example", "guild", &guild, &id, "m1").await.unwrap();
    let again = handoff::consume(&mut conn, "@ana:a.example", "guild", &guild, &id, "m2").await;
    assert!(matches!(again, Err(ApiError::Conflict(_))), "{again:?}");
    assert_eq!(handoff::status(&a, "@ana:a.example", &id).await.unwrap()["migration_id"], "m1");
}

#[tokio::test]
async fn a_guild_handoff_expires_and_is_replaced_like_an_accounts() {
    let a = home("a.example").await;
    let (guild, other) = (ulid(), ulid());

    let (id, secret) = opened_for(&a, "guild", &guild, "b.example").await;
    sqlx::query("UPDATE migration_handoffs SET expires_at = 1 WHERE id = ?")
        .bind(&id)
        .execute(&a.pool)
        .await
        .unwrap();
    let late = handoff::deliver(&a, "b.example", &guild_delivery(&id, &secret, &guild, "@ana:b.example")).await;
    assert!(matches!(late, Err(ApiError::Conflict(_))), "{late:?}");
    assert_eq!(handoff::status(&a, "@ana:a.example", &id).await.unwrap()["state"], "expired");

    let (first, first_secret) = opened_for(&a, "guild", &guild, "b.example").await;
    let (elsewhere, _) = opened_for(&a, "guild", &other, "b.example").await;
    let (account, _) = opened_for(&a, "user", "@ana:a.example", "b.example").await;
    let (second, _) = opened_for(&a, "guild", &guild, "c.example").await;
    let stale = handoff::deliver(&a, "b.example", &guild_delivery(&first, &first_secret, &guild, "@ana:b.example")).await;
    assert!(matches!(stale, Err(ApiError::NotFound(_))), "{stale:?}");
    for kept in [&elsewhere, &account, &second] {
        assert_eq!(handoff::status(&a, "@ana:a.example", kept).await.unwrap()["state"], "waiting");
    }

    for (kind, subject) in [("user", "@bo:a.example"), ("guild", "../etc"), ("guild", "@ana:a.example"), ("room", "x")] {
        let refused = handoff::open(&a, "@ana:a.example", kind, subject, "b.example").await;
        assert!(matches!(refused, Err(ApiError::BadRequest(_))), "{kind} {subject}: {refused:?}");
    }
}
