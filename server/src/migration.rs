
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{hash_token, invite_code, now_ms, random_token, ulid, unb64};
use serde_json::{json, Value};

pub mod handoff;
pub mod media;

mod export;
use export::expression_mime;
pub use export::{export_guild, export_user, MAX_USER_MEDIA_OBJECTS, USER_MEDIA_BUDGET_BYTES};

pub const BUNDLE_VERSION: i64 = 2;

const GUILD_TABLES: &[&str] = &[
    "guilds",
    "roles",
    "channels",
    "threads",
    "emojis",
    "stickers",
    "members",
    "member_roles",
    "channel_overwrites",
    "messages",
    "reactions",
    "message_mentions",
    "pins",
    "read_state",
    "channel_follows",
    "invites",
    "automod_rules",
    "guild_origin_rules",
    "guild_domain_rules",
    "screening_answers",
    "held_messages",
    "guild_voice_regions",
    "audit_log",
    "media",
];

const BUNDLE_KEYS: &[&str] = &[
    "version", "kind", "subject", "source", "guild", "channels", "roles", "threads", "emojis",
    "stickers", "members", "member_roles", "overwrites", "messages", "reactions", "mentions",
    "pins", "read_state", "follows", "invites", "automod_rules", "origin_rules",
    "domain_rules", "screening_answers", "held_messages", "voice_regions", "audit_log",
    "archived", "expressions", "exported_at",
    "key_id", "signature",
];

fn note_unknown_keys(bundle: &Value) {
    let Some(map) = bundle.as_object() else { return };
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|key| !BUNDLE_KEYS.contains(key))
        .collect();
    if !unknown.is_empty() {
        tracing::warn!(
            target: crate::logcat::MIGRATION,
            keys = unknown.join(", "),
            "bundle carries parts this server does not know how to store; importing the rest"
        );
    }
}

struct Schema(std::collections::HashMap<&'static str, Vec<String>>);

impl Schema {
    async fn load(pool: &sqlx::SqlitePool) -> ApiResult<Self> {
        let mut map = std::collections::HashMap::new();
        for name in GUILD_TABLES {
            let columns: Vec<String> =
                sqlx::query_scalar(&format!("SELECT name FROM pragma_table_info('{name}')"))
                    .fetch_all(pool)
                    .await?;
            map.insert(*name, columns);
        }
        Ok(Self(map))
    }

    fn columns(&self, table: &str) -> &[String] {
        self.0.get(table).map(Vec::as_slice).unwrap_or(&[])
    }
}

async fn restore(
    tx: &mut sqlx::SqliteConnection,
    schema: &Schema,
    table: &str,
    row: &Value,
    overrides: &[(&str, Value)],
    if_new: bool,
) -> ApiResult<()> {
    let mut values: Vec<(&str, Value)> = Vec::new();
    for name in schema.columns(table) {
        if let Some((_, value)) = overrides.iter().find(|(key, _)| key == name) {
            values.push((name, value.clone()));
        } else if let Some(value) = row.get(name) {
            values.push((name, value.clone()));
        }
    }
    if values.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "bundle's {table} rows have no column this server recognises"
        )));
    }

    let names = values.iter().map(|(n, _)| quote(n)).collect::<Vec<_>>().join(", ");
    let holes = vec!["?"; values.len()].join(", ");
    let conflict = if if_new { " ON CONFLICT DO NOTHING" } else { "" };
    let sql = format!("INSERT INTO {} ({names}) VALUES ({holes}){conflict}", quote(table));
    let mut query = sqlx::query(&sql);
    for (_, value) in &values {
        query = match value {
            Value::Null => query.bind(None::<String>),
            Value::Bool(b) => query.bind(i64::from(*b)),
            Value::Number(n) if n.is_i64() => query.bind(n.as_i64()),
            Value::Number(n) => query.bind(n.as_f64()),
            Value::String(s) => query.bind(s.clone()),
            other => query.bind(other.to_string()),
        };
    }
    query.execute(tx).await.map_err(|e| refused(e, table))?;
    Ok(())
}

fn refused(e: sqlx::Error, table: &str) -> ApiError {
    if let sqlx::Error::Database(db) = &e {
        if db.message().contains("constraint failed") {
            return ApiError::BadRequest(format!("bundle's {table} rows: {}", db.message()));
        }
    }
    ApiError::Db(e)
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn list<'a>(bundle: &'a Value, key: &str) -> &'a [Value] {
    bundle.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row.get(key).and_then(Value::as_str).unwrap_or("")
}

fn int(row: &Value, key: &str, default: i64) -> i64 {
    row.get(key).and_then(Value::as_i64).unwrap_or(default)
}

fn note_missing_bytes(landed: &std::collections::HashSet<&str>, row: &Value, kind: &str) {
    let hash = text(row, "media_hash");
    if !landed.contains(hash) {
        tracing::warn!(
            target: crate::logcat::MIGRATION,
            hash,
            kind,
            name = text(row, "name"),
            "expression arrived with no bytes behind it; importing the row blank"
        );
    }
}

pub fn grant_payload(subject: &str, destination: &str, import_token: &str, created_at: i64) -> Vec<u8> {
    let value = json!({
        "kind": "migration_grant",
        "subject": subject,
        "destination": destination,
        "import_token_hash": hash_token(import_token),
        "created_at": created_at,
    });
    serde_json::to_vec(&value).expect("json value is serialisable")
}

pub async fn verify_device_signature(
    state: &AppState,
    user_id: &str,
    device_id: &str,
    payload: &[u8],
    sig_b64: &str,
) -> ApiResult<()> {
    let pubkey: Option<String> = sqlx::query_scalar(
        "SELECT pubkey_b64 FROM devices WHERE user_id = ? AND device_id = ? AND active = 1",
    )
    .bind(user_id)
    .bind(device_id)
    .fetch_optional(&state.pool)
    .await?;
    let pubkey = pubkey.ok_or_else(|| {
        ApiError::Unauthorized("that device is not active on this account".into())
    })?;
    if !crypto::verify_bytes(&pubkey, payload, sig_b64) {
        return Err(ApiError::Unauthorized("device signature does not verify".into()));
    }
    Ok(())
}

const LIVE_CLAIMS_PER_ACCOUNT: i64 = 4;

pub async fn sweep_claims(state: &AppState) -> anyhow::Result<u64> {
    let gone = sqlx::query("DELETE FROM import_claims WHERE expires_at <= ?")
        .bind(now_ms())
        .execute(&state.pool)
        .await?
        .rows_affected();
    if gone > 0 {
        tracing::info!(target: crate::logcat::MIGRATION, count = gone, "cleared import claims that had run out");
    }
    Ok(gone)
}

