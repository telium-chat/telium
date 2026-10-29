use super::{curators, media, media_feeds, revalidate_sessions};
use crate::state::AppState;

pub fn spawn_slow_housekeeping(state: AppState) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            ticker.tick().await;
            if let Err(e) = crate::routes::media::sweep_orphans(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "orphaned media sweep failed");
            }
            if let Err(e) = crate::routes::media::sweep_unreferenced(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "unreferenced media sweep failed");
            }
            if let Err(e) = crate::migration::sweep_claims(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "import claim sweep failed");
            }
            if let Err(e) = crate::migration::handoff::sweep(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "migration handoff sweep failed");
            }
            if let Err(e) = crate::emoji::sweep(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "emoji entitlement sweep failed");
            }
            if let Err(e) = crate::erasure::run_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "account erasure sweep failed");
            }
            if let Err(e) = crate::retention::sweep(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "retention sweep failed");
            }
        }
    });
}

pub fn spawn_maintenance(state: AppState) {
    spawn_slow_housekeeping(state.clone());
    let interval = state.cfg.federation.revalidate_interval_secs.max(30) as u64;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(interval));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(e) = revalidate_sessions(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "session revalidation failed");
            }
            if let Err(e) = media::sweep_cache(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "media cache sweep failed");
            }
            if let Err(e) = crate::routes::media::sweep_expired(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "expired media sweep failed");
            }
            if let Err(e) = crate::routes::migrate::run_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "due migrations failed");
            }
            if let Err(e) = crate::memberships::run_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "membership moves failed");
            }
            if let Err(e) = crate::migration::media::pull_omitted(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "fetching uploads left out of a migration bundle failed");
            }
            if let Err(e) = crate::routes::dm::flush_outbox(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "dm outbox flush failed");
            }
            if let Err(e) = crate::routes::friends::flush_outbox(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "friend outbox flush failed");
            }
            if let Err(e) = crate::relocation::flush(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "relocation notice delivery failed");
            }
            if let Err(e) = crate::relocation::recheck(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "relocation recheck failed");
            }
            if let Err(e) = crate::revocation::flush(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "identity revocation notice delivery failed");
            }
            if let Err(e) = crate::routes::voice::health_check(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "voice region health check failed");
            }
            if let Err(e) = crate::routes::social::archive_idle_threads(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "thread archival failed");
            }
            if let Err(e) = crate::cold::sweep(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "cold storage sweep failed");
            }
            if let Err(e) = media_feeds::refresh_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "media origin feed refresh failed");
            }
            if let Err(e) = curators::refresh_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "curator directory refresh failed");
            }
            if let Err(e) = crate::hosting::refresh_due(&state).await {
                tracing::warn!(target: crate::logcat::MAINTENANCE, error = %e, "hosting catalog refresh failed");
            }
        }
    });
}
