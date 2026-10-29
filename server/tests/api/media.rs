use super::*;

#[tokio::test]
async fn media_capability_urls_gate_access_and_dedup_by_hash() {
    let s = start().await;
    let alice = s.user("alice").await;

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Filename", "note.txt")
        .header("Content-Type", "text/plain")
        .body("the bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap().to_string();
    let cap = media["capability"].as_str().unwrap().to_string();
    assert_eq!(media["origin"], "test.example");
    assert!(media["reference"].as_str().unwrap().starts_with("media://test.example/"));

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Filename", "again.txt")
        .body("the bytes")
        .send()
        .await
        .unwrap();
    let again: Value = resp.json().await.unwrap();
    assert_eq!(again["hash"], hash.as_str());

    let ok = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    assert_eq!(ok.text().await.unwrap(), "the bytes");

    let partial = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .header("Range", "bytes=4-7")
        .send()
        .await
        .unwrap();
    assert_eq!(partial.status().as_u16(), 206);
    assert_eq!(partial.headers().get("accept-ranges").unwrap(), "bytes");
    assert_eq!(partial.headers().get("content-range").unwrap(), "bytes 4-7/9");
    assert_eq!(partial.text().await.unwrap(), "byte");

    let guessed = s.client.get(format!("{}/_telium/v1/media/{hash}", s.base)).send().await.unwrap();
    assert_eq!(guessed.status().as_u16(), 404, "the content address alone must not be enough");
}

#[tokio::test]
async fn uploaded_media_expires_after_its_ttl_and_then_404s() {
    let s = start().await;
    let alice = s.user("alice").await;

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Filename", "note.txt")
        .header("Content-Type", "text/plain")
        .header("X-Telium-Ttl-Secs", "1")
        .body("the bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap().to_string();
    let cap = media["capability"].as_str().unwrap().to_string();

    let expires_at = media["expires_at"].as_i64().expect("expires_at present in response");
    let now = telium_server::util::now_ms();
    assert!(expires_at > now, "expires_at {expires_at} should be after now {now}");

    let ok = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 200);
    assert_eq!(ok.text().await.unwrap(), "the bytes");

    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let gone = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={cap}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status().as_u16(), 404, "expired media must 404 on fetch");

    let gone_meta = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(gone_meta.status().as_u16(), 404, "expired media must 404 on meta");
}

#[tokio::test]
async fn tier_one_upload_can_be_closed_without_breaking_profile_assets() {
    let s = start_with(|cfg| cfg.media_policy.default = MediaDefault::Disabled).await;
    let alice = s.user("alice").await;

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body("a general attachment")
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 403);

    let avatar = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Purpose", "profile")
        .header("Content-Type", "image/png")
        .body("pretend png")
        .send()
        .await
        .unwrap();
    assert_eq!(avatar.status().as_u16(), 200, "profile assets are carved out of the media policy");

    let (_, caps) = s.get("/_telium/v1/capabilities", Some(&alice.home)).await;
    assert_eq!(caps["account"]["tier1_upload"], false);
    assert_eq!(caps["media"]["default_policy"], "disabled");
}

#[tokio::test]
async fn the_upload_tier_is_account_state_and_survives_a_new_session() {
    let s = start_with(|cfg| {
        cfg.media_registry.hosts.push(telium_server::config::RegistryHost {
            origin: "files.example".into(),
            name: "Example Files".into(),
            ..Default::default()
        });
    })
    .await;
    let alice = s.user("alice").await;

    let (_, default) = s.get("/_telium/v1/media/preference", Some(&alice.home)).await;
    assert_eq!(default["tier"], 1, "an account that has never chosen is on its homeserver");

    let (_, feed) = s.get("/_telium/v1/media/registry", Some(&alice.home)).await;
    assert_eq!(feed["hosts"][0]["origin"], "files.example");
    assert_eq!(feed["gofile_playback_proxy"], true);
    assert!(feed["external_hosts"].as_array().unwrap().iter().any(|host| {
        host["provider"] == "gofile" && host["domain"] == "gofile.io"
    }));

    let (status, body) = s
        .put("/_telium/v1/media/preference", &alice.home, json!({ "tier": 2, "origin": "Files.Example" }))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["origin"], "files.example");

    let (status, _) = s
        .put("/_telium/v1/media/preference", &alice.home, json!({ "tier": 2, "origin": "https://files.example/upload" }))
        .await;
    assert_eq!(status, 400);
    let (status, _) = s.put("/_telium/v1/media/preference", &alice.home, json!({ "tier": 2 })).await;
    assert_eq!(status, 400, "tier 2 without a host is not a choice");

    let (_, login) = s
        .post("/_telium/v1/login", None, json!({ "user": "alice", "password": "correct horse battery" }))
        .await;
    let other_device = login["access_token"].as_str().unwrap();
    let (_, seen) = s.get("/_telium/v1/media/preference", Some(other_device)).await;
    assert_eq!(seen["tier"], 2);
    assert_eq!(seen["origin"], "files.example");

    let (_, back) = s.put("/_telium/v1/media/preference", &alice.home, json!({ "tier": 1 })).await;
    assert!(back["origin"].is_null());
}

