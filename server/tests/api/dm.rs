use super::*;

async fn dm_epoch(s: &Server, conv: &str, who: &User) -> (i64, i64) {
    let (status, view) = s.get(&format!("/_telium/v1/conversations/{conv}"), Some(&who.home)).await;
    assert_eq!(status, 200, "{view}");
    (view["epoch"].as_i64().unwrap(), view["last_seq"].as_i64().unwrap())
}

#[tokio::test]
async fn a_dm_commit_must_claim_exactly_the_next_epoch() {
    let s = start().await;
    let alice = s.user("epoch-alice").await;
    let bob = s.user("epoch-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let frame = |kind: &str, ct: &str, epoch: i64| json!({ "kind": kind, "ciphertext": ct, "epoch": epoch });
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (0, 0));

    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "early", 2)).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (0, 0), "a refused commit leaves no frame");

    let (status, body) = s.post(&path, Some(&alice.home), frame("welcome", "founding", 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await.0, 1);

    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "c2", 2)).await;
    assert_eq!(status, 200, "{body}");
    let (_, seq) = dm_epoch(&s, &conv, &alice).await;
    for (what, epoch) in [("replayed", 2), ("stale", 1), ("skipping", 4)] {
        let (status, body) = s.post(&path, Some(&alice.home), frame("commit", what, epoch)).await;
        assert_eq!(status, 409, "a {what} commit was ordered: {body}");
    }
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (2, seq), "nothing refused was kept");
    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "c3", 3)).await;
    assert_eq!(status, 200, "{body}");

    let (status, body) = s.post(&path, Some(&alice.home), frame("welcome", "start-over", 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await.0, 1);
    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "old-group", 4)).await;
    assert_eq!(status, 409, "a commit from the replaced group was ordered: {body}");
    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "new-group", 2)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await.0, 2);

    let (status, body) = s.post(&path, Some(&alice.home), frame("welcome", "added", 2)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await.0, 2);
}

#[tokio::test]
async fn simultaneous_commits_at_one_epoch_order_exactly_one() {
    let s = start().await;
    let alice = s.user("race-alice").await;
    let bob = s.user("race-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let (status, body) = s
        .post(&path, Some(&alice.home), json!({ "kind": "welcome", "ciphertext": "founding", "epoch": 1 }))
        .await;
    assert_eq!(status, 200, "{body}");

    for epoch in [2, 3] {
        let calls = (0..8).map(|i| {
            let client = s.client.clone();
            let url = format!("{}{path}", s.base);
            let token = if i % 2 == 0 { alice.home.clone() } else { bob.home.clone() };
            let body = json!({ "kind": "commit", "ciphertext": format!("e{epoch}-c{i}"), "epoch": epoch });
            async move {
                let resp = client.post(url).bearer_auth(token).json(&body).send().await.unwrap();
                resp.status().as_u16()
            }
        });
        let statuses = futures_util::future::join_all(calls).await;
        assert_eq!(statuses.iter().filter(|&&st| st == 200).count(), 1, "{statuses:?}");
        assert!(statuses.iter().all(|&st| st == 200 || st == 409), "{statuses:?}");
        assert_eq!(dm_epoch(&s, &conv, &alice).await.0, epoch);
    }
    let commits: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND kind = 'commit'",
    )
    .bind(&conv)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(commits, 2, "a refused commit was kept");
}

async fn dm_generation(s: &Server, conv: &str, who: &User) -> i64 {
    let (status, view) = s.get(&format!("/_telium/v1/conversations/{conv}"), Some(&who.home)).await;
    assert_eq!(status, 200, "{view}");
    view["generation"].as_i64().unwrap()
}

