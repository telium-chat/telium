use crate::config::{Integrity, IntegrityMode};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

/// Shape of durable state apart from schema; bump when stored values change meaning without a schema change.
pub const STATE_FORMAT_VERSION: i64 = 1;

/// Narrow the database files (and `-wal`/`-shm`) to owner-only; failure is logged, not fatal.
#[cfg(unix)]
fn restrict_database_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt as _;

    // `sqlx` spells an in-memory database with this filename.
    if path.as_os_str() == ":memory:" {
        return;
    }

    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        let target = Path::new(&name);
        // Creating a missing WAL here would race SQLite for the file.
        if !target.exists() {
            continue;
        }
        if let Err(e) = std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!(
                target: crate::logcat::STARTUP,
                path = %target.display(),
                error = %e,
                "could not restrict database file permissions to owner-only;                  check that this file is not readable by other local accounts,                  because it holds this server's federation signing keys"
            );
        }
    }
}

#[cfg(not(unix))]
fn restrict_database_permissions(_path: &Path) {}

pub async fn connect(database_url: &str) -> anyhow::Result<SqlitePool> {
    connect_checked(database_url, &Integrity::default()).await
}

pub async fn connect_checked(
    database_url: &str,
    integrity: &Integrity,
) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        // WAL is what lets the gateway read while the API writes on one file.
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(true);
    let filename = opts.get_filename().to_path_buf();

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await?;

    // Before the downgrade guard: a damaged page yields a confident wrong answer.
    check_integrity(&pool, Role::Primary, integrity).await?;

    open(&pool).await?;

    // After migration so the WAL and shm files exist to be narrowed.
    restrict_database_permissions(filename.as_path());
    Ok(pool)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Primary,
    Mirror,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Depth {
    Off,
    Quick,
    Full,
}

/// `TELIUM_DB_INTEGRITY` overrides `[integrity] startup_check` for one run.
fn depth(integrity: &Integrity) -> Depth {
    match std::env::var("TELIUM_DB_INTEGRITY").ok().as_deref().map(str::trim) {
        Some("off") | Some("none") | Some("0") => Depth::Off,
        Some("quick") => Depth::Quick,
        Some("full") | Some("integrity") => Depth::Full,
        // Unset or a typo falls back to the config.
        _ => match integrity.startup_check {
            IntegrityMode::Off => Depth::Off,
            IntegrityMode::Quick => Depth::Quick,
            IntegrityMode::Full => Depth::Full,
        },
    }
}

const MAX_REPORTED: usize = 8;