#[tokio::test]
async fn gofile_web_playback_proxy_can_be_disabled_without_disabling_gofile() {
    let s = start_with(|cfg| {
        cfg.media_registry.gofile_playback_proxy = false;
    })
    .await;
    let alice = s.user("alice").await;

    let (_, feed) = s.get("/_telium/v1/media/registry", Some(&alice.home)).await;
    assert_eq!(feed["gofile_playback_proxy"], false);
    assert!(feed["external_hosts"].as_array().unwrap().iter().any(|host| {
        host["provider"] == "gofile" && host["browser_direct"] == true
    }));

    let (status, _) = s
        .post(
            "/_telium/v1/media/external/gofile/playback",
            Some(&alice.home),
            json!({ "url": "https://store1.gofile.io/download/web/file/movie.mp4" }),
        )
        .await;
    assert_eq!(status, 404, "disabled playback proxy route must not be mounted");
}

#[tokio::test]
async fn an_avatar_is_capped_far_below_the_general_attachment_limit() {
    let s = start_with(|cfg| cfg.media_policy.max_profile_asset_bytes = 1024).await;
    let alice = s.user("alice").await;
    let big = "x".repeat(4096);

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Purpose", "profile")
        .header("Content-Type", "image/png")
        .body(big.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413);

    let allowed = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "image/png")
        .body(big)
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status().as_u16(), 200);
}

#[tokio::test]
async fn an_expression_asset_claims_shared_bytes_as_public() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let picture = png_fixture(40, 40);
    let stored = normalized(&s, &picture, telium_server::expression::Kind::Emoji);
    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Purpose", "profile")
        .header("Content-Type", "image/png")
        .body(stored.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let media: Value = resp.json().await.unwrap();
    let hash = media["hash"].as_str().unwrap().to_string();
    let guessed = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(guessed.status().as_u16(), 404, "a profile asset is still capability-gated");

    let data = URL_SAFE_NO_PAD.encode(&picture);
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "same", "data": data, "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    assert!(
        emoji["reference"].as_str().unwrap().ends_with(&hash),
        "the emoji must land on the object the profile asset made: {emoji}"
    );

    let public = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(public.status().as_u16(), 200, "an emoji's bytes must be fetchable by anyone");
    assert_eq!(public.bytes().await.unwrap().as_ref(), &stored[..]);
}

#[tokio::test]
async fn profile_updates_bump_the_version_that_keeps_member_caches_honest() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, before) = s.get(&format!("/_telium/v1/users/{}/profile", alice.user_id), None).await;
    let v0 = before["profile_version"].as_i64().unwrap();

    let (status, _) = s.patch("/_telium/v1/profile", &alice.home, json!({ "display_name": "Alice A." })).await;
    assert_eq!(status, 200);

    let (_, after) = s.get(&format!("/_telium/v1/users/{}/profile", alice.user_id), None).await;
    assert_eq!(after["display_name"], "Alice A.");
    assert!(after["profile_version"].as_i64().unwrap() > v0);
    assert!(after["signature"].is_string());
}

#[tokio::test]
async fn profile_theme_is_a_pair_or_nothing() {
    let s = start().await;
    let alice = s.user("alice").await;
    let path = format!("/_telium/v1/users/{}/profile", alice.user_id);

    let (status, _) = s.patch("/_telium/v1/profile", &alice.home, json!({ "theme_colors": [0xf0e0c0, 0] })).await;
    assert_eq!(status, 200);
    let (_, p) = s.get(&path, None).await;
    assert_eq!(p["theme_colors"], json!([0xf0e0c0, 0]));

    for bad in [json!([1]), json!([0x100_0000, 0]), json!([-1, 0])] {
        let (status, _) = s.patch("/_telium/v1/profile", &alice.home, json!({ "theme_colors": bad })).await;
        assert!(status == 400 || status == 422, "{bad} gave {status}");
    }

    s.patch("/_telium/v1/profile", &alice.home, json!({ "theme_colors": null })).await;
    let (_, p) = s.get(&path, None).await;
    assert!(p["theme_colors"].is_null(), "{p}");
}

