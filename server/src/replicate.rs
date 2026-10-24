
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const EXCLUDED: &[&str] = &[
    "_sqlx_migrations",
    "repl_log",
    "repl_ack",
    "replica_state",
    "server_keys",
    "vapid_key",
    "sfu_health",
    "media_cache",
    "admin_step_up",
];

fn excluded(name: &str) -> bool {
    EXCLUDED.contains(&name) || name.starts_with("sqlite_")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub seq: i64,
    pub tbl: String,
    pub op: String,
    pub pk: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row: Option<Value>,
    pub at: i64,
}

#[derive(Debug, Clone)]
pub struct TableInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub pk: Vec<String>,
}

fn quote(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

fn literal(s: &str) -> String {
    s.replace('\'', "''")
}

pub async fn tables(pool: &SqlitePool) -> ApiResult<Vec<TableInfo>> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .fetch_all(pool)
            .await?;
    let virtual_tables: Vec<String> = rows
        .iter()
        .filter(|(_, sql)| {
            sql.as_deref().map(|s| s.trim_start().to_uppercase().starts_with("CREATE VIRTUAL TABLE"))
                .unwrap_or(false)
        })
        .map(|(name, _)| name.clone())
        .collect();
    let mut out = Vec::new();
    for (name, _) in rows {
        if excluded(&name) || derived(&name, &virtual_tables) {
            continue;
        }
        out.push(describe(pool, &name).await?);
    }
    Ok(out)
}

fn derived(name: &str, virtual_tables: &[String]) -> bool {
    virtual_tables
        .iter()
        .any(|v| name == v || name.starts_with(&format!("{v}_")))
}

pub async fn describe(pool: &SqlitePool, name: &str) -> ApiResult<TableInfo> {
    let rows = sqlx::query(&format!(
        "SELECT name, pk FROM pragma_table_info('{}')",
        literal(name)
    ))
    .fetch_all(pool)
    .await?;
    let mut columns = Vec::new();
    let mut pk: Vec<(i64, String)> = Vec::new();
    for row in rows {
        let column: String = row.try_get("name")?;
        let position: i64 = row.try_get("pk")?;
        if position > 0 {
            pk.push((position, column.clone()));
        }
        columns.push(column);
    }
    if columns.is_empty() {
        return Err(ApiError::NotFound(format!("no table {name}")));
    }
    pk.sort();
    let mut info = TableInfo {
        name: name.to_string(),
        columns,
        pk: pk.into_iter().map(|(_, c)| c).collect(),
    };
    if info.pk.is_empty() {
        info.pk = vec!["rowid".into()];
        info.columns.insert(0, "rowid".into());
    }
    Ok(info)
}

