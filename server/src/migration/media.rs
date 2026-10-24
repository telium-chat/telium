
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::{b64, now_ms};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashSet};

use super::{int, list, text, LandedUpload, Refusal};

pub const PULL_PAGE: usize = 16;
pub const PULL_CONCURRENCY: usize = 4;
pub const PULL_MAX_ATTEMPTS: i64 = 10;
pub const PULL_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
const CONFIRM_PAGE: usize = 200;
const NOTICE_PAGE: usize = 1_000;
const NOTICE_CEILING: usize = super::MAX_USER_MEDIA_OBJECTS;
const REASON_CHARS: usize = 200;

pub fn outcome_json(landed: &[String], refused: &[Refusal]) -> Value {
    json!({
        "landed": landed,
        "refused": refused
            .iter()
            .map(|(hash, reason)| json!({ "hash": hash, "reason": reason }))
            .collect::<Vec<_>>(),
    })
}

pub fn outcome_from(ack: &Value) -> Option<(Vec<String>, Vec<Refusal>)> {
    let media = ack.get("media").filter(|m| m.is_object())?;
    let landed = list(media, "landed")
        .iter()
        .filter_map(Value::as_str)
        .filter(|h| crate::routes::media::valid_hash(h))
        .map(str::to_string)
        .collect();
    let refused = list(media, "refused")
        .iter()
        .filter(|r| crate::routes::media::valid_hash(text(r, "hash")))
        .map(|r| (text(r, "hash").to_string(), text(r, "reason").chars().take(REASON_CHARS).collect()))
        .collect();
    Some((landed, refused))
}

fn plausible_origin(origin: &str) -> bool {
    !origin.is_empty()
        && origin.len() <= 253
        && origin.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
}

async fn base_for(state: &AppState, origin: &str) -> String {
    match federation::known_base(state, origin).await {
        Ok(base) => base,
        Err(_) => format!("https://{origin}"),
    }
}

fn rewrite_descriptor(att: &mut Value, old_origin: &str, new_origin: &str, new_base: &str, hashes: &HashSet<&str>) -> bool {
    if att.get("external").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    if text(att, "origin") != old_origin {
        return false;
    }
    let hash = text(att, "hash").to_string();
    if !hashes.contains(hash.as_str()) {
        return false;
    }
    let Some(obj) = att.as_object_mut() else { return false };
    obj.insert("origin".into(), json!(new_origin));
    obj.insert("reference".into(), json!(format!("media://{new_origin}/{hash}")));
    let url = match obj.get("url").and_then(Value::as_str) {
        Some(url) => match url.find("/_telium/v1/media/") {
            Some(at) => Some(format!("{new_base}{}", &url[at..])),
            None => None,
        },
        None => None,
    };
    let url = url.unwrap_or_else(|| match obj.get("capability").and_then(Value::as_str) {
        Some(cap) if !cap.is_empty() => format!("{new_base}/_telium/v1/media/{hash}?cap={cap}"),
        _ => format!("{new_base}/_telium/v1/media/{hash}"),
    });
    obj.insert("url".into(), json!(url));
    true
}

pub async fn rewrite_references(
    conn: &mut sqlx::SqliteConnection,
    old_origin: &str,
    new_origin: &str,
    new_base: &str,
    hashes: &[String],
) -> ApiResult<u64> {
    if hashes.is_empty() || old_origin == new_origin {
        return Ok(0);
    }
    let wanted: HashSet<&str> = hashes.iter().map(String::as_str).collect();
    let needle = old_origin.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{needle}%");
    let mut changed = 0u64;
    let mut after = String::new();
    loop {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, attachments FROM messages WHERE id > ? AND attachments LIKE ? ESCAPE '\\' \
             ORDER BY id LIMIT 500",
        )
        .bind(&after)
        .bind(&pattern)
        .fetch_all(&mut *conn)
        .await?;
        let Some((last, _)) = rows.last() else { break };
        after = last.clone();
        for (id, attachments) in &rows {
            let Ok(mut parsed) = serde_json::from_str::<Value>(attachments) else { continue };
            let Some(entries) = parsed.as_array_mut() else { continue };
            let mut touched = false;
            for att in entries.iter_mut() {
                touched |= rewrite_descriptor(att, old_origin, new_origin, new_base, &wanted);
            }
            if !touched {
                continue;
            }
            sqlx::query("UPDATE messages SET attachments = ? WHERE id = ?")
                .bind(parsed.to_string())
                .bind(id)
                .execute(&mut *conn)
                .await?;
            changed += 1;
        }
    }
    Ok(changed)
}

