use super::*;

#[tokio::test]
async fn guild_lifecycle_and_messages() {
    let s = start().await;
    let alice = s.user("alice").await;

    let (status, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Test Guild" })).await;
    assert_eq!(status, 200, "{guild}");
    let gid = guild["id"].as_str().unwrap().to_string();
    assert_eq!(guild["owner"], alice.user_id.as_str());
    assert_eq!(guild["member_count"], 1);

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, roles) = s.get(&format!("/_telium/v1/guilds/{gid}/roles"), Some(&alice.token)).await;
    assert_eq!(roles["roles"][0]["id"], gid.as_str());

    let (status, msg) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": "hello world" }),
        )
        .await;
    assert_eq!(status, 200, "{msg}");
    let mid = msg["id"].as_str().unwrap().to_string();

    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert_eq!(history["messages"].as_array().unwrap().len(), 1);
    assert_eq!(history["messages"][0]["content"], "hello world");

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/channels/{cid}/messages/{mid}"),
            &alice.token,
            json!({ "content": "hello, world" }),
        )
        .await;
    assert_eq!(status, 200);

    let (status, _) = s
        .delete(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token)
        .await;
    assert_eq!(status, 200);
    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert!(history["messages"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_send_repeated_under_the_same_nonce_happens_once() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/channels/{cid}/messages");
    let mut ws = connect_watching(&s, &bob.token, &["GUILD_MESSAGES"]).await;

    let body = json!({ "content": "did that send?", "nonce": "retry-abcdef01" });
    let (status, first) = s.post(&path, Some(&alice.token), body.clone()).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(wait_for(&mut ws, "MESSAGE_CREATE").await["d"]["content"], "did that send?");
    let (status, again) = s.post(&path, Some(&alice.token), body).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["id"], first["id"], "a repeat must answer with the original message");

    let (_, other) = s
        .post(&path, Some(&alice.token), json!({ "content": "did that send?", "nonce": "retry-abcdef02" }))
        .await;
    assert_ne!(other["id"], first["id"]);
    assert_eq!(wait_for(&mut ws, "MESSAGE_CREATE").await["d"]["id"], other["id"], "a repeat was re-broadcast");
    let (_, history) = s.get(&path, Some(&alice.token)).await;
    assert_eq!(history["messages"].as_array().unwrap().len(), 2, "{history}");

    for bad in ["short", "has a space in it"] {
        let (status, _) = s.post(&path, Some(&alice.token), json!({ "content": "x", "nonce": bad })).await;
        assert_eq!(status, 400, "nonce {bad:?} was accepted");
    }

    s.patch(&format!("/_telium/v1/channels/{cid}"), &alice.token, json!({ "slowmode": 30 })).await;
    let body = json!({ "content": "one every thirty seconds", "nonce": "retry-def01234" });
    let (_, first) = s.post(&path, Some(&bob.token), body.clone()).await;
    let (status, again) = s.post(&path, Some(&bob.token), body).await;
    assert_eq!(status, 200, "a retry was read as a second message: {again}");
    assert_eq!(again["id"], first["id"]);
    let (status, _) =
        s.post(&path, Some(&bob.token), json!({ "content": "again", "nonce": "retry-ef012345" })).await;
    assert_eq!(status, 429);
}

