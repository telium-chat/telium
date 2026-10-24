
use crate::config::Config;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Home {
    Config(&'static str),
    Env(&'static str),
    KeyFile(&'static str),
    Database(&'static str),
    Elsewhere(&'static str),
}

impl Home {
    pub fn locator(self) -> &'static str {
        match self {
            Home::Config(s)
            | Home::Env(s)
            | Home::KeyFile(s)
            | Home::Database(s)
            | Home::Elsewhere(s) => s,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    Overlapping,
    Restart,
    Regenerate,
    Outage,
    Impossible,
}

impl Rotation {
    pub fn as_str(self) -> &'static str {
        match self {
            Rotation::Overlapping => "overlapping",
            Rotation::Restart => "restart",
            Rotation::Regenerate => "regenerate",
            Rotation::Outage => "outage",
            Rotation::Impossible => "impossible",
        }
    }
}

pub struct SecretEntry {
    pub heading: &'static str,
    pub protects: &'static str,
    pub home: Home,
    pub if_lost: &'static str,
    pub if_disclosed: &'static str,
    pub rotation: Rotation,
    pub how_to_rotate: &'static str,
}

pub const INVENTORY: &[SecretEntry] = &[
    SecretEntry {
        heading: "OPAQUE server setup",
        protects: "every password registration on this server",
        home: Home::Database("opaque_server_state.setup"),
        if_lost: "every account's password stops working, permanently: the per-account \
                  registration records are meaningless without it, and users with no verified \
                  recovery address have no route back at all",
        if_disclosed: "it is not a password database and yields no password directly, but it is \
                       the material an offline attack against the per-account records would \
                       need -- and whoever has this row has those records too",
        rotation: Rotation::Impossible,
        how_to_rotate: "It cannot be rotated, and this is structural rather than an omission: \
                        rotating it invalidates every registration derived from it, which is the \
                        same event as losing it. Re-sealing would need the passwords, and the \
                        point of OPAQUE is that this server never had them.",
    },
    SecretEntry {
        heading: "Backup encryption key",
        protects: "every `.tbk` archive this server has ever written",
        home: Home::KeyFile("backup.key_file"),
        if_lost: "every archive sealed under it becomes unreadable forever -- there is no \
                  escrow, no recovery key and no support path",
        if_disclosed: "anyone holding both the key and an archive can read everything the server \
                       had at that snapshot, including every other secret in this inventory that \
                       lives in the database",
        rotation: Rotation::Overlapping,
        how_to_rotate: "Mint a new key with `telium-server backup keygen` at a new path, move \
                        the old path into `backup.previous_key_files`, point `backup.key_file` \
                        at the new one and restart. New archives are sealed under the new key; \
                        every existing archive still opens. Drop the old entry when the last \
                        archive sealed under it has aged out of `backup.keep`.",
    },
    SecretEntry {
        heading: "Federation signing key",
        protects: "this server's identity on the federation: assertions, guild sessions, and \
                   every signed federated request",
        home: Home::Database("server_keys.secret_b64"),
        if_lost: "the server mints a fresh key on next start; peers holding the old one refuse \
                  this server until they refetch, and assertions in flight fail at once",
        if_disclosed: "total impersonation of this server. The holder can mint identity \
                       assertions for any of its users and answer for it on any federated route, \
                       and nothing on the receiving side can tell the difference",
        rotation: Rotation::Overlapping,
        how_to_rotate: "`telium-server keys rotate`, then restart. The new key is minted with a \
                        window that outlasts the current one and both stay published, so \
                        signatures already in flight keep verifying. After a theft use \
                        `--compromised`, which closes the old window immediately and drops every \
                        session signed under it.",
    },
    SecretEntry {
        heading: "Per-user escrow keys",
        protects: "each user's encrypted direct-message history",
        home: Home::Database("key_vault.escrow_key"),
        if_lost: "those users lose their encrypted DM history; nothing else on the server is \
                  affected",
        if_disclosed: "read access to that user's encrypted DM history",
        rotation: Rotation::Impossible,
        how_to_rotate: "Not an operator-rotatable secret. The material is per-user and the \
                        ciphertext it opens was written under it; replacing it discards the \
                        history rather than re-keying it.",
    },
    SecretEntry {
        heading: "Cross-signing sealed secrets",
        protects: "the user's own cross-signing identity",
        home: Home::Database("cross_signing.sealed_secret"),
        if_lost: "that user re-establishes cross-signing from a device they still hold",
        if_disclosed: "nothing directly. The server holds a ciphertext sealed to the user and \
                       has never been able to open it -- it is listed here so that its presence \
                       in the database is not mistaken for a secret the operator holds",
        rotation: Rotation::Regenerate,
        how_to_rotate: "The user re-enrols cross-signing from a device. There is no \
                        operator-side rotation and there should not be one.",
    },
    SecretEntry {
        heading: "MFA encryption key",
        protects: "every enrolled account's second factor, where it sits in the database",
        home: Home::KeyFile("mfa.key_file"),
        if_lost: "every sealed second factor becomes unreadable: authenticators keep showing \
                  codes and the server can no longer check them. Accounts holding an unused \
                  recovery code sign in and re-enrol -- recovery codes are hashed separately \
                  and are not sealed under this key -- and `telium-server mfa reset-all` is \
                  the way back for everybody else. The server refuses to start rather than \
                  boot into a silent lockout",
        if_disclosed: "nothing on its own. It is only worth anything together with a copy of \
                       the database, and the pair is worth exactly what the database alone \
                       used to be: every enrolled account's TOTP secret. Keeping the two apart \
                       is the entire point of this key, so a copy of it inside a backup \
                       archive that also holds the database is the same as not having it",
        rotation: Rotation::Overlapping,
        how_to_rotate: "Mint a new key with `telium-server mfa keygen` at a new path, move the \
                        old path into `mfa.previous_key_files`, point `mfa.key_file` at the new \
                        one and restart -- sign-ins keep working throughout, because the old \
                        key is still in the ring. Then `telium-server mfa rekey` re-seals \
                        every enrolled account under the new key and the old entry can be \
                        dropped. Unlike the backup key there is no waiting period: the \
                        ciphertext is a few hundred rows, not a month of archives.",
    },
    SecretEntry {
        heading: "Per-user MFA secrets",
        protects: "each enrolled user's time-based second factor",
        home: Home::Database(
            "accounts.mfa_sealed, sealed under the MFA encryption key; the cleartext \
             column accounts.mfa_secret is emptied by the startup sealing pass and \
             stays in the schema only so a rollback has somewhere to put the secret back",
        ),
        if_lost: "those users must re-enrol their authenticator",
        if_disclosed: "the holder can generate valid codes for those users. On its own that is \
                       not account access, but it silently removes the protection the user \
                       believed they had. A copy of the database is no longer enough to get \
                       them: they are sealed under `mfa.key_file`, which is not in it",
        rotation: Rotation::Regenerate,
        how_to_rotate: "A TOTP secret is shared with a phone and cannot be changed \
                        server-side; only the user re-enrolling changes it. What the server \
                        owns is the forced re-enrolment: `telium-server mfa reset-all` \
                        invalidates every enrolment, destroys every recovery code, tells the \
                        affected accounts, and makes the client ask them to enrol again. Note \
                        that enrolment hands the client an `otpauth://` URI containing the \
                        live secret: it must never be logged, returned in an error, or \
                        written into a diagnostic bundle.",
    },
    SecretEntry {
        heading: "Media curator key",
        protects: "the curated media feed this server publishes",
        home: Home::Database("media_curator_key.secret_b64, with the incoming key staged \
                              alongside it in media_curator_key.next_secret_b64"),
        if_lost: "the feed cannot be re-signed and subscribers stop accepting updates until they \
                  are repinned",
        if_disclosed: "the holder can publish curated media in this server's name to everyone \
                       who has pinned it",
        rotation: Rotation::Overlapping,
        how_to_rotate: "Built in and staged: `media_curator_key.next_secret_b64` holds the \
                        incoming key while the current one is still being published, so \
                        subscribers see both halves before the switch and none of them lose the \
                        feed at the moment it happens.",
    },
    SecretEntry {
        heading: "Hosting publisher key",
        protects: "the signed managed-hosting provider catalogue",
        home: Home::Database("hosting_catalog_key.secret_b64"),
        if_lost: "the catalogue cannot be re-signed; copies already signed keep verifying, so \
                  nothing breaks until an update is due",
        if_disclosed: "the holder can publish a provider catalogue that clients accept, pointing \
                       users at a hosting provider of their choosing. That is a supply-chain \
                       position, not a data breach, and it is worse than it sounds",
        rotation: Rotation::Impossible,
        how_to_rotate: "No rotation: the key id is a constant in the source and subscribers pin \
                        it, so changing it is a coordinated release rather than an operation. \
                        Treat it as release infrastructure -- it belongs on the machine that \
                        publishes, and most operators will never hold it.",
    },
    SecretEntry {
        heading: "Relocation successor keys",
        protects: "the old domain's vouch for a completed server relocation",
        home: Home::Database("server_keys.secret_b64 rows carrying a domain"),
        if_lost: "the old domain can no longer vouch for the move, and a peer that has not yet \
                  seen the vouch may never accept it",
        if_disclosed: "the holder can forge the move, redirecting this server's users to a \
                       domain of their choosing",
        rotation: Rotation::Outage,
        how_to_rotate: "Re-run relocation. `telium-server keys forget-expired` deliberately \
                        leaves these rows alone: a vouch may legitimately need re-signing after \
                        its window has passed, and destroying the only key that can say \"we \
                        really did move\" turns a paperwork problem into a permanent one.",
    },
    SecretEntry {
        heading: "VAPID push identity",
        protects: "this server's identity to browser push services",
        home: Home::Database("vapid_key.secret_b64"),
        if_lost: "a new one is generated on next start and every existing web-push subscription \
                  becomes invalid; clients re-subscribe on their next visit",
        if_disclosed: "surprisingly little. VAPID authenticates the sender to the push service; \
                       it does not let the holder read anything, and pushes here are \
                       content-free by design",
        rotation: Rotation::Regenerate,
        how_to_rotate: "Delete the row and restart. It costs exactly what losing it costs, and \
                        given how little disclosure buys there is no reason to do it on a \
                        schedule.",
    },
    SecretEntry {
        heading: "Bot credentials",
        protects: "each bot's authority to act as itself",
        home: Home::Database("bot_credentials.token_hash"),
        if_lost: "that bot is re-issued a credential; nothing else is affected",
        if_disclosed: "full use of that bot, within whatever the bot may do",
        rotation: Rotation::Overlapping,
        how_to_rotate: "Issue a new credential, let the bot pick it up, then revoke the old one \
                        with `revoked_at`. Only the hash is stored, so a disclosure here means \
                        the plaintext leaked somewhere else. This is the model the rest of this \
                        inventory wishes it had everywhere.",
    },
    SecretEntry {
        heading: "TURN shared secret",
        protects: "the credentials clients use to relay calls through your TURN server",
        home: Home::Config("voice.turn_secret"),
        if_lost: "relayed calls fail until this value and the relay's own `static-auth-secret` \
                  match again; mesh and SFU paths are unaffected",
        if_disclosed: "free use of your relay bandwidth, and the ability to mint credentials \
                       that look like yours. Call media is not exposed -- TURN relays ciphertext",
        rotation: Rotation::Outage,
        how_to_rotate: "A two-sided change: the new value must land in the TURN server's config \
                        and here. Credentials issued under the old value stop working, so do it \
                        in a quiet window. coturn accepts more than one `static-auth-secret`, so \
                        an operator who wants an overlap can stage it on that side -- this \
                        server always mints under the one value it has.",
    },
    SecretEntry {
        heading: "Object-store credentials",
        protects: "the buckets holding backups, archived media and the media store",
        home: Home::Config("backup.remote.{access_key_id,secret_access_key}, and the same pair \
                            again at archive.s3 and media_store.s3"),
        if_lost: "uploads stop; nothing already stored is destroyed",
        if_disclosed: "read and delete access to whatever the credential is scoped to. For a \
                       backup bucket that is the server's entire history in encrypted form -- \
                       harmless alone, catastrophic beside a leaked backup key",
        rotation: Rotation::Restart,
        how_to_rotate: "Entirely at the provider. Issue a new pair, update the config or \
                        `TELIUM_S3_ACCESS_KEY_ID`/`TELIUM_S3_SECRET_ACCESS_KEY`, restart, then \
                        delete the old pair at the provider -- in that order, so the window has \
                        two valid credentials rather than none.",
    },
    SecretEntry {
        heading: "Metrics scrape token",
        protects: "the Prometheus exposition, which describes this server's accounts, traffic \
                   shape and peers",
        home: Home::Config("metrics.scrape_token, plus metrics.scrape_token_previous while a \
                            rotation window is open"),
        if_lost: "the monitoring agent is refused until a new token is set on both sides",
        if_disclosed: "the holder can read this server's telemetry from anywhere. Not message \
                       content, but account counts, database size, traffic shape and the health \
                       of every peer",
        rotation: Rotation::Overlapping,
        how_to_rotate: "Copy the current token into `metrics.scrape_token_previous`, put the new \
                        one in `metrics.scrape_token`, restart -- both are now accepted -- \
                        reconfigure the agent, then clear `previous` and restart again. The \
                        window is as long as you want and closes on an explicit action.",
    },
    SecretEntry {
        heading: "Mail webhook token",
        protects: "the outbound-mail webhook, and with it the administrator alert channel",
        home: Home::Config("mail.webhook_token"),
        if_lost: "outbound mail stops -- silently, and you find out during the incident the \
                  alerts existed for",
        if_disclosed: "the holder can inject mail events at your relay, in your name",
        rotation: Rotation::Outage,
        how_to_rotate: "Two-sided: change it here and at the webhook. Whether there is an \
                        overlap window depends entirely on the receiving end, which is not this \
                        server; if it accepts only one token, mail stops for the seconds between \
                        the two edits.",
    },
    SecretEntry {
        heading: "FCM service account",
        protects: "this server's authority to send Android push through your Firebase project",
        home: Home::KeyFile("push.fcm.service_account_file"),
        if_lost: "Android push stops until a replacement is downloaded from Google Cloud",
        if_disclosed: "the holder can send push notifications through your Firebase project, to \
                       your app's users, with whatever content they choose",
        rotation: Rotation::Restart,
        how_to_rotate: "At Google: create a new service-account key, replace the file, restart, \
                        then delete the old key in the Cloud console. Google permits several \
                        live keys per service account, so the overlap costs nothing.",
    },
    SecretEntry {
        heading: "APNs signing key",
        protects: "this server's authority to send iOS push through your Apple team",
        home: Home::KeyFile("push.apns.key_file"),
        if_lost: "iOS push stops, and the `.p8` cannot be downloaded a second time -- a lost \
                  one is replaced, not recovered",
        if_disclosed: "the holder can send push to any app your team signs, not only this one. \
                       An APNs key is scoped to the team, which is wider than operators expect",
        rotation: Rotation::Restart,
        how_to_rotate: "At Apple: mint a new key, put the `.p8` in place, update \
                        `push.apns.key_id`, restart, then revoke the old key in the developer \
                        portal. Apple allows two active keys per team, which is exactly enough \
                        for one overlap and not enough for two at once.",
    },
    SecretEntry {
        heading: "Klipy API key",
        protects: "nothing -- it is an application identifier, and it is listed so that nobody \
                   treats it as a secret",
        home: Home::Config("klipy.api_key"),
        if_lost: "GIF search stops until a key is configured",
        if_disclosed: "nothing. It ships as a default compiled into the binary and is served to \
                       every client through `/capabilities`; a client's network log has always \
                       contained it. An operator who obtains their own key should understand it \
                       will be equally public",
        rotation: Rotation::Restart,
        how_to_rotate: "At Klipy. Change the value and restart.",
    },
    SecretEntry {
        heading: "Release signing key",
        protects: "the release manifest an operator checks for updates against",
        home: Home::Elsewhere("updates.manifest_public_key pins the public half; the private \
                               half is never held by a homeserver"),
        if_lost: "no homeserver is affected. The project cannot sign a new manifest until a new \
                  key is minted and published, and every operator who pinned the old one must \
                  repin",
        if_disclosed: "the holder can sign release metadata that pinned servers accept, telling \
                       them a compromised build is current or that a security release does not \
                       exist",
        rotation: Rotation::Outage,
        how_to_rotate: "Not an operation a homeserver performs. An operator's part is to repin \
                        `updates.manifest_public_key` when the project publishes a new key. Note \
                        that the private half does not exist yet: minting it is a human \
                        decision outside this repository, and until it is taken an empty pin is \
                        the honest state rather than a downgrade -- `preflight` reports it as a \
                        configuration state on every start so it is never a silent disable.",
    },
    SecretEntry {
        heading: "SFU LiveKit API key and secret",
        protects: "the SFU's room-join tokens",
        home: Home::Elsewhere("livekit.api_secret in the SFU's own config, not this server's"),
        if_lost: "in spawn mode, clear both fields and restart and a new pair is generated. In \
                  external mode you must match whatever the separately-run LiveKit expects",
        if_disclosed: "the holder can mint a join token for any room, as any participant \
                       identity, with any grant. Guild and DM call media is end-to-end encrypted \
                       above the SFU, so this is presence and metadata rather than content -- \
                       but it is still somebody in your calls",
        rotation: Rotation::Restart,
        how_to_rotate: "In spawn mode, clear `livekit.api_key` and `livekit.api_secret` and \
                        restart the SFU; it generates a fresh pair and writes them into the \
                        `livekit.yaml` it manages, at mode 0600.",
    },
];

pub fn find(locator: &str) -> Option<&'static SecretEntry> {
    INVENTORY.iter().find(|e| e.home.locator().contains(locator))
}

pub fn by_heading(heading: &str) -> Option<&'static SecretEntry> {
    INVENTORY.iter().find(|e| e.heading == heading)
}

pub struct SecretFile {
    pub path: PathBuf,
    pub holds: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub path: String,
    pub holds: &'static str,
    pub mode: u32,
    pub fatal: bool,
    pub message: String,
}

pub fn secret_files(cfg: &Config, config_path: Option<&Path>) -> Vec<SecretFile> {
    let mut files = Vec::new();

    if let Some(path) = config_path {
        if path.exists() {
            files.push(SecretFile {
                path: path.to_path_buf(),
                holds: "the TURN shared secret, the mail webhook token and any object-store \
                        credentials not supplied through the environment",
            });
        }
    }

    if let Some(db) = database_path(&cfg.database_url) {
        if db.exists() {
            files.push(SecretFile {
                path: db.clone(),
                holds: "this server's federation signing key, its push identity, its OPAQUE \
                        server setup, and every account's second-factor secret",
            });
        }
        for suffix in ["-wal", "-shm"] {
            let mut sidecar = db.clone().into_os_string();
            sidecar.push(suffix);
            let sidecar = PathBuf::from(sidecar);
            if sidecar.exists() {
                files.push(SecretFile {
                    path: sidecar,
                    holds: "database writes not yet folded into the main file, including any \
                            key material written since the last checkpoint",
                });
            }
        }
    }

    if cfg.mfa.key_file.exists() {
        files.push(SecretFile {
            path: cfg.mfa.key_file.clone(),
            holds: "the key every enrolled account's second factor is sealed under",
        });
    }
    for path in &cfg.mfa.previous_key_files {
        if path.exists() {
            files.push(SecretFile {
                path: path.clone(),
                holds: "a retired MFA key, which still opens every second factor not yet \
                        re-sealed under the current one",
            });
        }
    }

    if cfg.backup.key_file.exists() {
        files.push(SecretFile {
            path: cfg.backup.key_file.clone(),
            holds: "the key every backup archive this server has ever written is sealed under",
        });
    }

    for path in &cfg.backup.previous_key_files {
        if path.exists() {
            files.push(SecretFile {
                path: path.clone(),
                holds: "a retired backup key, which still opens every archive sealed before it \
                        was retired",
            });
        }
    }

    if let Some(path) = &cfg.push.fcm.service_account_file {
        if path.exists() {
            files.push(SecretFile {
                path: path.clone(),
                holds: "the service account that can send push through your Firebase project",
            });
        }
    }
    if let Some(path) = &cfg.push.apns.key_file {
        if path.exists() {
            files.push(SecretFile {
                path: path.clone(),
                holds: "the APNs signing key, which can push to every app your Apple team signs",
            });
        }
    }

    if let Some(path) = config_path {
        for referenced in crate::config::referenced_secret_files(path) {
            if referenced.exists() {
                files.push(SecretFile {
                    path: referenced,
                    holds: "a value the configuration reaches through ${file:}, which is a \
                            secret by construction -- nobody indirects a hostname",
                });
            }
        }
    }

    files
}

pub fn audit(cfg: &Config, config_path: Option<&Path>) -> Vec<Finding> {
    let mut findings = Vec::new();
    for file in secret_files(cfg, config_path) {
        if let Some(finding) = check(&file) {
            findings.push(finding);
        }
    }
    findings
}

#[cfg(unix)]
fn check(file: &SecretFile) -> Option<Finding> {
    use std::os::unix::fs::PermissionsExt as _;
    let meta = std::fs::metadata(&file.path).ok()?;
    let mode = meta.permissions().mode() & 0o777;
    let writable = mode & 0o022 != 0;
    let readable = mode & 0o044 != 0;
    if !writable && !readable {
        return None;
    }
    let display = file.path.display().to_string();
    let fix = mode & 0o700;
    let message = if writable {
        format!(
            "{display} is mode {mode:04o}: it can be written by users other than its owner, and \
             it holds {}. Anyone who can write it can replace this server's signing material and \
             have the server keep vouching for it. Fix it with `chmod {fix:04o} {display}` and \
             treat the key as compromised.",
            file.holds
        )
    } else {
        format!(
            "{display} is mode {mode:04o}: it can be read by users other than its owner, and it \
             holds {}. Fix it with `chmod {fix:04o} {display}`, and rotate what it holds if you \
             do not know who else has read it -- see docs/secrets.md.",
            file.holds
        )
    };
    Some(Finding { path: display, holds: file.holds, mode, fatal: writable, message })
}

#[cfg(not(unix))]
fn check(_file: &SecretFile) -> Option<Finding> {
    None
}

pub fn check_at_startup(cfg: &Config, config_path: Option<&Path>) -> anyhow::Result<()> {
    let findings = audit(cfg, config_path);
    if findings.is_empty() {
        return Ok(());
    }
    for finding in &findings {
        tracing::error!(target: crate::logcat::STARTUP, path = %finding.path, mode = format!("{:04o}", finding.mode), "{}", finding.message);
    }
    let fatal: Vec<&Finding> = findings.iter().filter(|f| f.fatal).collect();
    if fatal.is_empty() {
        return Ok(());
    }
    anyhow::bail!(
        "refusing to start: {} secret file(s) can be written by other users on this machine \
         ({}). A file anyone can write is a signing key anyone can replace, and a server that \
          kept running would keep vouching for whatever they put there. Fix the modes and start \
          again. If this is a deliberate arrangement -- a shared group you trust -- narrow the \
          group's write bit rather than the check.",
        fatal.len(),
        fatal.iter().map(|f| f.path.as_str()).collect::<Vec<_>>().join(", "),
    )
}

pub fn database_path(database_url: &str) -> Option<PathBuf> {
    use sqlx::sqlite::SqliteConnectOptions;
    use std::str::FromStr as _;
    let opts = SqliteConnectOptions::from_str(database_url).ok()?;
    let path = opts.get_filename().to_path_buf();
    let name = path.to_string_lossy();
    if name == ":memory:" || name.starts_with("file:sqlx-in-memory") {
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(rel: &str) -> String {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{rel}: {e}"))
    }

    #[test]
    fn database_path_of_memory_and_file_urls() {
        assert_eq!(database_path("sqlite::memory:"), None);
        assert_eq!(database_path("sqlite://:memory:"), None);
        assert_eq!(database_path("sqlite://telium.db?mode=rwc"), Some(PathBuf::from("telium.db")));
    }

    #[cfg(unix)]
    #[test]
    fn readable_warns_and_writable_refuses() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = std::env::temp_dir().join(format!("telium-secrets-{}", crate::util::ulid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("backup.key");
        std::fs::write(&path, b"not-a-real-key\n").unwrap();
        let file = SecretFile { path: path.clone(), holds: "a test key" };
        let at = |mode| {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            check(&file)
        };
        assert!(at(0o600).is_none());
        let readable = at(0o644).expect("0644 reported");
        assert!(!readable.fatal && readable.message.contains("chmod 0600"));
        assert!(at(0o666).expect("0666 reported").fatal);
        assert!(at(0o620).expect("group-writable reported").fatal);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn every_credential_field_in_the_config_is_in_the_inventory() {
        let src = manifest("src/config.rs");
        let fields: Vec<&str> = src
            .lines()
            .filter_map(|l| l.trim().strip_prefix("pub ")?.split_once(": "))
            .filter(|(_, ty)| matches!(ty.trim_end_matches(','), "Secret" | "Option<Secret>"))
            .map(|(name, _)| name)
            .collect();
        assert!(fields.len() >= 5, "scan broken: {} credential fields", fields.len());
        let missing: Vec<_> =
            fields.iter().filter(|n| !INVENTORY.iter().any(|e| e.home.locator().contains(**n))).collect();
        assert!(missing.is_empty(), "config Secret fields missing from INVENTORY: {missing:?}");
    }

    #[test]
    fn every_secret_bearing_column_in_the_schema_is_in_the_inventory() {
        const SECRET_SHAPED: &[&str] = &["secret", "escrow_key", "private_key", "passphrase", "password"];
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let sql: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "sql"))
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
        assert!(sql.len() > 30, "found {} migrations; the walk is broken", sql.len());

        let mut columns: Vec<String> = Vec::new();
        for text in &sql {
            let mut table: Option<String> = None;
            for line in text.lines() {
                let trimmed = line.trim();
                let lower = trimmed.to_ascii_lowercase();
                if let Some(rest) = lower.strip_prefix("alter table ") {
                    let mut w = rest.split_whitespace();
                    if let (Some(t), Some("add"), Some("column"), Some(c)) =
                        (w.next(), w.next(), w.next(), w.next())
                    {
                        columns.push(format!("{t}.{}", c.trim_matches('"')));
                    }
                    continue;
                }
                if let Some(rest) = lower.strip_prefix("create table ") {
                    let rest = rest.strip_prefix("if not exists ").unwrap_or(rest);
                    table = Some(rest.split(['(', ' ']).next().unwrap_or_default().to_string());
                    continue;
                }
                if trimmed.starts_with(')') {
                    table = None;
                    continue;
                }
                let Some(t) = table.as_deref() else { continue };
                let mut w = trimmed.split_whitespace();
                let (Some(name), Some(ty)) = (w.next(), w.next()) else { continue };
                let ty = ty.trim_end_matches(',').to_ascii_uppercase();
                if matches!(ty.as_str(), "TEXT" | "BLOB" | "INTEGER" | "REAL" | "NUMERIC") {
                    columns.push(format!("{t}.{}", name.trim_matches('"')));
                }
            }
        }
        let secretish: Vec<&String> = columns.iter().filter(|full| {
            let col = full.rsplit('.').next().unwrap_or_default();
            !col.ends_with("_hash") && SECRET_SHAPED.iter().any(|pat| col.contains(pat))
        }).collect();
        assert!(secretish.len() >= 8, "scan broken: {} secret columns", secretish.len());
        let listed = |n: &str| INVENTORY.iter().any(|e| e.home.locator().contains(n));
        let missing: Vec<_> = secretish.iter().filter(|full| !listed(full)).collect();
        assert!(missing.is_empty(), "secret columns missing from INVENTORY: {missing:?}");
    }

    #[test]
    fn every_example_placeholder_is_still_in_the_example_config() {
        let example = manifest("telium.example.toml");
        let missing: Vec<_> =
            crate::config::EXAMPLE_PLACEHOLDERS.iter().filter(|p| !example.contains(**p)).collect();
        assert!(missing.is_empty(), "placeholders absent from telium.example.toml: {missing:?}");
    }
}
