use super::*;

#[tokio::test]
async fn remote_memberships_travel_and_queue_one_move_per_guild_server() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let proof = json!({ "kind": "membership", "action": "joined", "user_id": "@ana:a.example",
                        "guild_id": "g-far", "guild_server": "g.example", "at": 4000,
                        "key_id": "ed25519:x", "signature": "SIG" });
    sqlx::query(
        "INSERT INTO remote_memberships (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
         VALUES ('@ana:a.example', 'g.example', 'g-far', 4000, ?, 'guild', 4000), \
                ('@ana:a.example', 'g.example', 'g-far-2', 4100, NULL, 'client', 4100), \
                ('@ana:a.example', 'h.example', 'g-farther', 4200, NULL, 'client', 4200)",
    )
    .bind(proof.to_string())
    .execute(&a.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO guilds (id, name, owner_user_id, created_at) VALUES ('g-home', 'Home', '@ana:a.example', 1)")
        .execute(&a.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO members (guild_id, user_id, joined_at) VALUES ('g-home', '@ana:a.example', 4300)")
        .execute(&a.pool)
        .await
        .unwrap();

    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let entries = bundle["remote_memberships"].as_array().unwrap().clone();
    let named: Vec<(String, String)> = entries
        .iter()
        .map(|e| (e["guild_server"].as_str().unwrap().into(), e["guild_id"].as_str().unwrap().into()))
        .collect();
    assert_eq!(
        named,
        vec![
            ("g.example".to_string(), "g-far".to_string()),
            ("g.example".to_string(), "g-far-2".to_string()),
            ("h.example".to_string(), "g-farther".to_string()),
            ("a.example".to_string(), "g-home".to_string()),
        ]
    );
    assert_eq!(entries[0]["proof"], proof, "the guild server's notice travels verbatim");
    assert_eq!(entries[0]["reported_by"], "guild");
    assert_eq!(bundle["memberships"], json!(["g-home"]), "the older list is still there");

    bundle["remote_memberships"].as_array_mut().unwrap().push(json!({ "guild_server": "x.example" }));
    bundle["remote_memberships"].as_array_mut().unwrap().push(json!("not even an object"));

    import_user(&b, &bundle, "@ana:b.example").await;

    let landed: Vec<(String, String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT guild_server, guild_id, joined_at, proof, reported_by FROM remote_memberships \
         WHERE user_id = '@ana:b.example' ORDER BY guild_server, guild_id",
    )
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(landed.len(), 4, "{landed:?}");
    assert_eq!(landed[0], ("a.example".into(), "g-home".into(), 4300, None, "guild".into()));
    assert_eq!(landed[1].1, "g-far");
    assert_eq!(landed[1].3.as_deref().map(|p| serde_json::from_str::<Value>(p).unwrap()), Some(proof));
    assert_eq!(landed[3], ("h.example".into(), "g-farther".into(), 4200, None, "client".into()));

    let moves: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT guild_server, old_id, state, attempts FROM membership_moves \
         WHERE user_id = '@ana:b.example' ORDER BY guild_server",
    )
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(
        moves,
        vec![
            ("a.example".into(), "@ana:a.example".into(), "pending".into(), 0),
            ("g.example".into(), "@ana:a.example".into(), "pending".into(), 0),
            ("h.example".into(), "@ana:a.example".into(), "pending".into(), 0),
        ]
    );
    let status = telium_server::memberships::status(&b, "@ana:b.example").await.unwrap();
    assert_eq!(status[1]["guild_ids"], json!(["g-far", "g-far-2"]));
    assert!(status[1]["next_attempt_at"].as_i64().unwrap() > telium_server::util::now_ms());
}

#[tokio::test]
async fn a_bundle_without_a_registry_section_still_lands() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    bundle.as_object_mut().unwrap().remove("remote_memberships");
    import_user(&b, &bundle, "@ana:b.example").await;
    let moves: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM membership_moves WHERE user_id = '@ana:b.example'")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(moves, 0);
}

