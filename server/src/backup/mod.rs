
pub mod drill;
pub mod format;
pub mod s3;

use crate::config::Config;
use crate::util::now_ms;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use format::{Manifest, Part};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use s3::S3Client;

pub const ARCHIVE_EXT: &str = "tbk";
const STATUS_FILE: &str = "status.json";
const DB_ENTRY: &str = "db/telium.db";
const MEDIA_SKIP: &[&str] = &["cache", "camo"];

pub type Key = [u8; 32];

fn decode_key(text: &str) -> anyhow::Result<Key> {
    let bytes = STANDARD
        .decode(text.trim())
        .map_err(|_| anyhow::anyhow!("backup key is not valid base64"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("backup key must decode to exactly 32 bytes"))
}

pub fn load_key(cfg: &Config) -> anyhow::Result<Option<Key>> {
    if let Ok(env) = std::env::var("TELIUM_BACKUP_KEY") {
        if !env.trim().is_empty() {
            return decode_key(&env).map(Some).map_err(|e| anyhow::anyhow!("TELIUM_BACKUP_KEY: {e}"));
        }
    }
    read_key_file(&cfg.backup.key_file)
}

pub fn read_key_file(path: &Path) -> anyhow::Result<Option<Key>> {
    match std::fs::read_to_string(path) {
        Ok(text) => decode_key(&text)
            .map(Some)
            .map_err(|e| anyhow::anyhow!("{}: {e}", path.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::anyhow!("reading {}: {e}", path.display())),
    }
}

pub struct Keyring {
    pub current: Option<Key>,
    pub retired: Vec<Key>,
}

impl Keyring {
    pub fn all(&self) -> Vec<Key> {
        self.current.into_iter().chain(self.retired.iter().copied()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.current.is_none() && self.retired.is_empty()
    }

    pub fn of(key: Key) -> Self {
        Keyring { current: Some(key), retired: Vec::new() }
    }

    pub fn open(&self, path: &Path) -> anyhow::Result<Key> {
        let keys = self.all();
        if keys.is_empty() {
            anyhow::bail!(
                "no backup key is configured, so {} cannot be opened. Put the key back at \
                 backup.key_file, set TELIUM_BACKUP_KEY, or pass --key.",
                path.display()
            );
        }
        for key in &keys {
            if peek(path, key).is_ok() {
                return Ok(*key);
            }
        }
        anyhow::bail!(
            "none of the {} configured backup key(s) opens {}. An archive is sealed under the \
             key that was current when it was written: if this one is older than your last \
             rotation, add the key it was sealed under to backup.previous_key_files. If it is \
             not one of this server's archives, it never will open.",
            keys.len(),
            path.display()
        )
    }
}

pub fn load_keyring(cfg: &Config) -> anyhow::Result<Keyring> {
    let current = load_key(cfg)?;
    let mut retired = Vec::new();
    for path in &cfg.backup.previous_key_files {
        let key = read_key_file(path)?.ok_or_else(|| {
            anyhow::anyhow!(
                "backup.previous_key_files names {} and it is not there. Archives sealed under \
                 that key cannot be opened without it.",
                path.display()
            )
        })?;
        if Some(key) != current && !retired.contains(&key) {
            retired.push(key);
        }
    }
    Ok(Keyring { current, retired })
}

pub fn keygen(path: &Path) -> anyhow::Result<Key> {
    let mut key = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut key);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            anyhow::anyhow!(
                "{} already exists; not overwriting a key that archives may depend on",
                path.display()
            )
        } else {
            anyhow::anyhow!("creating {}: {e}", path.display())
        }
    })?;
    file.write_all(STANDARD.encode(key).as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(key)
}

