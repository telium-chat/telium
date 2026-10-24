use super::*;

#[tokio::test]
async fn a_direct_message_crosses_servers_and_keeps_one_order() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;

    let (status, published) = b
        .post(
            "/_telium/v1/keypackages",
            Some(&bob.token),
            json!({ "packages": ["kp-bob-1", "kp-bob-2"] }),
        )
        .await;
    assert_eq!(status, 200, "{published}");
    assert_eq!(published["available"], 2);

    let (status, claim) = a
        .post("/_telium/v1/users/@bob:b.test/keypackages/claim", Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{claim}");
    assert_eq!(claim["key_packages"][0]["package"], "kp-bob-1");

    let (_, left) = b.get("/_telium/v1/keypackages", Some(&bob.token)).await;
    assert_eq!(left["available"], 1);

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "welcome-blob" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    assert_eq!(conv["sequencer"], "a.test", "the creator's home sequences");

    let (status, sent) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&alice.token),
            json!({ "ciphertext": "ct-from-alice" }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(sent["seq"], 2, "the welcome took seq 1");

    let hist = eventually(
        &b,
        &format!("/_telium/v1/conversations/{conv_id}/messages"),
        &bob.token,
        |v| v["messages"].as_array().map_or(0, |m| m.len()) == 2,
    )
    .await;
    assert_eq!(hist["messages"][0]["kind"], "welcome");
    assert_eq!(hist["messages"][1]["ciphertext"], "ct-from-alice");
    assert_eq!(hist["messages"][1]["sender"], "@alice:a.test");

    let (_, inbox) = b.get("/_telium/v1/conversations", Some(&bob.token)).await;
    let request = inbox["conversations"].as_array().unwrap()
        .iter().find(|c| c["id"] == conv_id).expect("Bob can see the request");
    assert_eq!(request["request_state"], "pending");

    let (status, accepted) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/request/accept"),
            Some(&bob.token),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{accepted}");
    let (_, inbox) = b.get("/_telium/v1/conversations", Some(&bob.token)).await;
    let ordinary = inbox["conversations"].as_array().unwrap()
        .iter().find(|c| c["id"] == conv_id).expect("accepted DM stays visible");
    assert!(ordinary.get("request_state").is_none(), "{ordinary}");

    let (status, duplicate) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "duplicate-welcome" }),
        )
        .await;
    assert_eq!(status, 200, "{duplicate}");
    let duplicate_id = duplicate["id"].as_str().unwrap().to_string();
    assert_eq!(
        duplicate_id, conv_id,
        "a second one-to-one must collapse onto the conversation that already exists"
    );

    drained(&a, &duplicate_id).await;

    let conversations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id \
         WHERE c.kind = 'dm' AND m.user_id = ?",
    )
    .bind("@alice:a.test")
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(conversations, 1, "recipient home holds a second dm with the same person");

    let memberships: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM conversation_members WHERE conversation_id = ?",
    )
    .bind(&conv_id)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(memberships, 2, "the one dm has exactly its two members");

    let requests: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_message_requests WHERE conversation_id = ? AND state = 'pending'",
    )
    .bind(&conv_id)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(requests, 0, "an accepted dm was re-armed as a pending request");

    let (status, reply) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&bob.token),
            json!({ "ciphertext": "ct-from-bob" }),
        )
        .await;
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["seq"], 3, "one order, assigned in one place");

    let (_, alice_view) = a
        .get(&format!("/_telium/v1/conversations/{conv_id}/messages"), Some(&alice.token))
        .await;
    assert_eq!(alice_view["messages"][2]["ciphertext"], "ct-from-bob");

    let (_, listed) = a.get("/_telium/v1/conversations", Some(&alice.token)).await;
    assert_eq!(listed["conversations"][0]["id"], conv_id.as_str());
    assert_eq!(listed["conversations"][0]["members"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn encrypted_dm_notification_hints_wait_for_the_authoritative_frame_in_either_order() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;

    let private = SecretKey::random(&mut OsRng);
    let public = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(private.public_key().to_sec1_bytes().as_ref());
    let (status, registration) = b
        .put(
            "/_telium/v1/notifications/device",
            &bob.token,
            json!({
                "algorithm": telium_server::notifications::ALGORITHM_V1,
                "public_key": public,
            }),
        )
        .await;
    assert_eq!(status, 200, "{registration}");

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "welcome" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();

    eventually(
        &b,
        &format!("/_telium/v1/conversations/{conv_id}/messages"),
        &bob.token,
        |v| v["messages"].as_array().is_some_and(|rows| !rows.is_empty()),
    )
    .await;

    let (status, keys) = a
        .get(
            &format!("/_telium/v1/conversations/{conv_id}/notification-keys"),
            Some(&alice.token),
        )
        .await;
    assert_eq!(status, 200, "{keys}");
    assert_eq!(keys["hint_origin"], format!("dm:{conv_id}"));

    let mallory = register_full(&a, "mallory-notify").await;
    let (status, refused) = a
        .get(
            &format!("/_telium/v1/conversations/{conv_id}/notification-keys"),
            Some(&mallory.token),
        )
        .await;
    assert_eq!(status, 403, "a non-member enumerated DM notification keys: {refused}");

    let target = &keys["targets"][0];
    assert_eq!(target["user_id"], "@bob:b.test");
    assert_eq!(target["public_key"], public);
    assert!(
        keys.to_string().find("endpoint").is_none(),
        "key discovery leaked a push endpoint: {keys}"
    );

    let seal = |notification_id: &str| {
        let device_id = target["device_id"].as_str().unwrap();
        let aad = telium_server::notifications::aad(
            "@bob:b.test",
            device_id,
            &format!("dm:{conv_id}"),
            notification_id,
            None,
            "dm_hint",
        );
        serde_json::to_value(
            telium_server::notifications::seal_descriptor(
                &public,
                &aad,
                br#"{"v":1,"kind":"dm_hint","notify":1}"#,
            )
            .unwrap(),
        )
        .unwrap()
    };

    let hint_body = |notification_id: &str| {
        json!({
            "notification_id": notification_id,
            "envelopes": [{
                "user_id": "@bob:b.test",
                "device_id": target["device_id"],
                "public_key": public,
                "ciphertext": seal(notification_id),
            }],
        })
    };

    let bob_device = target["device_id"].as_str().unwrap();
    b.state.hub.device_opened("@bob:b.test", bob_device).await;

    let (wake_tx, mut wakes) = tokio::sync::mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/wake", listener.local_addr().unwrap());
    let relay = axum::Router::new().route("/wake", axum::routing::post(
        move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let tx = wake_tx.clone();
            async move {
                let _ = tx.send((headers, body));
                axum::Json(json!({"ok": true}))
            }
        },
    ));
    let relay_task = tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, created_at) VALUES ('phone-relay', '@bob:b.test', ?, 'relay', ?, 1)",
    )
    .bind(bob_device).bind(endpoint).execute(&b.state.pool).await.unwrap();

    let first = "hint-first-0123456789";
    let (status, body) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/notification-hints"),
            Some(&alice.token),
            hint_body(first),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    for _ in 0..60 {
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM dm_notification_hints WHERE notification_id = ?",
        )
        .bind(first)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
        if pending == 1 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let before: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ?",
    )
    .bind(first)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(before, 0, "an unsequenced hint manufactured a notification");

    let (status, sent) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&alice.token),
            json!({
                "ciphertext": "opaque-application-1",
                "notification_id": first,
            }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    for _ in 0..60 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
        )
        .bind(first)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
        if count == 1 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let first_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
    )
    .bind(first)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(first_count, 1);

    let (headers, wake_body) = tokio::time::timeout(std::time::Duration::from_secs(5), wakes.recv())
        .await.expect("a connected phone must still receive its fallback wake").unwrap();
    assert_eq!(wake_body, json!({"type": "wake"}));
    assert_eq!(headers["urgency"], "high");
    let retained: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
    )
    .bind(first)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(retained, 1, "a live socket discarded an unacknowledged DM notification");

    let second = "frame-first-0123456789";
    let (status, sent) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&alice.token),
            json!({
                "ciphertext": "opaque-application-2",
                "notification_id": second,
            }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    eventually(
        &b,
        &format!("/_telium/v1/conversations/{conv_id}/messages"),
        &bob.token,
        |v| v["messages"].as_array().is_some_and(|rows| {
            rows.iter().any(|row| row["ciphertext"] == "opaque-application-2")
        }),
    )
    .await;

    let (status, body) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/notification-hints"),
            Some(&alice.token),
            hint_body(second),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    for _ in 0..60 {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
        )
        .bind(second)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
        if count == 1 { break; }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let second_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
    )
    .bind(second)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(second_count, 1);

    a.post(
        &format!("/_telium/v1/conversations/{conv_id}/notification-hints"),
        Some(&alice.token),
        hint_body(second),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let retried: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
    )
    .bind(second)
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(retried, 1);
    relay_task.abort();
}

