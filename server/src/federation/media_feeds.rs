
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, now_ms, unb64};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use telium_protocol::media_feed::{self as feed, Action, Entry, Feed, FeedError, Rotation, Update};

pub const MAX_SUBSCRIPTIONS: usize = 8;

const MANUAL_REFRESH_FLOOR_MS: i64 = 60_000;

const REFRESH_BATCH: usize = 32;

const CURATOR_KEY_ID: &str = "ed25519:curator";

pub fn validate_subscription(state: &AppState, url: &str, key: &str) -> ApiResult<()> {
    super::feeds::check_url(state, url)?;
    if !feed::is_public_key(key) {
        return Err(ApiError::BadRequest(format!(
            "the rule for feed {url} has to pin its curator's Ed25519 public key \
             (\"key\", base64): a feed is only trusted with the key its subscriber chose"
        )));
    }
    Ok(())
}

pub async fn refresh(state: &AppState, url: &str, key: &str) -> ApiResult<Option<String>> {
    sqlx::query(
        "INSERT INTO media_feeds (url, public_b64, attempted_at) VALUES (?, ?, ?) \
         ON CONFLICT (url, public_b64) DO UPDATE SET attempted_at = excluded.attempted_at",
    )
    .bind(url)
    .bind(key)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let pin = load_pin(state, url, key).await?;
    let refused = match fetch_verified(state, url, &pin).await {
        Ok(verified) => adopt(state, url, &pin, verified).await?,
        Err(reason) => Some(reason),
    };
    if let Some(reason) = &refused {
        tracing::warn!(target: crate::logcat::MEDIA, %url, %reason, "media origin feed not adopted");
        sqlx::query("UPDATE media_feeds SET error = ? WHERE url = ? AND public_b64 = ?")
            .bind(reason)
            .bind(url)
            .bind(key)
            .execute(&state.pool)
            .await?;
    }
    Ok(refused)
}

struct Pin {
    anchor: String,
    active: String,
    rotation: u64,
    next: Option<(String, u64)>,
    retired: Vec<String>,
}

async fn load_pin(state: &AppState, url: &str, anchor: &str) -> ApiResult<Pin> {
    let row: Option<(Option<String>, i64, Option<String>, Option<i64>)> = sqlx::query_as(
        "SELECT active_b64, rotation, next_b64, next_rotation FROM media_feeds \
         WHERE url = ? AND public_b64 = ?",
    )
    .bind(url)
    .bind(anchor)
    .fetch_optional(&state.pool)
    .await?;
    let (active, rotation, next_key, next_rotation) = row.unwrap_or((None, 0, None, None));
    let retired: Vec<String> = sqlx::query_scalar(
        "SELECT retired_b64 FROM media_feed_retired_keys WHERE url = ? AND public_b64 = ?",
    )
    .bind(url)
    .bind(anchor)
    .fetch_all(&state.pool)
    .await?;
    Ok(Pin {
        anchor: anchor.to_string(),
        active: active.unwrap_or_else(|| anchor.to_string()),
        rotation: rotation.max(0) as u64,
        next: next_key
            .zip(next_rotation)
            .map(|(k, r)| (k, r.max(0) as u64)),
        retired,
    })
}

struct Verified {
    feed: Feed,
    digest: String,
    signed_by: String,
}

async fn fetch_verified(state: &AppState, url: &str, pin: &Pin) -> Result<Verified, String> {
    let timeout = Duration::from_secs(state.cfg.media_registry.feed_timeout_secs.max(1));
    let bytes = super::feeds::fetch(state, url, feed::MAX_BYTES, timeout)
        .await
        .map_err(|e| e.to_string())?;
    let skew = state
        .cfg
        .federation
        .max_clock_skew_secs
        .saturating_mul(1000);
    // Successor key is tried only if the signature alone fails.
    let (parsed, signed_by) = match feed::verify(&bytes, &pin.active, now_ms(), skew) {
        Ok(parsed) => (parsed, pin.active.clone()),
        Err(FeedError::BadSignature) => match &pin.next {
            Some((next, _)) => (
                feed::verify(&bytes, next, now_ms(), skew).map_err(|e| lapsed(&e))?,
                next.clone(),
            ),
            None => return Err(lapsed(&FeedError::BadSignature)),
        },
        Err(e) => return Err(e.to_string()),
    };
    if i64::try_from(parsed.serial).is_err() {
        return Err("feed serial is out of range".into());
    }
    let body = serde_json::to_vec(&parsed).map_err(|e| e.to_string())?;
    Ok(Verified {
        feed: parsed,
        digest: blake3::hash(&body).to_hex().to_string(),
        signed_by,
    })
}