#[tokio::test]
async fn expression_assets_are_guild_owned_and_public_by_construction() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let picture = png_fixture(32, 32);
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "party", "data": URL_SAFE_NO_PAD.encode(&picture), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    assert!(emoji["reference"].as_str().unwrap().starts_with("media://test.example/"));

    let hash = emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    let resp = s.client.get(format!("{}/_telium/v1/media/{hash}", s.base)).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "expression assets must be fetchable by anyone");

    let eid = emoji["id"].as_str().unwrap().to_string();
    let resp = s.client.get(format!("{}/_telium/v1/emoji/{eid}", s.base)).send().await.unwrap();
    let final_resp = match resp.status().as_u16() {
        301 | 302 | 307 | 308 => {
            let loc = resp.headers().get("location").unwrap().to_str().unwrap().to_string();
            assert!(loc.contains(&hash), "emoji {eid} should redirect to its media: {loc}");
            s.client.get(format!("{}{loc}", s.base)).send().await.unwrap()
        }
        _ => resp,
    };
    assert_eq!(final_resp.status().as_u16(), 200, "emoji id must resolve to the media bytes");
    let bytes = final_resp.bytes().await.unwrap();
    assert_eq!(bytes.as_ref(), &normalized(&s, &picture, telium_server::expression::Kind::Emoji)[..]);
}

#[tokio::test]
async fn an_svg_is_refused_whatever_mime_it_claims() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let svg = URL_SAFE_NO_PAD.encode(b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    for (path, body) in [
        ("emojis", json!({ "name": "vector", "data": svg, "mime": "image/png" })),
        ("emojis", json!({ "name": "vector", "data": svg, "mime": "image/svg+xml" })),
        ("stickers", json!({ "name": "vector", "data": svg, "format": "png" })),
    ] {
        let (status, err) = s.post(&format!("/_telium/v1/guilds/{gid}/{path}"), Some(&alice.token), body).await;
        assert_eq!(status, 400, "{err}");
        let message = err["message"].as_str().unwrap();
        assert!(message.contains("SVG"), "the refusal names what is accepted: {message}");
    }

    for data in [URL_SAFE_NO_PAD.encode(b"a tiny png"), URL_SAFE_NO_PAD.encode(&png_fixture(64, 64)[..40])] {
        let (status, err) = s
            .post(
                &format!("/_telium/v1/guilds/{gid}/emojis"),
                Some(&alice.token),
                json!({ "name": "bytes", "data": data, "mime": "image/png" }),
            )
            .await;
        assert_eq!(status, 400, "{err}");
    }
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(count, 0, "a refused upload leaves nothing behind");
}

#[tokio::test]
async fn a_jpeg_emoji_is_stored_and_served_as_a_png() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let photo = jpeg_fixture(512, 256);
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "photo", "data": URL_SAFE_NO_PAD.encode(&photo), "mime": "image/jpeg" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    assert_eq!(emoji["animated"], false);

    let hash = emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    let resp = s.client.get(format!("{}/_telium/v1/media/{hash}", s.base)).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.headers().get("content-type").unwrap().to_str().unwrap(), "image/png");
    let bytes = resp.bytes().await.unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "the object under the hash is the PNG, not the JPEG");
    assert_eq!(blake3::hash(&bytes).to_hex().to_string(), hash, "the hash is of the stored bytes");

    let (mime, size, width, height) = media_row(&s, &hash).await;
    assert_eq!(mime, "image/png");
    assert_eq!(size, bytes.len() as i64);
    assert_eq!((width, height), (Some(128), Some(64)), "fitted into the emoji box, shape kept");
}

