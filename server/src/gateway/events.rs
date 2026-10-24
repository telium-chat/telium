
use serde_json::Value;
use std::sync::Arc;

pub const INTENT_GUILD_MESSAGES: u64 = 1 << 0;
pub const INTENT_GUILD_MEMBERS: u64 = 1 << 1;
pub const INTENT_GUILD_PRESENCES: u64 = 1 << 2;
pub const INTENT_GUILD_TYPING: u64 = 1 << 3;
pub const INTENT_GUILD_EXPRESSIONS: u64 = 1 << 4;
pub const INTENT_GUILD_STRUCTURE: u64 = 1 << 5;
pub const INTENT_DIRECT_MESSAGES: u64 = 1 << 6;
pub const INTENT_GUILD_VOICE_STATES: u64 = 1 << 7;
pub const INTENT_MESSAGE_CONTENT: u64 = 1 << 8;

pub const SESSION_REVOKED: &str = "SESSION_REVOKED";

pub const SERVER_GOING_AWAY: &str = "SERVER_GOING_AWAY";

pub const DEFAULT_INTENTS: u64 =
    INTENT_GUILD_MESSAGES | INTENT_GUILD_MEMBERS | INTENT_GUILD_STRUCTURE
        | INTENT_GUILD_EXPRESSIONS | INTENT_DIRECT_MESSAGES | INTENT_GUILD_VOICE_STATES;

pub const BOT_INTENTS: u64 = INTENT_GUILD_MESSAGES
    | INTENT_GUILD_MEMBERS
    | INTENT_GUILD_PRESENCES
    | INTENT_GUILD_TYPING
    | INTENT_GUILD_EXPRESSIONS
    | INTENT_GUILD_STRUCTURE
    | INTENT_GUILD_VOICE_STATES
    | INTENT_MESSAGE_CONTENT;

pub fn intent_from_name(name: &str) -> Option<u64> {
    Some(match name {
        "GUILD_MESSAGES" => INTENT_GUILD_MESSAGES,
        "GUILD_MEMBERS" => INTENT_GUILD_MEMBERS,
        "GUILD_PRESENCES" => INTENT_GUILD_PRESENCES,
        "GUILD_TYPING" => INTENT_GUILD_TYPING,
        "GUILD_EXPRESSIONS" => INTENT_GUILD_EXPRESSIONS,
        "GUILD_STRUCTURE" => INTENT_GUILD_STRUCTURE,
        "DIRECT_MESSAGES" => INTENT_DIRECT_MESSAGES,
        "GUILD_VOICE_STATES" => INTENT_GUILD_VOICE_STATES,
        "MESSAGE_CONTENT" => INTENT_MESSAGE_CONTENT,
        _ => return None,
    })
}

pub fn intents_from_names(names: &[String]) -> u64 {
    names.iter().filter_map(|name| intent_from_name(name)).fold(0, |acc, bit| acc | bit)
}

pub fn intent_names(bits: u64) -> Vec<&'static str> {
    const ALL: &[(&str, u64)] = &[
        ("GUILD_MESSAGES", INTENT_GUILD_MESSAGES),
        ("GUILD_MEMBERS", INTENT_GUILD_MEMBERS),
        ("GUILD_PRESENCES", INTENT_GUILD_PRESENCES),
        ("GUILD_TYPING", INTENT_GUILD_TYPING),
        ("GUILD_EXPRESSIONS", INTENT_GUILD_EXPRESSIONS),
        ("GUILD_STRUCTURE", INTENT_GUILD_STRUCTURE),
        ("DIRECT_MESSAGES", INTENT_DIRECT_MESSAGES),
        ("GUILD_VOICE_STATES", INTENT_GUILD_VOICE_STATES),
        ("MESSAGE_CONTENT", INTENT_MESSAGE_CONTENT),
    ];
    ALL.iter().filter(|(_, bit)| bits & bit != 0).map(|(name, _)| *name).collect()
}

#[derive(Debug, Clone)]
pub struct Event {
    pub t: &'static str,
    pub guild_id: String,
    pub channel_id: Option<String>,
    pub intent: u64,
    pub only_user: Option<String>,
    pub data: Value,
}

impl Event {
    pub fn new(t: &'static str, guild_id: impl Into<String>, intent: u64, data: Value) -> Arc<Self> {
        Arc::new(Event {
            t,
            guild_id: guild_id.into(),
            channel_id: None,
            intent,
            only_user: None,
            data,
        })
    }

    pub fn in_channel(
        t: &'static str,
        guild_id: impl Into<String>,
        channel_id: impl Into<String>,
        intent: u64,
        data: Value,
    ) -> Arc<Self> {
        Arc::new(Event {
            t,
            guild_id: guild_id.into(),
            channel_id: Some(channel_id.into()),
            intent,
            only_user: None,
            data,
        })
    }

    pub fn to_account(t: &'static str, user_id: impl Into<String>, data: Value) -> Arc<Self> {
        Arc::new(Event {
            t,
            guild_id: String::new(),
            channel_id: None,
            intent: INTENT_DIRECT_MESSAGES,
            only_user: Some(user_id.into()),
            data,
        })
    }

    pub fn in_channel_to_user(
        t: &'static str,
        guild_id: impl Into<String>,
        channel_id: impl Into<String>,
        intent: u64,
        user_id: impl Into<String>,
        data: Value,
    ) -> Arc<Self> {
        Arc::new(Event {
            t,
            guild_id: guild_id.into(),
            channel_id: Some(channel_id.into()),
            intent,
            only_user: Some(user_id.into()),
            data,
        })
    }

    pub fn to_user(mut self, user_id: impl Into<String>) -> Arc<Self> {
        self.only_user = Some(user_id.into());
        Arc::new(self)
    }
}
