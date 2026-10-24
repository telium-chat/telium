
use crate::auth::HomeAuth;
use crate::crypto;
use crate::error::ApiResult;
use crate::gateway::events::Event;
use crate::state::AppState;
use crate::util::{b64, hash_token, now_ms, random_token, unb64};
use axum::extract::{Form, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

const LINK_KIND: &str = "migration_cancel";

async fn describe(state: &AppState, migration_id: &str) -> ApiResult<Option<Value>> {
    let row: Option<(String, String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT subject_type, subject_id, destination, state, created_at, executes_at \
         FROM migrations WHERE id = ?",
    )
    .bind(migration_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.map(|(subject_type, subject_id, destination, st, created_at, executes_at)| {
        json!({ "id": migration_id, "subject_type": subject_type, "subject_id": subject_id,
                "destination": destination, "state": st, "created_at": created_at,
                "executes_at": executes_at })
    }))
}

fn account_event(t: &'static str, user_id: &str, data: Value) -> Arc<Event> {
    Arc::new(Event {
        t,
        guild_id: String::new(),
        channel_id: None,
        intent: 0,
        only_user: Some(user_id.to_string()),
        data,
    })
}

pub async fn migration_requested(state: &AppState, migration_id: &str, user_id: &str) {
    if let Err(e) = announce(state, migration_id, user_id).await {
        tracing::warn!(target: crate::logcat::MIGRATION, migration = %migration_id, error = %e, "could not raise the migration alert");
    }
}

async fn announce(state: &AppState, migration_id: &str, user_id: &str) -> ApiResult<()> {
    let Some(alert) = describe(state, migration_id).await? else {
        return Ok(());
    };
    let unsent = if crate::mail::verified_recovery_address(state, user_id).await?.is_none() {
        Some("no_address")
    } else if !crate::mail::configured(state) {
        Some("no_mailer")
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO migration_alerts (migration_id, user_id, notified_at, email_state) \
         VALUES (?, ?, ?, ?) ON CONFLICT(migration_id) DO UPDATE SET \
         user_id = excluded.user_id, notified_at = excluded.notified_at, \
         email_state = excluded.email_state, email_error = NULL",
    )
    .bind(migration_id)
    .bind(user_id)
    .bind(now_ms())
    .bind(unsent.unwrap_or("pending"))
    .execute(&state.pool)
    .await?;

    state.hub.publish_user(user_id, account_event("MIGRATION_ALERT", user_id, alert.clone())).await;
    crate::routes::push::notify_migration(state, user_id, migration_id).await?;

    if unsent.is_some() {
        return Ok(());
    }

    let state = state.clone();
    let id = migration_id.to_string();
    let user = user_id.to_string();
    tokio::spawn(async move {
        let (outcome, error) = match email(&state, &id, &user, &alert).await {
            Ok(outcome) => (outcome, None),
            Err(e) => {
                tracing::warn!(target: crate::logcat::MIGRATION, migration = %id, error = %e, "the migration warning email was not sent");
                ("failed", Some(e.to_string()))
            }
        };
        let _ = sqlx::query(
            "UPDATE migration_alerts SET email_state = ?, email_error = ? WHERE migration_id = ?",
        )
        .bind(outcome)
        .bind(error)
        .bind(&id)
        .execute(&state.pool)
        .await;
    });
    Ok(())
}

async fn email(state: &AppState, migration_id: &str, user_id: &str, alert: &Value) -> ApiResult<&'static str> {
    let Some(address) = crate::mail::verified_recovery_address(state, user_id).await? else {
        return Ok("no_address");
    };
    if !crate::mail::configured(state) {
        return Ok("no_mailer");
    }
    let subject_type = alert["subject_type"].as_str().unwrap_or("user");
    let subject_id = alert["subject_id"].as_str().unwrap_or_default();
    let destination = alert["destination"].as_str().unwrap_or_default();
    let executes_at = alert["executes_at"].as_i64().unwrap_or_default();
    let link = cancel_link(state, migration_id, subject_id, executes_at).await?;
    let what = if subject_type == "guild" {
        format!("the guild {subject_id}, which {user_id} owns,")
    } else {
        format!("the account {user_id}")
    };
    let subject = format!("A move of {} to {destination} was requested", if subject_type == "guild" { "your guild" } else { "your account" });
    let text = format!(
        "Someone signed in as {user_id} asked {server} to move {what} to {destination}.\n\n\
         It will move at {deadline}. Until then any device signed in to the account can \
         cancel it, and so can this link, which works without signing in and can be used once:\n\n\
         {link}\n\n\
         If you asked for this move, there is nothing to do.\n\n\
         If you did not, cancel it and then change your password: whoever asked had it.\n",
        server = state.cfg.server_name,
        deadline = utc(executes_at),
    );
    match crate::mail::send_notice(state, &address, user_id, &subject, &text).await? {
        Ok(()) => Ok("sent"),
        Err(crate::mail::Refused::NoMailer) => Ok("no_mailer"),
        Err(crate::mail::Refused::Suppressed { .. }) => Ok("suppressed"),
        Err(crate::mail::Refused::RateLimited { .. }) => Ok("rate_limited"),
    }
}

