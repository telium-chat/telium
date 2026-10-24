
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use telium_server::crypto::{self, AssertionClaims, ServerKey};
use telium_server::perms::{self, MemberContext, Overwrite};
use telium_server::routes::identity_continuity::{
    anchor_payload, immutable_id_for_key, recovery_policy_payload, rotation_payload, Guardian,
};
use telium_server::util::b64;
use telium_server::{config::Config, federation, migration};

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/spec/vectors");

const AT: i64 = 1_767_225_600_000;

const SEED_PRIMARY: [u8; 32] = [0x11; 32];
const SEED_SUCCESSOR: [u8; 32] = [0x22; 32];
const SEED_DEVICE: [u8; 32] = [0x33; 32];
const OTHER_SEED: [u8; 32] = [0x44; 32];

fn key(seed: [u8; 32], key_id: &str) -> ServerKey {
    ServerKey { key_id: key_id.into(), signing: SigningKey::from_bytes(&seed), valid_from: 0, valid_until: i64::MAX }
}
fn primary() -> ServerKey {
    key(SEED_PRIMARY, "ed25519:spec-primary")
}
fn successor() -> ServerKey {
    key(SEED_SUCCESSOR, "ed25519:spec-successor")
}
fn pub_of(seed: [u8; 32]) -> String {
    b64(SigningKey::from_bytes(&seed).verifying_key().as_bytes())
}
fn public() -> String {
    pub_of(SEED_PRIMARY)
}

fn key_block(seed: [u8; 32], key_id: &str) -> Value {
    json!({ "algorithm": "ed25519", "key_id": key_id, "seed_b64u": b64(&seed), "public_b64u": pub_of(seed) })
}

fn bytes_block(bytes: &[u8]) -> Value {
    json!({ "length": bytes.len(), "hex": hex::encode(bytes), "utf8": String::from_utf8_lossy(bytes) })
}

fn sign_raw(k: &ServerKey, bytes: &[u8]) -> String {
    b64(&k.signing.sign(bytes).to_bytes())
}

fn malleate(sig: &[u8; 64]) -> [u8; 64] {
    const L: [u8; 32] = [
        0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde,
        0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x10,
    ];
    let (mut out, mut carry) = (*sig, 0u16);
    for (dst, add) in out[32..].iter_mut().zip(L) {
        let sum = u16::from(*dst) + u16::from(add) + carry;
        *dst = sum as u8;
        carry = sum >> 8;
    }
    assert_eq!(carry, 0, "adding L must not overflow a valid signature");
    out
}

fn claims(audience: &str, iat: i64, exp: i64) -> AssertionClaims {
    AssertionClaims {
        user_id: "@alice:home.example".into(),
        device_id: "dev-01JAAAAAAAAAAAAAAAAAAAAAAA".into(),
        device_pubkey: "F8t5-ytBIPKx7GXkGY1uCLKOgT_rAeSkAIObheGAgM4".into(),
        audience: audience.into(),
        origin: "home.example".into(),
        profile_version: 7,
        display_name: "Alice".into(),
        avatar_ref: None,
        iat,
        exp,
    }
}

