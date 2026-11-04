//! The public SFU directory, end to end: a signed feed is fetched and held, a
//! guild with no configured regions picks a listed relay and pins to it, the
//! guild's voice modes gate the directory, add-time probes are advisory, and a
//! delisted relay loses its listing flag.
//!
//! The directory's URLs must be HTTPS (browsers probe relays from a HTTPS
//! app), so the held documents name `https://relay1.test`-style relays that
//! don't resolve; the probe itself — including its `accepting` parsing — is
//! exercised against a local HTTP host, which `probe_relay` accepts as any
//! guild region URL would be.

use super::*;
use telium_protocol::sfu_directory::{self, Sfu};
use telium_server::config::VoiceRegion;

const DAY: i64 = 86_400_000;
const RELAY1: &str = "https://relay1.test";
const RELAY2: &str = "https://relay2.test";

struct SfuHost {
    directory_url: String,
    /// A local relay that answers `/health` with `accepting: true`.
    reachable: String,
    /// A local relay that answers `/health` with `accepting: false`.
    declining: String,
    document: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

impl SfuHost {
    async fn start() -> SfuHost {
        let document = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let served = document.clone();
        let app = axum::Router::new()
            .route(
                "/directory.json",
                axum::routing::get(move || {
                    let served = served.clone();
                    async move { served.lock().unwrap().clone() }
                }),
            )
            .route(
                "/reachable/health",
                axum::routing::get(|| async { axum::Json(serde_json::json!({ "ok": true, "accepting": true })) }),
            )
            .route(
                "/declining/health",
                axum::routing::get(|| async { axum::Json(serde_json::json!({ "ok": true, "accepting": false })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        SfuHost {
            directory_url: format!("http://{addr}/directory.json"),
            reachable: format!("http://{addr}/reachable"),
            declining: format!("http://{addr}/declining"),
            document,
        }
    }

    fn serve(&self, bytes: Vec<u8>) {
        *self.document.lock().unwrap() = bytes;
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn keypair() -> (ed25519_dalek::SigningKey, String) {
    let key = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
    let public = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    (key, public)
}

fn relay(url: &str, name: &str, weight: u64) -> Sfu {
    Sfu {
        url: url.into(),
        name: name.into(),
        description: Some("A test relay.".into()),
        region: "eu-central".into(),
        region_label: "Frankfurt, DE".into(),
        operator_name: "Test Collective".into(),
        contact: "mailto:ops@test.example".into(),
        capacity_band: "1g".into(),
        weight,
        pubkey_hint: None,
    }
}

fn document(key: &ed25519_dalek::SigningKey, serial: u64, sfus: Vec<Sfu>) -> Vec<u8> {
    let now = now_millis();
    let directory = sfu_directory::Directory::new("telium.chat", serial, now - 1_000, now + DAY, sfus);
    serde_json::to_vec(&sfu_directory::sign(key, "ed25519:test", &directory)).unwrap()
}

/// A server with an empty region pool and a subscribed directory: the exact
/// configuration the directory exists to fill.
async fn directory_fixture(host: &SfuHost, public: &str) -> (Server, User, User, String, String) {
    let host_url = host.directory_url.clone();
    let pin = public.to_string();
    let s = start_with(move |cfg| {
        cfg.federation.allow_http = true;
        cfg.voice.directory.url = host_url;
        cfg.voice.directory.key = pin;
        cfg.voice.regions = Vec::new();
        cfg.voice.default_region = "local".into();
    })
    .await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (status, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({ "name": "Voice", "type": "voice" }))
        .await;
    assert_eq!(status, 200, "{ch}");
    let cid = ch["id"].as_str().unwrap().to_string();
    (s, alice, bob, gid, cid)
}

#[tokio::test]
async fn a_guild_with_no_regions_picks_a_listed_relay() {
    let host = SfuHost::start().await;
    let (key, public) = keypair();
    host.serve(document(&key, 1, vec![relay(RELAY1, "One", 2), relay(RELAY2, "Two", 1)]));

    let (s, alice, bob, _gid, cid) = directory_fixture(&host, &public).await;

    // Nothing held yet: no regions, no directory, so calls are mesh.
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["mode"], "mesh", "{join:?}");
    let (status, left) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/leave"), Some(&alice.token), json!({}))
        .await;
    assert_eq!(status, 200, "{left:?}");

    // The feed is fetched and held.
    let refused =
        telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();
    assert!(refused.is_none(), "a well-signed document is adopted: {refused:?}");
    let held = telium_server::sfu_directory::relays(&s.state).await.unwrap();
    assert_eq!(held.len(), 2, "both relays are held");

    // With no configured regions, an automatic guild resolves a listed relay.
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({ "key_package": "pkg" }))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["mode"], "sfu", "{join:?}");
    let pinned = join["voice_server"]["endpoint"].as_str().unwrap().to_string();
    assert!(pinned == RELAY1 || pinned == RELAY2, "endpoint is a listed relay: {pinned}");
    // The relay's URL is the region name, so the pin round-trips.
    assert_eq!(join["voice_server"]["region"], pinned.as_str());

    // A late joiner following the call's pinned relay lands on the same relay.
    let (status, follow) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/join"),
            Some(&bob.token),
            json!({ "key_package": "pkg", "region": pinned }),
        )
        .await;
    assert_eq!(status, 200, "{follow:?}");
    assert_eq!(follow["voice_server"]["endpoint"], pinned.as_str(), "the pin is honoured");

    // Even a conflicting explicit request must not split an active call.
    let other = if pinned == RELAY1 { RELAY2 } else { RELAY1 };
    let (status, moved) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/voice/join"),
            Some(&bob.token),
            json!({ "key_package": "pkg", "region": other }),
        )
        .await;
    assert_eq!(status, 200, "{moved:?}");
    assert_eq!(moved["voice_server"]["endpoint"], pinned.as_str(), "active call stays pinned");

    // The listing endpoint surfaces the held entries; the named relays do not
    // resolve in a test, so the probe round reports them unreachable.
    let (status, listing) = s.get("/_telium/v1/voice/directory", Some(&alice.token)).await;
    assert_eq!(status, 200, "{listing:?}");
    assert_eq!(listing["enabled"], true);
    let entries = listing["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["url"], RELAY1);
    assert_eq!(entries[0]["reachable"], false, "relay1.test does not resolve here");
    assert_eq!(entries[0]["weight"], 2);

    // The probe itself — including the `accepting` field a real relay reports —
    // is checked against the local host, as a guild region URL would be.
    let ok = telium_server::sfu_directory::probe_relay(&s.state, &host.reachable).await;
    assert!(ok.ok);
    assert_eq!(ok.accepting, Some(true), "{ok:?}");
    let declining = telium_server::sfu_directory::probe_relay(&s.state, &host.declining).await;
    assert!(declining.ok, "an HTTP 200 from a relay that is full is still a reachable relay");
    assert_eq!(declining.accepting, Some(false));
}


#[tokio::test]
async fn verified_capacity_refusal_moves_every_participant_together() {
    use std::sync::atomic::{AtomicBool, Ordering};

    // A real local relay whose admission switches from open to full. This is
    // different from an offline endpoint: a client must not be able to trigger
    // forced migration with an unverified assertion.
    let accepting = std::sync::Arc::new(AtomicBool::new(true));
    let switch = accepting.clone();
    let app = axum::Router::new().route("/health", axum::routing::get(move || {
        let current = switch.clone();
        async move {
            axum::Json(json!({
                "service": "telium-sfu", "ok": true,
                "accepting": current.load(Ordering::SeqCst),
            }))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let primary = format!("http://{addr}");
    let host = SfuHost::start().await;
    let backup = host.reachable.clone();
    let s = start_with(move |cfg| {
        cfg.voice.directory.enabled = false;
        cfg.voice.default_region = "primary".into();
        cfg.voice.regions = vec![
            VoiceRegion {
                name: "primary".into(), sfu: primary,
                turn: None, pubkey_hint: None,
            },
            VoiceRegion {
                name: "backup".into(), sfu: backup,
                turn: None, pubkey_hint: None,
            },
        ];
    }).await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_owned();
    let (_, invite) = s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    let (_, channel) = s.post(
        &format!("/_telium/v1/guilds/{gid}/channels"),
        Some(&alice.token), json!({ "name": "Voice", "type": "voice" }),
    ).await;
    let cid = channel["id"].as_str().unwrap();

    let (status, first) = s.post(
        &format!("/_telium/v1/channels/{cid}/voice/join"),
        Some(&alice.token), json!({ "key_package": "pkg" }),
    ).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["voice_server"]["region"], "primary");

    let (status, second) = s.post(
        &format!("/_telium/v1/channels/{cid}/voice/join"),
        Some(&bob.token), json!({ "key_package": "pkg", "region": "backup" }),
    ).await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["voice_server"]["region"], "primary", "active calls remain pinned");

    // Reporting a healthy relay as full must not relocate anybody.
    let (status, denied) = s.post(
        &format!("/_telium/v1/channels/{cid}/voice/relay-full"),
        Some(&bob.token), json!({ "region": "primary" }),
    ).await;
    assert_eq!(status, 409, "{denied}");

    accepting.store(false, Ordering::SeqCst);
    let (status, migrated) = s.post(
        &format!("/_telium/v1/channels/{cid}/voice/relay-full"),
        Some(&bob.token), json!({ "region": "primary" }),
    ).await;
    assert_eq!(status, 200, "{migrated}");
    assert_eq!(migrated["changed"], true, "{migrated}");

    let (status, result) = s.get(
        &format!("/_telium/v1/channels/{cid}/voice"), Some(&alice.token),
    ).await;
    assert_eq!(status, 200, "{result}");
    let states = result["voice_states"].as_array().unwrap();
    assert_eq!(states.len(), 2);
    for user in states {
        assert_eq!(user["region"], "backup", "every participant must migrate: {result}");
    }

    // A stale second report cannot bounce the call again.
    let (_, stale) = s.post(
        &format!("/_telium/v1/channels/{cid}/voice/relay-full"),
        Some(&bob.token), json!({ "region": "primary" }),
    ).await;
    assert_eq!(stale["changed"], false, "{stale}");
}

#[tokio::test]
async fn direct_and_fixed_modes_decline_the_directory() {
    let host = SfuHost::start().await;
    let (key, public) = keypair();
    host.serve(document(&key, 1, vec![relay(RELAY1, "One", 3)]));

    let (s, alice, _bob, gid, cid) = directory_fixture(&host, &public).await;
    telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();

    for mode in ["direct", "fixed"] {
        let (status, patched) = s
            .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "settings": { "voice_mode": mode } }))
            .await;
        assert_eq!(status, 200, "{patched:?}");

        let (status, join) = s
            .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({}))
            .await;
        assert_eq!(status, 200, "{join:?}");
        assert_eq!(join["voice_server"]["mode"], "mesh", "{mode} declines the directory: {join:?}");
    }

