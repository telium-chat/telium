
use crate::state::AppState;
use crate::util::now_ms;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Swept {
    pub notices: u64,
    pub tombstones: u64,
    pub remote_tombstones: u64,
    pub audit_entries: u64,
}

impl Swept {
    fn total(&self) -> u64 {
        self.notices + self.tombstones + self.remote_tombstones + self.audit_entries
    }
}

pub async fn sweep(state: &AppState) -> anyhow::Result<Swept> {
    let cfg = &state.cfg.retention;
    let now = now_ms();
    let mut swept = Swept::default();

    if cfg.delivered_notice_days > 0 {
        swept.notices = sqlx::query(
            "DELETE FROM identity_notices WHERE delivered_at IS NOT NULL AND delivered_at < ?",
        )
        .bind(now - cfg.delivered_notice_days * DAY_MS)
        .execute(&state.pool)
        .await?
        .rows_affected();
    }

    if cfg.tombstone_days > 0 {
        swept.tombstones = sqlx::query("DELETE FROM tombstones WHERE created_at < ?")
            .bind(now - cfg.tombstone_days * DAY_MS)
            .execute(&state.pool)
            .await?
            .rows_affected();
    }

    if cfg.remote_cache_days > 0 {
        swept.remote_tombstones = sqlx::query("DELETE FROM remote_tombstones WHERE learned_at < ?")
            .bind(now - cfg.remote_cache_days * DAY_MS)
            .execute(&state.pool)
            .await?
            .rows_affected();
    }

    if cfg.audit_log_days > 0 {
        swept.audit_entries = sqlx::query("DELETE FROM audit_log WHERE created_at < ?")
            .bind(now - cfg.audit_log_days * DAY_MS)
            .execute(&state.pool)
            .await?
            .rows_affected();
    }

    if swept.total() > 0 {
        tracing::info!(
            target: crate::logcat::MAINTENANCE,
            notices = swept.notices,
            tombstones = swept.tombstones,
            remote_tombstones = swept.remote_tombstones,
            audit_entries = swept.audit_entries,
            "retention sweep"
        );
    }
    Ok(swept)
}
