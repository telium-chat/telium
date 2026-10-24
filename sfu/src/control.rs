
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::{Json};
use serde_json::{json, Value};

use crate::livekit::room_name;
use crate::server::AppState;
use crate::trust::maybe_discover;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlCommand {
    Disconnect { user_id: String },
    Mute { user_id: String, mute: bool },
    Deafen { user_id: String, deaf: bool },
    Subscribe { viewer: String, streamer: String, quality: WatchQuality },
    Unsubscribe { viewer: String, streamer: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchQuality {
    Auto,
    Low,
    Medium,
    High,
}

impl WatchQuality {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
        }
    }
}

const MAX_AGE_MS: i64 = 5 * 60 * 1000;

/// Allowed future skew; below `MAX_AGE_MS` so a far-future `issued_at` cannot extend replay.
const MAX_FUTURE_SKEW_MS: i64 = 30 * 1000;

pub fn parse_command(body: &Value) -> Option<ControlCommand> {
    let cmd = body.get("command")?;
    let kind = cmd.get("command").and_then(Value::as_str)?;
    match kind {
        "disconnect" => Some(ControlCommand::Disconnect {
            user_id: cmd.get("user_id")?.as_str()?.to_string(),
        }),
        "mute" => Some(ControlCommand::Mute {
            user_id: cmd.get("user_id")?.as_str()?.to_string(),
            mute: cmd.get("mute").and_then(Value::as_bool).unwrap_or(true),
        }),
        "deafen" => Some(ControlCommand::Deafen {
            user_id: cmd.get("user_id")?.as_str()?.to_string(),
            deaf: cmd.get("deaf").and_then(Value::as_bool).unwrap_or(true),
        }),
        "subscribe" => Some(ControlCommand::Subscribe {
            viewer: cmd.get("viewer")?.as_str()?.to_string(),
            streamer: cmd.get("streamer")?.as_str()?.to_string(),
            quality: WatchQuality::parse(cmd.get("quality").and_then(Value::as_str).unwrap_or("auto"))?,
        }),
        "unsubscribe" => Some(ControlCommand::Unsubscribe {
            viewer: cmd.get("viewer")?.as_str()?.to_string(),
            streamer: cmd.get("streamer")?.as_str()?.to_string(),
        }),
        _ => None,
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn control_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    maybe_discover(&state.trust, &body).await;

    if !state.trust.read().await.verify_json(&body) {
        return Err((StatusCode::FORBIDDEN, Json(json!({ "error": "bad signature" }))));
    }

    // Replay inside the window is accepted: commands are idempotent, and a nonce store is an allocation DoS.
    let issued = body.get("issued_at").and_then(Value::as_i64).unwrap_or(0);
    let age = now_ms().saturating_sub(issued);
    if issued <= 0 || age > MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({ "error": "stale command" }))));
    }

    // Origin and guild are pinned so one SFU can host many without room collisions.
    let origin = body.get("origin").and_then(Value::as_str).unwrap_or("");
    let guild = body.get("guild").and_then(Value::as_str).unwrap_or("");
    let channel = body.get("channel").and_then(Value::as_str).unwrap_or("");
    if guild.is_empty() || channel.is_empty() {
        return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "missing guild/channel" }))));
    }

    let cmd = match parse_command(&body) {
        Some(c) => c,
        None => return Err((StatusCode::BAD_REQUEST, Json(json!({ "error": "unknown command" })))),
    };
    let room = room_name(origin, guild, channel);
    if let Err(e) = state.livekit.control(&room, &cmd).await {
        tracing::error!(error = %e, command = ?cmd, "livekit control translation failed");
        return Err((StatusCode::BAD_GATEWAY, Json(json!({ "error": "livekit control failed" }))));
    }

    match &cmd {
        ControlCommand::Subscribe { viewer, streamer, quality } => {
            state.sessions.set_watch(&room, viewer, streamer, quality.as_str());
        }
        ControlCommand::Unsubscribe { viewer, streamer } => {
            state.sessions.clear_watch(&room, viewer, streamer);
        }
        ControlCommand::Disconnect { user_id } => {
            state.sessions.remove_participant(&room, user_id);
        }
        _ => {}
    }

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn signed_command(inner: Value, issued_at: i64) -> Value {
        json!({
            "origin": "home.example",
            "channel": "c1",
            "issued_at": issued_at,
            "key_id": "ed25519:test",
            "signature": "x",
            "command": inner,
        })
    }

    #[test]
    fn parses_each_command_kind() {
        assert_eq!(
            parse_command(&signed_command(json!({"command":"disconnect","user_id":"u1"}), 0)),
            Some(ControlCommand::Disconnect { user_id: "u1".into() })
        );
        assert_eq!(
            parse_command(&signed_command(json!({"command":"mute","user_id":"u1","mute":false}), 0)),
            Some(ControlCommand::Mute { user_id: "u1".into(), mute: false })
        );
        assert_eq!(
            parse_command(&signed_command(json!({"command":"deafen","user_id":"u1","deaf":true}), 0)),
            Some(ControlCommand::Deafen { user_id: "u1".into(), deaf: true })
        );
        assert_eq!(
            parse_command(&signed_command(json!({"command":"subscribe","viewer":"v","streamer":"s","quality":"medium"}), 0)),
            Some(ControlCommand::Subscribe { viewer: "v".into(), streamer: "s".into(), quality: WatchQuality::Medium })
        );
        assert_eq!(
            parse_command(&signed_command(json!({"command":"unsubscribe","viewer":"v","streamer":"s"}), 0)),
            Some(ControlCommand::Unsubscribe { viewer: "v".into(), streamer: "s".into() })
        );
    }

    #[test]
    fn rejects_unknown_command() {
        assert_eq!(parse_command(&signed_command(json!({"command":"explode"}), 0)), None);
    }

    #[test]
    fn subscribe_quality_is_the_shared_closed_vocabulary() {
        for q in telium_protocol::WATCH_QUALITIES {
            let parsed = parse_command(&signed_command(
                json!({"command":"subscribe","viewer":"v","streamer":"s","quality":q}), 0,
            ));
            match parsed {
                Some(ControlCommand::Subscribe { quality, .. }) => assert_eq!(quality.as_str(), q),
                other => panic!("{q} should parse, got {other:?}"),
            }
        }
        assert_eq!(
            parse_command(&signed_command(json!({"command":"subscribe","viewer":"v","streamer":"s"}), 0)),
            Some(ControlCommand::Subscribe { viewer: "v".into(), streamer: "s".into(), quality: WatchQuality::Auto })
        );
        assert_eq!(
            parse_command(&signed_command(json!({"command":"subscribe","viewer":"v","streamer":"s","quality":"motion"}), 0)),
            None
        );
    }

    #[test]
    fn defaults_mute_and_deaf_to_true() {
        assert_eq!(
            parse_command(&signed_command(json!({"command":"mute","user_id":"u1"}), 0)),
            Some(ControlCommand::Mute { user_id: "u1".into(), mute: true })
        );
    }
}
