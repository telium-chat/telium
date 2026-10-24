use super::*;

#[tokio::test]
async fn a_guild_that_already_moved_is_not_sent_after_it() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Once" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();

    let landing = register_full(&b, "owner").await;
    let claim = |token: String, id: String| {
        let b = &b;
        async move {
            let (status, claim) = b
                .post(
                    "/_telium/v1/migrate/accept",
                    Some(&token),
                    json!({ "subject_type": "guild", "source": "a.test", "source_id": id }),
                )
                .await;
            assert_eq!(status, 200, "{claim}");
            claim["import_token"].as_str().unwrap().to_string()
        }
    };
    let import_token = claim(landing.token.clone(), guild_id.clone()).await;

    let created_at = now_ms();
    let payload =
        telium_server::migration::grant_payload(&guild_id, "b.test", &import_token, created_at);
    let signature = device_sign(&owner.secret, &payload);
    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&owner.token),
            json!({
                "subject_type": "guild", "subject_id": guild_id, "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let first = started["id"].as_str().unwrap().to_string();
    let (status, done) =
        a.post(&format!("/_telium/v1/migrate/{first}/execute"), Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{done}");
    let landed = done["new_id"].as_str().unwrap().to_string();

    let arrived: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(arrived, 1, "the guild did not arrive once, so nothing here is being tested");

    let created_at = now_ms();
    let second_token = claim(landing.token.clone(), guild_id.clone()).await;
    let payload =
        telium_server::migration::grant_payload(&guild_id, "b.test", &second_token, created_at);
    let (status, refused) = a
        .post(
            "/_telium/v1/migrate",
            Some(&owner.token),
            json!({
                "subject_type": "guild", "subject_id": guild_id, "destination": "b.test",
                "import_token": second_token, "password": "correct horse battery",
                "device_signature": device_sign(&owner.secret, &payload), "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 409, "a guild that had already moved could be moved again: {refused}");

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-again', 'guild', ?, 'b.test', ?, 'd', 's', 'failed', 0, 0)",
    )
    .bind(&guild_id)
    .bind(&second_token)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (status, refused) =
        a.post("/_telium/v1/migrate/m-again/retry", Some(&owner.token), json!({})).await;
    assert_eq!(status, 409, "a migration for a guild that had moved was started again: {refused}");

    sqlx::query("UPDATE migrations SET state = 'ready' WHERE id = 'm-again'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    let out = telium_server::routes::migrate::run(&a.state, "m-again").await;
    assert!(out.is_err(), "the bundle was sent after the guild had already gone: {out:?}");

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(after, 1, "the guild landed on the destination a second time");

    let (state, moved_to): (String, String) = sqlx::query_as(
        "SELECT m.state, t.new_id FROM migrations m, tombstones t \
         WHERE m.id = 'm-again' AND t.subject_id = ?",
    )
    .bind(&guild_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(state, "failed", "the migration was left for the sweep to try again");
    assert_eq!(moved_to, landed, "the forwarding address was repointed at another copy");
}

#[tokio::test]
async fn a_migration_started_again_can_carry_a_new_claim() {
    let (a, b) = pair_with_delay(3600).await;
    let owner = register_full(&a, "owner").await;
    landed_guild(&a, "g-fresh", "@owner:a.test").await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-fresh" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-dead', 'guild', 'g-fresh', 'b.test', 'spent', 'd', 's', 'failed', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let created_at = now_ms();
    let payload =
        telium_server::migration::grant_payload("g-fresh", "b.test", &import_token, created_at);
    let (status, half) = a
        .post(
            "/_telium/v1/migrate/m-dead/retry",
            Some(&owner.token),
            json!({ "import_token": import_token }),
        )
        .await;
    assert_eq!(status, 400, "a claim with no signature over it was accepted: {half}");

    let (status, wrong) = a
        .post(
            "/_telium/v1/migrate/m-dead/retry",
            Some(&owner.token),
            json!({
                "import_token": import_token, "created_at": created_at,
                "device_signature": device_sign(&owner.secret, b"not the grant"),
                "password": "correct horse battery",
            }),
        )
        .await;
    assert_eq!(status, 401, "a claim signed by nobody in particular was accepted: {wrong}");

    let signature = device_sign(&owner.secret, &payload);
    let (status, unauthenticated) = a
        .post(
            "/_telium/v1/migrate/m-dead/retry",
            Some(&owner.token),
            json!({
                "import_token": import_token, "created_at": created_at,
                "device_signature": signature,
            }),
        )
        .await;
    assert_eq!(
        status, 400,
        "a new claim was accepted without the reauthentication `start` asks for: {unauthenticated}"
    );

    let (status, wrong_password) = a
        .post(
            "/_telium/v1/migrate/m-dead/retry",
            Some(&owner.token),
            json!({
                "import_token": import_token, "created_at": created_at,
                "device_signature": signature, "password": "not the password",
            }),
        )
        .await;
    assert_eq!(status, 401, "a guessed password re-aimed the migration: {wrong_password}");

    let (status, again) = a
        .post(
            "/_telium/v1/migrate/m-dead/retry",
            Some(&owner.token),
            json!({
                "import_token": import_token, "created_at": created_at,
                "device_signature": signature, "password": "correct horse battery",
            }),
        )
        .await;
    assert_eq!(status, 200, "a properly signed new claim was refused: {again}");

    let (token, state, device, sig, executes_at): (String, String, String, String, i64) =
        sqlx::query_as(
            "SELECT grant_token, state, device_id, device_sig, executes_at \
             FROM migrations WHERE id = 'm-dead'",
        )
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "ready");
    assert_eq!(token, import_token, "the migration was put back holding the claim that failed");
    assert_eq!(sig, signature, "the signature over the new claim was not the one stored");
    assert_ne!(device, "d", "the device that signed the new claim was not recorded");
    assert!(
        executes_at > now_ms() + 3_000_000,
        "re-aiming a migration skipped the cooling-off window: {executes_at}"
    );
}

#[tokio::test]
async fn a_migration_started_again_with_no_new_claim_needs_no_password() {
    let (a, _b) = pair_with_delay(3600).await;
    let owner = register_full(&a, "owner").await;
    landed_guild(&a, "g-plain", "@owner:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-plain', 'guild', 'g-plain', 'b.test', 'tok', 'd', 's', 'failed', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let bare = a
        .client
        .post(format!("{}/_telium/v1/migrate/m-plain/retry", a.base))
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap();
    assert_eq!(bare.status().as_u16(), 200, "a retry with no body was refused: {:?}", bare.text().await);

    for (how, request) in [
        (
            "with a length",
            a.client
                .post(format!("{}/_telium/v1/migrate/m-plain/retry", a.base))
                .bearer_auth(&owner.token)
                .body("{\"import_token\":\"a brand new claim\"}"),
        ),
        (
            "chunked",
            a.client
                .post(format!("{}/_telium/v1/migrate/m-plain/retry", a.base))
                .bearer_auth(&owner.token)
                .body(reqwest::Body::wrap_stream(futures_util::stream::once(async {
                    Ok::<_, std::io::Error>("{\"import_token\":\"a brand new claim\"}")
                }))),
        ),
    ] {
        let unreadable = request.send().await.unwrap();
        assert_eq!(
            unreadable.status().as_u16(),
            400,
            "a claim sent {how} with no content type was silently dropped: {:?}",
            unreadable.text().await
        );
    }
    let (token_now, state_now): (String, String) =
        sqlx::query_as("SELECT grant_token, state FROM migrations WHERE id = 'm-plain'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(token_now, "tok", "a refused retry changed the claim anyway");
    assert_eq!(state_now, "ready", "a refused retry started the migration anyway");

    sqlx::query("UPDATE migrations SET state = 'failed' WHERE id = 'm-plain'")
        .execute(&a.state.pool)
        .await
        .unwrap();

    let (status, typo) = a
        .post(
            "/_telium/v1/migrate/m-plain/retry",
            Some(&owner.token),
            json!({ "import_tokn": "a brand new claim" }),
        )
        .await;
    assert_eq!(status, 422, "a misspelled claim field was read as no claim at all: {typo}");

    sqlx::query("UPDATE migrations SET state = 'failed' WHERE id = 'm-plain'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    let (status, back) = a
        .post("/_telium/v1/migrate/m-plain/retry", Some(&owner.token), json!({}))
        .await;
    assert_eq!(status, 200, "an ordinary retry was refused: {back}");
    let (token, device, executes_at): (String, String, i64) =
        sqlx::query_as("SELECT grant_token, device_id, executes_at FROM migrations WHERE id = 'm-plain'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(token, "tok", "a retry carrying nothing changed the claim");
    assert_eq!(device, "d", "a retry carrying nothing changed the signing device");
    assert!(
        executes_at > now_ms() + 3_000_000,
        "a retry handed the move to the next sweep with no window: {executes_at}"
    );
    assert_eq!(
        back["executes_at"].as_i64(),
        Some(executes_at),
        "the caller was not told when it will run: {back}"
    );

    let swept = telium_server::routes::migrate::run_due(&a.state).await.unwrap();
    assert_eq!(swept, 0, "the migration ran inside its own cooling-off window");
    let st: String = sqlx::query_scalar("SELECT state FROM migrations WHERE id = 'm-plain'")
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(st, "ready");
}

#[tokio::test]
async fn a_stopped_migration_is_not_started_again_beside_a_live_one() {
    let (a, _b) = pair().await;
    let owner = register_full(&a, "owner").await;
    landed_guild(&a, "g-two", "@owner:a.test").await;
    for (id, st) in [("m-stopped", "failed"), ("m-live", "ready")] {
        sqlx::query(
            "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
             device_id, device_sig, state, created_at, executes_at) \
             VALUES (?, 'guild', 'g-two', 'b.test', 'tok', 'd', 's', ?, 0, 0)",
        )
        .bind(id)
        .bind(st)
        .execute(&a.state.pool)
        .await
        .unwrap();
    }

    let (status, body) = a
        .post("/_telium/v1/migrate/m-stopped/retry", Some(&owner.token), json!({}))
        .await;
    assert_eq!(status, 409, "one subject was put on two live migrations: {body}");
    let st: String = sqlx::query_scalar("SELECT state FROM migrations WHERE id = 'm-stopped'")
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(st, "failed");
}

#[tokio::test]
async fn an_older_destination_saying_conflict_is_still_saying_wait() {
    let old = a_destination_that_refuses_the_push(
        "409 Conflict",
        "{\"error\":\"conflict\",\"message\":\"a push with that migration id is arriving here \
         right now; wait for it to finish rather than sending it twice\"}",
    )
    .await;
    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.peers.insert("old.test".into(), old.clone());
    })
    .await;
    landed_guild(&a, "g-old", "@owner:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-old', 'guild', 'g-old', 'old.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-old").await;
    assert!(out.is_err(), "the fake destination answered something other than a refusal: {out:?}");
    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-old'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert!(
        detail.as_deref().unwrap_or_default().contains("transfer failed"),
        "the push never happened, so nothing here is being tested: {detail:?}"
    );
    assert_eq!(
        state, "ready",
        "a busy destination on older code stopped the migration for good: {detail:?}"
    );
}

#[tokio::test]
async fn a_receipt_for_a_different_subject_is_not_turned_into_a_forwarding_address() {
    let muddled = a_destination_answering(
        "200 OK",
        "{\"kind\":\"migration_ack\",\"migration_id\":\"m-ack\",\"subject_type\":\"guild\",\
          \"old_id\":\"some-other-guild\",\"new_id\":\"g-landed\",\
          \"server_name\":\"muddled.test\"}",
        "500 Internal Server Error",
        "{\"error\":\"internal\",\"message\":\"the push should never have happened\"}",
    )
    .await;
    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.peers.insert("muddled.test".into(), muddled.clone());
    })
    .await;
    landed_guild(&a, "g-ack", "@owner:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-ack', 'guild', 'g-ack', 'muddled.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-ack").await;
    assert!(out.is_err(), "a receipt about another guild was accepted: {out:?}");
    let tomb: Option<String> = sqlx::query_scalar(
        "SELECT new_id FROM tombstones WHERE subject_type = 'guild' AND subject_id = 'g-ack'",
    )
    .fetch_optional(&a.state.pool)
    .await
    .unwrap();
    assert!(tomb.is_none(), "a guild was pointed at an id that is not it: {tomb:?}");
    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-ack'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "failed", "{detail:?}");
    assert!(
        detail.as_deref().unwrap_or_default().contains("not what was sent"),
        "stopped for some other reason, so nothing here is being tested: {detail:?}"
    );
}

#[tokio::test]
async fn a_receipt_made_out_to_something_else_is_not_a_receipt_for_this() {
    for (what, ack) in [
        (
            "another migration id",
            "{\"kind\":\"migration_ack\",\"migration_id\":\"m-somebody-elses\",\
              \"subject_type\":\"guild\",\"old_id\":\"g-else\",\"new_id\":\"g-landed\"}",
        ),
        (
            "a different kind of subject",
            "{\"kind\":\"migration_ack\",\"migration_id\":\"m-else\",\
              \"subject_type\":\"user\",\"old_id\":\"g-else\",\"new_id\":\"@landed:x\"}",
        ),
    ] {
        let muddled = a_destination_answering(
            "200 OK",
            ack,
            "500 Internal Server Error",
            "{\"error\":\"internal\",\"message\":\"the push should never have happened\"}",
        )
        .await;
        let (a, _b) = pair_tuned(0, &|cfg| {
            cfg.federation.peers.insert("muddled.test".into(), muddled.clone());
        })
        .await;
        landed_guild(&a, "g-else", "@owner:a.test").await;
        sqlx::query(
            "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
             device_id, device_sig, state, created_at, executes_at) \
             VALUES ('m-else', 'guild', 'g-else', 'muddled.test', 'tok', 'd', 's', 'ready', 0, 0)",
        )
        .execute(&a.state.pool)
        .await
        .unwrap();

        let out = telium_server::routes::migrate::run(&a.state, "m-else").await;
        assert!(out.is_err(), "a receipt for {what} was accepted: {out:?}");
        let tomb: Option<String> = sqlx::query_scalar(
            "SELECT new_id FROM tombstones WHERE subject_type = 'guild' AND subject_id = 'g-else'",
        )
        .fetch_optional(&a.state.pool)
        .await
        .unwrap();
        assert!(tomb.is_none(), "a guild was pointed somewhere by a receipt for {what}: {tomb:?}");
    }
}

#[tokio::test]
async fn the_sweep_takes_the_oldest_migrations_first() {
    let (a, _b) = pair().await;
    for n in 0..11 {
        landed_guild(&a, &format!("g-{n:02}"), "@owner:a.test").await;
        sqlx::query(
            "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
             device_id, device_sig, state, created_at, executes_at) \
             VALUES (?, 'guild', ?, 'b.test', 'tok', 'd', 's', 'ready', 0, ?)",
        )
        .bind(format!("m-{n:02}"))
        .bind(format!("g-{n:02}"))
        .bind(10 - n as i64)
        .execute(&a.state.pool)
        .await
        .unwrap();
    }

    telium_server::routes::migrate::run_due(&a.state).await.unwrap();

    let waiting: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM migrations WHERE state IN ('pending', 'ready') ORDER BY id",
    )
    .fetch_all(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(
        waiting,
        vec!["m-00".to_string()],
        "the sweep took ten in the order they were written, not the ten that were due first"
    );
}
