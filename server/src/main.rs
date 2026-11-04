
use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use telium_server::{backup, build_state_as, routes, Config, Role};
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "telium-server", version, about = "Telium reference homeserver")]
struct Cli {
    /// Path to the TOML config. Defaults are usable without one.
    #[arg(short, long, default_value = "telium.toml", global = true)]
    config: PathBuf,
    /// Who is running this, for the commands that write a rotation record.
    ///
    /// Nothing checks it and nothing can: this is a process on a box, not a
    /// session. It is recorded as `asserted`, which the record and the
    /// listing both say out loud, and it exists for the deployment where the
    /// uid is worthless -- a shared bastion, `sudo -i`, a CI runner -- and the
    /// only thing anybody will be able to reconstruct in a year is which human
    /// believed they were doing it. Leave it off and the record falls back to
    /// the uid and login name the kernel reports, which is a weaker claim
    /// about *who* and a stronger one about *what the machine saw*; both are
    /// written either way, and the difference is only which one the summary
    /// line rests on. See docs/runbooks/rotating-a-secret.md.
    #[arg(long, global = true)]
    operator: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server (default).
    Serve,
    /// Write a starter config to the config path.
    Init,
    /// Audit the configuration for settings that would expose a production
    /// server, and exit non-zero if any are found.
    ///
    /// Safe to run against a live server: it opens no database, binds no port
    /// and writes nothing. That is what makes it usable as an `ExecStartPre=`
    /// in a unit file and as a step in a deployment pipeline -- the two places
    /// where finding out costs nothing and not finding out costs an incident.
    Check {
        /// Fail on warnings too, not only on dangers. For a pipeline that has
        /// decided its deployments should be clean rather than merely safe.
        #[arg(long)]
        strict: bool,
    },
    /// Backups: take one, make a key, list what exists, verify an archive.
    ///
    /// With no subcommand this takes one backup now, as it always has.
    Backup {
        #[command(subcommand)]
        command: Option<BackupCommand>,
    },
    /// Restore a backup archive over this server's database, media and cold
    /// storage. The server must be stopped. See docs/backup.md.
    Restore {
        /// A `.tbk` path, `latest` (newest local archive), `s3://latest`
        /// (newest in the bucket) or `s3://<key>`.
        source: String,
        /// Replace existing data. What is there is moved aside, not deleted.
        #[arg(long)]
        yes: bool,
        /// Key file to use instead of the configured one.
        #[arg(long)]
        key: Option<PathBuf>,
    },
    /// The server's federation signing keys: show them, roll them, forget the
    /// private half of the ones that have expired.
    ///
    /// With no subcommand this prints them, as it always has.
    Keys {
        #[command(subcommand)]
        command: Option<KeysCommand>,
    },
    /// Second factors: the key they are sealed under, and the forced
    /// re-enrolment that is the only rotation a TOTP secret has.
    ///
    /// Every subcommand here runs against the database directly, and none of
    /// them needs the MFA key to be openable -- which is the point. The day
    /// these matter is the day the key is wrong, and a tool that needed the
    /// key to fix the key would be no tool at all.
    Mfa {
        #[command(subcommand)]
        command: MfaCommand,
    },
    /// When a long-lived secret was last replaced, and on whose word.
    ///
    /// This is the answer to "when did we last rotate this", which before the
    /// record existed lived in somebody's shell history and their notes. Read
    /// the `basis` column, not just the name: see docs/secrets.md.
    Rotations {
        /// Narrow to one secret, by any fragment of its inventory heading:
        /// `backup`, `mfa`, `federation`.
        entry: Option<String>,
        /// How many rows. The default is a screenful.
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Server-administrator ownership (docs/server-ownership.md).
    ///
    /// These run against the database directly, for the same reason the standby
    /// commands do and rather more urgently: the case they exist for is the one
    /// where nobody can sign in as an administrator, so an administrator API
    /// would be a locked door with the key inside it.
    #[command(subcommand)]
    Admin(AdminCommand),
    /// Warm-standby operations (Section 10).
    ///
    /// These run against the database directly rather than over the admin API,
    /// because the night they are needed is the night the other options are
    /// gone: no browser, maybe no session, possibly no primary. A shell on the
    /// box is the last thing an operator still has, so it has to be enough.
    /// Safe to run while the server is up -- it re-reads the rows these commands
    /// write, so nothing needs restarting.
    #[command(subcommand)]
    Standby(StandbyCommand),
    /// Print what this build is, as key=value lines.
    ///
    /// For the shell, and specifically for the on-box updater, which has to
    /// answer "what is running here" without a config file, without a database
    /// and without trusting anything but the binary it asks. Opens nothing,
    /// reads nothing, prints four lines.
    Version,
    /// Read the release manifest and say what this box should do about it.
    ///
    /// This is the parser half of `deploy/update-native.sh`, and it lives here
    /// rather than in the script for the same reason the script does not parse
    /// `telium.toml`: the manifest is untrusted input with rules about what may
    /// influence a decision, and those rules -- the size bounds, the shape
    /// checks, the sanitising of somebody else's text -- already exist in
    /// `src/updates.rs`, tested. A bash reimplementation would be a second
    /// opinion about hostile input, and the day the two disagree is the day
    /// one of them is wrong about a file that ends in a restart.
    ///
    /// So the binary fetches, verifies against the pinned publisher key when
    /// `updates.manifest_public_key` says to, parses, and decides; the script
    /// acts on the answer. Nothing here installs, restarts or writes anything:
    /// it is a question, and the script remains the only thing on the box
    /// allowed to act on it.
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
        /// The installable artifact to look for, named the way docs/updates.md
        /// names them. Defaults to this build's own architecture, so the
        /// updater script never has to know what CPU it is running on and a
        /// Raspberry Pi asks for `server-linux-aarch64` by the same
        /// do-nothing default that asks an x86_64 box for `x86_64`. A release
        /// that publishes no such artifact still answers -- `action=update`
        /// with no artifact lines -- because "there is a new release and it
        /// ships only as a container image" is a true and useful answer; the
        /// updater words it for the operator.
        #[arg(long, default_value_t = default_artifact())]
        artifact: String,
        /// Aim at this release instead of the channel's newest: a 40-hex
        /// commit, standing in for the pin in update.conf. The updater passes
        /// its pin through; nothing here reads that file, which keeps one
        /// parser per file format on this box.
        #[arg(long)]
        pin: Option<String>,
        /// Read the manifest from here instead of `updates.manifest_url`.
        #[arg(long)]
        manifest_url: Option<String>,
    },
}

