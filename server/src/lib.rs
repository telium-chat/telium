// sqlx row tuples are wide; a named type per query would obscure more.
#![allow(clippy::type_complexity)]

pub mod admin;
pub mod auth;
pub mod backup;
pub mod bot_receipts;
pub mod cold;
pub mod config;
pub mod crypto;
pub mod db;
pub mod emoji;
pub mod erasure;
pub mod errcodes;
pub mod error;
pub mod expression;
pub mod federation;
pub mod gateway;
pub mod hosting;
pub mod instance;
/// Log category vocabulary; `tests/observability.rs` checks it against the docs.
pub mod logcat;
pub mod metrics;
pub mod mfa;
pub mod migration;
pub mod mail;
pub mod memberships;
pub mod notifications;
pub mod ownership;
pub mod guildstore;
pub mod objectstore;
pub mod perms;
pub mod preflight;
pub mod promotion;
pub mod pushproviders;
pub mod relocation;
pub mod revocation;
pub mod sunset;
pub mod ratelimit;
pub mod relay;
pub mod replicate;
pub mod retention;
pub mod rotations;
pub mod rows;
#[path = "routes_secure.rs"]
pub mod routes;
pub mod scan;
pub mod secrets;
pub mod security_headers;
pub mod sendonce;
pub mod shutdown;
pub mod state;
pub mod updates;
pub mod usage;
pub mod util;
pub mod vanity;
pub mod webpush;

pub use config::Config;
pub use state::AppState;

use std::sync::Arc;

/// What the building process intends: only the homeserver takes the lease, voice sweep and Otto boot; one-off tools must not.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    /// This process is the homeserver.
    Serve,
    /// A one-off command alongside a possibly running server.
    Tool,
}

/// Serving build: opens the database, migrates, loads the signing key, creates the hub. Tests use it too.
pub async fn build_state(cfg: Config) -> anyhow::Result<AppState> {
    build_state_as(cfg, Role::Serve).await
}

pub async fn build_state_as(cfg: Config, role: Role) -> anyhow::Result<AppState> {
    let serving = role == Role::Serve;
    let cfg = Arc::new(cfg);
    std::fs::create_dir_all(&cfg.media_dir)?;
    let pool = db::connect_checked(&cfg.database_url, &cfg.integrity).await?;
    // Apply an announced relocation rename before anything reads the database.
    if let Some(old) = relocation::apply_local_rename(&pool, &cfg).await? {
        tracing::info!(target: crate::logcat::STARTUP, %old, new = %cfg.server_name, "domain relocation applied");
    }
    let key = crypto::load_or_create_key(&pool, cfg.sessions.signing_key_validity_secs).await?;
    // Before sign-in can be served. Deliberately doesn't refuse on a missing key: `mfa reset-all` goes through here; the refusal is `mfa::refuse_if_locked_out` in `serve()`.
    let mfa = Arc::new(mfa::start(&pool, &cfg).await?);
    let hub = Arc::new(gateway::hub::Hub::new(cfg.limits.presence_coalesce_secs));
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(cfg.federation.request_timeout_secs))
        .user_agent(format!("telium-server/{} ({})", env!("CARGO_PKG_VERSION"), cfg.server_name))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()?;
    let http_no_redirect = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(cfg.federation.request_timeout_secs))
        .user_agent(format!("telium-server/{} ({})", env!("CARGO_PKG_VERSION"), cfg.server_name))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let limiter = Arc::new(ratelimit::RateLimiter::new(cfg.rate_limit.clone()));
    let vapid = Arc::new(webpush::load_or_create(&pool).await?);
    let push_providers = Arc::new(pushproviders::Providers::load(&cfg)?);
    let archive_store =
        Arc::new(objectstore::ObjectStore::new(&cfg.archive.store, &cfg.archive.s3).await?);
    let media_store =
        Arc::new(objectstore::ObjectStore::new(&cfg.media_store.store, &cfg.media_store.s3).await?);
    let hash_lists = Arc::new(scan::HashLists::load(&cfg.moderation)?);
    let gofile_guest_token = Arc::new(tokio::sync::Mutex::new(None));
    // Claim the lease before anything touches rows a running instance might own (`mark_unclaimed` would hang up live calls). Tools claim nothing.
    let lease = if serving {
        let lease = Arc::new(instance::Lease::claim(&pool).await?);
        lease.clone().spawn_heartbeat();
        Some(lease)
    } else {
        None
    };

    // Voice states predating this boot are unclaimed, not dead: they keep their place for `voice.reconnect_grace_secs`, a reconnecting device reclaims them (`routes::voice::reclaim`), the rest are swept. Serving only.
    if serving {
        let (expired, unclaimed) =
            routes::voice::mark_unclaimed(&pool, cfg.voice.reconnect_grace_secs).await?;
        if expired > 0 || unclaimed > 0 {
            tracing::info!(target: crate::logcat::STARTUP, expired, unclaimed, "voice states left by the previous run");
        }
    }
    // Write-logging triggers only where a standby is configured.
    if cfg.failover.standbys.is_empty() {
        replicate::drop_triggers(&pool).await?;
    } else {
        // Reinstalled every boot so tables added by later migrations are covered.
        replicate::install_triggers(&pool).await?;
    }
    let signing_origin = Arc::new(cfg.server_name.clone());
    // Check turned off starts `disabled`, not `pending` forever.
    let check = cfg.updates.check;
    let shut_down = Arc::new(std::sync::atomic::AtomicBool::new(sunset::finalized(&pool).await));
    let state = AppState {
        cfg,
        pool,
        key: Arc::new(key),
        signing_origin,
        authority_record: Arc::new(tokio::sync::RwLock::new(None)),
        authority_workers_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        shutting_down: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        shutdown: Arc::new(tokio::sync::Notify::new()),
        replica_host_pool: None,
        hub,
        metrics: Arc::new(crate::metrics::Metrics::new()),
        http,
        http_no_redirect,
        limiter,
        relay: std::sync::Arc::new(relay::RelayState::new()),
        vapid,
        mfa,
        push_providers,
        archive_store,
        media_store,
        big_bodies: Arc::new(federation::BigBodies::new(federation::CONCURRENT_BIG_BODIES)),
        imports_in_flight: Arc::new(migration::ImportsInFlight::default()),
        send_once: Arc::new(sendonce::SendOnce::default()),
        hash_lists,
        gofile_guest_token,
        demoted: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        shut_down,
        updates: Arc::new(tokio::sync::RwLock::new(if check {
            updates::Status::pending()
        } else {
            updates::Status::disabled()
        })),
        lease,
    };
    Ok(state)
}
