use super::*;

#[tokio::test]
async fn deciding_a_held_message_takes_it_off_the_other_moderators_queue() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let carol = s.user("carol").await;
    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (status, gates) = s
        .put(
            &format!("/_telium/v1/guilds/{gid}/gates"),
            &alice.token,
            json!({ "hold_first_messages": 1 }),
        )
        .await;
    assert_eq!(status, 200, "{gates}");
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    for who in [&carol, &bob] {
        let (status, joined) =
            s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&who.token), json!({})).await;
        assert_eq!(status, 200, "{joined}");
    }
    let (_, channels) =
        s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let mut carols = connect_watching(&s, &carol.token, &["GUILD_MESSAGES"]).await;
    let (status, held) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&bob.token),
            json!({ "content": "hello everyone" }),
        )
        .await;
    assert_eq!(status, 200, "{held}");
    assert_eq!(held["held"], true, "{held}");
    let arrived = wait_for(&mut carols, "MESSAGE_HELD").await;
    let hid = arrived["d"]["id"].as_str().unwrap().to_string();

    let (status, decided) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/held/{hid}"),
            Some(&alice.token),
            json!({ "decision": "approve" }),
        )
        .await;
    assert_eq!(status, 200, "{decided}");
    let settled = wait_for(&mut carols, "MESSAGE_HELD").await;
    assert_eq!(settled["d"]["removed"], hid.as_str(), "{settled}");
    assert_eq!(settled["d"]["channel_id"], cid.as_str(), "{settled}");
    assert!(settled["d"]["decision"].is_null(), "{settled}");
}

#[tokio::test]
async fn a_message_revives_a_thread_on_everyone_elses_list() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    let (status, thread) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/threads"),
            Some(&alice.token),
            json!({ "title": "ship it" }),
        )
        .await;
    assert_eq!(status, 200, "{thread}");
    let tid = thread["id"].as_str().unwrap().to_string();
    let (status, archived) = s
        .patch(&format!("/_telium/v1/threads/{tid}"), &alice.token, json!({ "archived": true }))
        .await;
    assert_eq!(status, 200, "{archived}");

    let mut alices = connect_watching(&s, &alice.token, &["GUILD_STRUCTURE"]).await;
    let (status, msg) = s
        .post(
            &format!("/_telium/v1/channels/{tid}/messages"),
            Some(&bob.token),
            json!({ "content": "on it" }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    let seen = wait_for(&mut alices, "THREAD_UPDATE").await;
    assert_eq!(seen["d"]["id"], tid.as_str(), "{seen}");
    assert_eq!(seen["d"]["guild_id"], gid.as_str(), "{seen}");
    assert_eq!(seen["d"]["archived"], false, "the revival is the news: {seen}");
    assert_eq!(seen["d"]["message_count"], 1, "{seen}");

    let (status, again) = s
        .post(
            &format!("/_telium/v1/channels/{tid}/messages"),
            Some(&bob.token),
            json!({ "content": "and again" }),
        )
        .await;
    assert_eq!(status, 200, "{again}");
    let seen = wait_for(&mut alices, "THREAD_UPDATE").await;
    assert_eq!(seen["d"]["message_count"], 2, "{seen}");
}

#[tokio::test]
async fn a_thread_that_archives_itself_drops_off_everyone_elses_sidebar() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    let (status, thread) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/threads"),
            Some(&alice.token),
            json!({ "title": "ship it" }),
        )
        .await;
    assert_eq!(status, 200, "{thread}");
    let tid = thread["id"].as_str().unwrap().to_string();

    sqlx::query("UPDATE threads SET last_active = 0 WHERE id = ?")
        .bind(&tid)
        .execute(&s.state.pool)
        .await
        .unwrap();

    let mut bobs = connect_watching(&s, &bob.token, &["GUILD_STRUCTURE", "GUILD_MESSAGES"]).await;
    let swept = telium_server::routes::social::archive_idle_threads(&s.state).await.unwrap();
    assert_eq!(swept, 1, "the sweep did not archive the idle thread");

    let seen = wait_for(&mut bobs, "THREAD_UPDATE").await;
    assert_eq!(seen["d"]["id"], tid.as_str(), "{seen}");
    assert_eq!(seen["d"]["archived"], true, "the archiving is the news: {seen}");
    assert_eq!(seen["d"]["parent_id"], cid.as_str(), "{seen}");
    assert_eq!(seen["d"]["guild_id"], gid.as_str(), "{seen}");

    let swept = telium_server::routes::social::archive_idle_threads(&s.state).await.unwrap();
    assert_eq!(swept, 0, "the same thread archived twice");
    let (status, msg) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": "unrelated" }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    let next = next_frame(&mut bobs).await;
    assert_eq!(next["t"], "MESSAGE_CREATE", "the idle sweep spoke twice: {next}");
    assert_eq!(next["d"]["content"], "unrelated", "{next}");
}

