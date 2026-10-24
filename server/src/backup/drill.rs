
use super::{check_payload, format, key_is_stranded, HashingReader, Status, DB_ENTRY};
use crate::config::Config;
use crate::util::now_ms;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::io;
use std::path::{Path, PathBuf};

const SCRATCH_PREFIX: &str = ".drill-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Passed,
    Failed,
    NeverRun,
    Stale,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Passed => "passed",
            Verdict::Failed => "failed",
            Verdict::NeverRun => "never-run",
            Verdict::Stale => "stale",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Failure {
    NoKey,
    Fetch,
    CannotDecrypt,
    Corrupt,
    Unpack,
    NoDatabase,
    DatabaseUnopenable,
    IntegrityFailed,
    SchemaTooNew,
    MigrationsIncomplete,
    MissingSigningKey,
    MissingPushKey,
    MissingAuthSecret,
}

impl Failure {
    pub fn advice(self) -> &'static str {
        match self {
            Failure::NoKey => {
                "There is no readable backup key on this machine. Every archive is unreadable \
                 without it. Put it back at backup.key_file, or set TELIUM_BACKUP_KEY."
            }
            Failure::Fetch => {
                "The newest archive could not be fetched. If a remote is configured this is about \
                 the bucket, not the disk: check credentials, endpoint and that uploads are still \
                 arriving."
            }
            Failure::CannotDecrypt => {
                "The key on this machine does not open the archive. It was replaced, or these \
                 archives came from elsewhere. Find the key they were sealed under; nothing else \
                 will read them."
            }
            Failure::Corrupt => {
                "The key is right and the bytes are wrong. Try an older archive with `backup \
                 verify`, and look at whatever writes to the bucket between here and there."
            }
            Failure::Unpack => {
                "The archive decrypted but its contents do not match what it says it carries. \
                 Treat it as unusable and check an older one."
            }
            Failure::NoDatabase => {
                "The archive carries no database. Whatever produced it did not produce a backup."
            }
            Failure::DatabaseUnopenable | Failure::IntegrityFailed => {
                "The database inside the archive is damaged. Check an older archive, and check the \
                 disk this server's database lives on -- the snapshot is a copy of it."
            }
            Failure::SchemaTooNew => {
                "The archive was taken by a newer build than the one running. Upgrade \
                 telium-server before relying on it; a restore would refuse it as well."
            }
            Failure::MigrationsIncomplete => {
                "The database in the archive has a migration recorded as applied but not \
                 successful. It was snapshotted mid-migration; take a fresh backup."
            }
            Failure::MissingSigningKey => {
                "The database in the archive carries no federation signing keys. Restoring it \
                 would produce a server with this domain and a new identity, which every peer \
                 that already knows this domain would refuse. Take a fresh backup and drill it."
            }
            Failure::MissingPushKey => {
                "The database in the archive carries no Web Push identity. Restoring it would \
                 silently invalidate every push subscription on the server."
            }
            Failure::MissingAuthSecret => {
                "The database in the archive carries no OPAQUE server setup, and this server has \
                 one. Restoring it would leave every account's password verifier with nothing to \
                 verify against: nobody could sign in. Take a fresh backup."
            }
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Verified {
    pub schema_version: i64,
    pub binary_schema_version: i64,
    pub integrity: bool,
    pub database_bytes: u64,
    pub signing_keys: i64,
    pub accounts: i64,
    pub devices: i64,
    pub push_keys: i64,
    pub auth_secrets: Option<i64>,
    pub guilds: i64,
    pub messages: i64,
    pub parts: Vec<PartSeen>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct PartSeen {
    pub kind: String,
    pub files_declared: u64,
    pub files_seen: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Drill {
    pub at: i64,
    pub ok: bool,
    pub source: String,
    pub archive: String,
    pub archive_created_at: Option<i64>,
    pub took_ms: i64,
    pub failure: Option<Failure>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub verified: Option<Verified>,
}

pub fn verdict(cfg: &Config, drill: Option<&Drill>) -> Verdict {
    let Some(drill) = drill else { return Verdict::NeverRun };
    if !drill.ok {
        return Verdict::Failed;
    }
    let stale_after_ms = cfg.backup.drill_stale_after_secs.max(0).saturating_mul(1000);
    // A negative age is a clock jump; treat the result as current.
    if (now_ms() - drill.at).max(0) > stale_after_ms {
        Verdict::Stale
    } else {
        Verdict::Passed
    }
}

pub fn report(cfg: &Config, status: &Status) -> serde_json::Value {
    let drill = status.last_drill.as_ref();
    let verdict = verdict(cfg, drill);
    serde_json::json!({
        "enabled": cfg.backup.enabled && cfg.backup.drill,
        "verdict": verdict.as_str(),
        "interval_secs": cfg.backup.drill_interval_secs,
        "stale_after_secs": cfg.backup.drill_stale_after_secs,
        "at": drill.map(|d| d.at),
        "age_ms": drill.map(|d| (now_ms() - d.at).max(0)),
        // The age of the last pass; survives a later failure on purpose.
        "passed_at": status.last_drill_pass,
        "passed_age_ms": status.last_drill_pass.map(|at| (now_ms() - at).max(0)),
        "source": drill.map(|d| d.source.clone()),
        "archive": drill.map(|d| d.archive.clone()),
        "archive_age_ms": drill.and_then(|d| d.archive_created_at).map(|at| (now_ms() - at).max(0)),
        "took_ms": drill.map(|d| d.took_ms),
        "failure": drill.and_then(|d| d.failure),
        "reason": drill.and_then(|d| d.error.clone()),
        "advice": drill.and_then(|d| d.failure).map(|f| f.advice()),
        "warnings": drill.map(|d| d.warnings.clone()).unwrap_or_default(),
        "verified": drill.and_then(|d| d.verified.clone()),
    })
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(err) = std::fs::remove_dir_all(&self.0) {
            if err.kind() != io::ErrorKind::NotFound {
                tracing::warn!(target: crate::logcat::BACKUP, path = %self.0.display(), %err, "could not remove the drill scratch directory");
            }
        }
    }
}

struct Stopped {
    failure: Failure,
    error: String,
}

fn stop(failure: Failure, error: impl std::fmt::Display) -> Stopped {
    Stopped { failure, error: format!("{error}") }
}

pub async fn run(cfg: &Config, live: Option<&SqlitePool>) -> Drill {
    let started = now_ms();
    let remote = cfg.backup.remote.enabled;
    let source = if remote { "remote" } else { "local" };
    let _ = std::fs::create_dir_all(&cfg.backup.dir);
    sweep_old_scratch(&cfg.backup.dir);

    let mut drill = Drill {
        at: started,
        ok: false,
        source: source.to_string(),
        archive: String::new(),
        ..Drill::default()
    };

    match attempt(cfg, live, remote, &mut drill).await {
        Ok((verified, warnings)) => {
            drill.ok = true;
            drill.verified = Some(verified);
            drill.warnings.extend(warnings);
        }
        Err(stopped) => {
            drill.ok = false;
            drill.failure = Some(stopped.failure);
            drill.error = Some(stopped.error);
        }
    }
    drill.at = now_ms();
    drill.took_ms = (drill.at - started).max(0);

    // Read-modify-write: a concurrent `backup now` may have written fresh status.
    let mut status = super::read_status(&cfg.backup.dir);
    if drill.ok {
        status.last_drill_pass = Some(drill.at);
    }
    status.last_drill = Some(drill.clone());
    super::write_status(&cfg.backup.dir, &status);
    drill
}

async fn attempt(
    cfg: &Config,
    live: Option<&SqlitePool>,
    remote: bool,
    drill: &mut Drill,
) -> Result<(Verified, Vec<String>), Stopped> {
    let mut warnings = Vec::new();

    let ring = match super::load_keyring(cfg) {
        Ok(ring) if !ring.is_empty() => ring,
        Ok(_) => {
            return Err(stop(
                Failure::NoKey,
                format!(
                    "no backup key at {} and TELIUM_BACKUP_KEY is not set",
                    cfg.backup.key_file.display()
                ),
            ))
        }
        Err(err) => return Err(stop(Failure::NoKey, format!("{err:#}"))),
    };
    if key_is_stranded(cfg) {
        warnings.push(
            "the backup key is inside the data store while the archives are not: losing the data \
             store would leave archives nobody can decrypt"
                .into(),
        );
    }

    let source = if remote { super::Source::RemoteLatest } else { super::Source::LocalLatest };
    let fetched = super::fetch(cfg, &source).await.map_err(|err| {
        stop(
            Failure::Fetch,
            if remote {
                format!("could not fetch the newest archive from the bucket: {err:#}")
            } else {
                format!("could not read the newest local archive: {err:#}")
            },
        )
    })?;
    drill.archive = fetched.label.clone();

    let key = ring
        .open(&fetched.path)
        .map_err(|err| stop(Failure::CannotDecrypt, format!("{err:#}")))?;

    let scratch_path = cfg.backup.dir.join(format!("{SCRATCH_PREFIX}{}", now_ms()));
    std::fs::create_dir_all(&scratch_path)
        .map_err(|err| stop(Failure::Unpack, format!("could not make a scratch directory: {err}")))?;
    let scratch = Scratch(scratch_path.clone());
    let db_file = scratch_path.join("telium.db");

    let unpacked = {
        let (archive, db_file) = (fetched.path.clone(), db_file.clone());
        tokio::task::spawn_blocking(move || unpack_database(&archive, &key, &db_file))
            .await
            .map_err(|err| stop(Failure::Unpack, format!("the drill task did not finish: {err}")))?
    }?;
    drill.archive_created_at = Some(unpacked.manifest.created_at);

    let binary_schema = crate::db::latest_migration_version();
    let opened = open_restored(&db_file).await?;
    let mut verified = Verified {
        binary_schema_version: binary_schema,
        database_bytes: std::fs::metadata(&db_file).map(|m| m.len()).unwrap_or(0),
        parts: unpacked.parts,
        ..Verified::default()
    };
    inspect(&opened, &mut verified).await?;
    opened.close().await;

    if verified.schema_version > binary_schema {
        return Err(stop(
            Failure::SchemaTooNew,
            format!(
                "the archive is at schema version {} and this binary only knows {binary_schema}",
                verified.schema_version
            ),
        ));
    }
    if verified.schema_version != unpacked.manifest.schema_version {
        warnings.push(format!(
            "the manifest says schema version {} and the database inside it is at {}",
            unpacked.manifest.schema_version, verified.schema_version
        ));
    }

    warnings.extend(part_warnings(cfg, &unpacked.manifest, &verified));
    warnings.extend(drift_warnings(live, &verified).await?);

    drop(scratch);
    drop(fetched);
    Ok((verified, warnings))
}

struct Unpacked {
    manifest: format::Manifest,
    parts: Vec<PartSeen>,
}

fn unpack_database(archive: &Path, key: &super::Key, db_file: &Path) -> Result<Unpacked, Stopped> {
    let file = io::BufReader::new(
        std::fs::File::open(archive).map_err(|err| stop(Failure::Fetch, format!("{err}")))?,
    );
    let reader = format::Reader::open(file, key).map_err(|err| {
        let failure = match err {
            format::FormatError::Auth(_)
            | format::FormatError::BadMagic
            | format::FormatError::UnsupportedVersion(_) => Failure::CannotDecrypt,
            _ => Failure::Corrupt,
        };
        stop(failure, err)
    })?;
    let manifest = reader.manifest().clone();

    let mut hashing = HashingReader { inner: reader, hasher: <Sha256 as sha2::Digest>::new(), bytes: 0 };
    let mut seen: Vec<(String, u64)> = Vec::new();
    {
        let gz = flate2::read::GzDecoder::new(&mut hashing);
        let mut tar = tar::Archive::new(gz);
        let entries = tar
            .entries()
            .map_err(|err| stop(classify(&err), format!("could not read the archive: {}", super::archive_error(err))))?;
        for entry in entries {
            let mut entry = entry
                .map_err(|err| stop(classify(&err), format!("{}", super::archive_error(err))))?;
            let path = entry
                .path()
                .map_err(|err| stop(Failure::Unpack, format!("unreadable path in the archive: {err}")))?
                .into_owned();
            let is_file = entry.header().entry_type().is_file();
            if is_file {
                let top = path
                    .components()
                    .next()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .unwrap_or_default();
                match seen.iter_mut().find(|(k, _)| *k == top) {
                    Some((_, n)) => *n += 1,
                    None => seen.push((top, 1)),
                }
            }
            if is_file && path == Path::new(DB_ENTRY) {
                entry.unpack(db_file).map_err(|err| {
                    stop(classify(&err), format!("could not unpack the database: {}", super::archive_error(err)))
                })?;
            } else {
                io::copy(&mut entry, &mut io::sink())
                    .map_err(|err| stop(classify(&err), format!("{}", super::archive_error(err))))?;
            }
        }
    }
    // Read the gzip trailer and final chunk, or a truncated archive's last-chunk flag is never checked.
    io::copy(&mut hashing, &mut io::sink())
        .map_err(|err| stop(classify(&err), format!("{}", super::archive_error(err))))?;
    check_payload(&manifest, &hashing).map_err(|err| stop(Failure::Corrupt, format!("{err:#}")))?;

    if !db_file.is_file() {
        return Err(stop(Failure::NoDatabase, "the archive carries no database"));
    }

    let mut parts = Vec::new();
    for part in &manifest.parts {
        let top = part.name.split('/').next().unwrap_or(&part.name).to_string();
        let files_seen = seen.iter().find(|(k, _)| *k == top).map(|(_, n)| *n).unwrap_or(0);
        parts.push(PartSeen {
            kind: part.kind.clone(),
            files_declared: part.files,
            files_seen,
            bytes: part.bytes,
        });
    }
    if let Some(bad) = parts.iter().find(|p| p.files_seen != p.files_declared) {
        return Err(stop(
            Failure::Unpack,
            format!(
                "the manifest declares {} file(s) in the {} part and the archive holds {}",
                bad.files_declared, bad.kind, bad.files_seen
            ),
        ));
    }

    Ok(Unpacked { manifest, parts })
}

fn classify(err: &io::Error) -> Failure {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        if e.downcast_ref::<format::FormatError>().is_some() {
            return Failure::Corrupt;
        }
        if e.downcast_ref::<io::Error>()
            .and_then(|io| io.get_ref())
            .and_then(|inner| inner.downcast_ref::<format::FormatError>())
            .is_some()
        {
            return Failure::Corrupt;
        }
        cur = e.source();
    }
    Failure::Unpack
}

async fn open_restored(db_file: &Path) -> Result<SqlitePool, Stopped> {
    let opts = SqliteConnectOptions::new()
        .filename(db_file)
        .create_if_missing(false)
        .read_only(true)
        .foreign_keys(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(15))
        .connect_with(opts)
        .await
        .map_err(|err| {
            stop(Failure::DatabaseUnopenable, format!("SQLite would not open the restored database: {err}"))
        })
}

async fn inspect(pool: &SqlitePool, verified: &mut Verified) -> Result<(), Stopped> {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .map_err(|err| stop(Failure::IntegrityFailed, format!("integrity check would not run: {err}")))?;
    verified.integrity = integrity == "ok";
    if !verified.integrity {
        return Err(stop(Failure::IntegrityFailed, format!("SQLite reports: {integrity}")));
    }

    verified.schema_version = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await
        .map_err(|err| {
            stop(Failure::DatabaseUnopenable, format!("the restored file has no migration history: {err}"))
        })?;
    let unfinished: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 0")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if unfinished > 0 {
        return Err(stop(
            Failure::MigrationsIncomplete,
            format!("{unfinished} migration(s) in the archive are recorded as applied but not successful"),
        ));
    }

    verified.signing_keys = count(pool, "server_keys").await.unwrap_or(0);
    verified.push_keys = count(pool, "vapid_key").await.unwrap_or(0);
    verified.auth_secrets = count(pool, "opaque_server_state").await;
    verified.accounts = count(pool, "accounts").await.unwrap_or(0);
    verified.devices = count(pool, "devices").await.unwrap_or(0);
    verified.guilds = count(pool, "guilds").await.unwrap_or(0);
    verified.messages = count(pool, "messages").await.unwrap_or(0);

    if verified.signing_keys == 0 {
        return Err(stop(
            Failure::MissingSigningKey,
            "the database in the archive has no rows in server_keys",
        ));
    }
    if verified.push_keys == 0 {
        return Err(stop(
            Failure::MissingPushKey,
            "the database in the archive has no rows in vapid_key",
        ));
    }
    Ok(())
}

async fn count(pool: &SqlitePool, table: &str) -> Option<i64> {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}")).fetch_one(pool).await.ok()
}

