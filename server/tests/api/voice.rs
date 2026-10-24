use super::*;

async fn voice_here(s: &Server, cid: &str, token: &str) -> Vec<String> {
    let (_, body) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(token)).await;
    body["voice_states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["user_id"].as_str().unwrap().to_string())
        .collect()
}

async fn settles_to(s: &Server, cid: &str, token: &str, who: &[&str]) {
    for _ in 0..50 {
        let here = voice_here(s, cid, token).await;
        if here == who {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("voice states never settled to {who:?}, still {:?}", voice_here(s, cid, token).await);
}

async fn voice_fixture() -> (Server, User, User, String, String) {
    let s = start_with(|cfg| {
        cfg.voice.regions = vec![
            telium_server::config::VoiceRegion {
                name: "us-east".into(),
                sfu: "https://sfu1.example".into(),
                turn: Some("turn.example:3478".into()),
                pubkey_hint: None,
            },
            telium_server::config::VoiceRegion {
                name: "eu".into(),
                sfu: "https://sfu2.example".into(),
                turn: None,
                pubkey_hint: None,
            },
        ];
        cfg.voice.default_region = "us-east".into();
        cfg.voice.stun_servers = vec!["stun:stun.example:3478".into()];
        cfg.voice.turn_secret = Some("shared-with-the-turn-server".into());
        cfg.voice.max_streamers_per_channel = 1;
    })
    .await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (status, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "General", "type": "voice", "voice_region": "eu", "bitrate": 96_000 }),
        )
        .await;
    assert_eq!(status, 200, "{ch}");
    let cid = ch["id"].as_str().unwrap().to_string();
    (s, alice, bob, gid, cid)
}

#[tokio::test]
async fn ready_includes_members_who_were_already_in_voice() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let (status, joined) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/join"),
            Some(&bob.token),
            json!({"key_package": "pkg"}),
        )
        .await;
    assert_eq!(status, 200, "{joined}");

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(
        json!({
            "op": "IDENTIFY",
            "d": { "token": alice.token, "intents": ["GUILD_VOICE_STATES"] }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let ready = next_frame(&mut ws).await;
    assert_eq!(ready["op"], "READY");
    let guild = ready["d"]["guilds"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == gid)
        .expect("joined guild is in READY");
    let voice = guild["voice_states"].as_array().expect("READY carries voice states");
    assert!(
        voice.iter().any(|state| {
            state["user_id"] == bob.user_id.as_str() && state["channel_id"] == cid.as_str()
        }),
        "a member already in voice must be visible before a later state update: {ready}",
    );
}

#[tokio::test]
async fn move_members_moves_live_voice_state_to_the_destination() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let (_, destination) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Other room", "type": "voice" }),
        )
        .await;
    let destination = destination["id"].as_str().unwrap().to_string();

    s.post(
        &format!("/_telium/v1/channels/{cid}/voice/join"),
        Some(&bob.token),
        json!({"key_package": "pkg"}),
    )
    .await;

    let (status, refused) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/{}", bob.user_id),
            Some(&bob.token),
            json!({ "channel_id": destination }),
        )
        .await;
    assert_eq!(status, 403, "{refused}");
    assert_eq!(voice_here(&s, &cid, &alice.token).await, vec![bob.user_id.clone()]);

    let (status, moved) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/{}", bob.user_id),
            Some(&alice.token),
            json!({ "channel_id": destination }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["moved_to"], destination);
    assert!(voice_here(&s, &cid, &alice.token).await.is_empty());
    assert_eq!(
        voice_here(&s, &destination, &alice.token).await,
        vec![bob.user_id.clone()],
    );
}

#[tokio::test]
async fn guild_owner_can_register_a_custom_sfu_region() {
    let (s, alice, bob, gid, _cid) = voice_fixture().await;

    let (status, _err) = s
        .post(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&bob.token), json!({
            "name": "bobs", "sfu": "https://bob.sfu"
        }))
        .await;
    assert_eq!(status, 403, "only Manage Server may add regions");

    let (status, added) = s
        .post(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&alice.token), json!({
            "name": "mine", "sfu": "https://my.sfu", "set_default": true
        }))
        .await;
    assert_eq!(status, 200, "{added:?}");

    let (status, list) = s
        .get(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&bob.token))
        .await;
    assert_eq!(status, 200, "{list:?}");
    assert_eq!(list["guild_default"], "mine");
    let names: Vec<&str> = list["regions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"mine"), "custom region should be listed: {names:?}");

    let (status, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Custom", "type": "voice", "voice_region": "mine"
        }))
        .await;
    assert_eq!(status, 200, "{ch:?}");
    let custom_cid = ch["id"].as_str().unwrap().to_string();
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{custom_cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["mode"], "sfu");
    assert_eq!(join["voice_server"]["endpoint"], "https://my.sfu");
    assert_eq!(join["voice_server"]["region"], "mine");

    let (status, refused) = s
        .delete(&format!("/_telium/v1/guilds/{gid}/voice/regions/mine"), &alice.token)
        .await;
    assert_eq!(status, 409, "{refused:?}");

    let (status, def) = s
        .patch(&format!("/_telium/v1/guilds/{gid}/voice/regions/default"), &alice.token, json!({
            "name": "mine"
        }))
        .await;
    assert_eq!(status, 200, "{def:?}");
    let (status, gone) = s
        .delete(&format!("/_telium/v1/channels/{custom_cid}"), &alice.token)
        .await;
    assert_eq!(status, 200, "{gone:?}");
    let (status, del) = s
        .delete(&format!("/_telium/v1/guilds/{gid}/voice/regions/mine"), &alice.token)
        .await;
    assert_eq!(status, 200, "{del:?}");
}