/// Refuses to open a database SQLite can tell is damaged, before migrations touch it.
/// `TELIUM_DB_INTEGRITY`: `quick` (default), `full` or `off` (never blocks recovery; logs ERROR).
async fn check_integrity(
    pool: &SqlitePool,
    role: Role,
    integrity: &Integrity,
) -> anyhow::Result<()> {
    let depth = depth(integrity);
    if depth == Depth::Off {
        tracing::error!(
            target: crate::logcat::STARTUP,
            "database integrity checking is off ([integrity] startup_check = \"off\", or \
             TELIUM_DB_INTEGRITY=off): starting without checking the database for corruption. \
             This is a recovery setting. Leaving it set means backups of a damaged database will \
             be taken and will quietly replace the good ones."
        );
        return Ok(());
    }

    let started = std::time::Instant::now();
    let pragma = match depth {
        Depth::Full => "PRAGMA integrity_check",
        // The argument caps problems reported, not pages read.
        _ => "PRAGMA quick_check(1)",
    };
    let verdict: Vec<String> = match sqlx::query_scalar(pragma).fetch_all(pool).await {
        Ok(rows) => rows,
        // A failing pragma is the worst case; fold it into the same message.
        Err(e) => vec![e.to_string()],
    };
    if verdict.iter().any(|line| line != "ok") {
        let more = verdict.len().saturating_sub(MAX_REPORTED);
        let shown = verdict.iter().take(MAX_REPORTED).cloned().collect::<Vec<_>>().join("\n  ");
        let elided = if more > 0 { format!("\n  (and {more} more)") } else { String::new() };
        if !integrity.refuse_start_on_corruption {
            // Salvage: skip the referential check, which reads the same damaged file.
            tracing::error!(
                target: crate::logcat::STARTUP,
                problems = verdict.len(),
                "database integrity check failed: {shown}{elided}"
            );
            tracing::error!(
                target: crate::logcat::STARTUP,
                "starting anyway because [integrity] refuse_start_on_corruption is false; this \
                 server's answers cannot be relied on and writes may compound the damage"
            );
            return Ok(());
        }
        anyhow::bail!(
            "database integrity check failed -- SQLite's {pragma} reports damage:\n  {shown}{elided}\n\n             This server will not start on a damaged database, because continuing to run on one \
             means the next scheduled backup copies the damage and eventually replaces the last \
             good archive. The archives you have now are still good.\n\n             Restore from a backup: stop everything, then `telium-server restore s3://latest`. \
             See docs/runbooks/corrupted-database.md and docs/backup.md.\n\n             To start anyway -- only to extract data from a database you have already decided is \
             beyond repair -- set [integrity] refuse_start_on_corruption = false, or \
             TELIUM_DB_INTEGRITY=off to skip this check entirely."
        );
    }

    // Primary only: finds half-finished deletes, restores and migrations.
    if role == Role::Primary && integrity.foreign_key_check {
        let orphans: Vec<(String, Option<i64>, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check").fetch_all(pool).await?;
        if !orphans.is_empty() {
            let shown: Vec<String> = orphans
                .iter()
                .take(MAX_REPORTED)
                .map(|(table, rowid, parent, _)| {
                    format!("{table} row {} points at a missing {parent}", rowid.unwrap_or(-1))
                })
                .collect();
            let complaint = format!(
                "the database has {} row(s) whose foreign keys point at rows that are not there:\n  {}{}",
                orphans.len(),
                shown.join("\n  "),
                if orphans.len() > shown.len() { "\n  ..." } else { "" },
            );
            if !integrity.refuse_start_on_corruption {
                tracing::error!(target: crate::logcat::STARTUP, violations = orphans.len(), "{complaint}");
                tracing::error!(
                    target: crate::logcat::STARTUP,
                    "starting anyway because [integrity] refuse_start_on_corruption is false; \
                     queries that join these rows will come up empty -- see \
                     docs/data-lifecycle.md"
                );
                return Ok(());
            }
            anyhow::bail!(
                "{complaint}\n\n                 Referential damage like this is what a half-applied migration, a restore of \
                 mismatched parts, an interrupted account erasure, or an edit made directly with \
                 the `sqlite3` shell leaves behind. The pages are sound -- this is not disk \
                 corruption -- but the rows no longer mean what the code assumes they mean.\n\n                 See docs/runbooks/corrupted-database.md and docs/data-lifecycle.md. To start \
                 anyway, set [integrity] refuse_start_on_corruption = false, or \
                 TELIUM_DB_INTEGRITY=off."
            );
        }
    }

    tracing::info!(
        target: crate::logcat::STARTUP,
        check = pragma,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "database integrity check passed"
    );
    Ok(())
}

/// `connect` with foreign keys off: snapshots copy table by table, so a cascade would delete rows the primary holds.
pub async fn connect_without_foreign_keys(database_url: &str) -> anyhow::Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(10))
        .foreign_keys(false);
    let filename = opts.get_filename().to_path_buf();

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await?;

    // Page check only: a bad page found at promotion is too late.
    check_integrity(&pool, Role::Mirror, &Integrity::default()).await?;

    // Same downgrade guard as a primary.
    open(&pool).await?;

    // A replica still holds every message, session and OPAQUE record.
    restrict_database_permissions(filename.as_path());
    Ok(pool)
}

async fn open(pool: &SqlitePool) -> anyhow::Result<()> {
    let found = read_provenance(pool).await?;
    guard_against_downgrade(&found)?;
    sqlx::migrate!("./migrations").run(pool).await?;
    stamp_provenance(pool).await?;
    Ok(())
}

/// Newest migration this binary carries; lets a restore refuse a newer backup early.
pub fn latest_migration_version() -> i64 {
    sqlx::migrate!("./migrations").migrations.last().map(|m| m.version).unwrap_or(0)
}

/// What the database says about the newest binary that opened it; all optional.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Provenance {
    pub applied_migration: Option<i64>,
    pub migration_version: Option<i64>,
    pub state_format_version: Option<i64>,
    pub release_version: Option<String>,
    pub protocol_version: Option<i64>,
    pub applied_at: Option<i64>,
}

