//! Signed catalogues of managed guild-hosting providers.

use crate::{sign_json, unb64, verify_json};
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

/// The `kind` every hosting catalogue carries, so other signed documents cannot be replayed as one.
pub const KIND: &str = "telium.hosting_catalog";

/// A newer format version is not adopted; the subscriber keeps what it has.
pub const VERSION: u64 = 1;

pub const MAX_BYTES: usize = 256 * 1024;

pub const MAX_PROVIDERS: usize = 200;

pub const MAX_PLANS: usize = 12;

pub const MAX_REGIONS: usize = 40;

const MAX_SHORT: usize = 64;

const MAX_TEXT: usize = 600;

const MAX_URL: usize = 512;

const MAX_PRICE_MINOR: i64 = 100_000_000;

/// The largest byte quota a plan may name: an exabyte, which still fits an `i64` after arithmetic.
const MAX_QUOTA_BYTES: i64 = 1 << 60;

const MAX_MEMBER_CAP: i64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Period {
    Free,
    Monthly,
    Yearly,
    Metered,
}

impl Period {
    pub fn as_str(self) -> &'static str {
        match self {
            Period::Free => "free",
            Period::Monthly => "monthly",
            Period::Yearly => "yearly",
            Period::Metered => "metered",
        }
    }
}

/// Limits are optional because "not stated" and "unlimited" differ.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    /// Minor units of [`Plan::currency`] (cents, pence, yen); an integer, never a float.
    pub price_minor: i64,
    pub currency: String,
    pub period: Period,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_cap: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_quota_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// Where the provider's Telium servers live. Shown, never dialled by the catalogue's say-so.
    pub base_url: String,
    pub signup_url: String,
    pub terms_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub plans: Vec<Plan>,
    /// Not used to verify this document; lets a subscriber pin the provider later.
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Catalog {
    pub kind: String,
    pub version: u64,
    pub publisher: String,
    /// Strictly increases with every change, so last month's catalogue cannot be replayed.
    pub serial: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub providers: Vec<Provider>,
}

impl Catalog {
    pub fn new(publisher: &str, serial: u64, issued_at: i64, expires_at: i64, providers: Vec<Provider>) -> Self {
        Self {
            kind: KIND.to_string(),
            version: VERSION,
            publisher: publisher.to_string(),
            serial,
            issued_at,
            expires_at,
            providers,
        }
    }

    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at <= now_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CatalogError {
    TooLarge,
    NotJson,
    BadSignature,
    WrongKind,
    UnsupportedVersion(u64),
    Malformed(String),
    TooManyProviders(usize),
    DuplicateProvider(String),
    BadField { provider: String, field: &'static str, why: String },
    BadWindow,
    IssuedInFuture,
    Expired,
    Rollback { have: u64, got: u64 },
    Equivocation { serial: u64 },
}

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CatalogError::TooLarge => write!(f, "catalog is larger than {MAX_BYTES} bytes"),
            CatalogError::NotJson => write!(f, "catalog is not JSON"),
            CatalogError::BadSignature => {
                write!(f, "catalog signature does not verify against the pinned key")
            }
            CatalogError::WrongKind => write!(f, "document is not a hosting catalog"),
            CatalogError::UnsupportedVersion(v) => write!(f, "catalog format version {v} is not supported"),
            CatalogError::Malformed(e) => write!(f, "catalog is malformed: {e}"),
            CatalogError::TooManyProviders(n) => {
                write!(f, "catalog lists {n} providers; at most {MAX_PROVIDERS} are read")
            }
            CatalogError::DuplicateProvider(id) => write!(f, "catalog lists provider {id} more than once"),
            CatalogError::BadField { provider, field, why } => {
                write!(f, "provider {provider}: {field} {why}")
            }
            CatalogError::BadWindow => write!(f, "catalog expires before it was issued"),
            CatalogError::IssuedInFuture => write!(f, "catalog claims to be issued in the future"),
            CatalogError::Expired => write!(f, "catalog has already expired"),
            CatalogError::Rollback { have, got } => {
                write!(f, "catalog serial {got} is older than the {have} already held; refused as a rollback")
            }
            CatalogError::Equivocation { serial } => {
                write!(f, "catalog serial {serial} was already seen with different contents")
            }
        }
    }
}

impl std::error::Error for CatalogError {}

pub fn is_public_key(key: &str) -> bool {
    unb64(key)
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .is_some_and(|bytes| VerifyingKey::from_bytes(&bytes).is_ok())
}