    // Back to automatic: the directory answers again.
    let (status, patched) = s
        .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "settings": { "voice_mode": "automatic" } }))
        .await;
    assert_eq!(status, 200, "{patched:?}");
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({ "key_package": "pkg" }))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["mode"], "sfu", "{join:?}");
    assert_eq!(join["voice_server"]["endpoint"], RELAY1);
}

#[tokio::test]
async fn configured_regions_outrank_the_directory() {
    let host = SfuHost::start().await;
    let (key, public) = keypair();
    host.serve(document(&key, 1, vec![relay(RELAY1, "One", 3)]));

    // Same fixture, but the operator configured one region.
    let host_url = host.directory_url.clone();
    let pin = public.clone();
    let s = start_with(move |cfg| {
        cfg.federation.allow_http = true;
        cfg.voice.directory.url = host_url;
        cfg.voice.directory.key = pin;
        cfg.voice.regions = vec![VoiceRegion {
            name: "ops".into(),
            sfu: "https://ops.example".into(),
            turn: None,
            pubkey_hint: None,
        }];
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (status, ch) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({ "name": "Voice", "type": "voice" }))
        .await;
    let cid = ch["id"].as_str().unwrap().to_string();
    assert_eq!(status, 200, "{ch}");

    telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({ "key_package": "pkg" }))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["endpoint"], "https://ops.example", "the operator's region wins: {join:?}");
}

