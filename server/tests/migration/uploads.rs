use super::*;

#[tokio::test]
async fn an_accounts_uploads_move_with_it() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (attachment, attachment_cap) = uploaded(&a, "@ana:a.example", "attachment", b"ATTACHMENT-BYTES").await;
    let (avatar, avatar_cap) = uploaded(&a, "@ana:a.example", "profile", b"AVATAR-BYTES").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let media = bundle["media"].as_array().expect("the bundle carries no media");
    assert_eq!(media.len(), 2, "both uploads should be in the bundle: {media:?}");
    assert_eq!(media[0]["media"]["hash"], json!(avatar));
    assert_eq!(media[0]["media"]["purpose"], json!("profile"));
    assert_eq!(media[1]["media"]["hash"], json!(attachment));
    assert_eq!(
        telium_server::util::unb64(media[1]["data"].as_str().unwrap()).unwrap(),
        b"ATTACHMENT-BYTES"
    );
    assert!(bundle["media"].to_string().contains(&attachment_cap), "the capability did not travel");
    assert_eq!(bundle["media_omitted"], json!([]));

    import_user(&b, &bundle, "@ana:b.example").await;

    let (owner, cap, purpose, mime, size, moved_to) =
        media_row(&b.pool, &attachment).await.expect("the attachment has no row at the destination");
    assert_eq!(owner, "@ana:b.example", "the upload landed billed to somebody else");
    assert_eq!(cap, attachment_cap, "the capability changed, so every old link to it broke");
    assert_eq!((purpose.as_str(), mime.as_str(), size), ("attachment", "image/png", 16));
    assert_eq!(moved_to, None);
    assert_eq!(on_disk(&b, &attachment).as_deref(), Some(&b"ATTACHMENT-BYTES"[..]));

    let (_, cap, purpose, _, _, _) =
        media_row(&b.pool, &avatar).await.expect("the avatar has no row at the destination");
    assert_eq!((cap.as_str(), purpose.as_str()), (avatar_cap.as_str(), "profile"));
    assert_eq!(on_disk(&b, &avatar).as_deref(), Some(&b"AVATAR-BYTES"[..]));

    let resp = fetch(&b, &attachment, &attachment_cap).await.unwrap();
    assert_eq!(resp.status(), 200);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"ATTACHMENT-BYTES");
}

#[tokio::test]
async fn an_upload_that_lies_about_its_hash_is_skipped_and_the_rest_arrive() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (forged, _) = uploaded(&a, "@ana:a.example", "attachment", b"FIRST-UPLOAD").await;
    let (honest, _) = uploaded(&a, "@ana:a.example", "attachment", b"SECOND-UPLOAD").await;

    let mut bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    for entry in bundle["media"].as_array_mut().unwrap() {
        if entry["media"]["hash"] == json!(forged) {
            entry["data"] = json!(telium_server::util::b64(b"not what the name says"));
        } else {
            entry["media"]["capability"] = json!("cap");
            entry["media"]["mime"] = json!("text/html");
        }
    }

    import_user(&b, &bundle, "@ana:b.example").await;

    assert_eq!(media_row(&b.pool, &forged).await, None, "a row was written for bytes that are not the object");
    assert_eq!(on_disk(&b, &forged), None, "the forged bytes were written under the honest name");

    let (_, cap, _, mime, _, _) = media_row(&b.pool, &honest).await.expect("the honest upload did not land");
    assert_ne!(cap, "cap", "a three-byte capability was kept");
    assert!(cap.len() >= 16, "the minted capability is no better: {cap}");
    assert_eq!(mime, "application/octet-stream", "the bundle chose the Content-Type");
    assert_eq!(on_disk(&b, &honest).as_deref(), Some(&b"SECOND-UPLOAD"[..]));
}

