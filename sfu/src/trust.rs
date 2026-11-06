//! Key trust for verifying signed tokens and commands; public mode discovers unseen origins.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;
use tokio::sync::RwLock;

use crate::config::TrustConfig;
use crate::fetch::{self, AddressPolicy, MAX_DOCUMENT_BYTES};

/// Ceiling on discovered origins: filled from unauthenticated bodies and re-fetched on a timer.
const MAX_DISCOVERED_ORIGINS: usize = 512;

const DISCOVERY_RETRY_AFTER: Duration = Duration::from_secs(300);

const MAX_ATTEMPT_LEDGER: usize = 4096;

#[derive(Clone)]
pub struct TrustedKeys {
    keys: HashMap<String, Vec<(String, String)>>,
    discovery: bool,
    public: bool,
    discovered: HashMap<String, String>,
    attempted: HashMap<String, Instant>,
    insecure_discovery: bool,
}

impl TrustedKeys {
    pub fn from_config(cfg: &TrustConfig) -> Self {
        let mut map: HashMap<String, Vec<(String, String)>> = HashMap::new();
        for o in &cfg.origins {
            // Discovery-only whitelist entries have no pinned key; a placeholder would make knows() true too early.
            if !o.key_id.is_empty() && !o.public_key_b64.is_empty() {
                map.entry(o.server_name.clone())
                    .or_default()
                    .push((o.key_id.clone(), o.public_key_b64.clone()));
            }
        }
        Self {
            keys: map,
            discovery: cfg.discovery,
            public: cfg.public,
            discovered: HashMap::new(),
            attempted: HashMap::new(),
            insecure_discovery: cfg.allow_insecure_discovery,
        }
    }

    /// Untrusted unless the operator set `allow_insecure_discovery`; per deployment, never per request.
    pub fn discovery_policy(&self) -> AddressPolicy {
        if self.insecure_discovery {
            AddressPolicy::OperatorConfigured
        } else {
            AddressPolicy::Untrusted
        }
    }

    pub fn knows(&self, origin: &str) -> bool {
        self.keys.get(origin).map(|v| !v.is_empty()).unwrap_or(false)
    }

    pub fn may_attempt(&self, origin: &str) -> bool {
        if !self.public || self.knows(origin) {
            return false;
        }
        if self.discovered.len() >= MAX_DISCOVERED_ORIGINS {
            return false;
        }
        match self.attempted.get(origin) {
            Some(at) => at.elapsed() >= DISCOVERY_RETRY_AFTER,
            None => true,
        }
    }

    /// Claimed under the write lock before the network call so concurrent requests make one lookup.
    pub fn note_attempt(&mut self, origin: &str) {
        if self.attempted.len() >= MAX_ATTEMPT_LEDGER {
            self.attempted.retain(|_, at| at.elapsed() < DISCOVERY_RETRY_AFTER);
            if self.attempted.len() >= MAX_ATTEMPT_LEDGER {
                return;
            }
        }
        self.attempted.insert(origin.to_string(), Instant::now());
    }

    pub fn merge_keys(&mut self, origin: &str, discovered: Vec<(String, String)>, base: Option<String>) {
        if discovered.is_empty() {
            return;
        }
        let entry = self.keys.entry(origin.to_string()).or_default();
        for (kid, pk) in discovered {
            if !entry.iter().any(|(k, _)| k == &kid) {
                entry.push((kid, pk));
            }
        }
        if let Some(base) = base {
            if self.discovered.len() < MAX_DISCOVERED_ORIGINS || self.discovered.contains_key(origin) {
                self.discovered.insert(origin.to_string(), base);
            }
        }
    }

    pub async fn refresh_discovery(&mut self, cfg: &TrustConfig) {
        if self.discovery {
            for o in &cfg.origins {
                let Some(base) = o.discovery_url.clone() else { continue };
                let url = format!("{}/_telium/v1/keys", base.trim_end_matches('/'));
                // Typed into sfu.toml by the operator, so plaintext and LAN addresses are their call.
                match fetch_keys(&url, AddressPolicy::OperatorConfigured).await {
                    Ok((name, discovered)) if name == o.server_name => {
                        self.merge_keys(&o.server_name.clone(), discovered, None);
                        tracing::info!(origin = %o.server_name, "refreshed keys via discovery");
                    }
                    Ok((name, _)) => {
                        tracing::warn!(origin = %o.server_name, found = %name,
                            "discovery returned mismatched server_name");
                    }
                    Err(e) => tracing::warn!(origin = %o.server_name, error = %e, "key discovery failed"),
                }
            }
        }

        // Stay untrusted: being fetched once does not promote a stranger's URL into configuration.
        let policy = self.discovery_policy();
        let bases: Vec<(String, String)> = self
            .discovered
            .iter()
            .map(|(o, b)| (o.clone(), b.clone()))
            .collect();
        for (origin, base) in bases {
            let url = format!("{}/_telium/v1/keys", base.trim_end_matches('/'));
            if let Ok((name, discovered)) = fetch_keys(&url, policy).await {
                if name == origin {
                    self.merge_keys(&origin, discovered, None);
                }
            }
        }
    }

