use super::*;

async fn guild_with_history(a: &Server, owner: &Account, name: &str) -> String {
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": name })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = a.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = a
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "before the move" }),
        )
        .await;
    assert_eq!(status, 200);
    guild_id
}

async fn open_guild_handoff(a: &Server, token: &str, guild_id: &str) -> (u16, Value) {
    a.post(
        "/_telium/v1/migrate/handoff",
        Some(token),
        json!({ "destination": "b.test", "subject_type": "guild", "subject_id": guild_id }),
    )
    .await
}

async fn accept_guild_handoff(b: &Server, token: &str, guild_id: &str, id: &str, secret: &str) -> (u16, Value) {
    b.post(
        "/_telium/v1/migrate/accept",
        Some(token),
        json!({
            "subject_type": "guild", "source": "a.test", "source_id": guild_id,
            "handoff": { "id": id, "secret": secret },
        }),
    )
    .await
}

async fn start_guild_from_handoff(
    a: &Server,
    owner: &Account,
    guild_id: &str,
    id: &str,
    password: &str,
) -> (u16, Value) {
    let (status, grant) = a
        .post(
            "/_telium/v1/migrate/grant-payload",
            Some(&owner.token),
            json!({ "subject_type": "guild", "subject_id": guild_id, "destination": "b.test", "handoff_id": id }),
        )
        .await;
    if status != 200 {
        return (status, grant);
    }
    let payload = telium_server::util::unb64(grant["payload"].as_str().unwrap()).unwrap();
    let signature = device_sign(&owner.secret, &payload);
    a.post(
        "/_telium/v1/migrate",
        Some(&owner.token),
        json!({
            "subject_type": "guild", "subject_id": guild_id, "destination": "b.test", "handoff_id": id,
            "password": password, "device_signature": signature,
            "created_at": grant["created_at"],
        }),
    )
    .await
}

#[tokio::test]
async fn a_guild_moves_without_anybody_copying_a_code() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let guild_id = guild_with_history(&a, &owner, "Movers").await;
    let landing = register_full(&b, "owner").await;

    let (status, opened) = open_guild_handoff(&a, &owner.token, &guild_id).await;
    assert_eq!(status, 200, "{opened}");
    assert_eq!(opened["subject_type"], "guild");
    assert_eq!(opened["source_id"], guild_id.as_str());
    let id = opened["id"].as_str().unwrap().to_string();
    let secret = opened["secret"].as_str().unwrap().to_string();

    let (status, accepted) = accept_guild_handoff(&b, &landing.token, &guild_id, &id, &secret).await;
    assert_eq!(status, 200, "{accepted}");
    assert_eq!(accepted["delivered"], true);
    assert_eq!(accepted["subject_type"], "guild");
    assert!(accepted.get("import_token").is_none(), "the claim went to the source, not the browser: {accepted}");

    let (_, delivered) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&owner.token)).await;
    assert_eq!(delivered["state"], "delivered");
    assert_eq!(delivered["target_id"], "@owner:b.test", "the owner is shown who will own it there");
    assert_eq!(delivered["subject_id"], guild_id.as_str());

    let (status, body) = start_from_handoff(&a, &owner, &id, "correct horse battery").await;
    assert_eq!(status, 403, "a guild's handoff is not an account's: {body}");

    let (status, body) = start_guild_from_handoff(&a, &owner, &guild_id, &id, "wrong horse battery").await;
    assert_eq!(status, 401, "{body}");
    let (status, started) = start_guild_from_handoff(&a, &owner, &guild_id, &id, "correct horse battery").await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["subject_type"], "guild");
    let migration_id = started["id"].as_str().unwrap().to_string();
    let (_, used) = a.get(&format!("/_telium/v1/migrate/handoff/{id}"), Some(&owner.token)).await;
    assert_eq!(used["state"], "used");
    assert_eq!(used["migration_id"], migration_id.as_str());

    let (status, done) = a
        .post(&format!("/_telium/v1/migrate/{migration_id}/execute"), Some(&owner.token), json!({}))
        .await;
    assert_eq!(status, 200, "{done}");
    let new_guild = done["new_id"].as_str().unwrap().to_string();
    let (_, old_status) = a.get(&format!("/_telium/v1/guilds/{guild_id}/status"), None).await;
    assert_eq!(old_status["moved_to"], new_guild);

    let owner_there: String = sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
        .bind(&new_guild)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(owner_there, "@owner:b.test");
    let (status, session_b) = b.post("/_telium/v1/sessions/local", Some(&landing.token), json!({})).await;
    assert_eq!(status, 200, "{session_b}");
    let session_b = session_b["session_token"].as_str().unwrap().to_string();
    let (_, channels) = b.get(&format!("/_telium/v1/guilds/{new_guild}/channels"), Some(&session_b)).await;
    let new_channel = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, history) = b.get(&format!("/_telium/v1/channels/{new_channel}/messages"), Some(&session_b)).await;
    assert_eq!(history["messages"][0]["content"], "before the move");

    let (status, body) = open_guild_handoff(&a, &owner.token, &guild_id).await;
    assert_eq!(status, 409, "{body}");
}