#[tokio::test]
async fn a_gif_is_animated_whatever_the_request_says() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let clip = URL_SAFE_NO_PAD.encode(&gif_fixture(48, 48, 4));
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "spin", "data": clip, "mime": "image/png", "animated": false }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    assert_eq!(emoji["animated"], true, "animated is read off the bytes: {emoji}");

    let (status, sticker) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/stickers"),
            Some(&alice.token),
            json!({ "name": "spin", "data": clip, "format": "png" }),
        )
        .await;
    assert_eq!(status, 200, "{sticker}");
    assert_eq!(sticker["animated"], true);
    let sid = sticker["id"].as_str().unwrap();
    let (format,): (String,) = sqlx::query_as("SELECT format FROM stickers WHERE id = ?")
        .bind(sid).fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(format, "gif", "a sticker's format is the stored object's, not the request's");

    let hash = emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string();
    assert!(sticker["reference"].as_str().unwrap().ends_with(&hash));
    let resp = s.client.get(format!("{}/_telium/v1/media/{hash}", s.base)).send().await.unwrap();
    assert_eq!(resp.headers().get("content-type").unwrap().to_str().unwrap(), "image/gif");
    assert_eq!(&resp.bytes().await.unwrap()[..6], b"GIF89a");

    let (_, listed) = s.get(&format!("/_telium/v1/guilds/{gid}/expressions"), Some(&alice.token)).await;
    assert_eq!(listed["emojis"][0]["animated"], true, "{listed}");
    assert_eq!(listed["stickers"][0]["animated"], true, "{listed}");

    let (status, still) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "stop", "data": URL_SAFE_NO_PAD.encode(&gif_fixture(48, 48, 1)), "animated": true }),
        )
        .await;
    assert_eq!(status, 200, "{still}");
    assert_eq!(still["animated"], false);
}

#[tokio::test]
async fn the_same_image_uploaded_twice_is_one_object() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let picture = png_fixture(64, 48);
    let mut hashes = Vec::new();
    for name in ["one", "two"] {
        let (status, emoji) = s
            .post(
                &format!("/_telium/v1/guilds/{gid}/emojis"),
                Some(&alice.token),
                json!({ "name": name, "data": URL_SAFE_NO_PAD.encode(&picture), "mime": "image/png" }),
            )
            .await;
        assert_eq!(status, 200, "{emoji}");
        hashes.push(emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string());
    }
    let mut with_text = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut with_text, 64, 48);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.add_text_chunk("Software".into(), "an editor".into()).unwrap();
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(image::load_from_memory(&picture).unwrap().into_rgba8().as_raw()).unwrap();
    }
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "three", "data": URL_SAFE_NO_PAD.encode(&with_text), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    hashes.push(emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string());

    assert_eq!(hashes[0], hashes[1]);
    assert_eq!(hashes[0], hashes[2], "metadata does not make a different object");
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(rows, 1, "three emoji, one media row");
    let (emojis,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM emojis WHERE guild_id = ?")
        .bind(&gid).fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(emojis, 3);
}

// --- reference accounting and reclamation -----------------------------------

async fn upload_attachment(s: &Server, who: &User, cid: Option<&str>, body: &str) -> Value {
    let mut req = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&who.home)
        .header("X-Telium-Filename", "note.txt")
        .header("Content-Type", "text/plain")
        .body(body.to_string());
    if let Some(cid) = cid {
        req = req.header("X-Telium-Channel-Id", cid);
    }
    let resp = req.send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    resp.json().await.unwrap()
}

async fn attachment_entry(s: &Server, who: &User, cid: Option<&str>, body: &str) -> (Value, Value) {
    let media = upload_attachment(s, who, cid, body).await;
    let entry = json!({
        "origin": media["origin"],
        "hash": media["hash"],
        "filename": media["filename"],
        "mime": media["mime"],
        "size": media["size"],
        "capability": media["capability"],
    });
    (media, entry)
}