pub async fn install_triggers(pool: &SqlitePool) -> ApiResult<usize> {
    let tables = tables(pool).await?;
    let mut tx = pool.begin().await?;
    for name in trigger_names(pool).await? {
        sqlx::query(&format!("DROP TRIGGER IF EXISTS {}", quote(&name)))
            .execute(&mut *tx)
            .await?;
    }
    for table in &tables {
        for statement in trigger_sql(table) {
            sqlx::query(&statement).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(tables.len())
}

async fn trigger_names(pool: &SqlitePool) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_repl\\_%' ESCAPE '\\'",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn drop_triggers(pool: &SqlitePool) -> ApiResult<()> {
    for name in trigger_names(pool).await? {
        sqlx::query(&format!("DROP TRIGGER IF EXISTS {}", quote(&name)))
            .execute(pool)
            .await?;
    }
    Ok(())
}

fn json_object(table: &TableInfo, alias: &str) -> String {
    let parts: Vec<String> = table
        .columns
        .iter()
        .map(|c| format!("'{}', {alias}.{}", literal(c), quote(c)))
        .collect();
    format!("json_object({})", parts.join(", "))
}

fn json_key(table: &TableInfo, alias: &str) -> String {
    let parts: Vec<String> =
        table.pk.iter().map(|c| format!("{alias}.{}", quote(c))).collect();
    format!("json_array({})", parts.join(", "))
}

fn trigger_sql(table: &TableInfo) -> Vec<String> {
    let name = &table.name;
    let tbl = quote(name);
    let lit = literal(name);
    let now = "CAST(strftime('%s', 'now') AS INTEGER) * 1000";
    let new_key = json_key(table, "new");
    let old_key = json_key(table, "old");
    let new_row = json_object(table, "new");
    vec![
        format!("DROP TRIGGER IF EXISTS \"_repl_i_{lit}\""),
        format!(
            "CREATE TRIGGER \"_repl_i_{lit}\" AFTER INSERT ON {tbl} BEGIN \
             INSERT INTO repl_log(tbl, op, pk, row, at) \
             VALUES ('{lit}', 'u', {new_key}, {new_row}, {now}); END"
        ),
        format!("DROP TRIGGER IF EXISTS \"_repl_u_{lit}\""),
        format!(
            "CREATE TRIGGER \"_repl_u_{lit}\" AFTER UPDATE ON {tbl} BEGIN \
             INSERT INTO repl_log(tbl, op, pk, row, at) \
             SELECT '{lit}', 'd', {old_key}, NULL, {now} WHERE {old_key} <> {new_key}; \
             INSERT INTO repl_log(tbl, op, pk, row, at) \
             VALUES ('{lit}', 'u', {new_key}, {new_row}, {now}); END"
        ),
        format!("DROP TRIGGER IF EXISTS \"_repl_d_{lit}\""),
        format!(
            "CREATE TRIGGER \"_repl_d_{lit}\" AFTER DELETE ON {tbl} BEGIN \
             INSERT INTO repl_log(tbl, op, pk, row, at) \
             VALUES ('{lit}', 'd', {old_key}, NULL, {now}); END"
        ),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Head {
    pub seq: i64,
    pub floor: i64,
    pub schema_version: i64,
    pub server_time: i64,
}

pub async fn head(pool: &SqlitePool) -> ApiResult<Head> {
    let seq: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM repl_log")
        .fetch_one(pool)
        .await?;
    let floor: i64 = sqlx::query_scalar("SELECT COALESCE(MIN(seq), 0) FROM repl_log")
        .fetch_one(pool)
        .await?;
    Ok(Head { seq, floor, schema_version: schema_version(pool).await?, server_time: now_ms() })
}

pub async fn schema_version(pool: &SqlitePool) -> ApiResult<i64> {
    Ok(sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .unwrap_or(0))
}

pub async fn read_log(pool: &SqlitePool, since: i64, limit: i64) -> ApiResult<Vec<Entry>> {
    let rows: Vec<(i64, String, String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT seq, tbl, op, pk, row, at FROM repl_log WHERE seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(since)
    .bind(limit.clamp(1, 5_000))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(seq, tbl, op, pk, row, at)| Entry {
            seq,
            tbl,
            op,
            pk: serde_json::from_str(&pk).unwrap_or(Value::Null),
            row: row.as_deref().and_then(|r| serde_json::from_str(r).ok()),
            at,
        })
        .collect())
}

pub async fn acknowledge(pool: &SqlitePool, standby: &str, seq: i64, keep_ms: i64) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO repl_ack (standby, seq, at) VALUES (?, ?, ?) \
         ON CONFLICT(standby) DO UPDATE SET seq = MAX(seq, excluded.seq), at = excluded.at",
    )
    .bind(standby)
    .bind(seq)
    .bind(now_ms())
    .execute(pool)
    .await?;
    let slowest: i64 = sqlx::query_scalar("SELECT COALESCE(MIN(seq), 0) FROM repl_ack")
        .fetch_one(pool)
        .await?;
    sqlx::query("DELETE FROM repl_log WHERE seq <= ? AND at < ?")
        .bind(slowest)
        .bind(now_ms() - keep_ms.max(0))
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn snapshot(pool: &SqlitePool, dir: &Path) -> ApiResult<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| ApiError::Internal(e.into()))?;
    let out = dir.join(format!("repl-{}.db", now_ms()));
    let _ = std::fs::remove_file(&out);
    let target = literal(&out.to_string_lossy());
    sqlx::query(&format!("VACUUM INTO '{target}'")).execute(pool).await?;
    strip(&out).await?;
    Ok(out)
}

