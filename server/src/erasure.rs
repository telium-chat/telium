//! Finishes account deletion after the starting transaction; idempotent, journaled in `account_erasures`.

use crate::state::AppState;
use crate::util::now_ms;
use sqlx::SqliteConnection;

pub const RESIDUE: &str = "residue";
pub const MEDIA: &str = "media";
pub const FINISHED: &str = "finished";

const RETRY_MS: i64 = 60_000;

/// After this many failures the worker stops and leaves the row visible to an operator.
const MAX_ATTEMPTS: i64 = 20;

/// Tables the deletion transaction empties outright, with key column; read by `server/tests/data_lifecycle.rs`.
pub const DELETION_TABLES: &[(&str, &str)] = &[
    // The encrypted client sync blob and media settings; no other reader.
    ("sync_store", "user_id"),
    ("media_preferences", "user_id"),
    // Where this server would push to; deleted now so no endpoint survives the commit.
    ("push_subscriptions", "user_id"),
    // Rows where this account is the friendship subject; mirrors are in `RESIDUE_TABLES`.
    ("friends", "user_id"),
    // MLS and key-backup material: what makes messages unreadable, so it goes in the transaction.
    ("key_packages", "user_id"),
    ("key_backup", "user_id"),
    ("key_vault", "user_id"),
    ("identity_transitions", "user_id"),
    ("device_revocations", "user_id"),
    ("identity_recovery_policies", "user_id"),
    ("identity_roots", "user_id"),
    ("cross_signing", "user_id"),
    // Signatures this account issued; those issued about it belong to the residue.
    ("user_signatures", "signer"),
    // Credentials and in-flight use (`accounts` keeps an unmatchable `password_hash` of 'deleted').
    ("mfa_recovery_codes", "user_id"),
    ("opaque_login_attempts", "user_id"),
    ("opaque_reauth_tokens", "user_id"),
    ("home_sessions", "user_id"),
    // Recovery address and pending link; a kept address is a mailbox we could be made to write to.
    ("recovery_addresses", "user_id"),
    ("recovery_email_challenges", "user_id"),
];

/// Tables with rows keyed to a local account that survive the deletion transaction; public so tests walk this list.
pub const RESIDUE_TABLES: &[(&str, &str)] = &[
    // Remote guild servers the account belonged to; the revocation fan-out reads it after commit.
    ("remote_memberships", "user_id"),
    ("membership_moves", "user_id"),
    // A trigger clears this for devices active at deletion; earlier-revoked devices kept theirs.
    ("notification_devices", "user_id"),
    ("notification_inbox", "user_id"),
    ("notification_outbox", "recipient_id"),
    // Devices are only marked inactive in the transaction because `announce` needs them.
    ("devices", "user_id"),
    // Social graph rows where this account is the object, held by other local accounts.
    ("friends", "peer_id"),
    ("user_signatures", "subject"),
    // Listed twice: two columns name an account; `requester` rows are its asks, `subject` rows are asks of it.
    ("verification_requests", "requester"),
    ("verification_requests", "subject"),
    // Migration and recovery bookkeeping that names the account.
    ("migration_alerts", "user_id"),
    ("migration_handoffs", "user_id"),
    ("media_pulls", "owner_user_id"),
    ("imported_identities", "user_id"),
    ("password_reset_attempts", "user_id"),
    ("recovery_copy_attempts", "user_id"),
    // Per-user guild state: reads, voice presence, join answers, emoji entitlements, upload vouchers.
    ("read_state", "user_id"),
    ("voice_states", "user_id"),
    ("screening_answers", "user_id"),
    ("emoji_entitlements", "user_id"),
    ("media_vouchers", "user_id"),
    // In-flight interaction state; "it expires" does not answer "is my data gone".
    ("interactions", "user_id"),
    ("ephemeral_messages", "user_id"),
];

/// Opens the journal inside the deletion transaction.
pub async fn begin(tx: &mut SqliteConnection, user_id: &str) -> sqlx::Result<()> {
    let now = now_ms();
    sqlx::query(
        "INSERT INTO account_erasures (user_id, requested_at, stage, next_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(user_id) DO UPDATE SET stage = excluded.stage, next_at = excluded.next_at, \
             attempts = 0, last_error = NULL, finished_at = NULL",
    )
    .bind(user_id)
    .bind(now)
    .bind(RESIDUE)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    Ok(())
}

