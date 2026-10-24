//! Registry of error codes. A code is never renamed, is snake_case, never changes the status, carries interpolated values as fields, and is never set on a 500.

/// One code for no-such-user and wrong-password (enumeration oracle).
pub const INVALID_CREDENTIALS: &str = "invalid_credentials";

/// Deactivated by its owner; recoverable via reactivation (unlike `ACCOUNT_DELETED`).
pub const ACCOUNT_DEACTIVATED: &str = "account_deactivated";

pub const ACCOUNT_DELETED: &str = "account_deleted";

pub const ACCOUNT_ALREADY_ACTIVE: &str = "account_already_active";

/// Second factor outstanding; not a failure, retry the same request with a code.
pub const MFA_REQUIRED: &str = "mfa_required";

pub const INVALID_MFA_CODE: &str = "invalid_mfa_code";

pub const MFA_SETUP_NOT_STARTED: &str = "mfa_setup_not_started";

pub const MFA_NOT_CONFIGURED: &str = "mfa_not_configured";

/// Legacy password exchange on an OPAQUE account; tells the client to update the app.
pub const OPAQUE_REQUIRED: &str = "opaque_required";

pub const REAUTH_REQUIRED: &str = "reauth_required";

/// Reauth window ran out; distinct from `REAUTH_REQUIRED`.
pub const REAUTH_EXPIRED: &str = "reauth_expired";

/// One code for every recovery verification failure (enumeration).
pub const INVALID_RECOVERY_PROOF: &str = "invalid_recovery_proof";

pub const RECOVERY_ATTEMPT_EXPIRED: &str = "recovery_attempt_expired";

/// Carries `alternatives` when the operator names other servers.
pub const REGISTRATION_CLOSED: &str = "registration_closed";

pub const USERNAME_TAKEN: &str = "username_taken";

/// Carries `reason`: `too_short`, `too_long`, `charset` or `reserved`.
pub const USERNAME_INVALID: &str = "username_invalid";

pub const INVITE_INVALID: &str = "invite_invalid";

/// Carries `permission` (name from `crate::perms`). An unseen channel gets an uncoded 404 instead, to avoid confirming it exists.
pub const MISSING_PERMISSION: &str = "missing_permission";

/// Target is at or above the caller's role position; carries nothing.
pub const ROLE_HIERARCHY: &str = "role_hierarchy";

pub const OWNER_ONLY: &str = "owner_only";

pub const NOT_A_MEMBER: &str = "not_a_member";

/// Carries `expires_at` in ms.
pub const TIMED_OUT: &str = "timed_out";

/// Would leave the server with no administrator able to sign in. Carries `user_id` and `attempted` (`deactivate`, `delete`, `move` or `revoke`).
pub const LAST_ADMIN: &str = "last_admin";

/// Normal when an admin removed it; the SDK should forget the guild, not treat the credential as dead.
pub const BOT_NOT_INSTALLED: &str = "bot_not_installed";

/// Assertion not accepted: mint a fresh one and retry once. Lacks the `bot_` prefix because the SDK already branches on it.
pub const BOT_ASSERTION_REJECTED: &str = "assertion_rejected";

pub const UNKNOWN_BOT_TOKEN: &str = "unknown_bot_token";

/// Credential revoked or application disabled; terminal until re-issued.
pub const BOT_CREDENTIAL_REVOKED: &str = "bot_credential_revoked";

/// This host does not serve guilds. Retrying will never help.
pub const NOT_A_GUILD_SERVER: &str = "not_a_guild_server";

/// Carries `retry_after` in seconds.
pub const RATE_LIMITED: &str = "rate_limited";

/// No longer the primary; carries `leader` when known.
pub const DEMOTED: &str = "demoted";

pub const STANDBY_READ_ONLY: &str = "standby_read_only";

/// Shut down by its operator; terminal. Carries `sunset_at` and optionally `successor`.
pub const SHUT_DOWN: &str = "shut_down";

/// Retry in a moment (lock, in-flight migration, name race).
pub const TRY_AGAIN: &str = "try_again";

/// Mid-migration; carries `destination`.
pub const MIGRATION_IN_PROGRESS: &str = "migration_in_progress";

pub const MIGRATION_HANDOFF_INVALID: &str = "migration_handoff_invalid";

