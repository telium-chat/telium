//! Managed guild-hosting marketplace: fetched, verified and held provider catalogues.

use crate::config::{HostingPlan, HostingProvider};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{b64, now_ms, unb64};
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use telium_protocol::hosting_catalog::{self as catalog, Catalog, Period, Plan, Provider, Update};

const PUBLISHER_KEY_ID: &str = "ed25519:hosting";

const REFRESH_BATCH: usize = 8;

/// Minimum gap between an admin's manual refreshes of the same catalogue.
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
    /// Stored in `hosting_catalogs.failure_kind`; a rename would reclassify rows.
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
        Refusal { kind, message: message.into() }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// A configured provider as the protocol carries it, or why it is not listed.
pub fn provider_from_config(p: &HostingProvider) -> Result<Provider, String> {
    let period = |plan: &HostingPlan| match plan.period.to_ascii_lowercase().as_str() {
        "free" => Ok(Period::Free),
        "monthly" => Ok(Period::Monthly),
        "yearly" => Ok(Period::Yearly),
        "metered" => Ok(Period::Metered),
        other => Err(format!("plan {}: {other:?} is not free, monthly, yearly or metered", plan.id)),
    };
    let plans = p
        .plans
        .iter()
        .map(|plan| {
            Ok(Plan {
                id: plan.id.clone(),
                name: plan.name.clone(),
                price_minor: plan.price_minor,
                currency: plan.currency.clone(),
                period: period(plan)?,
                member_cap: plan.member_cap,
                storage_bytes: plan.storage_bytes,
                media_quota_bytes: plan.media_quota_bytes,
                notes: plan.notes.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let provider = Provider {
        id: p.id.clone(),
        name: p.name.clone(),
        base_url: p.base_url.clone(),
        signup_url: p.signup_url.clone(),
        terms_url: p.terms_url.clone(),
        privacy_url: p.privacy_url.clone(),
        contact: p.contact.clone(),
        description: p.description.clone(),
        regions: p.regions.clone(),
        plans,
        public_key: p.public_key.clone(),
    };
    catalog::check_provider(&provider).map_err(|e| e.to_string())?;
    Ok(provider)
}

/// The operator's providers minus unusable ones (logged); one mistake costs one entry.
pub fn curated(state: &AppState) -> Vec<Provider> {
    let mut seen = HashSet::new();
    state
        .cfg
        .hosting
        .providers
        .iter()
        .filter_map(|p| match provider_from_config(p) {
            Ok(provider) if seen.insert(provider.id.clone()) => Some(provider),
            Ok(provider) => {
                tracing::warn!(target: crate::logcat::FEDERATION, id = %provider.id, "curated hosting provider listed twice; the later one is ignored");
                None
            }
            Err(reason) => {
                tracing::warn!(target: crate::logcat::FEDERATION, id = %p.id, %reason, "curated hosting provider is not listable");
                None
            }
        })
        .collect()
}

pub fn validate_subscription(state: &AppState, url: &str, key: &str) -> ApiResult<()> {
    crate::federation::feeds::check_url(state, url)?;
    if !catalog::is_public_key(key) {
        return Err(ApiError::BadRequest(format!(
            "the subscription to {url} has to pin its publisher's Ed25519 public key \
             (\"key\", base64): a catalog is only trusted with the key its subscriber chose"
        )));
    }
    Ok(())
}

/// Fetches one catalogue and adopts it if newer. `Ok(Some(_))` is a recorded refusal; `Err` is a database failure.
pub async fn refresh(state: &AppState, url: &str, key: &str, label: Option<&str>) -> ApiResult<Option<Refusal>> {
    sqlx::query(
        "INSERT INTO hosting_catalogs (url, public_b64, label, attempted_at, added_at) VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (url, public_b64) DO UPDATE SET attempted_at = excluded.attempted_at, label = excluded.label",
    )
    .bind(url)
    .bind(key)
    .bind(label)
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
            tracing::warn!(target: crate::logcat::FEDERATION, %url, kind = refusal.kind.as_str(), reason = %refusal.message, "hosting catalog not adopted");
            // `error` is current state; `last_error` and companions are history (migration 0071).
            sqlx::query(
                "UPDATE hosting_catalogs SET error = ?, last_error = ?, failure_kind = ?, failed_at = ?, \
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
            sqlx::query("UPDATE hosting_catalogs SET consecutive_failures = 0 WHERE url = ? AND public_b64 = ?")
                .bind(url)
                .bind(key)
                .execute(&state.pool)
                .await?;
        }
    }
    Ok(refused)
}

/// Fetches one catalogue and classifies failure by where the fetch stopped. A valid catalogue failing the pin is `KeyMismatch` (rotation or captive portal).
async fn fetch_verified(state: &AppState, url: &str, key: &str) -> Result<(Catalog, String), Refusal> {
    validate_subscription(state, url, key)
        .map_err(|e| Refusal::new(Failure::Misconfigured, e.to_string()))?;
    let timeout = Duration::from_secs(state.cfg.hosting.catalog_timeout_secs.max(1));
    let bytes = crate::federation::feeds::fetch(state, url, catalog::MAX_BYTES, timeout)
        .await
        .map_err(|e| Refusal::new(Failure::Unreachable, e.to_string()))?;
    let skew = state.cfg.federation.max_clock_skew_secs.saturating_mul(1000);
    let parsed = catalog::verify(&bytes, key, now_ms(), skew).map_err(|e| match e {
        catalog::CatalogError::BadSignature => match catalog::foreign_signature(&bytes) {
            Some(found) => {
                let named = found
                    .key_id
                    .map(|id| format!(" The document names key_id {id:?}, which is the publisher's own unverified label for the key it used."))
                    .unwrap_or_default();
                Refusal::new(
                    Failure::KeyMismatch,
                    format!(
                        "this URL is serving a complete hosting catalog whose signature does not verify \
                         against the pinned key. Either the publisher has rotated its signing key without \
                         telling this subscriber, or somebody is serving a forgery; nothing in the document \
                         can tell the two apart, and the remedy for both is the same -- get the publisher's \
                         current key from somewhere other than this document and re-pin it in telium.toml.{named}"
                    ),
                )
            }
            // Not this publisher's catalogue at all; re-pinning would be the wrong fix.
            None => Refusal::new(
                Failure::Rejected,
                "what this URL served is not a hosting catalog document at all (it does not carry a \
                 catalog's kind, version and signature). Check that the URL is the publisher's catalog \
                 endpoint and not a login page, an error page or a redirect landing."
                    .to_string(),
            ),
        },
        other => Refusal::new(Failure::Rejected, other.to_string()),
    })?;
    if i64::try_from(parsed.serial).is_err() {
        return Err(Refusal::new(Failure::Rejected, "catalog serial is out of range"));
    }
    let body = serde_json::to_vec(&parsed)
        .map_err(|e| Refusal::new(Failure::Rejected, e.to_string()))?;
    Ok((parsed, blake3::hash(&body).to_hex().to_string()))
}

/// Applies the rollback rule; a new catalogue replaces the held copy wholesale.
async fn adopt(state: &AppState, url: &str, key: &str, parsed: &Catalog, digest: &str) -> ApiResult<Option<Refusal>> {
    let held: Option<(Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT serial, digest FROM hosting_catalogs WHERE url = ? AND public_b64 = ?")
            .bind(url)
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
    let held = held.and_then(|(serial, digest)| Some((serial? as u64, digest?)));
    let update = match catalog::check_update(held.as_ref().map(|(s, d)| (*s, d.as_str())), parsed.serial, digest) {
        Ok(update) => update,
        // Verified but refused (replay or equivocation): `Rejected`, never `KeyMismatch`.
        Err(e) => return Ok(Some(Refusal::new(Failure::Rejected, e.to_string()))),
    };
    let now = now_ms();
    if update == Update::Unchanged {
        sqlx::query("UPDATE hosting_catalogs SET fetched_at = ?, error = NULL WHERE url = ? AND public_b64 = ?")
            .bind(now)
            .bind(url)
            .bind(key)
            .execute(&state.pool)
            .await?;
        return Ok(None);
    }

    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM hosting_providers WHERE url = ? AND public_b64 = ?")
        .bind(url)
        .bind(key)
        .execute(&mut *tx)
        .await?;
    for (position, provider) in parsed.providers.iter().enumerate() {
        // Re-serialised from validated structures, not the publisher's bytes.
        let regions = serde_json::to_string(&provider.regions).unwrap_or_else(|_| "[]".into());
        let plans = serde_json::to_string(&provider.plans).unwrap_or_else(|_| "[]".into());
        sqlx::query(
            "INSERT INTO hosting_providers (url, public_b64, provider_id, position, name, base_url, \
             signup_url, terms_url, privacy_url, contact, description, regions, plans, public_key) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(url)
        .bind(key)
        .bind(&provider.id)
        .bind(position as i64)
        .bind(&provider.name)
        .bind(&provider.base_url)
        .bind(&provider.signup_url)
        .bind(&provider.terms_url)
        .bind(&provider.privacy_url)
        .bind(&provider.contact)
        .bind(&provider.description)
        .bind(&regions)
        .bind(&plans)
        .bind(&provider.public_key)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "UPDATE hosting_catalogs SET publisher = ?, serial = ?, digest = ?, issued_at = ?, expires_at = ?, \
         fetched_at = ?, error = NULL, providers = ? WHERE url = ? AND public_b64 = ?",
    )
    .bind(&parsed.publisher)
    .bind(parsed.serial as i64)
    .bind(digest)
    .bind(parsed.issued_at)
    .bind(parsed.expires_at)
    .bind(now)
    .bind(parsed.providers.len() as i64)
    .bind(url)
    .bind(key)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(None)
}

/// Maintenance tick: prune unnamed catalogues, then refresh those due.
pub async fn refresh_due(state: &AppState) -> ApiResult<usize> {
    // A switched-off marketplace subscribes to nothing, so the prune clears any cached list.
    let subscribed: Vec<(String, String, Option<String>)> = if state.cfg.hosting.enabled {
        state
            .cfg
            .hosting
            .catalogs
            .iter()
            .filter(|c| validate_subscription(state, &c.url, &c.key).is_ok())
            .map(|c| (c.url.clone(), c.key.clone(), c.label.clone()))
            .collect()
    } else {
        Vec::new()
    };
    prune(state, &subscribed).await?;
    if subscribed.is_empty() {
        return Ok(0);
    }

    let rows: Vec<(String, String, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT url, public_b64, attempted_at, error FROM hosting_catalogs")
            .fetch_all(&state.pool)
            .await?;
    let now = now_ms();
    let every = state.cfg.hosting.catalog_refresh_secs.max(60) * 1000;
    let retry = state.cfg.hosting.catalog_retry_secs.max(30) * 1000;
    let mut refreshed = 0;
    for (url, key, label) in &subscribed {
        let held = rows.iter().find(|(u, k, _, _)| u == url && k == key);
        let due = match held {
            None => true,
            Some((_, _, attempted, error)) => {
                let wait = if error.is_some() { retry } else { every };
                attempted.is_none_or(|at| at + wait <= now)
            }
        };
        if !due {
            continue;
        }
        refresh(state, url, key, label.as_deref()).await?;
        refreshed += 1;
        if refreshed >= REFRESH_BATCH {
            break;
        }
    }
    Ok(refreshed)
}

/// Refreshes every configured catalogue now; one row per subscription in config order: `{ url, label, error, kind, skipped }` (skipped = malformed or inside `MANUAL_REFRESH_FLOOR_MS`).
pub async fn refresh_all(state: &AppState) -> ApiResult<Vec<Value>> {
    let now = now_ms();
    let mut results = Vec::new();
    if !state.cfg.hosting.enabled {
        return Ok(results);
    }
    for c in &state.cfg.hosting.catalogs {
        if let Err(e) = validate_subscription(state, &c.url, &c.key) {
            // Never fetched: the fix is an editor and a restart.
            results.push(json!({
                "url": c.url,
                "label": c.label,
                "error": null,
                "kind": Failure::Misconfigured.as_str(),
                "skipped": e.to_string(),
            }));
            continue;
        }
        let attempted: Option<Option<i64>> =
            sqlx::query_scalar("SELECT attempted_at FROM hosting_catalogs WHERE url = ? AND public_b64 = ?")
                .bind(&c.url)
                .bind(&c.key)
                .fetch_optional(&state.pool)
                .await?;
        if let Some(at) = attempted.flatten() {
            let since = now.saturating_sub(at);
            if since < MANUAL_REFRESH_FLOOR_MS {
                results.push(json!({
                    "url": c.url,
                    "label": c.label,
                    "error": null,
                    "kind": Value::Null,
                    "skipped": format!("fetched {}s ago; this server waits a minute between manual fetches", since.max(0) / 1000),
                }));
                continue;
            }
        }
        let refused = refresh(state, &c.url, &c.key, c.label.as_deref()).await?;
        results.push(json!({
            "url": c.url,
            "label": c.label,
            "error": refused.as_ref().map(|r| r.message.clone()),
            "kind": refused.as_ref().map(|r| r.kind.as_str()),
            "skipped": null,
        }));
    }
    Ok(results)
}

/// Forgets cached catalogues (and their providers) the configuration no longer names.
async fn prune(state: &AppState, subscribed: &[(String, String, Option<String>)]) -> ApiResult<()> {
    let held: Vec<(String, String)> = sqlx::query_as("SELECT url, public_b64 FROM hosting_catalogs")
        .fetch_all(&state.pool)
        .await?;
    for (url, key) in held {
        if subscribed.iter().any(|(u, k, _)| *u == url && *k == key) {
            continue;
        }
        sqlx::query("DELETE FROM hosting_providers WHERE url = ? AND public_b64 = ?")
            .bind(&url)
            .bind(&key)
            .execute(&state.pool)
            .await?;
        sqlx::query("DELETE FROM hosting_catalogs WHERE url = ? AND public_b64 = ?")
            .bind(&url)
            .bind(&key)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

fn provider_json(provider: &Provider, source: Value) -> Value {
    json!({
        "id": provider.id,
        "name": provider.name,
        "base_url": provider.base_url,
        "signup_url": provider.signup_url,
        "terms_url": provider.terms_url,
        "privacy_url": provider.privacy_url,
        "contact": provider.contact,
        "description": provider.description,
        "regions": provider.regions,
        "plans": provider.plans,
        "public_key": provider.public_key,
        "source": source,
    })
}

/// Same offer when it would host a guild in the same place.
fn same_offer(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_ascii_lowercase()
}

/// Every provider to show: operator's own first, then live catalogues in config order.
pub async fn providers(state: &AppState) -> ApiResult<Vec<Value>> {
    let mut seen = HashSet::new();
    let mut out: Vec<Value> = Vec::new();
    let operator = json!({ "kind": "operator", "publisher": state.cfg.server_name });
    for provider in curated(state) {
        if seen.insert(same_offer(&provider.base_url)) {
            out.push(provider_json(&provider, operator.clone()));
        }
    }

    let now = now_ms();
    for c in &state.cfg.hosting.catalogs {
        let held: Option<(Option<String>, Option<i64>)> =
            sqlx::query_as("SELECT publisher, expires_at FROM hosting_catalogs WHERE url = ? AND public_b64 = ?")
                .bind(&c.url)
                .bind(&c.key)
                .fetch_optional(&state.pool)
                .await?;
        let Some((publisher, expires_at)) = held else { continue };
        if expires_at.is_none_or(|at| at <= now) {
            continue;
        }
        let source = json!({
            "kind": "catalog",
            "publisher": publisher,
            "label": c.label,
            "url": c.url,
        });
        let rows: Vec<(String, String, String, String, String, Option<String>, Option<String>, Option<String>,
            String, String, String)> = sqlx::query_as(
            "SELECT provider_id, name, base_url, signup_url, terms_url, privacy_url, contact, description, \
             regions, plans, public_key FROM hosting_providers WHERE url = ? AND public_b64 = ? ORDER BY position",
        )
        .bind(&c.url)
        .bind(&c.key)
        .fetch_all(&state.pool)
        .await?;
        for (id, name, base_url, signup_url, terms_url, privacy_url, contact, description, regions, plans, public_key)
            in rows
        {
            if !seen.insert(same_offer(&base_url)) {
                continue;
            }
            out.push(json!({
                "id": id,
                "name": name,
                "base_url": base_url,
                "signup_url": signup_url,
                "terms_url": terms_url,
                "privacy_url": privacy_url,
                "contact": contact,
                "description": description,
                // Our own re-serialisation, so parsing back is safe.
                "regions": serde_json::from_str::<Value>(&regions).unwrap_or_else(|_| json!([])),
                "plans": serde_json::from_str::<Value>(&plans).unwrap_or_else(|_| json!([])),
                "public_key": public_key,
                "source": source.clone(),
            }));
        }
    }
    Ok(out)
}

/// Status per configured catalogue in file order, including never-fetched. `state` is what it does for guild creators now, not health; `key_mismatch` outranks `expired` and `failed`.
pub async fn statuses(state: &AppState) -> ApiResult<Vec<Value>> {
    let now = now_ms();
    let mut out = Vec::new();
    for c in &state.cfg.hosting.catalogs {
        let held: Option<(Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<i64>, Option<i64>,
            Option<String>, i64, Option<i64>, Option<String>, Option<String>, i64)> = sqlx::query_as(
            "SELECT publisher, serial, issued_at, expires_at, fetched_at, attempted_at, error, providers, \
             failed_at, last_error, failure_kind, consecutive_failures \
             FROM hosting_catalogs WHERE url = ? AND public_b64 = ?",
        )
        .bind(&c.url)
        .bind(&c.key)
        .fetch_optional(&state.pool)
        .await?;
        let invalid = validate_subscription(state, &c.url, &c.key).err().map(|e| e.to_string());
        let (publisher, serial, issued_at, expires_at, fetched_at, attempted_at, error, providers,
             failed_at, last_error, failure_kind, consecutive) =
            held.unwrap_or((None, None, None, None, None, None, invalid.clone(), 0, None, None, None, 0));
        // Malformed means failed already, not `pending`; no timestamp.
        let (failure_kind, last_error) = match &invalid {
            Some(why) => (Some(Failure::Misconfigured.as_str().to_string()), Some(why.clone())),
            None => (failure_kind, last_error),
        };
        let mismatched = error.is_some() && failure_kind.as_deref() == Some(Failure::KeyMismatch.as_str());
        let status = match (invalid.is_some(), fetched_at, expires_at) {
            _ if !state.cfg.hosting.enabled => "disabled",
            (true, _, _) => "invalid",
            // Listing, whatever else is wrong with it. `failure` says the rest.
            (_, Some(_), Some(at)) if at > now => "active",
            _ if mismatched => "key_mismatch",
            (_, None, _) if error.is_some() => "failed",
            (_, None, _) => "pending",
            _ => "expired",
        };
        out.push(json!({
            "url": c.url,
            "label": c.label,
            // Public pinned key, shown to administrators to check for rotation.
            "key": c.key,
            "state": status,
            "publisher": publisher,
            "serial": serial,
            "issued_at": issued_at,
            "expires_at": expires_at,
            "fetched_at": fetched_at,
            "attempted_at": attempted_at,
            "error": error,
            "providers": providers,
            // Last failure, kept after repair (migration 0071); null if never failed.
            "failure": last_error.as_ref().map(|message| json!({
                "kind": failure_kind,
                "message": message,
                "at": failed_at,
                // Zero, not null, once the streak breaks: "failed before, fine now".
                "consecutive": consecutive,
            })),
        }));
    }
    Ok(out)
}

pub async fn publisher_key(state: &AppState) -> ApiResult<SigningKey> {
    let secret: [u8; 32] = rand::random();
    let signing = SigningKey::from_bytes(&secret);
    sqlx::query(
        "INSERT INTO hosting_catalog_key (id, secret_b64, public_b64, created_at) VALUES (1, ?, ?, ?) \
         ON CONFLICT DO NOTHING",
    )
    .bind(b64(&secret))
    .bind(b64(signing.verifying_key().as_bytes()))
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    let stored: String = sqlx::query_scalar("SELECT secret_b64 FROM hosting_catalog_key WHERE id = 1")
        .fetch_one(&state.pool)
        .await?;
    let bytes: [u8; 32] = unb64(&stored)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("stored hosting publisher key is malformed")))?;
    Ok(SigningKey::from_bytes(&bytes))
}

pub async fn published_at(state: &AppState) -> ApiResult<Value> {
    let key = publisher_key(state).await?;
    Ok(json!({
        "url": format!("{}/_telium/v1/hosting/catalog", state.cfg.public_base_url.trim_end_matches('/')),
        "key": b64(key.verifying_key().as_bytes()),
        "publisher": state.cfg.server_name,
    }))
}

/// Curated providers as a signed catalogue; the serial is the signing time so rollback rules hold without a counter.
pub async fn publish(state: &AppState) -> ApiResult<Value> {
    let key = publisher_key(state).await?;
    let now = now_ms();
    let validity = state.cfg.hosting.catalog_validity_secs.max(60) * 1000;
    let body = Catalog::new(&state.cfg.server_name, now as u64, now, now + validity, curated(state));
    Ok(catalog::sign(&key, PUBLISHER_KEY_ID, &body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> HostingPlan {
        HostingPlan {
            id: "small".into(),
            name: "Small".into(),
            price_minor: 400,
            currency: "USD".into(),
            period: "monthly".into(),
            member_cap: Some(250),
            storage_bytes: Some(10_737_418_240),
            media_quota_bytes: None,
            notes: None,
        }
    }

    fn configured() -> HostingProvider {
        HostingProvider {
            id: "aurora".into(),
            name: "Aurora Hosting".into(),
            base_url: "https://guilds.aurora.example".into(),
            signup_url: "https://aurora.example/signup".into(),
            terms_url: "https://aurora.example/terms".into(),
            privacy_url: None,
            contact: None,
            description: None,
            regions: vec!["eu-west".into()],
            plans: vec![plan()],
            public_key: telium_protocol::b64(
                ed25519_dalek::SigningKey::from_bytes(&[31u8; 32]).verifying_key().as_bytes(),
            ),
        }
    }

    #[test]
    fn a_configured_provider_is_checked_the_way_a_fetched_one_is() {
        let provider = provider_from_config(&configured()).unwrap();
        assert_eq!(provider.plans[0].period, Period::Monthly);

        let mut bad = configured();
        bad.signup_url = "http://aurora.example/signup".into();
        assert!(provider_from_config(&bad).unwrap_err().contains("signup_url"));

        let mut bad = configured();
        bad.plans[0].period = "weekly".into();
        assert!(provider_from_config(&bad).unwrap_err().contains("weekly"));
    }

    #[test]
    fn one_offer_is_one_row_however_it_is_spelt() {
        assert_eq!(same_offer("https://Guilds.Aurora.example/"), same_offer("https://guilds.aurora.example"));
        assert_ne!(same_offer("https://a.example"), same_offer("https://b.example"));
    }
}
