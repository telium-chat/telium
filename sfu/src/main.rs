
mod admission;
mod cli;
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

use crate::config::SfuConfig;
use crate::livekit::LivekitManager;
use crate::server::{router, AppState};
use crate::sessions::SessionRegistry;
use crate::trust::TrustedKeys;
use crate::usage::Usage;

#[derive(Parser)]
#[command(name = "telium-sfu", version, about = "Telium SFU front (LiveKit-backed media plane)")]
struct Cli {
    /// Path to the TOML config. `serve` works without one (defaults); the
    /// management commands look for an installed relay's config on their own.
    #[arg(short, long, global = true)]
    config: Option<PathBuf>,
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
    /// Look up a Telium server's keys the way this relay would for a join, and say what happened.
    ///
    /// Uses the same code and the same address policy as the running relay (from the config's
    /// [trust] section), but touches nothing: no state is kept and the service is not contacted.
    /// For an operator asking "why does this relay refuse joins from that server?".
    Discover {
        /// The server's name, as it appears in its join tokens (e.g. telium.chat).
        origin: String,
        /// Repeat the lookup, to catch a failure that only happens sometimes.
        #[arg(long, default_value_t = 1)]
        rounds: u32,
    },
    /// Show what the relay is doing: health, load, access, transfer, updates.
    Status {
        /// Machine-readable output.
        #[arg(long)]
        json: bool,
        /// Skip the release-manifest check (no outbound request).
        #[arg(long)]
        offline: bool,
    },
    /// Which Telium servers may use this relay (the whitelist of a private relay).
    Trust {
        #[command(subcommand)]
        command: Option<TrustCommand>,
    },
    /// Guild servers this relay refuses, whatever the trust mode.
    Block {
        #[command(subcommand)]
        command: Option<BlockCommand>,
    },
    /// Set the relay's domains and who may use it; configures HTTPS on a full install.
    Configure {
        /// Public hostname of the SFU API (e.g. sfu.example.com).
        #[arg(long)]
        sfu_domain: Option<String>,
        /// Public hostname for LiveKit signalling (e.g. livekit.example.com).
        #[arg(long)]
        livekit_domain: Option<String>,
        /// Let's Encrypt contact email (full installs only).
        #[arg(long)]
        email: Option<String>,
        /// Any federated Telium server may use this relay.
        #[arg(long, conflicts_with = "private")]
        public: bool,
        /// Only trusted Telium servers may use this relay.
        #[arg(long)]
        private: bool,
        /// Your homeserver's name; trusted automatically.
        #[arg(long)]
        homeserver: Option<String>,
        /// Where to find the homeserver's keys, when not discoverable from its name.
        #[arg(long)]
        discovery_url: Option<String>,
        /// Do not ask for confirmation.
        #[arg(long, short = 'y')]
        yes: bool,
        /// Save the config but leave the relay running as it is.
        #[arg(long)]
        no_restart: bool,
    },
    /// Restart the relay's service.
    Restart,
    /// Interactive menu over all of the above.
    Manage,
}

#[derive(Subcommand)]
enum TrustCommand {
    /// List whitelisted servers (the default).
    List,
    /// Look a server up, verify its keys, and whitelist it. Live; no restart.
    Add { server: String },
    /// Remove a server from the whitelist. Live; no restart.
    Remove { server: String },
}

#[derive(Subcommand)]
enum BlockCommand {
    /// List blocked guild servers (the default).
    List,
    /// Refuse new calls from a guild server. Live; no restart.
    Add { server: String },
    /// Stop refusing a guild server. Live; no restart.
    Remove { server: String },
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
        /// Root-controlled native updates cannot trust service-editable release settings.
        #[arg(long)]
        trusted_native: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let mut cli = Cli::parse();
    let explicit_config = cli.config.take();

    if let Some(command) = &cli.command {
        if is_management(command) {
            let path = cli::resolve_config_path(explicit_config.as_deref());
            cli::reexec_as_root_if_unreadable(&path);
            // Operator-facing: a message, not anyhow's `Error:` debug dump.
            if let Err(e) = manage_command(command, &path).await {
                eprintln!("error: {e:#}");
                std::process::exit(1);
            }
            return Ok(());
        }
    }
    let config_path = if matches!(cli.command, Some(Command::Discover { .. })) {
        // An operator's diagnostic, run against the installed relay's own
        // [trust] section, so find that config like the management commands do.
        let path = cli::resolve_config_path(explicit_config.as_deref());
        cli::reexec_as_root_if_unreadable(&path);
        path
    } else {
        explicit_config.unwrap_or_else(|| PathBuf::from("sfu.toml"))
    };
    cli.config = Some(config_path.clone());

    if matches!(cli.command, Some(Command::Init)) {
        let cfg = SfuConfig::default();
        std::fs::write(&config_path, toml::to_string_pretty(&cfg)?)?;
        println!("wrote {}", config_path.display());
        return Ok(());
    }

    if matches!(cli.command, Some(Command::Version)) {
        return print_version();
    }