pub fn is_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SHORT
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// `userinfo` is refused (`https://real.example@evil.example` lies); parsed by hand so only a small shape passes.
pub fn is_https_url(url: &str) -> bool {
    if url.len() > MAX_URL || !url.is_ascii() || url.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') {
        return false;
    }
    crate::media_feed::is_origin(&authority.to_ascii_lowercase())
}

fn is_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty()
        && text.chars().count() <= max
        && !text.chars().any(|c| c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}

fn is_currency(code: &str) -> bool {
    code.len() == 3 && code.bytes().all(|b| b.is_ascii_uppercase())
}

fn bad(provider: &str, field: &'static str, why: &str) -> CatalogError {
    CatalogError::BadField { provider: provider.to_string(), field, why: why.to_string() }
}

pub fn check_provider(p: &Provider) -> Result<(), CatalogError> {
    let id = p.id.as_str();
    if !is_id(id) {
        return Err(bad(id, "id", "is not an identifier"));
    }
    if !is_text(&p.name, MAX_SHORT) {
        return Err(bad(id, "name", "is empty, too long, or carries control characters"));
    }
    for (field, url) in [("base_url", &p.base_url), ("signup_url", &p.signup_url), ("terms_url", &p.terms_url)] {
        if !is_https_url(url) {
            return Err(bad(id, field, "is not an https URL with a host and no credentials"));
        }
    }
    if let Some(url) = &p.privacy_url {
        if !is_https_url(url) {
            return Err(bad(id, "privacy_url", "is not an https URL with a host and no credentials"));
        }
    }
    if let Some(contact) = &p.contact {
        if !is_text(contact, MAX_SHORT * 2) {
            return Err(bad(id, "contact", "is empty, too long, or carries control characters"));
        }
    }
    if let Some(description) = &p.description {
        if !is_text(description, MAX_TEXT) {
            return Err(bad(id, "description", "is empty, too long, or carries control characters"));
        }
    }
    if !is_public_key(&p.public_key) {
        return Err(bad(id, "public_key", "is not an Ed25519 public key"));
    }
    if p.regions.len() > MAX_REGIONS {
        return Err(bad(id, "regions", "lists more regions than are read"));
    }
    for region in &p.regions {
        if !is_text(region, MAX_SHORT) {
            return Err(bad(id, "regions", "contains an empty, overlong or control-bearing name"));
        }
    }
    if p.plans.len() > MAX_PLANS {
        return Err(bad(id, "plans", "lists more plans than are read"));
    }
    let mut seen = HashSet::new();
    for plan in &p.plans {
        if !is_id(&plan.id) {
            return Err(bad(id, "plans", "contains a plan whose id is not an identifier"));
        }
        if !seen.insert(plan.id.as_str()) {
            return Err(bad(id, "plans", "lists one plan id twice"));
        }
        if !is_text(&plan.name, MAX_SHORT) {
            return Err(bad(id, "plans", "contains a plan with no usable name"));
        }
        if !is_currency(&plan.currency) {
            return Err(bad(id, "plans", "contains a plan whose currency is not a three-letter code"));
        }
        if !(0..=MAX_PRICE_MINOR).contains(&plan.price_minor) {
            return Err(bad(id, "plans", "contains a plan whose price is negative or implausible"));
        }
        if plan.period == Period::Free && plan.price_minor != 0 {
            return Err(bad(id, "plans", "contains a free plan with a price on it"));
        }
        for (limit, what) in [
            (plan.member_cap, MAX_MEMBER_CAP),
            (plan.storage_bytes, MAX_QUOTA_BYTES),
            (plan.media_quota_bytes, MAX_QUOTA_BYTES),
        ] {
            if limit.is_some_and(|value| !(0..=what).contains(&value)) {
                return Err(bad(id, "plans", "contains a limit that is negative or implausible"));
            }
        }
        if let Some(notes) = &plan.notes {
            if !is_text(notes, MAX_TEXT) {
                return Err(bad(id, "plans", "contains notes that are empty, too long, or control-bearing"));
            }
        }
    }
    Ok(())
}

pub fn sign(signing: &SigningKey, key_id: &str, catalog: &Catalog) -> Value {
    let body = serde_json::to_value(catalog).expect("catalog is serialisable");
    sign_json(signing, key_id, body)
}