#[derive(Subcommand)]
enum BackupCommand {
    /// Take one backup now: write the archive, upload it if a remote is
    /// configured, prune both. Exits non-zero if the upload failed.
    Now,
    /// Create the backup key file. Refuses to overwrite one.
    Keygen {
        /// Where to write it. Defaults to `backup.key_file`.
        ///
        /// A rotation needs to mint the incoming key *before* the config
        /// points at it -- the old key has to stay current until the new file
        /// exists, or a crash in between leaves a server configured for a key
        /// that was never written. Without this argument the operator has to
        /// edit the config, run keygen, and hope nothing restarts in the gap.
        path: Option<PathBuf>,
    },
    /// List local archives, and remote ones if a remote is configured.
    List,
    /// Decrypt and authenticate every byte of an archive without restoring it.
    Verify {
        /// Same forms as `restore`: a path, `latest`, `s3://latest`, `s3://<key>`.
        source: String,
        #[arg(long)]
        key: Option<PathBuf>,
    },
    /// Rehearse a recovery: fetch the newest archive -- from the bucket when
    /// one is configured, because that is the copy that will still exist --
    /// decrypt it, unpack the database, open it with SQLite and check that it
    /// still carries this server's identity and its accounts.
    ///
    /// Non-destructive: nothing outside a scratch directory is touched and the
    /// scratch directory is deleted either way. Exits non-zero when the drill
    /// fails, so a cron entry that runs it says so by mail.
    Drill,
}

#[derive(Subcommand)]
enum KeysCommand {
    /// Print the published keys.
    List,
    /// Mint a new signing key. The server signs with it from its next start;
    /// the old key stays published so signatures already in flight still verify.
    Rotate {
        /// Cut the old key off now instead of letting it age out. Use this, and
        /// only this, when you believe somebody else has a copy of it: it
        /// invalidates every in-flight assertion signed under the old key at
        /// the same instant.
        #[arg(long)]
        compromised: bool,
    },
    /// Overwrite the private half of every key whose window has closed.
    ///
    /// Expired keys are still needed -- their public half verifies records
    /// signed years ago -- but their secret half has no remaining use, and
    /// keeping it means a stolen database copy hands over every key this server
    /// has ever signed with, not just the current one.
    ForgetExpired,
}

#[derive(Subcommand)]
enum MfaCommand {
    /// How many accounts are enrolled, how many are sealed, and how many the
    /// current keyring cannot open.
    Status,
    /// Create the MFA key file. Refuses to overwrite one.
    Keygen {
        /// Where to write it. Defaults to `mfa.key_file`.
        path: Option<PathBuf>,
    },
    /// Re-seal every enrolled account under the current key, so a retired key
    /// can be dropped from `mfa.previous_key_files`.
    Rekey,
    /// Put every second factor back into the cleartext column, for a rollback
    /// to a build that predates sealing.
    ///
    /// This is the deploy escape hatch and nothing else. It undoes the whole
    /// protection: after it runs, a copy of the database is again a copy of
    /// every enrolled account's second factor, and it stays that way until a
    /// build that seals starts again.
    Unseal {
        /// Required, because the effect is to put every second factor on the
        /// server back in the clear.
        #[arg(long)]
        yes: bool,
    },
    /// Invalidate every enrolment on this server and require re-enrolment.
    ///
    /// The server's answer to "a TOTP secret cannot be rotated": it cannot,
    /// but this server can stop honouring the old ones. Every enrolment goes,
    /// every recovery code goes, every affected account with a verified
    /// recovery address is mailed, and the client asks them to enrol again at
    /// the next sign-in.
    ///
    /// Run this when the database has been disclosed and was written by a
    /// build that stored second factors in the clear, or when the MFA key is
    /// gone and you are not getting it back.
    ResetAll {
        /// What to tell the affected accounts, in your words. It goes into
        /// the mail and is deliberately not stored anywhere.
        #[arg(long)]
        reason: String,
        /// Required. This turns the second factor off for every account on
        /// the server.
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Subcommand)]
enum AdminCommand {
    /// Who administers this server, and whether they can actually sign in.
    List,
    /// Grant server-administrator access to an account, from this machine's
    /// filesystem, when nobody can grant it over the API.
    ///
    /// Read `docs/server-ownership.md` before using this. In short: it grants
    /// authority over the server to an account you name; it does NOT give you
    /// access to that account, reset any password, or create any session. If
    /// you have lost the credentials to your only administrator account, the
    /// way back is to register a second account through the ordinary signup and
    /// name that one here. Your old account stays locked.
    ///
    /// It is never silent. Every administrator is told by gateway event, push
    /// and email; the server logs it at ERROR on every boot until it settles;
    /// and it is written to the server audit log. If this server still has an
    /// administrator who can sign in, the grant waits out
    /// `ownership.recovery_delay_secs` first and any administrator can cancel
    /// it during the wait.
    Recover {
        /// The account to give administrator access to: a full `@name:domain`
        /// or just the localpart.
        account: String,
        /// Why. It goes verbatim into the alert every administrator receives,
        /// so write it for them rather than for yourself.
        #[arg(long)]
        reason: String,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
    /// Recovery claims that have neither landed nor been called off.
    Claims,
    /// Call off a pending recovery claim from the shell, when there is no
    /// administrator session to cancel it from.
    Cancel {
        /// The claim id, from `admin claims`.
        id: String,
    },
}

#[derive(Subcommand)]
enum StandbyCommand {
    /// Show what this server mirrors, how far behind it is, and who the
    /// authority is for each side of every pairing.
    Status,
    /// Authorise a standby for this server, signing the consent a promotion
    /// will later have to carry. Run this while both servers are healthy.
    Pair {
        /// The domain that may stand in for this one.
        standby: String,
    },
    /// Pull now instead of waiting for the next poll.
    Sync {
        /// Which mirror. Omit to sync all of them.
        origin: Option<String>,
    },
    /// Become the authority for a mirrored server.
    ///
    /// Do this only once a human has decided the primary is not coming back.
    /// Nothing here is automatic, on purpose: a standby that promoted itself
    /// whenever it lost contact would promote itself every time a link hiccuped.
    Promote {
        /// The domain this server is taking over for.
        origin: String,
        /// Skip the confirmation prompt.
        #[arg(long)]
        yes: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()))
        .init();

