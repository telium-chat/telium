//! The node-side signer and this crate's verifier must agree byte-for-byte.
//!
//! `site/scripts/sfu-directory-lib.mjs` signs the live feed with node's
//! `crypto.sign` over recursively key-sorted canonical JSON; `sfu_directory::verify`
//! checks Ed25519 over serde_json's BTreeMap ordering. The fixture below was
//! produced by the site script with the tests' well-known key ([42u8; 32]); if
//! either implementation ever changes its canonical form, this test fails and
//! the feed stops verifying rather than silently drifting.

use ed25519_dalek::SigningKey;

const FIXTURE: &str = include_str!("fixtures/sfu_directory_node_fixture.json");

#[test]
fn a_document_signed_by_the_site_script_verifies_here() {
    let key = SigningKey::from_bytes(&[42u8; 32]);
    let public = telium_protocol::b64(key.verifying_key().as_bytes());
    // The fixture was issued at 1_799_000_000_000 and expires at 1_801_000_000_000.
    let now = 1_800_000_000_000;
    let parsed = telium_protocol::sfu_directory::verify(FIXTURE.as_bytes(), &public, now, 0)
        .expect("the site's canonical bytes must verify");
    assert_eq!(parsed.serial, 4);
    assert_eq!(parsed.sfus.len(), 2);
    assert_eq!(parsed.sfus[0].url, "https://sfu.example");
    assert_eq!(parsed.sfus[0].weight, 2);
    assert_eq!(parsed.sfus[1].pubkey_hint.as_deref(), Some("ed25519:hint"));
    assert_eq!(parsed.criteria.min_uptime_percent, 99);
}

#[test]
fn one_tampered_byte_breaks_the_site_signature() {
    let key = SigningKey::from_bytes(&[42u8; 32]);
    let public = telium_protocol::b64(key.verifying_key().as_bytes());
    let tampered = FIXTURE.replace("Example Relay", "Evample Relay");
    assert_eq!(
        telium_protocol::sfu_directory::verify(tampered.as_bytes(), &public, 1_800_000_000_000, 0),
        Err(telium_protocol::sfu_directory::DirectoryError::BadSignature),
    );
    assert!(telium_protocol::sfu_directory::verify(FIXTURE.as_bytes(), &public, 1_800_000_000_000, 0).is_ok());
}
