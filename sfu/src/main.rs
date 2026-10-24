
mod admin;
mod config;
mod control;
mod enforce;
mod fetch;
mod livekit;
mod server;
mod session;
mod sessions;
mod trust;

#[cfg(test)]
mod integration;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::{Parser, Subcommand};
use tokio::sync::watch;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::admin::AdminState;
use crate::config::SfuConfig;
use crate::livekit::LivekitManager;
use crate::server::{router, AppState};
use crate::sessions::SessionRegistry;
use crate::trust::TrustedKeys;

#[derive(Parser)]
#[command(name = "telium-sfu", version, about = "Telium SFU front (LiveKit-backed media plane)")]
struct Cli {
    /// Path to the TOML config. Defaults are usable without one.
    #[arg(short, long, default_value = "sfu.toml", global = true)]
    config: PathBuf,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the SFU front (default).
    Serve,
    /// Write a starter config to the config path.
    Init,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();

    if matches!(cli.command, Some(Command::Init)) {
        let cfg = SfuConfig::default();
        std::fs::write(&cli.config, toml::to_string_pretty(&cfg)?)?;
        println!("wrote {}", cli.config.display());
        return Ok(());
    }

    let cfg = if cli.config.exists() {
        SfuConfig::load(&cli.config)?
    } else {
        tracing::warn!(path = %cli.config.display(), "no sfu.toml; using defaults");
        SfuConfig::default()
    };

    let trust = TrustedKeys::from_config(&cfg.trust);
    // Never fatal: static keys remain authoritative.
    let trust = Arc::new(RwLock::new(trust));
    {
        let mut g = trust.write().await;
        g.refresh_discovery(&cfg.trust).await;
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let livekit = LivekitManager::start(&cfg, shutdown_rx).await?;

    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        trust: trust.clone(),
        livekit: livekit.clone(),
        sessions: Arc::new(SessionRegistry::new()),
    });
    let bind = state.cfg.bind.clone();

    if cfg.limits.enforce {
        tracing::info!(
            max_bitrate = cfg.limits.max_bitrate,
            every_secs = cfg.limits.poll_interval_secs,
            "bitrate sweep enabled"
        );
        tokio::spawn(enforce::run(state.clone(), shutdown_tx.subscribe()));
    } else {
        tracing::warn!("bitrate sweep disabled ([limits].enforce = false); ceilings are client-side only");
    }

    if cfg.admin.enabled {
        let admin_state = Arc::new(AdminState::new(
            cfg.clone(),
            cli.config.clone(),
            livekit.clone(),
            trust.clone(),
        )?);
        let admin_bind = cfg.admin.bind.clone();
        if admin_state.needs_bootstrap() {
            tracing::warn!(
                "FIRST-RUN SETUP: open {} and replace SERVER_IP with this machine's IP",
                admin_state.bootstrap_url()
            );
        } else {
            tracing::info!(bind = %admin_bind, "SFU admin dashboard enabled at /admin");
        }
        tokio::spawn(async move {
            match tokio::net::TcpListener::bind(&admin_bind).await {
                Ok(listener) => {
                    if let Err(e) = axum::serve(listener, crate::admin::router(admin_state)).await {
                        tracing::error!(error = %e, "admin dashboard stopped");
                    }
                }
                Err(e) => tracing::error!(bind = %admin_bind, error = %e, "could not bind admin dashboard"),
            }
        });
    }

    {
        let trust = trust.clone();
        let config_path = cli.config.clone();
        let secs = (cfg.trust.cache_ttl_secs.clamp(60, 300)) as u64;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(secs));
            loop {
                ticker.tick().await;
                match SfuConfig::load(&config_path) {
                    Ok(latest) => trust.write().await.refresh_discovery(&latest.trust).await,
                    Err(e) => tracing::warn!(error = %e, "could not reload trust config for key refresh"),
                }
            }
        });
    }
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "telium-sfu up");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_tx))
        .await?;
    Ok(())
}

async fn shutdown_signal(shutdown_tx: watch::Sender<bool>) {
    let ctrl_c = async { tokio::signal::ctrl_c().await.ok(); };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    tracing::info!("shutting down");
    let _ = shutdown_tx.send(true);
}