fn descriptor(origin: &str, base: &str, hash: &str, cap: &str) -> Value {
    json!({
        "reference": format!("media://{origin}/{hash}"),
        "origin": origin,
        "hash": hash,
        "capability": cap,
        "url": format!("{base}/_telium/v1/media/{hash}?cap={cap}"),
        "filename": "photo.png",
        "mime": "image/png",
        "size": 16,
    })
}

async fn message_carrying(pool: &SqlitePool, attachments: Value) -> String {
    let id = ulid();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, created_at) \
         VALUES (?, 'chan', 'guild', '@ana:a.example', 'look', ?, 1000)",
    )
    .bind(&id)
    .bind(attachments.to_string())
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn attachments_of(pool: &SqlitePool, id: &str) -> Value {
    let raw: String = sqlx::query_scalar("SELECT attachments FROM messages WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

async fn migration_media_state(pool: &SqlitePool, migration_id: &str, hash: &str) -> Option<(String, String)> {
    sqlx::query_as("SELECT state, detail FROM migration_media WHERE migration_id = ? AND hash = ?")
        .bind(migration_id)
        .bind(hash)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn user_move(home: &Home, id: &str, subject: &str, destination: &str, state: &str) {
    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, device_id, \
         device_sig, state, created_at, executes_at, completed_at) \
         VALUES (?, 'user', ?, ?, 'grant', 'device', 'sig', ?, 1000, 1000, 2000)",
    )
    .bind(id)
    .bind(subject)
    .bind(destination)
    .bind(state)
    .execute(&home.pool)
    .await
    .unwrap();
}

fn not_found<T: std::fmt::Debug>(r: Result<T, telium_server::error::ApiError>, what: &str) {
    assert!(matches!(r, Err(telium_server::error::ApiError::NotFound(_))), "{what}: {r:?}");
}

#[tokio::test]
async fn references_in_history_follow_the_uploads() {
    let a = home_with("a.example", |cfg| {
        cfg.federation.peers.insert("b.example".into(), "http://b.example".into());
    })
    .await;
    let b = home("b.example").await;
    let c = home_with("c.example", |cfg| {
        cfg.federation.peers.insert("b.example".into(), "http://b.example".into());
    })
    .await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (moving, cap) = uploaded(&a, "@ana:a.example", "attachment", b"MOVING").await;
    let (staying, staying_cap) = uploaded(&a, "@bob:a.example", "attachment", b"BOBS").await;
    let external = json!({ "external": true, "origin": "files.example", "url": "https://files.example/x", "hash": moving });

    let at_a = message_carrying(
        &a.pool,
        json!([
            descriptor("a.example", "http://a.example", &moving, &cap),
            descriptor("a.example", "http://a.example", &staying, &staying_cap),
        ]),
    )
    .await;
    let at_b = message_carrying(
        &b.pool,
        json!([descriptor("a.example", "http://a.example", &moving, &cap), external.clone()]),
    )
    .await;
    let at_c = message_carrying(&c.pool, json!([descriptor("a.example", "http://a.example", &moving, &cap)])).await;
    sqlx::query(
        "INSERT INTO media_cache (origin, hash, mime, size, fetched_at, expires_at) \
         VALUES ('a.example', ?, 'image/png', 6, 1000, 9999999999999)",
    )
    .bind(&moving)
    .execute(&c.pool)
    .await
    .unwrap();

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    import_user(&b, &bundle, "@ana:b.example").await;

    let atts = attachments_of(&b.pool, &at_b).await;
    assert_eq!(atts[0]["origin"], "b.example");
    assert_eq!(atts[0]["reference"], format!("media://b.example/{moving}"));
    assert_eq!(atts[0]["url"], format!("http://b.example/_telium/v1/media/{moving}?cap={cap}"));
    assert_eq!(atts[0]["capability"], json!(cap), "the rewrite touched a field it should not have");
    assert_eq!(atts[0]["filename"], "photo.png");
    assert_eq!(atts[1], external, "a provider reference was rewritten");

    let migration_id = ulid();
    migration::media::record_export(&a, &migration_id, &bundle).await.unwrap();
    let settled = migration::media::settle_ack(
        &a,
        &migration_id,
        "@ana:a.example",
        &migration::carried_media(&bundle),
        &json!({ "kind": "migration_ack" }),
        "b.example",
    )
    .await
    .unwrap();
    assert_eq!(settled.landed, vec![moving.clone()]);
    assert!(settled.refused.is_empty());
    assert_eq!(media_row(&a.pool, &moving).await.unwrap().5.as_deref(), Some("b.example"));
    let atts = attachments_of(&a.pool, &at_a).await;
    assert_eq!(atts[0]["origin"], "b.example");
    assert_eq!(atts[0]["reference"], format!("media://b.example/{moving}"));
    assert_eq!(atts[0]["url"], format!("http://b.example/_telium/v1/media/{moving}?cap={cap}"));
    assert_eq!(atts[1]["origin"], "a.example", "an object that did not move was re-pointed");
    assert_eq!(atts[1]["url"], format!("http://a.example/_telium/v1/media/{staying}?cap={staying_cap}"));
    assert_eq!(
        migration::media::moved_list(&a, "@ana:a.example", &[moving.clone(), staying.clone()]).await.unwrap(),
        json!({ "moves": [{ "new_origin": "b.example", "hashes": [moving] }] })
    );
    assert_eq!(
        migration::media::moved_list(&a, "@ana:a.example", &[]).await.unwrap(),
        json!({ "moves": [] })
    );
    assert_eq!(
        migration::media::moved_list(&a, "@ana:a.example", &[staying.clone()]).await.unwrap(),
        json!({ "moves": [] })
    );

    let ignored = migration::media::apply_move_notice(&c, "d.example", "b.example", &[moving.clone()]).await.unwrap();
    assert_eq!(ignored, 0);
    assert_eq!(attachments_of(&c.pool, &at_c).await[0]["origin"], "a.example", "a stranger re-pointed a.example's objects");
    let changed = migration::media::apply_move_notice(&c, "a.example", "b.example", &[moving.clone()]).await.unwrap();
    assert_eq!(changed, 1);
    let atts = attachments_of(&c.pool, &at_c).await;
    assert_eq!(atts[0]["origin"], "b.example");
    assert_eq!(atts[0]["reference"], format!("media://b.example/{moving}"));
    assert_eq!(atts[0]["url"], format!("http://b.example/_telium/v1/media/{moving}?cap={cap}"));
    let cached: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_cache WHERE origin = 'a.example' AND hash = ?")
        .bind(&moving)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(cached, 0, "the stale cache entry would keep answering from the old origin");
    assert_eq!(migration::media::apply_move_notice(&c, "a.example", "b.example", &[moving.clone()]).await.unwrap(), 0);
    assert!(migration::media::apply_move_notice(&c, "a.example", "not a server", &[moving.clone()]).await.is_err());
}

#[tokio::test]
async fn what_the_destination_refuses_stays_served_from_the_source() {
    let a = home("a.example").await;
    let b = home_with("b.example", |cfg| {
        cfg.media_policy.default = telium_server::config::MediaDefault::Disabled;
    })
    .await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (attachment, attachment_cap) = uploaded(&a, "@ana:a.example", "attachment", b"AN-ATTACHMENT").await;
    let (avatar, _) = uploaded(&a, "@ana:a.example", "profile", b"AN-AVATAR").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let carried = migration::carried_media(&bundle);
    assert_eq!(carried.len(), 2);
    let migration_id = ulid();
    migration::media::record_export(&a, &migration_id, &bundle).await.unwrap();
    assert_eq!(migration_media_state(&a.pool, &migration_id, &attachment).await.unwrap().0, "carried");
    import_user(&b, &bundle, "@ana:b.example").await;

    let outcome: String = sqlx::query_scalar("SELECT media_outcome FROM import_log")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    let outcome: Value = serde_json::from_str(&outcome).unwrap();
    assert_eq!(outcome["landed"], json!([avatar]));
    assert_eq!(outcome["refused"][0]["hash"], json!(attachment));
    assert!(outcome["refused"][0]["reason"].as_str().unwrap().starts_with("policy:"), "{outcome}");
    assert!(media_row(&b.pool, &attachment).await.is_none());
    assert!(on_disk(&b, &attachment).is_none());

    let settled = migration::media::settle_ack(
        &a,
        &migration_id,
        "@ana:a.example",
        &carried,
        &json!({ "kind": "migration_ack", "media": outcome }),
        "b.example",
    )
    .await
    .unwrap();
    assert_eq!(settled.landed, vec![avatar.clone()]);
    assert_eq!(settled.refused.len(), 1);
    assert_eq!(settled.refused[0].0, attachment);

    assert_eq!(media_row(&a.pool, &avatar).await.unwrap().5.as_deref(), Some("b.example"));
    assert_eq!(
        media_row(&a.pool, &attachment).await.unwrap().5,
        None,
        "a refused upload was forwarded to a server that does not have it"
    );
    let (state, detail) = migration_media_state(&a.pool, &migration_id, &attachment).await.unwrap();
    assert_eq!(state, "refused");
    assert!(detail.starts_with("policy:"), "{detail}");
    assert_eq!(migration_media_state(&a.pool, &migration_id, &avatar).await.unwrap().0, "landed");
    let resp = fetch(&a, &attachment, &attachment_cap).await.unwrap();
    assert_eq!(resp.status(), 200, "the source stopped serving what only it has");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"AN-ATTACHMENT");

    let d = home("d.example").await;
    let (shared, _) = uploaded(&d, "@bob:d.example", "attachment", b"AN-AVATAR").await;
    assert_eq!(shared, avatar);
    sqlx::query("UPDATE media SET moved_to = NULL WHERE hash = ?").bind(&avatar).execute(&a.pool).await.unwrap();
    let d_bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    assert_eq!(migration::carried_media(&d_bundle).len(), 2);
    import_user(&d, &d_bundle, "@ana:d.example").await;
    let outcome: String = sqlx::query_scalar("SELECT media_outcome FROM import_log").fetch_one(&d.pool).await.unwrap();
    let outcome: Value = serde_json::from_str(&outcome).unwrap();
    assert_eq!(outcome["landed"], json!([attachment]));
    assert_eq!(outcome["refused"][0]["hash"], json!(avatar));
    assert_eq!(outcome["refused"][0]["reason"], "already here under another capability");
    assert_eq!(media_row(&d.pool, &avatar).await.unwrap().0, "@bob:d.example", "the import took over somebody else's row");

    let quiet = ulid();
    migration::media::record_export(&a, &quiet, &d_bundle).await.unwrap();
    let settled = migration::media::settle_ack(
        &a,
        &quiet,
        "@ana:a.example",
        &migration::carried_media(&d_bundle),
        &json!({ "media": { "landed": [attachment], "refused": [] } }),
        "d.example",
    )
    .await
    .unwrap();
    assert_eq!(settled.landed, vec![attachment.clone()]);
    assert_eq!(settled.refused, vec![(avatar.clone(), "the destination did not say it landed".to_string())]);
    assert_eq!(media_row(&a.pool, &avatar).await.unwrap().5, None);
    assert_eq!(media_row(&a.pool, &attachment).await.unwrap().5.as_deref(), Some("d.example"));
    assert_eq!(migration_media_state(&a.pool, &quiet, &avatar).await.unwrap().0, "refused");
}