pub async fn cancel_link(
    state: &AppState,
    migration_id: &str,
    subject_id: &str,
    expires_at: i64,
) -> ApiResult<String> {
    let nonce = random_token(24);
    sqlx::query(
        "INSERT INTO migration_cancel_links (nonce_hash, migration_id, expires_at, created_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&nonce))
    .bind(migration_id)
    .bind(expires_at)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    let signed = crypto::sign_json(
        &state.key,
        json!({ "kind": LINK_KIND, "migration_id": migration_id, "subject_id": subject_id,
                "expires_at": expires_at, "nonce": nonce }),
    );
    let token = b64(signed.to_string().as_bytes());
    Ok(format!(
        "{}/_telium/v1/migrate/cancel-link?t={token}",
        state.cfg.public_base_url.trim_end_matches('/')
    ))
}

struct Claims {
    migration_id: String,
    subject_id: String,
    expires_at: i64,
    nonce: String,
}

enum Refusal {
    Malformed,
    Expired,
    Spent,
    NotThisMigration,
    Settled(String),
}

impl Refusal {
    fn status(&self) -> StatusCode {
        match self {
            Refusal::Malformed => StatusCode::BAD_REQUEST,
            Refusal::Expired | Refusal::Spent => StatusCode::GONE,
            Refusal::NotThisMigration => StatusCode::NOT_FOUND,
            Refusal::Settled(_) => StatusCode::CONFLICT,
        }
    }

    fn words(&self) -> String {
        match self {
            Refusal::Malformed => "This link is damaged or was not issued by this server.".into(),
            Refusal::Expired => "This link has expired: the cooling-off window it was issued for is over.".into(),
            Refusal::Spent => "This link has already been used.".into(),
            Refusal::NotThisMigration => {
                "This link is not for a move that is waiting. If the move was started again, \
                 the newer email has the link that works."
                    .into()
            }
            Refusal::Settled(st) => format!("This move can no longer be cancelled: it is {st}."),
        }
    }
}

fn read_token(state: &AppState, token: &str) -> Result<Claims, Refusal> {
    let raw = unb64(token.trim()).ok_or(Refusal::Malformed)?;
    let value: Value = serde_json::from_slice(&raw).map_err(|_| Refusal::Malformed)?;
    if value.get("kind").and_then(Value::as_str) != Some(LINK_KIND) {
        return Err(Refusal::Malformed);
    }
    if !crypto::verify_json(&state.key.public_b64(), &value) {
        return Err(Refusal::Malformed);
    }
    let text = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(Claims {
        migration_id: text("migration_id").ok_or(Refusal::Malformed)?,
        subject_id: text("subject_id").ok_or(Refusal::Malformed)?,
        nonce: text("nonce").ok_or(Refusal::Malformed)?,
        expires_at: value.get("expires_at").and_then(Value::as_i64).ok_or(Refusal::Malformed)?,
    })
}

async fn check(state: &AppState, claims: &Claims) -> Result<Value, Refusal> {
    if now_ms() >= claims.expires_at {
        return Err(Refusal::Expired);
    }
    let used: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT used_at FROM migration_cancel_links WHERE nonce_hash = ? AND migration_id = ?",
    )
    .bind(hash_token(&claims.nonce))
    .bind(&claims.migration_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| Refusal::Malformed)?;
    match used {
        None => return Err(Refusal::NotThisMigration),
        Some(Some(_)) => return Err(Refusal::Spent),
        Some(None) => {}
    }
    let alert = describe(state, &claims.migration_id)
        .await
        .map_err(|_| Refusal::Malformed)?
        .ok_or(Refusal::NotThisMigration)?;
    if alert["subject_id"].as_str() != Some(claims.subject_id.as_str())
        || alert["executes_at"].as_i64() != Some(claims.expires_at)
    {
        return Err(Refusal::NotThisMigration);
    }
    let st = alert["state"].as_str().unwrap_or_default();
    if st != "pending" && st != "ready" {
        return Err(Refusal::Settled(st.to_string()));
    }
    Ok(alert)
}

async fn redeem(state: &AppState, token: &str) -> Result<Value, Refusal> {
    let claims = read_token(state, token)?;
    let alert = check(state, &claims).await?;
    let spent = sqlx::query(
        "UPDATE migration_cancel_links SET used_at = ? \
         WHERE nonce_hash = ? AND migration_id = ? AND used_at IS NULL",
    )
    .bind(now_ms())
    .bind(hash_token(&claims.nonce))
    .bind(&claims.migration_id)
    .execute(&state.pool)
    .await
    .map_err(|_| Refusal::Malformed)?;
    if spent.rows_affected() != 1 {
        return Err(Refusal::Spent);
    }
    let cancelled = crate::routes::migrate::mark_cancelled(
        state,
        &claims.migration_id,
        "cancelled from the link in the recovery email",
    )
    .await
    .map_err(|_| Refusal::Malformed)?;
    if !cancelled {
        return Err(Refusal::Settled("already under way".into()));
    }
    migration_settled(state, &claims.migration_id).await;
    Ok(alert)
}

