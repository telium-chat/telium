use super::*;

fn call_region(cfg: &mut Config) {
    cfg.voice.regions = vec![telium_server::config::VoiceRegion {
        name: "home".into(),
        sfu: "http://127.0.0.1:9".into(),
        turn: Some(format!("turn.{}:3478", cfg.server_name)),
        pubkey_hint: None,
    }];
    cfg.voice.default_region = "home".into();
    cfg.voice.turn_secret = Some("shared-with-the-turn-server".into());
}

async fn call_conversation(a: &Server, b: &Server, alice: &Account, bob: &Account, kind: &str) -> String {
    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": kind, "members": ["@bob:b.test"], "welcome": "welcome-blob" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    assert_eq!(conv["sequencer"], "a.test");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    eventually(
        b,
        &format!("/_telium/v1/conversations/{conv_id}/messages"),
        &bob.token,
        |v| v["messages"].as_array().map_or(0, |m| m.len()) == 1,
    )
    .await;
    if kind == "dm" {
        let (status, accepted) = b
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/request/accept"),
                Some(&bob.token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{accepted}");
    }
    conv_id
}

fn call_claims(voice_server: &Value) -> Value {
    let token = voice_server["token"].as_str().expect("an SFU voice_server carries a token");
    let raw = telium_server::util::unb64(token).expect("the token is base64");
    serde_json::from_slice(&raw).expect("the token is signed JSON")
}

fn call_has_turn(ice_servers: &Value, host: &str) -> bool {
    ice_servers.as_array().unwrap_or(&Vec::new()).iter().any(|s| {
        s["username"].is_string()
            && s["credential"].is_string()
            && s["urls"].to_string().contains(&format!("turn:{host}"))
    })
}

#[tokio::test]
async fn call_relay_mode_hands_out_the_homes_own_turn_credentials() {
    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.voice.turn_secret = Some("shared-with-the-turn-server".into());
        cfg.voice.turn = Some(format!("relay.{}:3478", cfg.server_name));
    })
    .await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    let (_, caps) = a.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["calls"]["relay"], true, "{caps}");
    assert_eq!(caps["calls"]["sfu"], false, "{caps}");
    assert_eq!(caps["calls"]["e2ee"], "mls-exporter");

    let (status, joined) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    let server = &joined["voice_server"];
    assert_eq!(server["mode"], "mesh");
    assert_eq!(server["relay"], true);
    assert!(call_has_turn(&server["ice_servers"], "relay.b.test"), "{server}");

    let (c, d) = pair().await;
    let carol = register_full(&c, "carol").await;
    let dave = register_full(&d, "bob").await;
    let conv_id = call_conversation(&c, &d, &carol, &dave, "dm").await;
    let (_, caps) = c.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["calls"]["relay"], false, "{caps}");
    let (status, joined) = c
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&carol.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["relay"], false);
    assert!(!joined["voice_server"]["ice_servers"].to_string().contains("credential"));
}

