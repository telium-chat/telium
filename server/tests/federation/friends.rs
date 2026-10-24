use super::*;

#[tokio::test]
async fn a_friendship_crosses_servers_as_two_halves() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let bob = b.register("bob").await;

    let (status, row) = a
        .post("/_telium/v1/friends", Some(&alice), json!({ "user_id": "@bob:b.test" }))
        .await;
    assert_eq!(status, 200, "{row}");
    assert_eq!(row["state"], "pending_out");

    let (status, missing) = a
        .post("/_telium/v1/friends", Some(&alice), json!({ "user_id": "@ghost:b.test" }))
        .await;
    assert_eq!(status, 404, "{missing}");

    let his = eventually(&b, "/_telium/v1/friends", &bob, |v| {
        v["friends"][0]["state"] == "pending_in"
    })
    .await;
    assert_eq!(his["friends"][0]["user_id"], "@alice:a.test");
    assert_eq!(his["friends"][0]["domain"], "a.test");

    let (status, accepted) = b
        .post("/_telium/v1/friends/@alice:a.test/accept", Some(&bob), json!({}))
        .await;
    assert_eq!(status, 200, "{accepted}");

    eventually(&a, "/_telium/v1/friends", &alice, |v| {
        v["friends"][0]["state"] == "accepted"
    })
    .await;

    let (status, gone) = a.delete("/_telium/v1/friends/@bob:b.test", &alice).await;
    assert_eq!(status, 200, "{gone}");
    eventually(&b, "/_telium/v1/friends", &bob, |v| {
        v["friends"].as_array().unwrap().is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_relay_only_speaks_for_the_signing_servers_own_users() {
    let (a, b) = pair().await;
    let bob = b.register("bob").await;

    let (status, refused) = a
        .post(
            "/_telium/v1/friends/relay",
            Some(&bob),
            json!({ "action": "request", "from": "@c:c.test", "to": "@bob:b.test" }),
        )
        .await;
    assert!(status == 401 || status == 403, "{status}: {refused}");

    let (_, his) = b.get("/_telium/v1/friends", Some(&bob)).await;
    assert!(his["friends"].as_array().unwrap().is_empty(), "{his}");
}

#[tokio::test]
async fn an_accept_nobody_asked_for_makes_nobody_a_friend() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let bob = b.register("bob").await;

    let sent = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/friends/relay",
        &json!({ "action": "accept", "from": "@alice:a.test", "to": "@bob:b.test" }),
    )
    .await;
    assert!(sent.is_ok(), "the relay is dropped in silence, not answered: {sent:?}");

    let (_, his) = b.get("/_telium/v1/friends", Some(&bob)).await;
    assert!(his["friends"].as_array().unwrap().is_empty(), "{his}");

    let (status, row) = b
        .post("/_telium/v1/friends", Some(&bob), json!({ "user_id": "@alice:a.test" }))
        .await;
    assert_eq!(status, 200, "{row}");
    telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/friends/relay",
        &json!({ "action": "accept", "from": "@alice:a.test", "to": "@bob:b.test" }),
    )
    .await
    .expect("a relayed accept for a request that was made");

    let his = eventually(&b, "/_telium/v1/friends", &bob, |v| {
        v["friends"][0]["state"] == "accepted"
    })
    .await;
    assert_eq!(his["friends"][0]["user_id"], "@alice:a.test");
    let _ = alice;
}

#[tokio::test]
async fn a_full_list_is_full_to_other_servers_too() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let bob = b.register("bob").await;

    sqlx::query(
        "INSERT INTO friends (user_id, peer_id, peer_domain, state, created_at, updated_at) \
         SELECT '@bob:b.test', '@filler' || value || ':c.test', 'c.test', 'accepted', 0, 0 \
         FROM (WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n \
         WHERE value < 1000) SELECT value FROM n)",
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let refused = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/friends/relay",
        &json!({ "action": "request", "from": "@alice:a.test", "to": "@bob:b.test" }),
    )
    .await;
    assert!(refused.is_err(), "a full list refuses a relayed request too");

    let (_, his) = b.get("/_telium/v1/friends", Some(&bob)).await;
    let held = his["friends"].as_array().unwrap();
    assert!(
        !held.iter().any(|f| f["user_id"] == "@alice:a.test"),
        "the refused request left no row"
    );
    let _ = alice;
}

#[tokio::test]
async fn a_defederated_domain_gets_no_friend_requests() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    b.register("bob").await;
    a.elevate(&alice).await;

    let (status, _) = a
        .post(
            "/_telium/v1/admin/defederation",
            Some(&alice),
            json!({ "domain": "b.test", "scope": "all", "reason": "test" }),
        )
        .await;
    assert_eq!(status, 200);

    let (status, refused) = a
        .post("/_telium/v1/friends", Some(&alice), json!({ "user_id": "@bob:b.test" }))
        .await;
    assert_eq!(status, 403, "{refused}");
}