async fn media_refs(s: &Server, hash: &str) -> (i64, i64) {
    sqlx::query_as("SELECT refs, local_dest FROM media WHERE hash = ?")
        .bind(hash)
        .fetch_one(&s.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn deleting_a_message_releases_its_upload_for_reclamation() {
    let (s, alice, _bob, _gid, cid) = social_fixture().await;
    let (media, entry) = attachment_entry(&s, &alice, Some(&cid), "the bytes").await;
    let hash = media["hash"].as_str().unwrap().to_string();

    let (status, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({
            "content": "here you go", "attachments": [entry],
        }))
        .await;
    assert_eq!(status, 200, "{msg}");
    let (refs, local_dest) = media_refs(&s, &hash).await;
    assert_eq!(refs, 1, "a sent message claims its upload");
    assert_eq!(local_dest, 1, "an upload aimed at a local channel is reclaimable here");

    let mid = msg["id"].as_str().unwrap().to_string();
    let (status, _) = s
        .delete(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token)
        .await;
    assert_eq!(status, 200);
    let (refs, _) = media_refs(&s, &hash).await;
    assert_eq!(refs, 0, "a deleted message releases its claim");

    let swept = telium_server::routes::media::sweep_unreferenced_before(
        &s.state,
        telium_server::util::now_ms() + 1000,
    )
    .await
    .unwrap();
    assert_eq!(swept, 1);
    let gone = s
        .client
        .get(format!("{}/_telium/v1/media/{hash}?cap={}", s.base, media["capability"].as_str().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status().as_u16(), 404, "reclaimed bytes must stop serving");
}

#[tokio::test]
async fn a_message_still_referencing_its_upload_blocks_reclamation() {
    let (s, alice, _bob, _gid, cid) = social_fixture().await;
    let (media, entry) = attachment_entry(&s, &alice, Some(&cid), "kept").await;
    let hash = media["hash"].as_str().unwrap().to_string();

    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({
            "content": "still here", "attachments": [entry],
        }))
        .await;
    assert_eq!(status, 200);

    let swept = telium_server::routes::media::sweep_unreferenced_before(
        &s.state,
        telium_server::util::now_ms() + 1000,
    )
    .await
    .unwrap();
    assert_eq!(swept, 0, "a live message protects its upload");
    let alive = s
        .client
        .get(format!("{}/_telium/v1/media/{}?cap={}", s.base, hash, media["capability"].as_str().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(alive.status().as_u16(), 200);
}

#[tokio::test]
async fn an_upload_without_a_local_destination_is_never_reference_reclaimed() {
    let (s, alice, _bob, _gid, _cid) = social_fixture().await;
    // No channel or guild header: the shape of an end-to-end-encrypted
    // conversation upload or a tier-2 origin storing bytes for someone else.
    let (media, _entry) = attachment_entry(&s, &alice, None, "sealed").await;
    let hash = media["hash"].as_str().unwrap().to_string();
    let (refs, local_dest) = media_refs(&s, &hash).await;
    assert_eq!(refs, 0);
    assert_eq!(local_dest, 0, "no local destination, no local authority");

    let swept = telium_server::routes::media::sweep_unreferenced_before(
        &s.state,
        telium_server::util::now_ms() + 1000,
    )
    .await
    .unwrap();
    assert_eq!(swept, 0, "this server cannot see who still refers to it");
    let alive = s
        .client
        .get(format!("{}/_telium/v1/media/{}?cap={}", s.base, hash, media["capability"].as_str().unwrap()))
        .send()
        .await
        .unwrap();
    assert_eq!(alive.status().as_u16(), 200);
}

#[tokio::test]
async fn deleting_a_channel_releases_every_attachment_it_held() {
    let (s, alice, _bob, gid, cid) = social_fixture().await;
    let mut hashes = Vec::new();
    for body in ["first", "second"] {
        let (media, entry) = attachment_entry(&s, &alice, Some(&cid), body).await;
        let (status, msg) = s
            .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({
                "content": body, "attachments": [entry],
            }))
            .await;
        assert_eq!(status, 200, "{msg}");
        hashes.push(media["hash"].as_str().unwrap().to_string());
    }

    let (status, _) = s.delete(&format!("/_telium/v1/channels/{cid}"), &alice.token).await;
    assert_eq!(status, 200);

    let swept = telium_server::routes::media::sweep_unreferenced_before(
        &s.state,
        telium_server::util::now_ms() + 1000,
    )
    .await
    .unwrap();
    assert_eq!(swept, 2, "both uploads go with the channel");
    for hash in &hashes {
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media WHERE hash = ?")
            .bind(hash)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
        assert_eq!(rows, 0, "{hash}");
    }
}

#[tokio::test]
async fn expression_media_is_not_reference_reclaimed() {
    let (s, alice, _bob, gid, _cid) = social_fixture().await;
    let picture = png_fixture(32, 32);
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "party", "data": URL_SAFE_NO_PAD.encode(&picture), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    let hash = emoji["reference"].as_str().unwrap().rsplit('/').next().unwrap().to_string();

    let swept = telium_server::routes::media::sweep_unreferenced_before(
        &s.state,
        telium_server::util::now_ms() + 1000,
    )
    .await
    .unwrap();
    assert_eq!(swept, 0, "expressions are not attachments; the sweep does not judge them");
    let alive = s.client.get(format!("{}/_telium/v1/media/{hash}", s.base)).send().await.unwrap();
    assert_eq!(alive.status().as_u16(), 200);
}

#[tokio::test]
async fn an_owner_cannot_delete_deduplicated_content_another_upload_holds() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let bytes = "the same bytes twice";

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&bob.home)
        .header("Content-Type", "text/plain")
        .body(bytes.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let hash = resp.json::<Value>().await.unwrap()["hash"].as_str().unwrap().to_string();

    let resp = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body(bytes.to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "dedup lands on the same object");
    let (refcount,): (i64,) = sqlx::query_as("SELECT refcount FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(refcount, 2, "two uploads claim one object");

    // Bob owns the row but not the content: deleting would break Alice's copy.
    let (status, refused) = s
        .delete(&format!("/_telium/v1/media/{hash}"), &bob.home)
        .await;
    assert_eq!(status, 409, "{refused}");
    assert!(refused["message"].as_str().unwrap().contains("shared"), "{refused}");
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1, "a refused delete removes nothing");

    // The operator's takedown does not ask.
    let (status, gone) = s.delete(&format!("/_telium/v1/media/{hash}"), &alice.home).await;
    assert_eq!(status, 200, "{gone}");
    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media WHERE hash = ?")
        .bind(&hash)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn an_owner_may_delete_a_file_their_own_message_still_holds() {
    let (s, alice, _bob, _gid, cid) = social_fixture().await;
    let (media, entry) = attachment_entry(&s, &alice, Some(&cid), "mine to remove").await;
    let hash = media["hash"].as_str().unwrap().to_string();

    let (status, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({
            "content": "look at this", "attachments": [entry],
        }))
        .await;
    assert_eq!(status, 200, "{msg}");

    // One refcount claim (their upload) even though a message references it:
    // pulling your own file is the point of the endpoint.
    let (status, gone) = s.delete(&format!("/_telium/v1/media/{hash}"), &alice.home).await;
    assert_eq!(status, 200, "{gone}");
}

#[tokio::test]
async fn a_default_expiry_applies_only_where_the_client_chose_none() {
    let s = start_with(|cfg| cfg.media_policy.default_expiry_secs = 3_600).await;
    let alice = s.user("alice").await;
    let upload = |ttl: Option<&str>| {
        let mut req = s
            .client
            .post(format!("{}/_telium/v1/media", s.base))
            .bearer_auth(&alice.home)
            .header("Content-Type", "text/plain")
            .body("kept for a while".to_string());
        if let Some(ttl) = ttl {
            req = req.header("X-Telium-Ttl-Secs", ttl);
        }
        async move { req.send().await.unwrap().json::<Value>().await.unwrap() }
    };

    let now = telium_server::util::now_ms();
    let defaulted = upload(None).await;
    let chosen = upload(Some("60")).await;
    // A year is the most a client may ask for (366 days is refused at the header).
    let a_year = upload(Some("31536000")).await;

    let in_hours = defaulted["expires_at"].as_i64().unwrap() - now;
    assert!(
        (3_000_000..4_200_000).contains(&in_hours),
        "the default TTL lands near an hour: {in_hours}ms"
    );
    let in_minutes = chosen["expires_at"].as_i64().unwrap() - now;
    assert!(
        (30_000..90_000).contains(&in_minutes),
        "a client's own TTL is never widened: {in_minutes}ms"
    );
    assert!(
        a_year["expires_at"].as_i64().unwrap() > now + 300 * 24 * 60 * 60 * 1000,
        "a longer request still wins over the default"
    );
}

#[tokio::test]
async fn the_age_sweep_takes_only_attachments_past_the_ceiling() {
    let s = start_with(|cfg| cfg.media_policy.attachment_max_age_days = 1).await;
    let alice = s.user("alice").await;

    let old = upload_attachment(&s, &alice, None, "ancient").await;
    let young = upload_attachment(&s, &alice, None, "recent").await;
    let avatar = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Purpose", "profile")
        .header("Content-Type", "image/png")
        .body("pretend png".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(avatar.status().as_u16(), 200);
    let profile_hash = avatar.json::<Value>().await.unwrap()["hash"].as_str().unwrap().to_string();

    let two_days_ago = telium_server::util::now_ms() - 2 * 24 * 60 * 60 * 1000;
    sqlx::query("UPDATE media SET created_at = ? WHERE hash = ?")
        .bind(two_days_ago)
        .bind(old["hash"].as_str().unwrap())
        .execute(&s.state.pool)
        .await
        .unwrap();

    let swept = telium_server::routes::media::sweep_aged_attachments(&s.state).await.unwrap();
    assert_eq!(swept, 1, "only the aged attachment goes");

    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media WHERE hash = ?")
        .bind(old["hash"].as_str().unwrap())
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
    for survivor in [young["hash"].as_str().unwrap(), profile_hash.as_str()] {
        let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media WHERE hash = ?")
            .bind(survivor)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
        assert_eq!(rows, 1, "{survivor} is not past the ceiling, or not an attachment");
    }
}

#[tokio::test]
async fn the_destination_size_cap_narrows_what_the_server_accepts() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(channels["channels"][0]["media_max_file_bytes"], Value::Null);

    // A guild cap alone stops an upload aimed at any of its channels.
    let (status, patched) = s
        .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "media_max_file_bytes": 10 }))
        .await;
    assert_eq!(status, 200, "{patched}");
    assert_eq!(patched["media_max_file_bytes"], 10);

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Channel-Id", &cid)
        .header("Content-Type", "text/plain")
        .body("too big for this guild".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413, "over the guild cap");
    assert!(refused.json::<Value>().await.unwrap()["message"].as_str().unwrap().contains("destination"));

    // A channel may tighten it further, and the narrowest wins.
    let (status, _) = s
        .patch(&format!("/_telium/v1/channels/{cid}"), &alice.token, json!({ "media_max_file_bytes": 5 }))
        .await;
    assert_eq!(status, 200);
    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Channel-Id", &cid)
        .header("Content-Type", "text/plain")
        .body("123456".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413, "over the channel cap, under the guild's");

    let allowed = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Channel-Id", &cid)
        .header("Content-Type", "text/plain")
        .body("12345".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(allowed.status().as_u16(), 200);

    // Removing the channel cap falls back to the guild's.
    let (status, _) = s
        .patch(&format!("/_telium/v1/channels/{cid}"), &alice.token, json!({ "media_max_file_bytes": null }))
        .await;
    assert_eq!(status, 200);
    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Channel-Id", &cid)
        .header("Content-Type", "text/plain")
        .body("12345678901".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413, "the guild cap is back in force");

    // Zero is not a cap, it is a mistake.
    let (status, err) = s
        .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "media_max_file_bytes": 0 }))
        .await;
    assert_eq!(status, 400, "{err}");
}