#[tokio::test]
async fn closing_the_last_connection_ends_the_call_it_was_holding() {
    let s = start_with(|cfg| cfg.voice.reconnect_grace_secs = 0).await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    let (_, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Lounge", "type": "voice"
        }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let mut watcher = connect_watching(&s, &bob.token, &["GUILD_VOICE_STATES"]).await;
    let mut alices_tab = connect_watching(&s, &alice.token, &["GUILD_VOICE_STATES"]).await;
    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200);
    assert_eq!(voice_here(&s, &cid, &bob.token).await, vec![alice.user_id.clone()]);
    assert_eq!(wait_for(&mut watcher, "VOICE_STATE_UPDATE").await["d"]["channel_id"], cid);

    alices_tab.close(None).await.unwrap();
    drop(alices_tab);

    settles_to(&s, &cid, &bob.token, &[]).await;
    let gone = wait_for(&mut watcher, "VOICE_STATE_UPDATE").await;
    assert_eq!(gone["d"]["user_id"], alice.user_id);
    assert!(gone["d"]["channel_id"].is_null(), "{gone}");
}

#[tokio::test]
async fn a_second_tab_keeps_the_call_the_first_one_closed() {
    let s = start_with(|cfg| cfg.voice.reconnect_grace_secs = 0).await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Lounge", "type": "voice"
        }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let first = connect_watching(&s, &alice.token, &["GUILD_VOICE_STATES"]).await;
    let second = connect_watching(&s, &alice.token, &["GUILD_VOICE_STATES"]).await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"})).await;

    drop(first);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(
        voice_here(&s, &cid, &alice.token).await,
        vec![alice.user_id.clone()],
        "one tab closing took the call with it",
    );

    drop(second);
    settles_to(&s, &cid, &alice.token, &[]).await;
}

async fn connect_claiming(s: &Server, token: &str, voice: Value) -> (Ws, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "HELLO");
    ws.send(Message::Text(
        json!({
            "op": "IDENTIFY",
            "d": { "token": token, "intents": ["GUILD_VOICE_STATES"], "voice": voice }
        })
        .to_string(),
    ))
    .await
    .unwrap();
    let ready = next_frame(&mut ws).await;
    assert_eq!(ready["op"], "READY", "{ready}");
    (ws, ready)
}

async fn deadline_on(s: &Server, gid: &str, user_id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT reclaim_until FROM voice_states WHERE guild_id = ? AND user_id = ?")
        .bind(gid)
        .bind(user_id)
        .fetch_optional(&s.state.pool)
        .await
        .unwrap()
        .flatten()
}

async fn stays_quiet(ws: &mut Ws, t: &str) {
    loop {
        match tokio::time::timeout(std::time::Duration::from_millis(400), ws.next()).await {
            Err(_) => return,
            Ok(Some(Ok(Message::Text(text)))) => {
                let frame: Value = serde_json::from_str(&text).unwrap();
                assert_ne!(frame["t"], t, "the room was told about something that did not happen");
            }
            Ok(_) => return,
        }
    }
}

async fn join_voice(s: &Server, cid: &str, token: &str) -> Value {
    let (status, joined) =
        s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(token), json!({"key_package": "pkg"})).await;
    assert_eq!(status, 200, "{joined}");
    joined
}

#[tokio::test]
async fn a_call_survives_a_restart_the_device_comes_back_from() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let mut watching = connect_watching(&s, &bob.token, &["GUILD_VOICE_STATES"]).await;
    let joined = join_voice(&s, &cid, &alice.token).await;
    let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();
    wait_for(&mut watching, "VOICE_STATE_UPDATE").await;

    let (expired, unclaimed) =
        telium_server::routes::voice::mark_unclaimed(&s.state.pool, 60).await.unwrap();
    assert_eq!((expired, unclaimed), (0, 1));
    assert!(deadline_on(&s, &gid, &alice.user_id).await.is_some());
    assert_eq!(
        voice_here(&s, &cid, &bob.token).await,
        vec![alice.user_id.clone()],
        "an unclaimed state is still in the room; it is on notice, not gone",
    );

    let (_ws, ready) = connect_claiming(
        &s,
        &alice.token,
        json!([{ "room_id": gid, "session_id": session }]),
    )
    .await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([gid.clone()]));
    assert_eq!(deadline_on(&s, &gid, &alice.user_id).await, None, "the deadline is lifted");

    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&s.state).await, 0);
    assert_eq!(voice_here(&s, &cid, &bob.token).await, vec![alice.user_id.clone()]);
    stays_quiet(&mut watching, "VOICE_STATE_UPDATE").await;
}

