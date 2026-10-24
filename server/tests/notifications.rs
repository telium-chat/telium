use p256::SecretKey;
use rand::rngs::OsRng;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::config::Config;
use telium_server::notifications::{
    self, FederatedEnvelope, ALGORITHM_V1,
};
use telium_server::routes::messages::MessageRow;
use telium_server::util::{b64, now_ms};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct TestState {
    state: telium_server::AppState,
    dir: std::path::PathBuf,
}

impl Drop for TestState {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn state() -> TestState {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "telium-notification-test-{}-{n}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut cfg = Config {
        server_name: "bob.example".into(),
        public_base_url: "https://bob.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.roles.guild = false;
    cfg.federation.allow_http = true;
    cfg.federation.dm_retry_secs = 1;
    cfg.federation
        .peers
        .insert("offline.example".into(), "http://127.0.0.1:1".into());

    TestState {
        state: telium_server::build_state(cfg).await.unwrap(),
        dir,
    }
}

async fn seed_account(s: &telium_server::AppState, user_id: &str, device_id: &str) {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, 'bob', 'bob.example', 'irrelevant', ?)",
    )
    .bind(user_id)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO devices (device_id, user_id, name, pubkey_b64, created_at, last_seen, active) \
         VALUES (?, ?, 'phone', 'device-signing-key-not-used-here', ?, ?, 1)",
    )
    .bind(device_id)
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
}

async fn seed_remote_membership(
    s: &telium_server::AppState,
    user_id: &str,
    origin: &str,
    guild_id: &str,
) {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO remote_memberships \
         (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
         VALUES (?, ?, ?, ?, NULL, 'guild', ?)",
    )
    .bind(user_id)
    .bind(origin)
    .bind(guild_id)
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn remote_guild_gets_keys_only_for_a_real_membership() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    let guild = "guild-1";
    seed_account(&t.state, user, device).await;
    seed_remote_membership(&t.state, user, "guild.example", guild).await;

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    notifications::register_device(&t.state, user, device, ALGORITHM_V1, &public)
        .await
        .unwrap();

    let keys = notifications::keys_for_guild(
        &t.state,
        "guild.example",
        user,
        guild,
    )
    .await
    .unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].device_id, device);
    assert_eq!(keys[0].public_key, public);

    let unrelated = notifications::keys_for_guild(
        &t.state,
        "evil.example",
        user,
        guild,
    )
    .await;
    assert!(unrelated.is_err(), "an unrelated server must not learn device notification keys");
}

#[tokio::test]
async fn inbox_is_device_scoped_idempotent_and_acknowledged_by_cursor() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    let guild = "guild-1";
    let origin = "guild.example";
    seed_account(&t.state, user, device).await;
    seed_remote_membership(&t.state, user, origin, guild).await;

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let background = notifications::register_device(
        &t.state,
        user,
        device,
        ALGORITHM_V1,
        &public,
    )
    .await
    .unwrap();
    let background_auth = notifications::authenticate_background(&t.state, &background)
        .await
        .unwrap();
    assert_eq!(background_auth.user_id, user);
    assert_eq!(background_auth.device_id, device);

    let source_id = "message-1";
    let associated_data = notifications::aad(
        user,
        device,
        origin,
        source_id,
        Some(guild),
        "mention",
    );
    let descriptor = json!({
        "v": 1,
        "kind": "mention",
        "title": "Alice",
        "body": "hello @bob",
        "destination": {
            "type": "guild_message",
            "guild_origin": origin,
            "guild_id": guild,
            "channel_id": "general",
            "message_id": source_id,
        }
    });
    let envelope = notifications::seal_descriptor(
        &public,
        &associated_data,
        &serde_json::to_vec(&descriptor).unwrap(),
    )
    .unwrap();
    let target = FederatedEnvelope {
        device_id: device.into(),
        ciphertext: serde_json::to_value(envelope).unwrap(),
    };

    let inserted = notifications::enqueue_federated(
        &t.state,
        origin,
        user,
        guild,
        source_id,
        "mention",
        None,
        std::slice::from_ref(&target),
    )
    .await
    .unwrap();
    assert_eq!(inserted, vec![device.to_string()]);

    for _ in 0..40 {
        let duplicate = notifications::enqueue_federated(
            &t.state,
            origin,
            user,
            guild,
            source_id,
            "mention",
            None,
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
        assert!(duplicate.is_empty());
    }

    let page = notifications::pull(&t.state, &background_auth, None, 50)
        .await
        .unwrap();
    let rows = page["notifications"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["origin"], origin);
    assert_eq!(rows[0]["source_id"], source_id);
    assert!(rows[0]["ciphertext"]["ciphertext"].is_string());
    assert!(!rows[0].to_string().contains("hello @bob"));

    let cursor = page["cursor"].as_str().unwrap().to_string();
    assert_eq!(notifications::ack(&t.state, &background_auth, &cursor).await.unwrap(), 1);
    let empty = notifications::pull(&t.state, &background_auth, Some(&cursor), 50)
        .await
        .unwrap();
    assert_eq!(empty["notifications"], Value::Array(vec![]));
}

