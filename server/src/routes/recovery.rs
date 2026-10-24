
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::mail::{self, Refused};
use crate::state::AppState;
use crate::util::{hash_token, now_ms, random_token};
use axum::extract::{Form, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

const CHALLENGE_TTL_MS: i64 = 24 * 3_600_000;

const PURPOSE_CONFIRM: &str = "verify";
const PURPOSE_DISOWN: &str = "disown";

pub struct AddressState {
    pub verified: Option<String>,
    pub verified_at: Option<i64>,
    pub pending: Option<String>,
    pub pending_since: Option<i64>,
    pub bounced_at: Option<i64>,
    pub bounce_reason: Option<String>,
}

impl AddressState {
    fn empty() -> Self {
        Self {
            verified: None,
            verified_at: None,
            pending: None,
            pending_since: None,
            bounced_at: None,
            bounce_reason: None,
        }
    }

    fn word(&self) -> &'static str {
        if self.verified.is_some() {
            "verified"
        } else if self.pending.is_some() {
            "pending"
        } else if self.bounced_at.is_some() {
            "bounced"
        } else {
            "none"
        }
    }

    fn json(&self, state: &AppState) -> Value {
        json!({
            "state": self.word(),
            "verified_email": self.verified,
            "verified_at": self.verified_at,
            "pending_email": self.pending,
            "pending_since": self.pending_since,
            "bounced_at": self.bounced_at,
            "bounce_reason": self.bounce_reason,
            "mailer": mail::configured(state),
        })
    }
}

pub async fn load(state: &AppState, user_id: &str) -> ApiResult<AddressState> {
    let row: Option<(Option<String>, Option<i64>, Option<String>, Option<i64>, Option<i64>, Option<String>)> =
        sqlx::query_as(
            "SELECT verified_email, verified_at, pending_email, pending_since, bounced_at, \
             bounce_reason FROM recovery_addresses WHERE user_id = ?",
        )
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(match row {
        None => AddressState::empty(),
        Some((verified, verified_at, pending, pending_since, bounced_at, bounce_reason)) => {
            AddressState {
                verified: verified.filter(|a| !a.is_empty()),
                verified_at,
                pending: pending.filter(|a| !a.is_empty()),
                pending_since,
                bounced_at,
                bounce_reason,
            }
        }
    })
}

pub async fn get(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let current = load(&state, &auth.user_id).await?;
    Ok(Json(current.json(&state)))
}

#[derive(Deserialize)]
pub struct SetRecoveryEmail {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub reauth_token: Option<String>,
}

pub async fn set(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<SetRecoveryEmail>,
) -> ApiResult<Json<Value>> {
    crate::routes::identity::verify_sensitive_reauth(
        &state,
        &auth.user_id,
        req.password.as_deref(),
        req.reauth_token.as_deref(),
    )
    .await?;

    let email = req.email.map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
    let before = load(&state, &auth.user_id).await?;

    let Some(email) = email else {
        return remove(&state, &auth.user_id, before).await.map(Json);
    };

    if !mail::plausible_address(&email) {
        return Err(ApiError::BadRequest("that does not look like an email address".into()));
    }
    if before.verified.as_deref() == Some(email.as_str()) {
        return Ok(Json(before.json(&state)));
    }
    if !mail::configured(&state) {
        return Err(ApiError::BadRequest(Refused::NoMailer.words()));
    }

    let now = now_ms();
    sqlx::query(
        "INSERT INTO recovery_addresses (user_id, pending_email, pending_since) \
         VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET \
         pending_email = excluded.pending_email, pending_since = excluded.pending_since",
    )
    .bind(&auth.user_id)
    .bind(&email)
    .bind(now)
    .execute(&state.pool)
    .await?;

    sqlx::query("DELETE FROM recovery_email_challenges WHERE user_id = ? AND used_at IS NULL")
        .bind(&auth.user_id)
        .execute(&state.pool)
        .await?;

    let outcome = challenge_mail(&state, &auth.user_id, &email).await;

    if let Some(old) = mail::verified_recovery_address(&state, &auth.user_id).await? {
        if old.as_str() != email {
            let text = format!(
                "Somebody signed in as {user} asked {server} to send this account's security \
                 warnings to a different address:\n\n    {email}\n\n\
                 Nothing has changed yet. This address is still where warnings come until \
                 that one confirms it.\n\n\
                 If this was not you, sign in and change your password now: whoever asked \
                 had it.\n",
                user = auth.user_id,
                server = state.cfg.server_name,
            );
            let _ = mail::send_notice(
                &state,
                &old,
                &auth.user_id,
                "A different recovery address was requested",
                &text,
            )
            .await;
        }
    }

    let mut body = load(&state, &auth.user_id).await?.json(&state);
    body["challenge_sent"] = json!(outcome.is_ok());
    if let Err(refusal) = &outcome {
        body["challenge_error"] = json!(refusal.words());
    }
    Ok(Json(body))
}

