//! The claimed release stage.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    Alpha,
    Beta,
    Stable,
}

impl Stage {
    pub const fn slug(self) -> &'static str {
        match self {
            Stage::Alpha => "alpha",
            Stage::Beta => "beta",
            Stage::Stable => "stable",
        }
    }

    pub const ALL: &'static [Stage] = &[Stage::Alpha, Stage::Beta, Stage::Stable];

    pub fn from_slug(raw: &str) -> Option<Stage> {
        Stage::ALL.iter().copied().find(|s| s.slug() == raw.trim())
    }
}

impl fmt::Display for Stage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.slug())
    }
}

/// Raising it claims every gate at and below the new stage is ticked; the gate test enforces it.
pub const RELEASE_STAGE: Stage = Stage::Alpha;

/// Promises other implementations about the bytes; independent of `RELEASE_STAGE`.
pub const PROTOCOL_FROZEN: bool = false;

pub const fn requires_pre_release_warning() -> bool {
    !matches!(RELEASE_STAGE, Stage::Stable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_round_trip() {
        for stage in Stage::ALL {
            assert_eq!(Stage::from_slug(stage.slug()), Some(*stage));
        }
        assert_eq!(Stage::from_slug("release-candidate"), None);
    }

    #[test]
    fn stages_are_ordered_lowest_first() {
        assert!(Stage::Alpha < Stage::Beta);
        assert!(Stage::Beta < Stage::Stable);
        // The gate test walks ALL assuming it is sorted.
        assert!(Stage::ALL.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn the_warning_is_required_until_stable() {
        assert_eq!(
            requires_pre_release_warning(),
            RELEASE_STAGE != Stage::Stable,
        );
    }
}