#[tokio::test]
async fn starting_a_dm_over_is_sequenced_and_the_first_one_wins() {
    let s = start().await;
    let alice = s.user("gen-alice").await;
    let bob = s.user("gen-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let over = |ct: &str, generation: i64| {
        json!({ "kind": "welcome", "ciphertext": ct, "epoch": 1, "start_over": true, "generation": generation })
    };
    let commit = |ct: &str, epoch: i64, generation: i64| {
        json!({ "kind": "commit", "ciphertext": ct, "epoch": epoch, "generation": generation })
    };
    assert_eq!(dm_generation(&s, &conv, &alice).await, 0);

    let (status, founded) = s.post(&path, Some(&alice.home), over("alice-founds", 0)).await;
    assert_eq!(status, 200, "{founded}");
    assert_eq!(founded["generation"], 1);
    let (status, lost) = s.post(&path, Some(&bob.home), over("bob-founds", 0)).await;
    assert_eq!(status, 409, "{lost}");
    assert_eq!(lost["code"], "generation_conflict");
    assert_eq!(lost["generation"], 1);
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (1, 1), "the loser left no frame and moved nothing");

    let (status, body) = s.post(&path, Some(&bob.home), commit("g1-e2", 2, 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["generation"], 1);
    let (status, body) = s
        .post(&path, Some(&bob.home), json!({ "kind": "commit", "ciphertext": "legacy-e3", "epoch": 3 }))
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["generation"], 1);

    let (status, won) = s.post(&path, Some(&alice.home), over("alice-again", 1)).await;
    assert_eq!(status, 200, "{won}");
    assert_eq!(won["generation"], 2);
    let (status, lost) = s.post(&path, Some(&bob.home), over("bob-again", 1)).await;
    assert_eq!(status, 409, "{lost}");
    assert_eq!((lost["code"].as_str(), lost["generation"].as_i64()), (Some("generation_conflict"), Some(2)));
    assert_eq!(dm_epoch(&s, &conv, &alice).await.0, 1);
    assert_eq!(dm_generation(&s, &conv, &alice).await, 2);

    let (status, body) = s.post(&path, Some(&bob.home), commit("g1-e2-again", 2, 1)).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "generation_conflict");
    let (status, body) = s.post(&path, Some(&alice.home), commit("g2-e2", 2, 2)).await;
    assert_eq!(status, 200, "{body}");

    let (status, body) = s.post(&path, Some(&alice.home), over("alice-third", 2)).await;
    assert_eq!(status, 200, "{body}");

    for bad in [
        json!({ "kind": "commit", "ciphertext": "x", "epoch": 2, "start_over": true, "generation": 3 }),
        json!({ "kind": "welcome", "ciphertext": "x", "epoch": 1, "start_over": true }),
        json!({ "kind": "welcome", "ciphertext": "x", "epoch": 2, "start_over": true, "generation": 3 }),
    ] {
        let (status, body) = s.post(&path, Some(&alice.home), bad.clone()).await;
        assert_eq!(status, 400, "{bad} -> {body}");
    }

    let (_, hist) = s.get(&format!("{path}?after=0"), Some(&alice.home)).await;
    let gens: Vec<(String, i64)> = hist["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["ciphertext"].as_str().unwrap().to_string(), f["generation"].as_i64().unwrap()))
        .collect();
    assert_eq!(
        gens,
        vec![
            ("alice-founds".into(), 1), ("g1-e2".into(), 1), ("legacy-e3".into(), 1),
            ("alice-again".into(), 2), ("g2-e2".into(), 2), ("alice-third".into(), 3),
        ],
    );
}

#[tokio::test]
async fn a_start_over_sent_twice_is_ordered_once() {
    let s = start().await;
    let alice = s.user("gen2-alice").await;
    let bob = s.user("gen2-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let body = json!({
        "kind": "welcome", "ciphertext": "founding", "epoch": 1, "start_over": true, "generation": 0,
        "frame_id": "founding-frame",
    });
    let (status, first) = s.post(&path, Some(&alice.home), body.clone()).await;
    assert_eq!(status, 200, "{first}");
    let (status, again) = s.post(&path, Some(&alice.home), body).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["seq"], first["seq"]);
    assert_eq!(again["replayed"], true);
    assert_eq!(dm_generation(&s, &conv, &alice).await, 1);
}