fn lapsed(e: &FeedError) -> String {
    match e {
        FeedError::BadSignature => "feed signature does not verify against the curator key this \
             guild follows; if the curator rotated its key without publishing a signed rollover \
             under the old one, re-pin the subscription by hand after checking the new key"
            .to_string(),
        other => other.to_string(),
    }
}

async fn adopt(
    state: &AppState,
    url: &str,
    pin: &Pin,
    verified: Verified,
) -> ApiResult<Option<String>> {
    let Verified {
        feed: parsed,
        digest,
        signed_by,
    } = verified;
    let key = pin.anchor.as_str();
    let held: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT serial, digest FROM media_feeds WHERE url = ? AND public_b64 = ?")
            .bind(url)
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
    let held = held.and_then(|(serial, digest)| Some((serial? as u64, digest?)));
    // Serial is checked before rotation and survives key changes.
    let update = match feed::check_update(
        held.as_ref().map(|(s, d)| (*s, d.as_str())),
        parsed.serial,
        &digest,
    ) {
        Ok(update) => update,
        Err(e) => return Ok(Some(e.to_string())),
    };
    let now = now_ms();

    let mut tx = state.pool.begin().await?;
    let mut retired = pin.retired.clone();
    let (active, rotation) = match &pin.next {
        Some((next, next_rotation)) if *next == signed_by => {
            sqlx::query(
                "INSERT INTO media_feed_retired_keys \
                 (url, public_b64, retired_b64, rotation, retired_at) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT DO NOTHING",
            )
            .bind(url)
            .bind(key)
            .bind(&pin.active)
            .bind(*next_rotation as i64)
            .bind(now)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "UPDATE media_feeds SET active_b64 = ?, rotation = ?, next_b64 = NULL, \
                 next_rotation = NULL, next_seen_at = NULL WHERE url = ? AND public_b64 = ?",
            )
            .bind(next)
            .bind(*next_rotation as i64)
            .bind(url)
            .bind(key)
            .execute(&mut *tx)
            .await?;
            tracing::info!(target: crate::logcat::MEDIA, %url, rotation = next_rotation, "media origin feed curator key rotated");
            retired.push(pin.active.clone());
            (next.clone(), *next_rotation)
        }
        _ => (pin.active.clone(), pin.rotation),
    };

    let announced = pin
        .next
        .as_ref()
        .filter(|(k, _)| *k != signed_by)
        .map(|(k, r)| (k.as_str(), *r));
    match feed::check_rollover(
        parsed.rollover.as_ref(),
        &active,
        rotation,
        announced,
        &retired,
    ) {
        Ok(Rotation::Settled) => {}
        Ok(Rotation::Announce { to_key, rotation }) => {
            sqlx::query(
                "UPDATE media_feeds SET next_b64 = ?, next_rotation = ?, next_seen_at = ? \
                 WHERE url = ? AND public_b64 = ?",
            )
            .bind(to_key)
            .bind(rotation as i64)
            .bind(now)
            .bind(url)
            .bind(key)
            .execute(&mut *tx)
            .await?;
        }
        Err(e) => return Ok(Some(e.to_string())),
    }

    if update == Update::Unchanged {
        sqlx::query(
            "UPDATE media_feeds SET fetched_at = ?, error = NULL WHERE url = ? AND public_b64 = ?",
        )
        .bind(now)
        .bind(url)
        .bind(key)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(None);
    }

    sqlx::query("DELETE FROM media_feed_hosts WHERE url = ? AND public_b64 = ?")
        .bind(url)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    for entry in &parsed.entries {
        sqlx::query(
            "INSERT INTO media_feed_hosts \
             (url, public_b64, origin, action, name, description, max_file_bytes, abuse_contact) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(url)
        .bind(key)
        .bind(&entry.origin)
        .bind(entry.action.as_str())
        .bind(&entry.name)
        .bind(&entry.description)
        .bind(entry.max_file_bytes)
        .bind(&entry.abuse_contact)
        .execute(&mut *tx)
        .await?;
    }
    let blocks = parsed
        .entries
        .iter()
        .filter(|e| e.action == Action::Block)
        .count() as i64;
    sqlx::query(
        "UPDATE media_feeds SET curator = ?, serial = ?, digest = ?, issued_at = ?, expires_at = ?, \
         fetched_at = ?, error = NULL, allows = ?, blocks = ? WHERE url = ? AND public_b64 = ?",
    )
    .bind(&parsed.curator)
    .bind(parsed.serial as i64)
    .bind(&digest)
    .bind(parsed.issued_at)
    .bind(parsed.expires_at)
    .bind(now)
    .bind(parsed.entries.len() as i64 - blocks)
    .bind(blocks)
    .bind(url)
    .bind(key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(None)
}

pub async fn refresh_due(state: &AppState) -> ApiResult<usize> {
    sqlx::query(
        "DELETE FROM media_feed_hosts WHERE NOT EXISTS (SELECT 1 FROM guild_origin_rules r \
         WHERE r.feed_url = media_feed_hosts.url AND r.feed_key = media_feed_hosts.public_b64)",
    )
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "DELETE FROM media_feed_retired_keys WHERE NOT EXISTS (SELECT 1 FROM guild_origin_rules r \
         WHERE r.feed_url = media_feed_retired_keys.url \
         AND r.feed_key = media_feed_retired_keys.public_b64)",
    )
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "DELETE FROM media_feeds WHERE NOT EXISTS (SELECT 1 FROM guild_origin_rules r \
         WHERE r.feed_url = media_feeds.url AND r.feed_key = media_feeds.public_b64)",
    )
    .execute(&state.pool)
    .await?;

    let rows: Vec<(String, String, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT r.feed_url, r.feed_key, f.attempted_at, f.error FROM guild_origin_rules r \
         LEFT JOIN media_feeds f ON f.url = r.feed_url AND f.public_b64 = r.feed_key \
         WHERE r.feed_url IS NOT NULL AND r.feed_key IS NOT NULL",
    )
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    let every = state.cfg.media_registry.feed_refresh_secs.max(60) * 1000;
    let retry = state.cfg.media_registry.feed_retry_secs.max(30) * 1000;
    let due: Vec<(String, String)> = rows
        .into_iter()
        .filter(|(_, _, attempted, error)| {
            let wait = if error.is_some() { retry } else { every };
            attempted.is_none_or(|at| at + wait <= now)
        })
        .map(|(url, key, _, _)| (url, key))
        .take(REFRESH_BATCH)
        .collect();
    for (url, key) in &due {
        refresh(state, url, key).await?;
    }
    Ok(due.len())
}