#[tokio::test]
async fn notification_key_rotation_discards_only_old_key_ciphertext() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    let guild = "guild-1";
    let origin = "guild.example";
    seed_account(&t.state, user, device).await;
    seed_remote_membership(&t.state, user, origin, guild).await;

    let first_private = SecretKey::random(&mut OsRng);
    let first_public = b64(first_private.public_key().to_sec1_bytes().as_ref());
    notifications::register_device(&t.state, user, device, ALGORITHM_V1, &first_public)
        .await
        .unwrap();

    let source_id = "message-before-rotation";
    let aad = notifications::aad(
        user,
        device,
        origin,
        source_id,
        Some(guild),
        "mention",
    );
    let envelope = notifications::seal_descriptor(
        &first_public,
        &aad,
        br#"{"v":1,"kind":"mention","title":"Alice","body":"before"}"#,
    )
    .unwrap();
    let target = FederatedEnvelope {
        device_id: device.into(),
        ciphertext: serde_json::to_value(envelope).unwrap(),
    };
    notifications::enqueue_federated(
        &t.state,
        origin,
        user,
        guild,
        source_id,
        "mention",
        None,
        &[target],
    )
    .await
    .unwrap();

    let queued: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE user_id = ? AND device_id = ?",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(queued, 1);

    notifications::register_device(&t.state, user, device, ALGORITHM_V1, &first_public)
        .await
        .unwrap();
    let queued: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE user_id = ? AND device_id = ?",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(queued, 1);

    let replacement_private = SecretKey::random(&mut OsRng);
    let replacement_public = b64(replacement_private.public_key().to_sec1_bytes().as_ref());
    notifications::register_device(
        &t.state,
        user,
        device,
        ALGORITHM_V1,
        &replacement_public,
    )
    .await
    .unwrap();
    let queued: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_inbox WHERE user_id = ? AND device_id = ?",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(queued, 0);
}

#[tokio::test]
async fn revoking_telium_device_immediately_revokes_notification_access() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    let guild = "guild-1";
    seed_account(&t.state, user, device).await;
    seed_remote_membership(&t.state, user, "guild.example", guild).await;

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let background = notifications::register_device(
        &t.state,
        user,
        device,
        ALGORITHM_V1,
        &public,
    )
    .await
    .unwrap();
    assert!(notifications::authenticate_background(&t.state, &background).await.is_ok());

    sqlx::query("UPDATE devices SET active = 0 WHERE user_id = ? AND device_id = ?")
        .bind(user)
        .bind(device)
        .execute(&t.state.pool)
        .await
        .unwrap();

    assert!(notifications::authenticate_background(&t.state, &background).await.is_err());
    let keys = notifications::keys_for_guild(
        &t.state,
        "guild.example",
        user,
        guild,
    )
    .await
    .unwrap();
    assert!(keys.is_empty(), "revoked devices must disappear from remote key discovery");

    let registrations: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_devices WHERE user_id = ? AND device_id = ?",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(registrations, 0, "revocation must delete notification-only credentials");
}

#[tokio::test]
async fn everyone_hot_path_queues_one_broadcast_job_instead_of_expanding_members() {
    let t = state().await;
    let now = now_ms();
    let message = MessageRow {
        id: "message-everyone".into(),
        channel_id: "channel-large".into(),
        guild_id: "guild-large".into(),
        author_id: "@alice:bob.example".into(),
        content: "@everyone release is live".into(),
        attachments: "[]".into(),
        components: "[]".into(),
        cards: "[]".into(),
        sticker: None,
        reply_to: None,
        thread_id: None,
        author_signature: None,
        created_at: now,
        edited_at: None,
    };

    telium_server::routes::push::wake_mentioned(
        &t.state,
        &message,
        &["@everyone".to_string()],
    )
    .await;

    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT recipient_id, destination, kind, payload \
         FROM notification_outbox WHERE source_id = ?",
    )
    .bind(&message.id)
    .fetch_all(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 1, "@everyone expanded on the message-send path");
    assert_eq!(rows[0].0, "@everyone");
    assert_eq!(rows[0].1, "bob.example");
    assert_eq!(rows[0].2, "broadcast");

    let payload: Value = serde_json::from_str(&rows[0].3).unwrap();
    assert_eq!(payload["source"]["id"], message.id);
    assert!(payload["after_user_id"].is_null());
}