pub async fn create_claim(
    state: &AppState,
    subject_type: &str,
    source: &str,
    source_id: &str,
    target_id: &str,
) -> ApiResult<(String, i64)> {
    let mut tx = state.pool.begin().await?;
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM import_claims \
         WHERE target_id = ? AND used_at IS NULL AND expires_at > ?",
    )
    .bind(target_id)
    .bind(now_ms())
    .fetch_one(&mut *tx)
    .await?;
    if live >= LIVE_CLAIMS_PER_ACCOUNT {
        let dropped = sqlx::query(
            "DELETE FROM import_claims WHERE token_hash IN ( \
               SELECT token_hash FROM import_claims \
               WHERE target_id = ? AND used_at IS NULL AND expires_at > ? \
               ORDER BY created_at ASC LIMIT ?)",
        )
        .bind(target_id)
        .bind(now_ms())
        .bind(live - LIVE_CLAIMS_PER_ACCOUNT + 1)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        tracing::info!(
            target: crate::logcat::MIGRATION,
            target_id,
            dropped,
            "account is at its limit of pending migrations; forgetting the oldest"
        );
    }
    let token = random_token(24);
    let expires_at = now_ms() + 7 * 24 * 3600 * 1000;
    sqlx::query(
        "INSERT INTO import_claims (token_hash, subject_type, source, source_id, target_id, \
         created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(subject_type)
    .bind(source)
    .bind(source_id)
    .bind(target_id)
    .bind(now_ms())
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((token, expires_at))
}

#[derive(Default)]
pub struct ImportsInFlight(std::sync::Mutex<std::collections::HashSet<String>>);

pub struct InFlightGuard {
    ids: std::sync::Arc<ImportsInFlight>,
    id: String,
}

impl ImportsInFlight {
    pub fn begin(
        self: &std::sync::Arc<Self>,
        migration_id: &str,
    ) -> Result<InFlightGuard, ApiError> {
        if !self.0.lock().unwrap().insert(migration_id.to_string()) {
            return Err(ApiError::TryAgain(
                "a push with that migration id is arriving here right now; wait for it to \
                 finish rather than sending it twice"
                    .into(),
            ));
        }
        Ok(InFlightGuard { ids: self.clone(), id: migration_id.to_string() })
    }
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.ids.0.lock().unwrap().remove(&self.id);
    }
}

pub struct Reservation<'a> {
    pub migration_id: &'a str,
    pub subject_type: &'a str,
    pub source: &'a str,
    pub source_id: &'a str,
    pub token_hash: &'a str,
}

impl Reservation<'_> {
    async fn settle(&self, tx: &mut sqlx::SqliteConnection, new_id: &str) -> ApiResult<()> {
        sqlx::query("UPDATE import_log SET new_id = ? WHERE id = ?")
            .bind(new_id)
            .bind(self.migration_id)
            .execute(&mut *tx)
            .await?;
        Ok(())
    }

    async fn take(&self, tx: &mut sqlx::SqliteConnection) -> ApiResult<()> {
        let taken = sqlx::query(
            "INSERT INTO import_log (id, subject_type, source, source_id, new_id, imported_at, \
             ack, token_hash) VALUES (?, ?, ?, ?, '', ?, '', ?)",
        )
        .bind(self.migration_id)
        .bind(self.subject_type)
        .bind(self.source)
        .bind(self.source_id)
        .bind(now_ms())
        .bind(self.token_hash)
        .execute(&mut *tx)
        .await;
        match taken {
            Ok(_) => Ok(()),
            Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Err(ApiError::TryAgain(
                "an import with that migration id landed here while this one was arriving; ask \
                 for its acknowledgement rather than sending it again"
                    .into(),
            )),
            Err(e) => Err(e.into()),
        }
    }
}

fn landed_vault_mode(mode: &str) -> &'static str {
    match mode {
        "self_custody" => "self_custody",
        "opaque_custody" => "opaque_custody",
        _ => "device_custody",
    }
}

fn usable_capability(claimed: &str) -> bool {
    (16..=128).contains(&claimed.len())
        && claimed.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) struct LandedUpload {
    pub(crate) hash: String,
    pub(crate) filename: String,
    pub(crate) mime: String,
    pub(crate) size: i64,
    pub(crate) width: Option<i64>,
    pub(crate) height: Option<i64>,
    pub(crate) thumbhash: Option<String>,
    pub(crate) capability: String,
    pub(crate) purpose: String,
    pub(crate) created_at: i64,
    pub(crate) expires_at: Option<i64>,
}

pub(crate) type Refusal = (String, String);

pub(crate) async fn land_one_upload(
    state: &AppState,
    entry: &Value,
    target_id: &str,
    landed_bytes: i64,
) -> ApiResult<Result<LandedUpload, Refusal>> {
    let now = now_ms();
    let policy = &state.cfg.media_policy;
    let Some(media) = entry.get("media").filter(|m| m.is_object()) else {
        return Ok(Err((String::new(), "no media descriptor".into())));
    };
    let hash = text(media, "hash");
    let refuse = |reason: &str| Ok(Err((hash.to_string(), reason.to_string())));
    if !crate::routes::media::valid_hash(hash) {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload arrived under something that is not a hash; not importing it");
        return refuse("not a hash");
    }
    let purpose = text(media, "purpose");
    if !["attachment", "profile", "expression"].contains(&purpose) {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, purpose, "upload has a purpose this server does not store; not importing it");
        return refuse("purpose not stored here");
    }
    let Some(bytes) = unb64(text(entry, "data")) else {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload's bytes are not base64; not importing it");
        return refuse("bytes not base64");
    };
    let ceiling = match purpose {
        "profile" => policy.max_file_bytes.min(policy.max_profile_asset_bytes),
        "expression" => policy.max_file_bytes.min(crate::routes::guild::MAX_EXPRESSION_BYTES),
        _ => policy.max_file_bytes,
    };
    if bytes.is_empty() || bytes.len() > ceiling {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, purpose, size = bytes.len(), ceiling, "upload is not a size this server stores; not importing it");
        return refuse("size");
    }
    if blake3::hash(&bytes).to_hex().to_string() != hash {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload does not match its hash; not importing it");
        return refuse("bytes do not match the hash");
    }
    let expires_at = media.get("expires_at").and_then(Value::as_i64);
    if expires_at.is_some_and(|at| at <= now) {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload had already expired; not importing it");
        return refuse("expired");
    }
    if let Err(e) = crate::routes::media::enforce_media_policy(
        state,
        target_id,
        purpose,
        landed_bytes.saturating_add(bytes.len() as i64),
    )
    .await
    {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, purpose, reason = %e, "this server's media policy does not take the upload; not importing it");
        return Ok(Err((hash.to_string(), format!("policy: {e}"))));
    }
    if purpose == "expression" {
        if let Err(reason) = crate::expression::sniff(&bytes) {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, %reason, "expression upload is not a format this server accepts as an upload; importing it as it is");
        }
    }
    if let Err(e) = crate::scan::screen_upload(state, target_id, hash, &bytes).await {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, error = %e, "upload did not pass screening; not importing it");
        return refuse("screening");
    }

    let size = bytes.len() as i64;
    let key = crate::routes::media::media_key(state, hash);
    state.media_store.put(&key, bytes).await?;

    let capability = match text(media, "capability") {
        claimed if usable_capability(claimed) => claimed.to_string(),
        _ => {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload arrived with a capability not worth keeping; minting a new one");
            random_token(24)
        }
    };
    let filename: String = text(media, "filename").chars().take(255).collect();
    Ok(Ok(LandedUpload {
        hash: hash.to_string(),
        filename: if filename.trim().is_empty() { hash.to_string() } else { filename },
        mime: crate::routes::media::sanitize_mime(purpose, text(media, "mime")),
        size,
        width: media.get("width").and_then(Value::as_i64).filter(|w| *w > 0),
        height: media.get("height").and_then(Value::as_i64).filter(|h| *h > 0),
        thumbhash: media
            .get("thumbhash")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && t.len() <= 256)
            .map(str::to_string),
        capability,
        purpose: purpose.to_string(),
        created_at: int(media, "created_at", now),
        expires_at,
    }))
}

