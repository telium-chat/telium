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

// --- Phase 3 of the key-custody design: password writes re-wrap the vault atomically (I5) ---

/// One OPAQUE registration round for a new password; `start` is the route's answer.
fn registration_record(password: &str, started: ClientRegistrationStartResult<BrowserOpaqueSuite>, start: &Value) -> String {
    let mut rng = OsRng;
    let bytes = URL_SAFE_NO_PAD
        .decode(start["registration_response"].as_str().unwrap())
        .unwrap();
    let finished = started
        .state
        .finish(
            &mut rng,
            password.as_bytes(),
            RegistrationResponse::deserialize(&bytes).unwrap(),
            ClientRegistrationFinishParameters::default(),
        )
        .unwrap();
    opaque_b64(finished.message.serialize().as_slice())
}

/// A reset attempt: its start answer and the replacement record. `signer` signs the start (to be handed the vault copy).
async fn reset_attempt(
    s: &Server,
    user_id: &str,
    password: &str,
    signer: Option<&SigningKey>,
) -> (Value, String) {
    let mut rng = OsRng;
    let started =
        ClientRegistration::<BrowserOpaqueSuite>::start(&mut rng, password.as_bytes()).unwrap();
    let request = opaque_b64(started.message.serialize().as_slice());
    let mut body = json!({ "user": user_id, "registration_request": request });
    if let Some(key) = signer {
        body["signature"] = json!(identity_signature(
            key,
            &format!("telium-password-reset-start:v1|{user_id}|{request}"),
        ));
    }
    let (status, start) = s.post("/_telium/v1/password-reset/opaque/start", None, body).await;
    assert_eq!(status, 200, "reset start: {start}");
    let record = registration_record(password, started, &start);
    (start, record)
}

async fn reset_finish(
    s: &Server,
    user_id: &str,
    start: &Value,
    record: &str,
    signer: &SigningKey,
    vault: Option<(&str, i64)>,
    extra: Value,
) -> (u16, Value) {
    let mut payload = format!(
        "telium-password-reset:v1|{}|{}|{}|{}",
        start["user_id"].as_str().unwrap(),
        start["reset_id"].as_str().unwrap(),
        start["challenge"].as_str().unwrap(),
        record,
    );
    if let Some((ciphertext, version)) = vault {
        payload.push_str(&format!("|{version}|{ciphertext}"));
    }
    let mut body = json!({
        "user": user_id,
        "reset_id": start["reset_id"],
        "registration_record": record,
        "signature": identity_signature(signer, &payload),
    });
    if let Some((ciphertext, version)) = vault {
        body["vault_ciphertext"] = json!(ciphertext);
        body["vault_version"] = json!(version);
    }
    for (k, v) in extra.as_object().unwrap() {
        body[k] = v.clone();
    }
    s.post("/_telium/v1/password-reset/opaque/finish", None, body).await
}

