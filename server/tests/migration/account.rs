use super::*;

#[tokio::test]
async fn notification_state_never_travels_in_an_account_bundle() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    let user = "@ana:a.example";
    account(&a.pool, user, "ana", "a.example").await;

    sqlx::query(
        "INSERT INTO notification_devices \
         (user_id, device_id, algorithm, public_key_b64, background_token_hash, created_at, updated_at) \
         VALUES (?, 'phone', 'alg', 'NOTIFICATION-PUBLIC-KEY', 'BACKGROUND-TOKEN-HASH', 1, 1)",
    )
    .bind(user)
    .execute(&a.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notification_inbox \
         (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, created_at, expires_at) \
         VALUES ('notification-row', ?, 'phone', 'guild.example', 'message-1', 'mention', \
                 'guild-1', 'OPAQUE-NOTIFICATION-CIPHERTEXT', 1, 9999999999999)",
    )
    .bind(user)
    .execute(&a.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO dm_notification_hints \
         (id, conversation_id, notification_id, sender, recipient_id, device_id, ciphertext, created_at) \
         VALUES ('dm-notification-hint', 'conversation-1', 'notification-123456', \
                 '@sender:elsewhere.example', ?, 'phone', 'OPAQUE-DM-HINT-CIPHERTEXT', 1)",
    )
    .bind(user)
    .execute(&a.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, auth, created_at) \
         VALUES ('push-row', ?, 'phone', 'relay', 'https://push.example/SECRET-ENDPOINT', \
                 'PUSH-AUTH-SECRET', 1)",
    )
    .bind(user)
    .execute(&a.pool)
    .await
    .unwrap();

    let mut bundle = migration::export_user(&a, user).await.unwrap();
    let serialized = bundle.to_string();
    for secret in [
        "NOTIFICATION-PUBLIC-KEY",
        "BACKGROUND-TOKEN-HASH",
        "OPAQUE-NOTIFICATION-CIPHERTEXT",
        "OPAQUE-DM-HINT-CIPHERTEXT",
        "SECRET-ENDPOINT",
        "PUSH-AUTH-SECRET",
    ] {
        assert!(
            !serialized.contains(secret),
            "{secret} left its old homeserver inside the account bundle"
        );
    }
    for key in ["notification_devices", "notification_inbox", "dm_notification_hints", "push_subscriptions"] {
        assert!(bundle.get(key).is_none(), "{key} became migration-bundle state");
    }

    bundle["notification_devices"] = json!([{
        "device_id": "phone",
        "background_token_hash": "INJECTED-BACKGROUND-TOKEN"
    }]);
    bundle["notification_inbox"] = json!([{
        "ciphertext": "INJECTED-CIPHERTEXT"
    }]);
    bundle["dm_notification_hints"] = json!([{
        "ciphertext": "INJECTED-DM-HINT"
    }]);
    bundle["push_subscriptions"] = json!([{
        "endpoint": "https://push.example/INJECTED"
    }]);

    import_user(&b, &bundle, "@ana:b.example").await;
    for table in ["notification_devices", "notification_inbox", "push_subscriptions"] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM {table} WHERE user_id = '@ana:b.example'"
        ))
        .fetch_one(&b.pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table} was restored from migration input");
    }
    let dm_hints: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_notification_hints WHERE recipient_id = '@ana:b.example'",
    )
    .fetch_one(&b.pool)
    .await
    .unwrap();
    assert_eq!(dm_hints, 0, "pending DM hints were restored from migration input");
}

