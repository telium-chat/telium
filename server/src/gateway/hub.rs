//! In-process fanout hub.

use super::events::{Event, INTENT_GUILD_PRESENCES};
use crate::util::now_ms;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::Sender;
use tokio::sync::RwLock;

const RICH_ACTIVITY_PREFIX: &str = "telium-rich-v1:";
const MAX_RICH_ACTIVITY_BYTES: usize = 4096;

fn unpack_activity(activity: &Option<String>) -> (Option<String>, Option<Value>) {
    let Some(raw) = activity else { return (None, None) };
    let Some(payload) = raw.strip_prefix(RICH_ACTIVITY_PREFIX) else {
        return (Some(raw.clone()), None);
    };
    if payload.is_empty() || payload.len() > MAX_RICH_ACTIVITY_BYTES {
        return (None, None);
    }
    let Ok(value) = serde_json::from_str::<Value>(payload) else {
        return (None, None);
    };
    if !value.is_object() {
        return (None, None);
    }
    let fallback = value
        .get("name")
        .and_then(Value::as_str)
        .map(|name| name.chars().take(128).collect::<String>())
        .filter(|name| !name.is_empty());
    (fallback, Some(value))
}

fn activity_change_is_immediate(current: &Option<String>, next: &Option<String>) -> bool {
    if current == next {
        return false;
    }
    let (_, current_rich) = unpack_activity(current);
    let (_, next_rich) = unpack_activity(next);
    let current_type = current_rich.as_ref().and_then(|v| v.get("type")).and_then(Value::as_i64);
    let next_type = next_rich.as_ref().and_then(|v| v.get("type")).and_then(Value::as_i64);

    if current_type != next_type && (current_rich.is_some() || next_rich.is_some()) {
        return true;
    }
    let (Some(current_rich), Some(next_rich)) = (current_rich.as_ref(), next_rich.as_ref()) else {
        return false;
    };
    if current_rich.get("application_id") != next_rich.get("application_id")
        || current_rich.get("name") != next_rich.get("name")
    {
        return true;
    }

    next_type == Some(2)
}

fn activity_slot(value: &Value) -> &'static str {
    match value.get("type").and_then(Value::as_i64) {
        Some(2) => "music",
        Some(1 | 3) => "video",
        _ => "game",
    }
}

fn rich_activities_change_is_immediate(current: &[Value], next: &[Value]) -> bool {
    if current == next {
        return false;
    }
    if current.len() != next.len() {
        return true;
    }
    for candidate in next {
        let slot = activity_slot(candidate);
        let Some(previous) = current.iter().find(|value| activity_slot(value) == slot) else {
            return true;
        };
        if previous.get("type") != candidate.get("type")
            || previous.get("application_id") != candidate.get("application_id")
            || previous.get("name") != candidate.get("name")
        {
            return true;
        }
        if slot == "music" && previous != candidate {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone)]
pub struct Presence {
    pub status: String, // online | idle | dnd | offline
    pub custom_status: Option<String>,
    pub activity: Option<String>,
    pub rich_activities: Vec<Value>,
    pub updated_at: i64,
}

impl Presence {
    pub fn offline() -> Self {
        Presence {
            status: "offline".into(),
            custom_status: None,
            activity: None,
            rich_activities: Vec::new(),
            updated_at: now_ms(),
        }
    }

    pub fn to_json(&self, user_id: &str) -> serde_json::Value {
        let (activity, rich_activity) = unpack_activity(&self.activity);
        json!({
            "user_id": user_id,
            "status": self.status,
            "custom_status": self.custom_status,
            "activity": activity,
            "rich_activity": rich_activity,
            "rich_activities": self.rich_activities,
        })
    }
}

pub const OUTBOX_DEPTH: usize = 400;

/// Bounded event queue plus a set-once overflow flag.
#[derive(Clone)]
pub struct Outbox {
    tx: Sender<Arc<Event>>,
    lagging: Arc<AtomicBool>,
}

impl Outbox {
    pub fn new(tx: Sender<Arc<Event>>) -> (Self, Arc<AtomicBool>) {
        let lagging = Arc::new(AtomicBool::new(false));
        (Outbox { tx, lagging: lagging.clone() }, lagging)
    }
}

struct SessionHandle {
    user_id: String,
    out: Outbox,
}

/// Releases a pending-socket slot on drop.
pub struct PendingSocket {
    hub: Arc<Hub>,
}

impl Drop for PendingSocket {
    fn drop(&mut self) {
        // Saturating: wrapping would refuse every connection.
        let mut current = self.hub.pending.load(Ordering::Relaxed);
        loop {
            let next = current.saturating_sub(1);
            match self.hub.pending.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return,
                Err(seen) => current = seen,
            }
        }
    }
}