#[tokio::test]
async fn call_asking_for_an_sfu_moves_the_call_onto_the_sequencers() {
    let (a, b) = pair_tuned(0, &call_region).await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    let (status, joined) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["mode"], "mesh");
    assert_eq!(joined["voice_server"]["generation"], 0);

    let (status, joined) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
            Some(&bob.token),
            json!({ "wants_sfu": true }),
        )
        .await;
    assert_eq!(status, 200, "{joined}");
    let server = &joined["voice_server"];
    assert_eq!(server["mode"], "sfu", "{server}");
    assert_eq!(server["host"], "a.test");
    assert_eq!(server["generation"], 1);
    assert_eq!(server["e2ee"], "required");
    assert_eq!(server["endpoint"], "http://127.0.0.1:9");
    assert!(joined["voice_state"].get("wants_sfu").is_none(), "{joined}");

    let claims = call_claims(server);
    assert_eq!(claims["origin"], "a.test", "one origin mints, so one room");
    assert_eq!(claims["user_id"], "@bob:b.test");
    assert_eq!(claims["guild"], conv_id.as_str());
    assert_eq!(claims["channel"], conv_id.as_str());
    assert_eq!(claims["room_kind"], "conversation");
    assert_eq!(claims["e2ee"], true);
    assert!(claims["expires_at"].as_i64().unwrap() > now_ms());

    let (status, moved) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/server"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["voice_server"]["mode"], "sfu");
    assert_eq!(moved["voice_server"]["generation"], 1);
    let claims = call_claims(&moved["voice_server"]);
    assert_eq!((claims["origin"].as_str(), claims["user_id"].as_str()), (Some("a.test"), Some("@alice:a.test")));

    let (_, roster) = b.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(&bob.token)).await;
    assert_eq!(roster["call"]["mode"], "sfu", "{roster}");
    assert_eq!(roster["call"]["host"], "a.test");

    let (status, _) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/state"),
            Some(&bob.token),
            json!({ "wants_sfu": false }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, roster) = a.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(&alice.token)).await;
    assert_eq!(roster["call"]["mode"], "sfu", "{roster}");

    let carol = register_full(&a, "carol").await;
    let (status, _) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/server"), Some(&carol.token), json!({}))
        .await;
    assert_eq!(status, 403);

    for (server, token) in [(&a, &alice.token), (&b, &bob.token)] {
        let (status, _) = server
            .post(&format!("/_telium/v1/conversations/{conv_id}/voice/leave"), Some(token), json!({}))
            .await;
        assert_eq!(status, 200);
    }
    eventually(&a, &format!("/_telium/v1/conversations/{conv_id}/voice"), &alice.token, |v| {
        v["voice_states"].as_array().is_some_and(|s| s.is_empty())
    })
    .await;
    let (status, joined) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["mode"], "mesh");
}

#[tokio::test]
async fn call_is_hosted_by_a_participants_home_when_the_sequencer_has_no_sfu() {
    let (a, b) = pair_tuned(0, &|cfg| {
        if cfg.server_name == "b.test" {
            call_region(cfg);
        }
    })
    .await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    let (status, joined) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
            Some(&alice.token),
            json!({ "wants_sfu": true }),
        )
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["mode"], "mesh");

    let (status, joined) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["mode"], "sfu", "{joined}");
    assert_eq!(joined["voice_server"]["host"], "b.test");
    assert_eq!(call_claims(&joined["voice_server"])["origin"], "b.test");
    assert!(call_has_turn(&joined["voice_server"]["ice_servers"], "turn.b.test"));

    let (status, moved) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/server"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{moved}");
    let claims = call_claims(&moved["voice_server"]);
    assert_eq!(claims["origin"], "b.test");
    assert_eq!(claims["user_id"], "@alice:a.test");

    let body = json!({
        "conversation_id": conv_id, "user_id": "@bob:b.test", "device_id": "x", "host": "b.test",
    });
    let forged = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/voice/token", &body).await;
    assert!(forged.is_err(), "a.test cannot fetch Bob's token");
}

#[tokio::test]
async fn call_outgrowing_the_mesh_moves_to_an_sfu_or_is_refused_without_one() {
    let (a, b) = pair_tuned(0, &|cfg| cfg.voice.mesh_max_participants = 1).await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "gc").await;

    let (status, _) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200);
    let (status, refused) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused.to_string().contains("SFU"), "{refused}");
    let (_, roster) = b.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(&bob.token)).await;
    assert_eq!(roster["voice_states"].as_array().unwrap().len(), 1, "{roster}");

    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.voice.mesh_max_participants = 1;
        if cfg.server_name == "a.test" {
            call_region(cfg);
        }
    })
    .await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "gc").await;

    let (_, joined) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(joined["voice_server"]["mode"], "mesh");
    let (status, joined) = b
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&bob.token), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["voice_server"]["mode"], "sfu", "{joined}");
    assert_eq!(joined["voice_server"]["host"], "a.test");
    assert_eq!(call_claims(&joined["voice_server"])["origin"], "a.test");
}

