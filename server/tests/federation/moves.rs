use super::*;

#[tokio::test]
async fn an_account_moves_to_another_server_and_its_guilds_follow() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;

    let session = a.session_on(&alice.token, &b).await;
    let (_, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Home" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    assert_eq!(guild["owner"], "@alice:a.test");

    let newcomer = register_full(&b, "alice2").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&newcomer.token),
            json!({ "subject_type": "user", "source": "a.test", "source_id": "@alice:a.test" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    let created_at = 1_700_000_000_000i64;
    let payload =
        telium_server::migration::grant_payload("@alice:a.test", "b.test", &import_token, created_at);
    let signature = device_sign(&alice.secret, &payload);

    let (status, body) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 400, "a stale grant timestamp must not be accepted: {body}");

    let created_at = now_ms();
    let payload =
        telium_server::migration::grant_payload("@alice:a.test", "b.test", &import_token, created_at);
    let signature = device_sign(&alice.secret, &payload);

    let (status, body) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": "AAAA", "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 401, "an unsigned grant must fail: {body}");

    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let migration_id = started["id"].as_str().unwrap().to_string();

    let (status, done) = a
        .post(&format!("/_telium/v1/migrate/{migration_id}/execute"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["new_id"], "@alice2:b.test");
    assert_eq!(done["tombstone"]["old_id"], "@alice:a.test");
    assert!(done["tombstone"]["signature"].is_string());
    assert!(done["tombstone"]["sig_new_server"].is_string());
    assert!(done["tombstone"]["sig_user_device"].is_string());

    let (status, status_doc) = a.get("/_telium/v1/users/@alice:a.test/status", None).await;
    assert_eq!(status, 200);
    assert_eq!(status_doc["status"], "moved");
    assert_eq!(status_doc["moved_to"], "@alice2:b.test");

    let (status, whoami) = b.get("/_telium/v1/whoami", Some(&newcomer.token)).await;
    assert_eq!(status, 200, "{whoami}");

    let (status, _) = a.get("/_telium/v1/whoami", Some(&alice.token)).await;
    assert_eq!(status, 401, "sessions do not outlive the account that moved");

    let (status, swept) = b.post("/_telium/v1/admin/revalidate", Some(&newcomer.token), json!({})).await;
    assert_eq!(status, 200, "{swept}");

    let session_b = b
        .post("/_telium/v1/sessions/local", Some(&newcomer.token), json!({}))
        .await
        .1["session_token"]
        .as_str()
        .unwrap()
        .to_string();
    let (status, members) =
        b.get(&format!("/_telium/v1/guilds/{guild_id}/members"), Some(&session_b)).await;
    assert_eq!(status, 200, "the moved account is a member under its new id: {members}");
    let ids: Vec<&str> =
        members["members"].as_array().unwrap().iter().filter_map(|m| m["user_id"].as_str()).collect();
    assert!(ids.contains(&"@alice2:b.test"), "membership did not follow: {members}");
    assert!(!ids.contains(&"@alice:a.test"), "the old id lingered: {members}");

    let (status, _) = b.get("/_telium/v1/guilds", Some(&session)).await;
    assert_eq!(status, 401, "a moved account's guild sessions do not survive");
}

