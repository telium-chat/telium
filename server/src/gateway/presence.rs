use super::events::{self, Event};
use super::hub;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::Value;

const MAX_RICH_ACTIVITIES: usize = 3;
const MAX_RICH_ACTIVITY_OBJECT_BYTES: usize = 4096;

fn sanitize_rich_activities(d: &Value) -> Vec<Value> {
    let Some(values) = d.get("rich_activities").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen_game = false;
    let mut seen_music = false;
    let mut seen_video = false;
    for candidate in values {
        if !candidate.is_object() {
            continue;
        }
        let Ok(encoded) = serde_json::to_string(candidate) else {
            continue;
        };
        if encoded.len() > MAX_RICH_ACTIVITY_OBJECT_BYTES {
            continue;
        }
        let slot = match candidate.get("type").and_then(Value::as_i64) {
            Some(2) => &mut seen_music,
            Some(1 | 3) => &mut seen_video,
            _ => &mut seen_game,
        };
        if *slot {
            continue;
        }
        *slot = true;
        out.push(candidate.clone());
        if out.len() >= MAX_RICH_ACTIVITIES {
            break;
        }
    }
    out
}

const MAX_CUSTOM_STATUS_LEN: usize = 128;

pub(super) async fn apply_presence(state: &AppState, user_id: &str, d: &Value) -> bool {
    let status = d.get("status").and_then(Value::as_str).unwrap_or("online");
    let status = match status {
        "online" | "idle" | "dnd" | "invisible" | "offline" => status,
        _ => "online",
    };
    let status = if status == "invisible" { "offline" } else { status };
    let custom_status = d
        .get("custom_status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(MAX_CUSTOM_STATUS_LEN).collect::<String>());
    let keep_custom_status = d
        .get("show_custom_status_offline")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    // Missing activity means leave alone; explicit null means clear.
    let activity_was_sent = d.get("activity").is_some();
    let presence = hub::Presence {
        status: status.to_string(),
        custom_status,
        activity: d.get("activity").and_then(Value::as_str).map(str::to_string),
        rich_activities: sanitize_rich_activities(d),
        updated_at: now_ms(),
    };
    if activity_was_sent {
        state.hub.set_presence(user_id, presence, keep_custom_status).await
    } else {
        state
            .hub
            .set_presence_preserving_activity(user_id, presence, keep_custom_status)
            .await
    }
}

pub async fn broadcast_presence(state: &AppState, user_id: &str, presence: hub::Presence) {
    crate::routes::friends::fanout_presence(state, user_id, &presence).await;
    for guild_id in state.hub.guilds_of_user(user_id).await {
        state
            .hub
            .publish(Event::new(
                "PRESENCE_UPDATE",
                guild_id,
                events::INTENT_GUILD_PRESENCES,
                presence.to_json(user_id),
            ))
            .await;
    }
}

pub fn spawn_presence_flusher(state: AppState) {
    crate::bot_receipts::spawn(state.clone());
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            ticker.tick().await;
            for (user_id, presence) in state.hub.drain_coalesced_presence().await {
                broadcast_presence(&state, &user_id, presence).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rich_activities_are_bounded_to_one_per_category() {
        let input = json!({
            "rich_activities": [
                { "name": "Game A", "type": 0 },
                { "name": "Game B", "type": 5 },
                { "name": "Album", "type": 2 },
                { "name": "Video", "type": 3 },
                { "name": "Stream", "type": 1 }
            ]
        });
        let out = sanitize_rich_activities(&input);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0]["name"], "Game A");
        assert_eq!(out[1]["name"], "Album");
        assert_eq!(out[2]["name"], "Video");
    }
}
