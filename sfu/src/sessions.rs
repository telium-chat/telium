
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct JoinRecord {
    pub max_bitrate: i64,
    pub minted_at: Instant,
}

#[derive(Default)]
struct Inner {
    joins: HashMap<(String, String), JoinRecord>,
    watches: HashMap<(String, String, String), String>,
}

#[derive(Default)]
pub struct SessionRegistry {
    inner: Mutex<Inner>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means a handler panicked; every mutation is a single insert or remove.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn record_join(&self, room: &str, identity: &str, max_bitrate: i64) {
        self.lock().joins.insert(
            (room.to_string(), identity.to_string()),
            JoinRecord { max_bitrate, minted_at: Instant::now() },
        );
    }

    pub fn cap_for(&self, room: &str, identity: &str) -> Option<i64> {
        self.lock().joins.get(&(room.to_string(), identity.to_string())).map(|j| j.max_bitrate)
    }

    pub fn rooms(&self) -> Vec<String> {
        let g = self.lock();
        let mut rooms: Vec<String> = g.joins.keys().map(|(room, _)| room.clone()).collect();
        rooms.sort();
        rooms.dedup();
        rooms
    }

    /// Records minted less than `grace` ago are kept; the client may still be connecting.
    pub fn retain_present(&self, room: &str, present: &[String], grace: Duration) {
        let now = Instant::now();
        let mut g = self.lock();
        g.joins.retain(|(r, id), rec| {
            r != room || present.iter().any(|p| p == id) || now.duration_since(rec.minted_at) < grace
        });
        let alive: Vec<String> =
            g.joins.keys().filter(|(r, _)| r == room).map(|(_, id)| id.clone()).collect();
        g.watches.retain(|(r, viewer, streamer), _| {
            r != room || (alive.contains(viewer) && alive.contains(streamer))
        });
    }

    pub fn remove_participant(&self, room: &str, identity: &str) {
        let mut g = self.lock();
        g.joins.remove(&(room.to_string(), identity.to_string()));
        g.watches.retain(|(r, viewer, streamer), _| {
            r != room || (viewer != identity && streamer != identity)
        });
    }

    pub fn set_watch(&self, room: &str, viewer: &str, streamer: &str, quality: &str) {
        self.lock().watches.insert(
            (room.to_string(), viewer.to_string(), streamer.to_string()),
            quality.to_string(),
        );
    }

    pub fn clear_watch(&self, room: &str, viewer: &str, streamer: &str) {
        self.lock().watches.remove(&(room.to_string(), viewer.to_string(), streamer.to_string()));
    }

    #[allow(dead_code)] // read by tests; the control plane only writes it
    pub fn watch_quality(&self, room: &str, viewer: &str, streamer: &str) -> Option<String> {
        self.lock()
            .watches
            .get(&(room.to_string(), viewer.to_string(), streamer.to_string()))
            .cloned()
    }

    #[cfg(test)]
    pub fn join_count(&self) -> usize {
        self.lock().joins.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_records_are_scoped_by_room_and_identity() {
        let reg = SessionRegistry::new();
        reg.record_join("r1", "alice", 1_000);
        reg.record_join("r2", "alice", 2_000);
        assert_eq!(reg.cap_for("r1", "alice"), Some(1_000));
        assert_eq!(reg.cap_for("r2", "alice"), Some(2_000));
        assert_eq!(reg.cap_for("r1", "bob"), None);
        assert_eq!(reg.rooms(), vec!["r1".to_string(), "r2".to_string()]);
    }

    #[test]
    fn retain_drops_absent_identities_after_grace_and_their_watches() {
        let reg = SessionRegistry::new();
        reg.record_join("r", "viewer", 1);
        reg.record_join("r", "streamer", 1);
        reg.record_join("r", "gone", 1);
        reg.set_watch("r", "viewer", "streamer", "low");
        reg.set_watch("r", "viewer", "gone", "high");

        reg.retain_present("r", &["viewer".into()], Duration::from_secs(60));
        assert_eq!(reg.join_count(), 3);

        reg.retain_present("r", &["viewer".into(), "streamer".into()], Duration::ZERO);
        assert_eq!(reg.join_count(), 2);
        assert_eq!(reg.watch_quality("r", "viewer", "streamer").as_deref(), Some("low"));
        assert_eq!(reg.watch_quality("r", "viewer", "gone"), None);
    }

    #[test]
    fn removing_a_participant_clears_both_sides_of_its_watches() {
        let reg = SessionRegistry::new();
        reg.record_join("r", "a", 1);
        reg.record_join("r", "b", 1);
        reg.set_watch("r", "a", "b", "medium");
        reg.set_watch("r", "b", "a", "medium");
        reg.remove_participant("r", "a");
        assert_eq!(reg.cap_for("r", "a"), None);
        assert_eq!(reg.cap_for("r", "b"), Some(1));
        assert_eq!(reg.watch_quality("r", "a", "b"), None);
        assert_eq!(reg.watch_quality("r", "b", "a"), None);
    }
}
