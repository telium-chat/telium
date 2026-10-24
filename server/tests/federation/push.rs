use super::*;

const HEAVY_BUNDLE_ROWS: usize = 8_000;

#[tokio::test]
async fn one_servers_migration_id_is_not_another_servers() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    let logged = |id: &str, source: &str, ack: &str| {
        sqlx::query(
            "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, \
             ack) VALUES (?, 'guild', ?, 'g', 'g2', 0, ?)",
        )
        .bind(id.to_string())
        .bind(source.to_string())
        .bind(ack.to_string())
    };
    logged("m-taken", "c.test", r#"{"guild_id":"belongs-to-c"}"#)
        .execute(&b.state.pool)
        .await
        .unwrap();
    logged("m-mine", "a.test", r#"{"guild_id":"belongs-to-a"}"#)
        .execute(&b.state.pool)
        .await
        .unwrap();

    let push = |id: &str| {
        let body = json!({
            "migration_id": id, "import_token": import_token.clone(),
            "bundle": { "version": 1, "kind": "guild", "subject": "g" },
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let taken = push("m-taken").await;
    assert!(
        taken.contains("already used that migration id"),
        "an id another server had logged was not refused: {taken}"
    );
    assert!(
        !taken.contains("belongs-to-c"),
        "one origin was handed another origin's acknowledgement: {taken}"
    );

    let mine = push("m-mine").await;
    assert!(
        mine.contains("belongs-to-a"),
        "a retry from the origin that owns the id did not get its acknowledgement back: {mine}"
    );
}

#[tokio::test]
async fn one_id_for_two_subjects_is_not_a_retry() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-one" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-once', 'guild', 'a.test', 'g-one', 'g-one', 0, ?)",
    )
    .bind(r#"{"guild_id":"receipt-for-g-one"}"#)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let push = |subject: &str| {
        let body = json!({
            "migration_id": "m-once", "import_token": import_token.clone(),
            "bundle": { "version": 1, "kind": "guild", "subject": subject },
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let other = push("g-two").await;
    assert!(
        other.contains("for a different subject"),
        "one id used for a second guild was treated as a retry of the first: {other}"
    );
    assert!(
        !other.contains("receipt-for-g-one"),
        "a push about one guild was handed the acknowledgement for another: {other}"
    );

    let same = push("g-one").await;
    assert!(
        same.contains("receipt-for-g-one"),
        "a genuine retry was refused along with the impostor: {same}"
    );
}

#[tokio::test]
async fn an_import_that_stopped_without_a_word_is_not_quietly_run_again() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-halfway" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-halfway', 'guild', 'a.test', 'g-halfway', '', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-halfway", "import_token": import_token,
            "bundle": { "version": 1, "kind": "guild", "subject": "g-halfway" },
        }),
    )
    .await;
    let sent = format!("{sent:?}");
    assert!(
        sent.contains("never acknowledged") && sent.contains("on this server already"),
        "a bundle that had already landed was not told apart from one that never began: {sent}"
    );
    let guilds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(guilds, 0, "the retry imported the guild anyway");
}

#[tokio::test]
async fn a_receipt_that_never_arrived_is_written_again() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-lost" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    landed_guild(&b, "g-landed:b.test", "@owner:b.test").await;
    sqlx::query(
        "INSERT INTO import_log \
           (id, subject_type, source, source_id, new_id, imported_at, ack, token_hash) \
         VALUES ('m-lost', 'guild', 'a.test', 'g-lost', 'g-landed:b.test', 0, '', ?)",
    )
    .bind(telium_server::util::hash_token(&import_token))
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": "m-lost" }),
    )
    .await
    .expect("a receipt for an import that landed was refused rather than written");

    assert_eq!(sent["kind"], "migration_ack", "that is not an acknowledgement: {sent}");
    assert_eq!(sent["migration_id"], "m-lost");
    assert_eq!(sent["old_id"], "g-lost");
    assert_eq!(
        sent["new_id"], "g-landed:b.test",
        "the acknowledgement named something other than what the row says landed: {sent}"
    );
    assert!(sent.get("signature").is_some(), "the acknowledgement was not signed: {sent}");

    let guilds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(guilds, 1, "the retry imported the guild on top of itself");

    let stored: String = sqlx::query_scalar("SELECT ack FROM import_log WHERE id = 'm-lost'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert!(!stored.is_empty(), "the re-issued acknowledgement was not written down");

    let unspent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM import_claims WHERE token_hash = ? AND used_at IS NULL",
    )
    .bind(telium_server::util::hash_token(&import_token))
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(unspent, 0, "a receipt was written and the claim left good for another import");
}

