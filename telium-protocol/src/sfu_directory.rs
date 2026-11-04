//! The public SFU directory: relays run by volunteer operators, published as one signed
//! document. Discovery with a proven track record — an entry here is a suggestion, never
//! an obligation: it becomes call traffic only when a guild's automatic mode resolves to
//! it, and only while it stays listed, healthy and accepting.
//!
//! Load and `accepting` change by the minute and are deliberately absent: subscribers
//! learn them from the relay's own `/health`, not from a document that is only refreshed
//! hourly. What this document carries are the slow facts — who runs the relay, where it
//! is, what it claims to carry — sealed by the publisher.

use crate::curator_directory;
use crate::media_feed::{self as feed, is_display_text, MAX_CONTACT_CHARS, MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS};
use crate::{sign_json, verify_json};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

pub const KIND: &str = "telium.sfu_directory";

pub const VERSION: u64 = 1;

pub const MAX_BYTES: usize = 128 * 1024;

pub const MAX_SFUS: usize = 128;

pub const MAX_URL_CHARS: usize = 400;

/// How long a key hint (`pubkey_hint`) may be.
pub const MAX_HINT_CHARS: usize = 128;

/// The bands an operator may declare for its uplink. Self-declared like the server
/// registry's size bands, and cross-checked by the load the probes actually observe.
pub const CAPACITY_BANDS: [&str; 4] = ["<100m", "100m", "1g", "10g"];

/// One listed relay. The base URL is the identity; everything else is presentation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sfu {
    /// Base URL of a telium-sfu, e.g. `https://sfu.example`. HTTPS only, no credentials.
    pub url: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Machine region code, e.g. `eu-central`. Loose here; the site schema owns the enum.
    pub region: String,
    /// Human label shown to users, e.g. `Frankfurt, DE`.
    pub region_label: String,
    pub operator_name: String,
    /// How to reach the operator. Shown as text, never turned into a link.
    pub contact: String,
    /// One of `CAPACITY_BANDS`: the operator's declared uplink.
    pub capacity_band: String,
    /// 1–3. Damps automatic selection so a heavily-proven relay ranks higher without any
    /// single one being forced on everyone; never a share quota.
    pub weight: u64,
    /// Carried to clients; nothing reads it yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pubkey_hint: Option<String>,
}

/// The gates the publisher applied before listing, in the open. Display-only for
/// subscribers — the enforcement happened before this document was signed — but they
/// travel with the signature so clients can explain a thin directory and so the
/// publisher can launch lenient and tighten later without a protocol change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Criteria {
    /// Observed age under the publisher's probes before an entry is listed.
    #[serde(default)]
    pub min_observed_age_days: u64,
    /// Minimum 30-day uptime percent.
    #[serde(default)]
    pub min_uptime_percent: u64,
    /// How fresh the probes behind a listing must be.
    #[serde(default)]
    pub max_probe_age_minutes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Directory {
    pub kind: String,
    pub version: u64,
    pub publisher: String,
    pub serial: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub criteria: Criteria,
    pub sfus: Vec<Sfu>,
}