async fn remove(state: &AppState, user_id: &str, before: AddressState) -> ApiResult<Value> {
    sqlx::query("DELETE FROM recovery_addresses WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM recovery_email_challenges WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    if before.verified.is_some() {
        if let Some(old) = verified_from(before.verified.clone()) {
            let text = format!(
                "The recovery address for {user} on {server} was removed. Security warnings \
                 about this account will no longer come here.\n\n\
                 If this was not you, sign in and change your password now.\n",
                user = user_id,
                server = state.cfg.server_name,
            );
            let _ = deliver_to_snapshot(state, &old, user_id, "Your recovery address was removed", &text)
                .await;
        }
    }
    Ok(load(state, user_id).await?.json(state))
}

async fn challenge_mail(
    state: &AppState,
    user_id: &str,
    email: &str,
) -> Result<(), Refused> {
    let confirm = match mint(state, user_id, email, PURPOSE_CONFIRM).await {
        Ok(token) => token,
        Err(_) => return Err(Refused::NoMailer),
    };
    let disown = match mint(state, user_id, email, PURPOSE_DISOWN).await {
        Ok(token) => token,
        Err(_) => return Err(Refused::NoMailer),
    };
    let base = state.cfg.public_base_url.trim_end_matches('/');
    let text = format!(
        "Somebody asked {server} to send security warnings about the account {user} to this \
         address.\n\n\
         If that was you, confirm it here. Until you do, this address receives nothing else \
         and is not treated as a way to reach the account:\n\n    \
         {base}/_telium/v1/account/recovery-email/confirm?t={confirm}\n\n\
         If it was not you -- if you have no account on {server} and did not ask for this -- \
         use this instead. It detaches your address from that account and stops {server} \
         sending here:\n\n    \
         {base}/_telium/v1/account/recovery-email/disown?t={disown}\n\n\
         Both links stop working in 24 hours, and each works once.\n\n\
         Neither link signs anybody in to anything.\n",
        server = state.cfg.server_name,
        user = user_id,
    );
    match mail::send_challenge(state, email, user_id, "Confirm this recovery address", &text).await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(refusal)) => Err(refusal),
        Err(e) => {
            tracing::warn!(target: crate::logcat::AUTH, error = %e, "the recovery-address challenge was not sent");
            Err(Refused::RateLimited { scope: "delivery", retry_after_ms: 60_000 })
        }
    }
}

