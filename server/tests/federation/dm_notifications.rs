use super::*;

async fn dm_pair_with_bob_ready() -> (Server, Server, Account, Account, String) {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "welcome" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    drained(&a, &conv_id).await;
    let (status, accepted) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/request/accept"),
            Some(&bob.token),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{accepted}");
    (a, b, alice, bob, conv_id)
}

/// Queues application frames (seq 2..=count) while Bob's home server is down,
/// capturing each row's delivery payload and then removing the rows. The
/// sequencer's destination pump lock is held across the whole window, so a
/// spawned flush blocked on it can only observe rows that are already gone --
/// it can never deliver behind the test's back. Returns the revived server
/// plus each frame's seq and its exact delivery payload for hand-paced
/// replay.
async fn queue_frames_bob_offline(
    a: &Server,
    b: Server,
    alice: &Account,
    conv_id: &str,
    count: i64,
    notification_id_for: impl Fn(i64) -> Option<&'static str>,
) -> (Server, BTreeMap<i64, Value>) {
    let offline = take_offline(b);
    let lock = a.state.dm_outbox_pump.lock_for("b.test").await;
    let pump = lock.lock().await;
    let mut payloads = BTreeMap::new();
    for n in 2..=count {
        let mut body = json!({ "ciphertext": format!("ct-{n}") });
        if let Some(nid) = notification_id_for(n) {
            body["notification_id"] = json!(nid);
        }
        let (status, sent) = a
            .post(&format!("/_telium/v1/conversations/{conv_id}/messages"), Some(&alice.token), body)
            .await;
        assert_eq!(status, 200, "{sent}");
        assert_eq!(sent["seq"], n, "{sent}");
        let id = sent["id"].as_str().unwrap().to_string();
        let (payload,): (String,) =
            sqlx::query_as("SELECT payload FROM dm_outbox WHERE conversation_id = ? AND message_id = ?")
                .bind(conv_id)
                .bind(&id)
                .fetch_one(&a.state.pool)
                .await
                .expect("the frame row is queued for the offline peer");
        payloads.insert(n, serde_json::from_str(&payload).unwrap());
    }
    sqlx::query("DELETE FROM dm_outbox WHERE conversation_id = ?")
        .bind(conv_id)
        .execute(&a.state.pool)
        .await
        .unwrap();
    drop(pump);
    let b = bring_back(offline).await;
    (b, payloads)
}

/// Hand-delivers every captured payload to Bob's replica, in seq order.
async fn deliver_all(a: &Server, payloads: &BTreeMap<i64, Value>) {
    for payload in payloads.values() {
        let reply = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", payload)
            .await
            .expect("the hand-paced delivery succeeds");
        assert_eq!(reply["ok"], true, "{reply}");
    }
}

/// Registers Bob's notification device and a relay push subscription on his
/// home server, returning the device identity and the wake channel's
/// receiving half.
async fn reachable_phone(
    b: &Server,
    bob: &Account,
) -> (String, String, tokio::sync::mpsc::UnboundedReceiver<(axum::http::HeaderMap, Value)>) {
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

    let device_id: String = sqlx::query_scalar(
        "SELECT device_id FROM notification_devices WHERE user_id = ?",
    )
    .bind("@bob:b.test")
    .fetch_one(&b.state.pool)
    .await
    .unwrap();

    let (wake_tx, wakes) = tokio::sync::mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/wake", listener.local_addr().unwrap());
    let relay = axum::Router::new().route(
        "/wake",
        axum::routing::post(
            move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
                let tx = wake_tx.clone();
                async move {
                    let _ = tx.send((headers, body));
                    axum::Json(json!({"ok": true}))
                }
            },
        ),
    );
    tokio::spawn(async move { axum::serve(listener, relay).await.unwrap() });
    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, created_at) VALUES ('phone-relay', '@bob:b.test', ?, 'relay', ?, 1)",
    )
    .bind(&device_id)
    .bind(&endpoint)
    .execute(&b.state.pool)
    .await
    .unwrap();
    (device_id, public, wakes)
}