#[tokio::test]
async fn the_vault_moves_as_ciphertext_and_its_escrow_key_does_not() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    sqlx::query(
        "INSERT INTO key_vault (user_id, mode, ciphertext, independent_ciphertext, escrow_key, \
         version, updated_at) VALUES ('@ana:a.example', 'escrowed', 'VAULT-CIPHERTEXT', \
         'k1.INDEPENDENT-CIPHERTEXT', 'ESCROW-KEY-SECRET', 7, 5000)",
    )
    .execute(&a.pool)
    .await
    .unwrap();

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();

    let vault = bundle["key_vault"].as_object().expect("the bundle has no vault in it");
    assert_eq!(vault["ciphertext"], "VAULT-CIPHERTEXT");
    assert_eq!(vault["independent_ciphertext"], "k1.INDEPENDENT-CIPHERTEXT");
    assert_eq!(vault["version"], 7);
    assert!(!vault.contains_key("escrow_key"), "the vault's escrow key is in the bundle");

    let serialized = bundle.to_string();
    for secret in ["ESCROW-KEY-SECRET", "OPAQUE-RECORD", "RECOVERY-PUBLIC-KEY", "PASSWORD-HASH"] {
        assert!(!serialized.contains(secret), "{secret} left the server inside a bundle");
    }

    import_user(&b, &bundle, "@ana:b.example").await;

    let (mode, ciphertext, independent, escrow_key): (String, String, Option<String>, Option<String>) =
        sqlx::query_as(
            "SELECT mode, ciphertext, independent_ciphertext, escrow_key FROM key_vault \
             WHERE user_id = '@ana:b.example'",
        )
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(ciphertext, "VAULT-CIPHERTEXT");
    assert_eq!(independent.as_deref(), Some("k1.INDEPENDENT-CIPHERTEXT"));
    assert_eq!(escrow_key, None, "the destination has an escrow key nobody gave it");
    assert_eq!(mode, "device_custody");
}

#[tokio::test]
async fn a_landed_vault_keeps_the_modes_a_client_can_open() {
    for (before, after) in [
        ("self_custody", "self_custody"),
        ("opaque_custody", "opaque_custody"),
        ("device_custody", "device_custody"),
        ("something_newer", "device_custody"),
    ] {
        let a = home("a.example").await;
        let b = home("b.example").await;
        account(&a.pool, "@ana:a.example", "ana", "a.example").await;
        sqlx::query(
            "INSERT INTO key_vault (user_id, mode, ciphertext, version, updated_at) \
             VALUES ('@ana:a.example', ?, 'VAULT-CIPHERTEXT', 1, 5000)",
        )
        .bind(before)
        .execute(&a.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO key_vault (user_id, mode, ciphertext, escrow_key, version, updated_at) \
             VALUES ('@ana:b.example', 'escrowed', 'FRESH-CIPHERTEXT', 'FRESH-ESCROW', 3, 6000)",
        )
        .execute(&b.pool)
        .await
        .unwrap();

        let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
        import_user(&b, &bundle, "@ana:b.example").await;

        let (mode, ciphertext, escrow_key, version): (String, String, Option<String>, i64) =
            sqlx::query_as(
                "SELECT mode, ciphertext, escrow_key, version FROM key_vault \
                 WHERE user_id = '@ana:b.example'",
            )
            .fetch_one(&b.pool)
            .await
            .unwrap();
        assert_eq!(mode, after, "a {before} vault landed as {mode}");
        assert_eq!(ciphertext, "VAULT-CIPHERTEXT", "the fresh vault won over the moved one");
        assert_eq!(escrow_key, None, "the replaced vault's escrow key outlived it");
        assert!(version > 3, "a client caching version 3 would not notice the vault changed");
    }
}