/// Order: size, signature, kind and version, then shape.
pub fn verify(bytes: &[u8], public_b64: &str, now_ms: i64, max_skew_ms: i64) -> Result<Catalog, CatalogError> {
    if bytes.len() > MAX_BYTES {
        return Err(CatalogError::TooLarge);
    }
    let doc: Value = serde_json::from_slice(bytes).map_err(|_| CatalogError::NotJson)?;
    if !verify_json(public_b64, &doc) {
        return Err(CatalogError::BadSignature);
    }
    if doc.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Err(CatalogError::WrongKind);
    }
    match doc.get("version").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(other) => return Err(CatalogError::UnsupportedVersion(other)),
        None => return Err(CatalogError::Malformed("missing version".into())),
    }
    let mut body = doc;
    if let Some(obj) = body.as_object_mut() {
        obj.remove("signature");
        obj.remove("key_id");
    }
    let catalog: Catalog = serde_json::from_value(body).map_err(|e| CatalogError::Malformed(e.to_string()))?;

    if !is_text(&catalog.publisher, MAX_SHORT * 2) {
        return Err(CatalogError::Malformed("publisher is empty, too long, or control-bearing".into()));
    }
    if catalog.providers.len() > MAX_PROVIDERS {
        return Err(CatalogError::TooManyProviders(catalog.providers.len()));
    }
    let mut seen = HashSet::new();
    for provider in &catalog.providers {
        check_provider(provider)?;
        if !seen.insert(provider.id.as_str()) {
            return Err(CatalogError::DuplicateProvider(provider.id.clone()));
        }
    }
    if catalog.expires_at <= catalog.issued_at {
        return Err(CatalogError::BadWindow);
    }
    if catalog.issued_at > now_ms.saturating_add(max_skew_ms) {
        return Err(CatalogError::IssuedInFuture);
    }
    if catalog.is_expired(now_ms) {
        return Err(CatalogError::Expired);
    }
    Ok(catalog)
}

/// Tells a rotated publisher key from a non-catalogue response (error page, captive portal): strong evidence, not proof.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignSignature {
    pub key_id: Option<String>,
}

