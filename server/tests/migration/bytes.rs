use super::*;

async fn every_message(home: &Home, guild: &str) -> Vec<String> {
    let mut out = rows(&home.pool, "messages", "WHERE guild_id = ?", guild).await;
    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT s.id FROM cold_segments s JOIN channels c ON c.id = s.channel_id \
         WHERE c.guild_id = ?",
    )
    .bind(guild)
    .fetch_all(&home.pool)
    .await
    .unwrap();
    for segment in segments {
        for row in telium_server::cold::read_segment(&home.state, &segment).await.unwrap() {
            out.push(row.to_string());
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn a_guild_takes_its_archive_with_it() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    let cold = with_disk_state(&a, &s).await;

    let hot: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = ?")
        .bind(&s.guild)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(hot, s.messages.len() as i64 - cold);

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:a.example").await.unwrap();

    assert_eq!(
        rehomed(every_message(&a, &s.guild).await, "a.example", "b.example"),
        every_message(&b, &new_guild).await
    );
    let there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = ?")
        .bind(&new_guild)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(there, s.messages.len() as i64, "history arrives hot; the new server re-archives");

    let indexed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages_fts WHERE guild_id = ?")
        .bind(&new_guild)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(indexed, s.messages.len() as i64);
}

#[tokio::test]
async fn cold_history_comes_back_as_what_it_was() {
    let a = home("a.example").await;
    let s = seed(&a.pool).await;
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
         VALUES (?, ?, ?, '@ana:a.example', 'after', 9000)",
    )
    .bind(ulid())
    .bind(&s.channel)
    .bind(&s.guild)
    .execute(&a.pool)
    .await
    .unwrap();
    with_disk_state(&a, &s).await;

    let archived = telium_server::cold::page_before(&a.state, &s.channel, "\u{10FFFF}", 100)
        .await
        .unwrap();
    let sticker_message = s.messages.last().unwrap();
    let it = archived
        .iter()
        .find(|m| m["id"].as_str() == Some(sticker_message.as_str()))
        .expect("the archived message is readable again");

    assert_eq!(it["author_signature"].as_str(), Some("sig-abc"));
    assert_eq!(it["sticker"]["name"].as_str(), Some("shrug"));
    assert_eq!(it["author"].as_str(), Some("@ana:a.example"));
    assert!(it["thread_id"].is_null());
}

#[tokio::test]
async fn a_guild_takes_its_expressions_with_it() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    with_disk_state(&a, &s).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:a.example").await.unwrap();

    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT media_hash FROM emojis WHERE guild_id = ? \
         UNION SELECT media_hash FROM stickers WHERE guild_id = ?",
    )
    .bind(&new_guild)
    .bind(&new_guild)
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(hashes.len(), 2);

    for hash in hashes {
        let bytes = std::fs::read(b.cfg.media_dir.join(&hash[0..2]).join(&hash))
            .expect("the emoji resolves to bytes that are actually here");
        assert_eq!(blake3::hash(&bytes).to_hex().to_string(), hash);

        let purpose: String = sqlx::query_scalar("SELECT purpose FROM media WHERE hash = ?")
            .bind(&hash)
            .fetch_one(&b.pool)
            .await
            .unwrap();
        assert_eq!(purpose, "expression");
    }
}

#[tokio::test]
async fn a_bundle_does_not_write_over_an_object_that_is_already_here() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let hash = upload(&b, "profile", b"the real object").await;

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@bo:b.example", "filename": "x.png",
                   "mime": "image/png", "size": 4, "capability": "cap",
                   "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(b"not the real object"),
    }]);
    import_guild(&b, &bundle, "@ana:a.example").await.unwrap();

    let bytes = std::fs::read(b.cfg.media_dir.join(&hash[0..2]).join(&hash)).unwrap();
    assert_eq!(bytes, b"the real object", "the bundle overwrote an object it did not own");
    let purpose: String = sqlx::query_scalar("SELECT purpose FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(purpose, "profile", "the bundle made someone else's private object public");
}

