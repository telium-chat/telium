use super::*;

fn base64_url(s: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s.as_bytes())
}

#[tokio::test]
async fn reactions_and_pins_are_plain_local_facts() {
    let (s, alice, bob, _gid, cid) = social_fixture().await;
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "ship it" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let (status, _) = s.put(&format!("/_telium/v1/messages/{mid}/reactions/%F0%9F%9A%80/@me"), &bob.token, json!({})).await;
    assert_eq!(status, 200);
    s.put(&format!("/_telium/v1/messages/{mid}/reactions/%F0%9F%9A%80/@me"), &bob.token, json!({})).await;
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&bob.token)).await;
    assert_eq!(listed["reactions"][0]["count"], 1);
    assert_eq!(listed["reactions"][0]["me"], true);
    assert_eq!(listed["reactions"][0]["users"][0], bob.user_id.as_str());

    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert_eq!(history["messages"][0]["reactions"][0]["count"], 1);
    assert_eq!(history["messages"][0]["reactions"][0]["me"], false);
    assert_eq!(history["messages"][0]["reactions"][0]["users"][0], bob.user_id.as_str());

    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cnope%3A01H%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 404, "an unknown custom emoji must not become a reaction");

    let (status, _) = s.delete(&format!("/_telium/v1/messages/{mid}/reactions/%F0%9F%9A%80/@me"), &bob.token).await;
    assert_eq!(status, 200);
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&bob.token)).await;
    assert!(listed["reactions"].as_array().unwrap().is_empty());

    let (status, _) = s.put(&format!("/_telium/v1/channels/{cid}/pins/{mid}"), &bob.token, json!({})).await;
    assert_eq!(status, 403);
    let (status, _) = s.put(&format!("/_telium/v1/channels/{cid}/pins/{mid}"), &alice.token, json!({})).await;
    assert_eq!(status, 200);
    let (_, pins) = s.get(&format!("/_telium/v1/channels/{cid}/pins"), Some(&bob.token)).await;
    assert_eq!(pins["pins"][0]["id"], mid.as_str());

    s.delete(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token).await;
    let (_, pins) = s.get(&format!("/_telium/v1/channels/{cid}/pins"), Some(&bob.token)).await;
    assert!(pins["pins"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn reactions_name_who_reacted_and_keep_that_list_honest() {
    let (s, alice, bob, _gid, cid) = social_fixture().await;
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "who" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/messages/{mid}/reactions/%F0%9F%91%8D/@me");

    s.put(&path, &alice.token, json!({})).await;
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&alice.token)).await;
    assert_eq!(listed["reactions"][0]["users"].as_array().unwrap().len(), 1);
    assert_eq!(listed["reactions"][0]["users"][0], alice.user_id.as_str());
    assert_eq!(listed["reactions"][0]["count"], 1);

    s.put(&path, &bob.token, json!({})).await;
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&bob.token)).await;
    assert_eq!(listed["reactions"][0]["count"], 2);
    assert_eq!(listed["reactions"][0]["me"], true);
    assert_eq!(listed["reactions"][0]["users"][0], alice.user_id.as_str());
    assert_eq!(listed["reactions"][0]["users"][1], bob.user_id.as_str());

    let (status, _) = s.delete(&path, &alice.token).await;
    assert_eq!(status, 200);
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&alice.token)).await;
    assert_eq!(listed["reactions"][0]["count"], 1);
    assert_eq!(listed["reactions"][0]["me"], false);
    assert_eq!(listed["reactions"][0]["users"][0], bob.user_id.as_str());

    let (status, _) = s.delete(&path, &bob.token).await;
    assert_eq!(status, 200);
    let (_, listed) = s.get(&format!("/_telium/v1/messages/{mid}/reactions"), Some(&bob.token)).await;
    assert!(listed["reactions"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn custom_emoji_reactions_carry_an_origin() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "ship it" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let data = URL_SAFE_NO_PAD.encode(&png_fixture(16, 16));
    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "party", "data": data, "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 200, "{emoji}");
    let eid = emoji["id"].as_str().unwrap();

    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cparty%3A{eid}%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 200, "a local custom emoji must react");

    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cparty%3A{eid}%40test.example%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 200, "an explicit local origin must resolve like the bare form");

    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cparty%3A{eid}%40elsewhere.example%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 200, "an unverifiable foreign emoji must still be gated, not rejected outright");

    let (status, _) = s
        .patch(&format!("/_telium/v1/guilds/{gid}"), &alice.token, json!({ "external_emoji": false }))
        .await;
    assert_eq!(status, 200);
    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cparty%3A{eid}%40elsewhere.example%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 403, "external emoji off must refuse a foreign reference");

    let (status, _) = s
        .put(&format!("/_telium/v1/messages/{mid}/reactions/%3Cparty%3A{eid}%40test.example%3E/@me"), &bob.token, json!({}))
        .await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn a_thread_is_a_channel_and_inherits_its_parents_permissions() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    let (_, msg) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "topic" }))
        .await;
    let mid = msg["id"].as_str().unwrap().to_string();

    let (status, thread) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/threads"),
            Some(&bob.token),
            json!({ "title": "a side discussion", "message_id": mid }),
        )
        .await;
    assert_eq!(status, 200, "{thread}");
    let tid = thread["id"].as_str().unwrap().to_string();
    assert_eq!(thread["owner"], bob.user_id.as_str());

    let (status, in_thread) = s
        .post(&format!("/_telium/v1/channels/{tid}/messages"), Some(&bob.token), json!({ "content": "more" }))
        .await;
    assert_eq!(status, 200, "{in_thread}");
    let (_, listed) = s.get(&format!("/_telium/v1/channels/{cid}/threads"), Some(&alice.token)).await;
    assert_eq!(listed["threads"][0]["message_count"], 1);

    let (status, _) = s.patch(&format!("/_telium/v1/threads/{tid}"), &bob.token, json!({ "locked": true })).await;
    assert_eq!(status, 403);
    let (status, _) = s.patch(&format!("/_telium/v1/threads/{tid}"), &alice.token, json!({ "locked": true })).await;
    assert_eq!(status, 200);
    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{tid}/messages"), Some(&bob.token), json!({ "content": "again" }))
        .await;
    assert_eq!(status, 403, "a locked thread refuses new messages");

    let deny = (1u64 << 0).to_string();
    s.put(
        &format!("/_telium/v1/channels/{cid}/overwrites/role/{gid}"),
        &alice.token,
        json!({ "allow": "0", "deny": deny }),
    )
    .await;
    let (status, _) = s.get(&format!("/_telium/v1/channels/{tid}/messages"), Some(&bob.token)).await;
    assert_eq!(status, 404, "a thread under a hidden parent must be hidden too");
}

