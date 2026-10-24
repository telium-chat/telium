//! Directories of media-origin curators: discovery, not trust; pinning is the moderator's act.

use crate::media_feed::{
    self as feed, is_display_text, is_public_key, MAX_CONTACT_CHARS, MAX_DESCRIPTION_CHARS, MAX_NAME_CHARS,
};
use crate::{sign_json, verify_json};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

pub const KIND: &str = "telium.media_curator_directory";

pub const VERSION: u64 = 1;

pub const MAX_BYTES: usize = 128 * 1024;

pub const MAX_CURATORS: usize = 256;

pub const MAX_URL_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Curator {
    pub name: String,
    pub feed_url: String,
    /// The Ed25519 public key a subscriber should pin for it. A suggestion until a moderator pins it.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// How to reach the curator. Shown as text, never turned into a link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Directory {
    pub kind: String,
    pub version: u64,
    pub publisher: String,
    pub serial: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub curators: Vec<Curator>,
}

impl Directory {
    pub fn new(publisher: &str, serial: u64, issued_at: i64, expires_at: i64, curators: Vec<Curator>) -> Self {
        Self {
            kind: KIND.to_string(),
            version: VERSION,
            publisher: publisher.to_string(),
            serial,
            issued_at,
            expires_at,
            curators,
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
    TooManyCurators(usize),
    BadText(&'static str),
    BadFeedUrl(String),
    BadKey(String),
    DuplicateCurator(String),
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
            DirectoryError::WrongKind => write!(f, "document is not a curator directory"),
            DirectoryError::UnsupportedVersion(v) => {
                write!(f, "directory format version {v} is not supported")
            }
            DirectoryError::Malformed(e) => write!(f, "directory is malformed: {e}"),
            DirectoryError::TooManyCurators(n) => {
                write!(f, "directory names {n} curators; at most {MAX_CURATORS} are read")
            }
            DirectoryError::BadText(field) => {
                write!(f, "a {field} in the directory is empty, over-long or not plain text")
            }
            DirectoryError::BadFeedUrl(u) => write!(f, "directory lists {u:?}, which is not a feed URL"),
            DirectoryError::BadKey(name) => {
                write!(f, "the entry for {name:?} does not pin an Ed25519 public key")
            }
            DirectoryError::DuplicateCurator(u) => write!(f, "directory lists {u} more than once"),
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

/// Shape check only; whether the address may be reached is the fetcher's decision.
pub fn is_feed_url(url: &str) -> bool {
    if url.chars().count() > MAX_URL_CHARS || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // `user:pass@host` puts a trusted-looking part before the `@`.
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let host = match authority.rsplit_once(':') {
        Some((host, port)) => {
            if !matches!(port.parse::<u32>(), Ok(1..=65535)) {
                return false;
            }
            host
        }
        None => authority,
    };
    feed::is_origin(&host.to_ascii_lowercase())
}

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

    if directory.curators.len() > MAX_CURATORS {
        return Err(DirectoryError::TooManyCurators(directory.curators.len()));
    }
    if !is_display_text(&directory.publisher, MAX_NAME_CHARS) {
        return Err(DirectoryError::BadText("publisher name"));
    }
    let mut seen = HashSet::new();
    for curator in &directory.curators {
        if !is_display_text(&curator.name, MAX_NAME_CHARS) {
            return Err(DirectoryError::BadText("curator name"));
        }
        if !is_feed_url(&curator.feed_url) {
            return Err(DirectoryError::BadFeedUrl(curator.feed_url.clone()));
        }
        if !is_public_key(&curator.key) {
            return Err(DirectoryError::BadKey(curator.name.clone()));
        }
        for (field, text, max) in [
            ("curator description", &curator.description, MAX_DESCRIPTION_CHARS),
            ("curator contact", &curator.contact, MAX_CONTACT_CHARS),
        ] {
            if text.as_deref().is_some_and(|t| !is_display_text(t, max)) {
                return Err(DirectoryError::BadText(field));
            }
        }
        // One (URL, key) pair is one curator; the same URL under two keys is a key rotation and legitimate.
        if !seen.insert((curator.feed_url.as_str(), curator.key.as_str())) {
            return Err(DirectoryError::DuplicateCurator(curator.feed_url.clone()));
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
        SigningKey::from_bytes(&[21u8; 32])
    }

    fn public() -> String {
        b64(key().verifying_key().as_bytes())
    }

    fn curator_key() -> String {
        b64(SigningKey::from_bytes(&[22u8; 32]).verifying_key().as_bytes())
    }

    fn entry() -> Curator {
        Curator {
            name: "Small Servers Co-op".into(),
            feed_url: "https://registry.example/hosts.json".into(),
            key: curator_key(),
            description: Some("Hosts vetted by the co-op's moderators.".into()),
            contact: Some("curators@registry.example".into()),
        }
    }

    fn directory(serial: u64) -> Directory {
        Directory::new("home.example", serial, NOW - 1000, NOW + DAY, vec![entry()])
    }

    fn bytes(doc: &Value) -> Vec<u8> {
        serde_json::to_vec(doc).unwrap()
    }

    #[test]
    fn a_signed_directory_verifies_and_parses() {
        let doc = sign(&key(), "ed25519:curator", &directory(4));
        let parsed = verify(&bytes(&doc), &public(), NOW, 0).unwrap();
        assert_eq!(parsed, directory(4));
    }

    #[test]
    fn a_directory_is_only_read_under_the_key_its_reader_pinned() {
        let stranger = SigningKey::from_bytes(&[23u8; 32]);
        let doc = sign(&stranger, "k", &directory(4));
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));

        let mut doc = sign(&key(), "k", &directory(4));
        doc["curators"][0]["key"] = Value::String(public());
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));

        let doc = serde_json::to_value(directory(4)).unwrap();
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadSignature));
    }

    #[test]
    fn a_feed_cannot_pose_as_a_directory_and_the_reverse() {
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
        d.curators = (0..=MAX_CURATORS)
            .map(|i| Curator { feed_url: format!("https://r{i}.example/f.json"), ..entry() })
            .collect();
        let doc = sign(&key(), "k", &d);
        assert_eq!(
            verify(&bytes(&doc), &public(), NOW, 0),
            Err(DirectoryError::TooManyCurators(MAX_CURATORS + 1))
        );
    }

    #[test]
    fn every_field_of_an_entry_is_checked() {
        let bad_urls = [
            "http://registry.example/hosts.json",
            "https://user:pw@registry.example/hosts.json",
            "https://",
            "https://registry.example:0/f.json",
            "javascript:alert(1)",
            "https://registry.example/a b",
        ];
        for url in bad_urls {
            assert!(!is_feed_url(url), "{url}");
            let mut d = directory(4);
            d.curators[0].feed_url = url.into();
            let doc = sign(&key(), "k", &d);
            assert_eq!(
                verify(&bytes(&doc), &public(), NOW, 0),
                Err(DirectoryError::BadFeedUrl(url.into())),
                "{url}"
            );
        }
        assert!(is_feed_url("https://registry.example/hosts.json"));
        assert!(is_feed_url("https://registry.example:8443/hosts.json?v=2"));

        let mut d = directory(4);
        d.curators[0].key = "not-a-key".into();
        let doc = sign(&key(), "k", &d);
        assert!(matches!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadKey(_))));

        let mut d = directory(4);
        d.curators[0].name = "<script>alert(1)</script>\u{202e}".into();
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadText("curator name")));

        let mut d = directory(4);
        d.curators[0].contact = Some("x".repeat(MAX_CONTACT_CHARS + 1));
        let doc = sign(&key(), "k", &d);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::BadText("curator contact")));

        let mut d = directory(4);
        d.curators.push(entry());
        let doc = sign(&key(), "k", &d);
        assert!(matches!(verify(&bytes(&doc), &public(), NOW, 0), Err(DirectoryError::DuplicateCurator(_))));
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