pub async fn apply_move_notice(state: &AppState, from: &str, new_origin: &str, hashes: &[String]) -> ApiResult<u64> {
    let new_origin = federation::normalise_origin(new_origin);
    let from = federation::normalise_origin(from);
    if !plausible_origin(&new_origin) {
        return Err(ApiError::BadRequest("new_origin is not a server name".into()));
    }
    if hashes.len() > NOTICE_CEILING {
        return Err(ApiError::BadRequest("that is more objects than an account can move".into()));
    }
    let hashes: Vec<String> = hashes
        .iter()
        .filter(|h| crate::routes::media::valid_hash(h))
        .cloned()
        .collect();
    if hashes.is_empty() || from == new_origin {
        return Ok(0);
    }
    let base = base_for(state, &new_origin).await;
    let mut conn = state.pool.acquire().await?;
    let changed = rewrite_references(&mut conn, &from, &new_origin, &base, &hashes).await?;
    drop(conn);
    for hash in &hashes {
        federation::media::purge_local(state, &from, hash).await?;
    }
    if changed > 0 {
        tracing::info!(target: crate::logcat::MIGRATION, from, new_origin, messages = changed, "re-pointed attachments at an origin their uploads moved to");
    }
    Ok(changed)
}

pub fn broadcast_moved(state: &AppState, owner: &str, new_origin: &str, hashes: &[String]) {
    if hashes.is_empty() {
        return;
    }
    let state = state.clone();
    let owner = owner.to_string();
    let new_origin = new_origin.to_string();
    let hashes = hashes.to_vec();
    tokio::spawn(async move {
        let peers: Vec<String> = sqlx::query_scalar("SELECT origin FROM remote_servers")
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();
        for peer in peers {
            if peer == new_origin || peer == state.cfg.server_name {
                continue;
            }
            for page in hashes.chunks(NOTICE_PAGE) {
                let body = json!({ "owner": owner, "new_origin": new_origin, "hashes": page });
                if let Err(e) =
                    federation::post_signed(&state, &peer, "/_telium/v1/media/moved", &body).await
                {
                    tracing::debug!(target: crate::logcat::MIGRATION, peer, error = %e, "a peer did not take the media-moved notice; it will ask when it learns of the move");
                }
            }
        }
    });
}

pub async fn moved_list(state: &AppState, owner: &str, asked: &[String]) -> ApiResult<Value> {
    let asked: Vec<&String> = asked
        .iter()
        .filter(|h| crate::routes::media::valid_hash(h))
        .take(NOTICE_CEILING)
        .collect();
    let mut by_origin: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for chunk in asked.chunks(500) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let sql = format!(
            "SELECT moved_to, hash FROM media WHERE owner_user_id = ? AND moved_to IS NOT NULL \
             AND hash IN ({marks}) ORDER BY moved_to, hash"
        );
        let mut query = sqlx::query_as::<_, (String, String)>(&sql).bind(owner);
        for hash in chunk {
            query = query.bind(hash.as_str());
        }
        for (origin, hash) in query.fetch_all(&state.pool).await? {
            by_origin.entry(origin).or_default().push(hash);
        }
    }
    Ok(json!({
        "moves": by_origin
            .into_iter()
            .map(|(new_origin, hashes)| json!({ "new_origin": new_origin, "hashes": hashes }))
            .collect::<Vec<_>>(),
    }))
}