/// Destination refused; carries `destination` and optionally `reason`.
pub const MIGRATION_REFUSED: &str = "migration_refused";

/// Body too large; carries `limit` in bytes.
pub const TOO_LARGE: &str = "too_large";

pub const UNSUPPORTED_MEDIA_TYPE: &str = "unsupported_media_type";

/// A party is a bot; device verification needs two humans.
pub const PARTY_IS_BOT: &str = "party_is_bot";

/// The account being verified is a bot; separate from the above because the routes differ.
pub const SUBJECT_IS_BOT: &str = "subject_is_bot";

/// Verification request already outstanding.
pub const VERIFICATION_ALREADY_REQUESTED: &str = "verification_already_requested";

/// Out of storage; carries `used` and `limit` in bytes.
pub const QUOTA_EXCEEDED: &str = "quota_exceeded";

/// DM commit not built on the current epoch. Carries `epoch` and, when taken, `winner_seq`, `winner_epoch`, `winner_sender`, `winner_digest` (base64url SHA-256 of ciphertext) and `winner_frame_id`.
pub const EPOCH_CONFLICT: &str = "epoch_conflict";

/// Frame id already used for a different frame; carries `seq` of the holder.
pub const FRAME_ID_REUSED: &str = "frame_id_reused";

/// Key vault changed since read; carries stored `version` (0 if none).
pub const VAULT_VERSION_CONFLICT: &str = "vault_version_conflict";

/// Server doesn't order that conversation; carries `sequencer`.
pub const NOT_SEQUENCER: &str = "not_sequencer";

/// Someone else is the named committer; carries `committer`.
pub const NOT_COMMITTER: &str = "not_committer";

/// Stale or wrong-origin sequencer handoff; carries `n`, the newest held.
pub const HANDOFF_STALE: &str = "handoff_stale";

/// Frame or restart for a replaced generation; carries current `generation`.
pub const GENERATION_CONFLICT: &str = "generation_conflict";

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: &[&str] = &[
        INVALID_CREDENTIALS, ACCOUNT_DEACTIVATED, ACCOUNT_DELETED, ACCOUNT_ALREADY_ACTIVE,
        MFA_REQUIRED, INVALID_MFA_CODE, MFA_SETUP_NOT_STARTED, MFA_NOT_CONFIGURED, OPAQUE_REQUIRED,
        REAUTH_REQUIRED, REAUTH_EXPIRED, INVALID_RECOVERY_PROOF, RECOVERY_ATTEMPT_EXPIRED,
        REGISTRATION_CLOSED, USERNAME_TAKEN, USERNAME_INVALID, INVITE_INVALID, MISSING_PERMISSION,
        ROLE_HIERARCHY, OWNER_ONLY, NOT_A_MEMBER, TIMED_OUT, LAST_ADMIN, BOT_NOT_INSTALLED,
        BOT_ASSERTION_REJECTED, NOT_A_GUILD_SERVER, UNKNOWN_BOT_TOKEN, BOT_CREDENTIAL_REVOKED,
        PARTY_IS_BOT, SUBJECT_IS_BOT, VERIFICATION_ALREADY_REQUESTED, RATE_LIMITED, DEMOTED,
        STANDBY_READ_ONLY, SHUT_DOWN, TRY_AGAIN, MIGRATION_IN_PROGRESS, MIGRATION_HANDOFF_INVALID,
        MIGRATION_REFUSED, TOO_LARGE, UNSUPPORTED_MEDIA_TYPE, QUOTA_EXCEEDED,
        EPOCH_CONFLICT, FRAME_ID_REUSED, VAULT_VERSION_CONFLICT, NOT_SEQUENCER,
        NOT_COMMITTER, HANDOFF_STALE, GENERATION_CONFLICT,
    ];

    #[test]
    fn codes_are_unique_and_well_formed() {
        let mut seen = std::collections::BTreeSet::new();
        for code in ALL {
            assert!(!code.is_empty() && code.len() <= 48, "{code}");
            assert!(code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'), "{code}");
            assert!(!code.starts_with('_') && !code.ends_with('_'), "{code}");
            assert!(seen.insert(*code), "{code} is registered twice");
        }
    }
}