    /// Returns the resolved API base URL so callers can persist it.
    pub async fn discover_origin(&mut self, origin: &str, policy: AddressPolicy) -> Option<String> {
        let (base, keys) = discover_keys(origin, policy).await?;
        self.merge_keys(origin, keys, Some(base.clone()));
        tracing::info!(origin, "discovered origin keys via federation discovery");
        Some(base)
    }

    pub fn verify_json(&self, value: &Value) -> bool {
        let (Some(origin), Some(key_id)) = (
            value.get("origin").and_then(Value::as_str),
            value.get("key_id").and_then(Value::as_str),
        ) else {
            return false;
        };
        let Some(keys) = self.keys.get(origin) else {
            return false;
        };
        let Some((_, public_b64)) = keys.iter().find(|(k, _)| k == key_id) else {
            return false;
        };
        telium_protocol::verify_json(public_b64, value)
    }
}

async fn discover_keys(origin: &str, policy: AddressPolicy) -> Option<(String, Vec<(String, String)>)> {
    let base = match discover_base(origin, policy).await {
        Some(b) => b,
        None => {
            tracing::warn!(origin, "could not resolve origin via well-known discovery");
            return None;
        }
    };
    let url = format!("{}/_telium/v1/keys", base.trim_end_matches('/'));
    match fetch_keys(&url, policy).await {
        // The document must name the server we asked about, or we would file somebody else's keys under this origin.
        Ok((name, keys)) if name == origin => Some((base, keys)),
        Ok((name, _)) => {
            tracing::warn!(origin, found = %name, "discovered server_name mismatch");
            None
        }
        Err(e) => {
            tracing::warn!(origin, error = %e, "origin key discovery failed");
            None
        }
    }
}

/// No lock is held across the network call, or one black-holed host would block every request.
pub async fn maybe_discover(trust: &Arc<RwLock<TrustedKeys>>, value: &Value) {
    let origin = match value.get("origin").and_then(Value::as_str) {
        Some(o) if !o.is_empty() => o.to_string(),
        _ => return,
    };
    // A name that is not a bare authority is never worth a DNS lookup and must not reach a format string.
    if fetch::parse_authority(&origin).is_none() {
        return;
    }
    let policy = {
        let guard = trust.read().await;
        if !guard.may_attempt(&origin) {
            return;
        }
        guard.discovery_policy()
    };
    {
        // Re-check under the write lock and claim the attempt, so concurrent requests collapse into one lookup.
        let mut guard = trust.write().await;
        if !guard.may_attempt(&origin) {
            return;
        }
        guard.note_attempt(&origin);
    }

    let Some((base, keys)) = discover_keys(&origin, policy).await else {
        return;
    };
    trust.write().await.merge_keys(&origin, keys, Some(base));
}

/// Text pointers may only select this account domain or its descendants.
fn parse_txt_pointer(line: &str, origin: &str) -> Option<String> {
    if line.is_empty() || line.len() > 512 || line.contains('\r') || line.contains('\n') {
        return None;
    }
    let raw = if line.contains("://") { line.to_string() } else { format!("https://{line}") };
    let url = reqwest::Url::parse(&raw).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return None;
    }
    let hostname = url.host_str()?.to_ascii_lowercase();
    let identity = origin.split(':').next()?.trim_end_matches('.').to_ascii_lowercase();
    if hostname != identity && !hostname.ends_with(&format!(".{identity}")) {
        return None;
    }
    if url.port().is_some() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// Untrusted origins get https only; falling back to http would undo the domain-key binding.
async fn discover_base(origin: &str, policy: AddressPolicy) -> Option<String> {
    let (host, port) = fetch::parse_authority(origin)?;
    let authority = match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };

    let schemes: &[&str] = match policy {
        AddressPolicy::Untrusted => &["https"],
        AddressPolicy::OperatorConfigured => &["https", "http"],
    };
    for scheme in schemes {
        let url = format!("{scheme}://{authority}/.well-known/telium/server");
        if let Ok(doc) = fetch::get_json(&url, policy, MAX_DOCUMENT_BYTES).await {
            if let Some(api) = doc.get("api").and_then(Value::as_str) {
                // The key fetcher re-validates the API's address and signed keys.
                return Some(api.to_string());
            }
        }

        // A static website may only contain /telium.txt; load live discovery
        // from that backend and verify the claimed account domain.
        let pointer_url = format!("{scheme}://{authority}/telium.txt");
        let bytes = match fetch::get_bytes(&pointer_url, policy, 512, Duration::from_secs(8)).await {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };
        let pointer = match std::str::from_utf8(&bytes) {
            Ok(text) => text.trim(),
            Err(_) => continue,
        };
        let Some(target) = parse_txt_pointer(pointer, origin) else { continue };
        let live = format!("{target}/.well-known/telium/server");
        if let Ok(doc) = fetch::get_json(&live, policy, MAX_DOCUMENT_BYTES).await {
            if doc.get("server_name").and_then(Value::as_str) == Some(origin)
                && doc.get("api").and_then(Value::as_str).map(|api| api.trim_end_matches('/')) == Some(target.as_str()) {
                return Some(target);
            }
        }
    }
    None
}

