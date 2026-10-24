//! Cold storage: compressed on-disk segments for old history.

use crate::error::{ApiError, ApiResult};
use crate::rows;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::io::{Read, Write};

/// Decompression cap; segments could one day come from outside this process.
const MAX_SEGMENT_BYTES: u64 = 256 * 1024 * 1024;

fn safe_path_component(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub async fn archive_channel(state: &AppState, channel_id: &str, batch: i64) -> ApiResult<i64> {
    let cfg = &state.cfg.archive;
    if !safe_path_component(channel_id) {
        // Refuse rather than sanitise: renaming would orphan the only copy of the history.
        return Err(ApiError::BadRequest("channel id is not a valid identifier".into()));
    }
    let horizon = now_ms() - cfg.horizon_days * 86_400_000;

    let keep_after: Option<String> = sqlx::query_scalar(
        "SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
    )
    .bind(channel_id)
    .bind(cfg.keep_hot_messages)
    .fetch_optional(&state.pool)
    .await?;
    let Some(keep_after) = keep_after else { return Ok(0) };

    // Whole rows, never a column list: a forgotten column is deleted history.
    let messages: Vec<Value> = sqlx::query(
        "SELECT * FROM messages WHERE channel_id = ? AND id <= ? AND created_at < ? \
         ORDER BY id LIMIT ?",
    )
    .bind(channel_id)
    .bind(&keep_after)
    .bind(horizon)
    .bind(batch)
    .fetch_all(&state.pool)
    .await?
    .iter()
    .map(rows::object)
    .collect();
    if messages.len() < 2 {
        return Ok(0);
    }
    let id = |m: &Value| m["id"].as_str().unwrap_or_default().to_string();
    let first = id(messages.first().expect("checked non-empty"));
    let last = id(messages.last().expect("checked non-empty"));

    let dir = cfg.dir.join(channel_id);
    let segment_id = ulid();
    let path = dir.join(format!("{segment_id}.json.gz"));
    let key = path.to_string_lossy().to_string();
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(serde_json::to_string(&messages).unwrap_or_default().as_bytes())
        .map_err(|e| ApiError::Internal(e.into()))?;
    let bytes = encoder.finish().map_err(|e| ApiError::Internal(e.into()))?;
    let size = bytes.len() as i64;
    state.archive_store.put(&key, bytes).await?;

    // Segment hits disk before rows leave the table: worst case is a duplicate, never a loss.
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO cold_segments (id, channel_id, first_id, last_id, messages, bytes, path, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&segment_id)
    .bind(channel_id)
    .bind(&first)
    .bind(&last)
    .bind(messages.len() as i64)
    .bind(size)
    .bind(&key)
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM messages WHERE channel_id = ? AND id >= ? AND id <= ?")
        .bind(channel_id)
        .bind(&first)
        .bind(&last)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    tracing::info!(target: crate::logcat::MEDIA, channel = channel_id, segment = segment_id, count = messages.len(), "archived history");
    Ok(messages.len() as i64)
}

fn for_client(row: &Value) -> Value {
    if row.get("author").is_some() {
        return row.clone();
    }
    let text = |key: &str| row.get(key).and_then(Value::as_str);
    json!({
        "id": row.get("id"),
        "channel_id": row.get("channel_id"),
        "guild_id": row.get("guild_id"),
        "author": row.get("author_id"),
        "content": row.get("content"),
        "attachments": text("attachments")
            .and_then(|a| serde_json::from_str::<Value>(a).ok())
            .unwrap_or(json!([])),
        "sticker": text("sticker").and_then(|s| serde_json::from_str::<Value>(s).ok()),
        "reply_to": row.get("reply_to"),
        // Carried through as-is: delete_message already blanks the columns, so this is a tombstone.
        "deleted": row.get("deleted").and_then(Value::as_i64).unwrap_or(0) != 0,
        "thread_id": row.get("thread_id"),
        "author_signature": row.get("author_signature"),
        "created_at": row.get("created_at"),
        "edited_at": row.get("edited_at"),
    })
}

pub fn for_row(entry: &Value) -> Value {
    if entry.get("author_id").is_some() {
        return entry.clone();
    }
    let mut row = entry.clone();
    let Some(map) = row.as_object_mut() else { return row };
    if let Some(author) = map.remove("author") {
        map.insert("author_id".into(), author);
    }
    if let Some(Value::Bool(b)) = map.get("deleted") {
        let n = i64::from(*b);
        map.insert("deleted".into(), Value::from(n));
    }
    for key in ["attachments", "sticker"] {
        match map.get(key) {
            Some(Value::Null) | None => {}
            Some(Value::String(_)) => {}
            Some(other) => {
                let text = other.to_string();
                map.insert(key.into(), Value::String(text));
            }
        }
    }
    row
}

pub async fn read_segment(state: &AppState, segment_id: &str) -> ApiResult<Vec<Value>> {
    let path: Option<String> = sqlx::query_scalar("SELECT path FROM cold_segments WHERE id = ?")
        .bind(segment_id)
        .fetch_optional(&state.pool)
        .await?;
    let path = path.ok_or_else(|| ApiError::NotFound("no such segment".into()))?;
    let bytes = state.archive_store.get(&path).await?;
    // Cap the decompressed output; a gzip stream sets its own expansion ratio.
    let mut out = Vec::new();
    let mut reader = flate2::read::GzDecoder::new(&bytes[..]).take(MAX_SEGMENT_BYTES + 1);
    reader.read_to_end(&mut out).map_err(|e| ApiError::Internal(e.into()))?;
    if out.len() as u64 > MAX_SEGMENT_BYTES {
        return Err(ApiError::Internal(anyhow::anyhow!(
            "cold segment {segment_id} expands past {MAX_SEGMENT_BYTES} bytes and was not read"
        )));
    }
    Ok(serde_json::from_slice(&out).unwrap_or_default())
}

pub async fn page_before(
    state: &AppState,
    channel_id: &str,
    before: &str,
    limit: usize,
) -> ApiResult<Vec<Value>> {
    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM cold_segments WHERE channel_id = ? AND first_id < ? \
         ORDER BY first_id DESC LIMIT 4",
    )
    .bind(channel_id)
    .bind(before)
    .fetch_all(&state.pool)
    .await?;

    let mut out: Vec<Value> = Vec::new();
    for segment in segments {
        let mut messages: Vec<Value> = read_segment(state, &segment)
            .await?
            .iter()
            .filter(|m| m["id"].as_str().unwrap_or_default() < before)
            .map(for_client)
            .collect();
        messages.reverse();
        out.append(&mut messages);
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    Ok(out)
}

pub async fn sweep(state: &AppState) -> ApiResult<i64> {
    if !state.cfg.archive.enabled {
        return Ok(0);
    }
    let channels: Vec<String> = sqlx::query_scalar(
        "SELECT channel_id FROM messages GROUP BY channel_id HAVING COUNT(*) > ? \
         ORDER BY COUNT(*) DESC LIMIT 10",
    )
    .bind(state.cfg.archive.keep_hot_messages)
    .fetch_all(&state.pool)
    .await?;
    let mut moved = 0;
    for channel_id in channels {
        moved += archive_channel(state, &channel_id, state.cfg.archive.batch).await?;
    }
    Ok(moved)
}

use crate::auth::HomeAuth;
use axum::extract::State;
use axum::Json;

pub async fn archive_now(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    if !state.cfg.archive.enabled {
        return Err(ApiError::BadRequest("cold storage is not enabled on this server".into()));
    }
    let moved = sweep(&state).await?;
    let (segments, bytes): (i64, i64) =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM cold_segments")
            .fetch_one(&state.pool)
            .await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "archive.run",
        None,
        json!({ "archived": moved, "segments": segments, "bytes": bytes }),
    )
    .await;
    Ok(Json(json!({
        "archived": moved, "segments": segments, "bytes": bytes,
    })))
}