#[tokio::test]
async fn a_bare_welcome_at_epoch_one_resets_only_where_it_can_mean_a_start_over() {
    let s = start().await;
    let alice = s.user("bare-alice").await;
    let bob = s.user("bare-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let frame = |kind: &str, ct: &str, epoch: i64| json!({ "kind": kind, "ciphertext": ct, "epoch": epoch });

    let (status, body) = s.post(&path, Some(&alice.home), frame("welcome", "founding", 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((dm_epoch(&s, &conv, &alice).await.0, dm_generation(&s, &conv, &alice).await), (1, 1));
    let (status, body) = s.post(&path, Some(&bob.home), frame("welcome", "second-founding", 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(dm_generation(&s, &conv, &alice).await, 1);
    let (status, body) = s.post(&path, Some(&alice.home), frame("commit", "c2", 2)).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = s.post(&path, Some(&bob.home), frame("welcome", "legacy-start-over", 1)).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!((dm_epoch(&s, &conv, &alice).await.0, dm_generation(&s, &conv, &alice).await), (1, 2));
    let (status, body) = s
        .post(&path, Some(&alice.home), json!({ "kind": "commit", "ciphertext": "old", "epoch": 2, "generation": 1 }))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "generation_conflict");
}

#[tokio::test]
async fn a_dm_frame_sent_twice_under_one_id_is_ordered_once() {
    let s = start().await;
    let alice = s.user("frameid-alice").await;
    let bob = s.user("frameid-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let (status, body) = s
        .post(&path, Some(&alice.home), json!({ "kind": "welcome", "ciphertext": "w1", "epoch": 1 }))
        .await;
    assert_eq!(status, 200, "{body}");

    let commit = json!({ "kind": "commit", "ciphertext": "c2", "epoch": 2, "frame_id": "fid-c2" });
    let (status, first) = s.post(&path, Some(&alice.home), commit.clone()).await;
    assert_eq!(status, 200, "{first}");
    let seq = first["seq"].as_i64().unwrap();
    let (status, again) = s.post(&path, Some(&alice.home), commit).await;
    assert_eq!(status, 200, "a retry of an ordered commit is not a stale one: {again}");
    assert_eq!(again["seq"].as_i64(), Some(seq));
    assert_eq!(again["replayed"], true);
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (2, seq), "nothing was ordered twice");

    let app = json!({ "kind": "application", "ciphertext": "hello", "frame_id": "fid-hello" });
    let (_, one) = s.post(&path, Some(&alice.home), app.clone()).await;
    let (_, two) = s.post(&path, Some(&alice.home), app).await;
    assert_eq!(one["seq"], two["seq"]);
    let stored: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND ciphertext = 'hello'",
    )
    .bind(&conv)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(stored, 1);

    let (status, body) = s
        .post(&path, Some(&alice.home), json!({ "kind": "application", "ciphertext": "other", "frame_id": "fid-hello" }))
        .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "frame_id_reused");

    let (status, body) = s
        .post(&path, Some(&alice.home), json!({ "kind": "application", "ciphertext": "legacy" }))
        .await;
    assert_eq!(status, 200, "{body}");
}

#[tokio::test]
async fn a_dm_commit_that_loses_the_epoch_race_is_told_the_winner() {
    let s = start().await;
    let alice = s.user("race-alice").await;
    let bob = s.user("race-bob").await;
    let conv = open_dm(&s, &alice, &bob).await;
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    s.post(&path, Some(&alice.home), json!({ "kind": "welcome", "ciphertext": "w1", "epoch": 1 })).await;
    let (status, won) = s
        .post(&path, Some(&alice.home), json!({ "kind": "commit", "ciphertext": "alice-c2", "epoch": 2, "frame_id": "fid-alice" }))
        .await;
    assert_eq!(status, 200, "{won}");

    let (status, lost) = s
        .post(&path, Some(&bob.home), json!({ "kind": "commit", "ciphertext": "bob-c2", "epoch": 2, "frame_id": "fid-bob" }))
        .await;
    assert_eq!(status, 409, "{lost}");
    assert_eq!(lost["code"], "epoch_conflict");
    assert_eq!(lost["epoch"], 2);
    assert_eq!(lost["winner_seq"], won["seq"]);
    assert_eq!(lost["winner_epoch"], 2);
    assert_eq!(lost["winner_sender"], alice.user_id.as_str());
    assert_eq!(lost["winner_frame_id"], "fid-alice");
    assert!(lost["winner_digest"].as_str().is_some_and(|d| !d.is_empty()), "{lost}");
    let stored: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND ciphertext = 'bob-c2'",
    )
    .bind(&conv)
    .fetch_one(&s.state.pool)
    .await
    .unwrap();
    assert_eq!(stored, 0);
}

#[tokio::test]
async fn a_refused_add_leaves_no_member_and_no_frames() {
    let s = start().await;
    let alice = s.user("atomic-alice").await;
    let bob = s.user("atomic-bob").await;
    let carol = s.user("atomic-carol").await;
    let dave = s.user("atomic-dave").await;
    let (status, made) = s
        .post("/_telium/v1/conversations", Some(&alice.home), json!({ "kind": "gc", "members": [&bob.user_id] }))
        .await;
    assert_eq!(status, 200, "{made}");
    let conv = made["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    s.post(&path, Some(&alice.home), json!({ "kind": "welcome", "ciphertext": "w1", "epoch": 1 })).await;
    let member = |who: String| {
        let pool = s.state.pool.clone();
        let conv = conv.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "SELECT state FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
            )
            .bind(conv)
            .bind(who)
            .fetch_optional(&pool)
            .await
            .unwrap()
        }
    };

    let add = |who: &str, epoch: i64, ct: &str| json!({
        "kind": "commit", "ciphertext": ct, "epoch": epoch, "frame_id": format!("fid-{ct}"),
        "change": { "op": "add", "user_ids": [who] },
        "welcome": format!("welcome-for-{ct}"),
    });
    let before = dm_epoch(&s, &conv, &alice).await;
    let (status, body) = s.post(&path, Some(&alice.home), add(&carol.user_id, 3, "skips")).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(dm_epoch(&s, &conv, &alice).await, before, "a refused add orders nothing");
    assert_eq!(member(carol.user_id.clone()).await, None, "and adds nobody");
    let frames: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ?")
        .bind(&conv)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(frames, 1, "only the founding welcome");

    let (status, body) = s.post(&path, Some(&alice.home), add(&dave.user_id, 2, "adds")).await;
    assert_eq!(status, 200, "{body}");
    let seq = body["seq"].as_i64().unwrap();
    assert_eq!(body["welcome"]["seq"].as_i64(), Some(seq + 1), "{body}");
    assert_eq!(body["welcome"]["kind"], "welcome");
    assert_eq!(member(dave.user_id.clone()).await.as_deref(), Some("active"));
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (2, seq + 1));

    let (status, again) = s.post(&path, Some(&alice.home), add(&dave.user_id, 2, "adds")).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["seq"].as_i64(), Some(seq));
    assert_eq!(again["welcome"]["seq"].as_i64(), Some(seq + 1));
    assert_eq!(dm_epoch(&s, &conv, &alice).await, (2, seq + 1));
}

