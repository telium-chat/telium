//! Properties of `sign_json`/`verify_json`.

use ed25519_dalek::SigningKey;
use proptest::prelude::*;
use serde_json::{json, Map, Value};
use telium_protocol::{b64, has_unstable_number, sign_json, verify_json};

fn key_a() -> SigningKey {
    SigningKey::from_bytes(&[7u8; 32])
}

fn key_b() -> SigningKey {
    SigningKey::from_bytes(&[9u8; 32])
}

fn public_of(k: &SigningKey) -> String {
    b64(k.verifying_key().as_bytes())
}

fn sign(v: Value) -> Value {
    sign_json(&key_a(), "ed25519:a", v)
}

fn verifies(v: &Value) -> bool {
    verify_json(&public_of(&key_a()), v)
}

fn arb_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(|n| json!(n)),
        any::<u64>().prop_map(|n| json!(n)),
        "[\\x00-\\x{10FFFF}]{0,24}".prop_map(Value::String),
    ];
    leaf.prop_recursive(5, 48, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::hash_map("[\\x00-\\x{10FFFF}]{0,12}", inner, 0..6)
                .prop_map(|m| Value::Object(m.into_iter().collect())),
        ]
    })
}

fn arb_object() -> impl Strategy<Value = Map<String, Value>> {
    prop::collection::hash_map("[\\x00-\\x{10FFFF}]{0,12}", arb_json(), 0..8)
        .prop_map(|m| m.into_iter().collect())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    #[test]
    fn a_signature_binds_the_key_and_exactly_the_parsed_document(
        obj in arb_object(),
        name in "[a-z][a-z0-9_]{0,10}",
        extra in arb_json(),
    ) {
        let signed = sign(Value::Object(obj));
        prop_assert!(verifies(&signed));
        prop_assert!(!verify_json(&public_of(&key_b()), &signed));
        for text in [serde_json::to_string(&signed).unwrap(), serde_json::to_string_pretty(&signed).unwrap()] {
            prop_assert!(verifies(&serde_json::from_str(&text).unwrap()));
        }

        let envelope = |k: &str| k == "signature" || k == "key_id";
        let map = signed.as_object().unwrap();
        if !envelope(&name) && map.get(&name) != Some(&extra) {
            let mut added = map.clone();
            added.insert(name, extra);
            prop_assert!(!verifies(&Value::Object(added)));
        }
        if let Some(victim) = map.keys().find(|k| !envelope(k)) {
            let mut removed = map.clone();
            removed.remove(victim);
            prop_assert!(!verifies(&Value::Object(removed)));
        }
    }

    #[test]
    fn unsigned_or_arbitrary_values_never_verify_or_panic(
        mut obj in arb_object(),
        v in arb_json(),
        pk in "[A-Za-z0-9_-]{0,64}",
    ) {
        obj.remove("signature");
        prop_assert!(!verifies(&Value::Object(obj)));
        let _ = verify_json(&pk, &v);
    }
}

#[test]
fn an_embedded_signed_document_is_covered_by_the_outer_signature() {
    let inner = sign_json(&key_b(), "ed25519:b", json!({ "claim": "successor" }));
    let outer = sign(json!({ "kind": "wrap", "inner": inner }));
    assert!(verifies(&outer));

    let mut swapped = outer.clone();
    swapped["inner"] = sign_json(&key_b(), "ed25519:b", json!({ "claim": "not-successor" }));
    assert!(!verifies(&swapped));
    let mut hollowed = outer;
    hollowed["inner"].as_object_mut().unwrap().remove("signature");
    assert!(!verifies(&hollowed));
}

#[test]
fn the_key_id_is_outside_the_signature_and_callers_must_treat_it_as_a_hint() {
    let mut signed = sign(json!({ "origin": "home.example" }));
    signed["key_id"] = json!("ed25519:attacker-chose-this");
    assert!(verifies(&signed), "canonicalisation changed: every signed document just broke");
}

#[test]
fn malformed_envelopes_and_keys_are_refused() {
    let good = sign(json!({ "n": 1 }));
    let mut padded = good.clone();
    padded["signature"] = json!("AAAA====");
    for (why, value) in [
        ("not a string", json!({ "n": 1, "signature": 5 })),
        ("null", json!({ "n": 1, "signature": null })),
        ("object", json!({ "n": 1, "signature": { "sig": "x" } })),
        ("empty", json!({ "n": 1, "signature": "" })),
        ("not base64", json!({ "n": 1, "signature": "!!!!not base64!!!!" })),
        ("padded base64", padded),
        ("wrong length", json!({ "n": 1, "signature": b64(&[0u8; 32]) })),
        ("zero bytes", json!({ "n": 1, "signature": b64(&[0u8; 64]) })),
        ("array document", json!([1, 2, 3])),
        ("null document", Value::Null),
    ] {
        assert!(!verifies(&value), "must refuse signature: {why}");
    }
    // The all-zero key is a low-order point that `verify_strict` must refuse.
    for bad_key in [String::new(), "!!!!".into(), "AAAA".into(), b64(&[0u8; 32])] {
        assert!(!verify_json(&bad_key, &good), "must refuse key {bad_key:?}");
    }
}

#[test]
fn deeply_nested_documents_do_not_crash_the_verifier() {
    for depth in [8usize, 127, 128, 5_000] {
        let text = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            assert!(!verifies(&v));
            assert!(verifies(&sign(json!({ "body": v }))), "depth {depth}");
        }
    }
}

#[test]
fn a_duplicate_key_resolves_to_one_document_for_both_the_verifier_and_the_reader() {
    let text = serde_json::to_string(&sign(json!({ "amount": 2 }))).unwrap();
    let before: Value = serde_json::from_str(&text.replacen('{', r#"{"amount":1,"#, 1)).unwrap();
    assert_eq!(before["amount"], 2);
    assert!(verifies(&before));
    let after: Value =
        serde_json::from_str(&text.replacen(r#""amount":2"#, r#""amount":2,"amount":1"#, 1)).unwrap();
    assert_eq!(after["amount"], 1);
    assert!(!verifies(&after));
}

/// Regression: some floats do not survive serde_json's round trip, so they are refused outright.
#[test]
fn floats_are_refused_by_signer_and_verifier() {
    let doc = json!({ "body": [{ "amount": -3.3405415953267997e-133f64 }] });
    let reparsed: Value = serde_json::from_str(&serde_json::to_string(&doc).unwrap()).unwrap();
    assert_ne!(doc, reparsed, "serde_json now round-trips this value; re-derive the refusal");
    assert_eq!(sign(doc.clone()), doc);

    for shape in [json!({ "x": 1.5 }), json!({ "x": { "y": [0.1] } }), json!({ "x": [{ "y": -0.0 }] })] {
        assert!(has_unstable_number(&shape), "{shape}");
        assert!(!verifies(&sign(shape)));
    }
    for shape in [json!({ "x": i64::MIN }), json!({ "x": i64::MAX }), json!({ "x": u64::MAX })] {
        assert!(!has_unstable_number(&shape), "{shape}");
        assert!(verifies(&sign(shape)));
    }

    let mut floated = sign(json!({ "n": 3 }));
    floated["n"] = json!(3.5);
    assert!(!verifies(&floated));
}

#[test]
fn signing_a_non_object_produces_something_that_cannot_verify() {
    for value in [json!([1, 2, 3]), json!("text"), json!(7), Value::Null, json!(true)] {
        assert_eq!(sign(value.clone()), value);
        assert!(!verifies(&value));
    }
}