#[tokio::test]
async fn a_receipt_closes_the_claim_its_bundle_ran_on_and_no_other() {
    let (a, b) = pair().await;
    let mut tokens = Vec::new();
    for who in ["owner", "moderator"] {
        let account = register_full(&b, who).await;
        let (status, claim) = b
            .post(
                "/_telium/v1/migrate/accept",
                Some(&account.token),
                json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-both" }),
            )
            .await;
        assert_eq!(status, 200, "{claim}");
        tokens.push(claim["import_token"].as_str().unwrap().to_string());
    }
    let (ran_on, bystander) = (tokens[0].clone(), tokens[1].clone());

    landed_guild(&b, "g-both:b.test", "@owner:b.test").await;
    sqlx::query(
        "INSERT INTO import_log \
           (id, subject_type, source, source_id, new_id, imported_at, ack, token_hash) \
         VALUES ('m-both', 'guild', 'a.test', 'g-both', 'g-both:b.test', 0, '', ?)",
    )
    .bind(telium_server::util::hash_token(&ran_on))
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": "m-both" }),
    )
    .await
    .expect("the receipt was refused");
    assert_eq!(sent["kind"], "migration_ack", "that is not an acknowledgement: {sent}");

    let spent = |token: &str| {
        let hash = telium_server::util::hash_token(token);
        let pool = b.state.pool.clone();
        async move {
            sqlx::query_scalar::<_, Option<i64>>(
                "SELECT used_at FROM import_claims WHERE token_hash = ?",
            )
            .bind(hash)
            .fetch_one(&pool)
            .await
            .unwrap()
            .is_some()
        }
    };
    assert!(spent(&ran_on).await, "the claim the bundle came in on was left good for another import");
    assert!(
        !spent(&bystander).await,
        "a receipt spent a claim that another account was still waiting to use"
    );
}

#[tokio::test]
async fn a_receipt_for_a_row_that_names_no_claim_still_closes_one() {
    let (a, b) = pair().await;
    let account = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&account.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-legacy" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let token = claim["import_token"].as_str().unwrap().to_string();

    landed_guild(&b, "g-legacy:b.test", "@owner:b.test").await;
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-legacy', 'guild', 'a.test', 'g-legacy', 'g-legacy:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": "m-legacy" }),
    )
    .await
    .expect("the receipt was refused");
    assert_eq!(sent["kind"], "migration_ack", "that is not an acknowledgement: {sent}");

    let used: Option<i64> =
        sqlx::query_scalar("SELECT used_at FROM import_claims WHERE token_hash = ?")
            .bind(telium_server::util::hash_token(&token))
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
    assert!(
        used.is_some(),
        "a legacy row left its claim good for a second import of the same guild"
    );
}

#[tokio::test]
async fn a_bundle_the_destination_refuses_is_not_offered_again_every_tick() {
    let (a, b) = pair().await;
    let account = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&account.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-spent" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let token = claim["import_token"].as_str().unwrap().to_string();

    sqlx::query("UPDATE import_claims SET used_at = 1 WHERE token_hash = ?")
        .bind(telium_server::util::hash_token(&token))
        .execute(&b.state.pool)
        .await
        .unwrap();

    landed_guild(&a, "g-spent", "@mover:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-spent', 'guild', 'g-spent', 'b.test', ?, 'd', 's', 'ready', 0, 0)",
    )
    .bind(&token)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-spent").await;
    assert!(out.is_err(), "a refused bundle was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-spent'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "failed", "a refused bundle was left on the sweep to be sent again");
    assert!(
        detail.unwrap_or_default().contains("refused the bundle"),
        "the reason the destination gave was not written down"
    );
}

#[tokio::test]
async fn a_claim_opened_for_a_differently_spelled_name_is_still_that_server() {
    let (a, b) = pair().await;
    let account = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&account.token),
            json!({ "subject_type": "guild", "source": "  A.Test.  ", "source_id": "g-spelt" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let token = claim["import_token"].as_str().unwrap().to_string();

    let stored: String = sqlx::query_scalar("SELECT source FROM import_claims WHERE token_hash = ?")
        .bind(telium_server::util::hash_token(&token))
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(stored, "a.test", "the claim kept a spelling no signed request can arrive under");

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-spelt",
            "import_token": token,
            "bundle": { "version": 2, "kind": "guild", "subject": "g-spelt" },
        }),
    )
    .await;
    let refusal = format!("{:?}", sent.as_ref().err());
    assert!(
        !refusal.contains("different source") && !refusal.contains("no claim matches"),
        "a claim opened for this very server was refused for naming another one: {refusal}"
    );
}