#[tokio::test]
async fn a_message_deleted_before_the_archive_ran_comes_back_from_it_empty() {
    let s = start_with(|cfg| {
        cfg.archive.horizon_days = 0;
        cfg.archive.keep_hot_messages = 1;
    })
    .await;
    let alice = s.user("alice").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Cold" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let mut ids = Vec::new();
    for body in ["first", "the one that gets taken back", "third", "newest"] {
        let (status, msg) = s
            .post(
                &format!("/_telium/v1/channels/{cid}/messages"),
                Some(&alice.token),
                json!({ "content": body }),
            )
            .await;
        assert_eq!(status, 200, "{msg}");
        ids.push(msg["id"].as_str().unwrap().to_string());
    }

    let (status, _) = s
        .delete(&format!("/_telium/v1/channels/{cid}/messages/{}", ids[1]), &alice.token)
        .await;
    assert_eq!(status, 200);

    let moved = telium_server::cold::archive_channel(&s.state, &cid, 100).await.unwrap();
    assert!(moved > 1, "nothing was archived, so this proves nothing");

    let cold = telium_server::cold::page_before(&s.state, &cid, &ids[3], 50).await.unwrap();
    let taken = cold
        .iter()
        .find(|m| m["id"] == ids[1].as_str())
        .expect("the deleted message's row should still be in the segment -- the id has to keep meaning something");

    assert_eq!(taken["content"], "", "scrollback handed back the text of a deleted message");
    assert_eq!(taken["attachments"], json!([]), "scrollback handed back a deleted message's attachments");
    assert!(taken["sticker"].is_null(), "scrollback handed back a deleted message's sticker");
    assert_eq!(taken["deleted"], true, "the segment lost the fact that it was deleted");

    let kept = cold.iter().find(|m| m["id"] == ids[0].as_str()).expect("the first message went cold too");
    assert_eq!(kept["content"], "first");
}

#[tokio::test]
async fn only_the_owner_deletes_a_guild_and_it_leaves_a_tombstone() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Doomed" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, _) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200);

    let (_, channels) =
        s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": "last words" }),
        )
        .await;
    assert_eq!(status, 200);

    let (status, body) = s.delete(&format!("/_telium/v1/guilds/{gid}"), &bob.token).await;
    assert_eq!(status, 403, "{body}");

    let (status, body) = s.post(&format!("/_telium/v1/guilds/{gid}/leave"), Some(&alice.token), json!({})).await;
    assert_eq!(status, 400, "{body}");

    let (status, body) = s.delete(&format!("/_telium/v1/guilds/{gid}"), &alice.token).await;
    assert_eq!(status, 200, "{body}");

    let (status, _) = s.get(&format!("/_telium/v1/guilds/{gid}"), Some(&alice.token)).await;
    assert!(matches!(status, 403 | 404), "guild: {status}");
    let (status, _) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    assert!(matches!(status, 403 | 404), "channels: {status}");
    let (status, _) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert!(matches!(status, 403 | 404), "messages: {status}");
    let (_, mine) = s.get("/_telium/v1/guilds", Some(&bob.token)).await;
    assert!(mine["guilds"].as_array().unwrap().is_empty(), "{mine}");

    let (status, _) = s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_ne!(status, 200);
    let (status, status_body) = s.get(&format!("/_telium/v1/guilds/{gid}/status"), None).await;
    assert_eq!(status, 200, "{status_body}");
    assert_eq!(status_body["status"], "gone");
    assert_eq!(status_body["tombstone"]["name"], "Doomed");

    let (_, unknown) = s.get("/_telium/v1/guilds/01ABCDEF/status", None).await;
    assert_eq!(unknown["status"], "unknown");
}