#[tokio::test]
async fn the_guild_cap_does_not_cage_profile_assets() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (status, _) = s
        .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "media_max_file_bytes": 4 }))
        .await;
    assert_eq!(status, 200);

    let avatar = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("X-Telium-Purpose", "profile")
        .header("Content-Type", "image/png")
        .body("pretend png".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(avatar.status().as_u16(), 200, "the cap is for attachments, not avatars");
}

#[tokio::test]
async fn a_refused_upload_leaves_no_staging_file_or_row_behind() {
    // Over the global cap: the stream is cut mid-flight.
    let s = start_with(|cfg| cfg.media_policy.max_file_bytes = 8).await;
    let alice = s.user("alice").await;

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body("these bytes are much too long for the cap".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413);
    assert!(
        refused.json::<Value>().await.unwrap()["message"].as_str().unwrap().contains("limit"),
        "the refusal names the cap"
    );

    let (rows,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM media").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!(rows, 0, "an aborted upload stores nothing");
    let staging = s.dir.join("media").join("tmp");
    let leftovers = staging.exists()
        && std::fs::read_dir(&staging).unwrap().count() > 0;
    assert!(!leftovers, "the staging directory is empty after a refusal");
}

#[tokio::test]
async fn an_upload_past_the_quota_is_refused_after_staging_and_leaves_nothing() {
    let s = start_with(|cfg| {
        cfg.media_policy.default = MediaDefault::Quota;
        cfg.media_policy.quota_bytes = 16;
    })
    .await;
    let alice = s.user("alice").await;

    let first = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body("0123456789abcdef".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(first.status().as_u16(), 200);

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body("over the quota entirely".to_string())
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 413);
    assert!(
        refused.json::<Value>().await.unwrap()["message"].as_str().unwrap().contains("quota"),
        "the refusal names the quota"
    );

    let (count, total): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media").fetch_one(&s.state.pool).await.unwrap();
    assert_eq!((count, total), (1, 16), "only the first upload is on the books");
    let staging = s.dir.join("media").join("tmp");
    let leftovers = staging.exists() && std::fs::read_dir(&staging).unwrap().count() > 0;
    assert!(!leftovers, "staging bytes of a refused upload do not linger");
}

#[tokio::test]
async fn parallel_uploads_of_one_account_never_overshoot_its_quota() {
    let s = start_with(|cfg| {
        cfg.media_policy.default = MediaDefault::Quota;
        cfg.media_policy.quota_bytes = 100;
    })
    .await;
    let alice = s.user("alice").await;
    let upload = |n: usize| {
        let client = s.client.clone();
        let url = format!("{}/_telium/v1/media", s.base);
        let token = alice.home.clone();
        async move {
            client
                .post(url)
                .bearer_auth(&token)
                .header("Content-Type", "text/plain")
                .body(format!("{:060}", n))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16()
        }
    };

    // Sixty-byte uploads: two fit the quota of one hundred, the rest must not
    // ride in on a stale total while the first two are still landing.
    let outcomes: Vec<u16> = futures_util::future::join_all((0..6).map(upload)).await;
    let accepted = outcomes.iter().filter(|s| **s == 200).count();
    let (total,): (i64,) =
        sqlx::query_as("SELECT COALESCE(SUM(size), 0) FROM media").fetch_one(&s.state.pool).await.unwrap();
    assert!(
        total <= 100,
        "the quota was overshoot by parallel uploads: {total} bytes, outcomes {outcomes:?}"
    );
    assert_eq!(accepted, total as usize / 60, "outcomes {outcomes:?}");
}

#[tokio::test]
async fn the_operator_can_see_who_is_filling_the_disk() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    for (who, pile) in [(&alice, "alice's personal pile of bytes"), (&bob, "bob's own pile")] {
        let resp = s
            .client
            .post(format!("{}/_telium/v1/media", s.base))
            .bearer_auth(&who.home)
            .header("Content-Type", "text/plain")
            .body(pile.to_string())
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }

    // Alice registered first: she is the server's operator.
    let (status, listed) = s.get("/_telium/v1/admin/storage/media-consumers", Some(&alice.home)).await;
    assert_eq!(status, 200, "{listed}");
    let consumers = listed["consumers"].as_array().unwrap();
    assert_eq!(consumers.len(), 2, "{listed}");
    assert_eq!(consumers[0]["objects"], 1);
    assert_eq!(consumers[0]["bytes"], 30);

    let (status, refused) = s.get("/_telium/v1/admin/storage/media-consumers", Some(&bob.home)).await;
    assert_eq!(status, 403, "{refused}");
}