pub(crate) async fn insert_landed_upload(
    tx: &mut sqlx::SqliteConnection,
    upload: &LandedUpload,
    owner: &str,
) -> ApiResult<bool> {
    let written = sqlx::query(
        "INSERT INTO media (hash, owner_user_id, filename, mime, size, width, height, \
         thumbhash, capability, purpose, created_at, refcount, expires_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
    )
    .bind(&upload.hash)
    .bind(owner)
    .bind(&upload.filename)
    .bind(&upload.mime)
    .bind(upload.size)
    .bind(upload.width)
    .bind(upload.height)
    .bind(&upload.thumbhash)
    .bind(&upload.capability)
    .bind(&upload.purpose)
    .bind(upload.created_at)
    .bind(upload.expires_at)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    Ok(written > 0)
}

async fn land_user_media(
    state: &AppState,
    bundle: &Value,
    target_id: &str,
) -> ApiResult<(Vec<LandedUpload>, Vec<Refusal>)> {
    let entries = list(bundle, "media");
    if entries.len() > MAX_USER_MEDIA_OBJECTS {
        return Err(ApiError::BadRequest(format!(
            "bundle carries more uploads than an account may bring here ({MAX_USER_MEDIA_OBJECTS})"
        )));
    }
    let omitted = list(bundle, "media_omitted");
    if !omitted.is_empty() {
        tracing::info!(
            target: crate::logcat::MIGRATION,
            target_id,
            count = omitted.len(),
            "the source left uploads out of the bundle for its size; they will be fetched one at a time"
        );
    }

    let mut landed: Vec<LandedUpload> = Vec::new();
    let mut refused: Vec<Refusal> = Vec::new();
    let mut landed_bytes: i64 = 0;
    for entry in entries {
        match land_one_upload(state, entry, target_id, landed_bytes).await? {
            Ok(upload) => {
                landed_bytes = landed_bytes.saturating_add(upload.size);
                landed.push(upload);
            }
            Err((hash, _)) if hash.is_empty() => {}
            Err(refusal) => refused.push(refusal),
        }
    }
    Ok((landed, refused))
}

pub const PORTABLE_SYNC_KEYS: [&str; 7] = [
    "prefs.v1",
    "emoji.recent.v1",
    "emoji.tone.v1",
    "gif.favorites.v1",
    "drafts.v2",
    "stickers.saved.v1",
    "identity.pins.v1",
];

static DEVICE_SYNC_FIELDS: [(&str, &[&str]); 1] = [(
    "prefs.v1",
    &[
        "voiceRegion",
        "richPresenceEnabled",
        "richPresenceGameEnabled",
        "richPresenceMusicEnabled",
        "richPresenceVideoEnabled",
    ],
)];

pub const KEY_BACKUP_BUDGET_BYTES: usize = 16 * 1024 * 1024;

pub fn portable_sync_value(key: &str, value: &str) -> Option<String> {
    portable_sync(key, value).map(|(value, _)| value)
}

fn portable_sync(key: &str, value: &str) -> Option<(String, bool)> {
    use crate::routes::identity::{is_sealed_sync_value, SEALED_ONLY_SYNC_KEYS};

    if !PORTABLE_SYNC_KEYS.contains(&key) {
        return None;
    }
    let mut parsed: Value = serde_json::from_str(value).ok()?;
    if is_sealed_sync_value(&parsed) {
        return Some((parsed.to_string(), true));
    }
    if SEALED_ONLY_SYNC_KEYS.contains(&key) {
        return None;
    }
    if let (Some((_, fields)), Some(object)) =
        (DEVICE_SYNC_FIELDS.iter().find(|(k, _)| *k == key), parsed.as_object_mut())
    {
        for field in fields.iter() {
            object.remove(*field);
        }
    }
    Some((parsed.to_string(), false))
}

fn portable_sync_store(rows: Vec<(String, String, i64)>) -> Vec<Value> {
    rows.into_iter()
        .filter_map(|(key, value, updated_at)| {
            let value = portable_sync_value(&key, &value)?;
            Some(json!({ "key": key, "value": value, "updated_at": updated_at }))
        })
        .collect()
}

async fn export_key_backup(state: &AppState, user_id: &str) -> ApiResult<(Vec<Value>, i64)> {
    use futures_util::TryStreamExt;

    let mut carried = Vec::new();
    {
        let mut rows = sqlx::query_as::<_, (String, String, String, i64)>(
            "SELECT scope, item, ciphertext, updated_at FROM key_backup WHERE user_id = ? \
             ORDER BY updated_at DESC, scope, item",
        )
        .bind(user_id)
        .fetch(&state.pool);
        let mut spent = 0usize;
        while let Some((scope, item, ciphertext, updated_at)) = rows.try_next().await? {
            let cost = scope.len() + item.len() + ciphertext.len();
            if spent + cost > KEY_BACKUP_BUDGET_BYTES {
                break;
            }
            spent += cost;
            carried.push(json!({
                "scope": scope,
                "item": item,
                "ciphertext": ciphertext,
                "updated_at": updated_at,
            }));
        }
    }
    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_backup WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
    let omitted = held - carried.len() as i64;
    if omitted > 0 {
        tracing::warn!(target: crate::logcat::MIGRATION, user_id, omitted, "history backup items did not fit in the migration bundle");
    }
    Ok((carried, omitted))
}

