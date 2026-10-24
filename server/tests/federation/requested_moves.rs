use super::*;

async fn dispatched(ws: &mut Ws, t: &str) -> Value {
    loop {
        let f = frame(ws).await;
        if f["op"] == "DISPATCH" && f["t"] == t {
            return f["d"].clone();
        }
    }
}

type Inbox = std::sync::Arc<std::sync::Mutex<Vec<(Option<String>, Value)>>>;

async fn mail_catcher() -> (String, Inbox) {
    let inbox: Inbox = Default::default();
    let held = inbox.clone();
    let app = axum::Router::new().route(
        "/send",
        axum::routing::post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let held = held.clone();
            async move {
                let auth = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                held.lock().unwrap().push((auth, body));
                axum::http::StatusCode::ACCEPTED
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/send", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (url, inbox)
}

async fn open_move(a: &Server, b: &Server, alice: &Account, arrival: &str) -> Value {
    let arrival = register_full(b, arrival).await;
    let (_, claim) = b
        .post(
            "/_telium/v1/migrate/accept",
            Some(&arrival.token),
            json!({ "subject_type": "user", "source": "a.test", "source_id": "@alice:a.test" }),
        )
        .await;
    let import_token = claim["import_token"].as_str().expect("a claim").to_string();
    let created_at = now_ms();
    let payload =
        telium_server::migration::grant_payload("@alice:a.test", "b.test", &import_token, created_at);
    let (status, started) = a
        .post(
            "/_telium/v1/migrate",
            Some(&alice.token),
            json!({
                "subject_type": "user", "destination": "b.test",
                "import_token": import_token, "password": "correct horse battery",
                "device_signature": device_sign(&alice.secret, &payload), "created_at": created_at,
            }),
        )
        .await;
    assert_eq!(status, 200, "{started}");
    started
}

async fn migration_state(server: &Server, token: &str, id: &str) -> Value {
    let (_, listed) = server.get("/_telium/v1/migrate", Some(token)).await;
    listed["migrations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == id)
        .cloned()
        .expect("the migration is listed")
}

#[tokio::test]
async fn a_requested_move_reaches_every_session_and_the_recovery_address() {
    let (hook, inbox) = mail_catcher().await;
    let (a, b) = pair_tuned(3600, &move |cfg: &mut Config| {
        cfg.mail.mode = "webhook".into();
        cfg.mail.webhook_url = hook.clone();
        cfg.mail.webhook_token = "relay-secret".into();
    })
    .await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let (status, phone) = a
        .post(
            "/_telium/v1/login",
            None,
            json!({ "user": "alice", "password": "correct horse battery", "device_name": "phone" }),
        )
        .await;
    assert_eq!(status, 200, "{phone}");
    let phone_token = phone["access_token"].as_str().unwrap().to_string();

    let (status, refused) = a
        .put("/_telium/v1/account/recovery-email", &alice.token, json!({ "email": "alice@mail.example" }))
        .await;
    assert_eq!(status, 400, "no password, no change: {refused}");
    assert!(refused["message"].as_str().unwrap().contains("reauthentication"), "{refused}");
    let (status, set) = a
        .put(
            "/_telium/v1/account/recovery-email",
            &alice.token,
            json!({ "email": "alice@mail.example", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "{set}");
    assert_eq!(set["state"], "pending", "{set}");
    assert_eq!(set["pending_email"], "alice@mail.example");
    assert_eq!(set["verified_email"], Value::Null, "{set}");
    assert_eq!(set["mailer"], true);

    let mut waited = 0;
    while inbox.lock().unwrap().is_empty() {
        assert!(waited < 100, "no confirmation challenge reached the webhook");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        waited += 1;
    }
    let (_, challenge) = inbox.lock().unwrap()[0].clone();
    assert_eq!(challenge["to"], "alice@mail.example");
    let confirm = challenge["text"]
        .as_str()
        .unwrap()
        .split_whitespace()
        .find(|w| w.contains("/_telium/v1/account/recovery-email/confirm?t="))
        .expect("a confirmation link in the challenge")
        .to_string();
    let confirm_token = confirm.split("t=").nth(1).unwrap().to_string();
    let answered = a
        .client
        .post(format!("{}/_telium/v1/account/recovery-email/confirm", a.base))
        .form(&[("t", confirm_token.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(answered.status().as_u16(), 200, "confirming the address");
    let (_, on_file) = a.get("/_telium/v1/account/recovery-email", Some(&alice.token)).await;
    assert_eq!(on_file["state"], "verified", "{on_file}");
    assert_eq!(on_file["verified_email"], "alice@mail.example");
    inbox.lock().unwrap().clear();

    let mut laptop = gateway(&a, &local_session(&a, &alice.token).await).await;
    let mut handset = gateway(&a, &local_session(&a, &phone_token).await).await;

    let started = open_move(&a, &b, &alice, "alice2").await;
    let id = started["id"].as_str().unwrap().to_string();
    let deadline = started["executes_at"].as_i64().unwrap();

    for ws in [&mut laptop, &mut handset] {
        let alert = dispatched(ws, "MIGRATION_ALERT").await;
        assert_eq!(alert["id"], id.as_str());
        assert_eq!(alert["destination"], "b.test");
        assert_eq!(alert["executes_at"], deadline);
        assert_eq!(alert["state"], "pending");
    }
    let (_, listed) = a.get("/_telium/v1/migrate/alerts", Some(&phone_token)).await;
    assert_eq!(listed["alerts"][0]["id"], id.as_str(), "{listed}");

    waited = 0;
    while inbox.lock().unwrap().is_empty() {
        assert!(waited < 100, "no email reached the webhook");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        waited += 1;
    }
    let (auth, mail) = inbox.lock().unwrap()[0].clone();
    assert_eq!(auth.as_deref(), Some("Bearer relay-secret"));
    assert_eq!(mail["to"], "alice@mail.example");
    assert_eq!(mail["from"], "noreply@a.test");
    let text = mail["text"].as_str().unwrap();
    assert!(text.contains("b.test") && text.contains("@alice:a.test"), "{text}");
    let link = text
        .split_whitespace()
        .find(|w| w.contains("/_telium/v1/migrate/cancel-link?t="))
        .expect("a cancel link in the email")
        .to_string();
    assert!(link.starts_with(&a.base), "the link points at the account's own server: {link}");
    let email_state = eventually(&a, "/_telium/v1/migrate/alerts", &alice.token, |v| {
        v["alerts"][0]["email"] == "sent"
    })
    .await;
    assert_eq!(email_state["alerts"][0]["email"], "sent");

    let (status, page) = follow(&a, &link, false).await;
    assert_eq!(status, 200, "{page}");
    assert!(page.contains("b.test") && page.contains("<form"), "{page}");
    assert_eq!(migration_state(&a, &alice.token, &id).await["state"], "pending");

    let (status, page) = follow(&a, &link, true).await;
    assert_eq!(status, 200, "{page}");
    assert!(page.contains("cancelled"), "{page}");
    let row = migration_state(&a, &alice.token, &id).await;
    assert_eq!(row["state"], "cancelled");
    assert!(row["detail"].as_str().unwrap().contains("recovery email"), "{row}");

    for ws in [&mut laptop, &mut handset] {
        let update = dispatched(ws, "MIGRATION_UPDATE").await;
        assert_eq!(update["id"], id.as_str());
        assert_eq!(update["state"], "cancelled");
    }
    let (_, listed) = a.get("/_telium/v1/migrate/alerts", Some(&alice.token)).await;
    assert_eq!(listed["alerts"], json!([]));

    let (status, _) = follow(&a, &link, true).await;
    assert_eq!(status, 410, "a link is spent by its first use");
    let (status, whoami) = a.get("/_telium/v1/whoami", Some(&alice.token)).await;
    assert_eq!(status, 200, "{whoami}");
}

#[tokio::test]
async fn a_cancel_link_is_for_one_window_of_one_migration_and_works_once() {
    use telium_server::routes::alerts::cancel_link;
    let (a, b) = pair_with_delay(3600).await;
    let alice = register_full(&a, "alice").await;
    spare_admin(&a).await;
    let first = open_move(&a, &b, &alice, "alice2").await;
    let id = first["id"].as_str().unwrap().to_string();
    let deadline = first["executes_at"].as_i64().unwrap();

    let good = cancel_link(&a.state, &id, "@alice:a.test", deadline).await.unwrap();
    let spare = cancel_link(&a.state, &id, "@alice:a.test", deadline).await.unwrap();

    let expired = cancel_link(&a.state, &id, "@alice:a.test", now_ms() - 1_000).await.unwrap();
    assert_eq!(follow(&a, &expired, true).await.0, 410);
    let stale = cancel_link(&a.state, &id, "@alice:a.test", deadline + 60_000).await.unwrap();
    assert_eq!(follow(&a, &stale, true).await.0, 404);
    let token = good.split("t=").nth(1).unwrap();
    let mut claims: Value =
        serde_json::from_slice(&telium_server::util::unb64(token).unwrap()).unwrap();
    claims["migration_id"] = json!("01FORGEDMIGRATIONID0000000");
    let forged = format!(
        "{}/_telium/v1/migrate/cancel-link?t={}",
        a.base,
        telium_server::util::b64(claims.to_string().as_bytes())
    );
    assert_eq!(follow(&a, &forged, true).await.0, 400);
    assert_eq!(
        migration_state(&a, &alice.token, &id).await["state"],
        "pending",
        "none of those touched the migration"
    );

    eventually(&a, "/_telium/v1/migrate/alerts", &alice.token, |v| {
        v["alerts"][0]["email"] == "no_address"
    })
    .await;

    let (status, page) = follow(&a, &good, true).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(migration_state(&a, &alice.token, &id).await["state"], "cancelled");
    assert_eq!(follow(&a, &good, true).await.0, 410);

    let second = open_move(&a, &b, &alice, "alice3").await;
    let second_id = second["id"].as_str().unwrap().to_string();
    assert_eq!(follow(&a, &spare, false).await.0, 409);
    assert_eq!(follow(&a, &spare, true).await.0, 409);
    assert_eq!(migration_state(&a, &alice.token, &second_id).await["state"], "pending");
}

async fn stored_upload(server: &Server, owner: &str, bytes: &[u8]) -> (String, String) {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let capability = telium_server::util::random_token(24);
    let path = server.state.cfg.media_dir.join(&hash[0..2]).join(&hash);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    sqlx::query(
        "INSERT INTO media (hash, owner_user_id, filename, mime, size, capability, purpose, created_at) \
         VALUES (?, ?, 'photo.png', 'image/png', ?, ?, 'attachment', 1000)",
    )
    .bind(&hash)
    .bind(owner)
    .bind(bytes.len() as i64)
    .bind(&capability)
    .execute(&server.state.pool)
    .await
    .unwrap();
    (hash, capability)
}

async fn moved_to_at(server: &Server, hash: &str) -> Option<String> {
    sqlx::query_scalar("SELECT moved_to FROM media WHERE hash = ?")
        .bind(hash)
        .fetch_one(&server.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn what_the_budget_left_behind_is_fetched_in_pages_and_forwarded_as_it_lands() {
    use telium_server::migration::media as mm;

    let (a, b) = pair().await;
    let owner = "@ana:a.test";
    let target = "@ana:b.test";
    let mut omitted: Vec<(String, String)> = Vec::new();
    for i in 0..(mm::PULL_PAGE + 3) {
        omitted.push(stored_upload(&a, owner, format!("LEFT-OUT-FOR-SIZE-{i:03}").as_bytes()).await);
    }
    let (vanished, _) = stored_upload(&a, owner, b"LEFT-OUT-THEN-DELETED").await;
    std::fs::remove_file(a.state.cfg.media_dir.join(&vanished[0..2]).join(&vanished)).unwrap();
    let (carried, _) = stored_upload(&a, owner, b"WENT-IN-THE-BUNDLE").await;

    sqlx::query(
        "INSERT INTO migrations (id, subject_type, subject_id, destination, grant_token, device_id, \
         device_sig, state, created_at, executes_at, completed_at) \
         VALUES ('m-pull', 'user', ?, 'b.test', 'tok', 'd', 's', 'completed', 0, 0, 1)",
    )
    .bind(owner)
    .execute(&a.state.pool)
    .await
    .unwrap();
    let mut left_out: Vec<Value> = omitted
        .iter()
        .map(|(h, _)| json!({ "hash": h, "size": 21, "purpose": "attachment" }))
        .collect();
    left_out.push(json!({ "hash": vanished, "size": 21, "purpose": "attachment" }));
    let bundle = json!({ "media": [{ "media": { "hash": carried } }], "media_omitted": left_out });
    mm::record_export(&a.state, "m-pull", &bundle).await.unwrap();

    {
        let mut conn = b.state.pool.acquire().await.unwrap();
        let queued = mm::queue_omitted(&mut conn, "m-pull", "a.test", target, &left_out).await.unwrap();
        assert_eq!(queued as usize, omitted.len() + 1);
    }
    let (linked, linked_cap) = omitted[0].clone();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, created_at) \
         VALUES ('msg-linked', 'chan', 'guild', ?, 'look', ?, 1000)",
    )
    .bind(target)
    .bind(
        json!([{
            "reference": format!("media://a.test/{linked}"),
            "origin": "a.test",
            "hash": linked,
            "capability": linked_cap,
            "url": format!("{}/_telium/v1/media/{linked}?cap={linked_cap}", a.base),
            "filename": "photo.png", "mime": "image/png", "size": 21,
        }])
        .to_string(),
    )
    .execute(&b.state.pool)
    .await
    .unwrap();

    let unsigned = b
        .client
        .post(format!("{}/_telium/v1/migrate/media/fetch", a.base))
        .json(&json!({ "migration_id": "m-pull", "hash": omitted[0].0 }))
        .send()
        .await
        .unwrap();
    assert_eq!(unsigned.status().as_u16(), 401);
    for (migration_id, hash) in [("m-pull", carried.as_str()), ("m-other", omitted[0].0.as_str())] {
        let asked = telium_server::federation::post_signed(
            &b.state,
            "a.test",
            "/_telium/v1/migrate/media/fetch",
            &json!({ "migration_id": migration_id, "hash": hash }),
        )
        .await;
        assert!(asked.is_err(), "the source served {hash} under {migration_id}: {asked:?}");
    }
    assert!(
        mm::serve_omitted(&a.state, "a.test", "m-pull", &omitted[0].0).await.is_err(),
        "the source answered a request that did not come from the destination"
    );

    let landed = mm::pull_omitted(&b.state).await.unwrap();
    assert_eq!(landed as usize, mm::PULL_PAGE - 1, "the vanished object is in the first page and does not land");
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media_pulls WHERE state = 'pending'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(pending as usize, omitted.len() + 1 - mm::PULL_PAGE + 1, "the vanished object is due again later");
    let mut forwarded = 0;
    for (hash, _) in &omitted {
        let here: Option<String> =
            sqlx::query_scalar("SELECT state FROM media_pulls WHERE migration_id = 'm-pull' AND hash = ?")
                .bind(hash)
                .fetch_optional(&b.state.pool)
                .await
                .unwrap();
        let there = moved_to_at(&a, hash).await;
        if here.as_deref() == Some("landed") {
            assert_eq!(there.as_deref(), Some("b.test"), "landed at the destination but not forwarded");
            forwarded += 1;
        } else {
            assert_eq!(there, None, "forwarded before it landed");
        }
    }
    assert_eq!(forwarded, mm::PULL_PAGE - 1);
    assert_eq!(moved_to_at(&a, &carried).await, None, "the paged fetch forwarded a carried object");
    let linked_state: String =
        sqlx::query_scalar("SELECT state FROM media_pulls WHERE migration_id = 'm-pull' AND hash = ?")
            .bind(&linked)
            .fetch_one(&b.state.pool)
            .await
            .unwrap();
    assert_eq!(linked_state, "landed", "the page is taken oldest-due first and this one was in it");
    let atts: String = sqlx::query_scalar("SELECT attachments FROM messages WHERE id = 'msg-linked'")
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    let atts: Value = serde_json::from_str(&atts).unwrap();
    assert_eq!(atts[0]["origin"], "b.test", "the link here still names the old origin: {atts}");
    assert_eq!(atts[0]["reference"], format!("media://b.test/{linked}"));
    assert_eq!(atts[0]["url"], format!("{}/_telium/v1/media/{linked}?cap={linked_cap}", b.base));

    sqlx::query("INSERT INTO defederation (domain, scope, created_at) VALUES ('a.test', 'all', 0)")
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE media_pulls SET next_attempt_at = 0 WHERE state = 'pending'")
        .execute(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(mm::pull_omitted(&b.state).await.unwrap(), 0);
    let (still, attempts, due): (i64, i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), MIN(attempts), MIN(next_attempt_at) FROM media_pulls WHERE state = 'pending'",
    )
    .fetch_one(&b.state.pool)
    .await
    .unwrap();
    assert_eq!(still as usize, omitted.len() + 1 - (mm::PULL_PAGE - 1));
    assert!(attempts >= 1, "a failed fetch was not counted");
    assert!(due > 0, "a failed fetch is due again immediately");

    sqlx::query("DELETE FROM defederation WHERE domain = 'a.test'")
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE media_pulls SET next_attempt_at = 0 WHERE state = 'pending'")
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE media_pulls SET attempts = ? WHERE hash = ?")
        .bind(mm::PULL_MAX_ATTEMPTS - 1)
        .bind(&vanished)
        .execute(&b.state.pool)
        .await
        .unwrap();
    let restarted = telium_server::build_state((*b.state.cfg).clone()).await.unwrap();
    assert_eq!(mm::pull_omitted(&restarted).await.unwrap() as usize, omitted.len() - (mm::PULL_PAGE - 1));

    let unconfirmed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM media_pulls WHERE state = 'pending' OR confirmed_at IS NULL",
    )
    .fetch_one(&restarted.pool)
    .await
    .unwrap();
    assert_eq!(unconfirmed, 0);
    for (hash, _) in &omitted {
        assert_eq!(moved_to_at(&a, hash).await.as_deref(), Some("b.test"));
        let at_b: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media WHERE hash = ? AND owner_user_id = ?")
            .bind(hash)
            .bind(target)
            .fetch_one(&restarted.pool)
            .await
            .unwrap();
        assert_eq!(at_b, 1);
    }
    let (b_state, b_detail): (String, String) =
        sqlx::query_as("SELECT state, detail FROM media_pulls WHERE hash = ?")
            .bind(&vanished)
            .fetch_one(&restarted.pool)
            .await
            .unwrap();
    assert_eq!(b_state, "failed");
    assert!(b_detail.starts_with("gave up after"), "{b_detail}");
    assert_eq!(moved_to_at(&a, &vanished).await, None);
    let (a_state, a_detail): (String, String) =
        sqlx::query_as("SELECT state, detail FROM migration_media WHERE migration_id = 'm-pull' AND hash = ?")
            .bind(&vanished)
            .fetch_one(&a.state.pool)
            .await
            .unwrap();
    assert_eq!(a_state, "refused");
    assert!(a_detail.starts_with("gave up after"), "{a_detail}");

    let no_follow = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
    let resp = no_follow
        .get(format!("{}/_telium/v1/media/{linked}?cap={linked_cap}", a.base))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 307);
    let location = resp.headers()["location"].to_str().unwrap().to_string();
    assert!(location.starts_with(&b.base), "{location}");

    assert_eq!(mm::pull_omitted(&restarted).await.unwrap(), 0);
}