pub async fn refresh_guild(state: &AppState, guild_id: &str, manual: bool) -> ApiResult<()> {
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT DISTINCT r.feed_url, r.feed_key, f.attempted_at FROM guild_origin_rules r \
         LEFT JOIN media_feeds f ON f.url = r.feed_url AND f.public_b64 = r.feed_key \
         WHERE r.guild_id = ? AND r.feed_url IS NOT NULL AND r.feed_key IS NOT NULL",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    let due = rows
        .into_iter()
        .filter(|(_, _, attempted)| match attempted {
            None => true,
            Some(at) => manual && at + MANUAL_REFRESH_FLOOR_MS <= now,
        });
    let results = futures_util::future::join_all(
        due.map(|(url, key, _)| async move { refresh(state, &url, &key).await }),
    )
    .await;
    for result in results {
        result?;
    }
    Ok(())
}

pub async fn verdict(state: &AppState, guild_id: &str, origin: &str) -> ApiResult<Option<Action>> {
    let rows: Vec<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT r.action, h.action, f.expires_at FROM guild_origin_rules r \
         JOIN media_feeds f ON f.url = r.feed_url AND f.public_b64 = r.feed_key \
         JOIN media_feed_hosts h ON h.url = f.url AND h.public_b64 = f.public_b64 \
         WHERE r.guild_id = ? AND r.feed_url IS NOT NULL AND h.origin = ?",
    )
    .bind(guild_id)
    .bind(origin)
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    Ok(resolve(rows.iter().map(|(rule, entry, expires_at)| {
        (
            rule.as_str(),
            entry.as_str(),
            expires_at.is_none_or(|at| at <= now),
        )
    })))
}