#[tokio::test]
async fn a_conversation_can_be_read_from_either_end() {
    let (a, _b) = pair_tuned(0, &|cfg| cfg.rate_limit.enabled = false).await;
    let alice = register_full(&a, "alice").await;

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": [] }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();

    for i in 1..=150 {
        let (status, sent) = a
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/messages"),
                Some(&alice.token),
                json!({ "ciphertext": format!("ct-{i}") }),
            )
            .await;
        assert_eq!(status, 200, "{sent}");
    }

    let newest = history(&a, &alice, &conv_id, "?tail=100").await;
    let rows = newest["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    assert_eq!(rows[0]["ciphertext"], "ct-51");
    assert_eq!(rows[99]["ciphertext"], "ct-150");
    assert!(
        rows.windows(2).all(|w| w[0]["seq"].as_i64() < w[1]["seq"].as_i64()),
        "a tail is still a page of history, ascending like every other"
    );

    let oldest = history(&a, &alice, &conv_id, "").await;
    let rows = oldest["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 100);
    assert_eq!(rows[0]["ciphertext"], "ct-1");
    assert_eq!(rows[99]["ciphertext"], "ct-100");

    let page = history(&a, &alice, &conv_id, "?after=10&limit=20").await;
    let rows = page["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 20);
    assert_eq!(rows[0]["ciphertext"], "ct-11");
    assert_eq!(rows[19]["ciphertext"], "ct-30");

    let both = history(&a, &alice, &conv_id, "?after=140&tail=100").await;
    let rows = both["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 10);
    assert_eq!(rows[0]["ciphertext"], "ct-141");
    assert_eq!(rows[9]["ciphertext"], "ct-150");

    let all = history(&a, &alice, &conv_id, "?tail=400").await;
    assert_eq!(all["messages"].as_array().unwrap().len(), 150);
}

#[tokio::test]
async fn a_group_chat_can_re_anchor_to_another_members_server() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 3).await;

    let (status, refused) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "c.test" }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let (status, moved) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "b.test" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["sequencer"], "b.test");
    assert_eq!(moved["pending"], false, "{moved}");
    assert_eq!(moved["handoff"]["last_seq"], 4, "the handoff says where the old order stopped");
    assert_eq!(moved["handoff"]["from"], "a.test");

    let (_, seen) = b.get(&format!("/_telium/v1/conversations/{conv_id}"), Some(&bob.token)).await;
    assert_eq!(seen["sequencer"], "b.test");
    assert_eq!(seen["last_seq"], 4);
    let (_, seen) = a.get(&format!("/_telium/v1/conversations/{conv_id}"), Some(&alice.token)).await;
    assert_eq!(seen["sequencer"], "b.test");

    let (status, sent) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&bob.token),
            json!({ "ciphertext": "after-the-move", "epoch": 1 }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(sent["seq"], 5);
    drained(&b, &conv_id).await;
    assert_eq!(seqs(&a, &conv_id).await, vec![1, 2, 3, 4, 5]);

    let (status, routed) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&alice.token),
            json!({ "ciphertext": "still-works-via-b", "epoch": 1 }),
        )
        .await;
    assert_eq!(status, 200, "{routed}");
    assert_eq!(routed["seq"], 6);
    let (_, hist) = b
        .get(&format!("/_telium/v1/conversations/{conv_id}/messages"), Some(&bob.token))
        .await;
    let last = hist["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["ciphertext"], "still-works-via-b");
    assert_eq!(last["sender"], "@alice:a.test");

    let refused = telium_server::federation::post_signed(
        &b.state,
        "a.test",
        "/_telium/v1/dm/submit",
        &json!({
            "conversation_id": conv_id, "kind": "application", "sender": "@bob:b.test",
            "ciphertext": "to-the-old-one", "epoch": 1,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.code(), "not_sequencer", "{refused:?}");
}

#[tokio::test]
async fn a_new_sequencer_with_no_copy_reads_the_log_before_taking_over() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 4).await;
    for table in ["dm_messages", "conversation_members"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE conversation_id = ?"))
            .bind(&conv_id)
            .execute(&b.state.pool)
            .await
            .unwrap();
    }
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();

    let (status, moved) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "b.test" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(seqs(&b, &conv_id).await, vec![1, 2, 3, 4, 5]);
    let (sequencer, last_seq): (String, i64) =
        sqlx::query_as("SELECT sequencer, last_seq FROM conversations WHERE id = ?")
            .bind(&conv_id)
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
    assert_eq!((sequencer.as_str(), last_seq), ("b.test", 5));

    let (status, sent) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&bob.token),
            json!({ "ciphertext": "first-at-b", "epoch": 1 }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    assert_eq!(sent["seq"], 6, "numbering goes on from the handoff, never over it");
}