#[tokio::test]
async fn a_call_nobody_comes_back_for_is_swept_and_the_room_is_told() {
    let (s, alice, bob, _gid, cid) = voice_fixture().await;
    let mut watching = connect_watching(&s, &bob.token, &["GUILD_VOICE_STATES"]).await;
    join_voice(&s, &cid, &alice.token).await;
    wait_for(&mut watching, "VOICE_STATE_UPDATE").await;

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 0).await.unwrap();
    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&s.state).await, 1);

    let gone = wait_for(&mut watching, "VOICE_STATE_UPDATE").await;
    assert_eq!(gone["d"]["user_id"], alice.user_id.as_str());
    assert!(gone["d"]["channel_id"].is_null(), "{gone}");
    assert!(voice_here(&s, &cid, &bob.token).await.is_empty());
}

#[tokio::test]
async fn a_device_that_comes_back_too_late_finds_its_seat_gone() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let joined = join_voice(&s, &cid, &alice.token).await;
    let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 0).await.unwrap();
    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&s.state).await, 1);

    let (_ws, ready) =
        connect_claiming(&s, &alice.token, json!([{ "room_id": gid, "session_id": session }])).await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([]));
    assert!(voice_here(&s, &cid, &bob.token).await.is_empty());
}

#[tokio::test]
async fn a_second_restart_inside_the_window_does_not_extend_it() {
    let (s, alice, _bob, gid, cid) = voice_fixture().await;
    join_voice(&s, &cid, &alice.token).await;

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 3600).await.unwrap();
    let first = deadline_on(&s, &gid, &alice.user_id).await.expect("a deadline was written");

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let (expired, unclaimed) =
        telium_server::routes::voice::mark_unclaimed(&s.state.pool, 3600).await.unwrap();
    assert_eq!((expired, unclaimed), (0, 0), "an already-unclaimed state is not re-marked");
    assert_eq!(deadline_on(&s, &gid, &alice.user_id).await, Some(first));
}

#[tokio::test]
async fn a_process_that_dies_during_the_grace_window_sweeps_on_the_way_up() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    join_voice(&s, &cid, &alice.token).await;

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 0).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let (expired, unclaimed) =
        telium_server::routes::voice::mark_unclaimed(&s.state.pool, 60).await.unwrap();
    assert_eq!((expired, unclaimed), (1, 0));
    assert!(voice_here(&s, &cid, &bob.token).await.is_empty());
    assert_eq!(deadline_on(&s, &gid, &alice.user_id).await, None);
}

#[tokio::test]
async fn leaving_while_the_server_is_away_is_not_undone_by_coming_back() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let joined = join_voice(&s, &cid, &alice.token).await;
    let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 60).await.unwrap();
    let (status, _) =
        s.post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&alice.token), json!({}))
            .await;
    assert_eq!(status, 200);

    let (_ws, ready) =
        connect_claiming(&s, &alice.token, json!([{ "room_id": gid, "session_id": session }])).await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([]), "a claim cannot revive a call that ended");
    assert!(voice_here(&s, &cid, &bob.token).await.is_empty());
}

#[tokio::test]
async fn a_claim_that_cannot_name_the_session_takes_nothing_back() {
    let (s, alice, _bob, gid, cid) = voice_fixture().await;
    let joined = join_voice(&s, &cid, &alice.token).await;
    let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();
    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 60).await.unwrap();

    let (_a, ready) = connect_claiming(
        &s,
        &alice.token,
        json!([
            { "room_id": gid, "session_id": "01ANOTHERSESSIONENTIRELY" },
            { "room_id": "a-room-we-are-not-in", "session_id": session },
            { "room_id": gid },
        ]),
    )
    .await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([]));
    assert!(deadline_on(&s, &gid, &alice.user_id).await.is_some(), "the deadline still stands");
}

#[tokio::test]
async fn one_device_coming_back_does_not_speak_for_the_one_that_did_not() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    let joined = join_voice(&s, &cid, &alice.token).await;
    let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();
    join_voice(&s, &cid, &bob.token).await;

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 0).await.unwrap();
    let (_ws, ready) =
        connect_claiming(&s, &alice.token, json!([{ "room_id": gid, "session_id": session }])).await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([gid.clone()]));

    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&s.state).await, 1);
    assert_eq!(
        voice_here(&s, &cid, &alice.token).await,
        vec![alice.user_id.clone()],
        "the one who came back kept her seat and the one who did not lost his",
    );
}

