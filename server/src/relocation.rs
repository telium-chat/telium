
use crate::config::Config;
use crate::crypto::{self, ServerKey};
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::state::AppState;
use crate::util::{b64, now_ms, unb64};
use axum::extract::{Path, State};
use axum::Json;
use ed25519_dalek::SigningKey;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Connection, SqliteConnection, SqlitePool};

pub const KIND: &str = "domain_relocation";

const RECHECK_MS: i64 = 10 * 60 * 1000;

pub const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct Relocation {
    pub old_domain: String,
    pub new_domain: String,
    pub old_key_id: String,
    pub new_key_id: String,
    pub new_key: String,
    pub effective_at: i64,
    pub announced_at: i64,
    pub record: Value,
}

fn plausible_domain(d: &str) -> bool {
    !d.is_empty()
        && d.len() <= 253
        && !d.starts_with(['.', '-', ':'])
        && d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b':')
}

fn text<'a>(v: &'a Value, k: &str) -> ApiResult<&'a str> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::BadRequest(format!("relocation record lacks {k}")))
}

pub fn parse(record: &Value) -> ApiResult<Relocation> {
    if record.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Err(ApiError::BadRequest("not a domain relocation record".into()));
    }
    let old_domain = text(record, "old_domain")?.to_string();
    let new_domain = text(record, "new_domain")?.to_string();
    for d in [&old_domain, &new_domain] {
        if federation::normalise_origin(d) != *d || !plausible_domain(d) {
            return Err(ApiError::BadRequest(format!("{d} is not a server name")));
        }
    }
    if old_domain == new_domain {
        return Err(ApiError::BadRequest("a domain cannot relocate to itself".into()));
    }
    let old_key_id = text(record, "old_key_id")?.to_string();
    // Use the key the body names, not one chosen elsewhere.
    if record.get("key_id").and_then(Value::as_str) != Some(old_key_id.as_str()) {
        return Err(ApiError::Forbidden(
            "relocation record is not signed with the old domain key it names".into(),
        ));
    }
    let new_key = text(record, "new_key")?.to_string();
    if unb64(&new_key).map(|k| k.len()) != Some(32) {
        return Err(ApiError::BadRequest(
            "relocation record carries a malformed successor key".into(),
        ));
    }
    text(record, "new_signature")?;
    text(record, "signature")?;
    Ok(Relocation {
        old_domain,
        new_domain,
        old_key_id,
        new_key_id: text(record, "new_key_id")?.to_string(),
        new_key,
        effective_at: record.get("effective_at").and_then(Value::as_i64).unwrap_or(0),
        announced_at: record
            .get("announced_at")
            .and_then(Value::as_i64)
            .ok_or_else(|| ApiError::BadRequest("relocation record lacks announced_at".into()))?,
        record: record.clone(),
    })
}

pub fn check_signatures(r: &Relocation, old_public: &str) -> ApiResult<()> {
    if !crypto::verify_json(old_public, &r.record) {
        return Err(ApiError::Forbidden(format!(
            "relocation record is not signed by {}'s key {}",
            r.old_domain, r.old_key_id
        )));
    }
    let mut body = r.record.clone();
    if let Some(obj) = body.as_object_mut() {
        let new_sig = obj.remove("new_signature").unwrap_or(Value::Null);
        obj.insert("key_id".into(), json!(r.new_key_id));
        obj.insert("signature".into(), new_sig);
    }
    if !crypto::verify_json(&r.new_key, &body) {
        return Err(ApiError::Forbidden(format!(
            "relocation record is not countersigned by the successor key for {}",
            r.new_domain
        )));
    }
    Ok(())
}

pub fn sign_record(old: &ServerKey, new: &ServerKey, body: Value) -> Value {
    let by_new = crypto::sign_json(new, body.clone());
    let mut body = body;
    body["new_signature"] = by_new["signature"].clone();
    crypto::sign_json(old, body)
}

pub async fn verify(state: &AppState, record: &Value) -> ApiResult<Relocation> {
    let r = parse(record)?;
    if r.announced_at > now_ms() + MAX_FUTURE_SKEW_MS {
        return Err(ApiError::Forbidden(format!(
            "relocation record for {} is dated in the future",
            r.old_domain
        )));
    }
    if let Some(key) = previous_name_key(state, &r.old_domain, &r.old_key_id, r.announced_at).await {
        check_signatures(&r, &key)?;
        return Ok(r);
    }
    let old_public = match federation::verify_key(state, &r.old_domain, &r.old_key_id).await {
        Some(current) => current,
        None => {
            if !old_domain_publishes(state, &r).await {
                return Err(ApiError::Forbidden(format!(
                    "{}'s key {} is not current, and {} does not publish this relocation",
                    r.old_domain, r.old_key_id, r.old_domain
                )));
            }
            federation::verify_key_at(state, &r.old_domain, &r.old_key_id, r.announced_at)
                .await
                .ok_or_else(|| {
                    ApiError::Forbidden(format!(
                        "{} publishes no key {} valid when this relocation was announced",
                        r.old_domain, r.old_key_id
                    ))
                })?
        }
    };
    check_signatures(&r, &old_public)?;
    Ok(r)
}