pub async fn segments(
    State(state): State<AppState>,
    auth: crate::auth::GuildAuth,
    axum::extract::Path(channel_id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    crate::guildstore::require_channel_perm(
        &state,
        &channel_id,
        &auth.user_id,
        crate::perms::READ_MESSAGE_HISTORY,
    )
    .await?;
    let rows: Vec<(String, String, String, i64, i64, i64)> = sqlx::query_as(
        "SELECT id, first_id, last_id, messages, bytes, created_at FROM cold_segments \
         WHERE channel_id = ? ORDER BY first_id",
    )
    .bind(&channel_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "segments": rows.into_iter().map(|(id, first, last, count, bytes, at)| json!({
            "id": id, "first_id": first, "last_id": last,
            "messages": count, "bytes": bytes, "created_at": at,
        })).collect::<Vec<_>>()
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_channel_id_that_is_not_an_identifier_never_reaches_a_path() {
        for good in ["01HQ8Z5T6G3B0N7XQ2K9M4VJPW", "c-1", "c_1"] {
            assert!(safe_path_component(good), "{good}");
        }
        let long = "a".repeat(65);
        for bad in ["", "..", "../../etc/passwd", "a/b", "a\\b", "/absolute", ".", "a.b", "a\u{0}b", "ç", &long] {
            assert!(!safe_path_component(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_deleted_message_survives_the_round_trip() {
        let row = json!({
            "id": "01ABCDEFGHIJKLMNOPQRSTUVWX",
            "channel_id": "01ABCDEFGHIJKLMNOPQRSTUVWY",
            "author_id": "@ana:a.example",
            "content": "gone",
            "deleted": 1,
            "created_at": 1000,
        });
        let client = for_client(&row);
        assert_eq!(client.get("deleted"), Some(&Value::Bool(true)));
        let back = for_row(&client);
        assert_eq!(back.get("deleted").and_then(Value::as_i64), Some(1));
    }
}
