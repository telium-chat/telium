use super::*;

#[tokio::test]
async fn the_role_hierarchy_is_moved_whole_and_never_over_your_own_head() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let path = format!("/_telium/v1/guilds/{gid}/roles");
    let mut ids = Vec::new();
    for name in ["Mods", "Helpers", "Members"] {
        let (_, role) = s
            .post(&path, Some(&alice.token),
                json!({ "name": name, "permissions": ["KICK_MEMBERS"] }))
            .await;
        assert_eq!(role["position"], json!(1), "{role}");
        assert_eq!(role["hoist"], json!(false), "{role}");
        assert_eq!(role["member_count"], json!(0), "{role}");
        ids.push(role["id"].as_str().unwrap().to_string());
    }
    let (mods, helpers, members) = (ids[0].clone(), ids[1].clone(), ids[2].clone());

    let (_, listed) = s.get(&path, Some(&alice.token)).await;
    let everyone = listed["roles"].as_array().unwrap().iter()
        .find(|r| r["id"] == json!(gid)).unwrap();
    assert_eq!(everyone["member_count"], json!(2), "{listed}");

    let (status, moved) = s
        .patch(&path, &alice.token, json!({ "roles": [
            { "id": helpers, "position": 3 },
            { "id": mods, "position": 2 },
            { "id": members, "position": 1 },
        ] }))
        .await;
    assert_eq!(status, 200, "{moved}");
    let order: Vec<&str> = moved["roles"].as_array().unwrap().iter()
        .map(|r| r["id"].as_str().unwrap()).collect();
    assert_eq!(order, vec![helpers.as_str(), mods.as_str(), members.as_str(), gid.as_str()]);

    let (status, _) = s
        .patch(&path, &alice.token, json!({ "roles": [{ "id": gid, "position": 4 }] })).await;
    assert_eq!(status, 400);
    let (status, _) = s
        .patch(&path, &alice.token, json!({ "roles": [{ "id": mods, "position": 0 }] })).await;
    assert_eq!(status, 400);

    s.patch(&format!("{path}/{mods}"), &alice.token,
        json!({ "permissions": ["MANAGE_ROLES", "KICK_MEMBERS"] })).await;
    s.patch(&format!("/_telium/v1/guilds/{gid}/members/{}", bob.user_id), &alice.token,
        json!({ "add_roles": [mods] })).await;

    let (status, ok) = s
        .patch(&path, &bob.token, json!({ "roles": [{ "id": members, "position": 1 }] })).await;
    assert_eq!(status, 200, "{ok}");
    let (status, _) = s
        .patch(&path, &bob.token, json!({ "roles": [{ "id": helpers, "position": 1 }] })).await;
    assert_eq!(status, 403);
    let (status, _) = s
        .patch(&path, &bob.token, json!({ "roles": [{ "id": members, "position": 3 }] })).await;
    assert_eq!(status, 403);

    let (status, _) = s
        .patch(&path, &alice.token, json!({ "roles": [
            { "id": members, "position": 2 },
            { "id": "01NOSUCHROLE", "position": 1 },
        ] }))
        .await;
    assert_eq!(status, 404);
    let (_, after) = s.get(&path, Some(&alice.token)).await;
    let row = after["roles"].as_array().unwrap().iter()
        .find(|r| r["id"] == json!(members)).unwrap();
    assert_eq!(row["position"], json!(1), "{after}");
}

#[tokio::test]
async fn a_role_answers_for_its_own_members() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let roles = format!("/_telium/v1/guilds/{gid}/roles");
    let (_, role) = s.post(&roles, Some(&alice.token), json!({ "name": "Mods" })).await;
    let role_id = role["id"].as_str().unwrap().to_string();
    s.patch(&format!("/_telium/v1/guilds/{gid}/members/{}", bob.user_id), &alice.token,
        json!({ "add_roles": [role_id] })).await;

    let members = format!("/_telium/v1/guilds/{gid}/members");
    let (_, held) = s.get(&format!("{members}?role={role_id}"), Some(&alice.token)).await;
    let who: Vec<&str> = held["members"].as_array().unwrap().iter()
        .map(|m| m["user_id"].as_str().unwrap()).collect();
    assert_eq!(who, vec![bob.user_id.as_str()], "{held}");

    let (_, counted) = s.get(&roles, Some(&alice.token)).await;
    let row = counted["roles"].as_array().unwrap().iter()
        .find(|r| r["id"] == json!(role_id)).unwrap();
    assert_eq!(row["member_count"], json!(1), "{counted}");

    let (_, all) = s.get(&format!("{members}?role={gid}"), Some(&alice.token)).await;
    assert_eq!(all["members"].as_array().unwrap().len(), 2, "{all}");

    let (_, found) = s.get(&format!("{members}?q=bob"), Some(&alice.token)).await;
    let who: Vec<&str> = found["members"].as_array().unwrap().iter()
        .map(|m| m["user_id"].as_str().unwrap()).collect();
    assert_eq!(who, vec![bob.user_id.as_str()], "{found}");

    let (_, none) = s.get(&format!("{members}?q=%25"), Some(&alice.token)).await;
    assert!(none["members"].as_array().unwrap().is_empty(), "{none}");
}