#[tokio::test]
async fn a_screen_being_watched_comes_back_with_the_people_watching_it() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    join_voice(&s, &cid, &alice.token).await;
    let bobs = join_voice(&s, &cid, &bob.token).await;
    let bob_session = bobs["voice_state"]["session_id"].as_str().unwrap().to_string();
    let (status, live) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/stream"),
            Some(&alice.token),
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(status, 200, "{live}");
    let (status, watching) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/watch"),
            Some(&bob.token),
            json!({ "streamer": alice.user_id, "quality": "high" }),
        )
        .await;
    assert_eq!(status, 200, "{watching}");

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 60).await.unwrap();
    let watcher_deadline = || async {
        sqlx::query_scalar::<_, Option<i64>>(
            "SELECT reclaim_until FROM voice_watchers WHERE viewer = ?",
        )
        .bind(&bob.user_id)
        .fetch_one(&s.state.pool)
        .await
        .unwrap()
    };
    assert!(watcher_deadline().await.is_some());

    let (_ws, ready) = connect_claiming(
        &s,
        &bob.token,
        json!([{ "room_id": gid, "session_id": bob_session }]),
    )
    .await;
    assert_eq!(ready["d"]["voice_reclaimed"], json!([gid.clone()]));
    assert_eq!(watcher_deadline().await, None, "the watch came back with the watcher");
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
    assert_eq!(states["watchers"][0]["viewer"], bob.user_id.as_str());

    telium_server::routes::voice::mark_unclaimed(&s.state.pool, 0).await.unwrap();
    telium_server::routes::voice::sweep_unclaimed(&s.state).await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_watchers")
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_voice_channel_carries_text_beside_the_call() {
    let (s, alice, _bob, gid, cid) = voice_fixture().await;

    let (status, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({
            "content": "here is the thing I am talking about"
        }))
        .await;
    assert_eq!(status, 200, "{msg}");

    let (status, body) =
        s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert_eq!(status, 200);
    assert_eq!(body["messages"][0]["content"], "here is the thing I am talking about");

    let (_, cat) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Rooms", "type": "category"
        }))
        .await;
    let cat_id = cat["id"].as_str().unwrap();
    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cat_id}/messages"), Some(&alice.token), json!({
            "content": "hello?"
        }))
        .await;
    assert_eq!(status, 400, "a category has no history to post into");
}

#[tokio::test]
async fn a_voice_channel_carries_a_status_set_by_the_people_in_it() {
    let (s, alice, bob, _gid, cid) = voice_fixture().await;

    async fn put_status(s: &Server, cid: &str, token: &str, body: Value) -> (u16, Value) {
        let resp = s
            .client
            .put(format!("{}/_telium/v1/channels/{cid}/voice-status", s.base))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = resp.status().as_u16();
        (status, resp.json().await.unwrap_or(json!(null)))
    }

    let (status, out) = put_status(&s, &cid, &bob.token, json!({ "status": "Lobby 2 — ranked grind" })).await;
    assert_eq!(status, 200, "{out}");
    assert_eq!(out["voice_status"], "Lobby 2 — ranked grind");
    assert_eq!(out["voice_status_author"], bob.user_id.as_str());
    assert!(out["voice_status_at"].as_i64().unwrap() > 0);

    let (_, list) = s.get(&format!("/_telium/v1/guilds/{}/channels", out["guild_id"].as_str().unwrap()), Some(&alice.token)).await;
    let row = list["channels"].as_array().unwrap().iter().find(|c| c["id"] == cid).unwrap();
    assert_eq!(row["voice_status"], "Lobby 2 — ranked grind");

    let long = "x".repeat(141);
    let (status, _) = put_status(&s, &cid, &bob.token, json!({ "status": long })).await;
    assert_eq!(status, 400);

    let (_, text) = s
        .post(
            &format!("/_telium/v1/guilds/{}/channels", out["guild_id"].as_str().unwrap()),
            Some(&alice.token),
            json!({ "name": "chat", "type": "text" }),
        )
        .await;
    let tid = text["id"].as_str().unwrap();
    let (status, _) = put_status(&s, tid, &alice.token, json!({ "status": "hello" })).await;
    assert_eq!(status, 400);

    let (status, out) = put_status(&s, &cid, &bob.token, json!({ "status": "" })).await;
    assert_eq!(status, 200, "{out}");
    assert!(out["voice_status"].is_null());
    assert!(out["voice_status_author"].is_null());
    assert!(out["voice_status_at"].is_null());
}

#[tokio::test]
async fn joining_voice_mints_a_token_the_sfu_can_check_without_knowing_the_guild() {
    let (s, alice, _bob, gid, cid) = voice_fixture().await;

    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    let server = &join["voice_server"];
    assert_eq!(server["mode"], "sfu");
    assert_eq!(server["region"], "eu", "the channel picked its own region");
    assert_eq!(server["endpoint"], "https://sfu2.example");
    assert_eq!(server["max_bitrate"], 96_000, "the channel may spend less than the ceiling");

    let raw = server["token"].as_str().unwrap();
    let decoded = telium_server::util::unb64(raw).expect("token is base64");
    let claims: Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(claims["kind"], "sfu_join");
    assert_eq!(claims["user_id"], alice.user_id.as_str());
    assert_eq!(claims["channel"], cid.as_str());
    assert_eq!(claims["flags"]["speak"], true);
    assert_eq!(claims["flags"]["stream"], true);
    assert_eq!(
        claims["max_bitrate"], server["max_bitrate"],
        "the cap the client is told is the cap the SFU is told"
    );
    assert!(claims["expires_at"].as_i64().unwrap() > claims["issued_at"].as_i64().unwrap());
    assert!(claims["guild"].is_string());
    assert!(claims.get("roles").is_none(), "the SFU never needs to understand roles");

    let (_, keys) = s.get("/_telium/v1/keys", None).await;
    let key_id = claims["key_id"].as_str().unwrap();
    let public = keys["verify_keys"][key_id]["key"]
        .as_str()
        .expect("the token is signed by a published key")
        .to_string();
    assert!(
        telium_server::crypto::verify_json(&public, &claims),
        "an SFU can verify the join token with nothing but our public keys"
    );

    let ice = server["ice_servers"].as_array().unwrap();
    assert_eq!(ice.len(), 1, "this region has no TURN endpoint configured");
    assert_eq!(ice[0]["urls"][0], "stun:stun.example:3478");
    assert!(ice[0].get("username").is_none(), "STUN is asked, not authenticated");

    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&alice.token)).await;
    assert_eq!(states["voice_states"].as_array().unwrap().len(), 1);
    assert_eq!(states["voice_states"][0]["user_id"], alice.user_id.as_str());

    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200);
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&alice.token)).await;
    assert!(states["voice_states"].as_array().unwrap().is_empty());
    let _ = gid;
}

