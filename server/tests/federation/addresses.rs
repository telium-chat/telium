use super::*;

#[tokio::test]
async fn a_guild_address_crosses_servers_and_follows_the_guild_when_it_moves() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (status, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{session}");
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Movers" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (status, named) = a
        .put(&format!("/_telium/v1/guilds/{guild_id}/alias"), &session, json!({ "alias": "Movers" }))
        .await;
    assert_eq!(status, 200, "{named}");
    assert_eq!(named["alias"], "#movers:a.test", "the address is folded and qualified: {named}");

    let onlooker = register_full(&b, "onlooker").await;
    let (status, watcher) = b.post("/_telium/v1/sessions/local", Some(&onlooker.token), json!({})).await;
    assert_eq!(status, 200, "{watcher}");
    let watcher = watcher["session_token"].as_str().unwrap().to_string();
    let address = "/_telium/v1/guild-addresses/resolve?address=%23movers%3Aa.test";
    let (status, found) = b.get(address, Some(&watcher)).await;
    assert_eq!(status, 200, "{found}");
    assert_eq!(found["origin"], "a.test");
    assert_eq!(found["guild_id"], guild_id.as_str());
    assert_eq!(found["redirected"], false, "nothing has moved yet: {found}");
    assert_eq!(found["hops"], 0);

    let landing = register_full(&b, "owner").await;
    let (status, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&landing.token),
            json!({ "subject_type": "guild", "source": "a.test", "source_id": guild_id }),
        )
        .await;
    assert_eq!(status, 200, "{claim}");
    let import_token = claim["import_token"].as_str().unwrap().to_string();
    let created_at = now_ms();
    let payload = telium_server::migration::grant_payload(&guild_id, "b.test", &import_token, created_at);
    let signature = device_sign(&owner.secret, &payload);
    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&owner.token),
            json!({
                "subject_type": "guild", "subject_id": guild_id, "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": signature, "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    let id = started["id"].as_str().unwrap().to_string();
    let (status, done) =
        a.post(&format!("/_telium/v1/migrate/{id}/execute"), Some(&owner.token), json!({})).await;
    assert_eq!(status, 200, "{done}");
    let new_guild = done["new_id"].as_str().unwrap().to_string();

    let (status, old_name) = a.get("/_telium/v1/guild-aliases/movers", None).await;
    assert_eq!(status, 200, "{old_name}");
    assert_eq!(old_name["status"], "moved");
    assert_eq!(old_name["to"]["origin"], "b.test");
    assert_eq!(old_name["to"]["guild_id"], new_guild.as_str());
    assert_eq!(old_name["host"], "a.test", "a server's answer is only ever about itself");
    assert!(old_name["signature"].is_string(), "an address answer is signed: {old_name}");

    let (status, moved) = b.get(address, Some(&watcher)).await;
    assert_eq!(status, 200, "{moved}");
    assert_eq!(moved["origin"], "b.test");
    assert_eq!(moved["guild_id"], new_guild.as_str());
    assert_eq!(moved["redirected"], true, "{moved}");
    assert_eq!(moved["hops"], 1);

    let (status, from_home) = a.get(address, Some(&session)).await;
    assert_eq!(status, 200, "{from_home}");
    assert_eq!(from_home["origin"], "b.test");
    assert_eq!(from_home["guild_id"], new_guild.as_str());

    assert_eq!(moved["landed"], "#movers:b.test", "{moved}");
    let (status, direct) = b
        .get("/_telium/v1/guild-addresses/resolve?address=%23movers%3Ab.test", Some(&watcher))
        .await;
    assert_eq!(status, 200, "{direct}");
    assert_eq!(direct["guild_id"], new_guild.as_str());
    assert_eq!(direct["hops"], 0, "the new address is not a forward: {direct}");
}

#[tokio::test]
async fn vanity_links_are_opt_in_single_and_disable_cleanly() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (_, owner_session) =
        a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    let owner_session = owner_session["session_token"].as_str().unwrap().to_string();
    let (_, guild) =
        a.post("/_telium/v1/guilds", Some(&owner_session), json!({ "name": "Linux" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    assert!(guild["alias"].is_null(), "new guilds start with vanity links off: {guild}");

    let visitor = register_full(&b, "visitor").await;
    let visitor_session = b.session_on(&visitor.token, &a).await;

    let (status, body) = a
        .get(
            "/_telium/v1/guild-addresses/resolve?address=%23anything%3Ab.test",
            None,
        )
        .await;
    assert_eq!(status, 403, "a public resolver may not proxy an unrelated origin: {body}");

    let (status, body) = a
        .get(&format!("/_telium/v1/guilds/{guild_id}/join-preview"), None)
        .await;
    assert_eq!(status, 404, "a disabled vanity link has no public preview: {body}");
    let (status, body) = a
        .post(&format!("/_telium/v1/guilds/{guild_id}/join"), Some(&visitor_session), json!({}))
        .await;
    assert_eq!(status, 404, "a guild id alone cannot join while vanity is off: {body}");

    let (status, named) = a
        .put(
            &format!("/_telium/v1/guilds/{guild_id}/alias"),
            &owner_session,
            json!({ "alias": "LinuxCommunity" }),
        )
        .await;
    assert_eq!(status, 200, "{named}");
    assert_eq!(named["alias"], "#linuxcommunity:a.test");

    let (status, invite) = a
        .post(
            &format!("/_telium/v1/guilds/{guild_id}/invites"),
            Some(&owner_session),
            json!({}),
        )
        .await;
    assert_eq!(status, 200, "{invite}");
    assert!(
        invite["code"].as_str().is_some_and(|code| code.starts_with('~')),
        "new invite codes must be syntactically distinct from vanity names: {invite}"
    );

    sqlx::query(
        "INSERT INTO invites          (code, guild_id, channel_id, creator, uses, max_uses, expires_at, created_at)          VALUES ('legacycode', ?, NULL, ?, 0, NULL, NULL, ?)",
    )
    .bind(&guild_id)
    .bind(format!("@owner:{}", a.name))
    .bind(1_i64)
    .execute(&a.state.pool)
    .await
    .unwrap();

    let (_, collision_guild) = a
        .post(
            "/_telium/v1/guilds",
            Some(&owner_session),
            json!({ "name": "Collision" }),
        )
        .await;
    let collision_id = collision_guild["id"].as_str().unwrap();
    let (status, collision) = a
        .put(
            &format!("/_telium/v1/guilds/{collision_id}/alias"),
            &owner_session,
            json!({ "alias": "legacycode" }),
        )
        .await;
    assert_eq!(status, 409, "a live legacy invite keeps its /invite path: {collision}");

    let (status, preview) = a
        .get(&format!("/_telium/v1/guilds/{guild_id}/join-preview"), None)
        .await;
    assert_eq!(status, 200, "{preview}");
    assert_eq!(preview["address"], "#linuxcommunity:a.test");
    assert_eq!(preview["guild"]["id"], guild_id.as_str());

    let (status, joined) = a
        .post(&format!("/_telium/v1/guilds/{guild_id}/join"), Some(&visitor_session), json!({}))
        .await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["id"], guild_id.as_str());

    let (status, renamed) = a
        .put(
            &format!("/_telium/v1/guilds/{guild_id}/alias"),
            &owner_session,
            json!({ "alias": "kernel" }),
        )
        .await;
    assert_eq!(status, 200, "{renamed}");
    assert_eq!(renamed["alias"], "#kernel:a.test");
    let (_, old) = a.get("/_telium/v1/guild-aliases/linuxcommunity", None).await;
    assert_eq!(old["status"], "unknown", "the previous vanity address is dead after rename: {old}");
    let (_, current) = a.get("/_telium/v1/guild-aliases/kernel", None).await;
    assert_eq!(current["status"], "active", "{current}");

    let (_, second) =
        a.post("/_telium/v1/guilds", Some(&owner_session), json!({ "name": "Second" })).await;
    let second_id = second["id"].as_str().unwrap();
    let (status, reused) = a
        .put(
            &format!("/_telium/v1/guilds/{second_id}/alias"),
            &owner_session,
            json!({ "alias": "linuxcommunity" }),
        )
        .await;
    assert_eq!(status, 200, "a released local vanity name may be reused: {reused}");

    let (status, disabled) = a
        .delete(&format!("/_telium/v1/guilds/{guild_id}/alias"), &owner_session)
        .await;
    assert_eq!(status, 200, "{disabled}");
    assert!(disabled["alias"].is_null(), "{disabled}");
    let (_, old) = a.get("/_telium/v1/guild-aliases/kernel", None).await;
    assert_eq!(old["status"], "unknown", "disabling invalidates the live vanity address: {old}");

    let late = register_full(&b, "late").await;
    let late_session = b.session_on(&late.token, &a).await;
    let (status, body) = a
        .post(&format!("/_telium/v1/guilds/{guild_id}/join"), Some(&late_session), json!({}))
        .await;
    assert_eq!(status, 404, "disable takes effect for new joins immediately: {body}");
}

#[tokio::test]
async fn a_server_cannot_speak_for_another_servers_guild_through_an_address() {
    let (a, b) = pair().await;
    let owner = register_full(&a, "owner").await;
    let (_, session) = a.post("/_telium/v1/sessions/local", Some(&owner.token), json!({})).await;
    let session = session["session_token"].as_str().unwrap().to_string();
    let (_, guild) = a.post("/_telium/v1/guilds", Some(&session), json!({ "name": "Real" })).await;
    let guild_id = guild["id"].as_str().unwrap().to_string();
    let (status, named) =
        a.put(&format!("/_telium/v1/guilds/{guild_id}/alias"), &session, json!({ "alias": "real" })).await;
    assert_eq!(status, 200, "{named}");

    let mallory = register_full(&b, "mallory").await;
    let (_, session_b) = b.post("/_telium/v1/sessions/local", Some(&mallory.token), json!({})).await;
    let session_b = session_b["session_token"].as_str().unwrap().to_string();

    for (name, target) in [("borrowed", guild_id.as_str()), ("invented", "01HNEVERHELDHEREATALL00")] {
        sqlx::query(
            "INSERT INTO guild_alias_redirects (alias, guild_id, to_origin, to_guild_id, created_at) \
             VALUES (?, 'g-local', 'a.test', ?, 1)",
        )
        .bind(name)
        .bind(target)
        .execute(&b.state.pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO guilds (id, alias, name, owner_user_id, created_at) \
         VALUES (?, 'stolen', 'Imposter', '@mallory:b.test', 1)",
    )
    .bind(&guild_id)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let resolve = |address: &str| format!("/_telium/v1/guild-addresses/resolve?address={address}");

    let (status, borrowed) = b.get(&resolve("%23borrowed%3Ab.test"), Some(&session_b)).await;
    assert_eq!(status, 200, "{borrowed}");
    assert_eq!(borrowed["origin"], "a.test", "the holder answers for the guild: {borrowed}");
    assert_eq!(borrowed["guild_id"], guild_id.as_str());
    assert_eq!(
        borrowed["landed"], "#real:a.test",
        "the address it really goes by is the one its host gave it: {borrowed}"
    );

    let (status, invented) = b.get(&resolve("%23invented%3Ab.test"), Some(&session_b)).await;
    assert_eq!(status, 404, "a made-up forward must not resolve: {invented}");

    let (status, stolen) = b.get(&resolve("%23stolen%3Ab.test"), Some(&session_b)).await;
    assert_eq!(status, 200, "{stolen}");
    assert_eq!(stolen["origin"], "b.test", "b.test only ever answers as b.test: {stolen}");

    for (server, token) in [(&a, session.as_str()), (&b, session_b.as_str())] {
        let (status, real) = server.get(&resolve("%23real%3Aa.test"), Some(token)).await;
        assert_eq!(status, 200, "{real}");
        assert_eq!(real["origin"], "a.test", "nothing b.test wrote moved the guild: {real}");
        assert_eq!(real["guild_id"], guild_id.as_str());
        assert_eq!(real["redirected"], false);
    }
}

#[tokio::test]
async fn an_address_that_forwards_in_a_circle_between_servers_is_refused() {
    let (a, b) = pair().await;
    let reader = register_full(&a, "reader").await;
    let (_, session) = a.post("/_telium/v1/sessions/local", Some(&reader.token), json!({})).await;
    let session = session["session_token"].as_str().unwrap().to_string();

    let (ga, gb) = ("01HGUILDONAAAAAAAAAAAAAAAA", "01HGUILDONBBBBBBBBBBBBBBBB");
    sqlx::query(
        "INSERT INTO guild_alias_redirects (alias, guild_id, to_origin, to_guild_id, created_at) \
         VALUES ('pingpong', ?, 'b.test', ?, 1)",
    )
    .bind(ga)
    .bind(gb)
    .execute(&a.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', ?, '{\"new_server\":\"b.test\"}', 1)",
    )
    .bind(ga)
    .bind(gb)
    .execute(&a.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', ?, '{\"new_server\":\"a.test\"}', 1)",
    )
    .bind(gb)
    .bind(ga)
    .execute(&b.state.pool)
    .await
    .unwrap();

    let (status, circle) = a
        .get("/_telium/v1/guild-addresses/resolve?address=%23pingpong%3Aa.test", Some(&session))
        .await;
    assert_eq!(status, 409, "a circle has to end as an error: {circle}");
    assert!(
        circle["message"].as_str().unwrap_or_default().contains("circle"),
        "and to say why: {circle}"
    );
}

#[tokio::test]
async fn a_guild_decides_across_servers_who_may_carry_its_emoji_away() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let (_, home) = a.post("/_telium/v1/sessions/local", Some(&alice.token), json!({})).await;
    let home = home["session_token"].as_str().unwrap().to_string();
    let (_, host) = a.post("/_telium/v1/guilds", Some(&home), json!({ "name": "Home" })).await;
    let host_id = host["id"].as_str().unwrap().to_string();

    let bob = register_full(&b, "bob").await;
    let (_, away_session) = b.post("/_telium/v1/sessions/local", Some(&bob.token), json!({})).await;
    let away_session = away_session["session_token"].as_str().unwrap().to_string();
    let (_, away) = b.post("/_telium/v1/guilds", Some(&away_session), json!({ "name": "Away" })).await;
    let away_id = away["id"].as_str().unwrap().to_string();
    let (_, channels) = b.get(&format!("/_telium/v1/guilds/{away_id}/channels"), Some(&away_session)).await;
    let channel_id = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (_, msg) = b
        .post(
            &format!("/_telium/v1/channels/{channel_id}/messages"),
            Some(&away_session),
            json!({ "content": "hello" }),
        )
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let (_, invite) = b.post(&format!("/_telium/v1/guilds/{away_id}/invites"), Some(&away_session), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let alice_away = a.session_on(&alice.token, &b).await;
    let (status, joined) = b.post(&format!("/_telium/v1/invites/{code}/join"), Some(&alice_away), json!({})).await;
    assert_eq!(status, 200, "{joined}");

    let png = {
        use base64::Engine;
        let image = image::RgbaImage::from_pixel(16, 16, image::Rgba([40, 160, 220, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image).write_to(&mut out, image::ImageFormat::Png).unwrap();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out.into_inner())
    };
    let mut ids = Vec::new();
    for name in ["parrot", "toucan"] {
        let (status, emoji) = a
            .post(
                &format!("/_telium/v1/guilds/{host_id}/emojis"),
                Some(&home),
                json!({ "name": name, "data": png, "mime": "image/png" }),
            )
            .await;
        assert_eq!(status, 200, "{emoji}");
        ids.push(emoji["id"].as_str().unwrap().to_string());
    }
    let (parrot, toucan) = (ids[0].clone(), ids[1].clone());
    let react = |emoji: &str, id: &str| {
        format!("/_telium/v1/messages/{mid}/reactions/%3C{emoji}%3A{id}%40a.test%3E/@me")
    };

    for token in [&alice_away, &away_session] {
        let (status, body) = b.put(&react("parrot", &parrot), token, json!({})).await;
        assert_eq!(status, 200, "an open guild's emoji travels: {body}");
    }

    let (status, patched) = a
        .patch(&format!("/_telium/v1/guilds/{host_id}"), &home, json!({ "emoji_export_policy": "members" }))
        .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["emoji_export"]["policy"], "members");

    let (status, refused) = b.put(&react("toucan", &toucan), &away_session, json!({})).await;
    assert_eq!(status, 403, "a stranger to the owning guild must not carry its emoji: {refused}");
    let (status, allowed) = b.put(&react("toucan", &toucan), &alice_away, json!({})).await;
    assert_eq!(status, 200, "a member of the owning guild may: {allowed}");

    let cached: Vec<(String, i64)> = sqlx::query_as(
        "SELECT user_id, allowed FROM emoji_entitlements WHERE origin = 'a.test' AND emoji_id = ? \
         ORDER BY user_id",
    )
    .bind(&toucan)
    .fetch_all(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(
        cached,
        vec![("@alice:a.test".to_string(), 1), ("@bob:b.test".to_string(), 0)],
        "the owning server's answer is what was stored"
    );

    let (status, ghost) = b.put(&react("ghost", "01HNOSUCHEMOJIANYWHERE0"), &alice_away, json!({})).await;
    assert_eq!(status, 403, "an emoji nobody owns cannot be entitled: {ghost}");
}