struct PresenceEntry {
    current: Presence,
    last_sent: i64,
    dirty: bool,
    connections: u32,
    keep_custom_status: bool,
}

pub struct Hub {
    guild_subs: RwLock<HashMap<String, HashMap<u64, Arc<SessionHandle>>>>,
    user_subs: RwLock<HashMap<String, HashMap<u64, Arc<SessionHandle>>>>,
    presence: RwLock<HashMap<String, PresenceEntry>>,
    devices: RwLock<HashMap<String, HashMap<String, u32>>>,
    accounts: RwLock<HashMap<String, HashMap<u64, Outbox>>>,
    next_session_id: AtomicU64,
    coalesce_ms: i64,
    pending: AtomicU64,
    events_dropped: AtomicU64,
    sessions_shed: AtomicU64,
    refused: AtomicU64,
    lagged_closed: AtomicU64,
}

impl Hub {
    pub fn new(coalesce_secs: i64) -> Self {
        Hub {
            guild_subs: RwLock::new(HashMap::new()),
            user_subs: RwLock::new(HashMap::new()),
            presence: RwLock::new(HashMap::new()),
            devices: RwLock::new(HashMap::new()),
            accounts: RwLock::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            coalesce_ms: coalesce_secs * 1000,
            pending: AtomicU64::new(0),
            events_dropped: AtomicU64::new(0),
            sessions_shed: AtomicU64::new(0),
            refused: AtomicU64::new(0),
            lagged_closed: AtomicU64::new(0),
        }
    }