#[tokio::test]
async fn call_on_the_conversations_own_sfu_is_vouched_for_by_the_sequencer() {
    let (a, b) = pair_tuned(0, &|cfg| {
        cfg.voice.turn_secret = Some("shared-with-the-turn-server".into());
        cfg.voice.turn = Some(format!("relay.{}:3478", cfg.server_name));
    })
    .await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "gc").await;

    let (status, _) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200);
    let (status, joined) = b
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
            Some(&bob.token),
            json!({ "wants_sfu": true, "custom_sfu": true }),
        )
        .await;
    assert_eq!(status, 200, "{joined}");
    let server = &joined["voice_server"];
    assert_eq!(server["mode"], "sfu", "{server}");
    assert_eq!(server["host"], "custom");
    assert_eq!(server["custom"], true);
    assert!(server["endpoint"].is_null(), "no server knows where it is: {server}");
    let claims = call_claims(server);
    assert_eq!(claims["origin"], "a.test", "the sequencer mints");
    assert_eq!(claims["region"], "custom");
    assert_eq!(claims["user_id"], "@bob:b.test");
    assert!(call_has_turn(&server["ice_servers"], "relay.b.test"), "{server}");

    let body = json!({
        "conversation_id": conv_id, "user_id": "@alice:a.test", "device_id": "x", "host": "custom",
    });
    let refused = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/dm/voice/token", &body).await;
    assert!(refused.is_err());
}

async fn call_roster(server: &Server, token: &str, conv_id: &str) -> Vec<String> {
    let (status, body) =
        server.get(&format!("/_telium/v1/conversations/{conv_id}/voice"), Some(token)).await;
    assert_eq!(status, 200, "{body}");
    let mut who: Vec<String> = body["voice_states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["user_id"].as_str().unwrap().to_string())
        .collect();
    who.sort();
    who
}

#[tokio::test]
async fn call_sequencer_restart_keeps_the_seats_the_other_homes_vouch_for() {
    let (a, b) = pair_tuned(0, &call_region).await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    for (server, account) in [(&a, &alice), (&b, &bob)] {
        let (status, joined) = server
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
                Some(&account.token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{joined}");
    }
    assert_eq!(call_roster(&a, &alice.token, &conv_id).await, ["@alice:a.test", "@bob:b.test"]);

    let bob_session = local_session(&b, &bob.token).await;
    let _bobs_socket = gateway(&b, &bob_session).await;

    telium_server::routes::voice::mark_unclaimed(&a.state.pool, 0).await.unwrap();
    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&a.state).await, 1);
    assert_eq!(
        call_roster(&a, &alice.token, &conv_id).await,
        ["@bob:b.test"],
        "the sequencer dropped a seat the man's own home was still holding",
    );

    let still: Option<i64> = sqlx::query_scalar(
        "SELECT reclaim_until FROM voice_states WHERE guild_id = ? AND user_id = '@bob:b.test'",
    )
    .bind(&conv_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert_eq!(still, None);
}

#[tokio::test]
async fn call_home_row_keeps_the_session_the_sequencer_granted() {
    let (a, b) = pair_tuned(0, &call_region).await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    let session_of = |server: &Server| {
        let pool = server.state.pool.clone();
        let conv_id = conv_id.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT session_id FROM voice_states WHERE guild_id = ? AND user_id = '@bob:b.test'",
            )
            .bind(&conv_id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    let mut granted = Vec::new();
    for _ in 0..2 {
        let (status, joined) = b
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
                Some(&bob.token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{joined}");
        let session = joined["voice_state"]["session_id"].as_str().unwrap().to_string();
        assert_eq!(session_of(&a).await, session, "the sequencer's row");
        assert_eq!(session_of(&b).await, session, "the home's row is the one a claim is checked against");
        granted.push(session);
    }
    assert_ne!(granted[0], granted[1]);
}

#[tokio::test]
async fn call_sequencer_restart_drops_a_seat_no_home_will_vouch_for() {
    let (a, b) = pair_tuned(0, &call_region).await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = call_conversation(&a, &b, &alice, &bob, "dm").await;

    for (server, account) in [(&a, &alice), (&b, &bob)] {
        let (status, joined) = server
            .post(
                &format!("/_telium/v1/conversations/{conv_id}/voice/join"),
                Some(&account.token),
                json!({}),
            )
            .await;
        assert_eq!(status, 200, "{joined}");
    }

    sqlx::query("DELETE FROM voice_states WHERE guild_id = ? AND user_id = '@bob:b.test'")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();

    telium_server::routes::voice::mark_unclaimed(&a.state.pool, 0).await.unwrap();
    assert_eq!(telium_server::routes::voice::sweep_unclaimed(&a.state).await, 2);
    assert!(call_roster(&a, &alice.token, &conv_id).await.is_empty(), "a seat nobody claims goes");
}