pub fn resolve<'a>(listings: impl IntoIterator<Item = (&'a str, &'a str, bool)>) -> Option<Action> {
    let mut verdict = None;
    for (rule, entry, expired) in listings {
        if rule == "block" || entry == "block" {
            return Some(Action::Block);
        }
        if !expired {
            verdict = Some(Action::Allow);
        }
    }
    verdict
}

pub async fn statuses(
    state: &AppState,
    guild_id: &str,
) -> ApiResult<HashMap<(String, String), Value>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>,
        Option<i64>, Option<String>, i64, i64, Option<String>, i64, Option<String>)> = sqlx::query_as(
        "SELECT f.url, f.public_b64, f.curator, f.serial, f.issued_at, f.expires_at, f.fetched_at, \
         f.attempted_at, f.error, f.allows, f.blocks, f.active_b64, f.rotation, f.next_b64 \
         FROM media_feeds f \
         JOIN guild_origin_rules r ON r.feed_url = f.url AND r.feed_key = f.public_b64 \
         WHERE r.guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;
    let now = now_ms();
    Ok(rows
        .into_iter()
        .map(
            |(
                url,
                key,
                curator,
                serial,
                issued_at,
                expires_at,
                fetched_at,
                attempted_at,
                error,
                allows,
                blocks,
                active,
                rotation,
                next,
            )| {
                let state = match (fetched_at, expires_at) {
                    (None, _) if error.is_some() => "failed",
                    (None, _) => "pending",
                    (Some(_), Some(at)) if at > now => "active",
                    _ => "expired",
                };
                let status = json!({
                    "state": state,
                    "curator": curator,
                    "serial": serial,
                    "issued_at": issued_at,
                    "expires_at": expires_at,
                    "fetched_at": fetched_at,
                    "attempted_at": attempted_at,
                    "error": error,
                    "allows": allows,
                    "blocks": blocks,
                    "hosts": allows + blocks,
                    "rotation": rotation,
                    "active_key": active.clone().unwrap_or_else(|| key.clone()),
                    "pending_key": next,
                });
                ((url, key), status)
            },
        )
        .collect())
}

pub const MAX_VOUCHED_HOSTS: usize = 60;

