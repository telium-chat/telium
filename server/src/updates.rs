
use crate::config::Updates;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::time::Duration;

const MAX_MANIFEST_BYTES: usize = 512 * 1024;

const MAX_RELEASES: usize = 1000;

const MAX_SIGNATURE_BYTES: usize = 4 * 1024;

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARTIFACT_NAME: usize = 64;
const MAX_ARTIFACT_URL: usize = 2048;

const MAX_PROTOCOL_VERSION: u32 = 10_000;

const MAX_VERSION_COMPONENT: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl Version {
    pub fn parse(raw: &str) -> Option<Version> {
        let mut parts = raw.split('.');
        let mut component = || {
            parts
                .next()?
                .parse::<u64>()
                .ok()
                .filter(|n| *n <= MAX_VERSION_COMPONENT)
        };
        let version = Version {
            major: component()?,
            minor: component()?,
            patch: component()?,
        };
        if parts.next().is_some() {
            return None;
        }
        Some(version)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone)]
pub struct Build {
    pub version: &'static str,
    pub commit: &'static str,
    pub commit_time_ms: i64,
    pub built_at_ms: i64,
}

pub fn build() -> Build {
    Build {
        version: env!("CARGO_PKG_VERSION"),
        commit: env!("TELIUM_BUILD_COMMIT"),
        commit_time_ms: secs_env(env!("TELIUM_BUILD_COMMIT_TIME")),
        built_at_ms: secs_env(env!("TELIUM_BUILD_TIME")),
    }
}

fn secs_env(raw: &str) -> i64 {
    raw.parse::<i64>().unwrap_or(0).saturating_mul(1000)
}

