use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// A string that never prints itself (Config derives Debug).
#[derive(Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(transparent)]
pub struct Secret(String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Not even the length; "set" vs "unset" is all a log reader needs.
        f.write_str(if self.0.is_empty() { "<unset>" } else { "<redacted>" })
    }
}

impl std::ops::Deref for Secret {
    type Target = str;
    fn deref(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(s: String) -> Self {
        Secret(s)
    }
}

impl From<&str> for Secret {
    fn from(s: &str) -> Self {
        Secret(s.to_string())
    }
}

/// Substitute `${env:NAME}` and `${file:/path}` references across the whole document.
fn resolve_references(value: toml::Value) -> Result<toml::Value, String> {
    resolve_at(value, "")
}

fn resolve_at(value: toml::Value, path: &str) -> Result<toml::Value, String> {
    let joined = |key: &str| if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
    Ok(match value {
        toml::Value::String(s) => toml::Value::String(resolve_string(&s, path)?),
        toml::Value::Array(items) => toml::Value::Array(
            items
                .into_iter()
                .enumerate()
                .map(|(i, v)| resolve_at(v, &joined(&format!("[{i}]"))))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        toml::Value::Table(table) => toml::Value::Table(
            table
                .into_iter()
                .map(|(k, v)| {
                    let child = joined(&k);
                    resolve_at(v, &child).map(|v| (k, v))
                })
                .collect::<Result<toml::map::Map<_, _>, _>>()?,
        ),
        other => other,
    })
}

fn resolve_string(raw: &str, path: &str) -> Result<String, String> {
    let Some(inner) = raw.strip_prefix("${").and_then(|r| r.strip_suffix('}')) else {
        return Ok(raw.to_string());
    };
    // Unknown `${...}` is an error so a misspelled scheme can't become a password.
    let where_ = if path.is_empty() { "a config value".to_string() } else { format!("`{path}`") };
    if let Some(name) = inner.strip_prefix("env:") {
        let name = name.trim();
        match std::env::var(name) {
            Ok(v) if !v.is_empty() => Ok(v),
            Ok(_) => Err(format!(
                "{where_} refers to ${{env:{name}}} and {name} is set but empty. An empty secret \
                 is not a secret; unset the variable to see this error at the right key, or give \
                 it a value."
            )),
            Err(_) => Err(format!(
                "{where_} refers to ${{env:{name}}} and {name} is not set in this process's \
                 environment. Nothing is substituted and the server does not start, on purpose: \
                 an unset secret that defaulted to empty would fail much later and somewhere else."
            )),
        }
    } else if let Some(file) = inner.strip_prefix("file:") {
        let file = file.trim();
        let text = std::fs::read_to_string(file).map_err(|e| {
            format!(
                "{where_} refers to ${{file:{file}}} and it cannot be read: {e}. Check the path \
                 and that this server's user can read it -- a secret file is usually mode 600 \
                 and owned by somebody else."
            )
        })?;
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(format!("{where_} refers to ${{file:{file}}} and that file is empty"));
        }
        Ok(text)
    } else {
        Err(format!(
            "{where_} contains `{raw}`, which is not a reference this server understands. The \
             forms are `${{env:NAME}}` and `${{file:/path/to/secret}}`, each as the entire value."
        ))
    }
}

/// Example-file shapes refused at load; a test checks each still appears in `telium.example.toml`.
pub(crate) const EXAMPLE_PLACEHOLDERS: &[&str] = &[
    "BASE64-ED25519-PUBLIC-KEY",
    "base64-ed25519-public-key",
    "change-me",
    "ABCDE12345",
    "FGHIJ67890",
];

/// Placeholders from elsewhere; `secret`, `password`, `token`, `key` are absent as plausible real values.
const UNIVERSAL_PLACEHOLDERS: &[&str] = &[
    "changeme",
    "change_me",
    "CHANGEME",
    "CHANGE_ME",
    "CHANGE-ME",
    "replaceme",
    "replace-me",
    "replace_me",
    "REPLACE_ME",
    "REPLACEME",
    "your-secret-here",
    "your_secret_here",
    "yoursecrethere",
    "insert-key-here",
    "placeholder",
    "PLACEHOLDER",
    "xxxxxxxx",
    "hunter2",
    "todo",
    "TODO",
    "FIXME",
];

/// Whole-value match, so a password containing `todo` passes.
fn placeholder_reason(value: &str) -> Option<&'static str> {
    let trimmed = value.trim();
    if EXAMPLE_PLACEHOLDERS.contains(&trimmed) {
        return Some("a placeholder copied out of telium.example.toml");
    }
    if UNIVERSAL_PLACEHOLDERS.contains(&trimmed) {
        return Some("a placeholder value with no honest meaning");
    }
    None
}

/// Runs after reference substitution.
fn refuse_placeholders(value: &toml::Value, path: &str) -> Result<(), String> {
    let joined =
        |key: &str| if path.is_empty() { key.to_string() } else { format!("{path}.{key}") };
    match value {
        toml::Value::String(s) => {
            if let Some(reason) = placeholder_reason(s) {
                let where_ = if path.is_empty() { "a config value" } else { path };
                return Err(format!(
                    "`{where_}` is set to `{}`, which is {reason}. The server refuses to start \
                     on it rather than run with a credential whose value is printed in this \
                     project's own example file. Set it to the real value, or delete the key to \
                     take its default.",
                    s.trim()
                ));
            }
            Ok(())
        }
        toml::Value::Array(items) => items
            .iter()
            .enumerate()
            .try_for_each(|(i, v)| refuse_placeholders(v, &joined(&format!("[{i}]")))),
        toml::Value::Table(table) => {
            table.iter().try_for_each(|(k, v)| refuse_placeholders(v, &joined(k)))
        }
        _ => Ok(()),
    }
}

/// Files referenced by `${file:}` so `secrets` audits their permissions; errors give an empty list (load reports them).
pub fn referenced_secret_files(path: &std::path::Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    let Ok(doc) = toml::from_str::<toml::Value>(&text) else { return Vec::new() };
    let mut out = Vec::new();
    collect_file_references(&doc, &mut out);
    out.sort();
    out.dedup();
    out
}

fn collect_file_references(value: &toml::Value, out: &mut Vec<PathBuf>) {
    match value {
        toml::Value::String(s) => {
            if let Some(inner) = s.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
                if let Some(file) = inner.strip_prefix("file:") {
                    out.push(PathBuf::from(file.trim()));
                }
            }
        }
        toml::Value::Array(items) => items.iter().for_each(|v| collect_file_references(v, out)),
        toml::Value::Table(t) => t.values().for_each(|v| collect_file_references(v, out)),
        _ => {}
    }
}

// Human values. Byte, second, millisecond, day and bit-rate keys accept a
// string written the way an operator says it -- "100MiB", "6h", "2d 12h",
// "250ms", "2.5Mbps" -- beside the plain integer each key has always taken.
// The integer's unit is the one the key name spells out, and a string with no
// unit at all keeps that unit too.

fn split_number_unit(text: &str) -> Result<(f64, String), String> {
    let trimmed = text.trim();
    let split = trimmed
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+'))
        .unwrap_or(trimmed.len());
    let (number, unit) = trimmed.split_at(split);
    let number = number.trim();
    if number.is_empty() {
        return Err(format!("`{text}` has no number in it"));
    }
    let number: f64 =
        number.parse().map_err(|_| format!("`{number}` is not a number"))?;
    if !number.is_finite() || number < 0.0 {
        return Err(format!("`{number}` must be zero or more"));
    }
    Ok((number, unit.trim().to_ascii_lowercase()))
}

const SIZE_GUIDE: &str =
    "sizes look like \"15MB\", \"1GiB\", \"512KiB\" or a plain integer of bytes";

fn parse_size(text: &str) -> Result<i128, String> {
    let (number, unit) = split_number_unit(text)
        .map_err(|e| format!("`{text}` is not a size: {e}; {SIZE_GUIDE}"))?;
    let multiplier = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1e3,
        "m" | "mb" => 1e6,
        "g" | "gb" => 1e9,
        "t" | "tb" => 1e12,
        "ki" | "kib" => 1024.0,
        "mi" | "mib" => 1024.0 * 1024.0,
        "gi" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "ti" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        other => return Err(format!("`{text}`: unknown size unit `{other}`; {SIZE_GUIDE}")),
    };
    Ok((number * multiplier).round() as i128)
}

const DURATION_GUIDE: &str = "durations look like \"90s\", \"10m\", \"6h\", \"1d\", \"2w\", \"1d 12h\" or a plain integer of seconds";

/// A duration is one or more `<number><unit>` chunks, spaces optional between
/// them: "6h", "1d 12h", "1h30m".
fn duration_chunks(text: &str, guide: &str) -> Result<Vec<(f64, String)>, String> {
    let mut chunks = Vec::new();
    let mut rest = text.trim();
    while !rest.is_empty() {
        let number_end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '+'))
            .unwrap_or(rest.len());
        let (number, tail) = rest.split_at(number_end);
        let unit_end = tail
            .find(|c: char| c.is_ascii_digit() || c == '.' || c.is_whitespace())
            .unwrap_or(tail.len());
        let (unit, tail) = tail.split_at(unit_end);
        let number = number.trim();
        let unit = unit.trim().to_ascii_lowercase();
        if number.is_empty() || unit.is_empty() {
            return Err(format!("`{text}` pairs a number and a unit wrongly; {guide}"));
        }
        let number: f64 =
            number.parse().map_err(|_| format!("`{number}` is not a number"))?;
        if !number.is_finite() || number < 0.0 {
            return Err(format!("`{number}` must be zero or more"));
        }
        chunks.push((number, unit));
        rest = tail.trim_start();
    }
    if chunks.is_empty() {
        return Err(format!("`{text}` has no number in it; {guide}"));
    }
    Ok(chunks)
}

fn parse_secs(text: &str) -> Result<i128, String> {
    let mut total = 0.0;
    for (number, unit) in duration_chunks(text, DURATION_GUIDE)
        .map_err(|e| format!("`{text}` is not a duration: {e}"))?
    {
        let multiplier = match unit.as_str() {
            "" | "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
            "d" | "day" | "days" => 24.0 * 3600.0,
            "w" | "wk" | "week" | "weeks" => 7.0 * 24.0 * 3600.0,
            other => {
                return Err(format!(
                    "`{text}`: unknown duration unit `{other}`; {DURATION_GUIDE}"
                ))
            }
        };
        total += number * multiplier;
    }
    Ok(total.round() as i128)
}

const MILLIS_GUIDE: &str =
    "durations look like \"250ms\", \"1.5s\", \"30s\" or a plain integer of milliseconds";