#[tokio::test]
async fn everyone_expands_past_the_old_cap_and_across_multiple_pages() {
    let t = state().await;
    let now = now_ms();
    let guild = "guild-scale";
    let channel = "channel-scale";

    sqlx::query(
        "INSERT INTO guilds (id, name, owner_user_id, created_at) \
         VALUES (?, 'Scale Guild', '@owner:bob.example', ?)",
    )
    .bind(guild)
    .bind(now - 10)
    .execute(&t.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, permissions) \
         VALUES (?, ?, '@everyone', ?)",
    )
    .bind(guild)
    .bind(guild)
    .bind(telium_server::perms::VIEW_CHANNEL as i64)
    .execute(&t.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, created_at) \
         VALUES (?, ?, 'text', 'general', ?)",
    )
    .bind(channel)
    .bind(guild)
    .bind(now - 10)
    .execute(&t.state.pool)
    .await
    .unwrap();

    for i in 0..300 {
        let user_id = format!("@user-{i:03}:bob.example");
        sqlx::query(
            "INSERT INTO members (guild_id, user_id, joined_at, display_name) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(guild)
        .bind(&user_id)
        .bind(now - 1)
        .bind(format!("User {i}"))
        .execute(&t.state.pool)
        .await
        .unwrap();
    }

    let message = MessageRow {
        id: "message-scale-everyone".into(),
        channel_id: channel.into(),
        guild_id: guild.into(),
        author_id: "@owner:bob.example".into(),
        content: "@everyone scale test".into(),
        attachments: "[]".into(),
        components: "[]".into(),
        cards: "[]".into(),
        sticker: None,
        reply_to: None,
        thread_id: None,
        author_signature: None,
        created_at: now,
        edited_at: None,
    };

    telium_server::routes::push::wake_mentioned(
        &t.state,
        &message,
        &["@everyone".to_string()],
    )
    .await;

    telium_server::routes::push::flush_notification_outbox(&t.state)
        .await
        .unwrap();

    let first_page: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox \
         WHERE source_id = ? AND kind = 'mention'",
    )
    .bind(&message.id)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(
        first_page, 256,
        "the first expansion page should be bounded, not capped at the old 64-member limit"
    );

    sqlx::query(
        "UPDATE notification_outbox SET next_attempt_at = ? \
         WHERE source_id = ? AND kind = 'mention'",
    )
    .bind(now + 60_000)
    .bind(&message.id)
    .execute(&t.state.pool)
    .await
    .unwrap();

    telium_server::routes::push::flush_notification_outbox(&t.state)
        .await
        .unwrap();

    let all_recipients: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox \
         WHERE source_id = ? AND kind = 'mention'",
    )
    .bind(&message.id)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    let broadcast_cursor: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox \
         WHERE source_id = ? AND kind = 'broadcast'",
    )
    .bind(&message.id)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();

    assert_eq!(all_recipients, 300, "large @everyone fanout silently dropped recipients");
    assert_eq!(broadcast_cursor, 0, "broadcast cursor did not finish after the final page");
}