    // The config audit wants *the file*, and wants it to exist: an updater
    // auditing a config that was never installed should fail loudly, not
    // approve defaults the running relay may not be using.
    if matches!(cli.command, Some(Command::Check)) {
        let cfg = SfuConfig::load(&config_path)?;
        cfg.updates.validate()?;
        cfg.limits.validate()?;
        println!("ok");
        return Ok(());
    }

    let cfg = if config_path.exists() {
        SfuConfig::load(&config_path)?
    } else {
        tracing::warn!(path = %config_path.display(), "no sfu.toml; using defaults");
        SfuConfig::default()
    };

    if let Some(Command::Discover { origin, rounds }) = &cli.command {
        return discover_command(&cfg, origin, *rounds).await;
    }

    if let Some(Command::Updates(UpdatesCommand::Check { artifact, pin, manifest_url, trusted_native })) = &cli.command {
        return updates_check(&cfg.updates, artifact.clone(), pin.as_deref(), manifest_url.as_deref(), *trusted_native).await;
    }

    cfg.updates.validate()?;
    cfg.limits.validate()?;
    if cfg.trust.public && cfg.limits.transfer_budget_bytes == 0 {
        tracing::warn!(
            "public SFU transfer budget is UNLIMITED; set [limits].transfer_budget_bytes to your provider allowance if the uplink is metered"
        );
    }

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
    if cfg.limits.transfer_budget_bytes > 0 {
        // A metered operator should not discover after a restart that an
        // unreadable ledger silently reset their transfer allowance to zero.
        usage.verify_metered_storage()?;
    }
    let state = Arc::new(AppState {
        blocked: Arc::new(std::sync::RwLock::new(cfg.limits.blocked_origins.clone())),
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

    // Follow the config file. The operator's `telium-sfu trust` / `block`
    // commands edit it from another process, and a change to either list is
    // live within a couple of seconds: no restart, no dropped calls. Other
    // settings still need a restart (they are read once, at startup). Without
    // a change, keys are re-discovered every `cache_ttl_secs` as before.
    {
        let trust = trust.clone();
        let blocked = state.blocked.clone();
        let config_path = config_path.clone();
        let refresh_every = Duration::from_secs((cfg.trust.cache_ttl_secs.clamp(60, 300)) as u64);
        tokio::spawn(async move {
            let modified = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
            let mut seen = modified(&config_path);
            let mut last_refresh = std::time::Instant::now();
            let mut ticker = tokio::time::interval(Duration::from_secs(2));
            loop {
                ticker.tick().await;
                let now = modified(&config_path);
                let changed = now != seen;
                if !changed && last_refresh.elapsed() < refresh_every {
                    continue;
                }
                match SfuConfig::load(&config_path) {
                    Ok(latest) if changed => {
                        *blocked.write().unwrap_or_else(|e| e.into_inner()) = latest.limits.blocked_origins.clone();
                        // Fetch keys before taking the lock: verification keeps
                        // working while a slow homeserver answers.
                        let mut next = TrustedKeys::from_config(&latest.trust);
                        next.refresh_discovery(&latest.trust).await;
                        let mut live = trust.write().await;
                        next.adopt_discovered(&live);
                        *live = next;
                        tracing::info!("sfu.toml changed; trusted and blocked servers reloaded");
                    }
                    Ok(latest) => trust.write().await.refresh_discovery(&latest.trust).await,
                    Err(e) => tracing::warn!(error = %e, "could not reload sfu.toml"),
                }
                // Even a failed load is "seen": one warning per edit, not one per tick.
                seen = now;
                last_refresh = std::time::Instant::now();
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

fn is_management(command: &Command) -> bool {
    matches!(
        command,
        Command::Status { .. }
            | Command::Trust { .. }
            | Command::Block { .. }
            | Command::Configure { .. }
            | Command::Restart
            | Command::Manage
    )
}

async fn manage_command(command: &Command, path: &std::path::Path) -> anyhow::Result<()> {
    match command {
        Command::Status { json, offline } => cli::status(path, *json, *offline).await,
        Command::Trust { command: None | Some(TrustCommand::List) } => cli::trust_list(path),
        Command::Trust { command: Some(TrustCommand::Add { server }) } => cli::trust_add(path, server).await,
        Command::Trust { command: Some(TrustCommand::Remove { server }) } => cli::trust_remove(path, server),
        Command::Block { command: None | Some(BlockCommand::List) } => cli::block_list(path),
        Command::Block { command: Some(BlockCommand::Add { server }) } => cli::block_add(path, server),
        Command::Block { command: Some(BlockCommand::Remove { server }) } => cli::block_remove(path, server),
        Command::Configure { sfu_domain, livekit_domain, email, public, private, homeserver, discovery_url, yes, no_restart } => {
            cli::configure(
                path,
                cli::ConfigureArgs {
                    sfu_domain: sfu_domain.clone(),
                    livekit_domain: livekit_domain.clone(),
                    email: email.clone(),
                    public: if *public { Some(true) } else if *private { Some(false) } else { None },
                    homeserver: homeserver.clone(),
                    discovery_url: discovery_url.clone(),
                    yes: *yes,
                    restart: if *no_restart { Some(false) } else { None },
                },
            )
            .await
        }
        Command::Restart => cli::restart(path),
        Command::Manage => cli::manage(path).await,
        _ => unreachable!("not a management command"),
    }
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
    // The installers check these markers before changing the system: this
    // release has the `status`/`trust`/`block`/`configure` commands they hand
    // the operator over to, and (portable) a pinned update-signing key.
    println!("portable_native_installer=1");
    println!("management_cli=1");
    println!(
        "publisher_key_embedded={}",
        !option_env!("TELIUM_RELEASE_PUBLIC_KEY").unwrap_or("").is_empty()
    );
    Ok(())
}

fn default_artifact() -> String {
    format!("sfu-linux-{}", std::env::consts::ARCH)
}

const OFFICIAL_SFU_MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/telium-chat/telium/main/deploy/sfu-releases.json";

/// Root-owned native update policy overrides the service-writable config.
fn trusted_native_update_policy(
    service: &crate::config::Updates,
    manifest_url: Option<&str>,
    publisher_key: &str,
) -> anyhow::Result<crate::config::Updates> {
    anyhow::ensure!(!publisher_key.is_empty(), "native auto-update requires an embedded publisher signing key");
    let mut result = service.clone();
    result.check = true;
    result.manifest_url = manifest_url.unwrap_or(OFFICIAL_SFU_MANIFEST_URL).to_owned();
    anyhow::ensure!(result.manifest_url.starts_with("https://"), "trusted native update manifest URL must use HTTPS");
    result.manifest_signature_url.clear();
    result.manifest_public_key = publisher_key.to_owned();
    result.validate()?;
    Ok(result)
}

async fn updates_check(
    updates: &crate::config::Updates,
    artifact: String,
    pin: Option<&str>,
    manifest_url: Option<&str>,
    trusted_native: bool,
) -> anyhow::Result<()> {
    let updates = if trusted_native {
        trusted_native_update_policy(
            updates,
            manifest_url,
            option_env!("TELIUM_RELEASE_PUBLIC_KEY").unwrap_or(""),
        )?
    } else {
        let mut updates = updates.clone();
        if let Some(url) = manifest_url {
            updates.manifest_url = url.to_owned();
        }
        updates.validate()?;
        updates
    };
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

#[cfg(test)]
mod native_updater_trust_tests {
    use super::*;

    #[test]
    fn service_writable_updates_cannot_choose_native_publisher_or_source() {
        let mut service = crate::config::Updates::default();
        service.check = false;
        service.manifest_url = "https://attacker.example/manifest".into();
        service.manifest_signature_url = "https://attacker.example/signature".into();
        service.manifest_public_key = "attacker-key".into();
        let result = trusted_native_update_policy(&service, None, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").unwrap();
        assert!(result.check);
        assert_eq!(result.manifest_url, OFFICIAL_SFU_MANIFEST_URL);
        assert!(result.manifest_signature_url.is_empty());
        assert_eq!(result.manifest_public_key, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    }

    #[test]
    fn trusted_native_updates_fail_closed_without_publisher_key() {
        let service = crate::config::Updates::default();
        assert!(trusted_native_update_policy(&service, None, "").is_err());
        assert!(trusted_native_update_policy(&service, Some("http://attacker.example"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").is_err());
        assert_eq!(
            trusted_native_update_policy(&service, Some("https://trusted.example/manifest"), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
                .unwrap().manifest_url,
            "https://trusted.example/manifest"
        );
    }
}

async fn discover_command(cfg: &SfuConfig, origin: &str, rounds: u32) -> anyhow::Result<()> {
    let trust = TrustedKeys::from_config(&cfg.trust);
    let policy = trust.discovery_policy(origin);
    println!("origin={origin} policy={policy:?} public={} whitelisted={}", cfg.trust.public, trust.knows(origin));
    let mut failures = 0;
    for round in 1..=rounds.max(1) {
        let host = crate::fetch::parse_authority(origin).map(|(h, _)| h).unwrap_or_default();
        match tokio::net::lookup_host((host.trim_matches(['[', ']']), 443)).await {
            Ok(addrs) => {
                let list: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
                println!("round={round} resolved={}", list.join(","));
            }
            Err(e) => println!("round={round} resolve_error={e}"),
        }
        let started = std::time::Instant::now();
        match crate::trust::try_discover_keys(origin, policy).await {
            Ok((base, keys)) => println!("round={round} ok api={base} keys={} in={:?}", keys.len(), started.elapsed()),
            Err(reason) => {
                failures += 1;
                println!("round={round} failed in={:?} reason={reason}", started.elapsed());
            }
        }
    }
    if failures > 0 {
        anyhow::bail!("{failures} of {rounds} lookups failed");
    }
    Ok(())
}