    if matches!(cli.command, Some(Command::Init)) {
        return init_config(&cli.config);
    }

    if matches!(cli.command, Some(Command::Version)) {
        return print_version();
    }

    let cfg = if cli.config.exists() {
        Config::load(&cli.config)?
    } else {
        tracing::warn!(target: telium_server::logcat::STARTUP, path = %cli.config.display(), "no config file; using defaults");
        let cfg = Config::default();
        cfg.validate()?;
        cfg
    };

    telium_server::secrets::check_at_startup(&cfg, Some(&cli.config))?;

    match cli.command {
        Some(Command::Check { strict }) => {
            let audit = telium_server::preflight::audit(
                &cfg,
                cli.config.exists().then_some(cli.config.as_path()),
            );
            print!("{}", telium_server::preflight::render(&audit));
            let fail = match audit.worst() {
                Some(telium_server::preflight::Level::Danger) => true,
                Some(telium_server::preflight::Level::Warn) => strict,
                _ => false,
            };
            std::process::exit(if fail { 1 } else { 0 });
        }
        Some(Command::Restore { source, yes, key }) => return restore(&cfg, &source, yes, key).await,
        Some(Command::Backup { command: Some(BackupCommand::Keygen { path }) }) => {
            let path = path.unwrap_or_else(|| cfg.backup.key_file.clone());
            backup::keygen(&path)?;
            println!("wrote {}", path.display());
            if path == cfg.backup.key_file {
                eprintln!(
                    "Every backup from now on is sealed under this key and cannot be read \
                     without it. Copy it somewhere that is not this machine."
                );
            } else {
                eprintln!(
                    "Nothing is sealed under this key yet. To start using it, set \
                     backup.key_file to {} and move the current backup.key_file into \
                     backup.previous_key_files so existing archives keep opening. Copy the new \
                     key somewhere that is not this machine first.",
                    path.display()
                );
            }
            return Ok(());
        }
        Some(Command::Mfa { command: MfaCommand::Keygen { path } }) => {
            let path = path.unwrap_or_else(|| cfg.mfa.key_file.clone());
            telium_server::mfa::keygen(&path)?;
            println!("wrote {}", path.display());
            if path == cfg.mfa.key_file {
                eprintln!(
                    "Every enrolled account's second factor will be sealed under this key. \
                     Back it up somewhere that is NOT the database backup: a copy of this key \
                     inside an archive that also contains the database protects nobody."
                );
            } else {
                eprintln!(
                    "Nothing is sealed under this key yet. To start using it, move the current \
                     mfa.key_file into mfa.previous_key_files, point mfa.key_file at {}, and \
                     restart -- sign-ins keep working, because the old key is still in the \
                     ring. Then `telium-server mfa rekey` re-seals everything under the new \
                     key and the old entry can be dropped.",
                    path.display()
                );
            }
            return Ok(());
        }
        Some(Command::Backup { command: Some(BackupCommand::List) }) => return backup_list(&cfg).await,
        Some(Command::Backup { command: Some(BackupCommand::Verify { source, key }) }) => {
            return backup_verify(&cfg, &source, key).await
        }
        Some(Command::Updates(UpdatesCommand::Check { artifact, pin, manifest_url })) => {
            return updates_check(&cfg.updates, cfg.federation.allow_http, artifact, pin, manifest_url)
                .await
        }
        _ => {}
    }

    let config_path = cli.config.exists().then(|| cli.config.clone());
    let operator = cli.operator.clone();

    if matches!(cli.command, None | Some(Command::Serve)) {
        backup::before_migrations(&cfg).await?;
    }

    let role = if matches!(cli.command, None | Some(Command::Serve)) {
        Role::Serve
    } else {
        Role::Tool
    };
    let state = build_state_as(cfg, role).await?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Init | Command::Restore { .. } | Command::Check { .. } => unreachable!(),
        Command::Version | Command::Updates(_) => unreachable!(),
        Command::Backup { command: Some(BackupCommand::Drill) } => backup_drill(&state).await,
        Command::Backup { .. } => {
            if backup::load_key(&state.cfg)?.is_none() {
                backup::load_or_create_key(&state.cfg)?;
            }
            let outcome = backup::run_once(&state.pool, &state.cfg).await?;
            println!("{}", outcome.path.display());
            print_manifest(&outcome.manifest);
            if let Some(key) = &outcome.remote_key {
                println!("uploaded:  s3://{}/{key}", state.cfg.backup.remote.bucket);
            }
            if let Some(err) = &outcome.remote_error {
                anyhow::bail!("the archive was written but the upload failed: {err}");
            }
            Ok(())
        }
        Command::Keys { command } => {
            keys(state, command.unwrap_or(KeysCommand::List), operator.as_deref()).await
        }
        Command::Mfa { command } => mfa_command(state, command, operator.as_deref()).await,
        Command::Rotations { entry, limit } => rotations(state, entry.as_deref(), limit).await,
        Command::Admin(cmd) => admin(state, cmd).await,
        Command::Standby(cmd) => standby(state, cmd).await,
        Command::Serve => serve(state, config_path).await,
    }
}

fn print_version() -> anyhow::Result<()> {
    let b = telium_server::updates::build();
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
    format!("server-linux-{}", std::env::consts::ARCH)
}