async fn make_moves_due(server: &Server, user_id: &str) {
    sqlx::query("UPDATE membership_moves SET next_attempt_at = 0 WHERE user_id = ?")
        .bind(user_id)
        .execute(&server.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn the_home_keeps_a_registry_of_memberships_and_the_destination_moves_them() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;

    let session = a.session_on(&alice.token, &b).await;
    let (_, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Away" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let registry = eventually(&a, "/_telium/v1/memberships", &alice.token, |body| {
        body["memberships"].as_array().is_some_and(|m| m.iter().any(|r| r["guild_id"] == guild_id.as_str()))
    })
    .await;
    let row = registry["memberships"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["guild_id"] == guild_id.as_str())
        .unwrap();
    assert_eq!(row["guild_server"], "b.test");
    assert_eq!(row["reported_by"], "guild");
    assert_eq!(row["proof"]["action"], "joined", "the notice is kept as the proof: {row}");
    assert!(row["proof"]["signature"].is_string());

    let forged = telium_server::memberships::notice(&b.state, "joined", "@alice:a.test", "g-elsewhere");
    let mut forged = forged.clone();
    forged["guild_server"] = json!("c.test");
    let err = telium_server::federation::post_signed(
        &b.state,
        "a.test",
        "/_telium/v1/users/@alice:a.test/memberships",
        &forged,
    )
    .await
    .unwrap_err();
    assert!(format!("{err}").contains("must come from the guild server it names"), "{err}");
    let not_ours = telium_server::memberships::notice(&b.state, "joined", "@bob:b.test", "g-elsewhere");
    let err = telium_server::federation::post_signed(
        &b.state,
        "a.test",
        "/_telium/v1/users/@bob:b.test/memberships",
        &not_ours,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, telium_server::error::ApiError::NotFound(_)), "{err}");

    let (status, _) = a
        .post(
            "/_telium/v1/memberships",
            Some(&alice.token),
            json!({ "guild_server": "c.test", "guild_ids": ["g-on-c"] }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, _) = a
        .post("/_telium/v1/memberships", Some(&alice.token), json!({ "guild_server": "b.test", "guild_ids": [] }))
        .await;
    assert_eq!(status, 200);
    let (_, registry) = a.get("/_telium/v1/memberships", Some(&alice.token)).await;
    let rows = registry["memberships"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["guild_id"] == "g-on-c" && r["reported_by"] == "client"), "{registry}");
    assert!(rows.iter().any(|r| r["guild_id"] == guild_id.as_str()), "a client report does not withdraw the guild server's word: {registry}");

    let newcomer = register_full(&b, "alice2").await;
    let done = move_user(&a, &b, &alice, &newcomer.token, "@alice:a.test").await;
    assert_eq!(done["new_id"], "@alice2:b.test");
    let (status, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    assert_eq!(status, 200, "{moves}");
    let moves = moves["moves"].as_array().unwrap();
    assert_eq!(moves.len(), 2, "one row per guild server: {moves:?}");
    for m in moves {
        assert_eq!(m["state"], "pending");
        assert_eq!(m["attempts"], 0);
        assert_eq!(m["old_id"], "@alice:a.test");
        assert!(m["next_attempt_at"].as_i64().unwrap() > now_ms(), "the first try waits for the tombstone");
    }
    let on_b = moves.iter().find(|m| m["guild_server"] == "b.test").unwrap();
    assert_eq!(on_b["guild_ids"], json!([guild_id]));

    make_moves_due(&b, "@alice2:b.test").await;
    for pass in 0..5 {
        telium_server::memberships::run_due(&b.state).await.unwrap();
        let local_state: Option<String> = sqlx::query_scalar(
            "SELECT state FROM membership_moves WHERE user_id = ? AND guild_server = 'b.test'",
        )
        .bind("@alice2:b.test")
        .fetch_optional(&b.state.pool)
        .await
        .unwrap();
        if local_state.as_deref() == Some("done") {
            break;
        }
        assert!(pass < 4, "local membership move never completed: {local_state:?}");
        sqlx::query(
            "UPDATE membership_moves SET next_attempt_at = 0 \
             WHERE user_id = ? AND guild_server = 'b.test' AND state = 'pending'",
        )
        .bind("@alice2:b.test")
        .execute(&b.state.pool)
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }

    let session_b = b
        .post("/_telium/v1/sessions/local", Some(&newcomer.token), json!({}))
        .await
        .1["session_token"]
        .as_str()
        .unwrap()
        .to_string();
    let ids = member_ids(&b, &guild_id, &session_b).await;
    assert!(ids.contains(&"@alice2:b.test".to_string()), "membership did not follow: {ids:?}");
    assert!(!ids.contains(&"@alice:a.test".to_string()), "the old id lingered: {ids:?}");
    let (status, _) = b.get("/_telium/v1/guilds", Some(&session)).await;
    assert_eq!(status, 401, "a moved account's guild sessions do not survive");

    let (_, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    let moves = moves["moves"].as_array().unwrap();
    let on_b = moves.iter().find(|m| m["guild_server"] == "b.test").unwrap();
    assert_eq!(on_b["state"], "done");
    let on_c = moves.iter().find(|m| m["guild_server"] == "c.test").unwrap();
    assert_eq!(on_c["state"], "pending");
    assert_eq!(on_c["attempts"], 1);
    assert!(on_c["last_error"].as_str().is_some_and(|e| !e.is_empty()), "{on_c}");
    assert!(on_c["next_attempt_at"].as_i64().unwrap() > now_ms(), "backed off: {on_c}");

    sqlx::query("UPDATE membership_moves SET attempts = ?, next_attempt_at = 0 WHERE guild_server = 'c.test'")
        .bind(telium_server::memberships::MAX_ATTEMPTS - 1)
        .execute(&b.state.pool)
        .await
        .unwrap();
    telium_server::memberships::run_due(&b.state).await.unwrap();
    let (_, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    let on_c = moves["moves"].as_array().unwrap().iter().find(|m| m["guild_server"] == "c.test").unwrap().clone();
    assert_eq!(on_c["state"], "failed", "{on_c}");
    let (status, retried) = b.post("/_telium/v1/migrate/memberships/retry", Some(&newcomer.token), json!({})).await;
    assert_eq!(status, 200, "{retried}");
    assert_eq!(retried["retried"], 1);
    let (_, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    let on_c = moves["moves"].as_array().unwrap().iter().find(|m| m["guild_server"] == "c.test").unwrap().clone();
    assert_eq!(on_c["state"], "pending");
    assert_eq!(on_c["attempts"], 0);
}

#[tokio::test]
async fn a_guild_server_checks_a_move_notice_against_the_old_home() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let session = a.session_on(&alice.token, &b).await;
    let (_, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Away" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    register_full(&b, "alice2").await;

    let err = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/users/@alice:a.test/moved",
        &json!({ "old_id": "@alice:a.test", "new_id": "@alice2:b.test" }),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, telium_server::error::ApiError::Forbidden(_)), "{err}");

    let err = telium_server::memberships::apply_move_notice(&b.state, "b.test", "@alice:a.test", "@alice2:b.test")
        .await
        .unwrap_err();
    assert!(matches!(err, telium_server::error::ApiError::TryAgain(_)), "not a final refusal: {err}");
    let ids = member_ids(&b, &guild_id, &session).await;
    assert!(ids.contains(&"@alice:a.test".to_string()), "nothing was rewritten: {ids:?}");
}

#[tokio::test]
async fn a_guild_server_that_is_offline_during_a_move_is_told_when_it_returns() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let session_c = a.session_on(&alice.token, &c).await;
    let (_, guild) = c.post("/_telium/v1/guilds", Some(&session_c), json!({ "name": "Far" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    eventually(&a, "/_telium/v1/memberships", &alice.token, |body| {
        body["memberships"].as_array().is_some_and(|m| m.iter().any(|r| r["guild_server"] == "c.test"))
    })
    .await;

    let offline = take_offline(c);
    let newcomer = register_full(&b, "alice2").await;
    move_user(&a, &b, &alice, &newcomer.token, "@alice:a.test").await;

    make_moves_due(&b, "@alice2:b.test").await;
    assert_eq!(telium_server::memberships::run_due(&b.state).await.unwrap(), 0);
    let (_, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    let on_c = moves["moves"].as_array().unwrap().iter().find(|m| m["guild_server"] == "c.test").unwrap().clone();
    assert_eq!(on_c["state"], "pending", "{on_c}");
    assert_eq!(on_c["attempts"], 1);
    assert!(on_c["last_error"].as_str().is_some_and(|e| !e.is_empty()), "{on_c}");

    let c = bring_back(offline).await;
    make_moves_due(&b, "@alice2:b.test").await;
    assert_eq!(telium_server::memberships::run_due(&b.state).await.unwrap(), 1);
    let (_, moves) = b.get("/_telium/v1/migrate/memberships", Some(&newcomer.token)).await;
    let on_c = moves["moves"].as_array().unwrap().iter().find(|m| m["guild_server"] == "c.test").unwrap().clone();
    assert_eq!(on_c["state"], "done", "{on_c}");
    assert_eq!(on_c["attempts"], 2);
    assert!(on_c["last_error"].is_null());

    let session_c2 = b.session_on(&newcomer.token, &c).await;
    let ids = member_ids(&c, &guild_id, &session_c2).await;
    assert!(ids.contains(&"@alice2:b.test".to_string()), "membership did not follow: {ids:?}");
    assert!(!ids.contains(&"@alice:a.test".to_string()), "the old id lingered: {ids:?}");
    let (status, _) = c.get("/_telium/v1/guilds", Some(&session_c)).await;
    assert_eq!(status, 401, "the old id's session on c.test is gone");
}

#[tokio::test]
async fn a_migration_can_be_cancelled_during_the_cooling_off_window() {
    let (a, b) = pair_with_delay(3600).await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let newcomer = register_full(&b, "alice2").await;

    let (_, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&newcomer.token),
            json!({ "subject_type": "user", "source": "a.test", "source_id": "@alice:a.test" }),
        )
        .await;
    let import_token = claim["import_token"].as_str().unwrap().to_string();
    let created_at = now_ms();
    let payload =
        telium_server::migration::grant_payload("@alice:a.test", "b.test", &import_token, created_at);
    let signature = device_sign(&alice.secret, &payload);

    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let id = started["id"].as_str().unwrap().to_string();
    assert!(started["executes_at"].as_i64().unwrap() > now_ms() + 3_000_000);

    let (status, body) =
        a.post(&format!("/_telium/v1/migrate/{id}/execute"), Some(&alice.token), json!({})).await;
    assert_eq!(status, 409, "the cooling-off window is not advisory: {body}");

    let (status, cancelled) =
        a.post(&format!("/_telium/v1/migrate/{id}/cancel"), Some(&alice.token), json!({})).await;
    assert_eq!(status, 200, "{cancelled}");
    assert_eq!(cancelled["state"], "cancelled");

    let (status, whoami) = a.get("/_telium/v1/whoami", Some(&alice.token)).await;
    assert_eq!(status, 200, "a cancelled migration leaves the account untouched: {whoami}");
}

#[tokio::test]
async fn a_guild_moves_and_stops_accepting_writes_where_it_used_to_live() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();

    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Movers" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = a.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = a
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "before the move" }),
        )
        .await;
    assert_eq!(status, 200);

    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": guild_id }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();

    let created_at = now_ms();
    let payload = telium_server::migration::grant_payload(&guild_id, "b.test", &import_token, created_at);
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
    let id = started["id"].as_str().unwrap().to_string();

    let (status, done) =
        a.post(&format!("/_telium/v1/migrate/{id}/execute"), Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{done}");
    let new_guild = done["new_id"].as_str().unwrap().to_string();

    let (status, old_status) = a.get(&format!("/_telium/v1/guilds/{guild_id}/status"), None).await;
    assert_eq!(status, 200);
    assert_eq!(old_status["status"], "moved");
    assert_eq!(old_status["moved_to"], new_guild);

    let (status, body) = a
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "after the move" }),
        )
        .await;
    assert_eq!(status, 403, "one guild, one authority: {body}");

    let (status, session_b) = b.post("/_telium/v1/sessions/local", Some(&landing.token), json!({})).await;
    assert_eq!(status, 200, "{session_b}");
    let session_b = session_b["session_token"].as_str().unwrap().to_string();
    let (status, channels) =
        b.get(&format!("/_telium/v1/guilds/{new_guild}/channels"), Some(&session_b)).await;
    assert_eq!(status, 200, "{channels}");
    let new_channel = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (status, history) =
        b.get(&format!("/_telium/v1/channels/{new_channel}/messages"), Some(&session_b)).await;
    assert_eq!(status, 200, "{history}");
    assert_eq!(history["messages"][0]["content"], "before the move");
}