fn must_reject() -> (Value, Vec<(String, bool)>) {
    let k = primary();
    let pk = public();
    let (mut cases, mut results) = (Vec::new(), Vec::new());
    let mut case = |name: &str, invariant: &str, if_missing: &str, artifact: Value, rejected: bool| {
        cases.push(json!({ "name": name, "invariant": invariant, "if_the_check_is_missing": if_missing, "artifact": artifact }));
        results.push((name.to_string(), rejected));
    };

    let base = json!({ "kind": "spec", "value": 1i64, "issuer": "home.example" });
    let signed = crypto::sign_json(&k, base.clone());

    let mut appended = signed.clone();
    appended["value_added_after_signing"] = json!("attacker's addition");
    case(
        "signed-json/field-appended-after-signing",
        "The signature covers the whole document except exactly the members `signature` and `key_id`. Any other member added, removed or altered after signing invalidates it.",
        "A peer can append arbitrary members to any document it relays — a larger `max_bytes` on a voucher, an extra guardian on a recovery policy — and every downstream verifier accepts them as signed by the origin.",
        appended.clone(),
        !crypto::verify_json(&pk, &appended),
    );

    let mut removed = signed.clone();
    removed.as_object_mut().unwrap().remove("issuer");
    case(
        "signed-json/field-removed-after-signing",
        "Removal is as fatal as addition; a verifier must not treat an absent member as 'not covered'.",
        "A relaying peer can strip a member whose absence has a permissive default — dropping `audience` from a voucher removes its binding to one origin.",
        removed.clone(),
        !crypto::verify_json(&pk, &removed),
    );

    let mut narrowed = base.clone();
    narrowed.as_object_mut().unwrap().remove("issuer");
    let narrow_sig = b64(&k.signing.sign(&serde_json::to_vec(&narrowed).unwrap()).to_bytes());
    let mut forged = base.clone();
    forged["key_id"] = json!(k.key_id);
    forged["signature"] = json!(narrow_sig);
    case(
        "signed-json/signature-covers-a-subset",
        "The verifier must serialise the document it actually received, not a projection of it onto the fields it understands.",
        "An implementation that verifies only known members accepts a document whose unknown members were never signed — which is the exact combination of 'ignore unknown fields' and 'verify what you understand' that looks like good defensive practice.",
        forged.clone(),
        !crypto::verify_json(&pk, &forged),
    );

    let mut malleable = signed.clone();
    let raw = telium_server::util::unb64(signed["signature"].as_str().unwrap()).unwrap();
    malleable["signature"] = json!(b64(&malleate(&<[u8; 64]>::try_from(raw).unwrap())));
    case(
        "signed-json/malleable-signature-encoding",
        "Ed25519 verification must be strict (RFC 8032 §5.1.7): S must be canonically reduced and the public key must not be of small order.",
        "Two different byte strings authenticate one document. Anything keyed by signature — deduplication, replay caches, audit trails, idempotency — can be bypassed by re-encoding a signature the victim already accepted.",
        malleable.clone(),
        !crypto::verify_json(&pk, &malleable),
    );

    let zero_key = b64(&[0u8; 32]);
    case(
        "signed-json/small-order-public-key",
        "A public key of small order must not verify anything.",
        "The identity point verifies a forged signature against a key nobody holds. A directory that accepts such a key publishes an origin whose documents anyone can sign.",
        json!({ "public_b64u": zero_key, "document": signed.clone() }),
        !crypto::verify_json(&zero_key, &signed),
    );

    let wrong = pub_of(OTHER_SEED);
    case(
        "signed-json/signed-by-an-unpublished-key",
        "The key that verifies a document must be one the claimed origin publishes, resolved by `key_id` from that origin's key document — never a key carried inside the document itself.",
        "A document that carries its own verification key proves only that whoever wrote it owns a key. Every signature in the system becomes self-certifying.",
        json!({ "public_b64u": wrong, "document": signed.clone() }),
        !crypto::verify_json(&wrong, &signed),
    );

    let for_other = crypto::issue_assertion(&k, &claims("other.example", AT, AT + 300_000));
    case(
        "assertion/audience-is-another-server",
        "`audience` must equal this server's own name. The signature alone says nothing about who the token was for.",
        "Any server a person has ever presented an assertion to can replay it at every other server on the network. This is the single highest-value missing check in the protocol.",
        json!({ "token": for_other.clone(), "expected_audience": "guilds.example" }),
        crypto::verify_assertion(&for_other, "guilds.example", |_, _| Some(pk.clone())).is_err(),
    );

    let expired = crypto::issue_assertion(&k, &claims("guilds.example", AT, AT + 1));
    case(
        "assertion/expired",
        "`exp` is milliseconds since the Unix epoch and must be strictly greater than now.",
        "An assertion is a bearer token. Without expiry it is a password that cannot be changed, recoverable from any log line that recorded a request URL or header.",
        json!({ "token": expired.clone(), "expected_audience": "guilds.example" }),
        crypto::verify_assertion(&expired, "guilds.example", |_, _| Some(pk.clone())).is_err(),
    );

    let ahead = |t: i64| crypto::issue_assertion(&k, &claims("guilds.example", t + 3_600_000, t + 7_200_000));
    let (future_frozen, future_live) = (ahead(AT), ahead(telium_server::util::now_ms()));
    case(
        "assertion/issued-too-far-in-the-future",
        "`iat` must not exceed now by more than 60 000 ms.",
        "Without it, a compromised issuer can mint a pile of tokens dated forward and keep its access long after the compromise is found and the key is rotated, because each token is still inside its own validity window when it is used.",
        json!({ "token": future_frozen, "expected_audience": "guilds.example", "evaluate_at": AT }),
        crypto::verify_assertion(&future_live, "guilds.example", |_, _| Some(pk.clone())).is_err(),
    );

    let tampered = {
        let mut parts: Vec<String> = for_other.split('.').map(str::to_string).collect();
        let mut c = claims("guilds.example", AT, AT + 300_000);
        c.user_id = "@mallory:home.example".into();
        parts[0] = b64(&serde_json::to_vec(&c).unwrap());
        parts.join(".")
    };
    case(
        "assertion/payload-swapped-signature-kept",
        "The signature covers the payload segment exactly as transmitted. A verifier must not re-serialise the parsed claims before checking.",
        "A verifier that re-serialises is checking a signature over bytes the issuer never produced; depending on its serialiser it either rejects every honest token or accepts a rewritten one.",
        json!({ "token": tampered.clone(), "expected_audience": "guilds.example" }),
        crypto::verify_assertion(&tampered, "guilds.example", |_, _| Some(pk.clone())).is_err(),
    );

    let body = br#"{"hash":"abc123"}"#;
    let upload = |b: &[u8]| {
        federation::signing_payload("POST", "/_telium/v1/media/authorize", b, AT, "home.example", "guilds.example")
    };
    let rebuilt = upload(body);
    let honest_sig = sign_raw(&k, &rebuilt);
    let mismatched_sig = sign_raw(&k, &upload(br#"{"hash":"0000000000"}"#));
    case(
        "federation-request/body-does-not-match-the-signed-hash",
        "`body_hash` must be recomputed from the bytes actually received and the payload rebuilt from them — never taken from anything the caller supplied.",
        "This is the classic recompute-versus-echo bug. A verifier that accepts the caller's own hash has authenticated the header and nothing else, and every signed request becomes a signature on an empty promise.",
        json!({
            "authorization_header": format!("X-Telium-Federation origin=home.example,destination=guilds.example,key={},ts={AT},sig={mismatched_sig}", k.key_id),
            "body_utf8": String::from_utf8_lossy(body),
        }),
        !crypto::verify_bytes(&pk, &rebuilt, &mismatched_sig),
    );

    case(
        "federation-request/addressed-to-another-server",
        "`destination` must equal this server's own name, and it must be checked before the body is read.",
        "Without it, any request a peer signs for anybody can be forwarded to every other server. It is the same replay as the assertion audience case, one layer down, and it is checked at the door rather than after the body because a five-minute upload should not be read before the envelope is found to be misaddressed.",
        json!({
            "authorization_header": format!("X-Telium-Federation origin=home.example,destination=somebody-else.example,key={},ts={AT},sig={honest_sig}", k.key_id),
            "checked_by": "federation::check_envelope",
        }),
        true, // asserted against a live AppState in `envelope_rules_hold`
    );

    case(
        "federation-request/timestamp-outside-the-skew-window",
        "`|now - ts|` must be within the configured clock skew, in both directions.",
        "A one-sided check — rejecting old but not future timestamps — leaves a captured request replayable for as long as the attacker likes by nobody, which sounds harmless right up until the clock it was compared against is the attacker's.",
        json!({
            "authorization_header": format!("X-Telium-Federation origin=home.example,destination=guilds.example,key={},ts=1,sig={honest_sig}", k.key_id),
            "checked_by": "federation::check_envelope",
        }),
        true,
    );

    let old = primary();
    let new = successor();
    let reloc_body = json!({
        "kind": "relocation",
        "old_domain": "old.example",
        "new_domain": "attacker.example",
        "new_key_id": new.key_id,
        "new_key": new.public_b64(),
        "announced_at": AT,
        "cutover_at": AT + 604_800_000i64,
    });
    let outer_only = crypto::sign_json(&old, reloc_body.clone());
    let countersigned = {
        let mut body = reloc_body.clone();
        body["key_id"] = json!(new.key_id);
        body["signature"] = outer_only["signature"].clone();
        crypto::verify_json(&new.public_b64(), &body)
    };
    case(
        "relocation/no-successor-countersignature",
        "A relocation record must carry `new_signature`, made by the successor domain's key over the body, and the old key's signature must cover that member.",
        "Verifying only the outer signature lets a domain redirect itself — and therefore every account and guild on it — to a domain that never consented, which is a hostile takeover of an address book rather than a move.",
        json!({ "record": outer_only, "missing": "new_signature" }),
        !countersigned && outer_only.get("new_signature").is_none(),
    );

    (
        json!({
            "kind": "must-reject",
            "note": "Every artifact here is well formed and most of them carry a genuinely valid signature. A correct implementation refuses each one for the stated reason. An implementation that accepts any of them interoperates perfectly on the happy path.",
            "frozen_at": AT,
            "time_dependent": "Cases carrying `evaluate_at` are frozen so this file is byte-stable. Evaluate them with your clock set to that instant, or re-mint the artifact with the same offsets from your own now — otherwise the token is rejected for expiry and you learn nothing about the invariant under test.",
            "cases": cases,
        }),
        results,
    )
}

fn must_accept() -> (Value, Vec<(String, bool)>) {
    let k = primary();
    let pk = public();
    let (mut cases, mut results) = (Vec::new(), Vec::new());
    let mut case = |name: &str, rule: &str, why: &str, artifact: Value, accepted: bool| {
        cases.push(json!({ "name": name, "rule": rule, "why": why, "artifact": artifact }));
        results.push((name.to_string(), accepted));
    };

    let future = crypto::sign_json(
        &k,
        json!({ "kind": "spec", "value": 1i64, "a_member_added_in_a_later_release": { "nested": true } }),
    );
    case(
        "signed-json/unknown-member-is-signed-and-must-verify",
        "Serialise and verify the document as received, unknown members included. Do not filter, do not normalise, do not reject.",
        "Adding a member is an explicitly compatible change. An implementation that rejects unknown members turns every future additive change into a network partition, and the partition appears on the day somebody else deploys.",
        future.clone(),
        crypto::verify_json(&pk, &future),
    );

    let extend = |iat: i64| {
        let mut v = serde_json::to_value(claims("guilds.example", iat, iat + 300_000)).unwrap();
        v["a_claim_from_a_later_release"] = json!("ignored, but signed");
        let payload = serde_json::to_vec(&v).unwrap();
        let sig = k.signing.sign(&payload);
        format!("{}.{}.{}", b64(&payload), b64(&sig.to_bytes()), k.key_id)
    };
    let extended_live = extend(telium_server::util::now_ms());
    case(
        "assertion/unknown-claim-is-ignored-not-rejected",
        "Parse the claims leniently; verify the signature strictly over every byte received.",
        "The two halves pull in opposite directions and both are required. An implementation that is lenient in the parser and lenient in the verifier has no security; one that is strict in both has no forward compatibility.",
        json!({ "token": extend(AT), "evaluate_at": AT }),
        crypto::verify_assertion(&extended_live, "guilds.example", |_, _| Some(pk.clone())).is_ok(),
    );

    let signed = crypto::sign_json(&k, json!({ "kind": "spec" }));
    let mut relabelled = signed.clone();
    relabelled["key_id"] = json!("ed25519:some-other-label");
    case(
        "signed-json/key_id-is-outside-the-signed-bytes",
        "`key_id` and `signature` are stripped before the bytes are formed. `key_id` is therefore unauthenticated routing metadata: use it to select a key, then let the signature decide.",
        "An implementation that includes `key_id` in the signed bytes produces documents no Telium server can verify, and the error it gets back says only 'invalid signature'.",
        json!({ "original": signed, "relabelled": relabelled.clone() }),
        crypto::verify_json(&pk, &relabelled),
    );

    (
        json!({
            "kind": "must-accept",
            "note": "Over-strictness is a compatibility bug with the same blast radius as under-strictness, and it is the one a careful implementer introduces on purpose.",
            "frozen_at": AT,
            "time_dependent": "Cases carrying `evaluate_at` are frozen so this file is byte-stable. Evaluate them with your clock set to that instant, or re-mint the artifact with the same offsets from your own now.",
            "cases": cases,
        }),
        results,
    )
}

fn permission_cases() -> (Value, Vec<(String, bool)>) {
    let everyone = "01GUILD".to_string();
    let staff = "01STAFF".to_string();
    let (mut cases, mut results) = (Vec::new(), Vec::new());
    let mut case = |name: &str, rule: &str, trap: &str, setup: Value, expected: u64, actual: u64| {
        cases.push(json!({
            "name": name,
            "rule": rule,
            "what_goes_wrong": trap,
            "setup": setup,
            "expected_permissions_decimal": expected.to_string(),
        }));
        results.push((format!("{name}: expected {expected}, got {actual}"), expected == actual));
    };
    fn member<'a>(user_id: &'a str, roles: &'a [(String, u64)], ceiling: Option<u64>, timed_out: bool) -> MemberContext<'a> {
        let (guild_id, guild_owner) = ("01GUILD", "@owner:home.example");
        MemberContext { user_id, guild_id, guild_owner, roles, permission_ceiling: ceiling, timed_out }
    }
    let ow = |target_type: &str, target_id: &str, allow, deny| Overwrite {
        target_type: target_type.into(),
        target_id: target_id.into(),
        allow,
        deny,
    };

    let admin_roles = [(everyone.clone(), perms::DEFAULT_EVERYONE), (staff.clone(), perms::ADMINISTRATOR)];
    let ctx = member("@admin:home.example", &admin_roles, None, false);
    let denies_everything = vec![ow("role", &everyone, 0, u64::MAX)];
    case(
        "administrator-ignores-channel-overwrites",
        "A member holding ADMINISTRATOR (or the guild owner) has u64::MAX and channel overwrites are not applied at all.",
        "An implementation that applies the @everyone deny first and checks ADMINISTRATOR afterwards locks administrators out of channels they are supposed to be able to repair — and the person who can fix it is the one who is locked out.",
        json!({ "roles": ["@everyone (default)", "staff (ADMINISTRATOR)"], "overwrites": [{"target":"@everyone","deny":"all"}] }),
        u64::MAX,
        perms::channel_permissions(&ctx, &denies_everything),
    );

    let default_roles = [(everyone.clone(), perms::DEFAULT_EVERYONE)];
    let owner_timed_out = member("@owner:home.example", &default_roles, None, true);
    case(
        "timeout-applies-to-the-owner",
        "A timed-out member keeps exactly VIEW_CHANNEL | READ_MESSAGE_HISTORY, whoever they are.",
        "An implementation that returns early for the owner before applying the timeout produces a guild whose owner can be timed out on paper and not in fact, and a moderation log that says something untrue.",
        json!({ "user": "the guild owner", "timed_out": true }),
        perms::TIMEOUT_ALLOWED,
        perms::channel_permissions(&owner_timed_out, &[]),
    );

    let three_roles = [(everyone.clone(), perms::VIEW_CHANNEL), (staff.clone(), 0), ("01TWO".to_string(), 0)];
    let ctx = member("@member:home.example", &three_roles, None, false);
    let conflicting = vec![ow("role", &staff, 0, perms::SEND_MESSAGES), ow("role", "01TWO", perms::SEND_MESSAGES, 0)];
    case(
        "role-tier-unions-denies-then-allows",
        "All role overwrites in the tier are unioned into one allow mask and one deny mask; the deny mask is applied first and the allow mask second. Allow wins a conflict.",
        "An implementation that applies overwrites one at a time gets an answer that depends on the order the rows came back from its database — which means two servers hosting replicas of one guild disagree about who may speak, and neither is reproducible.",
        json!({
            "base": "VIEW_CHANNEL from @everyone",
            "overwrites": [{"role":"staff","deny":"SEND_MESSAGES"},{"role":"two","allow":"SEND_MESSAGES"}],
        }),
        perms::VIEW_CHANNEL | perms::SEND_MESSAGES,
        perms::channel_permissions(&ctx, &conflicting),
    );

    let member_last =
        vec![ow("role", &staff, 0, perms::SEND_MESSAGES), ow("member", "@member:home.example", perms::SEND_MESSAGES, 0)];
    let ctx_member = member("@member:home.example", &three_roles[..2], None, false);
    case(
        "member-overwrite-is-the-last-tier",
        "Order is: @everyone overwrite, then the union of role overwrites, then the member overwrite. Each tier is deny-then-allow.",
        "Flattening the tiers into one pass makes a per-member exception unable to override a role deny, which is the entire reason per-member exceptions exist.",
        json!({ "overwrites": [{"role":"staff","deny":"SEND_MESSAGES"},{"member":"@member","allow":"SEND_MESSAGES"}] }),
        perms::VIEW_CHANNEL | perms::SEND_MESSAGES,
        perms::channel_permissions(&ctx_member, &member_last),
    );

    let bot = member("@bot:home.example", &three_roles[..1], Some(perms::VIEW_CHANNEL), false);
    let grants_more = vec![ow("member", "@bot:home.example", perms::SEND_MESSAGES | perms::MANAGE_MESSAGES, 0)];
    case(
        "bot-ceiling-is-applied-after-overwrites",
        "A bot's installation grant is a ceiling on the final answer, re-applied after every overwrite tier — not only to its base permissions.",
        "Applying the ceiling only to the base lets any channel overwrite hand a bot permissions its install never asked for and the installing admin never approved. The bot behaves correctly, the audit trail looks clean, and the consent the install screen collected was for a smaller set.",
        json!({ "ceiling": "VIEW_CHANNEL", "overwrites": [{"member":"@bot","allow":"SEND_MESSAGES|MANAGE_MESSAGES"}] }),
        perms::VIEW_CHANNEL,
        perms::channel_permissions(&bot, &grants_more),
    );

    let bot_admin = member("@bot:home.example", &default_roles, Some(perms::ADMINISTRATOR), false);
    case(
        "administrator-in-a-ceiling-means-unrestricted",
        "ADMINISTRATOR in an installation ceiling lifts the ceiling entirely, exactly as ADMINISTRATOR in a role lifts ordinary permission checks.",
        "Treating the ceiling as a plain mask here gives a bot installed with ADMINISTRATOR exactly one bit and nothing else, which is the opposite of what the install screen said.",
        json!({ "ceiling": "ADMINISTRATOR", "roles": ["@everyone (default)"] }),
        perms::DEFAULT_EVERYONE,
        perms::channel_permissions(&bot_admin, &[]),
    );

    (
        json!({
            "kind": "permission-evaluation",
            "note": "Permission bits are given as decimal strings elsewhere on the wire because they exceed 2^53 and JSON numbers do not survive a JavaScript client. ADMINISTRATOR is bit 40.",
            "bits": {
                "VIEW_CHANNEL": perms::VIEW_CHANNEL.to_string(),
                "SEND_MESSAGES": perms::SEND_MESSAGES.to_string(),
                "MANAGE_MESSAGES": perms::MANAGE_MESSAGES.to_string(),
                "READ_MESSAGE_HISTORY": perms::READ_MESSAGE_HISTORY.to_string(),
                "ADMINISTRATOR": perms::ADMINISTRATOR.to_string(),
                "DEFAULT_EVERYONE": perms::DEFAULT_EVERYONE.to_string(),
                "TIMEOUT_ALLOWED": perms::TIMEOUT_ALLOWED.to_string(),
            },
            "cases": cases,
        }),
        results,
    )
}

fn signed_json_vectors() -> Value {
    let k = primary();

    let key_document = json!({
        "server_name": "home.example",
        "valid_until": AT + 86_400_000i64,
        "keys": [
            { "key_id": "ed25519:spec-primary", "public_b64u": key_block(SEED_PRIMARY, "x")["public_b64u"], "valid_from": 0, "valid_until": AT + 86_400_000i64 }
        ],
    });

    let voucher = json!({
        "audience": "media.example",
        "exp": AT + 300_000i64,
        "guild_id": "01JAAAAAAAAAAAAAAAAAAAAAAA",
        "issuer": "home.example",
        "max_bytes": 10_485_760i64,
        "user_id": "@alice:home.example",
    });

    let awkward = json!({
        "zeta": "last by name, first by insertion",
        "alpha": null,
        "unicode": "héllo — ✅ 漢字",
        "slash": "a/b",
        "int": 42i64,
        "empty_object": {},
        "empty_array": [],
        "nested": { "b": 2i64, "a": 1i64 },
        "Uppercase": "sorts before lowercase: 'U' is 0x55, 'a' is 0x61",
    });

    let mut out = Vec::new();
    for (name, note, input) in [
        (
            "key-document",
            "The signed key document embedded in `/.well-known/telium/server` and served at `/_telium/v1/keys`. Verify this one first.",
            key_document,
        ),
        (
            "media-voucher",
            "A guild server's voucher authorising one upload at a media origin. The signature is necessary and not sufficient: `audience`, `exp` and `max_bytes` are all separately enforced.",
            voucher,
        ),
        (
            "awkward-values",
            "Not a real document. Every member is a value whose canonical rendering differs between JSON writers. If your implementation reproduces these bytes, it will reproduce any Telium document.",
            awkward,
        ),
    ] {
        let signed = crypto::sign_json(&k, input.clone());
        let mut stripped = input.clone();
        stripped.as_object_mut().unwrap().remove("signature");
        stripped.as_object_mut().unwrap().remove("key_id");
        let canonical = serde_json::to_vec(&stripped).unwrap();
        out.push(json!({
            "name": name,
            "note": note,
            "key": key_block(SEED_PRIMARY, "ed25519:spec-primary"),
            "input": input,
            "canonical": bytes_block(&canonical),
            "signature_b64u": signed["signature"],
            "signed_document": signed,
        }));
    }

    let float_doc = json!({ "amount": 1.5f64, "note": "a non-integer number" });
    let attempted = crypto::sign_json(&k, float_doc.clone());
    assert_eq!(
        attempted, float_doc,
        "sign_json must return a float-bearing document untouched and unsigned",
    );
    let refusals = json!([{
        "name": "non-integer-number",
        "note": "Refused, not signed. `sign_json` returns this document unchanged -- no `key_id`, no `signature` -- and `verify_json` returns false for any document containing a non-integer number at any depth, however it was signed. An implementation that signs this document is not wrong about JSON; it is making a promise this protocol does not make.",
        "input": float_doc,
        "signed_document_is": "the input, unchanged and unsigned",
    }]);

    json!({
        "family": "signed-json",
        "produced_by": "telium_protocol::sign_json / crypto::verify_json",
        "refuses": refusals,
        "rule": "Remove the members `signature` and `key_id` if present. Serialise what remains as JSON with no insignificant whitespace and every object's members ordered by the UTF-8 bytes of their keys, at every depth. Sign those bytes with Ed25519. Base64url-encode the 64-byte signature with no padding. Re-insert `key_id` and `signature`.",
        "verification_is_order_sensitive": true,
        "vectors": out,
    })
}

fn assertion_vectors() -> Value {
    let k = primary();

    let with_avatar = AssertionClaims {
        user_id: "@alice:home.example".into(),
        device_id: "dev-01JAAAAAAAAAAAAAAAAAAAAAAA".into(),
        device_pubkey: pub_of(SEED_DEVICE),
        audience: "guilds.example".into(),
        origin: "home.example".into(),
        profile_version: 7,
        display_name: "Alice".into(),
        avatar_ref: Some("media://home.example/abc123".into()),
        iat: AT,
        exp: AT + 300_000,
    };
    let without_avatar = AssertionClaims { avatar_ref: None, ..with_avatar.clone() };

    let mut out = Vec::new();
    for (name, note, claims) in [
        ("with-avatar", "Full claim set.", with_avatar),
        (
            "no-avatar",
            "`avatar_ref` is omitted, not null, when the account has no avatar.",
            without_avatar,
        ),
    ] {
        let payload = serde_json::to_vec(&claims).unwrap();
        let token = crypto::issue_assertion(&k, &claims);
        out.push(json!({
            "name": name,
            "note": note,
            "key": key_block(SEED_PRIMARY, "ed25519:spec-primary"),
            "claims": serde_json::to_value(&claims).unwrap(),
            "canonical": bytes_block(&payload),
            "signature_b64u": sign_raw(&k, &payload),
            "token": token,
        }));
    }

    json!({
        "family": "identity-assertion",
        "produced_by": "crypto::issue_assertion / crypto::verify_assertion",
        "rule": "The token is `base64url(payload) '.' base64url(signature) '.' key_id`, all base64url with no padding. The signature covers the payload bytes exactly as they appear in the token, before base64 decoding is undone — NOT a re-serialisation of the parsed claims. A verifier decodes, verifies over those bytes, then parses.",
        "verification_is_order_sensitive": false,
        "issuer_field_order": ["user_id", "device_id", "device_pubkey", "audience", "origin", "profile_version", "display_name", "avatar_ref", "iat", "exp"],
        "vectors": out,
    })
}

fn federation_request_vectors() -> Value {
    let k = primary();
    let mut out = Vec::new();

    for (name, note, method, path, body) in [
        (
            "get-empty-body",
            "A GET has no body, so `body_hash` is BLAKE3 of the empty string. It is still present: the member is never omitted.",
            "GET",
            "/_telium/v1/keys",
            &b""[..],
        ),
        (
            "post-json-body",
            "The body is hashed, not signed directly, so the signature is a fixed size whatever the body is — which is what lets a five-minute migration upload be covered by one signature.",
            "POST",
            "/_telium/v1/media/authorize",
            &br#"{"hash":"abc123"}"#[..],
        ),
        (
            "lowercase-method-is-upper-cased",
            "The method is upper-cased before it enters the payload. A signer that signs `get` and a verifier that receives `GET` disagree, and this is the vector that says which side is right.",
            "get",
            "/_telium/v1/health",
            &b""[..],
        ),
    ] {
        let payload =
            federation::signing_payload(method, path, body, AT, "home.example", "guilds.example");
        out.push(json!({
            "name": name,
            "note": note,
            "key": key_block(SEED_PRIMARY, "ed25519:spec-primary"),
            "request": {
                "method": method,
                "path": path,
                "body_utf8": String::from_utf8_lossy(body),
                "timestamp": AT,
                "origin": "home.example",
                "destination": "guilds.example",
            },
            "canonical": bytes_block(&payload),
            "signature_b64u": sign_raw(&k, &payload),
            "authorization_header": format!(
                "X-Telium-Federation origin=home.example,destination=guilds.example,key={},ts={AT},sig={}",
                k.key_id,
                sign_raw(&k, &payload),
            ),
        }));
    }

    json!({
        "family": "federation-request",
        "produced_by": "federation::signing_payload / federation::auth_header / federation::verify_request",
        "rule": "Build the JSON object {body_hash, destination, method, origin, path, timestamp} — sorted, no whitespace — where `method` is upper-cased, `body_hash` is the lowercase hex BLAKE3 of the request body (of the empty string when there is none), `timestamp` is milliseconds since the Unix epoch, `origin` is the server the request is from and `destination` the server it is addressed to. Sign those bytes. The header is `X-Telium-Federation ` followed by comma-separated `name=value` pairs with no quoting.",
        "query_string_is_covered": false,
        "vectors": out,
    })
}

fn domain_separated_vectors() -> Value {
    let identity_key = pub_of(SEED_DEVICE);
    let immutable_id = immutable_id_for_key(&identity_key).unwrap();
    let successor_key = pub_of(SEED_SUCCESSOR);

    let guardians = vec![
        Guardian {
            user_id: "@zoe:home.example".into(),
            immutable_id: "tid:ff".into(),
            identity_key: "ZZZZ".into(),
        },
        Guardian {
            user_id: "@bob:home.example".into(),
            immutable_id: "tid:00".into(),
            identity_key: "BBBB".into(),
        },
    ];

    let device = SigningKey::from_bytes(&SEED_DEVICE);
    let sign = |bytes: &[u8]| b64(&ed25519_dalek::Signer::sign(&device, bytes).to_bytes());

    let anchor = anchor_payload("@alice:home.example", &immutable_id, &identity_key);
    let rotate = rotation_payload(&immutable_id, 1, &identity_key, &successor_key);
    let policy = recovery_policy_payload(&immutable_id, 1, 0, 2, &guardians);
    let grant = migration::grant_payload(
        "@alice:home.example",
        "new.example",
        "import-token-deadbeef",
        AT,
    );

    json!({
        "family": "domain-separated",
        "produced_by": "routes::identity_continuity::{anchor_payload, rotation_payload, recovery_policy_payload} / migration::grant_payload",
        "rule": "Each payload is a UTF-8 string built by joining a constant domain tag and the named fields with U+007C VERTICAL LINE, except `migration_grant`, which is a sorted JSON object like the signed-json family but signed by a device key and never carrying a `signature` member. Signatures are Ed25519, verified strictly, base64url with no padding.",
        "identity_id_rule": "`tid:` followed by the lowercase hex SHA-256 of the bytes `telium-identity-id:v1\\0` concatenated with the raw 32-byte Ed25519 public key. Note the trailing NUL in the domain tag: it is part of the hashed bytes.",
        "vectors": [
            {
                "name": "immutable-id",
                "note": "Not a signature: the derivation of a `tid:` from an identity key. Get this wrong and every signature below is made over the wrong subject.",
                "identity_key_b64u": identity_key,
                "immutable_id": immutable_id,
            },
            {
                "name": "identity-anchor",
                "note": "A new identity root binding an account name to a key. Signed by the identity key itself.",
                "key": key_block(SEED_DEVICE, "device"),
                "fields": { "user_id": "@alice:home.example", "immutable_id": immutable_id, "identity_key": identity_key },
                "canonical": bytes_block(&anchor),
                "signature_b64u": sign(&anchor),
            },
            {
                "name": "identity-rotation",
                "note": "Signed by the NEW key, over the sequence and both keys. `sequence` is the rotation count, and it is in the payload so a replayed rotation cannot be reordered.",
                "key": key_block(SEED_SUCCESSOR, "successor"),
                "fields": { "immutable_id": immutable_id, "sequence": 1, "previous_key": identity_key, "new_key": successor_key },
                "canonical": bytes_block(&rotate),
                "signature_b64u": b64(&ed25519_dalek::Signer::sign(&SigningKey::from_bytes(&SEED_SUCCESSOR), &rotate).to_bytes()),
            },
            {
                "name": "recovery-policy",
                "note": "The guardians are SORTED before they are serialised — by immutable_id, then user_id, then identity_key — and they are given here deliberately out of order so the vector proves it. An implementation that preserves the caller's order produces a policy nobody else can verify.",
                "key": key_block(SEED_DEVICE, "device"),
                "fields": {
                    "immutable_id": immutable_id,
                    "version": 1,
                    "identity_sequence": 0,
                    "threshold": 2,
                    "guardians_as_given": guardians,
                },
                "canonical": bytes_block(&policy),
                "signature_b64u": sign(&policy),
            },
            {
                "name": "migration-grant",
                "note": "A device authorising its account's move. `import_token_hash` is the lowercase hex BLAKE3 of the import token — the token itself is never signed, so a grant leaked from a log does not leak the token.",
                "key": key_block(SEED_DEVICE, "device"),
                "fields": {
                    "subject": "@alice:home.example",
                    "destination": "new.example",
                    "import_token": "import-token-deadbeef",
                    "created_at": AT,
                },
                "canonical": bytes_block(&grant),
                "signature_b64u": sign(&grant),
            },
        ],
    })
}

fn relocation_vectors() -> Value {
    let old = primary();
    let new = successor();
    let body = json!({
        "kind": "relocation",
        "old_domain": "old.example",
        "new_domain": "new.example",
        "new_key_id": new.key_id,
        "new_key": new.public_b64(),
        "announced_at": AT,
        "cutover_at": AT + 604_800_000i64,
    });

    let record = telium_server::relocation::sign_record(&old, &new, body.clone());

    let inner_bytes = serde_json::to_vec(&body).unwrap();
    let mut outer = body.clone();
    outer["new_signature"] = record["new_signature"].clone();
    let outer_bytes = serde_json::to_vec(&outer).unwrap();

    json!({
        "family": "relocation-record",
        "produced_by": "relocation::sign_record / relocation::check_signatures",
        "rule": "Sign the body with the successor key using the signed-json rule. Move that signature to a member named `new_signature`. Sign the result — `new_signature` included — with the old domain's key using the signed-json rule, which adds `key_id` and `signature`. To verify: check `signature` against the old key over the whole record minus `signature`/`key_id`; then remove `new_signature`, put its value in `signature` and the successor's id in `key_id`, and check that against the successor key.",
        "vectors": [{
            "name": "announced-relocation",
            "old_key": key_block(SEED_PRIMARY, "ed25519:spec-primary"),
            "new_key": key_block(SEED_SUCCESSOR, "ed25519:spec-successor"),
            "body": body,
            "successor_canonical": bytes_block(&inner_bytes),
            "new_signature_b64u": record["new_signature"],
            "old_canonical": bytes_block(&outer_bytes),
            "signature_b64u": record["signature"],
            "record": record,
        }],
    })
}

fn published() -> Vec<(&'static str, Value, Vec<(String, bool)>)> {
    let (reject, reject_v) = must_reject();
    let (accept, accept_v) = must_accept();
    let (perm, perm_v) = permission_cases();
    vec![
        ("signed-json.json", signed_json_vectors(), vec![]),
        ("identity-assertion.json", assertion_vectors(), vec![]),
        ("federation-request.json", federation_request_vectors(), vec![]),
        ("domain-separated.json", domain_separated_vectors(), vec![]),
        ("relocation-record.json", relocation_vectors(), vec![]),
        ("must-reject.json", reject, reject_v),
        ("must-accept.json", accept, accept_v),
        ("permissions.json", perm, perm_v),
    ]
}

#[test]
fn published_files_match_the_code_and_its_behaviour() {
    let update = std::env::var_os("UPDATE_SPEC_VECTORS").is_some();
    let mut problems = Vec::new();
    for (file, produced, verdicts) in published() {
        problems.extend(verdicts.into_iter().filter(|(_, ok)| !ok).map(|(name, _)| format!("{file}: {name}")));
        let path = std::path::Path::new(VECTORS).join(file);
        let rendered = format!("{}\n", serde_json::to_string_pretty(&produced).unwrap());
        if update {
            std::fs::write(&path, &rendered).unwrap();
        } else if std::fs::read_to_string(&path).ok().as_deref() != Some(rendered.as_str()) {
            problems.push(format!("{file}: stale or missing"));
        }
    }
    assert!(
        problems.is_empty(),
        "docs/spec/vectors disagrees with the code:\n  - {}\n\nChanging what a signature covers is an \
         incompatible change (docs/compatibility.md). Regenerate: UPDATE_SPEC_VECTORS=1 cargo test --test spec_vectors",
        problems.join("\n  - "),
    );
}

#[test]
fn published_vectors_verify_against_the_verifier() {
    let read = |file: &str| -> Value {
        serde_json::from_str(&std::fs::read_to_string(std::path::Path::new(VECTORS).join(file)).unwrap()).unwrap()
    };
    let s = |v: &Value| v.as_str().unwrap().to_string();
    let hex_of = |v: &Value| hex::decode(v["hex"].as_str().unwrap()).unwrap();
    let public = |v: &Value| s(&v["key"]["public_b64u"]);
    let covers = |v: &Value| crypto::verify_bytes(&public(v), &hex_of(&v["canonical"]), &s(&v["signature_b64u"]));

    let signed = read("signed-json.json");
    for v in signed["vectors"].as_array().unwrap() {
        assert!(crypto::verify_json(&public(v), &v["signed_document"]) && covers(v), "signed-json/{}", v["name"]);
    }
    for v in signed["refuses"].as_array().unwrap() {
        assert!(!crypto::verify_json(&public(&signed["vectors"][0]), &v["input"]), "refuses/{}", v["name"]);
    }
    for v in read("identity-assertion.json")["vectors"].as_array().unwrap() {
        let pk = public(v);
        if let Err(e) = crypto::verify_assertion(&s(&v["token"]), "guilds.example", |_, _| Some(pk.clone())) {
            assert!(format!("{e:?}").contains("expired"), "identity-assertion/{}: {e:?}", v["name"]);
        }
        assert!(covers(v), "identity-assertion/{}", v["name"]);
    }
    for v in read("federation-request.json")["vectors"].as_array().unwrap() {
        let r = &v["request"];
        let rebuilt = federation::signing_payload(
            &s(&r["method"]),
            &s(&r["path"]),
            s(&r["body_utf8"]).as_bytes(),
            r["timestamp"].as_i64().unwrap(),
            &s(&r["origin"]),
            &s(&r["destination"]),
        );
        assert_eq!(rebuilt, hex_of(&v["canonical"]), "federation-request/{}", v["name"]);
        assert!(covers(v), "federation-request/{}", v["name"]);
    }
    for v in read("domain-separated.json")["vectors"].as_array().unwrap() {
        assert!(v.get("signature_b64u").is_none() || covers(v), "domain-separated/{}", v["name"]);
    }
    for v in read("relocation-record.json")["vectors"].as_array().unwrap() {
        let check = |key: &str, bytes: &str, sig: &str| {
            crypto::verify_bytes(&s(&v[key]["public_b64u"]), &hex_of(&v[bytes]), &s(&v[sig]))
        };
        assert!(check("old_key", "old_canonical", "signature_b64u"), "relocation: old signature");
        assert!(check("new_key", "successor_canonical", "new_signature_b64u"), "relocation: successor signature");
    }
}

#[tokio::test]
async fn envelope_rules_hold() {
    let dir = std::env::temp_dir().join(format!("telium-spec-conformance-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cfg = Config {
        server_name: "guilds.example".into(),
        public_base_url: "http://guilds.example".into(),
        database_url: format!("sqlite://{}/telium.db?mode=rwc", dir.display()),
        media_dir: dir.join("media"),
        ..Config::default()
    };
    cfg.backup.enabled = false;
    let state = telium_server::build_state(cfg).await.unwrap();
    let k = primary();
    let now = telium_server::util::now_ms();
    let header = |ts: i64, destination: &str| {
        let payload = federation::signing_payload("GET", "/_telium/v1/keys", b"", ts, "home.example", destination);
        format!(
            "X-Telium-Federation origin=home.example,destination={destination},key={},ts={ts},sig={}",
            k.key_id,
            sign_raw(&k, &payload)
        )
    };
    assert_eq!(federation::check_envelope(&state, &header(now, "guilds.example")).unwrap(), "home.example");
    assert!(federation::check_envelope(&state, &header(now, "somebody-else.example")).is_err(), "misaddressed");
    for ts in [1i64, now + 86_400_000] {
        assert!(federation::check_envelope(&state, &header(ts, "guilds.example")).is_err(), "ts={ts} accepted");
    }
    let truncated = format!("X-Telium-Federation origin=home.example,key={},ts={now}", k.key_id);
    assert!(federation::check_envelope(&state, &truncated).is_err(), "no destination must be refused");

    sqlx::query("INSERT INTO remote_servers (origin, api_base, gateway, fetched_at) VALUES ('peer.example', 'http://127.0.0.1:1', NULL, ?)")
        .bind(now)
        .execute(&state.pool)
        .await
        .unwrap();
    let (from, until) = (now - 172_800_000, now - 86_400_000);
    sqlx::query(
        "INSERT INTO remote_keys (origin, key_id, public_b64, valid_from, valid_until, fetched_at) \
         VALUES ('peer.example', 'ed25519:retired', ?, ?, ?, ?)",
    )
    .bind(public())
    .bind(from)
    .bind(until)
    .bind(now)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(federation::verify_key(&state, "peer.example", "ed25519:retired").await, None);
    let at = |t| federation::verify_key_at(&state, "peer.example", "ed25519:retired", t);
    assert_eq!(at(from + 3_600_000).await.as_deref(), Some(public().as_str()));
    assert_eq!(at(until).await, None, "the window's upper bound is exclusive");
    let _ = std::fs::remove_dir_all(&dir);
}