async fn land_sync_store(
    conn: &mut sqlx::SqliteConnection,
    bundle: &Value,
    target_id: &str,
    now: i64,
    limit: i64,
) -> ApiResult<()> {
    let entries: Vec<(&str, String, bool)> = bundle
        .get("sync_store")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let (Some(key), Some(value)) = (
                entry.get("key").and_then(Value::as_str),
                entry.get("value").and_then(Value::as_str),
            ) else {
                return None;
            };
            let Some((value, sealed)) = portable_sync(key, value) else {
                tracing::warn!(target: crate::logcat::MIGRATION, target_id, key, "a migration bundle carried sync state that does not move; left out");
                return None;
            };
            Some((key, value, sealed))
        })
        .collect();
    let sealed_store = bundle.get("sync_sealed").and_then(Value::as_bool).unwrap_or(false)
        || entries.iter().any(|(_, _, sealed)| *sealed)
        || crate::routes::identity::sync_is_sealed(&mut *conn, target_id).await?;
    if sealed_store {
        sqlx::query("UPDATE accounts SET sync_sealed_at = ? WHERE user_id = ? AND sync_sealed_at IS NULL")
            .bind(now)
            .bind(target_id)
            .execute(&mut *conn)
            .await?;
    }
    for (key, value, sealed) in entries {
        if sealed_store && !sealed {
            tracing::warn!(target: crate::logcat::MIGRATION, target_id, key, "a migration bundle carried plaintext for a sealed sync store; left out");
            continue;
        }
        let used: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM sync_store WHERE user_id = ? AND key != ?",
        )
        .bind(target_id)
        .bind(key)
        .fetch_one(&mut *conn)
        .await?;
        if used + value.len() as i64 > limit {
            tracing::warn!(target: crate::logcat::MIGRATION, target_id, key, "synced state would put the account over this server's quota; left out");
            continue;
        }
        sqlx::query(
            "INSERT INTO sync_store (user_id, key, value, updated_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(target_id)
        .bind(key)
        .bind(&value)
        .bind(now)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

async fn land_key_backup(
    conn: &mut sqlx::SqliteConnection,
    bundle: &Value,
    target_id: &str,
    now: i64,
) -> ApiResult<()> {
    let Some(items) = bundle.get("key_backup").and_then(Value::as_array) else {
        return Ok(());
    };
    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_backup WHERE user_id = ?")
        .bind(target_id)
        .fetch_one(&mut *conn)
        .await?;
    let mut room = crate::routes::dm::MAX_BACKUP_ROWS - held;
    let mut refused = 0u64;
    for entry in items {
        let (scope, item, ciphertext) = (text(entry, "scope"), text(entry, "item"), text(entry, "ciphertext"));
        if scope.is_empty()
            || item.is_empty()
            || ciphertext.is_empty()
            || ciphertext.len() > crate::routes::dm::MAX_BACKUP_ITEM_BYTES
            || room <= 0
        {
            refused += 1;
            continue;
        }
        let landed = sqlx::query(
            "INSERT INTO key_backup (user_id, scope, item, ciphertext, updated_at) VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(user_id, scope, item) DO NOTHING",
        )
        .bind(target_id)
        .bind(scope)
        .bind(item)
        .bind(ciphertext)
        .bind(now)
        .execute(&mut *conn)
        .await?
        .rows_affected();
        room -= landed as i64;
    }
    if refused > 0 {
        tracing::warn!(target: crate::logcat::MIGRATION, target_id, refused, "history backup items in a migration bundle were over this server's limits; left out");
    }
    Ok(())
}

pub async fn import_user(
    state: &AppState,
    bundle: &Value,
    target_id: &str,
    source: &str,
    reservation: &Reservation<'_>,
) -> ApiResult<String> {
    let now = now_ms();
    let (uploads, mut refused) = land_user_media(state, bundle, target_id).await?;
    let mut tx = state.pool.begin().await?;
    reservation.take(&mut tx).await?;

    let mut landed: Vec<String> = Vec::with_capacity(uploads.len());
    for upload in &uploads {
        if insert_landed_upload(&mut tx, upload, target_id).await? {
            landed.push(upload.hash.clone());
        } else {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                hash = upload.hash,
                "upload was already here under this server's own capability; the old origin's links to it will not resolve here"
            );
            refused.push((upload.hash.clone(), "already here under another capability".into()));
        }
    }
    media::queue_omitted(&mut tx, reservation.migration_id, source, target_id, list(bundle, "media_omitted")).await?;
    let here = state.cfg.public_base_url.trim_end_matches('/').to_string();
    media::rewrite_references(&mut tx, source, &state.cfg.server_name, &here, &landed).await?;
    sqlx::query("UPDATE import_log SET media_outcome = ? WHERE id = ?")
        .bind(media::outcome_json(&landed, &refused).to_string())
        .bind(reservation.migration_id)
        .execute(&mut *tx)
        .await?;

    if let Some(profile) = bundle.get("profile").filter(|p| p.is_object()) {
        let s = |k: &str| profile.get(k).and_then(Value::as_str);
        let bio = s("bio").map(crate::routes::identity::clamp_bio);
        let theme = profile.get("theme_colors")
            .map(crate::routes::identity::theme_pair)
            .filter(|t| !t.is_null())
            .map(|t| t.to_string());
        sqlx::query(
            "UPDATE profiles SET display_name = COALESCE(?, display_name), avatar_ref = ?, \
             banner_ref = ?, accent_color = ?, theme_colors = ?, \
             bio = ?, pronouns = ?, \
             public_page_enabled = ?, public_status_enabled = ?, public_activity_enabled = ?, \
             profile_version = profile_version + 1, updated_at = ? WHERE user_id = ?",
        )
        .bind(s("display_name"))
        .bind(s("avatar_ref"))
        .bind(s("banner_ref"))
        .bind(profile.get("accent_color").and_then(Value::as_i64))
        .bind(theme)
        .bind(bio)
        .bind(s("pronouns"))
        .bind(i64::from(profile.get("public_page_enabled").and_then(Value::as_bool).unwrap_or(true)))
        .bind(i64::from(profile.get("public_status_enabled").and_then(Value::as_bool).unwrap_or(false)))
        .bind(i64::from(profile.get("public_activity_enabled").and_then(Value::as_bool).unwrap_or(false)))
        .bind(now)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
    }

    land_sync_store(&mut tx, bundle, target_id, now, state.cfg.limits.max_sync_store_bytes).await?;
    land_key_backup(&mut tx, bundle, target_id, now).await?;

    let old_id = bundle.get("subject").and_then(Value::as_str).unwrap_or_default();
    crate::memberships::land(&mut tx, bundle, target_id, old_id, source, now).await?;

    for friend in bundle.get("friends").and_then(Value::as_array).unwrap_or(&vec![]) {
        let (Some(peer_id), Some(peer_domain), Some(state)) = (
            friend.get("peer_id").and_then(Value::as_str),
            friend.get("peer_domain").and_then(Value::as_str),
            friend.get("state").and_then(Value::as_str),
        ) else {
            continue;
        };
        let created_at = friend.get("created_at").and_then(Value::as_i64).unwrap_or(now);
        let updated_at = friend.get("updated_at").and_then(Value::as_i64).unwrap_or(created_at);
        sqlx::query(
            "INSERT INTO friends (user_id, peer_id, peer_domain, state, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, peer_id) DO UPDATE SET \
             peer_domain = excluded.peer_domain, state = excluded.state, \
             created_at = excluded.created_at, updated_at = excluded.updated_at",
        )
        .bind(target_id)
        .bind(peer_id)
        .bind(peer_domain)
        .bind(state)
        .bind(created_at)
        .bind(updated_at)
        .execute(&mut *tx)
        .await?;
    }

    for request in list(bundle, "message_requests") {
        let conversation_id = text(request, "conversation_id");
        let sender_id = text(request, "sender_id");
        let request_state = text(request, "state");
        if conversation_id.is_empty()
            || sender_id.is_empty()
            || !matches!(request_state, "pending" | "accepted" | "declined" | "blocked")
        {
            continue;
        }
        sqlx::query(
            "INSERT INTO dm_message_requests \
             (conversation_id, user_id, sender_id, state, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(conversation_id, user_id) DO UPDATE SET \
             sender_id = excluded.sender_id, state = excluded.state, \
             created_at = excluded.created_at, updated_at = excluded.updated_at",
        )
        .bind(conversation_id)
        .bind(target_id)
        .bind(sender_id)
        .bind(request_state)
        .bind(int(request, "created_at", now))
        .bind(int(request, "updated_at", now))
        .execute(&mut *tx)
        .await?;
    }

        if let Some(pref) = bundle.get("media_preference").filter(|p| p.is_object()) {
        let tier = pref.get("tier").and_then(Value::as_i64).unwrap_or(1);
        let origin = pref.get("origin").and_then(Value::as_str).filter(|_| tier == 2);
        sqlx::query(
            "INSERT INTO media_preferences (user_id, tier, origin, updated_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT (user_id) DO UPDATE SET tier = excluded.tier, origin = excluded.origin, \
             updated_at = excluded.updated_at",
        )
        .bind(target_id)
        .bind(tier)
        .bind(origin)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    if let Some(vault) = bundle.get("key_vault").filter(|v| v.is_object()) {
        if let Some(ciphertext) = vault.get("ciphertext").and_then(Value::as_str) {
            let mode = landed_vault_mode(text(vault, "mode"));
            sqlx::query(
                "INSERT INTO key_vault (user_id, mode, ciphertext, independent_ciphertext, \
                 escrow_key, version, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?) \
                 ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, \
                 ciphertext = excluded.ciphertext, \
                 independent_ciphertext = excluded.independent_ciphertext, \
                 escrow_key = NULL, \
                 version = MAX(key_vault.version, excluded.version) + 1, \
                 updated_at = excluded.updated_at",
            )
            .bind(target_id)
            .bind(mode)
            .bind(ciphertext)
            .bind(vault.get("independent_ciphertext").and_then(Value::as_str))
            .bind(int(vault, "version", 1))
            .bind(now)
            .execute(&mut *tx)
            .await?;
        }
    }

    for frame in list(bundle, "dm_outbox") {
        let conversation_id = text(frame, "conversation_id");
        let destination = text(frame, "destination");
        let path = text(frame, "path");
        let Some(message) = frame.pointer("/payload/message").filter(|m| m.is_object()) else {
            tracing::warn!(target: crate::logcat::MIGRATION, conversation_id, destination, "skipping an outbox frame with no message in it");
            continue;
        };
        if path != "/_telium/v1/dm/deliver" {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                conversation_id,
                destination,
                path,
                "skipping an outbox frame this server does not know how to re-send"
            );
            continue;
        }
        if destination == state.cfg.server_name {
            tracing::warn!(target: crate::logcat::MIGRATION, conversation_id, "skipping an outbox frame addressed to this server");
            continue;
        }
        let sequencer: Option<String> =
            sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
                .bind(conversation_id)
                .fetch_optional(&mut *tx)
                .await?;
        if sequencer.as_deref() != Some(state.cfg.server_name.as_str()) {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                conversation_id,
                destination,
                sequencer = sequencer.as_deref().unwrap_or("unknown here"),
                "skipping an outbox frame for a conversation this server does not sequence; \
                 the member's home would refuse a delivery signed by anyone else"
            );
            continue;
        }
        let descriptor = crate::routes::dm::conversation_json(state, conversation_id).await?;
        let payload = json!({ "conversation": descriptor, "message": message });
        sqlx::query(
            "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, \
             path, payload, attempts, next_attempt_at, last_error, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?) ON CONFLICT DO NOTHING",
        )
        .bind(text(frame, "id"))
        .bind(conversation_id)
        .bind(text(frame, "message_id"))
        .bind(destination)
        .bind(path)
        .bind(payload.to_string())
        .bind(now)
        .bind(int(frame, "created_at", now))
        .execute(&mut *tx)
        .await?;
    }

    let previous_id = bundle.get("subject").and_then(Value::as_str).unwrap_or_default();
    let original_created_at = bundle
        .get("original_created_at")
        .and_then(Value::as_i64)
        .or_else(|| bundle.get("created_at").and_then(Value::as_i64))
        .unwrap_or(now);
    let mut chain = bundle
        .get("chain")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    chain.push(json!({ "id": previous_id, "server": source, "moved_at": now }));

    sqlx::query(
        "INSERT INTO imported_identities (user_id, previous_id, original_created_at, chain, imported_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(user_id) DO UPDATE SET previous_id = excluded.previous_id, \
             original_created_at = excluded.original_created_at, chain = excluded.chain, \
             imported_at = excluded.imported_at",
    )
    .bind(target_id)
    .bind(previous_id)
    .bind(original_created_at)
    .bind(Value::Array(chain).to_string())
    .bind(now)
    .execute(&mut *tx)
    .await?;

    reservation.settle(&mut tx, target_id).await?;
    tx.commit().await?;
    Ok(target_id.to_string())
}