async fn referenced_at(state: &AppState, origin: &str) -> ApiResult<Vec<String>> {
    let needle = origin.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{needle}%");
    let mut found: BTreeSet<String> = BTreeSet::new();
    let mut after = String::new();
    loop {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, attachments FROM messages WHERE id > ? AND attachments LIKE ? ESCAPE '\\' \
             ORDER BY id LIMIT 500",
        )
        .bind(&after)
        .bind(&pattern)
        .fetch_all(&state.pool)
        .await?;
        let Some((last, _)) = rows.last() else { break };
        after = last.clone();
        for (_, attachments) in &rows {
            let Ok(parsed) = serde_json::from_str::<Value>(attachments) else { continue };
            for att in parsed.as_array().into_iter().flatten() {
                if att.get("external").and_then(Value::as_bool) == Some(true) || text(att, "origin") != origin {
                    continue;
                }
                let hash = text(att, "hash");
                if crate::routes::media::valid_hash(hash) {
                    found.insert(hash.to_string());
                }
            }
        }
        if found.len() >= NOTICE_CEILING {
            break;
        }
    }
    Ok(found.into_iter().take(NOTICE_CEILING).collect())
}

pub async fn pull_moved_from_home(state: &AppState, home: &str, old_id: &str) -> ApiResult<u64> {
    let home = federation::normalise_origin(home);
    let hashes = referenced_at(state, &home).await?;
    if hashes.is_empty() {
        return Ok(0);
    }
    let doc = federation::post_signed(
        state,
        &home,
        "/_telium/v1/media/moved/list",
        &json!({ "owner": old_id, "hashes": hashes }),
    )
    .await?;
    let mut changed = 0;
    for entry in list(&doc, "moves") {
        let hashes: Vec<String> = list(entry, "hashes")
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
        changed += apply_move_notice(state, &home, text(entry, "new_origin"), &hashes).await?;
    }
    Ok(changed)
}

pub async fn mark_moved_and_tell(state: &AppState, owner: &str, hashes: &[String], new_origin: &str) -> ApiResult<u64> {
    if hashes.is_empty() {
        return Ok(0);
    }
    let marked = super::mark_media_moved(state, owner, hashes, new_origin).await?;
    let base = base_for(state, new_origin).await;
    let mut conn = state.pool.acquire().await?;
    rewrite_references(&mut conn, &state.cfg.server_name, new_origin, &base, hashes).await?;
    drop(conn);
    broadcast_moved(state, owner, new_origin, hashes);
    Ok(marked)
}