#[tokio::test]
async fn a_destination_that_says_come_back_is_not_treated_as_a_refusal() {
    let (a, b) = pair().await;
    let account = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&account.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-busy" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let token = claim["import_token"].as_str().unwrap().to_string();

    let _held = b.state.imports_in_flight.begin("m-busy").expect("the id was already held");

    landed_guild(&a, "g-busy", "@mover:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-busy', 'guild', 'g-busy', 'b.test', ?, 'd', 's', 'ready', 0, 0)",
    )
    .bind(&token)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-busy").await;
    assert!(out.is_err(), "a push that lost the id was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-busy'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(
        state, "ready",
        "a destination that asked the sender to come back stopped the migration for good"
    );
    assert!(
        detail.unwrap_or_default().contains("arriving here right now"),
        "the reason the destination gave was not written down"
    );
}

#[tokio::test]
async fn a_stopped_migration_can_be_started_again_on_the_same_id() {
    let (a, _b) = pair().await;
    let mover = register_full(&a, "mover").await;
    landed_guild(&a, "g-stop", "@mover:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-stop', 'guild', 'g-stop', 'b.test', 'tok', 'd', 's', 'failed', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (status, body) =
        a.post("/_telium/v1/migrate/m-stop/retry", Some(&mover.token), json!({})).await;
    assert_eq!(status, 200, "a stopped migration could not be started again: {body}");
    assert_eq!(body["state"], "ready");
    assert_eq!(body["id"], "m-stop", "starting again moved the migration to another id");

    sqlx::query("UPDATE migrations SET state = 'cancelled' WHERE id = 'm-stop'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    let (status, body) =
        a.post("/_telium/v1/migrate/m-stop/retry", Some(&mover.token), json!({})).await;
    assert_eq!(status, 409, "a cancelled migration was restarted as if it had failed: {body}");
    assert!(
        body["message"].as_str().unwrap_or_default().contains("cancelled"),
        "the refusal did not say what state the migration was actually in: {body}"
    );

    sqlx::query("UPDATE migrations SET state = 'failed' WHERE id = 'm-stop'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    let stranger = register_full(&a, "stranger").await;
    let (status, body) =
        a.post("/_telium/v1/migrate/m-stop/retry", Some(&stranger.token), json!({})).await;
    assert_eq!(status, 403, "anyone could restart somebody else's migration: {body}");
}

#[tokio::test]
async fn a_migration_cancelled_under_a_running_transfer_is_not_put_back() {
    let reached = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quiet = listener.local_addr().unwrap();
    let counted = reached.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = listener.accept().await {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            held.push(sock);
        }
    });

    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.request_timeout_secs = 3;
        cfg.federation.peers.insert("quiet.test".into(), format!("http://{quiet}"));
    })
    .await;

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-race', 'guild', 'g-race', 'quiet.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let running = a.state.clone();
    let transfer =
        tokio::spawn(async move { telium_server::routes::migrate::run(&running, "m-race").await });

    for _ in 0..200 {
        if reached.load(std::sync::atomic::Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(
        reached.load(std::sync::atomic::Ordering::SeqCst) > 0,
        "the transfer never reached the destination, so nothing was raced"
    );
    sqlx::query("UPDATE migrations SET state = 'cancelled', detail = 'cancelled by d1' \
                 WHERE id = 'm-race'")
        .execute(&a.state.pool)
        .await
        .unwrap();

    let out = transfer.await.unwrap();
    assert!(out.is_err(), "a destination that never answered was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-race'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "cancelled", "a cancelled migration was put back on the sweep");
    assert_eq!(
        detail.as_deref(),
        Some("cancelled by d1"),
        "the transfer wrote over a row it had already been taken off"
    );
}

#[tokio::test]
async fn an_unanswered_ask_does_not_promote_a_migration_that_sent_nothing() {
    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.peers.insert("gone.test".into(), "http://127.0.0.1:1".into());
    })
    .await;

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-pending', 'guild', 'g-nowhere', 'gone.test', 'tok', 'd', 's', 'pending', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-pending").await;
    assert!(out.is_err(), "a destination that never answered was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-pending'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "pending", "a migration that sent nothing was recorded as having pushed");
    assert!(
        detail.unwrap_or_default().contains("could not ask for a receipt"),
        "the reason was not written down"
    );
}

#[tokio::test]
async fn a_push_with_no_claim_cannot_read_which_ids_are_taken() {
    let (a, b) = pair().await;
    landed_guild(&b, "g-landed:b.test", "@owner:b.test").await;
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-taken', 'guild', 'c.test', 'g-theirs', 'g-landed:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let probe = |id: &str| {
        let body = json!({
            "migration_id": id, "import_token": "nothing-was-ever-issued-for-this",
            "bundle": { "version": 1, "kind": "guild", "subject": "g-theirs" },
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let taken = probe("m-taken").await;
    let free = probe("m-never-happened").await;
    assert!(!taken.contains("migration_ack"), "that is a receipt: {taken}");
    assert_eq!(
        taken, free,
        "a peer with no claim was told which migration ids this server is already holding"
    );
}

#[tokio::test]
async fn a_destination_that_will_not_sign_parks_the_migration_rather_than_retrying() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-stuck', 'guild', 'a.test', 'g-nowhere', 'g-vanished:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-stuck', 'guild', 'g-nowhere', 'b.test', 'spent', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-stuck").await;
    assert!(out.is_err(), "a destination that refuses to sign was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-stuck'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "failed", "a terminal refusal was left on the retry timer");
    assert!(
        detail.unwrap_or_default().contains("cannot acknowledge"),
        "the migration was parked without saying why"
    );
}

#[tokio::test]
async fn a_destination_that_did_not_answer_is_not_handed_the_bundle_anyway() {
    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.peers.insert("gone.test".into(), "http://127.0.0.1:1".into());
    })
    .await;

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-quiet', 'guild', 'g-nowhere', 'gone.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-quiet").await;
    assert!(out.is_err(), "a destination that never answered was treated as a success: {out:?}");

    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-quiet'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "ready", "an unanswered ask was treated as terminal");
    assert!(
        detail.unwrap_or_default().contains("could not ask for a receipt"),
        "the migration went past the ask and tried to push instead"
    );
}

#[tokio::test]
async fn a_receipt_is_only_for_the_server_that_pushed_it() {
    let (a, b) = pair().await;
    landed_guild(&b, "g-landed:b.test", "@owner:b.test").await;
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-theirs', 'guild', 'c.test', 'g-theirs', 'g-landed:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let ask = |id: &str| {
        let body = json!({ "migration_id": id });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/receipt",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let impostor = ask("m-theirs").await;
    assert!(!impostor.contains("migration_ack"), "that is somebody else's receipt: {impostor}");
    let missing = ask("m-never-happened").await;
    assert!(!missing.contains("migration_ack"), "that is a receipt for nothing: {missing}");
    assert_eq!(
        impostor, missing,
        "an id that belongs to another server reads differently from one that does not exist"
    );

    let stored: String = sqlx::query_scalar("SELECT ack FROM import_log WHERE id = 'm-theirs'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert!(stored.is_empty(), "a refusal wrote a receipt anyway");
}

#[tokio::test]
async fn a_retry_asks_for_the_receipt_before_it_builds_a_bundle() {
    let (a, b) = pair().await;

    landed_guild(&b, "g-landed:b.test", "@owner:b.test").await;
    let ack = json!({ "kind": "migration_ack", "migration_id": "m-retry", "subject_type": "guild",
                      "old_id": "g-nowhere", "new_id": "g-landed:b.test",
                      "server_name": "b.test", "signature": "written-once" });
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-retry', 'guild', 'a.test', 'g-nowhere', 'g-landed:b.test', 0, ?)",
    )
    .bind(ack.to_string())
    .execute(&b.state.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-retry', 'guild', 'g-nowhere', 'b.test', 'spent', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let finished = telium_server::routes::migrate::run(&a.state, "m-retry")
        .await
        .expect("a retry rebuilt the bundle instead of collecting the receipt it was owed");
    assert_eq!(finished["new_id"], "g-landed:b.test", "{finished}");

    let st: String = sqlx::query_scalar("SELECT state FROM migrations WHERE id = 'm-retry'")
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(st, "completed", "the migration did not finish on the receipt alone");
}

#[tokio::test]
async fn a_user_that_has_moved_on_again_is_still_acknowledged() {
    let (a, b) = pair().await;
    let moved = register_full(&b, "moved").await;
    sqlx::query("UPDATE accounts SET deactivated = 1 WHERE user_id = ?")
        .bind("@moved:b.test")
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-chain', 'user', 'a.test', '@who:a.test', '@moved:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();
    drop(moved);

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": "m-chain" }),
    )
    .await
    .expect("a user that had moved on again was treated as one that was never here");
    assert_eq!(sent["kind"], "migration_ack", "that is not an acknowledgement: {sent}");
    assert_eq!(
        sent["new_id"], "@moved:b.test",
        "the acknowledgement named something other than what the row says landed: {sent}"
    );
}

#[tokio::test]
async fn a_bundle_this_server_refused_leaves_its_id_free_to_try_again() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (_, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-bad" }),
        )
        .await;
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    let push = || {
        let body = json!({
            "migration_id": "m-bad", "import_token": import_token.clone(),
            "bundle": {
                "version": 1, "kind": "guild", "subject": "g-bad",
                "expressions": vec![json!({}); 400],
            },
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let first = push().await;
    assert!(
        first.contains("more expressions than a guild may hold"),
        "this bundle was supposed to fail during the import, not before it: {first}"
    );
    let logged: Option<String> = sqlx::query_scalar("SELECT ack FROM import_log WHERE id = ?")
        .bind("m-bad")
        .fetch_optional(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(logged, None, "a refused import kept hold of its id");

    let again = push().await;
    assert!(
        again.contains("more expressions than a guild may hold"),
        "a retry after a refusal was turned away instead of being tried: {again}"
    );
}

#[tokio::test]
async fn two_pushes_of_one_migration_id_do_not_both_import() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let mut tokens = Vec::new();
    for subject in ["g-first", "g-second"] {
        tokens.push(claim_on(&b, &landing.token, subject).await);
    }

    let push = |token: &String, subject: &str| {
        let body = json!({
            "migration_id": "m-shared", "import_token": token,
            "bundle": weighty_bundle(subject, 1000),
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };
    let (one, two) =
        tokio::join!(push(&tokens[0], "g-first"), push(&tokens[1], "g-second"));

    let guilds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(guilds, 1, "one migration id, two imports: {one} / {two}");
    let turned_away = |answer: &str| {
        answer.contains("arriving here right now")
            || answer.contains("while this one was arriving")
            || answer.contains("for a different subject")
    };
    assert!(
        turned_away(&one) != turned_away(&two),
        "the second push was not turned away by the id: {one} / {two}"
    );
}

#[tokio::test]
async fn a_push_the_sender_gave_up_on_leaves_its_id_free_to_try_again() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let token = claim_on(&b, &landing.token, "g-cut").await;
    let rows = 4_000;
    let body = json!({
        "migration_id": "m-cut", "import_token": token,
        "bundle": weighty_bundle("g-cut", rows),
    });

    let push = {
        let state = a.state.clone();
        let body = body.clone();
        tokio::spawn(async move {
            telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await
        })
    };

    assert!(reached_the_import(&b, "g-cut").await, "the push never got as far as the import");
    push.abort();
    assert!(push.await.is_err(), "the push was not actually cut off");

    let arrived: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE id = 'g-cut'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(arrived, 0, "the import ran to completion, so nothing here was abandoned");

    let logged: Option<String> = sqlx::query_scalar("SELECT ack FROM import_log WHERE id = ?")
        .bind("m-cut")
        .fetch_optional(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(logged, None, "a push nobody finished kept hold of its id");

    let again = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &body,
    )
    .await;
    assert!(again.is_ok(), "the retry of an abandoned push was refused: {again:?}");
    let landed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = 'g-cut'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(landed as usize, rows, "the retry was accepted but the guild did not arrive");
}

async fn reached_the_import(b: &Server, source_id: &str) -> bool {
    for _ in 0..400 {
        let attempts: i64 =
            sqlx::query_scalar("SELECT attempts FROM import_claims WHERE source_id = ?")
                .bind(source_id)
                .fetch_one(&b.state.pool)
                .await
                .unwrap();
        if attempts > 0 {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    false
}

#[tokio::test]
async fn a_second_push_of_an_id_already_arriving_is_told_so_at_once() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let slow = claim_on(&b, &landing.token, "g-slow").await;
    let quick = claim_on(&b, &landing.token, "g-quick").await;

    let first = {
        let state = a.state.clone();
        let body = json!({
            "migration_id": "m-both", "import_token": slow,
            "bundle": weighty_bundle("g-slow", HEAVY_BUNDLE_ROWS),
        });
        tokio::spawn(async move {
            telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await
        })
    };

    assert!(reached_the_import(&b, "g-slow").await, "the first push never got as far as importing");
    assert!(
        !first.is_finished(),
        "the first push was over before the second was even sent -- raise the row count"
    );

    let second = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-both", "import_token": quick,
            "bundle": weighty_bundle("g-quick", 1),
        }),
    )
    .await;
    let still_going = !first.is_finished();
    let second = format!("{second:?}");
    assert!(
        second.contains("arriving here right now"),
        "the second push of an id already in flight was not told what was wrong: {second}"
    );
    assert!(
        still_going,
        "the second push only got its answer once the first had finished, which is what queueing \
         behind the write lock looks like: {second}"
    );

    assert!(first.await.unwrap().is_ok(), "the first push did not survive the second");
    let landed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE id = 'g-quick'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(landed, 0, "the second push was refused and imported anyway");
}

#[tokio::test]
async fn a_proxy_in_front_does_not_make_every_peer_one_sender() {
    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.rate_limit.trusted_proxies = vec!["127.0.0.1".to_string()];
    })
    .await;
    expecting_from_a(&b).await;

    let stranger = dribble(&b.base, Some("198.51.100.9")).await;
    let sent = push_a_bundle(&a).await;
    was_read_to_the_end(&sent, "one socket behind the proxy shut out every peer");
    assert!(
        !sent.contains("large bundle"),
        "one socket behind the proxy shut out every peer behind it: {sent}"
    );
    drop(stranger);
}

#[tokio::test]
async fn a_blocked_peer_does_not_get_the_migration_ceiling() {
    let (a, b) = pair().await;

    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES ('h', 'guild', 'a.test', 'g', '@x:b.test', 0, ?)",
    )
    .bind(now_ms() + 3_600_000)
    .execute(&b.state.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO defederation (domain, scope, reason, created_at) \
                 VALUES ('a.test', 'all', 'no', 0)")
        .execute(&b.state.pool)
        .await
        .unwrap();

    let filler = "x".repeat(8 * 1024 * 1024);
    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({ "import_token": "nope", "bundle": { "padding": filler } }),
    )
    .await;
    let message = format!("{sent:?}");
    assert!(
        message.to_lowercase().contains("too large"),
        "a blocked peer still got the migration ceiling: {message}"
    );
}

#[tokio::test]
async fn a_timestamp_chosen_to_overflow_is_just_refused() {
    let b = pair().await.1;
    let header = format!(
        "{} origin=a.test,destination=b.test,key=k,ts={},sig=AAAA",
        telium_server::federation::AUTH_SCHEME,
        i64::MIN
    );
    let refused = telium_server::federation::check_envelope(&b.state, &header);
    assert!(refused.is_err(), "a timestamp outside the window was accepted");
}

#[tokio::test]
async fn a_receipt_is_handed_over_without_the_bundle_being_sent_again() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-done" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    landed_guild(&b, "g-done:b.test", "@owner:b.test").await;
    sqlx::query("UPDATE import_claims SET used_at = ? WHERE source = 'a.test'")
        .bind(now_ms())
        .execute(&b.state.pool)
        .await
        .unwrap();
    let stored = json!({ "kind": "migration_ack", "migration_id": "m-done",
                         "new_id": "g-done:b.test", "signature": "written-once" });
    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-done', 'guild', 'a.test', 'g-done', 'g-done:b.test', 0, ?)",
    )
    .bind(stored.to_string())
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/receipt",
        &json!({ "migration_id": "m-done" }),
    )
    .await
    .expect("a receipt this server was holding was not handed over when asked for");
    assert_eq!(
        sent, stored,
        "the ask was answered with something other than the receipt already written: {sent}"
    );

    let attempts: i64 =
        sqlx::query_scalar("SELECT attempts FROM import_claims WHERE source = 'a.test'")
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
    assert_eq!(attempts, 0, "asking for a receipt was charged as a push");

    let refused = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-again", "import_token": import_token,
            "bundle": { "padding": "x".repeat(5 * 1024 * 1024) },
        }),
    )
    .await;
    let message = format!("{refused:?}");
    assert!(
        message.to_lowercase().contains("too large"),
        "a spent claim still bought the migration ceiling: {message}"
    );
}