#[tokio::test]
async fn the_paged_fetch_answers_only_the_acknowledged_destination() {
    let a = home("a.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (omitted, cap) = uploaded(&a, "@ana:a.example", "attachment", b"LEFT-OUT-FOR-SIZE").await;
    let (carried, _) = uploaded(&a, "@ana:a.example", "attachment", b"WENT-IN-THE-BUNDLE").await;
    let (expired, _) = uploaded(&a, "@ana:a.example", "attachment", b"LEFT-OUT-THEN-EXPIRED").await;
    sqlx::query("UPDATE media SET expires_at = 1 WHERE hash = ?").bind(&expired).execute(&a.pool).await.unwrap();
    let (gone, _) = uploaded(&a, "@ana:a.example", "attachment", b"LEFT-OUT-THEN-DELETED").await;
    std::fs::remove_file(a.cfg.media_dir.join(&gone[0..2]).join(&gone)).unwrap();

    let done = ulid();
    user_move(&a, &done, "@ana:a.example", "b.example", "completed").await;
    let underway = ulid();
    user_move(&a, &underway, "@ana:a.example", "b.example", "ready").await;
    let bundle = json!({
        "media": [{ "media": { "hash": carried } }],
        "media_omitted": [
            { "hash": omitted, "size": 17, "purpose": "attachment" },
            { "hash": expired, "size": 21, "purpose": "attachment" },
            { "hash": gone, "size": 21, "purpose": "attachment" },
        ],
    });
    migration::media::record_export(&a, &done, &bundle).await.unwrap();
    migration::media::record_export(&a, &underway, &bundle).await.unwrap();

    not_found(migration::media::serve_omitted(&a, "c.example", &done, &omitted).await, "not the destination");
    not_found(migration::media::serve_omitted(&a, "b.example", &underway, &omitted).await, "move not completed");
    not_found(migration::media::serve_omitted(&a, "b.example", &ulid(), &omitted).await, "no such migration");
    not_found(migration::media::serve_omitted(&a, "b.example", &done, &carried).await, "not left out of the bundle");
    not_found(migration::media::serve_omitted(&a, "b.example", &done, &expired).await, "expired since");
    not_found(migration::media::serve_omitted(&a, "b.example", &done, &gone).await, "no bytes on disk");
    not_found(migration::media::serve_omitted(&a, "b.example", &done, "not-a-hash").await, "not a hash");

    let entry = migration::media::serve_omitted(&a, "B.example", &done, &omitted).await.unwrap();
    assert_eq!(entry["media"]["hash"], json!(omitted));
    assert_eq!(entry["media"]["capability"], json!(cap));
    assert_eq!(entry["media"]["purpose"], "attachment");
    assert_eq!(entry["media"]["size"], 17);
    assert_eq!(telium_server::util::unb64(entry["data"].as_str().unwrap()).unwrap(), b"LEFT-OUT-FOR-SIZE");
    assert_eq!(media_row(&a.pool, &omitted).await.unwrap().5, None);

    not_found(
        migration::media::confirm_pulled(&a, "c.example", &done, &[omitted.clone()], &[]).await,
        "a stranger confirming",
    );
    not_found(
        migration::media::confirm_pulled(&a, "b.example", &underway, &[omitted.clone()], &[]).await,
        "confirming a move that is not complete",
    );
    assert_eq!(media_row(&a.pool, &omitted).await.unwrap().5, None);
    let settled = migration::media::confirm_pulled(&a, "b.example", &done, &[carried.clone()], &[]).await.unwrap();
    assert!(settled.landed.is_empty(), "a carried object was taken as a fetched one");
    assert_eq!(media_row(&a.pool, &carried).await.unwrap().5, None);

    let settled = migration::media::confirm_pulled(
        &a,
        "b.example",
        &done,
        &[omitted.clone()],
        &[(gone.clone(), "gave up after 10 attempts".into())],
    )
    .await
    .unwrap();
    assert_eq!(settled.landed, vec![omitted.clone()]);
    assert_eq!(settled.refused, vec![(gone.clone(), "gave up after 10 attempts".to_string())]);
    assert_eq!(media_row(&a.pool, &omitted).await.unwrap().5.as_deref(), Some("b.example"));
    assert_eq!(migration_media_state(&a.pool, &done, &omitted).await.unwrap().0, "landed");
    assert_eq!(
        migration_media_state(&a.pool, &done, &gone).await.unwrap(),
        ("refused".to_string(), "gave up after 10 attempts".to_string())
    );
    not_found(migration::media::serve_omitted(&a, "b.example", &done, &omitted).await, "already forwarded");
    let again = migration::media::confirm_pulled(&a, "b.example", &done, &[omitted.clone()], &[]).await.unwrap();
    assert!(again.landed.is_empty());
    let resp = fetch(&a, &carried, &media_row(&a.pool, &carried).await.unwrap().1).await.unwrap();
    assert_eq!(resp.status(), 200);
}

#[tokio::test]
async fn synced_state_moves_and_what_belongs_to_a_device_does_not() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let ana = "@ana:a.example";
    account(&a.pool, ana, "ana", "a.example").await;
    synced(
        &a.pool,
        ana,
        "prefs.v1",
        json!({ "theme": "light", "muted": { "g1": true }, "collapsed": { "c1": true },
                "voiceRegion": "syd", "richPresenceEnabled": true,
                "richPresenceGameEnabled": false, "richPresenceMusicEnabled": true,
                "richPresenceVideoEnabled": false }),
    )
    .await;
    synced(&a.pool, ana, "emoji.recent.v1", json!(["+1", "tada"])).await;
    synced(&a.pool, ana, "emoji.tone.v1", json!("3")).await;
    synced(&a.pool, ana, "gif.favorites.v1", json!(["https://gifs.example/a.gif"])).await;
    synced(&a.pool, ana, "drafts.v1", json!({ "chan": "UNSENT-DRAFT-PLAINTEXT" })).await;
    synced(&a.pool, ana, "someones.plugin.v1", json!({ "token": "PLUGIN-STATE" })).await;

    let bundle = migration::export_user(&a, ana).await.unwrap();
    let mut keys: Vec<&str> =
        bundle["sync_store"].as_array().unwrap().iter().map(|e| e["key"].as_str().unwrap()).collect();
    keys.sort();
    assert_eq!(keys, vec!["emoji.recent.v1", "emoji.tone.v1", "gif.favorites.v1", "prefs.v1"]);
    let serialized = bundle.to_string();
    for stays in [
        "UNSENT-DRAFT-PLAINTEXT",
        "PLUGIN-STATE",
        "voiceRegion",
        "richPresenceEnabled",
        "richPresenceGameEnabled",
        "richPresenceMusicEnabled",
        "richPresenceVideoEnabled",
    ] {
        assert!(!serialized.contains(stays), "{stays} left the server inside a bundle");
    }

    import_user(&b, &bundle, "@ana:b.example").await;
    let landed = synced_at(&b.pool, "@ana:b.example").await;
    assert_eq!(
        landed.keys().map(String::as_str).collect::<Vec<_>>(),
        vec!["emoji.recent.v1", "emoji.tone.v1", "gif.favorites.v1", "prefs.v1"]
    );
    assert_eq!(landed["prefs.v1"], json!({ "theme": "light", "muted": { "g1": true }, "collapsed": { "c1": true } }));
    assert_eq!(landed["emoji.recent.v1"], json!(["+1", "tada"]));
    assert_eq!(landed["emoji.tone.v1"], json!("3"));
    assert_eq!(landed["gif.favorites.v1"], json!(["https://gifs.example/a.gif"]));
}