async fn vault_row(s: &Server, user_id: &str) -> (String, String, Option<String>, i64) {
    sqlx::query_as(
        "SELECT mode, ciphertext, independent_ciphertext, version FROM key_vault WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_one(&s.state.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn password_reset_replaces_the_record_and_the_vault_in_one_write() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let old = "correct horse battery staple";
    let new = "a different horse battery staple";
    let (_token, user_id, recovery) = enrolled_account(&s, "resetwrap", old).await;
    let (_, _, copy, version) = vault_row(&s, &user_id).await;
    assert_eq!(copy.as_deref(), Some("k1.first.copy"));

    // The recovery copy goes only to a caller that proves it holds the recovery key.
    let (unsigned, _) = reset_attempt(&s, &user_id, new, None).await;
    assert!(unsigned["vault"].is_null(), "{unsigned}");
    let (stranger, _) = reset_attempt(&s, &user_id, new, Some(&identity_signing_key())).await;
    assert!(stranger["vault"].is_null(), "{stranger}");
    let (unknown, _) = reset_attempt(&s, "@nobody:localhost", new, Some(&recovery)).await;
    assert!(unknown["vault"].is_null(), "{unknown}");
    assert_eq!(unknown["ksf_version"], unsigned["ksf_version"]);
    let (start, record) = reset_attempt(&s, &user_id, new, Some(&recovery)).await;
    assert_eq!(start["vault"]["independent_ciphertext"], "k1.first.copy");
    assert_eq!(start["vault"]["version"], version);

    // A reset that leaves the vault under the old password is refused whole: it would pair the new record with a vault
    // only the old password opens.
    let (status, refused) =
        reset_finish(&s, &user_id, &start, &record, &recovery, None, json!({})).await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["code"], "vault_rewrap_required");
    assert!(opaque_login(&s, &user_id, old, None).await.is_some(), "the old password must still work");
    assert_eq!(vault_row(&s, &user_id).await.1, "primary.copy");

    // A stale version loses and changes nothing.
    let (start, record) = reset_attempt(&s, &user_id, new, Some(&recovery)).await;
    let (status, refused) = reset_finish(
        &s, &user_id, &start, &record, &recovery, Some(("rewrapped.stale", version + 5)), json!({}),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["code"], "vault_version_conflict");
    assert!(opaque_login(&s, &user_id, old, None).await.is_some());
    assert_eq!(vault_row(&s, &user_id).await.1, "primary.copy");

    // The vault copy is inside the signature.
    let (start, record) = reset_attempt(&s, &user_id, new, Some(&recovery)).await;
    let (status, forged) = reset_finish(
        &s, &user_id, &start, &record, &recovery, Some(("rewrapped.signed", version)),
        json!({ "vault_ciphertext": "rewrapped.swapped" }),
    )
    .await;
    assert_eq!(status, 401, "{forged}");
    assert_eq!(vault_row(&s, &user_id).await.1, "primary.copy");

    // An unknown stretching version is refused before anything else.
    let (start, record) = reset_attempt(&s, &user_id, new, Some(&recovery)).await;
    let (status, refused) = reset_finish(
        &s, &user_id, &start, &record, &recovery, Some(("rewrapped.ksf", version)), json!({ "ksf_version": 2 }),
    )
    .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["code"], "unsupported_ksf_version");
    assert!(opaque_login(&s, &user_id, old, None).await.is_some());

    let (start, record) = reset_attempt(&s, &user_id, new, Some(&recovery)).await;
    let (status, done) = reset_finish(
        &s, &user_id, &start, &record, &recovery, Some(("rewrapped.new", version)), json!({}),
    )
    .await;
    assert_eq!(status, 200, "{done}");
    let (mode, ciphertext, copy, now) = vault_row(&s, &user_id).await;
    assert_eq!((mode.as_str(), ciphertext.as_str()), ("opaque_custody", "rewrapped.new"));
    assert_eq!(copy.as_deref(), Some("k1.first.copy"), "the recovery copy is under the account key and stays");
    assert_eq!(now, version + 1);
    assert!(opaque_login(&s, &user_id, new, None).await.is_some());
    assert!(opaque_login(&s, &user_id, old, None).await.is_none());
}

async fn change_start(s: &Server, token: &str, password: &str) -> (u16, Value, Option<String>) {
    let mut rng = OsRng;
    let started =
        ClientRegistration::<BrowserOpaqueSuite>::start(&mut rng, password.as_bytes()).unwrap();
    let (status, start) = s
        .post(
            "/_telium/v1/auth/opaque/password/change/start",
            Some(token),
            json!({ "registration_request": opaque_b64(started.message.serialize().as_slice()) }),
        )
        .await;
    if status != 200 {
        return (status, start, None);
    }
    let record = registration_record(password, started, &start);
    (status, start, Some(record))
}

