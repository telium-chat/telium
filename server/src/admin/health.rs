
use crate::admin::require_admin;
use crate::auth::HomeAuth;
use crate::error::ApiResult;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

const MINUTE_MS: i64 = 60 * 1000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DAY_MS: i64 = 24 * HOUR_MS;

const KEY_WARN_MS: i64 = 30 * DAY_MS;
const KEY_CRITICAL_MS: i64 = 3 * DAY_MS;

const BACKLOG_STUCK_MS: i64 = 6 * HOUR_MS;

const REPORT_STALE_MS: i64 = 7 * DAY_MS;

const STANDBY_SILENT_MS: i64 = 15 * MINUTE_MS;

const STANDBY_BEHIND_ENTRIES: i64 = 10_000;

const SFU_PROBE_STALE_MS: i64 = 15 * MINUTE_MS;

const RECLAIMABLE_NOTICE_BYTES: i64 = 1024 * 1024 * 1024;

struct Signal {
    key: &'static str,
    severity: Severity,
    title: String,
    cause: String,
    action: String,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Severity {
    Notice,
    Warning,
    Critical,
}

impl Severity {
    fn as_str(self) -> &'static str {
        match self {
            Severity::Notice => "notice",
            Severity::Warning => "warning",
            Severity::Critical => "critical",
        }
    }
}

struct Findings(Vec<Signal>);

impl Findings {
    fn say(
        &mut self,
        key: &'static str,
        severity: Severity,
        title: impl Into<String>,
        cause: impl Into<String>,
        action: impl Into<String>,
    ) {
        self.0.push(Signal {
            key,
            severity,
            title: title.into(),
            cause: cause.into(),
            action: action.into(),
        });
    }
}

fn human(ms: i64) -> String {
    let ms = ms.max(0);
    let plural = |n: i64, unit: &str| {
        if n == 1 {
            format!("1 {unit}")
        } else {
            format!("{n} {unit}s")
        }
    };
    if ms >= DAY_MS {
        plural(ms / DAY_MS, "day")
    } else if ms >= HOUR_MS {
        plural(ms / HOUR_MS, "hour")
    } else if ms >= MINUTE_MS {
        plural(ms / MINUTE_MS, "minute")
    } else {
        plural(ms / 1000, "second")
    }
}