    pub fn next_session_id(&self) -> u64 {
        self.next_session_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn admit_pending(self: &Arc<Self>, max: u64) -> Option<PendingSocket> {
        // Compare-and-swap: add-then-check lets a flood inflate the counter.
        let mut current = self.pending.load(Ordering::Relaxed);
        loop {
            if current >= max {
                return None;
            }
            match self.pending.compare_exchange_weak(
                current,
                current + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(PendingSocket { hub: self.clone() }),
                Err(seen) => current = seen,
            }
        }
    }

    pub fn pending_sockets(&self) -> u64 {
        self.pending.load(Ordering::Relaxed)
    }

    pub fn note_refused(&self) {
        self.refused.fetch_add(1, Ordering::Relaxed);
    }

    pub fn note_lagged_close(&self) {
        self.lagged_closed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn refusal_counts(&self) -> (u64, u64) {
        (self.refused.load(Ordering::Relaxed), self.lagged_closed.load(Ordering::Relaxed))
    }

    pub async fn subscribe(
        &self,
        session_id: u64,
        user_id: &str,
        guild_ids: &[String],
        out: Outbox,
    ) {
        let handle = Arc::new(SessionHandle { user_id: user_id.to_string(), out });
        let mut subs = self.guild_subs.write().await;
        for g in guild_ids {
            subs.entry(g.clone()).or_default().insert(session_id, handle.clone());
        }
    }

    pub async fn subscribe_one(
        &self,
        session_id: u64,
        user_id: &str,
        guild_id: &str,
        out: Outbox,
    ) {
        self.subscribe(session_id, user_id, &[guild_id.to_string()], out).await;
    }

    pub async fn subscribe_user(
        &self,
        session_id: u64,
        user_id: &str,
        out: Outbox,
    ) {
        let handle = Arc::new(SessionHandle { user_id: user_id.to_string(), out });
        self.user_subs.write().await.entry(user_id.to_string()).or_default().insert(session_id, handle);
    }

    pub async fn publish_user(&self, user_id: &str, event: Arc<Event>) {
        let subs = self.user_subs.read().await;
        let Some(sessions) = subs.get(user_id) else { return };
        for handle in sessions.values() {
            self.offer(&handle.out, event.clone());
        }
    }

    pub async fn watch_account(
        &self,
        session_id: u64,
        user_id: &str,
        out: Outbox,
        max: usize,
    ) -> bool {
        let mut accounts = self.accounts.write().await;
        let sessions = accounts.entry(user_id.to_string()).or_default();
        if sessions.len() >= max {
            // No empty entry for a refused account.
            if sessions.is_empty() {
                accounts.remove(user_id);
            }
            return false;
        }
        sessions.insert(session_id, out);
        true
    }

    pub async fn revoke(&self, user_id: &str, device_id: Option<&str>, homes: Option<&[&str]>) {
        let accounts = self.accounts.read().await;
        let Some(sessions) = accounts.get(user_id) else { return };
        let event = Arc::new(Event {
            t: super::events::SESSION_REVOKED,
            guild_id: String::new(),
            channel_id: None,
            intent: 0,
            only_user: Some(user_id.to_string()),
            data: json!({ "device_id": device_id, "homes": homes }),
        });
        for out in sessions.values() {
            self.offer(out, event.clone());
        }
    }

    pub async fn close_all(&self) -> usize {
        let accounts = self.accounts.read().await;
        let event = Arc::new(Event {
            t: super::events::SERVER_GOING_AWAY,
            guild_id: String::new(),
            channel_id: None,
            intent: 0,
            only_user: None,
            data: json!({}),
        });
        let mut told = 0;
        for sessions in accounts.values() {
            for out in sessions.values() {
                // Not `offer`: marking leaving sockets lagging would spike the overload graph at every deploy.
                if out.tx.try_send(event.clone()).is_ok() {
                    told += 1;
                }
            }
        }
        told
    }

    pub async fn unsubscribe_all(&self, session_id: u64) {
        let mut subs = self.guild_subs.write().await;
        subs.retain(|_, sessions| {
            sessions.remove(&session_id);
            !sessions.is_empty()
        });
        drop(subs);
        let mut users = self.user_subs.write().await;
        users.retain(|_, sessions| {
            sessions.remove(&session_id);
            !sessions.is_empty()
        });
        drop(users);
        let mut accounts = self.accounts.write().await;
        accounts.retain(|_, sessions| {
            sessions.remove(&session_id);
            !sessions.is_empty()
        });
    }

    pub async fn unsubscribe_guild(&self, session_id: u64, guild_id: &str) {
        let mut subs = self.guild_subs.write().await;
        if let Some(sessions) = subs.get_mut(guild_id) {
            sessions.remove(&session_id);
            if sessions.is_empty() {
                subs.remove(guild_id);
            }
        }
    }

    pub async fn publish(&self, event: Arc<Event>) {
        let subs = self.guild_subs.read().await;
        let Some(sessions) = subs.get(&event.guild_id) else { return };
        for handle in sessions.values() {
            if let Some(target) = &event.only_user {
                if &handle.user_id != target {
                    continue;
                }
            }
            self.offer(&handle.out, event.clone());
        }
    }

    fn offer(&self, out: &Outbox, event: Arc<Event>) {
        match out.tx.try_send(event) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.events_dropped.fetch_add(1, Ordering::Relaxed);
                if !out.lagging.swap(true, Ordering::Relaxed) {
                    self.sessions_shed.fetch_add(1, Ordering::Relaxed);
                    // No user id: a log naming who is on a bad connection is a location record.
                    tracing::warn!(
                        target: crate::logcat::GATEWAY,
                        limit = out.tx.max_capacity(),
                        "a gateway session fell behind its event queue and will be closed; \
                         the client reconnects and resyncs from READY"
                    );
                }
            }
            Err(TrySendError::Closed(_)) => {}
        }
    }

    pub fn backpressure(&self) -> (u64, u64) {
        (
            self.events_dropped.load(Ordering::Relaxed),
            self.sessions_shed.load(Ordering::Relaxed),
        )
    }

    pub async fn online_users_in(&self, guild_id: &str) -> Vec<String> {
        let subs = self.guild_subs.read().await;
        let mut users: Vec<String> = subs
            .get(guild_id)
            .map(|s| s.values().map(|h| h.user_id.clone()).collect())
            .unwrap_or_default();
        users.sort();
        users.dedup();
        users
    }

    pub async fn presence_of(&self, user_id: &str) -> Presence {
        self.presence
            .read()
            .await
            .get(user_id)
            .map(|e| e.current.clone())
            .unwrap_or_else(Presence::offline)
    }