#[tokio::test]
async fn an_expression_whose_bytes_were_refused_keeps_its_row_and_serves_nothing() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    with_disk_state(&a, &s).await;

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    assert_eq!(
        bundle["expressions"].as_array().unwrap().len(),
        2,
        "the guild should be exporting an emoji and a sticker"
    );

    let refused: Vec<String> = bundle["expressions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["media"]["hash"].as_str().unwrap().to_string())
        .collect();
    for asset in bundle["expressions"].as_array_mut().unwrap() {
        asset["data"] = json!(telium_server::util::b64(b"not what the name says"));
    }

    let new_guild = import_guild(&b, &bundle, "@ana:a.example").await.unwrap();

    let left: Vec<String> = sqlx::query_scalar(
        "SELECT media_hash FROM emojis WHERE guild_id = ? \
         UNION SELECT media_hash FROM stickers WHERE guild_id = ?",
    )
    .bind(&new_guild)
    .bind(&new_guild)
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(left.len(), 2, "the move dropped an expression row: {left:?}");

    for hash in &refused {
        assert!(
            !b.cfg.media_dir.join(&hash[0..2]).join(hash).exists(),
            "the refused bytes were written anyway: {hash}"
        );
        let row: Option<String> = sqlx::query_scalar("SELECT purpose FROM media WHERE hash = ?")
            .bind(hash)
            .fetch_optional(&b.pool)
            .await
            .unwrap();
        assert_eq!(row, None, "a media row was minted for bytes that never landed: {hash}");
    }

    let dangling_at_b = dangling(&b.pool, &new_guild).await;
    assert_eq!(
        dangling_at_b,
        vec![s.elsewhere.clone()],
        "refusing an asset left a message naming something that is not there"
    );
    assert!(
        !dangling_at_b.contains(&s.emoji) && !dangling_at_b.contains(&s.sticker),
        "the refused expressions are the thing left dangling: {dangling_at_b:?}"
    );
}

async fn make_the_archive_old(home: &Home, guild: &str) {
    let segments: Vec<(String, String)> = sqlx::query_as(
        "SELECT s.id, s.path FROM cold_segments s JOIN channels c ON c.id = s.channel_id \
         WHERE c.guild_id = ?",
    )
    .bind(guild)
    .fetch_all(&home.pool)
    .await
    .unwrap();
    assert!(!segments.is_empty(), "there is no archive to make old");

    for (_, path) in segments {
        let rows = {
            let gz = std::fs::read(&path).unwrap();
            let mut out = Vec::new();
            std::io::Read::read_to_end(
                &mut flate2::read::GzDecoder::new(&gz[..]),
                &mut out,
            )
            .unwrap();
            serde_json::from_slice::<Vec<Value>>(&out).unwrap()
        };
        let old: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.get("id"), "channel_id": r.get("channel_id"),
                    "guild_id": r.get("guild_id"), "author": r.get("author_id"),
                    "content": r.get("content"),
                    "attachments": r.get("attachments").and_then(Value::as_str)
                        .and_then(|a| serde_json::from_str::<Value>(a).ok())
                        .unwrap_or(json!([])),
                    "reply_to": r.get("reply_to"),
                    "deleted": r.get("deleted").and_then(Value::as_i64).unwrap_or(0) != 0,
                    "edited_at": r.get("edited_at"), "created_at": r.get("created_at"),
                })
            })
            .collect();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &serde_json::to_vec(&old).unwrap()).unwrap();
        std::fs::write(&path, gz.finish().unwrap()).unwrap();
    }
}

#[tokio::test]
async fn an_archive_written_by_the_old_code_still_moves() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    let moved = with_disk_state(&a, &s).await;
    make_the_archive_old(&a, &s.guild).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let here: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE guild_id = ?")
        .bind(&new_guild)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    let expected: i64 = sqlx::query_scalar("SELECT count(*) FROM messages WHERE guild_id = ?")
        .bind(&s.guild)
        .fetch_one(&a.pool)
        .await
        .unwrap();
    assert_eq!(here, expected + moved, "the old archive did not arrive");

    let orphaned: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM messages WHERE guild_id = ? AND (author_id IS NULL OR author_id = '')",
    )
    .bind(&new_guild)
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(orphaned, 0, "messages arrived with no author");
}