fn parse_millis(text: &str) -> Result<i128, String> {
    let mut total = 0.0;
    for (number, unit) in duration_chunks(text, MILLIS_GUIDE)
        .map_err(|e| format!("`{text}` is not a duration: {e}"))?
    {
        let multiplier = match unit.as_str() {
            "" | "ms" | "millis" | "millisecond" | "milliseconds" => 1.0,
            "s" | "sec" | "secs" | "second" | "seconds" => 1000.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 60.0 * 1000.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0 * 1000.0,
            other => {
                return Err(format!(
                    "`{text}`: unknown duration unit `{other}`; {MILLIS_GUIDE}"
                ))
            }
        };
        total += number * multiplier;
    }
    Ok(total.round() as i128)
}

const DAYS_GUIDE: &str = "spans look like \"30d\", \"2w\" or a plain integer of days";

fn parse_days(text: &str) -> Result<i128, String> {
    let (number, unit) = split_number_unit(text)
        .map_err(|e| format!("`{text}` is not a span of days: {e}; {DAYS_GUIDE}"))?;
    let multiplier = match unit.as_str() {
        "" | "d" | "day" | "days" => 1.0,
        "w" | "wk" | "week" | "weeks" => 7.0,
        other => {
            return Err(format!(
                "`{text}`: unknown span unit `{other}`; {DAYS_GUIDE}"
            ))
        }
    };
    if number.fract() != 0.0 {
        return Err(format!("`{text}`: {DAYS_GUIDE}, and `{number}` is not whole"));
    }
    Ok((number * multiplier) as i128)
}

const RATE_GUIDE: &str =
    "rates look like \"2.5Mbps\", \"800kbps\" or a plain integer of bits per second";

fn parse_bps(text: &str) -> Result<i128, String> {
    let (number, unit) = split_number_unit(text)
        .map_err(|e| format!("`{text}` is not a rate: {e}; {RATE_GUIDE}"))?;
    let multiplier = match unit.as_str() {
        "" | "bps" | "bit" | "bits" => 1.0,
        "k" | "kb" | "kbps" | "kbit" => 1e3,
        "m" | "mb" | "mbps" | "mbit" => 1e6,
        "g" | "gb" | "gbps" | "gbit" => 1e9,
        other => return Err(format!("`{text}`: unknown rate unit `{other}`; {RATE_GUIDE}")),
    };
    Ok((number * multiplier).round() as i128)
}

fn narrow<T, E>(v: i128) -> Result<T, E>
where
    T: std::convert::TryFrom<i128>,
    E: serde::de::Error,
{
    T::try_from(v).map_err(|_| E::custom(format!("value {v} does not fit this setting's range")))
}

/// One deserializer per (unit grammar, integer type) pair. The config fields
/// keep their plain integer types, so nothing outside this file changes.
macro_rules! human_deserializer {
    ($name:ident, $ty:ty, $parse:ident, $expecting:expr) => {
        pub(crate) fn $name<'de, D>(d: D) -> Result<$ty, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            struct V;
            impl<'de> serde::de::Visitor<'de> for V {
                type Value = $ty;
                fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    f.write_str($expecting)
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<$ty, E> {
                    narrow(v as i128)
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<$ty, E> {
                    narrow(v as i128)
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<$ty, E> {
                    $parse(v).map_err(E::custom).and_then(narrow)
                }
            }
            d.deserialize_any(V)
        }
    };
}

human_deserializer!(
    de_bytes, usize, parse_size,
    "a size like \"15MB\", \"1GiB\" or a plain integer of bytes"
);
human_deserializer!(
    de_bytes_i64, i64, parse_size,
    "a size like \"15MB\", \"1GiB\" or a plain integer of bytes"
);
human_deserializer!(
    de_bytes_u64, u64, parse_size,
    "a size like \"15MB\", \"1GiB\" or a plain integer of bytes"
);
human_deserializer!(
    de_secs, i64, parse_secs,
    "a duration like \"6h\", \"1d 12h\" or a plain integer of seconds"
);
human_deserializer!(
    de_secs_u64, u64, parse_secs,
    "a duration like \"6h\", \"1d 12h\" or a plain integer of seconds"
);
human_deserializer!(
    de_millis, u32, parse_millis,
    "a duration like \"250ms\", \"1.5s\" or a plain integer of milliseconds"
);
human_deserializer!(
    de_millis_u64, u64, parse_millis,
    "a duration like \"250ms\", \"1.5s\" or a plain integer of milliseconds"
);
human_deserializer!(
    de_days, i64, parse_days,
    "a span like \"30d\", \"2w\" or a plain integer of days"
);
human_deserializer!(
    de_bps, i64, parse_bps,
    "a rate like \"2.5Mbps\", \"800kbps\" or a plain integer of bits per second"
);

/// The `Option<i64>` form, for fields where an omitted limit means unstated.
pub(crate) fn de_bytes_opt<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct V;
    impl<'de> serde::de::Visitor<'de> for V {
        type Value = Option<i64>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a size like \"15MB\", \"1GiB\" or a plain integer of bytes")
        }
        fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Option<i64>, E> {
            Ok(Some(v))
        }
        fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Option<i64>, E> {
            narrow(v as i128).map(Some)
        }
        fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Option<i64>, E> {
            parse_size(v).map_err(E::custom).and_then(narrow).map(Some)
        }
    }
    d.deserialize_any(V)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Config {
    /// `auto`, `production` or `development`; only changes how loudly `preflight` complains.
    pub profile: String,
    /// The domain that appears in user ids and guild aliases. Identity, not hostname.
    pub server_name: String,
    /// Where clients actually reach us; published at /.well-known/telium/server.
    pub public_base_url: String,
    pub bind: String,
    pub database_url: String,
    pub media_dir: PathBuf,
    pub roles: Roles,
    pub relay: Relay,
    pub media_policy: MediaPolicy,
    pub media_registry: MediaRegistry,
    pub media_store: MediaStore,
    pub sessions: Sessions,
    pub registration: Registration,
    pub backup: Backup,
    pub failover: Failover,
    pub limits: Limits,
    pub federation: Federation,
    pub voice: Voice,
    pub moderation: Moderation,
    pub rate_limit: RateLimit,
    pub gateway: Gateway,
    pub archive: Archive,
    pub metrics: Metrics,
    pub web: Web,
    pub klipy: Klipy,
    pub mail: Mail,
    pub hosting: Hosting,
    pub updates: Updates,
    pub usage: Usage,
    pub push: Push,
    pub mfa: Mfa,
    pub ownership: Ownership,
    pub retention: Retention,
    pub integrity: Integrity,
    pub shutdown: Shutdown,
}

/// Retention for residue held about people; zero means forever only where stated.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Retention {
    /// Erasure journal retention after completion.
    #[serde(deserialize_with = "de_days")]
    pub erasure_journal_days: i64,
    /// Zero keeps local tombstones forever.
    #[serde(deserialize_with = "de_days")]
    pub tombstone_days: i64,
    /// Retention for `remote_tombstones`.
    #[serde(deserialize_with = "de_days")]
    pub remote_cache_days: i64,
    /// Account exports allowed per day.
    pub exports_per_day: i64,
    #[serde(deserialize_with = "de_days")]
    pub delivered_notice_days: i64,
    /// Zero keeps the audit log forever.
    #[serde(deserialize_with = "de_days")]
    pub audit_log_days: i64,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            erasure_journal_days: 90,
            tombstone_days: 365,
            remote_cache_days: 30,
            exports_per_day: 3,
            delivered_notice_days: 14,
            audit_log_days: 730,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Integrity {
    /// `quick` (default), `full` (several times slower) or `off`.
    pub startup_check: IntegrityMode,
    /// Look for rows referencing missing records.
    pub foreign_key_check: bool,
    /// Leave on: a corrupt server keeps writing and diverges from backups.
    pub refuse_start_on_corruption: bool,
}

impl Default for Integrity {
    fn default() -> Self {
        Self {
            startup_check: IntegrityMode::Quick,
            foreign_key_check: true,
            refuse_start_on_corruption: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrityMode {
    Off,
    #[default]
    Quick,
    Full,
}

/// Grace for in-flight work, kept below supervisor timeouts in `deploy/`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Shutdown {
    /// Seconds to wait for in-flight work before exiting anyway.
    pub grace_secs: u64,
    /// Milliseconds for close frames to flush before the wait begins.
    #[serde(deserialize_with = "de_millis_u64")]
    pub settle_ms: u64,
}

impl Default for Shutdown {
    fn default() -> Self {
        Self { grace_secs: 15, settle_ms: 250 }
    }
}

/// `check` on GETs one public file over HTTPS with a bare User-Agent; off fetches nothing.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Updates {
    pub check: bool,
    /// Release list URL (JSON written by CI).
    pub manifest_url: String,
    /// Check interval, retry delay and timeout.
    #[serde(deserialize_with = "de_secs")]
    pub check_interval_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub retry_secs: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub timeout_secs: u64,
    /// Lag before warning, and before urgent. Security releases are urgent immediately.
    #[serde(deserialize_with = "de_days")]
    pub stale_after_days: i64,
    #[serde(deserialize_with = "de_days")]
    pub urgent_after_days: i64,
    /// Ed25519 manifest-signing key, url-safe base64; empty means unchecked. Never compiled in.
    pub manifest_public_key: String,
    /// Where the detached signature lives. Empty means `manifest_url` + `.sig`.
    pub manifest_signature_url: String,
}

impl Default for Updates {
    fn default() -> Self {
        Self {
            check: true,
            manifest_url: "https://raw.githubusercontent.com/telium-chat/telium/main/deploy/releases.json"
                .into(),
            check_interval_secs: 6 * 60 * 60,
            retry_secs: 30 * 60,
            timeout_secs: 10,
            stale_after_days: 14,
            urgent_after_days: 45,
            manifest_public_key: String::new(),
            manifest_signature_url: String::new(),
        }
    }
}

/// Daily anonymous count: random id and enabled-account total, nothing else.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Usage {
    pub report: bool,
    pub count_url: String,
    #[serde(deserialize_with = "de_secs")]
    pub interval_secs: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub timeout_secs: u64,
}

impl Default for Usage {
    fn default() -> Self {
        Self {
            report: true,
            count_url: "https://count.telium.chat/ping".into(),
            interval_secs: 24 * 60 * 60,
            timeout_secs: 10,
        }
    }
}

/// Managed guild-hosting marketplace; `catalogs` are signed lists from others, `providers` is curated here.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Hosting {
    /// Whether the client is offered managed hosting.
    pub enabled: bool,
    pub catalogs: Vec<HostingCatalog>,
    pub providers: Vec<HostingProvider>,
    /// Catalogue refetch interval, failed-fetch retry delay, and per-fetch timeout.
    #[serde(deserialize_with = "de_secs")]
    pub catalog_refresh_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub catalog_retry_secs: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub catalog_timeout_secs: u64,
    /// Validity of the catalogue published from `providers`.
    #[serde(deserialize_with = "de_secs")]
    pub catalog_validity_secs: i64,
}