#[tokio::test]
async fn a_bundle_cannot_put_in_the_sync_store_what_a_device_could_not() {
    let a = home("a.example").await;
    let b = home_with("b.example", |cfg| cfg.limits.max_sync_store_bytes = 64).await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let long_link = format!("https://gifs.example/{}", "a".repeat(80));
    bundle["sync_store"] = json!([
        { "key": "drafts.v1", "value": json!({ "chan": "UNSENT" }).to_string(), "updated_at": 1 },
        { "key": "someones.plugin.v1", "value": "\"x\"", "updated_at": 1 },
        { "key": "prefs.v1", "value": json!({ "theme": "light", "voiceRegion": "syd" }).to_string(), "updated_at": 1 },
        { "key": "gif.favorites.v1", "value": json!([long_link]).to_string(), "updated_at": 1 },
        { "key": "emoji.tone.v1", "value": "\"2\"", "updated_at": 1 },
        { "key": "emoji.recent.v1", "value": "not json", "updated_at": 1 },
    ]);

    import_user(&b, &bundle, "@ana:b.example").await;
    let landed = synced_at(&b.pool, "@ana:b.example").await;
    assert_eq!(landed.keys().map(String::as_str).collect::<Vec<_>>(), vec!["emoji.tone.v1", "prefs.v1"]);
    assert_eq!(landed["prefs.v1"], json!({ "theme": "light" }));
}