#[tokio::test]
async fn unread_is_a_cursor_and_mentions_are_counted_separately() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    for text in ["one", "two"] {
        s.post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": text })).await;
    }
    let (_, mention) = s
        .post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&bob.token),
            json!({ "content": format!("{} take a look", alice.user_id) }),
        )
        .await;
    let last = mention["id"].as_str().unwrap().to_string();

    let (status, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&alice.token)).await;
    assert_eq!(status, 200, "{state}");
    let channel = &state["channels"][0];
    assert_eq!(channel["unread"], 3);
    assert_eq!(channel["mentions"], 1, "only the message naming Alice counts as a mention");

    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/ack"), Some(&alice.token), json!({ "message_id": last }))
        .await;
    assert_eq!(status, 200);
    let (_, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&alice.token)).await;
    assert_eq!(state["channels"][0]["unread"], 0);
    assert_eq!(state["channels"][0]["mentions"], 0);

    s.post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "mine" })).await;
    let (_, state) = s.get(&format!("/_telium/v1/guilds/{gid}/read-state"), Some(&alice.token)).await;
    assert_eq!(state["channels"][0]["unread"], 0);

    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "@everyone hi" }))
        .await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn search_is_scoped_to_what_the_member_can_see() {
    let (s, alice, bob, gid, cid) = social_fixture().await;
    s.post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "the quarterly roadmap" })).await;

    let (_, private) = s
        .post(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token), json!({ "name": "private" }))
        .await;
    let pid = private["id"].as_str().unwrap().to_string();
    let deny = (1u64 << 0).to_string();
    s.put(
        &format!("/_telium/v1/channels/{pid}/overwrites/role/{gid}"),
        &alice.token,
        json!({ "allow": "0", "deny": deny }),
    )
    .await;
    s.post(&format!("/_telium/v1/channels/{pid}/messages"), Some(&alice.token), json!({ "content": "the roadmap layoffs" })).await;

    let (status, found) = s.get(&format!("/_telium/v1/guilds/{gid}/search?q=roadmap"), Some(&alice.token)).await;
    assert_eq!(status, 200, "{found}");
    assert_eq!(found["count"], 2, "the owner sees both channels");

    let (_, found) = s.get(&format!("/_telium/v1/guilds/{gid}/search?q=roadmap"), Some(&bob.token)).await;
    assert_eq!(found["count"], 1, "search must not reach a channel the member cannot see");
    assert!(found["results"][0]["content"].as_str().unwrap().contains("quarterly"));

    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    let mid = history["messages"][0]["id"].as_str().unwrap().to_string();
    s.delete(&format!("/_telium/v1/channels/{cid}/messages/{mid}"), &alice.token).await;
    let (_, found) = s.get(&format!("/_telium/v1/guilds/{gid}/search?q=quarterly"), Some(&bob.token)).await;
    assert_eq!(found["count"], 0, "a deleted message must not stay findable");
}