#[tokio::test]
async fn a_leave_is_flagged_until_a_commit_takes_the_leaves_out() {
    let s = start().await;
    let alice = s.user("resync-alice").await;
    let bob = s.user("resync-bob").await;
    let carol = s.user("resync-carol").await;
    let managed = json!({ "v": 1, "add": "admins", "remove": "admins", "policy": "creator", "admins": [] });
    let (status, made) = s
        .post(
            "/_telium/v1/conversations",
            Some(&alice.home),
            json!({ "kind": "gc", "members": [&bob.user_id, &carol.user_id], "policy": managed }),
        )
        .await;
    assert_eq!(status, 200, "{made}");
    let conv = made["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/conversations/{conv}/messages");
    let (status, body) =
        s.post(&path, Some(&alice.home), json!({ "kind": "welcome", "ciphertext": "w1", "epoch": 1 })).await;
    assert_eq!(status, 200, "{body}");
    let view = |who: &User| {
        let token = who.home.clone();
        let conv = conv.clone();
        let s = &s;
        async move { s.get(&format!("/_telium/v1/conversations/{conv}"), Some(&token)).await.1 }
    };
    assert_eq!(view(&carol).await["resync"], false);

    let (status, body) = s
        .post(&path, Some(&bob.home), json!({ "kind": "proposal", "ciphertext": "bob-leaves", "epoch": 1 }))
        .await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = s.post(&format!("/_telium/v1/conversations/{conv}/leave"), Some(&bob.home), json!({})).await;
    assert_eq!(status, 200, "{body}");
    let seen = view(&carol).await;
    assert_eq!(seen["resync"], true, "{seen}");
    let row = seen["members"].as_array().unwrap().iter().find(|m| m["user_id"] == bob.user_id).cloned().unwrap();
    assert_eq!(row["resync"], true, "{row}");

    let (status, body) = s
        .post(&path, Some(&carol.home), json!({
            "kind": "commit", "ciphertext": "carol-ousts", "epoch": 2,
            "change": { "op": "remove", "user_ids": [&alice.user_id] },
        }))
        .await;
    assert_eq!(status, 403, "{body}");
    let (status, body) = s
        .post(&path, Some(&carol.home), json!({
            "kind": "commit", "ciphertext": "carol-commits-leave", "epoch": 2,
            "change": { "op": "remove", "user_ids": [&bob.user_id] },
        }))
        .await;
    assert_eq!(status, 200, "{body}");
    let seen = view(&alice).await;
    assert_eq!(seen["resync"], false, "{seen}");
}