impl Default for Hosting {
    fn default() -> Self {
        Self {
            enabled: true,
            catalogs: Vec::new(),
            providers: Vec::new(),
            catalog_refresh_secs: 6 * 60 * 60,
            catalog_retry_secs: 15 * 60,
            catalog_timeout_secs: 10,
            catalog_validity_secs: 7 * 24 * 60 * 60,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct HostingCatalog {
    pub url: String,
    /// Publisher's Ed25519 public key, base64.
    pub key: String,
    pub label: Option<String>,
}

/// A curated provider in catalogue shape.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct HostingProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub signup_url: String,
    pub terms_url: String,
    pub privacy_url: Option<String>,
    pub contact: Option<String>,
    pub description: Option<String>,
    pub regions: Vec<String>,
    pub plans: Vec<HostingPlan>,
    pub public_key: String,
}

/// One price tier; `price_minor` is in minor units, an omitted limit means unstated.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct HostingPlan {
    pub id: String,
    pub name: String,
    pub price_minor: i64,
    pub currency: String,
    /// free | monthly | yearly | metered.
    pub period: String,
    pub member_cap: Option<i64>,
    #[serde(deserialize_with = "de_bytes_opt")]
    pub storage_bytes: Option<i64>,
    #[serde(deserialize_with = "de_bytes_opt")]
    pub media_quota_bytes: Option<i64>,
    pub notes: Option<String>,
}

/// `mode = "none"` sends nothing; `"webhook"` POSTs JSON to `webhook_url`. No SMTP.
#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Mail {
    pub mode: String,
    pub webhook_url: String,
    pub webhook_token: Secret,
    /// Empty means `noreply@<server_name>`.
    pub from: String,
}

impl Default for Mail {
    fn default() -> Self {
        Self {
            mode: "none".into(),
            webhook_url: String::new(),
            webhook_token: Secret::default(),
            from: String::new(),
        }
    }
}

/// Direct push-provider credentials; empty by default. Providers only get an opaque wake doorbell.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Push {
    pub fcm: Fcm,
    pub apns: Apns,
}

/// FCM HTTP v1 (OAuth2 from the service account; no legacy key).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Fcm {
    /// Needs this switch and a credential.
    pub enabled: bool,
    pub project_id: String,
    /// Service-account JSON path; never logged, returned or backed up.
    pub service_account_file: Option<PathBuf>,
    /// Override for `https://fcm.googleapis.com`; `http://` needs `federation.allow_http`.
    pub base_url: Option<String>,
    /// Override for the OAuth2 token URI in the service-account JSON.
    pub token_url: Option<String>,
}

/// APNs over HTTP/2 with a provider JWT from the `.p8` key.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Apns {
    pub enabled: bool,
    pub team_id: String,
    pub key_id: String,
    pub bundle_id: String,
    /// Path to the `.p8` ECDSA P-256 key; never logged or exported.
    pub key_file: Option<PathBuf>,
    /// `production` or `sandbox`; explicit because a mismatch only surfaces as BadDeviceToken.
    pub environment: String,
    /// Override for the gateway `environment` selects, and wins over it. `http://` needs `federation.allow_http`.
    pub base_url: Option<String>,
}

/// Serves the bundled web client; off unless a directory is set.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Web {
    /// Static files directory, relative to the working directory.
    pub dir: Option<PathBuf>,
    /// Where the web client lives if not `public_base_url`; published as `client` in discovery.
    pub client_url: Option<String>,
    /// Where invite and vanity links point. Every link this server mints names this server
    /// inside a URL on the portal: `https://telium.chat/invite/{code}@{server_name}`. Whoever
    /// opens the link then runs Telium's own page rather than this server's web directory, so
    /// a malicious or compromised guild server cannot put a lookalike login in front of the
    /// credentials it is about to receive, and a server hosting no web client at all still
    /// hands out working links. `self` restores the older shape, on `public_base_url`.
    pub invite_portal: String,
}

impl Default for Web {
    /// The portal default lives here rather than in a field-level `#[serde(default)]`,
    /// because the container-level default on this struct is what fills a missing `[web]`
    /// table -- a field-level default would only fire when the table exists but is half
    /// written, and a server that never mentions `[web]` still deserves the safe shape.
    fn default() -> Self {
        Self {
            dir: None,
            client_url: None,
            invite_portal: default_invite_portal(),
        }
    }
}

/// The official portal. A server that never edits this line still mints the safe link shape;
/// naming another URL hosts the portal yourself, and `self` is the deliberate opt-out.
fn default_invite_portal() -> String {
    "https://telium.chat".into()
}

/// The Klipy API key is an application credential, not a secret: the web client sends it directly.
#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Klipy {
    pub enabled: bool,
    pub api_key: String,
    pub api_base_url: String,
    pub media_hosts: Vec<String>,
}

impl Default for Klipy {
    fn default() -> Self {
        Self {
            enabled: true,
            api_key: "PUJfq1nYPGGO7gjwx7wqjGJwOzld1FZiyP35kiBa2wnQ6mRD7JrJnfA0mKfLrHKh".into(),
            api_base_url: "https://api.klipy.com/api/v1".into(),
            media_hosts: vec![
                "klipy.com".into(),
                "static.klipy.com".into(),
                "static.klipy.co".into(),
                "media.klipy.com".into(),
            ],
        }
    }
}

/// Protected guild transport: TCP forwarding with client-side TLS, so this server carries only ciphertext.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Relay {
    /// Tunnels one account may hold open at once.
    pub max_concurrent_per_account: u32,
    pub max_concurrent_total: u32,
    /// Bytes per tunnel, both directions.
    #[serde(deserialize_with = "de_bytes_i64")]
    pub max_tunnel_bytes: i64,
    /// Bytes per account in a rolling 24 hours (persisted in `relay_usage`).
    #[serde(deserialize_with = "de_bytes_i64")]
    pub daily_bytes_per_account: i64,
    /// Idle seconds before closing.
    #[serde(deserialize_with = "de_secs_u64")]
    pub idle_timeout_secs: u64,
    /// Maximum tunnel lifetime in seconds.
    #[serde(deserialize_with = "de_secs_u64")]
    pub max_lifetime_secs: u64,
    /// Distinct destinations per account per hour.
    pub destinations_per_hour: u32,
    /// Tunnel opens per minute and burst, through the shared `RateLimiter`.
    pub opens_burst: f64,
    pub opens_per_minute: f64,
    /// Ports a tunnel may be opened to; HTTPS only by default.
    pub ports: Vec<u16>,
    /// Allowed server names; empty means any with a valid discovery document.
    pub allow: Vec<String>,
    /// Server names this relay refuses regardless of `allow`. Checked first.
    pub deny: Vec<String>,
    /// Seconds a discovery document (and negative answer) is cached.
    #[serde(deserialize_with = "de_secs_u64")]
    pub discovery_cache_secs: u64,
    /// Log account and destination per tunnel; off to avoid mapping who talks to whom.
    pub log_destinations: bool,
}

impl Default for Relay {
    fn default() -> Self {
        Self {
            max_concurrent_per_account: 4,
            max_concurrent_total: 256,
            max_tunnel_bytes: 256 * 1024 * 1024,
            daily_bytes_per_account: 4 * 1024 * 1024 * 1024,
            idle_timeout_secs: 120,
            max_lifetime_secs: 6 * 3600,
            destinations_per_hour: 40,
            opens_burst: 20.0,
            opens_per_minute: 30.0,
            ports: vec![443],
            allow: Vec::new(),
            deny: Vec::new(),
            discovery_cache_secs: 600,
            log_destinations: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Roles {
    pub identity: bool,
    pub guild: bool,
    pub media: bool,
    /// Carry protected guild connections for this server's accounts; off by default.
    pub relay: bool,
}

/// `default: enabled | disabled | quota(bytes)`, per-user overrides, profile-asset carveout.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct MediaPolicy {
    pub default: MediaDefault,
    #[serde(deserialize_with = "de_bytes_i64")]
    pub quota_bytes: i64,
    pub allowlist: Vec<String>,
    pub blocklist: Vec<String>,
    #[serde(deserialize_with = "de_bytes_i64")]
    pub profile_asset_carveout_bytes: i64,
    #[serde(deserialize_with = "de_bytes")]
    pub max_file_bytes: usize,
    /// Per-object ceiling for `purpose = profile`.
    #[serde(deserialize_with = "de_bytes")]
    pub max_profile_asset_bytes: usize,
    /// Longest requested upload lifetime in seconds; zero is no cap.
    #[serde(deserialize_with = "de_secs")]
    pub max_expiry_secs: i64,
    /// Lifetime applied when the client requests none; zero keeps such uploads
    /// until something reclaims them. Never widens a client's own request and
    /// still narrows against the destination's cap.
    #[serde(deserialize_with = "de_secs")]
    pub default_expiry_secs: i64,
    /// Attachment media older than this many days is swept even when a message
    /// still refers to it; zero never ages anything out. Destructive by design:
    /// live messages will lose their files past the age.
    #[serde(deserialize_with = "de_days")]
    pub attachment_max_age_days: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaDefault {
    Enabled,
    Disabled,
    Quota,
}

/// Curated host registry (tier-2 origins) and external-host add-ons (tier 3).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct MediaRegistry {
    /// Browser-only Gofile download compatibility stream; disable to keep external bytes off the homeserver.
    pub gofile_playback_proxy: bool,
    pub hosts: Vec<RegistryHost>,
    /// Tier-3 upload add-ons.
    pub external_hosts: Vec<ExternalHost>,
    /// Origin feed refresh interval, retry delay and fetch timeout.
    #[serde(deserialize_with = "de_secs")]
    pub feed_refresh_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub feed_retry_secs: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub feed_timeout_secs: u64,
    /// How long the feed published from `hosts` stays valid.
    #[serde(deserialize_with = "de_secs")]
    pub feed_validity_secs: i64,
    /// Curators published as a signed directory; pinning stays a guild moderator's act.
    pub curators: Vec<CuratorEntry>,
    /// Directories read, with publisher keys; those without a pinned key are skipped.
    pub curator_directories: Vec<CuratorDirectory>,
    /// Video services a call may embed a player for.
    pub watch_together: WatchTogether,
}

/// Narrows the client's built-in player list, never widens. `enabled = false` opts out.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct WatchTogether {
    pub enabled: bool,
    /// Provider ids to permit; empty means all, not none.
    pub providers: Vec<String>,
}

impl Default for WatchTogether {
    fn default() -> Self {
        Self { enabled: true, providers: Vec::new() }
    }
}

impl Default for MediaRegistry {
    fn default() -> Self {
        Self {
            gofile_playback_proxy: true,
            hosts: Vec::new(),
            external_hosts: vec![ExternalHost {
                id: "gofile".into(),
                provider: "gofile".into(),
                name: "Gofile".into(),
                domain: "gofile.io".into(),
                upload_url: "https://upload.gofile.io/uploadfile".into(),
                description: Some("Guest files are temporary and are normally kept for about ten days; Gofile may remove files for policy violations.".into()),
                max_file_bytes: None,
                browser_direct: Some(true),
            }],
            feed_refresh_secs: 60 * 60,
            feed_retry_secs: 10 * 60,
            feed_timeout_secs: 10,
            feed_validity_secs: 7 * 24 * 60 * 60,
            curators: Vec::new(),
            curator_directories: Vec::new(),
            watch_together: WatchTogether::default(),
        }
    }
}

/// A curator published in this server's directory.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CuratorEntry {
    pub name: String,
    pub feed_url: String,
    pub key: String,
    pub description: Option<String>,
    pub contact: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct CuratorDirectory {
    pub url: String,
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct RegistryHost {
    pub origin: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(deserialize_with = "de_bytes_opt")]
    pub max_file_bytes: Option<i64>,
    pub abuse_contact: Option<String>,
}

/// A provider add-on; `upload_url` is public configuration.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct ExternalHost {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub domain: String,
    pub upload_url: String,
    pub description: Option<String>,
    #[serde(deserialize_with = "de_bytes_opt")]
    pub max_file_bytes: Option<i64>,
    /// Whether the provider accepts browser CORS uploads; `None` uses the adapter default.
    pub browser_direct: Option<bool>,
}

