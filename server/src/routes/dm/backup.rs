use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

const MAX_BACKUP_ITEMS: usize = 512;
pub(crate) const MAX_BACKUP_ITEM_BYTES: usize = 256 * 1024;
pub(crate) const MAX_BACKUP_ROWS: i64 = 250_000;

#[derive(Deserialize)]
pub struct BackupItem {
    pub scope: String,
    pub item: String,
    pub ciphertext: String,
}

#[derive(Deserialize)]
pub struct PutBackup {
    pub items: Vec<BackupItem>,
}

pub async fn put_backup(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<PutBackup>,
) -> ApiResult<Json<Value>> {
    if req.items.len() > MAX_BACKUP_ITEMS {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_BACKUP_ITEMS} items per request"
        )));
    }
    for item in &req.items {
        if item.scope.is_empty() || item.item.is_empty() {
            return Err(ApiError::BadRequest("scope and item are required".into()));
        }
        if item.ciphertext.len() > MAX_BACKUP_ITEM_BYTES {
            return Err(ApiError::BadRequest("backup item is too large".into()));
        }
    }

    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_backup WHERE user_id = ?")
        .bind(&auth.user_id)
        .fetch_one(&state.pool)
        .await?;
    if held + (req.items.len() as i64) > MAX_BACKUP_ROWS {
        return Err(ApiError::BadRequest(
            "the backup for this account is full".into(),
        ));
    }

    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    for item in &req.items {
        sqlx::query(
            "INSERT INTO key_backup (user_id, scope, item, ciphertext, updated_at) \
             VALUES (?, ?, ?, ?, ?) \
             ON CONFLICT(user_id, scope, item) DO UPDATE SET \
                 ciphertext = excluded.ciphertext, updated_at = excluded.updated_at",
        )
        .bind(&auth.user_id)
        .bind(&item.scope)
        .bind(&item.item)
        .bind(&item.ciphertext)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "stored": req.items.len() })))
}

#[derive(Deserialize)]
pub struct BackupQuery {
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Default)]
struct BackupCursor {
    at: i64,
    scope: String,
    item: String,
}

impl BackupCursor {
    fn encode(at: i64, scope: &str, item: &str) -> String {
        use base64::Engine;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(json!({ "at": at, "scope": scope, "item": item }).to_string())
    }

    fn decode(raw: Option<&str>) -> Self {
        let Some(raw) = raw.filter(|r| !r.is_empty()) else { return Self::default() };
        if let Ok(at) = raw.parse::<i64>() {
            return Self { at, ..Self::default() };
        }
        use base64::Engine;
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let Some(v) = decoded else { return Self::default() };
        Self {
            at: v.get("at").and_then(Value::as_i64).unwrap_or(0),
            scope: v.get("scope").and_then(Value::as_str).unwrap_or_default().to_string(),
            item: v.get("item").and_then(Value::as_str).unwrap_or_default().to_string(),
        }
    }
}

pub async fn get_backup(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<BackupQuery>,
) -> ApiResult<Json<Value>> {
    let limit = q.limit.unwrap_or(500).clamp(1, MAX_BACKUP_ITEMS as i64);
    let after = BackupCursor::decode(q.after.as_deref());
    let rows: Vec<(String, String, String, i64)> = match &q.scope {
        Some(scope) => {
            sqlx::query_as(
                "SELECT scope, item, ciphertext, updated_at FROM key_backup \
                 WHERE user_id = ? AND scope = ? AND (updated_at, item) > (?, ?) \
                 ORDER BY updated_at, item LIMIT ?",
            )
            .bind(&auth.user_id)
            .bind(scope)
            .bind(after.at)
            .bind(&after.item)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT scope, item, ciphertext, updated_at FROM key_backup \
                 WHERE user_id = ? AND (updated_at, scope, item) > (?, ?, ?) \
                 ORDER BY updated_at, scope, item LIMIT ?",
            )
            .bind(&auth.user_id)
            .bind(after.at)
            .bind(&after.scope)
            .bind(&after.item)
            .bind(limit)
            .fetch_all(&state.pool)
            .await?
        }
    };
    let cursor = rows
        .last()
        .map(|(scope, item, _, at)| BackupCursor::encode(*at, scope, item))
        .unwrap_or_else(|| BackupCursor::encode(after.at, &after.scope, &after.item));
    Ok(Json(json!({
        "scope": q.scope,
        "cursor": cursor,
        "complete": (rows.len() as i64) < limit,
        "items": rows.into_iter()
            .map(|(scope, item, ciphertext, updated_at)| json!({
                "scope": scope, "item": item,
                "ciphertext": ciphertext, "updated_at": updated_at,
            }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct DropBackup {
    #[serde(default)]
    pub scope: Option<String>,
}

pub async fn delete_backup(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<DropBackup>,
) -> ApiResult<Json<Value>> {
    let deleted = match req.scope {
        Some(scope) => {
            sqlx::query("DELETE FROM key_backup WHERE user_id = ? AND scope = ?")
                .bind(&auth.user_id)
                .bind(&scope)
                .execute(&state.pool)
                .await?
        }
        None => {
            sqlx::query("DELETE FROM key_backup WHERE user_id = ?")
                .bind(&auth.user_id)
                .execute(&state.pool)
                .await?
        }
    };
    Ok(Json(json!({ "ok": true, "deleted": deleted.rows_affected() })))
}