async fn mint(state: &AppState, user_id: &str, email: &str, purpose: &str) -> ApiResult<String> {
    let token = random_token(32);
    let now = now_ms();
    sqlx::query(
        "INSERT INTO recovery_email_challenges (token_hash, user_id, email, purpose, \
         created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(email)
    .bind(purpose)
    .bind(now)
    .bind(now + CHALLENGE_TTL_MS)
    .execute(&state.pool)
    .await?;
    Ok(token)
}

#[derive(Deserialize)]
pub struct LinkParams {
    pub t: String,
}

enum Refusal {
    Unknown,
    Expired,
    Spent,
    Stale,
}

impl Refusal {
    fn status(&self) -> StatusCode {
        match self {
            Refusal::Unknown => StatusCode::NOT_FOUND,
            Refusal::Expired | Refusal::Spent => StatusCode::GONE,
            Refusal::Stale => StatusCode::CONFLICT,
        }
    }

    fn words(&self) -> String {
        match self {
            // Same answer for unknown and mistyped tokens (no oracle).
            Refusal::Unknown => {
                "This link is not one this server issued, or it has already been cleaned up."
                    .into()
            }
            Refusal::Expired => "This link has expired. Ask for a new one from the account's settings.".into(),
            Refusal::Spent => "This link has already been used.".into(),
            Refusal::Stale => {
                "This link is for an address the account is no longer asking about. A newer \
                 message has the link that works."
                    .into()
            }
        }
    }
}

struct Claim {
    user_id: String,
    email: String,
}

async fn inspect(state: &AppState, token: &str, purpose: &str) -> Result<Claim, Refusal> {
    let row: Option<(String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT user_id, email, expires_at, used_at FROM recovery_email_challenges \
         WHERE token_hash = ? AND purpose = ?",
    )
    .bind(hash_token(token.trim()))
    .bind(purpose)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| Refusal::Unknown)?;
    let (user_id, email, expires_at, used_at) = row.ok_or(Refusal::Unknown)?;
    if used_at.is_some() {
        return Err(Refusal::Spent);
    }
    if now_ms() >= expires_at {
        return Err(Refusal::Expired);
    }
    // The claim must still be current.
    let current = load(state, &user_id).await.map_err(|_| Refusal::Unknown)?;
    if current.pending.as_deref() != Some(email.as_str()) {
        return Err(Refusal::Stale);
    }
    Ok(Claim { user_id, email })
}

async fn burn(state: &AppState, token: &str, purpose: &str) -> Result<(), Refusal> {
    let spent = sqlx::query(
        "UPDATE recovery_email_challenges SET used_at = ? \
         WHERE token_hash = ? AND purpose = ? AND used_at IS NULL",
    )
    .bind(now_ms())
    .bind(hash_token(token.trim()))
    .bind(purpose)
    .execute(&state.pool)
    .await
    .map_err(|_| Refusal::Unknown)?;
    if spent.rows_affected() != 1 {
        return Err(Refusal::Spent);
    }
    Ok(())
}

pub async fn confirm_page(State(state): State<AppState>, Query(p): Query<LinkParams>) -> Response {
    match inspect(&state, &p.t, PURPOSE_CONFIRM).await {
        Ok(claim) => crate::routes::alerts::render_page(
            StatusCode::OK,
            "Confirm this recovery address",
            format!(
                "<p>Confirming tells <strong>{server}</strong> that <strong>{email}</strong> is \
                 reachable and belongs to whoever holds the account <strong>{user}</strong>.</p>\
                 <p>Security warnings about that account will then be sent here. This does not \
                 sign anybody in and gives nobody access to the account.</p>\
                 <form method=\"post\" action=\"confirm\">\
                 <input type=\"hidden\" name=\"t\" value=\"{token}\">\
                 <button type=\"submit\">Confirm this address</button></form>",
                server = crate::routes::alerts::escape(&state.cfg.server_name),
                email = crate::routes::alerts::escape(&claim.email),
                user = crate::routes::alerts::escape(&claim.user_id),
                token = crate::routes::alerts::escape(&p.t),
            ),
        ),
        Err(refusal) => refused(refusal),
    }
}

pub async fn confirm(State(state): State<AppState>, Form(p): Form<LinkParams>) -> Response {
    let outcome = async {
        let claim = inspect(&state, &p.t, PURPOSE_CONFIRM).await?;
        burn(&state, &p.t, PURPOSE_CONFIRM).await?;
        let updated = sqlx::query(
            "UPDATE recovery_addresses SET verified_email = pending_email, verified_at = ?, \
             pending_email = NULL, pending_since = NULL, bounced_at = NULL, \
             bounce_reason = NULL WHERE user_id = ? AND pending_email = ?",
        )
        .bind(now_ms())
        .bind(&claim.user_id)
        .bind(&claim.email)
        .execute(&state.pool)
        .await
        .map_err(|_| Refusal::Unknown)?;
        if updated.rows_affected() != 1 {
            return Err(Refusal::Stale);
        }
        let _ = sqlx::query(
            "DELETE FROM mail_suppressions WHERE destination_hash = ?",
        )
        .bind(crate::util::hash_token(&claim.email.trim().to_lowercase()))
        .execute(&state.pool)
        .await;
        announce(&state, &claim.user_id).await;
        Ok::<String, Refusal>(claim.email)
    }
    .await;

    match outcome {
        Ok(email) => crate::routes::alerts::render_page(
            StatusCode::OK,
            "This address is confirmed",
            format!(
                "<p><strong>{email}</strong> is now where {server} sends security warnings \
                 about that account.</p>\
                 <p>Every message we send here carries a link that undoes this, so you can \
                 stop it at any time without an account.</p>",
                email = crate::routes::alerts::escape(&email),
                server = crate::routes::alerts::escape(&state.cfg.server_name),
            ),
        ),
        Err(refusal) => refused(refusal),
    }
}