async fn stored_conversation(server: &Server, id: &str) -> (String, i64, Option<String>, Vec<(String, String)>) {
    let (sequencer, epoch, policy): (String, i64, Option<String>) =
        sqlx::query_as("SELECT sequencer, epoch, policy FROM conversations WHERE id = ?")
            .bind(id)
            .fetch_one(&server.state.pool)
            .await
            .unwrap();
    let members: Vec<(String, String)> = sqlx::query_as(
        "SELECT user_id, state FROM conversation_members WHERE conversation_id = ? ORDER BY user_id",
    )
    .bind(id)
    .fetch_all(&server.state.pool)
    .await
    .unwrap();
    (sequencer, epoch, policy, members)
}

#[tokio::test]
async fn only_a_handoff_the_sequencer_signed_moves_a_conversation() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let carol = register_full(&c, "carol").await;

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({
                "kind": "gc", "members": ["@bob:b.test", "@carol:c.test"], "welcome": "gc-welcome",
            }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    drained(&a, &conv_id).await;
    for (home, who) in [(&b, &bob), (&c, &carol)] {
        eventually(home, &format!("/_telium/v1/conversations/{conv_id}"), &who.token, |v| {
            v["sequencer"] == "a.test"
        })
        .await;
    }
    let before = stored_conversation(&b, &conv_id).await;
    let post = |from: &Server, to: &str, path: &str, body: Value| {
        let state = from.state.clone();
        let (to, path) = (to.to_string(), path.to_string());
        async move { telium_server::federation::post_signed(&state, &to, &path, &body).await }
    };

    let old = json!({ "conversation": { "id": conv_id, "sequencer": "a.test" } });
    let refused = post(&a, "b.test", "/_telium/v1/dm/reanchor", old).await.unwrap_err();
    assert_eq!(refused.status(), 400, "{refused:?}");

    let doc = json!({
        "type": "telium.dm.handoff", "conversation_id": conv_id, "n": 1,
        "from": "a.test", "to": "c.test", "last_seq": 1, "epoch": 1, "issued_at": 0,
    });
    let refused = post(&c, "b.test", "/_telium/v1/dm/handoff", json!({ "handoff": doc.clone() }))
        .await
        .unwrap_err();
    assert!(refused.status() == 400 || refused.status() == 403, "{refused:?}");

    let forged = telium_server::crypto::sign_json(&c.state.key, doc.clone());
    let refused = post(&c, "b.test", "/_telium/v1/dm/handoff", json!({ "handoff": forged }))
        .await
        .unwrap_err();
    assert_eq!(refused.status(), 403, "{refused:?}");

    let mut own = doc.clone();
    own["from"] = json!("c.test");
    own["to"] = json!("b.test");
    let own = telium_server::crypto::sign_json(&c.state.key, own);
    let refused = post(&c, "b.test", "/_telium/v1/dm/handoff", json!({ "handoff": own }))
        .await
        .unwrap_err();
    assert!(refused.status().is_client_error(), "{refused:?}");
    assert_eq!(stored_conversation(&b, &conv_id).await, before, "nothing a refusal carried was applied");

    let (status, moved) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "b.test" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["handoff"]["n"], 1);
    drained(&a, &conv_id).await;
    let after = stored_conversation(&b, &conv_id).await;
    assert_eq!(after.0, "b.test");
    assert_eq!((&after.1, &after.2, &after.3), (&before.1, &before.2, &before.3));
    assert_eq!(stored_conversation(&c, &conv_id).await.0, "b.test", "the third home moved too");
    let first = moved["handoff"].clone();

    let (status, back) = c
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&carol.token),
            json!({ "sequencer": "a.test" }),
        )
        .await;
    assert_eq!(status, 200, "{back}");
    assert_eq!(back["handoff"]["n"], 2);
    assert_eq!(back["handoff"]["from"], "b.test");
    assert_eq!(stored_conversation(&c, &conv_id).await.0, "a.test");
    assert_eq!(stored_conversation(&a, &conv_id).await.0, "a.test");

    let refused = post(&b, "c.test", "/_telium/v1/dm/handoff", json!({ "handoff": first.clone() }))
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "handoff_stale", "{refused:?}");
    assert_eq!(stored_conversation(&c, &conv_id).await.0, "a.test");
    let refused = post(&b, "a.test", "/_telium/v1/dm/handoff", json!({ "handoff": first }))
        .await
        .unwrap_err();
    assert_eq!(refused.code(), "handoff_stale", "{refused:?}");
    assert_eq!(stored_conversation(&a, &conv_id).await.0, "a.test");
}

