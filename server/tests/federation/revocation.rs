use super::*;

#[tokio::test]
async fn the_discovery_document_names_the_web_client() {
    let (a, b) = pair_tuned(0, &|cfg: &mut Config| {
        if cfg.server_name == "b.test" {
            cfg.web.client_url = Some("https://chat.b.example/".into());
        }
    })
    .await;
    let (_, doc) = b.get("/.well-known/telium/server", None).await;
    assert_eq!(doc["client"], "https://chat.b.example");
    let (_, doc) = a.get("/.well-known/telium/server", None).await;
    assert!(doc["client"].is_null(), "a headless server offers no page to send anybody to: {doc}");
}

async fn until_refused(server: &Server, session: &str) {
    for _ in 0..80 {
        let (status, _) = server.get("/_telium/v1/guilds", Some(session)).await;
        if status == 401 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("the guild session outlived its revocation");
}

async fn close_code(ws: &mut Ws) -> u16 {
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), futures_util::StreamExt::next(ws)).await {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Close(Some(frame))))) => {
                return u16::from(frame.code)
            }
            Ok(Some(Ok(_))) => continue,
            other => panic!("expected the connection to be closed, got {other:?}"),
        }
    }
}

async fn member_elsewhere(a: &Server, guild_server: &Server, alice: &Account) -> (String, String) {
    let session = a.session_on(&alice.token, guild_server).await;
    let (status, guild) =
        guild_server.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Elsewhere" })).await;
    assert_eq!(status, 200, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    eventually(a, "/_telium/v1/memberships", &alice.token, |body| {
        body["memberships"].as_array().is_some_and(|m| m.iter().any(|r| r["guild_id"] == guild_id.as_str()))
    })
    .await;
    (session, guild_id)
}

#[tokio::test]
async fn a_revoked_device_loses_its_guild_sessions_at_once() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let (laptop, _) = member_elsewhere(&a, &b, &alice).await;

    let (status, login) = a
        .post("/_telium/v1/login", None, json!({ "user": "alice", "password": "correct horse battery" }))
        .await;
    assert_eq!(status, 200, "{login}");
    let phone_token = login["access_token"].as_str().unwrap().to_string();
    let (_, me) = a.get("/_telium/v1/whoami", Some(&phone_token)).await;
    let phone_device = me["device_id"].as_str().unwrap().to_string();
    let phone = a.session_on(&phone_token, &b).await;
    assert_eq!(b.get("/_telium/v1/guilds", Some(&phone)).await.0, 200);
    let mut phone_ws = gateway(&b, &phone).await;

    let (status, _) = a.delete(&format!("/_telium/v1/devices/{phone_device}"), &alice.token).await;
    assert_eq!(status, 200);
    until_refused(&b, &phone).await;
    assert_eq!(close_code(&mut phone_ws).await, 4004, "the phone's socket is closed as well");
    assert_eq!(b.get("/_telium/v1/guilds", Some(&laptop)).await.0, 200, "the laptop is not the phone");

    let delivered: Option<i64> = sqlx::query_scalar(
        "SELECT delivered_at FROM identity_notices WHERE user_id = '@alice:a.test' AND guild_server = 'b.test'",
    )
    .fetch_one(&a.state.pool)
    .await
    .unwrap();
    assert!(delivered.is_some(), "the notice is recorded as delivered");

    let replay = telium_server::revocation::body("@alice:a.test", "device", Some(&phone_device), None);
    let said = telium_server::federation::post_signed(&a.state, "b.test", "/_telium/v1/users/@alice:a.test/revoked", &replay)
        .await
        .unwrap();
    assert_eq!(said["dropped"], 0, "{said}");
    assert_eq!(b.get("/_telium/v1/guilds", Some(&laptop)).await.0, 200);
}