pub async fn record_export(state: &AppState, migration_id: &str, bundle: &Value) -> ApiResult<()> {
    let now = now_ms();
    let carried = super::carried_media(bundle);
    let omitted: Vec<&str> = list(bundle, "media_omitted")
        .iter()
        .map(|o| text(o, "hash"))
        .filter(|h| crate::routes::media::valid_hash(h))
        .collect();
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM migration_media WHERE migration_id = ?")
        .bind(migration_id)
        .execute(&mut *tx)
        .await?;
    for (hash, state_name) in carried
        .iter()
        .map(|h| (h.as_str(), "carried"))
        .chain(omitted.iter().map(|h| (*h, "omitted")))
    {
        sqlx::query(
            "INSERT INTO migration_media (migration_id, hash, state, detail, updated_at) \
             VALUES (?, ?, ?, '', ?) ON CONFLICT DO NOTHING",
        )
        .bind(migration_id)
        .bind(hash)
        .bind(state_name)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Settled {
    pub landed: Vec<String>,
    pub refused: Vec<Refusal>,
}

pub async fn settle_ack(
    state: &AppState,
    migration_id: &str,
    owner: &str,
    carried: &[String],
    ack: &Value,
    new_origin: &str,
) -> ApiResult<Settled> {
    let carried: Vec<String> = if carried.is_empty() {
        sqlx::query_scalar(
            "SELECT hash FROM migration_media WHERE migration_id = ? AND state = 'carried' ORDER BY hash",
        )
        .bind(migration_id)
        .fetch_all(&state.pool)
        .await?
    } else {
        carried.to_vec()
    };
    if carried.is_empty() {
        return Ok(Settled::default());
    }
    let carried_set: HashSet<&str> = carried.iter().map(String::as_str).collect();

    let (landed, refused) = match outcome_from(ack) {
        None => (carried.clone(), Vec::new()),
        Some((said_landed, said_refused)) => {
            let landed: Vec<String> =
                said_landed.into_iter().filter(|h| carried_set.contains(h.as_str())).collect();
            let landed_set: HashSet<&str> = landed.iter().map(String::as_str).collect();
            let mut refused: Vec<Refusal> = said_refused
                .into_iter()
                .filter(|(h, _)| carried_set.contains(h.as_str()) && !landed_set.contains(h.as_str()))
                .collect();
            let mentioned: HashSet<String> = refused.iter().map(|(h, _)| h.clone()).collect();
            for hash in &carried {
                if !landed_set.contains(hash.as_str()) && !mentioned.contains(hash) {
                    refused.push((hash.clone(), "the destination did not say it landed".into()));
                }
            }
            (landed, refused)
        }
    };

    let now = now_ms();
    for hash in &landed {
        sqlx::query(
            "UPDATE migration_media SET state = 'landed', detail = '', updated_at = ? \
             WHERE migration_id = ? AND hash = ?",
        )
        .bind(now)
        .bind(migration_id)
        .bind(hash)
        .execute(&state.pool)
        .await?;
    }
    for (hash, reason) in &refused {
        tracing::warn!(
            target: crate::logcat::MIGRATION,
            migration = migration_id,
            hash,
            reason,
            "the destination refused an upload the bundle carried; it stays served from here"
        );
        sqlx::query(
            "UPDATE migration_media SET state = 'refused', detail = ?, updated_at = ? \
             WHERE migration_id = ? AND hash = ?",
        )
        .bind(reason)
        .bind(now)
        .bind(migration_id)
        .bind(hash)
        .execute(&state.pool)
        .await?;
    }
    mark_moved_and_tell(state, owner, &landed, new_origin).await?;
    Ok(Settled { landed, refused })
}

async fn acknowledged_destination(state: &AppState, requester: &str, migration_id: &str) -> ApiResult<String> {
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT subject_type, subject_id, destination, state FROM migrations WHERE id = ?",
    )
    .bind(migration_id)
    .fetch_optional(&state.pool)
    .await?;
    let requester = federation::normalise_origin(requester);
    match row {
        Some((subject_type, subject_id, destination, st))
            if subject_type == "user"
                && st == "completed"
                && federation::normalise_origin(&destination) == requester =>
        {
            Ok(subject_id)
        }
        _ => Err(ApiError::NotFound("no such migration".into())),
    }
}

pub async fn serve_omitted(state: &AppState, requester: &str, migration_id: &str, hash: &str) -> ApiResult<Value> {
    let subject = acknowledged_destination(state, requester, migration_id).await?;
    if !crate::routes::media::valid_hash(hash) {
        return Err(ApiError::NotFound("no such object".into()));
    }
    let recorded: Option<String> =
        sqlx::query_scalar("SELECT state FROM migration_media WHERE migration_id = ? AND hash = ?")
            .bind(migration_id)
            .bind(hash)
            .fetch_optional(&state.pool)
            .await?;
    if recorded.as_deref() != Some("omitted") {
        return Err(ApiError::NotFound("no such object".into()));
    }
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, i64, Option<i64>, Option<i64>, Option<String>, String, String, i64, Option<i64>)> =
        sqlx::query_as(
            "SELECT filename, mime, size, width, height, thumbhash, capability, purpose, created_at, \
             expires_at FROM media WHERE hash = ? AND owner_user_id = ? AND moved_to IS NULL \
             AND (expires_at IS NULL OR expires_at > ?)",
        )
        .bind(hash)
        .bind(&subject)
        .bind(now_ms())
        .fetch_optional(&state.pool)
        .await?;
    let Some((filename, mime, _size, width, height, thumbhash, capability, purpose, created_at, expires_at)) = row
    else {
        return Err(ApiError::NotFound("no such object".into()));
    };
    let Ok(bytes) = state.media_store.get(&crate::routes::media::media_key(state, hash)).await else {
        tracing::warn!(target: crate::logcat::MIGRATION, hash, "upload has no bytes on disk; cannot serve it to the destination");
        return Err(ApiError::NotFound("no such object".into()));
    };
    Ok(json!({
        "media": {
            "hash": hash,
            "filename": filename,
            "mime": mime,
            "size": bytes.len(),
            "width": width,
            "height": height,
            "thumbhash": thumbhash,
            "capability": capability,
            "purpose": purpose,
            "created_at": created_at,
            "expires_at": expires_at,
        },
        "data": b64(&bytes),
    }))
}

