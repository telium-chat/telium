use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult, Coded};
use crate::federation::{self, Fed};
use crate::gateway::events::Event;
use crate::routes::identity;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct VerificationStep {
    pub to_user: String,
    #[serde(default)]
    pub to_device: Option<String>,
    pub payload: Value,
}

pub(crate) const VERIFY_REQUEST_WINDOW_MS: i64 = 60 * 60 * 1000;

const VERIFY_START: &str = "start";

const VERIFY_SETTLED: [&str; 2] = ["accept", "done"];

fn roughly(ms: i64) -> String {
    let minutes = (ms + 59_999) / 60_000;
    match minutes {
        ..=1 => "in a moment".to_string(),
        2..=10 => format!("in {minutes} minutes"),
        11..=25 => "in about a quarter of an hour".to_string(),
        26..=40 => "in about half an hour".to_string(),
        41..=75 => "in about an hour".to_string(),
        _ => format!("in about {} hours", (minutes + 30) / 60),
    }
}

fn ago(ms: i64) -> String {
    let minutes = ms / 60_000;
    match minutes {
        ..=1 => "a moment ago".to_string(),
        2..=10 => format!("{minutes} minutes ago"),
        11..=25 => "about a quarter of an hour ago".to_string(),
        26..=40 => "about half an hour ago".to_string(),
        _ => "about an hour ago".to_string(),
    }
}

async fn guard_verification_start(
    state: &AppState,
    requester: &str,
    subject: &str,
) -> Result<(), Coded> {
    if identity::is_local_bot(state, subject).await? || identity::is_local_bot(state, requester).await? {
        return Err(Coded::new(
            ApiError::Forbidden(
                "bots do not take part in verification: there is nobody on the other end to compare emoji with".into(),
            ),
            crate::errcodes::PARTY_IS_BOT,
        ));
    }

    let now = now_ms();
    sqlx::query("DELETE FROM verification_requests WHERE requester = ? AND requested_at <= ?")
        .bind(requester)
        .bind(now - VERIFY_REQUEST_WINDOW_MS)
        .execute(&state.pool)
        .await?;

    let standing: Option<i64> = sqlx::query_scalar(
        "SELECT requested_at FROM verification_requests WHERE requester = ? AND subject = ?",
    )
    .bind(requester)
    .bind(subject)
    .fetch_optional(&state.pool)
    .await?;
    if let Some(at) = standing {
        return Err(Coded::new(
            ApiError::RateLimited(format!(
                "you asked to verify them {} and they have not answered yet. \
                 You can ask again {}.",
                ago(now - at),
                roughly(at + VERIFY_REQUEST_WINDOW_MS - now),
            )),
            crate::errcodes::VERIFICATION_ALREADY_REQUESTED,
        ));
    }
    Ok(())
}

async fn record_verification_request(
    state: &AppState,
    requester: &str,
    subject: &str,
    at: i64,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO verification_requests (requester, subject, requested_at) VALUES (?, ?, ?) \
         ON CONFLICT(requester, subject) DO UPDATE SET requested_at = excluded.requested_at",
    )
    .bind(requester)
    .bind(subject)
    .bind(at)
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn relay_verification(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(body): Json<VerificationStep>,
) -> Result<Json<Value>, Coded> {
    if body.payload.to_string().len() > MAX_FRAME_BYTES {
        return Err(ApiError::BadRequest("verification step too large".into()).into());
    }
    let home = home_of(&body.to_user)?;
    let opening = body.payload.get("step").and_then(Value::as_str) == Some(VERIFY_START)
        && body.to_user != auth.user_id;
    if opening {
        guard_verification_start(&state, &auth.user_id, &body.to_user).await?;
    }
    let envelope = json!({
        "from_user": auth.user_id,
        "from_device": auth.device_id,
        "to_user": body.to_user,
        "to_device": body.to_device,
        "payload": body.payload,
        "sent_at": now_ms(),
    });
    if home == state.cfg.server_name {
        deliver_verification(&state, &body.to_user, envelope).await;
    } else {
        federation::ensure_reachable(&state, &home, "dm").await?;
        federation::post_signed(&state, &home, "/_telium/v1/dm/verify", &envelope).await?;
    }
    if !opening {
        return Ok(Json(json!({ "ok": true })));
    }
    let now = now_ms();
    record_verification_request(&state, &auth.user_id, &body.to_user, now).await?;
    Ok(Json(json!({
        "ok": true,
        "request": {
            "subject": body.to_user,
            "requested_at": now,
            "may_ask_again_at": now + VERIFY_REQUEST_WINDOW_MS,
        },
    })))
}

#[derive(Deserialize)]
pub struct RemoteVerification {
    pub from_user: String,
    pub from_device: String,
    pub to_user: String,
    #[serde(default)]
    pub to_device: Option<String>,
    pub payload: Value,
}

pub async fn inbound_verification(
    State(state): State<AppState>,
    fed: Fed<RemoteVerification>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    if home_of(&fed.body.from_user)? != fed.origin {
        return Err(ApiError::Forbidden("a server may only relay for its own users".into()));
    }
    if home_of(&fed.body.to_user)? != state.cfg.server_name {
        return Err(ApiError::NotFound("that user is not ours".into()));
    }
    if identity::is_local_bot(&state, &fed.body.to_user).await? {
        return Err(ApiError::Forbidden(
            "that account is a bot and does not take part in verification".into(),
        ));
    }
    let envelope = json!({
        "from_user": fed.body.from_user,
        "from_device": fed.body.from_device,
        "to_user": fed.body.to_user,
        "to_device": fed.body.to_device,
        "payload": fed.body.payload,
        "sent_at": now_ms(),
    });
    deliver_verification(&state, &fed.body.to_user, envelope).await;
    Ok(Json(json!({ "ok": true })))
}

async fn deliver_verification(state: &AppState, user_id: &str, envelope: Value) {
    let answered = envelope
        .get("payload")
        .and_then(|p| p.get("step"))
        .and_then(Value::as_str)
        .is_some_and(|step| VERIFY_SETTLED.contains(&step));
    if answered {
        if let Some(subject) = envelope.get("from_user").and_then(Value::as_str) {
            // Logged and swallowed: the step must go out.
            if let Err(err) = sqlx::query(
                "DELETE FROM verification_requests WHERE requester = ? AND subject = ?",
            )
            .bind(user_id)
            .bind(subject)
            .execute(&state.pool)
            .await
            {
                tracing::debug!(target: crate::logcat::SOCIAL, %err, %user_id, %subject, "could not clear a verification request");
            }
        }
    }
    state
        .hub
        .publish_user(user_id, Event::to_account("VERIFICATION", user_id, envelope))
        .await;
}