async fn old_domain_publishes(state: &AppState, r: &Relocation) -> bool {
    if federation::ensure_reachable(state, &r.old_domain, "all").await.is_err() {
        return false;
    }
    let Ok(seed) = federation::seed_base(state, &r.old_domain) else { return false };
    let Some(resp) = state
        .http
        .get(format!("{seed}/.well-known/telium/server"))
        .send()
        .await
        .ok()
        .filter(|resp| resp.status().is_success())
    else {
        return false;
    };
    let Ok(doc) = resp.json::<Value>().await else { return false };
    doc.get("server_name").and_then(Value::as_str) == Some(r.old_domain.as_str())
        && doc.get("relocation") == Some(&r.record)
}

pub async fn new_domain_confirms(state: &AppState, r: &Relocation) -> bool {
    if r.new_domain == state.cfg.server_name {
        return state.key.key_id == r.new_key_id && state.key.public_b64() == r.new_key;
    }
    federation::verify_key(state, &r.new_domain, &r.new_key_id).await.as_deref()
        == Some(r.new_key.as_str())
}

pub async fn learn(
    state: &AppState,
    record: &Value,
    via: Option<&str>,
) -> ApiResult<&'static str> {
    let r = parse(record)?;
    if let Some(via) = via {
        if via != r.old_domain && via != r.new_domain {
            return Err(ApiError::Forbidden(format!(
                "{via} may not announce a relocation of {}",
                r.old_domain
            )));
        }
    }
    if r.old_domain == state.cfg.server_name || r.new_domain == state.cfg.server_name {
        return Ok("local");
    }
    let existing: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT record, state, checked_at, local FROM domain_relocations WHERE old_domain = ?",
    )
    .bind(&r.old_domain)
    .fetch_optional(&state.pool)
    .await?;
    let now = now_ms();
    if let Some((known, known_state, checked_at, local)) = &existing {
        if *local != 0 {
            return Ok("local");
        }
        let same = serde_json::from_str::<Value>(known).ok().as_ref() == Some(record);
        if known_state == "applied" {
            if same {
                return Ok("applied");
            }
            return Err(ApiError::Conflict(format!("{} has already relocated", r.old_domain)));
        }
        if same && now - checked_at < RECHECK_MS && via.is_none() {
            return Ok("announced");
        }
    }

    let held = matches!(
        &existing,
        Some((known, known_state, _, _))
            if known_state == "announced"
                && serde_json::from_str::<Value>(known).ok().as_ref() == Some(record)
    );
    let r = if held { r } else { verify(state, record).await? };
    sqlx::query(
        "INSERT INTO domain_relocations \
             (old_domain, new_domain, record, state, local, effective_at, learned_at, checked_at) \
         VALUES (?, ?, ?, 'announced', 0, ?, ?, ?) \
         ON CONFLICT(old_domain) DO UPDATE SET new_domain = excluded.new_domain, \
             record = excluded.record, effective_at = excluded.effective_at, \
             checked_at = excluded.checked_at \
         WHERE domain_relocations.state = 'announced' AND domain_relocations.local = 0",
    )
    .bind(&r.old_domain)
    .bind(&r.new_domain)
    .bind(record.to_string())
    .bind(r.effective_at)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;

    if !Box::pin(new_domain_confirms(state, &r)).await {
        return Ok("announced");
    }
    apply_remote(state, &r).await?;
    Ok("applied")
}

async fn apply_remote(state: &AppState, r: &Relocation) -> ApiResult<()> {
    inherit_defederation(state, &r.old_domain, &r.new_domain).await?;
    let new_base = Box::pin(federation::known_base(state, &r.new_domain)).await?;
    sqlx::query("DELETE FROM remote_tombstones WHERE subject_type = 'domain' AND subject_id = ?")
        .bind(&r.old_domain)
        .execute(&state.pool)
        .await?;
    {
        let mut conn = state.pool.acquire().await?;
        remap(&mut conn, &r.old_domain, &r.new_domain, &new_base).await?;
    }
    let now = now_ms();
    sqlx::query(
        "INSERT INTO remote_servers (origin, api_base, gateway, fetched_at, failures, moved_to) \
         VALUES (?, ?, NULL, 0, 0, ?) \
         ON CONFLICT(origin) DO UPDATE SET moved_to = excluded.moved_to",
    )
    .bind(&r.old_domain)
    .bind(&new_base)
    .bind(&r.new_domain)
    .execute(&state.pool)
    .await?;
    federation::learn_tombstone(
        state,
        "domain",
        &r.old_domain,
        "moved",
        Some(&r.new_domain),
        &r.record,
    )
    .await?;
    sqlx::query(
        "UPDATE domain_relocations SET state = 'applied', applied_at = ?, checked_at = ? \
         WHERE old_domain = ?",
    )
    .bind(now)
    .bind(now)
    .bind(&r.old_domain)
    .execute(&state.pool)
    .await?;
    tracing::info!(target: crate::logcat::FEDERATION, old = %r.old_domain, new = %r.new_domain, "applied a peer's domain relocation");
    Ok(())
}