#[tokio::test]
async fn a_server_mute_survives_a_reconnect_and_rides_in_the_token() {
    let (s, alice, bob, gid, cid) = voice_fixture().await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&bob.token), json!({"key_package": "pkg"})).await;

    let (status, refused) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/{}", alice.user_id),
            Some(&bob.token),
            json!({ "mute": true }),
        )
        .await;
    assert_eq!(status, 403, "{refused}");

    let (status, muted) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/{}", bob.user_id),
            Some(&alice.token),
            json!({ "mute": true }),
        )
        .await;
    assert_eq!(status, 200, "{muted}");

    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
    assert_eq!(states["voice_states"][0]["server_mute"], true);

    let (_, rejoined) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&bob.token), json!({"key_package": "pkg"}))
        .await;
    let decoded = telium_server::util::unb64(rejoined["voice_server"]["token"].as_str().unwrap()).unwrap();
    let claims: Value = serde_json::from_slice(&decoded).unwrap();
    assert_eq!(claims["flags"]["speak"], false, "a mute one reconnect from meaningless is not a mute");
    assert_eq!(rejoined["voice_state"]["server_mute"], true);

    let (status, kicked) =
        s.delete(&format!("/_telium/v1/guilds/{gid}/members/{}", bob.user_id), &alice.token).await;
    assert_eq!(status, 200, "{kicked}");
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&alice.token)).await;
    assert!(states["voice_states"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_channel_without_its_own_bitrate_is_capped_at_the_configured_ceiling() {
    let s = start_with(|cfg| {
        cfg.voice.regions = vec![telium_server::config::VoiceRegion {
            name: "us-east".into(),
            sfu: "https://sfu1.example".into(),
            turn: None,
            pubkey_hint: None,
        }];
        cfg.voice.default_region = "us-east".into();
        cfg.voice.max_bitrate = 1_500_000;
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let (status, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Voice", "type": "voice" }),
        )
        .await;
    assert_eq!(status, 200, "{ch}");
    let cid = ch["id"].as_str().unwrap().to_string();

    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    let server = &join["voice_server"];
    assert_eq!(server["max_bitrate"], 1_500_000);
    let raw = server["token"].as_str().unwrap();
    let claims: Value =
        serde_json::from_slice(&telium_server::util::unb64(raw).expect("token is base64")).unwrap();
    assert_eq!(claims["max_bitrate"], 1_500_000, "the signed token carries the configured ceiling");

    let (status, greedy) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Greedy", "type": "voice", "bitrate": 9_000_000 }),
        )
        .await;
    assert_eq!(status, 200, "{greedy}");
    let greedy_id = greedy["id"].as_str().unwrap().to_string();
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{greedy_id}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    let raw = join["voice_server"]["token"].as_str().unwrap();
    let claims: Value =
        serde_json::from_slice(&telium_server::util::unb64(raw).expect("token is base64")).unwrap();
    assert_eq!(claims["max_bitrate"], 1_500_000);
    assert_eq!(join["voice_server"]["max_bitrate"], 1_500_000);
}

#[tokio::test]
async fn watch_quality_is_a_closed_vocabulary() {
    let (s, alice, bob, _gid, cid) = voice_fixture().await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"})).await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&bob.token), json!({"key_package": "pkg"})).await;
    let (status, live) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/stream"),
            Some(&alice.token),
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(status, 200, "{live}");

    let (status, refused) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/watch"),
            Some(&bob.token),
            json!({ "streamer": alice.user_id, "quality": "motion" }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
    assert!(states["watchers"].as_array().unwrap().is_empty(), "a refused watch is not recorded");

    for quality in ["auto", "low", "medium", "high"] {
        let (status, watching) = s
            .post(
                &format!("/_telium/v1/channels/{cid}/voice/watch"),
                Some(&bob.token),
                json!({ "streamer": alice.user_id, "quality": quality }),
            )
            .await;
        assert_eq!(status, 200, "{quality}: {watching}");
        assert_eq!(watching["quality"], quality);
        let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
        assert_eq!(states["watchers"][0]["quality"], quality, "the picker round-trips");
    }

    let (status, watching) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/watch"),
            Some(&bob.token),
            json!({ "streamer": alice.user_id }),
        )
        .await;
    assert_eq!(status, 200, "{watching}");
    assert_eq!(watching["quality"], "auto");
}

#[tokio::test]
async fn watching_a_stream_is_an_explicit_subscription_and_streamers_are_capped() {
    let (s, alice, bob, _gid, cid) = voice_fixture().await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"})).await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&bob.token), json!({"key_package": "pkg"})).await;

    let (status, refused) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/watch"),
            Some(&bob.token),
            json!({ "streamer": alice.user_id }),
        )
        .await;
    assert_eq!(status, 404, "{refused}");

    let (status, live) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/stream"),
            Some(&alice.token),
            json!({ "enabled": true, "preset": "detail" }),
        )
        .await;
    assert_eq!(status, 200, "{live}");
    assert_eq!(live["voice_state"]["streaming"], true);
    assert_eq!(live["voice_state"]["stream_preset"], "detail");

    let (status, capped) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/stream"),
            Some(&bob.token),
            json!({ "enabled": true }),
        )
        .await;
    assert_eq!(status, 409, "{capped}");

    let (status, watching) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/watch"),
            Some(&bob.token),
            json!({ "streamer": alice.user_id, "quality": "low" }),
        )
        .await;
    assert_eq!(status, 200, "{watching}");
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
    assert_eq!(states["watchers"].as_array().unwrap().len(), 1);
    assert_eq!(states["watchers"][0]["quality"], "low");

    s.post(
        &format!("/_telium/v1/channels/{cid}/voice/stream"),
        Some(&alice.token),
        json!({ "enabled": false }),
    )
    .await;
    let (_, states) = s.get(&format!("/_telium/v1/channels/{cid}/voice"), Some(&bob.token)).await;
    assert!(states["watchers"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_server_with_no_sfu_falls_back_to_mesh_rather_than_pretending() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Voice", "type": "voice" }),
        )
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    assert_eq!(join["voice_server"]["mode"], "mesh");
    assert_eq!(join["voice_server"]["max_participants"], 4);
    let ice = join["voice_server"]["ice_servers"].as_array().unwrap();
    let stun = ice[0]["urls"][0].as_str().unwrap();
    assert!(stun.starts_with("stun:"), "a mesh call is still told where to ask for its own address");

    let (status, refused) = s
        .patch(&format!("/_telium/v1/channels/{cid}"), &alice.token, json!({ "voice_region": "atlantis" }))
        .await;
    assert_eq!(status, 400, "{refused}");
}

