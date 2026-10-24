use super::*;

#[derive(Deserialize)]
pub struct MfaSetupRequest {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

#[derive(Deserialize)]
pub struct MfaCodeRequest {
    pub code: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

pub async fn mfa_status(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let row: (i64, Option<String>, Option<String>, i64) = sqlx::query_as(
        "SELECT mfa_enabled, mfa_secret, mfa_sealed, mfa_reenrol_required \
         FROM accounts WHERE user_id = ?",
    ).bind(&auth.user_id).fetch_one(&state.pool).await?;
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL",
    ).bind(&auth.user_id).fetch_one(&state.pool).await?;
    Ok(Json(json!({
        "enabled": row.0 != 0,
        "setup_pending": row.0 == 0 && (row.1.is_some() || row.2.is_some()),
        "recovery_codes_remaining": remaining,
        "reenrol_required": row.3 != 0,
    })))
}

pub async fn mfa_setup(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<MfaSetupRequest>,
) -> ApiResult<Json<Value>> {
    verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let bytes: [u8; 20] = rand::random();
    let secret = base32_encode(&bytes);
    let key = state.mfa.current.ok_or_else(|| {
        ApiError::Internal(anyhow::anyhow!(
            "no MFA encryption key is loaded; second factors cannot be stored"
        ))
    })?;
    let sealed = crate::mfa::seal(&key, &auth.user_id, &secret)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("sealing the second factor: {e}")))?;
    sqlx::query(
        "UPDATE accounts SET mfa_sealed = ?, mfa_secret = NULL, mfa_enabled = 0 \
         WHERE user_id = ?",
    )
        .bind(&sealed).bind(&auth.user_id).execute(&state.pool).await?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = ?")
        .bind(&auth.user_id).execute(&state.pool).await?;
    let issuer = "Telium";
    let label = auth.user_id.replace(':', "%3A").replace('@', "%40");
    Ok(Json(json!({
        "secret": secret,
        "otpauth_uri": format!("otpauth://totp/{issuer}:{label}?secret={secret}&issuer={issuer}&digits=6&period=30"),
    })))
}

pub async fn mfa_enable(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<MfaCodeRequest>,
) -> ApiResult<Json<Value>> {
    let row: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT mfa_secret, mfa_sealed FROM accounts WHERE user_id = ?",
    ).bind(&auth.user_id).fetch_one(&state.pool).await?;
    let secret = crate::mfa::from_row(&state.mfa, &auth.user_id, row.0.as_deref(), row.1.as_deref())
        .ok_or_else(|| ApiError::BadRequest("start MFA setup first".into())
            .with_code(errcodes::MFA_SETUP_NOT_STARTED))?;
    if !verify_totp(&secret, &req.code, now_ms()) {
        return Err(ApiError::Unauthorized("invalid_mfa_code".into()).with_code(errcodes::INVALID_MFA_CODE));
    }
    let mut codes = Vec::new();
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = ?")
        .bind(&auth.user_id).execute(&mut *tx).await?;
    for _ in 0..8 {
        let code = random_token(9);
        sqlx::query("INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)")
            .bind(&auth.user_id).bind(hash_token(&code)).bind(now_ms())
            .execute(&mut *tx).await?;
        codes.push(code);
    }
    sqlx::query("UPDATE accounts SET mfa_enabled = 1, mfa_reenrol_required = 0 WHERE user_id = ?")
        .bind(&auth.user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "recovery_codes": codes })))
}

pub async fn mfa_disable(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<MfaCodeRequest>,
) -> ApiResult<Json<Value>> {
    verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;
    let row: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT mfa_secret, mfa_sealed FROM accounts WHERE user_id = ?",
    ).bind(&auth.user_id).fetch_one(&state.pool).await?;
    if row.0.is_none() && row.1.is_none() {
        return Err(ApiError::BadRequest("MFA is not configured".into())
            .with_code(errcodes::MFA_NOT_CONFIGURED));
    }
    let secret = crate::mfa::from_row(&state.mfa, &auth.user_id, row.0.as_deref(), row.1.as_deref());
    if !consume_mfa_code(&state, &auth.user_id, secret.as_deref(), &req.code).await? {
        return Err(ApiError::Unauthorized("invalid_mfa_code".into()).with_code(errcodes::INVALID_MFA_CODE));
    }
    sqlx::query(
        "UPDATE accounts SET mfa_enabled = 0, mfa_secret = NULL, mfa_sealed = NULL \
         WHERE user_id = ?",
    )
        .bind(&auth.user_id).execute(&state.pool).await?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = ?")
        .bind(&auth.user_id).execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true })))
}

pub(super) async fn consume_mfa_code(
    state: &AppState,
    user_id: &str,
    secret: Option<&str>,
    code: &str,
) -> ApiResult<bool> {
    let normalized = code.trim().replace('-', "");
    if secret.is_some_and(|s| verify_totp(s, &normalized, now_ms())) {
        return Ok(true);
    }
    let hash = hash_token(code.trim());
    let done = sqlx::query(
        "UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL",
    ).bind(now_ms()).bind(user_id).bind(hash).execute(&state.pool).await?;
    Ok(done.rows_affected() == 1)
}

fn verify_totp(secret: &str, code: &str, at_ms: i64) -> bool {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    (-1i64..=1).any(|step| totp(secret, at_ms / 1000 / 30 + step).as_deref() == Some(code))
}

fn totp(secret: &str, counter: i64) -> Option<String> {
    if counter < 0 { return None; }
    let key = base32_decode(secret)?;
    let mut mac = Hmac::<Sha1>::new_from_slice(&key).ok()?;
    mac.update(&(counter as u64).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 0x0f) as usize;
    let binary = ((u32::from(digest[offset]) & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    Some(format!("{:06}", binary % 1_000_000))
}

fn base32_encode(data: &[u8]) -> String {
    const A: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for &byte in data {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for ch in input.bytes().filter(|b| *b != b'=' && *b != b' ') {
        let v = match ch.to_ascii_uppercase() {
            b'A'..=b'Z' => ch.to_ascii_uppercase() - b'A',
            b'2'..=b'7' => ch - b'2' + 26,
            _ => return None,
        };
        buffer = (buffer << 5) | u32::from(v);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}
