//! The public SFU directory: fetched, verified and held copies of the project's
//! signed relay list, on exactly the terms a hosting catalogue is held on.
//!
//! One subscription, from `[voice.directory]`, on by default and pinned to the
//! publisher's key at compile time. An entry here is a suggestion, never an
//! obligation: it becomes call traffic only when a guild's voice mode resolves
//! to it, and it stops being suggested the moment the publisher stops listing
//! it. There is no background probing of listed relays — health comes from the
//! publisher's hourly checker, the joining client's own measurements, and the
//! relay's admission refusals; this module only fetches and holds the list.

use crate::config::VoiceDirectory;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::{json, Value};
use std::time::Duration;
use telium_protocol::media_feed::Update;
use telium_protocol::sfu_directory::{self as feed, Directory};

/// Minimum gap between an admin's manual refreshes.
const MANUAL_REFRESH_FLOOR_MS: i64 = 60_000;

/// Why the last fetch failed. `KeyMismatch` matters most: a stale pin looks like an outage and waiting won't fix it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Misconfigured,
    Unreachable,
    KeyMismatch,
    Rejected,
}

impl Failure {
    /// Stored in `sfu_directory.failure_kind`; a rename would reclassify rows.
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Misconfigured => "misconfigured",
            Failure::Unreachable => "unreachable",
            Failure::KeyMismatch => "key_mismatch",
            Failure::Rejected => "rejected",
        }
    }
}

/// A fetch that did not end in a held copy: its class and the verbatim message.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub kind: Failure,
    pub message: String,
}