/// Alice provisions the sender-sealed hint for one future application frame.
async fn queue_hint(
    a: &Server,
    b: &Server,
    conv_id: &str,
    alice: &Account,
    notification_id: &str,
    device_id: &str,
    public: &str,
) {
    let seal = |nid: &str| {
        let aad = telium_server::notifications::aad(
            "@bob:b.test",
            device_id,
            &format!("dm:{conv_id}"),
            nid,
            None,
            "dm_hint",
        );
        serde_json::to_value(
            telium_server::notifications::seal_descriptor(
                public,
                &aad,
                br#"{"v":1,"kind":"dm_hint","notify":1}"#,
            )
            .unwrap(),
        )
        .unwrap()
    };
    let (status, body) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/notification-hints"),
            Some(&alice.token),
            json!({
                "notification_id": notification_id,
                "envelopes": [{
                    "user_id": "@bob:b.test",
                    "device_id": device_id,
                    "public_key": public,
                    "ciphertext": seal(notification_id),
                }],
            }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    for _ in 0..60 {
        let pending: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM dm_notification_hints WHERE notification_id = ?",
        )
        .bind(notification_id)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
        if pending == 1 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the hint never reached Bob's home server");
}

async fn dm_gateway(server: &Server, home_token: &str) -> Ws {
    let session = local_session(server, home_token).await;
    let url = format!("{}/gateway/v1", server.base.replacen("http://", "ws://", 1));
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    assert_eq!(frame(&mut ws).await["op"], "HELLO");
    futures_util::SinkExt::send(
        &mut ws,
        tokio_tungstenite::tungstenite::Message::Text(
            json!({ "op": "IDENTIFY", "d": { "token": session, "intents": ["DIRECT_MESSAGES"] } })
                .to_string(),
        ),
    )
    .await
    .unwrap();
    assert_eq!(frame(&mut ws).await["op"], "READY");
    ws
}

async fn next_dm_message(ws: &mut Ws) -> Value {
    loop {
        let arrived = frame(ws).await;
        if arrived["t"] == "DM_MESSAGE" {
            return arrived["d"].clone();
        }
    }
}

async fn stored_seqs(server: &Server, conv_id: &str) -> Vec<i64> {
    sqlx::query_scalar("SELECT seq FROM dm_messages WHERE conversation_id = ? ORDER BY seq")
        .bind(conv_id)
        .fetch_all(&server.state.pool)
        .await
        .unwrap()
}

async fn marker_and_quiet(b: &Server, ws: &mut Ws, what: &str) {
    b.state
        .hub
        .publish_user(
            "@bob:b.test",
            telium_server::gateway::events::Event::to_account("MARKER", "@bob:b.test", json!({})),
        )
        .await;
    let arrived = frame(ws).await;
    if arrived["t"] != "MARKER" {
        panic!("{what}: an unexpected extra event reached Bob: {arrived}");
    }
}

/// Rewinds Bob's replica to the welcome plus the frames up to `keep`, leaving
/// a hole for everything above it. The next inbound frame must push the
/// replica into gap repair.
async fn rewind_replica_below(b: &Server, conv_id: &str, keep: i64) {
    sqlx::query("DELETE FROM dm_messages WHERE conversation_id = ? AND seq > ?")
        .bind(conv_id)
        .bind(keep)
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET last_seq = ? WHERE id = ?")
        .bind(keep)
        .bind(conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn gap_repair_announces_recovered_frames_exactly_once() {
    let (a, b, alice, bob, conv_id) = dm_pair_with_bob_ready().await;
    let (b, payloads) = queue_frames_bob_offline(&a, b, &alice, &conv_id, 5, |_| None).await;
    deliver_all(&a, &payloads).await;
    assert_eq!(stored_seqs(&b, &conv_id).await, vec![1, 2, 3, 4, 5]);

    // Pretend the replica lost everything above seq 2, then replay the
    // seq-4 delivery: the arriving frame must open a hole at 3, and the
    // background repair must fetch it and -- the regression -- announce the
    // recovered frame to the connected client instead of storing it silently.
    rewind_replica_below(&b, &conv_id, 2).await;
    let mut ws = dm_gateway(&b, &bob.token).await;
    let replay4 = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &payloads[&4])
        .await
        .expect("the seq-4 delivery succeeds");
    assert_eq!(replay4["ok"], true, "{replay4}");

    let mut announced: Vec<i64> = Vec::new();
    for _ in 0..3 {
        announced.push(next_dm_message(&mut ws).await["seq"].as_i64().unwrap());
    }
    announced.sort();
    // 4 by direct replay; 3 and 5 recovered by repair (its page runs to the
    // sequencer's last_seq), each announced exactly once.
    assert_eq!(announced, vec![3, 4, 5], "each frame announced exactly once");
    marker_and_quiet(&b, &mut ws, "after gap repair").await;

    assert_eq!(
        stored_seqs(&b, &conv_id).await,
        vec![1, 2, 3, 4, 5],
        "the repaired log has no holes"
    );
}

#[tokio::test]
async fn a_replayed_delivery_is_acked_without_repeating_events_or_hints() {
    let (a, b, alice, bob, conv_id) = dm_pair_with_bob_ready().await;
    let (device_id, public, _wakes) = reachable_phone(&b, &bob).await;
    let notification_id = "replay-nid-0123456789";
    queue_hint(&a, &b, &conv_id, &alice, notification_id, &device_id, &public).await;

    let (b, payloads) = queue_frames_bob_offline(&a, b, &alice, &conv_id, 2, |_| None).await;
    let mut ws = dm_gateway(&b, &bob.token).await;
    // Hand the sequencer's one due frame to Bob's replica ourselves, twice:
    // the second attempt stands in for a retry after a lost HTTP response.
    let first = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &payloads[&2])
        .await
        .expect("the first delivery succeeds");
    assert_eq!(first["ok"], true, "{first}");
    let delivered = next_dm_message(&mut ws).await;
    assert_eq!(delivered["seq"], 2, "{delivered}");

    let second = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &payloads[&2])
        .await
        .expect("the replay is acknowledged");
    assert_eq!(second["ok"], true, "{second}");
    marker_and_quiet(&b, &mut ws, "after the replay").await;

    let copies: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND seq = 2")
        .bind(&conv_id)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(copies, 1, "the frame must be stored exactly once");
    let hints: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notification_inbox WHERE source_id = ?")
        .bind(notification_id)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(hints, 0, "no hint was uploaded for this frame, and none may appear");
}