async fn strip(file: &Path) -> ApiResult<()> {
    let url = format!("sqlite://{}", file.display());
    let pool = SqlitePool::connect(&url).await?;
    let present: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(&pool)
            .await?;
    for name in EXCLUDED {
        if *name == "_sqlx_migrations" || !present.iter().any(|p| p == name) {
            continue;
        }
        sqlx::query(&format!("DELETE FROM \"{}\"", literal(name))).execute(&pool).await?;
    }
    sqlx::query("VACUUM").execute(&pool).await?;
    pool.close().await;
    Ok(())
}

enum Cell {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
}

fn cell(value: Option<&Value>) -> Cell {
    match value {
        None | Some(Value::Null) => Cell::Null,
        Some(Value::Bool(b)) => Cell::Int(i64::from(*b)),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Cell::Int)
            .or_else(|| n.as_f64().map(Cell::Real))
            .unwrap_or(Cell::Null),
        Some(Value::String(s)) => Cell::Text(s.clone()),
        Some(other) => Cell::Text(other.to_string()),
    }
}

pub async fn apply(pool: &SqlitePool, entries: &[Entry]) -> ApiResult<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut schema: HashMap<String, TableInfo> = HashMap::new();
    let mut tx = pool.begin().await?;
    for entry in entries {
        if excluded(&entry.tbl) {
            continue;
        }
        let info = match schema.get(&entry.tbl) {
            Some(info) => info.clone(),
            None => {
                let info = describe(pool, &entry.tbl).await.map_err(|_| {
                    ApiError::Conflict(format!(
                        "replica has no table {} -- the pair is running different versions",
                        entry.tbl
                    ))
                })?;
                schema.insert(entry.tbl.clone(), info.clone());
                info
            }
        };
        let key: Vec<Value> = entry.pk.as_array().cloned().unwrap_or_default();
        if key.len() != info.pk.len() {
            return Err(ApiError::Conflict(format!(
                "log entry for {} carries {} key columns, the replica has {}",
                entry.tbl,
                key.len(),
                info.pk.len()
            )));
        }
        let (sql, cells) = match entry.op.as_str() {
            "u" => {
                let row = entry.row.as_ref().and_then(Value::as_object);
                let columns: Vec<String> = info.columns.iter().map(|c| quote(c)).collect();
                let holes = vec!["?"; info.columns.len()].join(", ");
                let cells: Vec<Cell> = info
                    .columns
                    .iter()
                    .map(|c| cell(row.and_then(|r| r.get(c))))
                    .collect();
                (
                    format!(
                        "INSERT OR REPLACE INTO {} ({}) VALUES ({holes})",
                        quote(&info.name),
                        columns.join(", ")
                    ),
                    cells,
                )
            }
            "d" => {
                let predicate: Vec<String> =
                    info.pk.iter().map(|c| format!("{} IS ?", quote(c))).collect();
                (
                    format!(
                        "DELETE FROM {} WHERE {}",
                        quote(&info.name),
                        predicate.join(" AND ")
                    ),
                    key.iter().map(|v| cell(Some(v))).collect(),
                )
            }
            other => {
                return Err(ApiError::BadRequest(format!("unknown replication op {other}")))
            }
        };
        let mut query = sqlx::query(&sql);
        for cell in &cells {
            query = match cell {
                Cell::Null => query.bind(None::<String>),
                Cell::Int(i) => query.bind(*i),
                Cell::Real(f) => query.bind(*f),
                Cell::Text(s) => query.bind(s.clone()),
            };
        }
        query.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn install_snapshot(pool: &SqlitePool, file: &Path) -> ApiResult<()> {
    let path = literal(&file.to_string_lossy());
    let mut conn = pool.acquire().await?;
    sqlx::query(&format!("ATTACH '{path}' AS snap"))
        .execute(&mut *conn)
        .await?;
    let result = copy_in(&mut conn).await;
    let _ = sqlx::query("DETACH snap").execute(&mut *conn).await;
    result
}

async fn copy_in(conn: &mut sqlx::SqliteConnection) -> ApiResult<()> {
    sqlx::query("BEGIN").execute(&mut *conn).await?;
    let result = copy_tables(conn).await;
    match result {
        Ok(()) => {
            sqlx::query("COMMIT").execute(&mut *conn).await?;
            Ok(())
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

async fn copy_tables(conn: &mut sqlx::SqliteConnection) -> ApiResult<()> {
    let incoming: Vec<String> =
        sqlx::query_scalar("SELECT name FROM snap.sqlite_master WHERE type = 'table' ORDER BY name")
            .fetch_all(&mut *conn)
            .await?;
    let triggers: Vec<(String, String)> = sqlx::query_as(
        "SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL",
    )
    .fetch_all(&mut *conn)
    .await?;
    for (name, _) in &triggers {
        sqlx::query(&format!("DROP TRIGGER IF EXISTS main.{}", quote(name)))
            .execute(&mut *conn)
            .await?;
    }
    for name in incoming {
        if excluded(&name) {
            continue;
        }
        let here: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT name FROM pragma_table_info('{}', 'main')",
            literal(&name)
        ))
        .fetch_all(&mut *conn)
        .await?;
        let there: Vec<String> = sqlx::query_scalar(&format!(
            "SELECT name FROM pragma_table_info('{}', 'snap')",
            literal(&name)
        ))
        .fetch_all(&mut *conn)
        .await?;
        if here.is_empty() {
            return Err(ApiError::Conflict(format!(
                "the snapshot has a table {name} this server does not -- \
                 a standby has to run the same version as its primary"
            )));
        }
        let shared: Vec<String> =
            here.iter().filter(|c| there.contains(c)).map(|c| quote(c)).collect();
        let missing: Vec<&String> = here.iter().filter(|c| !there.contains(c)).collect();
        if !missing.is_empty() {
            return Err(ApiError::Conflict(format!(
                "the snapshot's {name} is missing {missing:?} -- \
                 a standby has to run the same version as its primary"
            )));
        }
        let columns = shared.join(", ");
        sqlx::query(&format!("DELETE FROM main.{}", quote(&name)))
            .execute(&mut *conn)
            .await?;
        sqlx::query(&format!(
            "INSERT INTO main.{t} ({columns}) SELECT {columns} FROM snap.{t}",
            t = quote(&name)
        ))
        .execute(&mut *conn)
        .await?;
    }
    for (_, sql) in &triggers {
        sqlx::query(sql).execute(&mut *conn).await?;
    }
    Ok(())
}

#[derive(Clone)]
pub struct Replica {
    pub origin: String,
    pub state: crate::AppState,
}

pub async fn open_replicas(host: &crate::AppState) -> anyhow::Result<Vec<Replica>> {
    let mut out = Vec::new();
    for origin in &host.cfg.failover.replicate {
        if origin == &host.cfg.server_name {
            anyhow::bail!("a server cannot be its own standby");
        }
        let dir = host.cfg.failover.dir.join(origin);
        std::fs::create_dir_all(&dir)?;
        let media_dir = dir.join("media");
        std::fs::create_dir_all(&media_dir)?;
        let url = format!("sqlite://{}/replica.db?mode=rwc", dir.display());
        // Foreign keys off: a snapshot is not in commit order.
        let pool = crate::db::connect_without_foreign_keys(&url).await?;

        let mut cfg = (*host.cfg).clone();
        cfg.server_name = origin.clone();
        cfg.media_dir = media_dir;
        cfg.public_base_url = format!("{}{}", host.cfg.public_base_url, mount_path(origin));
        cfg.backup.dir = dir.join("backups");
        cfg.web.dir = None;
        let promoted_standbys = host
            .cfg
            .failover
            .promoted_standbys
            .get(origin)
            .cloned()
            .unwrap_or_default();
        cfg.failover = crate::config::Failover::default();
        cfg.failover.standbys = promoted_standbys;

        sqlx::query(
            "INSERT INTO replica_state (origin, cursor) VALUES (?, 0) ON CONFLICT(origin) DO NOTHING",
        )
        .bind(origin)
        .execute(&host.pool)
        .await?;

        let (promoted, record): (i64, Option<String>) =
            sqlx::query_as("SELECT promoted, record FROM replica_state WHERE origin = ?")
                .bind(origin)
                .fetch_one(&host.pool)
                .await?;
        if promoted != 0 {
            install_triggers(&pool).await?;
        } else {
            drop_triggers(&pool).await?;
        }
        let authority_record = record
            .as_deref()
            .and_then(|r| serde_json::from_str::<Value>(r).ok());

        out.push(Replica {
            origin: origin.clone(),
            state: crate::AppState {
                cfg: std::sync::Arc::new(cfg),
                pool,
                signing_origin: std::sync::Arc::new(host.cfg.server_name.clone()),
                authority_record: std::sync::Arc::new(tokio::sync::RwLock::new(authority_record)),
                authority_workers_started: std::sync::Arc::new(
                    std::sync::atomic::AtomicBool::new(false),
                ),
                shutting_down: host.shutting_down.clone(),
                replica_host_pool: Some(host.pool.clone()),
                hub: std::sync::Arc::new(crate::gateway::hub::Hub::new(
                    host.cfg.limits.presence_coalesce_secs,
                )),
                demoted: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                lease: None,
                ..host.clone()
            },
        });
    }
    Ok(out)
}

pub fn mount_path(origin: &str) -> String {
    format!("/_telium/standby/{origin}")
}

pub fn spawn(host: crate::AppState, replicas: Vec<Replica>) {
    for replica in replicas {
        let host = host.clone();
        tokio::spawn(async move { follow(host, replica).await });
    }
}

pub fn activate(replica: &Replica) {
    use std::sync::atomic::Ordering;
    if replica
        .state
        .authority_workers_started
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    tracing::warn!(
        target: crate::logcat::STANDBY,
        origin = %replica.origin,
        signer = %replica.state.signing_origin,
        "starting full primary lifecycle for promoted authority",
    );
    crate::gateway::spawn_presence_flusher(replica.state.clone());
    crate::federation::spawn_maintenance(replica.state.clone());
    crate::routes::push::spawn_notification_outbox(replica.state.clone());
    crate::backup::spawn(replica.state.pool.clone(), replica.state.cfg.clone());
    crate::promotion::spawn(replica.state.clone());
}

pub async fn activate_promoted(host: &crate::AppState, replicas: &[Replica]) -> ApiResult<usize> {
    let mut activated = 0;
    for replica in replicas {
        let promoted: i64 =
            sqlx::query_scalar("SELECT promoted FROM replica_state WHERE origin = ?")
                .bind(&replica.origin)
                .fetch_one(&host.pool)
                .await?;
        if promoted != 0 {
            activate(replica);
            activated += 1;
        }
    }
    Ok(activated)
}

async fn follow(host: crate::AppState, replica: Replica) {
    let poll = std::time::Duration::from_secs(host.cfg.failover.poll_secs.max(1));
    tracing::info!(target: crate::logcat::STANDBY, origin = %replica.origin, "following as warm standby");
    loop {
        match sync_once(&host, &replica).await {
            Ok(applied) => {
                if applied > 0 {
                    tracing::debug!(target: crate::logcat::STANDBY, origin = %replica.origin, applied, "replicated");
                }
                let _ = sqlx::query("UPDATE replica_state SET last_error = NULL WHERE origin = ?")
                    .bind(&replica.origin)
                    .execute(&host.pool)
                    .await;
            }
            Err(err) => {
                tracing::warn!(target: crate::logcat::STANDBY, origin = %replica.origin, error = %err, "replication failed");
                let _ = sqlx::query("UPDATE replica_state SET last_error = ? WHERE origin = ?")
                    .bind(err.to_string())
                    .bind(&replica.origin)
                    .execute(&host.pool)
                    .await;
            }
        }
        tokio::time::sleep(poll).await;
    }
}

pub async fn sync_once(host: &crate::AppState, replica: &Replica) -> ApiResult<usize> {
    let (cursor, promoted): (i64, i64) =
        sqlx::query_as("SELECT cursor, promoted FROM replica_state WHERE origin = ?")
            .bind(&replica.origin)
            .fetch_one(&host.pool)
            .await?;
    if promoted != 0 {
        return Ok(0);
    }

    let path = "/_telium/v1/failover/head";
    let head: Head = serde_json::from_value(
        crate::federation::get_signed(host, &replica.origin, path).await?,
    )
    .map_err(|e| ApiError::BadRequest(format!("unreadable replication head: {e}")))?;

    let ours = schema_version(&replica.state.pool).await?;
    if head.schema_version != ours {
        return Err(ApiError::Conflict(format!(
            "{} is at schema {} and this standby is at {} -- \
             a pair has to run the same version of the server",
            replica.origin, head.schema_version, ours
        )));
    }

    let mut cursor = cursor;
    if cursor == 0 || cursor < head.floor.saturating_sub(1) {
        cursor = bootstrap(host, replica, &head).await?;
    }

    let applied = catch_up(host, replica, cursor).await?;
    sync_media(host, replica).await?;
    Ok(applied)
}

async fn bootstrap(host: &crate::AppState, replica: &Replica, head: &Head) -> ApiResult<i64> {
    tracing::info!(target: crate::logcat::STANDBY, origin = %replica.origin, "copying a fresh snapshot");
    let dir = host.cfg.failover.dir.join(&replica.origin);
    let file = dir.join("incoming.db");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| ApiError::Internal(e.into()))?;
    let (status, written) = crate::federation::get_signed_to_file(
        host,
        &replica.origin,
        "/_telium/v1/failover/snapshot",
        None,
        &file,
        usize::try_from(host.cfg.failover.max_snapshot_bytes).unwrap_or(usize::MAX),
    )
    .await?;
    if status != 200 {
        return Err(ApiError::BadRequest(format!(
            "{} refused a snapshot ({status})",
            replica.origin
        )));
    }
    let result = install_snapshot(&replica.state.pool, &file).await;
    let _ = tokio::fs::remove_file(&file).await;
    result?;
    rebuild_index(&replica.state.pool).await?;
    sqlx::query(
        "UPDATE replica_state SET cursor = ?, snapshot_at = ?, applied_at = ?, lag_at = ? \
         WHERE origin = ?",
    )
    .bind(head.seq)
    .bind(now_ms())
    .bind(now_ms())
    .bind(head.server_time)
    .bind(&replica.origin)
    .execute(&host.pool)
    .await?;
    tracing::info!(target: crate::logcat::STANDBY, origin = %replica.origin, seq = head.seq, bytes = written, "snapshot installed");
    Ok(head.seq)
}

async fn catch_up(host: &crate::AppState, replica: &Replica, from: i64) -> ApiResult<usize> {
    let mut cursor = from;
    let mut total = 0;
    for _ in 0..8 {
        let (bytes, _mime, status) = crate::federation::get_signed_bytes_capped(
            host,
            &replica.origin,
            "/_telium/v1/failover/log",
            Some(&format!("since={cursor}&limit={}", host.cfg.failover.batch)),
            64 * 1024 * 1024,
        )
        .await?;
        if status != 200 {
            return Err(ApiError::BadRequest(format!(
                "{} refused the replication log ({status})",
                replica.origin
            )));
        }
        let body: Value = serde_json::from_slice(&bytes)
            .map_err(|e| ApiError::BadRequest(format!("unreadable replication log: {e}")))?;
        let entries: Vec<Entry> = serde_json::from_value(
            body.get("entries").cloned().unwrap_or(Value::Array(vec![])),
        )
        .map_err(|e| ApiError::BadRequest(format!("unreadable replication log: {e}")))?;
        if entries.is_empty() {
            break;
        }
        let last = entries[entries.len() - 1].clone();
        apply(&replica.state.pool, &entries).await?;
        reindex(&replica.state.pool, &entries).await?;
        cursor = last.seq;
        total += entries.len();
        sqlx::query(
            "UPDATE replica_state SET cursor = ?, applied_at = ?, lag_at = ? WHERE origin = ?",
        )
        .bind(cursor)
        .bind(now_ms())
        .bind(last.at)
        .bind(&replica.origin)
        .execute(&host.pool)
        .await?;
    }
    if total == 0 {
        sqlx::query("UPDATE replica_state SET applied_at = ? WHERE origin = ?")
            .bind(now_ms())
            .bind(&replica.origin)
            .execute(&host.pool)
            .await?;
    }
    Ok(total)
}

async fn sync_media(host: &crate::AppState, replica: &Replica) -> ApiResult<()> {
    let batch = host.cfg.failover.media_batch.clamp(1, 5_000);
    let position: String =
        sqlx::query_scalar("SELECT media_cursor FROM replica_state WHERE origin = ?")
            .bind(&replica.origin)
            .fetch_one(&host.pool)
            .await?;
    let hashes: Vec<String> =
        sqlx::query_scalar("SELECT hash FROM media WHERE hash > ? ORDER BY hash LIMIT ?")
            .bind(&position)
            .bind(batch)
            .fetch_all(&replica.state.pool)
            .await?;
    let next = hashes.last().cloned().unwrap_or_default();
    for hash in &hashes {
        if hash.len() < 4 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let path = replica.state.cfg.media_dir.join(&hash[0..2]).join(hash);
        if tokio::fs::metadata(&path).await.is_ok() {
            continue;
        }
        let fetched = crate::federation::get_signed_bytes_capped(
            host,
            &replica.origin,
            &format!("/_telium/v1/failover/media/{hash}"),
            None,
            replica.state.cfg.media_policy.max_file_bytes,
        )
        .await;
        let Ok((bytes, _mime, 200)) = fetched else {
            continue;
        };
        if let Err(e) = crate::objectstore::write_atomically(&path, &bytes).await {
            tracing::warn!(target: crate::logcat::STANDBY, %hash, error = %e, "could not copy a media object to the standby");
        }
    }
    sqlx::query("UPDATE replica_state SET media_cursor = ? WHERE origin = ?")
        .bind(next)
        .bind(&replica.origin)
        .execute(&host.pool)
        .await?;
    Ok(())
}

pub async fn reindex(pool: &SqlitePool, entries: &[Entry]) -> ApiResult<()> {
    for entry in entries {
        if entry.tbl != "messages" {
            continue;
        }
        let Some(id) = entry.pk.as_array().and_then(|a| a.first()).and_then(Value::as_str) else {
            continue;
        };
        sqlx::query("DELETE FROM messages_fts WHERE message_id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        if entry.op != "u" {
            continue;
        }
        let Some(row) = entry.row.as_ref().and_then(Value::as_object) else { continue };
        let text = |key: &str| row.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        if row.get("deleted").and_then(Value::as_i64).unwrap_or(0) != 0 {
            continue;
        }
        sqlx::query(
            "INSERT INTO messages_fts (content, message_id, channel_id, guild_id, author_id) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(text("content"))
        .bind(id)
        .bind(text("channel_id"))
        .bind(text("guild_id"))
        .bind(text("author_id"))
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn rebuild_index(pool: &SqlitePool) -> ApiResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM messages_fts").execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO messages_fts (content, message_id, channel_id, guild_id, author_id) \
         SELECT content, id, channel_id, guild_id, author_id FROM messages WHERE deleted = 0",
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}