#[tokio::test]
async fn a_guilds_expressions_stay_with_the_guild() {
    let a = home("a.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let s = seed(&a.pool).await;
    with_disk_state(&a, &s).await;
    let (emoji_hash, sticker_hash): (String, String) = sqlx::query_as(
        "SELECT (SELECT media_hash FROM emojis WHERE id = ?), (SELECT media_hash FROM stickers WHERE id = ?)",
    )
    .bind(&s.emoji)
    .bind(&s.sticker)
    .fetch_one(&a.pool)
    .await
    .unwrap();
    let (attachment, _) = uploaded(&a, "@ana:a.example", "attachment", b"ANAS-ATTACHMENT").await;
    let (orphan, _) = uploaded(&a, "@ana:a.example", "expression", b"AN-EXPRESSION-NO-GUILD-USES").await;
    let (someone_elses, _) = uploaded(&a, "@bob:a.example", "attachment", b"BOBS-ATTACHMENT").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let mut carried = migration::carried_media(&bundle);
    carried.sort();
    let mut expected = vec![attachment, orphan];
    expected.sort();
    assert_eq!(carried, expected, "the bundle carries the wrong set of uploads");
    assert!(!carried.contains(&emoji_hash) && !carried.contains(&sticker_hash));
    assert!(!carried.contains(&someone_elses));
}

#[tokio::test]
async fn the_old_origin_forwards_a_fetch_for_an_upload_that_moved() {
    let a = home_with("a.example", |cfg| {
        cfg.federation.peers.insert("b.example".into(), "http://b.example".into());
    })
    .await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (moved, cap) = uploaded(&a, "@ana:a.example", "attachment", b"MOVED-BYTES").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    import_user(&b, &bundle, "@ana:b.example").await;
    let (left, left_cap) = uploaded(&a, "@ana:a.example", "attachment", b"LEFT-BEHIND").await;

    let marked = migration::mark_media_moved(&a, "@ana:a.example", &migration::carried_media(&bundle), "b.example")
        .await
        .unwrap();
    assert_eq!(marked, 1);
    assert_eq!(media_row(&a.pool, &moved).await.unwrap().5.as_deref(), Some("b.example"));
    assert_eq!(media_row(&a.pool, &left).await.unwrap().5, None);

    let resp = fetch(&a, &moved, &cap).await.unwrap();
    assert_eq!(resp.status(), 307, "the old origin did not forward the fetch");
    assert_eq!(
        resp.headers().get("location").unwrap().to_str().unwrap(),
        format!("http://b.example/_telium/v1/media/{moved}?cap={cap}")
    );

    let refused = fetch(&a, &moved, "not-the-capability").await;
    assert!(
        matches!(refused, Err(telium_server::error::ApiError::NotFound(_))),
        "a redirect leaked that the hash exists: {refused:?}"
    );

    let resp = fetch(&b, &moved, &cap).await.unwrap();
    assert_eq!(resp.status(), 200);

    let resp = fetch(&a, &left, &left_cap).await.unwrap();
    assert_eq!(resp.status(), 200, "an object the bundle never carried was forwarded to a server that does not have it");
}

#[tokio::test]
async fn a_destination_that_hosts_no_uploads_keeps_only_the_profile_carveout() {
    let a = home("a.example").await;
    let b = home_with("b.example", |cfg| {
        cfg.media_policy.default = telium_server::config::MediaDefault::Disabled;
    })
    .await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (attachment, _) = uploaded(&a, "@ana:a.example", "attachment", b"AN-ATTACHMENT").await;
    let (avatar, _) = uploaded(&a, "@ana:a.example", "profile", b"AN-AVATAR").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    import_user(&b, &bundle, "@ana:b.example").await;

    assert_eq!(media_row(&b.pool, &attachment).await, None, "a server that hosts no uploads took one");
    assert_eq!(on_disk(&b, &attachment), None);
    assert!(media_row(&b.pool, &avatar).await.is_some(), "the profile carveout did not apply");
    assert_eq!(on_disk(&b, &avatar).as_deref(), Some(&b"AN-AVATAR"[..]));
}

#[tokio::test]
async fn what_is_expired_or_already_moved_is_not_carried() {
    let a = home("a.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let (expired, _) = uploaded(&a, "@ana:a.example", "attachment", b"EXPIRED").await;
    sqlx::query("UPDATE media SET expires_at = 1 WHERE hash = ?").bind(&expired).execute(&a.pool).await.unwrap();
    let (moved, _) = uploaded(&a, "@ana:a.example", "attachment", b"MOVED-LAST-TIME").await;
    sqlx::query("UPDATE media SET moved_to = 'c.example' WHERE hash = ?").bind(&moved).execute(&a.pool).await.unwrap();
    let (live, _) = uploaded(&a, "@ana:a.example", "attachment", b"LIVE").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    assert_eq!(migration::carried_media(&bundle), vec![live]);
}