pub async fn vouched_hosts(state: &AppState, user_id: &str) -> ApiResult<Vec<Value>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT h.origin, r.action, h.action, f.expires_at, f.curator, f.url, \
         h.name, h.description, h.max_file_bytes, h.abuse_contact \
         FROM media_feed_hosts h \
         JOIN media_feeds f ON f.url = h.url AND f.public_b64 = h.public_b64 \
         JOIN guild_origin_rules r ON r.feed_url = h.url AND r.feed_key = h.public_b64 \
         JOIN members m ON m.guild_id = r.guild_id \
         WHERE m.user_id = ? AND m.banned = 0 ORDER BY h.origin",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;

    let now = now_ms();
    let listed: HashSet<String> = state
        .cfg
        .media_registry
        .hosts
        .iter()
        .map(|h| super::normalise_origin(&h.origin))
        .collect();
    let mut grouped: HashMap<String, Vec<(String, String, bool)>> = HashMap::new();
    let mut facts: HashMap<String, Value> = HashMap::new();
    for (
        origin,
        rule,
        entry,
        expires_at,
        curator,
        url,
        name,
        description,
        max_file_bytes,
        abuse_contact,
    ) in rows
    {
        grouped.entry(origin.clone()).or_default().push((
            rule,
            entry,
            expires_at.is_none_or(|at| at <= now),
        ));
        let fact = facts.entry(origin.clone()).or_insert_with(|| {
            json!({ "origin": origin, "name": name, "description": description,
                    "max_file_bytes": max_file_bytes, "abuse_contact": abuse_contact,
                    "vouched_by": [] })
        });
        let voucher = json!({ "curator": curator, "feed": url });
        if let Some(list) = fact["vouched_by"].as_array_mut() {
            if !list.contains(&voucher) {
                list.push(voucher);
            }
        }
    }

    let mut out = Vec::new();
    for (origin, listings) in grouped {
        if listed.contains(&origin) || origin == state.cfg.server_name {
            continue;
        }
        if resolve(
            listings
                .iter()
                .map(|(r, e, x)| (r.as_str(), e.as_str(), *x)),
        ) != Some(Action::Allow)
        {
            continue;
        }
        if let Some(fact) = facts.remove(&origin) {
            out.push(fact);
        }
    }
    out.sort_by(|a, b| a["origin"].as_str().cmp(&b["origin"].as_str()));
    out.truncate(MAX_VOUCHED_HOSTS);
    // Checked last: a feed cannot offer what this server has defederated.
    let mut kept = Vec::with_capacity(out.len());
    for host in out {
        let origin = host["origin"].as_str().unwrap_or_default();
        if !super::is_defederated(state, origin, "media").await {
            kept.push(host);
        }
    }
    Ok(kept)
}

pub fn unpinned_status() -> Value {
    json!({
        "state": "unpinned",
        "error": "this rule pins no curator key, so the feed is never fetched; save it again with one",
        "hosts": 0,
    })
}

pub struct Curator {
    pub signing: SigningKey,
    pub public: String,
    pub rotation: u64,
    pub announce: Option<(String, u64)>,
}

fn signing_key(secret_b64: &str) -> ApiResult<SigningKey> {
    let bytes: [u8; 32] = unb64(secret_b64)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("stored curator key is malformed")))?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub async fn curator(state: &AppState) -> ApiResult<Curator> {
    let secret: [u8; 32] = rand::random();
    let minted = SigningKey::from_bytes(&secret);
    sqlx::query(
        "INSERT INTO media_curator_key (id, secret_b64, public_b64, created_at) VALUES (1, ?, ?, ?) \
         ON CONFLICT DO NOTHING",
    )
    .bind(b64(&secret))
    .bind(b64(minted.verifying_key().as_bytes()))
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    let (stored, public, rotation, next_secret, next_public, rotate_after): (
        String,
        String,
        i64,
        Option<String>,
        Option<String>,
        Option<i64>,
    ) = sqlx::query_as(
        "SELECT secret_b64, public_b64, rotation, next_secret_b64, next_public_b64, rotate_after \
         FROM media_curator_key WHERE id = 1",
    )
    .fetch_one(&state.pool)
    .await?;

    if let (Some(next_secret), Some(next_public), Some(after)) =
        (&next_secret, &next_public, rotate_after)
    {
        if after <= now_ms() {
            let rotation = rotation + 1;
            sqlx::query(
                "UPDATE media_curator_key SET secret_b64 = ?, public_b64 = ?, rotation = ?, \
                 next_secret_b64 = NULL, next_public_b64 = NULL, rotate_after = NULL WHERE id = 1",
            )
            .bind(next_secret)
            .bind(next_public)
            .bind(rotation)
            .execute(&state.pool)
            .await?;
            return Ok(Curator {
                signing: signing_key(next_secret)?,
                public: next_public.clone(),
                rotation: rotation as u64,
                announce: None,
            });
        }
    }
    Ok(Curator {
        signing: signing_key(&stored)?,
        public,
        rotation: rotation.max(0) as u64,
        announce: next_public.map(|key| (key, rotation as u64 + 1)),
    })
}