fn part_warnings(cfg: &Config, manifest: &format::Manifest, verified: &Verified) -> Vec<String> {
    let mut out = Vec::new();
    let has = |kind: &str| verified.parts.iter().any(|p| p.kind == kind);

    for e in &manifest.excluded {
        if e.reason == "disabled" {
            continue;
        }
        out.push(format!("the archive drilled says {}", super::excluded_sentence(e)));
    }
    let non_empty = |dir: &Path| dir.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false);
    if cfg.backup.include_media && non_empty(&cfg.media_dir) && !has("media") {
        out.push(
            "include_media is on and this server has a media store, but the archive drilled \
             carries no media part: a restore from it would come back without attachments"
                .into(),
        );
    }
    if non_empty(&cfg.archive.dir) && !has("cold") {
        out.push(
            "this server has cold-storage segments and the archive drilled carries no cold part: \
             a restore from it would come back without archived history"
                .into(),
        );
    }
    out
}

async fn drift_warnings(
    live: Option<&SqlitePool>,
    verified: &Verified,
) -> Result<Vec<String>, Stopped> {
    let mut out = Vec::new();
    let Some(live) = live else { return Ok(out) };

    if let Some(live_auth) = count(live, "opaque_server_state").await {
        if live_auth > 0 && verified.auth_secrets.unwrap_or(0) == 0 {
            return Err(stop(
                Failure::MissingAuthSecret,
                "this server holds OPAQUE server state and the archive's database does not",
            ));
        }
    }
    if let Some(live_accounts) = count(live, "accounts").await {
        if live_accounts > verified.accounts {
            out.push(format!(
                "this server has {live_accounts} account(s) and the archive drilled has {}; \
                 the difference registered after it was taken",
                verified.accounts
            ));
        }
    }
    Ok(out)
}