pub async fn recheck(state: &AppState) -> ApiResult<u64> {
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT record FROM domain_relocations \
         WHERE local = 0 AND state = 'announced' AND checked_at <= ? LIMIT 20",
    )
    .bind(now_ms() - RECHECK_MS)
    .fetch_all(&state.pool)
    .await?;
    let mut applied = 0;
    for record in due {
        let Ok(record) = serde_json::from_str::<Value>(&record) else { continue };
        match learn(state, &record, None).await {
            Ok("applied") => applied += 1,
            Ok(_) => {}
            Err(e) => tracing::debug!(target: crate::logcat::FEDERATION, error = %e, "relocation recheck failed"),
        }
    }
    Ok(applied)
}

pub async fn current_domain(state: &AppState, domain: &str) -> String {
    let mut current = federation::normalise_origin(domain);
    for _ in 0..8 {
        if current == state.cfg.server_name {
            break;
        }
        let next: Option<String> = sqlx::query_scalar(
            "SELECT new_domain FROM domain_relocations WHERE old_domain = ? AND state = 'applied'",
        )
        .bind(&current)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
        match next {
            Some(next) if next != current => current = next,
            _ => break,
        }
    }
    current
}

pub async fn chain(state: &AppState, domain: &str) -> Vec<String> {
    let start = federation::normalise_origin(domain);
    let mut seen = vec![start.clone()];
    let mut queue = vec![start];
    while let Some(name) = queue.pop() {
        if seen.len() >= 16 {
            break;
        }
        let neighbours: Vec<String> = sqlx::query_scalar(
            "SELECT new_domain FROM domain_relocations \
              WHERE old_domain = ? AND state = 'applied' \
             UNION \
             SELECT old_domain FROM domain_relocations \
              WHERE new_domain = ? AND state = 'applied'",
        )
        .bind(&name)
        .bind(&name)
        .fetch_all(&state.pool)
        .await
        .unwrap_or_default();
        for next in neighbours {
            if !seen.contains(&next) {
                seen.push(next.clone());
                queue.push(next);
            }
        }
    }
    seen
}

async fn inherit_defederation(state: &AppState, from: &str, to: &str) -> ApiResult<()> {
    if from == to || to == state.cfg.server_name {
        return Ok(());
    }
    let blocks: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT scope, reason FROM defederation WHERE domain = ?")
            .bind(from)
            .fetch_all(&state.pool)
            .await?;
    for (scope, reason) in blocks {
        let reason = match reason {
            Some(r) => format!("{r} (inherited from {from})"),
            None => format!("inherited from {from}"),
        };
        sqlx::query(
            "INSERT INTO defederation (domain, scope, reason, source, created_at) \
             VALUES (?, ?, ?, 'relocation', ?) \
             ON CONFLICT(domain) DO UPDATE SET \
                 scope = CASE WHEN excluded.scope = 'all' THEN 'all' \
                              ELSE defederation.scope END",
        )
        .bind(to)
        .bind(&scope)
        .bind(&reason)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
        tracing::info!(target: crate::logcat::FEDERATION, %from, %to, %scope, "carried a defederation across a relocation");
    }
    Ok(())
}

pub async fn spread_defederation(state: &AppState, domain: &str) -> ApiResult<()> {
    let domain = federation::normalise_origin(domain);
    for other in chain(state, &domain).await {
        if other != domain {
            inherit_defederation(state, &domain, &other).await?;
        }
    }
    Ok(())
}

pub async fn current_id(state: &AppState, id: &str) -> Option<String> {
    let (head, domain) = id.rsplit_once(':')?;
    let now = current_domain(state, domain).await;
    (now != domain).then(|| format!("{head}:{now}"))
}

pub async fn current_user_id(state: &AppState, user_id: String) -> String {
    match current_id(state, &user_id).await {
        Some(renamed) if federation::is_local(state, &renamed) => renamed,
        _ => user_id,
    }
}

