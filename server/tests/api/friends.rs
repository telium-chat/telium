use super::*;

#[tokio::test]
async fn a_crossing_pair_of_friend_requests_becomes_a_friendship() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (status, row) = s
        .post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": bob.user_id }))
        .await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["state"], "pending_out");

    let (_, mine) = s.get("/_telium/v1/friends", Some(&bob.home)).await;
    assert_eq!(mine["friends"].as_array().unwrap().len(), 1);
    assert_eq!(mine["friends"][0]["state"], "pending_in");
    assert_eq!(mine["friends"][0]["user_id"], alice.user_id);

    let (status, again) = s
        .post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": bob.user_id }))
        .await;
    assert_eq!(status, 200, "{again}");
    let (_, mine) = s.get("/_telium/v1/friends", Some(&bob.home)).await;
    assert_eq!(mine["friends"].as_array().unwrap().len(), 1);

    let (status, row) = s
        .post("/_telium/v1/friends", Some(&bob.home), json!({ "user_id": alice.user_id }))
        .await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["state"], "accepted");
    let (_, hers) = s.get("/_telium/v1/friends", Some(&alice.home)).await;
    assert_eq!(hers["friends"][0]["state"], "accepted");
    assert_eq!(hers["friends"][0]["presence"]["status"], "offline");

    let (status, gone) = s
        .delete(&format!("/_telium/v1/friends/{}", bob.user_id), &alice.home)
        .await;
    assert_eq!(status, 200, "{gone}");
    let (_, hers) = s.get("/_telium/v1/friends", Some(&alice.home)).await;
    assert!(hers["friends"].as_array().unwrap().is_empty());
    let (_, his) = s.get("/_telium/v1/friends", Some(&bob.home)).await;
    assert!(his["friends"].as_array().unwrap().is_empty(), "{his}");
}

#[tokio::test]
async fn a_request_is_refused_when_there_is_nobody_to_receive_it() {
    let s = start().await;
    let alice = s.user("alice").await;

    let (status, _) = s
        .post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": "@ghost:test.example" }))
        .await;
    assert_eq!(status, 404, "a typo must not become a request nobody can answer");

    let (status, _) = s
        .post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": alice.user_id }))
        .await;
    assert_eq!(status, 400);
}

#[tokio::test]
async fn accepting_a_request_needs_a_request_to_accept() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (status, _) = s
        .post(&format!("/_telium/v1/friends/{}/accept", alice.user_id), Some(&bob.home), json!({}))
        .await;
    assert_eq!(status, 404);

    s.post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": bob.user_id })).await;
    let (status, row) = s
        .post(&format!("/_telium/v1/friends/{}/accept", alice.user_id), Some(&bob.home), json!({}))
        .await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["state"], "accepted");

    let (status, _) = s
        .delete(&format!("/_telium/v1/friends/{}", alice.user_id), &bob.home)
        .await;
    assert_eq!(status, 200);
    let (_, hers) = s.get("/_telium/v1/friends", Some(&alice.home)).await;
    assert!(hers["friends"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_block_ends_the_friendship_and_says_nothing_else() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    s.post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": bob.user_id })).await;
    s.post(&format!("/_telium/v1/friends/{}/accept", alice.user_id), Some(&bob.home), json!({}))
        .await;

    let (status, row) = s
        .put(&format!("/_telium/v1/friends/{}/block", bob.user_id), &alice.home, json!({}))
        .await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["state"], "blocked");

    let (_, his) = s.get("/_telium/v1/friends", Some(&bob.home)).await;
    assert!(his["friends"].as_array().unwrap().is_empty(), "{his}");

    let (status, retry) = s
        .post("/_telium/v1/friends", Some(&bob.home), json!({ "user_id": alice.user_id }))
        .await;
    assert_eq!(status, 200, "{retry}");
    let (_, hers) = s.get("/_telium/v1/friends", Some(&alice.home)).await;
    assert_eq!(hers["friends"].as_array().unwrap().len(), 1);
    assert_eq!(hers["friends"][0]["state"], "blocked");

    let (status, _) = s
        .post("/_telium/v1/friends", Some(&alice.home), json!({ "user_id": bob.user_id }))
        .await;
    assert_eq!(status, 409);

    let (status, _) = s
        .delete(&format!("/_telium/v1/friends/{}/block", bob.user_id), &alice.home)
        .await;
    assert_eq!(status, 200);
    let (_, hers) = s.get("/_telium/v1/friends", Some(&alice.home)).await;
    assert!(hers["friends"].as_array().unwrap().is_empty());
}