/// Drives one erasure as far as it goes now; the handler calls it, the worker retries the rest.
pub async fn drive(state: &AppState, user_id: &str) -> anyhow::Result<()> {
    loop {
        let stage: Option<String> =
            sqlx::query_scalar("SELECT stage FROM account_erasures WHERE user_id = ?")
                .bind(user_id)
                .fetch_optional(&state.pool)
                .await?;
        match stage.as_deref() {
            Some(RESIDUE) => {
                let erased = erase_residue(state, user_id).await?;
                sqlx::query(
                    "UPDATE account_erasures SET stage = ?, rows_erased = rows_erased + ?, \
                     attempts = 0, last_error = NULL WHERE user_id = ? AND stage = ?",
                )
                .bind(MEDIA)
                .bind(erased as i64)
                .bind(user_id)
                .bind(RESIDUE)
                .execute(&state.pool)
                .await?;
            }
            Some(MEDIA) => {
                let blobs = erase_profile_media(state, user_id).await?;
                sqlx::query(
                    "UPDATE account_erasures SET stage = ?, blobs_erased = blobs_erased + ?, \
                     finished_at = ?, attempts = 0, last_error = NULL \
                     WHERE user_id = ? AND stage = ?",
                )
                .bind(FINISHED)
                .bind(blobs as i64)
                .bind(now_ms())
                .bind(user_id)
                .bind(MEDIA)
                .execute(&state.pool)
                .await?;
            }
            // Finished, or removed while this ran; nothing to do.
            _ => return Ok(()),
        }
    }
}

/// Residue stage: all of [`RESIDUE_TABLES`] in one transaction.
async fn erase_residue(state: &AppState, user_id: &str) -> anyhow::Result<u64> {
    let mut tx = state.pool.begin().await?;
    let mut erased = 0u64;
    for (table, column) in RESIDUE_TABLES {
        // Names are compile-time constants; the only bound value is the account id.
        let sql = format!("DELETE FROM {table} WHERE {column} = ?");
        let done = sqlx::query(&sql).bind(user_id).execute(&mut *tx).await?;
        erased += done.rows_affected();
    }
    tx.commit().await?;
    Ok(erased)
}

/// Media stage: the account's own `purpose = 'profile'` assets; row first, then bytes (a failed file removal is swallowed).
async fn erase_profile_media(state: &AppState, user_id: &str) -> anyhow::Result<u64> {
    let doomed: Vec<String> = sqlx::query_scalar(
        "SELECT hash FROM media WHERE owner_user_id = ? AND purpose = 'profile'",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut erased = 0u64;
    for hash in &doomed {
        let done = sqlx::query("DELETE FROM media WHERE hash = ?")
            .bind(hash)
            .execute(&state.pool)
            .await?;
        if done.rows_affected() == 0 {
            continue;
        }
        let _ = state.media_store.delete(&crate::routes::media::media_key(state, hash)).await;
        // Best effort: peers that cached the avatar are told; a down peer keeps it until its TTL.
        crate::federation::media::broadcast_purge(state, hash).await;
        erased += 1;
    }
    Ok(erased)
}

/// Resumes unfinished erasures (crash aftermath) and retires old journal rows.
pub async fn run_due(state: &AppState) -> anyhow::Result<u64> {
    let now = now_ms();
    let due: Vec<(String, i64)> = sqlx::query_as(
        "SELECT user_id, attempts FROM account_erasures \
         WHERE stage != ? AND next_at <= ? AND attempts < ? ORDER BY next_at LIMIT 32",
    )
    .bind(FINISHED)
    .bind(now)
    .bind(MAX_ATTEMPTS)
    .fetch_all(&state.pool)
    .await?;

    let mut finished = 0u64;
    for (user_id, attempts) in due {
        match drive(state, &user_id).await {
            Ok(()) => finished += 1,
            Err(e) => {
                tracing::warn!(target: crate::logcat::ACCOUNT, %user_id, error = %e, "could not finish an account erasure; will retry");
                sqlx::query(
                    "UPDATE account_erasures SET attempts = attempts + 1, next_at = ?, \
                     last_error = ? WHERE user_id = ?",
                )
                .bind(now + RETRY_MS)
                .bind(e.to_string())
                .bind(&user_id)
                .execute(&state.pool)
                .await?;
                if attempts + 1 >= MAX_ATTEMPTS {
                    // Loud on purpose: a promised deletion has stopped and needs a human.
                    tracing::error!(
                        target: crate::logcat::ACCOUNT,
                        %user_id,
                        "an account erasure has failed {MAX_ATTEMPTS} times and has stopped \
                         retrying; residue of a deleted account remains in this database. See \
                         docs/data-lifecycle.md"
                    );
                }
            }
        }
    }

    // Retire the journal after the retention window.
    let keep_days = state.cfg.retention.erasure_journal_days;
    if keep_days > 0 {
        sqlx::query(
            "DELETE FROM account_erasures WHERE stage = ? AND finished_at IS NOT NULL \
             AND finished_at < ?",
        )
        .bind(FINISHED)
        .bind(now - keep_days * 24 * 60 * 60 * 1000)
        .execute(&state.pool)
        .await?;
    }
    Ok(finished)
}