#[tokio::test]
async fn password_change_replaces_the_record_and_the_vault_in_one_write() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let old = "correct horse battery staple";
    let new = "a different horse battery staple";
    let (token, user_id, _recovery) = enrolled_account(&s, "changewrap", old).await;
    let (_, _, copy, version) = vault_row(&s, &user_id).await;

    let (status, _, _) = change_start(&s, "not-a-session", new).await;
    assert_eq!(status, 401);
    let (status, start, record) = change_start(&s, &token, new).await;
    assert_eq!(status, 200, "{start}");
    assert_eq!(start["ksf_version"], 1);
    let record = record.unwrap();
    let proof = opaque_reauth(&s, &token, old).await;
    let finish = |extra: Value| {
        let mut body = json!({ "reauth_token": proof, "registration_record": record });
        for (k, v) in extra.as_object().unwrap() {
            body[k] = v.clone();
        }
        body
    };
    let url = "/_telium/v1/auth/opaque/password/change/finish";

    // Refusals leave everything as it was, and leave the proof spendable for the retry.
    let (status, refused) = s.post(url, Some(&token), finish(json!({}))).await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["code"], "vault_rewrap_required");
    let (status, refused) = s
        .post(url, Some(&token), finish(json!({ "vault_ciphertext": "rewrapped.stale", "vault_version": version + 5 })))
        .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["code"], "vault_version_conflict");
    let (status, refused) = s
        .post(url, Some(&token), finish(json!({ "vault_ciphertext": "x", "vault_version": version, "ksf_version": 2 })))
        .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["code"], "unsupported_ksf_version");
    let (status, refused) = s
        .post(url, Some("not-a-session"), finish(json!({ "vault_ciphertext": "x", "vault_version": version })))
        .await;
    assert_eq!(status, 401, "{refused}");
    assert!(opaque_login(&s, &user_id, old, None).await.is_some(), "the old password must still work");
    assert_eq!(vault_row(&s, &user_id).await.1, "primary.copy");

    let (status, done) = s
        .post(url, Some(&token), finish(json!({ "vault_ciphertext": "rewrapped.new", "vault_version": version })))
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["vault_version"], version + 1);
    let (_, ciphertext, kept, now) = vault_row(&s, &user_id).await;
    assert_eq!(ciphertext, "rewrapped.new");
    assert_eq!(kept, copy);
    assert_eq!(now, version + 1);
    assert!(opaque_login(&s, &user_id, new, None).await.is_some());
    assert!(opaque_login(&s, &user_id, old, None).await.is_none());
    let (status, _) = s.get("/_telium/v1/whoami", Some(&token)).await;
    assert_eq!(status, 200, "a password change does not end the session that made it");

    // The proof is spent by the write that used it.
    let (status, replay) = s
        .post(url, Some(&token), finish(json!({ "vault_ciphertext": "again", "vault_version": version + 1 })))
        .await;
    assert_eq!(status, 401, "{replay}");
    assert_eq!(vault_row(&s, &user_id).await.1, "rewrapped.new");
}

#[tokio::test]
async fn login_answers_with_the_key_stretching_version() {
    let s = start_with(|cfg| cfg.rate_limit.auth_burst = 1_000).await;
    let (_token, user_id, _) = enrolled_account(&s, "ksfver", "correct horse battery staple").await;
    let mut rng = OsRng;
    let started = ClientLogin::<BrowserOpaqueSuite>::start(&mut rng, b"whatever").unwrap();
    let ask = |user: String| {
        let request = opaque_b64(started.message.serialize().as_slice());
        let s = &s;
        async move {
            s.post(
                "/_telium/v1/login/opaque/start",
                None,
                json!({ "user": user, "start_login_request": request }),
            )
            .await
        }
    };
    let (_, known) = ask(user_id.clone()).await;
    let (_, stranger) = ask("@nobody:localhost".into()).await;
    assert_eq!(known["ksf_version"], 1, "{known}");
    assert_eq!(stranger["ksf_version"], 1, "a stranger is told the same as an account");

    // Registering with a version the server does not know is refused.
    let started =
        ClientRegistration::<BrowserOpaqueSuite>::start(&mut rng, b"correct horse battery staple").unwrap();
    let request = opaque_b64(started.message.serialize().as_slice());
    let (_, start) = s
        .post(
            "/_telium/v1/register/opaque/start",
            None,
            json!({ "localpart": "ksfnew", "registration_request": request }),
        )
        .await;
    let record = registration_record("correct horse battery staple", started, &start);
    let (status, refused) = s
        .post(
            "/_telium/v1/register/opaque/finish",
            None,
            json!({ "localpart": "ksfnew", "registration_record": record, "ksf_version": 99 }),
        )
        .await;
    assert_eq!(status, 400, "{refused}");
    assert_eq!(refused["code"], "unsupported_ksf_version");
}