#[tokio::test]
async fn the_history_backup_moves_as_ciphertext_within_the_destinations_limits() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    for (scope, item, ciphertext, at) in [
        ("conv-1", "f-1", "SEALED-1", 1000),
        ("conv-1", "f-2", "SEALED-2", 1001),
        ("conv-2", "state", "SEALED-3", 1002),
    ] {
        sqlx::query(
            "INSERT INTO key_backup (user_id, scope, item, ciphertext, updated_at) \
             VALUES ('@ana:a.example', ?, ?, ?, ?)",
        )
        .bind(scope)
        .bind(item)
        .bind(ciphertext)
        .bind(at)
        .execute(&a.pool)
        .await
        .unwrap();
    }

    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    {
        let carried = bundle["key_backup"].as_array().expect("the bundle has no history backup in it");
        assert_eq!(carried.len(), 3);
        assert_eq!(bundle["key_backup_omitted"], 0);
        for entry in carried {
            let mut fields: Vec<&str> = entry.as_object().unwrap().keys().map(String::as_str).collect();
            fields.sort();
            assert_eq!(fields, vec!["ciphertext", "item", "scope", "updated_at"]);
        }
        assert_eq!(carried[0]["ciphertext"], "SEALED-3");
    }

    let entries = bundle["key_backup"].as_array_mut().unwrap();
    entries.push(json!({ "scope": "conv-3", "item": "big", "ciphertext": "x".repeat(256 * 1024 + 1), "updated_at": 1 }));
    entries.push(json!({ "scope": "", "item": "f", "ciphertext": "SEALED-4", "updated_at": 1 }));

    import_user(&b, &bundle, "@ana:b.example").await;
    let landed: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT scope, item, ciphertext FROM key_backup WHERE user_id = '@ana:b.example' ORDER BY scope, item",
    )
    .fetch_all(&b.pool)
    .await
    .unwrap();
    let want: Vec<(String, String, String)> = [
        ("conv-1", "f-1", "SEALED-1"),
        ("conv-1", "f-2", "SEALED-2"),
        ("conv-2", "state", "SEALED-3"),
    ]
    .iter()
    .map(|(s, i, c)| (s.to_string(), i.to_string(), c.to_string()))
    .collect();
    assert_eq!(landed, want);
}