impl ExternalHost {
    pub fn browser_direct_enabled(&self) -> bool {
        if self.provider.eq_ignore_ascii_case("gofile") {
            return true;
        }
        self.browser_direct.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Sessions {
    #[serde(deserialize_with = "de_secs")]
    pub home_session_ttl_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub assertion_ttl_secs: i64,
    /// Bounded so home-server revocation takes effect.
    #[serde(deserialize_with = "de_secs")]
    pub guild_session_ttl_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub revalidate_interval_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub signing_key_validity_secs: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Registration {
    pub open: bool,
    pub min_password_len: usize,
    /// Localparts granted admin on registration; empty means the first account is admin.
    pub admins: Vec<String>,
    /// Also needs the registry to opt this domain in.
    pub recommendations: RecommendationParticipation,
}

/// Distributed account-home onboarding; the site generator clamps `referral_weight`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct RecommendationParticipation {
    pub accepting: bool,
    pub referral_weight: u32,
    pub suggest_alternatives: bool,
}

impl Default for RecommendationParticipation {
    fn default() -> Self {
        Self { accepting: false, referral_weight: 1, suggest_alternatives: false }
    }
}

/// Location of the key that encrypts per-account second factors; keep it outside `media_dir` and `backup.dir`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Mfa {
    /// AES-256 key sealing TOTP secrets, base64; generated at first start only if nothing is sealed yet.
    pub key_file: PathBuf,
    /// Retired keys: opening tries `key_file`, then these; `telium-server mfa rekey` re-seals.
    pub previous_key_files: Vec<PathBuf>,
}

impl Default for Mfa {
    fn default() -> Self {
        Self {
            key_file: PathBuf::from("mfa.key"),
            previous_key_files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Backup {
    pub enabled: bool,
    pub dir: PathBuf,
    #[serde(deserialize_with = "de_secs_u64")]
    pub interval_secs: u64,
    pub keep: usize,
    /// Warn once a backup is older than this, including the off-box copy.
    #[serde(deserialize_with = "de_secs")]
    pub stale_after_secs: i64,
    /// Include `media_dir`; off if media is backed up elsewhere.
    pub include_media: bool,
    /// AES-256 key sealing archives, base64; generated if missing. `TELIUM_BACKUP_KEY` overrides it.
    pub key_file: PathBuf,
    /// Retired keys: archives carry no key id, so restore tries each. Drop one once its last archive ages out of `keep`.
    pub previous_key_files: Vec<PathBuf>,
    /// Periodic restore rehearsal: fetch, decrypt and open the newest archive in a scratch directory.
    pub drill: bool,
    /// Daily; each drill is a full download.
    #[serde(deserialize_with = "de_secs_u64")]
    pub drill_interval_secs: u64,
    /// Staleness threshold for the last drill result.
    #[serde(deserialize_with = "de_secs")]
    pub drill_stale_after_secs: i64,
    /// Back up at startup before applying migrations.
    pub pre_migration_backup: bool,
    /// Refuse to start with pending migrations and no restorable archive.
    pub require_backup_before_migration: bool,
    pub remote: Remote,
}

/// Any S3-compatible endpoint; credentials may come from `TELIUM_S3_ACCESS_KEY_ID` / `TELIUM_S3_SECRET_ACCESS_KEY`.
#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Remote {
    pub enabled: bool,
    /// e.g. `https://s3.amazonaws.com` or `http://minio.internal:9000`.
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    /// Key prefix inside the bucket. Empty means `telium/<server_name>/`.
    pub prefix: String,
    pub access_key_id: Secret,
    pub secret_access_key: Secret,
    /// Path-style `https://endpoint/bucket/key` addressing; on by default for MinIO compatibility.
    pub path_style: bool,
    /// Archives kept in the bucket.
    pub keep: usize,
    /// Timeout for small requests; transfers get more.
    #[serde(deserialize_with = "de_secs_u64")]
    pub timeout_secs: u64,
}

impl Default for Remote {
    fn default() -> Self {
        Self {
            enabled: false,
            endpoint: "https://s3.amazonaws.com".into(),
            bucket: String::new(),
            region: "us-east-1".into(),
            prefix: String::new(),
            access_key_id: Secret::default(),
            secret_access_key: Secret::default(),
            path_style: true,
            keep: 8,
            timeout_secs: 60,
        }
    }
}

impl Remote {
    /// Config values, with the environment winning when it is set.
    pub fn credentials(&self) -> (String, String) {
        let access = std::env::var("TELIUM_S3_ACCESS_KEY_ID")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.access_key_id.to_string());
        let secret = std::env::var("TELIUM_S3_SECRET_ACCESS_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.secret_access_key.to_string());
        (access, secret)
    }

    pub fn prefix_for(&self, server_name: &str) -> String {
        let p = if self.prefix.is_empty() { format!("telium/{server_name}/") } else { self.prefix.clone() };
        if p.ends_with('/') { p } else { format!("{p}/") }
    }
}

/// Server-to-server behaviour; `peers` names where a peer answers (test rigs, split-horizon).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Federation {
    pub enabled: bool,
    /// Allow plain HTTP to peers. False everywhere but test rigs and LANs.
    pub allow_http: bool,
    pub peers: std::collections::BTreeMap<String, String>,
    #[serde(deserialize_with = "de_secs_u64")]
    pub request_timeout_secs: u64,
    #[serde(deserialize_with = "de_secs")]
    pub key_cache_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub max_clock_skew_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub media_cache_ttl_secs: i64,
    #[serde(deserialize_with = "de_bytes_i64")]
    pub media_cache_max_bytes: i64,
    pub embed_enabled: bool,
    #[serde(deserialize_with = "de_bytes")]
    pub embed_max_bytes: usize,
    /// Cap on a proxied video unfurl; over it, the card falls back to its still.
    #[serde(deserialize_with = "de_bytes")]
    pub embed_video_max_bytes: usize,
    #[serde(deserialize_with = "de_secs_u64")]
    pub embed_timeout_secs: u64,
    #[serde(deserialize_with = "de_secs")]
    pub embed_cache_secs: i64,
    /// Cooling-off before a migration executes; any logged-in device can cancel.
    #[serde(deserialize_with = "de_secs")]
    pub migration_delay_secs: i64,
    #[serde(deserialize_with = "de_secs")]
    pub revalidate_interval_secs: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub dm_retry_secs: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Voice {
    pub enabled: bool,
    pub default_region: String,
    pub regions: Vec<VoiceRegion>,
    /// Lifetime of a join token. Bounds only the replay window at the SFU's
    /// `/session`; the client renews it mid-call (`voice/token`), so a call
    /// never sits on an expired LiveKit grant, which would turn the first
    /// network blip into a full reconnect.
    #[serde(deserialize_with = "de_secs")]
    pub token_ttl_secs: i64,
    /// Handed to every client; without a reflexive address a peer can only
    /// offer its own network's addresses.
    pub stun_servers: Vec<String>,
    /// Shared TURN secret (coturn `static-auth-secret`); `TELIUM_TURN_SECRET` overrides.
    pub turn_secret: Option<Secret>,
    #[serde(deserialize_with = "de_secs")]
    pub turn_ttl_secs: i64,
    /// This server's own TURN relay (`host:port`) for relay-only calls; needs `turn_secret`.
    pub turn: Option<String>,
    /// Bitrate ceiling in bits per second; the streamer spends the budget.
    #[serde(deserialize_with = "de_bps")]
    pub max_bitrate: i64,
    pub max_streamers_per_channel: i64,
    /// Mesh mode (peer-to-peer WebRTC, signalled over the guild gateway) is what
    /// the reference client uses when no SFU is configured.
    pub mesh_max_participants: i64,
    /// How long a voice state outlives its gateway connection, so a socket drop doesn't evict a live call.
    #[serde(deserialize_with = "de_secs_u64")]
    pub reconnect_grace_secs: u64,
}

impl Voice {
    pub fn addressed_regions(&self) -> impl Iterator<Item = &VoiceRegion> {
        self.regions.iter().filter(|r| !r.sfu.trim().is_empty())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct VoiceRegion {
    pub name: String,
    /// Base URL of a telium-sfu, e.g. `https://sfu.example`; empty means mesh.
    pub sfu: String,
    pub turn: Option<String>,
    /// Carried to the client; nothing reads it yet.
    pub pubkey_hint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Moderation {
    /// Inline BLAKE3 digests; large lists belong in `upload_hash_lists`.
    pub upload_hash_blocklist: Vec<String>,
    pub upload_hash_lists: Vec<HashListSource>,
    pub abuse_contact: Option<String>,
    pub blocklist_feeds: Vec<String>,
    #[serde(deserialize_with = "de_days")]
    pub report_retention_days: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct HashListSource {
    pub name: String,
    /// blake3 | sha256 | sha1, the list author's choice.
    pub algorithm: String,
    pub path: PathBuf,
}

impl Default for HashListSource {
    fn default() -> Self {
        Self { name: "unnamed".into(), algorithm: "sha256".into(), path: PathBuf::new() }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Limits {
    pub max_message_len: usize,
    pub max_guilds_per_user: i64,
    pub max_emoji_per_guild: i64,
    pub max_stickers_per_guild: i64,
    #[serde(deserialize_with = "de_bytes_i64")]
    pub max_sync_store_bytes: i64,
    pub max_attachments_per_message: usize,
    /// Undecided stranger DM requests per account; overflow is silently filed as declined.
    pub max_message_requests: i64,
    /// Presence is coalesced to this granularity (the fanout bomb).
    #[serde(deserialize_with = "de_secs")]
    pub presence_coalesce_secs: i64,
    /// The side of the square an emoji is scaled down to fit; never scaled up.
    pub emoji_max_dimension: u32,
    /// The same for a sticker.
    pub sticker_max_dimension: u32,
    /// Max pixels one source frame may declare (16,777,216 is 4096x4096); refused before decoding.
    pub expression_max_source_pixels: u64,
    /// Max source pixels across all animation frames; bounds decode work.
    pub expression_max_total_pixels: u64,
    pub expression_max_frames: usize,
    #[serde(deserialize_with = "de_millis")]
    pub expression_max_duration_ms: u32,
    /// Past the frame or duration cap: keep what fits and drop the rest (true),
    /// or refuse the upload (false).
    pub expression_drop_excess_frames: bool,
    /// Largest request body on routes without their own ceiling; pins axum's 2 MB default.
    #[serde(deserialize_with = "de_bytes")]
    pub max_request_bytes: usize,
    /// Stall allowed between body chunks before abandoning the request (slowloris).
    #[serde(deserialize_with = "de_secs_u64")]
    pub request_body_timeout_secs: u64,
}

/// Rate limits, generous by default: they blunt runaway clients and floods, not ordinary sessions.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct RateLimit {
    pub enabled: bool,
    pub read_burst: i64,
    pub read_per_sec: f64,
    pub write_burst: i64,
    pub write_per_sec: f64,
    /// Separate, tighter bucket for password-bearing endpoints.
    pub auth_burst: i64,
    pub auth_per_sec: f64,
    /// Server-to-server, per socket; generous because a peer relays for all its users.
    pub federation_burst: i64,
    pub federation_per_sec: f64,
    /// Guild search, in cost units (`routes/social.rs::search_cost`; an ordinary search is about seven).
    pub search_burst: i64,
    pub search_per_sec: f64,
    /// Only peers listed here may supply X-Forwarded-For. Empty means never trust it.
    pub trusted_proxies: Vec<String>,
}

impl Default for RateLimit {
    fn default() -> Self {
        Self {
            enabled: true,
            read_burst: 200,
            read_per_sec: 20.0,
            write_burst: 60,
            write_per_sec: 5.0,
            auth_burst: 10,
            auth_per_sec: 0.25,
            federation_burst: 240,
            federation_per_sec: 40.0,
            // Cost units, not requests; 600 is about eighty ordinary searches.
            search_burst: 600,
            search_per_sec: 20.0,
            trusted_proxies: Vec::new(),
        }
    }
}

/// Ceilings on what one WebSocket connection may cost.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Gateway {
    /// Events queued per connection before it is closed (a disconnect, not a silent drop).
    pub outbox_depth: usize,
    /// Simultaneous connections per account.
    pub max_connections_per_account: usize,
    /// Sockets upgraded but not yet IDENTIFYed, globally.
    pub max_pending_sockets: u64,
    /// Largest client frame buffered and parsed; the only cap that acts before authentication.
    #[serde(deserialize_with = "de_bytes")]
    pub max_frame_bytes: usize,
    /// Client frames per second per account, and burst.
    pub frames_per_sec: f64,
    pub frame_burst: i64,
    /// Typing notifications per account per second, and burst.
    pub typing_per_sec: f64,
    pub typing_burst: i64,
}

impl Default for Gateway {
    fn default() -> Self {
        Self {
            outbox_depth: crate::gateway::hub::OUTBOX_DEPTH,
            max_connections_per_account: 6,
            max_pending_sockets: 2_048,
            max_frame_bytes: 64 * 1024,
            frames_per_sec: 10.0,
            frame_burst: 120,
            typing_per_sec: 0.5,
            typing_burst: 5,
        }
    }
}

/// Cold storage. Off by default: moving history is the operator's decision.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Archive {
    pub enabled: bool,
    pub dir: PathBuf,
    /// How old a message must be before it is a candidate.
    #[serde(deserialize_with = "de_days")]
    pub horizon_days: i64,
    /// Never archive below this many messages of recent tail per channel.
    pub keep_hot_messages: i64,
    pub batch: i64,
    #[serde(deserialize_with = "de_secs_u64")]
    pub sweep_interval_secs: u64,
    pub store: StoreBackend,
    pub s3: Remote,
}

impl Default for Archive {
    fn default() -> Self {
        Self {
            enabled: false,
            dir: PathBuf::from("cold"),
            horizon_days: 365,
            keep_hot_messages: 10_000,
            batch: 5_000,
            sweep_interval_secs: 3_600,
            store: StoreBackend::Local,
            s3: Remote::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreBackend {
    #[default]
    Local,
    S3,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct MediaStore {
    pub store: StoreBackend,
    pub s3: Remote,
}

/// Operator-console metrics; all aggregates, never a user, channel or peer dimension.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Metrics {
    pub enabled: bool,
    /// Span of one history bucket; below ~30s row count outweighs resolution.
    #[serde(deserialize_with = "de_secs_u64")]
    pub interval_secs: u64,
    /// How long rolled-up history is kept (about twenty thousand rows at two weeks).
    #[serde(deserialize_with = "de_days")]
    pub retention_days: i64,
    /// Sampling interval for expensive gauges; buckets between samples record them as absent.
    #[serde(deserialize_with = "de_secs_u64")]
    pub storage_interval_secs: u64,
    /// Max route patterns in the live per-route table (memory-only).
    pub max_routes: usize,
    /// Whether `GET /metrics` answers; off gives `404` rather than `401`.
    pub scrape_enabled: bool,
    /// Bearer token admitting a scrape from anywhere (constant-time compare); empty admits nothing. `TELIUM_METRICS_SCRAPE_TOKEN` overrides.
    pub scrape_token: Secret,
    /// Previous token still accepted during rotation, then cleared (`preflight` warns). `TELIUM_METRICS_SCRAPE_TOKEN_PREVIOUS` overrides.
    pub scrape_token_previous: Secret,
    /// Peers that may scrape without a token, matched on the TCP peer address; an explicit list replaces the loopback default.
    pub scrape_allow: Vec<String>,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 60,
            retention_days: 14,
            storage_interval_secs: 900,
            max_routes: 512,
            scrape_enabled: false,
            scrape_token: Secret::default(),
            scrape_token_previous: Secret::default(),
            scrape_allow: vec!["127.0.0.1".into(), "::1".into()],
        }
    }
}

/// Who may administer this server and how it recovers a lost administrator.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Ownership {
    /// Delay before a filesystem-opened admin-recovery claim applies while another admin can cancel it.
    #[serde(deserialize_with = "de_secs")]
    pub recovery_delay_secs: i64,
}

impl Default for Ownership {
    fn default() -> Self {
        Self { recovery_delay_secs: 24 * 60 * 60 }
    }
}

// Redacted `Debug` (not `Serialize`, which must round-trip); shows set/unset.

fn redacted(value: &str) -> &'static str {
    if value.is_empty() { "<unset>" } else { "<set>" }
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remote")
            .field("enabled", &self.enabled)
            .field("endpoint", &self.endpoint)
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .field("prefix", &self.prefix)
            .field("access_key_id", &redacted(&self.access_key_id))
            .field("secret_access_key", &redacted(&self.secret_access_key))
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Mail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mail")
            .field("mode", &self.mode)
            .field("webhook_url", &self.webhook_url)
            .field("webhook_token", &redacted(&self.webhook_token))
            .field("from", &self.from)
            .finish()
    }
}

impl std::fmt::Debug for Voice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Voice")
            .field("enabled", &self.enabled)
            .field("default_region", &self.default_region)
            .field("regions", &self.regions)
            .field("token_ttl_secs", &self.token_ttl_secs)
            .field("stun_servers", &self.stun_servers)
            .field("turn_secret", &redacted(self.turn_secret.as_deref().unwrap_or("")))
            .field("turn_ttl_secs", &self.turn_ttl_secs)
            .field("turn", &self.turn)
            .finish_non_exhaustive()
    }
}

impl std::fmt::Debug for Klipy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redacted anyway so an operator's own paid key is no exception.
        f.debug_struct("Klipy")
            .field("enabled", &self.enabled)
            .field("api_key", &redacted(&self.api_key))
            .finish_non_exhaustive()
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            profile: "auto".into(),
            server_name: "localhost".into(),
            public_base_url: "http://localhost:8448".into(),
            bind: "127.0.0.1:8448".into(),
            database_url: "sqlite://telium.db?mode=rwc".into(),
            media_dir: PathBuf::from("media"),
            roles: Roles::default(),
            relay: Relay::default(),
            media_policy: MediaPolicy::default(),
            media_registry: MediaRegistry::default(),
            media_store: MediaStore::default(),
            sessions: Sessions::default(),
            registration: Registration::default(),
            mfa: Mfa::default(),
            backup: Backup::default(),
            failover: Failover::default(),
            limits: Limits::default(),
            federation: Federation::default(),
            voice: Voice::default(),
            moderation: Moderation::default(),
            rate_limit: RateLimit::default(),
            gateway: Gateway::default(),
            archive: Archive::default(),
            metrics: Metrics::default(),
            web: Web::default(),
            klipy: Klipy::default(),
            mail: Mail::default(),
            hosting: Hosting::default(),
            updates: Updates::default(),
            usage: Usage::default(),
            push: Push::default(),
            ownership: Ownership::default(),
            retention: Retention::default(),
            integrity: Integrity::default(),
            shutdown: Shutdown::default(),
        }
    }
}

