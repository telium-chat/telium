//! Log category vocabulary (`tracing` targets); add new ones to [`ALL`], checked by `tests/observability.rs`.

/// Process start and stop: config, preflight, database open, shutdown drain.
pub const STARTUP: &str = "telium::startup";

/// Generic HTTP request path; mostly `error.rs` logging the cause of a 500.
pub const REQUEST: &str = "telium::request";

/// Sessions, device revocation and account recovery.
pub const AUTH: &str = "telium::auth";

/// Account lifecycle: profile, deactivation, erasure, sunset.
pub const ACCOUNT: &str = "telium::account";

/// Direct messages, conversations, friendships and their outboxes.
pub const SOCIAL: &str = "telium::social";

/// Uploads, object store, remote-media cache and cold storage; the hash-list check is [`SCAN`].
pub const MEDIA: &str = "telium::media";

/// The upload hash-list scanner; fails silently, so filter on it (`telium_media_scan_failures_total` alerts).
pub const SCAN: &str = "telium::scan";

/// Voice and video: call setup, SFU control, region health, seat reclaim.
pub const VOICE: &str = "telium::voice";

/// Waking devices: Web Push, APNs, FCM, native relay, notification outbox.
pub const PUSH: &str = "telium::push";

/// Realtime gateway sockets: session start and end, refusals, protocol violations.
pub const GATEWAY: &str = "telium::gateway";

/// Traffic with other homeservers: signatures, key refresh, discovery, relocation, notices, catalogues, the signing key.
pub const FEDERATION: &str = "telium::federation";

/// The store-and-forward relay, separate from federation.
pub const RELAY: &str = "telium::relay";

/// Moving an account, guild or domain between servers; chatty during a migration.
pub const MIGRATION: &str = "telium::migration";

/// Backups: key, archives, pruning, remote upload, pre-migration archive, restore drills.
pub const BACKUP: &str = "telium::backup";

/// Warm-standby replication, promotion, demotion and failover fencing; apart from [`BACKUP`].
pub const STANDBY: &str = "telium::standby";

/// Moderation: Otto, reports and media-origin feed subscriptions.
pub const MODERATION: &str = "telium::moderation";

/// Server administration: admin audit trail, ownership and recovery claims; apart from [`MODERATION`].
pub const ADMIN: &str = "telium::admin";

/// Bot accounts, applications, installs and tokens.
pub const BOTS: &str = "telium::bots";

/// Scheduled housekeeping: sweep tick, retention and media sweeps; about when, not what.
pub const MAINTENANCE: &str = "telium::maintenance";

/// The metrics system itself: rollup worker and route table overflow.
pub const TELEMETRY: &str = "telium::telemetry";

/// Every category, for the test that walks the source.
pub const ALL: [&str; 20] = [
    STARTUP,
    REQUEST,
    AUTH,
    ACCOUNT,
    SOCIAL,
    MEDIA,
    SCAN,
    VOICE,
    PUSH,
    GATEWAY,
    FEDERATION,
    RELAY,
    MIGRATION,
    BACKUP,
    STANDBY,
    MODERATION,
    ADMIN,
    BOTS,
    MAINTENANCE,
    TELEMETRY,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vocabulary_is_a_set_and_every_name_is_under_one_prefix() {
        let mut seen = std::collections::BTreeSet::new();
        for name in ALL {
            assert!(
                name.starts_with("telium::"),
                "{name} is not under the telium:: prefix, so RUST_LOG=telium=... will not reach it"
            );
            assert!(seen.insert(name), "{name} appears twice in ALL");
        }
        assert_eq!(seen.len(), ALL.len());
    }
}
