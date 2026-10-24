
use crate::error::ApiResult;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::{json, Value};
use std::time::Duration;
use telium_protocol::curator_directory::{self as directory, Curator, Directory};
use telium_protocol::media_feed::Update;

const DIRECTORY_KEY_ID: &str = "ed25519:curator";

const REFRESH_BATCH: usize = 8;

pub async fn refresh(
    state: &AppState,
    url: &str,
    key: &str,
    label: Option<&str>,
) -> ApiResult<Option<String>> {
    sqlx::query(
        "INSERT INTO curator_directories (url, public_b64, label, attempted_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (url, public_b64) DO UPDATE SET label = excluded.label, \
         attempted_at = excluded.attempted_at",
    )
    .bind(url)
    .bind(key)
    .bind(label)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let refused = match fetch_verified(state, url, key).await {
        Ok((parsed, digest)) => adopt(state, url, key, &parsed, &digest).await?,
        Err(reason) => Some(reason),
    };
    if let Some(reason) = &refused {
        tracing::warn!(target: crate::logcat::FEDERATION, %url, %reason, "curator directory not adopted");
        sqlx::query("UPDATE curator_directories SET error = ? WHERE url = ? AND public_b64 = ?")
            .bind(reason)
            .bind(url)
            .bind(key)
            .execute(&state.pool)
            .await?;
    }
    Ok(refused)
}

async fn fetch_verified(
    state: &AppState,
    url: &str,
    key: &str,
) -> Result<(Directory, String), String> {
    let timeout = Duration::from_secs(state.cfg.media_registry.feed_timeout_secs.max(1));
    let bytes = super::feeds::fetch(state, url, directory::MAX_BYTES, timeout)
        .await
        .map_err(|e| e.to_string())?;
    let skew = state
        .cfg
        .federation
        .max_clock_skew_secs
        .saturating_mul(1000);
    let parsed = directory::verify(&bytes, key, now_ms(), skew).map_err(|e| e.to_string())?;
    if i64::try_from(parsed.serial).is_err() {
        return Err("directory serial is out of range".into());
    }
    let body = serde_json::to_vec(&parsed).map_err(|e| e.to_string())?;
    Ok((parsed, blake3::hash(&body).to_hex().to_string()))
}