impl Default for Apns {
    fn default() -> Self {
        Self {
            enabled: false,
            team_id: String::new(),
            key_id: String::new(),
            bundle_id: String::new(),
            key_file: None,
            base_url: None,
            // Sandbox only works for development-profile builds.
            environment: "production".into(),
        }
    }
}

impl Default for Federation {
    fn default() -> Self {
        Self {
            enabled: true,
            allow_http: false,
            peers: Default::default(),
            request_timeout_secs: 15,
            key_cache_secs: 60 * 60 * 24,
            max_clock_skew_secs: 300,
            media_cache_ttl_secs: 60 * 60 * 24,
            media_cache_max_bytes: 2 * 1024 * 1024 * 1024,
            embed_enabled: true,
            embed_max_bytes: 8 * 1024 * 1024,
            embed_video_max_bytes: 32 * 1024 * 1024,
            embed_timeout_secs: 8,
            embed_cache_secs: 60 * 60 * 24,
            migration_delay_secs: 60 * 60 * 24,
            revalidate_interval_secs: 600,
            dm_retry_secs: 30,
        }
    }
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            enabled: true,
            default_region: "local".into(),
            // The operator supplies regions; with none addressed, calls are mesh-only.
            regions: Vec::new(),
            token_ttl_secs: 600,
            stun_servers: vec!["stun:stun.l.google.com:19302".into()],
            turn_secret: None,
            turn_ttl_secs: 3600,
            turn: None,
            max_bitrate: 2_500_000,
            max_streamers_per_channel: 4,
            mesh_max_participants: 4,
            reconnect_grace_secs: 15,
        }
    }
}

