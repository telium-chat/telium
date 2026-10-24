use super::*;

#[tokio::test]
async fn a_user_from_another_server_gets_a_guild_session_there() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;

    let session = a.session_on(&alice, &b).await;

    let (status, guild) = b
        .post("/_telium/v1/guilds", Some(&session), json!({ "name": "Cross-server" }))
        .await;
    assert_eq!(status, 200, "{guild}");
    let guild_id = guild["id"].as_str().unwrap().to_string();
    assert_eq!(guild["origin"], "b.test", "the guild lives on b.test");
    assert_eq!(guild["owner"], "@alice:a.test");

    let (status, channels) = b.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    assert_eq!(status, 200, "{channels}");
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let (status, msg) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "hello from a.test" }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    assert_eq!(msg["author"], "@alice:a.test");
}

#[tokio::test]
async fn a_defederated_domain_cannot_get_a_session() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let admin = b.register("root").await;
    b.elevate(&admin).await;

    let (status, _) = b
        .post(
            "/_telium/v1/admin/defederation",
            Some(&admin),
            json!({ "domain": "a.test", "scope": "all", "reason": "test" }),
        )
        .await;
    assert_eq!(status, 200);

    let (_, assertion) = a
        .post("/_telium/v1/assertions", Some(&alice), json!({ "audience": "b.test" }))
        .await;
    let (status, body) = b
        .post("/_telium/v1/sessions", None, json!({ "assertion": assertion["assertion"] }))
        .await;
    assert_eq!(status, 403, "defederation must refuse the session: {body}");

    let (status, _) = b.delete("/_telium/v1/admin/defederation/a.test", &admin).await;
    assert_eq!(status, 200);
    let (_, assertion) = a
        .post("/_telium/v1/assertions", Some(&alice), json!({ "audience": "b.test" }))
        .await;
    let (status, _) = b
        .post("/_telium/v1/sessions", None, json!({ "assertion": assertion["assertion"] }))
        .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_foreign_attachment_is_authorized_by_its_own_origin() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let session = a.session_on(&alice, &b).await;

    let reference = a.upload(&alice, b"pretend this is a png").await;
    assert_eq!(reference["origin"], "a.test");

    let (_, guild) = b.post("/_telium/v1/guilds", Some(&session), json!({ "name": "G" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = b.get(&format!("/_telium/v1/guilds/{guild_id}/channels"), Some(&session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let attachment = json!({
        "origin": reference["origin"], "hash": reference["hash"],
        "filename": reference["filename"], "mime": reference["mime"],
        "size": reference["size"], "capability": reference["capability"],
    });
    let (status, msg) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "look", "attachments": [attachment] }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");

    let mut forged = attachment.clone();
    forged["capability"] = json!("not-the-capability");
    let (status, body) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&session),
            json!({ "content": "sneaky", "attachments": [forged] }),
        )
        .await;
    assert_eq!(status, 403, "the origin must refuse an unauthorized reference: {body}");
}

#[tokio::test]
async fn foreign_media_is_cached_read_through_and_purged_on_delete() {
    let (a, b) = pair().await;
    let alice = a.register("alice").await;
    let session = a.session_on(&alice, &b).await;
    let reference = a.upload(&alice, b"bytes worth caching").await;
    let hash = reference["hash"].as_str().unwrap().to_string();
    let cap = reference["capability"].as_str().unwrap().to_string();

    let url = format!("{}/_telium/v1/media/remote/a.test/{hash}?cap={cap}", b.base);
    let resp = b.client.get(&url).bearer_auth(&session).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.bytes().await.unwrap().as_ref(), b"bytes worth caching");

    let resp = b.client.get(&url).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "the cached copy needs no round trip");

    let (status, _) = a.delete(&format!("/_telium/v1/media/{hash}"), &alice).await;
    assert_eq!(status, 200);
    for _ in 0..40 {
        let resp = b.client.get(&url).send().await.unwrap();
        if resp.status().as_u16() == 404 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("cached copy outlived the object at its origin");
}

async fn authorize_with(server: &Server, header: &str, body: &[u8]) -> u16 {
    server
        .client
        .post(format!("{}/_telium/v1/media/authorize", server.base))
        .header(reqwest::header::AUTHORIZATION, header)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_vec())
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn signed_requests_are_bound_to_their_destination() {
    let (a, b) = pair().await;
    let path = "/_telium/v1/media/authorize";
    let body = json!({ "hash": "nothing-by-this-name" }).to_string();
    let (status, refused) = b.post(path, None, json!({ "hash": "x" })).await;
    assert_eq!(status, 401, "unsigned federation requests are refused: {refused}");

    let sign = |method: &str, path: &str, origin: &str, destination: &str| {
        telium_server::federation::auth_header(&a.state.key, method, path, body.as_bytes(), origin, destination)
    };
    let good = sign("POST", path, "a.test", "b.test");
    assert_eq!(authorize_with(&b, &good, body.as_bytes()).await, 200, "the control case");
    let other = json!({ "hash": "something-else-entirely" }).to_string();
    assert_eq!(authorize_with(&b, &good, other.as_bytes()).await, 401, "a body swapped under the signature");
    for (what, header) in [
        ("addressed to a.test itself", sign("POST", path, "a.test", "a.test")),
        ("signed for another route", sign("POST", "/_telium/v1/report", "a.test", "b.test")),
        ("signed as a GET", sign("GET", path, "a.test", "b.test")),
        ("a.test's key claiming c.test", sign("POST", path, "c.test", "b.test")),
    ] {
        assert_eq!(authorize_with(&b, &header, body.as_bytes()).await, 401, "b.test accepted a request {what}");
    }
}

#[tokio::test]
async fn hostile_federation_envelopes_are_refused_and_do_not_take_the_server_with_them() {
    let (a, b) = pair().await;
    let path = "/_telium/v1/media/authorize";
    let body = json!({ "hash": "nothing-by-this-name" }).to_string();
    let valid = telium_server::federation::auth_header(&a.state.key, "POST", path, body.as_bytes(), "a.test", "b.test");
    let fed = |fields: &str| format!("X-Telium-Federation {fields}");
    let now = now_ms();
    let hostile = [
        String::new(),
        "Bearer deadbeef".into(),
        fed("garbage"),
        fed("origin=,destination=,key=,ts=,sig="),
        fed(&format!("origin=a.test,destination=b.test,key=k,ts={},sig=AAAA", i64::MIN)),
        fed("origin=a.test,destination=b.test,key=k,ts=tomorrow,sig=AAAA"),
        format!("{valid}!!!not base64!!!"),
        format!("{valid},signer=c.test,authority=**********"),
        format!("{valid},signer=c.test,authority={}", telium_server::util::b64(b"not json")),
        fed(&format!("origin=a.test,destination=b.test,destination=a.test,key=k,ts={now},sig=AAAA")),
        fed(&format!("origin=a.test,origin=c.test,destination=b.test,key=k,ts={now},sig=AAAA")),
        fed(&format!("origin={},destination=b.test,key=k,ts=0,sig=AAAA", "x".repeat(8000))),
        fed("origin=\u{202e}a.test,destination=b.test,key=k,ts=0,sig=AAAA"),
    ];
    for header in hostile {
        assert_ne!(authorize_with(&b, &header, body.as_bytes()).await, 200, "b.test accepted {header}");
    }
    assert_eq!(authorize_with(&b, &valid, body.as_bytes()).await, 200, "honest traffic after the hostile batch");
}