#[tokio::test]
async fn a_deactivated_account_is_dropped_by_its_guild_servers_at_once() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let (session, _) = member_elsewhere(&a, &b, &alice).await;

    let (status, body) = a
        .post(
            "/_telium/v1/account/deactivate",
            Some(&alice.token),
            json!({ "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    until_refused(&b, &session).await;
}

#[tokio::test]
async fn a_move_is_announced_to_guild_servers_and_checked_before_it_is_applied() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let (session, guild_id) = member_elsewhere(&a, &c, &alice).await;

    let newcomer = register_full(&b, "alice2").await;
    let done = move_user(&a, &b, &alice, &newcomer.token, "@alice:a.test").await;
    assert_eq!(done["new_id"], "@alice2:b.test");

    until_refused(&c, &session).await;
    let session_new = b.session_on(&newcomer.token, &c).await;
    let ids = member_ids(&c, &guild_id, &session_new).await;
    assert!(ids.contains(&"@alice2:b.test".to_string()), "membership did not follow: {ids:?}");
    assert!(!ids.contains(&"@alice:a.test".to_string()), "the old id lingered: {ids:?}");
}

#[tokio::test]
async fn only_an_accounts_home_can_revoke_it() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    let (session, guild_id) = member_elsewhere(&a, &b, &alice).await;
    let path = "/_telium/v1/users/@alice:a.test/revoked";

    for kind in ["all_devices", "deactivated", "deleted"] {
        let notice = telium_server::revocation::body("@alice:a.test", kind, None, None);
        let err = telium_server::federation::post_signed(&c.state, "b.test", path, &notice).await.unwrap_err();
        assert!(matches!(err, telium_server::error::ApiError::Forbidden(_)), "{kind}: {err}");
    }

    let err = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        "/_telium/v1/users/@carol:c.test/revoked",
        &telium_server::revocation::body("@carol:c.test", "all_devices", None, None),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, telium_server::error::ApiError::Forbidden(_)), "{err}");

    let notice = telium_server::revocation::body("@alice:a.test", "all_devices", None, None);
    let bytes = serde_json::to_vec(&notice).unwrap();
    let header = telium_server::federation::auth_header(&c.state.key, "POST", path, &bytes, "a.test", "b.test");
    let resp = b
        .client
        .post(format!("{}{path}", b.base))
        .header("authorization", header)
        .header("content-type", "application/json")
        .body(bytes)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "a forged origin is refused");

    let err = telium_server::federation::post_signed(
        &a.state,
        "b.test",
        path,
        &telium_server::revocation::body("@other:a.test", "all_devices", None, None),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, telium_server::error::ApiError::BadRequest(_)), "{err}");

    let moved = telium_server::revocation::body("@alice:a.test", "moved", None, Some("@alice2:c.test"));
    let err = telium_server::federation::post_signed(&a.state, "b.test", path, &moved).await.unwrap_err();
    assert!(format!("{err}").contains("does not say it moved"), "{err}");
    let deactivated = telium_server::revocation::body("@alice:a.test", "deactivated", None, None);
    let said = telium_server::federation::post_signed(&a.state, "b.test", path, &deactivated).await.unwrap();
    assert_eq!(said["dropped"], 0, "an account its home calls active keeps its sessions: {said}");

    assert_eq!(b.get("/_telium/v1/guilds", Some(&session)).await.0, 200, "nothing above ended the session");
    let ids = member_ids(&b, &guild_id, &session).await;
    assert!(ids.contains(&"@alice:a.test".to_string()), "nothing was rewritten: {ids:?}");
}

#[tokio::test]
async fn one_origin_cannot_flood_a_guild_server_with_notices() {
    let (a, _b) = pair().await;
    let path = "/_telium/v1/users/@nobody:a.test/revoked";
    let notice = telium_server::revocation::body("@nobody:a.test", "all_devices", None, None);
    let mut limited = None;
    for i in 0..(telium_server::revocation::NOTICE_BURST as usize + 10) {
        match telium_server::federation::post_signed(&a.state, "b.test", path, &notice).await {
            Ok(_) => {}
            Err(e) => {
                limited = Some((i, e));
                break;
            }
        }
    }
    let (i, err) = limited.expect("the notices were never limited");
    assert!(i >= telium_server::revocation::NOTICE_BURST as usize - 1, "limited too early, at {i}: {err}");
    assert!(format!("{err}").contains("too many identity notices"), "{err}");
}