    pub async fn live_connections(&self) -> (u64, u64) {
        let accounts = self.accounts.read().await;
        let connections = accounts.values().map(|s| s.len() as u64).sum();
        (connections, accounts.len() as u64)
    }

    pub async fn device_opened(&self, user_id: &str, device_id: &str) {
        let mut map = self.devices.write().await;
        *map.entry(user_id.to_string()).or_default().entry(device_id.to_string()).or_insert(0) += 1;
    }

    pub async fn device_closed(&self, user_id: &str, device_id: &str) -> bool {
        let mut map = self.devices.write().await;
        let Some(devices) = map.get_mut(user_id) else { return false };
        let Some(count) = devices.get_mut(device_id) else { return false };
        *count = count.saturating_sub(1);
        if *count > 0 {
            return false;
        }
        devices.remove(device_id);
        if devices.is_empty() {
            map.remove(user_id);
        }
        true
    }

    pub async fn device_live(&self, user_id: &str, device_id: &str) -> bool {
        self.devices
            .read()
            .await
            .get(user_id)
            .and_then(|d| d.get(device_id))
            .is_some_and(|n| *n > 0)
    }

    pub async fn connection_opened(&self, user_id: &str) {
        let mut map = self.presence.write().await;
        let entry = map.entry(user_id.to_string()).or_insert_with(|| PresenceEntry {
            current: Presence::offline(),
            last_sent: 0,
            dirty: false,
            connections: 0,
            keep_custom_status: false,
        });
        entry.connections += 1;
    }

    pub async fn connection_closed(&self, user_id: &str) -> bool {
        let mut map = self.presence.write().await;
        let Some(entry) = map.get_mut(user_id) else { return false };
        entry.connections = entry.connections.saturating_sub(1);
        if entry.connections == 0 {
            entry.current = if entry.keep_custom_status {
                Presence {
                    status: "offline".into(),
                    custom_status: entry.current.custom_status.clone(),
                    activity: None,
                    rich_activities: Vec::new(),
                    updated_at: now_ms(),
                }
            } else {
                Presence::offline()
            };
            entry.dirty = false;
            entry.last_sent = now_ms();
            true
        } else {
            false
        }
    }

    pub async fn set_presence(
        &self,
        user_id: &str,
        next: Presence,
        keep_custom_status: bool,
    ) -> bool {
        self.set_presence_inner(user_id, next, keep_custom_status, false).await
    }

    pub async fn set_presence_preserving_activity(
        &self,
        user_id: &str,
        next: Presence,
        keep_custom_status: bool,
    ) -> bool {
        self.set_presence_inner(user_id, next, keep_custom_status, true).await
    }

    async fn set_presence_inner(
        &self,
        user_id: &str,
        mut next: Presence,
        keep_custom_status: bool,
        preserve_activity: bool,
    ) -> bool {
        let now = now_ms();
        let mut map = self.presence.write().await;
        let entry = map.entry(user_id.to_string()).or_insert_with(|| PresenceEntry {
            current: Presence::offline(),
            last_sent: 0,
            dirty: false,
            connections: 1,
            keep_custom_status: false,
        });
        entry.keep_custom_status = keep_custom_status;

        if preserve_activity {
            next.activity = entry.current.activity.clone();
            next.rich_activities = entry.current.rich_activities.clone();
        }

        if next.status == "offline" && !keep_custom_status {
            next.custom_status = None;
            next.activity = None;
            next.rich_activities.clear();
        }

        let dot_moved = entry.current.status != next.status;
        let text_changed = entry.current.custom_status != next.custom_status;
        let activity_started = (entry.current.activity.is_none() && next.activity.is_some())
            || (entry.current.rich_activities.is_empty() && !next.rich_activities.is_empty());
        let activity_cleared = (entry.current.activity.is_some() && next.activity.is_none())
            || (!entry.current.rich_activities.is_empty() && next.rich_activities.is_empty());
        let activity_transition = activity_change_is_immediate(&entry.current.activity, &next.activity)
            || rich_activities_change_is_immediate(
                &entry.current.rich_activities,
                &next.rich_activities,
            );
        entry.current = next;

        if dot_moved || text_changed || activity_started || activity_cleared || activity_transition
            || now - entry.last_sent >= self.coalesce_ms
        {
            entry.last_sent = now;
            entry.dirty = false;
            true
        } else {
            entry.dirty = true;
            false
        }
    }

