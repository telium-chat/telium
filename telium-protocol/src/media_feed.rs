//! Curated media-origin feeds: a curator's signed claim about which origins deserve trust.

use crate::{sign_json, unb64, verify_json};
use ed25519_dalek::{SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;

/// The `kind` every media-origin feed carries, so other signed documents cannot be replayed as one.
pub const KIND: &str = "telium.media_origin_feed";

/// A newer format version is not adopted; the subscriber keeps what it has.
pub const VERSION: u64 = 1;

pub const MAX_BYTES: usize = 256 * 1024;

pub const MAX_ENTRIES: usize = 2000;

pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_DESCRIPTION_CHARS: usize = 600;
pub const MAX_CONTACT_CHARS: usize = 200;

/// Fit to show: non-empty, bounded, no control characters or bidi overrides.
pub fn is_display_text(text: &str, max_chars: usize) -> bool {
    !text.is_empty()
        && text.chars().count() <= max_chars
        && text.chars().all(|c| {
            !c.is_control()
                && !matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Block,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Allow => "allow",
            Action::Block => "block",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub origin: String,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_file_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abuse_contact: Option<String>,
}

/// Rides inside the feed so it is necessarily signed by the pinned key; an unverifiable rollover must not be followed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rollover {
    pub to_key: String,
    /// Counted from the key first pinned; only increases, so a replayed rotation is refused.
    pub rotation: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Feed {
    pub kind: String,
    pub version: u64,
    pub curator: String,
    pub serial: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub entries: Vec<Entry>,
    /// The curator keeps signing with the old key until subscribers have fetched one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollover: Option<Rollover>,
}

impl Feed {
    pub fn new(curator: &str, serial: u64, issued_at: i64, expires_at: i64, entries: Vec<Entry>) -> Self {
        Self {
            kind: KIND.to_string(),
            version: VERSION,
            curator: curator.to_string(),
            serial,
            issued_at,
            expires_at,
            entries,
            rollover: None,
        }
    }

    pub fn announcing(mut self, to_key: &str, rotation: u64) -> Self {
        self.rollover = Some(Rollover { to_key: to_key.to_string(), rotation });
        self
    }

    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at <= now_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedError {
    TooLarge,
    NotJson,
    BadSignature,
    WrongKind,
    UnsupportedVersion(u64),
    Malformed(String),
    TooManyEntries(usize),
    BadOrigin(String),
    DuplicateOrigin(String),
    BadText(&'static str),
    BadWindow,
    IssuedInFuture,
    Expired,
    Rollback { have: u64, got: u64 },
    Equivocation { serial: u64 },
    BadRolloverKey,
    RolloverReplay { have: u64, got: u64 },
    RolloverEquivocation { rotation: u64 },
    RolloverToRetiredKey,
    RolloverToActiveKey,
}

impl fmt::Display for FeedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FeedError::TooLarge => write!(f, "feed is larger than {MAX_BYTES} bytes"),
            FeedError::NotJson => write!(f, "feed is not JSON"),
            FeedError::BadSignature => write!(f, "feed signature does not verify against the pinned key"),
            FeedError::WrongKind => write!(f, "document is not a media-origin feed"),
            FeedError::UnsupportedVersion(v) => write!(f, "feed format version {v} is not supported"),
            FeedError::Malformed(e) => write!(f, "feed is malformed: {e}"),
            FeedError::TooManyEntries(n) => write!(f, "feed has {n} entries; at most {MAX_ENTRIES} are read"),
            FeedError::BadOrigin(o) => write!(f, "feed lists {o:?}, which is not an origin"),
            FeedError::DuplicateOrigin(o) => write!(f, "feed lists {o} more than once"),
            FeedError::BadText(field) => {
                write!(f, "a {field} on the feed is empty, over-long or not plain text")
            }
            FeedError::BadWindow => write!(f, "feed expires before it was issued"),
            FeedError::IssuedInFuture => write!(f, "feed claims to be issued in the future"),
            FeedError::Expired => write!(f, "feed has already expired"),
            FeedError::Rollback { have, got } => {
                write!(f, "feed serial {got} is older than the {have} already held; refused as a rollback")
            }
            FeedError::Equivocation { serial } => {
                write!(f, "feed serial {serial} was already seen with different contents")
            }
            FeedError::BadRolloverKey => {
                write!(f, "the feed's key rollover does not name an Ed25519 public key")
            }
            FeedError::RolloverReplay { have, got } => write!(
                f,
                "the feed announces key rotation {got}, at or below the {have} already followed; \
                 refused as a replayed rollover"
            ),
            FeedError::RolloverEquivocation { rotation } => {
                write!(f, "key rotation {rotation} has already been seen naming a different successor")
            }
            FeedError::RolloverToRetiredKey => {
                write!(f, "the feed rolls its key back to one this subscriber has already retired")
            }
            FeedError::RolloverToActiveKey => {
                write!(f, "the feed announces a rotation to the key that is already in force")
            }
        }
    }
}

impl std::error::Error for FeedError {}

pub fn is_public_key(key: &str) -> bool {
    unb64(key)
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .is_some_and(|bytes| VerifyingKey::from_bytes(&bytes).is_ok())
}

pub fn is_origin(origin: &str) -> bool {
    let (host, port) = match origin.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (origin, None),
    };
    if let Some(port) = port {
        if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        if !matches!(port.parse::<u32>(), Ok(1..=65535)) {
            return false;
        }
    }
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

pub fn sign(signing: &SigningKey, key_id: &str, feed: &Feed) -> Value {
    let body = serde_json::to_value(feed).expect("feed is serialisable");
    sign_json(signing, key_id, body)
}

/// Order: size, signature, kind and version, then shape.
pub fn verify(bytes: &[u8], public_b64: &str, now_ms: i64, max_skew_ms: i64) -> Result<Feed, FeedError> {
    if bytes.len() > MAX_BYTES {
        return Err(FeedError::TooLarge);
    }
    let doc: Value = serde_json::from_slice(bytes).map_err(|_| FeedError::NotJson)?;
    if !verify_json(public_b64, &doc) {
        return Err(FeedError::BadSignature);
    }
    if doc.get("kind").and_then(Value::as_str) != Some(KIND) {
        return Err(FeedError::WrongKind);
    }
    match doc.get("version").and_then(Value::as_u64) {
        Some(VERSION) => {}
        Some(other) => return Err(FeedError::UnsupportedVersion(other)),
        None => return Err(FeedError::Malformed("missing version".into())),
    }
    let mut body = doc;
    if let Some(obj) = body.as_object_mut() {
        obj.remove("signature");
        obj.remove("key_id");
    }
    let feed: Feed = serde_json::from_value(body).map_err(|e| FeedError::Malformed(e.to_string()))?;

    if feed.entries.len() > MAX_ENTRIES {
        return Err(FeedError::TooManyEntries(feed.entries.len()));
    }
    if !is_display_text(&feed.curator, MAX_NAME_CHARS) {
        return Err(FeedError::BadText("curator name"));
    }
    let mut seen = HashSet::new();
    for entry in &feed.entries {
        if !is_origin(&entry.origin) {
            return Err(FeedError::BadOrigin(entry.origin.clone()));
        }
        if !seen.insert(entry.origin.as_str()) {
            return Err(FeedError::DuplicateOrigin(entry.origin.clone()));
        }
        for (field, text, max) in [
            ("host name", &entry.name, MAX_NAME_CHARS),
            ("host description", &entry.description, MAX_DESCRIPTION_CHARS),
            ("abuse contact", &entry.abuse_contact, MAX_CONTACT_CHARS),
        ] {
            if text.as_deref().is_some_and(|t| !is_display_text(t, max)) {
                return Err(FeedError::BadText(field));
            }
        }
    }
    if let Some(rollover) = &feed.rollover {
        // So the rotation rules never reason about a successor that is not a key.
        if !is_public_key(&rollover.to_key) {
            return Err(FeedError::BadRolloverKey);
        }
        if rollover.rotation == 0 {
            return Err(FeedError::Malformed("a key rollover is numbered from 1".into()));
        }
    }
    if feed.expires_at <= feed.issued_at {
        return Err(FeedError::BadWindow);
    }
    if feed.issued_at > now_ms.saturating_add(max_skew_ms) {
        return Err(FeedError::IssuedInFuture);
    }
    if feed.is_expired(now_ms) {
        return Err(FeedError::Expired);
    }
    Ok(feed)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Update {
    Replace,
    Unchanged,
}

/// A lower serial is a rollback; the same serial with different contents is contradictory. Both are refused.
pub fn check_update(held: Option<(u64, &str)>, serial: u64, digest: &str) -> Result<Update, FeedError> {
    match held {
        None => Ok(Update::Replace),
        Some((have, _)) if serial > have => Ok(Update::Replace),
        Some((have, held_digest)) if serial == have => {
            if held_digest == digest {
                Ok(Update::Unchanged)
            } else {
                Err(FeedError::Equivocation { serial })
            }
        }
        Some((have, _)) => Err(FeedError::Rollback { have, got: serial }),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation<'a> {
    Settled,
    Announce { to_key: &'a str, rotation: u64 },
}

/// Applied to a rollover on an already-verified document. A rotated-away key must not talk its way back in; numbers at or below `applied` are replays.
pub fn check_rollover<'a>(
    rollover: Option<&'a Rollover>,
    active_key: &str,
    applied: u64,
    announced: Option<(&str, u64)>,
    retired: &[String],
) -> Result<Rotation<'a>, FeedError> {
    let Some(rollover) = rollover else {
        return Ok(Rotation::Settled);
    };
    if !is_public_key(&rollover.to_key) {
        return Err(FeedError::BadRolloverKey);
    }
    let to_key = rollover.to_key.as_str();
    if rollover.rotation < applied {
        return Err(FeedError::RolloverReplay { have: applied, got: rollover.rotation });
    }
    if rollover.rotation == applied {
        // The rotation that produced the key now signing; curators keep the field on for a while.
        return if to_key == active_key {
            Ok(Rotation::Settled)
        } else {
            Err(FeedError::RolloverEquivocation { rotation: rollover.rotation })
        };
    }
    if to_key == active_key {
        return Err(FeedError::RolloverToActiveKey);
    }
    if retired.iter().any(|k| k == to_key) {
        return Err(FeedError::RolloverToRetiredKey);
    }
    if let Some((held_key, held_rotation)) = announced {
        if held_rotation > rollover.rotation {
            return Err(FeedError::RolloverReplay { have: held_rotation, got: rollover.rotation });
        }
        if held_rotation == rollover.rotation && held_key != to_key {
            return Err(FeedError::RolloverEquivocation { rotation: rollover.rotation });
        }
    }
    Ok(Rotation::Announce { to_key, rotation: rollover.rotation })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::b64;

    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 86_400_000;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[11u8; 32])
    }

    fn public() -> String {
        b64(key().verifying_key().as_bytes())
    }

    fn entry(origin: &str, action: Action) -> Entry {
        Entry { origin: origin.into(), action, name: None, description: None, max_file_bytes: None, abuse_contact: None }
    }

    fn feed(serial: u64) -> Feed {
        Feed::new(
            "curator.example",
            serial,
            NOW - 1000,
            NOW + DAY,
            vec![entry("files.example", Action::Allow), entry("bad.example:8443", Action::Block)],
        )
    }

    fn bytes(doc: &Value) -> Vec<u8> {
        serde_json::to_vec(doc).unwrap()
    }

    #[test]
    fn a_signed_feed_verifies_and_parses() {
        let doc = sign(&key(), "ed25519:curator", &feed(3));
        let parsed = verify(&bytes(&doc), &public(), NOW, 0).unwrap();
        assert_eq!(parsed, feed(3));
        assert_eq!(parsed.entries[1].action, Action::Block);
    }

    #[test]
    fn a_tampered_feed_is_refused() {
        let mut doc = sign(&key(), "ed25519:curator", &feed(3));
        doc["entries"][1]["action"] = Value::String("allow".into());
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadSignature));
    }

    #[test]
    fn a_feed_signed_by_another_key_is_refused() {
        let other = SigningKey::from_bytes(&[12u8; 32]);
        let doc = sign(&other, "ed25519:curator", &feed(3));
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadSignature));
    }

    #[test]
    fn an_unsigned_document_is_refused() {
        let doc = serde_json::to_value(feed(3)).unwrap();
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadSignature));
    }

    #[test]
    fn an_oversize_document_is_refused_before_it_is_parsed() {
        let big = vec![b' '; MAX_BYTES + 1];
        assert_eq!(verify(&big, &public(), NOW, 0), Err(FeedError::TooLarge));
    }

    #[test]
    fn too_many_entries_are_refused() {
        let mut f = feed(3);
        f.entries = (0..=MAX_ENTRIES).map(|i| entry(&format!("h{i}.example"), Action::Allow)).collect();
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::TooManyEntries(MAX_ENTRIES + 1)));
    }

    #[test]
    fn another_signed_kind_cannot_pose_as_a_feed() {
        let mut body = serde_json::to_value(feed(3)).unwrap();
        body["kind"] = Value::String("blocklist".into());
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::WrongKind));

        let mut body = serde_json::to_value(feed(3)).unwrap();
        body["version"] = Value::from(2);
        let doc = sign_json(&key(), "k", body);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::UnsupportedVersion(2)));
    }

    #[test]
    fn origins_are_exact_lowercase_hosts() {
        for good in ["files.example", "a-b.example:443", "localhost", "127.0.0.1:8448"] {
            assert!(is_origin(good), "{good}");
        }
        for bad in ["", "Files.example", "https://files.example", "files.example/x", "*.example",
            "-a.example", "a..example", "files.example:", "files.example:99999", "files example"] {
            assert!(!is_origin(bad), "{bad}");
        }
        let mut f = feed(3);
        f.entries.push(entry("Files.Example", Action::Allow));
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadOrigin("Files.Example".into())));

        let mut f = feed(3);
        f.entries.push(entry("files.example", Action::Block));
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::DuplicateOrigin("files.example".into())));
    }

    #[test]
    fn the_validity_window_is_enforced() {
        let doc = sign(&key(), "k", &feed(3));
        assert_eq!(verify(&bytes(&doc), &public(), NOW + DAY, 0), Err(FeedError::Expired));

        let mut f = feed(3);
        f.issued_at = NOW + 10 * 60_000;
        f.expires_at = NOW + DAY;
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 5 * 60_000), Err(FeedError::IssuedInFuture));
        assert!(verify(&bytes(&doc), &public(), NOW, 15 * 60_000).is_ok(), "within the skew allowance");

        let mut f = feed(3);
        f.expires_at = f.issued_at;
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadWindow));
    }

    #[test]
    fn a_held_copy_only_moves_forward() {
        assert_eq!(check_update(None, 1, "a"), Ok(Update::Replace));
        assert_eq!(check_update(Some((4, "a")), 5, "b"), Ok(Update::Replace));
        assert_eq!(check_update(Some((4, "a")), 4, "a"), Ok(Update::Unchanged));
        assert_eq!(check_update(Some((4, "a")), 4, "b"), Err(FeedError::Equivocation { serial: 4 }));
        assert_eq!(check_update(Some((4, "a")), 3, "c"), Err(FeedError::Rollback { have: 4, got: 3 }));
    }

    #[test]
    fn public_keys_are_checked_for_shape() {
        assert!(is_public_key(&public()));
        assert!(!is_public_key("not-a-key"));
        assert!(!is_public_key(&b64(&[1u8; 16])));
    }

    #[test]
    fn descriptive_fields_have_to_be_plain_showable_text() {
        assert!(is_display_text("Example Files", MAX_NAME_CHARS));
        for bad in ["", "a\nb", "a\u{202e}b", "\u{2069}", &"x".repeat(MAX_NAME_CHARS + 1)] {
            assert!(!is_display_text(bad, MAX_NAME_CHARS), "{bad:?}");
        }

        let mut f = feed(3);
        f.entries[0].name = Some("files\u{202e}moc.elpmaxe".into());
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadText("host name")));

        let mut f = feed(3);
        f.curator = "curator\u{0007}".into();
        let doc = sign(&key(), "k", &f);
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadText("curator name")));
    }

    fn successor(seed: u8) -> String {
        b64(SigningKey::from_bytes(&[seed; 32]).verifying_key().as_bytes())
    }

    #[test]
    fn a_rollover_is_read_only_off_a_document_that_verified() {
        let next = successor(12);
        let doc = sign(&key(), "k", &feed(3).announcing(&next, 1));
        let parsed = verify(&bytes(&doc), &public(), NOW, 0).unwrap();
        assert_eq!(parsed.rollover.as_ref().unwrap().to_key, next);

        let doc = sign(&key(), "k", &feed(3).announcing("not-a-key", 1));
        assert_eq!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::BadRolloverKey));

        let doc = sign(&key(), "k", &feed(3).announcing(&next, 0));
        assert!(matches!(verify(&bytes(&doc), &public(), NOW, 0), Err(FeedError::Malformed(_))));
    }

    #[test]
    fn a_rotation_moves_forward_or_not_at_all() {
        let (a, b, c) = (public(), successor(12), successor(13));
        let roll = |to: &str, rotation: u64| Rollover { to_key: to.into(), rotation };

        assert_eq!(check_rollover(None, &a, 0, None, &[]), Ok(Rotation::Settled));
        assert_eq!(
            check_rollover(Some(&roll(&b, 1)), &a, 0, None, &[]),
            Ok(Rotation::Announce { to_key: &b, rotation: 1 })
        );
        assert_eq!(
            check_rollover(Some(&roll(&b, 1)), &a, 0, Some((&b, 1)), &[]),
            Ok(Rotation::Announce { to_key: &b, rotation: 1 })
        );
        assert_eq!(check_rollover(Some(&roll(&b, 1)), &b, 1, None, &[a.clone()]), Ok(Rotation::Settled));
        assert_eq!(
            check_rollover(Some(&roll(&c, 2)), &b, 1, None, &[a.clone()]),
            Ok(Rotation::Announce { to_key: &c, rotation: 2 })
        );
    }

    #[test]
    fn a_rotation_cannot_be_replayed_forked_or_rolled_back() {
        let (a, b, c) = (public(), successor(12), successor(13));
        let roll = |to: &str, rotation: u64| Rollover { to_key: to.into(), rotation };

        assert_eq!(
            check_rollover(Some(&roll(&b, 1)), &c, 2, None, &[a.clone(), b.clone()]),
            Err(FeedError::RolloverReplay { have: 2, got: 1 })
        );
        assert_eq!(
            check_rollover(Some(&roll(&c, 1)), &a, 0, Some((&b, 1)), &[]),
            Err(FeedError::RolloverEquivocation { rotation: 1 })
        );
        assert_eq!(
            check_rollover(Some(&roll(&c, 1)), &b, 1, None, &[a.clone()]),
            Err(FeedError::RolloverEquivocation { rotation: 1 })
        );
        assert_eq!(
            check_rollover(Some(&roll(&b, 1)), &a, 0, Some((&c, 2)), &[]),
            Err(FeedError::RolloverReplay { have: 2, got: 1 })
        );
        assert_eq!(
            check_rollover(Some(&roll(&a, 2)), &b, 1, None, &[a.clone()]),
            Err(FeedError::RolloverToRetiredKey)
        );
        assert_eq!(check_rollover(Some(&roll(&b, 2)), &b, 1, None, &[a]), Err(FeedError::RolloverToActiveKey));
    }
}
