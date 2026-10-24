//! What `protocol_version` promises, who is inside the window, and how features ship without a bump.

use std::collections::BTreeSet;
use std::fmt;

/// Bump only for an incompatible change, with a new interop fixture directory.
pub const PROTOCOL_VERSION: u32 = 1;

/// Raising it makes every older peer unreachable; major releases only.
pub const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 1;

pub const PROTOCOL_HEADER: &str = "X-Telium-Protocol";

pub const MIN_PROTOCOL_HEADER: &str = "X-Telium-Min-Protocol";

pub const CAPABILITIES_HEADER: &str = "X-Telium-Capabilities";

pub const IGNORE_UNKNOWN_FIELDS: &str = "server/tests/interop.rs";


/// `try_again` error code distinguishes in-flight from refused. Without it: generic `conflict`.
pub const CAP_MIGRATE_TRY_AGAIN: &str = "migrate.try_again";

/// Guided migration handoff. Without it: the client offers an import code.
pub const CAP_MIGRATE_HANDOFF: &str = "migrate.handoff";

/// Sealed client sync state in account bundles. Without it: the client is told the account arrived unsealed.
pub const CAP_SYNC_SEALED: &str = "sync.sealed";

/// Signed relocation announcement ahead of a domain change. Without it: the move shows only via `moved_to`.
pub const CAP_RELOCATION_ANNOUNCE: &str = "relocation.announce";

/// Onboarding recommendation surface. Without it: never recommended as an account home.
pub const CAP_ONBOARDING_RECOMMENDATIONS: &str = "onboarding.recommendations";

/// Signed curator feeds and pinned keys in AutoMod rules. Without it: a following rule arrives inert.
pub const CAP_CURATOR_FEEDS: &str = "federation.curator_feeds";

/// Protected guild transport. Claims the mechanism, not that `relay.enabled`. Without it: the client says the home server is too old.
pub const CAP_TRANSPORT_RELAY: &str = "transport.relay";

pub const CAPABILITIES: &[&str] = &[
    CAP_CURATOR_FEEDS,
    CAP_MIGRATE_HANDOFF,
    CAP_MIGRATE_TRY_AGAIN,
    CAP_ONBOARDING_RECOMMENDATIONS,
    CAP_RELOCATION_ANNOUNCE,
    CAP_SYNC_SEALED,
    CAP_TRANSPORT_RELAY,
];

/// Empty: a peer with no capability header predates negotiation.
pub const LEGACY_CAPABILITIES: &[&str] = &[];


#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerCompat {
    pub version: u32,
    pub min_supported: u32,
    pub capabilities: BTreeSet<String>,
}

impl PeerCompat {
    pub fn local() -> Self {
        PeerCompat {
            version: PROTOCOL_VERSION,
            min_supported: MIN_SUPPORTED_PROTOCOL_VERSION,
            capabilities: CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
        }
    }

    /// Predates negotiation, so exactly version 1.
    pub fn legacy() -> Self {
        PeerCompat {
            version: 1,
            min_supported: 1,
            capabilities: LEGACY_CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
        }
    }

    /// Missing or unparseable values fall back to `legacy` field by field.
    pub fn from_wire(
        version: Option<&str>,
        min_supported: Option<&str>,
        capabilities: Option<&str>,
    ) -> Self {
        let legacy = PeerCompat::legacy();
        let version = version.and_then(parse_version).unwrap_or(legacy.version);
        // An inverted window is impossible; clamp to the version the peer named as current.
        let min_supported = min_supported
            .and_then(parse_version)
            .unwrap_or(legacy.min_supported)
            .min(version);
        let capabilities = capabilities
            .map(parse_capabilities)
            .unwrap_or_else(|| legacy.capabilities.clone());
        PeerCompat {
            version,
            min_supported,
            capabilities,
        }
    }

    pub fn has(&self, capability: &str) -> bool {
        self.capabilities.contains(capability)
    }

