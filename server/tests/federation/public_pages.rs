use super::*;

#[tokio::test]
async fn an_assertion_for_another_homes_user_needs_a_learned_relocation() {
    let (a, b, c) = trio().await;
    let alice = a.register("alice").await;
    assert!(!a.session_on(&alice, &b).await.is_empty(), "the honest handshake still works");
    let now = telium_server::util::now_ms();
    let claims = telium_server::crypto::AssertionClaims {
        user_id: "@alice:a.test".into(),
        device_id: "stolen-device".into(),
        device_pubkey: "not-a-real-device-key".into(),
        audience: b.name.clone(),
        origin: c.name.clone(),
        profile_version: 1,
        display_name: "alice".into(),
        avatar_ref: None,
        iat: now,
        exp: now + 300_000,
    };
    let token = telium_server::crypto::issue_assertion(&c.state.key, &claims);
    let (status, body) = b.post("/_telium/v1/sessions", None, json!({ "assertion": token })).await;
    assert_eq!(status, 401, "c.test signed for an account of a.test and b.test took it: {body}");
    assert!(body["session_token"].is_null(), "{body}");
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM guild_sessions WHERE home_domain = 'c.test'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0);

    sqlx::query(
        "INSERT INTO domain_relocations \
             (old_domain, new_domain, record, state, local, effective_at, learned_at, checked_at, applied_at) \
         VALUES ('a.test', 'c.test', '{}', 'applied', 0, ?1, ?1, ?1, ?1)",
    )
    .bind(now)
    .execute(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(telium_server::relocation::current_domain(&b.state, "a.test").await, "c.test");
    let verified = telium_server::federation::verify_assertion(&b.state, &token, &b.name)
        .await
        .expect("a successor home's assertion for an old-name id is accepted");
    assert_eq!(verified.user_id, "@alice:a.test");
}

#[tokio::test]
async fn a_moved_accounts_public_page_follows_her_and_the_old_home_goes_quiet() {
    let (a, b) = pair().await;
    register_full(&a, "operator").await;
    let alice = register_full(&a, "alice").await;
    let profile = json!({
        "display_name": "Alice Who Moved",
        "bio": "a bio that has to survive the journey",
        "pronouns": "she/her",
    });
    let mut patch = profile.clone();
    patch["public_status_enabled"] = json!(true);
    let (status, patched) = a.patch("/_telium/v1/profile", &alice.token, patch).await;
    assert_eq!(status, 200, "{patched}");
    let presence = telium_server::gateway::hub::Presence {
        status: "online".into(),
        custom_status: Some("still at the old house".into()),
        activity: None,
        rich_activities: Vec::new(),
        updated_at: now_ms(),
    };
    let _ = a.state.hub.set_presence("@alice:a.test", presence, true).await;
    let (_, before) = a.get("/_telium/v1/users/@alice:a.test/public-page", None).await;
    assert_eq!(before["presence"]["custom_status"], "still at the old house", "{before}");
    let born = before["profile"]["created_at"].as_i64().expect("a public page states an age");

    let newcomer = register_full(&b, "alice2").await;
    let done = move_user(&a, &b, &alice, &newcomer.token, "@alice:a.test").await;
    assert_eq!(done["new_id"], "@alice2:b.test", "{done}");

    let (_, moved) = a.get("/_telium/v1/users/@alice:a.test/status", None).await;
    assert_eq!((&moved["status"], &moved["moved_to"]), (&json!("moved"), &json!("@alice2:b.test")), "{moved}");
    let (status, gone) = a.get("/_telium/v1/users/@alice:a.test/public-page", None).await;
    let (_, never) = a.get("/_telium/v1/users/@nobody-at-all:a.test/public-page", None).await;
    assert_eq!(status, 404, "{gone}");
    assert_eq!(gone, never, "a moved account must look like one that never existed");

    for (server, what) in [(&b, "the new home"), (&a, "a peer")] {
        let (status, page) = server.get("/_telium/v1/users/@alice2:b.test/public-page", None).await;
        assert_eq!(status, 200, "{what}: {page}");
        for key in ["display_name", "bio", "pronouns"] {
            assert_eq!(page["profile"][key], profile[key], "{what}: {page}");
        }
        assert_eq!(page["profile"]["created_at"].as_i64(), Some(born), "{what} aged the account to the move: {page}");
    }
    let (_, whoami) = b.get("/_telium/v1/whoami", Some(&newcomer.token)).await;
    assert_eq!(whoami["profile"]["public_status_enabled"], true, "the move reset a privacy switch: {whoami}");
}

