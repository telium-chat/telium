//! An estimate of what this relay forwards, kept so an operator with a
//! transfer cap can be protected from it.
//!
//! LiveKit moves the actual media and is the authoritative meter; this ledger
//! approximates it from the declared track rates the sweep already sees. A
//! room of n participants forwards every sender's stream to n-1 receivers, so
//! per sweep interval:
//!
//!   bytes ≈ Σ_senders (declared video + unmuted audio) x (n-1) x interval
//!
//! It deliberately over-estimates (idle senders still declare layers) — the
//! right failure mode for protecting an operator on a hard traffic cap — and
//! it is labelled an estimate everywhere it is shown. It is also per-origin:
//! the dashboard's per-guild usage and a per-origin block list both read it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    /// origin (guild server_name) -> day ("YYYY-MM-DD") -> estimated bytes.
    by_origin: BTreeMap<String, BTreeMap<String, i64>>,
}

pub struct Usage {
    inner: Mutex<Ledger>,
    path: PathBuf,
}

fn day_of(now_ms: i64) -> String {
    // UTC day bucket; a ledger is a guardrail, not an invoice.
    let days = now_ms.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-to-civil algorithm; no chrono dependency for one bucket key.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

impl Usage {
    /// Loads the ledger from `dir/usage.json`, tolerating absence and corruption:
    /// a lost ledger only resets the estimate to zero.
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("usage.json");
        let ledger = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Ledger>(&bytes).ok())
            .unwrap_or_default();
        Self { inner: Mutex::new(ledger), path }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Adds one sweep's estimated forwarding for `origin`.
    pub fn add(&self, origin: &str, bytes: i64) {
        if bytes <= 0 || origin.is_empty() {
            return;
        }
        let mut ledger = self.lock();
        *ledger.by_origin.entry(origin.to_string()).or_default().entry(day_of(now_ms())).or_insert(0) += bytes;
        self.persist(&ledger);
    }

    /// Estimated bytes forwarded in the trailing `days`, across all origins.
    pub fn total_estimate(&self, now_ms: i64, days: u32) -> i64 {
        let ledger = self.lock();
        sum_window(&ledger, None, now_ms, days)
    }

    /// Estimated bytes forwarded in the trailing `days` for one origin.
    pub fn origin_estimate(&self, origin: &str, now_ms: i64, days: u32) -> i64 {
        let ledger = self.lock();
        sum_window(&ledger, Some(origin), now_ms, days)
    }

    /// The dashboard's view: per-origin trailing-window estimates, heaviest first.
    pub fn snapshot(&self, now_ms: i64, days: u32) -> Vec<(String, i64)> {
        let ledger = self.lock();
        let mut rows: Vec<(String, i64)> = ledger
            .by_origin
            .keys()
            .map(|origin| (origin.clone(), sum_window(&ledger, Some(origin), now_ms, days)))
            .filter(|(_, bytes)| *bytes > 0)
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1));
        rows
    }

    /// Persists the ledger now. `add` persists as it goes; this exists for
    /// writers that mutate the ledger through other means (tests) and for a
    /// tidy shutdown.
    pub fn flush(&self) {
        let ledger = self.lock();
        self.persist(&ledger);
    }

    fn persist(&self, ledger: &Ledger) {
        // Best effort: an unwritable state dir costs the estimate, never a call.
        if let Ok(bytes) = serde_json::to_vec(ledger) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

fn sum_window(ledger: &Ledger, origin: Option<&str>, now_ms: i64, days: u32) -> i64 {
    // Trailing N calendar days, today included: a ledger is a guardrail, not an invoice.
    let today_start = now_ms.div_euclid(86_400_000) * 86_400_000;
    let cutoff = today_start - (days.max(1) as i64 - 1) * 86_400_000;
    let in_window = |day: &str| {
        let (y, m, d) = parse_day(day);
        let day_start = days_from_civil(y, m, d) * 86_400_000;
        day_start >= cutoff && day_start <= today_start
    };
    let origins: Box<dyn Iterator<Item = (&String, &BTreeMap<String, i64>)>> = match origin {
        Some(o) => Box::new(ledger.by_origin.iter().filter(move |(k, _)| k.as_str() == o)),
        None => Box::new(ledger.by_origin.iter()),
    };
    origins
        .flat_map(|(_, days_map)| days_map.iter())
        .filter(|(day, _)| in_window(day))
        .map(|(_, bytes)| *bytes)
        .sum()
}

fn parse_day(day: &str) -> (i64, u32, u32) {
    let mut parts = day.split('-');
    let y = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let m = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let d = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (y, m, d)
}

/// Inverse of `civil_from_days` (Hinnant), for window comparisons.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("telium-sfu-usage-{}", std::process::id()));
        let dir = dir.join(format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn day_buckets_are_round_trippable() {
        let (y, m, d) = civil_from_days(days_from_civil(2026, 11, 3));
        assert_eq!((y, m, d), (2026, 11, 3));
        assert_eq!(day_of(days_from_civil(2026, 11, 3) * 86_400_000), "2026-11-03");
    }

    #[test]
    fn usage_accumulates_per_origin_and_day_and_survives_a_reload() {
        let dir = temp_dir();
        let now = days_from_civil(2026, 11, 3) * 86_400_000 + 12 * 3_600_000;
        {
            let usage = Usage::load(&dir);
            usage.add("guild.one", 1_000);
            usage.add("guild.one", 2_000);
            usage.add("guild.two", 500);
            // Pretend yesterday forwarded 7 KB as well, by writing its bucket
            // directly -- `add` always lands in today's bucket.
            {
                let mut ledger = usage.lock();
                let day = day_of(now - 86_400_000);
                ledger.by_origin.entry("guild.one".to_string()).or_default().insert(day, 7_000);
                drop(ledger);
                usage.flush();
            }
            assert_eq!(usage.origin_estimate("guild.one", now, 30), 10_000);
            assert_eq!(usage.total_estimate(now, 30), 10_500);
            assert_eq!(usage.origin_estimate("guild.one", now, 1), 3_000, "yesterday is outside a 1-day window");
        }
        // Reload: persistence is best effort but local temp dirs work.
        let reloaded = Usage::load(&dir);
        assert_eq!(reloaded.total_estimate(now, 30), 10_500);
        let rows = reloaded.snapshot(now, 30);
        assert_eq!(rows.first().map(|(o, _)| o.as_str()), Some("guild.one"));
    }

    #[test]
    fn an_empty_or_corrupt_ledger_is_zero() {
        let dir = temp_dir();
        std::fs::write(dir.join("usage.json"), b"not json").unwrap();
        let usage = Usage::load(&dir);
        assert_eq!(usage.total_estimate(now_ms(), 30), 0);
    }
}