pub fn load_or_create_key(cfg: &Config) -> anyhow::Result<Key> {
    if let Some(key) = load_key(cfg)? {
        return Ok(key);
    }
    let key = keygen(&cfg.backup.key_file)?;
    let path = std::fs::canonicalize(&cfg.backup.key_file).unwrap_or_else(|_| cfg.backup.key_file.clone());
    tracing::error!(
        target: crate::logcat::BACKUP,
        path = %path.display(),
        "GENERATED A NEW BACKUP KEY. Every backup is sealed under it and is unreadable without it. \
         Copy this file somewhere that is not this machine, now."
    );
    Ok(key)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Status {
    pub last_local_at: Option<i64>,
    pub last_local_path: Option<String>,
    pub last_local_schema: Option<i64>,
    pub last_remote_at: Option<i64>,
    pub last_remote_key: Option<String>,
    pub last_error: Option<String>,
    pub last_error_at: Option<i64>,
    pub last_remote_error: Option<String>,
    pub last_drill: Option<drill::Drill>,
    pub last_drill_pass: Option<i64>,
    pub last_pre_migration: Option<PreMigration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreMigration {
    pub at: i64,
    pub from: i64,
    pub to: i64,
    pub ok: bool,
    pub archive: Option<String>,
    pub error: Option<String>,
}

pub fn read_status(dir: &Path) -> Status {
    std::fs::read(dir.join(STATUS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_status(dir: &Path, status: &Status) {
    let tmp = dir.join(format!(".{STATUS_FILE}.tmp"));
    let write = || -> io::Result<()> {
        std::fs::write(&tmp, serde_json::to_vec_pretty(status).unwrap_or_default())?;
        std::fs::rename(&tmp, dir.join(STATUS_FILE))
    };
    if let Err(err) = write() {
        tracing::warn!(target: crate::logcat::BACKUP, %err, "could not write backup status");
    }
}

pub fn report(cfg: &Config) -> serde_json::Value {
    let b = &cfg.backup;
    let stale_after_ms = b.stale_after_secs.saturating_mul(1000);
    let status = read_status(&b.dir);
    let local_age = newest_age_ms(&b.dir);
    let local_stale = b.enabled && local_age.map(|age| age > stale_after_ms).unwrap_or(true);
    let remote_enabled = b.enabled && b.remote.enabled;
    let remote_age = status.last_remote_at.map(|at| now_ms() - at);
    let remote_stale = remote_enabled && remote_age.map(|age| age > stale_after_ms).unwrap_or(true);
    let drill = drill::report(cfg, &status);
    serde_json::json!({
        "enabled": b.enabled,
        "age_ms": local_age,
        "stale": local_stale || remote_stale,
        "encrypted": true,
        "placement": placement(cfg).as_str(),
        "offsite": remote_enabled,
        "key_stranded": key_is_stranded(cfg),
        "excluded": excluded(cfg).iter().map(|e| serde_json::json!({
            "kind": e.kind,
            "reason": e.reason,
            "detail": e.detail,
            "says": excluded_sentence(e),
        })).collect::<Vec<_>>(),
        "last_error": status.last_error,
        "schema_version": crate::db::latest_migration_version(),
        "last_archive_schema": status.last_local_schema,
        "pre_migration": status.last_pre_migration,
        "drill": drill,
        "remote": {
            "enabled": remote_enabled,
            "age_ms": remote_age,
            "stale": remote_stale,
            "last_error": status.last_remote_error,
        },
    })
}

pub fn excluded(cfg: &Config) -> Vec<format::Excluded> {
    let mut out = Vec::new();
    let s3 = |r: &crate::config::Remote| {
        (!r.bucket.is_empty()).then(|| match r.prefix.trim_matches('/') {
            "" => format!("s3://{}", r.bucket),
            prefix => format!("s3://{}/{prefix}", r.bucket),
        })
    };

    // `include_media = false` wins.
    if !cfg.backup.include_media {
        out.push(format::Excluded {
            kind: "media".into(),
            reason: "disabled".into(),
            detail: None,
        });
    } else if cfg.media_store.store == crate::config::StoreBackend::S3 {
        out.push(format::Excluded {
            kind: "media".into(),
            reason: "object-store".into(),
            detail: s3(&cfg.media_store.s3),
        });
    }

    if cfg.archive.enabled && cfg.archive.store == crate::config::StoreBackend::S3 {
        out.push(format::Excluded {
            kind: "cold".into(),
            reason: "object-store".into(),
            detail: s3(&cfg.archive.s3),
        });
    }
    out
}

pub fn excluded_sentence(e: &format::Excluded) -> String {
    let where_it_is = e.detail.as_deref().unwrap_or("an object store");
    match (e.kind.as_str(), e.reason.as_str()) {
        ("cold", "object-store") => format!(
            "cold archive segments are in {where_it_is} and are not in the backup: they are the              only copy of the messages the sweep moved out of the database"
        ),
        ("media", "object-store") => format!(
            "media is in {where_it_is} and is not in the backup: a restore brings back the              database and every attachment in it would 404"
        ),
        ("media", "disabled") => {
            "media is excluded by backup.include_media = false".to_string()
        }
        _ => format!("{} is not in the backup ({})", e.kind, e.reason),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Inside,
    SameDevice,
    Separate,
    Unknown,
}

impl Placement {
    pub fn as_str(self) -> &'static str {
        match self {
            Placement::Inside => "inside",
            Placement::SameDevice => "same-device",
            Placement::Separate => "separate",
            Placement::Unknown => "unknown",
        }
    }
}

fn data_roots(cfg: &Config) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(db) = db_path(cfg) {
        roots.push(db.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(".")));
    }
    roots.push(cfg.media_dir.clone());
    roots.push(cfg.archive.dir.clone());
    roots
}

fn settled(path: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&cur) {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return Some(out);
        }
        tail.push(cur.file_name()?.to_os_string());
        cur = match cur.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            Some(_) => PathBuf::from("."),
            None => return None,
        };
    }
}

