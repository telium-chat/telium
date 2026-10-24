//! Hostile input for the published-document parsers: no panics, no unsigned acceptance, bounded.

use ed25519_dalek::SigningKey;
use proptest::prelude::*;
use serde_json::{json, Map, Value};
use telium_protocol::{b64, curator_directory, hosting_catalog, interactivity, media_feed, sign_json};

const NOW: i64 = 1_800_000_000_000;
const SKEW: i64 = 60_000;

fn key() -> SigningKey {
    SigningKey::from_bytes(&[3u8; 32])
}

fn public() -> String {
    b64(key().verifying_key().as_bytes())
}

fn other_public() -> String {
    b64(SigningKey::from_bytes(&[4u8; 32]).verifying_key().as_bytes())
}

fn verdicts(bytes: &[u8], pk: &str, now: i64, skew: i64) -> [(&'static str, bool); 3] {
    [
        ("media_feed", media_feed::verify(bytes, pk, now, skew).is_ok()),
        ("hosting_catalog", hosting_catalog::verify(bytes, pk, now, skew).is_ok()),
        ("curator_directory", curator_directory::verify(bytes, pk, now, skew).is_ok()),
    ]
}

fn arb_nasty_string() -> impl Strategy<Value = String> {
    prop_oneof![
        Just(String::new()),
        "[\\x00-\\x{10FFFF}]{0,40}",
        Just("\u{202e}gnirts a si siht".to_string()),
        Just("e\u{0301}".repeat(30)),
        Just("\u{10FFFF}".repeat(20)),
        Just("\u{0}".repeat(8)),
        Just("a".repeat(10_000)),
    ]
}

fn arb_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(|n| json!(n)),
        arb_nasty_string().prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 32, 5, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..5).prop_map(Value::Array),
            prop::collection::hash_map("[a-z_]{1,12}", inner, 0..6)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn arb_document_shaped() -> impl Strategy<Value = Value> {
    let fields = [
        "kind", "version", "publisher", "origin", "generated_at", "valid_from", "valid_until",
        "expires_at", "entries", "providers", "servers", "plans", "regions", "name", "url",
        "price_minor", "currency", "member_cap",
    ];
    prop::collection::vec(arb_json(), fields.len()).prop_map(move |values| {
        let map: Map<String, Value> = fields.iter().map(|k| k.to_string()).zip(values).collect();
        Value::Object(map)
    })
}

fn signed_bytes(value: Value) -> Vec<u8> {
    serde_json::to_vec(&sign_json(&key(), "ed25519:t", value)).unwrap_or_default()
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn arbitrary_bytes_are_never_a_crash(raw in prop::collection::vec(any::<u8>(), 0..2048)) {
        let _ = verdicts(&raw, &public(), NOW, SKEW);
    }

    #[test]
    fn shaped_documents_need_the_right_signature_and_stay_bounded(doc in arb_document_shaped()) {
        let bytes = signed_bytes(doc.clone());
        for (name, ok) in verdicts(&bytes, &other_public(), NOW, SKEW) {
            prop_assert!(!ok, "{name} accepted a document under a key that did not sign it");
        }
        for (name, ok) in verdicts(&serde_json::to_vec(&doc).unwrap(), &public(), NOW, SKEW) {
            prop_assert!(!ok, "{name} accepted an unsigned document");
        }
        let _ = verdicts(&bytes, &public(), NOW, SKEW);
        if let Ok(catalog) = hosting_catalog::verify(&bytes, &public(), NOW, SKEW) {
            prop_assert!(catalog.providers.len() <= hosting_catalog::MAX_PROVIDERS);
            for p in &catalog.providers {
                prop_assert!(p.plans.len() <= hosting_catalog::MAX_PLANS);
                prop_assert!(p.regions.len() <= hosting_catalog::MAX_REGIONS);
            }
        }
    }

    #[test]
    fn extreme_clocks_and_windows_do_not_overflow(
        now in any::<i64>(), skew in any::<i64>(), from in any::<i64>(), until in any::<i64>(),
    ) {
        let doc = json!({
            "kind": "telium.media_origin_feed", "version": 1, "origin": "media.example",
            "generated_at": now, "valid_from": from, "valid_until": until, "entries": [],
        });
        let _ = verdicts(&signed_bytes(doc), &public(), now, skew);
    }

    #[test]
    fn interactivity_payloads_are_refused_or_bounded(
        v in arb_json(), title in arb_nasty_string(), description in arb_nasty_string(),
    ) {
        if let Ok(rows) = interactivity::parse_components(&v) {
            prop_assert!(rows.len() <= interactivity::MAX_ROWS);
        }
        if let Ok(cards) = interactivity::parse_cards(&v) {
            prop_assert!(cards.len() <= interactivity::MAX_CARDS);
        }
        let payload = json!([{ "title": title, "description": description }]);
        if let Ok(cards) = interactivity::parse_cards(&payload) {
            if interactivity::validate_cards(&cards).is_ok() {
                for card in &cards {
                    let chars = |s: &Option<String>| s.as_ref().map_or(0, |s| s.chars().count());
                    prop_assert!(chars(&card.title) <= interactivity::MAX_CARD_TITLE_CHARS);
                    prop_assert!(chars(&card.description) <= interactivity::MAX_CARD_DESCRIPTION_CHARS);
                }
            }
        }
    }
}

#[test]
fn deep_nesting_and_oversized_documents_are_refused_without_exhausting_anything() {
    for depth in [128usize, 100_000] {
        let nested = format!("{}0{}", "[".repeat(depth), "]".repeat(depth));
        let text = format!(r#"{{"kind":"telium.hosting_catalog","version":1,"providers":{nested}}}"#);
        let _ = verdicts(text.as_bytes(), &public(), NOW, SKEW);
        if let Ok(v) = serde_json::from_str::<Value>(&nested) {
            let _ = (interactivity::parse_components(&v), interactivity::parse_cards(&v));
        }
    }
    // Size is checked before parsing, so the limit bounds what is spent, not only what is kept.
    for max in [hosting_catalog::MAX_BYTES, media_feed::MAX_BYTES, curator_directory::MAX_BYTES] {
        for (name, ok) in verdicts(&vec![b' '; max + 1], &public(), NOW, SKEW) {
            assert!(!ok, "{name} accepted {} bytes", max + 1);
        }
    }
}

#[test]
fn truncated_or_bit_flipped_catalogs_are_never_a_different_accepted_document() {
    let bytes = signed_bytes(json!({
        "kind": "telium.hosting_catalog", "version": 1, "publisher": "aurora.example",
        "serial": 7, "issued_at": NOW - 1_000, "expires_at": NOW + 86_400_000, "providers": [],
    }));
    let original = hosting_catalog::verify(&bytes, &public(), NOW, SKEW).expect("fixture must be valid");
    for cut in 0..bytes.len() {
        let _ = hosting_catalog::verify(&bytes[..cut], &public(), NOW, SKEW);
    }
    for i in 0..bytes.len() {
        for bit in [0x01u8, 0x20, 0x80] {
            let mut mutated = bytes.clone();
            mutated[i] ^= bit;
            if let Ok(parsed) = hosting_catalog::verify(&mutated, &public(), NOW, SKEW) {
                assert_eq!(parsed.publisher, original.publisher, "byte {i}, bit {bit:#04x}");
                assert_eq!(parsed.providers.len(), original.providers.len());
            }
        }
    }
}