#[tokio::test]
async fn a_receipt_not_yet_written_is_not_written_for_whoever_asks() {
    let (a, b) = pair().await;
    landed_guild(&b, "g-landed:b.test", "@owner:b.test").await;

    let landing = register_full(&b, "owner-a").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-ours" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    let unacknowledged = |id: &str, source: &str, subject: &str| {
        sqlx::query(
            "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, \
             ack) VALUES (?, 'guild', ?, ?, 'g-landed:b.test', 0, '')",
        )
        .bind(id.to_string())
        .bind(source.to_string())
        .bind(subject.to_string())
    };
    unacknowledged("m-theirs", "c.test", "g-theirs").execute(&b.state.pool).await.unwrap();
    unacknowledged("m-ours", "a.test", "g-ours").execute(&b.state.pool).await.unwrap();

    let push = |id: &str, subject: &str| {
        let body = json!({
            "migration_id": id, "import_token": import_token.clone(),
            "bundle": { "version": 1, "kind": "guild", "subject": subject },
        });
        let state = a.state.clone();
        async move {
            let sent = telium_server::federation::post_signed(
                &state,
                "b.test",
                "/_telium/v1/migrate/import",
                &body,
            )
            .await;
            format!("{sent:?}")
        }
    };

    let impostor = push("m-theirs", "g-theirs").await;
    assert!(
        impostor.contains("another server has already used"),
        "a blank row handed its signature to a server that had nothing to do with it: {impostor}"
    );
    assert!(!impostor.contains("migration_ack"), "that is a receipt: {impostor}");

    let elsewhere = push("m-ours", "g-something-else").await;
    assert!(
        elsewhere.contains("different subject"),
        "a blank row was signed for a subject it says nothing about: {elsewhere}"
    );
    assert!(!elsewhere.contains("migration_ack"), "that is a receipt: {elsewhere}");

    let acks: Vec<String> = sqlx::query_scalar("SELECT ack FROM import_log ORDER BY id")
        .fetch_all(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(acks, vec![String::new(), String::new()], "a refusal wrote a receipt anyway");
}

