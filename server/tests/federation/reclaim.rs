use super::*;

#[tokio::test]
async fn a_moved_guilds_history_can_be_reclaimed_without_losing_where_it_went() {
    let (a, _b) = pair_tuned(0, &|cfg| cfg.limits.max_guilds_per_user = 1).await;
    let admin = register_full(&a, "admin").await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Gone" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let channel_id: String = sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&a.state.pool)
        .await
        .unwrap();

    for (source, target) in [(channel_id.as_str(), "c-abroad"), ("c-abroad", channel_id.as_str())] {
        sqlx::query(
            "INSERT INTO channel_follows (source_id, target_id, created_by, created_at) \
             VALUES (?, ?, '@owner:a.test', 0)",
        )
        .bind(source)
        .bind(target)
        .execute(&a.state.pool)
        .await
        .unwrap();
    }

    let (status, refused) = a
        .post(&format!("/_telium/v1/admin/guilds/{guild_id}/purge"), Some(&owner.token), json!({}))
        .await;
    assert_eq!(status, 403, "anybody could purge a guild: {refused}");

    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = '@admin:a.test'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    a.elevate(&admin.token).await;

    let (status, not_moved) = a
        .post(&format!("/_telium/v1/admin/guilds/{guild_id}/purge"), Some(&admin.token), json!({}))
        .await;
    assert_eq!(status, 409, "a guild that never moved was purged: {not_moved}");

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 0)",
    )
    .bind(&guild_id)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (status, purged) = a
        .post(&format!("/_telium/v1/admin/guilds/{guild_id}/purge"), Some(&admin.token), json!({}))
        .await;
    assert_eq!(status, 200, "a moved guild's history could not be reclaimed: {purged}");
    assert_eq!(purged["moved_to"], "g-elsewhere");

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0, "the rows are still here, so nothing was reclaimed");
    let follows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM channel_follows WHERE source_id = ? OR target_id = ?",
    )
    .bind(&channel_id)
    .bind(&channel_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(follows, 0, "follows outlived the channels they name");
    let (kind, new_id): (String, Option<String>) = sqlx::query_as(
        "SELECT kind, new_id FROM tombstones WHERE subject_type = 'guild' AND subject_id = ?",
    )
    .bind(&guild_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(kind, "moved", "reclaiming the history took the forwarding address with it");
    assert_eq!(new_id.as_deref(), Some("g-elsewhere"));

    let (status, again) = a
        .post(&format!("/_telium/v1/admin/guilds/{guild_id}/purge"), Some(&admin.token), json!({}))
        .await;
    assert_eq!(status, 409, "purging twice was an internal error rather than an answer: {again}");

    let (status, mine) = a.get("/_telium/v1/guilds", Some(&session)).await;
    assert_eq!(status, 200, "{mine}");
    let listed = mine["guilds"].as_array().unwrap();
    let moved = listed
        .iter()
        .find(|g| g["id"] == guild_id.as_str())
        .unwrap_or_else(|| panic!("the member was not told where their guild went: {mine}"));
    assert_eq!(moved["moved_to"], "g-elsewhere");
    assert_eq!(moved["origin"], "a.test");
    assert!(moved["name"].is_null(), "a guild with no rows described itself: {mine}");
    assert!(moved["channels"].as_array().is_some_and(|c| c.is_empty()), "{mine}");

    let (status, refused) =
        a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Second" })).await;
    assert_eq!(status, 200, "a reclaimed guild still spends a slot of the allowance: {refused}");

    sqlx::query("UPDATE members SET banned = 1 WHERE guild_id = ?")
        .bind(&guild_id)
        .execute(&a.state.pool)
        .await
        .unwrap();

    let (status, left) =
        a.post(&format!("/_telium/v1/guilds/{guild_id}/leave"), Some(&session), json!({})).await;
    assert_eq!(status, 200, "a member could not put down a guild that is not there: {left}");
    let (status, mine) = a.get("/_telium/v1/guilds", Some(&session)).await;
    assert_eq!(status, 200, "{mine}");
    assert!(
        !mine["guilds"].as_array().unwrap().iter().any(|g| g["id"] == guild_id.as_str()),
        "the guild they left is still listed: {mine}"
    );
    let left_over: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
    assert_eq!(left_over, 0, "the membership row outlived the guild and the leave");
}

#[tokio::test]
async fn the_first_thing_a_client_hears_says_where_its_guild_went() {
    use futures_util::{SinkExt as _, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let (a, _b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Left" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 0)",
    )
    .bind(&guild_id)
    .execute(&a.state.pool)
    .await
    .unwrap();
    let admin = register_full(&a, "admin").await;
    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = '@admin:a.test'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    a.elevate(&admin.token).await;

    let ws_url = format!("{}/gateway/v1", a.base.replace("http://", "ws://"));
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    async fn next<S>(ws: &mut S) -> Value
    where
        S: StreamExt + Unpin,
        S::Item: std::fmt::Debug,
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>,
    {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(&t).unwrap(),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }
    assert_eq!(next(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": session, "intents": ["GUILD_STRUCTURE"] } })
            .to_string(),
    ))
    .await
    .unwrap();
    let first = next(&mut ws).await;
    assert_eq!(first["op"], "READY", "{first}");
    let listed = first["d"]["guilds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == guild_id.as_str())
        .unwrap_or_else(|| panic!("READY left the moved guild out entirely: {first}"));
    assert_eq!(
        listed["moved_to"], "g-elsewhere",
        "READY did not say where the guild went while its rows were still here: {first}"
    );

    let (status, purged) = a
        .post(&format!("/_telium/v1/admin/guilds/{guild_id}/purge"), Some(&admin.token), json!({}))
        .await;
    assert_eq!(status, 200, "{purged}");
    let live = next(&mut ws).await;
    assert_eq!(live["t"], "GUILD_UPDATE", "the member was told their guild ended: {live}");
    assert_eq!(live["d"]["id"], guild_id.as_str());
    assert_eq!(live["d"]["moved_to"], "g-elsewhere");

    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    assert_eq!(next(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": session, "intents": [] } }).to_string(),
    ))
    .await
    .unwrap();
    let ready = next(&mut ws).await;
    assert_eq!(ready["op"], "READY", "{ready}");
    let listed = ready["d"]["guilds"].as_array().unwrap();
    let moved = listed
        .iter()
        .find(|g| g["id"] == guild_id.as_str())
        .unwrap_or_else(|| panic!("READY said nothing about where the guild went: {ready}"));
    assert_eq!(moved["moved_to"], "g-elsewhere");
    assert!(moved["channels"].as_array().is_some_and(|c| c.is_empty()), "{ready}");
    assert!(moved["me"].is_null(), "{ready}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_operators_reclaiming_the_same_history_do_not_both_get_a_yes() {
    let (a, _b) = pair().await;
    let admin = register_full(&a, "admin").await;
    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = '@admin:a.test'")
        .execute(&a.state.pool)
        .await
        .unwrap();
    a.elevate(&admin.token).await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();

    for n in 0..8 {
        let (_, guild) =
            a.post("/_telium/v1/guilds", Some(&session), json!({ "name": format!("Left {n}") })).await;
        let guild_id = guild["id"].as_str().unwrap().to_string();
        sqlx::query(
            "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
             VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 0)",
        )
        .bind(&guild_id)
        .execute(&a.state.pool)
        .await
        .unwrap();

        let path = format!("/_telium/v1/admin/guilds/{guild_id}/purge");
        let (first, second) = tokio::join!(
            a.post(&path, Some(&admin.token), json!({})),
            a.post(&path, Some(&admin.token), json!({})),
        );
        let mut got = [first.0, second.0];
        got.sort();
        assert_eq!(
            got,
            [200, 409],
            "two purges at once answered {got:?}: {} / {}",
            first.1,
            second.1
        );
        let lost = if first.0 == 409 { &first.1 } else { &second.1 };
        let told = lost["message"].as_str().unwrap_or_default();
        assert!(
            told.contains("forwarding address"),
            "the purge that lost the race was told {told:?}"
        );
        let kind: String = sqlx::query_scalar(
            "SELECT kind FROM tombstones WHERE subject_type = 'guild' AND subject_id = ?",
        )
        .bind(&guild_id)
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
        assert_eq!(kind, "moved");
    }
}

#[tokio::test]
async fn a_person_asking_for_their_own_move_is_not_put_to_the_back_of_the_queue() {
    let never_answers = a_destination_answering(
        "503 Service Unavailable",
        "{\"error\":\"down\"}",
        "503 Service Unavailable",
        "{\"error\":\"down\"}",
    )
    .await;
    let will_not_take_it =
        a_destination_that_refuses_the_push("503 Service Unavailable", "{\"error\":\"down\"}").await;
    for dead in [never_answers, will_not_take_it] {
        let (a, _b) = pair_tuned(0, &|cfg| {
            cfg.federation.peers.insert("dead.test".into(), dead.clone());
        })
        .await;
        landed_guild(&a, "g-mine", "@owner:a.test").await;
        sqlx::query(
            "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
             device_id, device_sig, state, created_at, executes_at) \
             VALUES ('m-mine', 'guild', 'g-mine', 'dead.test', 'tok', 'd', 's', 'ready', 0, 0)",
        )
        .execute(&a.state.pool)
        .await
        .unwrap();

        for _ in 0..7 {
            let _ = telium_server::routes::migrate::run(&a.state, "m-mine").await;
        }
        let (until, count): (i64, i64) =
            sqlx::query_as("SELECT deferred_until, defer_count FROM migrations WHERE id = 'm-mine'")
                .fetch_one(&a.state.pool)
                .await
                .unwrap();
        assert_eq!(
            (until, count),
            (0, 0),
            "asking for your own move put it {} ms out of the sweep's reach",
            until
        );

        telium_server::routes::migrate::run_due(&a.state).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT defer_count FROM migrations WHERE id = 'm-mine'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "the sweep did not stand the row down");
    }
}

#[tokio::test]
async fn a_migration_that_gives_up_before_it_pushes_still_stands_aside() {
    let (a, _b) = pair().await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-nothing', 'guild', 'g-nothing', 'b.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    telium_server::routes::migrate::run_due(&a.state).await.unwrap();
    let (state, count): (String, i64) =
        sqlx::query_as("SELECT state, defer_count FROM migrations WHERE id = 'm-nothing'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(state, "ready", "a row that never sent anything was moved on");
    assert_eq!(count, 1, "an exit with no `defer` of its own was not covered by the sweep's");
}

#[tokio::test]
async fn standing_aside_doubles_and_then_stops_doubling() {
    let (a, _b) = pair().await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-again', 'guild', 'g-nothing', 'b.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let want = [60, 120, 240, 480, 960, 1_920, 3_600, 3_600];
    for (n, want) in want.iter().enumerate() {
        let before = now_ms();
        telium_server::routes::migrate::run_due(&a.state).await.unwrap();
        let (until, count): (i64, i64) =
            sqlx::query_as("SELECT deferred_until, defer_count FROM migrations WHERE id = 'm-again'")
                .fetch_one(&a.state.pool)
                .await
                .unwrap();
        assert_eq!(count, n as i64 + 1, "the sweep did not stand the row down on pass {n}");
        let gap = until - before;
        assert!(
            (gap - want * 1000).abs() < 5_000,
            "pass {n} stood the row aside for {gap} ms, not about {} ms",
            want * 1000
        );
        sqlx::query("UPDATE migrations SET deferred_until = 0 WHERE id = 'm-again'")
            .execute(&a.state.pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_sweep_that_is_out_of_time_leaves_the_rest_for_the_next_tick() {
    let (a, _b) = pair().await;
    landed_guild(&a, "g-waiting", "@owner:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-waiting', 'guild', 'g-waiting', 'b.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let done = telium_server::routes::migrate::run_due_within(&a.state, std::time::Duration::ZERO)
        .await
        .unwrap();
    assert_eq!(done, 0, "a sweep with no time left still started a push");
    let detail: Option<String> =
        sqlx::query_scalar("SELECT detail FROM migrations WHERE id = 'm-waiting'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert!(detail.is_none(), "the row was touched by a sweep that had no time for it: {detail:?}");

    telium_server::routes::migrate::run_due(&a.state).await.unwrap();
    let detail: Option<String> =
        sqlx::query_scalar("SELECT detail FROM migrations WHERE id = 'm-waiting'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert!(detail.is_some(), "the next sweep never came back to it");
}

#[tokio::test]
async fn a_destination_that_is_down_does_not_get_the_whole_sweep_forever() {
    let never_answers = a_destination_answering(
        "503 Service Unavailable",
        "{\"error\":\"down\"}",
        "503 Service Unavailable",
        "{\"error\":\"down\"}",
    )
    .await;
    let will_not_take_it =
        a_destination_that_refuses_the_push("503 Service Unavailable", "{\"error\":\"down\"}").await;
    for dead in [never_answers, will_not_take_it] {
        let (a, _b) = pair_tuned(0, &|cfg| {
            cfg.federation.peers.insert("dead.test".into(), dead.clone());
        })
        .await;
        for n in 0..10 {
            landed_guild(&a, &format!("g-stuck-{n}"), "@owner:a.test").await;
            sqlx::query(
                "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
                 device_id, device_sig, state, created_at, executes_at) \
                 VALUES (?, 'guild', ?, 'dead.test', 'tok', 'd', 's', 'ready', 0, 0)",
            )
            .bind(format!("m-stuck-{n}"))
            .bind(format!("g-stuck-{n}"))
            .execute(&a.state.pool)
            .await
            .unwrap();
        }
        landed_guild(&a, "g-behind", "@owner:a.test").await;
        sqlx::query(
            "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
             device_id, device_sig, state, created_at, executes_at) \
             VALUES ('m-behind', 'guild', 'g-behind', 'dead.test', 'tok', 'd', 's', 'ready', 0, 1)",
        )
        .execute(&a.state.pool)
        .await
        .unwrap();

        telium_server::routes::migrate::run_due(&a.state).await.unwrap();
        let waiting: Option<String> =
            sqlx::query_scalar("SELECT detail FROM migrations WHERE id = 'm-behind'")
                .fetch_one(&a.state.pool)
                .await
                .unwrap();
        assert!(waiting.is_none(), "the eleventh row went first, so nothing is being tested here");

        telium_server::routes::migrate::run_due(&a.state).await.unwrap();
        let reached: Option<String> =
            sqlx::query_scalar("SELECT detail FROM migrations WHERE id = 'm-behind'")
                .fetch_one(&a.state.pool)
                .await
                .unwrap();
        assert!(
            reached.is_some(),
            "a migration opened behind ten unreachable ones was never attempted at all"
        );
        let still: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM migrations WHERE state = 'ready' AND defer_count > 0",
        )
        .fetch_one(&a.state.pool)
        .await
        .unwrap();
        assert_eq!(still, 11, "the deferred rows did not stay ready");
    }
}

#[tokio::test]
async fn a_guild_that_moved_is_not_deleted_out_from_under_its_forwarding_address() {
    let (a, _b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Left" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 0)",
    )
    .bind(&guild_id)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (status, body) = a.delete(&format!("/_telium/v1/guilds/{guild_id}"), &session).await;
    assert_eq!(status, 403, "a moved guild was deleted from the server it left: {body}");
    let (kind, new_id): (String, Option<String>) = sqlx::query_as(
        "SELECT kind, new_id FROM tombstones WHERE subject_type = 'guild' AND subject_id = ?",
    )
    .bind(&guild_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(kind, "moved", "the forwarding address became a gravestone");
    assert_eq!(new_id.as_deref(), Some("g-elsewhere"));
}

#[tokio::test]
async fn a_bundle_refused_for_its_size_is_not_uploaded_again_every_tick() {
    let strict = a_destination_that_refuses_the_push(
        "413 Payload Too Large",
        "{\"error\":\"too_large\",\"message\":\"federation body is too large\"}",
    )
    .await;
    let (a, _b) = pair_tuned(0, &|cfg| {
        cfg.federation.peers.insert("strict.test".into(), strict.clone());
    })
    .await;
    landed_guild(&a, "g-big", "@owner:a.test").await;
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, \
         device_id, device_sig, state, created_at, executes_at) \
         VALUES ('m-big', 'guild', 'g-big', 'strict.test', 'tok', 'd', 's', 'ready', 0, 0)",
    )
    .execute(&a.state.pool)
    .await
    .unwrap();

    let out = telium_server::routes::migrate::run(&a.state, "m-big").await;
    assert!(out.is_err(), "the fake destination answered something other than a refusal: {out:?}");
    let (state, detail): (String, Option<String>) =
        sqlx::query_as("SELECT state, detail FROM migrations WHERE id = 'm-big'")
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert!(
        detail.as_deref().unwrap_or_default().contains("refused the bundle"),
        "the push never happened, so nothing here is being tested: {detail:?}"
    );
    assert_eq!(
        state, "failed",
        "a bundle refused for its size was left to be uploaded again: {detail:?}"
    );
}

#[tokio::test]
async fn a_home_that_cannot_answer_is_a_gateway_failure_not_a_refusal() {
    let failing = a_destination_answering(
        "", "", "500 Internal Server Error", "{\"error\":\"internal\",\"message\":\"internal error\"}",
    )
    .await;
    let unavailable = a_destination_answering(
        "", "", "503 Service Unavailable", "{\"error\":\"down\",\"message\":\"down for upgrade\"}",
    )
    .await;
    let timing_out = a_destination_answering(
        "", "", "504 Gateway Timeout", "{\"error\":\"gateway_timeout\",\"message\":\"slow\"}",
    )
    .await;
    let refusing = a_destination_answering(
        "", "", "403 Forbidden", "{\"error\":\"forbidden\",\"message\":\"not for you\"}",
    )
    .await;
    let gone = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let peers = [
        ("failing.test", failing),
        ("unavailable.test", unavailable),
        ("slow.test", timing_out),
        ("refusing.test", refusing),
        ("gone.test", gone),
    ];
    let (a, _b) = pair_tuned(0, &|cfg| {
        for (name, base) in &peers {
            cfg.federation.peers.insert((*name).into(), base.clone());
        }
    })
    .await;

    for (home, status, class) in [
        ("failing.test", 502, "bad_gateway"),
        ("unavailable.test", 503, "upstream_unavailable"),
        ("slow.test", 504, "gateway_timeout"),
        ("gone.test", 502, "bad_gateway"),
        ("refusing.test", 403, "forbidden"),
    ] {
        let (got, body) =
            a.get(&format!("/_telium/v1/users/@someone:{home}/identity"), None).await;
        assert_eq!(got, status, "{home}: {body}");
        assert_eq!(body["error"], class, "{home}: {body}");
    }
}

#[tokio::test]
async fn a_bundle_from_a_newer_protocol_is_refused_as_a_conflict() {
    let (a, b) = pair().await;
    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": "g-future" }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/import",
        &json!({
            "migration_id": "m-future",
            "import_token": claim["import_token"].as_str().unwrap(),
            "bundle": { "version": 9_999, "subject_type": "guild", "subject_id": "g-future" },
        }),
    )
    .await;
    let refused = format!("{sent:?}");
    assert!(
        refused.contains("Conflict") && refused.contains("newer protocol version"),
        "a bundle from the future was not refused as a conflict: {refused}"
    );
}

#[tokio::test]
async fn a_body_that_took_a_while_to_arrive_is_not_a_stale_one() {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.federation.max_clock_skew_secs = 2;
    })
    .await;

    let body = serde_json::to_vec(&json!({
        "migration_id": "m-slow",
        "import_token": "nope",
        "bundle": { "padding": "x".repeat(16 * 1024) },
    }))
    .unwrap();
    let path = "/_telium/v1/migrate/import";
    let header = telium_server::federation::auth_header(
        &a.state.key,
        "POST",
        path,
        &body,
        "a.test",
        "b.test",
    );

    let addr = b.base.trim_start_matches("http://").to_string();
    let mut sock = tokio::net::TcpStream::connect(&addr).await.unwrap();
    sock.write_all(
        format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: {header}\r\n\
             Content-Type: application/json\r\nConnection: close\r\n\
             Content-Length: {}\r\n\r\n",
            body.len()
        )
        .as_bytes(),
    )
    .await
    .unwrap();
    sock.flush().await.unwrap();

    for (n, piece) in body.chunks(body.len().div_ceil(4)).enumerate() {
        if n > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
        }
        sock.write_all(piece).await.unwrap();
        sock.flush().await.unwrap();
    }

    let mut said = Vec::new();
    sock.read_to_end(&mut said).await.unwrap();
    let said = String::from_utf8_lossy(&said).into_owned();
    assert!(
        !said.contains("skew window"),
        "a body that took four seconds to arrive was refused as a stale request: {said}"
    );
    assert!(
        said.starts_with("HTTP/1.1 403"),
        "expected the request to reach the route and be refused for its claim: {said}"
    );
}
