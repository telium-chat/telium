//! Shared signing and verification primitives; `telium-server` and `telium-sfu` must agree byte-for-byte.

// Must be `URL_SAFE_NO_PAD`, as the server uses, or `verify_bytes` rejects its tokens.
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::Value;

pub mod compat;
pub mod curator_directory;
pub mod hosting_catalog;
pub mod interactivity;
pub mod media_feed;
pub mod release;

/// Watch-quality vocabulary shared by server, SFU and web client.
pub const WATCH_QUALITIES: [&str; 4] = ["auto", "low", "medium", "high"];

pub fn is_watch_quality(q: &str) -> bool {
    WATCH_QUALITIES.contains(&q)
}

/// Participants cannot rewrite their own attributes, so this is the authoritative cap.
pub const MAX_BITRATE_ATTRIBUTE: &str = "telium.max_bitrate";

pub const WATCH_TOPIC: &str = "telium.watch";

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

/// Floats are refused: serde_json's float parser is not correctly rounded at extreme exponents, so honest signatures could fail.
pub fn has_unstable_number(value: &Value) -> bool {
    match value {
        Value::Number(n) => !n.is_i64() && !n.is_u64(),
        Value::Array(items) => items.iter().any(has_unstable_number),
        Value::Object(map) => map.values().any(has_unstable_number),
        _ => false,
    }
}

/// Returned unsigned (fails closed) for non-objects and non-integer numbers.
pub fn sign_json(signing: &SigningKey, key_id: &str, mut value: Value) -> Value {
    if has_unstable_number(&value) {
        return value;
    }
    if let Some(obj) = value.as_object_mut() {
        obj.remove("signature");
        obj.remove("key_id");
    }
    let canonical = serde_json::to_vec(&value).expect("json value is serialisable");
    let sig = signing.sign(&canonical);
    if let Some(obj) = value.as_object_mut() {
        obj.insert("key_id".into(), Value::String(key_id.to_string()));
        obj.insert("signature".into(), Value::String(b64(&sig.to_bytes())));
    }
    value
}

/// Non-integer numbers are refused here too: a third-party signer could canonicalise a float differently.
pub fn verify_json(public_b64: &str, value: &Value) -> bool {
    let Some(obj) = value.as_object() else { return false };
    let Some(sig_b64) = obj.get("signature").and_then(Value::as_str) else { return false };
    if has_unstable_number(value) {
        return false;
    }
    let mut stripped = value.clone();
    if let Some(o) = stripped.as_object_mut() {
        o.remove("signature");
        o.remove("key_id");
    }
    let canonical = match serde_json::to_vec(&stripped) {
        Ok(c) => c,
        Err(_) => return false,
    };
    verify_bytes(public_b64, &canonical, sig_b64)
}

pub fn verify_bytes(public_b64: &str, message: &[u8], sig_b64: &str) -> bool {
    let (Some(pk), Some(sig)) = (unb64(public_b64), unb64(sig_b64)) else { return false };
    let (Ok(pk), Ok(sig)): (Result<[u8; 32], _>, Result<[u8; 64], _>) = (pk.try_into(), sig.try_into())
    else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    // Strict: `verify` accepts malleable (non-canonical S, small-order) encodings.
    vk.verify_strict(message, &Signature::from_bytes(&sig)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use proptest::prelude::*;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    #[test]
    fn sign_then_verify_round_trips() {
        let k = key();
        let signed = sign_json(&k, "ed25519:test", serde_json::json!({ "kind": "x", "v": 1 }));
        assert!(verify_json(&b64(&k.verifying_key().to_bytes()), &signed));
    }

    #[test]
    fn tampered_body_fails() {
        let k = key();
        let mut signed = sign_json(&k, "ed25519:test", serde_json::json!({ "kind": "x", "v": 1 }));
        signed["v"] = serde_json::json!(2);
        assert!(!verify_json(&b64(&k.verifying_key().to_bytes()), &signed));
    }

    #[test]
    fn noncanonical_scalar_encoding_is_rejected() {
        // S + L is the same scalar but non-canonical; strict verification must reject it.
        const L: [u8; 32] = [
            0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
            0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
        ];
        let k = key();
        let message = b"strict-ed25519-regression";
        let mut bytes = k.sign(message).to_bytes();
        let mut carry = 0u16;
        for (dst, add) in bytes[32..].iter_mut().zip(L) {
            let sum = u16::from(*dst) + u16::from(add) + carry;
            *dst = sum as u8;
            carry = sum >> 8;
        }
        assert_eq!(carry, 0);
        assert!(!verify_bytes(
            &b64(&k.verifying_key().to_bytes()),
            message,
            &b64(&bytes),
        ));
    }

    #[test]
    fn watch_quality_vocabulary_is_closed() {
        for q in WATCH_QUALITIES {
            assert!(is_watch_quality(q));
        }
        assert!(!is_watch_quality("motion"));
        assert!(!is_watch_quality("HIGH"));
        assert!(!is_watch_quality(""));
    }

    /// Signing needs document -> canonical bytes to be injective, else one signature authenticates two documents.
    fn json_strategy() -> impl Strategy<Value = Value> {
        let leaf = prop_oneof![
            Just(Value::Null),
            any::<bool>().prop_map(Value::Bool),
            any::<i64>().prop_map(|n| serde_json::json!(n)),
            hostile_string().prop_map(Value::String),
        ];
        leaf.prop_recursive(4, 32, 6, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
                prop::collection::hash_map(hostile_string(), inner, 0..6)
                    .prop_map(|m| Value::Object(m.into_iter().collect())),
            ]
        })
    }

    fn hostile_string() -> impl Strategy<Value = String> {
        prop::collection::vec(
            prop_oneof![
                Just('a'),
                Just('"'),
                Just('\\'),
                Just('\n'),
                Just('\u{7f}'),
                Just('\u{0}'),
                Just('é'),
                Just('\u{301}'),
                Just('\u{1f600}'),
                Just('/'),
            ],
            0..6,
        )
        .prop_map(|cs| cs.into_iter().collect())
    }

    proptest! {
        #[test]
        fn two_different_documents_never_share_canonical_bytes(
            a in json_strategy(),
            b in json_strategy(),
        ) {
            prop_assume!(a != b);
            prop_assert_ne!(
                serde_json::to_vec(&a).unwrap(),
                serde_json::to_vec(&b).unwrap()
            );
        }
    }

    #[test]
    fn wrong_key_fails() {
        let k = key();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let signed = sign_json(&k, "ed25519:test", serde_json::json!({ "kind": "x" }));
        assert!(!verify_json(&b64(&other.verifying_key().to_bytes()), &signed));
    }
}