pub fn rewrite_path(path: &str, old: &str, new: &str) -> String {
    let (path_part, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    let rewritten: Vec<String> = path_part
        .split('/')
        .map(|seg| {
            if seg == old {
                return new.to_string();
            }
            for sep in [":", "%3A", "%3a"] {
                if let Some(head) = seg.strip_suffix(&format!("{sep}{old}")) {
                    return format!("{head}{sep}{new}");
                }
            }
            seg.to_string()
        })
        .collect();
    let mut out = rewritten.join("/");
    if let Some(q) = query {
        out.push('?');
        out.push_str(q);
    }
    out
}

pub async fn follow(state: &AppState, destination: &str, path: &str) -> (String, String) {
    let destination = federation::normalise_origin(destination);
    let current = current_domain(state, &destination).await;
    if current == destination {
        let path = path.to_string();
        return (destination, path);
    }
    let path = rewrite_path(path, &destination, &current);
    (current, path)
}

pub async fn previous_name_key(
    state: &AppState,
    origin: &str,
    key_id: &str,
    at: i64,
) -> Option<String> {
    if origin == state.cfg.server_name {
        return None;
    }
    sqlx::query_scalar(
        "SELECT public_b64 FROM server_keys \
         WHERE domain = ? AND key_id = ? AND valid_from <= ? AND valid_until > ?",
    )
    .bind(origin)
    .bind(key_id)
    .bind(at)
    .bind(at)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

const SKIP_TABLES: &[&str] = &[
    "server_keys",
    "remote_keys",
    "remote_servers",
    "domain_relocations",
    "relocation_deliveries",
    "server_meta",
    "repl_log",
    "repl_ack",
    "replica_state",
    "cold_segments",
    "failover",
    "migrations",
    "opaque_server_state",
    "opaque_login_attempts",
    "vapid_key",
];

fn skip_column(table: &str, column: &str) -> bool {
    let c = column.to_ascii_lowercase();
    [
        "sig", "record", "proof", "authorization", "secret", "hash", "token", "ciphertext",
        "password", "opaque", "_json", "welcome",
    ]
    .iter()
    .any(|p| c.contains(p))
        || (table == "messages" && (c == "content" || c == "attachments"))
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub async fn remap(
    conn: &mut SqliteConnection,
    old: &str,
    new: &str,
    new_base: &str,
) -> ApiResult<u64> {
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await?;
    let result = remap_inner(conn, old, new, new_base).await;
    let restored = sqlx::query("PRAGMA foreign_keys = ON").execute(&mut *conn).await;
    let changed = result?;
    restored?;
    Ok(changed)
}

async fn remap_inner(
    conn: &mut SqliteConnection,
    old: &str,
    new: &str,
    new_base: &str,
) -> ApiResult<u64> {
    let mut tx = conn.begin().await?;
    let mut changed = rewrite_attachments(&mut tx, old, new, new_base).await?;

    let tables: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .fetch_all(&mut *tx)
            .await?;
    let suffix_pattern = format!("%:{}", like_escape(old));
    let old_len = old.len() as i64;
    for (table, sql) in tables {
        let sql = sql.unwrap_or_default().to_ascii_uppercase();
        if table.starts_with("sqlite_")
            || table.starts_with("_sqlx")
            || table.contains("_fts")
            || sql.starts_with("CREATE VIRTUAL")
            || SKIP_TABLES.contains(&table.as_str())
        {
            continue;
        }
        let columns: Vec<(i64, String, String, i64, Option<String>, i64)> =
            sqlx::query_as(&format!("PRAGMA table_info({})", quote_ident(&table)))
                .fetch_all(&mut *tx)
                .await?;
        for (_, column, ty, _, _, _) in columns {
            let ty = ty.to_ascii_uppercase();
            if !(ty.is_empty() || ty.contains("TEXT") || ty.contains("CHAR"))
                || skip_column(&table, &column)
            {
                continue;
            }
            let t = quote_ident(&table);
            let c = quote_ident(&column);
            let exact = sqlx::query(&format!("UPDATE OR IGNORE {t} SET {c} = ? WHERE {c} = ?"))
                .bind(new)
                .bind(old)
                .execute(&mut *tx)
                .await?;
            let suffix = sqlx::query(&format!(
                "UPDATE OR IGNORE {t} SET {c} = substr({c}, 1, length({c}) - ?) || ? \
                 WHERE {c} LIKE ? ESCAPE '\\' AND substr({c}, 1, 1) NOT IN ('[', '{{')"
            ))
            .bind(old_len)
            .bind(new)
            .bind(&suffix_pattern)
            .execute(&mut *tx)
            .await?;
            let json = sqlx::query(&format!(
                "UPDATE OR IGNORE {t} SET {c} = \
                     replace(replace(replace({c}, ?, ?), ?, ?), ?, ?) \
                 WHERE substr({c}, 1, 1) IN ('[', '{{') AND instr({c}, ?) > 0"
            ))
            .bind(format!(":{old}\""))
            .bind(format!(":{new}\""))
            .bind(format!("\"{old}\""))
            .bind(format!("\"{new}\""))
            .bind(format!("media://{old}/"))
            .bind(format!("media://{new}/"))
            .bind(old)
            .execute(&mut *tx)
            .await?;
            changed += exact.rows_affected() + suffix.rows_affected() + json.rows_affected();
        }
    }
    tx.commit().await?;

    let dangling: Vec<(String, Option<i64>, String, i64)> =
        sqlx::query_as("PRAGMA foreign_key_check").fetch_all(&mut *conn).await?;
    if !dangling.is_empty() {
        tracing::warn!(target: crate::logcat::FEDERATION, count = dangling.len(), %old, %new, "rows left dangling by a domain rewrite");
    }
    Ok(changed)
}

async fn rewrite_attachments(
    conn: &mut SqliteConnection,
    old: &str,
    new: &str,
    new_base: &str,
) -> ApiResult<u64> {
    let pattern = format!("%{}%", like_escape(old));
    let mut after = String::new();
    let mut changed = 0;
    loop {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, attachments FROM messages \
             WHERE id > ? AND attachments LIKE ? ESCAPE '\\' ORDER BY id LIMIT 500",
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
                if att.get("external").and_then(Value::as_bool) == Some(true)
                    || att.get("origin").and_then(Value::as_str) != Some(old)
                {
                    continue;
                }
                let hash = att.get("hash").and_then(Value::as_str).unwrap_or_default().to_string();
                let Some(obj) = att.as_object_mut() else { continue };
                obj.insert("origin".into(), json!(new));
                if !hash.is_empty() {
                    obj.insert("reference".into(), json!(format!("media://{new}/{hash}")));
                }
                if let Some(url) = obj.get("url").and_then(Value::as_str) {
                    if let Some(at) = url.find("/_telium/v1/media/") {
                        let rebuilt = format!("{}{}", new_base.trim_end_matches('/'), &url[at..]);
                        obj.insert("url".into(), json!(rebuilt));
                    }
                }
                touched = true;
            }
            if touched {
                sqlx::query("UPDATE messages SET attachments = ? WHERE id = ?")
                    .bind(parsed.to_string())
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
                changed += 1;
            }
        }
    }
    Ok(changed)
}

fn key_from_row(
    key_id: String,
    secret_b64: &str,
    valid_from: i64,
    valid_until: i64,
) -> ApiResult<ServerKey> {
    let bytes: [u8; 32] = unb64(secret_b64)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("stored key {key_id} is malformed")))?;
    Ok(ServerKey { key_id, signing: SigningKey::from_bytes(&bytes), valid_from, valid_until })
}

