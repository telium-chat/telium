
mod admission;
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
mod updates;
mod usage;

#[cfg(test)]
mod integration;

use std::path::PathBuf;
use std::sync::atomic::AtomicI64;
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
use crate::usage::Usage;

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
    /// Validate the config file and exit non-zero on a problem.
    ///
    /// This is the config audit the on-box updater runs with the *staged*
    /// binary before anything restarts, so a config a new build cannot load
    /// holds the update instead of breaking the relay.
    Check,
    /// Print what this build is, as key=value lines.
    ///
    /// For the shell, and specifically for the on-box updater, which has to
    /// answer "what is running here" without a config file and without
    /// trusting anything but the binary it asks. Opens nothing, prints four lines.
    Version,
    /// Read the release manifest and say what this relay should do about it.
    ///
    /// This is the parser half of `deploy/update-sfu-native.sh`, and it lives
    /// here rather than in the script because the manifest is untrusted input
    /// with rules about what may influence a decision, and those rules -- the
    /// size bounds, the shape checks, the sanitising of somebody else's text
    /// -- already exist in `src/updates.rs`, tested. A bash reimplementation
    /// would be a second opinion about hostile input, and the day the two
    /// disagree is the day one of them is wrong about a file that ends in a
    /// restart.
    ///
    /// Nothing here installs, restarts or writes anything: it is a question,
    /// and the script remains the only thing on the box allowed to act on it.
    #[command(subcommand)]
    Updates(UpdatesCommand),
}

#[derive(Subcommand)]
enum UpdatesCommand {
    /// Fetch, verify and compare the release manifest, and print the answer.
    ///
    /// Stdout is key=value lines, safe for a shell to read: every value has
    /// already been through the manifest sanitiser, so no line can forge
    /// another one. Exit status answers only "did I get a true answer" --
    /// zero for `action=current` as much as for `action=update`, non-zero
    /// when the manifest could not be read, verified or parsed, because the
    /// updater must be able to tell "stay put on purpose" from "I could not
    /// find out".
    Check {
        /// The installable artifact to look for. Defaults to this build's own
        /// architecture, so the updater script never has to know what CPU it
        /// is running on. A release that publishes no such artifact still
        /// answers -- `action=update` with no artifact lines -- and the
        /// updater words it for the operator.
        #[arg(long, default_value_t = default_artifact())]
        artifact: String,
        /// Aim at this release instead of the channel's newest: a 40-hex
        /// commit or a version, standing in for the pin in update-sfu.conf.
        #[arg(long)]
        pin: Option<String>,
        /// Read the manifest from here instead of `updates.manifest_url`.
        #[arg(long)]
        manifest_url: Option<String>,
    },
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

    if matches!(cli.command, Some(Command::Version)) {
        return print_version();
    }

    // The config audit wants *the file*, and wants it to exist: an updater
    // auditing a config that was never installed should fail loudly, not
    // approve defaults the running relay may not be using.
    if matches!(cli.command, Some(Command::Check)) {
        let cfg = SfuConfig::load(&cli.config)?;
        cfg.updates.validate()?;
        cfg.limits.validate()?;
        println!("ok");
        return Ok(());
    }

    let cfg = if cli.config.exists() {
        SfuConfig::load(&cli.config)?
    } else {
        tracing::warn!(path = %cli.config.display(), "no sfu.toml; using defaults");
        SfuConfig::default()
    };

    if let Some(Command::Updates(UpdatesCommand::Check { artifact, pin, manifest_url })) = &cli.command {
        cfg.updates.validate()?;
        return updates_check(&cfg.updates, artifact.clone(), pin.as_deref(), manifest_url.as_deref()).await;
    }

    cfg.updates.validate()?;
    cfg.limits.validate()?;

    let trust = TrustedKeys::from_config(&cfg.trust);
    // Never fatal: static keys remain authoritative.
    let trust = Arc::new(RwLock::new(trust));
    {
        let mut g = trust.write().await;
        g.refresh_discovery(&cfg.trust).await;
    }

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let livekit = LivekitManager::start(&cfg, shutdown_rx).await?;

