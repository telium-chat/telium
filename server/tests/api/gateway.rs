use super::*;

#[tokio::test]
async fn gateway_delivers_messages_to_subscribed_members() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let hello = next_frame(&mut ws).await;
    assert_eq!(hello["op"], "HELLO");
    assert!(hello["d"]["heartbeat_interval_ms"].as_i64().unwrap() > 0);

    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": bob.token, "intents": ["GUILD_MESSAGES", "GUILD_MEMBERS"] } })
            .to_string(),
    ))
    .await
    .unwrap();

    let ready = next_frame(&mut ws).await;
    assert_eq!(ready["op"], "READY");
    assert_eq!(ready["d"]["guilds"][0]["id"], gid.as_str());
    assert_eq!(ready["d"]["user"]["user_id"], bob.user_id.as_str());

    s.post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "ping" }))
        .await;

    let dispatch = wait_for(&mut ws, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["d"]["content"], "ping");
    assert_eq!(dispatch["d"]["channel_id"], cid.as_str());
    assert!(dispatch["s"].as_i64().unwrap() >= 1);

    s.post(&format!("/_telium/v1/channels/{cid}/typing"), Some(&alice.token), json!({})).await;
    s.post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "second" }))
        .await;
    let next = wait_for(&mut ws, "MESSAGE_CREATE").await;
    assert_eq!(next["d"]["content"], "second", "an unrequested intent must not be delivered");
}

#[tokio::test]
async fn reply_message_dispatch_names_the_replied_to_author() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Replies" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, _) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200);

    let (_, channels) =
        s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let (status, parent) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&bob.token),
            json!({ "content": "parent from bob" }),
        )
        .await;
    assert_eq!(status, 200, "{parent}");
    let parent_id = parent["id"].as_str().unwrap().to_string();

    let mut socket = connect_watching(&s, &bob.token, &["GUILD_MESSAGES"]).await;

    let (status, reply) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": "reply without an @mention", "reply_to": parent_id }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");

    let dispatch = wait_for(&mut socket, "MESSAGE_CREATE").await;
    assert_eq!(dispatch["d"]["reply_to"], parent_id);
    assert_eq!(
        dispatch["d"]["reply_author"],
        bob.user_id.as_str(),
        "connected/background clients need an authoritative reply target"
    );
}

#[tokio::test]
async fn presence_custom_status_reaches_other_members() {
    let s = start_with(|cfg| cfg.limits.presence_coalesce_secs = 0).await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let mut ws_a = connect(&s, &alice.token).await;
    let mut ws_b = connect(&s, &bob.token).await;

    ws_a
        .send(Message::Text(
            json!({
                "op": "PRESENCE_UPDATE",
                "d": { "status": "dnd", "custom_status": "beating the final boss" }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["user_id"], alice.user_id.as_str());
    assert_eq!(seen["d"]["status"], "dnd");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    ws_a
        .send(Message::Text(
            json!({
                "op": "PRESENCE_UPDATE",
                "d": { "status": "idle", "custom_status": "x".repeat(500) }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["custom_status"].as_str().unwrap().chars().count(), 128);

    ws_a
        .send(Message::Text(
            json!({
                "op": "PRESENCE_UPDATE",
                "d": { "status": "online", "custom_status": "   " }
            })
            .to_string(),
        ))
        .await
        .unwrap();
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert!(seen["d"]["custom_status"].is_null());
}

#[tokio::test]
async fn presence_text_edit_broadcasts_immediately() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let mut ws_a = connect(&s, &alice.token).await;
    let mut ws_b = connect(&s, &bob.token).await;

    send_presence(&mut ws_a, &json!({ "status": "online", "custom_status": "first edit" })).await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "online");
    assert_eq!(seen["d"]["custom_status"], "first edit");

    send_presence(&mut ws_a, &json!({ "status": "online", "custom_status": "second edit" })).await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "online");
    assert_eq!(seen["d"]["custom_status"], "second edit");
}

#[tokio::test]
async fn show_custom_status_offline_survives_disconnect() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let mut ws_a = connect(&s, &alice.token).await;
    let mut ws_b = connect(&s, &bob.token).await;
    send_presence(
        &mut ws_a,
        &json!({
            "status": "online",
            "custom_status": "beating the final boss",
            "show_custom_status_offline": true,
        }),
    )
    .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "online");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    drop(ws_a);
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "offline");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    ws_b
        .send(Message::Text(
            json!({ "op": "SUBSCRIBE", "d": { "guild_id": gid, "member_ranges": [[0, 99]] } })
                .to_string(),
        ))
        .await
        .unwrap();
    let list = wait_for(&mut ws_b, "MEMBER_LIST_UPDATE").await;
    let items = list["d"]["ops"][0]["items"].as_array().unwrap();
    let alice_row = items.iter().find(|i| i["user_id"] == alice.user_id.as_str()).unwrap();
    assert_eq!(alice_row["presence"]["status"], "offline");
    assert_eq!(alice_row["presence"]["custom_status"], "beating the final boss");
}