fn device_of(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let mut cur = path.to_path_buf();
        loop {
            if let Ok(meta) = std::fs::metadata(&cur) {
                return Some(meta.dev());
            }
            cur = match cur.parent() {
                Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
                _ => return None,
            };
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

pub fn placement(cfg: &Config) -> Placement {
    let Some(archives) = settled(&cfg.backup.dir) else {
        return Placement::Unknown;
    };
    let roots = data_roots(cfg);
    let data: Vec<PathBuf> = roots.iter().filter_map(|p| settled(p)).collect();
    if data.is_empty() {
        return Placement::Unknown;
    }
    if data.iter().any(|d| d.starts_with(&archives) || archives.starts_with(d)) {
        return Placement::Inside;
    }
    let Some(archive_dev) = device_of(&cfg.backup.dir) else {
        return Placement::Unknown;
    };
    let devices: Vec<u64> = roots.iter().filter_map(|p| device_of(p)).collect();
    if devices.is_empty() {
        Placement::Unknown
    } else if devices.contains(&archive_dev) {
        Placement::SameDevice
    } else {
        Placement::Separate
    }
}

pub fn key_is_stranded(cfg: &Config) -> bool {
    let (Some(key), Some(archives)) = (settled(&cfg.backup.key_file), settled(&cfg.backup.dir)) else {
        return false;
    };
    let roots = data_roots(cfg);
    let data: Vec<PathBuf> = roots.iter().filter_map(|p| settled(p)).collect();
    let key_in_data = data.iter().any(|d| key.starts_with(d));
    let archives_in_data = data.iter().any(|d| archives.starts_with(d) || d.starts_with(&archives));
    key_in_data && !archives_in_data
}

pub fn log_placement(cfg: &Config) {
    let remote = cfg.backup.remote.enabled;
    let dir = cfg.backup.dir.display().to_string();
    let placed = placement(cfg);
    match placed {
        Placement::Inside if !remote => tracing::error!(
            target: crate::logcat::BACKUP,
            %dir,
            "THE ONLY BACKUP IS INSIDE THE DATA IT IS A BACKUP OF. Removing the volume, the data \
             directory or the deployment takes the archives with it, and no [backup.remote] is \
             configured. Point backup.dir at storage that is not the data store."
        ),
        Placement::Inside => tracing::warn!(
            target: crate::logcat::BACKUP,
            %dir,
            "backup.dir is inside the data it is backing up; only the uploaded copy would survive \
             losing the data store"
        ),
        Placement::SameDevice if !remote => tracing::warn!(
            target: crate::logcat::BACKUP,
            %dir,
            "backups are on the same filesystem as the data: they survive the volume being \
             removed, not the disk failing, and no [backup.remote] is configured"
        ),
        Placement::Separate if !remote => tracing::warn!(
            target: crate::logcat::BACKUP,
            %dir,
            "backups stay on this machine: no [backup.remote] is configured, so losing the box \
             loses them too"
        ),
        _ => tracing::info!(target: crate::logcat::BACKUP, %dir, placement = placed.as_str(), offsite = remote, "backup destination"),
    }
    if key_is_stranded(cfg) {
        tracing::error!(
            target: crate::logcat::BACKUP,
            key_file = %cfg.backup.key_file.display(),
            "the backup key is in the data store and the archives are not: losing the data store \
             would leave archives nobody can decrypt. Move key_file out with them, and keep a copy \
             off this machine."
        );
    }
    for e in excluded(cfg) {
        if e.reason == "disabled" {
            tracing::info!(target: crate::logcat::BACKUP, kind = %e.kind, "{}", excluded_sentence(&e));
        } else {
            tracing::warn!(target: crate::logcat::BACKUP, kind = %e.kind, detail = e.detail.as_deref(), "{}", excluded_sentence(&e));
        }
    }
}

#[derive(Debug)]
pub struct Outcome {
    pub path: PathBuf,
    pub manifest: Manifest,
    pub remote_key: Option<String>,
    pub remote_error: Option<String>,
}

pub fn archive_name(stamp: i64) -> String {
    format!("telium-{stamp}.{ARCHIVE_EXT}")
}

fn archive_stamp(name: &str) -> Option<i64> {
    name.strip_prefix("telium-")?
        .strip_suffix(&format!(".{ARCHIVE_EXT}"))?
        .parse::<i64>()
        .ok()
}

struct Scratch(Vec<PathBuf>);

impl Drop for Scratch {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub async fn run_once(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<Outcome> {
    let cfg = cfg.clone();
    let dir = cfg.backup.dir.clone();
    std::fs::create_dir_all(&dir)?;
    let mut status = read_status(&dir);

    let result = write_archive(pool, &cfg).await;
    let (path, manifest, sha256) = match result {
        Ok(v) => v,
        Err(e) => {
            status.last_error = Some(format!("local backup failed: {e:#}"));
            status.last_error_at = Some(now_ms());
            write_status(&dir, &status);
            return Err(e);
        }
    };
    prune(&dir, cfg.backup.keep)?;
    status.last_local_at = Some(manifest.created_at);
    status.last_local_path = Some(path.display().to_string());
    status.last_local_schema = Some(manifest.schema_version);
    status.last_error = None;
    status.last_error_at = None;
    write_status(&dir, &status);

    let mut outcome = Outcome { path: path.clone(), manifest, remote_key: None, remote_error: None };
    if cfg.backup.remote.enabled {
        match upload(&cfg, &path, sha256).await {
            Ok(key) => {
                status.last_remote_at = Some(now_ms());
                status.last_remote_key = Some(key.clone());
                status.last_remote_error = None;
                outcome.remote_key = Some(key);
            }
            Err(e) => {
                let msg = format!("{e:#}");
                status.last_error = Some(format!("upload failed: {msg}"));
                status.last_error_at = Some(now_ms());
                status.last_remote_error = Some(msg.clone());
                outcome.remote_error = Some(msg);
            }
        }
        write_status(&dir, &status);
    }
    Ok(outcome)
}

async fn write_archive(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<(PathBuf, Manifest, [u8; 32])> {
    let key = load_key(cfg)?.ok_or_else(|| {
        anyhow::anyhow!(
            "no backup key at {} (run `telium-server backup keygen`, or set TELIUM_BACKUP_KEY)",
            cfg.backup.key_file.display()
        )
    })?;
    let dir = cfg.backup.dir.clone();
    let stamp = now_ms();
    let snapshot = dir.join(format!(".snapshot-{stamp}.db"));
    let payload = dir.join(format!(".payload-{stamp}.tar.gz"));
    let partial = dir.join(format!(".{}.part", archive_name(stamp)));
    let final_path = dir.join(archive_name(stamp));
    let scratch = Scratch(vec![snapshot.clone(), payload.clone(), partial.clone()]);

    // VACUUM INTO refuses to overwrite, which is wanted.
    let target = snapshot.to_string_lossy().replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{target}'")).execute(pool).await?;
    let schema_version: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(pool)
        .await?;

    let cfg = cfg.clone();
    let done = final_path.clone();
    let out = tokio::task::spawn_blocking(move || -> anyhow::Result<(Manifest, [u8; 32])> {
        let (parts, payload_bytes, payload_sha256) = build_payload(&cfg, &snapshot, &payload)?;
        let manifest = Manifest {
            format: format::VERSION,
            server_name: cfg.server_name.clone(),
            created_at: stamp,
            schema_version,
            telium_version: env!("CARGO_PKG_VERSION").into(),
            parts,
            excluded: excluded(&cfg),
            payload_bytes,
            payload_sha256: hex::encode(payload_sha256),
        };
        let file = std::fs::File::create(&partial)?;
        let mut sealed = format::Writer::new(HashingWriter::new(io::BufWriter::new(file)), &key, &manifest)?;
        let mut src = io::BufReader::new(std::fs::File::open(&payload)?);
        io::copy(&mut src, &mut sealed)?;
        let hashing = sealed.finish()?;
        let (mut buf, sha256, _) = hashing.finish();
        buf.flush()?;
        buf.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        std::fs::rename(&partial, &done)?;
        drop(scratch);
        Ok((manifest, sha256))
    })
    .await??;
    Ok((final_path, out.0, out.1))
}

struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> HashingWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner, hasher: Sha256::new(), bytes: 0 }
    }
    fn finish(self) -> (W, [u8; 32], u64) {
        (self.inner, self.hasher.finalize().into(), self.bytes)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(data)?;
        self.hasher.update(&data[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

struct HashingReader<R: Read> {
    inner: R,
    hasher: Sha256,
    bytes: u64,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(out)?;
        self.hasher.update(&out[..n]);
        self.bytes += n as u64;
        Ok(n)
    }
}

fn build_payload(cfg: &Config, snapshot: &Path, payload: &Path) -> anyhow::Result<(Vec<Part>, u64, [u8; 32])> {
    let file = std::fs::File::create(payload)?;
    let gz = flate2::write::GzEncoder::new(HashingWriter::new(io::BufWriter::new(file)), flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(true);
    let mut parts = Vec::new();

    let db_bytes = std::fs::metadata(snapshot)?.len();
    tar.append_path_with_name(snapshot, DB_ENTRY)?;
    parts.push(Part { kind: "database".into(), name: DB_ENTRY.into(), files: 1, bytes: db_bytes });

    if cfg.archive.dir.is_dir() {
        let (files, bytes) = add_dir(&mut tar, &cfg.archive.dir, Path::new("cold"), &[])?;
        parts.push(Part { kind: "cold".into(), name: "cold".into(), files, bytes });
    }
    if cfg.backup.include_media && cfg.media_dir.is_dir() {
        let (files, bytes) = add_dir(&mut tar, &cfg.media_dir, Path::new("media"), MEDIA_SKIP)?;
        parts.push(Part { kind: "media".into(), name: "media".into(), files, bytes });
    }

    let gz = tar.into_inner()?;
    let hashing = gz.finish()?;
    let (mut buf, sha256, bytes) = hashing.finish();
    buf.flush()?;
    Ok((parts, bytes, sha256))
}

fn add_dir<W: Write>(
    tar: &mut tar::Builder<W>,
    root: &Path,
    prefix: &Path,
    skip: &[&str],
) -> io::Result<(u64, u64)> {
    fn walk<W: Write>(
        tar: &mut tar::Builder<W>,
        dir: &Path,
        rel: &Path,
        skip: &[&str],
        top: bool,
        files: &mut u64,
        bytes: &mut u64,
    ) -> io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<io::Result<_>>()?;
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if top && skip.iter().any(|s| name == *s) {
                continue;
            }
            let path = entry.path();
            let rel = rel.join(&name);
            let meta = std::fs::metadata(&path)?;
            if meta.is_dir() {
                tar.append_dir(&rel, &path)?;
                walk(tar, &path, &rel, skip, false, files, bytes)?;
            } else if meta.is_file() {
                tar.append_path_with_name(&path, &rel)?;
                *files += 1;
                *bytes += meta.len();
            }
        }
        Ok(())
    }
    tar.append_dir(prefix, root)?;
    let (mut files, mut bytes) = (0, 0);
    walk(tar, root, prefix, skip, true, &mut files, &mut bytes)?;
    Ok((files, bytes))
}

fn prune(dir: &Path, keep: usize) -> anyhow::Result<()> {
    let mut archives = local_archives(dir);
    while archives.len() > keep {
        let (oldest, _) = archives.remove(0);
        if let Err(err) = std::fs::remove_file(&oldest) {
            tracing::warn!(target: crate::logcat::BACKUP, path = %oldest.display(), %err, "could not prune old backup");
        }
    }
    Ok(())
}

pub fn local_archives(dir: &Path) -> Vec<(PathBuf, i64)> {
    let mut out: Vec<(PathBuf, i64)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let stamp = archive_stamp(&e.file_name().to_string_lossy())?;
            Some((e.path(), stamp))
        })
        .collect();
    out.sort_by_key(|(_, stamp)| *stamp);
    out
}

pub fn newest_age_ms(dir: &Path) -> Option<i64> {
    let newest = local_archives(dir).last().map(|(_, s)| *s)?;
    Some(now_ms() - newest)
}

pub fn remote(cfg: &Config) -> anyhow::Result<Option<S3Client>> {
    if !cfg.backup.remote.enabled {
        return Ok(None);
    }
    Ok(Some(S3Client::from_config(&cfg.backup.remote)?))
}

async fn upload(cfg: &Config, path: &Path, sha256: [u8; 32]) -> anyhow::Result<String> {
    let client = S3Client::from_config(&cfg.backup.remote)?;
    let prefix = cfg.backup.remote.prefix_for(&cfg.server_name);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let key = format!("{prefix}{name}");
    if client.ensure_bucket().await? {
        tracing::info!(target: crate::logcat::BACKUP, bucket = %cfg.backup.remote.bucket, "created the backup bucket");
    }
    client.upload_file(&key, path, Some(sha256)).await?;
    tracing::info!(target: crate::logcat::BACKUP, %key, "backup uploaded");
    prune_remote(&client, &prefix, cfg.backup.remote.keep).await?;
    Ok(key)
}

pub async fn remote_archives(client: &S3Client, prefix: &str) -> anyhow::Result<Vec<(s3::Object, i64)>> {
    let mut out: Vec<(s3::Object, i64)> = client
        .list(prefix)
        .await?
        .into_iter()
        .filter_map(|o| {
            let stamp = archive_stamp(o.key.strip_prefix(prefix)?)?;
            Some((o, stamp))
        })
        .collect();
    out.sort_by_key(|(_, stamp)| *stamp);
    Ok(out)
}

async fn prune_remote(client: &S3Client, prefix: &str, keep: usize) -> anyhow::Result<()> {
    let mut archives = remote_archives(client, prefix).await?;
    while archives.len() > keep {
        let (oldest, _) = archives.remove(0);
        if let Err(err) = client.delete(&oldest.key).await {
            tracing::warn!(target: crate::logcat::BACKUP, key = %oldest.key, %err, "could not prune old remote backup");
        }
    }
    Ok(())
}

pub fn due_in(cfg: &Config) -> std::time::Duration {
    let interval = cfg.backup.interval_secs.max(60);
    let Some(age_ms) = newest_age_ms(&cfg.backup.dir) else {
        return std::time::Duration::ZERO;
    };
    // A negative age (clock moved back) counts as new, not a backup per restart.
    let age = (age_ms.max(0) / 1000) as u64;
    std::time::Duration::from_secs(interval.saturating_sub(age))
}

fn nag(cfg: &Config) {
    let report = report(cfg);
    if !report["stale"].as_bool().unwrap_or(false) {
        return;
    }
    let local_hours = report["age_ms"].as_i64().map(|a| a / 3_600_000);
    let remote_hours = report["remote"]["age_ms"].as_i64().map(|a| a / 3_600_000);
    if local_hours.is_none() {
        tracing::error!(
            target: crate::logcat::BACKUP,
            dir = %cfg.backup.dir.display(),
            "no backup has ever been written here — there is nothing to restore from"
        );
        return;
    }
    tracing::error!(
        target: crate::logcat::BACKUP,
        ?local_hours,
        ?remote_hours,
        "most recent backup is stale — restore is not currently possible from a recent point"
    );
}

pub fn spawn(pool: SqlitePool, cfg: Arc<Config>) {
    if !cfg.backup.enabled {
        tracing::warn!(target: crate::logcat::BACKUP, "backups are disabled; the operator is on their own for recovery");
        return;
    }
    if let Err(err) = load_or_create_key(&cfg) {
        tracing::error!(target: crate::logcat::BACKUP, %err, "backups cannot run without a key");
        return;
    }
    log_placement(&cfg);
    nag(&cfg);
    tokio::spawn(async move {
        let interval = std::time::Duration::from_secs(cfg.backup.interval_secs.max(60));
        let first = due_in(&cfg);
        if first.is_zero() {
            tracing::info!(target: crate::logcat::BACKUP, "taking the first backup now rather than one interval from now");
        }
        tokio::time::sleep(first).await;
        loop {
            match run_once(&pool, &cfg).await {
                Ok(outcome) => {
                    tracing::info!(target: crate::logcat::BACKUP, path = %outcome.path.display(), "backup written");
                    if let Some(err) = &outcome.remote_error {
                        tracing::error!(target: crate::logcat::BACKUP, %err, "backup upload failed; the copy is on this machine only");
                    }
                }
                Err(err) => tracing::error!(target: crate::logcat::BACKUP, %err, "backup failed"),
            }
            nag(&cfg);
            tokio::time::sleep(interval).await;
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pending {
    pub from: i64,
    pub to: i64,
}

async fn open_unmigrated(cfg: &Config) -> anyhow::Result<SqlitePool> {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    let opts = SqliteConnectOptions::new()
        .filename(db_path(cfg)?)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(10));
    Ok(SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?)
}

pub async fn pending_migrations(cfg: &Config) -> anyhow::Result<Option<Pending>> {
    let path = db_path(cfg)?;
    if !path.is_file() {
        return Ok(None);
    }
    let pool = open_unmigrated(cfg).await?;
    let from: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap_or(0);
    pool.close().await;
    let to = crate::db::latest_migration_version();
    Ok((to > from).then_some(Pending { from, to }))
}

fn archive_at_schema(cfg: &Config, from: i64) -> Option<PathBuf> {
    let key = load_key(cfg).ok().flatten()?;
    let max_age_ms = cfg.backup.interval_secs.saturating_mul(1000) as i64;
    for (path, stamp) in local_archives(&cfg.backup.dir).into_iter().rev() {
        if now_ms().saturating_sub(stamp) > max_age_ms {
            break;
        }
        if peek(&path, &key).map(|m| m.schema_version).unwrap_or(-1) == from {
            return Some(path);
        }
    }
    None
}

pub async fn before_migrations(cfg: &Config) -> anyhow::Result<()> {
    let pending = match pending_migrations(cfg).await {
        Ok(Some(p)) => p,
        Ok(None) => return Ok(()),
        Err(err) => {
            tracing::warn!(target: crate::logcat::BACKUP, %err, "could not tell whether this start will apply migrations");
            return Ok(());
        }
    };
    tracing::warn!(
        target: crate::logcat::BACKUP,
        from = pending.from,
        to = pending.to,
        "this start will migrate the database forward; migrations are not reversible by running \
         them backwards"
    );

    let mut record = PreMigration {
        at: now_ms(),
        from: pending.from,
        to: pending.to,
        ok: false,
        archive: None,
        error: None,
    };
    let fail = |record: &mut PreMigration, message: String| -> anyhow::Result<()> {
        record.error = Some(message.clone());
        if cfg.backup.require_backup_before_migration {
            anyhow::bail!(
                "refusing to migrate from schema {} to {} without a restorable backup: {message}. \
                 Fix the backup, or set backup.require_backup_before_migration = false to start \
                 anyway.",
                record.from,
                record.to
            );
        }
        tracing::error!(
            target: crate::logcat::BACKUP,
            from = record.from,
            to = record.to,
            reason = %message,
            "MIGRATING WITHOUT A BACKUP TAKEN AT THE VERSION BEING LEFT. If these migrations lose \
             data there is nothing to put back."
        );
        Ok(())
    };

    let result = if !cfg.backup.enabled {
        fail(&mut record, "backups are disabled on this server".into())
    } else if !cfg.backup.pre_migration_backup {
        fail(&mut record, "backup.pre_migration_backup is off".into())
    } else if let Some(existing) = archive_at_schema(cfg, pending.from) {
        tracing::info!(
            target: crate::logcat::BACKUP,
            archive = %existing.display(),
            schema = pending.from,
            "a recent archive at the schema version being left already exists; not taking another"
        );
        record.ok = true;
        record.archive = Some(existing.display().to_string());
        Ok(())
    } else {
        match take_pre_migration_backup(cfg).await {
            Ok(path) => {
                tracing::warn!(
                    target: crate::logcat::BACKUP,
                    archive = %path.display(),
                    schema = pending.from,
                    "took a backup before migrating; this is the archive that undoes these \
                     migrations"
                );
                record.ok = true;
                record.archive = Some(path.display().to_string());
                Ok(())
            }
            Err(err) => fail(&mut record, format!("{err:#}")),
        }
    };

    // Written before the `?` so a refusal keeps the record.
    let _ = std::fs::create_dir_all(&cfg.backup.dir);
    let mut status = read_status(&cfg.backup.dir);
    status.last_pre_migration = Some(record);
    write_status(&cfg.backup.dir, &status);
    result
}

async fn take_pre_migration_backup(cfg: &Config) -> anyhow::Result<PathBuf> {
    load_or_create_key(cfg)?;
    let pool = open_unmigrated(cfg).await?;
    let outcome = run_once(&pool, cfg).await;
    pool.close().await;
    let outcome = outcome?;
    if let Some(err) = &outcome.remote_error {
        tracing::error!(target: crate::logcat::BACKUP, %err, "the pre-migration backup was written locally but not uploaded");
    }
    Ok(outcome.path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Path(PathBuf),
    LocalLatest,
    RemoteLatest,
    RemoteKey(String),
}

impl Source {
    pub fn parse(s: &str) -> Self {
        match s {
            "latest" => Source::LocalLatest,
            "s3://latest" => Source::RemoteLatest,
            _ => match s.strip_prefix("s3://") {
                Some(key) => Source::RemoteKey(key.to_string()),
                None => Source::Path(PathBuf::from(s)),
            },
        }
    }
}

pub struct Fetched {
    pub path: PathBuf,
    pub label: String,
    temporary: bool,
}

impl Drop for Fetched {
    fn drop(&mut self) {
        if self.temporary {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub async fn fetch(cfg: &Config, source: &Source) -> anyhow::Result<Fetched> {
    match source {
        Source::Path(p) => {
            if !p.is_file() {
                anyhow::bail!("{} is not a file", p.display());
            }
            Ok(Fetched { path: p.clone(), label: p.display().to_string(), temporary: false })
        }
        Source::LocalLatest => {
            let (path, _) = local_archives(&cfg.backup.dir)
                .pop()
                .ok_or_else(|| anyhow::anyhow!("no archives in {}", cfg.backup.dir.display()))?;
            Ok(Fetched { path: path.clone(), label: path.display().to_string(), temporary: false })
        }
        Source::RemoteLatest | Source::RemoteKey(_) => {
            let client = remote(cfg)?
                .ok_or_else(|| anyhow::anyhow!("no [backup.remote] is configured, so there is nothing to fetch from"))?;
            let prefix = cfg.backup.remote.prefix_for(&cfg.server_name);
            let key = match source {
                Source::RemoteKey(k) if k.contains('/') => k.clone(),
                Source::RemoteKey(k) => format!("{prefix}{k}"),
                _ => remote_archives(&client, &prefix)
                    .await?
                    .pop()
                    .map(|(o, _)| o.key)
                    .ok_or_else(|| anyhow::anyhow!("no archives under s3://{}/{prefix}", cfg.backup.remote.bucket))?,
            };
            std::fs::create_dir_all(&cfg.backup.dir)?;
            let name = key.rsplit('/').next().unwrap_or("download");
            let path = cfg.backup.dir.join(format!(".fetch-{}-{name}", now_ms()));
            let (bytes, _) = client.download(&key, &path).await?;
            tracing::info!(target: crate::logcat::BACKUP, %key, bytes, "downloaded archive");
            Ok(Fetched { path, label: format!("s3://{}/{key}", cfg.backup.remote.bucket), temporary: true })
        }
    }
}

pub fn peek(path: &Path, key: &Key) -> anyhow::Result<Manifest> {
    let file = io::BufReader::new(std::fs::File::open(path)?);
    let reader = format::Reader::open(file, key)?;
    Ok(reader.manifest().clone())
}

pub fn verify(path: &Path, key: &Key) -> anyhow::Result<Manifest> {
    let file = io::BufReader::new(std::fs::File::open(path)?);
    let reader = format::Reader::open(file, key)?;
    let manifest = reader.manifest().clone();
    let mut hashing = HashingReader { inner: reader, hasher: Sha256::new(), bytes: 0 };
    io::copy(&mut hashing, &mut io::sink())?;
    check_payload(&manifest, &hashing)?;
    Ok(manifest)
}

fn check_payload<R: Read>(manifest: &Manifest, hashing: &HashingReader<format::Reader<R>>) -> anyhow::Result<()> {
    if !hashing.inner.finished() {
        anyhow::bail!("archive ended before its final chunk");
    }
    let sha = hex::encode(hashing.hasher.clone().finalize());
    if hashing.bytes != manifest.payload_bytes || sha != manifest.payload_sha256 {
        anyhow::bail!(
            "payload does not match its manifest ({} bytes, sha256 {sha}; manifest says {} bytes, {})",
            hashing.bytes,
            manifest.payload_bytes,
            manifest.payload_sha256
        );
    }
    Ok(())
}

pub fn db_path(cfg: &Config) -> anyhow::Result<PathBuf> {
    use std::str::FromStr as _;
    let opts = sqlx::sqlite::SqliteConnectOptions::from_str(&cfg.database_url)?;
    let path = opts.get_filename().to_path_buf();
    if path.as_os_str().is_empty() || path.to_string_lossy().contains(":memory:") {
        anyhow::bail!("database_url {} is not a file; nothing to restore into", cfg.database_url);
    }
    Ok(path)
}

#[derive(Debug)]
pub struct Restored {
    pub manifest: Manifest,
    pub source: String,
    pub db_path: PathBuf,
    pub media_dir: Option<PathBuf>,
    pub cold_dir: Option<PathBuf>,
    pub moved_aside: Vec<PathBuf>,
}

pub async fn restore(
    cfg: &Config,
    source: &Source,
    keyring: &Keyring,
    yes: bool,
) -> anyhow::Result<Restored> {
    let db = db_path(cfg)?;
    let db_dir = db.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    let db_dir = if db_dir.as_os_str().is_empty() { PathBuf::from(".") } else { db_dir };
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db.display()));
        if side.exists() {
            anyhow::bail!(
                "{} exists: the server appears to be running, or was not shut down cleanly. Stop it \
                 first. If it is stopped, the files {0} and {}-shm belong to the database being \
                 replaced and can be removed.",
                side.display(),
                db.display()
            );
        }
    }
    let occupied: Vec<&Path> = [Some(db.as_path()), Some(cfg.media_dir.as_path()), Some(cfg.archive.dir.as_path())]
        .into_iter()
        .flatten()
        .filter(|p| p.is_file() || p.read_dir().map(|mut d| d.next().is_some()).unwrap_or(false))
        .collect();
    if !occupied.is_empty() && !yes {
        anyhow::bail!(
            "refusing to replace existing data without --yes: {}. The current files would be moved \
             aside, not deleted.",
            occupied.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
        );
    }

    let fetched = fetch(cfg, source).await?;
    // Key chosen after the archive is in hand: a retired key needs the file to be identified.
    let key = keyring.open(&fetched.path)?;
    let manifest = peek(&fetched.path, &key)?;
    let ours = crate::db::latest_migration_version();
    if manifest.schema_version > ours {
        anyhow::bail!(
            "archive was taken at schema version {} but this binary only knows {ours}; upgrade \
             telium-server before restoring it",
            manifest.schema_version
        );
    }

    std::fs::create_dir_all(&db_dir)?;
    let stamp = now_ms();
    let staging = db_dir.join(format!(".telium-restore-{stamp}"));
    std::fs::create_dir_all(&staging)?;
    let unpack = {
        let (path, key, staging) = (fetched.path.clone(), key, staging.clone());
        tokio::task::spawn_blocking(move || -> anyhow::Result<Manifest> {
            let file = io::BufReader::new(std::fs::File::open(&path)?);
            let reader = format::Reader::open(file, &key)?;
            let manifest = reader.manifest().clone();
            let mut hashing = HashingReader { inner: reader, hasher: Sha256::new(), bytes: 0 };
            {
                let gz = flate2::read::GzDecoder::new(&mut hashing);
                let mut tar = tar::Archive::new(gz);
                tar.unpack(&staging).map_err(archive_error)?;
            }
            // Read the gzip trailer and final chunk, or the last-chunk flag is never checked.
            io::copy(&mut hashing, &mut io::sink()).map_err(archive_error)?;
            check_payload(&manifest, &hashing)?;
            if !staging.join(DB_ENTRY).is_file() {
                anyhow::bail!("archive has no database in it");
            }
            Ok(manifest)
        })
        .await?
    };
    let manifest = match unpack {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    // Everything is verified and on the database's filesystem; from here the moves are atomic renames.
    let mut moved_aside = Vec::new();
    let mut aside = |dest: &Path| -> anyhow::Result<()> {
        if dest.exists() {
            let parked = PathBuf::from(format!("{}.pre-restore-{stamp}", dest.display()));
            std::fs::rename(dest, &parked)?;
            moved_aside.push(parked);
        }
        Ok(())
    };
    aside(&db)?;
    move_into_place(&staging.join(DB_ENTRY), &db)?;
    let media_dir = if manifest.parts.iter().any(|p| p.kind == "media") {
        aside(&cfg.media_dir)?;
        move_into_place(&staging.join("media"), &cfg.media_dir)?;
        Some(cfg.media_dir.clone())
    } else {
        None
    };
    let cold_dir = if manifest.parts.iter().any(|p| p.kind == "cold") {
        aside(&cfg.archive.dir)?;
        move_into_place(&staging.join("cold"), &cfg.archive.dir)?;
        Some(cfg.archive.dir.clone())
    } else {
        None
    };
    let _ = std::fs::remove_dir_all(&staging);
    Ok(Restored { manifest, source: fetched.label.clone(), db_path: db, media_dir, cold_dir, moved_aside })
}

fn archive_error(e: io::Error) -> anyhow::Error {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(err) = cur {
        if let Some(verdict) = err.downcast_ref::<format::FormatError>() {
            return anyhow::anyhow!("{verdict}");
        }
        // `io::Error::source` skips the carried error, so look at it directly.
        if let Some(verdict) = err
            .downcast_ref::<io::Error>()
            .and_then(|io| io.get_ref())
            .and_then(|inner| inner.downcast_ref::<format::FormatError>())
        {
            return anyhow::anyhow!("{verdict}");
        }
        cur = err.source();
    }
    anyhow::Error::from(e)
}

fn move_into_place(from: &Path, to: &Path) -> anyhow::Result<()> {
    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_tree(from, to)?;
            if from.is_dir() {
                std::fs::remove_dir_all(from)?;
            } else {
                std::fs::remove_file(from)?;
            }
            Ok(())
        }
    }
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

pub fn human_time(ms: i64) -> String {
    let d = s3::amz_date((ms / 1000).max(0) as u64);
    format!("{}-{}-{} {}:{}:{} UTC", &d[0..4], &d[4..6], &d[6..8], &d[9..11], &d[11..13], &d[13..15])
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = n as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{n} B") } else { format!("{v:.1} {}", UNITS[u]) }
}