#[tokio::test]
async fn a_region_with_no_address_yields_mesh_rather_than_an_sfu_at_nowhere() {
    let s = start_with(|cfg| {
        cfg.voice.regions = vec![telium_server::config::VoiceRegion::default()];
        cfg.voice.default_region = "local".into();
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Voice", "type": "voice" }),
        )
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    let server = &join["voice_server"];
    assert_eq!(server["mode"], "mesh", "a named region with no address is not an SFU: {join}");
    assert!(server["endpoint"].is_null(), "nothing to dial, so nothing is offered: {join}");
    assert!(server["region"].is_null(), "and no region name to show for it: {join}");
}

#[tokio::test]
async fn a_mesh_call_is_offered_this_server_s_own_relay() {
    let s = start_with(|cfg| {
        cfg.voice.turn = Some("turn.test.example:3478".into());
        cfg.voice.turn_secret = Some("shared-secret".into());
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Voice", "type": "voice" }),
        )
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"}))
        .await;
    assert_eq!(status, 200, "{join}");
    let server = &join["voice_server"];
    assert_eq!(server["mode"], "mesh");
    assert_eq!(server["relay"], true, "a mesh call says whether it has a relay");

    let ice = server["ice_servers"].as_array().unwrap();
    let relay = ice
        .iter()
        .find(|e| {
            e["urls"].as_array().is_some_and(|u| {
                u.iter().any(|s| s.as_str().is_some_and(|s| s.starts_with("turn:")))
            })
        })
        .expect("the configured relay is handed to a mesh call");
    let username = relay["username"].as_str().unwrap();
    assert!(
        username.ends_with(&format!(":{}", alice.user_id)),
        "the TURN username carries an expiry and the user it was minted for, got {username:?}"
    );
    assert!(!relay["credential"].as_str().unwrap().is_empty());
    assert_ne!(relay["credential"], "shared-secret", "the shared secret never leaves the server");
}

#[tokio::test]
async fn a_mesh_signal_reaches_the_peer_it_names_and_nobody_else() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let carol = s.user("carol").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    let (_, ch) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({ "name": "Voice", "type": "voice" }),
        )
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _hello = next_frame(&mut ws).await;
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": bob.token, "intents": ["GUILD_VOICE_STATES"] } })
            .to_string(),
    ))
    .await
    .unwrap();
    let ready = next_frame(&mut ws).await;
    assert_eq!(ready["op"], "READY");

    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({"key_package": "pkg"})).await;
    s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&bob.token), json!({"key_package": "pkg"})).await;

    let (status, ok) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/signal"),
            Some(&alice.token),
            json!({ "target": bob.user_id, "payload": { "description": { "type": "offer", "sdp": "v=0" } } }),
        )
        .await;
    assert_eq!(status, 200, "{ok}");

    let relayed = wait_for(&mut ws, "VOICE_SIGNAL").await;
    assert_eq!(relayed["d"]["from"], alice.user_id.as_str());
    assert_eq!(relayed["d"]["channel_id"], cid.as_str());
    assert_eq!(relayed["d"]["payload"]["description"]["type"], "offer");

    let (status, refused) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/signal"),
            Some(&alice.token),
            json!({ "target": carol.user_id, "payload": { "candidate": {} } }),
        )
        .await;
    assert_eq!(status, 403, "{refused}");
}