#[tokio::test]
async fn add_time_probe_is_advisory_and_seeds_health() {
    let host = SfuHost::start().await;
    let (key, public) = keypair();
    host.serve(document(&key, 1, vec![relay(RELAY1, "One", 2)]));

    let (s, alice, _bob, gid, _cid) = directory_fixture(&host, &public).await;
    telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();

    // A relay that answers probes fine.
    let (status, added) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/regions"),
            Some(&alice.token),
            json!({ "name": "reachable", "sfu": host.reachable }),
        )
        .await;
    assert_eq!(status, 200, "{added:?}");
    assert_eq!(added["reachable"], true, "{added:?}");
    assert_eq!(added["accepting"], true);

    // A listed relay that does not resolve here: added anyway, flagged listed.
    let (status, listed) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/regions"),
            Some(&alice.token),
            json!({ "name": "one", "sfu": RELAY1, "from_directory": true }),
        )
        .await;
    assert_eq!(status, 200, "{listed:?}");
    assert_eq!(listed["reachable"], false, "{listed:?}");

    // A dead address still adds: the probe is a warning, not a gate.
    let (status, dead) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/regions"),
            Some(&alice.token),
            json!({ "name": "dead", "sfu": "http://127.0.0.1:1" }),
        )
        .await;
    assert_eq!(status, 200, "{dead:?}");
    assert_eq!(dead["reachable"], false, "{dead:?}");

    let (status, list) = s
        .get(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&alice.token))
        .await;
    assert_eq!(status, 200, "{list:?}");
    assert_eq!(list["voice_mode"], "automatic", "the mode rides along");
    let rows = list["regions"].as_array().unwrap();
    let reachable = rows.iter().find(|r| r["name"] == "reachable").unwrap();
    assert_eq!(reachable["healthy"], true, "{reachable}");
    assert_eq!(reachable["listed"], Value::Null, "a URL the directory never listed has no listing state");
    let one = rows.iter().find(|r| r["name"] == "one").unwrap();
    // A failed probe records no health row: the server's vantage is not
    // authoritative, so the relay stays unknown rather than marked down.
    assert_eq!(one["healthy"], true, "{one}");
    assert_eq!(one["listed"], true, "a directory URL on the held copy is listed");
    let dead = rows.iter().find(|r| r["name"] == "dead").unwrap();
    assert_eq!(dead["healthy"], true, "unknown is not down");
    assert_eq!(dead["listed"], Value::Null);
}