#[tokio::test]
async fn automod_blocks_before_the_message_exists_and_exempts_moderators() {
    let (s, alice, bob, gid, cid) = social_fixture().await;

    let (status, rule) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/automod"),
            Some(&alice.token),
            json!({ "name": "no crypto spam", "kind": "keyword", "pattern": "airdrop, free nitro" }),
        )
        .await;
    assert_eq!(status, 200, "{rule}");

    let (status, refused) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "free NITRO here" }))
        .await;
    assert_eq!(status, 403, "{refused}");
    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token)).await;
    assert!(history["messages"].as_array().unwrap().is_empty(), "a blocked message must never exist");

    let (_, hits) = s.get(&format!("/_telium/v1/guilds/{gid}/automod-hits"), Some(&alice.token)).await;
    assert_eq!(hits["hits"][0]["user_id"], bob.user_id.as_str());
    assert_eq!(hits["hits"][0]["action"], "block");

    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "the airdrop rule works" }))
        .await;
    assert_eq!(status, 200);

    s.post(
        &format!("/_telium/v1/guilds/{gid}/automod"),
        Some(&alice.token),
        json!({ "name": "links", "kind": "link", "pattern": "example.com" }),
    )
    .await;
    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "see https://docs.example.com/x" }))
        .await;
    assert_eq!(status, 200);
    let (status, _) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "see https://evil.test/x" }))
        .await;
    assert_eq!(status, 403);

    let (status, _) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/automod"),
            Some(&alice.token),
            json!({ "name": "broken", "kind": "regex", "pattern": "([unclosed" }),
        )
        .await;
    assert_eq!(status, 400);
    let (status, _) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/automod"),
            Some(&bob.token),
            json!({ "name": "mine", "kind": "keyword", "pattern": "x" }),
        )
        .await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn join_gates_screen_applicants_and_hold_first_messages() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let (status, gates) = s
        .put(
            &format!("/_telium/v1/guilds/{gid}/gates"),
            &alice.token,
            json!({
                "screening": ["why do you want to join?"],
                "hold_first_messages": 1,
                "domain_policy": "blocklist",
                "domains": [{ "domain": "spam.test", "action": "block" }],
            }),
        )
        .await;
    assert_eq!(status, 200, "{gates}");

    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();

    let (status, pending) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{pending}");
    assert_eq!(pending["pending"], true);
    assert_eq!(pending["screening"][0], "why do you want to join?");
    let (status, _) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    assert_eq!(status, 403, "an applicant is not yet a member");

    let (status, _) = s
        .post(&format!("/_telium/v1/guilds/{gid}/screening"), Some(&bob.token), json!({ "answers": [] }))
        .await;
    assert_eq!(status, 400);
    let (status, _) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/screening"),
            Some(&bob.token),
            json!({ "answers": ["I like the topic"] }),
        )
        .await;
    assert_eq!(status, 200);

    let (_, applicants) = s.get(&format!("/_telium/v1/guilds/{gid}/applicants"), Some(&alice.token)).await;
    assert_eq!(applicants["applicants"][0]["answers"][0]["answer"], "I like the topic");
    let (status, _) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/applicants/{}", bob.user_id),
            Some(&alice.token),
            json!({ "decision": "approve" }),
        )
        .await;
    assert_eq!(status, 200);

    let (status, joined) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["id"], gid.as_str());

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&bob.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();
    let (status, held) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "hello everyone" }))
        .await;
    assert_eq!(status, 200, "{held}");
    assert_eq!(held["held"], true);
    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token)).await;
    assert!(history["messages"].as_array().unwrap().is_empty());

    let (_, queue) = s.get(&format!("/_telium/v1/guilds/{gid}/held"), Some(&alice.token)).await;
    let hid = queue["held"][0]["id"].as_str().unwrap().to_string();
    let (status, decided) = s
        .post(&format!("/_telium/v1/guilds/{gid}/held/{hid}"), Some(&alice.token), json!({ "decision": "approve" }))
        .await;
    assert_eq!(status, 200, "{decided}");
    assert_eq!(decided["published"], true);
    let (_, history) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token)).await;
    assert_eq!(history["messages"][0]["content"], "hello everyone");

    let (status, _) = s
        .post(&format!("/_telium/v1/guilds/{gid}/held/{hid}"), Some(&alice.token), json!({ "decision": "approve" }))
        .await;
    assert_eq!(status, 409);

    let (status, second) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&bob.token), json!({ "content": "second" }))
        .await;
    assert_eq!(status, 200);
    assert_eq!(second["content"], "second");
}

