use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::{config::Config, migration, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

struct Home {
    state: AppState,
    dir: std::path::PathBuf,
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl std::ops::Deref for Home {
    type Target = AppState;
    fn deref(&self) -> &AppState {
        &self.state
    }
}

async fn home(server_name: &str) -> Home {
    home_with(server_name, |_| {}).await
}

async fn home_with(server_name: &str, adjust: impl FnOnce(&mut Config)) -> Home {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-migration-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: server_name.into(),
        public_base_url: format!("http://{server_name}"),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    cfg.archive.dir = dir.join("cold");
    cfg.archive.horizon_days = 0;
    cfg.archive.keep_hot_messages = 1;
    adjust(&mut cfg);
    let state = telium_server::build_state(cfg).await.unwrap();
    Home { state, dir }
}

struct Seeded {
    guild: String,
    category: String,
    channel: String,
    announce: String,
    role: String,
    emoji: String,
    sticker: String,
    thread: String,
    messages: Vec<String>,
    elsewhere: String,
}

async fn index(pool: &SqlitePool, id: &str, channel: &str, guild: &str, author: &str, content: &str) {
    sqlx::query(
        "INSERT INTO messages_fts (content, message_id, channel_id, guild_id, author_id) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(content)
    .bind(id)
    .bind(channel)
    .bind(guild)
    .bind(author)
    .execute(pool)
    .await
    .unwrap();
}

async fn seed(pool: &SqlitePool) -> Seeded {
    let guild = ulid();
    let category = ulid();
    let channel = ulid();
    let announce = ulid();
    let role = ulid();
    let emoji = ulid();

    sqlx::query(
        "INSERT INTO guilds (id, alias, name, owner_user_id, settings, created_at) \
         VALUES (?, 'gaming', 'Gaming', '@ana:a.example', '{}', 1000)",
    )
    .bind(&guild)
    .execute(pool)
    .await
    .unwrap();

    for (id, name, mentionable) in [
        (guild.clone(), "@everyone", 0),
        (role.clone(), "mods", 1),
    ] {
        sqlx::query(
            "INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist, mentionable) \
             VALUES (?, ?, ?, 0, 1, 8, 0, ?)",
        )
        .bind(id)
        .bind(&guild)
        .bind(name)
        .bind(mentionable)
        .execute(pool)
        .await
        .unwrap();
    }

    for (id, ty, name, parent) in [
        (category.clone(), "category", "text channels", None),
        (channel.clone(), "text", "general", Some(category.clone())),
        (announce.clone(), "text", "announcements", Some(category.clone())),
    ] {
        sqlx::query(
            "INSERT INTO channels (id, guild_id, type, name, position, parent_id, created_at) \
             VALUES (?, ?, ?, ?, 0, ?, 1000)",
        )
        .bind(id)
        .bind(&guild)
        .bind(ty)
        .bind(name)
        .bind(parent)
        .execute(pool)
        .await
        .unwrap();
    }

    sqlx::query(
        "INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) \
         VALUES (?, 'role', ?, 8, 0)",
    )
    .bind(&channel)
    .bind(&role)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO emojis (id, guild_id, name, media_hash, animated, uploader, created_at) \
         VALUES (?, ?, 'partyparrot', 'abc123', 0, '@ana:a.example', 1000)",
    )
    .bind(&emoji)
    .bind(&guild)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO members (guild_id, user_id, joined_at, display_name, profile_version) \
         VALUES (?, '@ana:a.example', 1000, 'Ana', 1)",
    )
    .bind(&guild)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, '@ana:a.example', ?)")
        .bind(&guild)
        .bind(&role)
        .execute(pool)
        .await
        .unwrap();

    let elsewhere = ulid();
    let bodies = [
        format!("welcome <@&{role}> to <#{channel}> <partyparrot:{emoji}>"),
        format!("<partyparrot:{emoji}@a.example> is the good one"),
        format!("unrelated: <@&{elsewhere}> lives in another guild"),
        "no ids in here at all".to_string(),
    ];
    let mut messages = Vec::new();
    for (i, body) in bodies.iter().enumerate() {
        let id = ulid();
        sqlx::query(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, created_at) \
             VALUES (?, ?, ?, '@ana:a.example', ?, ?)",
        )
        .bind(&id)
        .bind(&channel)
        .bind(&guild)
        .bind(body)
        .bind(2000 + i as i64)
        .execute(pool)
        .await
        .unwrap();
        index(pool, &id, &channel, &guild, "@ana:a.example", body).await;
        messages.push(id);
    }
    let reply = ulid();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, reply_to, created_at) \
         VALUES (?, ?, ?, '@bo:b.example', 'agreed', ?, 3000)",
    )
    .bind(&reply)
    .bind(&channel)
    .bind(&guild)
    .bind(&messages[0])
    .execute(pool)
    .await
    .unwrap();
    index(pool, &reply, &channel, &guild, "@bo:b.example", "agreed").await;
    messages.push(reply);

    let (sticker, thread, with_sticker) =
        seed_the_rest(pool, &guild, &channel, &announce, &role, &messages).await;
    messages.push(with_sticker);

    Seeded {
        guild,
        category,
        channel,
        announce,
        role,
        emoji,
        sticker,
        thread,
        messages,
        elsewhere,
    }
}

