use super::*;

async fn opaque_register(
    s: &Server,
    localpart: &str,
    password: &str,
) -> (Value, Vec<u8>) {
    let mut rng = OsRng;
    let started = ClientRegistration::<BrowserOpaqueSuite>::start(
        &mut rng,
        password.as_bytes(),
    )
    .unwrap();
    let (status, response) = s
        .post(
            "/_telium/v1/register/opaque/start",
            None,
            json!({
                "localpart": localpart,
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
            password.as_bytes(),
            RegistrationResponse::deserialize(&response_bytes).unwrap(),
            ClientRegistrationFinishParameters::default(),
        )
        .unwrap();
    let export_key = finished.export_key.to_vec();

    let (status, session) = s
        .post(
            "/_telium/v1/register/opaque/finish",
            None,
            json!({
                "localpart": localpart,
                "registration_record": opaque_b64(finished.message.serialize().as_slice()),
                "device_name": "opaque test",
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque register finish: {session}");
    (session, export_key)
}

async fn opaque_reauth(s: &Server, token: &str, password: &str) -> String {
    let mut rng = OsRng;
    let started =
        ClientLogin::<BrowserOpaqueSuite>::start(&mut rng, password.as_bytes()).unwrap();
    let (status, response) = s
        .post(
            "/_telium/v1/auth/opaque/reauth/start",
            Some(token),
            json!({
                "start_login_request": opaque_b64(started.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque reauth start: {response}");

    let response_bytes = URL_SAFE_NO_PAD
        .decode(response["login_response"].as_str().unwrap())
        .unwrap();
    let finished = started
        .state
        .finish(
            &mut rng,
            password.as_bytes(),
            CredentialResponse::deserialize(&response_bytes).unwrap(),
            ClientLoginFinishParameters::default(),
        )
        .unwrap();

    let (status, proof) = s
        .post(
            "/_telium/v1/auth/opaque/reauth/finish",
            Some(token),
            json!({
                "login_id": response["login_id"],
                "finish_login_request": opaque_b64(finished.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque reauth finish: {proof}");
    proof["reauth_token"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn identity_assertion_is_exchanged_for_a_local_guild_session() {
    let s = start().await;
    let (_, body) = s
        .post("/_telium/v1/register", None, json!({ "localpart": "alice", "password": "correct horse battery" }))
        .await;
    let home = body["access_token"].as_str().unwrap().to_string();
    assert_eq!(body["user_id"], "@alice:test.example");

    let (status, assertion) = s
        .post("/_telium/v1/assertions", Some(&home), json!({ "audience": "test.example" }))
        .await;
    assert_eq!(status, 200, "{assertion}");
    let token = assertion["assertion"].as_str().unwrap();

    let (status, session) = s.post("/_telium/v1/sessions", None, json!({ "assertion": token })).await;
    assert_eq!(status, 200, "{session}");
    assert_eq!(session["user_id"], "@alice:test.example");
    assert!(session["expires_at"].as_i64().unwrap() > 0);

    let (_, wrong) = s
        .post("/_telium/v1/assertions", Some(&home), json!({ "audience": "other.example" }))
        .await;
    let (status, _) = s
        .post("/_telium/v1/sessions", None, json!({ "assertion": wrong["assertion"] }))
        .await;
    assert_eq!(status, 401, "an assertion for another audience must be refused");
}

#[tokio::test]
async fn opaque_registration_login_and_reauth_keep_password_server_blind() {
    let s = start().await;
    let password = "correct horse battery staple";

    s.post(
        "/_telium/v1/register",
        None,
        json!({ "localpart": "founder", "password": "correct horse battery" }),
    )
    .await;

    let (registered, register_export) = opaque_register(&s, "opaquealice", password).await;
    assert_eq!(registered["user_id"], "@opaquealice:test.example");
    let first_token = registered["access_token"].as_str().unwrap();

    let (status, legacy) = s
        .post(
            "/_telium/v1/login",
            None,
            json!({ "user": "opaquealice", "password": password }),
        )
        .await;
    assert_eq!(status, 401, "OPAQUE accounts must reject raw-password login: {legacy}");
    assert_eq!(legacy["message"], "invalid credentials");

    let (logged_in, login_export) = opaque_login(&s, "opaquealice", password, None)
        .await
        .expect("correct OPAQUE password");
    assert_eq!(
        register_export, login_export,
        "the client-only OPAQUE export key must be stable across logins"
    );
    assert_ne!(logged_in["access_token"], registered["access_token"]);

    assert!(
        opaque_login(&s, "opaquealice", "definitely wrong password", None)
            .await
            .is_none(),
        "wrong passwords must fail on the client side before a session is minted"
    );

    let proof = opaque_reauth(&s, first_token, password).await;
    let (status, setup) = s
        .post(
            "/_telium/v1/mfa/setup",
            Some(first_token),
            json!({ "reauth_token": proof }),
        )
        .await;
    assert_eq!(status, 200, "one-use OPAQUE reauth proof should authorize MFA setup: {setup}");

    let (status, replay) = s
        .post(
            "/_telium/v1/mfa/setup",
            Some(first_token),
            json!({ "reauth_token": proof }),
        )
        .await;
    assert_eq!(status, 401, "OPAQUE reauth proofs must be one-use: {replay}");

    let delete_proof = opaque_reauth(&s, first_token, password).await;
    let response = s
        .client
        .delete(format!("{}/_telium/v1/account", s.base))
        .bearer_auth(first_token)
        .json(&json!({ "reauth_token": delete_proof }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);

    let (status, raw) = s
        .post(
            "/_telium/v1/login",
            None,
            json!({ "user": "opaquealice", "password": password }),
        )
        .await;
    assert_eq!(status, 401);
    assert_eq!(raw["message"], "invalid credentials");
    assert!(
        opaque_login(&s, "opaquealice", password, None).await.is_none(),
        "a deleted account must authenticate through neither the real nor fake OPAQUE record"
    );
}

#[tokio::test]
async fn opaque_vault_mode_never_stores_a_server_recovery_key() {
    let s = start().await;
    let (registered, _) =
        opaque_register(&s, "opaquevault", "correct horse battery staple").await;
    let token = registered["access_token"].as_str().unwrap();

    let (status, stored) = s
        .put(
            "/_telium/v1/vault",
            token,
            json!({
                "mode": "opaque_custody",
                "ciphertext": "client-only-primary-wrapper",
                "independent_ciphertext": "optional-second-wrapper",
            }),
        )
        .await;
    assert_eq!(status, 200, "{stored}");

    let (_, vault) = s.get("/_telium/v1/vault", Some(token)).await;
    assert_eq!(vault["mode"], "opaque_custody");
    assert_eq!(vault["ciphertext"], "client-only-primary-wrapper");
    assert_eq!(vault["independent_ciphertext"], "optional-second-wrapper");
    assert_eq!(vault["server_can_recover"], false);
    assert!(vault["escrow_key"].is_null());

    let (status, refused) = s
        .put(
            "/_telium/v1/vault",
            token,
            json!({
                "mode": "opaque_custody",
                "ciphertext": "x",
                "escrow_key": "must-not-be-accepted",
            }),
        )
        .await;
    assert_eq!(status, 400, "OPAQUE custody must reject a server-held key: {refused}");
}

async fn opaque_reauth_with(s: &Server, token: &str, password: &str, extra: Value) -> (u16, Value) {
    let mut rng = OsRng;
    let started =
        ClientLogin::<BrowserOpaqueSuite>::start(&mut rng, password.as_bytes()).unwrap();
    let (status, response) = s
        .post(
            "/_telium/v1/auth/opaque/reauth/start",
            Some(token),
            json!({
                "start_login_request": opaque_b64(started.message.serialize().as_slice()),
            }),
        )
        .await;
    assert_eq!(status, 200, "opaque reauth start: {response}");
    let response_bytes = URL_SAFE_NO_PAD
        .decode(response["login_response"].as_str().unwrap())
        .unwrap();
    let finished = started
        .state
        .finish(
            &mut rng,
            password.as_bytes(),
            CredentialResponse::deserialize(&response_bytes).unwrap(),
            ClientLoginFinishParameters::default(),
        )
        .unwrap();
    let mut body = json!({
        "login_id": response["login_id"],
        "finish_login_request": opaque_b64(finished.message.serialize().as_slice()),
    });
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    s.post("/_telium/v1/auth/opaque/reauth/finish", Some(token), body).await
}

async fn recovery_rows(s: &Server, user_id: &str) -> (Option<String>, Option<String>) {
    let public: Option<String> =
        sqlx::query_scalar("SELECT recovery_public_key FROM accounts WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    let copy: Option<String> =
        sqlx::query_scalar("SELECT independent_ciphertext FROM key_vault WHERE user_id = ?")
            .bind(user_id)
            .fetch_one(&s.state.pool)
            .await
            .unwrap();
    (public, copy)
}

async fn enrolled_account(s: &Server, localpart: &str, password: &str) -> (String, String, SigningKey) {
    let (registered, _) = opaque_register(s, localpart, password).await;
    let token = registered["access_token"].as_str().unwrap().to_string();
    let user_id = registered["user_id"].as_str().unwrap().to_string();
    let (status, stored) = s
        .put(
            "/_telium/v1/vault",
            &token,
            json!({ "mode": "opaque_custody", "ciphertext": "primary.copy" }),
        )
        .await;
    assert_eq!(status, 200, "{stored}");
    let recovery = identity_signing_key();
    let (status, enrolled) = opaque_reauth_with(
        s,
        &token,
        password,
        json!({
            "recovery_public_key": identity_public(&recovery),
            "recovery_vault_ciphertext": "k1.first.copy",
        }),
    )
    .await;
    assert_eq!(status, 200, "enrollment: {enrolled}");
    assert_eq!(enrolled["recovery_key_enrolled"], true);
    (token, user_id, recovery)
}

#[tokio::test]
async fn vault_mode_keeps_the_independent_copy_unless_told_to_clear_it() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let (token, user_id, _) =
        enrolled_account(&s, "keepscopy", "correct horse battery staple").await;

    for body in [
        json!({ "mode": "opaque_custody", "ciphertext": "primary.repaired" }),
        json!({
            "mode": "opaque_custody",
            "ciphertext": "primary.repaired.again",
            "independent_ciphertext": null,
        }),
    ] {
        let (status, changed) = s.post("/_telium/v1/vault/mode", Some(&token), body).await;
        assert_eq!(status, 200, "{changed}");
        let (_, vault) = s.get("/_telium/v1/vault", Some(&token)).await;
        assert_eq!(vault["independent_ciphertext"], "k1.first.copy");
        assert_eq!(vault["recovery_key_enrolled"], true);
    }

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&token),
            json!({
                "mode": "opaque_custody",
                "ciphertext": "primary.copy",
                "independent_ciphertext": "p2.other",
                "clear_independent": true,
            }),
        )
        .await;
    assert_eq!(status, 400, "a new copy and a clear in one request is a contradiction");
    assert_eq!(recovery_rows(&s, &user_id).await.1.as_deref(), Some("k1.first.copy"));

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&token),
            json!({
                "mode": "opaque_custody",
                "ciphertext": "primary.copy",
                "clear_independent": true,
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, vault) = s.get("/_telium/v1/vault", Some(&token)).await;
    assert!(vault["independent_ciphertext"].is_null());
}

#[tokio::test]
async fn a_recovery_key_is_replaced_in_one_step_or_not_at_all() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let password = "correct horse battery staple";
    let (token, user_id, old) = enrolled_account(&s, "replaceskey", password).await;
    let old_public = identity_public(&old);
    let new = identity_signing_key();
    let new_public = identity_public(&new);

    let (status, refused) = opaque_reauth_with(
        &s,
        &token,
        password,
        json!({
            "recovery_public_key": new_public.clone(),
            "recovery_vault_ciphertext": "k1.second.copy",
        }),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(
        recovery_rows(&s, &user_id).await,
        (Some(old_public.clone()), Some("k1.first.copy".into())),
    );

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&token),
            json!({
                "mode": "opaque_custody",
                "ciphertext": "primary.copy",
                "independent_ciphertext": "p2.legacy.copy",
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, refused) = opaque_reauth_with(
        &s,
        &token,
        password,
        json!({
            "recovery_public_key": new_public.clone(),
            "recovery_vault_ciphertext": "k1.second.copy",
            "replace_recovery_key": true,
        }),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(
        recovery_rows(&s, &user_id).await,
        (Some(old_public.clone()), Some("p2.legacy.copy".into())),
        "a failed replacement must leave the old key and the old copy where they were",
    );

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&token),
            json!({
                "mode": "opaque_custody",
                "ciphertext": "primary.copy",
                "independent_ciphertext": "k1.first.copy",
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (status, replaced) = opaque_reauth_with(
        &s,
        &token,
        password,
        json!({
            "recovery_public_key": new_public.clone(),
            "recovery_vault_ciphertext": "k1.second.copy",
            "replace_recovery_key": true,
        }),
    )
    .await;
    assert_eq!(status, 200, "{replaced}");
    assert_eq!(replaced["recovery_key_enrolled"], true);
    assert_eq!(
        recovery_rows(&s, &user_id).await,
        (Some(new_public), Some("k1.second.copy".into())),
    );
}

async fn restore_copy(
    s: &Server,
    token: &str,
    user_id: &str,
    key: &SigningKey,
    signed: &str,
    sent: &str,
) -> (u16, Value) {
    let (status, started) = s
        .post("/_telium/v1/auth/recovery-key/vault-copy/start", Some(token), json!({}))
        .await;
    assert_eq!(status, 200, "{started}");
    let attempt = started["attempt_id"].as_str().unwrap();
    let challenge = started["challenge"].as_str().unwrap();
    let signature = identity_signature(
        key,
        &format!("telium-recovery-k1-restore:v1|{user_id}|{attempt}|{challenge}|{signed}"),
    );
    s.post(
        "/_telium/v1/auth/recovery-key/vault-copy/finish",
        Some(token),
        json!({
            "attempt_id": attempt,
            "recovery_vault_ciphertext": sent,
            "signature": signature,
        }),
    )
    .await
}

#[tokio::test]
async fn the_recovery_key_can_put_back_a_missing_vault_copy() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let (token, user_id, recovery) =
        enrolled_account(&s, "restorescopy", "correct horse battery staple").await;

    let (status, refused) =
        restore_copy(&s, &token, &user_id, &recovery, "k1.other", "k1.other").await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(recovery_rows(&s, &user_id).await.1.as_deref(), Some("k1.first.copy"));

    let (status, _) = s
        .post(
            "/_telium/v1/vault/mode",
            Some(&token),
            json!({
                "mode": "opaque_custody",
                "ciphertext": "primary.copy",
                "clear_independent": true,
            }),
        )
        .await;
    assert_eq!(status, 200);
    let (_, vault) = s.get("/_telium/v1/vault", Some(&token)).await;
    assert_eq!(vault["recovery_key_enrolled"], true);
    assert!(vault["independent_ciphertext"].is_null());

    let stranger = identity_signing_key();
    let (status, refused) =
        restore_copy(&s, &token, &user_id, &stranger, "k1.forged", "k1.forged").await;
    assert_eq!(status, 401, "{refused}");
    let (status, refused) =
        restore_copy(&s, &token, &user_id, &recovery, "k1.signed", "k1.swapped").await;
    assert_eq!(status, 401, "{refused}");
    let (status, _) = restore_copy(&s, &token, &user_id, &recovery, "p2.x", "p2.x").await;
    assert_eq!(status, 400);
    assert!(recovery_rows(&s, &user_id).await.1.is_none());

    let (_, started) = s
        .post("/_telium/v1/auth/recovery-key/vault-copy/start", Some(&token), json!({}))
        .await;
    let attempt = started["attempt_id"].as_str().unwrap();
    let challenge = started["challenge"].as_str().unwrap();
    let signature = identity_signature(
        &recovery,
        &format!("telium-password-reset:v1|{user_id}|{attempt}|{challenge}|k1.restored"),
    );
    let (status, _) = s
        .post(
            "/_telium/v1/auth/recovery-key/vault-copy/finish",
            Some(&token),
            json!({
                "attempt_id": attempt,
                "recovery_vault_ciphertext": "k1.restored",
                "signature": signature,
            }),
        )
        .await;
    assert_eq!(status, 401);

    let (status, restored) =
        restore_copy(&s, &token, &user_id, &recovery, "k1.restored", "k1.restored").await;
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["recovery_copy_restored"], true);
    assert_eq!(recovery_rows(&s, &user_id).await.1.as_deref(), Some("k1.restored"));

    let (_, started) = s
        .post("/_telium/v1/auth/recovery-key/vault-copy/start", Some(&token), json!({}))
        .await;
    let attempt = started["attempt_id"].as_str().unwrap().to_string();
    let challenge = started["challenge"].as_str().unwrap().to_string();
    let signature = identity_signature(
        &stranger,
        &format!("telium-recovery-k1-restore:v1|{user_id}|{attempt}|{challenge}|k1.x"),
    );
    let finish = json!({
        "attempt_id": attempt.clone(),
        "recovery_vault_ciphertext": "k1.x",
        "signature": signature,
    });
    let (status, _) = s
        .post("/_telium/v1/auth/recovery-key/vault-copy/finish", Some(&token), finish.clone())
        .await;
    assert_eq!(status, 401);
    let gone: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_copy_attempts WHERE id = ?")
        .bind(&attempt)
        .fetch_one(&s.state.pool)
        .await
        .unwrap();
    assert_eq!(gone, 0, "a failed proof must still spend its challenge");
}

#[tokio::test]
async fn login_does_not_leak_which_accounts_exist() {
    let s = start().await;
    s.post("/_telium/v1/register", None, json!({ "localpart": "alice", "password": "correct horse battery" }))
        .await;

    let (s1, b1) = s
        .post("/_telium/v1/login", None, json!({ "user": "alice", "password": "wrong" }))
        .await;
    let (s2, b2) = s
        .post("/_telium/v1/login", None, json!({ "user": "nobody", "password": "wrong" }))
        .await;
    assert_eq!(s1, s2);
    assert_eq!(b1["message"], b2["message"]);
}

#[tokio::test]
async fn usernames_accept_capitals_but_identity_is_case_insensitive() {
    let s = start().await;
    let (status, registered) = s
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": "Alice", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 200, "{registered}");
    assert_eq!(registered["user_id"], "@alice:test.example");

    let token = registered["access_token"].as_str().unwrap();
    let (status, me) = s.get("/_telium/v1/whoami", Some(token)).await;
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["profile"]["display_name"], "Alice");

    let (status, duplicate) = s
        .post(
            "/_telium/v1/register",
            None,
            json!({ "localpart": "aLiCe", "password": "correct horse battery" }),
        )
        .await;
    assert_eq!(status, 409, "{duplicate}");

    for user in ["ALICE", "@AlIcE:test.example"] {
        let (status, logged_in) = s
            .post(
                "/_telium/v1/login",
                None,
                json!({ "user": user, "password": "correct horse battery" }),
            )
            .await;
        assert_eq!(status, 200, "{logged_in}");
        assert_eq!(logged_in["user_id"], "@alice:test.example");
    }
}