impl Provenance {
    /// Newest migration seen, from the migration log or provenance row (each can be missing).
    pub fn migration_high_water(&self) -> i64 {
        self.applied_migration.unwrap_or(0).max(self.migration_version.unwrap_or(0))
    }

    pub fn writer(&self) -> String {
        match &self.release_version {
            Some(release) => format!("telium-server {release}"),
            None => "an unknown release (this database predates provenance recording)".to_string(),
        }
    }
}

pub async fn read_provenance(pool: &SqlitePool) -> anyhow::Result<Provenance> {
    let mut found = Provenance::default();

    // Query `sqlite_master` so a corrupt file isn't read as "table not there".
    let tables: Vec<String> =
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table'")
            .fetch_all(pool)
            .await?;

    if tables.iter().any(|t| t == "_sqlx_migrations") {
        found.applied_migration =
            sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _sqlx_migrations")
                .fetch_one(pool)
                .await?;
    }

    if tables.iter().any(|t| t == "schema_provenance") {
        let row: Option<(i64, i64, String, i64, i64)> = sqlx::query_as(
            "SELECT migration_version, state_format_version, release_version, \
                    protocol_version, applied_at FROM schema_provenance WHERE id = 1",
        )
        .fetch_optional(pool)
        .await?;
        // Migration 0063's seed row says `unrecorded`: no binary has stamped it.
        if let Some((migration, state, release, protocol, at)) = row {
            if release != "unrecorded" {
                found.migration_version = Some(migration);
                found.state_format_version = Some(state);
                found.release_version = Some(release);
                found.protocol_version = Some(protocol);
                found.applied_at = Some(at);
            }
        }
    }

    Ok(found)
}

#[derive(Debug)]
pub struct Downgrade {
    pub found: Provenance,
    pub our_release: &'static str,
    pub our_migration: i64,
    pub our_state_format: i64,
    pub reason: DowngradeReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DowngradeReason {
    NewerSchema,
    NewerStateFormat,
}

impl DowngradeReason {
    pub fn code(&self) -> &'static str {
        match self {
            DowngradeReason::NewerSchema => "database_schema_is_newer",
            DowngradeReason::NewerStateFormat => "database_state_format_is_newer",
        }
    }
}

impl std::fmt::Display for Downgrade {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "refusing to start: this database is newer than this server.")?;
        writeln!(f)?;
        match self.reason {
            DowngradeReason::NewerSchema => {
                writeln!(
                    f,
                    "  what happened   the database has been migrated to schema version {}, \
                     and this binary only carries migrations up to {}.",
                    self.found.migration_high_water(),
                    self.our_migration,
                )?;
            }
            DowngradeReason::NewerStateFormat => {
                writeln!(
                    f,
                    "  what happened   the schema matches, but the release that last opened \
                     this database declared durable state format {}, and this binary \
                     understands format {}. A release only raises that number when it has \
                     changed what stored values mean, so the tables would look readable to \
                     this build and would not be.",
                    self.found.state_format_version.unwrap_or_default(),
                    self.our_state_format,
                )?;
            }
        }
        writeln!(f, "  written by      {}", self.found.writer())?;
        if let Some(protocol) = self.found.protocol_version {
            writeln!(f, "                  speaking Telium protocol v{protocol}")?;
        }
        if let Some(at) = self.found.applied_at {
            writeln!(f, "                  last migrated at {at} (unix ms)")?;
        }
        writeln!(
            f,
            "  you are running telium-server {} (migrations up to {}, state format {}, \
             Telium protocol v{})",
            self.our_release,
            self.our_migration,
            self.our_state_format,
            telium_protocol::compat::PROTOCOL_VERSION,
        )?;
        writeln!(f)?;
        writeln!(f, "  what to do")?;
        writeln!(f, "    * Start {} again. Nothing has been changed by this attempt.", self.found.writer())?;
        writeln!(
            f,
            "    * Or restore the backup taken before that upgrade, which is the only \
             thing that can put the database back into a shape this build understands:"
        )?;
        writeln!(f, "        telium-server restore latest --yes")?;
        writeln!(f, "      Anything written since that backup is lost; see docs/upgrade.md.")?;
        writeln!(f)?;
        write!(
            f,
            "  why it refuses  Opening newer state with older code does not fail loudly. It \
             reads columns whose meaning has changed, writes rows that break invariants it \
             cannot see, and keeps serving users the whole time. The damage is discovered \
             later and is spread across everything touched in between. Not starting is the \
             recoverable outcome; starting is not."
        )
    }
}