pub async fn disown_page(State(state): State<AppState>, Query(p): Query<LinkParams>) -> Response {
    match inspect(&state, &p.t, PURPOSE_DISOWN).await {
        Ok(claim) => crate::routes::alerts::render_page(
            StatusCode::OK,
            "Stop sending to this address",
            format!(
                "<p>Somebody asked {server} to send security warnings about an account to \
                 <strong>{email}</strong>.</p>\
                 <p>This detaches the address from that account and stops {server} sending \
                 here. It does not tell us anything about you and does not create an \
                 account.</p>\
                 <form method=\"post\" action=\"disown\">\
                 <input type=\"hidden\" name=\"t\" value=\"{token}\">\
                 <button type=\"submit\">Stop sending to this address</button></form>",
                server = crate::routes::alerts::escape(&state.cfg.server_name),
                email = crate::routes::alerts::escape(&claim.email),
                token = crate::routes::alerts::escape(&p.t),
            ),
        ),
        Err(refusal) => refused(refusal),
    }
}

pub async fn disown(State(state): State<AppState>, Form(p): Form<LinkParams>) -> Response {
    let outcome = async {
        let claim = inspect(&state, &p.t, PURPOSE_DISOWN).await?;
        burn(&state, &p.t, PURPOSE_DISOWN).await?;
        sqlx::query(
            "UPDATE recovery_addresses SET pending_email = NULL, pending_since = NULL \
             WHERE user_id = ? AND pending_email = ?",
        )
        .bind(&claim.user_id)
        .bind(&claim.email)
        .execute(&state.pool)
        .await
        .map_err(|_| Refusal::Unknown)?;
        sqlx::query(
            "UPDATE recovery_addresses SET verified_email = NULL, verified_at = NULL \
             WHERE user_id = ? AND verified_email = ?",
        )
        .bind(&claim.user_id)
        .bind(&claim.email)
        .execute(&state.pool)
        .await
        .map_err(|_| Refusal::Unknown)?;
        let _ = mail::suppress(&state, &claim.email, "disowned", mail::SUPPRESSION_MS).await;
        announce(&state, &claim.user_id).await;
        Ok::<(), Refusal>(())
    }
    .await;

    match outcome {
        Ok(()) => crate::routes::alerts::render_page(
            StatusCode::OK,
            "We will stop sending here",
            format!(
                "<p>{server} will not send to this address again for the next 30 days, and it \
                 is no longer attached to that account.</p>\
                 <p>Nothing else was changed, and no account was created or altered beyond \
                 removing this address.</p>",
                server = crate::routes::alerts::escape(&state.cfg.server_name),
            ),
        ),
        Err(refusal) => refused(refusal),
    }
}

fn refused(refusal: Refusal) -> Response {
    crate::routes::alerts::render_page(
        refusal.status(),
        "This link cannot be used",
        format!("<p>{}</p>", crate::routes::alerts::escape(&refusal.words())),
    )
}

