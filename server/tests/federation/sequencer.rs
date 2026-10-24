use super::*;

#[tokio::test]
async fn the_sequencer_holds_declared_changes_to_a_groups_policy() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let carol = register_full(&a, "carol").await;
    let _dave = register_full(&a, "dave").await;
    let _bob = register_full(&b, "bob").await;
    let managed = json!({ "v": 1, "add": "admins", "remove": "admins", "policy": "creator", "admins": [] });

    let (status, refused) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "dm", "members": ["@bob:b.test"], "welcome": "w", "policy": managed }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let mut stolen = managed.clone();
    stolen["creator"] = json!("@carol:a.test");
    let (status, refused) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@carol:a.test", "@bob:b.test"], "welcome": "w", "policy": stolen }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let mut outsider = managed.clone();
    outsider["admins"] = json!(["@dave:a.test"]);
    let (status, refused) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@carol:a.test", "@bob:b.test"], "welcome": "w", "policy": outsider }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@carol:a.test", "@bob:b.test"], "welcome": "w", "policy": managed }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    let here = format!("/_telium/v1/conversations/{conv_id}");
    let frames = format!("{here}/messages");
    let members = format!("{here}/members");
    let (_, seen) = a.get(&here, Some(&alice.token)).await;
    assert_eq!(seen["policy"]["creator"], "@alice:a.test");
    assert_eq!(seen["policy"]["add"], "admins");

    let (status, refused) = a
        .post(
            &frames,
            Some(&carol.token),
            json!({ "kind": "commit", "ciphertext": "c-add", "epoch": 1,
                    "change": { "op": "add", "user_ids": ["@dave:a.test"] } }),
        )
        .await;
    assert_eq!(status, 403, "{refused}");
    let (status, refused) = a.post(&members, Some(&carol.token), json!({ "user_id": "@dave:a.test" })).await;
    assert_eq!(status, 403, "{refused}");
    let (status, refused) = a
        .delete_json(&members, &carol.token, json!({ "user_id": "@bob:b.test", "commit": "c-rm" }))
        .await;
    assert_eq!(status, 403, "{refused}");

    let mut promoted = managed.clone();
    promoted["admins"] = json!(["@carol:a.test"]);
    let (status, refused) = a
        .post(
            &frames,
            Some(&carol.token),
            json!({ "kind": "commit", "ciphertext": "c-policy", "epoch": 1,
                    "change": { "op": "policy", "policy": promoted } }),
        )
        .await;
    assert_eq!(status, 403, "{refused}");

    let (status, refused) = a
        .post(
            &frames,
            Some(&alice.token),
            json!({ "kind": "commit", "ciphertext": "a-steal", "epoch": 1,
                    "change": { "op": "policy", "policy": stolen } }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");

    let (_, untouched) = a.get(&frames, Some(&alice.token)).await;
    assert_eq!(untouched["messages"].as_array().unwrap().len(), 1, "only the welcome: {untouched}");

    let (status, granted) = a
        .post(
            &frames,
            Some(&alice.token),
            json!({ "kind": "commit", "ciphertext": "a-policy", "epoch": 1,
                    "change": { "op": "policy", "policy": promoted } }),
        )
        .await;
    assert_eq!(status, 200, "{granted}");
    let (_, seen) = a.get(&here, Some(&alice.token)).await;
    assert_eq!(seen["policy"]["admins"], json!(["@carol:a.test"]));

    let (status, added) = a
        .post(
            &frames,
            Some(&carol.token),
            json!({ "kind": "commit", "ciphertext": "c-add-2", "epoch": 2,
                    "change": { "op": "add", "user_ids": ["@dave:a.test"] } }),
        )
        .await;
    assert_eq!(status, 200, "{added}");
    let (_, seen) = a.get(&here, Some(&alice.token)).await;
    assert!(
        seen["members"].as_array().unwrap().iter().any(|m| m["user_id"] == "@dave:a.test"),
        "{seen}"
    );

    let (status, refused) = a.delete(&format!("{here}/policy"), &carol.token).await;
    assert_eq!(status, 403, "{refused}");
    let (status, refused) = a.delete(&format!("{here}/policy"), &alice.token).await;
    assert_eq!(status, 409, "{refused}");
}

#[tokio::test]
async fn a_policy_the_group_could_not_carry_is_withdrawn_by_its_creator() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let carol = register_full(&a, "carol").await;
    let _dave = register_full(&a, "dave").await;
    let _bob = register_full(&b, "bob").await;
    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@carol:a.test", "@bob:b.test"], "welcome": "w",
                    "policy": { "v": 1, "add": "creator", "remove": "creator", "policy": "creator", "admins": [] } }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    let here = format!("/_telium/v1/conversations/{conv_id}");

    let (status, refused) = a.delete(&format!("{here}/policy"), &carol.token).await;
    assert_eq!(status, 403, "{refused}");
    let (status, open) = a.delete(&format!("{here}/policy"), &alice.token).await;
    assert_eq!(status, 200, "{open}");
    assert!(open["policy"].is_null(), "{open}");

    let (status, added) = a
        .post(
            &format!("{here}/messages"),
            Some(&carol.token),
            json!({ "kind": "commit", "ciphertext": "c-add", "epoch": 1,
                    "change": { "op": "add", "user_ids": ["@dave:a.test"] } }),
        )
        .await;
    assert_eq!(status, 200, "{added}");
}