fn jpeg_fixture(width: u32, height: u32) -> Vec<u8> {    let image = image::RgbImage::from_fn(width, height, |x, y| image::Rgb([x as u8, y as u8, 200]));
    let mut out = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(image).write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

fn gif_fixture(width: u32, height: u32, frames: u32) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut out);
        encoder.set_repeat(image::codecs::gif::Repeat::Infinite).unwrap();
        for i in 0..frames {
            let shade = (i * 60 % 256) as u8;
            let image = image::RgbaImage::from_pixel(width, height, image::Rgba([shade, 255 - shade, 60, 255]));
            let delay = image::Delay::from_numer_denom_ms(80, 1);
            encoder.encode_frame(image::Frame::from_parts(image, 0, 0, delay)).unwrap();
        }
    }
    out.into_inner()
}

fn normalized(s: &Server, bytes: &[u8], kind: telium_server::expression::Kind) -> Vec<u8> {
    let limits = telium_server::expression::Limits::from_config(&s.state.cfg.limits);
    telium_server::expression::normalize(bytes, kind, &limits).unwrap().bytes
}

async fn media_row(s: &Server, hash: &str) -> (String, i64, Option<i64>, Option<i64>) {
    sqlx::query_as("SELECT mime, size, width, height FROM media WHERE hash = ?")
        .bind(hash)
        .fetch_one(&s.state.pool)
        .await
        .unwrap()
}