#[tokio::test]
async fn role_positions_are_dense_so_the_hierarchy_can_be_dragged() {
    let s = start().await;
    let alice = s.user("alice").await;
    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let path = format!("/_telium/v1/guilds/{gid}/roles");

    let ranked = |body: &Value| -> Vec<(String, i64)> {
        body["roles"].as_array().unwrap().iter()
            .map(|r| (r["id"].as_str().unwrap().to_string(), r["position"].as_i64().unwrap()))
            .collect()
    };

    let mut ids = Vec::new();
    for name in ["One", "Two", "Three"] {
        let (_, role) = s.post(&path, Some(&alice.token), json!({ "name": name })).await;
        ids.push(role["id"].as_str().unwrap().to_string());
    }

    let (_, listed) = s.get(&path, Some(&alice.token)).await;
    assert_eq!(
        ranked(&listed),
        vec![
            (ids[0].clone(), 3),
            (ids[1].clone(), 2),
            (ids[2].clone(), 1),
            (gid.clone(), 0),
        ],
        "{listed}",
    );

    let (status, _) = s.delete(&format!("{path}/{}", ids[1]), &alice.token).await;
    assert_eq!(status, 200);
    let (_, after) = s.get(&path, Some(&alice.token)).await;
    assert_eq!(
        ranked(&after),
        vec![(ids[0].clone(), 2), (ids[2].clone(), 1), (gid.clone(), 0)],
        "{after}",
    );

    let (_, fresh) = s.post(&path, Some(&alice.token), json!({ "name": "Four" })).await;
    assert_eq!(fresh["position"], json!(1), "{fresh}");
    let (_, last) = s.get(&path, Some(&alice.token)).await;
    assert_eq!(
        ranked(&last),
        vec![
            (ids[0].clone(), 3),
            (ids[2].clone(), 2),
            (fresh["id"].as_str().unwrap().to_string(), 1),
            (gid.clone(), 0),
        ],
        "{last}",
    );
}

#[tokio::test]
async fn channel_order_and_categories_are_the_guilds_own() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;

    let (_, guild) =
        s.post("/_telium/v1/guilds", Some(&alice.token), json!({ "name": "Guild" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&alice.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&bob.token), json!({})).await;

    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&alice.token)).await;
    let general = channels["channels"][0]["id"].as_str().unwrap().to_string();

    let path = format!("/_telium/v1/guilds/{gid}/channels");
    let (_, category) = s
        .post(&path, Some(&alice.token), json!({ "name": "Text", "type": "category" }))
        .await;
    let category = category["id"].as_str().unwrap().to_string();
    let (_, second) = s.post(&path, Some(&alice.token), json!({ "name": "second" })).await;
    let second = second["id"].as_str().unwrap().to_string();

    let (status, moved) = s
        .patch(
            &path,
            &alice.token,
            json!({ "channels": [
                { "id": second, "position": 0, "parent_id": null },
                { "id": category, "position": 1 },
                { "id": general, "position": 2, "parent_id": category },
            ] }),
        )
        .await;
    assert_eq!(status, 200, "{moved}");

    let (_, his) = s.get(&path, Some(&bob.token)).await;
    let order: Vec<&str> = his["channels"].as_array().unwrap()
        .iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(order, vec![second.as_str(), category.as_str(), general.as_str()], "{his}");
    assert_eq!(his["channels"][2]["parent_id"], json!(category));

    let (status, _) = s
        .patch(&path, &bob.token, json!({ "channels": [{ "id": general, "position": 0 }] }))
        .await;
    assert_eq!(status, 403);

    let (status, _) = s
        .patch(&path, &alice.token,
            json!({ "channels": [{ "id": category, "position": 0, "parent_id": category }] }))
        .await;
    assert_eq!(status, 400);
    let (status, _) = s
        .patch(&path, &alice.token,
            json!({ "channels": [{ "id": general, "position": 0, "parent_id": second }] }))
        .await;
    assert_eq!(status, 400);
    let (status, _) = s
        .patch(&path, &alice.token,
            json!({ "channels": [{ "id": "01NOSUCHCHANNEL", "position": 0 }] }))
        .await;
    assert_eq!(status, 404);

    let (status, _) = s.delete(&format!("/_telium/v1/channels/{category}"), &alice.token).await;
    assert_eq!(status, 200);
    let (_, after) = s.get(&path, Some(&bob.token)).await;
    let general_row = after["channels"].as_array().unwrap()
        .iter().find(|c| c["id"] == json!(general)).unwrap();
    assert_eq!(general_row["parent_id"], json!(null), "{after}");
}

