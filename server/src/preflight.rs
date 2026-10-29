
use crate::config::Config;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Notice,
    Warn,
    Danger,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Notice => "notice",
            Level::Warn => "warning",
            Level::Danger => "DANGER",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Finding {
    pub key: String,
    pub level: Level,
    pub exposes: String,
    pub remedy: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    Production,
    Development,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Production => "production",
            Profile::Development => "development",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Audit {
    pub profile: Profile,
    pub inferred: bool,
    pub findings: Vec<Finding>,
}

impl Audit {
    pub fn worst(&self) -> Option<Level> {
        self.findings.iter().map(|f| f.level).max()
    }

    pub fn dangers(&self) -> usize {
        self.findings.iter().filter(|f| f.level == Level::Danger).count()
    }
}

pub fn profile_of(cfg: &Config) -> (Profile, bool) {
    match cfg.profile.trim().to_ascii_lowercase().as_str() {
        "production" | "prod" => (Profile::Production, false),
        "development" | "dev" => (Profile::Development, false),
        _ => {
            let local = host_of(&cfg.public_base_url).is_some_and(|h| is_loopback_host(&h));
            (if local { Profile::Development } else { Profile::Production }, true)
        }
    }
}

pub fn audit(cfg: &Config, config_path: Option<&Path>) -> Audit {
    let (profile, inferred) = profile_of(cfg);
    let prod = profile == Profile::Production;
    let mut f: Vec<Finding> = Vec::new();

    if prod && (cfg.server_name == "localhost" || !cfg.server_name.contains('.')) {
        f.push(Finding {
            key: "server_name".into(),
            level: Level::Danger,
            exposes: format!(
                "every account created on this server gets a user id ending in \
                 `:{}`, which no other server on the internet can resolve. The ids are \
                 durable: changing this key later does not rename them, it strands them, and \
                 recovering means migrating every account to a new domain.",
                cfg.server_name
            ),
            remedy: "set `server_name` to the domain this server is identified by -- the one in \
                     its user ids, which may differ from its hostname -- before the first account \
                     is created."
                .into(),
        });
    }

    match host_of(&cfg.public_base_url) {
        None => f.push(Finding {
            key: "public_base_url".into(),
            level: if prod { Level::Danger } else { Level::Warn },
            exposes: format!(
                "`{}` is not a URL this server can publish. It is what \
                 /.well-known/telium/server tells other servers and every client to come back \
                 to, so invite links, federation callbacks and the guided account move all point \
                 at it.",
                cfg.public_base_url
            ),
            remedy: "set `public_base_url` to the scheme-and-host clients actually reach, e.g. \
                     `public_base_url = \"https://telium.example\"`."
                .into(),
        }),
        Some(host) if prod && is_loopback_host(&host) => f.push(Finding {
            key: "public_base_url".into(),
            level: Level::Danger,
            exposes: format!(
                "this server publishes `{}` as its address. Every invite link, every \
                 federation callback and every client redirect sends people to their own \
                 machine, where there is nothing listening. The server itself looks healthy \
                 throughout.",
                cfg.public_base_url
            ),
            remedy: "set `public_base_url` to the public origin, e.g. \
                     `public_base_url = \"https://telium.example\"`."
                .into(),
        }),
        Some(_) if prod && cfg.public_base_url.starts_with("http://") => f.push(Finding {
            key: "public_base_url".into(),
            level: Level::Danger,
            exposes: "this server publishes an `http://` address, so session tokens, identity \
                      assertions and every message cross the network in clear text and can be \
                      read or altered by anything between a client and here. Clients will not \
                      refuse it -- they will simply do as they are told."
                .into(),
            remedy: "terminate TLS in front of this server and set `public_base_url` to the \
                     `https://` origin. See docs/production.md for nginx and Caddy examples."
                .into(),
        }),
        Some(_) => {}
    }

    // `validate` refuses a non-https portal outright, so what is left to catch here is an
    // https portal that still points at the machine itself: every link minted against it
    // opens nothing on anybody else's browser.
    if cfg.web.invite_portal != "self" {
        if let Some(host) = host_of(&cfg.web.invite_portal) {
            if prod && is_loopback_host(&host) {
                f.push(Finding {
                    key: "web.invite_portal".into(),
                    level: Level::Danger,
                    exposes: format!(
                        "invite and vanity links are minted against `{}`, which every \
                         recipient's browser resolves on their own machine, where nothing \
                         is listening for them.",
                        cfg.web.invite_portal
                    ),
                    remedy: "set `web.invite_portal` to the public portal URL, or to `self` \
                             to mint links on this server again."
                        .into(),
                });
            }
        }
    }

    let wildcard = cfg.bind.starts_with("0.0.0.0:")
        || cfg.bind.starts_with("[::]:")
        || cfg.bind.starts_with(":::");
    let behind_proxy = !cfg.rate_limit.trusted_proxies.is_empty();
    let published_https = cfg.public_base_url.starts_with("https://");

    if prod && wildcard && !behind_proxy && published_https {
        f.push(Finding {
            key: "rate_limit.trusted_proxies".into(),
            level: Level::Warn,
            exposes: format!(
                "this server listens on every interface (`{}`) and publishes an https \
                 address, so TLS is being terminated by something in front of it -- but no proxy \
                 address is trusted, so every request is attributed to the proxy's IP. Per-IP \
                 rate limits then throttle the whole internet as one client, or nobody, \
                 depending on which limit is hit first.",
                cfg.bind
            ),
            remedy: "list the reverse proxy's address, e.g. \
                     `rate_limit.trusted_proxies = [\"127.0.0.1\"]`. Do not list anything you do \
                     not control: a trusted address may forge the client IP of every request."
                .into(),
        });
    }

    if prod && wildcard && !published_https {
        f.push(Finding {
            key: "bind".into(),
            level: Level::Danger,
            exposes: format!(
                "this server's plaintext listener is bound to every interface (`{}`) \
                 and nothing in the configuration suggests anything is terminating TLS in front \
                 of it. Anyone who can route to this machine can read every session token that \
                 crosses it.",
                cfg.bind
            ),
            remedy: "bind to loopback (`bind = \"127.0.0.1:8448\"`) and put a TLS-terminating \
                     reverse proxy in front, or -- inside a container network where the only \
                     route in is the proxy -- keep the wildcard and set `public_base_url` to the \
                     https origin the proxy serves."
                .into(),
        });
    }

    if cfg.federation.allow_http {
        f.push(Finding {
            key: "federation.allow_http".into(),
            level: if prod { Level::Danger } else { Level::Notice },
            exposes: "federation talks to other servers over plaintext http and accepts peer \
                      hostnames that carry a port or have no dot in them. The documents fetched \
                      that way include the signing keys used to authenticate every peer, so \
                      anything on the path can mint a peer identity and speak as any server on \
                      the network."
                .into(),
            remedy: "`federation.allow_http = false`. It exists for test rigs and split-horizon \
                     development, and nothing else."
                .into(),
        });
    }

    if cfg.media_policy.attachment_max_age_days > 0 {
        f.push(Finding {
            key: "media_policy.attachment_max_age_days".into(),
            level: Level::Warn,
            exposes: format!(
                "attachment media older than {} day(s) is swept whether or not a message \
                 still refers to it, so live messages will lose their files past that age.",
                cfg.media_policy.attachment_max_age_days
            ),
            remedy: "`media_policy.attachment_max_age_days = 0` keeps attachments for as long \
                     as their messages live; the unreferenced sweep alone reclaims what \
                     deletions free."
                .into(),
        });
    }

    for (key, value) in [
        ("push.fcm.base_url", cfg.push.fcm.base_url.as_ref()),
        ("push.fcm.token_url", cfg.push.fcm.token_url.as_ref()),
        ("push.apns.base_url", cfg.push.apns.base_url.as_ref()),
    ] {
        let Some(value) = value else { continue };
        f.push(Finding {
            key: key.into(),
            level: if prod { Level::Warn } else { Level::Notice },
            exposes: format!(
                "push notifications for this server are sent to {value} rather than to Google \
                 or Apple. Whatever is there receives the wake and its timing for every device \
                 registered through that transport, and if it is not a working provider relay \
                 then no such device is ever woken -- which looks like nothing at all in the \
                 logs, because the override is being honoured exactly as written."
            ),
            remedy: format!(
                "remove `{key}` unless this deployment genuinely relays push through {value}. \
                 Unset is the correct value on every server that talks to the real provider."
            ),
        });
    }

    if prod && cfg.registration.open && cfg.registration.admins.is_empty() {
        f.push(Finding {
            key: "registration.open".into(),
            level: Level::Danger,
            exposes: "registration is open and no administrator localparts are named, so the \
                      first account anybody creates on this server becomes its administrator. \
                      Between this process binding and the operator signing up, that is a race \
                      a stranger can win, and the winner can read, moderate and delete \
                      everything."
                .into(),
            remedy: "name the administrators up front -- `registration.admins = [\"you\"]` -- or \
                     close registration (`registration.open = false`), create your account, and \
                     reopen it."
                .into(),
        });
    }

    if prod && !cfg.rate_limit.enabled {
        f.push(Finding {
            key: "rate_limit.enabled".into(),
            level: Level::Danger,
            exposes: "every endpoint on this server is unthrottled, including sign-in. Password \
                      guessing, registration floods and message spam all run as fast as the \
                      network allows, and the first symptom is usually the database."
                .into(),
            remedy: "`rate_limit.enabled = true`. The defaults are sized for a normal community \
                     and only ever stop a client that is behaving abnormally."
                .into(),
        });
    }

    if cfg.registration.open && cfg.registration.min_password_len < 8 {
        f.push(Finding {
            key: "registration.min_password_len".into(),
            level: Level::Warn,
            exposes: format!(
                "anybody may register and a password of {} characters is accepted. \
                 Short passwords are not guessed one at a time; they are looked up.",
                cfg.registration.min_password_len
            ),
            remedy: "`registration.min_password_len = 12` or more. Length is the only property \
                     of a password that reliably costs an attacker anything."
                .into(),
        });
    }

    for (label, data_dir) in [("media_dir", Some(cfg.media_dir.clone())), ("database", sqlite_dir(&cfg.database_url))] {
        let Some(data_dir) = data_dir else { continue };
        if cfg.backup.enabled && is_inside(&cfg.backup.dir, &data_dir) {
            f.push(Finding {
                key: "backup.dir".into(),
                level: Level::Danger,
                exposes: format!(
                    "backups are written to `{}`, which is inside `{}` -- the very data they \
                     are backups of. They survive a corrupted table and nothing else: the same \
                     `docker volume rm`, the same lost disk and the same mistaken `rm -rf` takes \
                     the data and every archive of it in one go.",
                    cfg.backup.dir.display(),
                    data_dir.display(),
                ),
                remedy: format!(
                    "point `backup.dir` at a path on a different mount -- a host bind mount \
                     survives a volume being recreated -- and turn on `[backup.remote]` so a \
                     copy is off the box entirely. `{label}` is the directory to stay out of."
                ),
            });
            break;
        }
    }

    if prod && !cfg.backup.enabled {
        f.push(Finding {
            key: "backup.enabled".into(),
            level: Level::Warn,
            exposes: "nothing on this server is being backed up. Every account, every message \
                      and every uploaded file exists in exactly one place."
                .into(),
            remedy: "`backup.enabled = true`, and read docs/backup.md -- the key the archives \
                     are sealed under has to leave this machine too, or the archives are \
                     unreadable by the person who needs them."
                .into(),
        });
    } else if prod && cfg.backup.enabled && !cfg.backup.remote.enabled {
        f.push(Finding {
            key: "backup.remote.enabled".into(),
            level: Level::Warn,
            exposes: "backups are written to this machine and nowhere else, so they survive \
                      software mistakes and do not survive the machine. A dead disk, a deleted \
                      instance or a lost provider account takes the data and the backups \
                      together."
                .into(),
            remedy: "configure `[backup.remote]` with any S3-compatible bucket. The credentials \
                     belong in `TELIUM_S3_ACCESS_KEY_ID` / `TELIUM_S3_SECRET_ACCESS_KEY` or a \
                     `${file:...}` reference rather than in this file."
                .into(),
        });
    }

    #[cfg(unix)]
    if is_root() {
        f.push(Finding {
            key: "(process)".into(),
            level: Level::Danger,
            exposes: "this server is running as root. Every file it writes is root-owned, and \
                      any bug that reaches the filesystem or a subprocess reaches the whole \
                      machine rather than one service account. Nothing in this server needs \
                      privilege: it binds one port and writes one directory."
                .into(),
            remedy: "run as an unprivileged user. The container image already does (uid 10001); \
                     for a native install use the `User=`/`Group=` in \
                     deploy/telium-server.service, and bind above 1024 with a proxy in front."
                .into(),
        });
    }

    if cfg.backup.enabled {
        check_secret_file(&mut f, "backup.key_file", &cfg.backup.key_file, "every backup this \
            server has ever written can be decrypted by anybody who can read this file");
    }

    if let Some(path) = config_path {
        let secrets = secrets_in_file(cfg);
        if !secrets.is_empty() {
            check_secret_file(
                &mut f,
                "(config file)",
                path,
                &format!(
                    "this file holds {} in plain text, readable by every account on this machine",
                    join_english(&secrets)
                ),
            );
        }
    }

    for path in &cfg.backup.previous_key_files {
        check_secret_file(
            &mut f,
            "backup.previous_key_files",
            path,
            "every archive sealed before the last rotation can be decrypted by anybody who can \
             read this file, which is most of the archive set",
        );
    }
    if !cfg.backup.previous_key_files.is_empty() {
        f.push(Finding {
            key: "backup.previous_key_files".into(),
            level: Level::Notice,
            exposes: format!(
                "{} retired backup {} still configured. That is correct during a rotation and \
                 wrong afterwards: every one of them opens archives, so the blast radius of a \
                 stolen key file has not actually shrunk until they are removed.",
                cfg.backup.previous_key_files.len(),
                if cfg.backup.previous_key_files.len() == 1 { "key is" } else { "keys are" },
            ),
            remedy: "once no archive within `backup.keep` was sealed under a retired key, delete \
                     its entry from `backup.previous_key_files` and shred the file. \
                     docs/runbooks/rotating-a-secret.md has the ordering."
                .into(),
        });
    }

    if !cfg.metrics.scrape_token_previous.is_empty() {
        f.push(Finding {
            key: "metrics.scrape_token_previous".into(),
            level: Level::Notice,
            exposes: "a metrics scrape-token rotation window is open, so two tokens are \
                      accepted. That is exactly what the field is for and it is not a state to \
                      stay in -- if the old token is the one that leaked, it is still working."
                .into(),
            remedy: "once the monitoring agent presents the new token, clear \
                     `metrics.scrape_token_previous` and restart."
                .into(),
        });
    }

    if cfg.updates.check && cfg.updates.manifest_public_key.trim().is_empty() {
        f.push(Finding {
            key: "updates.manifest_public_key".into(),
            level: Level::Notice,
            exposes: "update checks are on and no release signing key is pinned, so the manifest \
                      is trusted because of where it was fetched from and nothing else. Whoever \
                      can answer for `updates.manifest_url` -- the host, a proxy, anyone holding \
                      a certificate for it -- can tell this server that a version it is missing \
                      does not exist."
                .into(),
            remedy: "pin the project's release signing key in `updates.manifest_public_key` once \
                     one is published. There is no key to pin yet, so today the honest options \
                     are to leave this as it is and read release announcements yourself, or set \
                     `updates.check = false` and decide when to look."
                .into(),
        });
    }

    if let Some(path) = &cfg.push.fcm.service_account_file {
        check_secret_file(
            &mut f,
            "push.fcm.service_account_file",
            path,
            "anybody who can read this file can send push notifications through your Firebase \
             project, to your users, saying anything",
        );
    }
    if let Some(path) = &cfg.push.apns.key_file {
        check_secret_file(
            &mut f,
            "push.apns.key_file",
            path,
            "anybody who can read this file can send push to every app your Apple team signs -- \
             an APNs key is scoped to the team, not to this app",
        );
    }

    if prod && cfg.web.dir.is_none() && cfg.web.client_url.is_none() {
        f.push(Finding {
            key: "web.dir".into(),
            level: Level::Warn,
            exposes: "this server serves no web client and names none, so somebody who opens its \
                      address in a browser gets a 404, and another server guiding an account \
                      move here has no page to send the person to."
                .into(),
            remedy: "serve the built client from this process with `web.dir = \"/srv/telium/web\"` \
                     (the container image already has it there), or point `web.client_url` at \
                     wherever it is hosted."
                .into(),
        });
    }

    if !cfg.updates.check {
        f.push(Finding {
            key: "updates.check".into(),
            level: Level::Notice,
            exposes: "this server will never tell you how far behind it is, including when a \
                      release it is missing was flagged security-relevant. That is a legitimate \
                      choice for an air-gapped or privacy-strict deployment, and it means the \
                      question has to be asked from somewhere else."
                .into(),
            remedy: "nothing, if this was deliberate. Otherwise `updates.check = true`, or point \
                     `updates.manifest_url` at an internal mirror of the release manifest."
                .into(),
        });
    }

    let inline = secrets_in_file(cfg);
    if !inline.is_empty() {
        f.push(Finding {
            key: "(secrets)".into(),
            level: Level::Notice,
            exposes: format!(
                "{} {} written literally into the config file. A config file tends to end up \
                 beside the compose file that deploys it, and that tends to end up in version \
                 control.",
                join_english(&inline),
                if inline.len() == 1 { "is" } else { "are" },
            ),
            remedy: "replace the value with `${env:NAME}` or `${file:/run/secrets/name}` and \
                     inject it at run time. See \"Secrets\" in docs/production.md."
                .into(),
        });
    }

    f.sort_by_key(|x| std::cmp::Reverse(x.level));
    Audit { profile, inferred, findings: f }
}

pub fn log(audit: &Audit) {
    if audit.findings.is_empty() {
        tracing::info!(
            target: crate::logcat::STARTUP,
            profile = audit.profile.as_str(),
            inferred = audit.inferred,
            "configuration audit: nothing to report"
        );
        return;
    }

    tracing::info!(
        target: crate::logcat::STARTUP,
        profile = audit.profile.as_str(),
        inferred = audit.inferred,
        findings = audit.findings.len(),
        dangers = audit.dangers(),
        "configuration audit"
    );

    for finding in &audit.findings {
        match finding.level {
            Level::Danger => tracing::error!(
                target: crate::logcat::STARTUP,
                key = %finding.key,
                remedy = %finding.remedy,
                "{}",
                finding.exposes
            ),
            Level::Warn => tracing::warn!(
                target: crate::logcat::STARTUP,
                key = %finding.key,
                remedy = %finding.remedy,
                "{}",
                finding.exposes
            ),
            Level::Notice => tracing::info!(
                target: crate::logcat::STARTUP,
                key = %finding.key,
                remedy = %finding.remedy,
                "{}",
                finding.exposes
            ),
        }
    }

    if audit.dangers() > 0 {
        tracing::error!(
            target: crate::logcat::STARTUP,
            dangers = audit.dangers(),
            "this server is starting with settings that expose it. `telium-server check` prints \
             the same list and exits non-zero; see docs/production.md"
        );
    }
}

pub fn render(audit: &Audit) -> String {
    let mut out = String::new();
    let how = if audit.inferred { "inferred from public_base_url" } else { "from the `profile` key" };
    let _ = writeln!(out, "profile:  {} ({how})", audit.profile.as_str());

    if audit.findings.is_empty() {
        let _ = writeln!(out, "\nNothing to report.");
        return out;
    }

    let _ = writeln!(out);
    for finding in &audit.findings {
        let _ = writeln!(out, "{:>7}  {}", finding.level.as_str(), finding.key);
        let _ = writeln!(out, "         {}", wrap(&finding.exposes, 9));
        let _ = writeln!(out, "         fix: {}", wrap(&finding.remedy, 14));
        let _ = writeln!(out);
    }

    let dangers = audit.dangers();
    if dangers > 0 {
        let _ = writeln!(
            out,
            "{dangers} setting{} here expose{} this server. Fix {} before it is reachable.",
            if dangers == 1 { "" } else { "s" },
            if dangers == 1 { "s" } else { "" },
            if dangers == 1 { "it" } else { "them" }
        );
    } else {
        let _ = writeln!(out, "Nothing dangerous. The warnings above are worth reading anyway.");
    }
    out
}

fn wrap(text: &str, indent: usize) -> String {
    const WIDTH: usize = 78;
    let pad = " ".repeat(indent);
    let mut out = String::new();
    let mut col = indent;
    for word in text.split_whitespace() {
        if col > indent && col + 1 + word.len() > WIDTH {
            out.push('\n');
            out.push_str(&pad);
            col = indent;
        } else if col > indent {
            out.push(' ');
            col += 1;
        }
        out.push_str(word);
        col += word.chars().count();
    }
    out
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(end) = authority.strip_prefix('[').and_then(|a| a.find(']').map(|i| &a[..i])) {
        end.to_string()
    } else {
        authority.split(':').next().unwrap_or("").to_string()
    };
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

fn sqlite_dir(database_url: &str) -> Option<PathBuf> {
    let rest = database_url.strip_prefix("sqlite://").or_else(|| database_url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next().unwrap_or("");
    if path.is_empty() || path == ":memory:" {
        return None;
    }
    let parent = Path::new(path).parent().unwrap_or(Path::new(""));
    Some(if parent.as_os_str().is_empty() { PathBuf::from(".") } else { parent.to_path_buf() })
}

fn is_inside(inner: &Path, outer: &Path) -> bool {
    let c = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| normalise(p));
    let (inner, outer) = (c(inner), c(outer));
    inner.starts_with(&outer)
}

fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}

fn secrets_in_file(cfg: &Config) -> Vec<&'static str> {
    let from_env = |name: &str| std::env::var(name).is_ok_and(|v| !v.is_empty());
    let mut out = Vec::new();
    if cfg.voice.turn_secret.as_deref().is_some_and(|s| !s.is_empty()) && !from_env("TELIUM_TURN_SECRET") {
        out.push("the TURN shared secret");
    }
    if !cfg.backup.remote.secret_access_key.is_empty() && !from_env("TELIUM_S3_SECRET_ACCESS_KEY") {
        out.push("the backup bucket's secret access key");
    }
    if !cfg.archive.s3.secret_access_key.is_empty() && !from_env("TELIUM_S3_SECRET_ACCESS_KEY") {
        out.push("the archive bucket's secret access key");
    }
    if !cfg.media_store.s3.secret_access_key.is_empty() && !from_env("TELIUM_S3_SECRET_ACCESS_KEY")
    {
        out.push("the media bucket's secret access key");
    }
    if !cfg.mail.webhook_token.is_empty() && !from_env("TELIUM_MAIL_WEBHOOK_TOKEN") {
        out.push("the mail webhook token");
    }
    if !cfg.metrics.scrape_token.is_empty() && !from_env("TELIUM_METRICS_SCRAPE_TOKEN") {
        out.push("the metrics scrape token");
    }
    out
}