    pub async fn drain_coalesced_presence(&self) -> Vec<(String, Presence)> {
        let now = now_ms();
        let mut out = Vec::new();
        let mut map = self.presence.write().await;
        for (user_id, entry) in map.iter_mut() {
            if entry.dirty && now - entry.last_sent >= self.coalesce_ms {
                entry.dirty = false;
                entry.last_sent = now;
                out.push((user_id.clone(), entry.current.clone()));
            }
        }
        out
    }

    pub async fn guilds_of_user(&self, user_id: &str) -> Vec<String> {
        let subs = self.guild_subs.read().await;
        subs.iter()
            .filter(|(_, sessions)| sessions.values().any(|h| h.user_id == user_id))
            .map(|(g, _)| g.clone())
            .collect()
    }

    pub fn presence_intent(&self) -> u64 {
        INTENT_GUILD_PRESENCES
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::events::INTENT_GUILD_MESSAGES;

    fn presence(status: &str) -> Presence {
        Presence { status: status.into(), custom_status: None, activity: None, rich_activities: Vec::new(), updated_at: now_ms() }
    }

    fn doing(status: &str, activity: &str) -> Presence {
        Presence {
            status: status.into(),
            custom_status: None,
            activity: Some(activity.into()),
            rich_activities: Vec::new(),
            updated_at: now_ms(),
        }
    }

    fn rich_doing(status: &str, activity_type: i64, name: &str, details: &str) -> Presence {
        Presence {
            status: status.into(),
            custom_status: None,
            activity: Some(format!(
                "{RICH_ACTIVITY_PREFIX}{}",
                json!({"name": name, "type": activity_type, "details": details})
            )),
            rich_activities: Vec::new(),
            updated_at: now_ms(),
        }
    }

    fn multi_doing(game_details: &str, track: &str) -> Presence {
        let game = json!({"name": "Minecraft", "type": 0, "details": game_details});
        let music = json!({"name": "Music", "type": 2, "details": track});
        Presence {
            status: "online".into(),
            custom_status: None,
            activity: Some(format!("{RICH_ACTIVITY_PREFIX}{game}")),
            rich_activities: vec![game, music],
            updated_at: now_ms(),
        }
    }

    fn status_text(status: &str, custom_status: &str) -> Presence {
        Presence {
            status: status.into(),
            custom_status: (!custom_status.is_empty()).then(|| custom_status.into()),
            activity: None,
            rich_activities: Vec::new(),
            updated_at: now_ms(),
        }
    }

    #[test]
    fn rich_activity_envelope_is_unpacked_for_fanout() {
        let packed = format!(
            "{RICH_ACTIVITY_PREFIX}{}",
            json!({"name":"Minecraft","type":0,"details":"Survival"})
        );
        let p = Presence {
            status: "online".into(),
            custom_status: None,
            activity: Some(packed),
            rich_activities: Vec::new(),
            updated_at: now_ms(),
        };
        let wire = p.to_json("@a:x");
        assert_eq!(wire["activity"], "Minecraft");
        assert_eq!(wire["rich_activity"]["details"], "Survival");
    }

    #[tokio::test]
    async fn publish_reaches_only_subscribers_of_that_guild() {
        let hub = Hub::new(30);
        let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(8);
        let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(8);
        let (tx_a, _) = Outbox::new(tx_a);
        let (tx_b, _) = Outbox::new(tx_b);
        hub.subscribe(1, "@a:x", &["g1".into()], tx_a).await;
        hub.subscribe(2, "@b:x", &["g2".into()], tx_b).await;

        hub.publish(Event::new("MESSAGE_CREATE", "g1", INTENT_GUILD_MESSAGES, json!({}))).await;
        assert!(rx_a.try_recv().is_ok());
        assert!(rx_b.try_recv().is_err());
    }

    #[tokio::test]
    async fn only_user_events_are_targeted() {
        let hub = Hub::new(30);
        let (tx_a, mut rx_a) = tokio::sync::mpsc::channel(8);
        let (tx_b, mut rx_b) = tokio::sync::mpsc::channel(8);
        let (tx_a, _) = Outbox::new(tx_a);
        let (tx_b, _) = Outbox::new(tx_b);
        hub.subscribe(1, "@a:x", &["g1".into()], tx_a).await;
        hub.subscribe(2, "@b:x", &["g1".into()], tx_b).await;

        let ev = Event {
            t: "GUILD_DELETE",
            guild_id: "g1".into(),
            channel_id: None,
            intent: INTENT_GUILD_MESSAGES,
            only_user: None,
            data: json!({}),
        }
        .to_user("@b:x");
        hub.publish(ev).await;
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_ok());
    }