#[tokio::test]
async fn a_history_backup_past_the_budget_leaves_its_oldest_behind() {
    let a = home("a.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let sealed = "x".repeat(256 * 1024);
    let rows = migration::KEY_BACKUP_BUDGET_BYTES / sealed.len() + 3;
    for i in 0..rows {
        sqlx::query(
            "INSERT INTO key_backup (user_id, scope, item, ciphertext, updated_at) \
             VALUES ('@ana:a.example', 'conv', ?, ?, ?)",
        )
        .bind(format!("f-{i:03}"))
        .bind(&sealed)
        .bind(1000 + i as i64)
        .execute(&a.pool)
        .await
        .unwrap();
    }

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let carried = bundle["key_backup"].as_array().unwrap();
    let omitted = bundle["key_backup_omitted"].as_i64().unwrap();
    assert!(omitted > 0, "a backup past the budget was carried whole");
    assert_eq!(carried.len() as i64 + omitted, rows as i64);
    let bytes: usize = carried.iter().map(|e| e["ciphertext"].as_str().unwrap().len()).sum();
    assert!(bytes <= migration::KEY_BACKUP_BUDGET_BYTES);
    assert_eq!(carried[0]["item"], format!("f-{:03}", rows - 1), "the newest item was not carried first");
    assert!(carried.iter().all(|e| e["item"] != "f-000"), "the oldest item was carried over newer ones");
}