#[tokio::test]
async fn a_delisted_relay_loses_its_listing_flag() {
    let host = SfuHost::start().await;
    let (key, public) = keypair();
    host.serve(document(&key, 1, vec![relay(RELAY1, "One", 2)]));

    let (s, alice, _bob, gid, cid) = directory_fixture(&host, &public).await;
    telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();

    let (status, added) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/voice/regions"),
            Some(&alice.token),
            json!({ "name": "one", "sfu": RELAY1, "from_directory": true, "set_default": true }),
        )
        .await;
    assert_eq!(status, 200, "{added:?}");

    // The publisher drops relay1 in serial 2.
    host.serve(document(&key, 2, vec![relay(RELAY2, "Two", 2)]));
    let refused =
        telium_server::sfu_directory::refresh(&s.state, &host.directory_url, &public).await.unwrap();
    assert!(refused.is_none(), "serial 2 adopts cleanly: {refused:?}");

    // The guild's fixed row keeps working — and keeps its calls — but is
    // flagged as no longer listed. Explicit choices survive delisting.
    let (status, list) = s
        .get(&format!("/_telium/v1/guilds/{gid}/voice/regions"), Some(&alice.token))
        .await;
    assert_eq!(status, 200, "{list:?}");
    let one = list["regions"].as_array().unwrap().iter().find(|r| r["name"] == "one").unwrap().clone();
    assert_eq!(one["listed"], false, "{one}");
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid}/voice/join"), Some(&alice.token), json!({ "key_package": "pkg" }))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["endpoint"], RELAY1, "the guild's own pin still governs its calls: {join:?}");

    // A guild with no regions of its own migrates to the survivor.
    let (_, guild2) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Second" })).await;
    let gid2 = guild2["id"].as_str().unwrap().to_string();
    let (status, ch2) = s
        .post(&format!("/_telium/v1/guilds/{gid2}/channels"), Some(&alice.token), json!({ "name": "Voice", "type": "voice" }))
        .await;
    assert_eq!(status, 200, "{ch2}");
    let cid2 = ch2["id"].as_str().unwrap().to_string();
    let (status, join) = s
        .post(&format!("/_telium/v1/channels/{cid2}/voice/join"), Some(&alice.token), json!({ "key_package": "pkg" }))
        .await;
    assert_eq!(status, 200, "{join:?}");
    assert_eq!(join["voice_server"]["endpoint"], RELAY2, "the call moves off the delisted relay: {join:?}");
}