async fn conversation(pool: &SqlitePool, id: &str, sequencer: &str, members: &[(&str, &str)]) {
    sqlx::query(
        "INSERT INTO conversations (id, kind, sequencer, creator, created_at, updated_at) \
         VALUES (?, 'gc', ?, '@ana:a.example', 1000, 1000)",
    )
    .bind(id)
    .bind(sequencer)
    .execute(pool)
    .await
    .unwrap();
    for (user_id, home) in members {
        sqlx::query(
            "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
             VALUES (?, ?, ?, 1000)",
        )
        .bind(id)
        .bind(user_id)
        .bind(home)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn queued_frame(pool: &SqlitePool, conversation_id: &str, sender: &str, destination: &str) -> String {
    let id = ulid();
    let message_id = ulid();
    let payload = json!({
        "conversation": { "id": conversation_id, "sequencer": "a.example", "members": [] },
        "message": {
            "id": message_id, "conversation_id": conversation_id, "seq": 4, "epoch": 2,
            "kind": "application", "sender": sender, "sender_device": "dev1",
            "ciphertext": format!("CIPHERTEXT-{message_id}"), "created_at": 2000,
        },
    });
    sqlx::query(
        "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, path, payload, \
         attempts, next_attempt_at, last_error, created_at) \
         VALUES (?, ?, ?, ?, '/_telium/v1/dm/deliver', ?, 5, ?, 'connection refused', 2000)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(&message_id)
    .bind(destination)
    .bind(payload.to_string())
    .bind(telium_server::util::now_ms() + 3_600_000)
    .execute(pool)
    .await
    .unwrap();
    id
}

#[tokio::test]
async fn queued_frames_the_account_sent_arrive_due_for_retry() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    let members = [("@ana:a.example", "a.example"), ("@bo:c.example", "c.example")];
    let moved = ulid();
    conversation(&a.pool, &moved, "a.example", &members).await;
    conversation(&b.pool, &moved, "b.example", &[("@ana:b.example", "b.example"), ("@bo:c.example", "c.example")]).await;
    let stuck = ulid();
    conversation(&a.pool, &stuck, "a.example", &members).await;
    conversation(&b.pool, &stuck, "a.example", &members).await;
    let elsewhere = ulid();
    conversation(&a.pool, &elsewhere, "a.example", &[("@cy:a.example", "a.example"), ("@bo:c.example", "c.example")]).await;

    let hers = queued_frame(&a.pool, &moved, "@ana:a.example", "c.example").await;
    let his = queued_frame(&a.pool, &moved, "@bo:c.example", "c.example").await;
    let refused = queued_frame(&a.pool, &stuck, "@ana:a.example", "c.example").await;
    let not_hers = queued_frame(&a.pool, &elsewhere, "@cy:a.example", "c.example").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let carried: Vec<&str> = bundle["dm_outbox"]
        .as_array()
        .expect("the bundle has no outbox in it")
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect();
    assert!(carried.contains(&hers.as_str()), "the account's own frame stayed behind");
    assert!(carried.contains(&refused.as_str()), "export decides whose the frame is, not where it can go");
    assert!(!carried.contains(&his.as_str()), "another member's frame left with the account");
    assert!(!carried.contains(&not_hers.as_str()), "a frame from a group the account is not in left with it");

    import_user(&b, &bundle, "@ana:b.example").await;

    let landed: Vec<(String, String, i64, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT id, destination, attempts, next_attempt_at, last_error, payload FROM dm_outbox",
    )
    .fetch_all(&b.pool)
    .await
    .unwrap();
    assert_eq!(landed.len(), 1, "frames b could only be refused for were queued: {landed:?}");
    let (id, destination, attempts, next, error, payload) = &landed[0];
    assert_eq!(id, &hers);
    assert_eq!(destination, "c.example");
    assert_eq!(*attempts, 0, "the destination inherited a backoff it did not earn");
    assert_eq!(error, &None);
    assert!(*next <= telium_server::util::now_ms(), "the frame is not due; the flusher would leave it");

    let payload: Value = serde_json::from_str(payload).unwrap();
    assert_eq!(payload["conversation"]["sequencer"], "b.example");
    assert_eq!(payload["conversation"]["id"], moved.as_str());
    assert_eq!(payload["message"]["sender"], "@ana:a.example");
    assert_eq!(payload["message"]["seq"], 4);
    assert!(payload["message"]["ciphertext"].as_str().unwrap().starts_with("CIPHERTEXT-"));

    let due: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_outbox WHERE next_attempt_at <= ?")
        .bind(telium_server::util::now_ms())
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(due, 1);
}

#[tokio::test]
async fn an_account_with_no_vault_still_migrates() {
    let a = home("a.example").await;
    let b = home("b.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    assert_eq!(bundle["key_vault"], Value::Null);
    assert_eq!(bundle["dm_outbox"], json!([]));

    let landed = import_user(&b, &bundle, "@ana:b.example").await;
    assert_eq!(landed, "@ana:b.example");
    let vaults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_vault WHERE user_id = '@ana:b.example'")
        .fetch_one(&b.pool)
        .await
        .unwrap();
    assert_eq!(vaults, 0, "the destination invented a vault for an account that had none");
    let previous: String =
        sqlx::query_scalar("SELECT previous_id FROM imported_identities WHERE user_id = '@ana:b.example'")
            .fetch_one(&b.pool)
            .await
            .unwrap();
    assert_eq!(previous, "@ana:a.example");
}

async fn privacy_flags(pool: &SqlitePool, user_id: &str) -> (i64, i64, i64) {
    sqlx::query_as(
        "SELECT public_page_enabled, public_status_enabled, public_activity_enabled \
         FROM profiles WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn import_onto_blank(server: &str, bundle: &Value) -> Home {
    let h = home(server).await;
    let uid = format!("@ana:{server}");
    account(&h.pool, &uid, "ana", server).await;
    sqlx::query("INSERT INTO profiles (user_id, display_name, profile_version, updated_at) VALUES (?, ?, 1, 1000)")
        .bind(&uid)
        .bind(&uid)
        .execute(&h.pool)
        .await
        .unwrap();
    import_user(&h, bundle, &uid).await;
    h
}

#[tokio::test]
async fn privacy_switches_and_request_decisions_survive_a_move() {
    let a = home("a.example").await;
    account(&a.pool, "@ana:a.example", "ana", "a.example").await;
    sqlx::query(
        "INSERT INTO profiles (user_id, display_name, profile_version, updated_at, \
         public_page_enabled, public_status_enabled, public_activity_enabled) \
         VALUES ('@ana:a.example', 'Ana', 3, 1700, 0, 1, 1)",
    )
    .execute(&a.pool)
    .await
    .unwrap();
    let requests = [
        ("convo-accepted", "@friend:c.example", "accepted"),
        ("convo-blocked", "@abuser:c.example", "blocked"),
        ("convo-declined", "@stranger:c.example", "declined"),
        ("convo-pending", "@other:c.example", "pending"),
    ];
    for (id, peer, state) in requests {
        conversation(&a.pool, id, "a.example", &[("@ana:a.example", "a.example"), (peer, "c.example")]).await;
        sqlx::query(
            "INSERT INTO dm_message_requests (conversation_id, user_id, sender_id, state, created_at, updated_at) \
             VALUES (?, '@ana:a.example', ?, ?, 1000, 1000)",
        )
        .bind(id)
        .bind(peer)
        .bind(state)
        .execute(&a.pool)
        .await
        .unwrap();
    }

    let bundle = migration::export_user(&a, "@ana:a.example").await.unwrap();
    let b = import_onto_blank("b.example", &bundle).await;
    assert_eq!(privacy_flags(&b.pool, "@ana:b.example").await, (0, 1, 1));
    let decisions: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT conversation_id, sender_id, state FROM dm_message_requests \
         WHERE user_id = '@ana:b.example' ORDER BY conversation_id",
    )
    .fetch_all(&b.pool)
    .await
    .unwrap();
    let want: Vec<(String, String, String)> =
        requests.iter().map(|(c, s, st)| (c.to_string(), s.to_string(), st.to_string())).collect();
    assert_eq!(decisions, want, "request decisions must survive exactly, nothing invented");

    let mut older = bundle.clone();
    for field in ["public_page_enabled", "public_status_enabled", "public_activity_enabled"] {
        older["profile"].as_object_mut().unwrap().remove(field);
    }
    let c = import_onto_blank("c.example", &older).await;
    assert_eq!(privacy_flags(&c.pool, "@ana:c.example").await, (1, 0, 0), "an old bundle must not switch presence on");
}
