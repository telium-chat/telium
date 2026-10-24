use super::*;

struct FeedHost {
    url: String,
    directory_url: String,
    body: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
    directory: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

impl FeedHost {
    async fn start() -> FeedHost {
        let body = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let directory = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let served = body.clone();
        let served_directory = directory.clone();
        let app = axum::Router::new()
            .route(
                "/feed.json",
                axum::routing::get(move || {
                    let served = served.clone();
                    async move { served.lock().unwrap().clone() }
                }),
            )
            .route(
                "/curators.json",
                axum::routing::get(move || {
                    let served = served_directory.clone();
                    async move { served.lock().unwrap().clone() }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        FeedHost {
            url: format!("http://{addr}/feed.json"),
            directory_url: format!("http://{addr}/curators.json"),
            body,
            directory,
        }
    }

    fn serve(&self, bytes: Vec<u8>) {
        *self.body.lock().unwrap() = bytes;
    }

    fn serve_directory(&self, bytes: Vec<u8>) {
        *self.directory.lock().unwrap() = bytes;
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn curator(seed: u8) -> (SigningKey, String) {
    let key = SigningKey::from_bytes(&[seed; 32]);
    let public = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    (key, public)
}

fn media_feed_doc(key: &SigningKey, serial: u64, entries: &[(&str, Action)]) -> Vec<u8> {
    let now = now_millis();
    media_feed_doc_at(key, serial, now - 1_000, now + 86_400_000, entries)
}

fn media_feed_doc_at(
    key: &SigningKey,
    serial: u64,
    issued_at: i64,
    expires_at: i64,
    entries: &[(&str, Action)],
) -> Vec<u8> {
    let entries = entries
        .iter()
        .map(|(origin, action)| media_feed::Entry {
            origin: origin.to_string(),
            action: *action,
            name: None,
            description: None,
            max_file_bytes: None,
            abuse_contact: None,
        })
        .collect();
    let feed = media_feed::Feed::new("curator.example", serial, issued_at, expires_at, entries);
    serde_json::to_vec(&media_feed::sign(key, "ed25519:test", &feed)).unwrap()
}

fn media_feed_doc_announcing(
    key: &SigningKey,
    serial: u64,
    to_key: &str,
    rotation: u64,
    entries: &[(&str, Action)],
) -> Vec<u8> {
    let now = now_millis();
    let entries = entries
        .iter()
        .map(|(origin, action)| media_feed::Entry {
            origin: origin.to_string(),
            action: *action,
            name: None,
            description: None,
            max_file_bytes: None,
            abuse_contact: None,
        })
        .collect();
    let feed = media_feed::Feed::new("curator.example", serial, now - 1_000, now + 86_400_000, entries)
        .announcing(to_key, rotation);
    serde_json::to_vec(&media_feed::sign(key, "ed25519:test", &feed)).unwrap()
}

fn directory_doc(key: &SigningKey, serial: u64, curators: &[(&str, &str, &str)]) -> Vec<u8> {
    let now = now_millis();
    directory_doc_at(key, serial, now - 1_000, now + 86_400_000, curators)
}

fn directory_doc_at(
    key: &SigningKey,
    serial: u64,
    issued_at: i64,
    expires_at: i64,
    curators: &[(&str, &str, &str)],
) -> Vec<u8> {
    let curators = curators
        .iter()
        .map(|(name, feed_url, feed_key)| curator_directory::Curator {
            name: name.to_string(),
            feed_url: feed_url.to_string(),
            key: feed_key.to_string(),
            description: Some("hosts that answer takedowns".into()),
            contact: Some("abuse@curator.example".into()),
        })
        .collect();
    let doc =
        curator_directory::Directory::new("directory.example", serial, issued_at, expires_at, curators);
    serde_json::to_vec(&curator_directory::sign(key, "ed25519:test", &doc)).unwrap()
}

struct FeedRig {
    s: Server,
    token: String,
    home: String,
    gid: String,
    path: String,
}

async fn feed_rig(tweak: impl FnOnce(&mut Config)) -> FeedRig {
    let s = start_with(|cfg| {
        cfg.federation.enabled = false;
        cfg.federation.allow_http = true;
        tweak(cfg);
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    FeedRig {
        token: alice.token.clone(),
        home: alice.home.clone(),
        gid,
        path: format!("/_telium/v1/channels/{cid}/messages"),
        s,
    }
}

impl FeedRig {
    async fn gates(&self, body: Value) -> (u16, Value) {
        self.s.put(&format!("/_telium/v1/guilds/{}/gates", self.gid), &self.token, body).await
    }

    async fn attach(&self, origin: &str) -> u16 {
        let (status, _) = self
            .s
            .post(
                &self.path,
                Some(&self.token),
                json!({ "content": "hi", "attachments": [{
                    "origin": origin, "hash": "0".repeat(64),
                    "filename": "cat.png", "mime": "image/png", "size": 12,
                }] }),
            )
            .await;
        status
    }

    async fn refusal(&self, origin: &str) -> String {
        let (status, body) = self
            .s
            .post(
                &self.path,
                Some(&self.token),
                json!({ "content": "hi", "attachments": [{
                    "origin": origin, "hash": "0".repeat(64),
                    "filename": "cat.png", "mime": "image/png", "size": 12,
                }] }),
            )
            .await;
        assert_eq!(status, 403, "{origin} should have been refused: {body}");
        body["message"].as_str().unwrap_or_default().to_string()
    }

    async fn feed_status(&self) -> Value {
        let (_, gates) = self.s.get(&format!("/_telium/v1/guilds/{}/gates", self.gid), Some(&self.token)).await;
        gates["origins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o.get("feed").is_some())
            .map(|o| o["status"].clone())
            .unwrap_or(json!(null))
    }

    async fn refresh(&self, url: &str, key: &str) -> Option<String> {
        telium_server::federation::media_feeds::refresh(&self.s.state, url, key).await.unwrap()
    }

    async fn refresh_directory(&self, url: &str, key: &str) -> Option<String> {
        telium_server::federation::curators::refresh(&self.s.state, url, key, None).await.unwrap()
    }
}

#[tokio::test]
async fn a_subscribed_feed_decides_origins_the_guild_did_not_name() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (key, public) = curator(7);
    host.serve(media_feed_doc(
        &key,
        1,
        &[
            ("files.curated.example", Action::Allow),
            ("more.curated.example", Action::Allow),
            ("bad.curated.example", Action::Block),
        ],
    ));
    let feed_rule = json!({ "action": "allow", "feed": host.url, "key": public });

    r.gates(json!({ "origin_policy": "allowlist", "origins": [] })).await;
    assert_eq!(r.attach("files.curated.example").await, 403);

    let (status, saved) = r.gates(json!({ "origins": [feed_rule.clone()] })).await;
    assert_eq!(status, 200, "{saved}");
    let st = &saved["origins"][0]["status"];
    assert_eq!(st["state"], "active", "{saved}");
    assert_eq!(st["serial"], 1);
    assert_eq!(st["hosts"], 3);
    assert_eq!(st["blocks"], 1);
    assert_eq!(st["curator"], "curator.example");
    assert!(st["fetched_at"].is_i64() && st["error"].is_null(), "{st}");
    assert_eq!(saved["origins"][0]["key"], public);

    assert_eq!(r.attach("files.curated.example").await, 200);
    assert_eq!(r.attach("elsewhere.example").await, 403);
    assert_eq!(r.attach("bad.curated.example").await, 403);

    r.gates(json!({ "origin_policy": "open" })).await;
    assert_eq!(r.attach("elsewhere.example").await, 200);
    let why = r.refusal("bad.curated.example").await;
    assert!(why.contains("feed"), "the refusal says a feed made it: {why}");

    let (status, saved) = r
        .gates(json!({ "origin_policy": "allowlist", "origins": [
            { "action": "block", "domain": "files.curated.example" },
            { "action": "allow", "domain": "bad.curated.example" },
            feed_rule.clone(),
        ] }))
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(r.attach("files.curated.example").await, 403);
    assert_eq!(r.attach("bad.curated.example").await, 200);
    assert_eq!(r.attach("more.curated.example").await, 200);

    r.gates(json!({ "origins": [feed_rule.clone()] })).await;
    assert_eq!(r.attach("files.curated.example").await, 200);
    sqlx::query("INSERT INTO defederation (domain, scope, created_at) VALUES ('files.curated.example', 'media', 0)")
        .execute(&r.s.state.pool)
        .await
        .unwrap();
    let why = r.refusal("files.curated.example").await;
    assert!(why.contains("defederated"), "{why}");

    let (status, saved) = r
        .gates(json!({ "origin_policy": "open", "origins": [
            { "action": "block", "feed": host.url, "key": public },
        ] }))
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(r.attach("more.curated.example").await, 403);
    assert_eq!(r.attach("elsewhere.example").await, 200);
}

#[tokio::test]
async fn a_feed_update_that_fails_or_goes_backwards_keeps_the_last_good_copy() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (key, public) = curator(7);
    let good = media_feed_doc(&key, 2, &[("a.curated.example", Action::Allow)]);
    host.serve(good.clone());
    let (status, saved) = r
        .gates(json!({ "origin_policy": "allowlist", "origins": [
            { "action": "allow", "feed": host.url, "key": public },
        ] }))
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(r.attach("a.curated.example").await, 200);

    let mut tampered: Value =
        serde_json::from_slice(&media_feed_doc(&key, 3, &[("b.curated.example", Action::Allow)])).unwrap();
    tampered["entries"][0]["origin"] = json!("evil.example");
    host.serve(serde_json::to_vec(&tampered).unwrap());
    assert!(r.refresh(&host.url, &public).await.is_some(), "a tampered feed is refused");

    let (stranger, _) = curator(8);
    host.serve(media_feed_doc(&stranger, 3, &[("b.curated.example", Action::Allow)]));
    assert!(r.refresh(&host.url, &public).await.is_some(), "a feed under another key is refused");

    host.serve(media_feed_doc(&key, 1, &[("b.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &public).await;
    assert!(why.is_some(), "a rollback is refused");
    host.serve(media_feed_doc(&key, 2, &[("b.curated.example", Action::Allow)]));
    assert!(r.refresh(&host.url, &public).await.is_some(), "an equivocation is refused");

    host.serve(b"<html>not a feed</html>".to_vec());
    assert!(r.refresh(&host.url, &public).await.is_some());
    host.serve(vec![b' '; 300 * 1024]);
    let why = r.refresh(&host.url, &public).await.unwrap_or_default();
    assert!(why.contains("larger"), "{why}");

    assert_eq!(r.attach("a.curated.example").await, 200);
    assert_eq!(r.attach("b.curated.example").await, 403);
    assert_eq!(r.attach("evil.example").await, 403);
    let st = r.feed_status().await;
    assert_eq!(st["state"], "active", "{st}");
    assert_eq!(st["serial"], 2);
    assert!(st["error"].as_str().unwrap_or_default().contains("larger"), "{st}");

    host.serve(good);
    assert_eq!(r.refresh(&host.url, &public).await, None);
    assert!(r.feed_status().await["error"].is_null());

    host.serve(media_feed_doc(&key, 3, &[("b.curated.example", Action::Allow)]));
    assert_eq!(r.refresh(&host.url, &public).await, None);
    assert_eq!(r.attach("b.curated.example").await, 200);
    assert_eq!(r.attach("a.curated.example").await, 403);
    assert_eq!(r.feed_status().await["serial"], 3);
}

#[tokio::test]
async fn an_expired_feed_stops_vouching_but_keeps_blocking() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (key, public) = curator(7);
    host.serve(media_feed_doc(
        &key,
        1,
        &[("good.curated.example", Action::Allow), ("bad.curated.example", Action::Block)],
    ));
    r.gates(json!({ "origin_policy": "allowlist", "origins": [
        { "action": "allow", "feed": host.url, "key": public },
    ] }))
    .await;
    assert_eq!(r.attach("good.curated.example").await, 200);

    sqlx::query("UPDATE media_feeds SET expires_at = 1").execute(&r.s.state.pool).await.unwrap();
    assert_eq!(r.feed_status().await["state"], "expired");
    assert_eq!(r.attach("good.curated.example").await, 403);
    r.gates(json!({ "origin_policy": "open" })).await;
    assert_eq!(r.attach("good.curated.example").await, 200);
    assert_eq!(r.attach("bad.curated.example").await, 403);

    let now = now_millis();
    host.serve(media_feed_doc_at(&key, 5, now - 7_200_000, now - 3_600_000, &[]));
    assert!(r.refresh(&host.url, &public).await.is_some());
    assert_eq!(r.feed_status().await["serial"], 1);
    assert_eq!(r.attach("bad.curated.example").await, 403);
}

#[tokio::test]
async fn a_feed_rule_has_to_pin_its_curators_key() {
    let r = feed_rig(|_| {}).await;
    let (_, public) = curator(7);
    let kept = json!([{ "action": "allow", "domain": "kept.example" }]);
    let (status, _) = r.gates(json!({ "origin_policy": "allowlist", "origins": kept })).await;
    assert_eq!(status, 200);

    for bad in [
        json!({ "action": "allow", "feed": "https://registry.example/hosts.json" }),
        json!({ "action": "allow", "feed": "https://registry.example/hosts.json", "key": "not-a-key" }),
        json!({ "action": "allow", "feed": "ftp://registry.example/hosts.json", "key": public }),
        json!({ "action": "allow", "feed": "https://me:pw@registry.example/hosts.json", "key": public }),
    ] {
        let (status, body) = r.gates(json!({ "origins": [bad] })).await;
        assert_eq!(status, 400, "{body}");
    }
    let too_many: Vec<Value> = (0..9)
        .map(|i| json!({ "action": "allow", "feed": format!("https://r{i}.example/hosts.json"), "key": public }))
        .collect();
    let (status, body) = r.gates(json!({ "origins": too_many })).await;
    assert_eq!(status, 400, "{body}");

    let (_, gates) = r.s.get(&format!("/_telium/v1/guilds/{}/gates", r.gid), Some(&r.token)).await;
    assert_eq!(gates["origins"], kept);
}

#[tokio::test]
async fn this_servers_registry_is_a_feed_a_guild_can_subscribe_to() {
    let r = feed_rig(|cfg| {
        cfg.media_registry.hosts = vec![serde_json::from_value(json!({
            "origin": "files.registry.example",
            "name": "Registry Files",
        }))
        .unwrap()];
    })
    .await;
    let (status, registry) = r.s.get("/_telium/v1/media/registry", None).await;
    assert_eq!(status, 200, "{registry}");
    let url = registry["feed"]["url"].as_str().unwrap().to_string();
    let public = registry["feed"]["key"].as_str().unwrap().to_string();
    assert!(url.ends_with("/_telium/v1/media/registry/feed"), "{url}");

    let bytes = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
    let feed = media_feed::verify(&bytes, &public, now_millis(), 300_000).unwrap();
    assert_eq!(feed.curator, "test.example");
    assert_eq!(feed.entries.len(), 1);
    assert_eq!(feed.entries[0].origin, "files.registry.example");
    assert_eq!(feed.entries[0].action, Action::Allow);
    let (_, again) = r.s.get("/_telium/v1/media/registry", None).await;
    assert_eq!(again["feed"]["key"], public);

    let (status, saved) = r
        .gates(json!({ "origin_policy": "allowlist", "origins": [
            { "action": "allow", "feed": url, "key": public },
        ] }))
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["origins"][0]["status"]["state"], "active", "{saved}");
    assert_eq!(saved["origins"][0]["status"]["hosts"], 1);
    assert_eq!(r.attach("files.registry.example").await, 200);
    assert_eq!(r.attach("elsewhere.example").await, 403);
}

fn sealed_envelope(ct: &str) -> Value {
    json!({ "sealed": "v1", "kid": "AAECAwQFBgc", "iv": "AAECAwQFBgcICQoL", "ct": ct })
}

#[tokio::test]
async fn sealed_sync_values_are_kept_opaque_and_seal_the_store() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (status, _) = s.put("/_telium/v1/sync/prefs.v1", &alice.home, json!({ "theme": "light" })).await;
    assert_eq!(status, 200);
    for key in ["drafts.v2", "stickers.saved.v1", "identity.pins.v1"] {
        let (status, body) = s.put(&format!("/_telium/v1/sync/{key}"), &alice.home, json!({ "c1": "UNSENT" })).await;
        assert_eq!(status, 400, "{key}: {body}");
    }

    let envelope = sealed_envelope("c2VhbGVkLXByZWZz");
    let (status, _) = s.put("/_telium/v1/sync/prefs.v1", &alice.home, envelope.clone()).await;
    assert_eq!(status, 200);
    let (status, _) = s
        .put("/_telium/v1/sync/drafts.v2", &alice.home, sealed_envelope("c2VhbGVkLWRyYWZ0cw"))
        .await;
    assert_eq!(status, 200);

    let (_, all) = s.get("/_telium/v1/sync?sealed=1", Some(&alice.home)).await;
    assert_eq!(all["prefs.v1"]["value"], envelope);
    assert!(all["drafts.v2"]["value"]["ct"].is_string());
    let (_, old) = s.get("/_telium/v1/sync", Some(&alice.home)).await;
    assert!(old.get("prefs.v1").is_none(), "{old}");
    assert!(old.get("drafts.v2").is_none(), "{old}");
    let (status, _) = s.get("/_telium/v1/sync/prefs.v1", Some(&alice.home)).await;
    assert_eq!(status, 404);
    let (status, one) = s.get("/_telium/v1/sync/prefs.v1?sealed=1", Some(&alice.home)).await;
    assert_eq!(status, 200);
    assert_eq!(one["value"], envelope);

    let (status, _) = s.put("/_telium/v1/sync/emoji.tone.v1", &alice.home, json!("3")).await;
    assert_eq!(status, 409);
    let (status, _) = s
        .put("/_telium/v1/sync/prefs.v1", &alice.home, json!({ "sealed": "v1", "ct": 5, "theme": "light" }))
        .await;
    assert_eq!(status, 409);
    let (status, _) = s
        .put("/_telium/v1/sync/prefs.v1", &alice.home, json!({ "sealed": "v1", "ct": "has spaces" }))
        .await;
    assert_eq!(status, 409);
    let (_, all) = s.get("/_telium/v1/sync?sealed=1", Some(&alice.home)).await;
    assert_eq!(all["prefs.v1"]["value"], envelope);

    let (status, _) = s.delete("/_telium/v1/sync/drafts.v1", &alice.home).await;
    assert_eq!(status, 200);

    let (status, _) = s.put("/_telium/v1/sync/emoji.tone.v1", &bob.home, json!("2")).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_signed_rollover_carries_subscribers_to_the_curators_next_key() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (old, old_pub) = curator(7);
    let (new, new_pub) = curator(8);

    host.serve(media_feed_doc(&old, 1, &[("a.curated.example", Action::Allow)]));
    let (status, saved) = r
        .gates(json!({ "origin_policy": "allowlist", "origins": [
            { "action": "allow", "feed": host.url, "key": old_pub },
        ] }))
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(r.attach("a.curated.example").await, 200);

    host.serve(media_feed_doc_announcing(&old, 2, &new_pub, 1, &[("a.curated.example", Action::Allow)]));
    assert_eq!(r.refresh(&host.url, &old_pub).await, None);
    let st = r.feed_status().await;
    assert_eq!(st["active_key"], old_pub, "{st}");
    assert_eq!(st["pending_key"], new_pub, "{st}");
    assert_eq!(st["rotation"], 0, "{st}");

    host.serve(media_feed_doc(&new, 3, &[("b.curated.example", Action::Allow)]));
    assert_eq!(r.refresh(&host.url, &old_pub).await, None);
    let st = r.feed_status().await;
    assert_eq!(st["active_key"], new_pub, "{st}");
    assert!(st["pending_key"].is_null(), "{st}");
    assert_eq!(st["rotation"], 1, "{st}");
    assert_eq!(st["serial"], 3, "{st}");
    assert_eq!(r.attach("b.curated.example").await, 200);
    assert_eq!(r.attach("a.curated.example").await, 403);

    let (_, gates) = r.s.get(&format!("/_telium/v1/guilds/{}/gates", r.gid), Some(&r.token)).await;
    assert_eq!(gates["origins"][0]["key"], old_pub, "{gates}");

    host.serve(media_feed_doc(&old, 4, &[("evil.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("re-pin"), "the retired key is a stranger now: {why}");
    assert_eq!(r.attach("evil.curated.example").await, 403);
}

#[tokio::test]
async fn a_rotation_that_forks_replays_or_rolls_back_is_refused() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (old, old_pub) = curator(7);
    let (new, new_pub) = curator(8);
    let (third, third_pub) = curator(9);

    host.serve(media_feed_doc(&old, 1, &[("a.curated.example", Action::Allow)]));
    r.gates(json!({ "origin_policy": "allowlist", "origins": [
        { "action": "allow", "feed": host.url, "key": old_pub },
    ] }))
    .await;
    assert_eq!(r.attach("a.curated.example").await, 200);

    host.serve(media_feed_doc(&new, 2, &[("b.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("re-pin"), "an unannounced key is refused: {why}");

    host.serve(media_feed_doc_announcing(&third, 2, &new_pub, 1, &[("b.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("re-pin"), "a rollover the pinned key did not sign is refused: {why}");
    let st = r.feed_status().await;
    assert_eq!(st["active_key"], old_pub, "{st}");
    assert!(st["pending_key"].is_null(), "{st}");

    host.serve(media_feed_doc_announcing(&old, 2, &old_pub, 1, &[("a.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("already in force"), "{why}");

    host.serve(media_feed_doc_announcing(&old, 2, &new_pub, 1, &[("a.curated.example", Action::Allow)]));
    assert_eq!(r.refresh(&host.url, &old_pub).await, None);
    assert_eq!(r.feed_status().await["pending_key"], new_pub);

    host.serve(media_feed_doc_announcing(&old, 3, &third_pub, 1, &[("a.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("different successor"), "{why}");
    assert_eq!(r.feed_status().await["pending_key"], new_pub, "the fork changed nothing");

    host.serve(media_feed_doc(&new, 3, &[("b.curated.example", Action::Allow)]));
    assert_eq!(r.refresh(&host.url, &old_pub).await, None);
    assert_eq!(r.feed_status().await["rotation"], 1);

    host.serve(media_feed_doc_announcing(&new, 4, &third_pub, 1, &[("b.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("replayed rollover") || why.contains("different successor"), "{why}");

    host.serve(media_feed_doc_announcing(&new, 4, &old_pub, 2, &[("b.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("already retired"), "{why}");

    let st = r.feed_status().await;
    assert_eq!(st["active_key"], new_pub, "{st}");
    assert_eq!(st["rotation"], 1, "{st}");
    assert_eq!(st["serial"], 3, "{st}");
    assert_eq!(r.attach("b.curated.example").await, 200);
}

#[tokio::test]
async fn a_subscriber_that_missed_the_rotation_fails_closed() {
    let r = feed_rig(|_| {}).await;
    let host = FeedHost::start().await;
    let (old, old_pub) = curator(7);
    let (new, _new_pub) = curator(8);

    host.serve(media_feed_doc(
        &old,
        1,
        &[("a.curated.example", Action::Allow), ("bad.curated.example", Action::Block)],
    ));
    r.gates(json!({ "origin_policy": "allowlist", "origins": [
        { "action": "allow", "feed": host.url, "key": old_pub },
    ] }))
    .await;
    assert_eq!(r.attach("a.curated.example").await, 200);

    host.serve(media_feed_doc(&new, 9, &[("a.curated.example", Action::Allow)]));
    let why = r.refresh(&host.url, &old_pub).await.unwrap_or_default();
    assert!(why.contains("rotated its key"), "the error tells the moderator what happened: {why}");

    let st = r.feed_status().await;
    assert_eq!(st["serial"], 1, "{st}");
    assert_eq!(r.attach("a.curated.example").await, 200);
    sqlx::query("UPDATE media_feeds SET expires_at = 1").execute(&r.s.state.pool).await.unwrap();
    assert_eq!(r.attach("a.curated.example").await, 403);
    r.gates(json!({ "origin_policy": "open" })).await;
    assert_eq!(r.attach("bad.curated.example").await, 403);

    let (_, saved) = r
        .gates(json!({ "origin_policy": "allowlist", "origins": [
            { "action": "allow", "feed": host.url, "key": _new_pub },
        ] }))
        .await;
    assert_eq!(saved["origins"][0]["status"]["state"], "active", "{saved}");
    assert_eq!(r.attach("a.curated.example").await, 200);
}

#[tokio::test]
async fn rotating_this_servers_curator_key_announces_before_it_switches() {
    let r = feed_rig(|cfg| {
        cfg.media_registry.hosts = vec![serde_json::from_value(json!({
            "origin": "files.registry.example",
            "name": "Registry Files",
        }))
        .unwrap()];
    })
    .await;
    let member = r.s.user("bob").await;

    let (_, registry) = r.s.get("/_telium/v1/media/registry", None).await;
    let before = registry["feed"]["key"].as_str().unwrap().to_string();

    let (status, _) =
        r.s.post("/_telium/v1/admin/media/curator-key/rotate", Some(&member.home), json!({})).await;
    assert_eq!(status, 403);

    let (status, elevated) = r
        .s
        .post(
            "/_telium/v1/admin/step-up",
            Some(&r.home),
            json!({ "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "step-up: {elevated}");

    let (status, started) = r
        .s
        .post("/_telium/v1/admin/media/curator-key/rotate", Some(&r.home), json!({ "overlap_secs": 60 }))
        .await;
    assert_eq!(status, 200, "{started}");
    assert_eq!(started["key"], before);
    assert_eq!(started["rotation"], 1);
    let next = started["next_key"].as_str().unwrap().to_string();
    assert_ne!(next, before);
    let overlap = started["rotate_after"].as_i64().unwrap() - now_millis();
    assert!(overlap > 23 * 3_600_000, "overlap was floored: {overlap}");

    let (_, still) = r.s.get("/_telium/v1/media/registry", None).await;
    assert_eq!(still["feed"]["key"], before);
    assert_eq!(still["feed"]["next_key"], next);
    let (_, doc) = r.s.get("/_telium/v1/media/registry/feed", None).await;
    let parsed = media_feed::verify(
        &serde_json::to_vec(&doc).unwrap(),
        &before,
        now_millis(),
        300_000,
    )
    .unwrap();
    assert_eq!(parsed.rollover.as_ref().unwrap().to_key, next);
    assert_eq!(parsed.rollover.as_ref().unwrap().rotation, 1);

    let (status, body) =
        r.s.post("/_telium/v1/admin/media/curator-key/rotate", Some(&r.home), json!({})).await;
    assert_eq!(status, 409, "{body}");

    sqlx::query("UPDATE media_curator_key SET rotate_after = 1").execute(&r.s.state.pool).await.unwrap();
    let (_, after) = r.s.get("/_telium/v1/media/registry", None).await;
    assert_eq!(after["feed"]["key"], next);
    assert_eq!(after["feed"]["rotation"], 1);
    assert!(after["feed"]["next_key"].is_null(), "{after}");
    let (_, doc) = r.s.get("/_telium/v1/media/registry/feed", None).await;
    assert!(media_feed::verify(&serde_json::to_vec(&doc).unwrap(), &next, now_millis(), 300_000).is_ok());
}

#[tokio::test]
async fn a_curator_directory_suggests_curators_and_decides_nothing() {
    let host = FeedHost::start().await;
    let (publisher, publisher_pub) = curator(21);
    let (_, curated_pub) = curator(22);
    host.serve_directory(directory_doc(
        &publisher,
        1,
        &[("Example Curators", "https://curator.example/feed.json", &curated_pub)],
    ));
    let directory_url = host.directory_url.clone();
    let publisher_key = publisher_pub.clone();
    let (_, own_pub) = curator(23);
    let own_key = own_pub.clone();
    let r = feed_rig(move |cfg| {
        cfg.media_registry.curators = vec![serde_json::from_value(json!({
            "name": "House Curators",
            "feed_url": "https://house.example/feed.json",
            "key": own_key,
            "description": "the operator's own picks",
        }))
        .unwrap()];
        cfg.media_registry.curator_directories = vec![serde_json::from_value(json!({
            "url": directory_url,
            "key": publisher_key,
            "label": "friend.example",
        }))
        .unwrap()];
    })
    .await;

    let (status, listed) =
        r.s.get(&format!("/_telium/v1/guilds/{}/gates/curators", r.gid), Some(&r.token)).await;
    assert_eq!(status, 200, "{listed}");
    let entries = listed["curators"].as_array().unwrap();
    assert_eq!(entries.len(), 2, "{listed}");
    let own = entries.iter().find(|c| c["name"] == "House Curators").unwrap();
    assert_eq!(own["local"], true);
    assert_eq!(own["key"], own_pub);
    let theirs = entries.iter().find(|c| c["name"] == "Example Curators").unwrap();
    assert_eq!(theirs["source"], "friend.example");
    assert_eq!(theirs["key"], curated_pub);
    assert_eq!(theirs["local"], false);

    r.gates(json!({ "origin_policy": "allowlist", "origins": [] })).await;
    assert_eq!(r.attach("curator.example").await, 403);
    let (_, gates) = r.s.get(&format!("/_telium/v1/guilds/{}/gates", r.gid), Some(&r.token)).await;
    assert_eq!(gates["origins"].as_array().unwrap().len(), 0, "{gates}");

    let bob = r.s.user("bob").await;
    let (status, _) =
        r.s.get(&format!("/_telium/v1/guilds/{}/gates/curators", r.gid), Some(&bob.token)).await;
    assert!(status == 403 || status == 401, "a non-moderator got the list");

    let (status, registry) = r.s.get("/_telium/v1/media/registry", None).await;
    assert_eq!(status, 200, "{registry}");
    let url = registry["directory"]["url"].as_str().unwrap().to_string();
    assert!(url.ends_with("/_telium/v1/media/curators"), "{url}");
    let key = registry["directory"]["key"].as_str().unwrap().to_string();
    let bytes = reqwest::get(&url).await.unwrap().bytes().await.unwrap();
    let published = curator_directory::verify(&bytes, &key, now_millis(), 300_000).unwrap();
    assert_eq!(published.publisher, "test.example");
    assert_eq!(published.curators.len(), 1);
    assert_eq!(published.curators[0].name, "House Curators");
}

#[tokio::test]
async fn a_directory_that_fails_or_lapses_keeps_the_last_good_copy() {
    let host = FeedHost::start().await;
    let (publisher, publisher_pub) = curator(21);
    let (stranger, _) = curator(24);
    let (_, one) = curator(25);
    let (_, two) = curator(26);
    host.serve_directory(directory_doc(&publisher, 2, &[("One", "https://one.example/feed.json", &one)]));
    let directory_url = host.directory_url.clone();
    let publisher_key = publisher_pub.clone();
    let r = feed_rig(move |cfg| {
        cfg.media_registry.curator_directories = vec![serde_json::from_value(json!({
            "url": directory_url, "key": publisher_key, "label": "friend.example",
        }))
        .unwrap()];
    })
    .await;
    let path = format!("/_telium/v1/guilds/{}/gates/curators", r.gid);
    let names = |listed: &Value| {
        listed["curators"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["name"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>()
    };
    let (_, listed) = r.s.get(&path, Some(&r.token)).await;
    assert_eq!(names(&listed), vec!["One"], "{listed}");

    let two_entry = [("Two", "https://two.example/feed.json", two.as_str())];
    host.serve_directory(directory_doc(&stranger, 3, &two_entry));
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());
    let mut tampered: Value =
        serde_json::from_slice(&directory_doc(&publisher, 3, &two_entry)).unwrap();
    tampered["curators"][0]["key"] = json!(one);
    host.serve_directory(serde_json::to_vec(&tampered).unwrap());
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());
    host.serve_directory(directory_doc(&publisher, 1, &two_entry));
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());
    host.serve_directory(directory_doc(&publisher, 2, &two_entry));
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());
    host.serve_directory(directory_doc(
        &publisher,
        3,
        &[("Two", "https://one.example@evil.example/feed.json", &two)],
    ));
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());
    host.serve_directory(b"<html>nope</html>".to_vec());
    assert!(r.refresh_directory(&host.directory_url, &publisher_pub).await.is_some());

    let (_, listed) = r.s.get(&path, Some(&r.token)).await;
    assert_eq!(names(&listed), vec!["One"], "the last good copy stood throughout: {listed}");

    host.serve_directory(directory_doc(&publisher, 3, &two_entry));
    assert_eq!(r.refresh_directory(&host.directory_url, &publisher_pub).await, None);
    let (_, listed) = r.s.get(&path, Some(&r.token)).await;
    assert_eq!(names(&listed), vec!["Two"], "{listed}");

    sqlx::query("UPDATE curator_directories SET expires_at = 1").execute(&r.s.state.pool).await.unwrap();
    let (_, listed) = r.s.get(&path, Some(&r.token)).await;
    assert!(names(&listed).is_empty(), "{listed}");
}

#[tokio::test]
async fn a_directory_full_of_tricks_is_refused_before_it_is_stored() {
    let (publisher, publisher_pub) = curator(21);
    let (_, key) = curator(27);
    let now = now_millis();
    let bad = [
        "\u{202e}gnp.ekaf",              // a bidi override, to reverse what is read
        "line one\nline two",            // control characters
        "",                              // nothing at all
    ];
    for name in bad {
        let doc = directory_doc(&publisher, 1, &[(name, "https://one.example/feed.json", &key)]);
        assert!(
            curator_directory::verify(&doc, &publisher_pub, now, 300_000).is_err(),
            "a curator named {name:?} was accepted"
        );
    }
    let doc = directory_doc(
        &publisher,
        1,
        &[("One", "https://one.example/feed.json", &key), ("Uno", "https://one.example/feed.json", &key)],
    );
    assert!(curator_directory::verify(&doc, &publisher_pub, now, 300_000).is_err());
    let doc = directory_doc_at(
        &publisher,
        1,
        now - 7_200_000,
        now - 3_600_000,
        &[("One", "https://one.example/feed.json", &key)],
    );
    assert!(curator_directory::verify(&doc, &publisher_pub, now, 300_000).is_err());
    let doc = directory_doc(&publisher, 1, &[("One", "https://one.example/feed.json", &key)]);
    assert!(curator_directory::verify(&doc, &publisher_pub, now, 300_000).is_ok());
}

#[tokio::test]
async fn the_upload_picker_offers_hosts_the_guilds_feeds_vouch_for() {
    let r = feed_rig(|cfg| {
        cfg.media_registry.hosts = vec![serde_json::from_value(json!({
            "origin": "files.registry.example", "name": "Registry Files",
        }))
        .unwrap()];
    })
    .await;
    let host = FeedHost::start().await;
    let (key, public) = curator(7);
    let entries = [
        ("vouched.curated.example", Action::Allow),
        ("also.curated.example", Action::Allow),
        ("bad.curated.example", Action::Block),
        ("files.registry.example", Action::Allow),
    ];
    host.serve(media_feed_doc(&key, 1, &entries));

    let (status, empty) = r.s.get("/_telium/v1/media/registry/feeds", Some(&r.home)).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["hosts"].as_array().unwrap().len(), 0, "{empty}");

    r.gates(json!({ "origin_policy": "allowlist", "origins": [
        { "action": "allow", "feed": host.url, "key": public },
    ] }))
    .await;
    let (_, offered) = r.s.get("/_telium/v1/media/registry/feeds", Some(&r.home)).await;
    let origins: Vec<&str> =
        offered["hosts"].as_array().unwrap().iter().map(|h| h["origin"].as_str().unwrap()).collect();
    assert_eq!(origins, vec!["also.curated.example", "vouched.curated.example"], "{offered}");
    let first = &offered["hosts"][0];
    assert_eq!(first["vouched_by"][0]["curator"], "curator.example", "{first}");
    assert_eq!(first["vouched_by"][0]["feed"], host.url, "{first}");

    let bob = r.s.user("bob").await;
    let (_, none) = r.s.get("/_telium/v1/media/registry/feeds", Some(&bob.home)).await;
    assert_eq!(none["hosts"].as_array().unwrap().len(), 0, "{none}");

    sqlx::query(
        "INSERT INTO defederation (domain, scope, created_at) VALUES ('vouched.curated.example', 'media', 0)",
    )
    .execute(&r.s.state.pool)
    .await
    .unwrap();
    let (_, offered) = r.s.get("/_telium/v1/media/registry/feeds", Some(&r.home)).await;
    let origins: Vec<&str> =
        offered["hosts"].as_array().unwrap().iter().map(|h| h["origin"].as_str().unwrap()).collect();
    assert_eq!(origins, vec!["also.curated.example"], "{offered}");

    sqlx::query("UPDATE media_feeds SET expires_at = 1").execute(&r.s.state.pool).await.unwrap();
    let (_, offered) = r.s.get("/_telium/v1/media/registry/feeds", Some(&r.home)).await;
    assert_eq!(offered["hosts"].as_array().unwrap().len(), 0, "{offered}");
}

fn listed_provider(id: &str, host: &str) -> Provider {
    Provider {
        id: id.into(),
        name: format!("{id} Hosting"),
        base_url: format!("https://{host}"),
        signup_url: format!("https://{host}/signup"),
        terms_url: format!("https://{host}/terms"),
        privacy_url: None,
        contact: Some("support@example.invalid".into()),
        description: Some("Managed Telium guilds.".into()),
        regions: vec!["eu-west".into()],
        plans: vec![Plan {
            id: "small".into(),
            name: "Small".into(),
            price_minor: 500,
            currency: "EUR".into(),
            period: Period::Monthly,
            member_cap: Some(500),
            storage_bytes: Some(20 * 1024 * 1024 * 1024),
            media_quota_bytes: Some(5 * 1024 * 1024 * 1024),
            notes: None,
        }],
        public_key: URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[41u8; 32]).verifying_key().as_bytes()),
    }
}

fn catalog_doc(key: &SigningKey, serial: u64, providers: Vec<Provider>) -> Vec<u8> {
    let now = now_millis();
    catalog_doc_at(key, serial, now - 1_000, now + 86_400_000, providers)
}

fn catalog_doc_at(
    key: &SigningKey,
    serial: u64,
    issued_at: i64,
    expires_at: i64,
    providers: Vec<Provider>,
) -> Vec<u8> {
    let body = Catalog::new("catalog.example", serial, issued_at, expires_at, providers);
    serde_json::to_vec(&hosting_catalog::sign(key, "ed25519:test", &body)).unwrap()
}

async fn hosting_rig(url: &str, key: &str) -> Server {
    let url = url.to_string();
    let key = key.to_string();
    start_with(move |cfg| {
        cfg.federation.allow_http = true;
        cfg.hosting = Hosting {
            catalogs: vec![HostingCatalog { url, key, label: Some("Test catalog".into()) }],
            ..Hosting::default()
        };
    })
    .await
}

#[tokio::test]
async fn a_subscribed_catalog_lists_its_providers_with_their_prices_and_limits() {
    let host = FeedHost::start().await;
    let (key, public) = curator(41);
    host.serve(catalog_doc(&key, 1, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;

    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 0);

    assert_eq!(telium_server::hosting::refresh_due(&s.state).await.unwrap(), 1);
    let body = listed(&s).await;
    let providers = body["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1, "{body}");
    assert_eq!(providers[0]["name"], "aurora Hosting");
    assert_eq!(providers[0]["signup_url"], "https://guilds.aurora.example/signup");
    assert_eq!(providers[0]["source"]["kind"], "catalog");
    assert_eq!(providers[0]["source"]["label"], "Test catalog");
    let plan = &providers[0]["plans"][0];
    assert_eq!(plan["price_minor"], 500);
    assert_eq!(plan["currency"], "EUR");
    assert_eq!(plan["period"], "monthly");
    assert_eq!(plan["member_cap"], 500);
    assert_eq!(plan["storage_bytes"], 20 * 1024 * 1024 * 1024i64);

    assert_eq!(body["self_hosted"]["server_name"], "test.example");
    assert_eq!(body["self_hosted"]["available"], true);
    assert_eq!(body["portability"]["guided_handoff"], true);

    assert!(telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap().is_none());
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 1);

    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (status, _) = s.get("/_telium/v1/admin/hosting-catalogs", Some(&bob.home)).await;
    assert_eq!(status, 403, "an ordinary account read the operator's subscription status");
    let (status, admin) = s.get("/_telium/v1/admin/hosting-catalogs", Some(&alice.home)).await;
    assert_eq!(status, 200, "{admin}");
    assert_eq!(admin["catalogs"][0]["state"], "active");
    assert_eq!(admin["catalogs"][0]["providers"], 1);
    assert_eq!(admin["catalogs"][0]["publisher"], "catalog.example");
}

#[tokio::test]
async fn a_catalog_that_does_not_verify_leaves_the_held_copy_alone() {
    let host = FeedHost::start().await;
    let (key, public) = curator(42);
    host.serve(catalog_doc(&key, 5, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;
    telium_server::hosting::refresh_due(&s.state).await.unwrap();

    let stranger = SigningKey::from_bytes(&[43u8; 32]);
    host.serve(catalog_doc(&stranger, 6, vec![listed_provider("evil", "guilds.evil.example")]));
    let refused = telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap().unwrap();
    assert!(refused.message.contains("signature"), "a stranger's catalog was adopted");
    assert_eq!(refused.kind, telium_server::hosting::Failure::KeyMismatch);

    host.serve(catalog_doc(&key, 4, vec![listed_provider("evil", "guilds.evil.example")]));
    let refused = telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap();
    assert!(refused.unwrap().message.contains("rollback"), "a replayed catalog was adopted");

    host.serve(catalog_doc(&key, 5, vec![listed_provider("evil", "guilds.evil.example")]));
    let refused = telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap();
    assert!(refused.unwrap().message.contains("already seen"), "an equivocating catalog was adopted");

    let mut bad = listed_provider("aurora", "guilds.aurora.example");
    bad.signup_url = "http://guilds.aurora.example/signup".into();
    host.serve(catalog_doc(&key, 7, vec![bad]));
    let refused = telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap();
    assert!(refused.unwrap().message.contains("signup_url"), "a plaintext signup link was adopted");

    let body = listed(&s).await;
    assert_eq!(body["providers"].as_array().unwrap().len(), 1);
    assert_eq!(body["providers"][0]["id"], "aurora", "the held copy changed: {body}");
}

#[tokio::test]
async fn an_expired_catalog_stops_listing_anything() {
    let host = FeedHost::start().await;
    let (key, public) = curator(44);
    host.serve(catalog_doc(&key, 1, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;
    telium_server::hosting::refresh_due(&s.state).await.unwrap();
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 1);

    sqlx::query("UPDATE hosting_catalogs SET expires_at = 1").execute(&s.state.pool).await.unwrap();
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 0);

    let now = now_millis();
    host.serve(catalog_doc_at(
        &key,
        2,
        now - 7_200_000,
        now - 3_600_000,
        vec![listed_provider("late", "guilds.late.example")],
    ));
    let refused = telium_server::hosting::refresh(&s.state, &host.url, &public, None).await.unwrap();
    assert!(refused.unwrap().message.contains("expired"));
}

#[tokio::test]
async fn an_operators_refresh_is_theirs_alone_and_does_not_re_ask_within_the_minute() {
    let host = FeedHost::start().await;
    let (key, public) = curator(47);
    host.serve(catalog_doc(&key, 1, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let refresh = "/_telium/v1/admin/hosting-catalogs/refresh";

    let (status, body) = s.post(refresh, Some(&bob.home), json!({})).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 0);

    let (status, body) = s.post(refresh, Some(&alice.home), json!({})).await;
    assert_eq!(status, 200, "{body}");
    assert!(body["results"][0]["skipped"].is_null(), "{body}");
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 1);

    host.serve(catalog_doc(&key, 2, vec![
        listed_provider("aurora", "guilds.aurora.example"),
        listed_provider("borealis", "guilds.borealis.example"),
    ]));
    let (_, body) = s.post(refresh, Some(&alice.home), json!({})).await;
    assert_eq!(body["ok"], true, "{body}");
    assert!(body["results"][0]["skipped"].as_str().unwrap_or_default().contains("ago"), "{body}");
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 1, "the floor was not held");

    sqlx::query("UPDATE hosting_catalogs SET attempted_at = attempted_at - 120000")
        .execute(&s.state.pool)
        .await
        .unwrap();
    s.post(refresh, Some(&alice.home), json!({})).await;
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 2);

    let refreshes: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM server_audit_log WHERE action = 'hosting.catalogs.refresh'",
    )
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(refreshes, 3);
    let (_, admin) = s.get("/_telium/v1/admin/hosting-catalogs", Some(&alice.home)).await;
    assert_eq!(admin["catalogs"][0]["key"], public, "{admin}");
}

async fn only_subscription(s: &Server) -> Value {
    telium_server::hosting::statuses(&s.state).await.unwrap().remove(0)
}

#[tokio::test]
async fn subscription_failures_are_classified_and_remembered() {
    let host = FeedHost::start().await;
    let (key, public) = curator(51);
    host.serve(catalog_doc(&key, 5, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;
    telium_server::hosting::refresh_due(&s.state).await.unwrap();
    assert!(only_subscription(&s).await["failure"].is_null());
    let refresh = || telium_server::hosting::refresh(&s.state, &host.url, &public, None);

    let rotated = SigningKey::from_bytes(&[52u8; 32]);
    host.serve(catalog_doc(&rotated, 6, vec![listed_provider("aurora", "guilds.aurora.example")]));
    refresh().await.unwrap();
    let row = only_subscription(&s).await;
    assert_eq!(row["failure"]["kind"], "key_mismatch", "{row}");
    assert_eq!(row["failure"]["consecutive"], 1, "{row}");
    assert!(row["failure"]["message"].as_str().unwrap().contains("re-pin"), "{row}");
    assert_eq!(row["state"], "active", "{row}");
    assert!(!row["error"].is_null(), "{row}");
    sqlx::query("UPDATE hosting_catalogs SET expires_at = 1").execute(&s.state.pool).await.unwrap();
    refresh().await.unwrap();
    let row = only_subscription(&s).await;
    assert_eq!(row["state"], "key_mismatch", "{row}");
    assert_eq!(row["failure"]["consecutive"], 2, "{row}");

    let mut impostor: Value =
        serde_json::from_slice(&catalog_doc(&rotated, 7, vec![listed_provider("a", "a.example")])).unwrap();
    impostor["kind"] = json!("telium.media_feed");
    host.serve(serde_json::to_vec(&impostor).unwrap());
    refresh().await.unwrap();
    assert_eq!(only_subscription(&s).await["failure"]["kind"], "rejected");
    host.serve(catalog_doc(&key, 5, vec![listed_provider("evil", "guilds.evil.example")]));
    refresh().await.unwrap();
    assert_eq!(only_subscription(&s).await["failure"]["kind"], "rejected");

    host.serve(catalog_doc(&key, 8, vec![listed_provider("aurora", "guilds.aurora.example")]));
    assert!(refresh().await.unwrap().is_none());
    let row = only_subscription(&s).await;
    assert_eq!(row["state"], "active", "{row}");
    assert!(row["error"].is_null(), "{row}");
    assert_eq!(row["failure"]["kind"], "rejected", "{row}");
    assert_eq!(row["failure"]["consecutive"], 0, "{row}");

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = format!("http://{}/catalog.json", listener.local_addr().unwrap());
    drop(listener);
    let s = hosting_rig(&dead, &public).await;
    telium_server::hosting::refresh_due(&s.state).await.unwrap();
    let row = only_subscription(&s).await;
    assert_eq!((row["state"].as_str(), row["failure"]["kind"].as_str()), (Some("failed"), Some("unreachable")));
    let s = hosting_rig("https://catalog.example/list.json", "not-a-key").await;
    let row = only_subscription(&s).await;
    assert_eq!(row["state"], "invalid", "{row}");
    assert_eq!(row["failure"]["kind"], "misconfigured", "{row}");
    assert!(row["failure"]["at"].is_null(), "{row}");
}

#[tokio::test]
async fn an_operators_own_providers_are_listed_and_published_for_others_to_subscribe_to() {
    let s = start_with(|cfg| {
        cfg.hosting = Hosting {
            providers: vec![
                HostingProvider {
                    id: "house".into(),
                    name: "House Hosting".into(),
                    base_url: "https://guilds.house.example".into(),
                    signup_url: "https://house.example/signup".into(),
                    terms_url: "https://house.example/terms".into(),
                    regions: vec!["us-east".into()],
                    plans: vec![HostingPlan {
                        id: "free".into(),
                        name: "Free".into(),
                        price_minor: 0,
                        currency: "USD".into(),
                        period: "free".into(),
                        member_cap: Some(100),
                        ..HostingPlan::default()
                    }],
                    public_key: URL_SAFE_NO_PAD
                        .encode(SigningKey::from_bytes(&[45u8; 32]).verifying_key().as_bytes()),
                    ..HostingProvider::default()
                },
                HostingProvider { id: "broken".into(), name: "Broken".into(), ..HostingProvider::default() },
            ],
            ..Hosting::default()
        };
    })
    .await;

    let body = listed(&s).await;
    let providers = body["providers"].as_array().unwrap();
    assert_eq!(providers.len(), 1, "{body}");
    assert_eq!(providers[0]["id"], "house");
    assert_eq!(providers[0]["source"]["kind"], "operator");
    assert_eq!(providers[0]["plans"][0]["period"], "free");

    let (status, publication) = s.get("/_telium/v1/hosting/publication", None).await;
    assert_eq!(status, 200, "{publication}");
    let public = publication["key"].as_str().unwrap().to_string();
    let (status, doc) = s.get("/_telium/v1/hosting/catalog", None).await;
    assert_eq!(status, 200, "{doc}");
    let bytes = serde_json::to_vec(&doc).unwrap();
    let parsed = hosting_catalog::verify(&bytes, &public, now_millis(), 300_000).unwrap();
    assert_eq!(parsed.publisher, "test.example");
    assert_eq!(parsed.providers.len(), 1);
    assert_eq!(parsed.providers[0].id, "house");

    let (_, again) = s.get("/_telium/v1/hosting/publication", None).await;
    assert_eq!(again["key"], publication["key"]);
}

#[tokio::test]
async fn a_marketplace_that_is_switched_off_fetches_nothing_and_offers_nothing() {
    let host = FeedHost::start().await;
    let (key, public) = curator(46);
    host.serve(catalog_doc(&key, 1, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let url = host.url.clone();
    let pinned = public.clone();
    let s = start_with(move |cfg| {
        cfg.federation.allow_http = true;
        cfg.hosting = Hosting {
            enabled: false,
            catalogs: vec![HostingCatalog { url, key: pinned, label: None }],
            ..Hosting::default()
        };
    })
    .await;

    assert_eq!(telium_server::hosting::refresh_due(&s.state).await.unwrap(), 0);
    let held: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosting_catalogs")
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(held, 0, "a switched-off marketplace fetched a catalog anyway");

    let body = listed(&s).await;
    assert_eq!(body["enabled"], false);
    assert_eq!(body["providers"].as_array().unwrap().len(), 0);

    let alice = s.user("alice").await;
    let (status, admin) = s.get("/_telium/v1/admin/hosting-catalogs", Some(&alice.home)).await;
    assert_eq!(status, 200, "{admin}");
    assert_eq!(admin["catalogs"][0]["state"], "disabled");
}

#[tokio::test]
async fn a_catalog_the_operator_no_longer_subscribes_to_is_forgotten() {
    let host = FeedHost::start().await;
    let (key, public) = curator(47);
    host.serve(catalog_doc(&key, 1, vec![listed_provider("aurora", "guilds.aurora.example")]));
    let s = hosting_rig(&host.url, &public).await;

    let stale = "https://old.example/catalog.json";
    sqlx::query("INSERT INTO hosting_catalogs (url, public_b64, added_at, providers) VALUES (?, ?, ?, 1)")
        .bind(stale)
        .bind(&public)
        .bind(now_millis())
        .execute(&s.state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO hosting_providers (url, public_b64, provider_id, position, name, base_url, signup_url, \
         terms_url, regions, plans, public_key) VALUES (?, ?, 'ghost', 0, 'Ghost', 'https://ghost.example', \
         'https://ghost.example/signup', 'https://ghost.example/terms', '[]', '[]', ?)",
    )
    .bind(stale)
    .bind(&public)
    .bind(&public)
    .execute(&s.state.pool)
    .await
    .unwrap();

    telium_server::hosting::refresh_due(&s.state).await.unwrap();

    let held: Vec<String> = sqlx::query_scalar("SELECT url FROM hosting_catalogs")
        .fetch_all(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(held, vec![host.url.clone()], "a catalog nobody subscribes to is still cached");
    let ghosts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosting_providers WHERE provider_id = 'ghost'")
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(ghosts, 0, "the forgotten catalog's providers outlived it");
    assert_eq!(listed(&s).await["providers"].as_array().unwrap().len(), 1);
}
