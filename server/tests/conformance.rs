
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use telium_server::routes::identity::{is_sealed_sync_value, SEALED_ONLY_SYNC_KEYS};
use telium_server::{config::Config, migration, migration::BUNDLE_VERSION, AppState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/migration");

const FROZEN_AT: i64 = 1_767_225_600_000;

const FAR: i64 = 4_102_444_800_000;

struct Home {
    state: AppState,
    dir: PathBuf,
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
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("telium-conformance-{}-{n}", std::process::id()));
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
    let state = telium_server::build_state(cfg).await.unwrap();
    Home { state, dir }
}

fn now() -> i64 {
    telium_server::util::now_ms()
}

fn ulid() -> String {
    telium_server::util::ulid()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn verdict(what: &str, failures: &[String]) {
    assert!(failures.is_empty(), "{what}:\n  {}\n", failures.join("\n  "));
}

fn shape(name: &str) -> Option<(i64, u32)> {
    let rest = name.strip_prefix('v')?;
    let (major, minor) = match rest.split_once('.') {
        Some((major, minor)) => (major, minor.parse().ok()?),
        None => (rest, 0),
    };
    Some((major.parse().ok()?, minor))
}

fn frozen() -> Vec<(String, PathBuf)> {
    let mut out: Vec<((i64, u32), String, PathBuf)> = std::fs::read_dir(FIXTURES)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    Some((shape(&name)?, name, entry.path()))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.into_iter().map(|(_, name, path)| (name, path)).collect()
}

fn every_frozen_shape() -> Vec<(String, PathBuf)> {
    let all = frozen();
    assert!(
        !all.is_empty(),
        "no frozen bundles under {FIXTURES}; run server/scripts/freeze-migration-bundles.sh"
    );
    all
}

fn newest_current() -> (String, PathBuf) {
    frozen()
        .into_iter()
        .rfind(|(name, _)| shape(name).map(|s| s.0) == Some(BUNDLE_VERSION))
        .unwrap_or_else(|| {
            panic!(
                "no frozen bundle for BUNDLE_VERSION {BUNDLE_VERSION} under {FIXTURES}; \
                 run server/scripts/freeze-migration-bundles.sh"
            )
        })
}

fn load(dir: &Path, file: &str) -> Value {
    let path = dir.join(file);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

const GUILD_PARTS: &[(&str, &str, &[&str])] = &[
    ("guild", "guilds", &["id"]),
    ("channels", "channels", &["id"]),
    ("roles", "roles", &["id"]),
    ("threads", "threads", &["id"]),
    ("emojis", "emojis", &["id"]),
    ("stickers", "stickers", &["id"]),
    ("members", "members", &["user_id"]),
    ("member_roles", "member_roles", &["user_id", "role_id"]),
    ("overwrites", "channel_overwrites", &["channel_id", "target_id"]),
    ("messages", "messages", &["id"]),
    ("reactions", "reactions", &["message_id", "emoji", "user_id"]),
    ("mentions", "message_mentions", &["message_id", "user_id"]),
    ("pins", "pins", &["channel_id", "message_id"]),
    ("read_state", "read_state", &["user_id", "channel_id"]),
    ("follows", "channel_follows", &["source_id", "target_id"]),
    ("invites", "invites", &["code"]),
    ("automod_rules", "automod_rules", &["id"]),
    ("origin_rules", "guild_origin_rules", &["domain"]),
    ("domain_rules", "guild_domain_rules", &["domain"]),
    ("screening_answers", "screening_answers", &["user_id"]),
    ("held_messages", "held_messages", &["id"]),
    ("voice_regions", "guild_voice_regions", &["name"]),
    ("audit_log", "audit_log", &["id"]),
];

const GUILD_META: &[&str] = &["version", "kind", "subject", "source", "exported_at", "archived", "expressions"];

const NOT_A_GUILD: &[&str] = &[
    "guild_alias_redirects",
    "automod_hits",
    "media_vouchers",
    "voice_states",
    "messages_fts",
    "notification_inbox",
    "notification_outbox",
    "remote_memberships",
    "ephemeral_messages",
    "interactions",
];

const RETIRED: &[(&str, &str)] = &[];

fn scope(table: &str) -> &'static str {
    match table {
        "guilds" => "WHERE id = ?",
        "channel_overwrites" => "JOIN channels c ON c.id = channel_overwrites.channel_id WHERE c.guild_id = ?",
        "message_mentions" => "JOIN channels c ON c.id = message_mentions.channel_id WHERE c.guild_id = ?",
        "pins" => "JOIN channels c ON c.id = pins.channel_id WHERE c.guild_id = ?",
        "read_state" => "JOIN channels c ON c.id = read_state.channel_id WHERE c.guild_id = ?",
        "channel_follows" => "JOIN channels c ON c.id = channel_follows.source_id WHERE c.guild_id = ?",
        "reactions" => "JOIN messages m ON m.id = reactions.message_id WHERE m.guild_id = ?",
        "media" => {
            "WHERE hash IN (SELECT media_hash FROM emojis WHERE guild_id = ? \
             UNION SELECT media_hash FROM stickers WHERE guild_id = ?)"
        }
        _ => "WHERE guild_id = ?",
    }
}

async fn select(pool: &SqlitePool, sql: &str, binds: &[&str]) -> Vec<Value> {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.fetch_all(pool).await.unwrap().iter().map(telium_server::rows::object).collect()
}

async fn table_rows(pool: &SqlitePool, table: &str, guild: &str) -> Vec<Value> {
    let scope = scope(table);
    let binds = vec![guild; scope.matches('?').count()];
    select(pool, &format!("SELECT \"{table}\".* FROM \"{table}\" {scope}"), &binds).await
}

async fn columns(pool: &SqlitePool, table: &str) -> Vec<String> {
    sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .fetch_all(pool)
        .await
        .unwrap()
}

fn on_disk(home: &Home, hash: &str) -> Option<Vec<u8>> {
    std::fs::read(home.cfg.media_dir.join(&hash[0..2]).join(hash)).ok()
}

fn same(a: &Value, b: &Value) -> bool {
    fn plain(v: &Value) -> Value {
        match v {
            Value::String(s) => match serde_json::from_str::<Value>(s) {
                Ok(parsed) if parsed.is_object() || parsed.is_array() => parsed,
                _ => v.clone(),
            },
            Value::Bool(b) => json!(i64::from(*b)),
            _ => v.clone(),
        }
    }
    a == b || plain(a) == plain(b)
}

fn differ(d: &mut Vec<String>, at: String, here: &str, bundle: &Value, landed: &Value) {
    if !same(bundle, landed) {
        d.push(format!("{at}: bundle has {bundle}, {here} has {landed}"));
    }
}

fn key_of(row: &Value, keys: &[&str]) -> String {
    keys.iter()
        .map(|k| row.get(*k).map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_string)).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("/")
}

struct Part<'a> {
    at: &'a str,
    here: &'a str,
    table: &'a str,
    keys: &'a [&'a str],
    columns: &'a [String],
    ignore: &'a [&'a str],
}

fn compare(d: &mut Vec<String>, part: &Part<'_>, expected: &[Value], actual: Vec<Value>) {
    let mut landed: BTreeMap<String, Value> = actual.into_iter().map(|row| (key_of(&row, part.keys), row)).collect();
    for row in expected {
        let key = key_of(row, part.keys);
        let at = format!("{}[{key}]", part.at);
        let Some(here) = landed.remove(&key) else {
            d.push(format!("{at}: not on {}", part.here));
            continue;
        };
        let Some(cells) = row.as_object() else {
            d.push(format!("{at}: not an object"));
            continue;
        };
        for (column, value) in cells {
            if part.ignore.contains(&column.as_str()) {
                continue;
            }
            if !part.columns.iter().any(|c| c == column) {
                if !RETIRED.contains(&(part.table, column.as_str())) {
                    d.push(format!(
                        "{at}.{column}: {} has no {}.{column} column, so the bundle's {value} was dropped",
                        part.here, part.table
                    ));
                }
                continue;
            }
            differ(d, format!("{at}.{column}"), part.here, value, &here[column.as_str()]);
        }
    }
    for key in landed.keys() {
        d.push(format!("{}[{key}]: on {} but not in the bundle", part.at, part.here));
    }
}

async fn import_guild(home: &Home, bundle: &Value, owner: &str) -> Result<String, String> {
    let migration_id = ulid();
    migration::import_guild(
        home,
        bundle,
        owner,
        &migration::Reservation {
            migration_id: &migration_id,
            subject_type: "guild",
            source: text(bundle, "source"),
            source_id: text(bundle, "subject"),
            token_hash: "",
        },
    )
    .await
    .map_err(|e| format!("{e:?}"))
}

fn part_rows(bundle: &Value, key: &str) -> Vec<Value> {
    match key {
        "guild" => bundle.get("guild").filter(|g| g.is_object()).cloned().into_iter().collect(),
        "messages" => {
            let mut all: Vec<Value> = list(bundle, "messages").to_vec();
            all.extend(list(bundle, "archived").iter().map(telium_server::cold::for_row));
            all.sort_by(|a, b| text(a, "id").cmp(text(b, "id")));
            all.dedup_by(|a, b| text(a, "id") == text(b, "id"));
            all
        }
        _ => list(bundle, key).to_vec(),
    }
}

fn as_landed(table: &str, row: &mut Value, owner: &str, here: &str, stickers: &[String]) {
    match table {
        "guilds" => row["owner_user_id"] = json!(owner),
        "channel_follows" => row["created_by"] = json!(owner),
        "media" => row["owner_user_id"] = json!(owner),
        "messages" => {
            let Some(raw) = row.get("sticker").and_then(Value::as_str) else { return };
            let Ok(mut sticker) = serde_json::from_str::<Value>(raw) else { return };
            if stickers.iter().any(|s| s == text(&sticker, "id")) && sticker.get("origin").is_some() {
                sticker["origin"] = json!(here);
                row["sticker"] = json!(sticker.to_string());
            }
        }
        _ => {}
    }
}