    let usage = Arc::new(Usage::load(std::path::Path::new(&cfg.livekit.config_dir)));
    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        trust: trust.clone(),
        livekit: livekit.clone(),
        sessions: Arc::new(SessionRegistry::new()),
        usage,
        updates: Arc::new(RwLock::new(if cfg.updates.check {
            updates::Status::pending()
        } else {
            updates::Status::disabled()
        })),
        drain_until_ms: Arc::new(AtomicI64::new(0)),
    });
    let bind = state.cfg.bind.clone();

    updates::log_build();

    // Accounting is never optional when a transfer budget is in use. Disabling
    // media-enforcement must not silently switch off metering too.
    if !cfg.limits.enforce {
        tracing::warn!("video bitrate enforcement disabled; transfer accounting continues");
    }
    tokio::spawn(enforce::run(state.clone(), shutdown_tx.subscribe()));

    // The check loop only reports; the apply is the updater script's job.
    updates::spawn(state.clone());

    // SIGUSR1 asks the relay to drain for an update: refuse new joins, let
    // live calls finish, resume on its own after updates.drain_max_secs so a
    // crashed updater cannot wedge admission shut. The update script polls
    // /health to see the drain take effect and the rooms empty.
    #[cfg(unix)]
    {
        let drain_state = state.clone();
        tokio::spawn(async move {
            if let Ok(mut s) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1())
            {
                while s.recv().await.is_some() {
                    admission::begin_drain(&drain_state);
                    tracing::warn!(
                        drain_max_secs = drain_state.cfg.updates.drain_max_secs,
                        "drain requested (SIGUSR1): refusing new joins until rooms empty or the deadline passes"
                    );
                    // Tell whoever is in a call. Best effort and off the signal
                    // path: the drain is real whether or not the notice lands.
                    let until =
                        drain_state.drain_until_ms.load(std::sync::atomic::Ordering::Relaxed);
                    let notice_state = drain_state.clone();
                    tokio::spawn(async move {
                        announce_drain(&notice_state, "draining", Some(until)).await;
                    });
                }
            }
        });
    }

    if cfg.admin.enabled {
        let admin_state = Arc::new(AdminState::new(
            cfg.clone(),
            cli.config.clone(),
            livekit.clone(),
            trust.clone(),
            state.usage.clone(),
            state.sessions.clone(),
            state.updates.clone(),
            state.drain_until_ms.clone(),
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
    let app = router(state.clone());

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "telium-sfu up");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown_tx, state))
        .await?;
    Ok(())
}

/// One `telium.drain` message to every occupied room, phrased `draining` (an
/// update is scheduled, `until_ms` is the drain deadline) or `now` (the relay
/// is going away). The room list comes from the session registry, which the
/// sweeper only prunes when `[limits].enforce` is on -- and even then only
/// every poll interval -- so each room's occupancy is confirmed against
/// LiveKit before speaking; announcing into a dead room would be an error
/// line per room per restart. Failures are logged and swallowed: the notice
/// is a courtesy, never a coordination step the drain depends on.
async fn announce_drain(state: &AppState, phase: &str, until_ms: Option<i64>) {
    let mut payload = serde_json::json!({ "phase": phase });
    if let Some(until) = until_ms {
        payload["until_ms"] = serde_json::json!(until);
    }
    // Bound simultaneous LiveKit requests while notifying occupied rooms in
    // parallel: a slow room should not starve every room after it.
    let gate = Arc::new(tokio::sync::Semaphore::new(8));
    let mut tasks = tokio::task::JoinSet::new();
    for room in state.sessions.rooms() {
        let Ok(permit) = gate.clone().acquire_owned().await else { break };
        let livekit = state.livekit.clone();
        let body = payload.clone();
        tasks.spawn(async move {
            let _permit = permit;
            match livekit.list_participants(&room).await {
                Ok(participants) if participants.is_empty() => return,
                Ok(_) => {}
                Err(e) => {
                    tracing::debug!(room = %room, error = %e, "could not count participants for a drain notice");
                    return;
                }
            }
            if let Err(e) = livekit.broadcast(&room, telium_protocol::DRAIN_TOPIC, &body).await {
                tracing::warn!(room = %room, error = %e, "drain notice did not reach this room");
            }
        });
    }
    while let Some(result) = tasks.join_next().await {
        if let Err(e) = result {
            tracing::warn!(error = %e, "drain notice task failed");
        }
    }
}