async fn updates_check(
    updates: &telium_server::config::Updates,
    allow_http: bool,
    artifact: String,
    pin: Option<String>,
    manifest_url: Option<String>,
) -> anyhow::Result<()> {
    let mut updates = updates.clone();
    if let Some(url) = manifest_url {
        updates.manifest_url = url;
    }
    let manifest = telium_server::updates::read_manifest(&updates, allow_http)
        .await
        .map_err(|(kind, e)| anyhow::anyhow!("{}: {e}", kind.as_str()))?;
    let plan = telium_server::updates::plan(
        telium_server::updates::build().commit,
        &manifest,
        pin.as_deref(),
        &artifact,
    );

    println!("ours={}", plan.ours);
    println!(
        "action={}",
        match plan.action {
            telium_server::updates::PlanAction::Current => "current",
            telium_server::updates::PlanAction::Update => "update",
            telium_server::updates::PlanAction::UnidentifiedBuild => "unidentified_build",
            telium_server::updates::PlanAction::NotPublished => "not_published",
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
    if plan.action == telium_server::updates::PlanAction::Update {
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

async fn keys(
    state: telium_server::AppState,
    cmd: KeysCommand,
    operator: Option<&str>,
) -> anyhow::Result<()> {
    use telium_server::crypto;
    match cmd {
        KeysCommand::List => {
            for (key_id, public_b64, from, until) in crypto::published_keys(&state.pool).await? {
                let current = if key_id == state.key.key_id { " (signing)" } else { "" };
                println!("{key_id}\t{public_b64}\tvalid {from}..{until}{current}");
            }
            Ok(())
        }
        KeysCommand::Rotate { compromised } => {
            let validity = state.cfg.sessions.signing_key_validity_secs;
            let (new_key, retired) = crypto::rotate_key(&state.pool, validity, compromised).await?;

            let actor = telium_server::rotations::Actor::local(operator);
            telium_server::rotations::record(
                &state.pool,
                telium_server::secrets::by_heading("Federation signing key")
                    .expect("the federation signing key is in the inventory"),
                &actor,
                telium_server::rotations::Detail {
                    change: "minted",
                    note: "telium-server keys rotate. The new key signs from the server's next \
                           start; the old one stays published until its window closes unless \
                           --compromised cut it off here",
                    public_key_id: Some(new_key.clone()),
                    retired_public_key_id: retired.clone(),
                    compromised: Some(compromised),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "the key WAS rotated and the rotation record could not be written: {e}. \
                     The new key is live; write this rotation down by hand and find out why \
                     the database refused the row before the next one."
                )
            })?;

            println!("new key:   {new_key}");
            match retired {
                Some(old) => println!("retired:   {old} (no longer published; signatures under it are refused now)"),
                None => println!("retired:   nothing -- the previous key stays published until its window closes"),
            }
            eprintln!(
                "\nRestart {} to begin signing with the new key. Both keys are published in the \
                 meantime, so peers accept either and nothing has to happen in a particular order.",
                state.cfg.server_name
            );
            if compromised {
                eprintln!(
                    "You rotated a key you believe was copied. The database also holds this \
                     server's push identity, its OPAQUE server setup and every account's \
                     second-factor secret, all in cleartext -- if the database was copied, read \
                     docs/secrets.md and work through the rest of them."
                );
            }
            Ok(())
        }
        KeysCommand::ForgetExpired => {
            let forgotten = crypto::forget_expired_secrets(&state.pool).await?;
            println!("forgot the private half of {forgotten} expired key(s)");
            Ok(())
        }
    }
}

async fn mfa_command(
    state: telium_server::AppState,
    cmd: MfaCommand,
    operator: Option<&str>,
) -> anyhow::Result<()> {
    use telium_server::mfa;
    match cmd {
        MfaCommand::Keygen { .. } => unreachable!(),
        MfaCommand::Status => {
            let enrolled: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE mfa_enabled = 1")
                    .fetch_one(&state.pool)
                    .await?;
            let sealed = mfa::sealed_count(&state.pool).await?;
            let cleartext: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE mfa_secret IS NOT NULL")
                    .fetch_one(&state.pool)
                    .await?;
            let stuck = mfa::unopenable_count(&state.pool, &state.mfa).await?;
            let waiting: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM accounts WHERE mfa_reenrol_required = 1")
                    .fetch_one(&state.pool)
                    .await?;
            println!("key file:      {}", state.cfg.mfa.key_file.display());
            println!(
                "keys loaded:   {} current, {} retired",
                usize::from(state.mfa.current.is_some()),
                state.mfa.retired.len()
            );
            println!("enabled:       {enrolled}");
            println!("sealed:        {sealed}");
            println!("cleartext:     {cleartext}");
            println!("unopenable:    {stuck}");
            println!("awaiting re-enrolment: {waiting}");
            if stuck > 0 {
                eprintln!(
                    "\n{stuck} account(s) are sealed under a key this server does not have. If a \
                     rotation is half done, put the old key file in mfa.previous_key_files. If \
                     the key is gone, those accounts can still sign in with an unused recovery \
                     code, and `telium-server mfa reset-all` is the way back for the rest."
                );
            }
            Ok(())
        }
        MfaCommand::Rekey => {
            let (done, stuck) = mfa::rekey(&state.pool, &state.mfa).await?;
            println!("re-sealed: {done}");
            if stuck > 0 {
                eprintln!(
                    "{stuck} account(s) could not be re-sealed: no key in the ring opens them. \
                     Do NOT drop anything from mfa.previous_key_files until this reads 0."
                );
            } else {
                println!(
                    "Everything is sealed under the current key. mfa.previous_key_files can now \
                     be emptied, and the retired key files deleted."
                );
            }
            let actor = telium_server::rotations::Actor::local(operator);
            telium_server::rotations::record(
                &state.pool,
                telium_server::secrets::by_heading("MFA encryption key")
                    .expect("the MFA encryption key is in the inventory"),
                &actor,
                telium_server::rotations::Detail {
                    change: "re-sealed",
                    note: "telium-server mfa rekey. Every second factor the ring could open was \
                           re-sealed under the current key; a retired key can be dropped once \
                           nothing is left behind",
                    affected: Some(done as i64),
                    ..Default::default()
                },
            )
            .await?;
            Ok(())
        }
        MfaCommand::Unseal { yes } => {
            if !yes {
                anyhow::bail!(
                    "this puts every second factor on the server back into the database in the \
                     clear, where a copy of the database is a copy of all of them. It exists \
                     for a rollback to a build that predates sealing. Pass --yes if that is \
                     what you are doing."
                );
            }
            let (done, stuck) = mfa::unseal_all(&state.pool, &state.mfa).await?;
            println!("unsealed: {done}");
            if stuck > 0 {
                eprintln!(
                    "{stuck} account(s) could not be unsealed and were left exactly as they \
                     are: no key in the ring opens them, and clearing them would have destroyed \
                     the one copy the right key file would still open."
                );
            }
            eprintln!(
                "Every second factor is now in the clear in accounts.mfa_secret. The next start \
                 of a build that seals will put them back."
            );
            Ok(())
        }
        MfaCommand::ResetAll { reason, yes } => {
            if !yes {
                anyhow::bail!(
                    "this turns the second factor off for every account on the server and \
                     destroys every recovery code. Pass --yes once you mean it."
                );
            }
            let reset = mfa::reset_all(&state.pool, &reason).await?;
            println!("enrolments invalidated: {}", reset.accounts.len());
            println!(
                "recovery codes destroyed: {}",
                reset.recovery_codes_destroyed
            );

            let mut mailed = 0;
            let mut unreachable = 0;
            if telium_server::mail::configured(&state) {
                for user_id in &reset.accounts {
                    let address =
                        match telium_server::mail::verified_recovery_address(&state, user_id).await
                        {
                            Ok(Some(address)) => address,
                            Ok(None) => {
                                unreachable += 1;
                                continue;
                            }
                            Err(e) => {
                                eprintln!("could not look up a recovery address: {e}");
                                unreachable += 1;
                                continue;
                            }
                        };
                    let subject = format!(
                        "Two-factor authentication on {} needs setting up again",
                        state.cfg.server_name
                    );
                    let text = format!(
                        "The two-factor authentication on your account at {} has been turned \
                         off by the server operator and must be set up again the next time you \
                         sign in. Your existing authenticator entry and your recovery codes no \
                         longer work and can be deleted.\n\n\
                         Reason given by the operator:\n\n{reason}\n\n\
                         Your password has not changed. If you did not expect this, contact \
                         the operator of {} before signing in.",
                        state.cfg.server_name, state.cfg.server_name
                    );
                    match telium_server::mail::send_notice(
                        &state, &address, user_id, &subject, &text,
                    )
                    .await
                    {
                        Ok(Ok(())) => mailed += 1,
                        Ok(Err(refused)) => {
                            unreachable += 1;
                            eprintln!("not mailed ({refused:?})");
                        }
                        Err(e) => {
                            unreachable += 1;
                            eprintln!("not mailed: {e}");
                        }
                    }
                }
            } else {
                unreachable = reset.accounts.len();
            }
            println!("mailed: {mailed}");
            println!("no verified address (not told by mail): {unreachable}");

            if !reset.accounts.is_empty() {
                telium_server::mfa::record_reset(
                    &state.pool,
                    &telium_server::rotations::Actor::local(operator),
                    reset.accounts.len() as i64,
                )
                .await?;
            }
            Ok(())
        }
    }
}

async fn rotations(
    state: telium_server::AppState,
    entry: Option<&str>,
    limit: i64,
) -> anyhow::Result<()> {
    let rows = telium_server::rotations::recent(&state.pool, entry, limit.max(1)).await?;
    if rows.is_empty() {
        match entry {
            Some(fragment) => println!("No rotation of anything matching \"{fragment}\" is recorded."),
            None => println!("No rotation is recorded on this server."),
        }
        println!(
            "That means nothing was written down here -- not that nothing was rotated. \
             Rotations performed before migration 0072 landed, and any performed by editing \
             files while the server was stopped and never restarted, leave no row. See \
             docs/secrets.md."
        );
        return Ok(());
    }
    for r in rows {
        let when = backup::human_time(r.at);
        println!("{when}  {}", r.entry);
        println!("  by {} -- {}", r.actor, r.basis.caveat());
        if let Some(change) = r.detail.get("change").and_then(|v| v.as_str()) {
            let note = r.detail.get("note").and_then(|v| v.as_str()).unwrap_or("");
            println!("  {change}: {note}");
        }
        for key in ["public_key_id", "retired_public_key_id", "path", "affected", "compromised"] {
            if let Some(v) = r.detail.get(key) {
                println!("  {key}: {v}");
            }
        }
        println!();
    }
    Ok(())
}

async fn admin(state: telium_server::AppState, cmd: AdminCommand) -> anyhow::Result<()> {
    use telium_server::{admin, ownership};

    match cmd {
        AdminCommand::List => {
            let roster = ownership::roster(&state).await?;
            if roster.is_empty() {
                println!("This server has no administrator account at all.");
                println!(
                    "Register an account through the ordinary signup, then run:\n  \
                     telium-server admin recover <account> --reason \"...\""
                );
                return Ok(());
            }
            let usable = roster.iter().filter(|a| a.usable).count();
            for a in &roster {
                let standing = if a.usable {
                    if a.dormant {
                        "usable, but not seen in over 90 days".to_string()
                    } else {
                        "usable".to_string()
                    }
                } else {
                    format!("UNUSABLE -- {}", a.unusable_because)
                };
                println!("{:<40} {standing}", a.user_id);
                println!(
                    "  {} active device(s), {} live session(s){}",
                    a.active_devices,
                    a.live_sessions,
                    match a.admin_granted_by.as_deref() {
                        Some(by) => format!(", granted by {by}"),
                        None => String::new(),
                    }
                );
            }
            println!("\n{usable} of {} can actually sign in.", roster.len());
            if usable == 0 {
                println!(
                    "\nNobody can administer this server. `telium-server admin recover` is the \
                     way back; read docs/server-ownership.md first."
                );
            } else if usable == 1 {
                println!(
                    "\nOnly one account can administer this server. If it is lost, recovery means \
                     a shell on this machine. Grant a second administrator while you still can."
                );
            }
            Ok(())
        }

        AdminCommand::Recover { account, reason, yes } => {
            let subject = if account.starts_with('@') {
                account.clone()
            } else {
                format!("@{account}:{}", state.cfg.server_name)
            };
            let usable = ownership::usable_admin_count(&state.pool).await?;
            let delay = state.cfg.ownership.recovery_delay_secs;

            if !yes {
                eprintln!(
                    "This asks for server-administrator access to be granted to {subject}.\n\n\
                     It does NOT give you access to {subject}, or to any other account. It does \
                     not reset a password and does not create a session. You will still have to \
                     sign in as {subject} with that account's own credentials afterwards.\n"
                );
                if usable == 0 {
                    eprintln!(
                        "This server currently has no administrator who can sign in, so the grant \
                         takes effect immediately.\n"
                    );
                } else {
                    eprintln!(
                        "This server still has {usable} administrator(s) who can sign in. They \
                         will all be told about this now -- by notification and by email -- and \
                         any of them can cancel it. If nobody does, the grant lands in {} hours.\n",
                        delay / 3600
                    );
                }
                eprintln!("Either way it is written to the server audit log and cannot be taken back quietly.");
                eprint!("\nType the account to confirm: ");
                use std::io::Write as _;
                std::io::stderr().flush()?;
                let mut typed = String::new();
                std::io::stdin().read_line(&mut typed)?;
                if typed.trim() != subject && typed.trim() != account {
                    anyhow::bail!("not confirmed");
                }
            }

            let database = telium_server::secrets::database_path(&state.cfg.database_url)
                .and_then(|p| std::fs::canonicalize(&p).ok().or(Some(p)));
            let (database_mode, directory_mode) = database
                .as_deref()
                .map(ownership::host_modes)
                .unwrap_or((None, None));
            let evidence = ownership::HostEvidence {
                database: database
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| state.cfg.database_url.clone()),
                config: std::env::args()
                    .collect::<Vec<_>>()
                    .join(" "),
                uid: current_uid(),
                hostname: std::env::var("HOSTNAME").ok(),
                database_mode,
                directory_mode,
            };
            let (id, effective_at, usable_then) =
                ownership::open_claim(&state.pool, &subject, &reason, &evidence, delay).await?;

            println!("claim:     {id}");
            println!("subject:   {subject}");
            if usable_then == 0 {
                println!("effective: immediately -- this server had no administrator who could sign in");
                println!(
                    "\nStart the server if it is stopped. The grant lands within a minute of it \
                     coming up, and every administrator is told."
                );
            } else {
                println!("effective: {}", telium_server::backup::human_time(effective_at));
                println!(
                    "\nEvery administrator is being told now, and any of them can cancel it \
                     before then with `telium-server admin cancel {id}` or from the console."
                );
            }
            Ok(())
        }

        AdminCommand::Claims => {
            let claims = ownership::pending_claims(&state).await?;
            if claims.is_empty() {
                println!("no pending recovery claims");
                return Ok(());
            }
            for c in &claims {
                println!("{}", c["id"].as_str().unwrap_or_default());
                println!("  subject:   {}", c["subject"].as_str().unwrap_or_default());
                println!("  reason:    {}", c["reason"].as_str().unwrap_or_default());
                println!(
                    "  effective: {}",
                    telium_server::backup::human_time(c["effective_at"].as_i64().unwrap_or(0))
                );
                println!(
                    "  announced: {}",
                    match c["announced_at"].as_i64() {
                        Some(at) => telium_server::backup::human_time(at),
                        None => "not yet -- the server has not been up to raise the alarm".into(),
                    }
                );
            }
            Ok(())
        }

        AdminCommand::Cancel { id } => {
            let done = sqlx::query(
                "UPDATE admin_recovery_claims SET cancelled_at = ?, cancelled_by = 'filesystem' \
                 WHERE id = ? AND applied_at IS NULL AND cancelled_at IS NULL",
            )
            .bind(now_secs() * 1000)
            .bind(&id)
            .execute(&state.pool)
            .await?;
            if done.rows_affected() == 0 {
                anyhow::bail!("no pending claim with that id (it may already have landed)");
            }
            admin::record_to_pool(
                &state.pool,
                "filesystem",
                "ownership.recovery.cancel",
                Some(&id),
                serde_json::json!({ "from": "cli" }),
            )
            .await?;
            println!("cancelled {id}");
            Ok(())
        }
    }
}

fn current_uid() -> Option<u32> {
    std::env::var("UID").ok().and_then(|v| v.parse().ok())
}

async fn standby(state: telium_server::AppState, cmd: StandbyCommand) -> anyhow::Result<()> {
    use telium_server::{promotion, replicate};

    match cmd {
        StandbyCommand::Status => {
            println!("server:    {}", state.cfg.server_name);
            match promotion::authority(&state).await? {
                Some(a) => println!(
                    "authority: {} (superseded at sequence {}) -- this server is read-only",
                    a.domain, a.sequence
                ),
                None => println!("authority: {} (this server)", state.cfg.server_name),
            }
            let standbys = &state.cfg.failover.standbys;
            println!(
                "standbys:  {}",
                if standbys.is_empty() { "none".into() } else { standbys.join(", ") }
            );

            let replicas = replicate::open_replicas(&state).await?;
            if replicas.is_empty() {
                println!("mirrors:   none");
                return Ok(());
            }
            println!("mirrors:");
            for replica in &replicas {
                let (cursor, applied_at, promoted): (i64, i64, i64) = sqlx::query_as(
                    "SELECT cursor, applied_at, promoted FROM replica_state WHERE origin = ?",
                )
                .bind(&replica.origin)
                .fetch_one(&state.pool)
                .await?;
                let state_word = if promoted != 0 {
                    "promoted -- this server is the authority for it".to_string()
                } else if applied_at == 0 {
                    "never synced".to_string()
                } else {
                    format!("{}s behind", (now_secs() - applied_at / 1000).max(0))
                };
                println!("  {} at entry {cursor}: {state_word}", replica.origin);
            }
            Ok(())
        }

        StandbyCommand::Pair { standby } => {
            if standby == state.cfg.server_name {
                anyhow::bail!("a server cannot stand behind itself");
            }
            if !state.cfg.failover.standbys.iter().any(|s| s == &standby) {
                eprintln!(
                    "warning: {standby} is not in failover.standbys, so it cannot pull this \
                     server's log yet. Add it and restart."
                );
            }
            let authorization =
                promotion::authorise(&state, promotion::SUBJECT, &state.cfg.server_name, &standby)
                    .await?;
            println!("{}", serde_json::to_string_pretty(&authorization)?);
            eprintln!(
                "\n{standby} may now be promoted in place of {}. It has to hold a copy first: \
                 add {} to that server's failover.replicate.",
                state.cfg.server_name, state.cfg.server_name
            );
            Ok(())
        }

        StandbyCommand::Sync { origin } => {
            let replicas = replicate::open_replicas(&state).await?;
            let wanted: Vec<_> = match &origin {
                Some(o) => replicas.iter().filter(|r| &r.origin == o).collect(),
                None => replicas.iter().collect(),
            };
            if wanted.is_empty() {
                anyhow::bail!(
                    "this server holds no copy of {}",
                    origin.unwrap_or_else(|| "anything".into())
                );
            }
            for replica in wanted {
                let applied = replicate::sync_once(&state, replica).await?;
                println!("{}: {applied} entries applied", replica.origin);
            }
            Ok(())
        }

        StandbyCommand::Promote { origin, yes } => {
            let replicas = replicate::open_replicas(&state).await?;
            let replica = replicas
                .iter()
                .find(|r| r.origin == origin)
                .ok_or_else(|| anyhow::anyhow!("this server holds no copy of {origin}"))?;
            if !yes {
                eprintln!(
                    "This makes {} the authority for {origin}. {origin} will demote itself \
                     when it returns, and coming back is a manual re-pairing.",
                    state.cfg.server_name
                );
                eprint!("Type the domain to confirm: ");
                use std::io::Write as _;
                std::io::stderr().flush().ok();
                let mut line = String::new();
                std::io::stdin().read_line(&mut line)?;
                if line.trim() != origin {
                    anyhow::bail!("not confirmed; nothing changed");
                }
            }
            let record = promotion::promote(&state, replica).await?;
            println!("{}", serde_json::to_string_pretty(&record)?);
            eprintln!(
                "\n{} is the authority for {origin}. Point {origin}'s DNS or your clients here; \
                 clients already failed over will notice on their own.",
                state.cfg.server_name
            );
            Ok(())
        }
    }
}

fn print_manifest(m: &backup::format::Manifest) {
    println!("server:    {}", m.server_name);
    println!("taken:     {}", backup::human_time(m.created_at));
    println!("schema:    migration {} (telium-server {})", m.schema_version, m.telium_version);
    for p in &m.parts {
        println!("  {:<9} {} file(s), {}", p.kind, p.files, backup::human_bytes(p.bytes));
    }
    for e in &m.excluded {
        println!("  {:<9} NOT IN THIS ARCHIVE -- {}", e.kind, backup::excluded_sentence(e));
    }
}

fn keyring_from(cfg: &Config, key: Option<PathBuf>) -> anyhow::Result<backup::Keyring> {
    match key {
        Some(path) => {
            let key = backup::read_key_file(&path)?
                .ok_or_else(|| anyhow::anyhow!("{} does not exist", path.display()))?;
            Ok(backup::Keyring { current: Some(key), retired: Vec::new() })
        }
        None => {
            let ring = backup::load_keyring(cfg)?;
            if ring.is_empty() {
                anyhow::bail!(
                    "no backup key at {} and TELIUM_BACKUP_KEY is not set. Restoring needs the \
                     key the archive was sealed under: copy it back to this machine, or pass \
                     --key.",
                    cfg.backup.key_file.display()
                );
            }
            Ok(ring)
        }
    }
}

async fn backup_list(cfg: &Config) -> anyhow::Result<()> {
    let ring = backup::load_keyring(cfg)?;
    let local = backup::local_archives(&cfg.backup.dir);
    println!("local ({}):", cfg.backup.dir.display());
    if local.is_empty() {
        println!("  none");
    }
    for (path, stamp) in local.iter().rev() {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let detail = if ring.is_empty() {
            "no key available to read the manifest".to_string()
        } else {
            match ring.open(path).and_then(|k| backup::peek(path, &k)) {
                Ok(m) => format!(
                    "schema {}, {}",
                    m.schema_version,
                    m.parts.iter().map(|p| format!("{} {}", p.kind, backup::human_bytes(p.bytes))).collect::<Vec<_>>().join(", ")
                ),
                Err(e) => format!("cannot read manifest: {e}"),
            }
        };
        println!(
            "  {:<32} {:>10}  {}  {detail}",
            path.file_name().unwrap_or_default().to_string_lossy(),
            backup::human_bytes(size),
            backup::human_time(*stamp)
        );
    }
    match backup::remote(cfg)? {
        None => println!("remote:    not configured"),
        Some(client) => {
            let prefix = cfg.backup.remote.prefix_for(&cfg.server_name);
            println!("remote (s3://{}/{prefix}):", cfg.backup.remote.bucket);
            let objects = backup::remote_archives(&client, &prefix).await?;
            if objects.is_empty() {
                println!("  none");
            }
            for (object, stamp) in objects.iter().rev() {
                println!(
                    "  {:<32} {:>10}  {}",
                    object.key.strip_prefix(&prefix).unwrap_or(&object.key),
                    backup::human_bytes(object.size),
                    backup::human_time(*stamp)
                );
            }
        }
    }
    let status = backup::read_status(&cfg.backup.dir);
    print_drill(cfg, &status);
    if let Some(err) = status.last_error {
        println!("last error: {err}");
    }
    Ok(())
}

fn print_drill(cfg: &Config, status: &backup::Status) {
    use telium_server::backup::drill;

    let verdict = drill::verdict(cfg, status.last_drill.as_ref());
    match status.last_drill.as_ref() {
        None => println!("drill:     never run — nothing has confirmed these archives can be restored"),
        Some(d) => {
            println!(
                "drill:     {} — {} archive, {}, {:.1}s",
                verdict.as_str(),
                d.source,
                backup::human_time(d.at),
                d.took_ms as f64 / 1000.0
            );
            if let Some(err) = &d.error {
                println!("           {err}");
            }
            for warning in &d.warnings {
                println!("           warning: {warning}");
            }
        }
    }
}

async fn backup_drill(state: &telium_server::AppState) -> anyhow::Result<()> {
    use telium_server::backup::drill;

    let cfg = &state.cfg;
    if !cfg.backup.drill {
        eprintln!(
            "note: backup.drill is off, so nothing drills on a schedule here. This run still \
             happens and is still recorded."
        );
    }
    let result = drill::run(cfg, Some(&state.pool)).await;

    println!("drill:     {}", if result.ok { "PASSED" } else { "FAILED" });
    println!("source:    {} ({})", result.source, if result.archive.is_empty() { "-" } else { &result.archive });
    if let Some(at) = result.archive_created_at {
        println!("archive:   taken {}", backup::human_time(at));
    }
    println!("took:      {:.1}s", result.took_ms as f64 / 1000.0);
    if let Some(v) = &result.verified {
        println!(
            "database:  {}, integrity {}, schema {} (this binary knows {})",
            backup::human_bytes(v.database_bytes),
            if v.integrity { "ok" } else { "FAILED" },
            v.schema_version,
            v.binary_schema_version
        );
        println!(
            "identity:  {} signing key(s), {} push key(s), {}",
            v.signing_keys,
            v.push_keys,
            match v.auth_secrets {
                Some(n) => format!("{n} OPAQUE setup row(s)"),
                None => "no OPAQUE table in this archive".into(),
            }
        );
        println!(
            "contents:  {} account(s), {} device(s), {} guild(s), {} message(s)",
            v.accounts, v.devices, v.guilds, v.messages
        );
        for part in &v.parts {
            println!("  {:<9} {} file(s), {}", part.kind, part.files_seen, backup::human_bytes(part.bytes));
        }
    }
    for warning in &result.warnings {
        eprintln!("warning:   {warning}");
    }
    if result.ok {
        return Ok(());
    }
    if let Some(failure) = result.failure {
        eprintln!("\n{}", failure.advice());
    }
    anyhow::bail!(
        "the restore drill failed: {}",
        result.error.as_deref().unwrap_or("no reason recorded")
    );
}

async fn backup_verify(cfg: &Config, source: &str, key: Option<PathBuf>) -> anyhow::Result<()> {
    let ring = keyring_from(cfg, key)?;
    let fetched = backup::fetch(cfg, &backup::Source::parse(source)).await?;
    let key = ring.open(&fetched.path)?;
    let path = fetched.path.clone();
    let manifest = tokio::task::spawn_blocking(move || backup::verify(&path, &key)).await??;
    println!("ok:        {}", fetched.label);
    print_manifest(&manifest);
    Ok(())
}

async fn restore(cfg: &Config, source: &str, yes: bool, key: Option<PathBuf>) -> anyhow::Result<()> {
    let ring = keyring_from(cfg, key)?;
    let restored = backup::restore(cfg, &backup::Source::parse(source), &ring, yes).await?;
    println!("restored:  {}", restored.source);
    print_manifest(&restored.manifest);
    println!("database:  {}", restored.db_path.display());
    match &restored.media_dir {
        Some(d) => println!("media:     {}", d.display()),
        None => println!("media:     not in this archive; left as it was"),
    }
    match &restored.cold_dir {
        Some(d) => println!("cold:      {}", d.display()),
        None => println!("cold:      not in this archive; left as it was"),
    }
    for parked in &restored.moved_aside {
        println!("moved aside: {}", parked.display());
    }
    if !restored.moved_aside.is_empty() {
        eprintln!("The previous data was moved aside, not deleted. Remove it once the restored server checks out.");
    }
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn serve(state: telium_server::AppState, config_path: Option<PathBuf>) -> anyhow::Result<()> {
    telium_server::updates::log_build();
    telium_server::preflight::log(&telium_server::preflight::audit(&state.cfg, config_path.as_deref()));

    telium_server::mfa::refuse_if_locked_out(&state.pool, &state.cfg, &state.mfa).await?;

    match telium_server::rotations::witness_key_files(&state.pool, &state.cfg).await {
        Ok(changes) => {
            for change in changes {
                tracing::warn!(
                    target: telium_server::logcat::STARTUP,
                    %change,
                    "a key file changed since this server last started; recorded in the \
                     rotation record (telium-server rotations)"
                );
            }
        }
        Err(e) => tracing::error!(
            target: telium_server::logcat::STARTUP,
            error = %e,
            "could not compare the key files against the last start; a key file rotation \
             between now and the previous boot will not have been recorded"
        ),
    }

    telium_server::updates::spawn(state.clone());
    telium_server::usage::spawn(state.clone());
    telium_server::gateway::spawn_presence_flusher(state.clone());
    telium_server::routes::voice::spawn_reclaim_sweeper(state.clone());
    telium_server::federation::spawn_maintenance(state.clone());
    backup::spawn(state.pool.clone(), state.cfg.clone());
    backup::drill::spawn(state.pool.clone(), state.cfg.clone());
    telium_server::metrics::spawn(state.clone());
    telium_server::ownership::spawn(state.clone());

    let replicas = telium_server::replicate::open_replicas(&state).await?;
    if !replicas.is_empty() {
        tracing::info!(
            target: telium_server::logcat::STANDBY,
            mirrors = replicas.len(),
            "warm standby: serving read-only copies at /_telium/standby/{{origin}}"
        );
    }
    telium_server::replicate::spawn(state.clone(), replicas.clone());
    let promoted = telium_server::replicate::activate_promoted(&state, &replicas).await?;
    if promoted > 0 {
        tracing::warn!(target: telium_server::logcat::STANDBY, promoted, "restored promoted standby authorities");
    }

    telium_server::promotion::load(&state).await?;
    if let Err(e) = telium_server::promotion::check(&state).await {
        tracing::warn!(target: telium_server::logcat::STANDBY, error = %e, "could not confirm this server is still the authority");
    }
    telium_server::promotion::spawn(state.clone());

    if !state.demoted.load(std::sync::atomic::Ordering::Relaxed) {
        routes::push::spawn_notification_outbox(state.clone());
    }

    let bind = state.cfg.bind.clone();
    let server_name = state.cfg.server_name.clone();
    let roles = state.cfg.roles.clone();
    let shutdown_state = state.clone();
    let app = routes::router_with_standbys(state, &replicas);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(
        target: telium_server::logcat::STARTUP,
        %server_name, %bind,
        identity = roles.identity, guild = roles.guild, media = roles.media,
        "telium up"
    );
    let grace = std::time::Duration::from_secs(shutdown_state.cfg.shutdown.grace_secs);
    let (begun_tx, begun_rx) = tokio::sync::oneshot::channel::<()>();
    let served = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async move {
            shutdown_signal(shutdown_state).await;
            let _ = begun_tx.send(());
        });

    match telium_server::shutdown::bounded(served, begun_rx, grace).await {
        Some(result) => result?,
        None => tracing::warn!(
            target: telium_server::logcat::STARTUP,
            grace_secs = grace.as_secs(),
            "shutdown deadline reached with requests still in flight; exiting anyway. Raise \
             shutdown.grace_secs if uploads are being cut short, and keep the supervisor's own \
             stop timeout above it."
        ),
    }
    Ok(())
}

async fn shutdown_signal(state: telium_server::AppState) {
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
    state.shutting_down.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Some(lease) = &state.lease {
        lease.release().await;
    }
    state.shutdown.notify_waiters();
    let closed = state.hub.close_all().await;
    tokio::time::sleep(std::time::Duration::from_millis(state.cfg.shutdown.settle_ms)).await;
    tracing::info!(
        target: telium_server::logcat::STARTUP,
        connections = closed,
        grace_secs = state.cfg.shutdown.grace_secs,
        "shutting down; waiting for in-flight requests"
    );
}

fn init_config(path: &std::path::Path) -> anyhow::Result<()> {
    if path.exists() {
        anyhow::bail!("{} already exists", path.display());
    }
    // The annotated example, not a bare dump of the defaults: every value in it
    // is the default, and the comments around them are the documentation most
    // operators will actually read.
    std::fs::write(path, include_str!("../telium.example.toml"))?;
    println!("wrote {}", path.display());
    Ok(())
}