struct IdMap {
    reissue: bool,
    map: std::collections::HashMap<String, String>,
}

impl IdMap {
    fn new(reissue: bool) -> Self {
        Self { reissue, map: std::collections::HashMap::new() }
    }

    fn take(&mut self, old: &str) -> String {
        let new = if self.reissue { ulid() } else { old.to_string() };
        self.map.insert(old.to_string(), new.clone());
        new
    }

    fn bind(&mut self, old: &str, new: &str) {
        self.map.insert(old.to_string(), new.to_string());
    }

    fn declared(&self, old: &str) -> Option<&String> {
        self.map.get(old)
    }

    fn get(&self, old: &str) -> String {
        self.map.get(old).cloned().unwrap_or_else(|| old.to_string())
    }

    fn rewrite(&self, text: &str) -> String {
        if self.reissue {
            rewrite_ids(text, self)
        } else {
            text.to_string()
        }
    }
}

fn carried(row: &Value, key: &str, ids: &IdMap) -> Value {
    match row.get(key).and_then(Value::as_str) {
        None => Value::Null,
        Some(old) => match ids.declared(old) {
            Some(new) => json!(new),
            None => {
                tracing::warn!(target: crate::logcat::MIGRATION, key, id = old, "bundle points at a row it does not carry; dropping the reference");
                Value::Null
            }
        },
    }
}