impl Directory {
    pub fn new(publisher: &str, serial: u64, issued_at: i64, expires_at: i64, sfus: Vec<Sfu>) -> Self {
        Self {
            kind: KIND.to_string(),
            version: VERSION,
            publisher: publisher.to_string(),
            serial,
            issued_at,
            expires_at,
            criteria: Criteria::default(),
            sfus,
        }
    }

    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at <= now_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectoryError {
    TooLarge,
    NotJson,
    BadSignature,
    WrongKind,
    UnsupportedVersion(u64),
    Malformed(String),
    TooManySfus(usize),
    BadText(&'static str),
    BadSfuUrl(String),
    BadCapacityBand(String),
    BadWeight(u64),
    DuplicateSfu(String),
    BadWindow,
    IssuedInFuture,
    Expired,
    Rollback { have: u64, got: u64 },
    Equivocation { serial: u64 },
}

impl fmt::Display for DirectoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DirectoryError::TooLarge => write!(f, "directory is larger than {MAX_BYTES} bytes"),
            DirectoryError::NotJson => write!(f, "directory is not JSON"),
            DirectoryError::BadSignature => {
                write!(f, "directory signature does not verify against the pinned key")
            }
            DirectoryError::WrongKind => write!(f, "document is not an SFU directory"),
            DirectoryError::UnsupportedVersion(v) => {
                write!(f, "directory format version {v} is not supported")
            }
            DirectoryError::Malformed(e) => write!(f, "directory is malformed: {e}"),
            DirectoryError::TooManySfus(n) => {
                write!(f, "directory lists {n} SFUs; at most {MAX_SFUS} are read")
            }
            DirectoryError::BadText(field) => {
                write!(f, "a {field} in the directory is empty, over-long or not plain text")
            }
            DirectoryError::BadSfuUrl(u) => write!(f, "directory lists {u:?}, which is not an SFU base URL"),
            DirectoryError::BadCapacityBand(b) => {
                write!(f, "directory declares capacity band {b:?}; expected one of {CAPACITY_BANDS:?}")
            }
            DirectoryError::BadWeight(w) => write!(f, "directory declares weight {w}; expected 1 to 3"),
            DirectoryError::DuplicateSfu(u) => write!(f, "directory lists {u} more than once"),
            DirectoryError::BadWindow => write!(f, "directory expires before it was issued"),
            DirectoryError::IssuedInFuture => write!(f, "directory claims to be issued in the future"),
            DirectoryError::Expired => write!(f, "directory has already expired"),
            DirectoryError::Rollback { have, got } => write!(
                f,
                "directory serial {got} is older than the {have} already held; refused as a rollback"
            ),
            DirectoryError::Equivocation { serial } => {
                write!(f, "directory serial {serial} was already seen with different contents")
            }
        }
    }
}

impl std::error::Error for DirectoryError {}

/// An SFU base URL is the same shape as a feed URL: a bare HTTPS origin, no credentials,
/// no whitespace. Shape check only; whether the address may be reached is the fetcher's
/// decision.
pub fn is_sfu_url(url: &str) -> bool {
    if url.chars().count() > MAX_URL_CHARS {
        return false;
    }
    curator_directory::is_feed_url(url)}

pub fn sign(signing: &SigningKey, key_id: &str, directory: &Directory) -> Value {
    let body = serde_json::to_value(directory).expect("directory is serialisable");
    sign_json(signing, key_id, body)
}