async fn shutdown_signal(shutdown_tx: watch::Sender<bool>, state: Arc<AppState>) {
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
    // Normally the drain has already emptied the rooms and this says nothing
    // to nobody. It is for the deadline-expired stragglers: they get one
    // message that the media plane is going away *before* LiveKit drops them,
    // then the client's usual drop ladder takes over.
    // Notification delivery must not hold SIGTERM for minutes if LiveKit is
    // unhealthy or many stale rooms are recorded. Docker's stop grace is 10s.
    if tokio::time::timeout(Duration::from_secs(2), announce_drain(&state, "now", None))
        .await
        .is_err()
    {
        tracing::warn!("timed out announcing SFU shutdown; proceeding anyway");
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let _ = shutdown_tx.send(true);
}

fn print_version() -> anyhow::Result<()> {
    let b = crate::updates::build();
    println!("version={}", b.version);
    println!("commit={}", b.commit);
    println!(
        "commit_time={}",
        if b.commit_time_ms == 0 { String::new() } else { b.commit_time_ms.to_string() }
    );
    println!(
        "built_at={}",
        if b.built_at_ms == 0 { String::new() } else { b.built_at_ms.to_string() }
    );
    Ok(())
}

fn default_artifact() -> String {
    format!("sfu-linux-{}", std::env::consts::ARCH)
}

async fn updates_check(
    updates: &crate::config::Updates,
    artifact: String,
    pin: Option<&str>,
    manifest_url: Option<&str>,
) -> anyhow::Result<()> {
    let mut updates = updates.clone();
    if let Some(url) = manifest_url {
        updates.manifest_url = url.to_string();
    }
    let manifest = crate::updates::read_manifest(&updates)
        .await
        .map_err(|(kind, e)| anyhow::anyhow!("{}: {e}", kind.as_str()))?;
    let plan = crate::updates::plan(crate::updates::build().commit, &manifest, pin, &artifact);

    println!("ours={}", plan.ours);
    println!(
        "action={}",
        match plan.action {
            crate::updates::PlanAction::Current => "current",
            crate::updates::PlanAction::Update => "update",
            crate::updates::PlanAction::UnidentifiedBuild => "unidentified_build",
            crate::updates::PlanAction::NotPublished => "not_published",
        }
    );
    if let Some(target) = &plan.target {
        println!("target_commit={}", target.commit);
        if let Some(version) = &target.version {
            println!("target_version={version}");
        }
        println!("target_released_at={}", target.released_at);
        println!("target_security={}", target.security);
        if !target.summary.is_empty() {
            println!("summary={}", target.summary);
        }
        if let Some((name, a)) = &target.artifact {
            println!("artifact_name={name}");
            println!("artifact_url={}", a.url);
            println!("artifact_sha256={}", a.sha256);
            if let Some(size) = a.size {
                println!("artifact_size={size}");
            }
        }
    }
    if plan.action == crate::updates::PlanAction::Update {
        println!("missed={}", plan.missed);
        println!("security={}", plan.missed_security);
        println!("breaking={}", plan.breaking);
        if !plan.notes.is_empty() {
            let joined = plan
                .notes
                .iter()
                .map(|n| n.text.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            println!("notes={}", joined.chars().take(1200).collect::<String>());
        }
    }
    Ok(())
}
