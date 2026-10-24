use super::*;

fn identity_id(public: &str) -> String {
    let raw = URL_SAFE_NO_PAD.decode(public).unwrap();
    let mut digest = Sha256::new();
    digest.update(b"telium-identity-id:v1\0");
    digest.update(raw);
    format!("tid:{}", hex::encode(digest.finalize()))
}

fn identity_anchor_payload(user_id: &str, immutable_id: &str, public: &str) -> String {
    format!("telium-identity-anchor:v1|{user_id}|{immutable_id}|{public}")
}

fn identity_rotation_payload(
    immutable_id: &str,
    sequence: i64,
    previous: &str,
    next: &str,
) -> String {
    format!("telium-identity-rotate:v1|{immutable_id}|{sequence}|{previous}|{next}")
}

fn identity_policy_payload(
    immutable_id: &str,
    version: i64,
    identity_sequence: i64,
    threshold: i64,
    guardians: &[(String, String, String)],
) -> String {
    let mut rows = guardians.to_vec();
    rows.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)).then_with(|| a.2.cmp(&b.2)));
    let rows: Vec<Value> = rows
        .into_iter()
        .map(|(user, immutable, key)| json!([user, immutable, key]))
        .collect();
    let body = json!([threshold, rows]).to_string();
    format!(
        "telium-identity-recovery-policy:v1|{immutable_id}|{version}|{identity_sequence}|{body}"
    )
}

async fn anchor_test_identity(s: &Server, user: &User, key: &SigningKey) -> (String, String) {
    let public = identity_public(key);
    let immutable = identity_id(&public);
    let (status, cross) = s
        .put(
            "/_telium/v1/crosssigning",
            &user.home,
            json!({
                "identity_key": public,
                "sealed_secret": "test-sealed-cross-signing-secret",
            }),
        )
        .await;
    assert_eq!(status, 200, "cross-signing setup: {cross}");

    let proof = identity_signature(
        key,
        &identity_anchor_payload(&user.user_id, &immutable, &public),
    );
    let (status, anchored) = s
        .put(
            "/_telium/v1/identity/anchor",
            &user.home,
            json!({
                "immutable_id": immutable.clone(),
                "identity_key": public.clone(),
                "signature": proof.clone(),
            }),
        )
        .await;
    assert_eq!(status, 200, "identity anchor: {anchored}");
    assert_eq!(anchored["user_id"], user.user_id.as_str());
    assert_eq!(anchored["immutable_id"], immutable.as_str());
    assert_eq!(anchored["genesis_key"], public.as_str());
    assert_eq!(anchored["anchor_signature"], proof.as_str());
    (immutable, public)
}

#[tokio::test]
async fn immutable_identity_blocks_server_style_replacement_and_accepts_authorized_rotation() {
    let s = start().await;
    let alice = s.user("identity-alice").await;
    let root0 = identity_signing_key();
    let (immutable, public0) = anchor_test_identity(&s, &alice, &root0).await;

    let attacker = identity_signing_key();
    let (status, rejected) = s
        .put(
            "/_telium/v1/crosssigning",
            &alice.home,
            json!({
                "identity_key": identity_public(&attacker),
                "sealed_secret": "operator-controlled",
            }),
        )
        .await;
    assert_eq!(status, 409, "direct root replacement must fail: {rejected}");

    let root1 = identity_signing_key();
    let public1 = identity_public(&root1);
    let rotate = identity_rotation_payload(&immutable, 1, &public0, &public1);
    let (status, rotated) = s
        .post(
            "/_telium/v1/identity/rotate",
            Some(&alice.home),
            json!({
                "sequence": 1,
                "previous_key": public0,
                "new_key": public1,
                "sealed_secret": "sealed-new-root",
                "new_key_signature": identity_signature(&root1, &rotate),
                "authorization": {
                    "kind": "existing_root",
                    "signature": identity_signature(&root0, &rotate),
                },
            }),
        )
        .await;
    assert_eq!(status, 200, "authorized rotation: {rotated}");
    assert_eq!(rotated["immutable_id"], immutable);
    assert_eq!(rotated["sequence"], 1);
    assert_eq!(rotated["current_key"], public1);

    let (status, public_doc) = s
        .get(
            &format!("/_telium/v1/users/{}/identity", alice.user_id),
            None,
        )
        .await;
    assert_eq!(status, 200, "{public_doc}");
    assert_eq!(public_doc["immutable_id"], immutable);
    assert_eq!(public_doc["current_key"], public1);
    assert!(public_doc["signature"].is_string(), "public continuity state is also server-signed for transport");
}