impl Default for VoiceRegion {
    fn default() -> Self {
        Self { name: "local".into(), sfu: String::new(), turn: None, pubkey_hint: None }
    }
}

impl Default for Moderation {
    fn default() -> Self {
        Self {
            upload_hash_blocklist: Vec::new(),
            upload_hash_lists: Vec::new(),
            abuse_contact: None,
            blocklist_feeds: Vec::new(),
            report_retention_days: 365,
        }
    }
}

impl Default for Roles {
    fn default() -> Self {
        Self { identity: true, guild: true, media: true, relay: false }
    }
}

impl Default for MediaPolicy {
    fn default() -> Self {
        Self {
            default: MediaDefault::Enabled,
            quota_bytes: 1024 * 1024 * 1024,
            allowlist: Vec::new(),
            blocklist: Vec::new(),
            profile_asset_carveout_bytes: 512 * 1024,
            max_file_bytes: 100 * 1024 * 1024,
            max_profile_asset_bytes: 256 * 1024,
            max_expiry_secs: 0,
            default_expiry_secs: 0,
            attachment_max_age_days: 0,
        }
    }
}

impl Default for Sessions {
    fn default() -> Self {
        Self {
            home_session_ttl_secs: 60 * 60 * 24 * 30,
            assertion_ttl_secs: 300,
            guild_session_ttl_secs: 60 * 60,
            revalidate_interval_secs: 600,
            signing_key_validity_secs: 60 * 60 * 24 * 90,
        }
    }
}

impl Default for Registration {
    fn default() -> Self {
        Self {
            open: true,
            min_password_len: 8,
            admins: Vec::new(),
            recommendations: RecommendationParticipation::default(),
        }
    }
}

impl Default for Backup {
    fn default() -> Self {
        Self {
            enabled: true,
            dir: PathBuf::from("backups"),
            interval_secs: 60 * 60 * 6,
            keep: 8,
            stale_after_secs: 60 * 60 * 24 * 2,
            include_media: true,
            key_file: PathBuf::from("backup.key"),
            previous_key_files: Vec::new(),
            drill: true,
            drill_interval_secs: 60 * 60 * 24,
            drill_stale_after_secs: 60 * 60 * 24 * 3,
            pre_migration_backup: true,
            require_backup_before_migration: false,
            remote: Remote::default(),
        }
    }
}

/// Warm standby: `standbys` may stream our database, `replicate` is whose database we mirror.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Failover {
    /// Domains allowed to pull our change log and snapshots; empty means no standby (no triggers installed).
    pub standbys: Vec<String>,
    /// Domains we mirror and serve read-only if they stop answering.
    pub replicate: Vec<String>,
    /// Where mirrored databases and their media live.
    pub dir: PathBuf,
    /// How often the standby asks for new entries; lag is data loss in a failure.
    #[serde(deserialize_with = "de_secs_u64")]
    pub poll_secs: u64,
    pub batch: i64,
    /// How long to keep acknowledged entries, so a briefly disconnected standby resumes.
    #[serde(deserialize_with = "de_secs")]
    pub keep_acked_secs: i64,
    /// How stale a replica may be before clients are told the copy is behind.
    #[serde(deserialize_with = "de_secs")]
    pub stale_after_secs: i64,
    /// Content addresses examined per sweep of a replica's media.
    pub media_batch: i64,
    /// Standbys allowed to stream a logical origin after promotion; separate from `standbys`.
    pub promoted_standbys: BTreeMap<String, Vec<String>>,
    /// How often a primary asks its standbys whether one has taken over.
    #[serde(deserialize_with = "de_secs_u64")]
    pub demotion_poll_secs: u64,
    /// Largest snapshot a standby will write; too low silently breaks failover.
    #[serde(deserialize_with = "de_bytes_u64")]
    pub max_snapshot_bytes: u64,
}

impl Default for Failover {
    fn default() -> Self {
        Self {
            standbys: Vec::new(),
            replicate: Vec::new(),
            dir: PathBuf::from("replicas"),
            poll_secs: 5,
            batch: 500,
            keep_acked_secs: 60 * 30,
            stale_after_secs: 60 * 5,
            media_batch: 200,
            promoted_standbys: BTreeMap::new(),
            demotion_poll_secs: 30,
            max_snapshot_bytes: 100 * 1024 * 1024 * 1024,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_message_len: 4000,
            max_guilds_per_user: 200,
            max_emoji_per_guild: 250,
            max_stickers_per_guild: 60,
            max_sync_store_bytes: 1024 * 1024,
            max_attachments_per_message: 10,
            max_message_requests: 100,
            presence_coalesce_secs: 30,
            emoji_max_dimension: 128,
            sticker_max_dimension: 320,
            expression_max_source_pixels: 4096 * 4096,
            expression_max_total_pixels: 256 * 1024 * 1024,
            expression_max_frames: 250,
            expression_max_duration_ms: 30_000,
            expression_drop_excess_frames: true,
            max_request_bytes: 2 * 1024 * 1024,
            request_body_timeout_secs: 30,
        }
    }
}