async fn seed_the_rest(
    pool: &SqlitePool,
    guild: &str,
    channel: &str,
    announce: &str,
    role: &str,
    messages: &[String],
) -> (String, String, String) {
    sqlx::query(
        "UPDATE guilds SET origin_policy = 'allowlist', require_voucher = 1, external_emoji = 0, \
         fallback_domain = 'standby.example', min_account_age_days = 7, domain_policy = 'blocklist', \
         screening = '[\"why are you here\"]', hold_first_messages = 1, \
         media_expiry_limit_secs = 86400, settings = '{\"theme\":\"dark\"}' WHERE id = ?",
    )
    .bind(guild)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "UPDATE channels SET voice_region = 'eu', bitrate = 96000, user_limit = 10, \
         available_tags = '[{\"id\":\"t1\",\"name\":\"bug\"}]', default_sort = 'creation', \
         default_layout = 'gallery', strip_embeds = 1, media_expiry_limit_secs = 3600, \
         topic = 'the general channel', slowmode = 5 WHERE id = ?",
    )
    .bind(channel)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query("UPDATE members SET timeout_until = 9999, nickname = 'ana!' WHERE guild_id = ?")
        .bind(guild)
        .execute(pool)
        .await
        .unwrap();

    let sticker = ulid();
    sqlx::query(
        "INSERT INTO stickers (id, guild_id, name, media_hash, format, uploader, created_at) \
         VALUES (?, ?, 'shrug', 'def456', 'png', '@ana:a.example', 1000)",
    )
    .bind(&sticker)
    .bind(guild)
    .execute(pool)
    .await
    .unwrap();

    let with_sticker = ulid();
    sqlx::query(
        "INSERT INTO messages (id, channel_id, guild_id, author_id, content, sticker, \
         author_signature, created_at) VALUES (?, ?, ?, '@ana:a.example', '', ?, 'sig-abc', 4000)",
    )
    .bind(&with_sticker)
    .bind(channel)
    .bind(guild)
    .bind(format!("{{\"id\":\"{sticker}\",\"name\":\"shrug\",\"origin\":\"a.example\"}}"))
    .execute(pool)
    .await
    .unwrap();
    index(pool, &with_sticker, channel, guild, "@ana:a.example", "").await;

    let thread = ulid();
    sqlx::query(
        "INSERT INTO channels (id, guild_id, type, name, position, parent_id, created_at) \
         VALUES (?, ?, 'thread', 'a question', 0, ?, 1000)",
    )
    .bind(&thread)
    .bind(guild)
    .bind(channel)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO threads (id, parent_id, guild_id, starter_id, owner, title, tags, archived, \
         locked, auto_archive, message_count, last_active, created_at, pinned) \
         VALUES (?, ?, ?, ?, '@ana:a.example', 'a question', '[\"bug\"]', 0, 0, 86400, 1, 5000, 1000, 1)",
    )
    .bind(&thread)
    .bind(channel)
    .bind(guild)
    .bind(&messages[0])
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE messages SET thread_id = ? WHERE id = ?")
        .bind(&thread)
        .bind(&messages[0])
        .execute(pool)
        .await
        .unwrap();

    let emoji_id: String = sqlx::query_scalar("SELECT id FROM emojis WHERE guild_id = ?")
        .bind(guild)
        .fetch_one(pool)
        .await
        .unwrap();
    for emoji in ["\u{1F44D}".to_string(), format!("<partyparrot:{emoji_id}>")] {
        sqlx::query(
            "INSERT INTO reactions (message_id, emoji, user_id, created_at) \
             VALUES (?, ?, '@bo:b.example', 6000)",
        )
        .bind(&messages[0])
        .bind(emoji)
        .execute(pool)
        .await
        .unwrap();
    }

    sqlx::query(
        "INSERT INTO message_mentions (message_id, channel_id, user_id, kind) \
         VALUES (?, ?, ?, 'role')",
    )
    .bind(&messages[0])
    .bind(channel)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) \
         VALUES (?, ?, '@ana:a.example', 7000)",
    )
    .bind(channel)
    .bind(&messages[0])
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO read_state (user_id, channel_id, last_read_id, muted, updated_at) \
         VALUES ('@ana:a.example', ?, ?, 1, 8000)",
    )
    .bind(channel)
    .bind(messages.last().unwrap())
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO channel_follows (source_id, target_id, created_by, created_at) \
         VALUES (?, ?, '@ana:a.example', 9000)",
    )
    .bind(channel)
    .bind(announce)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO invites (code, guild_id, channel_id, creator, uses, max_uses, expires_at, created_at) \
         VALUES ('come-in', ?, ?, '@ana:a.example', 3, 100, 99999, 1000)",
    )
    .bind(guild)
    .bind(channel)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO automod_rules (id, guild_id, name, kind, pattern, action, threshold, \
         exempt_roles, enabled, created_at) \
         VALUES (?, ?, 'no links', 'link', '.*', 'block', 0, ?, 1, 1000)",
    )
    .bind(ulid())
    .bind(guild)
    .bind(format!("[\"{role}\"]"))
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO guild_origin_rules (guild_id, domain, action, feed_url) \
         VALUES (?, 'c.example', 'block', 'https://feeds.example/bad')",
    )
    .bind(guild)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO guild_domain_rules (guild_id, domain, action) VALUES (?, 'd.example', 'allow')")
        .bind(guild)
        .execute(pool)
        .await
        .unwrap();

    sqlx::query(
        "INSERT INTO screening_answers (guild_id, user_id, answers, state, created_at) \
         VALUES (?, '@cy:c.example', '[\"for the parrots\"]', 'pending', 1000)",
    )
    .bind(guild)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO held_messages (id, guild_id, channel_id, author_id, payload, reason, \
         created_at, state) VALUES (?, ?, ?, '@cy:c.example', '{\"content\":\"hi\"}', 'first message', 1000, 'pending')",
    )
    .bind(ulid())
    .bind(guild)
    .bind(channel)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO guild_voice_regions (guild_id, name, sfu, turn, pubkey_hint, is_default, \
         created_by, created_at) VALUES (?, 'eu', 'wss://sfu.example', 'turn:t.example', 'hint', 1, \
         '@ana:a.example', 1000)",
    )
    .bind(guild)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO audit_log (id, guild_id, actor, action, target, data, created_at) \
         VALUES (?, ?, '@ana:a.example', 'role.create', ?, '{}', 1000)",
    )
    .bind(ulid())
    .bind(guild)
    .bind(role)
    .execute(pool)
    .await
    .unwrap();

    (sticker, thread, with_sticker)
}