#[tokio::test]
async fn permissions_are_enforced_and_invisible_channels_are_not_hinted_at() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();

    let (status, preview) = s.get(&format!("/_telium/v1/invites/{code}"), None).await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["guild"]["name"], "Guild");

    let (status, joined) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{joined}");

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let (status, _) = s.patch(&format!("/_telium/v1/guilds/{gid}"), &bob.token, json!({ "name": "Mine" })).await;
    assert_eq!(status, 403);

    let deny = (1u64 << 0).to_string();
    let (status, _) = s
        .client
        .put(format!("{}/_telium/v1/channels/{cid}/overwrites/role/{gid}", s.base))
        .bearer_auth(&alice.token)
        .json(&json!({ "allow": "0", "deny": deny }))
        .send()
        .await
        .map(|r| (r.status().as_u16(), ()))
        .unwrap();
    assert_eq!(status, 200);

    let (status, _) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token)).await;
    assert_eq!(status, 404, "an invisible channel must 404, never 403");

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    assert!(channels["channels"].as_array().unwrap().is_empty());

    let (status, _) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn invite_links_name_the_server_on_the_portal() {
    let s = start_with(|cfg| cfg.web.invite_portal = "https://portal.example".into()).await;
    let alice = s.user("alice").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    assert_eq!(guild["invite_portal"], "https://portal.example");
    assert!(guild["vanity_url"].is_null());

    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    assert_eq!(
        invite["url"],
        format!("https://portal.example/invite/{code}@test.example")
    );

    let (_, caps) = s.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["invite_portal"], "https://portal.example");

    // An old-format link landing on the server upgrades itself to the portal form.
    let no_redirect = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let resp = no_redirect
        .get(format!("{}/invite/{code}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 303, "old links upgrade, they do not break");
    assert_eq!(
        resp.headers().get("location").unwrap().to_str().unwrap(),
        format!("https://portal.example/invite/{code}@test.example")
    );

    // The token is attacker-shaped input off the URL: it is re-encoded, never passed through.
    let resp = no_redirect
        .get(format!("{}/invite/ab%3Fc", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 303);
    assert_eq!(
        resp.headers().get("location").unwrap().to_str().unwrap(),
        "https://portal.example/invite/ab%3Fc@test.example"
    );
}

#[tokio::test]
async fn invite_portal_self_keeps_links_on_the_server() {
    let s = start_with(|cfg| cfg.web.invite_portal = "self".into()).await;
    let alice = s.user("alice").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    assert!(guild["invite_portal"].is_null());

    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{}/invites", guild["id"].as_str().unwrap()), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    assert_eq!(invite["url"], format!("{}/invite/{code}", s.base));

    let (_, caps) = s.get("/_telium/v1/capabilities", None).await;
    assert!(caps["invite_portal"].is_null());

    // No redirect route is registered, and with no web dir there is nothing to fall through to.
    let (status, _) = s.get("/invite/whatever", None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_moderator_may_delete_but_never_rewrite() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "hi" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let (status, _) = s
        .patch(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token, json!({ "content": "no" }))
        .await;
    assert_eq!(status, 403, "even the owner may not edit someone else's words");

    let (status, _) = s.delete(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token).await;
    assert_eq!(status, 200);

    let (_, log) = s.get(&format!("/_telium/v1/guilds/{gid}/audit-log"), Some(&alice.token)).await;
    assert!(log["entries"].as_array().unwrap().iter().any(|e| e["action"] == "message.delete"));
}

#[tokio::test]
async fn history_reads_oldest_first_however_it_was_paged() {
    let (s, alice, _bob, _gid, cid) = social_fixture().await;
    for i in 0..12 {
        s.post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": format!("m{i}") }),
        )
        .await;
    }

    let (_, tail) = s
        .get(&format!("/_telium/v1/channels/{cid}/messages?limit=5"), Some(&alice.token))
        .await;
    let tail = tail["messages"].as_array().unwrap().clone();
    assert_eq!(tail.len(), 5);
    assert_eq!(tail.first().unwrap()["content"], "m7");
    assert_eq!(tail.last().unwrap()["content"], "m11");

    let cursor = tail.first().unwrap()["id"].as_str().unwrap().to_string();
    let (_, older) = s
        .get(
            &format!("/_telium/v1/channels/{cid}/messages?before={cursor}&limit=5"),
            Some(&alice.token),
        )
        .await;
    let older = older["messages"].as_array().unwrap().clone();
    assert_eq!(older.first().unwrap()["content"], "m2");
    assert_eq!(older.last().unwrap()["content"], "m6");

    let (_, newer) = s
        .get(
            &format!("/_telium/v1/channels/{cid}/messages?after={cursor}&limit=3"),
            Some(&alice.token),
        )
        .await;
    let newer = newer["messages"].as_array().unwrap().clone();
    assert_eq!(newer.first().unwrap()["content"], "m8");
    assert_eq!(newer.last().unwrap()["content"], "m10");
}

#[tokio::test]
async fn a_role_ping_is_one_row_and_a_permission() {
    let (s, alice, bob, gid, cid) = social_fixture().await;

    let (status, role) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/roles"),
            Some(&alice.token),
            json!({ "name": "oncall", "permissions": ["VIEW_CHANNEL"] }),
        )
        .await;
    assert_eq!(status, 200, "{role}");
    let rid = role["id"].as_str().unwrap().to_string();

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/members/{}", bob.user_id),
            &alice.token,
            json!({ "add_roles": [rid] }),
        )
        .await;
    assert_eq!(status, 200);

    s.post(
        &format!("/_telium/v1/channels/{cid}/messages"),
        Some(&alice.token),
        json!({ "content": format!("<@&{rid}> deploy is out") }),
    )
    .await;

    let (_, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&bob.token)).await;
    assert_eq!(state["channels"][0]["mentions"], 1, "a role ping reaches its holders: {state}");

    let (_, hers) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&alice.token)).await;
    assert_eq!(hers["channels"][0]["mentions"], 0);

    let (status, sent) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&bob.token),
            json!({ "content": format!("<@&{rid}> anyone about?") }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
    let (_, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&bob.token)).await;
    assert_eq!(state["channels"][0]["mentions"], 1, "no second mention was recorded");

    let (status, updated) = s
        .patch(
            &format!("/_telium/v1/guilds/{gid}/roles/{rid}"),
            &alice.token,
            json!({ "mentionable": true, "hoist": true }),
        )
        .await;
    assert_eq!(status, 200, "{updated}");
    assert_eq!(updated["mentionable"], true);
    assert_eq!(updated["hoist"], true, "hoist used to be accepted and dropped");

    s.post(
        &format!("/_telium/v1/channels/{cid}/messages"),
        Some(&bob.token),
        json!({ "content": format!("<@&{rid}> now?") }),
    )
    .await;
    let (_, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&bob.token)).await;
    assert_eq!(state["channels"][0]["mentions"], 2);
}