#[tokio::test]
async fn archived_history_is_still_scrollable_and_still_searchable() {
    let (s, alice, _bob, gid, cid) = social_fixture_with(|cfg| {
        cfg.archive.enabled = true;
        cfg.archive.horizon_days = 0;
        cfg.archive.keep_hot_messages = 3;
        cfg.archive.batch = 100;
        cfg.archive.dir = cfg.media_dir.with_file_name("cold");
    })
    .await;
    for i in 0..8 {
        s.post(
            &format!("/_telium/v1/channels/{cid}/messages"),
            Some(&alice.token),
            json!({ "content": format!("message number {i} about penguins") }),
        )
        .await;
    }
    let (_, before_archive) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    assert_eq!(before_archive["messages"].as_array().unwrap().len(), 8);

    let (status, run) = s.post("/_telium/v1/admin/archive", Some(&alice.home), json!({})).await;
    assert_eq!(status, 200, "{run}");
    assert!(run["archived"].as_i64().unwrap() >= 5, "old history should have moved: {run}");

    let (_, hot) = s.get(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token)).await;
    let hot_count = hot["messages"].as_array().unwrap().len();
    assert!(hot_count <= 3, "the hot table keeps only the tail, got {hot_count}");
    let oldest_hot = hot["messages"].as_array().unwrap().first().unwrap()["id"].as_str().unwrap().to_string();

    let (status, cold) = s
        .get(&format!("/_telium/v1/channels/{cid}/messages?before={oldest_hot}"), Some(&alice.token))
        .await;
    assert_eq!(status, 200, "{cold}");
    assert_eq!(cold["archived"], true);
    assert!(!cold["messages"].as_array().unwrap().is_empty(), "archived scrollback must page in");

    let (_, found) = s.get(&format!("/_telium/v1/guilds/{gid}/search?q=penguins"), Some(&alice.token)).await;
    assert_eq!(found["count"], 8, "archival must not cost searchability");
    assert!(
        found["results"].as_array().unwrap().iter().any(|r| r["archived"] == true),
        "a hit in cold storage should name its segment: {found}"
    );

    let (_, segments) = s.get(&format!("/_telium/v1/channels/{cid}/segments"), Some(&alice.token)).await;
    assert_eq!(segments["segments"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_listed_hash_is_refused_on_every_ingress_path() {
    const DENIED: &str = "forbidden bytes";
    const DENIED_SHA256: &str = "cb6cf1b18ae08a4ce3e3b9f0c1f19dc27b3891d07279b2ad908d4f92ba0ab795";

    let s = start_with(|cfg| {
        let list = cfg.media_dir.with_file_name("hashes.txt");
        std::fs::write(&list, format!("# a comment\n{DENIED_SHA256}  labelled entry\n")).unwrap();
        cfg.moderation.upload_hash_lists = vec![telium_server::config::HashListSource {
            name: "test-list".into(),
            algorithm: "sha256".into(),
            path: list,
        }];
    })
    .await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();

    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body(DENIED)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 403);
    let body: Value = refused.json().await.unwrap();
    let message = body["message"].as_str().unwrap().to_string();
    assert!(message.contains("hash list"), "the uploader is told what happened: {message}");
    assert!(
        !message.contains("test-list"),
        "but never which list matched, or a rejection is a probing oracle: {message}"
    );

    let (status, voucher) = s
        .post(
            "/_telium/v1/media/vouchers",
            Some(&alice.token),
            json!({ "guild_id": gid, "origin": "test.example" }),
        )
        .await;
    assert_eq!(status, 200, "{voucher}");
    let header = telium_server::util::b64(voucher["voucher"].to_string().as_bytes());
    let refused = s
        .client
        .post(format!("{}/_telium/v1/media/voucher-upload", s.base))
        .header("X-Telium-Voucher", &header)
        .header("Content-Type", "text/plain")
        .body(DENIED)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 403, "the voucher path reaches storage too");

    let (status, emoji) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/emojis"),
            Some(&alice.token),
            json!({ "name": "bad", "data": base64_url(DENIED), "mime": "image/png" }),
        )
        .await;
    assert_eq!(status, 403, "expression assets are an ingress like any other: {emoji}");

    let ok = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body("perfectly ordinary bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status().as_u16(), 200);

    let (_, reports) = s.get("/_telium/v1/admin/reports", Some(&alice.home)).await;
    let hits: Vec<&Value> = reports["reports"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["category"] == "hash_list_match")
        .collect();
    assert_eq!(hits.len(), 3, "one report per refusal: {reports}");
    assert_eq!(hits[0]["target_type"], "media");
    assert_eq!(hits[0]["evidence"][0]["list"], "test-list");
    assert_eq!(hits[0]["evidence"][0]["uploader"], alice.user_id.as_str());

    use std::sync::atomic::Ordering;
    let metrics = &s.state.metrics;
    assert_eq!(metrics.media_scans.load(Ordering::Relaxed), 4);
    assert_eq!(metrics.media_scan_matches.load(Ordering::Relaxed), 3);
    assert_eq!(metrics.media_scan_failures.load(Ordering::Relaxed), 0);
    sqlx::query("ALTER TABLE reports RENAME TO reports_taken_away")
        .execute(&s.state.pool)
        .await
        .unwrap();
    let refused = s
        .client
        .post(format!("{}/_telium/v1/media", s.base))
        .bearer_auth(&alice.home)
        .header("Content-Type", "text/plain")
        .body(DENIED)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 403, "a scanner that cannot file its finding must fail closed");
    assert_eq!(metrics.media_scan_failures.load(Ordering::Relaxed), 1);
    assert_eq!(metrics.media_scan_matches.load(Ordering::Relaxed), 4);

    let bare = start().await;
    let (_, caps) = bare.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["media"]["upload_scanning"], true);
    assert_eq!(caps["media"]["hash_list_entries"], 0);
    assert_eq!(caps["features"]["gif_picker"], true);
    assert_eq!(caps["gif_provider"]["provider"], "klipy");
    assert_eq!(caps["gif_provider"]["enabled"], true);
}