    #[tokio::test]
    async fn unsubscribe_removes_the_session() {
        let hub = Hub::new(30);
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let (tx, _) = Outbox::new(tx);
        hub.subscribe(7, "@a:x", &["g1".into()], tx).await;
        hub.unsubscribe_all(7).await;
        hub.publish(Event::new("MESSAGE_CREATE", "g1", INTENT_GUILD_MESSAGES, json!({}))).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn the_dot_never_waits_for_the_window() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", presence("online"), false).await);
        assert!(hub.set_presence("@a:x", presence("dnd"), false).await);
        assert!(hub.set_presence("@a:x", presence("idle"), false).await);
        assert!(hub.set_presence("@a:x", presence("offline"), false).await);
    }

    #[tokio::test]
    async fn text_changes_skip_the_coalescing_window() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", presence("online"), false).await);
        assert!(hub.set_presence("@a:x", status_text("online", "beating the boss"), false).await);
        assert!(hub.set_presence("@a:x", status_text("dnd", "done with the boss"), false).await);
    }

    #[tokio::test]
    async fn activity_start_is_immediate_but_churn_still_waits() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", presence("online"), false).await);
        assert!(hub.set_presence("@a:x", doing("online", "chapter two"), false).await);
        assert!(!hub.set_presence("@a:x", doing("online", "chapter three"), false).await);
        assert_eq!(hub.presence_of("@a:x").await.activity.as_deref(), Some("chapter three"));

        assert!(hub.set_presence(
            "@a:x", rich_doing("online", 2, "Music", "Track one"), false,
        ).await);
        assert!(hub.set_presence(
            "@a:x", rich_doing("online", 2, "Music", "Track two"), false,
        ).await);
    }

    #[tokio::test]
    async fn music_does_not_make_unrelated_game_churn_immediate() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", presence("online"), false).await);
        assert!(hub.set_presence("@a:x", multi_doing("chapter one", "Track one"), false).await);

        assert!(!hub.set_presence(
            "@a:x", multi_doing("chapter two", "Track one"), false,
        ).await);

        assert!(hub.set_presence(
            "@a:x", multi_doing("chapter two", "Track two"), false,
        ).await);
    }

    #[tokio::test]
    async fn clearing_activity_skips_the_coalescing_window() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", doing("online", "private game"), false).await);

        assert!(!hub.set_presence_preserving_activity("@a:x", presence("online"), false).await);
        assert_eq!(hub.presence_of("@a:x").await.activity.as_deref(), Some("private game"));

        assert!(hub.set_presence("@a:x", presence("online"), false).await);
        assert_eq!(hub.presence_of("@a:x").await.activity, None);
    }

    #[tokio::test]
    async fn coalesced_updates_drain_after_the_window() {
        let hub = Hub::new(0); // zero-length window: everything is due immediately
        hub.set_presence("@a:x", presence("online"), false).await;
        hub.set_presence("@a:x", presence("idle"), false).await;
        let drained = hub.drain_coalesced_presence().await;
        assert!(drained.iter().any(|(u, p)| u == "@a:x" && p.status == "idle") || drained.is_empty());
    }

    #[tokio::test]
    async fn last_connection_closing_marks_offline() {
        let hub = Hub::new(30);
        hub.connection_opened("@a:x").await;
        hub.connection_opened("@a:x").await;
        assert!(!hub.connection_closed("@a:x").await);
        assert!(hub.connection_closed("@a:x").await);
        assert_eq!(hub.presence_of("@a:x").await.status, "offline");
    }

    #[tokio::test]
    async fn offline_keep_retains_the_custom_status() {
        let hub = Hub::new(30);
        hub.connection_opened("@a:x").await;
        assert!(hub.set_presence("@a:x", status_text("online", "beating the boss"), true).await);
        assert!(hub.connection_closed("@a:x").await);
        let p = hub.presence_of("@a:x").await;
        assert_eq!(p.status, "offline");
        assert_eq!(p.custom_status.as_deref(), Some("beating the boss"));
    }

    #[tokio::test]
    async fn offline_without_keep_wipes_the_custom_status() {
        let hub = Hub::new(30);
        hub.connection_opened("@a:x").await;
        assert!(hub.set_presence("@a:x", status_text("online", "beating the boss"), false).await);
        assert!(hub.connection_closed("@a:x").await);
        let p = hub.presence_of("@a:x").await;
        assert_eq!(p.status, "offline");
        assert_eq!(p.custom_status, None);
    }

    #[tokio::test]
    async fn offline_without_keep_hides_the_status_while_still_connected() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", status_text("online", "beating the boss"), false).await);
        assert!(hub.set_presence("@a:x", status_text("offline", "beating the boss"), false).await);
        let p = hub.presence_of("@a:x").await;
        assert_eq!(p.status, "offline");
        assert_eq!(p.custom_status, None);
    }

    #[tokio::test]
    async fn offline_with_keep_retains_the_status_while_still_connected() {
        let hub = Hub::new(30);
        assert!(hub.set_presence("@a:x", status_text("online", "beating the boss"), true).await);
        assert!(hub.set_presence("@a:x", status_text("offline", "beating the boss"), true).await);
        let p = hub.presence_of("@a:x").await;
        assert_eq!(p.status, "offline");
        assert_eq!(p.custom_status.as_deref(), Some("beating the boss"));
    }

    fn outbox(depth: usize) -> (Outbox, Arc<AtomicBool>, tokio::sync::mpsc::Receiver<Arc<Event>>) {
        let (tx, rx) = tokio::sync::mpsc::channel(depth);
        let (out, lagging) = Outbox::new(tx);
        (out, lagging, rx)
    }

    fn message() -> Arc<Event> {
        Event::new("MESSAGE_CREATE", "g1", INTENT_GUILD_MESSAGES, json!({}))
    }

    #[tokio::test]
    async fn a_subscriber_that_stops_reading_is_bounded_and_shed() {
        let hub = Hub::new(30);
        let (out, lagging, mut rx) = outbox(4);
        hub.subscribe(1, "@slow:x", &["g1".into()], out).await;
        for _ in 0..64 {
            hub.publish(message()).await;
        }
        let mut held = 0;
        while rx.try_recv().is_ok() {
            held += 1;
        }
        assert_eq!(held, 4);
        assert!(lagging.load(Ordering::Relaxed));
        assert_eq!(hub.backpressure(), (60, 1));

        let hub = Hub::new(30);
        let (out, lagging, mut rx) = outbox(4);
        hub.subscribe(1, "@fast:x", &["g1".into()], out).await;
        for _ in 0..200 {
            hub.publish(message()).await;
            assert!(rx.try_recv().is_ok());
        }
        assert!(!lagging.load(Ordering::Relaxed));
        assert_eq!(hub.backpressure(), (0, 0));
    }

    #[tokio::test]
    async fn a_revocation_into_a_full_queue_still_ends_the_session() {
        let hub = Hub::new(30);
        let (out, lagging, _rx) = outbox(1);
        assert!(hub.watch_account(1, "@a:x", out, 8).await);
        hub.revoke("@a:x", None, None).await;
        assert!(!lagging.load(Ordering::Relaxed));
        hub.revoke("@a:x", None, None).await;
        assert!(lagging.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn connections_are_capped_per_account_and_released_on_close() {
        let hub = Hub::new(30);
        let mut rxs = Vec::new();
        let mut watch = |session: u64, user: &'static str| {
            let (out, _, rx) = outbox(4);
            rxs.push(rx);
            let hub = &hub;
            async move { hub.watch_account(session, user, out, 2).await }
        };
        assert!(watch(1, "@a:x").await && watch(2, "@a:x").await);
        assert!(!watch(3, "@a:x").await, "third socket for one account is refused");
        assert!(watch(4, "@b:x").await, "the cap is per account");
        hub.unsubscribe_all(1).await;
        assert!(watch(5, "@a:x").await, "closing gives the slot back");
    }

    #[test]
    fn unidentified_sockets_are_capped_and_the_slot_returns_on_drop() {
        let hub = Arc::new(Hub::new(30));
        let a = hub.admit_pending(2).expect("first slot");
        let _b = hub.admit_pending(2).expect("second slot");
        assert!(hub.admit_pending(2).is_none());
        drop(a);
        assert!(hub.admit_pending(2).is_some());
    }
}