pub fn verify(
    bytes: &[u8],
    public_b64: &str,
    now_ms: i64,
    max_skew_ms: i64,
) -> Result<Directory, DirectoryError> {
    if bytes.len() > MAX_BYTES {
        return Err(DirectoryError::TooLarge);
    }
    let doc: Value = serde_json::from_slice(bytes).map_err(|_| DirectoryError::NotJson)?;
    if !verify_json(public_b64, &doc) {
        return Err(DirectoryError::BadSignature);
    }
    if doc.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Err(DirectoryError::WrongKind);
    }
    match doc.get("version").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(other) => return Err(DirectoryError::UnsupportedVersion(other)),
        None => return Err(DirectoryError::Malformed("missing version".into())),
    }
    let mut body = doc;
    if let Some(obj) = body.as_object_mut() {
        obj.remove("signature");
        obj.remove("key_id");
    }
    let directory: Directory =
        serde_json::from_value(body).map_err(|e| DirectoryError::Malformed(e.to_string()))?;

    if directory.sfus.len() > MAX_SFUS {
        return Err(DirectoryError::TooManySfus(directory.sfus.len()));
    }
    if !is_display_text(&directory.publisher, MAX_NAME_CHARS) {
        return Err(DirectoryError::BadText("publisher name"));
    }
    if directory.criteria.min_uptime_percent > 100 {
        return Err(DirectoryError::Malformed("criteria min_uptime_percent exceeds 100".into()));
    }
    let mut seen = HashSet::new();
    for sfu in &directory.sfus {
        if !is_sfu_url(&sfu.url) {
            return Err(DirectoryError::BadSfuUrl(sfu.url.clone()));
        }
        if !is_display_text(&sfu.name, MAX_NAME_CHARS) {
            return Err(DirectoryError::BadText("SFU name"));
        }
        if !is_display_text(&sfu.region, MAX_NAME_CHARS) {
            return Err(DirectoryError::BadText("SFU region"));
        }
        if !is_display_text(&sfu.region_label, MAX_NAME_CHARS) {
            return Err(DirectoryError::BadText("SFU region label"));
        }
        if !is_display_text(&sfu.operator_name, MAX_NAME_CHARS) {
            return Err(DirectoryError::BadText("operator name"));
        }
        if !is_display_text(&sfu.contact, MAX_CONTACT_CHARS) {
            return Err(DirectoryError::BadText("operator contact"));
        }
        if !CAPACITY_BANDS.contains(&sfu.capacity_band.as_str()) {
            return Err(DirectoryError::BadCapacityBand(sfu.capacity_band.clone()));
        }
        if !(1..=3).contains(&sfu.weight) {
            return Err(DirectoryError::BadWeight(sfu.weight));
        }
        for (field, text, max) in [
            ("SFU description", &sfu.description, MAX_DESCRIPTION_CHARS),
            ("SFU key hint", &sfu.pubkey_hint, MAX_HINT_CHARS),
        ] {
            if text.as_deref().is_some_and(|t| !is_display_text(t, max)) {
                return Err(DirectoryError::BadText(field));
            }
        }
        // The base URL is the identity; the same URL listed twice is at best a mistake.
        if !seen.insert(sfu.url.as_str()) {
            return Err(DirectoryError::DuplicateSfu(sfu.url.clone()));
        }
    }
    if directory.expires_at <= directory.issued_at {
        return Err(DirectoryError::BadWindow);
    }
    if directory.issued_at > now_ms.saturating_add(max_skew_ms) {
        return Err(DirectoryError::IssuedInFuture);
    }
    if directory.is_expired(now_ms) {
        return Err(DirectoryError::Expired);
    }
    Ok(directory)
}