#[tokio::test]
async fn a_member_home_fills_a_gap_from_the_sequencer() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 6).await;
    assert_eq!(seqs(&b, &conv_id).await, vec![1, 2, 3, 4, 5, 6, 7]);

    sqlx::query("DELETE FROM dm_messages WHERE conversation_id = ? AND seq IN (3, 5)")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();

    let page = telium_server::federation::get_signed(
        &b.state,
        "a.test",
        &format!("/_telium/v1/dm/frames/{conv_id}/4"),
    )
    .await
    .unwrap();
    let got: Vec<i64> = page["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(got, vec![5, 6, 7]);
    assert_eq!(page["last_seq"], 7);

    let refused = telium_server::federation::get_signed(
        &c.state,
        "a.test",
        &format!("/_telium/v1/dm/frames/{conv_id}/0"),
    )
    .await;
    assert_eq!(refused.unwrap_err().status().as_u16(), 403);

    let read = history(&b, &bob, &conv_id, "?after=1&limit=100").await;
    let got: Vec<i64> = read["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(got, vec![2, 3, 4, 5, 6, 7], "{read}");
    assert!(read.get("incomplete").is_none(), "{read}");
    assert_eq!(seqs(&b, &conv_id).await, vec![1, 2, 3, 4, 5, 6, 7]);
    let ct: String = sqlx::query_scalar("SELECT ciphertext FROM dm_messages WHERE conversation_id = ? AND seq = 3")
        .bind(&conv_id)
        .fetch_one(&b.state.pool)
        .await
        .unwrap();
    assert_eq!(ct, "frame-1");
}

#[tokio::test]
async fn a_gap_the_sequencer_cannot_fill_stops_the_read_below_it() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 4).await;
    let _gone = take_offline(a);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    sqlx::query("DELETE FROM dm_messages WHERE conversation_id = ? AND seq = 3")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();

    let read = history(&b, &bob, &conv_id, "?after=0").await;
    let got: Vec<i64> = read["messages"].as_array().unwrap().iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(got, vec![1, 2], "{read}");
    assert_eq!(read["incomplete"], true);
    assert_eq!(read["missing_from"], 3);

    let tail = history(&b, &bob, &conv_id, "?tail=10").await;
    assert_eq!(tail["messages"].as_array().unwrap().len(), 4);
    assert!(tail.get("incomplete").is_none());
}

#[tokio::test]
async fn a_late_frame_after_a_gap_makes_the_member_home_ask_for_the_rest() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 3).await;
    sqlx::query("DELETE FROM dm_messages WHERE conversation_id = ? AND seq > 2")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET last_seq = 2 WHERE id = ?")
        .bind(&conv_id)
        .execute(&b.state.pool)
        .await
        .unwrap();
    let (status, _) = a
        .post(
            &format!("/_telium/v1/conversations/{conv_id}/messages"),
            Some(&alice.token),
            json!({ "ciphertext": "frame-late", "epoch": 1 }),
        )
        .await;
    assert_eq!(status, 200);
    for _ in 0..100 {
        if seqs(&b, &conv_id).await == vec![1, 2, 3, 4, 5] {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("the gap was not repaired: {:?}", seqs(&b, &conv_id).await);
}

#[tokio::test]
async fn an_ordered_commit_outlasts_any_outage_and_lands_in_order() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 1).await;
    let path = format!("/_telium/v1/conversations/{conv_id}/messages");

    let gone = take_offline(b);
    let (status, sent) = a
        .post(&path, Some(&alice.token), json!({ "kind": "commit", "ciphertext": "c1", "epoch": 1 }))
        .await;
    assert_eq!(status, 200, "{sent}");
    let ordered = sent["seq"].as_i64().unwrap();
    let row: String = sqlx::query_scalar(
        "SELECT id FROM dm_outbox WHERE conversation_id = ? AND destination = 'b.test'",
    )
    .bind(&conv_id)
    .fetch_one(&a.state.pool)
    .await
    .unwrap();

    for attempts in [40, 100] {
        sqlx::query("UPDATE dm_outbox SET attempts = ?, next_attempt_at = 0 WHERE id = ?")
            .bind(attempts)
            .bind(&row)
            .execute(&a.state.pool)
            .await
            .unwrap();
        telium_server::routes::dm::flush_outbox(&a.state).await.unwrap();
        assert_eq!(outbox_row(&a, &row).await.map(|r| r.0), Some(attempts + 1), "the commit was dropped");
    }

    let b = bring_back(gone).await;
    sqlx::query("UPDATE dm_outbox SET next_attempt_at = 0 WHERE id = ?")
        .bind(&row)
        .execute(&a.state.pool)
        .await
        .unwrap();
    telium_server::routes::dm::flush_outbox(&a.state).await.unwrap();
    drained(&a, &conv_id).await;
    let held = history(&b, &bob, &conv_id, "").await;
    let last = held["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["seq"].as_i64(), last["kind"].as_str()), (Some(ordered), Some("commit")));
    assert_eq!(seqs(&b, &conv_id).await, seqs(&a, &conv_id).await);

    let (status, next) = b
        .post(&path, Some(&bob.token), json!({ "kind": "commit", "ciphertext": "c2", "epoch": 2 }))
        .await;
    assert_eq!(status, 200, "{next}");
    assert_eq!(next["seq"].as_i64(), Some(ordered + 1));
}