fn ulid() -> String {
    telium_server::util::ulid()
}

async fn import_guild(
    state: &AppState,
    bundle: &Value,
    owner: &str,
) -> telium_server::error::ApiResult<String> {
    let migration_id = ulid();
    let source_id = bundle.get("subject").and_then(Value::as_str).unwrap_or_default();
    migration::import_guild(
        state,
        bundle,
        owner,
        &migration::Reservation {
            migration_id: &migration_id,
            subject_type: "guild",
            source: "a.example",
            source_id,
            token_hash: "",
        },
    )
    .await
}

async fn ids(pool: &SqlitePool, table: &str, guild: &str) -> Vec<String> {
    sqlx::query_scalar(&format!("SELECT id FROM {table} WHERE guild_id = ? ORDER BY id"))
        .bind(guild)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn content(pool: &SqlitePool, guild: &str) -> Vec<String> {
    sqlx::query_scalar("SELECT content FROM messages WHERE guild_id = ? ORDER BY created_at")
        .bind(guild)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn dangling(pool: &SqlitePool, guild: &str) -> Vec<String> {
    let shapes = [
        (regex::Regex::new(r"<@&([A-Z0-9]{26})>").unwrap(), "roles"),
        (regex::Regex::new(r"<#([A-Z0-9]{26})>").unwrap(), "channels"),
        (
            regex::Regex::new(r"<[a-zA-Z0-9_.-]{1,32}:([A-Z0-9]{26})(?:@[a-zA-Z0-9.-]+)?>").unwrap(),
            "emojis",
        ),
    ];
    let mut out = Vec::new();
    for body in content(pool, guild).await {
        for (re, table) in &shapes {
            for cap in re.captures_iter(&body) {
                let id = cap[1].to_string();
                let found: Option<String> = sqlx::query_scalar(&format!(
                    "SELECT id FROM {table} WHERE id = ? AND guild_id = ?"
                ))
                .bind(&id)
                .bind(guild)
                .fetch_optional(pool)
                .await
                .unwrap();
                if found.is_none() {
                    out.push(id);
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

async fn rows(pool: &SqlitePool, table: &str, scope: &str, guild: &str) -> Vec<String> {
    let columns: Vec<String> =
        sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .fetch_all(pool)
            .await
            .unwrap();
    let object = columns
        .iter()
        .map(|c| format!("'{c}', \"{table}\".\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let raw: Vec<String> =
        sqlx::query_scalar(&format!("SELECT json_object({object}) FROM \"{table}\" {scope}"))
            .bind(guild)
            .fetch_all(pool)
            .await
            .unwrap();
    let mut out: Vec<String> = raw
            .iter()
            .map(|row| serde_json::from_str::<serde_json::Value>(row).unwrap().to_string())
            .collect();
    out.sort();
    out
}

fn rehomed(rows: Vec<String>, from: &str, to: &str) -> Vec<String> {
    let mut out: Vec<String> = rows
        .into_iter()
        .map(|row| {
            let mut parsed: Value = serde_json::from_str(&row).unwrap();
            let Some(raw) = parsed.get("sticker").and_then(Value::as_str) else { return row };
            let Ok(mut sticker) = serde_json::from_str::<Value>(raw) else { return row };
            if sticker.get("origin").and_then(Value::as_str) != Some(from) {
                return row;
            }
            sticker["origin"] = json!(to);
            parsed["sticker"] = json!(sticker.to_string());
            parsed.to_string()
        })
        .collect();
    out.sort();
    out
}

async fn upload(home: &Home, purpose: &str, bytes: &[u8]) -> String {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let path = home.cfg.media_dir.join(&hash[0..2]).join(&hash);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    sqlx::query(
        "INSERT INTO media (hash, owner_user_id, filename, mime, size, capability, purpose, created_at) \
         VALUES (?, '@ana:a.example', 'parrot.png', 'image/png', ?, 'cap', ?, 1000)",
    )
    .bind(&hash)
    .bind(bytes.len() as i64)
    .bind(purpose)
    .execute(&home.pool)
    .await
    .unwrap();
    hash
}

async fn with_disk_state(home: &Home, s: &Seeded) -> i64 {
    for (table, bytes) in [("emojis", b"parrot bytes".as_slice()), ("stickers", b"shrug bytes")] {
        let hash = upload(home, "expression", bytes).await;
        sqlx::query(&format!("UPDATE {table} SET media_hash = ? WHERE guild_id = ?"))
            .bind(&hash)
            .bind(&s.guild)
            .execute(&home.pool)
            .await
            .unwrap();
    }

    let moved = telium_server::cold::archive_channel(&home.state, &s.channel, 100).await.unwrap();
    assert!(moved > 1, "the sweep had nothing to archive, so nothing is proven");
    moved
}

async fn account(pool: &SqlitePool, user_id: &str, localpart: &str, domain: &str) {
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at, \
         opaque_record, recovery_public_key) VALUES (?, ?, ?, 'PASSWORD-HASH', 1000, \
         'OPAQUE-RECORD', 'RECOVERY-PUBLIC-KEY')",
    )
    .bind(user_id)
    .bind(localpart)
    .bind(domain)
    .execute(pool)
    .await
    .unwrap();
}

async fn import_user(b: &Home, bundle: &Value, target: &str) -> String {
    let migration_id = ulid();
    migration::import_user(
        b,
        bundle,
        target,
        "a.example",
        &migration::Reservation {
            migration_id: &migration_id,
            subject_type: "user",
            source: "a.example",
            source_id: bundle["subject"].as_str().unwrap_or_default(),
            token_hash: "",
        },
    )
    .await
    .unwrap()
}

async fn uploaded(home: &Home, owner: &str, purpose: &str, bytes: &[u8]) -> (String, String) {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let capability = telium_server::util::random_token(24);
    let path = home.cfg.media_dir.join(&hash[0..2]).join(&hash);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    sqlx::query(
        "INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, thumbhash, \
         capability, purpose, created_at) VALUES (?, ?, 'photo.png', 'image/png', ?, 640, 480, \
         'THUMB', ?, ?, ?)",
    )
    .bind(&hash)
    .bind(owner)
    .bind(bytes.len() as i64)
    .bind(&capability)
    .bind(purpose)
    .bind(1000 + bytes.len() as i64)
    .execute(&home.pool)
    .await
    .unwrap();
    (hash, capability)
}

#[allow(clippy::type_complexity)]
async fn media_row(
    pool: &SqlitePool,
    hash: &str,
) -> Option<(String, String, String, String, i64, Option<String>)> {
    sqlx::query_as(
        "SELECT owner_user_id, capability, purpose, mime, size, moved_to FROM media WHERE hash = ?",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .unwrap()
}

fn on_disk(home: &Home, hash: &str) -> Option<Vec<u8>> {
    std::fs::read(home.cfg.media_dir.join(&hash[0..2]).join(hash)).ok()
}

async fn fetch(home: &Home, hash: &str, cap: &str) -> Result<axum::response::Response, telium_server::error::ApiError> {
    use axum::extract::{Path, Query, State};
    telium_server::routes::media::fetch(
        State(home.state.clone()),
        Path(hash.to_string()),
        axum::http::HeaderMap::new(),
        Query(telium_server::routes::media::FetchParams { cap: Some(cap.to_string()) }),
    )
    .await
}

async fn synced(pool: &SqlitePool, user_id: &str, key: &str, value: Value) {
    sqlx::query("INSERT INTO sync_store (user_id, key, value, updated_at) VALUES (?, ?, ?, 1000)")
        .bind(user_id)
        .bind(key)
        .bind(value.to_string())
        .execute(pool)
        .await
        .unwrap();
}

async fn synced_at(pool: &SqlitePool, user_id: &str) -> std::collections::BTreeMap<String, Value> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT key, value FROM sync_store WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(pool)
            .await
            .unwrap();
    rows.into_iter().map(|(k, v)| (k, serde_json::from_str(&v).unwrap())).collect()
}

use telium_server::error::ApiError;
use telium_server::migration::handoff;

mod account;
mod bytes;
mod constraints;
mod guild_import;
mod handoffs;
mod history;
mod sealed;
mod uploads;