#[tokio::test]
async fn a_guild_payload_says_what_the_caller_may_do() {
    let (s, alice, bob, gid, _cid) = social_fixture().await;

    let (status, mine) = s.get(&format!("/_telium/v1/guilds/{gid}"), Some(&alice.token)).await;
    assert_eq!(status, 200, "{mine}");
    assert_eq!(mine["me"]["is_owner"], true);
    assert_eq!(mine["me"]["permissions"], u64::MAX.to_string());
    assert_eq!(mine["roles"][0]["id"], gid.as_str(), "@everyone is a role like any other");

    let (_, theirs) = s.get(&format!("/_telium/v1/guilds/{gid}"), Some(&bob.token)).await;
    assert_eq!(theirs["me"]["is_owner"], false);
    let bits: u64 = theirs["me"]["permissions"].as_str().unwrap().parse().unwrap();
    assert!(bits & (1 << 1) != 0, "@everyone can speak");
    assert!(bits & (1 << 7) == 0, "@everyone cannot manage the guild");
}

#[tokio::test]
async fn a_guild_address_is_one_name_case_folded_bounded_and_partly_reserved() {
    let s = start().await;
    let alice = s.user("alice").await;

    let (status, guild) = s
        .post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G", "alias": "Gaming" }))
        .await;
    assert_eq!(status, 200, "{guild}");
    assert_eq!(guild["alias"], "#gaming:test.example");

    for taken in ["gaming", "GAMING", "  Gaming  "] {
        let (status, body) = s
            .post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G2", "alias": taken }))
            .await;
        assert_eq!(status, 409, "{taken:?} is the name that is already taken: {body}");
    }

    for reserved in ["admin", "Support", "everyone", "telium", ".", ".."] {
        let (status, body) = s
            .post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G3", "alias": reserved }))
            .await;
        assert_eq!(status, 409, "{reserved:?} must be reserved: {body}");
    }
    for bad in ["with space", "slash/es", "emoji\u{1f600}", &"x".repeat(33), ""] {
        let (status, body) = s
            .post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G4", "alias": bad }))
            .await;
        assert_eq!(status, 400, "{bad:?} must not be a guild address: {body}");
    }
}