#[tokio::test]
async fn a_vault_write_against_a_stale_version_is_refused() {
    let s = start().await;
    let alice = s.user("vaultcas-alice").await;
    let put = |body: Value| s.put("/_telium/v1/vault", &alice.home, body);

    let (status, made) = put(json!({ "mode": "device_custody", "ciphertext": "first", "expected_version": 0 })).await;
    assert_eq!(status, 200, "{made}");
    let v1 = made["version"].as_i64().unwrap();
    let (status, body) = put(json!({ "mode": "device_custody", "ciphertext": "second-first", "expected_version": 0 })).await;
    assert_eq!(status, 409, "two first devices may not both create: {body}");
    assert_eq!(body["code"], "vault_version_conflict");
    assert_eq!(body["version"].as_i64(), Some(v1));

    let (status, body) = put(json!({ "mode": "device_custody", "ciphertext": "second", "expected_version": v1 })).await;
    assert_eq!(status, 200, "{body}");
    let v2 = body["version"].as_i64().unwrap();
    assert!(v2 > v1);
    let (status, body) = put(json!({ "mode": "device_custody", "ciphertext": "stale", "expected_version": v1 })).await;
    assert_eq!(status, 409, "{body}");

    let mode = |body: Value| s.post("/_telium/v1/vault/mode", Some(&alice.home), body);
    let (status, body) = mode(json!({ "mode": "device_custody", "ciphertext": "stale-mode", "expected_version": v1 })).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["code"], "vault_version_conflict");
    let (_, vault) = s.get("/_telium/v1/vault", Some(&alice.home)).await;
    assert_eq!(vault["ciphertext"], "second", "a refused write changes nothing");
    assert_eq!(vault["version"].as_i64(), Some(v2));

    let (status, body) = mode(json!({ "mode": "device_custody", "ciphertext": "current", "expected_version": v2 })).await;
    assert_eq!(status, 200, "{body}");
    let (status, body) = mode(json!({ "mode": "device_custody", "ciphertext": "unconditional" })).await;
    assert_eq!(status, 200, "a client that names no version is not held to one: {body}");
    let (status, body) = put(json!({ "mode": "device_custody", "ciphertext": "legacy-put" })).await;
    assert_eq!(status, 200, "{body}");
}

async fn race_creates(s: &Server, token: &str, body: Value, count: usize) -> Vec<(u16, Value)> {
    let calls = (0..count).map(|_| {
        let client = s.client.clone();
        let url = format!("{}/_telium/v1/conversations", s.base);
        let token = token.to_string();
        let body = body.clone();
        async move {
            let resp = client.post(url).bearer_auth(token).json(&body).send().await.unwrap();
            let status = resp.status().as_u16();
            (status, resp.json::<Value>().await.unwrap_or(json!(null)))
        }
    });
    futures_util::future::join_all(calls).await
}

#[tokio::test]
async fn simultaneous_dm_creates_land_in_one_conversation_and_one_request() {
    let s = start().await;
    let ana = s.user("ana").await;
    let ben = s.user("ben").await;

    let hers = race_creates(&s, &ana.home, json!({ "kind": "dm", "members": [&ben.user_id] }), 6);
    let his = race_creates(&s, &ben.home, json!({ "kind": "dm", "members": [&ana.user_id] }), 2);
    let (hers, his) = tokio::join!(hers, his);
    let first = &hers[0].1;
    for (status, body) in hers.iter().chain(his.iter()) {
        assert_eq!(*status, 200, "{body}");
        assert_eq!(body["id"], first["id"], "two conversations for one pair: {body}");
    }
    for (_, body) in &hers {
        assert_eq!(body, first, "losers must get the identical answer");
    }
    assert_eq!(count(&s, "SELECT COUNT(*) FROM conversations").await, 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM dm_pairs").await, 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM dm_message_requests").await, 1);
    let recipient: String = sqlx::query_scalar("SELECT user_id FROM dm_message_requests")
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert!(recipient == ana.user_id || recipient == ben.user_id);

    let (status, again) = s
        .post(
            "/_telium/v1/conversations",
            Some(&ana.home),
            json!({ "kind": "dm", "members": [&ben.user_id], "welcome": "welcome-two" }),
        )
        .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["id"], first["id"]);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM dm_message_requests").await, 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM dm_messages").await, 0, "the repeat sequenced its Welcome");
}