fn fake_key_package(signature_key: &[u8; 32]) -> String {
    let mut bytes = vec![0, 1, 0, 5, 0, 1, 0, 1];
    for part in [[7u8; 32], [9u8; 32], *signature_key] {
        bytes.push(32);
        bytes.extend_from_slice(&part);
    }
    bytes.extend_from_slice(&[0, 0, 0]);
    STANDARD.encode(bytes)
}

async fn current_device(s: &Server, home: &str) -> String {
    let (status, list) = s.get("/_telium/v1/devices", Some(home)).await;
    assert_eq!(status, 200, "{list}");
    list["devices"].as_array().unwrap().iter()
        .find(|d| d["current"] == true).unwrap()["device_id"].as_str().unwrap().to_string()
}

async fn delete_with(s: &Server, path: &str, token: &str, body: Value) -> (u16, Value) {
    let resp = s.client.delete(format!("{}{path}", s.base)).bearer_auth(token).json(&body)
        .send().await.unwrap();
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(json!(null)))
}

#[tokio::test]
async fn a_device_revocation_must_be_signed_by_the_root_and_then_holds() {
    let s = start().await;
    let alice = s.user("revoke-alice").await;
    let bob = s.user("revoke-bob").await;
    let root = identity_signing_key();
    let (immutable, _) = anchor_test_identity(&s, &alice, &root).await;

    let (status, login) = s
        .post("/_telium/v1/login", None, json!({ "user": "revoke-alice", "password": "correct horse battery" }))
        .await;
    assert_eq!(status, 200, "{login}");
    let phone = login["access_token"].as_str().unwrap().to_string();
    let phone_device = current_device(&s, &phone).await;
    let phone_key_raw = [42u8; 32];
    let phone_key = STANDARD.encode(phone_key_raw);
    let (status, body) = s
        .put(
            &format!("/_telium/v1/crosssigning/devices/{phone_device}"),
            &phone,
            json!({ "mls_key": phone_key, "signature": "test-device-signature" }),
        )
        .await;
    assert_eq!(status, 200, "{body}");

    let payload = format!(
        "telium-device-revoke:v1|{}|{immutable}|{phone_device}|{phone_key}",
        alice.user_id
    );
    let path = format!("/_telium/v1/devices/{phone_device}");

    let stranger = identity_signing_key();
    let (status, body) = delete_with(&s, &path, &alice.home, json!({
        "mls_key": phone_key, "signature": identity_signature(&stranger, &payload),
    })).await;
    assert_eq!(status, 401, "{body}");
    let (status, _) = s.get("/_telium/v1/devices", Some(&phone)).await;
    assert_eq!(status, 200, "a refused revocation leaves the device signed in");
    let other = format!(
        "telium-device-revoke:v1|{}|{immutable}|{phone_device}|{}",
        alice.user_id, STANDARD.encode([1u8; 32])
    );
    let (status, body) = delete_with(&s, &path, &alice.home, json!({
        "mls_key": phone_key, "signature": identity_signature(&root, &other),
    })).await;
    assert_eq!(status, 401, "{body}");

    let (status, body) = delete_with(&s, &path, &alice.home, json!({
        "mls_key": phone_key, "signature": identity_signature(&root, &payload),
    })).await;
    assert_eq!(status, 200, "{body}");
    let (status, _) = s.get("/_telium/v1/devices", Some(&phone)).await;
    assert_eq!(status, 401, "the revoked session is gone");

    let (status, list) = s.get(&format!("/_telium/v1/users/{}/devices", alice.user_id), None).await;
    assert_eq!(status, 200, "{list}");
    let revs = list["revocations"].as_array().unwrap();
    assert_eq!(revs.len(), 1, "{list}");
    assert_eq!(revs[0]["mls_key"], phone_key.as_str());
    assert_eq!(revs[0]["device_id"], phone_device.as_str());
    assert_eq!(revs[0]["immutable_id"], immutable.as_str());
    let (_, own) = s.get("/_telium/v1/crosssigning", Some(&alice.home)).await;
    assert_eq!(own["revocations"].as_array().unwrap().len(), 1, "{own}");

    let laptop = current_device(&s, &alice.home).await;
    let (status, body) = s
        .put(
            &format!("/_telium/v1/crosssigning/devices/{laptop}"),
            &alice.home,
            json!({ "mls_key": phone_key, "signature": "test-device-signature" }),
        )
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s
        .post("/_telium/v1/keypackages", Some(&alice.home), json!({ "packages": [fake_key_package(&phone_key_raw)] }))
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s
        .post("/_telium/v1/keypackages", Some(&alice.home), json!({ "last_resort": fake_key_package(&phone_key_raw) }))
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s
        .post("/_telium/v1/keypackages", Some(&alice.home), json!({ "packages": [fake_key_package(&[5u8; 32])] }))
        .await;
    assert_eq!(status, 200, "{body}");

    let (status, made) = s
        .post("/_telium/v1/conversations", Some(&alice.home), json!({ "kind": "dm", "members": [&bob.user_id] }))
        .await;
    assert_eq!(status, 200, "{made}");
    let conv = made["id"].as_str().unwrap();
    let frames = format!("/_telium/v1/conversations/{conv}/messages");
    let (status, body) = s
        .post(&frames, Some(&alice.home), json!({ "kind": "rejoin", "ciphertext": format!("key:{phone_key}"), "epoch": 0 }))
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s
        .post(&frames, Some(&alice.home), json!({ "kind": "rejoin", "ciphertext": format!("key:{}", STANDARD.encode([5u8; 32])), "epoch": 0 }))
        .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn a_root_rotation_needs_the_new_root_signature_too() {
    let s = start().await;
    let alice = s.user("rotate-both-alice").await;
    let root0 = identity_signing_key();
    let (immutable, public0) = anchor_test_identity(&s, &alice, &root0).await;
    let laptop = current_device(&s, &alice.home).await;
    let laptop_key = STANDARD.encode([3u8; 32]);

    let root1 = identity_signing_key();
    let public1 = identity_public(&root1);
    let rotate = identity_rotation_payload(&immutable, 1, &public0, &public1);
    let base = json!({
        "sequence": 1,
        "previous_key": public0,
        "new_key": public1,
        "sealed_secret": "sealed-new-root",
        "authorization": { "kind": "existing_root", "signature": identity_signature(&root0, &rotate) },
    });
    let with = |extra: Value| {
        let mut body = base.clone();
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        body
    };

    let (status, body) = s.post("/_telium/v1/identity/rotate", Some(&alice.home), base.clone()).await;
    assert_eq!(status, 401, "{body}");
    let stranger = identity_signing_key();
    let (status, body) = s
        .post("/_telium/v1/identity/rotate", Some(&alice.home),
            with(json!({ "new_key_signature": identity_signature(&stranger, &rotate) })))
        .await;
    assert_eq!(status, 401, "{body}");
    let device_payload = format!("telium-device-sig:v1|{}|{laptop}|{laptop_key}", alice.user_id);
    let (status, body) = s
        .post("/_telium/v1/identity/rotate", Some(&alice.home), with(json!({
            "new_key_signature": identity_signature(&root1, &rotate),
            "device_signatures": [{
                "device_id": laptop, "mls_key": laptop_key,
                "signature": identity_signature(&root0, &device_payload),
            }],
        })))
        .await;
    assert_eq!(status, 401, "{body}");
    let (_, unchanged) = s.get(&format!("/_telium/v1/users/{}/identity", alice.user_id), None).await;
    assert_eq!(unchanged["sequence"], 0, "refused rotations leave the root alone");

    let laptop_sig = identity_signature(&root1, &device_payload);
    let (status, rotated) = s
        .post("/_telium/v1/identity/rotate", Some(&alice.home), with(json!({
            "new_key_signature": identity_signature(&root1, &rotate),
            "device_signatures": [{ "device_id": laptop, "mls_key": laptop_key, "signature": laptop_sig }],
        })))
        .await;
    assert_eq!(status, 200, "{rotated}");
    assert_eq!(rotated["current_key"], public1.as_str());
    assert_eq!(
        rotated["transitions"][0]["new_key_signature"],
        identity_signature(&root1, &rotate).as_str(),
        "the document carries both signatures for clients to check"
    );
    let (_, list) = s.get(&format!("/_telium/v1/users/{}/devices", alice.user_id), None).await;
    let row = list["devices"].as_array().unwrap().iter().find(|d| d["device_id"] == laptop.as_str()).cloned().unwrap();
    assert_eq!(row["cross_sig"], laptop_sig.as_str(), "re-signed under the new root in the same step");
    assert_eq!(row["mls_key"], laptop_key.as_str());
}

#[tokio::test]
async fn identity_recovery_rejects_guardians_that_share_one_signing_key() {
    let s = start().await;
    let alice = s.user("guardian-key-alice").await;
    let alice_root = identity_signing_key();
    let (alice_id, _) = anchor_test_identity(&s, &alice, &alice_root).await;

    let bob = s.user("guardian-key-bob").await;
    let carol = s.user("guardian-key-carol").await;
    let bob_root = identity_signing_key();
    let carol_root = identity_signing_key();
    let (bob_id, bob_public) = anchor_test_identity(&s, &bob, &bob_root).await;
    let (carol_id, carol_public) = anchor_test_identity(&s, &carol, &carol_root).await;

    let carol_rotate = identity_rotation_payload(
        &carol_id,
        1,
        &carol_public,
        &bob_public,
    );
    let (status, rotated) = s
        .post(
            "/_telium/v1/identity/rotate",
            Some(&carol.home),
            json!({
                "sequence": 1,
                "previous_key": carol_public,
                "new_key": bob_public,
                "sealed_secret": "shared-guardian-key",
                "new_key_signature": identity_signature(&bob_root, &carol_rotate),
                "authorization": {
                    "kind": "existing_root",
                    "signature": identity_signature(&carol_root, &carol_rotate),
                },
            }),
        )
        .await;
    assert_eq!(status, 200, "guardian key rotation: {rotated}");

    let guardians = vec![
        (bob.user_id.clone(), bob_id, bob_public.clone()),
        (carol.user_id.clone(), carol_id, bob_public),
    ];
    let payload = identity_policy_payload(&alice_id, 1, 0, 2, &guardians);
    let rows: Vec<Value> = guardians
        .iter()
        .map(|(user_id, immutable_id, identity_key)| json!({
            "user_id": user_id,
            "immutable_id": immutable_id,
            "identity_key": identity_key,
        }))
        .collect();
    let (status, rejected) = s
        .put(
            "/_telium/v1/identity/recovery-policy",
            &alice.home,
            json!({
                "version": 1,
                "identity_sequence": 0,
                "threshold": 2,
                "guardians": rows,
                "signature": identity_signature(&alice_root, &payload),
            }),
        )
        .await;
    assert_eq!(
        status, 400,
        "2-of-2 must mean two independent signing keys: {rejected}"
    );
}

#[tokio::test]
async fn identity_recovery_requires_the_configured_two_of_three_guardians() {
    let s = start().await;
    let alice = s.user("guardian-alice").await;
    let alice_root = identity_signing_key();
    let (alice_id, alice_public) = anchor_test_identity(&s, &alice, &alice_root).await;

    let bob = s.user("guardian-bob").await;
    let carol = s.user("guardian-carol").await;
    let dave = s.user("guardian-dave").await;
    let bob_key = identity_signing_key();
    let carol_key = identity_signing_key();
    let dave_key = identity_signing_key();
    let (bob_id, bob_public) = anchor_test_identity(&s, &bob, &bob_key).await;
    let (carol_id, carol_public) = anchor_test_identity(&s, &carol, &carol_key).await;
    let (dave_id, dave_public) = anchor_test_identity(&s, &dave, &dave_key).await;

    let guardians = vec![
        (bob.user_id.clone(), bob_id.clone(), bob_public.clone()),
        (carol.user_id.clone(), carol_id.clone(), carol_public.clone()),
        (dave.user_id.clone(), dave_id.clone(), dave_public.clone()),
    ];
    let policy_payload = identity_policy_payload(&alice_id, 1, 0, 2, &guardians);
    let guardian_json: Vec<Value> = guardians
        .iter()
        .map(|(user_id, immutable_id, identity_key)| json!({
            "user_id": user_id,
            "immutable_id": immutable_id,
            "identity_key": identity_key,
        }))
        .collect();
    let (status, policy) = s
        .put(
            "/_telium/v1/identity/recovery-policy",
            &alice.home,
            json!({
                "version": 1,
                "identity_sequence": 0,
                "threshold": 2,
                "guardians": guardian_json,
                "signature": identity_signature(&alice_root, &policy_payload),
            }),
        )
        .await;
    assert_eq!(status, 200, "setting 2-of-3 policy: {policy}");
    assert_eq!(policy["current_policy_version"], 1);

    let recovered_root = identity_signing_key();
    let recovered_public = identity_public(&recovered_root);
    let rotate = identity_rotation_payload(&alice_id, 1, &alice_public, &recovered_public);

    let (status, one) = s
        .post(
            "/_telium/v1/identity/rotate",
            Some(&alice.home),
            json!({
                "sequence": 1,
                "previous_key": alice_public,
                "new_key": recovered_public,
                "sealed_secret": "recovered-secret",
                "new_key_signature": identity_signature(&recovered_root, &rotate),
                "authorization": {
                    "kind": "guardians",
                    "policy_version": 1,
                    "approvals": [{
                        "guardian_immutable_id": bob_id,
                        "signature": identity_signature(&bob_key, &rotate),
                    }],
                },
            }),
        )
        .await;
    assert_eq!(status, 401, "one guardian cannot recover a 2-of-3 identity: {one}");

    let policy_v2_payload = identity_policy_payload(&alice_id, 2, 0, 2, &guardians);
    let guardian_json_v2: Vec<Value> = guardians
        .iter()
        .map(|(user_id, immutable_id, identity_key)| json!({
            "user_id": user_id,
            "immutable_id": immutable_id,
            "identity_key": identity_key,
        }))
        .collect();
    let (status, policy_v2) = s
        .put(
            "/_telium/v1/identity/recovery-policy",
            &alice.home,
            json!({
                "version": 2,
                "identity_sequence": 0,
                "threshold": 2,
                "guardians": guardian_json_v2,
                "signature": identity_signature(&alice_root, &policy_v2_payload),
            }),
        )
        .await;
    assert_eq!(status, 200, "replacement recovery policy: {policy_v2}");
    assert_eq!(policy_v2["current_policy_version"], 2);

    let (status, old_policy) = s
        .post(
            "/_telium/v1/identity/rotate",
            Some(&alice.home),
            json!({
                "sequence": 1,
                "previous_key": alice_public,
                "new_key": recovered_public,
                "sealed_secret": "recovered-secret",
                "new_key_signature": identity_signature(&recovered_root, &rotate),
                "authorization": {
                    "kind": "guardians",
                    "policy_version": 1,
                    "approvals": [
                        {
                            "guardian_immutable_id": bob_id,
                            "signature": identity_signature(&bob_key, &rotate),
                        },
                        {
                            "guardian_immutable_id": carol_id,
                            "signature": identity_signature(&carol_key, &rotate),
                        }
                    ],
                },
            }),
        )
        .await;
    assert_eq!(status, 401, "a superseded guardian set must stay revoked: {old_policy}");

    let (status, two) = s
        .post(
            "/_telium/v1/identity/rotate",
            Some(&alice.home),
            json!({
                "sequence": 1,
                "previous_key": alice_public,
                "new_key": recovered_public,
                "sealed_secret": "recovered-secret",
                "new_key_signature": identity_signature(&recovered_root, &rotate),
                "authorization": {
                    "kind": "guardians",
                    "policy_version": 2,
                    "approvals": [
                        {
                            "guardian_immutable_id": bob_id,
                            "signature": identity_signature(&bob_key, &rotate),
                        },
                        {
                            "guardian_immutable_id": carol_id,
                            "signature": identity_signature(&carol_key, &rotate),
                        }
                    ],
                },
            }),
        )
        .await;
    assert_eq!(status, 200, "two current guardians satisfy recovery: {two}");
    assert_eq!(two["immutable_id"], alice_id);
    assert_eq!(two["current_key"], recovered_public);
    assert_eq!(two["sequence"], 1);
}

#[tokio::test]
async fn vault_custody_modes_and_what_the_server_admits_to() {
    let s = start().await;
    let u = s.user("custodian").await;

    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["exists"], false, "a fresh account has no vault: {v}");

    let (status, _) = s
        .put(
            "/_telium/v1/vault",
            &u.home,
            json!({ "ciphertext": "iv.ct", "mode": "device_custody" }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["mode"], "device_custody");
    assert_eq!(v["server_can_recover"], false);
    assert!(v["escrow_key"].is_null());

    let (status, _) = s
        .put(
            "/_telium/v1/vault/backup",
            &u.home,
            json!({ "items": [{ "scope": "c1", "item": "f1", "ciphertext": "sealed" }] }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["backup"]["items"], 1);
    assert_eq!(v["backup"]["server_can_read"], false);

    let (status, _) = s
        .put("/_telium/v1/vault", &u.home, json!({ "ciphertext": "x", "mode": "escrowed" }))
        .await;
    assert_eq!(status, 400, "escrowed with no key is not escrowed");
    let (status, _) = s
        .put(
            "/_telium/v1/vault",
            &u.home,
            json!({ "ciphertext": "x", "mode": "device_custody", "escrow_key": "aaaa" }),
        )
        .await;
    assert_eq!(status, 400, "trusted-device custody must not accept an escrow key");
    let (status, _) = s
        .put(
            "/_telium/v1/vault",
            &u.home,
            json!({ "ciphertext": "x", "mode": "self_custody", "escrow_key": "aaaa" }),
        )
        .await;
    assert_eq!(status, 400, "self-custody must not accept an escrow key");

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&u.home),
            json!({ "mode": "escrowed", "ciphertext": "legacy.blob" }),
        )
        .await;
    assert_eq!(status, 400, "server-assisted recovery requires the wrapper key");

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&u.home),
            json!({
                "mode": "escrowed",
                "ciphertext": "legacy.blob",
                "escrow_key": "aaaa",
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["mode"], "escrowed");
    assert_eq!(v["server_can_recover"], true);
    assert_eq!(v["backup"]["server_can_read"], true);

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&u.home),
            json!({ "mode": "device_custody", "ciphertext": "device.blob" }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["mode"], "device_custody");
    assert_eq!(v["server_can_recover"], false);
    assert_eq!(v["backup"]["server_can_read"], false);

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&u.home),
            json!({ "mode": "self_custody", "ciphertext": "self.blob" }),
        )
        .await;
    assert_eq!(status, 400);

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&u.home),
            json!({
                "mode": "self_custody",
                "ciphertext": "self.blob",
                "recovery_confirmed": true,
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, v) = s.get("/_telium/v1/vault", Some(&u.home)).await;
    assert_eq!(v["mode"], "self_custody");
    assert_eq!(v["server_can_recover"], false);
}

