use super::*;

#[tokio::test]
async fn a_guilds_emoji_travels_only_as_far_as_that_guild_lets_it() {
    let (s, alice, bob, host, _host_channel) = social_fixture().await;
    let carol = s.user("carol").await;
    let (_, away) = s.post("/_telium/v1/guilds", Some(&bob.token), json!({ "name": "Away" })).await;
    let away_id = away["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{away_id}/invites"), Some(&bob.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, joined) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&carol.token), json!({})).await;
    assert_eq!(status, 200, "{joined}");
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{away_id}/channels"), Some(&bob.token)).await;
    let away_channel = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{away_channel}/messages"), Some(&bob.token), json!({ "content": "hi" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let data = URL_SAFE_NO_PAD.encode(png_fixture(16, 16));
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{host}/emojis"),
            Some(&alice.token),
            json!({ "name": "parrot", "data": data, "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    let eid = emoji["id"].as_str().unwrap().to_string();
    let elsewhere = format!("/_telium/v1/messages/{mid}/reactions/%3Cparrot%3A{eid}%3E/@me");

    assert_eq!(s.get(&format!("/_telium/v1/guilds/{host}"), Some(&alice.token)).await.1["emoji_export"]["policy"], "everyone");
    let (status, body) = s.put(&elsewhere, &carol.token, json!({})).await;
    assert_eq!(status, 200, "everyone means everyone: {body}");
    s.delete(&elsewhere, &carol.token).await;

    let (status, patched) = s
        .patch(&format!("/_telium/v1/guilds/{host}"), &alice.token, json!({ "emoji_export_policy": "members" }))
        .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["emoji_export"]["policy"], "members");
    let (status, body) = s.put(&elsewhere, &carol.token, json!({})).await;
    assert_eq!(status, 403, "a non-member must not carry the emoji out: {body}");

    let (status, body) = s.put(&elsewhere, &bob.token, json!({})).await;
    assert_eq!(status, 200, "a member carries his guild's emoji: {body}");

    let (_, host_channels) = s.get(&format!("/_telium/v1/guilds/{host}/channels"), Some(&alice.token)).await;
    let host_channel = host_channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, at_home) = s
        .post(&format!("/_telium/v1/channels/{host_channel}/messages"), Some(&alice.token), json!({ "content": "home" }))
        .await;
    let home_mid = at_home["id"].as_str().unwrap().to_string();
    let (status, body) = s
        .put(&format!("/_telium/v1/messages/{home_mid}/reactions/%3Cparrot%3A{eid}%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 200, "the owning guild's own channels are not 'elsewhere': {body}");
}

#[tokio::test]
async fn a_guild_can_gate_its_emoji_on_a_role_and_a_role_above_it() {
    let (s, alice, bob, host, _cid) = social_fixture().await;
    let (_, away) = s.post("/_telium/v1/guilds", Some(&bob.token), json!({ "name": "Away" })).await;
    let away_id = away["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{away_id}/invites"), Some(&bob.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&alice.token), json!({})).await;
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{away_id}/channels"), Some(&bob.token)).await;
    let away_channel = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{away_channel}/messages"), Some(&bob.token), json!({ "content": "hi" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let data = URL_SAFE_NO_PAD.encode(png_fixture(16, 16));
    let (_, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{host}/emojis"),
            Some(&alice.token),
            json!({ "name": "parrot", "data": data, "mime": "image/png" }),
        )
        .await;
    let eid = emoji["id"].as_str().unwrap().to_string();
    let elsewhere = format!("/_telium/v1/messages/{mid}/reactions/%3Cparrot%3A{eid}%3E/@me");

    for name in ["supporter", "regular"] {
        let (status, role) = s
            .post(&format!("/_telium/v1/guilds/{host}/roles"), Some(&alice.token), json!({ "name": name }))
            .await;
        assert_eq!(status, 200, "{role}");
    }
    let (_, roles) = s.get(&format!("/_telium/v1/guilds/{host}/roles"), Some(&alice.token)).await;
    let ranked: Vec<String> = roles["roles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["id"] != host.as_str())
        .map(|r| r["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ranked.len(), 2, "{roles}");
    let (above, floor) = (ranked[0].clone(), ranked[1].clone());

    let (status, body) = s
        .patch(&format!("/_telium/v1/guilds/{host}"), &alice.token, json!({ "emoji_export_policy": "role" }))
        .await;
    assert_eq!(status, 400, "'role' without a role is not a rule: {body}");
    let (status, body) = s
        .patch(
            &format!("/_telium/v1/guilds/{host}"),
            &alice.token,
            json!({ "emoji_export_policy": "role", "emoji_export_role_id": away_id }),
        )
        .await;
    assert_eq!(status, 400, "another guild's role is not this guild's to name: {body}");
    let (status, body) = s
        .patch(&format!("/_telium/v1/guilds/{host}"), &alice.token, json!({ "emoji_export_policy": "vips" }))
        .await;
    assert_eq!(status, 400, "{body}");

    let (status, patched) = s
        .patch(
            &format!("/_telium/v1/guilds/{host}"),
            &alice.token,
            json!({ "emoji_export_policy": "role", "emoji_export_role_id": floor }),
        )
        .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["emoji_export"]["role_id"], floor.as_str());

    let (status, body) = s.put(&elsewhere, &bob.token, json!({})).await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s.put(&elsewhere, &alice.token, json!({})).await;
    assert_eq!(status, 403, "the owner holds no role either: {body}");

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/guilds/{host}/members/{}", bob.user_id),
            &alice.token,
            json!({ "add_roles": [floor] }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, body) = s.put(&elsewhere, &bob.token, json!({})).await;
    assert_eq!(status, 200, "the named role is the floor: {body}");

    let (status, _) = s
        .patch(
            &format!("/_telium/v1/guilds/{host}/members/{}", alice.user_id),
            &alice.token,
            json!({ "add_roles": [above] }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, body) = s.put(&elsewhere, &alice.token, json!({})).await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn a_new_sticker_reaches_the_other_members_pickers() {
    let (s, alice, bob, gid, _cid) = social_fixture().await;
    let mut bobs = connect_watching(&s, &bob.token, &["GUILD_EXPRESSIONS"]).await;
    let picture = URL_SAFE_NO_PAD.encode(&png_fixture(64, 64));

    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "party", "data": picture.clone(), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    let seen = wait_for(&mut bobs, "GUILD_EMOJI_UPDATE").await;
    assert_eq!(seen["d"]["emoji"]["name"], "party", "{seen}");

    let (status, sticker) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/stickers"),
            Some(&alice.token),
            json!({ "name": "wave", "data": picture, "format": "png" }),
        )
        .await;
    assert_eq!(status, 200, "{sticker}");
    let seen = wait_for(&mut bobs, "GUILD_EMOJI_UPDATE").await;
    assert_eq!(seen["d"]["sticker"]["name"], "wave", "{seen}");
    assert_eq!(seen["d"]["sticker"]["id"], sticker["id"], "{seen}");
    assert_eq!(seen["d"]["guild_id"], gid.as_str(), "{seen}");
}