#[tokio::test]
async fn a_renamed_or_disabled_guild_releases_its_old_vanity_name() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s
        .post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G", "alias": "games" }))
        .await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let (status, renamed) =
        s.put(&format!("/_telium/v1/guilds/{gid}/alias"), &alice.token, json!({ "alias": "GAMING" })).await;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["alias"], "#gaming:test.example");

    let (status, old) = s.get("/_telium/v1/guild-aliases/games", None).await;
    assert_eq!(status, 200, "{old}");
    assert_eq!(old["status"], "unknown", "the released name must stop resolving: {old}");
    assert!(old["signature"].is_string(), "even an unknown answer is signed: {old}");

    let (status, resolved) = s
        .get("/_telium/v1/guild-addresses/resolve?address=%23games%3Atest.example", None)
        .await;
    assert_eq!(status, 404, "the old address must not silently forward after a rename: {resolved}");

    let (status, now) = s.get("/_telium/v1/guild-aliases/gaming", None).await;
    assert_eq!(status, 200, "{now}");
    assert_eq!(now["status"], "active");
    assert_eq!(now["guild_id"], gid.as_str());

    let (status, other) = s
        .post("/_telium/v1/guilds", Some(&bob.token), json!({ "name": "Other", "alias": "games" }))
        .await;
    assert_eq!(status, 200, "a released vanity may be reused: {other}");
    assert_eq!(other["alias"], "#games:test.example");

    let (status, cleared) = s.delete(&format!("/_telium/v1/guilds/{gid}/alias"), &alice.token).await;
    assert_eq!(status, 200, "{cleared}");
    assert_eq!(cleared["alias"], Value::Null);

    sqlx::query(
        "INSERT INTO guild_alias_redirects (alias, guild_id, to_origin, to_guild_id, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind("gaming")
    .bind(&gid)
    .bind("test.example")
    .bind(&gid)
    .bind(1_i64)
    .execute(&s.state.pool)
    .await
    .unwrap();
    let (_, disabled) = s.get("/_telium/v1/guild-aliases/gaming", None).await;
    assert_eq!(disabled["status"], "unknown", "disabling must kill the live vanity: {disabled}");

    let (status, never) = s.get("/_telium/v1/guild-aliases/nobody-ever", None).await;
    assert_eq!(status, 200, "{never}");
    assert_eq!(never["status"], "unknown");
}

#[tokio::test]
async fn setting_a_guild_address_is_a_managers_act_and_a_loop_is_refused() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (status, _) =
        s.put(&format!("/_telium/v1/guilds/{gid}/alias"), &bob.token, json!({ "alias": "mine" })).await;
    assert_eq!(status, 403);
    let (status, _) = s.delete(&format!("/_telium/v1/guilds/{gid}/alias"), &bob.token).await;
    assert_eq!(status, 403);

    let (status, _) =
        s.put(&format!("/_telium/v1/guilds/{gid}/alias"), &alice.token, json!({ "alias": "mine" })).await;
    assert_eq!(status, 200);

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', ?, '{}', 1)",
    )
    .bind(&gid)
    .bind(&gid)
    .execute(&s.state.pool)
    .await
    .unwrap();

    let (status, body) = s
        .get("/_telium/v1/guild-addresses/resolve?address=%23mine%3Atest.example", Some(&alice.token))
        .await;
    assert_eq!(status, 409, "a circular address must be refused, not followed: {body}");

    let (status, _) = s
        .get("/_telium/v1/guild-addresses/resolve?address=%23nothing%3Atest.example", Some(&alice.token))
        .await;
    assert_eq!(status, 404);
    let (status, _) =
        s.get("/_telium/v1/guild-addresses/resolve?address=gaming", Some(&alice.token)).await;
    assert_eq!(status, 400);
}