pub async fn confirm_pulled(
    state: &AppState,
    requester: &str,
    migration_id: &str,
    landed: &[String],
    refused: &[Refusal],
) -> ApiResult<Settled> {
    let subject = acknowledged_destination(state, requester, migration_id).await?;
    let requester = federation::normalise_origin(requester);
    let now = now_ms();
    let mut settled = Settled::default();
    for hash in landed.iter().filter(|h| crate::routes::media::valid_hash(h)) {
        let took = sqlx::query(
            "UPDATE migration_media SET state = 'landed', detail = '', updated_at = ? \
             WHERE migration_id = ? AND hash = ? AND state = 'omitted'",
        )
        .bind(now)
        .bind(migration_id)
        .bind(hash)
        .execute(&state.pool)
        .await?
        .rows_affected();
        if took > 0 {
            settled.landed.push(hash.clone());
        }
    }
    for (hash, reason) in refused.iter().filter(|(h, _)| crate::routes::media::valid_hash(h)) {
        let reason: String = reason.chars().take(REASON_CHARS).collect();
        let took = sqlx::query(
            "UPDATE migration_media SET state = 'refused', detail = ?, updated_at = ? \
             WHERE migration_id = ? AND hash = ? AND state = 'omitted'",
        )
        .bind(&reason)
        .bind(now)
        .bind(migration_id)
        .bind(hash)
        .execute(&state.pool)
        .await?
        .rows_affected();
        if took > 0 {
            tracing::warn!(
                target: crate::logcat::MIGRATION,
                migration = migration_id,
                hash,
                reason,
                "the destination refused an upload it fetched; it stays served from here"
            );
            settled.refused.push((hash.clone(), reason));
        }
    }
    mark_moved_and_tell(state, &subject, &settled.landed, &requester).await?;
    Ok(settled)
}

pub async fn queue_omitted(
    tx: &mut sqlx::SqliteConnection,
    migration_id: &str,
    source: &str,
    owner: &str,
    omitted: &[Value],
) -> ApiResult<u64> {
    let now = now_ms();
    let mut queued = 0u64;
    for entry in omitted.iter().take(super::MAX_USER_MEDIA_OBJECTS) {
        let hash = text(entry, "hash");
        if !crate::routes::media::valid_hash(hash) {
            continue;
        }
        queued += sqlx::query(
            "INSERT INTO media_pulls (migration_id, hash, source, owner_user_id, size, \
             purpose, state, detail, attempts, next_attempt_at, confirmed_at, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, 'pending', '', 0, ?, NULL, ?) ON CONFLICT DO NOTHING",
        )
        .bind(migration_id)
        .bind(hash)
        .bind(source)
        .bind(owner)
        .bind(int(entry, "size", 0))
        .bind(text(entry, "purpose"))
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    }
    Ok(queued)
}

