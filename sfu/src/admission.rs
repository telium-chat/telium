//! Admission: whether this relay takes another call, and why not when it
//! doesn't. Read by `/health` (so guild servers and the directory can route
//! around a full relay) and enforced by `/session` before a join is minted.
//! Existing calls are never dropped by admission — only new joins are refused.

use crate::server::AppState;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Status {
    pub accepting: bool,
    /// Set when `accepting` is false: the first reason found.
    pub reason: &'static str,
    pub rooms: usize,
    pub participants: usize,
    /// True when the trailing-period transfer estimate has crossed 80% of the budget.
    pub near_budget: bool,
}

/// True while a drain for an update is in force and its deadline has not
/// passed. Drain is lazy-expiring on purpose: the update script signals, then
/// polls `/health` until rooms drain or the script gives up, and a crashed
/// updater must not leave the relay refusing joins forever — past the
/// deadline the relay resumes accepting without anyone having to intervene.
pub fn is_draining(state: &AppState) -> bool {
    let until = state.drain_until_ms.load(Ordering::Relaxed);
    until > 0 && until > now_ms()
}

/// Arm (or re-arm) the drain deadline. Called on SIGUSR1.
pub fn begin_drain(state: &AppState) {
    let secs = state.cfg.updates.drain_max_secs;
    let deadline = now_ms() + (secs as i64).saturating_mul(1000);
    state.drain_until_ms.store(deadline, Ordering::Relaxed);
}

pub fn status(state: &AppState) -> Status {
    let limits = &state.cfg.limits;
    let rooms = state.sessions.rooms().len();
    let participants = state.sessions.join_count_all();
    let now = now_ms();
    let budgeted = limits.transfer_budget_bytes > 0;
    let used = if budgeted {
        state.usage.total_estimate(now, limits.transfer_period_days)
    } else {
        0
    };
    let near_budget = budgeted && used >= limits.admission_budget_bytes();
    let (accepting, reason) = if is_draining(state) {
        (false, "draining for update")
    } else if limits.max_rooms > 0 && rooms as u32 >= limits.max_rooms {
        (false, "room limit reached")
    } else if limits.max_participants > 0 && participants as u32 >= limits.max_participants {
        (false, "participant limit reached")
    } else if budgeted && used >= limits.admission_budget_bytes() {
        (false, "transfer budget reached")
    } else {
        (true, "")
    };
    Status { accepting, reason, rooms, participants, near_budget }
}

/// The admission refusal for one join, if any. Blocked origins are a deliberate
/// operator decision and get 403; capacity and budget are the relay saying
/// "full" and get 503 so callers route around without treating it as an error
/// of their own.
pub fn refuse(state: &AppState, origin: &str, room: &str, identity: &str) -> Option<(axum::http::StatusCode, Value)> {
    if state.cfg.limits.blocked_origins.iter().any(|o| o == origin) {
        return Some((
            axum::http::StatusCode::FORBIDDEN,
            json!({ "error": format!("this relay does not serve {origin}"), "code": "origin_blocked" }),
        ));
    }
    // A room cap limits *new rooms*, never a new listener in an existing call.
    // A participant cap limits new identities; an existing identity must still
    // be able to renew its token or reconnect when the relay is full.
    // A transfer budget stops new calls, but doesn't strand an active call.
    // A drain for an update stops everything new for the same reason — and,
    // like the caps, still lets an existing seat renew, so the drain waits
    // for calls to end rather than stranding a reconnect mid-call.
    let limits = &state.cfg.limits;
    let existing_room = state.sessions.rooms().iter().any(|r| r == room);
    let existing_seat = state.sessions.cap_for(room, identity).is_some();
    let draining = is_draining(state) && !existing_seat;
    let rooms_full = !existing_room && limits.max_rooms > 0
        && state.sessions.rooms().len() as u32 >= limits.max_rooms;
    let seats_full = !existing_seat && limits.max_participants > 0
        && state.sessions.join_count_all() as u32 >= limits.max_participants;
    let budget_full = !existing_room && limits.transfer_budget_bytes > 0
        && state.usage.total_estimate(now_ms(), limits.transfer_period_days) >= limits.admission_budget_bytes();
    let reason = if draining {
        Some("draining for update")
    } else if rooms_full {
        Some("room limit reached")
    } else if seats_full {
        Some("participant limit reached")
    } else if budget_full {
        Some("transfer budget reached")
    } else {
        None
    };
    reason.map(full_error)
}

/// Structured refusal returned for races as well as ordinary admission checks.
pub fn full_error(reason: &'static str) -> (axum::http::StatusCode, Value) {
    (
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        json!({
            "error": format!("relay is not accepting new calls: {reason}"),
            "code": "relay_full",
        }),
    )
}

/// The `/health` body: what a guild server or the directory learns from one
/// knock. `accepting` is the routing signal; the counts and estimate are
/// display facts.
pub fn health_body(state: &AppState, livekit_ok: bool) -> Value {
    let status = status(state);
    let limits = &state.cfg.limits;
    json!({
        "service": "telium-sfu",
        "ok": livekit_ok,
        "accepting": status.accepting && livekit_ok,
        "reason": if status.accepting { Value::Null } else { Value::String(status.reason.into()) },
        "rooms": status.rooms,
        "participants": status.participants,
        "limits": {
            "max_rooms": limits.max_rooms,
            "max_participants": limits.max_participants,
        },
        "transfer": {
            "estimate_bytes": if limits.transfer_budget_bytes > 0 {
                Value::from(state.usage.total_estimate(now_ms(), limits.transfer_period_days))
            } else {
                Value::Null
            },
            "budget_bytes": if limits.transfer_budget_bytes > 0 { Value::from(limits.transfer_budget_bytes) } else { Value::Null },
            "period_days": limits.transfer_period_days,
            "stop_percent": limits.transfer_stop_percent,
            "stop_at_bytes": if limits.transfer_budget_bytes > 0 { Value::from(limits.admission_budget_bytes()) } else { Value::Null },
            "near_budget": status.near_budget,
        },
    })
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