#[tokio::test]
async fn a_guild_call_on_an_sfu_keeps_one_encryption_group() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let carol = s.user("carol").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    for who in [&bob, &carol] {
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&who.token), json!({})).await;
    }
    let (status, _) = s
        .post(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&alice.token), json!({
            "name": "mine", "sfu": "https://my.sfu", "set_default": true
        }))
        .await;
    assert_eq!(status, 200);
    let (_, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Lounge", "type": "voice", "voice_region": "mine"
        }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();
    let join = |token: String, package: Option<&'static str>| {
        let s = &s;
        let cid = cid.clone();
        async move {
            let body = match package {
                Some(p) => json!({ "key_package": p }),
                None => json!({}),
            };
            s.post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&token), body).await
        }
    };
    let e2ee = format!("/_telium/v1/channels/{cid}/voice/e2ee");

    let (status, refused) = join(alice.token.clone(), None).await;
    assert_eq!(status, 400, "{refused:?}");

    let (status, first) = join(alice.token.clone(), Some("pkg-alice")).await;
    assert_eq!(status, 200, "{first:?}");
    assert_eq!(first["voice_server"]["e2ee"], "required");
    assert_eq!(first["e2ee"]["member"], true);
    assert_eq!(first["e2ee"]["epoch"], 0);
    let group = first["e2ee"]["group_id"].as_str().unwrap().to_string();

    let (_, second) = join(bob.token.clone(), Some("pkg-bob")).await;
    assert_eq!(second["e2ee"]["member"], false);
    assert_eq!(second["e2ee"]["group_id"], group);
    let (status, _) = s
        .post(&e2ee, Some(&bob.token), json!({ "group_id": group, "epoch": 0, "commit": "c" }))
        .await;
    assert_eq!(status, 403, "a device outside the group wrote a commit");

    let (_, view) = s.get(&e2ee, Some(&alice.token)).await;
    let waiting: Vec<&Value> =
        view["participants"].as_array().unwrap().iter().filter(|p| p["member"] == false).collect();
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0]["key_package"], "pkg-bob");
    let add = json!({
        "group_id": group, "epoch": 0, "commit": "c1", "welcome": "w1",
        "added": [{ "user_id": bob.user_id, "key_package": "pkg-bob" }],
    });
    let (status, done) = s.post(&e2ee, Some(&alice.token), add.clone()).await;
    assert_eq!(status, 200, "{done:?}");
    assert_eq!(done["epoch"], 1);

    let (status, _) = s.post(&e2ee, Some(&alice.token), add).await;
    assert_eq!(status, 409);
    let (_, view) = s.get(&e2ee, Some(&bob.token)).await;
    assert_eq!(view["member"], true);
    assert_eq!(view["epoch"], 1);

    join(carol.token.clone(), Some("pkg-carol")).await;
    for who in [&alice, &bob] {
        s.post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&who.token), json!({})).await;
    }
    let (_, view) = s.get(&e2ee, Some(&carol.token)).await;
    assert_eq!(view["member"], true, "{view:?}");
    assert_eq!(view["epoch"], 0);
    assert_ne!(view["group_id"], group);
}

