use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct SendFrame {
    #[serde(default = "application_kind")]
    pub kind: String,
    pub ciphertext: String,
    #[serde(default)]
    pub epoch: i64,
    #[serde(default)]
    pub notification_id: Option<String>,
    #[serde(default)]
    pub change: Option<Change>,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub frame_id: Option<String>,
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub generation: Option<i64>,
    #[serde(default)]
    pub start_over: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Change {
    pub op: String,
    #[serde(default)]
    pub user_ids: Vec<String>,
    #[serde(default)]
    pub policy: Option<Value>,
}

fn application_kind() -> String {
    "application".to_string()
}

pub async fn send_frame(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<SendFrame>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if req.ciphertext.len() > MAX_FRAME_BYTES {
        return Err(ApiError::TooLarge("frame is too large".into()));
    }
    refuse_revoked_sender(&state, &auth, &req.kind, &req.ciphertext).await?;
    if !matches!(
        req.kind.as_str(),
        "application" | "commit" | "proposal" | "welcome" | "groupinfo" | "rejoin"
    ) {
        return Err(ApiError::BadRequest("unknown frame kind".into()));
    }
    if let Some(notification_id) = req.notification_id.as_deref() {
        validate_notification_id(notification_id)?;
        if req.kind != "application" {
            return Err(ApiError::BadRequest(
                "only application frames carry a DM notification id".into(),
            ));
        }
    }
    let extras = FrameExtras {
        notification_id: req.notification_id.as_deref(),
        frame_id: req.frame_id.as_deref(),
        welcome: req.welcome.as_deref(),
        generation: req.generation,
        start_over: req.start_over,
    };
    validate_extras(&req.kind, &extras)?;

    let answer = route_frame(
        &state,
        &id,
        &req.kind,
        &auth,
        &req.ciphertext,
        req.epoch,
        extras,
        req.change.as_ref(),
        req.notify,
    )
    .await?;
    Ok(Json(answer))
}

async fn refuse_revoked_sender(
    state: &AppState,
    auth: &HomeAuth,
    kind: &str,
    ciphertext: &str,
) -> ApiResult<()> {
    let own: Option<Option<String>> =
        sqlx::query_scalar("SELECT mls_key FROM devices WHERE device_id = ?")
            .bind(&auth.device_id)
            .fetch_optional(&state.pool)
            .await?;
    let named = if kind == "rejoin" {
        ciphertext.strip_prefix("key:").map(str::to_string)
    } else {
        None
    };
    for key in own.flatten().into_iter().chain(named) {
        if super::super::identity_continuity::is_revoked_key(state, &auth.user_id, &key).await? {
            return Err(ApiError::Forbidden("this device key has been revoked".into()));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn route_frame(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    auth: &HomeAuth,
    ciphertext: &str,
    epoch: i64,
    extras: FrameExtras<'_>,
    change: Option<&Change>,
    notify: bool,
) -> ApiResult<Value> {
    let mut followed = false;
    loop {
        let sequencer: String =
            sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
                .bind(conversation_id)
                .fetch_one(&state.pool)
                .await?;
        let attempt = if sequencer == state.cfg.server_name {
            sequence_with_change(
                state,
                conversation_id,
                kind,
                &auth.user_id,
                Some(&auth.device_id),
                ciphertext,
                epoch,
                extras,
                change,
                notify,
            )
            .await
        } else {
            federation::ensure_reachable(state, &sequencer, "dm").await?;
            submit_remote(
                state, &sequencer, conversation_id, kind, auth, ciphertext, epoch, extras, change,
                notify,
            )
            .await
        };
        match attempt {
            Err(e) if e.code() == crate::errcodes::NOT_SEQUENCER && !followed => {
                followed = true;
                if sequencer == state.cfg.server_name {
                    continue;
                }
                if learn_handoff(state, conversation_id, &sequencer).await?.is_none() {
                    return Err(e);
                }
            }
            other => return other,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn submit_remote(
    state: &AppState,
    sequencer: &str,
    conversation_id: &str,
    kind: &str,
    auth: &HomeAuth,
    ciphertext: &str,
    epoch: i64,
    extras: FrameExtras<'_>,
    change: Option<&Change>,
    notify: bool,
) -> ApiResult<Value> {
    let mut answer = federation::post_signed(
        state,
        sequencer,
        "/_telium/v1/dm/submit",
        &json!({
            "conversation_id": conversation_id, "kind": kind, "sender": auth.user_id,
            "sender_device": auth.device_id, "ciphertext": ciphertext, "epoch": epoch,
            "notification_id": extras.notification_id, "change": change,
            "notify": notify, "frame_id": extras.frame_id, "welcome": extras.welcome,
            "generation": extras.generation, "start_over": extras.start_over,
        }),
    )
    .await?;
    if let Some(welcome) = extras.welcome {
        if answer.get("welcome").is_none() && answer.get("replayed").is_none() {
            let sent = federation::post_signed(
                state,
                sequencer,
                "/_telium/v1/dm/submit",
                &json!({
                    "conversation_id": conversation_id, "kind": "welcome",
                    "sender": auth.user_id, "sender_device": auth.device_id,
                    "ciphertext": welcome, "epoch": epoch, "notify": false,
                    "generation": extras.generation,
                }),
            )
            .await;
            match sent {
                Ok(w) => answer["welcome"] = w,
                Err(e) => tracing::warn!(
                    target: crate::logcat::SOCIAL, error = %e,
                    "commit ordered but its Welcome was not; the client will resend it"
                ),
            }
        }
    }
    Ok(answer)
}

#[derive(Default, Clone, Copy)]
pub struct FrameExtras<'a> {
    pub notification_id: Option<&'a str>,
    pub frame_id: Option<&'a str>,
    pub welcome: Option<&'a str>,
    pub generation: Option<i64>,
    pub start_over: bool,
}

const MAX_FRAME_ID: usize = 128;

pub(crate) fn validate_frame_id(id: &str) -> ApiResult<()> {
    let ok = !id.is_empty()
        && id.len() <= MAX_FRAME_ID
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'+' | b'/' | b'='));
    if ok {
        Ok(())
    } else {
        Err(ApiError::BadRequest("frame id is malformed".into()))
    }
}

pub(super) fn validate_extras(kind: &str, extras: &FrameExtras<'_>) -> ApiResult<()> {
    if let Some(frame_id) = extras.frame_id {
        validate_frame_id(frame_id)?;
    }
    if extras.start_over && (kind != "welcome" || extras.generation.is_none()) {
        return Err(ApiError::BadRequest(
            "a start-over is a Welcome naming the generation it replaces".into(),
        ));
    }
    if let Some(welcome) = extras.welcome {
        if kind != "commit" {
            return Err(ApiError::BadRequest("only a commit carries a Welcome".into()));
        }
        if welcome.len() > MAX_FRAME_BYTES {
            return Err(ApiError::TooLarge("frame is too large".into()));
        }
    }
    Ok(())
}

pub(crate) fn frame_digest(ciphertext: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(ciphertext.as_bytes()))
}

#[allow(clippy::too_many_arguments)]
pub async fn sequence_and_fanout(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    sender: &str,
    sender_device: Option<&str>,
    ciphertext: &str,
    epoch: i64,
    notify: bool,
) -> ApiResult<Value> {
    sequence_inner(
        state,
        conversation_id,
        kind,
        sender,
        sender_device,
        ciphertext,
        epoch,
        FrameExtras::default(),
        None,
        None,
        notify,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn sequence_with_change(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    sender: &str,
    sender_device: Option<&str>,
    ciphertext: &str,
    epoch: i64,
    extras: FrameExtras<'_>,
    change: Option<&Change>,
    notify: bool,
) -> ApiResult<Value> {
    validate_extras(kind, &extras)?;
    let next_policy = match change {
        Some(change) => authorize_change(state, conversation_id, kind, sender, change).await?,
        None => None,
    };
    sequence_inner(
        state,
        conversation_id,
        kind,
        sender,
        sender_device,
        ciphertext,
        epoch,
        extras,
        next_policy.as_deref(),
        change,
        notify,
    )
    .await
}