fn gib(bytes: i64) -> String {
    format!("{:.1} GiB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

pub async fn get(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let now = now_ms();
    let mut f = Findings(Vec::new());

    continuity(&state, now, &mut f).await;
    backups(&state, now, &mut f);
    keys(&state, now, &mut f);
    federation(&state, now, &mut f).await;
    replication(&state, now, &mut f).await;
    voice(&state, now, &mut f).await;
    scanning(&state, &mut f);
    storage(&state, &mut f).await;
    release(&state, now, &mut f).await;

    f.0.sort_by(|a, b| b.severity.cmp(&a.severity));

    let verdict = f
        .0
        .iter()
        .map(|s| s.severity)
        .max()
        .map(Severity::as_str)
        .unwrap_or("ok");

    Ok(Json(json!({
        "checked_at": now,
        "verdict": verdict,
        "signals": f.0.iter().map(|s| json!({
            "key": s.key,
            "severity": s.severity.as_str(),
            "title": s.title,
            "cause": s.cause,
            "action": s.action,
        })).collect::<Vec<_>>(),
    })))
}

async fn continuity(state: &AppState, now: i64, f: &mut Findings) {
    if let Ok(Some(authority)) = crate::promotion::authority(state).await {
        f.say(
            "authority.superseded",
            Severity::Critical,
            "another server holds this domain's authority",
            format!(
                "{} was promoted in this server's place at sequence {}. This process is \
                 read-only and accepts no writes.",
                authority.domain, authority.sequence
            ),
            "Either retire this instance, or resynchronise it against the promoted server \
             before bringing it back as the authority.",
        );
    }

    if state.shut_down.load(std::sync::atomic::Ordering::Relaxed) {
        f.say(
            "sunset.finalized",
            Severity::Critical,
            "this server has been shut down",
            "The sunset was finalized. Sign-ins and account bundle exports still work; \
             everything else is refused.",
            "Nothing further is required unless this was not intended, in which case the \
             `shutdown_final` row in `server_meta` is what holds it.",
        );
    } else if let Some(sunset) = crate::sunset::current(state).await {
        let effective = sunset.get("effective_at").and_then(Value::as_i64);
        let mode = sunset.get("mode").and_then(Value::as_str).unwrap_or("announced");
        let when = match effective {
            Some(at) if at > now => format!("in {}", human(at - now)),
            Some(_) => "already".to_string(),
            None => "at an unset date".to_string(),
        };
        f.say(
            "sunset.announced",
            Severity::Warning,
            "a shutdown has been announced",
            format!("Mode `{mode}`; it takes effect {when}."),
            "Members should export their accounts before then. Cancel it from the \
             Continuity pane if it was announced in error.",
        );
    }

    if state.cfg.failover.standbys.is_empty() && state.cfg.roles.identity {
        f.say(
            "standby.none",
            Severity::Notice,
            "no standby is paired with this server",
            "`failover.standbys` is empty, so no other server holds a live copy of this \
             database and none could be promoted in its place.",
            "If this server going away permanently is unacceptable, pair a standby: see \
             `telium standby pair` in docs/operator-guide.md.",
        );
    }
}

fn backups(state: &AppState, _now: i64, f: &mut Findings) {
    let report = crate::backup::report(&state.cfg);
    let enabled = report["enabled"].as_bool().unwrap_or(false);

    if !enabled {
        f.say(
            "backup.disabled",
            Severity::Warning,
            "backups are switched off",
            "`[backup] enabled` is false, so nothing on this server is being copied \
             anywhere. A lost disk is a lost server.",
            "Set `[backup] enabled = true` and point `dir` somewhere that is not the data \
             directory.",
        );
        return;
    }

    match report["age_ms"].as_i64() {
        None => f.say(
            "backup.never",
            Severity::Critical,
            "no backup has ever been taken",
            "Backups are enabled and there is no archive in the backup directory.",
            "Run `telium backup now` and check the log: an enabled backup that has produced \
             nothing is usually a permissions problem on `backup.dir`.",
        ),
        Some(age) if report["stale"].as_bool().unwrap_or(false) => f.say(
            "backup.stale",
            Severity::Critical,
            "the newest backup is out of date",
            format!(
                "The newest archive is {} old, past the `stale_after_secs` this server was \
                 configured with.",
                human(age)
            ),
            "Run `telium backup now`. If it succeeds by hand, the scheduled run is what is \
             broken -- check the log around the last expected interval.",
        ),
        Some(_) => {}
    }

    if report["key_stranded"].as_bool().unwrap_or(false) {
        f.say(
            "backup.key_stranded",
            Severity::Critical,
            "the backup key is stored with the backups",
            "The encryption key file lives inside the directory tree the archives are in. \
             Whatever takes one takes the other, and an encrypted archive without its key \
             restores nothing.",
            "Move `backup.key_file` off this machine, or copy it somewhere you would still \
             have if this machine were gone.",
        );
    }

    match report["placement"].as_str() {
        Some("inside") => f.say(
            "backup.placement",
            Severity::Warning,
            "backups are inside the data they back up",
            "The archive directory is under the data directory, or the data directory is \
             under it. Removing the volume, or one bad `rm`, takes both.",
            "Point `backup.dir` at a separate filesystem, and turn on `[backup.remote]` for \
             a copy that survives losing the machine.",
        ),
        Some("same_device") => f.say(
            "backup.placement",
            Severity::Notice,
            "backups are on the same disk as the data",
            "The archives are a separate tree on the same filesystem. That survives a bad \
             migration and a deleted volume; it does not survive the disk.",
            "Turn on `[backup.remote]` if losing this machine is a case you want covered.",
        ),
        _ => {}
    }

    if !report["offsite"].as_bool().unwrap_or(false) {
        f.say(
            "backup.offsite",
            Severity::Notice,
            "no off-box copy is configured",
            "`[backup.remote]` is off, so every copy of this server is on this machine.",
            "Configure `[backup.remote]` to push archives somewhere else.",
        );
    } else if report["remote"]["stale"].as_bool().unwrap_or(false) {
        let cause = match report["remote"]["age_ms"].as_i64() {
            Some(age) => format!("The last off-box copy landed {} ago.", human(age)),
            None => "No off-box copy has ever landed.".to_string(),
        };
        let detail = report["remote"]["last_error"]
            .as_str()
            .map(|e| format!(" The last attempt said: {e}"))
            .unwrap_or_default();
        f.say(
            "backup.remote_stale",
            Severity::Critical,
            "off-box backups have stopped arriving",
            format!("{cause}{detail}"),
            "Check the remote's credentials and reachability; the local archive being fresh \
             is not a substitute for this.",
        );
    }

    if let Some(err) = report["last_error"].as_str() {
        f.say(
            "backup.error",
            Severity::Warning,
            "the last backup run reported an error",
            format!("The backup worker recorded: {err}"),
            "Run `telium backup now` to reproduce it with the message in front of you.",
        );
    }
}

fn keys(state: &AppState, now: i64, f: &mut Findings) {
    let left = state.key.valid_until - now;
    if left <= 0 {
        f.say(
            "keys.expired",
            Severity::Critical,
            "this server's federation key has expired",
            "Every request this server signs is now rejected by every peer that checks the \
             validity window, which is all of them.",
            "Restart the server: a new key is minted at startup when the current one is \
             past its validity. If that does not help, the `server_keys` table is what to \
             look at.",
        );
    } else if left <= KEY_CRITICAL_MS {
        f.say(
            "keys.expiring",
            Severity::Critical,
            "this server's federation key expires within days",
            format!(
                "The signing key `{}` is valid for another {}. When it lapses, peers stop \
                 accepting anything this server signs.",
                state.key.key_id,
                human(left)
            ),
            "Restart the server at a time of your choosing to mint the next key, rather than \
             having the lapse choose for you.",
        );
    } else if left <= KEY_WARN_MS {
        f.say(
            "keys.expiring",
            Severity::Warning,
            "this server's federation key expires soon",
            format!(
                "The signing key `{}` is valid for another {}.",
                state.key.key_id,
                human(left)
            ),
            "A restart mints the next key. Schedule one before the window closes.",
        );
    }
}

async fn federation(state: &AppState, now: i64, f: &mut Findings) {
    let g = crate::metrics::sample_gauges(state, false).await;

    if let (Some(depth), Some(oldest)) = (g.federation_backlog, g.federation_backlog_oldest_ms) {
        if depth > 0 && oldest > BACKLOG_STUCK_MS {
            f.say(
                "federation.backlog",
                Severity::Warning,
                "federated messages are not being delivered",
                format!(
                    "{depth} undelivered items are queued and the oldest has been waiting {}. \
                     Backoff alone does not explain a wait that long.",
                    human(oldest)
                ),
                "Open the Federation pane and look at which peers are failing; a single \
                 unreachable destination is the usual cause.",
            );
        }
    }

    if let (Some(peers), Some(failing)) = (g.federation_peers, g.federation_peers_failing) {
        if failing > 0 && peers > 0 && failing * 2 >= peers {
            f.say(
                "federation.peers_failing",
                Severity::Warning,
                "most known peers are failing",
                format!(
                    "{failing} of {peers} known servers are in a failing state. When it is \
                     this many at once the shared thing -- this server's DNS, egress or \
                     clock -- is the more likely cause than all of theirs."
                ),
                "Check outbound connectivity and this machine's clock, then use Revalidate \
                 in the Federation pane.",
            );
        }
    }

    if let Some(open) = g.reports_open {
        if open > 0 {
            let oldest: Option<i64> = sqlx::query_scalar(
                "SELECT MIN(created_at) FROM reports WHERE status = 'open'",
            )
            .fetch_optional(&state.pool)
            .await
            .ok()
            .flatten()
            .flatten();
            if let Some(at) = oldest {
                let waiting = now - at;
                if waiting > REPORT_STALE_MS {
                    f.say(
                        "reports.stale",
                        Severity::Warning,
                        "the report queue has not been read",
                        format!(
                            "{open} reports are open and the oldest has been waiting {}.",
                            human(waiting)
                        ),
                        "Work the queue in the Moderation pane. Peers that report to a server \
                         which never answers eventually stop federating with it.",
                    );
                }
            }
        }
    }

    if state.cfg.moderation.abuse_contact.is_none() {
        f.say(
            "moderation.no_contact",
            Severity::Notice,
            "no abuse contact is published",
            "`[moderation] abuse_contact` is unset, so another operator with a complaint \
             about this server has no address to send it to.",
            "Set `[moderation] abuse_contact` to an address somebody reads.",
        );
    }
}

async fn replication(state: &AppState, now: i64, f: &mut Findings) {
    if !state.cfg.failover.standbys.is_empty() {
        let head: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM repl_log")
            .fetch_one(&state.pool)
            .await
            .unwrap_or(0);

        for standby in &state.cfg.failover.standbys {
            let ack: Option<(i64, i64)> =
                sqlx::query_as("SELECT seq, at FROM repl_ack WHERE standby = ?")
                    .bind(standby)
                    .fetch_optional(&state.pool)
                    .await
                    .ok()
                    .flatten();
            match ack {
                None => f.say(
                    "standby.never",
                    Severity::Warning,
                    format!("standby {standby} has never pulled"),
                    format!(
                        "{standby} is authorised to stream this server's log and has not \
                         acknowledged a single entry. It holds no copy, so it could not be \
                         promoted."
                    ),
                    format!(
                        "On {standby}, add this server to `failover.replicate` and check it \
                         can reach this one."
                    ),
                ),
                Some((seq, at)) => {
                    let silent = now - at;
                    if silent > STANDBY_SILENT_MS {
                        f.say(
                            "standby.silent",
                            Severity::Warning,
                            format!("standby {standby} has gone quiet"),
                            format!(
                                "Its last acknowledgement was {} ago, at entry {seq} of {head}. \
                                 Whatever it holds is that old.",
                                human(silent)
                            ),
                            format!(
                                "Check that {standby} is running and can still reach this \
                                 server. Until it resumes, a promotion would lose everything \
                                 written since."
                            ),
                        );
                    } else if head - seq > STANDBY_BEHIND_ENTRIES {
                        f.say(
                            "standby.behind",
                            Severity::Warning,
                            format!("standby {standby} is falling behind"),
                            format!(
                                "It is {} entries behind (at {seq} of {head}) while still \
                                 pulling, which means it cannot keep up with the write rate.",
                                head - seq
                            ),
                            "Lower `failover.poll_secs` or raise `failover.batch` on the \
                             standby, or find out what is slowing its pull."
                                .to_string(),
                        );
                    }
                }
            }
        }
    }

    let mirrors: Vec<(String, i64, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT origin, cursor, applied_at, promoted, last_error FROM replica_state",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let stale_after = state.cfg.failover.stale_after_secs.max(1) * 1000;
    for (origin, cursor, applied_at, promoted, last_error) in mirrors {
        if promoted != 0 {
            continue;
        }
        match applied_at {
            None | Some(0) => f.say(
                "mirror.never",
                Severity::Warning,
                format!("the copy of {origin} has never synced"),
                format!(
                    "This server is configured to mirror {origin} and has applied nothing. \
                     There is no copy to serve if {origin} stops answering."
                ),
                format!(
                    "Run `telium standby sync {origin}` and read the error. Usually {origin} \
                     has not added this server to its own `failover.standbys`."
                ),
            ),
            Some(at) => {
                let behind = now - at;
                if behind > stale_after * 4 {
                    f.say(
                        "mirror.stale",
                        Severity::Warning,
                        format!("the copy of {origin} is falling behind"),
                        format!(
                            "The newest change applied from {origin} is {} old, at entry \
                             {cursor}.",
                            human(behind)
                        ),
                        format!(
                            "Check that {origin} is reachable from here. `telium standby sync \
                             {origin}` pulls once and reports what happened."
                        ),
                    );
                }
            }
        }
        if let Some(err) = last_error {
            f.say(
                "mirror.error",
                Severity::Warning,
                format!("replication from {origin} reported an error"),
                format!("The last pull from {origin} said: {err}"),
                format!("`telium standby sync {origin}` reproduces it in the foreground."),
            );
        }
    }
}

async fn voice(state: &AppState, now: i64, f: &mut Findings) {
    if !state.cfg.voice.enabled || state.cfg.voice.addressed_regions().next().is_none() {
        return;
    }

    let rows: Vec<(String, i64, i64, i64, Option<String>)> = sqlx::query_as(
        "SELECT region, healthy, failures, checked_at, detail FROM sfu_health",
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    let known: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    for region in &state.cfg.voice.regions {
        if !known.contains(&region.name.as_str()) {
            f.say(
                "sfu.unprobed",
                Severity::Warning,
                format!("voice region {} has never been checked", region.name),
                format!(
                    "{} is configured as a voice region and the health prober has never \
                     recorded a result for it. Clients may be handed an endpoint nobody has \
                     confirmed answers.",
                    region.name
                ),
                format!("Check that {} is running and reachable from this server.", region.sfu),
            );
        }
    }

    for (region, healthy, failures, checked_at, detail) in rows {
        let age = now - checked_at;
        if age > SFU_PROBE_STALE_MS {
            f.say(
                "sfu.probe_stale",
                Severity::Warning,
                format!("voice region {region} has not been checked recently"),
                format!(
                    "Its health was last recorded {} ago. Whatever the row says is that old, \
                     so the region's state is effectively unknown.",
                    human(age)
                ),
                "The voice health probe has stopped running. Check the server log for the \
                 voice worker."
                    .to_string(),
            );
            continue;
        }
        if healthy == 0 {
            let why = detail
                .map(|d| format!(" The probe said: {d}"))
                .unwrap_or_default();
            f.say(
                "sfu.unhealthy",
                Severity::Warning,
                format!("voice region {region} is not answering"),
                format!(
                    "The health probe has failed {failures} times in a row.{why} Calls routed \
                     to this region will not connect."
                ),
                format!(
                    "Restart or repair the SFU for {region}. Until it recovers, clients fall \
                     back to whatever other region is healthy."
                ),
            );
        }
    }
}

fn scanning(state: &AppState, f: &mut Findings) {
    if !state.cfg.roles.media {
        return;
    }
    if state.hash_lists.entries() == 0 {
        f.say(
            "scanner.unarmed",
            Severity::Notice,
            "uploads are not screened against any hash list",
            "This server accepts media and `[moderation] upload_hash_lists` is empty, so \
             every upload is stored without being checked against known-bad content.",
            "Point `[moderation] upload_hash_lists` at a list. Known-bad hashes are the one \
             screening measure that costs nothing per upload.",
        );
    }
}

async fn storage(state: &AppState, f: &mut Findings) {
    if !state.cfg.roles.media {
        return;
    }

    let unreferenced: Option<(i64, i64)> =
        sqlx::query_as("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM media WHERE refcount <= 0")
            .fetch_one(&state.pool)
            .await
            .ok();
    if let Some((objects, bytes)) = unreferenced {
        if bytes >= RECLAIMABLE_NOTICE_BYTES {
            f.say(
                "storage.reclaimable",
                Severity::Notice,
                "there is media nothing refers to",
                format!(
                    "{objects} objects totalling {} are no longer referenced by any message, \
                     profile or guild.",
                    gib(bytes)
                ),
                "Reclaim it now with Sweep in the Storage pane; otherwise the scheduled \
                 sweep gets to it.",
            );
        }
    }

    let ceiling = state.cfg.federation.media_cache_max_bytes;
    if ceiling > 0 {
        let cached: i64 =
            sqlx::query_scalar("SELECT COALESCE(SUM(size), 0) FROM media_cache")
                .fetch_one(&state.pool)
                .await
                .unwrap_or(0);
        if cached > ceiling + ceiling / 2 {
            f.say(
                "storage.cache_over",
                Severity::Notice,
                "the remote media cache is over its ceiling",
                format!(
                    "The cache holds {} against a `media_cache_max_bytes` of {}.",
                    gib(cached),
                    gib(ceiling)
                ),
                "Sweep in the Storage pane trims it now. If it climbs back, the ceiling is \
                 lower than this server's traffic warrants.",
            );
        }
    }
}

async fn release(state: &AppState, now: i64, f: &mut Findings) {
    let status = state.updates.read().await.clone();
    let cfg = &state.cfg.updates;
    let severity = match crate::updates::severity(&status, now, cfg) {
        crate::updates::Severity::Quiet => return,
        crate::updates::Severity::Notice => Severity::Notice,
        crate::updates::Severity::Warn => Severity::Warning,
        crate::updates::Severity::Urgent => Severity::Critical,
    };
    let Some(message) = crate::updates::describe(&status, now) else {
        return;
    };
    f.say(
        "updates.behind",
        severity,
        "this server is not running the current release",
        message,
        "Pull the latest release and restart. The Server pane carries the exact version \
         this build reports.",
    );
}
