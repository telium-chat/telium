
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{hash_token, now_ms};
use serde_json::json;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Verify,
    Notice,
}

impl Purpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Verify => "verify",
            Purpose::Notice => "notice",
        }
    }
}

pub struct VerifiedAddress(String);

impl VerifiedAddress {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

pub fn configured(state: &AppState) -> bool {
    state.cfg.mail.mode == "webhook"
}

pub async fn verified_recovery_address(
    state: &AppState,
    user_id: &str,
) -> ApiResult<Option<VerifiedAddress>> {
    let address: Option<Option<String>> =
        sqlx::query_scalar("SELECT verified_email FROM recovery_addresses WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(address.flatten().filter(|a| !a.is_empty()).map(VerifiedAddress))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refused {
    NoMailer,
    Suppressed { reason: String, until: i64 },
    RateLimited { scope: &'static str, retry_after_ms: i64 },
}

impl Refused {
    pub fn words(&self) -> String {
        match self {
            Refused::NoMailer => {
                "This server is not set up to send email, so nothing was sent.".into()
            }
            Refused::Suppressed { .. } => {
                "This server is not sending to that address at the moment: it refused an \
                 earlier message, or somebody there asked us to stop. Try again later, or \
                 use a different address."
                    .into()
            }
            Refused::RateLimited { retry_after_ms, .. } => {
                format!(
                    "Too many messages have been sent recently. Try again in about {} minutes.",
                    (retry_after_ms / 60_000).max(1)
                )
            }
        }
    }
}

struct Budget {
    window_ms: i64,
    max: i64,
}

struct Gate;

impl Gate {
    fn per_destination(purpose: Purpose) -> Budget {
        match purpose {
            Purpose::Verify => Budget { window_ms: 24 * 3_600_000, max: 5 },
            Purpose::Notice => Budget { window_ms: 3_600_000, max: 10 },
        }
    }

    fn per_account() -> Budget {
        Budget { window_ms: 3_600_000, max: 15 }
    }

    fn per_server() -> Budget {
        Budget { window_ms: 3_600_000, max: 500 }
    }
}

fn destination_key(email: &str) -> String {
    hash_token(&email.trim().to_lowercase())
}

async fn suppression(state: &AppState, email: &str) -> ApiResult<Option<(String, i64)>> {
    let row: Option<(String, i64)> = sqlx::query_as(
        "SELECT reason, expires_at FROM mail_suppressions \
         WHERE destination_hash = ? AND expires_at > ?",
    )
    .bind(destination_key(email))
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await?;
    Ok(row)
}

pub async fn suppress(state: &AppState, email: &str, reason: &str, window_ms: i64) -> ApiResult<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO mail_suppressions (destination_hash, reason, created_at, expires_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT(destination_hash) DO UPDATE SET \
         reason = excluded.reason, created_at = excluded.created_at, \
         expires_at = MAX(mail_suppressions.expires_at, excluded.expires_at)",
    )
    .bind(destination_key(email))
    .bind(reason)
    .bind(now)
    .bind(now + window_ms)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub const SUPPRESSION_MS: i64 = 30 * 24 * 3_600_000;

async fn allowed(
    state: &AppState,
    email: &str,
    user_id: Option<&str>,
    purpose: Purpose,
) -> ApiResult<Result<(), Refused>> {
    if let Some((reason, until)) = suppression(state, email).await? {
        return Ok(Err(Refused::Suppressed { reason, until }));
    }
    let now = now_ms();

    let verdict = |oldest: Option<i64>, budget: &Budget, scope: &'static str| match oldest {
        Some(oldest) => Err(Refused::RateLimited {
            scope,
            retry_after_ms: (oldest + budget.window_ms - now).max(1),
        }),
        None => Ok(()),
    };

    let budget = Gate::per_destination(purpose);
    let oldest: Option<i64> = sqlx::query_scalar(
        "SELECT created_at FROM mail_sends WHERE destination_hash = ? AND purpose = ? \
         AND created_at > ? ORDER BY created_at DESC LIMIT 1 OFFSET ?",
    )
    .bind(destination_key(email))
    .bind(purpose.as_str())
    .bind(now - budget.window_ms)
    .bind(budget.max - 1)
    .fetch_optional(&state.pool)
    .await?;
    if let Err(refusal) = verdict(oldest, &budget, "destination") {
        return Ok(Err(refusal));
    }

    if let Some(user_id) = user_id {
        let budget = Gate::per_account();
        let oldest: Option<i64> = sqlx::query_scalar(
            "SELECT created_at FROM mail_sends WHERE user_id = ? AND created_at > ? \
             ORDER BY created_at DESC LIMIT 1 OFFSET ?",
        )
        .bind(user_id)
        .bind(now - budget.window_ms)
        .bind(budget.max - 1)
        .fetch_optional(&state.pool)
        .await?;
        if let Err(refusal) = verdict(oldest, &budget, "account") {
            return Ok(Err(refusal));
        }
    }

    let budget = Gate::per_server();
    let oldest: Option<i64> = sqlx::query_scalar(
        "SELECT created_at FROM mail_sends WHERE created_at > ? ORDER BY created_at DESC \
         LIMIT 1 OFFSET ?",
    )
    .bind(now - budget.window_ms)
    .bind(budget.max - 1)
    .fetch_optional(&state.pool)
    .await?;
    if let Err(refusal) = verdict(oldest, &budget, "server") {
        return Ok(Err(refusal));
    }

    Ok(Ok(()))
}

async fn record(
    state: &AppState,
    email: &str,
    user_id: Option<&str>,
    purpose: Purpose,
    state_word: &str,
    attempts: i64,
    error: Option<String>,
) {
    let _ = sqlx::query(
        "INSERT INTO mail_sends (destination_hash, user_id, purpose, created_at, state, \
         attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(destination_key(email))
    .bind(user_id)
    .bind(purpose.as_str())
    .bind(now_ms())
    .bind(state_word)
    .bind(attempts)
    .bind(error)
    .execute(&state.pool)
    .await;
}

pub async fn cleanup(state: &AppState) {
    let cutoff = now_ms() - 48 * 3_600_000;
    let _ = sqlx::query("DELETE FROM mail_sends WHERE created_at < ?")
        .bind(cutoff)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("DELETE FROM mail_suppressions WHERE expires_at < ?")
        .bind(now_ms())
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("DELETE FROM recovery_email_challenges WHERE expires_at < ?")
        .bind(now_ms())
        .execute(&state.pool)
        .await;
}

const RETRY_BACKOFF_MS: [u64; 2] = [2_000, 8_000];

fn permanent(status: reqwest::StatusCode) -> bool {
    status.is_client_error()
}

async fn attempt(state: &AppState, to: &str, subject: &str, text: &str) -> Result<(), (String, bool)> {
    let from = if state.cfg.mail.from.is_empty() {
        format!("noreply@{}", state.cfg.server_name)
    } else {
        state.cfg.mail.from.clone()
    };
    let mut req = state
        .http
        .post(&state.cfg.mail.webhook_url)
        .timeout(std::time::Duration::from_secs(15))
        .json(&json!({ "to": to, "from": from, "subject": subject, "text": text }));
    if !state.cfg.mail.webhook_token.is_empty() {
        req = req.bearer_auth(&*state.cfg.mail.webhook_token);
    }
    match req.send().await {
        Err(e) => Err((format!("mail webhook unreachable: {e}"), true)),
        Ok(resp) if resp.status().is_success() => Ok(()),
        Ok(resp) => {
            let status = resp.status();
            Err((format!("mail webhook answered {status}"), !permanent(status)))
        }
    }
}

async fn deliver(
    state: &AppState,
    to: &str,
    user_id: Option<&str>,
    purpose: Purpose,
    subject: &str,
    text: &str,
) -> ApiResult<Result<(), Refused>> {
    if !configured(state) {
        return Ok(Err(Refused::NoMailer));
    }
    if let Err(refusal) = allowed(state, to, user_id, purpose).await? {
        return Ok(Err(refusal));
    }

    let mut tries = 0i64;
    let mut last = String::new();
    for backoff in std::iter::once(None).chain(RETRY_BACKOFF_MS.iter().map(|ms| Some(*ms))) {
        if let Some(ms) = backoff {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        tries += 1;
        match attempt(state, to, subject, text).await {
            Ok(()) => {
                record(state, to, user_id, purpose, "sent", tries, None).await;
                return Ok(Ok(()));
            }
            Err((error, retryable)) => {
                last = error;
                if !retryable {
                    record(state, to, user_id, purpose, "refused", tries, Some(last.clone())).await;
                    return Err(ApiError::BadRequest(last));
                }
            }
        }
    }
    record(state, to, user_id, purpose, "failed", tries, Some(last.clone())).await;
    Err(ApiError::BadRequest(last))
}

pub async fn send_notice(
    state: &AppState,
    to: &VerifiedAddress,
    user_id: &str,
    subject: &str,
    text: &str,
) -> ApiResult<Result<(), Refused>> {
    deliver(state, &to.0, Some(user_id), Purpose::Notice, subject, text).await
}

pub async fn send_challenge(
    state: &AppState,
    to: &str,
    user_id: &str,
    subject: &str,
    text: &str,
) -> ApiResult<Result<(), Refused>> {
    deliver(state, to, Some(user_id), Purpose::Verify, subject, text).await
}

pub fn plausible_address(email: &str) -> bool {
    let Some((local, domain)) = email.rsplit_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && domain.contains('.')
        && email.len() <= 254
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[cfg(test)]
mod tests {
    use super::{destination_key, plausible_address, Purpose};

    #[test]
    fn addresses_are_held_to_a_shape_and_no_more() {
        assert!(plausible_address("alice@example.com"));
        assert!(plausible_address("a.b+c@sub.example.org"));
        assert!(!plausible_address("alice"));
        assert!(!plausible_address("@example.com"));
        assert!(!plausible_address("alice@"));
        assert!(!plausible_address("alice@localhost"));
        assert!(!plausible_address("alice @example.com"));
    }

    #[test]
    fn one_mailbox_is_one_budget_however_it_is_capitalised() {
        let plain = destination_key("victim@example.com");
        assert_eq!(plain, destination_key("Victim@Example.COM"));
        assert_eq!(plain, destination_key("  victim@example.com  "));
        assert_ne!(plain, destination_key("victim2@example.com"));
    }

    #[test]
    fn the_ledger_key_is_not_the_address() {
        assert!(!destination_key("victim@example.com").contains("victim"));
    }

    #[test]
    fn purposes_have_stable_names() {
        assert_eq!(Purpose::Verify.as_str(), "verify");
        assert_eq!(Purpose::Notice.as_str(), "notice");
    }
}