pub fn short_commit(commit: &str) -> &str {
    if commit.len() >= 12 {
        &commit[..12]
    } else {
        commit
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Release {
    pub commit: String,
    pub released_at: i64,
    #[serde(default)]
    pub security: bool,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub protocol: Option<u32>,
    #[serde(default)]
    pub min_protocol: Option<u32>,
    #[serde(default)]
    pub breaking: bool,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub artifacts: BTreeMap<String, Artifact>,
}

impl Release {
    pub fn artifact(&self, name: &str) -> Option<&Artifact> {
        self.artifacts.get(name)
    }

    pub fn parsed_version(&self) -> Option<Version> {
        self.version.as_deref().and_then(Version::parse)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub generated_at: i64,
    #[serde(default)]
    pub releases: Vec<Release>,
}

impl Manifest {
    pub fn channel(&self) -> Vec<&Release> {
        let versioned: Vec<&Release> = self
            .releases
            .iter()
            .filter(|r| r.parsed_version().is_some())
            .collect();
        if versioned.is_empty() {
            self.releases.iter().collect()
        } else {
            versioned
        }
    }

    pub fn latest(&self) -> Option<&Release> {
        self.channel().into_iter().max_by(|a, b| {
            match (a.parsed_version(), b.parsed_version()) {
                (Some(x), Some(y)) => x.cmp(&y).then(a.released_at.cmp(&b.released_at)),
                _ => a.released_at.cmp(&b.released_at),
            }
        })
    }
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(format!("release manifest is larger than {MAX_MANIFEST_BYTES} bytes"));
    }
    let mut manifest: Manifest =
        serde_json::from_slice(bytes).map_err(|e| format!("release manifest is not JSON we understand: {e}"))?;

    manifest.channel = sanitise(&manifest.channel, 64);
    manifest.releases.truncate(MAX_RELEASES);
    manifest.releases.retain(|r| {
        r.commit.len() == 40
            && r.commit.chars().all(|c| c.is_ascii_hexdigit())
            && r.released_at > 0
    });
    for release in &mut manifest.releases {
        release.commit = release.commit.to_ascii_lowercase();
        release.summary = sanitise(&release.summary, 200);
        release.notes = sanitise(&release.notes, 400);
        release.version = release
            .version
            .as_deref()
            .and_then(Version::parse)
            .map(|v| v.to_string());
        if release.protocol.is_some_and(|v| v > MAX_PROTOCOL_VERSION) {
            release.protocol = None;
        }
        if release.min_protocol.is_some_and(|v| v > MAX_PROTOCOL_VERSION) {
            release.min_protocol = None;
        }
        release.artifacts = release
            .artifacts
            .iter()
            .filter_map(|(name, a)| {
                let name = sanitise(name, MAX_ARTIFACT_NAME);
                let url = sanitise(&a.url, MAX_ARTIFACT_URL);
                let sha256 = a.sha256.to_ascii_lowercase();
                (
                    !name.is_empty()
                        && url.starts_with("https://")
                        && sha256.len() == 64
                        && sha256.chars().all(|c| c.is_ascii_hexdigit())
                        && a.size.map(|s| s <= MAX_ARTIFACT_BYTES).unwrap_or(true)
                )
                .then(|| (name, Artifact { url, sha256, size: a.size }))
            })
            .collect();
    }
    if manifest.releases.is_empty() {
        return Err("release manifest names no releases".into());
    }
    Ok(manifest)
}

const STATEMENT_VERSION: &str = "telium-release-manifest-v1";

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestSignature {
    #[serde(default)]
    pub alg: String,
    #[serde(default)]
    pub key_id: String,
    #[serde(default)]
    pub statement: String,
    #[serde(default)]
    pub signature: String,
}

fn statement_for(manifest: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(manifest);
    format!("{STATEMENT_VERSION} sha256={digest:x}")
}

pub fn verify_manifest_signature(
    manifest: &[u8],
    signature_bytes: &[u8],
    public_key_b64: &str,
) -> Result<(), String> {
    if signature_bytes.len() > MAX_SIGNATURE_BYTES {
        return Err(format!("release signature is larger than {MAX_SIGNATURE_BYTES} bytes"));
    }
    let doc: ManifestSignature = serde_json::from_slice(signature_bytes)
        .map_err(|e| format!("release signature is not JSON we understand: {e}"))?;

    if doc.alg != "ed25519" {
        return Err(format!(
            "release signature names algorithm {:?}, and this server only accepts ed25519",
            sanitise(&doc.alg, 32)
        ));
    }

    // Check the statement against the bytes before verifying; otherwise an old signed list can be replayed.
    let expected = statement_for(manifest);
    if doc.statement != expected {
        return Err(
            "release signature is for a different manifest than the one downloaded -- either the \
             manifest was altered in transit or an older signature is being replayed"
                .into(),
        );
    }

    if !crate::crypto::verify_bytes(public_key_b64, expected.as_bytes(), &doc.signature) {
        return Err(format!(
            "release manifest signature does not verify against the configured publisher key{}",
            if doc.key_id.is_empty() {
                String::new()
            } else {
                format!(" (manifest was signed by {})", sanitise(&doc.key_id, 80))
            }
        ));
    }
    Ok(())
}

fn sanitise(raw: &str, max: usize) -> String {
    raw.chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
        .take(max)
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanAction {
    Current,
    Update,
    UnidentifiedBuild,
    NotPublished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub commit: String,
    pub version: Option<String>,
    pub released_at: i64,
    pub security: bool,
    pub summary: String,
    pub artifact: Option<(String, Artifact)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub action: PlanAction,
    pub ours: String,
    pub target: Option<Target>,
    pub missed: usize,
    pub missed_security: bool,
    pub breaking: bool,
    pub notes: Vec<Note>,
}

pub fn plan(ours: &str, manifest: &Manifest, want: Option<&str>, artifact_name: &str) -> Plan {
    if ours.is_empty() {
        return Plan {
            action: PlanAction::UnidentifiedBuild,
            ours: String::new(),
            target: None,
            missed: 0,
            missed_security: false,
            breaking: false,
            notes: Vec::new(),
        };
    }

    let channel = manifest.channel();
    let aimed = match want {
        Some(pin) => match Version::parse(pin) {
            Some(version) => manifest
                .releases
                .iter()
                .find(|r| r.parsed_version() == Some(version)),
            None => manifest.releases.iter().find(|r| r.commit == pin),
        },
        None => manifest.latest(),
    };
    let Some(aimed) = aimed else {
        return Plan { action: PlanAction::NotPublished, ours: ours.to_string(), target: None, missed: 0, missed_security: false, breaking: false, notes: Vec::new() };
    };

    if aimed.commit == ours {
        return Plan { action: PlanAction::Current, ours: ours.to_string(), target: None, missed: 0, missed_security: false, breaking: false, notes: Vec::new() };
    }

    let notes_from = match manifest.releases.iter().find(|r| r.commit == ours) {
        Some(ours_entry) => channel
            .iter()
            .copied()
            .filter(|r| r.released_at > ours_entry.released_at)
            .collect::<Vec<_>>(),
        None => Vec::new(),
    };
    let mut notes: Vec<Note> = notes_from
        .iter()
        .filter(|r| r.breaking || !r.notes.is_empty())
        .map(|r| Note { commit: r.commit.clone(), released_at: r.released_at, breaking: r.breaking, text: r.notes.clone() })
        .collect();
    if (aimed.breaking || !aimed.notes.is_empty())
        && !notes.iter().any(|n| n.commit == aimed.commit)
    {
        notes.push(Note { commit: aimed.commit.clone(), released_at: aimed.released_at, breaking: aimed.breaking, text: aimed.notes.clone() });
    }
    notes.sort_by_key(|n| n.released_at);

    Plan {
        action: PlanAction::Update,
        ours: ours.to_string(),
        target: Some(Target {
            commit: aimed.commit.clone(),
            version: aimed.version.clone(),
            released_at: aimed.released_at,
            security: aimed.security,
            summary: aimed.summary.clone(),
            artifact: aimed
                .artifact(artifact_name)
                .map(|a| (artifact_name.to_string(), a.clone())),
        }),
        missed: notes_from.len(),
        missed_security: notes_from.iter().any(|r| r.security),
        breaking: notes.iter().any(|n| n.breaking),
        notes,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unknown {
    NotYet,
    UnidentifiedBuild,
    Unreachable,
    Unverified,
    NotPublished,
}

impl Unknown {
    pub fn as_str(self) -> &'static str {
        match self {
            Unknown::NotYet => "not_checked_yet",
            Unknown::UnidentifiedBuild => "unidentified_build",
            Unknown::Unreachable => "unreachable",
            Unknown::Unverified => "unverified",
            Unknown::NotPublished => "not_published",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Assessment {
    Disabled,
    Unknown(Unknown),
    Current,
    Behind {
        missed: usize,
        stale_since_ms: i64,
        security: bool,
        latest: String,
        latest_version: Option<String>,
        incompatible: Option<Incompatibility>,
        notes: Vec<Note>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Required {
    Compatibility,
    Security,
}

impl Required {
    pub fn as_str(self) -> &'static str {
        match self {
            Required::Compatibility => "compatibility",
            Required::Security => "security",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Incompatibility {
    pub speaks: u32,
    pub floor: u32,
    pub since: String,
    pub since_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Note {
    pub commit: String,
    pub released_at: i64,
    pub breaking: bool,
    pub text: String,
}

impl Assessment {
    pub fn required(&self) -> Option<Required> {
        match self {
            Assessment::Behind { security, incompatible, .. } => {
                let mut why = None;
                if incompatible.is_some() {
                    why = Some(Required::Compatibility);
                }
                if *security {
                    why = Some(Required::Security);
                }
                why
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Quiet,
    Notice,
    Warn,
    Urgent,
}

pub fn assess(commit: &str, manifest: &Manifest) -> Assessment {
    if commit.is_empty() {
        return Assessment::Unknown(Unknown::UnidentifiedBuild);
    }
    let Some(ours) = manifest.releases.iter().find(|r| r.commit == commit) else {
        return Assessment::Unknown(Unknown::NotPublished);
    };
    let newer: Vec<&Release> = manifest
        .channel()
        .into_iter()
        .filter(|r| r.released_at > ours.released_at)
        .collect();
    if newer.is_empty() {
        return Assessment::Current;
    }
    let stale_since_ms = newer.iter().map(|r| r.released_at).min().unwrap_or(ours.released_at);
    let newest = newer
        .iter()
        .max_by_key(|r| r.released_at)
        .copied()
        .unwrap_or(ours);
    let latest = newest.commit.clone();
    let latest_version = newest.version.clone();
    let incompatible = ours.protocol.and_then(|speaks| {
        newer
            .iter()
            .filter(|r| r.min_protocol.is_some_and(|floor| floor > speaks))
            .min_by_key(|r| r.released_at)
            .map(|r| Incompatibility {
                speaks,
                floor: r.min_protocol.unwrap_or(speaks),
                since: r.commit.clone(),
                since_ms: r.released_at,
            })
    });

    let mut notes: Vec<Note> = newer
        .iter()
        .filter(|r| r.breaking || !r.notes.is_empty())
        .map(|r| Note {
            commit: r.commit.clone(),
            released_at: r.released_at,
            breaking: r.breaking,
            text: r.notes.clone(),
        })
        .collect();
    notes.sort_by_key(|n| n.released_at);

    Assessment::Behind {
        missed: newer.len(),
        stale_since_ms,
        security: newer.iter().any(|r| r.security),
        latest,
        latest_version,
        incompatible,
        notes,
    }
}

#[derive(Debug, Clone)]
pub struct Status {
    pub assessment: Assessment,
    pub last_checked_ms: Option<i64>,
    pub last_error: Option<String>,
    pub failing_since_ms: Option<i64>,
}

impl Status {
    pub fn disabled() -> Self {
        Self { assessment: Assessment::Disabled, last_checked_ms: None, last_error: None, failing_since_ms: None }
    }

    pub fn pending() -> Self {
        Self {
            assessment: Assessment::Unknown(Unknown::NotYet),
            last_checked_ms: None,
            last_error: None,
            failing_since_ms: None,
        }
    }
}

pub fn behind_ms(status: &Status, now: i64) -> Option<i64> {
    match status.assessment {
        Assessment::Behind { stale_since_ms, .. } => Some((now - stale_since_ms).max(0)),
        _ => None,
    }
}

pub fn severity(status: &Status, now: i64, cfg: &Updates) -> Severity {
    let warn_at = cfg.stale_after_days.max(1).saturating_mul(DAY_MS);
    let urgent_at = cfg.urgent_after_days.max(1).saturating_mul(DAY_MS).max(warn_at);
    match status.assessment {
        Assessment::Disabled => Severity::Quiet,
        Assessment::Current => Severity::Quiet,
        Assessment::Unknown(Unknown::NotYet) => Severity::Quiet,
        Assessment::Unknown(_) => {
            let failing_for = status.failing_since_ms.map(|since| now - since).unwrap_or(0);
            if failing_for >= warn_at {
                Severity::Warn
            } else {
                Severity::Notice
            }
        }
        Assessment::Behind { security, stale_since_ms, ref incompatible, .. } => {
            if security {
                return Severity::Urgent;
            }
            if incompatible.is_some() {
                return Severity::Urgent;
            }
            let behind = (now - stale_since_ms).max(0);
            if behind >= urgent_at {
                Severity::Urgent
            } else if behind >= warn_at {
                Severity::Warn
            } else {
                Severity::Notice
            }
        }
    }
}

pub fn describe(status: &Status, now: i64) -> Option<String> {
    match &status.assessment {
        Assessment::Disabled | Assessment::Current => None,
        Assessment::Unknown(Unknown::NotYet) => None,
        Assessment::Unknown(Unknown::UnidentifiedBuild) => Some(
            "this build does not record which commit it came from, so it cannot be compared \
             against published releases"
                .into(),
        ),
        Assessment::Unknown(Unknown::NotPublished) => Some(
            "this build is not in the release manifest, so how current it is cannot be \
             established -- it is not being reported as up to date"
                .into(),
        ),
        Assessment::Unknown(Unknown::Unreachable) => Some(format!(
            "the release manifest could not be read, so how current this server is is unknown{}",
            status.last_error.as_ref().map(|e| format!(": {e}")).unwrap_or_default()
        )),
        Assessment::Unknown(Unknown::Unverified) => Some(format!(
            "the release manifest was refused because it is not signed by the key pinned in \
             updates.manifest_public_key -- check that the pinned key is the project's current \
             publishing key before concluding the manifest was tampered with{}",
            status.last_error.as_ref().map(|e| format!(": {e}")).unwrap_or_default()
        )),
        Assessment::Behind { missed, security, latest, latest_version, incompatible, notes, .. } => {
            let days = behind_ms(status, now).unwrap_or(0) / DAY_MS;
            let plural = if *missed == 1 { "release" } else { "releases" };
            let named = latest_version
                .as_deref()
                .map(|v| v.to_string())
                .unwrap_or_else(|| short_commit(latest).to_string());
            let mut line = format!(
                "this server is {missed} {plural} behind, and has been out of date for {days} days; \
                 the current release is {named}"
            );
            if *security {
                line.push_str(" -- at least one release that was missed was flagged security-relevant");
            }
            if let Some(gap) = incompatible {
                line.push_str(&format!(
                    " -- updating is no longer optional: this build speaks protocol v{} and \
                     release {} accepts nothing older than v{}, so servers and clients on that \
                     release will refuse to talk to this one",
                    gap.speaks,
                    short_commit(&gap.since),
                    gap.floor
                ));
            }
            if !notes.is_empty() {
                let breaking = notes.iter().filter(|n| n.breaking).count();
                line.push_str(&format!(
                    " -- {} of the missed releases carry upgrade notes{}; read them before \
                     updating (GET /_telium/v1/admin/version)",
                    notes.len(),
                    if breaking > 0 { format!(", {breaking} flagged as needing a config or data change") } else { String::new() }
                ));
            }
            Some(line)
        }
    }
}

fn signature_url(cfg: &Updates) -> String {
    if cfg.manifest_signature_url.is_empty() {
        format!("{}.sig", cfg.manifest_url)
    } else {
        cfg.manifest_signature_url.clone()
    }
}

pub async fn read_manifest(cfg: &Updates, allow_http: bool) -> Result<Manifest, (Unknown, String)> {
    let timeout = Duration::from_secs(cfg.timeout_secs.max(1));
    let bytes = crate::federation::feeds::fetch_bytes(
        allow_http,
        crate::federation::feeds::check_url_loose(&cfg.manifest_url, allow_http)
            .map_err(|e| (Unknown::Unreachable, e.to_string()))?,
        MAX_MANIFEST_BYTES,
        timeout,
        "telium-server",
    )
    .await
    .map_err(|e: ApiError| (Unknown::Unreachable, e.to_string()))?;

    if !cfg.manifest_public_key.is_empty() {
        let sig = crate::federation::feeds::fetch_bytes(
            allow_http,
            crate::federation::feeds::check_url_loose(&signature_url(cfg), allow_http)
                .map_err(|e| (Unknown::Unverified, e.to_string()))?,
            MAX_SIGNATURE_BYTES,
            timeout,
            "telium-server",
        )
        .await
        .map_err(|e: ApiError| {
            (
                Unknown::Unverified,
                format!("release signature could not be read: {e}"),
            )
        })?;
        verify_manifest_signature(&bytes, &sig, &cfg.manifest_public_key)
            .map_err(|e| (Unknown::Unverified, e))?;
    }

    parse_manifest(&bytes).map_err(|e| (Unknown::Unreachable, e))
}

pub async fn check_once(state: &AppState) -> Result<Assessment, (Unknown, String)> {
    let manifest = read_manifest(&state.cfg.updates, state.cfg.federation.allow_http).await?;
    Ok(assess(build().commit, &manifest))
}

pub async fn refresh(state: &AppState) {
    let now = now_ms();
    let outcome = check_once(state).await;
    let mut status = state.updates.write().await;
    match outcome {
        Ok(assessment) => {
            status.assessment = assessment;
            status.last_checked_ms = Some(now);
            status.last_error = None;
            status.failing_since_ms = None;
        }
        Err((kind, e)) => {
            if kind == Unknown::Unverified
                || !matches!(status.assessment, Assessment::Behind { .. } | Assessment::Current)
            {
                status.assessment = Assessment::Unknown(kind);
            }
            status.failing_since_ms.get_or_insert(now);
            status.last_error = Some(e);
        }
    }
    let severity = severity(&status, now, &state.cfg.updates);
    let line = describe(&status, now);
    drop(status);
    if let Some(line) = line {
        emit(severity, &line, state);
    }
}

fn emit(severity: Severity, line: &str, state: &AppState) {
    match severity {
        Severity::Quiet => {}
        Severity::Notice => tracing::info!(target: crate::logcat::STARTUP, "{line}"),
        Severity::Warn => tracing::warn!(target: crate::logcat::STARTUP, "{line}"),
        Severity::Urgent => tracing::error!(
            target: crate::logcat::STARTUP,
            "\n\
             ============================================================\n\
             THIS TELIUM SERVER IS RUNNING A STALE RELEASE\n\
             {line}\n\
             \n\
             Updates are applied by /opt/telium/update.sh on a timer. If this\n\
             server is not updating, the timer is off, the update mode is set\n\
             to manual, or a version is pinned in /opt/telium/update.conf.\n\
             Staying on this release is a choice you can make -- write it down\n\
             in TELIUM_PIN_REASON so the next person knows it was one.\n\
             Nobody using {} is affected by this. You are.\n\
             ============================================================",
            state.cfg.server_name
        ),
    }
}

pub fn spawn(state: AppState) {
    if !state.cfg.updates.check {
        tracing::info!(
            target: crate::logcat::STARTUP,
            "update check is off (updates.check = false); this server will not be told when it \
             falls behind, which is the deal you made"
        );
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            refresh(&state).await;
            let cfg = &state.cfg.updates;
            let failing = state.updates.read().await.last_error.is_some();
            let wait = if failing { cfg.retry_secs } else { cfg.check_interval_secs };
            tokio::time::sleep(Duration::from_secs(wait.max(60) as u64)).await;
        }
    });
}

pub fn log_build() {
    let b = build();
    let commit = if b.commit.is_empty() { "unknown".to_string() } else { short_commit(b.commit).to_string() };
    tracing::info!(target: crate::logcat::STARTUP, version = b.version, commit = %commit, "telium build");
}

pub async fn admin_version(
    axum::extract::State(state): axum::extract::State<AppState>,
    auth: crate::auth::HomeAuth,
) -> ApiResult<axum::Json<Value>> {
    crate::federation::routes::require_admin(&state, &auth.user_id).await?;
    let now = now_ms();
    let status = state.updates.read().await.clone();
    let cfg = &state.cfg.updates;
    let b = build();

    let (state_name, detail) = match &status.assessment {
        Assessment::Disabled => ("disabled", json!({})),
        Assessment::Unknown(reason) => ("unknown", json!({ "reason": reason.as_str() })),
        Assessment::Current => ("current", json!({})),
        Assessment::Behind { missed, security, latest, latest_version, stale_since_ms, incompatible, notes } => (
            "behind",
            json!({
                "missed": missed,
                "security": security,
                "latest": latest,
                "latest_version": latest_version,
                "stale_since": stale_since_ms,
                "required": status.assessment.required().map(|r| r.as_str()),
                "incompatible": incompatible.as_ref().map(|gap| json!({
                    "speaks": gap.speaks,
                    "floor": gap.floor,
                    "since": gap.since,
                    "since_at": gap.since_ms,
                })),
                "notes": notes.iter().map(|n| json!({
                    "commit": n.commit,
                    "released_at": n.released_at,
                    "breaking": n.breaking,
                    "notes": n.text,
                })).collect::<Vec<_>>(),
            }),
        ),
    };

    Ok(axum::Json(json!({
        "build": {
            "version": b.version,
            "commit": if b.commit.is_empty() { Value::Null } else { json!(b.commit) },
            "commit_time": if b.commit_time_ms == 0 { Value::Null } else { json!(b.commit_time_ms) },
            "built_at": if b.built_at_ms == 0 { Value::Null } else { json!(b.built_at_ms) },
        },
        "state": state_name,
        "detail": detail,
        "behind_ms": behind_ms(&status, now),
        "severity": match severity(&status, now, cfg) {
            Severity::Quiet => "quiet",
            Severity::Notice => "notice",
            Severity::Warn => "warn",
            Severity::Urgent => "urgent",
        },
        "message": describe(&status, now),
        "check": {
            "enabled": cfg.check,
            "manifest_url": cfg.manifest_url,
            "last_checked": status.last_checked_ms,
            "last_error": status.last_error,
            "interval_secs": cfg.check_interval_secs,
        },
        "thresholds": {
            "stale_after_days": cfg.stale_after_days,
            "urgent_after_days": cfg.urgent_after_days,
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(commit: &str, days_ago: i64, security: bool) -> Release {
        Release {
            commit: commit.repeat(40)[..40].to_string(),
            released_at: 1_700_000_000_000 - days_ago * DAY_MS,
            security,
            ..Release::default()
        }
    }

    fn speaking(commit: &str, days_ago: i64, protocol: u32, min_protocol: u32) -> Release {
        Release {
            protocol: Some(protocol),
            min_protocol: Some(min_protocol),
            ..release(commit, days_ago, false)
        }
    }

    fn manifest(releases: Vec<Release>) -> Manifest {
        Manifest { channel: "main".into(), generated_at: 1_700_000_000_000, releases }
    }

    fn id(c: &str) -> String {
        c.repeat(40)[..40].to_string()
    }

    fn cfg() -> Updates {
        Updates::default()
    }

    fn behind(missed: usize, days: i64, security: bool) -> Status {
        Status {
            assessment: Assessment::Behind {
                missed,
                stale_since_ms: 1_700_000_000_000 - days * DAY_MS,
                security,
                latest: id("a"),
                latest_version: None,
                incompatible: None,
                notes: Vec::new(),
            },
            last_checked_ms: Some(1_700_000_000_000),
            last_error: None,
            failing_since_ms: None,
        }
    }

    #[test]
    fn only_security_or_a_raised_protocol_floor_makes_an_update_required() {
        let sec = Release { security: true, ..speaking("a", 0, 2, 2) };
        let cases = [
            ("ordinary missed release", vec![release("a", 0, false), release("b", 3, false)], None),
            ("floor raised past us", vec![speaking("a", 0, 2, 2), speaking("b", 3, 1, 1)], Some(Required::Compatibility)),
            ("newer protocol still accepts us", vec![speaking("a", 0, 2, 1), speaking("b", 3, 1, 1)], None),
            ("security wins when both apply", vec![sec, speaking("b", 3, 1, 1)], Some(Required::Security)),
        ];
        for (name, releases, want) in cases {
            assert_eq!(assess(&id("b"), &manifest(releases)).required(), want, "{name}");
        }
        let m = manifest(vec![speaking("a", 0, 2, 2), speaking("b", 1, 1, 1)]);
        match assess(&id("b"), &m) {
            Assessment::Behind { incompatible: Some(g), .. } => assert_eq!((g.speaks, g.floor, g.since), (1, 2, id("a"))),
            other => panic!("expected an incompatibility, got {other:?}"),
        }
        let status = Status { assessment: assess(&id("b"), &m), ..behind(0, 0, false) };
        assert_eq!(severity(&status, 1_700_000_000_000, &cfg()), Severity::Urgent, "urgent immediately");
    }

    #[test]
    fn upgrade_notes_are_oldest_first() {
        let noted = |c: &str, days: i64, text: &str| Release { breaking: true, notes: text.into(), ..release(c, days, false) };
        let m = manifest(vec![noted("a", 0, "second"), noted("b", 5, "first"), release("c", 9, false)]);
        match assess(&id("c"), &m) {
            Assessment::Behind { notes, .. } => assert_eq!(notes.iter().map(|n| &n.text).collect::<Vec<_>>(), ["first", "second"]),
            other => panic!("expected to be behind, got {other:?}"),
        }
    }

    #[test]
    fn an_absurd_protocol_floor_is_not_believed() {
        let r = |c: &str, at: i64, min: u32| serde_json::json!({ "commit": id(c), "released_at": at, "protocol": 1, "min_protocol": min });
        let body = serde_json::json!({ "channel": "main", "releases": [r("a", 1_700_000_000_000, 4_000_000_000), r("b", 1_600_000_000_000, 1)] });
        let m = parse_manifest(body.to_string().as_bytes()).expect("parses");
        assert_eq!((m.releases[0].min_protocol, assess(&id("b"), &m).required()), (None, None));
    }

    #[test]
    fn the_newest_release_is_current() {
        let m = manifest(vec![release("a", 0, false), release("b", 3, false), release("c", 9, false)]);
        assert_eq!(assess(&id("a"), &m), Assessment::Current);
    }

    #[test]
    fn the_missed_count_is_the_number_of_releases_after_ours() {
        let m = manifest(vec![release("a", 0, false), release("b", 3, false), release("c", 9, false)]);
        match assess(&id("b"), &m) {
            Assessment::Behind { missed, .. } => assert_eq!(missed, 1),
            other => panic!("expected behind, got {other:?}"),
        }
        match assess(&id("c"), &m) {
            Assessment::Behind { missed, .. } => assert_eq!(missed, 2),
            other => panic!("expected behind, got {other:?}"),
        }
    }

    #[test]
    fn staleness_is_measured_from_the_first_missed_release() {
        let m = manifest(vec![
            release("a", 0, false),
            release("b", 1, false),
            release("c", 9, false),
            release("d", 40, false),
        ]);
        match assess(&id("d"), &m) {
            Assessment::Behind { stale_since_ms, missed, .. } => {
                assert_eq!(missed, 3);
                assert_eq!(stale_since_ms, 1_700_000_000_000 - 9 * DAY_MS);
            }
            other => panic!("expected behind, got {other:?}"),
        }
    }

    #[test]
    fn order_in_the_manifest_does_not_change_the_answer() {
        let sorted = manifest(vec![release("a", 0, false), release("b", 3, false), release("c", 9, false)]);
        let shuffled = manifest(vec![release("c", 9, false), release("a", 0, false), release("b", 3, false)]);
        assert_eq!(assess(&id("b"), &sorted), assess(&id("b"), &shuffled));
        assert_eq!(assess(&id("a"), &shuffled), Assessment::Current);
    }

    #[test]
    fn a_build_that_cannot_be_placed_is_unknown_rather_than_up_to_date() {
        let m = manifest(vec![release("a", 0, false)]);
        assert_eq!(assess("", &m), Assessment::Unknown(Unknown::UnidentifiedBuild));
        assert_eq!(assess(&id("f"), &m), Assessment::Unknown(Unknown::NotPublished));
    }

    #[test]
    fn the_staleness_thresholds_are_inclusive_at_the_boundary() {
        let c = cfg();
        let now = 1_700_000_000_000;
        assert_eq!(c.stale_after_days, 14);
        assert_eq!(c.urgent_after_days, 45);

        let mut nearly = behind(1, 14, false);
        if let Assessment::Behind { stale_since_ms, .. } = &mut nearly.assessment {
            *stale_since_ms += 1;
        }
        assert_eq!(severity(&nearly, now, &c), Severity::Notice);
        assert_eq!(severity(&behind(1, 14, false), now, &c), Severity::Warn);
        assert_eq!(severity(&behind(1, 44, false), now, &c), Severity::Warn);
        assert_eq!(severity(&behind(1, 45, false), now, &c), Severity::Urgent);
        assert_eq!(severity(&behind(9, 1, false), now, &c), Severity::Notice);
    }

    #[test]
    fn being_barely_behind_is_not_shouted_about() {
        assert_eq!(severity(&behind(1, 0, false), 1_700_000_000_000, &cfg()), Severity::Notice);
    }

    #[test]
    fn a_missed_security_release_is_urgent_immediately() {
        assert_eq!(severity(&behind(1, 0, true), 1_700_000_000_000, &cfg()), Severity::Urgent);
    }

    #[test]
    fn a_disabled_check_says_nothing_at_all() {
        let s = Status::disabled();
        assert_eq!(severity(&s, 1_700_000_000_000, &cfg()), Severity::Quiet);
        assert!(describe(&s, 1_700_000_000_000).is_none());
    }

    #[test]
    fn a_check_that_keeps_failing_gets_firmer_but_never_urgent() {
        let now = 1_700_000_000_000;
        let mut s = Status::pending();
        s.assessment = Assessment::Unknown(Unknown::Unreachable);
        s.last_error = Some("connection refused".into());
        s.failing_since_ms = Some(now - DAY_MS);
        assert_eq!(severity(&s, now, &cfg()), Severity::Notice);
        s.failing_since_ms = Some(now - 100 * DAY_MS);
        assert_eq!(severity(&s, now, &cfg()), Severity::Warn);
    }

    #[test]
    fn a_check_that_has_not_run_yet_is_silent() {
        assert_eq!(severity(&Status::pending(), 1_700_000_000_000, &cfg()), Severity::Quiet);
    }

    #[test]
    fn a_manifest_is_bounded_and_its_text_is_scrubbed() {
        let good = br#"{"channel":"main","releases":[
            {"commit":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","released_at":1,"summary":"fine"},
            {"commit":"nope","released_at":2},
            {"commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","released_at":0}
        ]}"#;
        let m = parse_manifest(good).expect("parses");
        assert_eq!(m.releases.len(), 1);
        assert_eq!(m.releases[0].commit, "a".repeat(40));
        assert_eq!(m.releases[0].summary, "fine");

        // Strip control characters: a newline in a release note would forge a log line.
        assert_eq!(sanitise("fine\u{202e}evil\nWARN: all clear", 200), "fineevilWARN: all clear");
        assert_eq!(sanitise(&"x".repeat(500), 200).len(), 200);

        assert!(parse_manifest(b"{}").is_err());
        assert!(parse_manifest(b"not json").is_err());
        assert!(parse_manifest(&vec![b'x'; MAX_MANIFEST_BYTES + 1]).is_err());
    }

    const FIXTURE_MANIFEST: &[u8] =
        b"{\"channel\":\"main\",\"generated_at\":1789855425636,\"releases\":[]}\n";
    const FIXTURE_PUBLIC_KEY: &str = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
    const FIXTURE_SIGNATURE: &str = concat!(
        r#"{"alg":"ed25519","key_id":"ed25519:release-manifest:test","#,
        r#""statement":"telium-release-manifest-v1 "#,
        r#"sha256=45020eb90eaaf5737d7a6b24c2ddd77747cb6aff27c54f120e2cce43d6e79bb9","#,
        r#""signature":"ZidHgoIzu1qYOyfXyznulm_uMgx7d-MxQ9asMmkg7MBFAAvlOvrhEvUduvkrpygesgoLwj4xJaaKpuN2Q23AAg"}"#
    );

    #[test]
    fn release_signatures_verify_only_when_exactly_right() {
        let ok = |m: &[u8], sig: &[u8], key: &str| verify_manifest_signature(m, sig, key).is_ok();
        assert!(ok(FIXTURE_MANIFEST, FIXTURE_SIGNATURE.as_bytes(), FIXTURE_PUBLIC_KEY));
        assert!(statement_for(FIXTURE_MANIFEST).ends_with("sha256=45020eb90eaaf5737d7a6b24c2ddd77747cb6aff27c54f120e2cce43d6e79bb9"));
        assert!(!ok(&[FIXTURE_MANIFEST, b" "].concat(), FIXTURE_SIGNATURE.as_bytes(), FIXTURE_PUBLIC_KEY), "altered manifest");
        assert!(!ok(FIXTURE_MANIFEST, &vec![b'x'; MAX_SIGNATURE_BYTES + 1], FIXTURE_PUBLIC_KEY), "oversized");
        let replayed = FIXTURE_SIGNATURE.replace("45020eb9", "deadbeef");
        let unknown_alg = FIXTURE_SIGNATURE.replace("ed25519\",", "none\",");
        for (sig, key) in [
            (FIXTURE_SIGNATURE, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            (&replayed, FIXTURE_PUBLIC_KEY),
            (&unknown_alg, FIXTURE_PUBLIC_KEY),
            ("", FIXTURE_PUBLIC_KEY),
            ("not json", FIXTURE_PUBLIC_KEY),
            ("{}", FIXTURE_PUBLIC_KEY),
            (r#"{"alg":"ed25519"}"#, FIXTURE_PUBLIC_KEY),
            (FIXTURE_SIGNATURE, ""),
            (FIXTURE_SIGNATURE, "!!!not base64!!!"),
        ] {
            assert!(!ok(FIXTURE_MANIFEST, sig.as_bytes(), key), "accepted {sig:?} / {key:?}");
        }
    }

    #[test]
    fn the_signature_url_defaults_beside_the_manifest_and_no_key_is_pinned_by_default() {
        let mut cfg = Updates::default();
        assert!(cfg.manifest_public_key.is_empty());
        assert_eq!(signature_url(&cfg), format!("{}.sig", cfg.manifest_url));
        cfg.manifest_signature_url = "https://mirror.example/sig".into();
        assert_eq!(signature_url(&cfg), "https://mirror.example/sig");
    }

    #[test]
    fn a_failed_check_does_not_erase_what_was_known() {
        let now = 1_700_000_000_000;
        let mut s = behind(4, 60, false);
        if !matches!(s.assessment, Assessment::Behind { .. } | Assessment::Current) {
            s.assessment = Assessment::Unknown(Unknown::Unreachable);
        }
        s.failing_since_ms.get_or_insert(now);
        s.last_error = Some("dns".into());
        assert_eq!(severity(&s, now, &cfg()), Severity::Urgent);
    }

    #[test]
    fn the_manifest_this_repository_publishes_is_one_this_code_can_read() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../deploy/releases.json");
        let bytes = std::fs::read(path).expect("deploy/releases.json is readable");
        let manifest = parse_manifest(&bytes).expect("deploy/releases.json parses");
        assert!(
            matches!(manifest.channel.as_str(), "main" | "releases"),
            "unexpected channel {:?}",
            manifest.channel
        );
        assert!(!manifest.releases.is_empty());

        let raw: serde_json::Value = serde_json::from_slice(&bytes).expect("valid JSON");
        assert_eq!(manifest.releases.len(), raw["releases"].as_array().unwrap().len());

        let newest = manifest.releases.iter().max_by_key(|r| r.released_at).unwrap().commit.clone();
        assert!(matches!(assess(&newest, &manifest), Assessment::Current));
        let oldest = manifest.releases.iter().min_by_key(|r| r.released_at).unwrap().commit.clone();
        assert!(matches!(assess(&oldest, &manifest), Assessment::Behind { .. }));
    }

    fn versioned(commit: &str, days_ago: i64, version: &str) -> Release {
        Release {
            version: Some(version.into()),
            ..release(commit, days_ago, false)
        }
    }

    #[test]
    fn versions_parse_only_in_the_shape_we_publish() {
        assert_eq!(Version::parse("0.2.0").map(|v| v.to_string()).as_deref(), Some("0.2.0"));
        assert_eq!(Version::parse("10.20.30").map(|v| v.to_string()).as_deref(), Some("10.20.30"));
        for bad in ["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc1", "1.2.x", "-1.2.3", "1..3"] {
            assert_eq!(Version::parse(bad), None, "{bad:?} must not parse");
        }
        assert_eq!(Version::parse("99999999999999999999.0.0"), None);
    }

    #[test]
    fn versions_order_numerically_not_lexicographically() {
        let m = manifest(vec![
            versioned("a", 0, "0.10.0"),
            versioned("b", 3, "0.9.0"),
            versioned("c", 9, "0.2.0"),
        ]);
        assert_eq!(m.latest().expect("a latest").commit, id("a"));
        assert_eq!(plan(&id("b"), &m, None, "server-linux-x86_64").action, PlanAction::Update);
    }

    #[test]
    fn a_version_that_does_not_parse_is_dropped_not_kept_as_text() {
        let body = serde_json::json!({
            "channel": "releases",
            "releases": [
                { "commit": id("a"), "released_at": 2, "version": "1.2.3-rc1" },
                { "commit": id("b"), "released_at": 1, "version": "0.9.0" }
            ]
        });
        let m = parse_manifest(body.to_string().as_bytes()).expect("parses");
        assert_eq!(m.releases.len(), 2, "the entry survives, only the version is dropped");
        assert_eq!(m.releases[0].version, None);
        assert_eq!(m.releases[1].version.as_deref(), Some("0.9.0"));
    }

    #[test]
    fn once_a_version_exists_the_channel_is_the_versioned_releases() {
        let m = manifest(vec![
            versioned("a", 0, "0.2.0"),
            versioned("b", 5, "0.1.0"),
            release("c", 9, false),
            release("d", 20, false),
        ]);
        assert_eq!(m.channel().len(), 2);
        assert_eq!(m.latest().expect("a latest").commit, id("a"));

        match assess(&id("c"), &m) {
            Assessment::Behind { missed, latest, latest_version, .. } => {
                assert_eq!(missed, 2, "the two versioned releases are what it missed");
                assert_eq!(latest, id("a"));
                assert_eq!(latest_version.as_deref(), Some("0.2.0"));
            }
            other => panic!("expected behind, got {other:?}"),
        }
        assert_eq!(assess(&id("d"), &m).required(), None);
    }

    #[test]
    fn without_any_version_the_channel_is_still_every_commit() {
        let m = manifest(vec![release("a", 0, false), release("b", 3, false)]);
        assert_eq!(m.channel().len(), 2);
        assert_eq!(m.latest().expect("a latest").commit, id("a"));
        assert_eq!(plan(&id("a"), &m, None, "server-linux-x86_64").action, PlanAction::Current);
    }

    #[test]
    fn a_pin_accepts_a_version_or_a_commit() {
        let m = manifest(vec![
            versioned("a", 0, "0.2.0"),
            versioned("b", 3, "0.1.0"),
            release("c", 9, false),
        ]);
        let by_version = plan(&id("a"), &m, Some("0.1.0"), "server-linux-x86_64");
        assert_eq!(by_version.action, PlanAction::Update);
        assert_eq!(by_version.target.expect("target").commit, id("b"));

        let by_commit = plan(&id("a"), &m, Some(&id("c")), "server-linux-x86_64");
        assert_eq!(by_commit.target.expect("target").commit, id("c"));

        assert_eq!(plan(&id("a"), &m, Some("9.9.9"), "server-linux-x86_64").action, PlanAction::NotPublished);
    }

    #[test]
    fn the_target_carries_the_version_the_operator_reads() {
        let m = manifest(vec![versioned("a", 0, "0.2.0"), versioned("b", 3, "0.1.0")]);
        let p = plan(&id("b"), &m, None, "server-linux-x86_64");
        let t = p.target.expect("a target");
        assert_eq!(t.version.as_deref(), Some("0.2.0"));
        assert_eq!(t.commit, id("a"));
    }

    fn server_artifact(commit: &str, days_ago: i64) -> Release {
        let mut r = release(commit, days_ago, false);
        r.artifacts.insert(
            "server-linux-x86_64".into(),
            Artifact {
                url: "https://example.invalid/telium-server.tar.gz".into(),
                sha256: "a".repeat(64),
                size: Some(1024),
            },
        );
        r
    }

    #[test]
    fn an_artifact_that_cannot_be_acted_on_is_dropped_not_repaired() {
        let a = |url: &str, sha: &str, size: u64| serde_json::json!({"url": url, "sha256": sha, "size": size});
        let body = serde_json::json!({
            "channel": "main",
            "releases": [{
                "commit": id("a"), "released_at": 1,
                "artifacts": {
                    "server-linux-x86_64": a("https://ok.example/x.tar.gz", &"A".repeat(64), 1024),
                    "plain-http": a("http://example/x.tar.gz", &"a".repeat(64), 1024),
                    "short-digest": a("https://ok.example/x.tar.gz", "abcd", 1024),
                    "not-a-digest": a("https://ok.example/x.tar.gz", &"g".repeat(64), 1024),
                    "": a("https://ok.example/x.tar.gz", &"a".repeat(64), 1024),
                    "enormous": a("https://ok.example/x.tar.gz", &"a".repeat(64), MAX_ARTIFACT_BYTES + 1),
                }
            }]
        });
        let m = parse_manifest(body.to_string().as_bytes()).expect("parses");
        let artifacts = &m.releases[0].artifacts;
        assert_eq!(artifacts.len(), 1, "only the usable artifact survives");
        let kept = artifacts.get("server-linux-x86_64").expect("the https artifact survives");
        assert_eq!(kept.sha256, "a".repeat(64));
    }

    #[test]
    fn the_plan_is_current_only_when_aimed_at_what_this_build_runs() {
        let m = manifest(vec![server_artifact("a", 0), release("b", 3, false)]);
        assert_eq!(plan(&id("a"), &m, None, "server-linux-x86_64").action, PlanAction::Current);

        let p = plan(&id("b"), &m, None, "server-linux-x86_64");
        assert_eq!(p.action, PlanAction::Update);
        let t = p.target.expect("a channel update has a target");
        assert_eq!(t.commit, id("a"));
        assert!(t.artifact.is_some(), "the requested artifact is named");
        assert_eq!(p.missed, 1);
    }

    #[test]
    fn a_pin_aims_the_plan_at_one_release() {
        let m = manifest(vec![server_artifact("a", 0), server_artifact("b", 3), server_artifact("c", 9)]);
        let p = plan(&id("c"), &m, Some(&id("b")), "server-linux-x86_64");
        assert_eq!(p.action, PlanAction::Update);
        assert_eq!(p.target.expect("target").commit, id("b"));
        assert_eq!(p.missed, 2);

        assert_eq!(plan(&id("c"), &m, Some(&id("d")), "server-linux-x86_64").action, PlanAction::NotPublished);
        assert_eq!(plan(&id("b"), &m, Some(&id("b")), "server-linux-x86_64").action, PlanAction::Current);
    }

    #[test]
    fn the_plan_carries_the_missed_notes_oldest_first_and_the_breaking_flag() {
        let noted = |c: &str, days: i64, text: &str| Release {
            breaking: true,
            notes: text.into(),
            ..release(c, days, false)
        };
        let m = manifest(vec![
            release("a", 0, false),
            noted("b", 1, "second"),
            Release { security: true, ..noted("c", 5, "first") },
            release("d", 9, false),
        ]);
        let p = plan(&id("d"), &m, None, "server-linux-x86_64");
        assert_eq!(p.missed, 3);
        assert!(p.missed_security);
        assert!(p.breaking);
        assert_eq!(p.notes.iter().map(|n| &n.text).collect::<Vec<_>>(), ["first", "second"]);
    }

    #[test]
    fn a_build_that_cannot_place_itself_is_not_offered_an_update() {
        let m = manifest(vec![server_artifact("a", 0)]);
        assert_eq!(plan("", &m, None, "server-linux-x86_64").action, PlanAction::UnidentifiedBuild);
        assert_eq!(plan("", &m, Some(&id("a")), "server-linux-x86_64").action, PlanAction::UnidentifiedBuild);
    }

    #[test]
    fn an_update_without_the_requested_artifact_is_still_an_update() {
        let m = manifest(vec![release("a", 0, false), release("b", 3, false)]);
        let p = plan(&id("b"), &m, None, "server-linux-x86_64");
        assert_eq!(p.action, PlanAction::Update);
        assert!(p.target.expect("target").artifact.is_none());
    }

    #[test]
    fn an_unpublished_build_still_gets_the_target_release_note() {
        let noted = Release { breaking: true, notes: "read first".into(), ..release("a", 0, false) };
        let m = manifest(vec![noted]);
        let p = plan(&id("f"), &m, None, "server-linux-x86_64");
        assert_eq!(p.action, PlanAction::Update);
        assert!(p.breaking);
        assert_eq!(p.notes.len(), 1);
        assert_eq!(p.notes[0].text, "read first");
    }

    #[test]
    fn the_repository_manifest_plans_sanely_for_its_own_releases() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../deploy/releases.json");
        let bytes = std::fs::read(path).expect("deploy/releases.json is readable");
        let manifest = parse_manifest(&bytes).expect("deploy/releases.json parses");

        let newest = manifest.releases.iter().max_by_key(|r| r.released_at).unwrap();
        assert!(matches!(plan(&newest.commit, &manifest, None, "server-linux-x86_64").action, PlanAction::Current));
        assert!(
            newest.artifacts.contains_key("server-linux-x86_64")
                && newest.artifacts.contains_key("server-linux-aarch64"),
            "the newest published release carries both native artifacts"
        );

        let oldest = manifest.releases.iter().min_by_key(|r| r.released_at).unwrap().commit.clone();
        let p = plan(&oldest, &manifest, None, "server-linux-x86_64");
        assert_eq!(p.action, PlanAction::Update);
        assert!(p.target.is_some());
    }
}