#[tokio::test]
async fn a_bundle_outlives_the_timeout_meant_for_small_requests() {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
    const HOLD: std::time::Duration = std::time::Duration::from_secs(2);
    let (a, b) =
        pair_tuned(0, &|cfg| cfg.federation.request_timeout_secs = TIMEOUT.as_secs()).await;
    let landing = register_full(&b, "owner").await;

    let free = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-free",
            "import_token": claim_on(&b, &landing.token, "g-free").await,
            "bundle": weighty_bundle("g-free", HELD_BUNDLE_ROWS),
        }),
    )
    .await;
    assert!(free.is_ok(), "the ordinary client could not carry a bundle at all: {free:?}");

    let held_token = claim_on(&b, &landing.token, "g-held").await;
    let began = std::time::Instant::now();
    let hold = hold_the_write_lock(&b, HOLD).await;
    let held = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-held",
            "import_token": held_token,
            "bundle": weighty_bundle("g-held", HELD_BUNDLE_ROWS),
        }),
    )
    .await;
    let elapsed = began.elapsed();
    assert!(
        held.is_err(),
        "the ordinary {TIMEOUT:?} client waited out a {HOLD:?} hold ({elapsed:?}), so nothing \
         below turns on the push having its own allowance"
    );
    assert!(
        elapsed < HOLD,
        "the ordinary client's push failed only after the hold had let go ({elapsed:?}), which \
         is some failure other than the timeout: {held:?}"
    );
    hold.await.unwrap();

    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Heavy" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = a.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();

    for chunk in (0..HELD_BUNDLE_ROWS).collect::<Vec<_>>().chunks(400) {
        let mut sql = String::from(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
             VALUES ",
        );
        for (i, n) in chunk.iter().enumerate() {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&format!(
                "('held-{n:06}','{channel_id}','{guild_id}','@owner:a.test','hello',1)"
            ));
        }
        sqlx::query(&sql).execute(&a.state.pool).await.unwrap();
    }

    let import_token = claim_on(&b, &landing.token, &guild_id).await;
    let created_at = now_ms();
    let payload = telium_server::migration::grant_payload(&guild_id, "b.test", &import_token, created_at);
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
    let id = started["id"].as_str().unwrap().to_string();

    let began = std::time::Instant::now();
    let hold = hold_the_write_lock(&b, HOLD).await;
    let (status, done) =
        a.post(&format!("/_telium/v1/migrate/{id}/execute"), Some(&owner.token), json!({})).await;
    let elapsed = began.elapsed();
    assert_eq!(status, 200, "the push must not be cut off by the client timeout: {done}");
    assert!(
        elapsed >= HOLD,
        "the migration was acknowledged in {elapsed:?}, before the {HOLD:?} hold on the \
         destination had let go, so the push was never made to wait: {done}"
    );
    hold.await.unwrap();

    let new_guild = done["new_id"].as_str().unwrap().to_string();
    let landed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = ?")
        .bind(&new_guild)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(landed as usize, HELD_BUNDLE_ROWS, "the bundle arrived short");
}

const HELD_BUNDLE_ROWS: usize = 500;

async fn hold_the_write_lock(
    server: &Server,
    how_long: std::time::Duration,
) -> tokio::task::JoinHandle<()> {
    let mut conn = server.state.pool.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await.unwrap();
    tokio::spawn(async move {
        tokio::time::sleep(how_long).await;
        sqlx::query("ROLLBACK").execute(&mut *conn).await.unwrap();
    })
}