#[tokio::test]
async fn a_forum_post_keeps_its_body_and_wears_the_forums_tags() {
    let (s, alice, bob, gid, _cid) = social_fixture().await;

    let (status, forum) = s
        .post(
            &format!("/_telium/v1/guilds/{gid}/channels"),
            Some(&alice.token),
            json!({
                "name": "help", "type": "forum",
                "available_tags": [
                    { "name": "question" },
                    { "name": "solved", "moderated": true },
                ],
            }),
        )
        .await;
    assert_eq!(status, 200, "{forum}");
    let fid = forum["id"].as_str().unwrap().to_string();
    let question = forum["available_tags"][0]["id"].as_str().unwrap().to_string();
    let solved = forum["available_tags"][1]["id"].as_str().unwrap().to_string();
    assert_eq!(forum["default_layout"], "list");

    let (status, refused) = s
        .post(&format!("/_telium/v1/channels/{fid}/threads"), Some(&bob.token), json!({ "title": "hm" }))
        .await;
    assert_eq!(status, 400, "{refused}");

    let (status, _) = s
        .post(
            &format!("/_telium/v1/channels/{fid}/threads"),
            Some(&bob.token),
            json!({ "title": "how do I", "content": "the thing", "tags": [solved] }),
        )
        .await;
    assert_eq!(status, 403);

    let (status, post) = s
        .post(
            &format!("/_telium/v1/channels/{fid}/threads"),
            Some(&bob.token),
            json!({ "title": "how do I federate", "content": "asking here", "tags": [question] }),
        )
        .await;
    assert_eq!(status, 200, "{post}");
    let pid = post["id"].as_str().unwrap().to_string();

    assert_eq!(post["opening"]["content"], "asking here");
    assert_eq!(post["opening"]["author"], bob.user_id.as_str());
    assert_eq!(post["message_count"], 1);
    assert_eq!(post["tags"][0], question.as_str());
    let (_, history) = s.get(&format!("/_telium/v1/channels/{pid}/messages"), Some(&alice.token)).await;
    assert_eq!(history["messages"][0]["content"], "asking here");

    let (status, _) = s
        .post(
            &format!("/_telium/v1/channels/{fid}/threads"),
            Some(&bob.token),
            json!({ "title": "nope", "content": "x", "tags": ["made-up"] }),
        )
        .await;
    assert_eq!(status, 400);

    let (_, second) = s
        .post(
            &format!("/_telium/v1/channels/{fid}/threads"),
            Some(&alice.token),
            json!({ "title": "read me first", "content": "rules" }),
        )
        .await;
    let rules = second["id"].as_str().unwrap().to_string();
    s.post(&format!("/_telium/v1/channels/{pid}/messages"), Some(&alice.token), json!({ "content": "bump" }))
        .await;
    let (_, by_activity) = s.get(&format!("/_telium/v1/channels/{fid}/threads"), Some(&bob.token)).await;
    assert_eq!(by_activity["threads"][0]["id"], pid.as_str(), "the bumped post is what is going on");
    let (_, by_age) = s
        .get(&format!("/_telium/v1/channels/{fid}/threads?sort=creation"), Some(&bob.token))
        .await;
    assert_eq!(by_age["threads"][0]["id"], rules.as_str(), "the newest post is what is new");

    let (status, _) = s.patch(&format!("/_telium/v1/threads/{rules}"), &bob.token, json!({ "pinned": true })).await;
    assert_eq!(status, 403, "pinning is a claim on everybody's screen");
    let (status, _) = s.patch(&format!("/_telium/v1/threads/{rules}"), &alice.token, json!({ "pinned": true })).await;
    assert_eq!(status, 200);

    let (_, listed) = s.get(&format!("/_telium/v1/channels/{fid}/threads"), Some(&bob.token)).await;
    assert_eq!(listed["threads"][0]["id"], rules.as_str(), "pinned first, whatever the sort");
    assert_eq!(listed["threads"][0]["pinned"], true);
    assert_eq!(listed["threads"][1]["id"], pid.as_str());

    let (status, _) = s.delete(&format!("/_telium/v1/threads/{pid}"), &alice.token).await;
    assert_eq!(status, 200);
    let (status, _) = s.get(&format!("/_telium/v1/channels/{pid}/messages"), Some(&bob.token)).await;
    assert_eq!(status, 404, "a deleted post takes its messages with it");
    let (_, left) = s.get(&format!("/_telium/v1/channels/{fid}/threads"), Some(&bob.token)).await;
    assert_eq!(left["threads"].as_array().unwrap().len(), 1);
}