#[tokio::test]
async fn here_does_not_create_an_offline_broadcast_job() {
    let t = state().await;
    let message = MessageRow {
        id: "message-here".into(),
        channel_id: "channel-large".into(),
        guild_id: "guild-large".into(),
        author_id: "@alice:bob.example".into(),
        content: "@here release is live".into(),
        attachments: "[]".into(),
        components: "[]".into(),
        cards: "[]".into(),
        sticker: None,
        reply_to: None,
        thread_id: None,
        author_signature: None,
        created_at: now_ms(),
        edited_at: None,
    };

    telium_server::routes::push::wake_mentioned(
        &t.state,
        &message,
        &["@everyone".to_string()],
    )
    .await;

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox WHERE source_id = ?",
    )
    .bind(&message.id)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn moved_account_loses_old_home_notification_authority_but_keeps_device_history() {
    let t = state().await;
    let user = "@bob:bob.example";
    let device = "phone-1";
    seed_account(&t.state, user, device).await;

    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let background =
        notifications::register_device(&t.state, user, device, ALGORITHM_V1, &public)
            .await
            .unwrap();

    sqlx::query(
        "INSERT INTO notification_inbox \
         (id, user_id, device_id, origin, source_id, kind, guild_id, ciphertext, created_at, expires_at) \
         VALUES ('move-inbox', ?, ?, 'guild.example', 'message-1', 'mention', 'guild-1', '{}', ?, ?)",
    )
    .bind(user)
    .bind(device)
    .bind(now_ms())
    .bind(now_ms() + notifications::DEFAULT_RETENTION_MS)
    .execute(&t.state.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO dm_notification_hints \
         (id, conversation_id, notification_id, sender, recipient_id, device_id, ciphertext, created_at) \
         VALUES ('move-dm-hint', 'conversation-1', 'notification-123456', '@alice:alice.example', ?, ?, '{}', ?)",
    )
    .bind(user)
    .bind(device)
    .bind(now_ms())
    .execute(&t.state.pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO push_subscriptions \
         (id, user_id, device_id, kind, endpoint, created_at) \
         VALUES ('move-push', ?, ?, 'relay', 'https://push.example.invalid/device', ?)",
    )
    .bind(user)
    .bind(device)
    .bind(now_ms())
    .execute(&t.state.pool)
    .await
    .unwrap();

    let retired = notifications::retire_moved_account(&t.state, user)
        .await
        .unwrap();
    assert_eq!(retired, (1, 1, 1, 1));

    for table in ["notification_inbox", "notification_devices", "push_subscriptions"] {
        let count: i64 = sqlx::query_scalar(&format!(
            "SELECT COUNT(*) FROM {table} WHERE user_id = ?"
        ))
        .bind(user)
        .fetch_one(&t.state.pool)
        .await
        .unwrap();
        assert_eq!(count, 0, "{table} still lets the old home act for the moved account");
    }
    let pending_dm_hints: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_notification_hints WHERE recipient_id = ?",
    )
    .bind(user)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(
        pending_dm_hints,
        0,
        "pending encrypted DM hints survived old-home notification retirement",
    );

    assert!(
        notifications::authenticate_background(&t.state, &background)
            .await
            .is_err(),
        "the old notification-only credential still authenticates after the move"
    );

    let active: i64 = sqlx::query_scalar(
        "SELECT active FROM devices WHERE user_id = ? AND device_id = ?",
    )
    .bind(user)
    .bind(device)
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(active, 1, "migration cleanup erased normal device/audit history");
}

#[tokio::test]
async fn notification_outbox_persists_and_backs_off_when_account_home_is_down() {
    let t = state().await;
    let now = now_ms();
    let source_id = "message-offline-home";
    let guild_id = "guild-remote";
    let recipient = "@carol:offline.example";
    let payload = json!({
        "id": source_id,
        "guild_id": guild_id,
        "channel_id": "channel-1",
        "author_id": "@alice:bob.example",
        "content": "hello @carol",
        "has_attachment": false,
        "has_sticker": false,
        "created_at": now,
    });

    sqlx::query(
        "INSERT INTO notification_outbox \
         (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
         VALUES ('outbox-1', ?, 'offline.example', ?, ?, 'mention', ?, ?, ?)",
    )
    .bind(recipient)
    .bind(guild_id)
    .bind(source_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&t.state.pool)
    .await
    .unwrap();

    let processed = telium_server::routes::push::flush_notification_outbox(&t.state)
        .await
        .unwrap();
    assert_eq!(processed, 1);

    let row: (i64, i64, Option<String>) = sqlx::query_as(
        "SELECT attempts, next_attempt_at, last_error FROM notification_outbox WHERE id = 'outbox-1'",
    )
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(row.0, 1, "the failed federation attempt must remain queued");
    assert!(row.1 > now, "the retry must move into the future");
    assert!(row.2.as_deref().is_some_and(|e| !e.is_empty()));
}