#[tokio::test]
async fn a_mirrored_duplicate_is_torn_down_without_spending_a_pending_slot() {
    let (a, b) = pair_tuned(0, &|cfg| cfg.limits.max_message_requests = 2).await;
    let alice = a.register("alice").await;
    let bob = b.register("bob").await;
    let carol = b.register("carol").await;
    let create = |welcome: &'static str| {
        a.post("/_telium/v1/conversations", Some(&alice), json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": welcome }))
    };
    let conv_id = create("welcome-one").await.1["id"].as_str().unwrap().to_string();
    eventually(&b, "/_telium/v1/conversations", &bob, |v| {
        v["conversations"].as_array().is_some_and(|c| c.len() == 1 && c[0]["request_state"] == "pending")
    })
    .await;

    sqlx::query("DELETE FROM dm_pairs").execute(&a.state.pool).await.unwrap();
    let duplicate_id = create("welcome-two").await.1["id"].as_str().unwrap().to_string();
    assert_ne!(duplicate_id, conv_id);
    drained(&a, &duplicate_id).await;
    let (status, alices_view) = a.get(&format!("/_telium/v1/conversations/{duplicate_id}"), Some(&alice)).await;
    assert_eq!(status, 200, "{alices_view}");
    assert!(alices_view.get("request_state").is_none(), "the sender can read the recipient's decision");
    for table in ["conversations WHERE id = ?", "conversation_members WHERE conversation_id = ?", "dm_message_requests WHERE conversation_id = ?", "dm_messages WHERE conversation_id = ?"] {
        let held: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
            .bind(&duplicate_id)
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
        assert_eq!(held, 0, "the mirrored duplicate left rows in {table}");
    }
    let requests: Vec<(String, String)> =
        sqlx::query_as("SELECT conversation_id, state FROM dm_message_requests WHERE user_id = '@bob:b.test'")
            .fetch_all(&b.state.pool)
            .await
            .unwrap();
    assert_eq!(requests, vec![(conv_id.clone(), "pending".to_string())]);

    let (_, hers) = b.post("/_telium/v1/conversations", Some(&carol), json!({ "kind": "dm", "members": ["@bob:b.test"] })).await;
    let (_, inbox) = b.get("/_telium/v1/conversations", Some(&bob)).await;
    let rows = inbox["conversations"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{inbox}");
    assert!(rows.iter().any(|c| c["id"] == hers["id"] && c["request_state"] == "pending"), "{inbox}");
    let (status, accepted) =
        b.post(&format!("/_telium/v1/conversations/{conv_id}/request/accept"), Some(&bob), json!({})).await;
    assert_eq!(status, 200, "{accepted}");
}

#[tokio::test]
async fn a_local_id_spelled_oddly_is_answered_here_and_not_chased_around_the_network() {
    let (a, _b) = pair().await;
    a.register("alice").await;
    for spelling in ["@alice:A.TEST", "@alice:a.test.", "@alice:A.TEST."] {
        for (route, want) in [("status", 200), ("public-page", 404)] {
            let (status, body) = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                a.get(&format!("/_telium/v1/users/{spelling}/{route}"), None),
            )
            .await
            .unwrap_or_else(|_| panic!("{spelling}/{route} was proxied to this server by this server"));
            assert_eq!(status, want, "{spelling}/{route}: {body}");
            if route == "status" {
                assert_eq!((&body["origin"], &body["status"]), (&json!("a.test"), &json!("unknown")), "{body}");
            }
        }
    }
    let (_, canonical) = a.get("/_telium/v1/users/@alice:a.test/status", None).await;
    assert_eq!(canonical["status"], "active", "{canonical}");
}

#[tokio::test]
async fn hiding_a_public_page_does_not_hide_the_person_from_other_servers() {
    let (a, b) = pair().await;
    let alice = b.register("alice").await;
    let (status, patched) = b
        .patch("/_telium/v1/profile", &alice, json!({ "display_name": "Alice Unlisted", "pronouns": "she/her" }))
        .await;
    assert_eq!(status, 200, "{patched}");
    let (_, listed) = a.get("/_telium/v1/users/@alice:b.test/profile", None).await;
    assert_eq!(listed["display_name"], "Alice Unlisted", "{listed}");
    let (status, off) = b.patch("/_telium/v1/profile", &alice, json!({ "public_page_enabled": false })).await;
    assert_eq!(status, 200, "{off}");
    for server in [&b, &a] {
        let (status, page) = server.get("/_telium/v1/users/@alice:b.test/public-page", None).await;
        assert_eq!(status, 404, "{page}");
    }
    let (status, still) = a.get("/_telium/v1/users/@alice:b.test/profile", None).await;
    assert_eq!(status, 200, "{still}");
    assert_eq!(still, listed, "turning the public page off changed what other servers see");
    let (_, local) = b.get("/_telium/v1/users/@alice:b.test/profile", None).await;
    assert_eq!(local["display_name"], "Alice Unlisted", "{local}");
}