    pub fn capability_header(&self) -> String {
        self.capabilities.iter().cloned().collect::<Vec<_>>().join(",")
    }

    pub fn negotiate(&self) -> Result<Negotiated, Incompatibility> {
        negotiate(&PeerCompat::local(), self)
    }
}

/// Accepts `"1"` or `"v1"`: discovery carries `v1`, headers a bare integer.
pub fn parse_version(raw: &str) -> Option<u32> {
    let raw = raw.trim();
    let digits = raw.strip_prefix('v').or_else(|| raw.strip_prefix('V')).unwrap_or(raw);
    // `v1.2` reads as its major part.
    let major = digits.split('.').next().unwrap_or(digits);
    major.parse::<u32>().ok()
}

/// Unknown tokens are kept so operators can see what a newer peer offers.
pub fn parse_capabilities(raw: &str) -> BTreeSet<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        // Bounded because this arrives from a peer and is stored and displayed.
        .filter(|token| token.len() <= 64)
        .take(64)
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Negotiated {
    pub version: u32,
    pub shared: BTreeSet<String>,
    /// Capabilities the peer has that we do not; not an error, it shows an operator the peer is ahead.
    pub peer_only: BTreeSet<String>,
}

impl Negotiated {
    pub fn has(&self, capability: &str) -> bool {
        self.shared.contains(capability)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incompatibility {
    PeerTooOld {
        peer_version: u32,
        our_min: u32,
    },
    PeerTooNew {
        peer_min: u32,
        our_version: u32,
    },
}

impl Incompatibility {
    pub fn code(&self) -> &'static str {
        match self {
            Incompatibility::PeerTooOld { .. } => "peer_protocol_too_old",
            Incompatibility::PeerTooNew { .. } => "peer_protocol_too_new",
        }
    }

    /// What the operator can do about it, as opposed to `Display`'s statement of fact.
    pub fn remedy(&self) -> &'static str {
        match self {
            Incompatibility::PeerTooOld { .. } => {
                "The other operator must upgrade their server. Nothing on this \
                 side can reach them until they do; if they cannot upgrade, the \
                 only other option is to stay on a Telium release that still \
                 supports their protocol version."
            }
            Incompatibility::PeerTooNew { .. } => {
                "Upgrade this server. The peer has dropped support for the \
                 protocol version this build speaks, so the move is on this side."
            }
        }
    }
}

impl fmt::Display for Incompatibility {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Incompatibility::PeerTooOld {
                peer_version,
                our_min,
            } => write!(
                f,
                "the peer speaks Telium protocol v{peer_version}, and this server \
                 supports v{our_min} at the oldest"
            ),
            Incompatibility::PeerTooNew {
                peer_min,
                our_version,
            } => write!(
                f,
                "the peer requires Telium protocol v{peer_min} at the oldest, and \
                 this server speaks v{our_version}"
            ),
        }
    }
}