#[tokio::test]
async fn key_backup_paging_does_not_skip_rows_written_in_one_millisecond() {
    let s = start().await;
    let u = s.user("mirrorer").await;

    let items: Vec<Value> = (0..300)
        .map(|i| json!({ "scope": "c1", "item": format!("f{i:04}"), "ciphertext": "sealed" }))
        .collect();
    let (status, _) = s.put("/_telium/v1/vault/backup", &u.home, json!({ "items": items })).await;
    assert_eq!(status, 200);

    let (_, first) = s.get("/_telium/v1/vault/backup?scope=c1&limit=50", Some(&u.home)).await;
    let stamps: std::collections::HashSet<i64> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["updated_at"].as_i64().unwrap())
        .collect();
    assert_eq!(stamps.len(), 1, "the premise: one flush, one stamp");

    let mut seen = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let path = match &cursor {
            Some(c) => format!("/_telium/v1/vault/backup?scope=c1&limit=50&after={c}"),
            None => "/_telium/v1/vault/backup?scope=c1&limit=50".to_string(),
        };
        let (_, page) = s.get(&path, Some(&u.home)).await;
        for item in page["items"].as_array().unwrap() {
            seen.insert(item["item"].as_str().unwrap().to_string());
        }
        cursor = page["cursor"].as_str().map(str::to_string);
        if page["complete"] == true {
            break;
        }
    }
    assert_eq!(seen.len(), 300, "every row is reachable by paging, not just the first page");

    let mut seen = std::collections::HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let path = match &cursor {
            Some(c) => format!("/_telium/v1/vault/backup?limit=50&after={c}"),
            None => "/_telium/v1/vault/backup?limit=50".to_string(),
        };
        let (_, page) = s.get(&path, Some(&u.home)).await;
        for item in page["items"].as_array().unwrap() {
            seen.insert(item["item"].as_str().unwrap().to_string());
        }
        cursor = page["cursor"].as_str().map(str::to_string);
        if page["complete"] == true {
            break;
        }
    }
    assert_eq!(seen.len(), 300, "and the unscoped walk sees all of them too");

    let (status, page) = s.get("/_telium/v1/vault/backup?scope=c1&limit=50&after=0", Some(&u.home)).await;
    assert_eq!(status, 200);
    assert_eq!(page["items"].as_array().unwrap().len(), 50);
    let (status, page) = s.get("/_telium/v1/vault/backup?scope=c1&after=garbage", Some(&u.home)).await;
    assert_eq!(status, 200);
    assert!(!page["items"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn key_backup_belongs_to_one_account_and_can_be_thrown_away() {
    let s = start().await;
    let mine = s.user("keeper").await;
    let theirs = s.user("stranger").await;

    let (status, _) = s
        .put(
            "/_telium/v1/vault/backup",
            &mine.home,
            json!({ "items": [
                { "scope": "c1", "item": "f1", "ciphertext": "sealed-1" },
                { "scope": "c1", "item": "f2", "ciphertext": "sealed-2" },
                { "scope": "c2", "item": "rx", "ciphertext": "sealed-3" },
            ] }),
        )
        .await;
    assert_eq!(status, 200);

    let (_, page) = s.get("/_telium/v1/vault/backup?scope=c1", Some(&theirs.home)).await;
    assert!(
        page["items"].as_array().unwrap().is_empty(),
        "another account reads none of it, scope collision or not"
    );

    let (_, page) = s.get("/_telium/v1/vault/backup?scope=c1", Some(&mine.home)).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2, "a scoped read is one conversation");
    assert_eq!(page["complete"], true);

    let (status, _) = s
        .put(
            "/_telium/v1/vault/backup",
            &mine.home,
            json!({ "items": [{ "scope": "c1", "item": "f1", "ciphertext": "sealed-again" }] }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, page) = s.get("/_telium/v1/vault/backup?scope=c1", Some(&mine.home)).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2, "still two rows, not three");

    let too_many: Vec<Value> = (0..513)
        .map(|i| json!({ "scope": "c1", "item": format!("x{i}"), "ciphertext": "a" }))
        .collect();
    let (status, _) = s.put("/_telium/v1/vault/backup", &mine.home, json!({ "items": too_many })).await;
    assert_eq!(status, 400);
    let (status, _) = s
        .put(
            "/_telium/v1/vault/backup",
            &mine.home,
            json!({ "items": [{ "scope": "c1", "item": "big", "ciphertext": "a".repeat(256 * 1024 + 1) }] }),
        )
        .await;
    assert_eq!(status, 400);

    let drop = |body: Value| {
        let client = s.client.clone();
        let url = format!("{}/_telium/v1/vault/backup", s.base);
        let token = mine.home.clone();
        async move {
            let resp = client.delete(url).bearer_auth(token).json(&body).send().await.unwrap();
            resp.json::<Value>().await.unwrap()
        }
    };
    let body = drop(json!({ "scope": "c1" })).await;
    assert_eq!(body["deleted"], 2);
    let body = drop(json!({})).await;
    assert_eq!(body["deleted"], 1, "and the rest goes with the unscoped delete");
}

#[tokio::test]
async fn recovery_key_resets_opaque_password_and_preserves_identity() {
    // Lift the auth bucket: eleven OPAQUE calls would otherwise race its refill.
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let old_password = "the old correct horse battery";
    let new_password = "the new correct horse battery";
    let recovery = identity_signing_key();

    let mut rng = OsRng;
    let started = ClientRegistration::<BrowserOpaqueSuite>::start(
        &mut rng,
        old_password.as_bytes(),
    )
    .unwrap();
    let (status, response) = s
        .post(
            "/_telium/v1/register/opaque/start",
            None,
            json!({
                "localpart": "recoverable",
                "registration_request": opaque_b64(started.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque register start: {response}");
    let response_bytes = URL_SAFE_NO_PAD
        .decode(response["registration_response"].as_str().unwrap())
        .unwrap();
    let finished = started
        .state
        .finish(
            &mut rng,
            old_password.as_bytes(),
            RegistrationResponse::deserialize(&response_bytes).unwrap(),
            ClientRegistrationFinishParameters::default(),
        )
        .unwrap();
    let (status, registered) = s
        .post(
            "/_telium/v1/register/opaque/finish",
            None,
            json!({
                "localpart": "recoverable",
                "registration_record": opaque_b64(finished.message.serialize().as_slice()),
                "recovery_public_key": identity_public(&recovery),
                "device_name": "first device",
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque register finish: {registered}");
    assert_eq!(
        registered["recovery_key_enrolled"], true,
        "server did not acknowledge recovery-key enrollment"
    );
    let user_id = registered["user_id"].as_str().unwrap().to_string();
    let old_token = registered["access_token"].as_str().unwrap().to_string();

    let account = User {
        user_id: user_id.clone(),
        home: old_token.clone(),
        token: String::new(),
    };
    let identity_key = identity_signing_key();
    let (immutable_id, _) = anchor_test_identity(&s, &account, &identity_key).await;

    let (status, stolen) = s.post("/_telium/v1/sessions/local", Some(&old_token), json!({})).await;
    assert_eq!(status, 200, "local session: {stolen}");
    let stolen = stolen["session_token"].as_str().unwrap().to_string();
    let mut intruder = connect(&s, &stolen).await;

    let reset_registration = ClientRegistration::<BrowserOpaqueSuite>::start(
        &mut rng,
        new_password.as_bytes(),
    )
    .unwrap();
    let (status, reset) = s
        .post(
            "/_telium/v1/password-reset/opaque/start",
            None,
            json!({
                "user": user_id.clone(),
                "registration_request": opaque_b64(
                    reset_registration.message.serialize().as_slice()
                ),
            }),
        )
        .await;
    assert_eq!(status, 200, "password reset start: {reset}");

    let reset_response = URL_SAFE_NO_PAD
        .decode(reset["registration_response"].as_str().unwrap())
        .unwrap();
    let reset_finished = reset_registration
        .state
        .finish(
            &mut rng,
            new_password.as_bytes(),
            RegistrationResponse::deserialize(&reset_response).unwrap(),
            ClientRegistrationFinishParameters::default(),
        )
        .unwrap();
    let replacement_record = opaque_b64(reset_finished.message.serialize().as_slice());
    let any_valid_record = replacement_record.clone();
    let payload = format!(
        "telium-password-reset:v1|{}|{}|{}|{}",
        reset["user_id"].as_str().unwrap(),
        reset["reset_id"].as_str().unwrap(),
        reset["challenge"].as_str().unwrap(),
        replacement_record,
    );
    let attacker = identity_signing_key();
    let forged_signature = identity_signature(&attacker, &payload);
    let (status, forged) = s
        .post(
            "/_telium/v1/password-reset/opaque/finish",
            None,
            json!({
                "user": reset["user_id"].as_str().unwrap(),
                "reset_id": reset["reset_id"].as_str().unwrap(),
                "registration_record": replacement_record.clone(),
                "signature": forged_signature,
                "device_name": "attacker device",
            }),
        )
        .await;
    assert_eq!(status, 401, "forged recovery proof was accepted: {forged}");

    let signature = identity_signature(&recovery, &payload);
    let (status, spent) = s
        .post(
            "/_telium/v1/password-reset/opaque/finish",
            None,
            json!({
                "user": reset["user_id"].as_str().unwrap(),
                "reset_id": reset["reset_id"].as_str().unwrap(),
                "registration_record": replacement_record.clone(),
                "signature": signature,
                "device_name": "recovered device",
            }),
        )
        .await;
    assert_eq!(status, 401, "a spent reset challenge was accepted again: {spent}");

    let reset_registration = ClientRegistration::<BrowserOpaqueSuite>::start(
        &mut rng,
        new_password.as_bytes(),
    )
    .unwrap();
    let (status, reset) = s
        .post(
            "/_telium/v1/password-reset/opaque/start",
            None,
            json!({
                "user": user_id.clone(),
                "registration_request": opaque_b64(
                    reset_registration.message.serialize().as_slice()
                ),
            }),
        )
        .await;
    assert_eq!(status, 200, "second password reset start: {reset}");
    let reset_response = URL_SAFE_NO_PAD
        .decode(reset["registration_response"].as_str().unwrap())
        .unwrap();
    let reset_finished = reset_registration
        .state
        .finish(
            &mut rng,
            new_password.as_bytes(),
            RegistrationResponse::deserialize(&reset_response).unwrap(),
            ClientRegistrationFinishParameters::default(),
        )
        .unwrap();
    let replacement_record = opaque_b64(reset_finished.message.serialize().as_slice());
    let payload = format!(
        "telium-password-reset:v1|{}|{}|{}|{}",
        reset["user_id"].as_str().unwrap(),
        reset["reset_id"].as_str().unwrap(),
        reset["challenge"].as_str().unwrap(),
        replacement_record,
    );
    let signature = identity_signature(&recovery, &payload);
    let (status, recovered) = s
        .post(
            "/_telium/v1/password-reset/opaque/finish",
            None,
            json!({
                "user": reset["user_id"].as_str().unwrap(),
                "reset_id": reset["reset_id"].as_str().unwrap(),
                "registration_record": replacement_record,
                "signature": signature,
                "device_name": "recovered device",
            }),
        )
        .await;
    assert_eq!(status, 200, "password reset finish: {recovered}");

    let (status, _) = s.get("/_telium/v1/whoami", Some(&old_token)).await;
    assert_eq!(status, 401, "old session survived password recovery");

    let (sessions,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM guild_sessions WHERE user_id = ?")
            .bind(&user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(sessions, 0, "a guild session survived password recovery");

    let closed = loop {
        match tokio::time::timeout(std::time::Duration::from_secs(5), intruder.next()).await {
            Ok(Some(Ok(Message::Close(_))) | None | Some(Err(_))) => break true,
            Ok(Some(Ok(_))) => continue,
            Err(_) => break false,
        }
    };
    assert!(closed, "the gateway connection outlived the password it was opened with");

    assert!(
        opaque_login(&s, &user_id, old_password, None).await.is_none(),
        "the forgotten password still authenticated"
    );
    assert!(
        opaque_login(&s, &user_id, new_password, None).await.is_some(),
        "the replacement password did not authenticate"
    );

    let (status, identity) = s
        .get(
            &format!("/_telium/v1/users/{}/identity", user_id),
            None,
        )
        .await;
    assert_eq!(status, 200, "identity after password recovery: {identity}");
    assert_eq!(identity["immutable_id"], immutable_id);

    sqlx::query("UPDATE accounts SET deactivated = 1 WHERE user_id = ?")
        .bind(&user_id)
        .execute(&s.state.pool)
        .await
        .unwrap();
    let probe = ClientRegistration::<BrowserOpaqueSuite>::start(&mut rng, new_password.as_bytes())
        .unwrap();
    let (status, probe_started) = s
        .post(
            "/_telium/v1/password-reset/opaque/start",
            None,
            json!({
                "user": user_id.clone(),
                "registration_request": opaque_b64(probe.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "password reset start: {probe_started}");
    let (status, probed) = s
        .post(
            "/_telium/v1/password-reset/opaque/finish",
            None,
            json!({
                "user": user_id.clone(),
                "reset_id": probe_started["reset_id"].as_str().unwrap(),
                "registration_record": any_valid_record,
                "signature": identity_signature(&identity_signing_key(), "not the payload"),
            }),
        )
        .await;
    assert_eq!(status, 401);
    assert_eq!(
        probed["message"], "invalid recovery proof",
        "an unproven reset attempt disclosed the account's state: {probed}"
    );
}