#[tokio::test]
async fn bytes_that_lie_about_an_unknown_hash_are_refused_too() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let claimed = blake3::hash(b"the object this name means").to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": claimed.clone(), "owner_user_id": "@bo:b.example",
                   "filename": "x.png", "mime": "image/png", "size": 4,
                   "capability": "cap", "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(b"something else entirely"),
    }]);
    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    assert!(
        !b.cfg.media_dir.join(&claimed[0..2]).join(&claimed).exists(),
        "bytes were written under a name they do not hash to"
    );
    let row: Option<String> = sqlx::query_scalar("SELECT hash FROM media WHERE hash = ?")
        .bind(&claimed)
        .fetch_optional(&b.pool)
        .await
        .unwrap();
    assert_eq!(row, None, "a media row was created for bytes that were refused");
}

#[tokio::test]
async fn a_bundle_does_not_get_to_describe_its_own_media() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bytes = b"<script>alert(origin)</script>".as_slice();
    let hash = blake3::hash(bytes).to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@victim:b.example",
                   "filename": "x.png", "mime": "text/html", "size": 9,
                   "capability": "cap", "purpose": "profile", "created_at": 1000,
                   "refcount": 999_999 },
        "data": telium_server::util::b64(bytes),
    }]);
    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let (owner, mime, size, refcount, purpose, capability): (String, String, i64, i64, String, Option<String>) =
        sqlx::query_as(
            "SELECT owner_user_id, mime, size, refcount, purpose, capability FROM media WHERE hash = ?",
        )
        .bind(&hash)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(mime, "image/png", "the bundle chose the Content-Type it is served as");
    assert_eq!(owner, "@ana:b.example", "the bundle billed the bytes to someone else");
    assert_eq!(size, bytes.len() as i64, "the bundle chose the size on record");
    assert_eq!(refcount, 1, "the bundle pinned the bytes against collection");
    assert_eq!(purpose, "expression", "the bundle chose what its bytes count as");
    assert_ne!(
        capability.as_deref(),
        Some("cap"),
        "the bundle chose the capability its bytes are unlocked by"
    );
}

fn refusal(e: telium_server::error::ApiError) -> String {
    match e {
        telium_server::error::ApiError::BadRequest(m) => format!("bad_request: {m}"),
        other => format!("{other:?}"),
    }
}

#[tokio::test]
async fn a_bundle_that_breaks_a_constraint_is_a_bad_request() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let members = bundle["members"].as_array().unwrap().clone();
    bundle["members"] = json!([members[0].clone(), members[0].clone()]);

    let e = import_guild(&b, &bundle, "@ana:b.example").await.unwrap_err();
    let told = refusal(e);
    assert!(told.starts_with("bad_request: "), "the sender was told {told}");
    assert!(told.contains("members"), "the sender was not told which rows: {told}");
}

#[tokio::test]
async fn a_row_with_nothing_in_it_is_a_bad_request_too() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["roles"] = json!([{ "nothing_here": 1 }]);

    let e = import_guild(&b, &bundle, "@ana:b.example").await.unwrap_err();
    assert!(refusal(e).starts_with("bad_request: "));
}

#[tokio::test]
async fn bytes_refused_by_screening_never_land() {
    const DENIED: &str = "forbidden bytes";
    const DENIED_SHA256: &str = "cb6cf1b18ae08a4ce3e3b9f0c1f19dc27b3891d07279b2ad908d4f92ba0ab795";

    let a = home("a.example").await;
    let b = home_with("b.example", |cfg| {
        let list = cfg.media_dir.with_file_name("hashes.txt");
        std::fs::write(&list, format!("{DENIED_SHA256}  listed\n")).unwrap();
        cfg.moderation.upload_hash_lists = vec![telium_server::config::HashListSource {
            name: "test-list".into(),
            algorithm: "sha256".into(),
            path: list,
        }];
    })
    .await;
    let s = seed(&a.pool).await;

    let bytes = DENIED.as_bytes();
    let hash = blake3::hash(bytes).to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@ana:a.example",
                   "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                   "capability": "cap", "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(bytes),
    }]);

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    assert!(
        !b.cfg.media_dir.join(&hash[0..2]).join(&hash).exists(),
        "bytes the screen refused were written to the store anyway"
    );
}