/// Windows overlap when each maximum reaches the other's minimum; the version is the lower maximum.
pub fn negotiate(ours: &PeerCompat, theirs: &PeerCompat) -> Result<Negotiated, Incompatibility> {
    if theirs.version < ours.min_supported {
        return Err(Incompatibility::PeerTooOld {
            peer_version: theirs.version,
            our_min: ours.min_supported,
        });
    }
    if theirs.min_supported > ours.version {
        return Err(Incompatibility::PeerTooNew {
            peer_min: theirs.min_supported,
            our_version: ours.version,
        });
    }
    Ok(Negotiated {
        version: ours.version.min(theirs.version),
        shared: ours.capabilities.intersection(&theirs.capabilities).cloned().collect(),
        peer_only: theirs.capabilities.difference(&ours.capabilities).cloned().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(version: u32, min_supported: u32, capabilities: &[&str]) -> PeerCompat {
        PeerCompat {
            version,
            min_supported,
            capabilities: capabilities.iter().map(|c| (*c).to_string()).collect(),
        }
    }

    #[test]
    fn a_peer_that_advertises_nothing_is_read_as_the_oldest_version_with_no_capabilities() {
        let silent = PeerCompat::from_wire(None, None, None);
        assert_eq!(silent, PeerCompat::legacy());
        assert!(!silent.has(CAP_MIGRATE_HANDOFF));
        assert!(silent.negotiate().is_ok(), "the legacy peer must stay inside the window");
    }

    #[test]
    fn a_version_survives_a_missing_capability_header() {
        let half = PeerCompat::from_wire(Some("3"), Some("2"), None);
        assert_eq!(half.version, 3);
        assert_eq!(half.min_supported, 2);
        assert!(half.capabilities.is_empty());
    }

    #[test]
    fn both_the_bare_and_the_v_prefixed_spelling_of_a_version_are_understood() {
        assert_eq!(parse_version("1"), Some(1));
        assert_eq!(parse_version("v1"), Some(1));
        assert_eq!(parse_version(" v2 "), Some(2));
        assert_eq!(parse_version("v2.4"), Some(2));
        assert_eq!(parse_version("next"), None);
    }

    #[test]
    fn a_peer_claiming_a_minimum_above_its_own_version_is_clamped_rather_than_refused() {
        let confused = PeerCompat::from_wire(Some("1"), Some("9"), None);
        assert_eq!(confused.min_supported, 1);
        assert!(confused.negotiate().is_ok());
    }

    #[test]
    fn negotiation_picks_the_highest_version_both_ends_speak() {
        let ours = peer(4, 2, &["a", "b"]);
        let theirs = peer(3, 1, &["b", "c"]);
        let agreed = negotiate(&ours, &theirs).unwrap();
        assert_eq!(agreed.version, 3);
        assert!(agreed.has("b"));
        assert!(!agreed.has("a"));
        assert_eq!(agreed.peer_only.iter().cloned().collect::<Vec<_>>(), vec!["c".to_string()]);
    }

    #[test]
    fn a_peer_below_our_minimum_is_refused_with_both_numbers_in_the_sentence() {
        let ours = peer(4, 3, &[]);
        let theirs = peer(2, 1, &[]);
        let err = negotiate(&ours, &theirs).unwrap_err();
        assert_eq!(err.code(), "peer_protocol_too_old");
        assert!(err.to_string().contains("v2"), "{err}");
        assert!(err.to_string().contains("v3"), "{err}");
        assert!(err.remedy().contains("upgrade their server"));
    }

    #[test]
    fn a_peer_that_has_dropped_our_version_is_refused_and_names_this_side_as_the_fix() {
        let ours = peer(2, 1, &[]);
        let theirs = peer(5, 4, &[]);
        let err = negotiate(&ours, &theirs).unwrap_err();
        assert_eq!(err.code(), "peer_protocol_too_new");
        assert!(err.remedy().contains("Upgrade this server"));
    }

    #[test]
    fn a_hostile_capability_header_cannot_grow_without_bound() {
        let huge = (0..500).map(|n| format!("cap{n}")).collect::<Vec<_>>().join(",");
        assert!(parse_capabilities(&huge).len() <= 64);
        let long = format!("{},ok", "x".repeat(500));
        let parsed = parse_capabilities(&long);
        assert_eq!(parsed.iter().cloned().collect::<Vec<_>>(), vec!["ok".to_string()]);
    }

    #[test]
    fn the_advertised_capability_list_is_sorted_and_stable() {
        let mut sorted = CAPABILITIES.to_vec();
        sorted.sort_unstable();
        assert_eq!(CAPABILITIES, sorted.as_slice(), "CAPABILITIES must stay sorted");
        assert_eq!(
            PeerCompat::local().capability_header(),
            CAPABILITIES.join(","),
        );
    }

    #[test]
    fn this_build_is_compatible_with_itself() {
        let agreed = PeerCompat::local().negotiate().unwrap();
        assert_eq!(agreed.version, PROTOCOL_VERSION);
        assert!(agreed.peer_only.is_empty());
    }
}