impl std::error::Error for Downgrade {}

pub fn guard_against_downgrade(found: &Provenance) -> Result<(), Downgrade> {
    let our_migration = latest_migration_version();
    let our_release = env!("CARGO_PKG_VERSION");

    let reason = if found.migration_high_water() > our_migration {
        Some(DowngradeReason::NewerSchema)
    } else if found.state_format_version.unwrap_or(0) > STATE_FORMAT_VERSION {
        Some(DowngradeReason::NewerStateFormat)
    } else {
        None
    };

    match reason {
        None => Ok(()),
        Some(reason) => Err(Downgrade {
            found: found.clone(),
            our_release,
            our_migration,
            our_state_format: STATE_FORMAT_VERSION,
            reason,
        }),
    }
}

/// Record this start in the provenance row using high-water marks (`MAX`), never lowering.
async fn stamp_provenance(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE schema_provenance SET \
             migration_version    = MAX(migration_version, ?), \
             state_format_version = MAX(state_format_version, ?), \
             protocol_version     = MAX(protocol_version, ?), \
             release_version      = ?, \
             applied_at           = ? \
         WHERE id = 1",
    )
    .bind(latest_migration_version())
    .bind(STATE_FORMAT_VERSION)
    .bind(i64::from(telium_protocol::compat::PROTOCOL_VERSION))
    .bind(env!("CARGO_PKG_VERSION"))
    .bind(crate::util::now_ms())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[tokio::test]
    #[cfg(unix)]
    async fn the_database_is_not_readable_by_other_local_accounts() {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("telium-db-perms-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("telium.db");
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(&path).expect("seed");
        let pool = super::connect(&format!("sqlite://{}", path.display())).await.expect("connect");
        for suffix in ["", "-wal", "-shm"] {
            let target = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            if target.exists() {
                let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600, "{} is mode {mode:o}", target.display());
            }
        }
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_versions_are_unique() {
        let migrations = sqlx::migrate!("./migrations");
        let mut seen = HashSet::new();
        for migration in migrations.migrations.iter() {
            assert!(
                seen.insert(migration.version),
                "duplicate SQLx migration version {} ({})",
                migration.version,
                migration.description,
            );
        }
    }

    #[test]
    fn the_downgrade_guard_refuses_only_newer_schema_or_state_and_says_why() {
        let latest = latest_migration_version();
        let own = Provenance {
            applied_migration: Some(latest),
            migration_version: Some(latest),
            state_format_version: Some(STATE_FORMAT_VERSION),
            release_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            protocol_version: Some(1),
            applied_at: Some(0),
        };
        assert!(guard_against_downgrade(&Provenance::default()).is_ok(), "no provenance");
        assert!(guard_against_downgrade(&own).is_ok(), "own version");

        let err = guard_against_downgrade(&Provenance { applied_migration: Some(latest + 3), ..Default::default() }).unwrap_err();
        assert_eq!(err.reason, DowngradeReason::NewerSchema);
        assert!(err.to_string().contains("unknown release"));

        let state = Provenance { state_format_version: Some(STATE_FORMAT_VERSION + 1), ..own.clone() };
        let err = guard_against_downgrade(&state).unwrap_err();
        assert_eq!(err.reason, DowngradeReason::NewerStateFormat);
        assert!(err.to_string().contains("durable state format"));

        let newer = Provenance {
            applied_migration: Some(latest + 1),
            migration_version: Some(latest + 1),
            release_version: Some("9.9.9".into()),
            protocol_version: Some(4),
            ..own
        };
        let text = guard_against_downgrade(&newer).unwrap_err().to_string();
        let (next, cur) = ((latest + 1).to_string(), latest.to_string());
        for want in ["telium-server 9.9.9", env!("CARGO_PKG_VERSION"), &next, &cur, "telium-server restore", "protocol v4"] {
            assert!(text.contains(want), "missing {want:?}: {text}");
        }
    }
}