pub fn check_update(
    held: Option<(u64, &str)>,
    serial: u64,
    digest: &str,
) -> Result<feed::Update, DirectoryError> {
    feed::check_update(held, serial, digest).map_err(|e| match e {
        feed::FeedError::Rollback { have, got } => DirectoryError::Rollback { have, got },
        feed::FeedError::Equivocation { serial } => DirectoryError::Equivocation { serial },
        other => DirectoryError::Malformed(other.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::b64;

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[31u8; 32])
    }

    fn public() -> String {
        b64(key().verifying_key().as_bytes())
    }

    fn entry() -> Sfu {
        Sfu {
            url: "https://sfu.example".into(),
            name: "Example Relay".into(),
            description: Some("A community-run relay in Frankfurt.".into()),
            region: "eu-central".into(),
            region_label: "Frankfurt, DE".into(),
            operator_name: "Example Collective".into(),
            contact: "https://example.org/contact".into(),
            capacity_band: "1g".into(),
            weight: 2,
            pubkey_hint: None,
        }
    }

    fn directory(serial: u64) -> Directory {
        Directory::new("telium.chat", serial, NOW - 1000, NOW + DAY, vec![entry()])
    }

    fn bytes(doc: &Value) -> Vec<u8> {
        serde_json::to_vec(doc).unwrap()
    }

    #[test]
    fn a_signed_directory_verifies_and_parses() {
        let doc = sign(&key(), "ed25519:sfu-directory", &directory(4));
        let parsed = verify(&bytes(&doc), &public(), NOW, 0).unwrap();
        assert_eq!(parsed, directory(4));
    }

    #[test]
    fn a_directory_is_only_read_under_the_key_its_reader_pinned() {
        let stranger = SigningKey::from_bytes(&[32u8; 32]);
        let doc = sign(&stranger, "k", &directory(4));
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));

        let mut doc = sign(&key(), "k", &directory(4));
        doc["sfus"][0]["url"] = Value::String("https://evil.example".into());
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));

        let doc = serde_json::to_value(directory(4)).unwrap();
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));
    }

    #[test]
    fn other_documents_cannot_pose_as_a_directory_and_the_reverse() {
        let mut body = serde_json::to_value(directory(4)).unwrap();
        body["kind"] = Value::String(feed::KIND.into());
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::WrongKind));

        let mut body = serde_json::to_value(directory(4)).unwrap();
        body["version"] = Value::from(9);
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::UnsupportedVersion(9)));
    }

    #[test]
    fn size_and_count_are_bounded_before_anything_is_read() {
        assert_eq!(verify(&vec![b' '; MAX_BYTES + 1], &public(), NOW, 0), Err(DirectoryError::TooLarge));

        let mut d = directory(4);
        d.sfus = (0..=MAX_SFUS)
            .map(|i| Sfu { url: format!("https://sfu{i}.example"), ..entry() })
            .collect();
        let doc = sign(&key(), "k", &d);
        assert_eq!(
            verify(&bytes(&doc), &public(), NOW, 0),
            Err(DirectoryError::TooManySfus(MAX_SFUS + 1))
        );
    }

    #[test]
    fn every_field_of_an_entry_is_checked() {
        let bad_urls = [
            "http://sfu.example",
            "https://user:pw@sfu.example",
            "https://",
            "https://sfu.example:0",
            "javascript:alert(1)",
            "https://sfu.example/a b",
        ];
        for url in bad_urls {
            assert!(!is_sfu_url(url), "{url}");
            let mut d = directory(4);
            d.sfus[0].url = url.into();
            let doc = sign(&key(), "k", &d);
            assert_eq!(
                verify(&bytes(&doc), &public(), NOW, 0),
                Err(DirectoryError::BadSfuUrl(url.into())),
                "{url}"
            );
        }
        assert!(is_sfu_url("https://sfu.example"));
        assert!(is_sfu_url("https://sfu.example:8443"));

        for band in ["<100m", "100m", "1g", "10g"] {
            let mut d = directory(4);
            d.sfus[0].capacity_band = band.into();
            assert!(verify(&bytes(&sign(&key(), "k", &d)), &public(), NOW, 0).is_ok(), "{band}");
        }
        let mut d = directory(4);
        d.sfus[0].capacity_band = "10tb".into();
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadCapacityBand("10tb".into())));

        for weight in [0, 4] {
            let mut d = directory(4);
            d.sfus[0].weight = weight;
            let doc = sign(&key(), "k", &d);
            assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadWeight(weight)));
        }

        let mut d = directory(4);
        d.sfus[0].name = "<script>alert(1)</script>\u{202e}".into();
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadText("SFU name")));

        let mut d = directory(4);
        d.sfus[0].pubkey_hint = Some("x".repeat(MAX_HINT_CHARS + 1));
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadText("SFU key hint")));

        let mut d = directory(4);
        d.criteria.min_uptime_percent = 101;
        let doc = sign(&key(), "k", &d);
        assert!(matches!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::Malformed(_))));

        let mut d = directory(4);
        d.sfus.push(entry());
        let doc = sign(&key(), "k", &d);
        assert!(matches!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::DuplicateSfu(_))));
    }

    #[test]
    fn the_validity_window_and_the_serial_behave_as_a_feed_does() {
        let doc = sign(&key(), "k", &directory(4));
        assert_eq!(verify(&bytes(&doc), &public(), NOW + DAY, 0), Err(DirectoryError::Expired));

        let mut d = directory(4);
        d.issued_at = NOW + 10 * 60_000;
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 60_000), Err(DirectoryError::IssuedInFuture));

        assert_eq!(check_update(None, 1, "a"), Ok(feed::Update::Replace));
        assert_eq!(check_update(Some((4, "a")), 4, "a"), Ok(feed::Update::Unchanged));
        assert_eq!(
            check_update(Some((4, "a")), 4, "b"),
            Err(DirectoryError::Equivocation { serial: 4 })
        );
        assert_eq!(
            check_update(Some((4, "a")), 3, "c"),
            Err(DirectoryError::Rollback { have: 4, got: 3 })
        );
    }
}