pub async fn migration_settled(state: &AppState, migration_id: &str) {
    let Ok(Some(alert)) = describe(state, migration_id).await else {
        return;
    };
    let told: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM migration_alerts WHERE migration_id = ?")
            .bind(migration_id)
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten();
    let user = match told {
        Some(user) => Some(user),
        None if alert["subject_type"] == "user" => alert["subject_id"].as_str().map(str::to_string),
        None => sqlx::query_scalar("SELECT owner_user_id FROM guilds WHERE id = ?")
            .bind(alert["subject_id"].as_str().unwrap_or_default())
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten(),
    };
    if let Some(user) = user {
        state.hub.publish_user(&user, account_event("MIGRATION_UPDATE", &user, alert)).await;
    }
}

pub async fn list(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    let rows: Vec<(String, String, String, String, String, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT m.id, m.subject_type, m.subject_id, m.destination, m.state, m.created_at, \
         m.executes_at, a.email_state FROM migrations m \
         LEFT JOIN guilds g ON g.id = m.subject_id \
         LEFT JOIN migration_alerts a ON a.migration_id = m.id \
         WHERE (m.subject_id = ? OR g.owner_user_id = ?) AND m.state IN ('pending', 'ready') \
         ORDER BY m.executes_at LIMIT 20",
    )
    .bind(&auth.user_id)
    .bind(&auth.user_id)
    .fetch_all(&state.pool)
    .await?;
    let alerts: Vec<Value> = rows
        .into_iter()
        .map(|(id, ty, subject, destination, st, created, executes, email)| {
            json!({ "id": id, "subject_type": ty, "subject_id": subject,
                    "destination": destination, "state": st, "created_at": created,
                    "executes_at": executes, "email": email })
        })
        .collect();
    Ok(Json(json!({ "alerts": alerts })))
}

#[derive(Deserialize)]
pub struct LinkParams {
    pub t: String,
}

pub async fn link_page(State(state): State<AppState>, Query(params): Query<LinkParams>) -> Response {
    let outcome = match read_token(&state, &params.t) {
        Ok(claims) => check(&state, &claims).await,
        Err(refusal) => Err(refusal),
    };
    match outcome {
        Ok(alert) => render_page(
            StatusCode::OK,
            "Cancel this move?",
            format!(
                "<p>{what} is set to move to <strong>{destination}</strong> at {deadline}.</p>\
                 <p>Cancelling stops the move. The account stays where it is and nothing is lost.</p>\
                 <form method=\"post\" action=\"cancel-link\">\
                 <input type=\"hidden\" name=\"t\" value=\"{token}\">\
                 <button type=\"submit\">Cancel the move</button></form>",
                what = escape(&subject_words(&alert)),
                destination = escape(alert["destination"].as_str().unwrap_or_default()),
                deadline = utc(alert["executes_at"].as_i64().unwrap_or_default()),
                token = escape(&params.t),
            ),
        ),
        Err(refusal) => render_page(refusal.status(), "This link cannot be used", format!("<p>{}</p>", escape(&refusal.words()))),
    }
}

pub async fn link_cancel(State(state): State<AppState>, Form(params): Form<LinkParams>) -> Response {
    match redeem(&state, &params.t).await {
        Ok(alert) => render_page(
            StatusCode::OK,
            "The move is cancelled",
            format!(
                "<p>{what} will not move to {destination}.</p>\
                 <p>If you did not ask for the move, change your password now: whoever asked had it.</p>",
                what = escape(&subject_words(&alert)),
                destination = escape(alert["destination"].as_str().unwrap_or_default()),
            ),
        ),
        Err(refusal) => render_page(refusal.status(), "This link cannot be used", format!("<p>{}</p>", escape(&refusal.words()))),
    }
}

fn subject_words(alert: &Value) -> String {
    let subject = alert["subject_id"].as_str().unwrap_or_default();
    if alert["subject_type"] == "guild" {
        format!("The guild {subject}")
    } else {
        format!("The account {subject}")
    }
}

const STYLE: &str = "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;\
padding:0 1rem;color:#1a1a1a;background:#fafafa}button{font:inherit;padding:.6rem 1.2rem;\
border:0;border-radius:.5rem;background:#c62828;color:#fff;cursor:pointer}";

pub(crate) fn render_page(status: StatusCode, title: &str, body: String) -> Response {
    let style = STYLE;
    let title = escape(title);
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Html(format!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
             <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
             <meta name=\"referrer\" content=\"no-referrer\"><title>{title}</title>\
             <style>{style}</style></head><body><h1>{title}</h1>{body}</body></html>"
        )),
    )
        .into_response()
}

pub(crate) fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02} UTC", rem / 3600, rem % 3600 / 60)
}

#[cfg(test)]
mod tests {
    use super::{escape, utc};

    #[test]
    fn deadlines_read_as_utc_dates() {
        assert_eq!(utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(utc(1_700_000_000_000), "2023-11-14 22:13 UTC");
        assert_eq!(utc(951_782_400_000), "2000-02-29 00:00 UTC");
    }

    #[test]
    fn page_text_is_escaped() {
        assert_eq!(escape("<a href=\"x\">&'"), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
    }
}