#[derive(Debug, Clone)]
struct Due {
    migration_id: String,
    hash: String,
    source: String,
    owner: String,
    size: i64,
    purpose: String,
    attempts: i64,
}

fn backoff_ms(attempts: i64) -> i64 {
    let minute = 60_000i64;
    let six_hours = 6 * 3_600_000i64;
    minute.saturating_mul(1i64 << attempts.clamp(0, 20)).min(six_hours)
}

pub async fn pull_omitted(state: &AppState) -> ApiResult<u64> {
    use futures_util::StreamExt;

    let now = now_ms();
    let due: Vec<Due> = sqlx::query_as::<_, (String, String, String, String, i64, String, i64)>(
        "SELECT migration_id, hash, source, owner_user_id, size, purpose, attempts FROM media_pulls \
         WHERE state = 'pending' AND next_attempt_at <= ? \
         ORDER BY next_attempt_at, migration_id, hash LIMIT ?",
    )
    .bind(now)
    .bind(PULL_PAGE as i64)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(migration_id, hash, source, owner, size, purpose, attempts)| Due {
        migration_id,
        hash,
        source,
        owner,
        size,
        purpose,
        attempts,
    })
    .collect();

    let mut landed_now = 0u64;
    let mut touched: HashSet<String> = HashSet::new();
    if !due.is_empty() {
        let policy = &state.cfg.media_policy;
        let mut to_fetch = Vec::new();
        for row in due {
            touched.insert(row.migration_id.clone());
            let ceiling = match row.purpose.as_str() {
                "profile" => policy.max_file_bytes.min(policy.max_profile_asset_bytes),
                "expression" => policy.max_file_bytes.min(crate::routes::guild::MAX_EXPRESSION_BYTES),
                _ => policy.max_file_bytes,
            };
            if row.size > ceiling as i64 {
                finish(state, &row, "refused", "size").await?;
                continue;
            }
            to_fetch.push(row);
        }

        let fetched: Vec<(Due, ApiResult<Value>)> = futures_util::stream::iter(to_fetch)
            .map(|row| async move {
                let answer = federation::post_signed_within(
                    state,
                    &row.source,
                    "/_telium/v1/migrate/media/fetch",
                    &json!({ "migration_id": row.migration_id, "hash": row.hash }),
                    PULL_FETCH_TIMEOUT,
                )
                .await;
                (row, answer)
            })
            .buffer_unordered(PULL_CONCURRENCY)
            .collect()
            .await;

        // Landed one at a time: concurrent policy checks would both see room.
        for (row, answer) in fetched {
            let entry = match answer {
                Ok(entry) => entry,
                Err(e) => {
                    defer(state, &row, &format!("{e}")).await?;
                    continue;
                }
            };
            // Checked against the descriptor's hash, or another object would land under this row.
            if text(entry.get("media").unwrap_or(&Value::Null), "hash") != row.hash {
                finish(state, &row, "refused", "the source served a different object").await?;
                continue;
            }
            match super::land_one_upload(state, &entry, &row.owner, 0).await? {
                Ok(upload) => {
                    land(state, &row, &upload).await?;
                    landed_now += 1;
                }
                Err((_, reason)) => finish(state, &row, "refused", &reason).await?,
            }
        }
    }

    confirm_pages(state).await?;

    for migration_id in touched {
        let unfinished: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_pulls WHERE migration_id = ? \
             AND (state = 'pending' OR confirmed_at IS NULL)",
        )
        .bind(&migration_id)
        .fetch_one(&state.pool)
        .await?;
        if unfinished == 0 {
            let (landed, refused, failed): (i64, i64, i64) = sqlx::query_as(
                "SELECT SUM(state = 'landed'), SUM(state = 'refused'), SUM(state = 'failed') \
                 FROM media_pulls WHERE migration_id = ?",
            )
            .bind(&migration_id)
            .fetch_one(&state.pool)
            .await?;
            tracing::info!(
                target: crate::logcat::MIGRATION,
                migration = migration_id,
                landed,
                refused,
                failed,
                "every upload the bundle left out has been fetched or given up on, and the source told"
            );
        }
    }
    Ok(landed_now)
}

