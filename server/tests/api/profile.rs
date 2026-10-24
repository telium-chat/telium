use super::*;

fn without_envelope(doc: &Value) -> String {
    let mut copy = doc.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("signature");
        object.remove("key_id");
    }
    copy.to_string()
}

#[tokio::test]
async fn public_profile_page_obeys_its_own_privacy_controls() {
    const STATUS: &str = "peregrine-custom-status-sentinel";
    const ACTIVITY: &str = "peregrine-activity-sentinel";
    let s = start().await;
    let alice = s.user("public-profile-alice").await;
    let path = format!("/_telium/v1/users/{}/public-page", alice.user_id);
    let _ = s.state.hub
        .set_presence(
            &alice.user_id,
            telium_server::gateway::hub::Presence {
                status: "dnd".into(),
                custom_status: Some(STATUS.into()),
                activity: Some(format!(
                    "telium-rich-v1:{}",
                    json!({ "type": 0, "application_id": "app-1", "name": ACTIVITY })
                )),
                rich_activities: Vec::new(),
                updated_at: telium_server::util::now_ms(),
            },
            true,
        )
        .await;

    let (status, page, headers) = s.get_with_headers(&path, None).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(headers.get("cache-control").and_then(|v| v.to_str().ok()), Some("no-store"));
    assert_eq!(page["presence_known"], true, "{page}");
    let mut keys: Vec<&str> = page["profile"].as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec![
            "accent_color", "avatar_ref", "banner_ref", "bio", "created_at", "display_name",
            "is_bot", "profile_version", "pronouns", "theme_colors", "updated_at", "user_id",
        ],
        "public page leaked a field outside the profile allowlist"
    );

    let status_keys = [STATUS, "custom_status", "\"status\"", "dnd"];
    let activity_keys = [ACTIVITY, "rich_activity", "\"activity\""];
    for (status_on, activity_on) in [(false, false), (true, false), (false, true)] {
        let (code, patched) = s
            .patch(
                "/_telium/v1/profile",
                &alice.home,
                json!({ "public_status_enabled": status_on, "public_activity_enabled": activity_on }),
            )
            .await;
        assert_eq!(code, 200, "{patched}");
        let (_, page) = s.get(&path, None).await;
        let body = without_envelope(&page);
        for (on, needles) in [(status_on, &status_keys[..]), (activity_on, &activity_keys[..])] {
            for needle in needles {
                assert_eq!(body.contains(needle), on, "{needle:?} with switch on={on}: {body}");
            }
        }
    }

    let switches = ["public_page_enabled", "public_status_enabled", "public_activity_enabled"];
    let (_, whoami) = s.get("/_telium/v1/whoami", Some(&alice.home)).await;
    for switch in switches {
        assert!(whoami["profile"][switch].is_boolean(), "{whoami}");
    }
    let (_, page) = s.get(&path, None).await;
    let (status, profile) = s.get(&format!("/_telium/v1/users/{}/profile", alice.user_id), None).await;
    assert_eq!(status, 200, "{profile}");
    for doc in [&page, &profile] {
        let body = without_envelope(doc);
        assert!(!switches.iter().any(|sw| body.contains(sw)), "a privacy switch leaked: {body}");
    }

    s.patch("/_telium/v1/profile", &alice.home, json!({ "public_page_enabled": false })).await;
    let (status, refused) = s.get(&path, None).await;
    assert_eq!(status, 404);
    assert!(!refused.to_string().contains(STATUS) && !refused.to_string().contains(&alice.user_id));
    let (status, _) = s.get(&format!("/_telium/v1/users/{}/profile", alice.user_id), None).await;
    assert_eq!(status, 200);
}

#[tokio::test]
async fn every_reason_a_public_page_is_missing_answers_with_the_same_headers() {
    let s = start().await;
    let hidden = s.user("identical-404-hidden").await;
    s.patch("/_telium/v1/profile", &hidden.home, json!({ "public_page_enabled": false })).await;
    let sleeper = s.user("identical-404-sleeper").await;
    let (status, done) = s
        .post(
            "/_telium/v1/account/deactivate",
            Some(&sleeper.home),
            json!({ "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "{done}");

    let mut answers = Vec::new();
    for user_id in [
        hidden.user_id.as_str(),
        sleeper.user_id.as_str(),
        "@nobody-at-all:test.example",
        "@also-nobody:test.example",
    ] {
        let (status, body, headers) =
            s.get_with_headers(&format!("/_telium/v1/users/{user_id}/public-page"), None).await;
        let headers: Vec<(String, String)> = headers
            .iter()
            .filter(|(name, _)| name.as_str() != "date")
            .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        answers.push((user_id, status, body, headers));
    }
    assert_eq!(answers[0].1, 404);
    for answer in &answers[1..] {
        assert_eq!(
            (answer.1, &answer.2, &answer.3),
            (answers[0].1, &answers[0].2, &answers[0].3),
            "{} answers differently from a hidden page",
            answer.0
        );
    }
}

#[tokio::test]
async fn an_identity_only_home_says_it_cannot_know_rather_than_answering_offline() {
    let s = start_with(|cfg| cfg.roles.guild = false).await;
    let (_, body) = s
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": "identity-only-alice", "password": "correct horse battery" }),
        )
        .await;
    let home = body["access_token"].as_str().unwrap().to_string();
    let user_id = body["user_id"].as_str().unwrap().to_string();
    s.patch("/_telium/v1/profile", &home, json!({ "public_status_enabled": true })).await;
    let (status, page) = s.get(&format!("/_telium/v1/users/{user_id}/public-page"), None).await;
    assert_eq!(status, 200, "{page}");
    assert_eq!(page["presence_known"], false, "{page}");
    assert!(page["presence"].as_object().is_some_and(|p| p.is_empty()), "{page}");
}

#[tokio::test]
async fn the_anonymous_public_page_spends_the_ordinary_read_budget() {
    let s = start_with(|cfg| {
        cfg.rate_limit.read_burst = 5;
        cfg.rate_limit.read_per_sec = 0.01;
    })
    .await;
    let alice = s.user("rate-limited-alice").await;
    let path = format!("/_telium/v1/users/{}/public-page", alice.user_id);
    let mut refused_after = None;
    for attempt in 1..=20 {
        if s.get(&path, None).await.0 == 429 {
            refused_after = Some(attempt);
            break;
        }
    }
    let refused_after = refused_after.expect("an unlimited anonymous endpoint is a free crawler");
    assert!(refused_after > 5, "refused on attempt {refused_after}");
    let (status, _) = s.get(&format!("/_telium/v1/users/{}/profile", alice.user_id), None).await;
    assert_eq!(status, 429, "the public page has a budget of its own");
}