#[tokio::test]
async fn custom_status_is_wiped_on_disconnect_by_default() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let mut ws_a = connect(&s, &alice.token).await;
    let mut ws_b = connect(&s, &bob.token).await;
    send_presence(
        &mut ws_a,
        &json!({ "status": "online", "custom_status": "beating the final boss" }),
    )
    .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    drop(ws_a);
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "offline");
    assert!(seen["d"]["custom_status"].is_null(), "the status must not survive a plain disconnect");
}

#[tokio::test]
async fn invisible_hides_or_shows_the_custom_status_per_the_toggle() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let mut ws_a = connect(&s, &alice.token).await;
    let mut ws_b = connect(&s, &bob.token).await;

    send_presence(
        &mut ws_a,
        &json!({ "status": "online", "custom_status": "beating the final boss" }),
    )
    .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "online");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    send_presence(&mut ws_a, &json!({ "status": "invisible", "custom_status": "beating the final boss" }))
        .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "offline");
    assert!(seen["d"]["custom_status"].is_null(), "invisible without the toggle must hide the status");

    send_presence(
        &mut ws_a,
        &json!({ "status": "online", "custom_status": "beating the final boss" }),
    )
    .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "online");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");

    send_presence(
        &mut ws_a,
        &json!({
            "status": "invisible",
            "custom_status": "beating the final boss",
            "show_custom_status_offline": true,
        }),
    )
    .await;
    let seen = wait_for(&mut ws_b, "PRESENCE_UPDATE").await;
    assert_eq!(seen["d"]["status"], "offline");
    assert_eq!(seen["d"]["custom_status"], "beating the final boss");
}

#[tokio::test]
async fn a_session_coming_online_is_announced_to_the_guild() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _hello = next_frame(&mut ws).await;
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": alice.token, "intents": ["GUILD_PRESENCES"] } })
            .to_string(),
    ))
    .await
    .unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "READY");

    let (mut bobs, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _hello = next_frame(&mut bobs).await;
    bobs.send(Message::Text(
        json!({
            "op": "IDENTIFY",
            "d": { "token": bob.token, "intents": ["GUILD_PRESENCES"], "presence": { "status": "online" } }
        })
        .to_string(),
    ))
    .await
    .unwrap();

    let update = loop {
        let frame = wait_for(&mut ws, "PRESENCE_UPDATE").await;
        if frame["d"]["user_id"] == bob.user_id.as_str() {
            break frame;
        }
    };
    assert_eq!(update["d"]["status"], "online");
    assert_eq!(update["d"]["guild_id"], gid.as_str());
}

#[tokio::test]
async fn gateway_refuses_a_bad_token() {
    let s = start().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _hello = next_frame(&mut ws).await;
    ws.send(Message::Text(json!({ "op": "IDENTIFY", "d": { "token": "nope" } }).to_string()))
        .await
        .unwrap();
    loop {
        match ws.next().await {
            Some(Ok(Message::Close(frame))) => {
                assert_eq!(frame.unwrap().code, tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Library(4004));
                return;
            }
            Some(Ok(_)) => continue,
            _ => panic!("expected a close frame"),
        }
    }
}

#[tokio::test]
async fn a_restart_closes_its_gateway_sockets_instead_of_being_waited_for() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    let _hello = next_frame(&mut ws).await;
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": alice.token } }).to_string(),
    ))
    .await
    .unwrap();
    assert_eq!(next_frame(&mut ws).await["op"], "READY");

    let told = s.state.hub.close_all().await;
    assert_eq!(told, 1, "the live connection was told to go");

    loop {
        match ws.next().await {
            Some(Ok(Message::Close(frame))) => {
                assert_eq!(
                    frame.unwrap().code,
                    tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Library(
                        4005
                    )
                );
                return;
            }
            Some(Ok(_)) => continue,
            other => panic!("expected a close frame, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn a_server_on_its_way_out_does_not_accept_a_new_socket() {
    let s = start().await;
    let alice = s.user("alice").await;
    s.state
        .shutting_down
        .store(true, std::sync::atomic::Ordering::Relaxed);

    let (mut ws, _) = tokio_tungstenite::connect_async(&s.ws).await.unwrap();
    ws.send(Message::Text(
        json!({ "op": "IDENTIFY", "d": { "token": alice.token } }).to_string(),
    ))
    .await
    .ok();
    loop {
        match ws.next().await {
            Some(Ok(Message::Close(frame))) => {
                assert_eq!(
                    frame.unwrap().code,
                    tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Library(
                        4005
                    )
                );
                return;
            }
            Some(Ok(Message::Text(t))) => panic!("served a frame while shutting down: {t}"),
            Some(Ok(_)) => continue,
            _ => return,
        }
    }
}

async fn send_presence(ws: &mut Ws, d: &Value) {
    ws.send(Message::Text(json!({ "op": "PRESENCE_UPDATE", "d": d }).to_string()))
        .await
        .unwrap();
}