impl Refusal {
    fn new(kind: Failure, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// One relay from the held copy, as the resolver and the listing endpoint see it.
#[derive(Debug, Clone)]
pub struct Relay {
    pub url: String,
    pub name: String,
    pub description: Option<String>,
    pub region: String,
    pub region_label: String,
    pub operator_name: String,
    pub contact: String,
    pub capacity_band: String,
    pub weight: i64,
    pub pubkey_hint: Option<String>,
}

/// The health row key a directory relay is probed under, distinct from the
/// config regions' bare names and guild regions' `g{guild}/{name}`.
pub fn health_key(sfu: &str) -> String {
    format!("d/{}", &blake3::hash(sfu.as_bytes()).to_hex()[..12])
}

/// The result of one reachability probe of a relay's `/health`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Probe {
    pub ok: bool,
    pub latency_ms: Option<i64>,
    /// Whether the relay says it is taking new calls; `None` when the relay predates the field.
    pub accepting: Option<bool>,
}

/// The subscription this server actually holds: `None` when the directory is
/// switched off, unconfigured, or missing its pin.
fn subscription(cfg: &VoiceDirectory) -> Option<(String, String)> {
    if !cfg.enabled {
        return None;
    }
    let url = cfg.url.trim();
    let key = cfg.effective_key();
    if url.is_empty() || key.is_empty() {
        return None;
    }
    Some((url.to_string(), key.to_string()))
}

pub fn validate_subscription(state: &AppState, url: &str, key: &str) -> ApiResult<()> {
    crate::federation::feeds::check_url(state, url)?;
    if !telium_protocol::media_feed::is_public_key(key) {
        return Err(ApiError::BadRequest(format!(
            "the subscription to {url} has to pin its publisher's Ed25519 public key \
             (\"key\", base64): a directory is only trusted with the key its subscriber chose"
        )));
    }
    Ok(())
}

/// Fetches the directory and adopts it if newer. `Ok(Some(_))` is a recorded refusal; `Err` is a database failure.
pub async fn refresh(state: &AppState, url: &str, key: &str) -> ApiResult<Option<Refusal>> {
    sqlx::query(
        "INSERT INTO sfu_directory (url, public_b64, attempted_at, added_at) VALUES (?, ?, ?, ?) \
         ON CONFLICT (url, public_b64) DO UPDATE SET attempted_at = excluded.attempted_at",
    )
    .bind(url)
    .bind(key)
    .bind(now_ms())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let refused = match fetch_verified(state, url, key).await {
        Ok((parsed, digest)) => adopt(state, url, key, &parsed, &digest).await?,
        Err(reason) => Some(reason),
    };
    match &refused {
        Some(refusal) => {
            tracing::warn!(target: crate::logcat::VOICE, %url, kind = refusal.kind.as_str(), reason = %refusal.message, "sfu directory not adopted");
            // `error` is current state; `last_error` and companions are history.
            sqlx::query(
                "UPDATE sfu_directory SET error = ?, last_error = ?, failure_kind = ?, failed_at = ?, \
                 consecutive_failures = consecutive_failures + 1 WHERE url = ? AND public_b64 = ?",
            )
            .bind(&refusal.message)
            .bind(&refusal.message)
            .bind(refusal.kind.as_str())
            .bind(now_ms())
            .bind(url)
            .bind(key)
            .execute(&state.pool)
            .await?;
        }
        None => {
            // Streak only: `adopt` cleared `error`; failure history stays.
            sqlx::query("UPDATE sfu_directory SET consecutive_failures = 0 WHERE url = ? AND public_b64 = ?")
                .bind(url)
                .bind(key)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(refused)
}

/// Fetches one directory and classifies failure by where the fetch stopped. A valid
/// directory failing the pin is `KeyMismatch` (rotation or forgery; nothing in the
/// document can tell the two apart).
async fn fetch_verified(state: &AppState, url: &str, key: &str) -> Result<(Directory, String), Refusal> {
    validate_subscription(state, url, key)
        .map_err(|e| Refusal::new(Failure::Misconfigured, e.to_string()))?;
    let timeout = Duration::from_secs(state.cfg.voice.directory.timeout_secs.max(1));
    let bytes = crate::federation::feeds::fetch(state, url, feed::MAX_BYTES, timeout)
        .await
        .map_err(|e| Refusal::new(Failure::Unreachable, e.to_string()))?;
    let skew = state.cfg.federation.max_clock_skew_secs.saturating_mul(1000);
    let parsed = feed::verify(&bytes, key, now_ms(), skew).map_err(|e| match e {
        // Signed under a different key: rotation without notice, or a forgery.
        feed::DirectoryError::BadSignature => Refusal::new(
            Failure::KeyMismatch,
            "this URL is serving a complete SFU directory whose signature does not verify \
             against the pinned key. Either the publisher has rotated its signing key without \
             telling this subscriber, or somebody is serving a forgery; nothing in the document \
             can tell the two apart, and the remedy for both is the same -- get the publisher's \
             current key from somewhere other than this document and re-pin it in telium.toml.",
        ),
        // Not a directory document at all; re-pinning would be the wrong fix.
        feed::DirectoryError::NotJson => Refusal::new(
            Failure::Rejected,
            "what this URL served is not an SFU directory document at all (it is not JSON). Check \
             that the URL is the publisher's directory endpoint and not a login page, an error \
             page or a redirect landing.",
        ),
        feed::DirectoryError::WrongKind | feed::DirectoryError::UnsupportedVersion(_) => Refusal::new(
            Failure::Rejected,
            "what this URL served verifies under the pinned key but is not a v1 SFU directory. \
             Check that the URL points at the directory endpoint.",
        ),
        other => Refusal::new(Failure::Rejected, other.to_string()),
    })?;
    if i64::try_from(parsed.serial).is_err() {
        return Err(Refusal::new(Failure::Rejected, "directory serial is out of range"));
    }
    let body = serde_json::to_vec(&parsed)
        .map_err(|e| Refusal::new(Failure::Rejected, e.to_string()))?;
    Ok((parsed, blake3::hash(&body).to_hex().to_string()))
}

/// Applies the rollback rule; a new directory replaces the held copy wholesale.
async fn adopt(state: &AppState, url: &str, key: &str, parsed: &Directory, digest: &str) -> ApiResult<Option<Refusal>> {
    let held: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT serial, digest FROM sfu_directory WHERE url = ? AND public_b64 = ?")
            .bind(url)
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
    let held = held.and_then(|(serial, digest)| Some((serial? as u64, digest?)));
    let update = match feed::check_update(held.as_ref().map(|(s, d)| (*s, d.as_str())), parsed.serial, digest) {
        Ok(update) => update,
        // Verified but refused (replay or equivocation): `Rejected`, never `KeyMismatch`.
        Err(e) => return Ok(Some(Refusal::new(Failure::Rejected, e.to_string()))),
    };
    let now = now_ms();
    if update == Update::Unchanged {
        sqlx::query("UPDATE sfu_directory SET fetched_at = ?, error = NULL WHERE url = ? AND public_b64 = ?")
            .bind(now)
            .bind(url)
            .bind(key)
            .execute(&state.pool)
            .await?;
        return Ok(None);
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM sfu_directory_entries WHERE url = ? AND public_b64 = ?")
        .bind(url)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    for (position, sfu) in parsed.sfus.iter().enumerate() {
        sqlx::query(
            "INSERT INTO sfu_directory_entries (url, public_b64, position, sfu, name, description, region, \
             region_label, operator_name, contact, capacity_band, weight, pubkey_hint) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(url)
        .bind(key)
        .bind(position as i64)
        .bind(&sfu.url)
        .bind(&sfu.name)
        .bind(&sfu.description)
        .bind(&sfu.region)
        .bind(&sfu.region_label)
        .bind(&sfu.operator_name)
        .bind(&sfu.contact)
        .bind(&sfu.capacity_band)
        .bind(sfu.weight as i64)
        .bind(&sfu.pubkey_hint)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE sfu_directory SET publisher = ?, serial = ?, digest = ?, issued_at = ?, expires_at = ?, \
         fetched_at = ?, error = NULL, sfus = ? WHERE url = ? AND public_b64 = ?",
    )
    .bind(&parsed.publisher)
    .bind(parsed.serial as i64)
    .bind(digest)
    .bind(parsed.issued_at)
    .bind(parsed.expires_at)
    .bind(now)
    .bind(parsed.sfus.len() as i64)
    .bind(url)
    .bind(key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(None)
}

/// The relays on the held copy, in the publisher's order. Empty once the held
/// copy expires: an expired list is not a list.
pub async fn relays(state: &AppState) -> ApiResult<Vec<Relay>> {
    let Some((url, key)) = subscription(&state.cfg.voice.directory) else {
        return Ok(Vec::new());
    };
    let row: Option<(i64, i64)> = sqlx::query_as("SELECT expires_at, fetched_at FROM sfu_directory WHERE url = ? AND public_b64 = ?")
        .bind(&url)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await?;
    let Some((expires_at, _fetched_at)) = row else { return Ok(Vec::new()) };
    if expires_at <= now_ms() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>, String, String, String, String, String, i64, Option<String>)> =
        sqlx::query_as(
            "SELECT sfu, name, description, region, region_label, operator_name, contact, capacity_band, \
             weight, pubkey_hint FROM sfu_directory_entries WHERE url = ? AND public_b64 = ? ORDER BY position",
        )
        .bind(&url)
        .bind(&key)
        .fetch_all(&state.pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(url, name, description, region, region_label, operator_name, contact, capacity_band, weight, pubkey_hint)| Relay {
            url,
            name,
            description,
            region,
            region_label,
            operator_name,
            contact,
            capacity_band,
            weight,
            pubkey_hint,
        })
        .collect())
}

/// Whether a relay URL is on the held, unexpired copy. Fixed-list guild regions
/// backed by a directory URL use this for their "no longer listed" warning.
pub async fn is_listed(state: &AppState, sfu: &str) -> ApiResult<bool> {
    Ok(relays(state).await?.iter().any(|r| r.url == sfu))
}

/// Maintenance tick: prune the cache when the subscription is gone, refresh if due.
pub async fn refresh_due(state: &AppState) -> ApiResult<usize> {
    let Some((url, key)) = subscription(&state.cfg.voice.directory) else {
        // A switched-off or unconfigured directory subscribes to nothing, so the prune clears any held copy.
        sqlx::query("DELETE FROM sfu_directory_entries").execute(&state.pool).await?;
        sqlx::query("DELETE FROM sfu_directory").execute(&state.pool).await?;
        return Ok(0);
    };
    prune(state, &url, &key).await?;

    let row: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT attempted_at, error FROM sfu_directory WHERE url = ? AND public_b64 = ?")
            .bind(&url)
            .bind(&key)
            .fetch_optional(&state.pool)
            .await?;
    let now = now_ms();
    let every = state.cfg.voice.directory.refresh_secs.max(60) * 1000;
    let retry = state.cfg.voice.directory.retry_secs.max(30) * 1000;
    let due = match &row {
        None => true,
        Some((attempted, error)) => {
            let wait = if error.is_some() { retry } else { every };
            attempted.is_none_or(|at| at + wait <= now)
        }
    };
    if !due {
        return Ok(0);
    }
    refresh(state, &url, &key).await?;
    Ok(1)
}

/// Forgets a held copy the configuration no longer names.
async fn prune(state: &AppState, url: &str, key: &str) -> ApiResult<()> {
    let held: Vec<(String, String)> = sqlx::query_as("SELECT url, public_b64 FROM sfu_directory")
        .fetch_all(&state.pool)
        .await?;
    for (hurl, hkey) in held {
        if hurl == url && hkey == key {
            continue;
        }
        sqlx::query("DELETE FROM sfu_directory_entries WHERE url = ? AND public_b64 = ?")
            .bind(&hurl)
            .bind(&hkey)
            .execute(&state.pool)
            .await?;
        sqlx::query("DELETE FROM sfu_directory WHERE url = ? AND public_b64 = ?")
            .bind(&hurl)
            .bind(&hkey)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

/// Refreshes the directory now; one row: `{ url, error, kind, skipped }`.
pub async fn refresh_all(state: &AppState) -> ApiResult<Vec<Value>> {
    let now = now_ms();
    let mut results = Vec::new();
    let Some((url, key)) = subscription(&state.cfg.voice.directory) else {
        return Ok(results);
    };
    if let Err(e) = validate_subscription(state, &url, &key) {
        // Never fetched: the fix is an editor and a restart.
        results.push(json!({ "url": url, "error": null, "kind": Failure::Misconfigured.as_str(), "skipped": e.to_string() }));
        return Ok(results);
    }
    let attempted: Option<Option<i64>> =
        sqlx::query_scalar("SELECT attempted_at FROM sfu_directory WHERE url = ? AND public_b64 = ?")
            .bind(&url)
            .bind(&key)
            .fetch_optional(&state.pool)
            .await?;
    if let Some(at) = attempted.flatten() {
        let since = now.saturating_sub(at);
        if since < MANUAL_REFRESH_FLOOR_MS {
            results.push(json!({
                "url": url,
                "error": null,
                "kind": Value::Null,
                "skipped": format!("fetched {}s ago; this server waits a minute between manual fetches", since.max(0) / 1000),
            }));
            return Ok(results);
        }
    }
    let refused = refresh(state, &url, &key).await?;
    results.push(json!({
        "url": url,
        "error": refused.as_ref().map(|r| r.message.clone()),
        "kind": refused.as_ref().map(|r| r.kind.as_str()),
        "skipped": null,
    }));
    Ok(results)
}

/// One row for the configured subscription: `{ url, enabled, state, publisher, serial, entries, issued_at, expires_at, fetched_at, error, failure }`.
pub async fn statuses(state: &AppState) -> ApiResult<Vec<Value>> {
    let cfg = &state.cfg.voice.directory;
    let Some((url, key)) = subscription(cfg) else {
        return Ok(vec![json!({
            "url": cfg.url,
            "enabled": cfg.enabled,
            "state": if cfg.enabled { "invalid" } else { "disabled" },
        })]);
    };
    let row: Option<(Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<i64>, i64, i64)> =
        sqlx::query_as(
            "SELECT publisher, serial, issued_at, expires_at, fetched_at, attempted_at, error, last_error, \
             failure_kind, failed_at, consecutive_failures, sfus FROM sfu_directory WHERE url = ? AND public_b64 = ?",
        )
        .bind(&url)
        .bind(&key)
        .fetch_optional(&state.pool)
        .await?;
    let Some((publisher, serial, issued_at, expires_at, fetched_at, attempted_at, error, last_error, failure_kind, failed_at, consecutive, sfus)) = row
    else {
        return Ok(vec![json!({ "url": url, "enabled": true, "state": "pending" })]);
    };
    // Precedence as in hosting: `key_mismatch` outranks `expired` and `failed`.
    let state_name = if failure_kind.as_deref() == Some(Failure::KeyMismatch.as_str()) {
        "key_mismatch"
    } else if expires_at.is_some_and(|at| at <= now_ms()) {
        "expired"
    } else if error.is_some() {
        "failed"
    } else if fetched_at.is_some() {
        "active"
    } else {
        "pending"
    };
    let failure = failure_kind.map(|kind| {
        json!({
            "kind": kind,
            "message": last_error,
            "at": failed_at,
            "consecutive": consecutive,
        })
    });
    Ok(vec![json!({
        "url": url,
        "enabled": true,
        "state": state_name,
        "publisher": publisher,
        "serial": serial,
        "entries": sfus,
        "issued_at": issued_at,
        "expires_at": expires_at,
        "fetched_at": fetched_at,
        "attempted_at": attempted_at,
        "error": error,
        "failure": failure,
    })])
}

/// Probes one relay's `/health` the way the voice module probes regions: any 2xx
/// means reachable; the body may add `accepting` (and, later, load figures).
pub async fn probe_relay(state: &AppState, sfu: &str) -> Probe {
    let url = format!("{}/health", sfu.trim_end_matches('/'));
    let started = std::time::Instant::now();
    let timeout = Duration::from_secs(5);
    let is_public = is_listed(state, sfu).await.unwrap_or(false);
    // Public relay URLs are signed but their DNS is controlled by their
    // operators. Pin a checked public address and refuse redirects to avoid
    // turning every subscribed homeserver into an SSRF proxy.
    let body = if is_public {
        match url::Url::parse(&url) {
            Ok(parsed) => crate::federation::feeds::fetch_bytes(
                false, parsed, 16 * 1024, timeout, "telium-sfu-health/1.0",
            )
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()),
            Err(_) => None,
        }
    } else {
        // An admin may intentionally configure a localhost SFU on their own
        // machine. Still do not follow redirects out of that destination.
        match state.http_no_redirect.get(&url).timeout(timeout).send().await {
            Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
            _ => None,
        }
    };
    let ok = body.as_ref().is_some_and(|v| {
        v.get("ok").and_then(Value::as_bool) == Some(true)
            && (!is_public || v.get("service").and_then(Value::as_str) == Some("telium-sfu"))
    });
    Probe {
        ok,
        latency_ms: if body.is_some() { Some(started.elapsed().as_millis() as i64) } else { None },
        accepting: if ok { body.as_ref().and_then(|v| v.get("accepting").and_then(Value::as_bool)) } else { None },
    }
}

/// Probes a set of relays concurrently, for the on-demand browse listing: one
/// round triggered by a human opening the list, never a timer.
pub async fn probe_relays(state: &AppState, urls: &[String]) -> Vec<(String, Probe)> {
    futures_util::future::join_all(urls.iter().map(|sfu| async move {
        let probe = probe_relay(state, sfu).await;
        (sfu.clone(), probe)
    }))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relay_health_key_is_stable_and_namespaced() {
        let a = health_key("https://sfu.example");
        assert!(a.starts_with("d/"));
        assert_eq!(a.len(), "d/".len() + 12);
        assert_eq!(a, health_key("https://sfu.example"));
        assert_ne!(a, health_key("https://sfu2.example"));
    }

    #[test]
    fn a_subscription_needs_enabled_url_and_pin() {
        // The production pin ships embedded, so the default configuration subscribes.
        let cfg = VoiceDirectory::default();
        assert!(subscription(&cfg).is_some());
        let mut cfg = VoiceDirectory { enabled: false, ..VoiceDirectory::default() };
        assert!(subscription(&cfg).is_none(), "enabled = false is the kill switch");
        cfg.enabled = true;
        cfg.url = "   ".into();
        assert!(subscription(&cfg).is_none(), "a blank URL is no URL");
        // A blank config pin falls back to the compile-time pin, which ships
        // filled; an operator who wants silence uses the kill switch, and one
        // who wants their own directory pins their own key.
        let blanked = VoiceDirectory { key: " ".repeat(3), ..VoiceDirectory::default() };
        assert!(subscription(&blanked).is_some());
        let private = VoiceDirectory { url: "https://directory.internal/feed.json".into(), key: "k".into(), ..VoiceDirectory::default() };
        assert!(subscription(&private).is_some());
    }
}