#[tokio::test]
async fn a_receipt_is_not_written_for_something_that_is_no_longer_here() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-gone" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    sqlx::query(
        "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, ack) \
         VALUES ('m-gone', 'guild', 'a.test', 'g-gone', 'g-deleted:b.test', 0, '')",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-gone", "import_token": import_token,
            "bundle": { "version": 1, "kind": "guild", "subject": "g-gone" },
        }),
    )
    .await;
    let sent = format!("{sent:?}");
    assert!(
        sent.contains("no longer on this server"),
        "this server signed for a guild it does not have: {sent}"
    );
    let stored: String = sqlx::query_scalar("SELECT ack FROM import_log WHERE id = 'm-gone'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert!(stored.is_empty(), "a receipt it refused to give out was stored anyway: {stored}");
}

#[tokio::test]
async fn a_slow_link_is_not_mistaken_for_an_idle_socket() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (_a, b) = pair().await;
    let mut slow = chunked_to(&b.base, "/_telium/v1/report").await;
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        slow.write_all(b"400\r\n").await.unwrap();
        slow.write_all(&[b'x'; 1024]).await.unwrap();
        slow.write_all(b"\r\n").await.unwrap();
        slow.flush().await.unwrap();
    }
    slow.write_all(b"0\r\n\r\n").await.unwrap();
    slow.flush().await.unwrap();

    let mut sink = [0u8; 1024];
    let n = tokio::time::timeout(std::time::Duration::from_secs(5), slow.read(&mut sink))
        .await
        .expect("the server never answered a body it had already been given in full")
        .expect("the connection failed rather than being answered");
    let said = String::from_utf8_lossy(&sink[..n]).into_owned();
    assert!(
        !said.contains("too slowly") && !said.contains("stopped arriving"),
        "an ordinary federation body that never stopped arriving was cut for its rate: {said}"
    );
    assert!(
        said.starts_with("HTTP/1.1 401"),
        "expected the body to reach the signature check, got: {said}"
    );
}