#[tokio::test]
async fn a_conversation_re_anchors_across_three_homes_and_every_home_converges() {
    let (a, b, c) = trio().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let carol = register_full(&c, "carol").await;
    let (status, conv) = a
        .post(
            "/_telium/v1/conversations",
            Some(&alice.token),
            json!({ "kind": "gc", "members": ["@bob:b.test", "@carol:c.test"], "welcome": "gc-welcome" }),
        )
        .await;
    assert_eq!(status, 200, "{conv}");
    let conv_id = conv["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/conversations/{conv_id}/messages");
    let homes = [(&a, &alice), (&b, &bob), (&c, &carol)];
    let settle = || async {
        for (home, _) in homes {
            drained(home, &conv_id).await;
        }
    };
    settle().await;

    let sent_from_each = |label: &'static str, epoch: i64| {
        let path = path.clone();
        async move {
            for (home, who) in homes {
                let (status, sent) = home
                    .post(&path, Some(&who.token), json!({ "ciphertext": format!("{label}-{}", home.name), "epoch": epoch }))
                    .await;
                assert_eq!(status, 200, "{label} from {}: {sent}", home.name);
            }
        }
    };
    sent_from_each("at-a", 1).await;
    let (status, sent) = b
        .post(&path, Some(&bob.token), json!({ "kind": "commit", "ciphertext": "c1", "epoch": 1 }))
        .await;
    assert_eq!(status, 200, "{sent}");
    settle().await;

    let (status, first) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/reanchor"), Some(&alice.token), json!({ "sequencer": "b.test" }))
        .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!((first["handoff"]["from"].as_str(), first["handoff"]["n"].as_i64()), (Some("a.test"), Some(1)));
    settle().await;
    sent_from_each("at-b", 2).await;
    let (status, sent) = c
        .post(&path, Some(&carol.token), json!({ "kind": "commit", "ciphertext": "c2", "epoch": 2 }))
        .await;
    assert_eq!(status, 200, "{sent}");
    settle().await;

    let (status, second) = a
        .post(&format!("/_telium/v1/conversations/{conv_id}/reanchor"), Some(&alice.token), json!({ "sequencer": "c.test" }))
        .await;
    assert_eq!(status, 200, "{second}");
    assert_eq!((second["handoff"]["from"].as_str(), second["handoff"]["n"].as_i64()), (Some("b.test"), Some(2)));
    settle().await;
    sent_from_each("at-c", 3).await;
    let (status, sent) = a
        .post(&path, Some(&alice.token), json!({ "kind": "commit", "ciphertext": "c3", "epoch": 3 }))
        .await;
    assert_eq!(status, 200, "{sent}");
    let (status, stale) = b
        .post(&path, Some(&bob.token), json!({ "kind": "commit", "ciphertext": "stale-c3", "epoch": 3 }))
        .await;
    assert_eq!(status, 409, "a second commit at one epoch, across a move: {stale}");
    settle().await;

    let reference = history(&c, &carol, &conv_id, "?limit=500").await["messages"].clone();
    let order = reference.as_array().unwrap();
    assert_eq!(order.len(), 1 + 3 + 1 + 3 + 1 + 3 + 1, "{reference}");
    let seqs_now: Vec<i64> = order.iter().map(|m| m["seq"].as_i64().unwrap()).collect();
    assert_eq!(seqs_now, (1..=order.len() as i64).collect::<Vec<_>>(), "no hole and no repeat");
    for (home, who) in homes {
        let held = eventually(home, &format!("/_telium/v1/conversations/{conv_id}"), &who.token, |v| {
            v["sequencer"] == "c.test" && v["last_seq"].as_i64() == Some(order.len() as i64)
        })
        .await;
        assert_eq!(held["epoch"], 3, "{} holds {held}", home.name);
        let theirs = history(home, who, &conv_id, "?limit=500").await["messages"].clone();
        let pick = |v: &Value| -> Vec<(i64, String, String)> {
            v.as_array().unwrap().iter()
                .map(|m| (m["seq"].as_i64().unwrap(), m["kind"].as_str().unwrap().to_string(), m["ciphertext"].as_str().unwrap().to_string()))
                .collect()
        };
        assert_eq!(pick(&theirs), pick(&reference), "{} holds another order", home.name);
    }

    for (from, sender, old) in [
        (&c, "@carol:c.test", "a.test"),
        (&c, "@carol:c.test", "b.test"),
        (&a, "@alice:a.test", "b.test"),
        (&b, "@bob:b.test", "a.test"),
    ] {
        let refused = telium_server::federation::post_signed(
            &from.state,
            old,
            "/_telium/v1/dm/submit",
            &json!({
                "conversation_id": conv_id, "kind": "application", "sender": sender,
                "ciphertext": "to-an-old-sequencer", "epoch": 3,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.code(), "not_sequencer", "{old} asked by {}: {refused:?}", from.name);
    }
}

async fn queue_delivery(a: &Server, conv_id: &str, kind: &str, sequencer: &str, attempts: i64) -> String {
    let id = format!("outbox-{kind}-{sequencer}-{attempts}");
    let payload = json!({
        "conversation": { "id": conv_id, "kind": "gc", "sequencer": sequencer, "members": [] },
        "message": { "id": format!("m-{id}"), "seq": 999, "epoch": 1, "kind": kind, "ciphertext": "x" },
    });
    sqlx::query(
        "INSERT INTO dm_outbox (id, conversation_id, message_id, destination, path, payload, attempts, \
         next_attempt_at, created_at) VALUES (?, ?, ?, 'b.test', '/_telium/v1/dm/deliver', ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(conv_id)
    .bind(format!("m-{id}"))
    .bind(payload.to_string())
    .bind(attempts)
    .bind(now_ms())
    .execute(&a.state.pool)
    .await
    .unwrap();
    id
}

async fn outbox_row(a: &Server, id: &str) -> Option<(i64, i64)> {
    sqlx::query_as("SELECT attempts, next_attempt_at FROM dm_outbox WHERE id = ?")
        .bind(id)
        .fetch_optional(&a.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn commits_are_never_dead_lettered_and_a_refusal_is_not_a_delay() {
    let (a, b) = pair().await;
    let alice = register_full(&a, "alice").await;
    let bob = register_full(&b, "bob").await;
    let conv_id = group_with_frames(&a, &b, &alice, &bob, 1).await;
    let longest = a.state.cfg.federation.dm_retry_secs as i64 * 1000 * 1024;

    let app = queue_delivery(&a, &conv_id, "application", "c.test", 0).await;
    let commit = queue_delivery(&a, &conv_id, "commit", "c.test", 0).await;
    let orphan = queue_delivery(&a, "conversation-that-is-gone", "welcome", "c.test", 0).await;
    let before = now_ms();
    telium_server::routes::dm::flush_outbox(&a.state).await.unwrap();
    assert_eq!(outbox_row(&a, &app).await, None, "an ordinary frame is dropped on a refusal");
    let (attempts, next) = outbox_row(&a, &commit).await.expect("a commit is kept");
    assert_eq!(attempts, 1);
    assert!(next >= before + longest, "and parked at the longest backoff, not hammered");
    assert_eq!(outbox_row(&a, &orphan).await, None, "unless its conversation is gone");
    sqlx::query("DELETE FROM dm_outbox").execute(&a.state.pool).await.unwrap();

    let _gone = take_offline(b);
    let app = queue_delivery(&a, &conv_id, "application", "a.test", 0).await;
    let tired_app = queue_delivery(&a, &conv_id, "application", "a.test", 40).await;
    let tired_commit = queue_delivery(&a, &conv_id, "commit", "a.test", 40).await;
    let before = now_ms();
    telium_server::routes::dm::flush_outbox(&a.state).await.unwrap();
    let (attempts, next) = outbox_row(&a, &app).await.expect("a delay is retried");
    assert_eq!(attempts, 1);
    assert!(next < before + longest, "on the ordinary schedule");
    assert_eq!(outbox_row(&a, &tired_app).await, None);
    assert_eq!(outbox_row(&a, &tired_commit).await.map(|r| r.0), Some(41));
}