fn id_array(row: &Value, key: &str, ids: &IdMap, drop_undeclared: bool) -> Value {
    let raw = row.get(key).and_then(Value::as_str).unwrap_or("[]");
    let parsed: Vec<String> = serde_json::from_str(raw).unwrap_or_default();
    let moved: Vec<String> = parsed
        .iter()
        .filter_map(|old| {
            if drop_undeclared {
                ids.declared(old).cloned()
            } else {
                Some(ids.get(old))
            }
        })
        .collect();
    Value::String(serde_json::to_string(&moved).unwrap_or_else(|_| "[]".into()))
}

fn rewrite_json_ids(value: Option<&Value>, ids: &IdMap, here: &str) -> Value {
    let Some(raw) = value.and_then(Value::as_str) else { return Value::Null };
    let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else { return Value::String(raw.into()) };
    if let Some(id) = parsed.get("id").and_then(Value::as_str) {
        if let Some(new) = ids.declared(id).cloned() {
            parsed["id"] = Value::String(new);
            if parsed.get("origin").is_some() {
                parsed["origin"] = Value::String(here.to_string());
            }
        }
    }
    Value::String(parsed.to_string())
}

fn rewrite_ids(text: &str, ids: &IdMap) -> String {
    static TOKENS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TOKENS.get_or_init(|| {
        regex::Regex::new(
            r"<@&([A-Z0-9]{26})>|<#([A-Z0-9]{26})>|<[a-zA-Z0-9_.-]{1,32}:([A-Z0-9]{26})(?:@[a-zA-Z0-9.-]+)?>|telium://forward/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)",
        )
        .expect("static regex")
    });
    let mut out = String::with_capacity(text.len());
    let mut end = 0;
    for caps in re.captures_iter(text) {
        let whole = caps.get(0).expect("group 0 always matches");
        out.push_str(&text[end..whole.start()]);
        end = whole.end();
        let mut token = whole.as_str().to_string();
        for group in caps.iter().skip(1).flatten().collect::<Vec<_>>().into_iter().rev() {
            let Some(replacement) = ids.declared(group.as_str()) else { continue };
            if replacement == group.as_str() {
                continue;
            }
            let at = group.start() - whole.start();
            token.replace_range(at..at + group.len(), replacement);
        }
        out.push_str(&token);
    }
    out.push_str(&text[end..]);
    out
}