#[tokio::test]
async fn a_trickle_does_not_earn_a_place_it_is_not_filling() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (_a, b) = pair().await;
    expecting_from_a(&b).await;

    let mut trickle = declaring(&b.base, None, 40_000_000).await;
    let (mut reading, mut writing) = trickle.split();
    let mut sink = [0u8; 1024];
    let answered = tokio::time::timeout(std::time::Duration::from_secs(8), async {
        loop {
            tokio::select! {
                read = reading.read(&mut sink) => return read,
                _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                    if writing.write_all(&[b'x'; 256]).await.is_err() {
                        return reading.read(&mut sink).await;
                    }
                }
            }
        }
    })
    .await
    .expect("a socket trickling below the floor kept its place until the deadline");
    let n = answered.expect("the connection failed rather than being answered");
    let said = String::from_utf8_lossy(&sink[..n]).into_owned();
    assert!(
        said.contains("too slowly") && said.contains("holding a place"),
        "expected the trickle to be told it had not earned its place, got: {said}"
    );
}

#[tokio::test]
async fn a_small_push_holds_nothing_so_it_is_not_charged_for_a_place() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (_a, b) = pair().await;
    expecting_from_a(&b).await;

    let mut small = declaring(&b.base, None, 2_000_000).await;
    let (mut reading, mut writing) = small.split();
    let mut sink = [0u8; 1024];
    let cut = tokio::time::timeout(std::time::Duration::from_secs(7), async {
        loop {
            tokio::select! {
                read = reading.read(&mut sink) => return read,
                _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {
                    if writing.write_all(&[b'x'; 1024]).await.is_err() {
                        return reading.read(&mut sink).await;
                    }
                }
            }
        }
    })
    .await;
    if let Ok(read) = cut {
        let n = read.unwrap_or(0);
        let said = String::from_utf8_lossy(&sink[..n]).into_owned();
        assert!(
            !said.contains("too slowly") && !said.contains("stopped arriving"),
            "a push too small to hold anything was charged for a place: {said}"
        );
    }
}