pub async fn announce(
    state: &AppState,
    new_domain: &str,
    effective_at: i64,
    message: Option<&str>,
) -> ApiResult<Value> {
    let new_domain = federation::normalise_origin(new_domain);
    if !plausible_domain(&new_domain) {
        return Err(ApiError::BadRequest(format!("{new_domain} is not a server name")));
    }
    if new_domain == state.cfg.server_name {
        return Err(ApiError::BadRequest("a server cannot relocate to its own name".into()));
    }
    if state.signing_origin.as_str() != state.cfg.server_name {
        return Err(ApiError::Conflict(
            "a standby cannot relocate the server it stands in for".into(),
        ));
    }
    let now = now_ms();

    let previous: Option<String> = sqlx::query_scalar(
        "SELECT new_domain FROM domain_relocations \
         WHERE old_domain = ? AND local = 1 AND state = 'announced'",
    )
    .bind(&state.cfg.server_name)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(previous) = previous.filter(|p| *p != new_domain) {
        sqlx::query("DELETE FROM server_keys WHERE domain = ?")
            .bind(&previous)
            .execute(&state.pool)
            .await?;
    }

    let existing: Option<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT key_id, secret_b64, valid_from, valid_until FROM server_keys WHERE domain = ?",
    )
    .bind(&new_domain)
    .fetch_optional(&state.pool)
    .await?;
    let successor = match existing {
        Some((key_id, secret, from, until)) => key_from_row(key_id, &secret, from, until)?,
        None => {
            let secret: [u8; 32] = rand::random();
            let validity = state.cfg.sessions.signing_key_validity_secs * 1000;
            let key = ServerKey {
                key_id: format!("ed25519:{}", crate::util::random_token(6)),
                signing: SigningKey::from_bytes(&secret),
                valid_from: now,
                valid_until: now.max(effective_at) + validity,
            };
            sqlx::query(
                "INSERT INTO server_keys \
                     (key_id, secret_b64, public_b64, valid_from, valid_until, domain) \
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&key.key_id)
            .bind(b64(&secret))
            .bind(key.public_b64())
            .bind(key.valid_from)
            .bind(key.valid_until)
            .bind(&new_domain)
            .execute(&state.pool)
            .await?;
            key
        }
    };

    let body = json!({
        "kind": KIND,
        "old_domain": state.cfg.server_name,
        "new_domain": new_domain,
        "old_key_id": state.key.key_id,
        "new_key_id": successor.key_id,
        "new_key": successor.public_b64(),
        "effective_at": effective_at,
        "announced_at": now,
        "message": message,
    });
    let record = sign_record(&state.key, &successor, body);

    sqlx::query(
        "INSERT INTO domain_relocations \
             (old_domain, new_domain, record, state, local, effective_at, learned_at, checked_at) \
         VALUES (?, ?, ?, 'announced', 1, ?, ?, ?) \
         ON CONFLICT(old_domain) DO UPDATE SET new_domain = excluded.new_domain, \
             record = excluded.record, state = 'announced', local = 1, \
             effective_at = excluded.effective_at, learned_at = excluded.learned_at",
    )
    .bind(&state.cfg.server_name)
    .bind(&new_domain)
    .bind(record.to_string())
    .bind(effective_at)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    queue_deliveries(
        &state.pool,
        &state.cfg.server_name,
        "announced",
        &[&state.cfg.server_name, &new_domain],
    )
    .await?;
    Ok(record)
}