#[tokio::test]
async fn a_start_over_from_another_home_is_decided_at_the_sequencer_and_moves_with_it() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 1).await;
    let path = format!("/_telium/v1/conversations/{conv_id}/messages");
    let over = |ct: &str, generation: i64| {
        json!({ "kind": "welcome", "ciphertext": ct, "epoch": 1, "start_over": true, "generation": generation })
    };

    let (status, won) = b.post(&path, Some(&bob.token), over("bob-starts-over", 0)).await;
    assert_eq!(status, 200, "{won}");
    assert_eq!(won["generation"], 1);
    let (status, lost) = a.post(&path, Some(&alice.token), over("alice-starts-over", 0)).await;
    assert_eq!(status, 409, "{lost}");
    assert_eq!((lost["code"].as_str(), lost["generation"].as_i64()), (Some("generation_conflict"), Some(1)));
    let (status, lost) = b.post(&path, Some(&bob.token), over("bob-again", 0)).await;
    assert_eq!(status, 409, "{lost}");
    assert_eq!((lost["code"].as_str(), lost["generation"].as_i64()), (Some("generation_conflict"), Some(1)));
    drained(&a, &conv_id).await;
    let (_, seen) = b.get(&format!("/_telium/v1/conversations/{conv_id}"), Some(&bob.token)).await;
    assert_eq!(seen["generation"], 1, "the member home's copy follows the sequencer's");
    let held = history(&b, &bob, &conv_id, "").await;
    let last = held["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["ciphertext"].as_str(), last["generation"].as_i64()), (Some("bob-starts-over"), Some(1)));

    let (status, moved) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "b.test" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["handoff"]["generation"], 1);
    let (status, body) = b
        .post(&path, Some(&bob.token), json!({ "kind": "commit", "ciphertext": "old", "epoch": 2, "generation": 0 }))
        .await;
    assert_eq!(status, 409, "the new sequencer knows which group is current: {body}");
    assert_eq!(body["code"], "generation_conflict");
    let (status, body) = b
        .post(&path, Some(&bob.token), json!({ "kind": "commit", "ciphertext": "new", "epoch": 2, "generation": 1 }))
        .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn frames_the_old_sequencer_ordered_before_a_handoff_still_land() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 2).await;
    sqlx::query("DELETE FROM dm_messages WHERE conversation_id = ? AND seq = 3")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();
    let (status, moved) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/reanchor"),
            Some(&alice.token),
            json!({ "sequencer": "b.test" }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(seqs(&b, &conv_id).await, vec![1, 2, 3], "the new home filled its hole before it took over");

    let late = |seq: i64| {
        json!({
            "conversation": {
                "id": conv_id, "kind": "gc", "sequencer": "a.test", "creator": "@alice:a.test",
                "epoch": 1,
                "members": [
                    { "user_id": "@alice:a.test", "home": "a.test", "state": "active" },
                    { "user_id": "@bob:b.test", "home": "b.test", "state": "active" },
                ],
            },
            "message": {
                "id": format!("late-{seq}"), "seq": seq, "kind": "application", "epoch": 1,
                "sender": "@alice:a.test", "ciphertext": format!("late-{seq}"), "created_at": 0,
            },
        })
    };
    let accepted = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &late(3)).await;
    assert!(accepted.is_ok(), "{accepted:?}");
    let refused = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &late(4)).await;
    assert!(refused.is_err(), "the old sequencer orders nothing past its handoff: {refused:?}");
    assert_eq!(seqs(&b, &conv_id).await, vec![1, 2, 3]);
}