#[tokio::test]
async fn a_packet_now_and_then_does_not_buy_the_whole_deadline() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (_a, b) = pair().await;

    let mut dawdling = chunked_to(&b.base, "/_telium/v1/report").await;
    let (mut reading, mut writing) = dawdling.split();
    let mut sink = [0u8; 1024];
    let answered = tokio::time::timeout(std::time::Duration::from_secs(6), async {
        loop {
            tokio::select! {
                read = reading.read(&mut sink) => return read,
                _ = tokio::time::sleep(std::time::Duration::from_millis(2500)) => {
                    if writing.write_all(b"1\r\nx\r\n").await.is_err() {
                        return reading.read(&mut sink).await;
                    }
                }
            }
        }
    })
    .await
    .expect("a socket sending a byte at a time held the connection to the deadline");
    let n = answered.expect("the connection failed rather than being answered");
    let said = String::from_utf8_lossy(&sink[..n]).into_owned();
    assert!(
        said.contains("stopped arriving"),
        "expected the dawdling socket to be cut for its rate, got: {said}"
    );
}

#[tokio::test]
async fn a_body_that_arrives_all_at_once_cannot_spend_the_change_on_silence() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (_a, b) = pair().await;

    let mut burst = chunked_to(&b.base, "/_telium/v1/report").await;
    let (mut reading, mut writing) = burst.split();
    writing.write_all(b"10000\r\n").await.unwrap();
    writing.write_all(&[b'x'; 64 * 1024]).await.unwrap();
    writing.write_all(b"\r\n").await.unwrap();

    let mut sink = [0u8; 1024];
    let answered = tokio::time::timeout(
        std::time::Duration::from_secs(7),
        reading.read(&mut sink),
    )
    .await
    .expect("a socket that had paid for the deadline in advance was allowed to sit on it");
    let n = answered.expect("the connection failed rather than being answered");
    let said = String::from_utf8_lossy(&sink[..n]).into_owned();
    assert!(
        said.contains("stopped arriving"),
        "expected the silent socket to be cut for the gap, got: {said}"
    );
}