#[tokio::test]
async fn a_guild_call_keeps_its_commits_and_names_a_live_committer() {
    let s = start().await;
    let alice = s.user("log-alice").await;
    let mut people = Vec::new();
    for name in ["log-bob", "log-carol", "log-dave", "log-erin"] {
        people.push(s.user(name).await);
    }
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    for who in &people {
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&who.token), json!({})).await;
    }
    s.post(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&alice.token), json!({
        "name": "mine", "sfu": "https://my.sfu", "set_default": true
    }))
    .await;
    let (_, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({
            "name": "Lounge", "type": "voice", "voice_region": "mine"
        }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();
    let (bob, carol, dave, erin) = (&people[0], &people[1], &people[2], &people[3]);
    let join_path = format!("/_telium/v1/channels/{cid}/voice/join");
    let join = |token: &str, package: &str| {
        let body = json!({ "key_package": package });
        let token = token.to_string();
        let s = &s;
        let path = join_path.clone();
        async move { s.post(&path, Some(&token), body).await }
    };
    let e2ee = format!("/_telium/v1/channels/{cid}/voice/e2ee");
    let commits = |since: i64| format!("/_telium/v1/channels/{cid}/voice/e2ee/commits?since={since}");

    let (_, first) = join(&alice.token, "pkg-alice").await;
    let group = first["e2ee"]["group_id"].as_str().unwrap().to_string();
    join(&bob.token, "pkg-bob").await;
    let (_, view) = s.get(&e2ee, Some(&bob.token)).await;
    assert_eq!(view["committer"], alice.user_id.as_str(), "{view}");
    assert_eq!(view["standing"], "pending");

    let (status, _) = s.post(&e2ee, Some(&alice.token), json!({
        "group_id": group, "epoch": 0, "commit": "c1", "welcome": "w1",
        "added": [{ "user_id": bob.user_id, "key_package": "pkg-bob" }],
    })).await;
    assert_eq!(status, 200);
    join(&carol.token, "pkg-carol").await;
    let (status, _) = s.post(&e2ee, Some(&alice.token), json!({
        "group_id": group, "epoch": 1, "commit": "c2", "welcome": "w2",
        "added": [{ "user_id": carol.user_id, "key_package": "pkg-carol" }],
    })).await;
    assert_eq!(status, 200);

    let (status, log) = s.get(&commits(0), Some(&bob.token)).await;
    assert_eq!(status, 200, "{log}");
    let got: Vec<(i64, &str, &str)> = log["commits"].as_array().unwrap().iter()
        .map(|c| (c["epoch"].as_i64().unwrap(), c["commit"].as_str().unwrap(), c["welcome"].as_str().unwrap()))
        .collect();
    assert_eq!(got, vec![(1, "c1", "w1"), (2, "c2", "w2")]);
    assert_eq!(log["commits"][1]["added"], json!([carol.user_id]));
    assert_eq!(log["oldest"], 1);
    let (_, log) = s.get(&commits(1), Some(&bob.token)).await;
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);

    let (status, refused) = s.post(&e2ee, Some(&bob.token), json!({
        "group_id": group, "epoch": 2, "commit": "c3-bob",
    })).await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["code"], "not_committer");
    assert_eq!(refused["committer"], alice.user_id.as_str());

    join(&dave.token, "pkg-dave").await;
    let long_ago = telium_server::util::now_ms() - telium_server::routes::voice::COMMITTER_SILENT_MS - 1000;
    sqlx::query("UPDATE voice_states SET e2ee_offered_at = ? WHERE channel_id = ?")
        .bind(long_ago).bind(&cid).execute(&s.state.pool).await.unwrap();
    sqlx::query("UPDATE voice_e2ee_groups SET committer_at = ?, updated_at = ? WHERE channel_id = ?")
        .bind(long_ago).bind(long_ago).bind(&cid).execute(&s.state.pool).await.unwrap();
    let (_, view) = s.get(&e2ee, Some(&dave.token)).await;
    assert_eq!(view["committer"], bob.user_id.as_str(), "the next member takes over: {view}");
    let (status, _) = s.post(&e2ee, Some(&alice.token), json!({
        "group_id": group, "epoch": 2, "commit": "c3-alice",
    })).await;
    assert_eq!(status, 409, "the quiet one is no longer the committer");
    let (status, _) = s.post(&e2ee, Some(&bob.token), json!({
        "group_id": group, "epoch": 2, "commit": "c3", "welcome": "w3",
        "added": [{ "user_id": dave.user_id, "key_package": "pkg-dave" }],
    })).await;
    assert_eq!(status, 200);

    join(&erin.token, "pkg-not-a-package").await;
    let refuse = format!("/_telium/v1/channels/{cid}/voice/e2ee/refuse");
    let body = json!({ "user_id": erin.user_id, "key_package": "pkg-not-a-package" });
    let (status, _) = s.post(&refuse, Some(&carol.token), body.clone()).await;
    assert_eq!(status, 409);
    let (status, done) = s.post(&refuse, Some(&bob.token), body).await;
    assert_eq!(status, 200, "{done}");
    let (_, view) = s.get(&e2ee, Some(&erin.token)).await;
    assert_eq!(view["standing"], "refused", "{view}");

    s.post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&bob.token), json!({})).await;
    let (_, view) = s.get(&e2ee, Some(&carol.token)).await;
    assert_eq!(view["committer"], alice.user_id.as_str(), "{view}");

    for who in [&alice, carol, dave] {
        s.post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&who.token), json!({})).await;
    }
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM voice_e2ee_log WHERE channel_id = ?")
        .bind(&cid).fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(kept, 0);
}

#[tokio::test]
async fn a_guild_call_settles_its_group_when_everybody_arrives_or_leaves_at_once() {
    let s = start().await;
    let owner = s.user("settle-owner").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&owner.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&owner.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&owner.token), json!({
        "name": "mine", "sfu": "https://my.sfu", "set_default": true
    }))
    .await;
    let (_, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&owner.token), json!({
            "name": "Lounge", "type": "voice", "voice_region": "mine"
        }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();
    let mut people = vec![owner];
    for i in 0..7 {
        let who = s.user(&format!("settle-{i}")).await;
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&who.token), json!({})).await;
        people.push(who);
    }
    let all = |path: &'static str, who: Vec<String>| {
        let calls = who.into_iter().map(|token| {
            let client = s.client.clone();
            let url = format!("{}/_telium/v1/channels/{cid}/voice/{path}", s.base);
            async move {
                let body = json!({ "key_package": format!("pkg-{}", &token[..8]) });
                let resp = client.post(url).bearer_auth(token).json(&body).send().await.unwrap();
                (resp.status().as_u16(), resp.json::<Value>().await.unwrap_or(json!(null)))
            }
        });
        futures_util::future::join_all(calls)
    };
    let held = format!("SELECT COUNT(*) FROM voice_states WHERE channel_id = '{cid}' AND e2ee_member = 1");
    let members = || count(&s, &held);

    for round in 0..5 {
        let tokens: Vec<String> = people.iter().map(|p| p.token.clone()).collect();
        for (status, body) in all("join", tokens.clone()).await {
            assert_eq!(status, 200, "round {round}: {body}");
        }
        assert_eq!(members().await, 1, "round {round}: one founder, everyone else waiting");

        for (status, body) in all("leave", tokens[1..].to_vec()).await {
            assert_eq!(status, 200, "round {round}: {body}");
        }
        assert_eq!(members().await, 1, "round {round}: the one left holds the group");
        let (status, body) = all("leave", tokens[..1].to_vec()).await.remove(0);
        assert_eq!(status, 200, "round {round}: {body}");
    }
}