pub async fn rotate(state: &AppState, overlap_secs: i64) -> ApiResult<Value> {
    let held = curator(state).await?;
    if let Some((key, rotation)) = held.announce {
        return Err(ApiError::Conflict(format!(
            "curator key rotation {rotation} to {key} is already in flight; let it finish before starting another"
        )));
    }
    let secret: [u8; 32] = rand::random();
    let next = SigningKey::from_bytes(&secret);
    let next_public = b64(next.verifying_key().as_bytes());
    let overlap = overlap_secs.clamp(24 * 60 * 60, 90 * 24 * 60 * 60);
    let rotate_after = now_ms() + overlap * 1000;
    sqlx::query(
        "UPDATE media_curator_key SET next_secret_b64 = ?, next_public_b64 = ?, rotate_after = ? WHERE id = 1",
    )
    .bind(b64(&secret))
    .bind(&next_public)
    .bind(rotate_after)
    .execute(&state.pool)
    .await?;
    tracing::info!(
        target: crate::logcat::MEDIA,
        rotation = held.rotation + 1,
        "media curator key rotation announced"
    );
    Ok(json!({
        "key": held.public,
        "next_key": next_public,
        "rotation": held.rotation + 1,
        "rotate_after": rotate_after,
    }))
}

pub async fn published_at(state: &AppState) -> ApiResult<Value> {
    let key = curator(state).await?;
    Ok(json!({
        "url": format!("{}/_telium/v1/media/registry/feed", state.cfg.public_base_url.trim_end_matches('/')),
        "key": key.public,
        "curator": state.cfg.server_name,
        "rotation": key.rotation,
        "next_key": key.announce.map(|(key, _)| key),
    }))
}

pub async fn publish(state: &AppState) -> ApiResult<Value> {
    let key = curator(state).await?;
    let now = now_ms();
    let mut seen = HashSet::new();
    let entries: Vec<Entry> = state
        .cfg
        .media_registry
        .hosts
        .iter()
        .filter_map(|host| {
            let origin = super::normalise_origin(&host.origin);
            (feed::is_origin(&origin) && seen.insert(origin.clone())).then(|| Entry {
                origin,
                action: Action::Allow,
                name: (!host.name.is_empty()).then(|| host.name.clone()),
                description: host.description.clone(),
                max_file_bytes: host.max_file_bytes,
                abuse_contact: host.abuse_contact.clone(),
            })
        })
        .collect();
    let validity = state.cfg.media_registry.feed_validity_secs.max(60) * 1000;
    let mut body = Feed::new(
        &state.cfg.server_name,
        now as u64,
        now,
        now + validity,
        entries,
    );
    if let Some((next, rotation)) = &key.announce {
        body = body.announcing(next, *rotation);
    }
    Ok(feed::sign(&key.signing, CURATOR_KEY_ID, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_block_anywhere_wins() {
        assert_eq!(
            resolve([("allow", "allow", false), ("allow", "block", false)]),
            Some(Action::Block)
        );
        assert_eq!(
            resolve([("allow", "allow", false), ("block", "allow", false)]),
            Some(Action::Block)
        );
    }

    #[test]
    fn an_allow_needs_an_allow_subscription_to_a_live_feed() {
        assert_eq!(resolve([("allow", "allow", false)]), Some(Action::Allow));
        assert_eq!(resolve([("allow", "allow", true)]), None);
        assert_eq!(
            resolve([("allow", "allow", true), ("allow", "allow", false)]),
            Some(Action::Allow)
        );
        assert_eq!(resolve(std::iter::empty()), None);
    }

    #[test]
    fn an_expired_feed_still_blocks() {
        assert_eq!(resolve([("allow", "block", true)]), Some(Action::Block));
        assert_eq!(resolve([("block", "allow", true)]), Some(Action::Block));
    }
}