fn join_english(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: `geteuid` takes no arguments, touches no memory and cannot fail.
    unsafe { libc_geteuid() == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "geteuid"]
    fn libc_geteuid() -> u32;
}

#[cfg(unix)]
fn check_secret_file(findings: &mut Vec<Finding>, key: &str, path: &Path, exposes: &str) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 == 0 {
        return;
    }
    findings.push(Finding {
        key: key.to_string(),
        level: Level::Danger,
        exposes: format!(
            "{} is mode {:04o}, so {exposes}. On a shared box that is every other service and \
             every other login; in a container it is every process that gets in.",
            path.display(),
            mode,
        ),
        remedy: format!("`chmod 600 {}` (and check the directories above it).", path.display()),
    });
}

#[cfg(not(unix))]
fn check_secret_file(_: &mut Vec<Finding>, _: &str, _: &Path, _: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn production() -> Config {
        let mut cfg = Config {
            server_name: "telium.example".into(),
            public_base_url: "https://telium.example".into(),
            bind: "127.0.0.1:8448".into(),
            ..Default::default()
        };
        cfg.registration.admins = vec!["operator".into()];
        (cfg.backup.remote.enabled, cfg.backup.remote.bucket) = (true, "b".into());
        cfg.web.client_url = Some("https://telium.example".into());
        cfg
    }

    fn has(audit: &Audit, key: &str) -> bool {
        audit.findings.iter().any(|f| f.key == key)
    }

    #[test]
    fn profile_inference() {
        assert_eq!(profile_of(&Config::default()), (Profile::Development, true));
        assert_eq!(audit(&Config::default(), None).dangers(), 0);
        assert_eq!(profile_of(&production()), (Profile::Production, true));
        assert_eq!(audit(&production(), None).dangers(), 0);
        let cfg = Config { profile: "production".into(), ..Default::default() };
        assert_eq!(profile_of(&cfg), (Profile::Production, false));
        let mut cfg = production();
        cfg.profile = "prodution".into();
        assert_eq!(profile_of(&cfg).0, Profile::Production);
        let mut dev = Config::default();
        dev.federation.allow_http = true;
        assert!(has(&audit(&dev, None), "federation.allow_http") && audit(&dev, None).dangers() == 0);
        cfg.federation.allow_http = true;
        assert_eq!(audit(&cfg, None).dangers(), 1);
    }

    #[test]
    fn each_rule_fires_and_its_fix_clears_it() {
        type Tweak = fn(&mut Config);
        let cases: &[(&str, Tweak, Option<Tweak>)] = &[
            ("registration.open", |c| { c.registration.open = true; c.registration.admins.clear() }, Some(|c| c.registration.admins = vec!["op".into()])),
            ("push.fcm.base_url", |c| c.push.fcm.base_url = Some("https://fcm.staging.example".into()), Some(|c| c.push.fcm.base_url = None)),
            ("public_base_url", |c| c.public_base_url = "http://telium.example".into(), None),
            ("server_name", |c| c.server_name = "localhost".into(), None),
            ("backup.dir", |c| { c.media_dir = "/var/lib/telium/media".into(); c.backup.dir = "/var/lib/telium/media/./sub/../backups".into() }, Some(|c| c.backup.dir = "/var/backups/telium".into())),
            ("backup.dir", |c| { c.media_dir = "/srv/media".into(); c.database_url = "sqlite:///var/lib/telium/telium.db?mode=rwc".into(); c.backup.dir = "/var/lib/telium/backups".into() }, None),
            ("bind", |c| { c.bind = "0.0.0.0:8448".into(); c.public_base_url = "http://telium.example".into() }, Some(|c| c.public_base_url = "https://telium.example".into())),
            ("rate_limit.trusted_proxies", |c| c.bind = "0.0.0.0:8448".into(), Some(|c| c.rate_limit.trusted_proxies = vec!["127.0.0.1".into()])),
            ("web.invite_portal", |c| c.web.invite_portal = "https://localhost:8448".into(), Some(|c| c.web.invite_portal = "self".into())),
        ];
        for (key, breaks, fixes) in cases {
            let mut cfg = production();
            breaks(&mut cfg);
            assert!(has(&audit(&cfg, None), key), "{key} not reported");
            if let Some(fixes) = fixes {
                fixes(&mut cfg);
                assert!(!has(&audit(&cfg, None), key), "{key} not cleared");
            }
        }
        let mut cfg = production();
        cfg.bind = "0.0.0.0:8448".into();
        cfg.rate_limit.trusted_proxies = vec!["127.0.0.1".into()];
        cfg.push.fcm.base_url = Some("https://fcm.staging.example".into());
        assert_eq!(audit(&cfg, None).dangers(), 0);
    }

    #[test]
    fn address_parsing() {
        assert_eq!(sqlite_dir("sqlite::memory:"), None);
        assert_eq!(sqlite_dir("postgres://localhost/telium"), None);
        assert_eq!(sqlite_dir("sqlite:///var/lib/telium/t.db?mode=rwc"), Some(PathBuf::from("/var/lib/telium")));
        assert_eq!(host_of("https://Telium.Example/").as_deref(), Some("telium.example"));
        assert_eq!(host_of("http://[::1]:8448").as_deref(), Some("::1"));
        assert_eq!(host_of("telium.example"), None);
        assert!(is_loopback_host("telium.localhost") && is_loopback_host("127.0.0.53"));
        assert!(!is_loopback_host("telium.example"));
    }

    #[cfg(unix)]
    #[test]
    fn a_world_readable_key_file_is_a_danger() {
        use std::os::unix::fs::PermissionsExt;
        let key = std::env::temp_dir().join(format!("telium-preflight-{}.key", std::process::id()));
        std::fs::write(&key, "x").unwrap();
        let mut cfg = production();
        cfg.backup.key_file = key.clone();
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(has(&audit(&cfg, None), "backup.key_file"));
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!has(&audit(&cfg, None), "backup.key_file"));
        std::fs::remove_file(&key).ok();
    }

    #[test]
    fn findings_are_worst_first_and_each_has_a_remedy() {
        let mut cfg = Config { profile: "production".into(), ..Default::default() };
        (cfg.federation.allow_http, cfg.rate_limit.enabled, cfg.updates.check) = (true, false, false);
        (cfg.registration.open, cfg.registration.admins) = (true, vec![]);
        let audit = audit(&cfg, None);
        assert!(audit.findings.len() >= 5);
        assert!(audit.findings.windows(2).all(|w| w[0].level >= w[1].level));
        for f in &audit.findings {
            assert!(!f.key.is_empty() && f.exposes.len() > 40 && f.remedy.len() > 20, "{} is thin", f.key);
        }
        assert!(render(&audit).contains("DANGER"));
    }
}