#[tokio::test]
async fn switching_the_vault_to_self_custody_destroys_the_escrow_key() {
    let (a, _b) = pair().await;
    let alice = register_full(&a, "alice").await;

    let (status, ok) = a
        .put(
            "/_telium/v1/vault",
            &alice.token,
            json!({ "ciphertext": "vault-v1", "escrow_key": "escrow-secret" }),
        )
        .await;
    assert_eq!(status, 200, "{ok}");

    let (_, vault) = a.get("/_telium/v1/vault", Some(&alice.token)).await;
    assert_eq!(vault["mode"], "escrowed");
    assert_eq!(vault["server_can_recover"], true, "escrowed mode is honest about this");

    let (status, refused) = a
        .post(
            "/_telium/v1/vault/mode",
            Some(&alice.token),
            json!({ "mode": "self_custody", "ciphertext": "vault-v2" }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let (status, switched) = a
        .post(
            "/_telium/v1/vault/mode",
            Some(&alice.token),
            json!({ "mode": "self_custody", "ciphertext": "vault-v2", "recovery_confirmed": true }),
        )
        .await;
    assert_eq!(status, 200, "{switched}");
    assert_eq!(switched["escrow_key_destroyed"], true);

    let (_, vault) = a.get("/_telium/v1/vault", Some(&alice.token)).await;
    assert_eq!(vault["mode"], "self_custody");
    assert_eq!(vault["escrow_key"], Value::Null);
    assert_eq!(vault["server_can_recover"], false);
    assert_eq!(vault["version"], 2);

    let (status, refused) = a
        .put(
            "/_telium/v1/vault",
            &alice.token,
            json!({ "ciphertext": "v3", "mode": "self_custody", "escrow_key": "oops" }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");
}

#[tokio::test]
async fn a_call_in_a_dm_is_kept_by_the_sequencer_and_seen_on_both_sides() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "welcome-blob" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    assert_eq!(conv["sequencer"], "a.test");

    eventually(
        &b,
        &format!("/_telium/v1/conversations/{conv_id}/messages"),
        &bob.token,
        |v| v["messages"].as_array().map_or(0, |m| m.len()) == 1,
    )
    .await;

    let (status, joined) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
            Some(&alice.token),
            json!({ "self_mute": true }),
        )
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_state"]["conversation_id"], conv_id.as_str());
    assert_eq!(joined["voice_state"]["self_mute"], true);
    assert!(joined["voice_state"].get("guild_id").is_none(), "a DM call has no guild");
    assert_eq!(joined["voice_server"]["mode"], "mesh");

    let (status, hidden) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 404, "{hidden}");

    let (status, accepted) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/request/accept"),
            Some(&bob.token),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{accepted}");

    let (status, joined) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_state"]["user_id"], "@bob:b.test");

    let here = |v: &Value| {
        let mut who: Vec<String> = v["voice_states"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .map(|s| s["user_id"].as_str().unwrap_or_default().to_string())
            .collect();
        who.sort();
        who
    };

    let (_, from_a) = a.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(&alice.token)).await;
    assert_eq!(here(&from_a), vec!["@alice:a.test", "@bob:b.test"]);
    let (_, from_b) = b.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(&bob.token)).await;
    assert_eq!(here(&from_b), vec!["@alice:a.test", "@bob:b.test"]);

    let (status, muted) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/state"),
            Some(&bob.token),
            json!({ "self_video": true }),
        )
        .await;
    assert_eq!(status, 200, "{muted}");
    assert_eq!(muted["self_video"], true);

    let (status, gone) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/leave"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 200, "{gone}");
    let settled = eventually(
        &a,
        &format!("/_telium/v1/conversations/{conv_id}/voice"),
        &alice.token,
        |v| here(v) == vec!["@alice:a.test".to_string()],
    )
    .await;
    assert_eq!(here(&settled), vec!["@alice:a.test"]);

    let carol = register_full(&a, "carol").await;
    let (status, refused) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&carol.token), json!({}))
        .await;
    assert_eq!(status, 403, "{refused}");
}
