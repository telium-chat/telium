//! The operator's side of `telium-sfu`: show what the relay is doing, change
//! who may use it, and (re)configure it, from a terminal on the machine it
//! runs on.
//!
//! Everything here works on the config file and on the running relay's local
//! `/health`; none of it needs the relay's cooperation beyond that. The relay
//! watches its config file (see `main.rs`), so trust and block changes made
//! here are live within a couple of seconds. Anything else (domains, limits)
//! is picked up by a restart, which `configure` offers.
//!
//! The config is usually owned by the `telium-sfu` service account and not
//! readable by the operator, so a command that cannot read it re-runs itself
//! under `sudo` rather than failing with a permission error.

use std::io::{BufRead, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::config::{InstallKind, SfuConfig, TrustedOrigin};
use crate::trust::TrustedKeys;
use crate::updates;

/// The root-owned helper `install-full.sh` puts on the machine. It is the only
/// thing that edits the host's Caddy/nginx; the path is a constant on purpose
/// (a config value here would be a way to point a root process at any file).
const PROXY_HELPER: &str = "/usr/local/libexec/telium-sfu-admin-helper";

const SERVICE: &str = "telium-sfu.service";

// ------------------------------------------------------------------ plumbing

/// Where the config of an installed relay lives, when `--config` was not given.
/// A path that exists but cannot be stat'ed (the service account owns the
/// directory) counts: that is the normal case for an operator who is not root.
pub fn resolve_config_path(explicit: Option<&Path>) -> PathBuf {
    if let Some(path) = explicit {
        return path.to_path_buf();
    }
    if let Some(from_env) = std::env::var_os("TELIUM_SFU_CONFIG").filter(|v| !v.is_empty()) {
        return PathBuf::from(from_env);
    }
    let mut candidates = vec![PathBuf::from("sfu.toml")];
    if let Ok(exe) = std::env::current_exe() {
        // Portable layout: <prefix>/bin/telium-sfu next to <prefix>/config/sfu.toml.
        if let Some(prefix) = exe.parent().and_then(Path::parent) {
            candidates.push(prefix.join("config").join("sfu.toml"));
        }
    }
    candidates.push(PathBuf::from("/var/lib/telium-sfu/sfu.toml"));
    candidates.push(PathBuf::from("/etc/telium/sfu.toml"));
    candidates
        .into_iter()
        .find(|p| match std::fs::metadata(p) {
            Ok(_) => true,
            Err(e) => e.kind() == std::io::ErrorKind::PermissionDenied,
        })
        .unwrap_or_else(|| PathBuf::from("sfu.toml"))
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}
#[cfg(not(unix))]
fn is_root() -> bool {
    false
}

/// If `path` cannot be read by this user, run the same command again under
/// sudo (so the operator never has to work out which account owns the config)
/// and never return. Returns normally when the file is readable or missing.
#[cfg(unix)]
pub fn reexec_as_root_if_unreadable(path: &Path) {
    use std::os::unix::process::CommandExt;
    if is_root() {
        return;
    }
    let unreadable = matches!(std::fs::File::open(path), Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied);
    if !unreadable {
        return;
    }
    let Ok(exe) = std::env::current_exe() else { return };
    eprintln!("{} belongs to the telium-sfu service account; re-running with sudo.", path.display());
    let err = std::process::Command::new("sudo")
        .arg(format!("TELIUM_SFU_CONFIG={}", path.display()))
        .arg(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    eprintln!("could not run sudo ({err}); run this command as root instead.");
    std::process::exit(1);
}
#[cfg(not(unix))]
pub fn reexec_as_root_if_unreadable(_path: &Path) {}

fn load(path: &Path) -> anyhow::Result<SfuConfig> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => anyhow::bail!(
            "no config at {}. Pass --config <path> (or set TELIUM_SFU_CONFIG), or install the relay first with sfu/install.sh",
            path.display()
        ),
        _ => SfuConfig::load(path),
    }
}

fn install_kind(cfg: &SfuConfig) -> InstallKind {
    cfg.install.kind(Path::new(PROXY_HELPER).is_file())
}