async fn land(state: &AppState, row: &Due, upload: &LandedUpload) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    let written = super::insert_landed_upload(&mut tx, upload, &row.owner).await?;
    let (state_name, detail) = if written {
        let here = state.cfg.public_base_url.trim_end_matches('/').to_string();
        rewrite_references(&mut tx, &row.source, &state.cfg.server_name, &here, std::slice::from_ref(&row.hash)).await?;
        ("landed", String::new())
    } else {
        tracing::warn!(
            target: crate::logcat::MIGRATION,
            hash = row.hash,
            "fetched upload was already here under this server's own capability; the old origin's links to it will not resolve here"
        );
        ("refused", "already here under another capability".to_string())
    };
    sqlx::query(
        "UPDATE media_pulls SET state = ?, detail = ? WHERE migration_id = ? AND hash = ?",
    )
    .bind(state_name)
    .bind(detail)
    .bind(&row.migration_id)
    .bind(&row.hash)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn finish(state: &AppState, row: &Due, state_name: &str, detail: &str) -> ApiResult<()> {
    let detail: String = detail.chars().take(REASON_CHARS).collect();
    tracing::warn!(
        target: crate::logcat::MIGRATION,
        migration = row.migration_id,
        hash = row.hash,
        source = row.source,
        outcome = state_name,
        detail,
        "an upload the bundle left out will not be fetched"
    );
    sqlx::query("UPDATE media_pulls SET state = ?, detail = ? WHERE migration_id = ? AND hash = ?")
        .bind(state_name)
        .bind(detail)
        .bind(&row.migration_id)
        .bind(&row.hash)
        .execute(&state.pool)
        .await?;
    Ok(())
}

async fn defer(state: &AppState, row: &Due, error: &str) -> ApiResult<()> {
    let attempts = row.attempts + 1;
    if attempts >= PULL_MAX_ATTEMPTS {
        return finish(state, row, "failed", &format!("gave up after {attempts} attempts; last: {error}")).await;
    }
    tracing::debug!(
        target: crate::logcat::MIGRATION,
        migration = row.migration_id,
        hash = row.hash,
        source = row.source,
        attempts,
        error,
        "could not fetch an upload the bundle left out; will try again"
    );
    sqlx::query(
        "UPDATE media_pulls SET attempts = ?, next_attempt_at = ?, detail = ? \
         WHERE migration_id = ? AND hash = ?",
    )
    .bind(attempts)
    .bind(now_ms() + backoff_ms(attempts))
    .bind(error.chars().take(REASON_CHARS).collect::<String>())
    .bind(&row.migration_id)
    .bind(&row.hash)
    .execute(&state.pool)
    .await?;
    Ok(())
}

