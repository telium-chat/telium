use super::*;

async fn open_handoff(a: &Server, token: &str, destination: &str) -> (String, String) {
    let (status, handoff) =
        a.post("/_telium/v1/migrate/handoff", Some(token), json!({ "destination": destination })).await;
    assert_eq!(status, 200, "{handoff}");
    assert_eq!(handoff["source"], a.name);
    (
        handoff["id"].as_str().unwrap().to_string(),
        handoff["secret"].as_str().unwrap().to_string(),
    )
}

#[tokio::test]
async fn an_account_moves_without_anybody_copying_a_code() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let newcomer = register_full(&b, "alice2").await;

    let (id, secret) = open_handoff(&a, &alice.token, "b.test").await;
    let (status, waiting) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&alice.token)).await;
    assert_eq!(status, 200, "{waiting}");
    assert_eq!(waiting["state"], "waiting");

    let (status, body) = start_from_handoff(&a, &alice, &id, "correct horse battery").await;
    assert_eq!(status, 409, "an undelivered handoff is not a claim: {body}");

    let (status, accepted) = accept_handoff(&b, &newcomer.token, "@alice:a.test", &id, &secret).await;
    assert_eq!(status, 200, "{accepted}");
    assert_eq!(accepted["delivered"], true);
    assert!(accepted.get("import_token").is_none(), "the claim went to the source, not the browser: {accepted}");

    let (status, delivered) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&alice.token)).await;
    assert_eq!(status, 200, "{delivered}");
    assert_eq!(delivered["state"], "delivered");
    assert_eq!(delivered["target_id"], "@alice2:b.test", "the owner is shown where they are going");
    assert!(delivered.get("import_token").is_none(), "{delivered}");

    let (status, body) = start_from_handoff(&a, &alice, &id, "wrong horse battery").await;
    assert_eq!(status, 401, "{body}");
    let (_, still) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&alice.token)).await;
    assert_eq!(still["state"], "delivered", "a refused start does not spend the handoff");

    let (status, started) = start_from_handoff(&a, &alice, &id, "correct horse battery").await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["destination"], "b.test");
    let migration_id = started["id"].as_str().unwrap().to_string();

    let (_, used) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&alice.token)).await;
    assert_eq!(used["state"], "used");
    assert_eq!(used["migration_id"], migration_id.as_str());

    let (status, done) = a
        .post(&format!("/_telium/v1/migrate/{migration_id}/execute"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["new_id"], "@alice2:b.test");
    assert!(done["tombstone"]["sig_user_device"].is_string());
}

#[tokio::test]
async fn a_handoff_is_spent_once() {
    let (a, b) = pair_with_delay(3600).await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let newcomer = register_full(&b, "alice2").await;
    let (id, secret) = open_handoff(&a, &alice.token, "b.test").await;

    let (status, body) = accept_handoff(&b, &newcomer.token, "@alice:a.test", &id, &secret).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(live_claims(&b).await, 1);

    let (status, body) = accept_handoff(&b, &newcomer.token, "@alice:a.test", &id, &secret).await;
    assert_eq!(status, 409, "a delivered handoff does not take a second claim: {body}");
    assert_eq!(live_claims(&b).await, 1, "the refused delivery's claim is not left behind");

    let (status, started) = start_from_handoff(&a, &alice, &id, "correct horse battery").await;
    assert_eq!(status, 200, "{started}");
    let migration = started["id"].as_str().unwrap().to_string();
    a.post(&format!("/_telium/v1/migrate/{migration}/cancel"), Some(&alice.token), json!({})).await;

    let (status, body) = start_from_handoff(&a, &alice, &id, "correct horse battery").await;
    assert_eq!(status, 409, "a spent handoff starts nothing: {body}");
}

#[tokio::test]
async fn a_handoff_belongs_to_the_account_that_opened_it() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let mallory = register_full(&a, "mallory").await;
    let newcomer = register_full(&b, "alice2").await;
    let (id, secret) = open_handoff(&a, &alice.token, "b.test").await;

    let (status, _) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&mallory.token)).await;
    assert_eq!(status, 404);

    let (status, body) = accept_handoff(&b, &newcomer.token, "@mallory:a.test", &id, &secret).await;
    assert_eq!(status, 403, "a handoff is for the account that opened it: {body}");
    assert_eq!(live_claims(&b).await, 0);

    let (status, body) = accept_handoff(&b, &newcomer.token, "@alice:a.test", &id, &secret).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = start_from_handoff(&a, &mallory, &id, "correct horse battery").await;
    assert_eq!(status, 404, "somebody else's handoff: {body}");

    let (status, body) = a
        .post(
            "/_telium/v1/migrate/grant-payload",
            Some(&alice.token),
            json!({ "subject_type": "user", "destination": "c.test", "handoff_id": id }),
        )
        .await;
    assert_eq!(status, 400, "a handoff fixes its destination: {body}");
    let (status, body) = a
        .post(
            "/_telium/v1/migrate/grant-payload",
            Some(&alice.token),
            json!({ "subject_type": "user", "destination": "b.test", "handoff_id": id, "import_token": "x" }),
        )
        .await;
    assert_eq!(status, 400, "{body}");
}

#[tokio::test]
async fn only_the_named_destination_can_fill_a_handoff_in() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    let (id, secret) = open_handoff(&a, &alice.token, "b.test").await;
    let path = "/_telium/v1/migrate/handoff/deliver";
    let forged = |target: &str, secret: &str| {
        json!({
            "handoff_id": id, "secret": secret, "subject_type": "user",
            "source_id": "@alice:a.test", "target_id": target, "import_token": "forged-claim",
        })
    };

    let refused = telium_server::federation::post_signed(&c.state, "a.test", path, &forged("@eve:c.test", &secret)).await;
    assert!(
        matches!(refused, Err(telium_server::error::ApiError::NotFound(_))),
        "a handoff for b.test is not c.test's to fill: {refused:?}"
    );
    let refused = telium_server::federation::post_signed(&c.state, "a.test", path, &forged("@alice2:b.test", &secret)).await;
    assert!(refused.is_err(), "{refused:?}");

    let refused = telium_server::federation::post_signed(&b.state, "a.test", path, &forged("@alice2:b.test", "guess")).await;
    assert!(matches!(refused, Err(telium_server::error::ApiError::NotFound(_))), "{refused:?}");

    let refused = telium_server::federation::post_signed(&b.state, "a.test", path, &forged("@eve:c.test", &secret)).await;
    assert!(matches!(refused, Err(telium_server::error::ApiError::Forbidden(_))), "{refused:?}");

    let (_, status_doc) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&alice.token)).await;
    assert_eq!(status_doc["state"], "waiting", "nothing above filled it in: {status_doc}");
}

#[tokio::test]
async fn a_source_cannot_open_a_claim_at_the_destination_by_itself() {
    let (a, b) = pair().await;
    let _alice = register_full(&a, "alice").await;
    let _newcomer = register_full(&b, "alice2").await;

    let refused = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/migrate/accept",
        &json!({
            "subject_type": "user", "source": "a.test", "source_id": "@alice:a.test",
            "handoff": { "id": "x", "secret": "y" },
        }),
    )
    .await;
    assert!(refused.is_err(), "{refused:?}");
    assert_eq!(live_claims(&b).await, 0);
}