/// Written beside the target, then renamed over it. The file holds the LiveKit
/// API secret, so it is created private; and when this runs as root inside a
/// directory the service account can write to, it must not follow anything
/// the service account planted there (hence create-new, and `fchown` on the
/// open file rather than `chown` on a name that could be swapped).
pub fn write_config(path: &Path, cfg: &SfuConfig) -> anyhow::Result<()> {
    let text = toml::to_string_pretty(cfg)?;
    let tmp = path.with_extension("toml.tmp");
    // Removing a leftover (or planted) name never follows it.
    match std::fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::anyhow!("cannot clear {}: {e}", tmp.display())),
    }
    let existing = std::fs::metadata(path).ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| anyhow::anyhow!("cannot write {}: {e}", tmp.display()))?;
        let written = (|| -> anyhow::Result<()> {
            if let Some(old) = &existing {
                // Keep the service account's ownership and the installer's mode:
                // a root-owned replacement would lock the relay out of its config.
                let mine = file.metadata()?;
                if mine.uid() != old.uid() || mine.gid() != old.gid() {
                    std::os::unix::fs::fchown(&file, Some(old.uid()), Some(old.gid()))?;
                }
                file.set_permissions(std::fs::Permissions::from_mode(old.mode() & 0o777))?;
            }
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    #[cfg(not(unix))]
    std::fs::write(&tmp, &text)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow::anyhow!("cannot replace {}: {e}", path.display()));
    }
    Ok(())
}

/// A container's config lives on the host: it is mounted read-only, or
/// regenerated at every start, so a change saved from inside would fail or
/// quietly vanish on the next restart. Refuse before doing any work.
fn ensure_editable(cfg: &SfuConfig) -> anyhow::Result<()> {
    anyhow::ensure!(
        install_kind(cfg) != InstallKind::Compose,
        "this is a Compose deployment, whose config is not editable from inside the container. Edit sfu.toml on the host, \
         then run `docker compose restart sfu` (see \"Compose SFU setup\" in deploy/README.md)"
    );
    Ok(())
}

fn save(path: &Path, cfg: &SfuConfig) -> anyhow::Result<()> {
    ensure_editable(cfg)?;
    write_config(path, cfg)
}

/// A DNS name, not a URL or host:port. Stricter than it needs to be on
/// purpose: the same values are passed to a root shell helper, which applies
/// the identical rule again.
pub fn valid_domain(value: &str) -> bool {
    let b = value.as_bytes();
    value.len() >= 3
        && value.len() <= 253
        && value.contains('.')
        && !value.contains("..")
        && b.first().is_some_and(u8::is_ascii_alphanumeric)
        && b.last().is_some_and(u8::is_ascii_alphanumeric)
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'.')
}

fn normalize_server(input: &str) -> anyhow::Result<String> {
    let name = input.trim().to_ascii_lowercase();
    anyhow::ensure!(
        valid_domain(&name),
        "{input:?} is not a server name. Use the bare name, such as chat.example.com (no https://, no port)"
    );
    Ok(name)
}