#[tokio::test]
async fn a_guild_handoff_is_the_owners_and_for_one_guild() {
    let (a, b) = pair_with_delay(3600).await;
    let owner = register_full(&a, "owner").await;
    let mallory = register_full(&a, "mallory").await;
    let guild_id = guild_with_history(&a, &owner, "Movers").await;
    let second_guild = guild_with_history(&a, &owner, "Other").await;
    let landing = register_full(&b, "owner").await;

    let (status, body) = open_guild_handoff(&a, &mallory.token, &guild_id).await;
    assert_eq!(status, 403, "only the owner opens a guild's handoff: {body}");
    let (status, body) = open_guild_handoff(&a, &owner.token, "01NOSUCHGUILD0000000000000").await;
    assert_eq!(status, 404, "{body}");

    let (status, opened) = open_guild_handoff(&a, &owner.token, &guild_id).await;
    assert_eq!(status, 200, "{opened}");
    let id = opened["id"].as_str().unwrap().to_string();
    let secret = opened["secret"].as_str().unwrap().to_string();

    let (status, body) = accept_guild_handoff(&b, &landing.token, &second_guild, &id, &secret).await;
    assert_eq!(status, 403, "a handoff is for the guild it was opened for: {body}");
    assert_eq!(live_claims(&b).await, 0);
    let (status, body) = accept_handoff(&b, &landing.token, "@owner:a.test", &id, &secret).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(live_claims(&b).await, 0);

    let (status, body) = accept_guild_handoff(&b, &landing.token, &guild_id, &id, &secret).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = accept_guild_handoff(&b, &landing.token, &guild_id, &id, &secret).await;
    assert_eq!(status, 409, "a delivered handoff does not take a second claim: {body}");
    assert_eq!(live_claims(&b).await, 1);

    let (status, body) = start_guild_from_handoff(&a, &owner, &second_guild, &id, "correct horse battery").await;
    assert_eq!(status, 403, "a handoff for one guild does not move another: {body}");
    let (status, body) = start_guild_from_handoff(&a, &mallory, &guild_id, &id, "correct horse battery").await;
    assert_eq!(status, 404, "somebody else's handoff: {body}");
    let (status, body) = a
        .post(
            "/_telium/v1/migrate",
            Some(&mallory.token),
            json!({
                "subject_type": "guild", "subject_id": guild_id, "destination": "b.test", "handoff_id": id,
                "password": "correct horse battery", "device_signature": "x", "created_at": now_ms(),
            }),
        )
        .await;
    assert_eq!(status, 403, "only the owner may move a guild: {body}");

    let (status, started) = start_guild_from_handoff(&a, &owner, &guild_id, &id, "correct horse battery").await;
    assert_eq!(status, 200, "{started}");
    let migration = started["id"].as_str().unwrap().to_string();
    a.post(&format!("/_telium/v1/migrate/{migration}/cancel"), Some(&owner.token), json!({})).await;
    let (status, body) = start_guild_from_handoff(&a, &owner, &guild_id, &id, "correct horse battery").await;
    assert_eq!(status, 409, "a spent handoff starts nothing: {body}");
}
