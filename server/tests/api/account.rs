use super::*;

fn decode_base32_test(input: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for ch in input.bytes() {
        let upper = ch.to_ascii_uppercase();
        let v = match upper {
            b'A'..=b'Z' => upper - b'A',
            b'2'..=b'7' => upper - b'2' + 26,
            _ => continue,
        };
        buffer = (buffer << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    out
}

fn totp_test(secret: &str) -> String {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    let key = decode_base32_test(secret);
    let counter = (telium_server::util::now_ms() / 1000 / 30) as u64;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).unwrap();
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let binary = ((u32::from(digest[offset]) & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    format!("{:06}", binary % 1_000_000)
}

#[tokio::test]
async fn totp_mfa_requires_a_second_factor_and_recovery_codes_are_one_time() {
    let s = start().await;
    let (status, registered) = s.post(
        "/_telium/v1/register",
        None,
        json!({ "localpart": "mfauser", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{registered}");
    let token = registered["access_token"].as_str().unwrap();

    let (status, _) = s.post(
        "/_telium/v1/mfa/setup",
        Some(token),
        json!({ "password": "wrong password" }),
    ).await;
    assert_eq!(status, 401);

    let (status, setup) = s.post(
        "/_telium/v1/mfa/setup",
        Some(token),
        json!({ "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{setup}");
    let secret = setup["secret"].as_str().unwrap();
    let code = totp_test(secret);

    let (status, enabled) = s.post(
        "/_telium/v1/mfa/enable",
        Some(token),
        json!({ "code": code }),
    ).await;
    assert_eq!(status, 200, "{enabled}");
    let recovery = enabled["recovery_codes"][0].as_str().unwrap().to_string();

    let (status, missing) = s.post(
        "/_telium/v1/login",
        None,
        json!({ "user": "mfauser", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 401);
    assert_eq!(missing["message"], "mfa_required");

    let (status, logged_in) = s.post(
        "/_telium/v1/login",
        None,
        json!({ "user": "mfauser", "password": "correct horse battery", "mfa_code": recovery }),
    ).await;
    assert_eq!(status, 200, "{logged_in}");

    let (status, reused) = s.post(
        "/_telium/v1/login",
        None,
        json!({ "user": "mfauser", "password": "correct horse battery", "mfa_code": recovery }),
    ).await;
    assert_eq!(status, 401);
    assert_eq!(reused["message"], "invalid_mfa_code");
}

#[tokio::test]
async fn owners_can_transfer_guilds_and_invites_can_be_revoked() {
    let s = start().await;
    let alice = s.user("owner").await;
    let bob = s.user("nextowner").await;

    let (status, guild) = s.post(
        "/_telium/v1/guilds",
        Some(&alice.token),
        json!({ "name": "Transferable" }),
    ).await;
    assert_eq!(status, 200, "{guild}");
    let guild_id = guild["id"].as_str().unwrap();

    let (status, invite) = s.post(
        &format!("/_telium/v1/guilds/{guild_id}/invites"),
        Some(&alice.token),
        json!({ "max_uses": 10, "expires_in_secs": 3600 }),
    ).await;
    assert_eq!(status, 200, "{invite}");
    let code = invite["code"].as_str().unwrap();

    let (status, list) = s.get(
        &format!("/_telium/v1/guilds/{guild_id}/invites"),
        Some(&alice.token),
    ).await;
    assert_eq!(status, 200, "{list}");
    assert!(list["invites"].as_array().unwrap().iter().any(|v| v["code"] == code));

    let (status, joined) = s.post(
        &format!("/_telium/v1/invites/{code}/join"),
        Some(&bob.token),
        json!({}),
    ).await;
    assert_eq!(status, 200, "{joined}");

    let (status, transferred) = s.post(
        &format!("/_telium/v1/guilds/{guild_id}/transfer-ownership"),
        Some(&alice.token),
        json!({ "user_id": bob.user_id }),
    ).await;
    assert_eq!(status, 200, "{transferred}");
    assert_eq!(transferred["owner"], bob.user_id);

    let (status, left) = s.post(
        &format!("/_telium/v1/guilds/{guild_id}/leave"),
        Some(&alice.token),
        json!({}),
    ).await;
    assert_eq!(status, 200, "{left}");

    let (status, _) = s.delete(
        &format!("/_telium/v1/guilds/{guild_id}/invites/{code}"),
        &bob.token,
    ).await;
    assert_eq!(status, 200);

    let (status, _) = s.get(&format!("/_telium/v1/invites/{code}"), None).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn deactivation_can_be_reversed_only_with_valid_credentials() {
    let s = start().await;
    let (status, founder) = s.post(
        "/_telium/v1/register",
        None,
        json!({ "localpart": "founder", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{founder}");
    let (status, registered) = s.post(
        "/_telium/v1/register",
        None,
        json!({ "localpart": "sleepy", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{registered}");
    let token = registered["access_token"].as_str().unwrap();

    let (status, deactivated) = s.post(
        "/_telium/v1/account/deactivate",
        Some(token),
        json!({ "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{deactivated}");

    let (status, wrong) = s.post(
        "/_telium/v1/login",
        None,
        json!({ "user": "sleepy", "password": "not the password" }),
    ).await;
    assert_eq!(status, 401);
    assert_eq!(wrong["message"], "invalid credentials");

    let (status, known) = s.post(
        "/_telium/v1/login",
        None,
        json!({ "user": "sleepy", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 401);
    assert_eq!(known["message"], "account_deactivated");

    let (status, _) = s.post(
        "/_telium/v1/account/reactivate",
        None,
        json!({ "user": "sleepy", "password": "not the password" }),
    ).await;
    assert_eq!(status, 401);

    let (status, reactivated) = s.post(
        "/_telium/v1/account/reactivate",
        None,
        json!({ "user": "sleepy", "password": "correct horse battery" }),
    ).await;
    assert_eq!(status, 200, "{reactivated}");
    assert!(reactivated["access_token"].as_str().is_some());
}

#[tokio::test]
async fn an_account_export_says_what_it_does_not_contain() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (gid, _) = shared_guild(&s, &bob, &alice).await;

    let (status, export) = s.get("/_telium/v1/account/export", Some(&alice.home)).await;
    assert_eq!(status, 200, "{export}");
    assert_eq!(export["format"], "telium-account-export-v2");
    assert_eq!(export["user_id"], alice.user_id);
    assert!(export["account"]["created_at"].is_i64(), "{export}");
    assert!(export["memberships"].to_string().contains(&gid), "{export}");
    for key in [
        "profile", "devices", "sync", "friends", "conversations", "uploads", "read_state",
        "bot_applications", "notification_devices", "not_included",
    ] {
        assert!(export[key].is_array() || export[key].is_object(), "{key} missing: {export}");
    }
    let omissions = export["not_included"].as_array().expect("not_included");
    assert!(omissions.len() >= 5, "{omissions:?}");
    for entry in omissions {
        assert!(entry["what"].as_str().is_some_and(|v| !v.is_empty()), "{entry}");
        assert!(entry["why"].as_str().is_some_and(|v| v.len() > 40), "{entry}");
        assert!(entry["instead"].as_str().is_some(), "{entry}");
    }
    let all = omissions.iter().map(|e| e.to_string()).collect::<String>();
    assert!(all.contains("other servers"), "federation is not disclosed: {all}");
}

async fn shared_guild(s: &Server, owner: &User, member: &User) -> (String, String) {
    let (_, guild) = s.post("/_telium/v1/guilds", Some(&owner.token), json!({ "name": "G" })).await;
    let gid = guild["id"].as_str().unwrap().to_string();
    let (_, invite) =
        s.post(&format!("/_telium/v1/guilds/{gid}/invites"), Some(&owner.token), json!({})).await;
    let code = invite["code"].as_str().unwrap().to_string();
    let (status, body) =
        s.post(&format!("/_telium/v1/invites/{code}/join"), Some(&member.token), json!({})).await;
    assert_eq!(status, 200, "{body}");
    let (_, channels) = s.get(&format!("/_telium/v1/guilds/{gid}/channels"), Some(&owner.token)).await;
    (gid, channels["channels"][0]["id"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn deleting_an_account_answers_gone_and_erases_its_residue() {
    let s = start().await;
    let alice = s.user("alice").await;
    let bob = s.user("bob").await;
    let (_, cid) = shared_guild(&s, &bob, &alice).await;
    let (status, sent) = s
        .post(&format!("/_telium/v1/channels/{cid}/messages"), Some(&alice.token), json!({ "content": "hi" }))
        .await;
    assert_eq!(status, 200, "{sent}");
    sqlx::query("INSERT INTO read_state (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, 0)")
        .bind(&alice.user_id)
        .bind(&cid)
        .bind(sent["id"].as_str().unwrap())
        .execute(&s.state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE accounts SET admin = 1 WHERE user_id = ?")
        .bind(&bob.user_id)
        .execute(&s.state.pool)
        .await
        .unwrap();

    let resp = s
        .client
        .delete(format!("{}/_telium/v1/account", s.base))
        .bearer_auth(&alice.home)
        .json(&json!({ "password": "correct horse battery" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.unwrap_or(json!(null));
    assert!(body["note"].as_str().unwrap_or_default().to_lowercase().contains("server"), "{body}");

    let (_, state) = s.get(&format!("/_telium/v1/users/{}/status", alice.user_id), None).await;
    assert_eq!(state["status"], "gone", "{state}");
    assert_eq!(state["tombstone"]["reason"], "account_deleted", "{state}");

    let stage: Option<String> =
        sqlx::query_scalar("SELECT stage FROM account_erasures WHERE user_id = ?")
            .bind(&alice.user_id)
            .fetch_optional(&s.state.pool)
            .await
            .unwrap();
    assert_eq!(stage.as_deref(), Some("finished"));
    for (table, column) in telium_server::erasure::RESIDUE_TABLES {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?"))
            .bind(&alice.user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} still holds rows for a deleted account");
    }
    for (table, column) in [("messages", "author_id"), ("members", "user_id")] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?"))
            .bind(&alice.user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "{table} lost a deleted account's guild history");
    }
    let (status, again) = s
        .post("/_telium/v1/register", None, json!({ "localpart": "alice", "password": "another one entirely" }))
        .await;
    assert_ne!(status, 200, "a deleted account's name was handed out again: {again}");
}