pub async fn hard_bounce(state: &AppState, email: &str, reason: &str) -> ApiResult<usize> {
    let now = now_ms();
    let affected: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM recovery_addresses WHERE verified_email = ? OR pending_email = ?",
    )
    .bind(email)
    .bind(email)
    .fetch_all(&state.pool)
    .await?;

    sqlx::query(
        "UPDATE recovery_addresses SET verified_email = NULL, verified_at = NULL, \
         bounced_at = ?, bounce_reason = ? WHERE verified_email = ?",
    )
    .bind(now)
    .bind(reason)
    .bind(email)
    .execute(&state.pool)
    .await?;
    sqlx::query(
        "UPDATE recovery_addresses SET pending_email = NULL, pending_since = NULL, \
         bounced_at = ?, bounce_reason = ? WHERE pending_email = ?",
    )
    .bind(now)
    .bind(reason)
    .bind(email)
    .execute(&state.pool)
    .await?;
    sqlx::query("DELETE FROM recovery_email_challenges WHERE email = ? AND used_at IS NULL")
        .bind(email)
        .execute(&state.pool)
        .await?;

    mail::suppress(state, email, "hard_bounce", mail::SUPPRESSION_MS).await?;

    for user_id in &affected {
        announce(state, user_id).await;
        crate::routes::push::notify(state, user_id, json!({ "type": "recovery_email" })).await;
    }
    Ok(affected.len())
}

async fn announce(state: &AppState, user_id: &str) {
    let Ok(current) = load(state, user_id).await else {
        return;
    };
    let event = std::sync::Arc::new(crate::gateway::events::Event {
        t: "RECOVERY_EMAIL_UPDATE",
        guild_id: String::new(),
        channel_id: None,
        intent: 0,
        only_user: Some(user_id.to_string()),
        data: current.json(state),
    });
    state.hub.publish_user(user_id, event).await;
}

#[derive(Deserialize)]
pub struct BounceReport {
    pub email: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn report_bounce(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<BounceReport>,
) -> ApiResult<Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    let email = req.email.trim().to_string();
    if email.is_empty() {
        return Err(ApiError::BadRequest("a bounce has to name an address".into()));
    }
    let reason = req.reason.unwrap_or_else(|| "reported by the mail system".into());
    if req.kind.as_deref() != Some("hard") {
        tracing::info!(target: crate::logcat::AUTH, reason = %reason, "a soft bounce was reported for a recovery address");
        return Ok(Json(json!({ "accounts_affected": 0, "retired": false })));
    }
    let affected = hard_bounce(&state, &email, &reason).await?;
    Ok(Json(json!({ "accounts_affected": affected, "retired": true })))
}

pub async fn forget(state: &AppState, user_id: &str) -> ApiResult<()> {
    let before = load(state, user_id).await?;
    sqlx::query("DELETE FROM recovery_addresses WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    sqlx::query("DELETE FROM recovery_email_challenges WHERE user_id = ?")
        .bind(user_id)
        .execute(&state.pool)
        .await?;
    if let Some(old) = verified_from(before.verified) {
        let text = format!(
            "The account {user} has left {server}, so {server} will not send security \
             warnings about it to this address again.\n\n\
             If the account moved to another server, that server has not been told this \
             address -- a confirmed address is this server's record of a mailbox answering \
             a challenge, and it is not ours to hand on. Set one up there to keep getting \
             warnings.\n",
            user = user_id,
            server = state.cfg.server_name,
        );
        let _ = deliver_to_snapshot(
            state,
            &old,
            user_id,
            "This account has left the server",
            &text,
        )
        .await;
    }
    Ok(())
}

fn verified_from(verified: Option<String>) -> Option<String> {
    verified.filter(|a| !a.is_empty())
}

async fn deliver_to_snapshot(
    state: &AppState,
    email: &str,
    user_id: &str,
    subject: &str,
    text: &str,
) -> ApiResult<Result<(), Refused>> {
    mail::send_challenge(state, email, user_id, subject, text).await
}

#[cfg(test)]
mod tests {
    use super::AddressState;

    #[test]
    fn the_state_word_says_which_of_the_four_this_is() {
        let mut s = AddressState::empty();
        assert_eq!(s.word(), "none");

        s.pending = Some("a@b.test".into());
        assert_eq!(s.word(), "pending");

        s.verified = Some("old@b.test".into());
        assert_eq!(s.word(), "verified");

        s.verified = None;
        s.pending = None;
        s.bounced_at = Some(1);
        assert_eq!(s.word(), "bounced");

        s.pending = Some("new@b.test".into());
        assert_eq!(s.word(), "pending");
    }
}