#[tokio::test]
async fn group_chats_stay_separate_and_leaving_a_dm_releases_the_pair() {
    let s = start().await;
    let ana = s.user("ana").await;
    let ben = s.user("ben").await;

    let replies = race_creates(&s, &ana.home, json!({ "kind": "gc", "members": [&ben.user_id] }), 4).await;
    let mut ids: Vec<&str> = replies.iter().map(|(_, b)| b["id"].as_str().unwrap()).collect();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), 4, "concurrent group chats were deduplicated: {replies:?}");

    let dm = json!({ "kind": "dm", "members": [&ben.user_id] });
    let (_, first) = s.post("/_telium/v1/conversations", Some(&ana.home), dm.clone()).await;
    let old = first["id"].as_str().unwrap().to_string();
    let (status, left) =
        s.post(&format!("/_telium/v1/conversations/{old}/leave"), Some(&ana.home), json!({})).await;
    assert_eq!(status, 200, "{left}");
    let (_, second) = s.post("/_telium/v1/conversations", Some(&ana.home), dm).await;
    assert_ne!(second["id"].as_str().unwrap(), old, "a departed dm still held the pair");
    let (status, kept) = s.get(&format!("/_telium/v1/conversations/{old}"), Some(&ben.home)).await;
    assert_eq!(status, 200, "the conversation she left was destroyed: {kept}");
}

#[tokio::test]
async fn the_backfill_gives_the_pair_to_the_conversation_people_were_using() {
    let s = start().await;
    let ana = s.user("ana").await;
    let ben = s.user("ben").await;
    for (id, created_at) in [("dm-older", 1000_i64), ("dm-newer", 2000)] {
        sqlx::query(
            "INSERT INTO conversations (id, kind, sequencer, creator, created_at, updated_at) \
             VALUES (?, 'dm', 'test.example', ?, ?, ?)",
        )
        .bind(id)
        .bind(&ana.user_id)
        .bind(created_at)
        .bind(created_at)
        .execute(&s.state.pool)
        .await
        .unwrap();
        for who in [&ana.user_id, &ben.user_id] {
            sqlx::query(
                "INSERT INTO conversation_members (conversation_id, user_id, home_domain, added_at) \
                 VALUES (?, ?, 'test.example', ?)",
            )
            .bind(id)
            .bind(who)
            .bind(created_at)
            .execute(&s.state.pool)
            .await
            .unwrap();
        }
    }
    sqlx::query(
        "INSERT INTO dm_messages (id, conversation_id, seq, kind, sender, ciphertext, created_at) \
         VALUES ('frame-1', 'dm-older', 1, 'application', ?, 'ct', 9000)",
    )
    .bind(&ana.user_id)
    .execute(&s.state.pool)
    .await
    .unwrap();

    let migration = include_str!("../../migrations/0075_one_dm_per_pair.sql");
    let backfill = &migration[migration.find("INSERT INTO dm_pairs").unwrap()..];
    sqlx::raw_sql(backfill).execute(&s.state.pool).await.unwrap();

    let claimed: Vec<String> = sqlx::query_scalar("SELECT conversation_id FROM dm_pairs")
        .fetch_all(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(claimed, ["dm-older"], "the claim went to the empty twin");
    let (_, asked) = s
        .post("/_telium/v1/conversations", Some(&ana.home), json!({ "kind": "dm", "members": [&ben.user_id] }))
        .await;
    assert_eq!(asked["id"], "dm-older");
    let (status, loser) = s.get("/_telium/v1/conversations/dm-newer", Some(&ben.home)).await;
    assert_eq!(status, 200, "{loser}");
}

#[tokio::test]
async fn conversations_list_newest_activity_first() {
    let s = start().await;
    let alice = s.user("order-alice").await;
    let bob = s.user("order-bob").await;
    let carol = s.user("order-carol").await;
    let older = open_dm(&s, &alice, &bob).await;
    let newer = open_dm(&s, &alice, &carol).await;
    let (_, listed) = s.get("/_telium/v1/conversations", Some(&alice.home)).await;
    assert_eq!(listed["conversations"][0]["id"], newer.as_str(), "{listed}");

    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    dm_send(&s, &older, &alice, "ct-bump").await;
    let (_, listed) = s.get("/_telium/v1/conversations", Some(&alice.home)).await;
    assert_eq!(listed["conversations"][0]["id"], older.as_str(), "{listed}");
    assert!(listed["conversations"][0]["last_activity_at"].as_i64().unwrap() > 0, "{listed}");
}