async fn adopt(
    state: &AppState,
    url: &str,
    key: &str,
    parsed: &Directory,
    digest: &str,
) -> ApiResult<Option<String>> {
    let held: Option<(Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT serial, digest FROM curator_directories WHERE url = ? AND public_b64 = ?",
    )
    .bind(url)
    .bind(key)
    .fetch_optional(&state.pool)
    .await?;
    let held = held.and_then(|(serial, digest)| Some((serial? as u64, digest?)));
    let update = match directory::check_update(
        held.as_ref().map(|(s, d)| (*s, d.as_str())),
        parsed.serial,
        digest,
    ) {
        Ok(update) => update,
        Err(e) => return Ok(Some(e.to_string())),
    };
    let now = now_ms();
    if update == Update::Unchanged {
        sqlx::query(
            "UPDATE curator_directories SET fetched_at = ?, error = NULL WHERE url = ? AND public_b64 = ?",
        )
        .bind(now)
        .bind(url)
        .bind(key)
        .execute(&state.pool)
        .await?;
        return Ok(None);
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM curator_directory_entries WHERE url = ? AND public_b64 = ?")
        .bind(url)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    for entry in &parsed.curators {
        sqlx::query(
            "INSERT INTO curator_directory_entries \
             (url, public_b64, feed_url, feed_key, name, description, contact) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(url)
        .bind(key)
        .bind(&entry.feed_url)
        .bind(&entry.key)
        .bind(&entry.name)
        .bind(&entry.description)
        .bind(&entry.contact)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE curator_directories SET publisher = ?, serial = ?, digest = ?, issued_at = ?, \
         expires_at = ?, fetched_at = ?, error = NULL, curators = ? WHERE url = ? AND public_b64 = ?",
    )
    .bind(&parsed.publisher)
    .bind(parsed.serial as i64)
    .bind(digest)
    .bind(parsed.issued_at)
    .bind(parsed.expires_at)
    .bind(now)
    .bind(parsed.curators.len() as i64)
    .bind(url)
    .bind(key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(None)
}

fn subscriptions(state: &AppState) -> Vec<(String, String, Option<String>)> {
    state
        .cfg
        .media_registry
        .curator_directories
        .iter()
        .filter(|d| {
            !d.url.trim().is_empty()
                && telium_protocol::media_feed::is_public_key(&d.key)
                && super::feeds::check_url(state, &d.url).is_ok()
        })
        .map(|d| {
            (
                d.url.trim().to_string(),
                d.key.clone(),
                (!d.label.is_empty()).then(|| d.label.clone()),
            )
        })
        .collect()
}

pub async fn refresh_due(state: &AppState) -> ApiResult<usize> {
    let following = subscriptions(state);
    let kept: Vec<String> = following
        .iter()
        .map(|(url, key, _)| format!("{url}\u{1f}{key}"))
        .collect();
    for table in ["curator_directory_entries", "curator_directories"] {
        let rows: Vec<(String, String)> =
            sqlx::query_as(&format!("SELECT DISTINCT url, public_b64 FROM {table}"))
                .fetch_all(&state.pool)
                .await?;
        for (url, key) in rows {
            if !kept.contains(&format!("{url}\u{1f}{key}")) {
                sqlx::query(&format!(
                    "DELETE FROM {table} WHERE url = ? AND public_b64 = ?"
                ))
                .bind(&url)
                .bind(&key)
                .execute(&state.pool)
                .await?;
            }
        }
    }

    let now = now_ms();
    let every = state.cfg.media_registry.feed_refresh_secs.max(60) * 1000;
    let retry = state.cfg.media_registry.feed_retry_secs.max(30) * 1000;
    let mut done = 0;
    for (url, key, label) in following {
        if done >= REFRESH_BATCH {
            break;
        }
        let row: Option<(Option<i64>, Option<String>)> = sqlx::query_as(
            "SELECT attempted_at, error FROM curator_directories WHERE url = ? AND public_b64 = ?",
        )
        .bind(&url)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await?;
        let due = match row {
            None => true,
            Some((attempted, error)) => {
                let wait = if error.is_some() { retry } else { every };
                attempted.is_none_or(|at| at + wait <= now)
            }
        };
        if due {
            refresh(state, &url, &key, label.as_deref()).await?;
            done += 1;
        }
    }
    Ok(done)
}

pub async fn listing(state: &AppState) -> ApiResult<Vec<Value>> {
    for (url, key, label) in subscriptions(state) {
        let attempted: Option<Option<i64>> = sqlx::query_scalar(
            "SELECT attempted_at FROM curator_directories WHERE url = ? AND public_b64 = ?",
        )
        .bind(&url)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await?;
        if attempted.flatten().is_none() {
            refresh(state, &url, &key, label.as_deref()).await?;
        }
    }

    let mut out: Vec<Value> = local(state)
        .into_iter()
        .map(|c| {
            json!({
                "name": c.name, "feed": c.feed_url, "key": c.key,
                "description": c.description, "contact": c.contact,
                "source": state.cfg.server_name, "local": true,
            })
        })
        .collect();
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT e.feed_url, e.feed_key, e.name, e.description, e.contact, \
             COALESCE(d.label, d.publisher, d.url), d.expires_at \
             FROM curator_directory_entries e \
             JOIN curator_directories d ON d.url = e.url AND d.public_b64 = e.public_b64 \
             ORDER BY e.name",
    )
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    for (feed_url, feed_key, name, description, contact, source, expires_at) in rows {
        if expires_at.is_none_or(|at| at <= now) {
            continue;
        }
        if out
            .iter()
            .any(|c| c["feed"] == feed_url.as_str() && c["key"] == feed_key.as_str())
        {
            continue;
        }
        out.push(json!({
            "name": name, "feed": feed_url, "key": feed_key,
            "description": description, "contact": contact,
            "source": source, "local": false,
        }));
    }
    Ok(out)
}

fn local(state: &AppState) -> Vec<Curator> {
    state
        .cfg
        .media_registry
        .curators
        .iter()
        .filter_map(|c| {
            let entry = Curator {
                name: c.name.trim().to_string(),
                feed_url: c.feed_url.trim().to_string(),
                key: c.key.trim().to_string(),
                description: c.description.clone().filter(|d| !d.trim().is_empty()),
                contact: c.contact.clone().filter(|d| !d.trim().is_empty()),
            };
            (directory::is_feed_url(&entry.feed_url)
                && telium_protocol::media_feed::is_public_key(&entry.key)
                && telium_protocol::media_feed::is_display_text(
                    &entry.name,
                    telium_protocol::media_feed::MAX_NAME_CHARS,
                ))
            .then_some(entry)
        })
        .collect()
}

pub async fn published_at(state: &AppState) -> ApiResult<Value> {
    let key = super::media_feeds::curator(state).await?;
    Ok(json!({
        "url": format!("{}/_telium/v1/media/curators", state.cfg.public_base_url.trim_end_matches('/')),
        "key": key.public,
        "publisher": state.cfg.server_name,
    }))
}

pub async fn publish(state: &AppState) -> ApiResult<Value> {
    let key = super::media_feeds::curator(state).await?;
    let now = now_ms();
    let validity = state.cfg.media_registry.feed_validity_secs.max(60) * 1000;
    let body = Directory::new(
        &state.cfg.server_name,
        now as u64,
        now,
        now + validity,
        local(state),
    );
    Ok(directory::sign(&key.signing, DIRECTORY_KEY_ID, &body))
}