pub async fn import_guild(
    state: &AppState,
    bundle: &Value,
    owner: &str,
    reservation: &Reservation<'_>,
) -> ApiResult<String> {
    note_unknown_keys(bundle);
    let guild = bundle.get("guild").cloned().unwrap_or_else(|| json!({}));
    let old_guild_id = text(bundle, "subject").to_string();
    let now = now_ms();

    let occupied: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE id = ?")
        .bind(&old_guild_id)
        .fetch_optional(&state.pool)
        .await?;
    let mut ids = IdMap::new(occupied.is_some() || old_guild_id.is_empty());
    let new_guild_id = if ids.reissue { ulid() } else { old_guild_id.clone() };
    ids.bind(&old_guild_id, &new_guild_id);

    let alias = match guild
        .get("alias")
        .and_then(Value::as_str)
        .and_then(|a| crate::vanity::normalise(a).ok())
    {
        Some(alias) => {
            let taken: Option<String> = sqlx::query_scalar(
                "SELECT id FROM guilds WHERE alias = ? \
                 UNION ALL SELECT guild_id FROM guild_alias_redirects WHERE alias = ? LIMIT 1",
            )
            .bind(&alias)
            .bind(&alias)
            .fetch_optional(&state.pool)
            .await?;
            taken.is_none().then(|| Value::String(alias))
        }
        None => None,
    };

    let allowed = state
        .cfg
        .limits
        .max_emoji_per_guild
        .saturating_add(state.cfg.limits.max_stickers_per_guild)
        .max(0) as usize;
    if list(bundle, "expressions").len() > allowed {
        return Err(ApiError::BadRequest(format!(
            "bundle carries more expressions than a guild may hold here ({allowed})"
        )));
    }
    let mut assets: Vec<(&Value, usize)> = Vec::new();
    for asset in list(bundle, "expressions") {
        let Some(media) = asset.get("media") else { continue };
        let hash = text(media, "hash");
        let Some(bytes) = unb64(text(asset, "data")) else { continue };
        if bytes.is_empty() || bytes.len() > crate::routes::guild::MAX_EXPRESSION_BYTES {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, "expression asset is not a plausible size; not importing it");
            continue;
        }
        if hash.len() < 2 || blake3::hash(&bytes).to_hex().to_string() != hash {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, "expression asset does not match its hash; not importing it");
            continue;
        }
        if let Err(reason) = crate::expression::sniff(&bytes) {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, %reason, "expression asset is not a format this server accepts as an upload; importing it as it is");
        }
        if let Err(e) = crate::scan::screen_upload(state, owner, hash, &bytes).await {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, error = %e, "expression asset did not pass screening; not importing it");
            continue;
        }
        let size = bytes.len();
        let key = crate::routes::media::media_key(state, hash);
        state.media_store.put(&key, bytes).await?;
        assets.push((media, size));
    }

    let landed: std::collections::HashSet<&str> =
        assets.iter().map(|(media, _)| text(media, "hash")).collect();

    let schema = Schema::load(&state.pool).await?;
    let mut tx = state.pool.begin().await?;
    reservation.take(&mut tx).await?;

    for (media, size) in assets {
        restore(
            &mut tx,
            &schema,
            "media",
            media,
            &[
                ("owner_user_id", json!(owner)),
                ("mime", json!(expression_mime(text(media, "mime")))),
                ("size", json!(size as i64)),
                ("capability", json!(random_token(24))),
                ("purpose", json!("expression")),
                ("created_at", json!(now)),
                ("refcount", json!(1)),
                ("expires_at", json!(null)),
                ("moved_to", json!(null)),
            ],
            true,
        )
        .await?;
    }

    for role in list(bundle, "roles") {
        let old_id = text(role, "id");
        if old_id == old_guild_id {
            ids.bind(old_id, &new_guild_id);
        } else {
            ids.take(old_id);
        }
    }

    restore(
        &mut tx,
        &schema,
        "guilds",
        &guild,
        &[
            ("id", json!(new_guild_id)),
            ("alias", alias.unwrap_or(Value::Null)),
            ("name", json!(guild.get("name").and_then(Value::as_str).unwrap_or("Imported guild"))),
            ("owner_user_id", json!(owner)),
            ("created_at", json!(int(&guild, "created_at", now))),
            ("emoji_export_role_id", carried(&guild, "emoji_export_role_id", &ids)),
        ],
        false,
    )
    .await?;

    for role in list(bundle, "roles") {
        restore(
            &mut tx,
            &schema,
            "roles",
            role,
            &[("id", json!(ids.get(text(role, "id")))), ("guild_id", json!(new_guild_id))],
            false,
        )
        .await?;
    }

    for channel in list(bundle, "channels") {
        ids.take(text(channel, "id"));
    }
    for channel in list(bundle, "channels") {
        let new_id = ids.get(text(channel, "id"));
        restore(
            &mut tx,
            &schema,
            "channels",
            channel,
            &[
                ("id", json!(new_id)),
                ("guild_id", json!(new_guild_id)),
                ("parent_id", carried(channel, "parent_id", &ids)),
            ],
            false,
        )
        .await?;
    }

    for emoji in list(bundle, "emojis") {
        let new_id = ids.take(text(emoji, "id"));
        note_missing_bytes(&landed, emoji, "emoji");
        restore(
            &mut tx,
            &schema,
            "emojis",
            emoji,
            &[("id", json!(new_id)), ("guild_id", json!(new_guild_id))],
            false,
        )
        .await?;
    }
    for sticker in list(bundle, "stickers") {
        let new_id = ids.take(text(sticker, "id"));
        note_missing_bytes(&landed, sticker, "sticker");
        restore(
            &mut tx,
            &schema,
            "stickers",
            sticker,
            &[("id", json!(new_id)), ("guild_id", json!(new_guild_id))],
            false,
        )
        .await?;
    }

    for member in list(bundle, "members") {
        if text(member, "user_id").is_empty() {
            continue;
        }
        restore(
            &mut tx,
            &schema,
            "members",
            member,
            &[
                ("guild_id", json!(new_guild_id)),
                ("bot_role_id", carried(member, "bot_role_id", &ids)),
            ],
            false,
        )
        .await?;
    }
    sqlx::query(
        "INSERT INTO members (guild_id, user_id, joined_at, display_name, profile_version) \
         VALUES (?, ?, ?, '', 0) ON CONFLICT DO NOTHING",
    )
    .bind(&new_guild_id)
    .bind(owner)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    for member_role in list(bundle, "member_roles") {
        let Some(role_id) = ids.declared(text(member_role, "role_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "member_roles",
            member_role,
            &[("guild_id", json!(new_guild_id)), ("role_id", json!(role_id))],
            true,
        )
        .await?;
    }

    for overwrite in list(bundle, "overwrites") {
        let Some(channel) = ids.declared(text(overwrite, "channel_id")).cloned() else { continue };
        let target = ids.get(text(overwrite, "target_id"));
        restore(
            &mut tx,
            &schema,
            "channel_overwrites",
            overwrite,
            &[("channel_id", json!(channel)), ("target_id", json!(target))],
            false,
        )
        .await?;
    }

    let mut messages: Vec<&Value> = list(bundle, "messages").iter().collect();
    messages.extend(list(bundle, "archived"));
    messages.sort_by_key(|m| text(m, "id"));
    messages.dedup_by_key(|m| text(m, "id"));

    for message in &messages {
        ids.take(text(message, "id"));
    }
    for message in &messages {
        let Some(channel) = ids.declared(text(message, "channel_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "messages",
            message,
            &[
                ("id", json!(ids.get(text(message, "id")))),
                ("channel_id", json!(channel)),
                ("guild_id", json!(new_guild_id)),
                ("content", json!(ids.rewrite(text(message, "content")))),
                ("sticker", rewrite_json_ids(message.get("sticker"), &ids, &state.cfg.server_name)),
                ("reply_to", carried(message, "reply_to", &ids)),
                ("thread_id", carried(message, "thread_id", &ids)),
            ],
            false,
        )
        .await?;
    }

    sqlx::query(
        "INSERT INTO messages_fts (content, message_id, channel_id, guild_id, author_id) \
         SELECT content, id, channel_id, guild_id, author_id FROM messages \
         WHERE guild_id = ? AND deleted = 0",
    )
    .bind(&new_guild_id)
    .execute(&mut *tx)
    .await?;

    for thread in list(bundle, "threads") {
        let Some(id) = ids.declared(text(thread, "id")).cloned() else { continue };
        let Some(parent_id) = ids.declared(text(thread, "parent_id")).cloned() else {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                parent = text(thread, "parent_id"),
                "bundle hangs a thread off a channel it does not carry; not importing it"
            );
            continue;
        };
        restore(
            &mut tx,
            &schema,
            "threads",
            thread,
            &[
                ("id", json!(id)),
                ("guild_id", json!(new_guild_id)),
                ("parent_id", json!(parent_id)),
                ("starter_id", carried(thread, "starter_id", &ids)),
            ],
            false,
        )
        .await?;
    }

    for reaction in list(bundle, "reactions") {
        let Some(message_id) = ids.declared(text(reaction, "message_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "reactions",
            reaction,
            &[
                ("message_id", json!(message_id)),
                ("emoji", json!(ids.rewrite(text(reaction, "emoji")))),
            ],
            true,
        )
        .await?;
    }

    for mention in list(bundle, "mentions") {
        let Some(message_id) = ids.declared(text(mention, "message_id")).cloned() else { continue };
        let Some(channel_id) = ids.declared(text(mention, "channel_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "message_mentions",
            mention,
            &[
                ("message_id", json!(message_id)),
                ("channel_id", json!(channel_id)),
                ("user_id", json!(ids.get(text(mention, "user_id")))),
            ],
            true,
        )
        .await?;
    }

    for pin in list(bundle, "pins") {
        let Some(channel_id) = ids.declared(text(pin, "channel_id")).cloned() else { continue };
        let Some(message_id) = ids.declared(text(pin, "message_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "pins",
            pin,
            &[("channel_id", json!(channel_id)), ("message_id", json!(message_id))],
            true,
        )
        .await?;
    }

    for read in list(bundle, "read_state") {
        let Some(channel_id) = ids.declared(text(read, "channel_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "read_state",
            read,
            &[
                ("channel_id", json!(channel_id)),
                ("last_read_id", carried(read, "last_read_id", &ids)),
            ],
            true,
        )
        .await?;
    }

    for follow in list(bundle, "follows") {
        let Some(source_id) = ids.declared(text(follow, "source_id")).cloned() else { continue };
        let Some(target_id) = ids.declared(text(follow, "target_id")).cloned() else {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                target = text(follow, "target_id"),
                "bundle's follow points at a channel it does not carry; not importing it"
            );
            continue;
        };
        restore(
            &mut tx,
            &schema,
            "channel_follows",
            follow,
            &[
                ("source_id", json!(source_id)),
                ("target_id", json!(target_id)),
                ("created_by", json!(owner)),
            ],
            true,
        )
        .await?;
    }

    for invite in list(bundle, "invites") {
        let code = text(invite, "code");
        let taken: Option<String> = sqlx::query_scalar("SELECT code FROM invites WHERE code = ?")
            .bind(code)
            .fetch_optional(&mut *tx)
            .await?;
        let vanity_taken: Option<String> = sqlx::query_scalar(
            "SELECT id FROM guilds WHERE alias = ? AND id <> ? \
             UNION ALL \
             SELECT guild_id FROM guild_alias_redirects \
             WHERE alias = ? AND to_guild_id <> ? LIMIT 1",
        )
        .bind(code)
        .bind(&new_guild_id)
        .bind(code)
        .bind(&new_guild_id)
        .fetch_optional(&mut *tx)
        .await?;
        let code = if taken.is_some() || vanity_taken.is_some() {
            invite_code()
        } else {
            code.to_string()
        };
        restore(
            &mut tx,
            &schema,
            "invites",
            invite,
            &[
                ("code", json!(code)),
                ("guild_id", json!(new_guild_id)),
                ("channel_id", carried(invite, "channel_id", &ids)),
            ],
            false,
        )
        .await?;
    }

    for rule in list(bundle, "automod_rules") {
        let new_id = ids.take(text(rule, "id"));
        let exempt_roles = id_array(rule, "exempt_roles", &ids, false);
        let exempt_channels = id_array(rule, "exempt_channels", &ids, true);
        let scope_channels = id_array(rule, "scope_channels", &ids, true);
        restore(
            &mut tx,
            &schema,
            "automod_rules",
            rule,
            &[
                ("id", json!(new_id)),
                ("guild_id", json!(new_guild_id)),
                ("exempt_roles", exempt_roles),
                ("exempt_channels", exempt_channels),
                ("scope_channels", scope_channels),
            ],
            false,
        )
        .await?;
    }

    for held in list(bundle, "held_messages") {
        let Some(channel_id) = ids.declared(text(held, "channel_id")).cloned() else { continue };
        restore(
            &mut tx,
            &schema,
            "held_messages",
            held,
            &[
                ("id", json!(ids.take(text(held, "id")))),
                ("guild_id", json!(new_guild_id)),
                ("channel_id", json!(channel_id)),
            ],
            false,
        )
        .await?;
    }

    for entry in list(bundle, "audit_log") {
        restore(
            &mut tx,
            &schema,
            "audit_log",
            entry,
            &[
                ("id", json!(ids.take(text(entry, "id")))),
                ("guild_id", json!(new_guild_id)),
                ("target", entry.get("target").and_then(Value::as_str).map_or(Value::Null, |t| json!(ids.get(t)))),
            ],
            false,
        )
        .await?;
    }

    for (key, name) in [
        ("origin_rules", "guild_origin_rules"),
        ("domain_rules", "guild_domain_rules"),
        ("screening_answers", "screening_answers"),
        ("voice_regions", "guild_voice_regions"),
    ] {
        for row in list(bundle, key) {
            restore(&mut tx, &schema, name, row, &[("guild_id", json!(new_guild_id))], false).await?;
        }
    }

    reservation.settle(&mut tx, &new_guild_id).await?;
    tx.commit().await?;
    Ok(new_guild_id)
}

pub async fn write_tombstone(
    state: &AppState,
    subject_type: &str,
    old_id: &str,
    new_id: &str,
    device_sig: &str,
    destination_ack: &Value,
) -> ApiResult<Value> {
    let record = json!({
        "kind": "moved",
        "subject_type": subject_type,
        "old_id": old_id,
        "new_id": new_id,
        "timestamp": now_ms(),
        "old_server": state.cfg.server_name,
        "new_server": destination_ack.get("server_name").cloned().unwrap_or(Value::Null),
        "sig_user_device": device_sig,
        "sig_new_server": destination_ack.get("signature").cloned().unwrap_or(Value::Null),
        "new_server_key_id": destination_ack.get("key_id").cloned().unwrap_or(Value::Null),
    });
    let record = crypto::sign_json(&state.key, record);

    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES (?, ?, 'moved', ?, ?, ?) \
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET kind = 'moved', \
             new_id = excluded.new_id, record = excluded.record, created_at = excluded.created_at",
    )
    .bind(subject_type)
    .bind(old_id)
    .bind(new_id)
    .bind(record.to_string())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(record)
}

pub fn carried_media(bundle: &Value) -> Vec<String> {
    list(bundle, "media")
        .iter()
        .filter_map(|entry| entry.get("media"))
        .map(|media| text(media, "hash"))
        .filter(|hash| crate::routes::media::valid_hash(hash))
        .map(str::to_string)
        .collect()
}

pub async fn mark_media_moved(
    state: &AppState,
    owner: &str,
    hashes: &[String],
    new_origin: &str,
) -> ApiResult<u64> {
    let mut marked = 0u64;
    for hash in hashes {
        marked += sqlx::query("UPDATE media SET moved_to = ? WHERE hash = ? AND owner_user_id = ?")
            .bind(new_origin)
            .bind(hash)
            .bind(owner)
            .execute(&state.pool)
            .await?
            .rows_affected();
    }
    Ok(marked)
}

pub async fn apply_user_move(state: &AppState, old_id: &str, new_id: &str) -> ApiResult<u64> {
    let mut moved = 0u64;
    let mut tx = state.pool.begin().await?;
    let guilds: Vec<String> =
        sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ?")
            .bind(old_id)
            .fetch_all(&mut *tx)
            .await?;
    for guild_id in guilds {
        let exists: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = ? AND user_id = ?")
                .bind(&guild_id)
                .bind(new_id)
                .fetch_optional(&mut *tx)
                .await?;
        if exists.is_some() {
            sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
                .bind(&guild_id)
                .bind(old_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?")
                .bind(&guild_id)
                .bind(old_id)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        sqlx::query("UPDATE members SET user_id = ? WHERE guild_id = ? AND user_id = ?")
            .bind(new_id)
            .bind(&guild_id)
            .bind(old_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE OR IGNORE member_roles SET user_id = ? WHERE guild_id = ? AND user_id = ?")
            .bind(new_id)
            .bind(&guild_id)
            .bind(old_id)
            .execute(&mut *tx)
            .await?;
        moved += 1;
    }
    sqlx::query("DELETE FROM guild_sessions WHERE user_id = ?")
        .bind(old_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(moved)
}