/// Call only on a document that already failed `verify` with `BadSignature`.
pub fn foreign_signature(bytes: &[u8]) -> Option<ForeignSignature> {
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let doc: Value = serde_json::from_slice(bytes).ok()?;
    let obj = doc.as_object()?;
    if obj.get("kind").and_then(Value::as_str) != Some(KIND) {
        return None;
    }
    if obj.get("version").and_then(Value::as_u64) != Some(VERSION) {
        return None;
    }
    // A real signature length, not merely a `signature` key: any JSON error page mentions the word.
    let sig = obj.get("signature").and_then(Value::as_str)?;
    if unb64(sig).is_none_or(|raw| raw.len() != 64) {
        return None;
    }
    // And a body that is really a catalogue; one this code cannot read could not be adopted even with the right key.
    let mut body = doc.clone();
    if let Some(o) = body.as_object_mut() {
        o.remove("signature");
        o.remove("key_id");
    }
    serde_json::from_value::<Catalog>(body).ok()?;
    let key_id = obj
        .get("key_id")
        .and_then(Value::as_str)
        .filter(|id| is_text(id, MAX_SHORT))
        .map(str::to_string);
    Some(ForeignSignature { key_id })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Update {
    Replace,
    Unchanged,
}

/// A lower serial is a replay; the same serial with different contents is contradictory. Both are refused.
pub fn check_update(held: Option<(u64, &str)>, serial: u64, digest: &str) -> Result<Update, CatalogError> {
    match held {
        None => Ok(Update::Replace),
        Some((have, _)) if serial > have => Ok(Update::Replace),
        Some((have, held_digest)) if serial == have => {
            if held_digest == digest {
                Ok(Update::Unchanged)
            } else {
                Err(CatalogError::Equivocation { serial })
            }
        }
        Some((have, _)) => Err(CatalogError::Rollback { have, got: serial }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::b64;

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[21u8; 32])
    }

    fn public() -> String {
        b64(key().verifying_key().as_bytes())
    }

    fn provider_key() -> String {
        b64(SigningKey::from_bytes(&[22u8; 32]).verifying_key().as_bytes())
    }

    fn plan() -> Plan {
        Plan {
            id: "small".into(),
            name: "Small".into(),
            price_minor: 500,
            currency: "EUR".into(),
            period: Period::Monthly,
            member_cap: Some(500),
            storage_bytes: Some(20 * 1024 * 1024 * 1024),
            media_quota_bytes: Some(5 * 1024 * 1024 * 1024),
            notes: None,
        }
    }

    fn provider() -> Provider {
        Provider {
            id: "aurora".into(),
            name: "Aurora Hosting".into(),
            base_url: "https://guilds.aurora.example".into(),
            signup_url: "https://aurora.example/signup".into(),
            terms_url: "https://aurora.example/terms".into(),
            privacy_url: Some("https://aurora.example/privacy".into()),
            contact: Some("support@aurora.example".into()),
            description: Some("Managed Telium guilds in the EU.".into()),
            regions: vec!["eu-west".into(), "eu-north".into()],
            plans: vec![plan()],
            public_key: provider_key(),
        }
    }

    fn catalog(serial: u64) -> Catalog {
        Catalog::new("catalog.example", serial, NOW - 1000, NOW + DAY, vec![provider()])
    }

    fn bytes(doc: &Value) -> Vec<u8> {
        serde_json::to_vec(doc).unwrap()
    }

    fn with_provider(tweak: impl FnOnce(&mut Provider)) -> Vec<u8> {
        let mut c = catalog(1);
        tweak(&mut c.providers[0]);
        bytes(&sign(&key(), "ed25519:test", &c))
    }

    #[test]
    fn a_catalog_signed_by_somebody_else_is_not_the_same_as_a_reply_that_is_not_a_catalog() {
        let stranger = SigningKey::from_bytes(&[99u8; 32]);
        let rotated = bytes(&sign(&stranger, "ed25519:hosting-2026", &catalog(4)));
        assert_eq!(verify(&rotated, &public(), NOW, 0), Err(CatalogError::BadSignature));
        let found = foreign_signature(&rotated).expect("a signed catalogue was not recognised as one");
        assert_eq!(found.key_id.as_deref(), Some("ed25519:hosting-2026"));

        assert_eq!(foreign_signature(b"<html>502 Bad Gateway</html>"), None);
        assert_eq!(foreign_signature(br#"{"error":"signature required"}"#), None);
        let mut doc = sign(&stranger, "ed25519:hosting", &catalog(4));
        doc.as_object_mut().unwrap().insert("signature".into(), Value::String("nope".into()));
        assert_eq!(foreign_signature(&bytes(&doc)), None);
        let mut doc = sign(&stranger, "ed25519:hosting", &catalog(4));
        doc.as_object_mut().unwrap().remove("providers");
        assert_eq!(foreign_signature(&bytes(&doc)), None);
    }

    fn refusal(doc: Vec<u8>) -> CatalogError {
        verify(&doc, &public(), NOW, 0).expect_err("document should have been refused")
    }

    #[test]
    fn a_signed_catalog_verifies_and_parses() {
        let doc = sign(&key(), "ed25519:test", &catalog(3));
        let parsed = verify(&bytes(&doc), &public(), NOW, 0).unwrap();
        assert_eq!(parsed, catalog(3));
        assert_eq!(parsed.providers[0].plans[0].member_cap, Some(500));
    }

    #[test]
    fn a_tampered_catalog_is_refused() {
        let mut doc = sign(&key(), "ed25519:test", &catalog(3));
        doc["providers"][0]["signup_url"] = Value::String("https://evil.example/signup".into());
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::BadSignature));
    }

    #[test]
    fn a_catalog_signed_by_another_key_is_refused() {
        let other = SigningKey::from_bytes(&[23u8; 32]);
        let doc = sign(&other, "ed25519:test", &catalog(3));
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::BadSignature));
    }

    #[test]
    fn an_oversize_document_is_refused_before_it_is_parsed() {
        assert_eq!(verify(&vec![b' '; MAX_BYTES + 1], &public(), NOW, 0), Err(CatalogError::TooLarge));
    }

    #[test]
    fn another_signed_kind_cannot_pose_as_a_catalog() {
        let mut body = serde_json::to_value(catalog(3)).unwrap();
        body["kind"] = Value::String("telium.media_origin_feed".into());
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::WrongKind));

        let mut body = serde_json::to_value(catalog(3)).unwrap();
        body["version"] = Value::from(9);
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::UnsupportedVersion(9)));
    }

    #[test]
    fn a_catalog_is_bounded_by_provider_count_and_uniqueness() {
        let mut c = catalog(1);
        c.providers = (0..=MAX_PROVIDERS)
            .map(|i| Provider { id: format!("p{i}"), ..provider() })
            .collect();
        let doc = sign(&key(), "k", &c);
        assert_eq!(
            verify(&bytes(&doc), &public(), NOW, 0),
            Err(CatalogError::TooManyProviders(MAX_PROVIDERS + 1))
        );

        let mut c = catalog(1);
        c.providers.push(provider());
        let doc = sign(&key(), "k", &c);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::DuplicateProvider("aurora".into())));
    }

    #[test]
    fn links_must_be_plain_https_addresses() {
        for bad_url in [
            "http://aurora.example/signup",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "https://real.example@evil.example/signup",
            "/signup",
            "",
        ] {
            let doc = with_provider(|p| p.signup_url = bad_url.into());
            assert!(
                matches!(refusal(doc), CatalogError::BadField { field: "signup_url", .. }),
                "{bad_url} was accepted as a signup link"
            );
        }
        assert!(is_https_url("https://aurora.example/signup?plan=small#tier"));
        assert!(!is_https_url(&format!("https://aurora.example/{}", "a".repeat(MAX_URL))));
    }

    #[test]
    fn provider_text_cannot_carry_layout_instructions() {
        for bad_name in ["", "   ", "Aurora\nHosting", "Aurora\u{202e}gnitsoH", "Aurora\u{0}"] {
            let doc = with_provider(|p| p.name = bad_name.into());
            assert!(
                matches!(refusal(doc), CatalogError::BadField { field: "name", .. }),
                "{bad_name:?} was accepted as a provider name"
            );
        }
        let doc = with_provider(|p| p.description = Some("x".repeat(MAX_TEXT + 1)));
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "description", .. }));
    }

    #[test]
    fn prices_and_limits_are_bounded_integers_in_a_named_currency() {
        let doc = with_provider(|p| p.plans[0].price_minor = -1);
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }));

        let doc = with_provider(|p| p.plans[0].price_minor = MAX_PRICE_MINOR + 1);
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }));

        for code in ["eur", "EURO", "E", ""] {
            let doc = with_provider(|p| p.plans[0].currency = code.into());
            assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }), "{code} accepted");
        }

        let doc = with_provider(|p| p.plans[0].storage_bytes = Some(-5));
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }));

        let doc = with_provider(|p| p.plans[0].member_cap = Some(MAX_MEMBER_CAP + 1));
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }));

        let doc = with_provider(|p| p.plans[0].period = Period::Free);
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "plans", .. }));

        let doc = with_provider(|p| {
            p.plans[0].period = Period::Free;
            p.plans[0].price_minor = 0;
        });
        assert!(verify(&doc, &public(), NOW, 0).is_ok(), "a genuinely free plan is fine");
    }

    #[test]
    fn a_provider_key_has_to_be_a_key() {
        let doc = with_provider(|p| p.public_key = "not-a-key".into());
        assert!(matches!(refusal(doc), CatalogError::BadField { field: "public_key", .. }));
        assert!(is_public_key(&provider_key()));
    }

    #[test]
    fn the_validity_window_is_enforced() {
        let doc = sign(&key(), "k", &catalog(3));
        assert_eq!(verify(&bytes(&doc), &public(), NOW + DAY, 0), Err(CatalogError::Expired));

        let mut c = catalog(3);
        c.issued_at = NOW + 10 * 60_000;
        let doc = sign(&key(), "k", &c);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 5 * 60_000), Err(CatalogError::IssuedInFuture));
        assert!(verify(&bytes(&doc), &public(), NOW, 15 * 60_000).is_ok(), "within the skew allowance");

        let mut c = catalog(3);
        c.expires_at = c.issued_at;
        let doc = sign(&key(), "k", &c);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(CatalogError::BadWindow));
    }

    #[test]
    fn a_held_copy_only_moves_forward() {
        assert_eq!(check_update(None, 1, "a"), Ok(Update::Replace));
        assert_eq!(check_update(Some((4, "a")), 5, "b"), Ok(Update::Replace));
        assert_eq!(check_update(Some((4, "a")), 4, "a"), Ok(Update::Unchanged));
        assert_eq!(check_update(Some((4, "a")), 4, "b"), Err(CatalogError::Equivocation { serial: 4 }));
        assert_eq!(check_update(Some((4, "a")), 3, "c"), Err(CatalogError::Rollback { have: 4, got: 3 }));
    }
}