fn human_bytes(bytes: i64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 { format!("{bytes} B") } else { format!("{value:.1} {}", units[unit]) }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn host_of(url: &str) -> String {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

// ------------------------------------------------------------------- prompts

pub fn interactive() -> bool {
    std::io::stdin().is_terminal() && std::io::stdout().is_terminal()
}

fn read_line() -> anyhow::Result<String> {
    let mut line = String::new();
    let n = std::io::stdin().lock().read_line(&mut line)?;
    anyhow::ensure!(n > 0, "input ended before an answer was given");
    Ok(line.trim().to_string())
}

fn ask(label: &str, default: &str) -> anyhow::Result<String> {
    if default.is_empty() {
        print!("{label}: ");
    } else {
        print!("{label} [{default}]: ");
    }
    std::io::stdout().flush()?;
    let answer = read_line()?;
    Ok(if answer.is_empty() { default.to_string() } else { answer })
}

fn confirm(label: &str, default_yes: bool) -> anyhow::Result<bool> {
    loop {
        print!("{label} {} ", if default_yes { "[Y/n]" } else { "[y/N]" });
        std::io::stdout().flush()?;
        match read_line()?.to_ascii_lowercase().as_str() {
            "" => return Ok(default_yes),
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => println!("Please answer y or n."),
        }
    }
}

/// A value that was given as a flag, or is asked for; with no terminal and no
/// flag it is an error that names the flag, never a hang on stdin.
fn flag_or_ask(given: Option<String>, flag: &str, label: &str, default: &str) -> anyhow::Result<String> {
    if let Some(v) = given {
        return Ok(v.trim().to_string());
    }
    anyhow::ensure!(interactive(), "{flag} is required when there is no terminal to ask on");
    ask(label, default)
}

fn paint(code: &str, text: &str) -> String {
    if std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none() {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}
fn good(text: &str) -> String { paint("32", text) }
fn bad(text: &str) -> String { paint("31", text) }
fn dim(text: &str) -> String { paint("2", text) }

// -------------------------------------------------------------------- status

#[derive(Serialize)]
struct Report {
    config: String,
    install: &'static str,
    sfu_domain: String,
    livekit_public_url: String,
    bind: String,
    mode: &'static str,
    trusted: Vec<String>,
    blocked: Vec<String>,
    service: Option<String>,
    /// `/health` of the running relay; null when it is not answering.
    relay: Option<serde_json::Value>,
    usage_period_days: u32,
    usage: Vec<(String, i64)>,
    build: serde_json::Value,
    updates: Option<serde_json::Value>,
    #[serde(skip)]
    update_line: Option<String>,
    #[serde(skip)]
    update_state: &'static str,
    #[serde(skip)]
    cfg: Option<SfuConfig>,
}

fn kind_name(kind: InstallKind) -> &'static str {
    match kind {
        InstallKind::Full => "full",
        InstallKind::Portable => "portable",
        InstallKind::Compose => "compose",
        InstallKind::Manual => "manual",
    }
}

async fn fetch_health(bind: &str) -> Option<serde_json::Value> {
    // 0.0.0.0 / [::] are listen addresses, not places to connect to.
    let addr = bind.replace("0.0.0.0", "127.0.0.1").replace("[::]", "[::1]");
    let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build().ok()?;
    client.get(format!("http://{addr}/health")).send().await.ok()?.json().await.ok()
}

fn service_state() -> Option<String> {
    let out = std::process::Command::new("systemctl").args(["is-active", SERVICE]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

async fn update_status(cfg: &SfuConfig) -> updates::Status {
    if !cfg.updates.check {
        return updates::Status::disabled();
    }
    let now = now_ms();
    match updates::read_manifest(&cfg.updates).await {
        Ok(manifest) => updates::Status {
            assessment: updates::assess(updates::build().commit, &manifest),
            last_checked_ms: Some(now),
            last_error: None,
            failing_since_ms: None,
        },
        Err((kind, e)) => updates::Status {
            assessment: updates::Assessment::Unknown(kind),
            last_checked_ms: None,
            last_error: Some(e),
            failing_since_ms: Some(now),
        },
    }
}

async fn build_report(path: &Path, cfg: SfuConfig, offline: bool) -> Report {
    let kind = install_kind(&cfg);
    let now = now_ms();
    let usage_dir = Path::new(&cfg.livekit.config_dir);
    let usage = crate::usage::Usage::load(usage_dir).snapshot(now, cfg.limits.transfer_period_days);
    let relay = fetch_health(&cfg.bind).await;
    let service = if matches!(kind, InstallKind::Full | InstallKind::Portable) { service_state() } else { None };

    let (updates_doc, update_line, update_state) = if offline {
        (None, None, "not checked (--offline)")
    } else {
        let status = update_status(&cfg).await;
        let state = match &status.assessment {
            updates::Assessment::Disabled => "checks are off (updates.check = false)",
            updates::Assessment::Current => "up to date",
            updates::Assessment::Unknown(_) => "unknown",
            updates::Assessment::Behind { .. } => "behind",
        };
        (
            Some(updates::version_document(&status, &cfg.updates, now)),
            updates::describe(&status, now),
            state,
        )
    };
    let b = updates::build();
    Report {
        config: path.display().to_string(),
        install: kind_name(kind),
        sfu_domain: cfg.install.sfu_domain.clone(),
        livekit_public_url: cfg.livekit.public_url.clone(),
        bind: cfg.bind.clone(),
        mode: if cfg.trust.public { "public" } else { "private" },
        trusted: cfg.trust.origins.iter().map(|o| o.server_name.clone()).collect(),
        blocked: cfg.limits.blocked_origins.clone(),
        service,
        relay,
        usage_period_days: cfg.limits.transfer_period_days,
        usage,
        build: serde_json::json!({ "version": b.version, "commit": b.commit }),
        updates: updates_doc,
        update_line,
        update_state,
        cfg: Some(cfg),
    }
}

fn print_report(r: &Report) {
    let cfg = r.cfg.as_ref().expect("report built from a config");
    println!("Telium SFU  {}  (build {})", updates::build().version, updates::short_commit(updates::build().commit));
    println!("{}", dim(&format!("config {}   install {}", r.config, r.install)));
    println!();

    println!("Relay");
    match &r.relay {
        Some(h) => {
            let ok = h["ok"].as_bool().unwrap_or(false);
            let accepting = h["accepting"].as_bool().unwrap_or(false);
            println!("  LiveKit       {}", if ok { good("running") } else { bad("not reachable") });
            if accepting {
                println!("  New calls     {}", good("accepting"));
            } else {
                let why = h["reason"].as_str().unwrap_or("LiveKit is down");
                println!("  New calls     {}", bad(&format!("not accepting ({why})")));
            }
            println!(
                "  Right now     {} room(s), {} participant(s)",
                h["rooms"].as_u64().unwrap_or(0),
                h["participants"].as_u64().unwrap_or(0)
            );
        }
        None => println!("  Relay         {}", bad(&format!("not answering on {}", r.bind))),
    }
    if let Some(service) = &r.service {
        let line = if service == "active" { good(service) } else { bad(service) };
        println!("  Service       {line} ({SERVICE})");
    }
    println!();

    println!("Address");
    let none = bad("not configured -- run `telium-sfu configure`");
    println!("  SFU API       {}", if r.sfu_domain.is_empty() { none.clone() } else { format!("https://{}", r.sfu_domain) });
    println!("  LiveKit       {}", if r.livekit_public_url.is_empty() { none } else { r.livekit_public_url.clone() });
    println!("  Listening     {} (behind your HTTPS proxy)", r.bind);
    println!();

    println!("Access");
    if cfg.trust.public {
        println!("  Public relay: any federated Telium server may use it.");
    } else {
        println!("  Private relay: only the servers below may use it.");
    }
    if r.trusted.is_empty() {
        println!("  Trusted       {}", dim("none"));
    } else {
        println!("  Trusted       {}", r.trusted.join(", "));
    }
    if r.blocked.is_empty() {
        println!("  Blocked       {}", dim("none"));
    } else {
        println!("  Blocked       {}", r.blocked.join(", "));
    }
    println!();

    println!("Limits and transfer");
    let limit = |n: u32| if n == 0 { "unlimited".to_string() } else { n.to_string() };
    println!("  Rooms         max {}", limit(cfg.limits.max_rooms));
    println!("  Participants  max {}", limit(cfg.limits.max_participants));
    if cfg.limits.transfer_budget_bytes > 0 {
        let used = crate::usage::Usage::load(Path::new(&cfg.livekit.config_dir))
            .total_estimate(now_ms(), cfg.limits.transfer_period_days);
        println!(
            "  Transfer      {} of {} over {} days (est.); new calls stop at {}% ({})",
            human_bytes(used),
            human_bytes(cfg.limits.transfer_budget_bytes),
            cfg.limits.transfer_period_days,
            cfg.limits.transfer_stop_percent,
            human_bytes(cfg.limits.admission_budget_bytes()),
        );
    } else {
        println!("  Transfer      not budgeted");
    }
    if !r.usage.is_empty() {
        println!("  Per guild server, last {} days (estimated):", r.usage_period_days);
        for (origin, bytes) in &r.usage {
            println!("    {origin:<32} {}", human_bytes(*bytes));
        }
    }
    println!();

    println!("Updates");
    println!("  State         {}", r.update_state);
    if let Some(line) = &r.update_line {
        println!("  {}", dim(line));
    }
}

pub async fn status(path: &Path, json: bool, offline: bool) -> anyhow::Result<()> {
    let cfg = load(path)?;
    let report = build_report(path, cfg, offline).await;
    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print_report(&report);
    }
    Ok(())
}

// --------------------------------------------------------------- trust/block

const LIVE_NOTE: &str = "A running relay picks this up within a few seconds; no restart is needed.";

pub fn trust_list(path: &Path) -> anyhow::Result<()> {
    let cfg = load(path)?;
    if cfg.trust.public {
        println!("This is a public relay: any federated Telium server may use it. Entries below are kept and refreshed explicitly.");
    } else {
        println!("This is a private relay: only the servers below can start calls or send control commands.");
    }
    if cfg.trust.origins.is_empty() {
        println!("No servers are whitelisted yet. Add one with: telium-sfu trust add chat.example.com");
    }
    for o in &cfg.trust.origins {
        let how = match (&o.discovery_url, o.public_key_b64.is_empty()) {
            (Some(url), _) => url.clone(),
            (None, false) => "pinned key".to_string(),
            (None, true) => "no key or address".to_string(),
        };
        println!("  {:<34} {}", o.server_name, dim(&how));
    }
    Ok(())
}

pub async fn trust_add(path: &Path, server: &str) -> anyhow::Result<()> {
    let name = normalize_server(server)?;
    let mut cfg = load(path)?;
    ensure_editable(&cfg)?;
    if cfg.trust.origins.iter().any(|o| o.server_name == name) {
        println!("{name} is already whitelisted.");
        return Ok(());
    }
    println!("Looking up {name} and verifying its signing keys...");
    // Typed by the operator, so this is configuration, not a stranger's claim.
    let base = TrustedKeys::from_config(&cfg.trust)
        .discover_origin(&name, crate::fetch::AddressPolicy::OperatorConfigured)
        .await
        .ok_or_else(|| anyhow::anyhow!(
            "could not discover and verify {name}. Check the name, that it is online, its .well-known discovery and /_telium/v1/keys. Nothing was changed. \
             `telium-sfu discover {name}` shows which step fails."
        ))?;
    cfg.trust.origins.push(TrustedOrigin {
        server_name: name.clone(),
        key_id: String::new(),
        public_key_b64: String::new(),
        discovery_url: Some(base.clone()),
    });
    save(path, &cfg)?;
    println!("Whitelisted {name} ({base}).");
    println!("{LIVE_NOTE} Active calls are not touched.");
    Ok(())
}

pub fn trust_remove(path: &Path, server: &str) -> anyhow::Result<()> {
    let name = normalize_server(server)?;
    let mut cfg = load(path)?;
    ensure_editable(&cfg)?;
    let before = cfg.trust.origins.len();
    cfg.trust.origins.retain(|o| o.server_name != name);
    anyhow::ensure!(cfg.trust.origins.len() != before, "{name} is not in the whitelist (see `telium-sfu trust list`)");
    save(path, &cfg)?;
    println!("Removed {name} from the whitelist.");
    println!("{LIVE_NOTE} Calls already in progress are not disconnected; new sessions and control commands from it stop.");
    Ok(())
}

pub fn block_list(path: &Path) -> anyhow::Result<()> {
    let cfg = load(path)?;
    if cfg.limits.blocked_origins.is_empty() {
        println!("No guild servers are blocked. Block one with: telium-sfu block add guild.example");
    }
    for o in &cfg.limits.blocked_origins {
        println!("  {o}");
    }
    Ok(())
}

pub fn block_add(path: &Path, server: &str) -> anyhow::Result<()> {
    let name = server.trim().to_ascii_lowercase();
    anyhow::ensure!(!name.is_empty(), "a server name is required");
    let mut cfg = load(path)?;
    ensure_editable(&cfg)?;
    if cfg.limits.blocked_origins.contains(&name) {
        println!("{name} is already blocked.");
        return Ok(());
    }
    cfg.limits.blocked_origins.push(name.clone());
    save(path, &cfg)?;
    println!("Blocked {name}: new calls from it are refused; calls in progress finish naturally.");
    println!("{LIVE_NOTE}");
    Ok(())
}

pub fn block_remove(path: &Path, server: &str) -> anyhow::Result<()> {
    let name = server.trim().to_ascii_lowercase();
    let mut cfg = load(path)?;
    ensure_editable(&cfg)?;
    let before = cfg.limits.blocked_origins.len();
    cfg.limits.blocked_origins.retain(|o| *o != name);
    anyhow::ensure!(cfg.limits.blocked_origins.len() != before, "{name} is not blocked (see `telium-sfu block list`)");
    save(path, &cfg)?;
    println!("Unblocked {name}.");
    println!("{LIVE_NOTE}");
    Ok(())
}

// ------------------------------------------------------------------- restart

/// Runs `argv` as root: directly when this process is root, else through sudo.
fn run_privileged(argv: &[&str]) -> anyhow::Result<()> {
    let mut command = if is_root() {
        let mut c = std::process::Command::new(argv[0]);
        c.args(&argv[1..]);
        c
    } else {
        let mut c = std::process::Command::new("sudo");
        c.args(argv);
        c
    };
    let status = command.status().map_err(|e| anyhow::anyhow!("could not run {}: {e}", argv[0]))?;
    anyhow::ensure!(status.success(), "{} failed ({status})", argv.join(" "));
    Ok(())
}

pub fn restart(path: &Path) -> anyhow::Result<()> {
    let cfg = load(path)?;
    if install_kind(&cfg) == InstallKind::Compose {
        anyhow::bail!("this is a Compose deployment: restart it from the host with `docker compose restart sfu`");
    }
    println!("Restarting {SERVICE}...");
    run_privileged(&["systemctl", "restart", SERVICE])?;
    println!("Restarted. Calls in progress at this moment reconnect through the client's usual retry.");
    Ok(())
}

// ----------------------------------------------------------------- configure

#[derive(Default)]
pub struct ConfigureArgs {
    pub sfu_domain: Option<String>,
    pub livekit_domain: Option<String>,
    pub email: Option<String>,
    pub public: Option<bool>,
    pub homeserver: Option<String>,
    pub discovery_url: Option<String>,
    pub yes: bool,
    pub restart: Option<bool>,
}

pub async fn configure(path: &Path, args: ConfigureArgs) -> anyhow::Result<()> {
    let mut cfg = load(path)?;
    ensure_editable(&cfg)?;
    let kind = install_kind(&cfg);
    let manages_proxy = kind == InstallKind::Full;
    let first_server = cfg.trust.origins.first().cloned();

    println!("Configure this relay.");
    if manages_proxy {
        println!("Telium will add its two sites to your Caddy or nginx, get HTTPS certificates, and open the recommended firewall ports.");
        println!("Before continuing, create DNS A/AAAA records for both names pointing at this machine.");
    } else {
        println!("Telium saves its config and restarts the relay. It does not touch your reverse proxy, certificates or firewall:");
        println!("route the SFU name to 127.0.0.1:7890 and the LiveKit name (with WebSocket upgrades) to 127.0.0.1:7880 yourself.");
    }
    println!();

    let sfu_domain = flag_or_ask(args.sfu_domain, "--sfu-domain", "SFU domain (Telium servers and browsers use this, e.g. sfu.example.com)", &cfg.install.sfu_domain)?
        .to_ascii_lowercase();
    let livekit_domain = flag_or_ask(args.livekit_domain, "--livekit-domain", "LiveKit domain (secure WebSocket signalling, e.g. livekit.example.com)", &host_of(&cfg.livekit.public_url))?
        .to_ascii_lowercase();
    anyhow::ensure!(
        valid_domain(&sfu_domain) && valid_domain(&livekit_domain),
        "enter DNS hostnames such as sfu.example.com, not URLs or host:port values"
    );
    anyhow::ensure!(sfu_domain != livekit_domain, "the SFU and LiveKit names must differ: they are two different sites");
    let email = if manages_proxy {
        let email = flag_or_ask(args.email, "--email", "Email for Let's Encrypt", "")?;
        anyhow::ensure!(
            email.contains('@') && email.rsplit('@').next().is_some_and(|d| d.contains('.')),
            "enter a valid email address for Let's Encrypt"
        );
        email
    } else {
        String::new()
    };

    let already_configured = !cfg.livekit.public_url.is_empty() || !cfg.trust.origins.is_empty();
    let public = match args.public {
        Some(p) => p,
        None => {
            anyhow::ensure!(interactive(), "--public or --private is required when there is no terminal to ask on");
            println!();
            println!("Who can use this relay?");
            println!("  public   guilds on any Telium homeserver can run calls through it.");
            println!("           Choose this to list the relay at telium.chat/list; a private relay in the directory turns every caller away.");
            println!("  private  only the homeservers you trust, starting with yours (add more with `telium-sfu trust add`).");
            let default = if already_configured && cfg.trust.public { "public" } else if already_configured { "private" } else { "" };
            loop {
                match ask("public or private", default)?.to_ascii_lowercase().as_str() {
                    "public" | "pub" => break true,
                    "private" | "priv" => break false,
                    _ => println!("Type public or private."),
                }
            }
        }
    };

    let homeserver_default = first_server.as_ref().map(|o| o.server_name.clone()).unwrap_or_default();
    let homeserver = match args.homeserver {
        Some(h) => h,
        None if interactive() => {
            let label = if public { "Your homeserver (optional for a public relay)" } else { "Your homeserver (required for a private relay), e.g. chat.example.com" };
            ask(label, &homeserver_default)?
        }
        None => String::new(),
    }
    .trim()
    .to_ascii_lowercase();
    if !homeserver.is_empty() {
        anyhow::ensure!(valid_domain(&homeserver), "enter your homeserver's name, such as chat.example.com");
    }
    anyhow::ensure!(
        public || !homeserver.is_empty() || !cfg.trust.origins.is_empty(),
        "a private relay only serves the homeservers it trusts: give your homeserver's name, or choose public"
    );

    println!();
    println!("About to apply:");
    println!("  SFU endpoint     https://{sfu_domain}");
    println!("  LiveKit          wss://{livekit_domain}");
    println!("  Access           {}", if public { "public relay" } else { "private relay" });
    if !homeserver.is_empty() {
        println!("  Homeserver       {homeserver}");
    }
    if manages_proxy {
        println!("  HTTPS front end  configured now (certificates for both names, UFW ports if active)");
    }
    if !args.yes && interactive() && !confirm("Apply?", true)? {
        println!("Nothing was changed.");
        return Ok(());
    }

    cfg.bind = "127.0.0.1:7890".into();
    cfg.livekit.url = "http://127.0.0.1:7880".into();
    cfg.livekit.public_url = format!("https://{livekit_domain}");
    cfg.livekit.rtc.use_external_ip = true;
    cfg.trust.discovery = true;
    cfg.trust.public = public;
    cfg.install.sfu_domain = sfu_domain.clone();

    if !homeserver.is_empty() {
        let mut discovery_url = args.discovery_url.unwrap_or_default().trim().to_string();
        let already_trusted = cfg.trust.origins.iter().any(|o| o.server_name == homeserver);
        if discovery_url.is_empty() && !already_trusted {
            // Without this the entry would carry neither a key nor an address
            // and the relay could never verify the homeserver.
            println!("Looking up {homeserver} and verifying its signing keys...");
            discovery_url = TrustedKeys::from_config(&cfg.trust)
                .discover_origin(&homeserver, crate::fetch::AddressPolicy::OperatorConfigured)
                .await
                .ok_or_else(|| anyhow::anyhow!(
                    "could not find and verify the homeserver {homeserver}. Check its name and that it is online, then run this again. Nothing was changed."
                ))?;
        }
        // An already-trusted homeserver with no new URL keeps its entry (and any pinned key).
        if !(already_trusted && discovery_url.is_empty()) {
            let entry = TrustedOrigin {
                server_name: homeserver.clone(),
                key_id: String::new(),
                public_key_b64: String::new(),
                discovery_url: (!discovery_url.is_empty()).then_some(discovery_url),
            };
            match cfg.trust.origins.iter_mut().find(|o| o.server_name == homeserver) {
                Some(existing) => *existing = entry,
                None => cfg.trust.origins.push(entry),
            }
        }
    }

    if manages_proxy {
        println!("Setting up HTTPS (this can take a minute while certificates are issued)...");
        run_privileged(&[PROXY_HELPER, "proxy", &sfu_domain, &livekit_domain, &email]).map_err(|e| anyhow::anyhow!(
            "proxy/certificate setup failed: {e}. Check that DNS for both names points at this machine, then run `telium-sfu configure` again. The relay's own config was not changed."
        ))?;
    }
    save(path, &cfg)?;
    println!("Saved {}.", path.display());

    let do_restart = match args.restart {
        Some(r) => r,
        None if args.yes || !interactive() => true,
        None => confirm("Restart the relay now to use the new settings?", true)?,
    };
    if do_restart {
        restart(path)?;
    } else {
        println!("Not restarted. Run `telium-sfu restart` when you are ready.");
    }

    println!();
    println!("Done.");
    println!("  SFU endpoint:       https://{sfu_domain}");
    println!("  LiveKit signalling: wss://{livekit_domain}");
    println!("Add https://{sfu_domain} as a voice region on your Telium server.");
    if public {
        println!("To let other communities find it, list it at https://telium.chat/list?type=relay (you decide there whether automatic call routing may use it).");
    } else {
        println!("This is a private relay. To list it in the public directory later, run `telium-sfu configure` and choose public.");
    }
    if !manages_proxy {
        println!("Allow the WebRTC media ports through your firewall: TCP 7881, UDP 3478 and UDP 50000-60000.");
    }
    Ok(())
}

// --------------------------------------------------------------------- menu

fn pick(title: &str, items: &[(&str, &str)]) -> anyhow::Result<Option<String>> {
    println!();
    println!("{title}");
    for (key, label) in items {
        println!("  {key}) {label}");
    }
    let answer = ask("Choose", "")?.to_ascii_lowercase();
    Ok(if answer.is_empty() { None } else { Some(answer) })
}

/// Each action reports its own failure and returns to the menu: one mistyped
/// server name should not end the session.
fn report(result: anyhow::Result<()>) {
    if let Err(e) = result {
        eprintln!("{} {e:#}", bad("error:"));
    }
}

pub async fn manage(path: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(interactive(), "`manage` is interactive; use the subcommands (status, trust, block, configure, restart) in scripts");
    load(path)?;
    println!("Telium SFU  {}", dim(&path.display().to_string()));
    loop {
        let Some(choice) = pick(
            "What would you like to do?",
            &[
                ("1", "Show status"),
                ("2", "Trusted servers (whitelist)"),
                ("3", "Blocked guild servers"),
                ("4", "Configure domains and access"),
                ("5", "Restart the relay"),
                ("q", "Quit"),
            ],
        )?
        else {
            continue;
        };
        match choice.as_str() {
            "1" => report(status(path, false, false).await),
            "2" => loop {
                report(trust_list(path));
                match pick("Trusted servers", &[("a", "Add a server"), ("r", "Remove a server"), ("b", "Back")])?.as_deref() {
                    Some("a") => {
                        let name = ask("Server name (e.g. chat.example.com)", "")?;
                        report(trust_add(path, &name).await);
                    }
                    Some("r") => {
                        let name = ask("Server name to remove", "")?;
                        report(trust_remove(path, &name));
                    }
                    _ => break,
                }
            },
            "3" => loop {
                report(block_list(path));
                match pick("Blocked servers", &[("a", "Block a server"), ("r", "Unblock a server"), ("b", "Back")])?.as_deref() {
                    Some("a") => {
                        let name = ask("Server name to block", "")?;
                        report(block_add(path, &name));
                    }
                    Some("r") => {
                        let name = ask("Server name to unblock", "")?;
                        report(block_remove(path, &name));
                    }
                    _ => break,
                }
            },
            "4" => report(configure(path, ConfigureArgs::default()).await),
            "5" => {
                if confirm("Restart the relay?", false)? {
                    report(restart(path));
                }
            }
            "q" | "quit" | "exit" => return Ok(()),
            _ => println!("Choose one of the listed options."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("telium-sfu-cli-{name}-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn server_names_are_bare_dns_names() {
        assert!(valid_domain("chat.example.com"));
        assert!(valid_domain("a-b.example"));
        for bad in ["", "localhost", "https://chat.example.com", "chat.example.com:8448", "chat..example", ".chat.example", "chat.example.", "-a.example", "a.example-", "a b.example"] {
            assert!(!valid_domain(bad), "{bad:?} must be refused");
        }
        assert_eq!(normalize_server("  Chat.Example.COM ").unwrap(), "chat.example.com");
        assert!(normalize_server("https://chat.example.com").is_err());
    }

    #[test]
    fn install_kind_reads_the_new_and_the_legacy_section() {
        let new: SfuConfig = toml::from_str("[install]\nmode = \"portable\"\nsfu_domain = \"sfu.example.com\"\n").unwrap();
        assert_eq!(new.install.kind(false), InstallKind::Portable);
        assert_eq!(new.install.sfu_domain, "sfu.example.com");
        // What the retired web dashboard's installers wrote: the other keys are ignored.
        let old: SfuConfig = toml::from_str(
            "[admin]\nenabled = true\nbind = \"127.0.0.1:7891\"\nstate_dir = \"/x\"\nhelper_path = \"/y\"\ninstall_mode = \"portable\"\n",
        )
        .unwrap();
        assert_eq!(old.install.kind(false), InstallKind::Portable);
        // Older full installs recorded no mode; the helper's presence says what they are.
        let legacy: SfuConfig = toml::from_str("[admin]\nenabled = true\n").unwrap();
        assert_eq!(legacy.install.kind(true), InstallKind::Full);
        assert_eq!(legacy.install.kind(false), InstallKind::Manual);
    }

    #[test]
    fn saved_config_is_private_and_replaces_atomically() {
        let dir = scratch("save");
        let path = dir.join("sfu.toml");
        let mut cfg = SfuConfig::default();
        cfg.livekit.api_secret = "s3cret".into();
        write_config(&path, &cfg).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        cfg.limits.blocked_origins.push("guild.example".into());
        write_config(&path, &cfg).unwrap();
        assert_eq!(SfuConfig::load(&path).unwrap().limits.blocked_origins, vec!["guild.example".to_string()]);
        assert!(!path.with_extension("toml.tmp").exists(), "no temp file is left behind");
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn saving_keeps_the_installers_mode_and_ignores_a_planted_temp_name() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("plant");
        let path = dir.join("sfu.toml");
        write_config(&path, &SfuConfig::default()).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();
        // A service-writable directory: someone planted a symlink where the temp file goes.
        let victim = dir.join("victim");
        std::fs::write(&victim, "keep me").unwrap();
        std::os::unix::fs::symlink(&victim, path.with_extension("toml.tmp")).unwrap();
        write_config(&path, &SfuConfig::default()).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me", "the symlink target is never written through");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o640);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn blocking_and_trusting_edit_the_file_and_report_misses() {
        let dir = scratch("lists");
        let path = dir.join("sfu.toml");
        write_config(&path, &SfuConfig::default()).unwrap();
        block_add(&path, " Guild.Example ").unwrap();
        block_add(&path, "guild.example").unwrap();
        assert_eq!(SfuConfig::load(&path).unwrap().limits.blocked_origins, vec!["guild.example".to_string()]);
        assert!(block_remove(&path, "other.example").is_err());
        block_remove(&path, "GUILD.example").unwrap();
        assert!(SfuConfig::load(&path).unwrap().limits.blocked_origins.is_empty());
        assert!(trust_remove(&path, "chat.example.com").is_err());
        assert!(trust_remove(&path, "https://chat.example.com").is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_compose_deployment_refuses_edits_instead_of_losing_them() {
        let dir = scratch("compose");
        let path = dir.join("sfu.toml");
        let mut cfg = SfuConfig::default();
        cfg.install.mode = "compose".into();
        write_config(&path, &cfg).unwrap();
        let err = block_add(&path, "guild.example").unwrap_err().to_string();
        assert!(err.contains("docker compose restart sfu"), "{err}");
        assert!(trust_remove(&path, "chat.example.com").unwrap_err().to_string().contains("Compose"));
        assert!(SfuConfig::load(&path).unwrap().limits.blocked_origins.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_missing_config_says_how_to_find_one() {
        let err = load(Path::new("/nonexistent/telium/sfu.toml")).unwrap_err().to_string();
        assert!(err.contains("--config"), "{err}");
    }
}