async fn nothing_else_reached(s: &Server, ws: &mut Ws, user_id: &str, what: &str) {
    s.state
        .hub
        .publish_user(
            user_id,
            telium_server::gateway::events::Event::to_account("MARKER", user_id, json!({})),
        )
        .await;
    let frame = next_frame(ws).await;
    assert_eq!(frame["t"], "MARKER", "{what} reached {user_id}: {frame}");
}

async fn seat_in_dm_call(s: &Server, conv_id: &str, user_id: &str) {
    sqlx::query(
        "INSERT INTO voice_states \
         (guild_id, user_id, channel_id, device_id, session_id, region, \
          self_mute, self_deaf, self_video, streaming, server_mute, server_deaf, \
          joined_at, updated_at, room_kind) \
         VALUES (?, ?, ?, 'dev-1', 'sess-1', 'auto', 0, 0, 0, 0, 0, 0, 1, 1, 'dm')",
    )
    .bind(conv_id)
    .bind(user_id)
    .bind(conv_id)
    .execute(&s.state.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn an_unaccepted_request_is_labelled_and_gates_typing_and_calls() {
    let s = start().await;
    let bob = s.user("gated-bob").await;
    let mallory = s.user("gated-mallory").await;
    let conv = open_dm(&s, &mallory, &bob).await;
    seat_in_dm_call(&s, &conv, &mallory.user_id).await;
    let mut ws = connect_watching(&s, &bob.token, &["DIRECT_MESSAGES"]).await;

    dm_send(&s, &conv, &mallory, "ct-pending").await;
    let arrived = next_frame(&mut ws).await;
    assert_eq!(arrived["t"], "DM_MESSAGE", "{arrived}");
    assert_eq!(arrived["d"]["request_state"], "pending", "{arrived}");
    let (_, listed) = s.get("/_telium/v1/conversations", Some(&bob.home)).await;
    assert_eq!(listed["conversations"][0]["request_state"], "pending", "{listed}");

    for phase in ["pending", "declined"] {
        if phase == "declined" {
            s.post(&format!("/_telium/v1/conversations/{conv}/request/decline"), Some(&bob.home), json!({}))
                .await;
            assert_eq!(next_frame(&mut ws).await["t"], "DM_REQUEST_UPDATE");
            dm_send(&s, &conv, &mallory, "ct-declined").await;
            nothing_else_reached(&s, &mut ws, &bob.user_id, "a declined request's message").await;
            let (_, listed) = s.get("/_telium/v1/conversations", Some(&bob.home)).await;
            assert!(listed["conversations"].as_array().unwrap().is_empty(), "{listed}");
        }
        let (status, _) = s.get(&format!("/_telium/v1/conversations/{conv}/voice"), Some(&bob.home)).await;
        assert_eq!(status, 404, "a {phase} request showed a call");
        let (status, _) = s
            .post(
                &format!("/_telium/v1/conversations/{conv}/voice/signal"),
                Some(&mallory.home),
                json!({ "target": bob.user_id, "payload": { "sdp": "offer" } }),
            )
            .await;
        assert_eq!(status, 200, "the sender must not learn the offer was dropped");
        telium_server::routes::dm::gateway_typing(&s.state, &conv, &mallory.user_id, true).await.unwrap();
        nothing_else_reached(&s, &mut ws, &bob.user_id, &format!("{phase} typing or call offer")).await;
    }

    let carol = s.user("gated-carol").await;
    let second = open_dm(&s, &carol, &bob).await;
    seat_in_dm_call(&s, &second, &carol.user_id).await;
    s.post(&format!("/_telium/v1/conversations/{second}/request/accept"), Some(&bob.home), json!({})).await;
    assert_eq!(next_frame(&mut ws).await["t"], "DM_REQUEST_UPDATE");
    dm_send(&s, &second, &carol, "ct-accepted").await;
    let arrived = next_frame(&mut ws).await;
    assert!(arrived["d"].get("request_state").is_none(), "{arrived}");
    let (status, _) = s.get(&format!("/_telium/v1/conversations/{second}/voice"), Some(&bob.home)).await;
    assert_eq!(status, 200);
    s.post(
        &format!("/_telium/v1/conversations/{second}/voice/signal"),
        Some(&carol.home),
        json!({ "target": bob.user_id, "payload": { "sdp": "offer-after-accept" } }),
    )
    .await;
    assert_eq!(next_frame(&mut ws).await["t"], "VOICE_SIGNAL");
    telium_server::routes::dm::gateway_typing(&s.state, &second, &carol.user_id, true).await.unwrap();
    assert_eq!(next_frame(&mut ws).await["t"], "DM_TYPING_START");
}

#[tokio::test]
async fn a_decline_and_a_block_are_invisible_to_the_sender() {
    let s = start_with(|cfg| cfg.limits.max_message_requests = 2).await;
    let bob = s.user("private-decision-bob").await;
    let mallory = s.user("private-decision-mallory").await;
    let conv = open_dm(&s, &mallory, &bob).await;

    let snapshot = || async {
        let mut out = Vec::new();
        for (path, token) in [
            (format!("/_telium/v1/conversations/{conv}"), Some(mallory.home.as_str())),
            ("/_telium/v1/conversations".to_string(), Some(mallory.home.as_str())),
            (format!("/_telium/v1/conversations/{conv}/messages"), Some(mallory.home.as_str())),
            (format!("/_telium/v1/users/{}/profile", bob.user_id), None),
            (format!("/_telium/v1/users/{}/status", bob.user_id), None),
            ("/_telium/v1/friends".to_string(), Some(mallory.home.as_str())),
        ] {
            out.push(s.get(&path, token).await);
        }
        out
    };
    let before = snapshot().await;
    assert_eq!(before[0].0, 200);
    assert!(before[0].1.get("request_state").is_none(), "{:?}", before[0]);

    s.post(&format!("/_telium/v1/conversations/{conv}/request/decline"), Some(&bob.home), json!({})).await;
    let (_, bobs) = s.get("/_telium/v1/conversations", Some(&bob.home)).await;
    assert!(bobs["conversations"].as_array().unwrap().is_empty(), "{bobs}");
    assert_eq!(snapshot().await, before, "declining changed something the sender can read");
    s.put(&format!("/_telium/v1/friends/{}/block", mallory.user_id), &bob.home, json!({})).await;
    assert_eq!(snapshot().await, before, "blocking changed something the sender can read");
    let (status, _) = s
        .post(
            &format!("/_telium/v1/conversations/{conv}/messages"),
            Some(&mallory.home),
            json!({ "kind": "application", "ciphertext": "ct-into-the-void" }),
        )
        .await;
    assert_eq!(status, 200);

    for n in 0..3 {
        let stranger = s.user(&format!("request-bound-stranger-{n}")).await;
        open_dm(&s, &stranger, &bob).await;
    }
    let (_, inbox) = s.get("/_telium/v1/conversations", Some(&bob.home)).await;
    let rows = inbox["conversations"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{inbox}");
    assert!(rows.iter().all(|c| c["request_state"] == "pending"), "{inbox}");
}

#[tokio::test]
async fn mutual_friends_return_only_the_accepted_intersection() {
    let s = start().await;
    let alice = s.user("mutual-alice").await;
    let bob = s.user("mutual-bob").await;
    let charlie = s.user("mutual-charlie").await;
    let dave = s.user("mutual-dave").await;
    let pending = s.user("mutual-pending").await;

    async fn befriend(s: &Server, a: &User, b: &User) {
        let (status, sent) = s
            .post(
                "/_telium/v1/friends",
                Some(&a.home),
                json!({ "user_id": b.user_id }),
            )
            .await;
        assert_eq!(status, 200, "{sent}");
        let (status, accepted) = s
            .post(
                &format!("/_telium/v1/friends/{}/accept", a.user_id),
                Some(&b.home),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{accepted}");
    }

    befriend(&s, &alice, &charlie).await;
    befriend(&s, &bob, &charlie).await;
    befriend(&s, &alice, &dave).await;

    let (status, request) = s
        .post(
            "/_telium/v1/friends",
            Some(&alice.home),
            json!({ "user_id": pending.user_id }),
        )
        .await;
    assert_eq!(status, 200, "{request}");
    let (status, request) = s
        .post(
            "/_telium/v1/friends",
            Some(&bob.home),
            json!({ "user_id": pending.user_id }),
        )
        .await;
    assert_eq!(status, 200, "{request}");

    let (status, mutuals) = s
        .get(
            &format!("/_telium/v1/friends/mutual/{}", bob.user_id),
            Some(&alice.home),
        )
        .await;
    assert_eq!(status, 200, "{mutuals}");
    assert_eq!(mutuals["complete"], true);
    let ids: Vec<&str> = mutuals["friends"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["user_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![charlie.user_id.as_str()], "{mutuals}");

    let (status, blocked) = s
        .put(
            &format!("/_telium/v1/friends/{}/block", bob.user_id),
            &alice.home,
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{blocked}");
    let (status, mutuals) = s
        .get(
            &format!("/_telium/v1/friends/mutual/{}", bob.user_id),
            Some(&alice.home),
        )
        .await;
    assert_eq!(status, 200, "{mutuals}");
    assert!(mutuals["friends"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn exact_member_status_supports_mutual_guilds_without_listing_other_guilds() {
    let s = start().await;
    let alice = s.user("guild-mutual-alice").await;
    let bob = s.user("guild-mutual-bob").await;

    async fn guild(s: &Server, owner: &User, name: &str) -> (String, String) {
        let (status, created) = s
            .post(
                "/_telium/v1/guilds",
                Some(&owner.token),
                json!({ "name": name }),
            )
            .await;
        assert_eq!(status, 200, "{created}");
        let id = created["id"].as_str().unwrap().to_string();
        let (status, invite) = s
            .post(
                &format!("/_telium/v1/guilds/{id}/invites"),
                Some(&owner.token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{invite}");
        (id, invite["code"].as_str().unwrap().to_string())
    }

    let (shared_id, shared_code) = guild(&s, &alice, "Shared").await;
    let (private_id, _) = guild(&s, &alice, "Alice only").await;

    let (status, joined) = s
        .post(
            &format!("/_telium/v1/invites/{shared_code}/join"),
            Some(&bob.token),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{joined}");

    let (status, shared) = s
        .get(
            &format!("/_telium/v1/guilds/{shared_id}/members/{}", bob.user_id),
            Some(&alice.token),
        )
        .await;
    assert_eq!(status, 200, "{shared}");
    assert_eq!(shared["member"], true);

    let (status, not_shared) = s
        .get(
            &format!("/_telium/v1/guilds/{private_id}/members/{}", bob.user_id),
            Some(&alice.token),
        )
        .await;
    assert_eq!(status, 200, "{not_shared}");
    assert_eq!(not_shared["member"], false);
}