pub async fn cancel(state: &AppState) -> ApiResult<()> {
    let pending: Option<String> = sqlx::query_scalar(
        "SELECT new_domain FROM domain_relocations \
         WHERE old_domain = ? AND local = 1 AND state = 'announced'",
    )
    .bind(&state.cfg.server_name)
    .fetch_optional(&state.pool)
    .await?;
    let Some(new_domain) = pending else { return Ok(()) };
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM server_keys WHERE domain = ?")
        .bind(&new_domain)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM domain_relocations WHERE old_domain = ?")
        .bind(&state.cfg.server_name)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM relocation_deliveries WHERE old_domain = ?")
        .bind(&state.cfg.server_name)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn queue_deliveries(
    pool: &SqlitePool,
    old_domain: &str,
    stage: &str,
    except: &[&str],
) -> ApiResult<()> {
    let peers: Vec<String> = sqlx::query_scalar("SELECT origin FROM remote_servers")
        .fetch_all(pool)
        .await?;
    let now = now_ms();
    for peer in peers {
        if except.contains(&peer.as_str()) {
            continue;
        }
        sqlx::query(
            "INSERT INTO relocation_deliveries (old_domain, peer, stage, attempts, next_at) \
             VALUES (?, ?, ?, 0, ?) \
             ON CONFLICT(old_domain, peer, stage) DO UPDATE SET attempts = 0, \
                 next_at = excluded.next_at, delivered_at = NULL, last_error = NULL",
        )
        .bind(old_domain)
        .bind(&peer)
        .bind(stage)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}

pub async fn apply_local_rename(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<Option<String>> {
    let pending: Option<(String, String)> = sqlx::query_as(
        "SELECT old_domain, record FROM domain_relocations \
         WHERE local = 1 AND state = 'announced' AND new_domain = ?",
    )
    .bind(&cfg.server_name)
    .fetch_optional(pool)
    .await?;
    let Some((old, record)) = pending else { return Ok(None) };
    let new = cfg.server_name.clone();
    let successor: Option<String> =
        sqlx::query_scalar("SELECT key_id FROM server_keys WHERE domain = ?")
            .bind(&new)
            .fetch_optional(pool)
            .await?;
    let Some(successor) = successor else {
        anyhow::bail!("a relocation from {old} to {new} was announced, but its successor key is gone");
    };
    tracing::info!(target: crate::logcat::FEDERATION, %old, %new, "renaming this server for its announced relocation");

    sqlx::query(
        "UPDATE accounts SET opaque_identifier = user_id \
         WHERE opaque_identifier IS NULL AND opaque_record IS NOT NULL",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "UPDATE migrations SET state = 'failed', \
             detail = 'this server relocated to a new domain before the move ran; start it again' \
         WHERE state IN ('pending', 'ready') AND subject_id LIKE ?",
    )
    .bind(format!("%:{old}"))
    .execute(pool)
    .await?;

    sqlx::query("DELETE FROM tombstones WHERE subject_type = 'domain' AND subject_id = ?")
        .bind(&old)
        .execute(pool)
        .await?;
    {
        let mut conn = pool.acquire().await?;
        remap(&mut conn, &old, &new, cfg.public_base_url.trim_end_matches('/'))
            .await
            .map_err(|e| anyhow::anyhow!("rewriting {old} to {new} failed: {e}"))?;
    }

    let now = now_ms();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE server_keys SET domain = ? WHERE domain IS NULL")
        .bind(&old)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE server_keys SET domain = NULL WHERE key_id = ?")
        .bind(&successor)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
         VALUES ('domain', ?, 'moved', ?, ?, ?) \
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET kind = excluded.kind, \
             new_id = excluded.new_id, record = excluded.record, created_at = excluded.created_at",
    )
    .bind(&old)
    .bind(&new)
    .bind(&record)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE domain_relocations SET state = 'applied', applied_at = ? WHERE old_domain = ?",
    )
    .bind(now)
    .bind(&old)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM server_meta WHERE key = 'sunset'")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    queue_deliveries(pool, &old, "applied", &[&old, &new])
        .await
        .map_err(|e| anyhow::anyhow!("queueing relocation notices failed: {e}"))?;
    Ok(Some(old))
}

pub async fn flush(state: &AppState) -> ApiResult<u64> {
    let now = now_ms();
    let due: Vec<(String, String, String, i64, String)> = sqlx::query_as(
        "SELECT d.old_domain, d.peer, d.stage, d.attempts, r.record \
         FROM relocation_deliveries d JOIN domain_relocations r ON r.old_domain = d.old_domain \
         WHERE r.local = 1 AND d.delivered_at IS NULL AND d.next_at <= ? LIMIT 50",
    )
    .bind(now)
    .fetch_all(&state.pool)
    .await?;
    let mut delivered = 0;
    for (old, peer, stage, attempts, record) in due {
        let record: Value = serde_json::from_str(&record).unwrap_or(Value::Null);
        let outcome = federation::post_signed(
            state,
            &peer,
            "/_telium/v1/relocation",
            &json!({ "record": record }),
        )
        .await;
        match outcome {
            Ok(_) => {
                sqlx::query(
                    "UPDATE relocation_deliveries SET delivered_at = ?, last_error = NULL \
                     WHERE old_domain = ? AND peer = ? AND stage = ?",
                )
                .bind(now_ms())
                .bind(&old)
                .bind(&peer)
                .bind(&stage)
                .execute(&state.pool)
                .await?;
                delivered += 1;
            }
            Err(e) => {
                let backoff = (60_000i64 << attempts.clamp(0, 8)).min(6 * 3600 * 1000);
                sqlx::query(
                    "UPDATE relocation_deliveries \
                     SET attempts = attempts + 1, next_at = ?, last_error = ? \
                     WHERE old_domain = ? AND peer = ? AND stage = ?",
                )
                .bind(now_ms() + backoff)
                .bind(e.to_string())
                .bind(&old)
                .bind(&peer)
                .bind(&stage)
                .execute(&state.pool)
                .await?;
            }
        }
    }
    Ok(delivered)
}

pub async fn announced(state: &AppState) -> ApiResult<Option<Value>> {
    let record: Option<String> = sqlx::query_scalar(
        "SELECT record FROM domain_relocations \
         WHERE old_domain = ? AND local = 1 AND state = 'announced'",
    )
    .bind(&state.cfg.server_name)
    .fetch_optional(&state.pool)
    .await?;
    Ok(record.and_then(|r| serde_json::from_str(&r).ok()))
}

pub async fn previous_domain_document(state: &AppState, old: &str) -> ApiResult<Option<Value>> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT new_domain, record FROM domain_relocations \
         WHERE old_domain = ? AND local = 1 AND state = 'applied'",
    )
    .bind(old)
    .fetch_optional(&state.pool)
    .await?;
    let Some((new_domain, record)) = row else { return Ok(None) };
    let record: Value = serde_json::from_str(&record).unwrap_or(Value::Null);
    let keys: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT key_id, secret_b64, public_b64, valid_from, valid_until FROM server_keys \
         WHERE domain = ? ORDER BY valid_from",
    )
    .bind(old)
    .fetch_all(&state.pool)
    .await?;
    let Some((last_id, last_secret, _, last_from, last_until)) = keys.last().cloned() else {
        return Ok(None);
    };
    let mut verify_keys = serde_json::Map::new();
    for (key_id, _, public, from, until) in &keys {
        verify_keys.insert(
            key_id.clone(),
            json!({ "key": public, "valid_from": from, "valid_until": until }),
        );
    }
    let signer = key_from_row(last_id.clone(), &last_secret, last_from, last_until)?;
    let key_document = crypto::sign_json(
        &signer,
        json!({
            "server_name": old,
            "signer": old,
            "authority": Value::Null,
            "current_key_id": last_id,
            "verify_keys": Value::Object(verify_keys),
            "generated_at": now_ms(),
        }),
    );
    let base = state.cfg.public_base_url.trim_end_matches('/');
    Ok(Some(json!({
        "server_name": old,
        "api": base,
        "gateway": format!("{}/gateway/v1", base.replace("http", "ws")),
        "protocol_version": "v1",
        "moved_to": new_domain,
        "relocation": record,
        "keys": key_document,
    })))
}