#[tokio::test]
async fn putting_down_a_moved_guilds_signpost_is_heard_on_the_other_devices() {
    let (s, alice, bob, gid, _cid) = social_fixture().await;

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'g-elsewhere', '{}', 1)",
    )
    .bind(&gid)
    .execute(&s.state.pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM guilds WHERE id = ?")
        .bind(&gid)
        .execute(&s.state.pool)
        .await
        .unwrap();

    let mut elsewhere = connect_watching(&s, &bob.token, &["GUILD_MEMBERS"]).await;

    let (status, left) =
        s.post(&format!("/_telium/v1/guilds/{gid}/leave"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{left}");

    let seen = wait_for(&mut elsewhere, "MEMBER_REMOVE").await;
    assert_eq!(seen["d"]["user_id"], bob.user_id.as_str(), "{seen}");
    assert_eq!(seen["d"]["guild_id"], gid.as_str(), "{seen}");

    let (status, mine) = s.get("/_telium/v1/guilds", Some(&alice.token)).await;
    assert_eq!(status, 200, "{mine}");
    assert!(
        mine["guilds"].as_array().unwrap().iter().any(|g| g["id"] == gid.as_str()),
        "leaving took the signpost down for everybody else: {mine}"
    );
    let left_over: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(&gid)
            .bind(&bob.user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(left_over, 0, "the membership row outlived the leave");
}

#[tokio::test]
async fn deciding_an_applicant_takes_the_card_off_the_other_moderators_queue() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let carol = s.user("carol").await;
    let dave = s.user("dave").await;
    let erin = s.user("erin").await;
    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();

    let (status, joined) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&carol.token), json!({})).await;
    assert_eq!(status, 200, "{joined}");
    let (_, role) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&alice.token),
            json!({ "name": "Mods", "permissions": ["KICK_MEMBERS"] }),
        )
        .await;
    let rid = role["id"].as_str().unwrap().to_string();
    let (status, promoted) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", carol.user_id),
            &alice.token,
            json!({ "add_roles": [rid] }),
        )
        .await;
    assert_eq!(status, 200, "{promoted}");
    let (status, gates) = s
        .put(
            &format!("/_telium/v1/guilds/{gid}/gates"),
            &alice.token,
            json!({ "screening": ["why do you want to join?"] }),
        )
        .await;
    assert_eq!(status, 200, "{gates}");

    let mut carols = connect_watching(&s, &carol.token, &["GUILD_MEMBERS"]).await;

    let (status, pending) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{pending}");
    assert_eq!(pending["pending"], true, "{pending}");
    let (status, applied) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/screening"),
            Some(&bob.token),
            json!({ "answers": ["I like the topic"] }),
        )
        .await;
    assert_eq!(status, 200, "{applied}");
    assert_eq!(applied["state"], "pending", "{applied}");

    let arrived = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert_eq!(arrived["d"]["guild_id"], gid.as_str(), "{arrived}");
    assert!(arrived["d"]["removed"].is_null(), "{arrived}");
    assert!(arrived["d"]["user_id"].is_null(), "the applicant was named to the guild: {arrived}");
    assert!(arrived["d"]["answers"].is_null(), "{arrived}");

    let (status, decided) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/applicants/{}", bob.user_id),
            Some(&alice.token),
            json!({ "decision": "approve" }),
        )
        .await;
    assert_eq!(status, 200, "{decided}");
    let settled = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert_eq!(settled["d"]["guild_id"], gid.as_str(), "{settled}");
    assert_eq!(settled["d"]["removed"], true, "{settled}");
    assert!(settled["d"]["decision"].is_null(), "{settled}");
    assert!(settled["d"]["user_id"].is_null(), "{settled}");

    let (status, late) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/applicants/{}", bob.user_id),
            Some(&carol.token),
            json!({ "decision": "reject" }),
        )
        .await;
    assert_eq!(status, 404, "{late}");

    let (status, pending) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&dave.token), json!({})).await;
    assert_eq!(status, 200, "{pending}");
    let (status, applied) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/screening"),
            Some(&dave.token),
            json!({ "answers": ["me too"] }),
        )
        .await;
    assert_eq!(status, 200, "{applied}");
    let next = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert!(next["d"]["removed"].is_null(), "the empty decision spoke: {next}");

    let (status, pending) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&erin.token), json!({})).await;
    assert_eq!(status, 200, "{pending}");
    let (status, applied) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/screening"),
            Some(&erin.token),
            json!({ "answers": ["and me"] }),
        )
        .await;
    assert_eq!(status, 200, "{applied}");
    let next = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert!(next["d"]["removed"].is_null(), "{next}");

    let (status, ruled) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/applicants/{}", dave.user_id),
            Some(&alice.token),
            json!({ "decision": "reject" }),
        )
        .await;
    assert_eq!(status, 200, "{ruled}");
    let settled = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert_eq!(settled["d"]["removed"], true, "{settled}");

    let (status, again) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/screening"),
            Some(&dave.token),
            json!({ "answers": ["please"] }),
        )
        .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["state"], "rejected", "a declined application came back pending: {again}");
    let (_, applicants) =
        s.get(&format!("/_telium/v1/guilds/{gid}/applicants"), Some(&alice.token)).await;
    let waiting: Vec<&str> = applicants["applicants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["user_id"].as_str().unwrap())
        .collect();
    assert_eq!(waiting, [erin.user_id.as_str()], "a declined applicant is back on the queue");

    let (status, ruled) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/applicants/{}", erin.user_id),
            Some(&alice.token),
            json!({ "decision": "approve" }),
        )
        .await;
    assert_eq!(status, 200, "{ruled}");
    let settled = wait_for(&mut carols, "GUILD_APPLICANT").await;
    assert_eq!(settled["d"]["removed"], true, "a declined re-application spoke: {settled}");
}