#[tokio::test]
async fn gif_provider_configuration_is_published_and_can_be_disabled() {
    let s = start_with(|cfg| {
        cfg.klipy.enabled = false;
        cfg.klipy.api_key = "operator-key".into();
    })
    .await;
    let (_, caps) = s.get("/_telium/v1/capabilities", None).await;
    assert_eq!(caps["features"]["gif_picker"], false);
    assert_eq!(caps["gif_provider"]["enabled"], false);
    assert_eq!(caps["gif_provider"]["api_key"], "operator-key");
    assert!(caps["media"]["external_hosts"].as_array().unwrap().iter().any(|host| {
        host["provider"] == "gofile"
    }));
}

#[tokio::test]
async fn a_reference_from_a_disallowed_origin_is_refused_at_message_create() {
    let s = start_with(|cfg| cfg.federation.enabled = false).await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, channels) =
        s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let cid = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let foreign = json!({
        "origin": "files.elsewhere.example",
        "hash": "0".repeat(64),
        "filename": "cat.png",
        "mime": "image/png",
        "size": 12,
    });
    let path = format!("/_telium/v1/channels/{cid}/messages");

    let (status, sent) =
        s.post(&path, Some(&alice.token), json!({ "content": "hi", "attachments": [foreign] })).await;
    assert_eq!(status, 200, "{sent}");

    let (status, saved) = s
        .put(
            &format!("/_telium/v1/guilds/{gid}/gates"),
            &alice.token,
            json!({
                "origin_policy": "blocklist",
                "origins": [{ "action": "block", "domain": "files.elsewhere.example" }],
            }),
        )
        .await;
    assert_eq!(status, 200, "{saved}");
    assert_eq!(saved["origin_policy"], "blocklist");

    let (status, refused) =
        s.post(&path, Some(&alice.token), json!({ "content": "hi", "attachments": [foreign] })).await;
    assert_eq!(status, 403);
    assert!(
        refused["message"].as_str().unwrap().contains("files.elsewhere.example"),
        "the refusal names the origin that caused it: {refused}"
    );
    let (status, _) = s.post(&path, Some(&alice.token), json!({ "content": "hi" })).await;
    assert_eq!(status, 200);

    let registry_key = URL_SAFE_NO_PAD.encode(SigningKey::from_bytes(&[9; 32]).verifying_key().as_bytes());
    let (_, saved) = s
        .put(
            &format!("/_telium/v1/guilds/{gid}/gates"),
            &alice.token,
            json!({
                "origin_policy": "allowlist",
                "origins": [
                    { "action": "allow", "domain": "files.trusted.example" },
                    { "action": "allow", "feed": "https://registry.example/hosts.json", "key": registry_key },
                ],
            }),
        )
        .await;
    assert_eq!(saved["origins"].as_array().unwrap().len(), 2);
    assert!(saved["origins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|o| o["feed"] == "https://registry.example/hosts.json"));

    let (status, refused) =
        s.post(&path, Some(&alice.token), json!({ "content": "hi", "attachments": [foreign] })).await;
    assert_eq!(status, 403, "{refused}");

    let (status, sent) = s
        .post(
            &path,
            Some(&alice.token),
            json!({ "content": "hi", "attachments": [{
                "origin": "test.example", "hash": "1".repeat(64),
                "filename": "cat.png", "mime": "image/png", "size": 12,
            }] }),
        )
        .await;
    assert_eq!(status, 200, "{sent}");
}

#[tokio::test]
async fn an_external_https_attachment_is_accepted_without_origin_federation() {
    let s = start_with(|cfg| cfg.federation.enabled = false).await;
    let alice = s.user("alice").await;
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap();
    let (_, channels) = s
        .get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token))
        .await;
    let cid = channels["channels"][0]["id"].as_str().unwrap();
    let path = format!("/_telium/v1/channels/{cid}/messages");

    let external = json!({
        "external": true,
        "external_host": "gofile",
        "origin": "store-na-phx-5.gofile.io",
        "hash": "external-abc",
        "url": "https://store-na-phx-5.gofile.io/download/direct/file1/notes.txt",
        "filename": "notes.txt",
        "mime": "text/plain",
        "size": 12,
    });
    let (status, sent) = s
        .post(&path, Some(&alice.token), json!({ "content": "hi", "attachments": [external] }))
        .await;
    assert_eq!(status, 200, "{sent}");

    let invalid = json!({
        "external": true,
        "origin": "store-na-phx-5.gofile.io",
        "hash": "external-bad",
        "url": "http://store-na-phx-5.gofile.io/download/direct/file1/notes.txt",
        "filename": "notes.txt",
        "mime": "text/plain",
        "size": 12,
    });
    let (status, _) = s
        .post(&path, Some(&alice.token), json!({ "content": "hi", "attachments": [invalid] }))
        .await;
    assert_eq!(status, 400);
}