#[tokio::test]
async fn notification_outbox_expires_old_preview_jobs() {
    let t = state().await;
    let now = now_ms();
    let old = now - notifications::DEFAULT_RETENTION_MS - 1;
    sqlx::query(
        "INSERT INTO notification_outbox \
         (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
         VALUES ('outbox-old', '@carol:offline.example', 'offline.example', 'guild-remote', \
                 'message-old', 'mention', '{}', ?, ?)",
    )
    .bind(old)
    .bind(old)
    .execute(&t.state.pool)
    .await
    .unwrap();

    telium_server::routes::push::flush_notification_outbox(&t.state)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox WHERE id = 'outbox-old'",
    )
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn notification_outbox_drops_jobs_after_guild_authority_moves() {
    let t = state().await;
    let now = now_ms();
    let guild_id = "guild-moved";
    let source_id = "message-before-move";
    let payload = json!({
        "id": source_id,
        "guild_id": guild_id,
        "channel_id": "channel-before-move",
        "author_id": "@alice:bob.example",
        "content": "queued before the guild moved",
        "has_attachment": false,
        "has_sticker": false,
        "created_at": now,
    });

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('guild', ?, 'moved', 'guild-on-new-home', '{}', ?)",
    )
    .bind(guild_id)
    .bind(now)
    .execute(&t.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO notification_outbox \
         (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
         VALUES ('outbox-moved', '@carol:offline.example', 'offline.example', ?, ?, 'mention', ?, ?, ?)",
    )
    .bind(guild_id)
    .bind(source_id)
    .bind(payload.to_string())
    .bind(now)
    .bind(now)
    .execute(&t.state.pool)
    .await
    .unwrap();

    let processed = telium_server::routes::push::flush_notification_outbox(&t.state)
        .await
        .unwrap();
    assert_eq!(processed, 1);

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox WHERE id = 'outbox-moved'",
    )
    .fetch_one(&t.state.pool)
    .await
    .unwrap();
    assert_eq!(
        count, 0,
        "an archived former authority must not retry a notification after the guild moved"
    );
}

async fn seed_device(s: &telium_server::AppState, user_id: &str, localpart: &str, device_id: &str) {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) \
         VALUES (?, ?, 'bob.example', 'irrelevant', ?)",
    )
    .bind(user_id)
    .bind(localpart)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO devices (device_id, user_id, name, pubkey_b64, created_at, last_seen, active) \
         VALUES (?, ?, 'phone', 'device-signing-key-not-used-here', ?, ?, 1)",
    )
    .bind(device_id)
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
}

async fn seed_conversation(s: &telium_server::AppState, id: &str, members: &[&str]) {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO conversations (id, kind, sequencer, creator, epoch, last_seq, metadata, \
         created_at, updated_at) VALUES (?, 'gc', 'bob.example', ?, 1, 0, NULL, ?, ?)",
    )
    .bind(id)
    .bind(members[0])
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await
    .unwrap();
    for user_id in members {
        sqlx::query(
            "INSERT INTO conversation_members \
               (conversation_id, user_id, home_domain, state, added_at) \
             VALUES (?, ?, 'bob.example', 'active', ?)",
        )
        .bind(id)
        .bind(user_id)
        .bind(now)
        .execute(&s.pool)
        .await
        .unwrap();
    }
}

fn conversation_frame(sender: &str, id: &str, notify: bool) -> Value {
    json!({
        "id": id,
        "conversation_id": "01JCONVERSATION",
        "seq": 1,
        "epoch": 1,
        "kind": "application",
        "sender": sender,
        "sender_device": "alice-phone",
        "ciphertext": "bWxzLWNpcGhlcnRleHQtbm9ib2R5LWhlcmUtY2FuLXJlYWQ",
        "created_at": now_ms(),
        "notify": notify,
    })
}

async fn background_auth(s: &telium_server::AppState, user: &str, device: &str) -> (String, notifications::BackgroundAuth) {
    let private = SecretKey::random(&mut OsRng);
    let public = b64(private.public_key().to_sec1_bytes().as_ref());
    let background = notifications::register_device(s, user, device, ALGORITHM_V1, &public).await.unwrap();
    (public, notifications::authenticate_background(s, &background).await.unwrap())
}