/// The self-signature proves consistency, not domain ownership; the caller compares `server_name`.
async fn fetch_keys(url: &str, policy: AddressPolicy) -> Result<(String, Vec<(String, String)>)> {
    let resp = fetch::get_json(url, policy, MAX_DOCUMENT_BYTES).await?;

    let server_name = resp
        .get("server_name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("keys response missing server_name"))?
        .to_string();
    let current = resp
        .get("current_key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("keys response missing current_key_id"))?
        .to_string();
    let verify_keys = resp
        .get("verify_keys")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("keys response missing verify_keys"))?;

    let Some(current_key) = verify_keys.get(&current).and_then(|v| v.get("key")).and_then(Value::as_str) else {
        return Err(anyhow::anyhow!("current key not present in verify_keys"));
    };
    if !telium_protocol::verify_json(current_key, &resp) {
        return Err(anyhow::anyhow!("keys response self-signature invalid"));
    }

    let mut out = Vec::new();
    for (kid, v) in verify_keys {
        if let Some(pk) = v.get("key").and_then(Value::as_str) {
            out.push((kid.clone(), pk.to_string()));
        }
    }
    Ok((server_name, out))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TrustedOrigin;

    fn trust(public: bool) -> TrustedKeys {
        TrustedKeys::from_config(&TrustConfig {
            discovery: true,
            cache_ttl_secs: 86400,
            public,
            allow_insecure_discovery: false,
            origins: Vec::new(),
        })
    }

    #[test]
    fn text_pointer_is_confined_to_the_account_domain() {
        assert_eq!(parse_txt_pointer("chat.example.com", "example.com"),
            Some("https://chat.example.com".into()));
        for bad in ["http://chat.example.com", "https://attacker.com",
                    "https://evil-example.com", "https://chat.example.com/path",
                    "https://chat.example.com\nhttps://attacker.com"] {
            assert!(parse_txt_pointer(bad, "example.com").is_none(), "{bad}");
        }
    }

    #[test]
    fn discovery_only_origin_is_not_known_until_a_real_key_is_loaded() {
        let trust = TrustedKeys::from_config(&TrustConfig {
            discovery: true,
            cache_ttl_secs: 86400,
            public: false,
            allow_insecure_discovery: false,
            origins: vec![TrustedOrigin {
                server_name: "chat.example.com".into(),
                key_id: String::new(),
                public_key_b64: String::new(),
                discovery_url: Some("https://chat.example.com".into()),
            }],
        });
        assert!(!trust.knows("chat.example.com"));
    }

    #[test]
    fn discovery_attempts_are_gated_and_bounded() {
        assert!(!trust(false).may_attempt("chat.example.com"), "a private SFU never discovers");
        let mut t = trust(true);
        t.note_attempt("nowhere.example");
        assert!(!t.may_attempt("nowhere.example"));
        assert!(t.may_attempt("elsewhere.example"));
        for i in 0..MAX_ATTEMPT_LEDGER + 100 {
            t.note_attempt(&format!("a{i}.example"));
        }
        assert!(t.attempted.len() <= MAX_ATTEMPT_LEDGER);
        for i in 0..MAX_DISCOVERED_ORIGINS + 50 {
            t.merge_keys(&format!("o{i}.example"), vec![("ed25519:k".into(), "pk".into())], Some("https://x.example".into()));
        }
        assert_eq!(t.discovered.len(), MAX_DISCOVERED_ORIGINS);
        assert!(!t.may_attempt("brand-new.example"), "a full map stops attempting new discovery");
    }

    #[tokio::test]
    async fn discovery_refuses_non_bare_origins_and_holds_no_lock_while_waiting() {
        let t = Arc::new(RwLock::new(trust(true)));
        for origin in ["169.254.169.254/latest", "real.example@evil.example", "https://evil.example", "evil.example\nHost: x"] {
            maybe_discover(&t, &serde_json::json!({ "origin": origin })).await;
            assert!(!t.read().await.attempted.contains_key(origin), "{origin:?}");
        }
        let t2 = t.clone();
        let bg = tokio::spawn(async move { maybe_discover(&t2, &serde_json::json!({ "origin": "unreachable.invalid" })).await });
        tokio::task::yield_now().await;
        assert!(tokio::time::timeout(Duration::from_secs(2), t.read()).await.is_ok());
        let _ = tokio::time::timeout(Duration::from_secs(20), bg).await;
    }
}