fn sweep_old_scratch(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(SCRATCH_PREFIX) && entry.path().is_dir() {
            tracing::warn!(
                target: crate::logcat::BACKUP,
                path = %entry.path().display(),
                "removing a drill scratch directory a previous run left behind; it held a \
                 decrypted copy of the database"
            );
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

const SETTLE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

pub fn due_in(cfg: &Config, status: &Status) -> std::time::Duration {
    let interval = cfg.backup.drill_interval_secs.max(300);
    let Some(last) = status.last_drill.as_ref() else {
        return SETTLE;
    };
    let age = ((now_ms() - last.at).max(0) / 1000) as u64;
    let remaining = std::time::Duration::from_secs(interval.saturating_sub(age));
    remaining.max(SETTLE)
}

pub fn nag(cfg: &Config, status: &Status) {
    if !cfg.backup.enabled || !cfg.backup.drill {
        return;
    }
    match verdict(cfg, status.last_drill.as_ref()) {
        Verdict::Passed => {}
        Verdict::NeverRun => tracing::error!(
            target: crate::logcat::BACKUP,
            "no restore drill has ever completed here: nothing has confirmed that the archives on \
             this server can actually be restored"
        ),
        Verdict::Failed => {
            let drill = status.last_drill.as_ref();
            tracing::error!(
                target: crate::logcat::BACKUP,
                failure = drill.and_then(|d| d.failure).map(|f| format!("{f:?}")),
                source = drill.map(|d| d.source.as_str()),
                archive = drill.map(|d| d.archive.as_str()),
                reason = drill.and_then(|d| d.error.as_deref()),
                "THE LAST RESTORE DRILL FAILED: this server cannot currently be recovered from its \
                 newest archive"
            );
        }
        Verdict::Stale => tracing::error!(
            target: crate::logcat::BACKUP,
            hours = status.last_drill.as_ref().map(|d| (now_ms() - d.at) / 3_600_000),
            "the last restore drill passed too long ago to be an answer to whether this server \
             could be recovered now"
        ),
    }
}

pub fn spawn(pool: SqlitePool, cfg: std::sync::Arc<Config>) {
    if !cfg.backup.enabled || !cfg.backup.drill {
        if cfg.backup.enabled {
            tracing::warn!(
                target: crate::logcat::BACKUP,
                "restore drills are off: nothing on this server will check that its archives can \
                 be restored until somebody runs `telium-server backup drill`"
            );
        }
        return;
    }
    nag(&cfg, &super::read_status(&cfg.backup.dir));
    tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(cfg.backup.drill_interval_secs.max(300));
        tokio::time::sleep(due_in(&cfg, &super::read_status(&cfg.backup.dir))).await;
        loop {
            let drill = run(&cfg, Some(&pool)).await;
            if drill.ok {
                tracing::info!(
                    target: crate::logcat::BACKUP,
                    source = %drill.source,
                    archive = %drill.archive,
                    took_ms = drill.took_ms,
                    accounts = drill.verified.as_ref().map(|v| v.accounts),
                    "restore drill passed: the newest archive decrypts, unpacks and opens"
                );
                for warning in &drill.warnings {
                    tracing::warn!(target: crate::logcat::BACKUP, %warning, "restore drill");
                }
            }
            nag(&cfg, &super::read_status(&cfg.backup.dir));
            tokio::time::sleep(interval).await;
        }
    });
}