#[tokio::test]
async fn conversation_frames_notify_once_per_burst_and_reveal_nothing() {
    let t = state().await;
    let (alice, bob) = ("@alice:bob.example", "@bob:bob.example");
    seed_device(&t.state, alice, "alice", "alice-phone").await;
    seed_device(&t.state, bob, "bob", "bob-phone").await;
    seed_conversation(&t.state, "01JCONVERSATION", &[alice, bob]).await;
    let (_, auth) = background_auth(&t.state, bob, "bob-phone").await;
    let locals = vec![alice.to_string(), bob.to_string()];
    let wake = |id: &str, notify: bool| {
        let frame = conversation_frame(alice, id, notify);
        let locals = locals.clone();
        let state = t.state.clone();
        async move { telium_server::routes::push::wake_conversation(&state, "01JCONVERSATION", &frame, &locals).await }
    };
    let count = |sql: &'static str| {
        let pool = t.state.pool.clone();
        async move { sqlx::query_scalar::<_, i64>(sql).fetch_one(&pool).await.unwrap() }
    };

    wake("01JRECEIPT", false).await;
    assert_eq!(count("SELECT COUNT(*) FROM notification_inbox").await, 0);
    for n in 0..5 {
        wake(&format!("01JFRAME{n}"), true).await;
    }
    wake("01JFRAME0", true).await; // a federation retry of a superseded frame
    let page = notifications::pull(&t.state, &auth, None, 50).await.unwrap();
    let rows = page["notifications"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!((&row["source_id"], &row["kind"], &row["coalesced"]), (&json!("01JFRAME4"), &json!("encrypted_message"), &json!(4)));
    assert_eq!(row["guild_id"], Value::Null);
    assert!(!row.to_string().contains("bWxzLWNpcGhlcnRleHQ"), "the frame ciphertext leaked: {row}");
    let bucket = row["coalesce_key"].as_str().unwrap();
    assert!(!bucket.is_empty() && !bucket.contains("01JCONVERSATION"), "the bucket must be opaque");
    assert_eq!(count("SELECT COUNT(*) FROM notification_inbox WHERE superseded_at IS NOT NULL").await, 4);
    assert_eq!(count("SELECT COUNT(*) FROM notification_inbox WHERE user_id = '@alice:bob.example'").await, 0);

    let cursor = page["cursor"].as_str().unwrap().to_string();
    assert_eq!(notifications::ack(&t.state, &auth, &cursor).await.unwrap(), 5, "an ack clears the tombstones too");
    sqlx::query("UPDATE conversation_members SET muted = 1 WHERE user_id = ?").bind(bob).execute(&t.state.pool).await.unwrap();
    wake("01JMUTED", true).await;
    assert_eq!(count("SELECT COUNT(*) FROM notification_inbox").await, 0);
}

#[tokio::test]
async fn guild_mentions_group_by_their_blinded_channel_hint() {
    let t = state().await;
    let (user, device, guild, origin) = ("@bob:bob.example", "phone-1", "guild-1", "guild.example");
    seed_account(&t.state, user, device).await;
    seed_remote_membership(&t.state, user, origin, guild).await;
    let (public, auth) = background_auth(&t.state, user, device).await;
    let general = notifications::coalesce_bucket(&["channel", guild, "general"]);
    let random = notifications::coalesce_bucket(&["channel", guild, "random"]);
    let enqueue = |source_id: &'static str, hint: Option<&str>| {
        let aad = notifications::aad(user, device, origin, source_id, Some(guild), "mention");
        let envelope = notifications::seal_descriptor(&public, &aad, br#"{"v":1,"kind":"mention","title":"Alice","body":"hello"}"#).unwrap();
        let envelopes = vec![FederatedEnvelope { device_id: device.into(), ciphertext: serde_json::to_value(envelope).unwrap() }];
        let hint = hint.map(str::to_string);
        let state = t.state.clone();
        async move {
            notifications::enqueue_federated(&state, origin, user, guild, source_id, "mention", hint.as_deref(), &envelopes).await
        }
    };
    for (source_id, hint) in [("message-1", Some(general.as_str())), ("message-2", Some(&general)), ("message-3", Some(&random)), ("old-peer-1", None), ("old-peer-2", None)] {
        enqueue(source_id, hint).await.unwrap();
    }
    let page = notifications::pull(&t.state, &auth, None, 50).await.unwrap();
    let rows = page["notifications"].as_array().unwrap();
    let coalesced = |id: &str| rows.iter().find(|r| r["source_id"] == id).map(|r| r["coalesced"].clone());
    assert_eq!(rows.len(), 3, "one per channel plus one per-guild bucket: {rows:?}");
    assert_eq!((coalesced("message-2"), coalesced("message-3"), coalesced("old-peer-2")), (Some(json!(1)), Some(json!(0)), Some(json!(1))));
    let stored = rows.iter().find(|r| r["source_id"] == "message-2").unwrap()["coalesce_key"].as_str().unwrap();
    assert!(stored != general && !stored.contains("general"));

    assert!(enqueue("hostile", Some("../../etc/passwd")).await.is_err(), "a hint outside the token alphabet");
    enqueue("blank-hint", Some("   ")).await.unwrap();
}