impl Config {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| anyhow::anyhow!("reading {}: {e}", path.display()))?;
        let doc: toml::Value = toml::from_str(&text)?;
        let doc = resolve_references(doc)
            .map_err(|e| anyhow::anyhow!("in {}: {e}", path.display()))?;
        // After substitution so a reference resolving to `change-me` is caught.
        refuse_placeholders(&doc, "")
            .map_err(|e| anyhow::anyhow!("in {}: {e}", path.display()))?;
        let mut cfg: Config = doc.try_into()?;
        // Env secrets win over the (often version-controlled) file, before `validate`.
        if let Ok(secret) = std::env::var("TELIUM_TURN_SECRET") {
            if !secret.is_empty() {
                cfg.voice.turn_secret = Some(secret.into());
            }
        }
        if let Ok(token) = std::env::var("TELIUM_METRICS_SCRAPE_TOKEN") {
            if !token.is_empty() {
                cfg.metrics.scrape_token = token.into();
            }
        }
        if let Ok(token) = std::env::var("TELIUM_METRICS_SCRAPE_TOKEN_PREVIOUS") {
            if !token.is_empty() {
                cfg.metrics.scrape_token_previous = token.into();
            }
        }
        cfg.validate()?;
        Ok(cfg)
    }

    /// The URL an invite or vanity link is shared as. The portal form names this server inside
    /// the portal's URL, so the page that opens is Telium's build whatever server minted the
    /// link; `self` is the old shape, served by this server's own web directory.
    pub fn invite_link(&self, token: &str) -> String {
        let portal = self.web.invite_portal.trim().trim_end_matches('/');
        if portal == "self" || portal.is_empty() {
            format!("{}/invite/{}", self.public_base_url.trim_end_matches('/'), token)
        } else {
            format!("{portal}/invite/{token}@{}", self.server_name)
        }
    }

    /// The portal as clients should name links, or None when links are minted on this server.
    pub fn invite_portal_field(&self) -> Option<String> {
        match self.web.invite_portal.trim() {
            "self" | "" => None,
            portal => Some(portal.trim_end_matches('/').to_string()),
        }
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        if self.server_name.is_empty() {
            anyhow::bail!("server_name must be set");
        }
        if !(self.roles.identity || self.roles.guild || self.roles.media) {
            anyhow::bail!("at least one role must be enabled");
        }
        if self.web.invite_portal != "self"
            && !self.web.invite_portal.starts_with("https://")
        {
            anyhow::bail!(
                "web.invite_portal must be an https URL, or \"self\" to mint invite links \
                 on public_base_url"
            );
        }

        // Malformed key would make every signature check look like a bad project signature.
        if !self.updates.manifest_public_key.is_empty() {
            // Decoded with the verifier's own function so we can't accept a key it rejects.
            let decoded = telium_protocol::unb64(self.updates.manifest_public_key.trim())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "updates.manifest_public_key is set but is not url-safe unpadded \
                         base64, which is the form the project publishes its release key in. \
                         If what you pasted ends in `=` or contains `+` or `/`, it is the other \
                         base64 alphabet and this server will never decode it. Leave the key \
                         empty to check release metadata against nothing but its transport."
                    )
                })?;
            if decoded.len() != 32 {
                anyhow::bail!(
                    "updates.manifest_public_key decodes to {} bytes and an Ed25519 public key \
                     is 32. A private key, a signature or a fingerprint pasted here would fail \
                     every signature check for the life of the deployment while looking \
                     configured.",
                    decoded.len()
                );
            }
        }

        // `scrape_token_previous` without `scrape_token` is a rotation done
        // backwards: the retired token would be the only one that works.
        if !self.metrics.scrape_token_previous.trim().is_empty()
            && self.metrics.scrape_token.trim().is_empty()
        {
            anyhow::bail!(
                "metrics.scrape_token_previous is set but metrics.scrape_token is empty, so the \
                 only token that admits a scrape is the one you are retiring. Put the new token \
                 in metrics.scrape_token; previous is for the old one, during the window where \
                 both work."
            );
        }

        // A retired backup key that is missing would otherwise be found at restore time.
        for path in &self.backup.previous_key_files {
            if !path.exists() {
                anyhow::bail!(
                    "backup.previous_key_files names {} and there is no file there. Every \
                     archive sealed under that key can only ever be opened with it: put the \
                     file back, or -- if every archive it sealed has already aged out -- remove \
                     the entry.",
                    path.display()
                );
            }
        }

        for path in &self.mfa.previous_key_files {
            if !path.exists() {
                anyhow::bail!(
                    "mfa.previous_key_files names {} and there is no file there. Any account \
                     still sealed under that key cannot use its authenticator without it: put \
                     the file back, or -- if `telium-server mfa rekey` has already moved every \
                     row onto the current key -- remove the entry.",
                    path.display()
                );
            }
        }

        // A relay without accounts would reject every tunnel as unauthorized.
        if self.roles.relay && !self.roles.identity {
            anyhow::bail!("roles.relay needs roles.identity: the relay only serves this server's own accounts");
        }
        if self.roles.relay {
            if self.relay.max_concurrent_per_account == 0 || self.relay.max_concurrent_total == 0 {
                anyhow::bail!("relay concurrency limits must be at least 1 (set roles.relay = false to turn the relay off)");
            }
            if self.relay.max_tunnel_bytes <= 0 || self.relay.daily_bytes_per_account <= 0 {
                anyhow::bail!("relay byte budgets must be positive (set roles.relay = false to turn the relay off)");
            }
            if self.relay.idle_timeout_secs == 0 || self.relay.max_lifetime_secs == 0 {
                anyhow::bail!("relay idle_timeout_secs and max_lifetime_secs must be positive");
            }
            if self.relay.ports.is_empty() {
                anyhow::bail!("relay.ports must name at least one port; the default is [443]");
            }
            if self.relay.opens_burst <= 0.0 || self.relay.opens_per_minute <= 0.0 {
                anyhow::bail!("relay open-rate limits must be positive");
            }
        }
        if self.rate_limit.enabled && (
            self.rate_limit.read_burst < 1
            || self.rate_limit.write_burst < 1
            || self.rate_limit.auth_burst < 1
            || self.rate_limit.read_per_sec <= 0.0
            || self.rate_limit.write_per_sec <= 0.0
            || self.rate_limit.auth_per_sec <= 0.0
            || self.rate_limit.federation_burst < 1
            || self.rate_limit.federation_per_sec <= 0.0
            // Search's burst is in cost units; the cheapest query costs more than 1.
            || self.rate_limit.search_burst < 1
            || self.rate_limit.search_per_sec <= 0.0
        ) {
            anyhow::bail!("rate-limit bursts and refill rates must be positive");
        }
        // Negative is no window; at or past a claim's life, claims expire before the sweep.
        const CLAIM_LIFETIME_SECS: i64 = 7 * 24 * 3600;
        if self.federation.migration_delay_secs < 0
            || self.federation.migration_delay_secs >= CLAIM_LIFETIME_SECS
        {
            anyhow::bail!(
                "federation.migration_delay_secs must be at least 0 and less than \
                 {CLAIM_LIFETIME_SECS} (an import claim lives seven days, and a window that \
                 long outlasts every claim it waits on)"
            );
        }
        match self.mail.mode.as_str() {
            "none" => {}
            "webhook" => {
                if !(self.mail.webhook_url.starts_with("https://") || self.mail.webhook_url.starts_with("http://")) {
                    anyhow::bail!("mail.webhook_url must be an http(s) URL when mail.mode is webhook");
                }
            }
            other => anyhow::bail!("mail.mode must be none or webhook, not {other:?}"),
        }
        if self.backup.enabled && self.backup.remote.enabled {
            if self.backup.remote.bucket.is_empty() {
                anyhow::bail!("backup.remote.bucket must be set when the remote is enabled");
            }
            if self.backup.remote.endpoint.is_empty() {
                anyhow::bail!("backup.remote.endpoint must be set when the remote is enabled");
            }
        }
        for proxy in &self.rate_limit.trusted_proxies {
            proxy.parse::<std::net::IpAddr>()
                .map_err(|_| anyhow::anyhow!("rate_limit.trusted_proxies contains an invalid IP: {proxy}"))?;
        }
        // A zero is not "no limit": it is an output with no pixels.
        let l = &self.limits;
        if l.emoji_max_dimension < 1 || l.sticker_max_dimension < 1 {
            anyhow::bail!("limits.emoji_max_dimension and limits.sticker_max_dimension must be at least 1");
        }
        if l.expression_max_source_pixels < 1 || l.expression_max_total_pixels < 1 {
            anyhow::bail!("limits.expression_max_source_pixels and limits.expression_max_total_pixels must be at least 1");
        }
        if l.expression_max_frames < 1 || l.expression_max_duration_ms < 1 {
            anyhow::bail!("limits.expression_max_frames and limits.expression_max_duration_ms must be at least 1");
        }
        // Unsatisfiable threshold ordering would pin the server at one volume.
        let u = &self.updates;
        if u.check {
            if u.stale_after_days < 1 || u.urgent_after_days < u.stale_after_days {
                anyhow::bail!(
                    "updates.stale_after_days must be at least 1 and updates.urgent_after_days \
                     must not be smaller than it (they are the two steps of one escalation, and \
                     a louder threshold that arrives first is not a step)"
                );
            }
            if !(u.manifest_url.starts_with("https://") || u.manifest_url.starts_with("http://")) {
                anyhow::bail!(
                    "updates.manifest_url must be an https URL, or set updates.check = false to \
                     turn the check off deliberately"
                );
            }
        }
        // Zero grace is an abrupt shutdown; very long is a restart that never completes.
        if self.shutdown.grace_secs < 1 || self.shutdown.grace_secs > 300 {
            anyhow::bail!(
                "shutdown.grace_secs must be between 1 and 300 (it is a ceiling on how long \
                 stopping may take; a supervisor's own timeout has to be larger still, and \
                 nothing sensible waits five minutes to restart)"
            );
        }
        if self.shutdown.settle_ms > 5_000 {
            anyhow::bail!(
                "shutdown.settle_ms must be at most 5000 (it is the flush of close frames \
                 already written, not a wait for anything to be decided)"
            );
        }
        self.warn_about_voice_reachability();
        Ok(())
    }

    /// Voice connection plan logged at startup; warnings, since a missing relay is valid.
    fn warn_about_voice_reachability(&self) {
        if !self.voice.enabled {
            return;
        }
        let set = |o: &Option<String>| o.as_deref().is_some_and(|v| !v.is_empty());
        let secret = self.voice.turn_secret.as_deref().is_some_and(|v| !v.is_empty());
        let address =
            set(&self.voice.turn) || self.voice.regions.iter().any(|r| set(&r.turn));

        match (address, secret) {
            (true, true) => {}
            // Half a relay looks configured but behaves as absent (`relay_turn` needs the secret).
            (true, false) => tracing::warn!(
                target: crate::logcat::STARTUP,
                "voice: a TURN address is configured but voice.turn_secret is empty, so no                  credentials can be minted and the relay is never handed to any client. Set                  voice.turn_secret to the same value as the relay's coturn `static-auth-secret`."
            ),
            (false, true) => tracing::warn!(
                target: crate::logcat::STARTUP,
                "voice: voice.turn_secret is set but no TURN address is configured, so there is                  nothing to hand clients. Set voice.turn to the relay's host:port."
            ),
            // STUN only: no direct path on symmetric NAT or strict firewalls.
            (false, false) => tracing::warn!(
                target: crate::logcat::STARTUP,
                "voice: enabled with no TURN relay configured — the connection plan is STUN                  only. Calls between participants whose networks have no direct path will fail                  to connect. To fix, run a TURN relay reachable from the public internet on                  UDP and set voice.turn = \"host:port\" and voice.turn_secret to its shared                  secret. Note a TURN relay needs its own public UDP ports and cannot be                  reached through an HTTP-only ingress such as a Cloudflare Tunnel."
            ),
        }

        // Regions without an `sfu` are ignored, but the operator believes they count.
        let unaddressed: Vec<&str> = self
            .voice
            .regions
            .iter()
            .filter(|r| r.sfu.trim().is_empty())
            .map(|r| r.name.as_str())
            .collect();
        if !unaddressed.is_empty() {
            tracing::warn!(
                target: crate::logcat::STARTUP,
                regions = ?unaddressed,
                "voice: these SFU regions have no `sfu` address and are ignored. A region is the \
                 base URL of a telium-sfu, as in sfu = \"https://sfu.example\"."
            );
        }

        if self.voice.addressed_regions().next().is_none() {
            tracing::info!(
                target: crate::logcat::STARTUP,
                mesh_max_participants = self.voice.mesh_max_participants,
                "voice: no SFU regions configured; calls run peer-to-peer in mesh mode"
            );
        }

        // Enabled but admitting nobody: scrapes would 401 where nobody reads.
        if self.metrics.scrape_enabled {
            let usable = self.metrics.scrape_allow.iter().any(|a| {
                a.trim().parse::<std::net::IpAddr>().is_ok()
            });
            if self.metrics.scrape_token.trim().is_empty() && !usable {
                tracing::warn!(
                    target: crate::logcat::STARTUP,
                    "metrics: the scrape endpoint is enabled but has neither a token nor a                      usable address in `scrape_allow`, so every scrape will be refused"
                );
            }
        }
    }

    /// Tier-1 upload permission; `None` means closed, so the client runs origin setup.
    pub fn media_quota_for(&self, user_id: &str) -> Option<i64> {
        let p = &self.media_policy;
        if p.blocklist.iter().any(|u| u == user_id) {
            return None;
        }
        if p.allowlist.iter().any(|u| u == user_id) {
            return Some(p.quota_bytes);
        }
        match p.default {
            MediaDefault::Enabled => Some(i64::MAX),
            MediaDefault::Quota => Some(p.quota_bytes),
            MediaDefault::Disabled => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn sizes_take_human_strings() {
        let cfg: Config = toml::from_str(
            "[media_policy]\nmax_file_bytes = \"100MiB\"\nquota_bytes = \"1GiB\"\n\
             profile_asset_carveout_bytes = \"512KiB\"\n[federation]\n\
             media_cache_max_bytes = \"2GiB\"\nembed_video_max_bytes = \"32MB\"\n[relay]\n\
             max_tunnel_bytes = \"256MiB\"\ndaily_bytes_per_account = \"4 GiB\"\n",
        )
        .expect("human sizes parse");
        assert_eq!(cfg.media_policy.max_file_bytes, 104_857_600);
        assert_eq!(cfg.media_policy.quota_bytes, 1_073_741_824);
        assert_eq!(cfg.media_policy.profile_asset_carveout_bytes, 524_288);
        assert_eq!(cfg.federation.media_cache_max_bytes, 2 * 1024 * 1024 * 1024);
        // MB and MiB are different units on purpose: this is 32,000,000, not the default.
        assert_eq!(cfg.federation.embed_video_max_bytes, 32_000_000);
        assert_eq!(cfg.relay.max_tunnel_bytes, 268_435_456);
        assert_eq!(cfg.relay.daily_bytes_per_account, 4 * 1024 * 1024 * 1024);
    }

    #[test]
    fn optional_sizes_take_human_strings() {
        let cfg: Config = toml::from_str(
            "[[media_registry.hosts]]\norigin = \"files.example.org\"\nname = \"Example\"\n\
             max_file_bytes = \"2GiB\"\n",
        )
        .expect("an optional human size parses");
        assert_eq!(cfg.media_registry.hosts[0].max_file_bytes, Some(2 * 1024 * 1024 * 1024));

        let unstated: Config =
            toml::from_str("[[media_registry.hosts]]\norigin = \"a.example\"\n").expect("parses");
        assert_eq!(unstated.media_registry.hosts[0].max_file_bytes, None);
    }

    #[test]
    fn durations_take_human_strings() {
        let cfg: Config = toml::from_str(
            "[sessions]\nhome_session_ttl_secs = \"30d\"\nsigning_key_validity_secs = \"90d\"\n\
             [backup]\ninterval_secs = \"6h\"\ndrill_stale_after_secs = \"3d\"\n[limits]\n\
             expression_max_duration_ms = \"30s\"\n[shutdown]\nsettle_ms = \"0.25s\"\n[voice]\n\
             max_bitrate = \"2.5Mbps\"\ntoken_ttl_secs = \"10m\"\n[updates]\n\
             check_interval_secs = \"6h\"\nstale_after_days = \"2w\"\n[retention]\n\
             audit_log_days = \"104w\"\n",
        )
        .expect("human durations parse");
        assert_eq!(cfg.sessions.home_session_ttl_secs, 2_592_000);
        assert_eq!(cfg.sessions.signing_key_validity_secs, 7_776_000);
        assert_eq!(cfg.backup.interval_secs, 21_600);
        assert_eq!(cfg.backup.drill_stale_after_secs, 259_200);
        assert_eq!(cfg.limits.expression_max_duration_ms, 30_000);
        assert_eq!(cfg.shutdown.settle_ms, 250);
        assert_eq!(cfg.voice.max_bitrate, 2_500_000);
        assert_eq!(cfg.voice.token_ttl_secs, 600);
        assert_eq!(cfg.updates.check_interval_secs, 21_600);
        assert_eq!(cfg.updates.stale_after_days, 14);
        assert_eq!(cfg.retention.audit_log_days, 728);
    }

    #[test]
    fn compound_durations_add_up() {
        let cfg: Config = toml::from_str(
            "[failover]\nstale_after_secs = \"1d 12h\"\n[archive]\nsweep_interval_secs = \"1h30m\"\n",
        )
        .expect("compound durations parse");
        assert_eq!(cfg.failover.stale_after_secs, 129_600);
        assert_eq!(cfg.archive.sweep_interval_secs, 5_400);
    }

    #[test]
    fn plain_integers_still_mean_what_the_key_name_says() {
        let cfg: Config = toml::from_str(
            "[media_policy]\nmax_file_bytes = 104857600\nattachment_max_age_days = 30\n\
             [voice]\nmax_bitrate = 2500000\n",
        )
        .expect("plain integers keep parsing");
        assert_eq!(cfg.media_policy.max_file_bytes, 104_857_600);
        assert_eq!(cfg.media_policy.attachment_max_age_days, 30);
        assert_eq!(cfg.voice.max_bitrate, 2_500_000);
    }

    #[test]
    fn human_values_refuse_nonsense_loudly() {
        for (src, fragment) in [
            ("[media_policy]\nmax_file_bytes = \"15qb\"\n", "unknown size unit"),
            ("[media_policy]\nmax_file_bytes = \"a lot\"\n", "is not a size"),
            ("[media_policy]\nmax_file_bytes = \"MB\"\n", "no number"),
            ("[sessions]\nhome_session_ttl_secs = \"5x\"\n", "unknown duration unit"),
            ("[sessions]\nhome_session_ttl_secs = \"-5m\"\n", "wrongly"),
            ("[media_policy]\nattachment_max_age_days = \"1.5d\"\n", "not whole"),
            ("[media_policy]\nattachment_max_age_days = \"6h\"\n", "unknown span unit"),
            ("[voice]\nmax_bitrate = \"2.5MB/s\"\n", "unknown rate unit"),
        ] {
            let err = toml::from_str::<Config>(src)
                .expect_err("a nonsensical human value must be refused");
            assert!(
                format!("{err}").contains(fragment),
                "`{src}` was refused, but not with `{fragment}`: {err}"
            );
        }
    }
    #[test]
    fn printing_the_whole_configuration_does_not_print_a_single_credential() {
        let mut cfg = Config::default();
        cfg.mail.webhook_token = "leak-1".into();
        cfg.backup.remote.access_key_id = "leak-2".into();
        cfg.backup.remote.secret_access_key = "leak-3".into();
        cfg.voice.turn_secret = Some("leak-4".into());
        cfg.metrics.scrape_token = "leak-5".into();
        let printed = format!("{cfg:?}");
        assert!(!printed.contains("leak-"), "a credential reached Debug output");
        assert!(printed.contains("<redacted>"));
        assert!(format!("{:?}", Config::default()).contains("<unset>"));
    }

    #[test]
    fn retention_knobs_default_off_and_parse_when_set() {
        let default_cfg: Config = toml::from_str("").expect("default config parses");
        assert_eq!(default_cfg.media_policy.default_expiry_secs, 0);
        assert_eq!(default_cfg.media_policy.attachment_max_age_days, 0);

        let tuned: Config = toml::from_str(
            "[media_policy]\ndefault_expiry_secs = 604800\nattachment_max_age_days = 30\n",
        )
        .expect("tuned media policy parses");
        assert_eq!(tuned.media_policy.default_expiry_secs, 604800);
        assert_eq!(tuned.media_policy.attachment_max_age_days, 30);
    }

    #[test]
    fn account_home_recommendations_are_explicit_opt_in() {
        let default_cfg: Config = toml::from_str("").expect("default config parses");
        assert!(!default_cfg.registration.recommendations.accepting);
        assert_eq!(default_cfg.registration.recommendations.referral_weight, 1);

        let opted_in: Config = toml::from_str(
            "[registration.recommendations]\naccepting = true\nreferral_weight = 999\n",
        )
        .expect("recommendation config parses");
        assert!(opted_in.registration.recommendations.accepting);
        assert_eq!(opted_in.registration.recommendations.referral_weight, 999);
    }

    #[test]
    fn usage_reporting_defaults_on_and_the_switch_is_real() {
        let default_cfg: Config = toml::from_str("").expect("default config parses");
        assert!(default_cfg.usage.report);
        assert_eq!(default_cfg.usage.interval_secs, 24 * 60 * 60);

        let dark: Config = toml::from_str(
            "[usage]\nreport = false\ncount_url = \"https://count.internal.invalid/ping\"\n",
        )
        .expect("usage opt-out parses");
        assert!(!dark.usage.report);
        assert_eq!(dark.usage.count_url, "https://count.internal.invalid/ping");
    }

    #[test]
    fn gofile_playback_proxy_defaults_on_and_can_be_disabled() {
        let default_cfg: Config = toml::from_str("").expect("default config parses");
        assert!(default_cfg.media_registry.gofile_playback_proxy);

        let disabled: Config = toml::from_str(
            "[media_registry]\ngofile_playback_proxy = false\n",
        )
        .expect("proxy opt-out parses");
        assert!(!disabled.media_registry.gofile_playback_proxy);
    }

    #[test]
    fn gofile_upload_is_always_reported_browser_direct() {
        let cfg: Config = toml::from_str(
            r#"
[[media_registry.external_hosts]]
id = "gofile"
provider = "gofile"
domain = "gofile.io"
upload_url = "https://upload.gofile.io/uploadfile"
browser_direct = false
"#,
        )
        .expect("Gofile host config parses");

        assert!(cfg.media_registry.external_hosts[0].browser_direct_enabled());
    }

    #[test]
    fn a_cooling_off_window_has_to_be_one_a_migration_can_survive() {
        let ok = |toml_src: &str| {
            let cfg: Config = toml::from_str(toml_src).expect("config parses");
            cfg.validate()
        };
        let base = "server_name = \"a.test\"\n[federation]\n";

        assert!(ok(&format!("{base}migration_delay_secs = 3600\n")).is_ok());
        assert!(ok(&format!("{base}migration_delay_secs = 0\n")).is_ok());

        for bad in ["-1", "604800", "604801"] {
            let out = ok(&format!("{base}migration_delay_secs = {bad}\n"));
            assert!(out.is_err(), "{bad} was accepted as a cooling-off window");
            let err = out.unwrap_err();
            assert!(
                format!("{err}").contains("migration_delay_secs"),
                "refused for some other reason: {err}"
            );
        }
    }

    #[test]
    fn a_region_with_no_sfu_address_is_not_a_region() {
        let named_only: Config = toml::from_str(
            "[[voice.regions]]\nname = \"local\"\n",
        )
        .expect("a region with only a name parses");
        assert_eq!(named_only.voice.regions.len(), 1);
        assert_eq!(named_only.voice.addressed_regions().count(), 0);

        let blank: Config = toml::from_str(
            "[[voice.regions]]\nname = \"local\"\nsfu = \"   \"\n",
        )
        .expect("a region with a blank address parses");
        assert_eq!(blank.voice.addressed_regions().count(), 0);

        let addressed: Config = toml::from_str(
            "[[voice.regions]]\nname = \"staging\"\nsfu = \"https://sfu.example\"\n",
        )
        .expect("a region with an address parses");
        assert_eq!(addressed.voice.addressed_regions().count(), 1);

        // Shape of the compiled-in default (no [voice] section).
        assert_eq!(Config::default().voice.addressed_regions().count(), 0);
    }

    #[test]
    fn invite_links_name_the_server_on_the_portal_unless_the_operator_opts_out() {
        let mut cfg: Config = toml::from_str("").expect("default config parses");
        cfg.server_name = "guilds.example".into();
        cfg.public_base_url = "https://guilds.example".into();

        // A config that never mentions the portal mints the safe shape.
        assert_eq!(cfg.web.invite_portal, "https://telium.chat");
        assert_eq!(
            cfg.invite_link("~k7m2pxqa"),
            "https://telium.chat/invite/~k7m2pxqa@guilds.example"
        );
        assert_eq!(cfg.invite_portal_field().as_deref(), Some("https://telium.chat"));

        cfg.web.invite_portal = "self".into();
        assert_eq!(cfg.invite_link("~k7m2pxqa"), "https://guilds.example/invite/~k7m2pxqa");
        assert_eq!(cfg.invite_portal_field(), None);

        cfg.web.invite_portal = "https://portal.example/".into();
        assert_eq!(
            cfg.invite_link("~k7m2pxqa"),
            "https://portal.example/invite/~k7m2pxqa@guilds.example"
        );
    }

    #[test]
    fn the_invite_portal_is_https_or_self() {
        let cfg_with = |portal: &str| {
            let mut cfg: Config = toml::from_str("").expect("default config parses");
            cfg.server_name = "guilds.example".into();
            cfg.public_base_url = "https://guilds.example".into();
            cfg.web.invite_portal = portal.into();
            cfg
        };
        for accepted in ["https://telium.chat", "https://portal.example", "self"] {
            if let Err(err) = cfg_with(accepted).validate() {
                assert!(!err.to_string().contains("web.invite_portal"), "{err}");
            }
        }
        for refused in ["http://portal.example", "", "telium.chat", "ftp://portal.example"] {
            let err = cfg_with(refused)
                .validate()
                .err()
                .expect("a non-https portal is refused");
            assert!(err.to_string().contains("web.invite_portal"), "{err}");
        }
    }
}