#[tokio::test]
async fn a_bundle_cannot_carry_more_expressions_than_a_guild_may_hold() {
    let a = home("a.example").await;
    let b = home_with("b.example", |cfg| {
        cfg.limits.max_emoji_per_guild = 1;
        cfg.limits.max_stickers_per_guild = 1;
    })
    .await;
    let s = seed(&a.pool).await;

    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let assets: Vec<Value> = (0u8..3)
        .map(|i| {
            let bytes = vec![i; 16];
            let hash = blake3::hash(&bytes).to_hex().to_string();
            json!({
                "media": { "hash": hash, "owner_user_id": "@ana:a.example",
                           "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                           "capability": "cap", "purpose": "expression", "created_at": 1000 },
                "data": telium_server::util::b64(&bytes),
            })
        })
        .collect();
    bundle["expressions"] = json!(assets);

    let refused = import_guild(&b, &bundle, "@ana:b.example").await.unwrap_err();
    let message = refusal(refused);
    assert!(
        message.contains("more expressions than a guild may hold"),
        "a bundle carrying three expressions landed on a server that allows two: {message}"
    );

    for i in 0u8..3 {
        let hash = blake3::hash(&[i; 16]).to_hex().to_string();
        assert!(
            !b.cfg.media_dir.join(&hash[0..2]).join(&hash).exists(),
            "a refused bundle still left bytes behind"
        );
    }
}

#[tokio::test]
async fn an_expression_too_big_to_upload_is_too_big_to_import() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bytes = vec![7u8; telium_server::routes::guild::MAX_EXPRESSION_BYTES + 1];
    let hash = blake3::hash(&bytes).to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@ana:a.example",
                   "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                   "capability": "cap", "purpose": "expression", "created_at": 1000 },
        "data": telium_server::util::b64(&bytes),
    }]);

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    assert!(
        !b.cfg.media_dir.join(&hash[0..2]).join(&hash).exists(),
        "an expression over the upload ceiling was written to the store"
    );
    let row: Option<String> = sqlx::query_scalar("SELECT hash FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_optional(&b.pool)
        .await
        .unwrap();
    assert!(row.is_none(), "an expression over the upload ceiling got a row");
}

#[tokio::test]
async fn a_bundle_cannot_put_an_expiry_on_its_bytes() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;

    let bytes = b"bytes with a fuse attached".as_slice();
    let hash = blake3::hash(bytes).to_hex().to_string();
    let mut bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    bundle["expressions"] = json!([{
        "media": { "hash": hash.clone(), "owner_user_id": "@ana:a.example",
                   "filename": "x.png", "mime": "image/png", "size": bytes.len(),
                   "capability": "cap", "purpose": "expression", "created_at": 1000,
                   "expires_at": 1 },
        "data": telium_server::util::b64(bytes),
    }]);

    import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let expiry: Option<i64> = sqlx::query_scalar("SELECT expires_at FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(expiry, None, "the bundle set an expiry on bytes it does not own");
}

#[tokio::test]
async fn a_successful_import_keeps_its_bytes() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let s = seed(&a.pool).await;
    with_disk_state(&a, &s).await;

    let bundle = migration::export_guild(&a, &s.guild).await.unwrap();
    let new_guild = import_guild(&b, &bundle, "@ana:b.example").await.unwrap();

    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT media_hash FROM emojis WHERE guild_id = ? AND media_hash IS NOT NULL",
    )
    .bind(&new_guild)
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert!(!hashes.is_empty(), "there are no expression bytes to check");
    for hash in hashes {
        assert!(
            b.cfg.media_dir.join(&hash[0..2]).join(&hash).exists(),
            "a committed import is missing the bytes its rows point at"
        );
    }
}