#[tokio::test]
async fn a_gap_repaired_frame_fires_the_push_hint_waiting_for_it() {
    let (a, b, alice, bob, conv_id) = dm_pair_with_bob_ready().await;
    let (device_id, public, mut wakes) = reachable_phone(&b, &bob).await;
    let notification_id = "gap-hint-nid-01234567";
    queue_hint(&a, &b, &conv_id, &alice, notification_id, &device_id, &public).await;

    let (b, payloads) =
        queue_frames_bob_offline(&a, b, &alice, &conv_id, 4, |n| (n == 3).then_some(notification_id)).await;
    deliver_all(&a, &payloads).await;
    assert_eq!(stored_seqs(&b, &conv_id).await, vec![1, 2, 3, 4]);
    b.state.hub.device_opened("@bob:b.test", &device_id).await;

    // Lose frame 3 on the replica and replay frame 4: the hint uploaded for
    // the missing frame must fire when gap repair recovers it -- exactly once.
    rewind_replica_below(&b, &conv_id, 2).await;
    let replay4 = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/deliver", &payloads[&4])
        .await
        .expect("the seq-4 delivery succeeds");
    assert_eq!(replay4["ok"], true, "{replay4}");

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM notification_inbox WHERE source_id = ? AND kind = 'dm_hint'",
            )
            .bind(notification_id)
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
            if count == 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the hint waiting on a gap-repaired frame was never fired");

    let (headers, wake_body) = tokio::time::timeout(std::time::Duration::from_secs(5), wakes.recv())
        .await
        .expect("the repaired frame must wake the phone")
        .unwrap();
    assert_eq!(wake_body, json!({"type": "wake"}));
    assert_eq!(headers["urgency"], "high");
    tokio::time::timeout(std::time::Duration::from_millis(200), wakes.recv())
        .await
        .expect_err("the repaired frame fired a second wake");
    assert_eq!(stored_seqs(&b, &conv_id).await, vec![1, 2, 3, 4]);
}