async fn confirm_pages(state: &AppState) -> ApiResult<()> {
    let migrations: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT migration_id, source FROM media_pulls \
         WHERE state IN ('landed', 'refused', 'failed') AND confirmed_at IS NULL",
    )
    .fetch_all(&state.pool)
    .await?;
    for (migration_id, source) in migrations {
        let rows: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT hash, state, detail FROM media_pulls WHERE migration_id = ? \
             AND state IN ('landed', 'refused', 'failed') AND confirmed_at IS NULL \
             ORDER BY hash LIMIT ?",
        )
        .bind(&migration_id)
        .bind(CONFIRM_PAGE as i64)
        .fetch_all(&state.pool)
        .await?;
        let landed: Vec<&str> = rows.iter().filter(|(_, s, _)| s == "landed").map(|(h, _, _)| h.as_str()).collect();
        let refused: Vec<Value> = rows
            .iter()
            .filter(|(_, s, _)| s != "landed")
            .map(|(h, _, d)| json!({ "hash": h, "reason": d }))
            .collect();
        let answer = federation::post_signed(
            state,
            &source,
            "/_telium/v1/migrate/media/confirm",
            &json!({ "migration_id": migration_id, "landed": landed, "refused": refused }),
        )
        .await;
        if let Err(e) = answer {
            tracing::debug!(target: crate::logcat::MIGRATION, migration = migration_id, source, error = %e, "could not confirm fetched uploads to the source; will try again");
            continue;
        }
        let now = now_ms();
        for (hash, _, _) in &rows {
            sqlx::query("UPDATE media_pulls SET confirmed_at = ? WHERE migration_id = ? AND hash = ?")
                .bind(now)
                .bind(&migration_id)
                .bind(hash)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_descriptor_is_rewritten_in_all_three_places_it_names_the_host() {
        let hash = "a".repeat(64);
        let mut att = json!({
            "reference": format!("media://a.example/{hash}"),
            "origin": "a.example",
            "hash": hash,
            "capability": "CAP",
            "url": format!("http://a.example/_telium/v1/media/{hash}?cap=CAP"),
            "filename": "photo.png",
        });
        let wanted: HashSet<&str> = [hash.as_str()].into_iter().collect();
        assert!(rewrite_descriptor(&mut att, "a.example", "b.example", "https://b.example", &wanted));
        assert_eq!(att["origin"], "b.example");
        assert_eq!(att["reference"], format!("media://b.example/{hash}"));
        assert_eq!(att["url"], format!("https://b.example/_telium/v1/media/{hash}?cap=CAP"));
        assert_eq!(att["filename"], "photo.png");
    }

    #[test]
    fn a_descriptor_for_another_object_or_another_origin_is_left_alone() {
        let hash = "b".repeat(64);
        let wanted: HashSet<&str> = [hash.as_str()].into_iter().collect();
        let mut other_origin = json!({ "origin": "c.example", "hash": hash, "url": "x" });
        assert!(!rewrite_descriptor(&mut other_origin, "a.example", "b.example", "https://b.example", &wanted));
        let mut other_hash = json!({ "origin": "a.example", "hash": "c".repeat(64), "url": "x" });
        assert!(!rewrite_descriptor(&mut other_hash, "a.example", "b.example", "https://b.example", &wanted));
        let mut external = json!({ "external": true, "origin": "a.example", "hash": hash, "url": "x" });
        assert!(!rewrite_descriptor(&mut external, "a.example", "b.example", "https://b.example", &wanted));
        assert_eq!(external["url"], "x");
    }

    #[test]
    fn the_backoff_doubles_from_a_minute_and_stops_at_six_hours() {
        assert_eq!(backoff_ms(1), 120_000);
        assert_eq!(backoff_ms(2), 240_000);
        assert_eq!(backoff_ms(9), 6 * 3_600_000);
        assert_eq!(backoff_ms(60), 6 * 3_600_000);
    }

    #[test]
    fn an_acknowledgement_without_a_media_section_reads_as_none() {
        assert_eq!(outcome_from(&json!({ "kind": "migration_ack" })), None);
        let hash = "d".repeat(64);
        let (landed, refused) = outcome_from(&json!({
            "media": { "landed": [hash, "not-a-hash"], "refused": [{ "hash": "e".repeat(64), "reason": "size" }] }
        }))
        .unwrap();
        assert_eq!(landed, vec!["d".repeat(64)]);
        assert_eq!(refused, vec![("e".repeat(64), "size".to_string())]);
    }
}
