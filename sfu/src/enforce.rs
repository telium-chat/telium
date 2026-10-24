//! Backstop that mutes tracks whose declared layers exceed the participant ceiling.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::livekit::{ParticipantInfo, TrackInfo, TrackKind};
use crate::server::AppState;

const JOIN_GRACE: Duration = Duration::from_secs(120);

pub fn assess(cap: i64, tracks: &[TrackInfo]) -> Vec<String> {
    let mut candidates: Vec<&TrackInfo> = tracks
        .iter()
        .filter(|t| t.kind == TrackKind::Video && !t.muted && t.declared_bitrate > 0)
        .collect();
    let mut total: i64 = candidates.iter().map(|t| t.declared_bitrate).sum();
    if total <= cap {
        return Vec::new();
    }
    candidates.sort_by(|a, b| b.declared_bitrate.cmp(&a.declared_bitrate).then(a.sid.cmp(&b.sid)));
    let mut out = Vec::new();
    for t in candidates {
        if total <= cap {
            break;
        }
        total -= t.declared_bitrate;
        out.push(t.sid.clone());
    }
    out
}

pub fn cap_for(state: &AppState, room: &str, p: &ParticipantInfo) -> Option<i64> {
    p.attributes
        .get(telium_protocol::MAX_BITRATE_ATTRIBUTE)
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
        .or_else(|| state.sessions.cap_for(room, &p.identity))
}

pub async fn sweep_once(state: &AppState) -> usize {
    let mut muted = 0;
    for room in state.sessions.rooms() {
        let participants = match state.livekit.list_participants(&room).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(room = %room, error = %e, "bitrate sweep: ListParticipants failed");
                continue;
            }
        };
        let present: Vec<String> = participants.iter().map(|p| p.identity.clone()).collect();
        state.sessions.retain_present(&room, &present, JOIN_GRACE);

        for p in &participants {
            let Some(cap) = cap_for(state, &room, p) else { continue };
            for sid in assess(cap, &p.tracks) {
                match state.livekit.mute_track(&room, &p.identity, &sid, true).await {
                    Ok(()) => {
                        muted += 1;
                        tracing::warn!(
                            room = %room, identity = %p.identity, track = %sid, cap,
                            "muted video track whose declared layers exceed the participant's ceiling"
                        );
                    }
                    Err(e) => tracing::warn!(
                        room = %room, identity = %p.identity, track = %sid, error = %e,
                        "bitrate sweep: MutePublishedTrack failed"
                    ),
                }
            }
        }
    }
    muted
}

pub async fn run(state: Arc<AppState>, mut shutdown: watch::Receiver<bool>) {
    let secs = state.cfg.limits.poll_interval_secs.max(1);
    let mut ticker = tokio::time::interval(Duration::from_secs(secs));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = ticker.tick() => { sweep_once(&state).await; }
            _ = shutdown.changed() => { if *shutdown.borrow() { break; } }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(sid: &str, bitrate: i64, muted: bool) -> TrackInfo {
        TrackInfo {
            sid: sid.into(),
            kind: TrackKind::Video,
            source: "SCREEN_SHARE".into(),
            muted,
            declared_bitrate: bitrate,
        }
    }

    #[test]
    fn nothing_to_mute_when_declared_total_fits() {
        let tracks = vec![video("a", 1_000_000, false), video("b", 500_000, false)];
        assert!(assess(1_500_000, &tracks).is_empty());
        assert!(assess(10_000_000, &tracks).is_empty());
    }

    #[test]
    fn mutes_largest_tracks_first_until_under_cap() {
        let tracks = vec![
            video("small", 300_000, false),
            video("big", 2_000_000, false),
            video("mid", 800_000, false),
        ];
        assert_eq!(assess(1_000_000, &tracks), vec!["big".to_string(), "mid".to_string()]);
        assert_eq!(assess(2_000_000, &tracks), vec!["big".to_string()]);
    }

    #[test]
    fn muted_tracks_audio_and_undeclared_ladders_do_not_count() {
        let tracks = vec![
            video("already", 5_000_000, true),
            TrackInfo {
                sid: "mic".into(),
                kind: TrackKind::Audio,
                source: "MICROPHONE".into(),
                muted: false,
                declared_bitrate: 5_000_000,
            },
            video("silent-ladder", 0, false),
            video("ok", 400_000, false),
        ];
        assert!(assess(500_000, &tracks).is_empty());
    }
}