fn served_as(claimed: &str) -> &'static str {
    match claimed {
        "image/gif" => "image/gif",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/avif" => "image/avif",
        _ => "image/png",
    }
}

const POINTERS: &[(&str, &str)] = &[
    ("a channel's category", "SELECT id FROM channels WHERE guild_id = ? AND parent_id IS NOT NULL \
      AND parent_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("a thread's own channel", "SELECT id FROM threads WHERE guild_id = ? \
      AND id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("a thread's parent", "SELECT id FROM threads WHERE guild_id = ? \
      AND parent_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("a thread's starter", "SELECT id FROM threads WHERE guild_id = ? AND starter_id IS NOT NULL \
      AND starter_id NOT IN (SELECT id FROM messages WHERE guild_id = ?)"),
    ("a message's channel", "SELECT id FROM messages WHERE guild_id = ? \
      AND channel_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("a reply's original", "SELECT id FROM messages WHERE guild_id = ? AND reply_to IS NOT NULL \
      AND reply_to NOT IN (SELECT id FROM messages WHERE guild_id = ?)"),
    ("a message's thread", "SELECT id FROM messages WHERE guild_id = ? AND thread_id IS NOT NULL \
      AND thread_id NOT IN (SELECT id FROM threads WHERE guild_id = ?)"),
    ("a sticker message's sticker", "SELECT id FROM messages WHERE guild_id = ? AND sticker IS NOT NULL \
      AND json_extract(sticker, '$.id') NOT IN (SELECT id FROM stickers WHERE guild_id = ?)"),
    ("a role grant's role", "SELECT user_id FROM member_roles WHERE guild_id = ? \
      AND role_id NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("a bot's managed role", "SELECT user_id FROM members WHERE guild_id = ? AND bot_role_id IS NOT NULL \
      AND bot_role_id NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("the role that may export emoji", "SELECT id FROM guilds WHERE id = ? AND emoji_export_role_id IS NOT NULL \
      AND emoji_export_role_id NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("a role grant's member", "SELECT user_id FROM member_roles WHERE guild_id = ? \
      AND user_id NOT IN (SELECT user_id FROM members WHERE guild_id = ?)"),
    ("a role overwrite's role", "SELECT o.target_id FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id \
      WHERE c.guild_id = ? AND o.target_type = 'role' AND o.target_id NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("a pin's message", "SELECT p.message_id FROM pins p JOIN channels c ON c.id = p.channel_id \
      WHERE c.guild_id = ? AND p.message_id NOT IN (SELECT id FROM messages WHERE guild_id = ?)"),
    ("a mention's message", "SELECT x.message_id FROM message_mentions x JOIN channels c ON c.id = x.channel_id \
      WHERE c.guild_id = ? AND x.message_id NOT IN (SELECT id FROM messages WHERE guild_id = ?)"),
    ("a role mention's role", "SELECT x.user_id FROM message_mentions x JOIN channels c ON c.id = x.channel_id \
      WHERE c.guild_id = ? AND x.kind = 'role' AND x.user_id NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("the last message read", "SELECT r.user_id FROM read_state r JOIN channels c ON c.id = r.channel_id \
      WHERE c.guild_id = ? AND r.last_read_id NOT IN (SELECT id FROM messages WHERE guild_id = ?)"),
    ("a follow's target", "SELECT f.target_id FROM channel_follows f JOIN channels c ON c.id = f.source_id \
      WHERE c.guild_id = ? AND f.target_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("an invite's channel", "SELECT code FROM invites WHERE guild_id = ? AND channel_id IS NOT NULL \
      AND channel_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("a held message's channel", "SELECT id FROM held_messages WHERE guild_id = ? \
      AND channel_id NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("an AutoMod exemption's role", "SELECT r.id FROM automod_rules r, json_each(r.exempt_roles) e \
      WHERE r.guild_id = ? AND e.value NOT IN (SELECT id FROM roles WHERE guild_id = ?)"),
    ("an AutoMod exemption's channel", "SELECT r.id FROM automod_rules r, json_each(r.exempt_channels) e \
      WHERE r.guild_id = ? AND e.value NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("an AutoMod rule's scope", "SELECT r.id FROM automod_rules r, json_each(r.scope_channels) e \
      WHERE r.guild_id = ? AND e.value NOT IN (SELECT id FROM channels WHERE guild_id = ?)"),
    ("an emoji's media row", "SELECT id FROM emojis WHERE guild_id = ? AND media_hash NOT IN (SELECT hash FROM media)"),
    ("a sticker's media row", "SELECT id FROM stickers WHERE guild_id = ? AND media_hash NOT IN (SELECT hash FROM media)"),
];

async fn guild_diffs(home: &Home, bundle: &Value, at: &str, owner: &str, started: i64) -> Vec<String> {
    let pool = &home.pool;
    let here = home.cfg.server_name.clone();
    let guild = text(bundle, "subject");
    let stickers: Vec<String> = list(bundle, "stickers").iter().map(|s| text(s, "id").to_string()).collect();
    let mut d = Vec::new();

    for (key, table, keys) in GUILD_PARTS {
        let mut expected = part_rows(bundle, key);
        for row in &mut expected {
            as_landed(table, row, owner, &here, &stickers);
        }
        let mut actual = table_rows(pool, table, guild).await;
        if *table == "members" && !expected.iter().any(|m| text(m, "user_id") == owner) {
            match actual.iter().position(|m| text(m, "user_id") == owner) {
                Some(i) => {
                    actual.remove(i);
                }
                None => d.push(format!("{at} members: the new owner {owner} is not a member on {here}")),
            }
        }
        let columns = columns(pool, table).await;
        let part = Part { at: &format!("{at} {key}"), here: &here, table, keys, columns: &columns, ignore: &[] };
        compare(&mut d, &part, &expected, actual);
    }

    for asset in list(bundle, "expressions") {
        let media = &asset["media"];
        let hash = text(media, "hash");
        let at = format!("{at} expressions[{hash}]");
        let bytes = telium_server::util::unb64(text(asset, "data")).unwrap_or_default();
        if blake3::hash(&bytes).to_hex().to_string() != hash {
            d.push(format!("{at}: the frozen bytes do not hash to their name; the fixture is damaged"));
        }
        match on_disk(home, hash) {
            None => d.push(format!("{at}: no bytes on {here}")),
            Some(stored) if stored != bytes => d.push(format!("{at}: {here} holds different bytes under this hash")),
            Some(_) => {}
        }
        let Some(row) = select(pool, "SELECT * FROM media WHERE hash = ?", &[hash]).await.into_iter().next() else {
            d.push(format!("{at}: no media row on {here}"));
            continue;
        };
        for field in ["filename", "width", "height", "thumbhash"] {
            differ(&mut d, format!("{at}.{field}"), &here, &media[field], &row[field]);
        }
        let told = [
            ("owner_user_id", json!(owner)),
            ("purpose", json!("expression")),
            ("mime", json!(served_as(text(media, "mime")))),
            ("size", json!(bytes.len())),
            ("refcount", json!(1)),
            ("expires_at", Value::Null),
            ("moved_to", Value::Null),
        ];
        for (field, value) in told {
            if !same(&value, &row[field]) {
                d.push(format!(
                    "{at}.{field}: {here} has {}, and it should be {value} whatever the bundle said ({})",
                    row[field], media[field]
                ));
            }
        }
        let capability = text(&row, "capability");
        if capability == text(media, "capability") || capability.len() < 16 {
            d.push(format!("{at}.capability: {here} kept the bundle's capability instead of minting one"));
        }
        if row["created_at"].as_i64().unwrap_or(0) < started {
            d.push(format!("{at}.created_at: {here} took the bundle's {} instead of now", media["created_at"]));
        }
    }

    for (what, sql) in POINTERS {
        let binds = vec![guild; sql.matches('?').count()];
        for row in select(pool, sql, &binds).await {
            let name = row.as_object().and_then(|o| o.values().next()).cloned().unwrap_or_default();
            d.push(format!("{at}: {what} points at nothing on {here} ({name})"));
        }
    }
    for row in table_rows(pool, "messages", guild).await {
        let Some(raw) = row.get("sticker").and_then(Value::as_str) else { continue };
        let origin = serde_json::from_str::<Value>(raw).ok().map(|s| text(&s, "origin").to_string());
        if origin.as_deref() != Some(here.as_str()) {
            d.push(format!("{at} messages[{}].sticker: asked for at {origin:?}, not at {here}", text(&row, "id")));
        }
    }
    let hashes = select(pool, "SELECT media_hash FROM emojis WHERE guild_id = ? UNION SELECT media_hash FROM stickers WHERE guild_id = ?", &[guild, guild]).await;
    for row in hashes {
        let hash = text(&row, "media_hash");
        let intact = on_disk(home, hash).is_some_and(|b| blake3::hash(&b).to_hex().to_string() == hash);
        if !intact {
            d.push(format!("{at}: expression {hash} has no intact bytes on {here}"));
        }
    }

    let indexed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages_fts WHERE guild_id = ?")
        .bind(guild)
        .fetch_one(pool)
        .await
        .unwrap();
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = ? AND deleted = 0")
        .bind(guild)
        .fetch_one(pool)
        .await
        .unwrap();
    if indexed != live {
        d.push(format!("{at}: {live} messages on {here} and {indexed} of them searchable"));
    }
    d
}

#[tokio::test]
async fn every_frozen_guild_arrives_as_it_left() {
    let mut failures = Vec::new();
    for (name, dir) in every_frozen_shape() {
        let bundle = load(&dir, "guild.json");
        let at = format!("{name}/guild.json");
        if text(&bundle, "kind") != "guild" || bundle["version"].as_i64() > Some(BUNDLE_VERSION) {
            failures.push(format!("{at}: kind {} version {} is not a guild bundle this server takes", bundle["kind"], bundle["version"]));
            continue;
        }
        let b = home("b.example").await;
        let started = now();
        match import_guild(&b, &bundle, "@owner:b.example").await {
            Err(e) => failures.push(format!("{at}: refused: {e}")),
            Ok(id) if id != text(&bundle, "subject") => {
                failures.push(format!("{at}: arrived as {id} instead of keeping {}", text(&bundle, "subject")))
            }
            Ok(_) => failures.extend(guild_diffs(&b, &bundle, &at, "@owner:b.example", started).await),
        }
    }
    verdict("frozen guild bundles that did not arrive as they left", &failures);
}

#[tokio::test]
async fn a_guild_survives_a_second_move() {
    let mut failures = Vec::new();
    for (name, dir) in every_frozen_shape() {
        let first = load(&dir, "guild.json");
        let at = format!("{name}/guild.json, moved on");
        let guild = text(&first, "subject").to_string();
        let b = home("b.example").await;
        let c = home("c.example").await;
        import_guild(&b, &first, "@owner:b.example").await.unwrap();
        let second = migration::export_guild(&b, &guild).await.unwrap();
        let started = now();
        if let Err(e) = import_guild(&c, &second, "@owner:c.example").await {
            failures.push(format!("{at}: refused: {e}"));
            continue;
        }
        failures.extend(guild_diffs(&c, &second, &at, "@owner:c.example", started).await);

        let stickers: Vec<String> = table_rows(&b.pool, "stickers", &guild).await.iter().map(|s| text(s, "id").to_string()).collect();
        let parts = GUILD_PARTS.iter().copied().chain([("expressions", "media", &["hash"][..])]);
        for (key, table, keys) in parts {
            let mut before = table_rows(&b.pool, table, &guild).await;
            for row in &mut before {
                as_landed(table, row, "@owner:c.example", "c.example", &stickers);
            }
            let mut after = table_rows(&c.pool, table, &guild).await;
            if table == "members" {
                after.retain(|m| text(m, "user_id") != "@owner:c.example");
            }
            let columns = columns(&c.pool, table).await;
            let at = format!("{at}: b.example {key}");
            let part = Part {
                at: &at,
                here: "c.example",
                table,
                keys,
                columns: &columns,
                ignore: &["capability", "created_at"][..if table == "media" { 2 } else { 0 }],
            };
            compare(&mut failures, &part, &before, after);
        }
    }
    verdict("guilds that did not survive a second move", &failures);
}

#[tokio::test]
async fn a_bot_comes_home_with_its_guild() {
    let owner = "@owner:b.example";
    let mut failures = Vec::new();
    let mut shapes_with_a_bot = 0;
    for (name, dir) in every_frozen_shape() {
        let bundle = load(&dir, "guild.json");
        let at = format!("{name}/guild.json, come home");
        let bots: Vec<&Value> = list(&bundle, "members")
            .iter()
            .filter(|m| !text(m, "bot_application_id").is_empty())
            .collect();
        if bots.is_empty() {
            continue;
        }
        shapes_with_a_bot += 1;
        let b = home("b.example").await;
        if let Err(e) = import_guild(&b, &bundle, owner).await {
            failures.push(format!("{at}: refused on the way in: {e}"));
            continue;
        }
        let guild = match import_guild(&b, &bundle, owner).await {
            Ok(id) => id,
            Err(e) => {
                failures.push(format!("{at}: refused coming home: {e}"));
                continue;
            }
        };
        if guild == text(&bundle, "subject") {
            failures.push(format!(
                "{at}: kept {guild}, so no id was re-minted and nothing below proves anything"
            ));
            continue;
        }

        for (what, sql) in POINTERS {
            let binds = vec![guild.as_str(); sql.matches('?').count()];
            for row in select(&b.pool, sql, &binds).await {
                let named = row.as_object().and_then(|o| o.values().next()).cloned().unwrap_or_default();
                failures.push(format!("{at}: {what} points at nothing once renumbered ({named})"));
            }
        }

        for bot in bots {
            let user = text(bot, "user_id");
            let at = format!("{at} {user}");
            let was = text(bot, "bot_role_id");
            let landed: Option<(Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT bot_application_id, bot_role_id FROM members WHERE guild_id = ? AND user_id = ?",
            )
            .bind(&guild)
            .bind(user)
            .fetch_optional(&b.pool)
            .await
            .unwrap();
            let Some((application_id, role_id)) = landed else {
                failures.push(format!("{at}: not a member of the guild that came home"));
                continue;
            };
            if application_id.as_deref() != Some(text(bot, "bot_application_id")) {
                failures.push(format!(
                    "{at}: installed as {application_id:?}, not {}",
                    text(bot, "bot_application_id")
                ));
            }
            let Some(role_id) = role_id else {
                failures.push(format!("{at}.bot_role_id: null, so its grant was dropped on the way in"));
                continue;
            };
            if role_id == was {
                failures.push(format!(
                    "{at}.bot_role_id: still {was}, which is a role of the archive this guild came home from"
                ));
            }
            let granted = list(&bundle, "roles")
                .iter()
                .find(|r| text(r, "id") == was)
                .and_then(|r| r.get("permissions").and_then(Value::as_i64))
                .map(|p| p as u64);
            match telium_server::guildstore::membership(&b.state, &guild, user).await {
                Err(e) => failures.push(format!("{at}: has no membership to read a ceiling from: {e:?}")),
                Ok(m) => match (granted, m.permission_ceiling) {
                    (_, None) => failures
                        .push(format!("{at}: has no permission ceiling, so it did not arrive as a bot at all")),
                    (Some(granted), Some(ceiling)) if ceiling != granted => failures.push(format!(
                        "{at}: masked to {ceiling} where the bundle granted {granted}; \
                         the managed role it was installed with is not here"
                    )),
                    _ => {}
                },
            }
            let roles = telium_server::guildstore::roles_json(&b.state, &guild).await.unwrap();
            let managed = roles.iter().find(|r| text(r, "id") == role_id).map(|r| r["managed"].clone());
            if managed != Some(json!(true)) {
                failures.push(format!(
                    "{at}: its role {role_id} reports managed {managed:?}, \
                     so a moderator may edit it, delete it, or give it to themselves"
                ));
            }
        }
    }
    if shapes_with_a_bot == 0 {
        failures.push(
            "no frozen shape has a bot in it, so this test proved nothing; \
             re-freeze against a reference guild that installs one"
                .to_string(),
        );
    }
    verdict("bots that did not survive their guild coming home", &failures);
}

async fn import_user(home: &Home, bundle: &Value, target: &str) -> Result<String, String> {
    let migration_id = ulid();
    migration::import_user(
        home,
        bundle,
        target,
        text(bundle, "source"),
        &migration::Reservation {
            migration_id: &migration_id,
            subject_type: "user",
            source: text(bundle, "source"),
            source_id: text(bundle, "subject"),
            token_hash: "",
        },
    )
    .await
    .map_err(|e| format!("{e:?}"))
}

async fn receiving(home: &Home, bundle: &Value, target: &str) {
    let (localpart, domain) = target.trim_start_matches('@').split_once(':').unwrap();
    sqlx::query(
        "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at) VALUES (?, ?, ?, 'x', ?)",
    )
    .bind(target)
    .bind(localpart)
    .bind(domain)
    .bind(now())
    .execute(&home.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO profiles (user_id, display_name, profile_version, updated_at) VALUES (?, 'new here', 1, ?)")
        .bind(target)
        .bind(now())
        .execute(&home.pool)
        .await
        .unwrap();
    for frame in list(bundle, "dm_outbox") {
        let conversation = text(frame, "conversation_id");
        let destination = text(frame, "destination");
        sqlx::query(
            "INSERT OR IGNORE INTO conversations (id, kind, sequencer, creator, created_at, updated_at) \
             VALUES (?, 'gc', ?, ?, 1000, 1000)",
        )
        .bind(conversation)
        .bind(&home.cfg.server_name)
        .bind(target)
        .execute(&home.pool)
        .await
        .unwrap();
        for (member, member_home) in [(target.to_string(), domain.to_string()), (format!("@member:{destination}"), destination.to_string())] {
            sqlx::query(
                "INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
                 VALUES (?, ?, ?, 1000)",
            )
            .bind(conversation)
            .bind(member)
            .bind(member_home)
            .execute(&home.pool)
            .await
            .unwrap();
        }
    }
}

fn sealed_entry(entry: &Value) -> bool {
    serde_json::from_str::<Value>(text(entry, "value")).is_ok_and(|v| is_sealed_sync_value(&v))
}

fn sealed_store(bundle: &Value) -> bool {
    bundle["sync_sealed"] == json!(true) || list(bundle, "sync_store").iter().any(sealed_entry)
}

fn landing_sync(bundle: &Value) -> Vec<&Value> {
    let sealed = sealed_store(bundle);
    list(bundle, "sync_store").iter().filter(|e| !sealed || sealed_entry(e)).collect()
}

fn landed_mode(mode: &str) -> &'static str {
    match mode {
        "self_custody" => "self_custody",
        "opaque_custody" => "opaque_custody",
        _ => "device_custody",
    }
}

async fn user_diffs(home: &Home, bundle: &Value, at: &str, target: &str) -> Vec<String> {
    let pool = &home.pool;
    let here = home.cfg.server_name.clone();
    let subject = text(bundle, "subject");
    let mut d = Vec::new();

    let profile = &bundle["profile"];
    match select(pool, "SELECT * FROM profiles WHERE user_id = ?", &[target]).await.first() {
        None => d.push(format!("{at} profile: {target} has no profile on {here}")),
        Some(row) => {
            for field in ["display_name", "avatar_ref", "banner_ref", "accent_color", "bio", "pronouns"] {
                differ(&mut d, format!("{at} profile.{field}"), &here, &profile[field], &row[field]);
            }
        }
    }
    let shown = telium_server::routes::identity::load_profile(home, target).await.unwrap().unwrap_or_default();
    differ(&mut d, format!("{at} original_created_at, as the profile shows it"), &here, &bundle["original_created_at"], &shown["created_at"]);

    let stored: BTreeMap<String, Value> = select(pool, "SELECT key, value FROM sync_store WHERE user_id = ?", &[target])
        .await
        .into_iter()
        .map(|row| (text(&row, "key").to_string(), row["value"].clone()))
        .collect();
    let landing = landing_sync(bundle);
    for entry in &landing {
        let key = text(entry, "key");
        match stored.get(key) {
            None => d.push(format!("{at} sync_store[{key}]: not on {here}")),
            Some(value) => differ(&mut d, format!("{at} sync_store[{key}].value"), &here, &entry["value"], value),
        }
    }
    for key in stored.keys().filter(|k| !landing.iter().any(|e| text(e, "key") == k.as_str())) {
        let why = if list(bundle, "sync_store").iter().any(|e| text(e, "key") == key.as_str()) {
            "plaintext the bundle carried, landed in a store that is sealed"
        } else {
            "not in the bundle"
        };
        d.push(format!("{at} sync_store[{key}]: on {here}, and it is {why}"));
    }
    for (key, value) in &stored {
        let opened = serde_json::from_str::<Value>(value.as_str().unwrap_or_default()).ok();
        if SEALED_ONLY_SYNC_KEYS.contains(&key.as_str()) && !opened.as_ref().is_some_and(is_sealed_sync_value) {
            d.push(format!("{at} sync_store[{key}]: {here} holds plaintext under a key that only ever holds ciphertext"));
        }
    }
    let sealed_here = select(pool, "SELECT sync_sealed_at FROM accounts WHERE user_id = ?", &[target])
        .await
        .first()
        .is_some_and(|row| !row["sync_sealed_at"].is_null());
    if sealed_here != sealed_store(bundle) {
        d.push(format!(
            "{at} sync_sealed: the bundle's store {} sealed, and {target}'s store on {here} {} sealed",
            if sealed_store(bundle) { "lands" } else { "does not land" },
            if sealed_here { "is" } else { "is not" },
        ));
    }
    if let Some(pref) = bundle.get("media_preference").filter(|p| p.is_object()) {
        match select(pool, "SELECT tier, origin FROM media_preferences WHERE user_id = ?", &[target]).await.first() {
            None => d.push(format!("{at} media_preference: not on {here}")),
            Some(row) => {
                differ(&mut d, format!("{at} media_preference.tier"), &here, &pref["tier"], &row["tier"]);
                let origin = if pref["tier"] == json!(2) { pref["origin"].clone() } else { Value::Null };
                differ(&mut d, format!("{at} media_preference.origin"), &here, &origin, &row["origin"]);
            }
        }
    }

    let friends = select(pool, "SELECT peer_id, peer_domain, state, created_at, updated_at FROM friends WHERE user_id = ?", &[target]).await;
    let columns_of_friends = columns(pool, "friends").await;
    let part = Part { at: &format!("{at} friends"), here: &here, table: "friends", keys: &["peer_id"], columns: &columns_of_friends, ignore: &[] };
    compare(&mut d, &part, list(bundle, "friends"), friends);
    let requests = select(pool, "SELECT conversation_id, sender_id, state, created_at, updated_at FROM dm_message_requests WHERE user_id = ?", &[target]).await;
    let request_columns = columns(pool, "dm_message_requests").await;
    let part = Part { at: &format!("{at} message_requests"), here: &here, table: "dm_message_requests", keys: &["conversation_id"], columns: &request_columns, ignore: &["user_id"] };
    compare(&mut d, &part, list(bundle, "message_requests"), requests);
    let moved: Vec<Value> = list(bundle, "remote_memberships").iter().filter(|m| !text(m, "guild_server").is_empty()).cloned().collect();
    let registry = select(pool, "SELECT guild_server, guild_id, joined_at, proof, reported_by FROM remote_memberships WHERE user_id = ?", &[target]).await;
    let columns_of_registry = columns(pool, "remote_memberships").await;
    let part = Part {
        at: &format!("{at} remote_memberships"),
        here: &here,
        table: "remote_memberships",
        keys: &["guild_server", "guild_id"],
        columns: &columns_of_registry,
        ignore: &[],
    };
    compare(&mut d, &part, &moved, registry);
    let mut servers: BTreeSet<String> = moved.iter().map(|m| text(m, "guild_server").to_string()).collect();
    if !list(bundle, "memberships").is_empty() {
        servers.insert(text(bundle, "source").to_string());
    }
    let queued: BTreeMap<String, Value> = select(pool, "SELECT guild_server, old_id FROM membership_moves WHERE user_id = ?", &[target])
        .await
        .into_iter()
        .map(|row| (text(&row, "guild_server").to_string(), row))
        .collect();
    for server in &servers {
        match queued.get(server) {
            None => d.push(format!("{at} membership move to {server}: not queued on {here}")),
            Some(row) => differ(&mut d, format!("{at} membership move to {server}.old_id"), &here, &json!(subject), &row["old_id"]),
        }
    }
    for server in queued.keys().filter(|s| !servers.contains(*s)) {
        d.push(format!("{at} membership move to {server}: queued on {here} for a server the bundle never named"));
    }

    if let Some(vault) = bundle.get("key_vault").filter(|v| v.is_object()) {
        match select(pool, "SELECT * FROM key_vault WHERE user_id = ?", &[target]).await.first() {
            None => d.push(format!("{at} key_vault: not on {here}")),
            Some(row) => {
                for field in ["ciphertext", "independent_ciphertext"] {
                    differ(&mut d, format!("{at} key_vault.{field}"), &here, &vault[field], &row[field]);
                }
                differ(&mut d, format!("{at} key_vault.mode"), &here, &json!(landed_mode(text(vault, "mode"))), &row["mode"]);
                if !row["escrow_key"].is_null() {
                    d.push(format!("{at} key_vault.escrow_key: {here} holds an escrow key nobody gave it"));
                }
                if row["version"].as_i64() < vault["version"].as_i64() {
                    d.push(format!("{at} key_vault.version: went back from {} to {}", vault["version"], row["version"]));
                }
            }
        }
    }
    let backup = select(pool, "SELECT scope, item, ciphertext FROM key_backup WHERE user_id = ?", &[target]).await;
    let columns_of_backup = columns(pool, "key_backup").await;
    let part = Part {
        at: &format!("{at} key_backup"),
        here: &here,
        table: "key_backup",
        keys: &["scope", "item"],
        columns: &columns_of_backup,
        ignore: &["updated_at"],
    };
    compare(&mut d, &part, list(bundle, "key_backup"), backup);
    for device in list(bundle, "devices") {
        let id = text(device, "device_id");
        if !select(pool, "SELECT device_id FROM devices WHERE user_id = ? AND device_id = ?", &[target, id]).await.is_empty() {
            d.push(format!("{at} devices[{id}]: landed on {here}, and a moved account re-verifies its devices instead"));
        }
    }

    for frame in list(bundle, "dm_outbox") {
        let id = text(frame, "id");
        let at = format!("{at} dm_outbox[{id}]");
        let sequenced_here = select(pool, "SELECT sequencer FROM conversations WHERE id = ?", &[text(frame, "conversation_id")])
            .await
            .first()
            .is_some_and(|row| text(row, "sequencer") == here);
        let row = select(pool, "SELECT * FROM dm_outbox WHERE id = ?", &[id]).await.into_iter().next();
        match (sequenced_here, row) {
            (false, None) => {}
            (false, Some(_)) => d.push(format!("{at}: queued for a conversation {here} does not sequence")),
            (true, None) => d.push(format!("{at}: not queued on {here}")),
            (true, Some(row)) => {
                for field in ["conversation_id", "message_id", "destination", "path", "created_at"] {
                    differ(&mut d, format!("{at}.{field}"), &here, &frame[field], &row[field]);
                }
                let payload: Value = serde_json::from_str(text(&row, "payload")).unwrap_or_default();
                differ(&mut d, format!("{at}.payload.message"), &here, &frame["payload"]["message"], &payload["message"]);
                if row["attempts"] != json!(0) {
                    d.push(format!("{at}.attempts: arrived with {} attempts it never made", row["attempts"]));
                }
            }
        }
    }

    for entry in list(bundle, "media") {
        let media = &entry["media"];
        let hash = text(media, "hash");
        let at = format!("{at} media[{hash}]");
        let bytes = telium_server::util::unb64(text(entry, "data")).unwrap_or_default();
        match on_disk(home, hash) {
            None => d.push(format!("{at}: no bytes on {here}")),
            Some(stored) if stored != bytes => d.push(format!("{at}: {here} holds different bytes under this hash")),
            Some(_) => {}
        }
        match select(pool, "SELECT * FROM media WHERE hash = ?", &[hash]).await.first() {
            None => d.push(format!("{at}: no media row on {here}")),
            Some(row) => {
                for field in ["filename", "mime", "size", "width", "height", "thumbhash", "capability", "purpose", "created_at", "expires_at"] {
                    differ(&mut d, format!("{at}.{field}"), &here, &media[field], &row[field]);
                }
                differ(&mut d, format!("{at}.owner_user_id"), &here, &json!(target), &row["owner_user_id"]);
                if !row["moved_to"].is_null() {
                    d.push(format!("{at}.moved_to: {here} forwards it to {}", row["moved_to"]));
                }
            }
        }
    }

    match select(pool, "SELECT * FROM imported_identities WHERE user_id = ?", &[target]).await.first() {
        None => d.push(format!("{at} chain: {here} has no record of where {target} came from")),
        Some(row) => {
            differ(&mut d, format!("{at} previous_id"), &here, &json!(subject), &row["previous_id"]);
            differ(&mut d, format!("{at} original_created_at"), &here, &bundle["original_created_at"], &row["original_created_at"]);
            let chain: Vec<Value> = serde_json::from_str(text(row, "chain")).unwrap_or_default();
            let before = list(bundle, "chain");
            let kept = chain.len() == before.len() + 1 && chain[..before.len()] == *before;
            let hop = chain.last().cloned().unwrap_or_default();
            if !kept || text(&hop, "id") != subject || text(&hop, "server") != text(bundle, "source") {
                d.push(format!(
                    "{at} chain: bundle has {}, {here} has {}; every earlier hop has to survive and this one be added",
                    json!(before),
                    json!(chain)
                ));
            }
        }
    }
    d
}

#[tokio::test]
async fn every_frozen_account_arrives_as_it_left() {
    let mut failures = Vec::new();
    for (name, dir) in every_frozen_shape() {
        let bundle = load(&dir, "user.json");
        let at = format!("{name}/user.json");
        if text(&bundle, "kind") != "user" || bundle["version"].as_i64() > Some(BUNDLE_VERSION) {
            failures.push(format!("{at}: kind {} version {} is not an account bundle this server takes", bundle["kind"], bundle["version"]));
            continue;
        }
        let b = home("b.example").await;
        receiving(&b, &bundle, "@ana:b.example").await;
        match import_user(&b, &bundle, "@ana:b.example").await {
            Err(e) => failures.push(format!("{at}: refused: {e}")),
            Ok(_) => failures.extend(user_diffs(&b, &bundle, &at, "@ana:b.example").await),
        }
    }
    verdict("frozen account bundles that did not arrive as they left", &failures);
}

fn carried_on(first: &Value, second: &Value, at: &str) -> Vec<String> {
    let mut d = Vec::new();
    let mut agree = |what: &str, a: Value, b: Value| {
        if !same(&a, &b) {
            d.push(format!("{at} {what}: the first bundle has {a}, the second has {b}"));
        }
    };
    for field in ["display_name", "avatar_ref", "banner_ref", "accent_color", "bio", "pronouns"] {
        agree(&format!("profile.{field}"), first["profile"][field].clone(), second["profile"][field].clone());
    }
    let switch = |b: &Value, field: &str, default: bool| json!(b["profile"][field].as_bool().unwrap_or(default));
    for (field, default) in [("public_page_enabled", true), ("public_status_enabled", false), ("public_activity_enabled", false)] {
        agree(&format!("profile.{field}"), switch(first, field, default), switch(second, field, default));
    }
    agree("original_created_at", first["original_created_at"].clone(), second["original_created_at"].clone());
    let mut chain = list(first, "chain").to_vec();
    chain.push(json!({ "id": first["subject"], "server": first["source"] }));
    let hops = |c: &[Value]| -> Value { c.iter().map(|h| json!([h["id"], h["server"]])).collect() };
    agree("chain", hops(&chain), hops(list(second, "chain")));

    let by = |bundle: &Value, key: &str, name: &dyn Fn(&Value) -> String, pick: &dyn Fn(&Value) -> Value| -> Value {
        let map: BTreeMap<String, Value> = list(bundle, key).iter().map(|e| (name(e), pick(e))).collect();
        json!(map)
    };
    let landed: BTreeMap<String, Value> = landing_sync(first).into_iter().map(|e| (text(e, "key").into(), e["value"].clone())).collect();
    let carried: BTreeMap<String, Value> = list(second, "sync_store").iter().map(|e| (text(e, "key").into(), e["value"].clone())).collect();
    for key in landed.keys().chain(carried.keys()).collect::<BTreeSet<_>>() {
        let value = |m: &BTreeMap<String, Value>| m.get(key).cloned().unwrap_or(Value::Null);
        agree(&format!("sync_store[{key}], as it landed"), value(&landed), value(&carried));
    }
    agree("sync_sealed", json!(sealed_store(first)), json!(second["sync_sealed"] == json!(true)));
    let tier = |b: &Value| json!([b["media_preference"]["tier"], if b["media_preference"]["tier"] == json!(2) { b["media_preference"]["origin"].clone() } else { Value::Null }]);
    agree("media_preference", tier(first), tier(second));
    let friends = |b: &Value| by(b, "friends", &|e| text(e, "peer_id").into(), &|e| e.clone());
    agree("friends", friends(first), friends(second));
    let requests = |b: &Value| by(b, "message_requests", &|e| text(e, "conversation_id").into(), &|e| e.clone());
    agree("message_requests", requests(first), requests(second));
    let vault = |b: &Value| json!([landed_mode(text(&b["key_vault"], "mode")), b["key_vault"]["ciphertext"], b["key_vault"]["independent_ciphertext"]]);
    agree("key_vault", vault(first), vault(second));
    let backup = |b: &Value| by(b, "key_backup", &|e| format!("{}/{}", text(e, "scope"), text(e, "item")), &|e| e["ciphertext"].clone());
    agree("key_backup", backup(first), backup(second));
    let media = |b: &Value| by(b, "media", &|e| text(&e["media"], "hash").into(), &|e| e.clone());
    agree("media", media(first), media(second));
    let registry = |b: &Value| {
        by(b, "remote_memberships", &|e| format!("{}/{}", text(e, "guild_server"), text(e, "guild_id")), &|e| {
            json!([e["joined_at"], e["proof"], e["reported_by"]])
        })
    };
    agree("remote_memberships", registry(first), registry(second));
    d
}

#[tokio::test]
async fn an_account_survives_a_second_move() {
    let mut failures = Vec::new();
    for (name, dir) in every_frozen_shape() {
        let first = load(&dir, "user.json");
        let at = format!("{name}/user.json, moved on");
        let b = home("b.example").await;
        receiving(&b, &first, "@ana:b.example").await;
        import_user(&b, &first, "@ana:b.example").await.unwrap();
        let second = migration::export_user(&b, "@ana:b.example").await.unwrap();
        failures.extend(carried_on(&first, &second, &at));
        let c = home("c.example").await;
        receiving(&c, &second, "@ana:c.example").await;
        match import_user(&c, &second, "@ana:c.example").await {
            Err(e) => failures.push(format!("{at}: refused: {e}")),
            Ok(_) => failures.extend(user_diffs(&c, &second, &at, "@ana:c.example").await),
        }
    }
    verdict("accounts that did not survive a second move", &failures);
}

const USER_FIELDS: &[&str] = &[
    "version", "kind", "subject", "source", "localpart", "created_at", "original_created_at", "chain",
    "profile", "sync_store", "sync_sealed", "media_preference", "devices", "friends", "message_requests",
    "key_vault", "key_backup", "key_backup_omitted", "dm_outbox", "media", "media_omitted", "memberships", "remote_memberships",
    "exported_at",
];

const EMPTY_BY_DESIGN: &[&str] = &["media_omitted", "key_backup_omitted"];

const USER_TABLES: &[(&str, &str, &[&str])] = &[
    ("profile", "profiles", &[]),
    ("sync_store", "sync_store", &["user_id"]),
    ("media_preference", "media_preferences", &["user_id", "updated_at"]),
    ("devices", "devices", &["user_id", "pubkey_b64", "last_seen", "active", "mls_key", "cross_sig"]),
    ("friends", "friends", &["user_id"]),
    ("message_requests", "dm_message_requests", &["user_id"]),
    ("key_vault", "key_vault", &["user_id", "escrow_key"]),
    ("key_backup", "key_backup", &["user_id"]),
    ("dm_outbox", "dm_outbox", &[]),
    ("media", "media", &["owner_user_id", "refcount", "moved_to", "refs", "local_dest"]),
    ("remote_memberships", "remote_memberships", &["user_id", "updated_at"]),
];

const NEVER_CARRIED: &[&str] = &[
    "PASSWORD-HASH",
    "OPAQUE-RECORD",
    "RECOVERY-PUBLIC-KEY",
    "MFA-SECRET",
    "recovery@ana.example",
    "ESCROW-KEY-SECRET",
    "CURATOR-SECRET-KEY",
    "FEED-COPY-DIGEST",
    "resolved-from-feed.example",
    "UNSENT-DRAFT",
    "VOICE-REGION-OF-ONE-DEVICE",
];

fn user_objects<'a>(bundle: &'a Value, field: &str) -> Vec<&'a Value> {
    match &bundle[field] {
        Value::Array(items) if field == "media" => items.iter().map(|e| &e["media"]).collect(),
        Value::Array(items) => items.iter().collect(),
        object @ Value::Object(_) => vec![object],
        _ => Vec::new(),
    }
}

fn unexercised(at: &str, objects: &[&Value], gaps: &mut Vec<String>) {
    let names: BTreeSet<&String> = objects.iter().filter_map(|o| o.as_object()).flat_map(|o| o.keys()).collect();
    for name in names {
        if !objects.iter().any(|o| o.get(name).is_some_and(|v| !v.is_null())) {
            gaps.push(format!("{at}.{name}: null everywhere, so nothing proves it survives a move"));
        }
    }
}

#[tokio::test]
async fn the_newest_frozen_shape_exercises_everything() {
    let (name, dir) = newest_current();
    let guild = load(&dir, "guild.json");
    let user = load(&dir, "user.json");
    let h = home("b.example").await;
    let pool = &h.pool;
    let mut gaps = Vec::new();

    for (file, bundle, kind) in [("guild.json", &guild, "guild"), ("user.json", &user, "user")] {
        if bundle["version"] != json!(BUNDLE_VERSION) || text(bundle, "kind") != kind {
            gaps.push(format!("{name}/{file}: is version {} {}, not a version {BUNDLE_VERSION} {kind} bundle", bundle["version"], bundle["kind"]));
        }
    }

    let named: Vec<String> = sqlx::query_scalar(
        "SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p \
         WHERE m.type = 'table' AND p.name = 'guild_id' ORDER BY m.name",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    for table in named {
        if !GUILD_PARTS.iter().any(|p| p.1 == table) && !NOT_A_GUILD.contains(&table.as_str()) {
            gaps.push(format!("{name}/guild.json: {table} holds a guild's rows and no part of the bundle carries it"));
        }
    }
    let mut parts: Vec<(&str, &str, Vec<Value>)> = GUILD_PARTS.iter().map(|(k, t, _)| (*k, *t, part_rows(&guild, k))).collect();
    parts.push(("expressions", "media", list(&guild, "expressions").iter().map(|e| e["media"].clone()).collect()));
    for (key, table, rows) in parts {
        if rows.is_empty() {
            gaps.push(format!("{name}/guild.json {key}: empty"));
        }
        for column in columns(pool, table).await {
            if !rows.iter().any(|r| r.get(&column).is_some_and(|v| !v.is_null())) {
                gaps.push(format!("{name}/guild.json {key}: no row gives {table}.{column} a value, so nothing proves it survives a move"));
            }
        }
    }
    if list(&guild, "archived").is_empty() {
        gaps.push(format!("{name}/guild.json archived: empty, so no archived history is proven to move"));
    }
    for key in guild.as_object().map(|o| o.keys().collect::<Vec<_>>()).unwrap_or_default() {
        if !GUILD_META.contains(&key.as_str()) && !GUILD_PARTS.iter().any(|p| p.0 == key) {
            gaps.push(format!("{name}/guild.json {key}: a part this suite does not check"));
        }
    }
    for key in user.as_object().map(|o| o.keys().collect::<Vec<_>>()).unwrap_or_default() {
        if !USER_FIELDS.contains(&key.as_str()) {
            gaps.push(format!("{name}/user.json {key}: a field this suite does not check"));
        }
    }

    for field in USER_FIELDS {
        let value = &user[*field];
        let empty = value.is_null() || value.as_array().is_some_and(Vec::is_empty) || value == &json!(0);
        if empty && !EMPTY_BY_DESIGN.contains(field) {
            gaps.push(format!("{name}/user.json {field}: {value}, so nothing proves it survives a move"));
        }
        unexercised(&format!("{name}/user.json {field}"), &user_objects(&user, field), &mut gaps);
    }
    for (field, table, left_behind) in USER_TABLES {
        let objects = user_objects(&user, field);
        for column in columns(pool, table).await {
            let carried = objects.iter().any(|o| o.get(&column).is_some());
            if !carried && !left_behind.contains(&column.as_str()) {
                gaps.push(format!(
                    "{name}/user.json {field}: {table}.{column} is neither carried nor named as left behind"
                ));
            }
        }
    }
    verdict("what the newest frozen shape does not exercise", &gaps);
}

fn paths(value: &Value, prefix: &str, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                out.insert(path.clone());
                paths(inner, &path, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                paths(item, &format!("{prefix}[]"), out);
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn the_newest_frozen_shape_is_what_this_server_exports() {
    let (guild, user) = reference_bundles().await;
    let (name, dir) = newest_current();
    let mut gaps = Vec::new();
    for (file, fresh) in [("guild.json", &guild), ("user.json", &user)] {
        let serialized = fresh.to_string();
        for secret in NEVER_CARRIED {
            if serialized.contains(secret) {
                gaps.push(format!("{file}: {secret} left the server inside a bundle"));
            }
        }
        let (mut now_exported, mut was_frozen) = (BTreeSet::new(), BTreeSet::new());
        paths(fresh, "", &mut now_exported);
        paths(&load(&dir, file), "", &mut was_frozen);
        for path in now_exported.difference(&was_frozen) {
            gaps.push(format!(
                "{file}: this server now exports {path}, which {name} does not have; \
                 freeze a new shape with server/scripts/freeze-migration-bundles.sh"
            ));
        }
    }
    verdict("what this server exports that no frozen shape has", &gaps);
}

fn fid(n: u32) -> String {
    format!("01JC0NF0RMANCE{n:012}")
}

const ANA: &str = "@ana:a.example";
const BOT_APP: &str = "01JC0NF0RMANCEBOTAPP00000001";
const ATTACHMENT: &[u8] = b"conformance attachment: a photo";
const AVATAR: &[u8] = b"conformance avatar: a face";

fn put(home: &Home, bytes: &[u8]) -> String {
    let hash = blake3::hash(bytes).to_hex().to_string();
    let path = home.cfg.media_dir.join(&hash[0..2]).join(&hash);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    hash
}

async fn run(pool: &SqlitePool, sql: &str, binds: &[&str]) {
    let mut query = sqlx::query(sql);
    for bind in binds {
        query = query.bind(*bind);
    }
    query.execute(pool).await.unwrap_or_else(|e| panic!("{e}: {sql}"));
}

async fn reference_guild(a: &Home) -> String {
    let pool = &a.pool;
    let (g, mods) = (fid(1), fid(2));
    let (category, general, news, voice, thread) = (fid(10), fid(11), fid(12), fid(13), fid(14));
    let ticket_channel = fid(15);
    let (emoji, sticker) = (fid(20), fid(21));
    let m: Vec<String> = (100..107).map(fid).collect();
    let emoji_hash = put(a, b"conformance emoji: a parrot");
    let sticker_hash = put(a, b"conformance sticker: a shrug");
    let attachment = blake3::hash(ATTACHMENT).to_hex().to_string();

    run(pool, "INSERT INTO guilds (id, alias, name, icon_ref, owner_user_id, settings, created_at, origin_policy, \
         require_voucher, external_emoji, fallback_domain, min_account_age_days, domain_policy, screening, \
         hold_first_messages, media_expiry_limit_secs, emoji_export_policy, emoji_export_role_id) \
         VALUES (?, 'conformance', 'Conformance', \
         'media://a.example/guild-icon', '@ana:a.example', '{\"theme\":\"dark\"}', 1000, 'allowlist', 1, 0, \
         'standby.example', 7, 'blocklist', '[\"why are you here\"]', 1, 86400, 'role', ?)", &[&g, &mods]).await;
    run(pool, "INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist, mentionable) VALUES \
         (?, ?, '@everyone', 0, 0, 1024, 0, 0), (?, ?, 'mods', 15844367, 1, 8200, 1, 1)", &[&g, &g, &mods, &g]).await;
    run(pool, "INSERT INTO channels (id, guild_id, type, name, topic, position, parent_id, slowmode, created_at, \
         voice_region, bitrate, user_limit, strip_embeds, media_expiry_limit_secs, available_tags, default_sort, \
         default_layout, voice_status, voice_status_at, voice_status_author) VALUES \
         (?, ?, 'category', 'text channels', NULL, 0, NULL, 0, 1000, 'auto', NULL, 0, 0, NULL, '[]', 'activity', 'list', \
          NULL, NULL, NULL), \
         (?, ?, 'text', 'general', 'the general channel', 1, ?, 5, 1000, 'auto', NULL, 0, 1, 3600, \
          '[{\"id\":\"t1\",\"name\":\"bug\"}]', 'creation', 'gallery', NULL, NULL, NULL), \
         (?, ?, 'text', 'announcements', NULL, 2, ?, 0, 1000, 'auto', NULL, 0, 0, NULL, '[]', 'activity', 'list', \
          NULL, NULL, NULL), \
         (?, ?, 'voice', 'lounge', NULL, 3, ?, 0, 1000, 'eu', 96000, 10, 0, NULL, '[]', 'activity', 'list', \
          'ranked grind in the lounge', 1500, '@ana:a.example'), \
         (?, ?, 'thread', 'a question', NULL, 0, ?, 0, 1100, 'auto', NULL, 0, 0, NULL, '[]', 'activity', 'list', \
          NULL, NULL, NULL), \
         (?, ?, 'text', 'ticket-0001', NULL, 4, ?, 0, 1600, 'auto', NULL, 0, 0, NULL, '[]', 'activity', 'list', \
          NULL, NULL, NULL)",
        &[&category, &g, &general, &g, &category, &news, &g, &category, &voice, &g, &category, &thread, &g, &general,
          &ticket_channel, &g, &category]).await;
    run(pool, "INSERT INTO threads (id, parent_id, guild_id, starter_id, owner, title, tags, archived, locked, \
         auto_archive, message_count, last_active, created_at, pinned) VALUES \
         (?, ?, ?, ?, '@ana:a.example', 'a question', '[\"bug\"]', 0, 1, 86400, 1, 2600, 1100, 1)",
        &[&thread, &general, &g, &m[0]]).await;
    run(pool, "INSERT INTO emojis (id, guild_id, name, media_hash, animated, uploader, created_at) \
         VALUES (?, ?, 'parrot', ?, 1, '@ana:a.example', 1000)", &[&emoji, &g, &emoji_hash]).await;
    run(pool, "INSERT INTO stickers (id, guild_id, name, media_hash, format, uploader, created_at) \
         VALUES (?, ?, 'shrug', ?, 'png', '@ana:a.example', 1000)", &[&sticker, &g, &sticker_hash]).await;
    let sizes = (b"conformance emoji: a parrot".len(), b"conformance sticker: a shrug".len());
    run(pool, &format!("INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, thumbhash, \
         capability, purpose, created_at, refcount, expires_at, moved_to) VALUES \
         (?, '@ana:a.example', 'parrot.png', 'image/png', {}, 128, 128, 'THUMBHASH-PARROT', \
          'conformance-emoji-capability', 'expression', 1000, 1, NULL, NULL), \
         (?, '@ana:a.example', 'shrug.png', 'image/png', {}, 160, 160, 'THUMBHASH-SHRUG', \
          'conformance-sticker-capability', 'expression', 1000, 3, {FAR}, 'elsewhere.example')", sizes.0, sizes.1),
        &[&emoji_hash, &sticker_hash]).await;

    run(pool, "INSERT INTO members (guild_id, user_id, nickname, joined_at, timeout_until, banned, ban_reason, \
         display_name, avatar_ref, profile_version, bot_application_id, bot_application_origin, \
         bot_allowed_intents, bot_role_id, bot_installed_by) VALUES \
         (?, '@ana:a.example', 'ana!', 1100, 1500, 0, NULL, 'Ana', 'media://a.example/ana-avatar', 3, \
          NULL, NULL, 0, NULL, NULL), \
         (?, '@bo:b.example', NULL, 1200, NULL, 0, NULL, 'Bo', NULL, 1, \
          ?, 'b.example', 33, ?, '@ana:a.example'), \
         (?, '@cy:c.example', NULL, 1300, NULL, 1, 'spam', '', NULL, 0, \
          NULL, NULL, 0, NULL, NULL)", &[&g, &g, BOT_APP, &mods, &g]).await;
    run(pool, "INSERT INTO member_roles (guild_id, user_id, role_id) VALUES \
         (?, '@ana:a.example', ?), (?, '@bo:b.example', ?)", &[&g, &mods, &g, &mods]).await;
    run(pool, "INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES \
         (?, 'role', ?, 1024, 0), (?, 'member', '@bo:b.example', 0, 2048), (?, 'role', ?, 0, 2048)",
        &[&general, &mods, &general, &news, &g]).await;

    let first = format!("welcome <@&{mods}> to <#{news}> <parrot:{emoji}>");
    let attachments = format!(
        "[{{\"reference\":\"media://a.example/{attachment}\",\"filename\":\"photo.png\",\"mime\":\"image/png\",\"size\":{}}}]",
        ATTACHMENT.len()
    );
    let sticker_ref = format!("{{\"id\":\"{sticker}\",\"name\":\"shrug\",\"origin\":\"a.example\"}}");
    let later = format!("<parrot:{emoji}@a.example> is the good one, <@@bo:b.example>");
    let news_body = format!("news for <#{general}>");
    #[allow(clippy::type_complexity)]
    let messages: [(&str, &str, &str, &str, &str, Option<&str>, Option<&str>, Option<&str>, i64, Option<i64>, i64, Option<&str>); 7] = [
        (&m[0], &general, ANA, &first, &attachments, None, Some(&thread), Some("ed25519:conformance-signature-0"), 2000, Some(2050), 0, None),
        (&m[1], &general, "@bo:b.example", "agreed", "[]", Some(&m[0]), None, Some("ed25519:conformance-signature-1"), 2100, None, 0, None),
        (&m[2], &general, ANA, "", "[]", None, None, None, 2200, None, 0, Some(&sticker_ref)),
        (&m[3], &general, "@bo:b.example", "", "[]", None, None, None, 2300, None, 1, None),
        (&m[4], &general, ANA, &later, "[]", Some(&m[0]), None, Some("ed25519:conformance-signature-4"), 2400, Some(2450), 0, None),
        (&m[5], &thread, "@bo:b.example", "in the thread", "[]", None, None, None, 2600, None, 0, None),
        (&m[6], &news, ANA, &news_body, "[]", None, None, None, 2700, None, 0, None),
    ];
    for (id, channel, author, content, attachments, reply_to, thread_id, signature, created_at, edited_at, deleted, sticker) in messages {
        sqlx::query(
            "INSERT INTO messages (id, channel_id, guild_id, author_id, content, attachments, reply_to, thread_id, \
             author_signature, created_at, edited_at, deleted, sticker) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(channel)
        .bind(&g)
        .bind(author)
        .bind(content)
        .bind(attachments)
        .bind(reply_to)
        .bind(thread_id)
        .bind(signature)
        .bind(created_at)
        .bind(edited_at)
        .bind(deleted)
        .bind(sticker)
        .execute(pool)
        .await
        .unwrap();
    }

    let custom = format!("<parrot:{emoji}>");
    run(pool, "INSERT INTO reactions (message_id, emoji, user_id, created_at) VALUES \
         (?, '\u{1F44D}', '@bo:b.example', 3000), (?, ?, '@ana:a.example', 3001), (?, '\u{1F44D}', '@bo:b.example', 3002)",
        &[&m[0], &m[0], &custom, &m[4]]).await;
    run(pool, "INSERT INTO message_mentions (message_id, channel_id, user_id, kind) VALUES \
         (?, ?, ?, 'role'), (?, ?, '@bo:b.example', 'user')", &[&m[0], &general, &mods, &m[4], &general]).await;
    run(pool, "INSERT INTO pins (channel_id, message_id, pinned_by, pinned_at) VALUES (?, ?, '@ana:a.example', 3100)",
        &[&general, &m[0]]).await;
    run(pool, "INSERT INTO read_state (user_id, channel_id, last_read_id, muted, updated_at) VALUES \
         ('@ana:a.example', ?, ?, 1, 3200), ('@bo:b.example', ?, ?, 0, 3201)", &[&general, &m[4], &news, &m[6]]).await;
    run(pool, "INSERT INTO channel_follows (source_id, target_id, created_by, created_at) \
         VALUES (?, ?, '@ana:a.example', 3300)", &[&news, &general]).await;
    run(pool, &format!("INSERT INTO invites (code, guild_id, channel_id, creator, uses, max_uses, expires_at, created_at) \
         VALUES ('conformance', ?, ?, '@ana:a.example', 3, 100, {FAR}, 1000), \
         ('lobby', ?, NULL, '@ana:a.example', 0, NULL, NULL, 1001)"), &[&g, &general, &g]).await;
    let exempt = format!("[\"{mods}\"]");
    let exempt_channels = format!("[\"{news}\"]");
    let scope_channels = format!("[\"{general}\"]");
    run(pool, "INSERT INTO automod_rules (id, guild_id, name, kind, pattern, action, threshold, exempt_roles, \
         enabled, created_at, window_secs, timeout_secs, exempt_channels, scope_channels, escalate, \
         escalate_window_secs, created_by, updated_at) VALUES (?, ?, 'no links', 'link', '.*', 'block', 3, ?, 1, 1000, \
         20, 600, ?, ?, '[{\"hits\":3,\"action\":\"timeout\"},{\"hits\":5,\"action\":\"ban\"}]', 7200, \
         '@ana:a.example', 1200)", &[&fid(30), &g, &exempt, &exempt_channels, &scope_channels]).await;
    run(pool, "INSERT INTO guild_origin_rules (guild_id, domain, action, feed_url, feed_key) VALUES \
         (?, 'blocked.example', 'block', NULL, NULL), \
         (?, 'feed:https://feeds.example/curated.json', 'allow', 'https://feeds.example/curated.json', 'CURATOR-PUBLIC-KEY')", &[&g, &g]).await;
    run(pool, "INSERT INTO guild_domain_rules (guild_id, domain, action) VALUES (?, 'allowed.example', 'allow')", &[&g]).await;
    run(pool, "INSERT INTO screening_answers (guild_id, user_id, answers, state, created_at) \
         VALUES (?, '@cy:c.example', '[\"for the parrots\"]', 'pending', 1300)", &[&g]).await;
    run(pool, "INSERT INTO held_messages (id, guild_id, channel_id, author_id, payload, reason, created_at, state, \
         handled_by, handled_at) VALUES (?, ?, ?, '@cy:c.example', '{\"content\":\"hi\"}', 'first message', 1400, \
         'approved', '@ana:a.example', 1450)", &[&fid(31), &g, &general]).await;
    run(pool, "INSERT INTO guild_voice_regions (guild_id, name, sfu, turn, pubkey_hint, is_default, created_by, \
         created_at) VALUES (?, 'eu', 'wss://sfu.example', 'turn:turn.example', 'ed25519:sfu-key-hint', 1, \
         '@ana:a.example', 1000)", &[&g]).await;
    run(pool, "INSERT INTO audit_log (id, guild_id, actor, action, target, data, created_at) \
         VALUES (?, ?, '@ana:a.example', 'role.create', ?, '{\"name\":\"mods\"}', 1000)", &[&fid(32), &g, &mods]).await;

    run(pool, "INSERT INTO media_feeds (url, public_b64, curator, serial, digest, issued_at, expires_at, fetched_at, \
         attempted_at, error, allows, blocks) VALUES ('https://feeds.example/curated.json', 'CURATOR-PUBLIC-KEY', \
         'A curator', 3, 'FEED-COPY-DIGEST', 1000, 2000, 1000, 1000, NULL, 0, 1)", &[]).await;
    run(pool, "INSERT INTO media_feed_hosts (url, public_b64, origin, action) VALUES \
         ('https://feeds.example/curated.json', 'CURATOR-PUBLIC-KEY', 'resolved-from-feed.example', 'block')", &[]).await;
    run(pool, "INSERT INTO media_curator_key (id, secret_b64, public_b64, created_at) \
         VALUES (1, 'CURATOR-SECRET-KEY', 'CURATOR-PUBLIC-KEY-OF-A', 1000)", &[]).await;

    let components = r#"[{"type":"action_row","components":[{"type":"button","style":"primary","label":"Open a ticket","custom_id":"support:ticket:open"},{"type":"button","style":"link","label":"The rules","url":"https://example.test/rules"},{"type":"select","custom_id":"roles:pick","placeholder":"Pick a colour","min":0,"max":1,"options":[{"label":"Red","value":"red","description":"a warm one","default":false}]}]}]"#;
    let cards = r#"[{"title":"Welcome","description":"Read the rules, then say hello.","colour":3447003,"fields":[{"name":"Rules","value":"Be kind.","inline":true}],"footer":"posted by Bo"}]"#;
    run(pool, "UPDATE messages SET components = ?, cards = ? WHERE id IN (?, ?)",
        &[components, cards, &m[1], &m[5]]).await;

    let moved = telium_server::cold::archive_channel(&a.state, &general, 100).await.unwrap();
    assert!(moved >= 2, "nothing was archived, so the reference guild has no cold history");
    g
}

async fn reference_account(a: &Home) {
    let pool = &a.pool;
    run(pool, "INSERT INTO accounts (user_id, localpart, domain, password_hash, created_at, mfa_secret, \
         opaque_record, recovery_public_key, sync_sealed_at) VALUES ('@ana:a.example', 'ana', \
         'a.example', 'PASSWORD-HASH', 1000, 'MFA-SECRET', 'OPAQUE-RECORD', 'RECOVERY-PUBLIC-KEY', \
         1850)", &[]).await;
    run(pool, "INSERT INTO recovery_addresses (user_id, verified_email, verified_at) \
         VALUES ('@ana:a.example', 'recovery@ana.example', 1800)", &[]).await;
    run(pool, "INSERT INTO imported_identities (user_id, previous_id, original_created_at, chain, imported_at) \
         VALUES ('@ana:a.example', '@ana:z.example', 500, \
         '[{\"id\":\"@ana:z.example\",\"moved_at\":900,\"server\":\"z.example\"}]', 900)", &[]).await;
    let avatar = put(a, AVATAR);
    let attachment = put(a, ATTACHMENT);
    run(pool, "INSERT INTO profiles (user_id, display_name, avatar_ref, banner_ref, accent_color, theme_colors, bio, pronouns, \
         profile_version, updated_at) VALUES ('@ana:a.example', 'Ana', ?, ?, 3447003, '[15786176,0]', 'moving house', 'she/her', 4, 1700)",
        &[&format!("media://a.example/{avatar}"), &format!("media://a.example/{attachment}")]).await;
    let sealed = |ct: &str| json!({ "sealed": "v1", "kid": "KEYRING-1", "iv": format!("IV-{ct}"), "ct": format!("SEALED-{ct}") }).to_string();
    run(pool, "INSERT INTO sync_store (user_id, key, value, updated_at) VALUES \
         ('@ana:a.example', 'prefs.v1', '{\"theme\":\"dark\",\"voiceRegion\":\"VOICE-REGION-OF-ONE-DEVICE\"}', 1800), \
         ('@ana:a.example', 'emoji.recent.v1', ?, 1861), \
         ('@ana:a.example', 'emoji.tone.v1', ?, 1862), \
         ('@ana:a.example', 'gif.favorites.v1', ?, 1863), \
         ('@ana:a.example', 'drafts.v2', ?, 1864), \
         ('@ana:a.example', 'stickers.saved.v1', ?, 1865), \
         ('@ana:a.example', 'drafts.v1', '{\"general\":\"UNSENT-DRAFT\"}', 1804)",
        &[&sealed("EMOJI-RECENT"), &sealed("EMOJI-TONE"), &sealed("GIF-FAVORITES"), &sealed("DRAFTS"), &sealed("SAVED-STICKERS")]).await;
    run(pool, "INSERT INTO media_preferences (user_id, tier, origin, updated_at) \
         VALUES ('@ana:a.example', 2, 'media.example', 1800)", &[]).await;
    run(pool, "INSERT INTO devices (device_id, user_id, name, pubkey_b64, created_at, last_seen, active, mls_key, \
         cross_sig) VALUES ('DEVICE-LAPTOP', '@ana:a.example', 'laptop', 'DEVICE-PUBKEY-LAPTOP', 1000, 1900, 1, \
         'MLS-KEY', 'CROSS-SIG'), ('DEVICE-OLD', '@ana:a.example', 'old phone', 'DEVICE-PUBKEY-OLD', 900, 950, 0, NULL, NULL)", &[]).await;
    run(pool, "INSERT INTO friends (user_id, peer_id, peer_domain, state, created_at, updated_at) VALUES \
         ('@ana:a.example', '@bo:b.example', 'b.example', 'accepted', 1000, 1100), \
         ('@ana:a.example', '@dan:d.example', 'd.example', 'blocked', 1000, 1200)", &[]).await;
    run(pool, "INSERT INTO conversations (id, kind, sequencer, creator, created_at, updated_at) VALUES \
         ('CONVERSATION-REQUEST-ACCEPTED', 'dm', 'a.example', '@eve:e.example', 1300, 1320), \
         ('CONVERSATION-REQUEST-DECLINED', 'dm', 'a.example', '@mallory:m.example', 1400, 1420), \
         ('CONVERSATION-LEGACY-DM', 'dm', 'a.example', '@trent:t.example', 1500, 1520)", &[]).await;
    run(pool, "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) VALUES \
         ('CONVERSATION-REQUEST-ACCEPTED', '@ana:a.example', 'a.example', 1300), \
         ('CONVERSATION-REQUEST-ACCEPTED', '@eve:e.example', 'e.example', 1300), \
         ('CONVERSATION-REQUEST-DECLINED', '@ana:a.example', 'a.example', 1400), \
         ('CONVERSATION-REQUEST-DECLINED', '@mallory:m.example', 'm.example', 1400), \
         ('CONVERSATION-LEGACY-DM', '@ana:a.example', 'a.example', 1500), \
         ('CONVERSATION-LEGACY-DM', '@trent:t.example', 't.example', 1500)", &[]).await;
    run(pool, "INSERT INTO dm_message_requests \
         (conversation_id, user_id, sender_id, state, created_at, updated_at) VALUES \
         ('CONVERSATION-REQUEST-ACCEPTED', '@ana:a.example', '@eve:e.example', 'accepted', 1300, 1320), \
         ('CONVERSATION-REQUEST-DECLINED', '@ana:a.example', '@mallory:m.example', 'declined', 1400, 1420)", &[]).await;
    run(pool, "INSERT INTO key_vault (user_id, mode, ciphertext, escrow_key, version, updated_at, independent_ciphertext) \
         VALUES ('@ana:a.example', 'self_custody', 'VAULT-CIPHERTEXT', 'ESCROW-KEY-SECRET', 7, 1900, \
         'k1.INDEPENDENT-CIPHERTEXT')", &[]).await;
    run(pool, "INSERT INTO key_backup (user_id, scope, item, ciphertext, updated_at) VALUES \
         ('@ana:a.example', 'dm', 'conversation-1', 'BACKUP-CIPHERTEXT-1', 1950), \
         ('@ana:a.example', 'dm', 'conversation-2', 'BACKUP-CIPHERTEXT-2', 1960)", &[]).await;

    run(pool, "INSERT INTO conversations (id, kind, sequencer, creator, created_at, updated_at) \
         VALUES ('CONVERSATION-REANCHORED', 'gc', 'b.example', '@ana:a.example', 1000, 1000)", &[]).await;
    run(pool, "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) VALUES \
         ('CONVERSATION-REANCHORED', '@ana:a.example', 'a.example', 1000), \
         ('CONVERSATION-REANCHORED', '@bo:c.example', 'c.example', 1000)", &[]).await;
    let payload = json!({
        "conversation": { "id": "CONVERSATION-REANCHORED", "sequencer": "a.example", "members": [] },
        "message": {
            "id": "DM-MESSAGE-1", "conversation_id": "CONVERSATION-REANCHORED", "seq": 4, "epoch": 2,
            "kind": "application", "sender": ANA, "sender_device": "DEVICE-LAPTOP",
            "ciphertext": "DM-CIPHERTEXT-1", "created_at": 2000,
        },
    });
    run(pool, "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, path, payload, attempts, \
         next_attempt_at, last_error, created_at) VALUES ('FRAME-1', 'CONVERSATION-REANCHORED', 'DM-MESSAGE-1', \
         'c.example', '/_telium/v1/dm/deliver', ?, 5, 3000, 'connection refused', 2000)", &[&payload.to_string()]).await;

    run(pool, &format!("INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, thumbhash, \
         capability, purpose, created_at, expires_at) VALUES \
         (?, '@ana:a.example', 'avatar.png', 'image/png', {}, 256, 256, 'THUMBHASH-AVATAR', \
          'conformance-avatar-capability', 'profile', 1500, NULL), \
         (?, '@ana:a.example', 'photo.png', 'image/png', {}, 640, 480, 'THUMBHASH-PHOTO', \
          'conformance-photo-capability', 'attachment', 1600, {FAR})", AVATAR.len(), ATTACHMENT.len()),
        &[&avatar, &attachment]).await;

    let proof = json!({ "kind": "membership", "action": "joined", "user_id": ANA, "guild_id": "GUILD-FAR",
                        "guild_server": "g.example", "at": 4000, "key_id": "ed25519:g", "signature": "MEMBERSHIP-SIGNATURE" });
    run(pool, "INSERT INTO remote_memberships (user_id, guild_server, guild_id, joined_at, proof, reported_by, updated_at) \
         VALUES ('@ana:a.example', 'g.example', 'GUILD-FAR', 4000, ?, 'guild', 4000), \
         ('@ana:a.example', 'h.example', 'GUILD-FARTHER', 4200, NULL, 'client', 4200)", &[&proof.to_string()]).await;
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let ordered: BTreeMap<&String, Value> = map.iter().map(|(k, v)| (k, sorted(v))).collect();
            Value::Object(ordered.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

async fn reference_bundles() -> (Value, Value) {
    let a = home("a.example").await;
    let guild_id = reference_guild(&a).await;
    reference_account(&a).await;
    let mut guild = migration::export_guild(&a, &guild_id).await.unwrap();
    let mut user = migration::export_user(&a, ANA).await.unwrap();
    guild["exported_at"] = json!(FROZEN_AT);
    user["exported_at"] = json!(FROZEN_AT);
    (sorted(&guild), sorted(&user))
}

fn freeze_into(asked: &str) -> String {
    let name = if asked == "next" || asked == "1" {
        let minors: Vec<u32> = frozen()
            .iter()
            .filter_map(|(name, _)| shape(name))
            .filter(|(major, _)| *major == BUNDLE_VERSION)
            .map(|(_, minor)| minor)
            .collect();
        match minors.iter().max() {
            None => format!("v{BUNDLE_VERSION}"),
            Some(minor) => format!("v{BUNDLE_VERSION}.{}", minor + 1),
        }
    } else {
        asked.to_string()
    };
    assert_eq!(
        shape(&name).map(|s| s.0),
        Some(BUNDLE_VERSION),
        "{name} is not a shape of BUNDLE_VERSION {BUNDLE_VERSION}; name it v{BUNDLE_VERSION} or v{BUNDLE_VERSION}.N"
    );
    assert!(
        !Path::new(FIXTURES).join(&name).exists(),
        "{name} is already frozen, and a frozen shape is never rewritten; freeze the next one instead"
    );
    name
}

#[tokio::test]
#[ignore = "writes a new frozen shape; run server/scripts/freeze-migration-bundles.sh"]
async fn freeze() {
    let asked = std::env::var("TELIUM_FREEZE_BUNDLES")
        .expect("TELIUM_FREEZE_BUNDLES is not set; run server/scripts/freeze-migration-bundles.sh");
    let name = freeze_into(&asked);
    let (guild, user) = reference_bundles().await;
    if let Some((was, dir)) = frozen().into_iter().rfind(|(n, _)| shape(n).map(|s| s.0) == Some(BUNDLE_VERSION)) {
        assert!(
            load(&dir, "guild.json") != guild || load(&dir, "user.json") != user,
            "this server exports exactly {was}; there is nothing new to freeze"
        );
    }
    let dir = Path::new(FIXTURES).join(&name);
    std::fs::create_dir_all(&dir).unwrap();
    for (file, bundle) in [("guild.json", &guild), ("user.json", &user)] {
        std::fs::write(dir.join(file), serde_json::to_string_pretty(bundle).unwrap() + "\n").unwrap();
    }
    println!("froze {}", dir.display());
}