pub async fn previous_name_for_host(
    state: &AppState,
    headers: &axum::http::HeaderMap,
) -> Option<String> {
    let host = headers.get(axum::http::header::HOST)?.to_str().ok()?;
    let host = federation::normalise_origin(host);
    let bare = host.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_default();
    for name in [host, bare] {
        if name.is_empty() || name == state.cfg.server_name {
            continue;
        }
        let hit: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM domain_relocations \
             WHERE old_domain = ? AND local = 1 AND state = 'applied'",
        )
        .bind(&name)
        .fetch_optional(&state.pool)
        .await
        .ok()
        .flatten();
        if hit.is_some() {
            return Some(name);
        }
    }
    None
}

#[derive(Deserialize)]
pub struct Notice {
    pub record: Value,
}

pub async fn inbound(State(state): State<AppState>, fed: Fed<Notice>) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "all").await?;
    let outcome = learn(&state, &fed.body.record, Some(&fed.origin)).await?;
    Ok(Json(json!({ "state": outcome })))
}

pub async fn status(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, i64, Option<i64>, String)> = sqlx::query_as(
        "SELECT old_domain, new_domain, state, effective_at, applied_at, record \
         FROM domain_relocations WHERE local = 1 ORDER BY learned_at",
    )
    .fetch_all(&state.pool)
    .await?;
    let relocations: Vec<Value> = rows
        .into_iter()
        .map(|(old, new, st, effective_at, applied_at, record)| {
            json!({
                "old_domain": old,
                "new_domain": new,
                "state": st,
                "effective_at": effective_at,
                "applied_at": applied_at,
                "record": serde_json::from_str::<Value>(&record).unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Json(json!({ "server_name": state.cfg.server_name, "relocations": relocations })))
}

pub async fn discovery(
    State(state): State<AppState>,
    Path(old): Path<String>,
) -> ApiResult<Json<Value>> {
    let old = federation::normalise_origin(&old);
    previous_domain_document(&state, &old)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("this server was never called {old}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str) -> ServerKey {
        ServerKey {
            key_id: id.into(),
            signing: SigningKey::from_bytes(&rand::random()),
            valid_from: 0,
            valid_until: i64::MAX,
        }
    }

    fn body(old: &ServerKey, new: &ServerKey) -> Value {
        json!({
            "kind": KIND,
            "old_domain": "old.example",
            "new_domain": "new.example",
            "old_key_id": old.key_id,
            "new_key_id": new.key_id,
            "new_key": new.public_b64(),
            "effective_at": 1,
            "announced_at": 1,
        })
    }

    #[test]
    fn a_record_signed_by_both_keys_verifies() {
        let (old, new) = (key("ed25519:old"), key("ed25519:new"));
        let record = sign_record(&old, &new, body(&old, &new));
        let r = parse(&record).unwrap();
        check_signatures(&r, &old.public_b64()).unwrap();
    }

    #[test]
    fn a_record_not_signed_by_the_old_key_is_refused() {
        let (old, new, forger) = (key("ed25519:old"), key("ed25519:new"), key("ed25519:old"));
        let record = sign_record(&forger, &new, body(&old, &new));
        let r = parse(&record).unwrap();
        assert!(check_signatures(&r, &old.public_b64()).is_err());
    }

    #[test]
    fn a_record_the_successor_did_not_countersign_is_refused() {
        let (old, new, other) = (key("ed25519:old"), key("ed25519:new"), key("ed25519:new"));
        let record = sign_record(&old, &other, body(&old, &new));
        let r = parse(&record).unwrap();
        assert!(check_signatures(&r, &old.public_b64()).is_err());
    }

    #[test]
    fn an_edited_destination_breaks_the_signatures() {
        let (old, new) = (key("ed25519:old"), key("ed25519:new"));
        let mut record = sign_record(&old, &new, body(&old, &new));
        record["new_domain"] = json!("victim.example");
        let r = parse(&record).unwrap();
        assert!(check_signatures(&r, &old.public_b64()).is_err());
    }

    #[test]
    fn the_outer_signature_must_be_made_with_the_key_the_body_names() {
        let (old, new, other) = (key("ed25519:old"), key("ed25519:new"), key("ed25519:other"));
        let record = sign_record(&other, &new, body(&old, &new));
        assert!(parse(&record).is_err());
    }

    #[test]
    fn a_domain_cannot_relocate_to_itself() {
        let (old, new) = (key("ed25519:old"), key("ed25519:new"));
        let mut b = body(&old, &new);
        b["new_domain"] = json!("old.example");
        assert!(parse(&sign_record(&old, &new, b)).is_err());
    }

    #[test]
    fn paths_follow_the_new_name_only_where_it_names_a_server() {
        assert_eq!(
            rewrite_path("/_telium/v1/users/@alice:old.example/status", "old.example", "new.example"),
            "/_telium/v1/users/@alice:new.example/status"
        );
        assert_eq!(
            rewrite_path("/_telium/v1/users/%40alice%3Aold.example", "old.example", "new.example"),
            "/_telium/v1/users/%40alice%3Anew.example"
        );
        assert_eq!(
            rewrite_path("/_telium/v1/failover/status/old.example", "old.example", "new.example"),
            "/_telium/v1/failover/status/new.example"
        );
        assert_eq!(
            rewrite_path("/_telium/v1/users/@alice:notold.example/x", "old.example", "new.example"),
            "/_telium/v1/users/@alice:notold.example/x"
        );
    }
}
