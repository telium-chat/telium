//! Single-instance lease in the database: a second process against the same database refuses to start.

use crate::util::now_ms;
use sqlx::SqlitePool;

const HEARTBEAT_SECS: u64 = 30;

/// Four missed heartbeats, so long pauses don't self-evict; a clean shutdown or dead PID releases sooner.
const STALE_MS: i64 = (HEARTBEAT_SECS as i64) * 1000 * 4;

/// Escape hatch like `TELIUM_DB_INTEGRITY`: lets an operator attach a second process; logs ERROR every time.
fn disabled() -> bool {
    matches!(
        std::env::var("TELIUM_INSTANCE_LOCK").ok().as_deref().map(str::trim),
        Some("off") | Some("none") | Some("0")
    )
}

pub struct Lease {
    pool: SqlitePool,
    instance_id: String,
}

pub(crate) fn hostname() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "unknown".into())
}

/// Whether a process with this id is still running on this host. `None` means this host cannot answer; the staleness window then applies.
fn pid_alive(pid: i64) -> Option<bool> {
    if pid <= 0 {
        return Some(false);
    }
    let proc_entry = std::path::Path::new("/proc").join(pid.to_string());
    if std::path::Path::new("/proc/self").exists() {
        return Some(proc_entry.exists());
    }
    // Elsewhere: `kill -0` checks existence only; non-zero exit is no such process, an unrunnable `kill` is cannot answer.
    match std::process::Command::new("kill").arg("-0").arg(pid.to_string()).output() {
        Ok(out) => Some(out.status.success()),
        Err(_) => None,
    }
}

impl Lease {
    /// Claim the right to be this homeserver, or explain who already has it; runs before `mark_unclaimed`.
    pub async fn claim(pool: &SqlitePool) -> anyhow::Result<Self> {
        let instance_id = crate::util::ulid();
        let me_host = hostname();
        let me_pid = std::process::id() as i64;
        let now = now_ms();

        if disabled() {
            tracing::error!(
                target: crate::logcat::STARTUP,
                "TELIUM_INSTANCE_LOCK=off: starting without checking whether another process is \
                 already serving this database. Rate limits, quotas, scheduled work and \
                 notifications will be doubled, gateway events will reach only half of the \
                 connected clients, and this process's startup will end live voice calls held by \
                 the other one. This is a recovery setting; see docs/scaling.md."
            );
            return Ok(Lease { pool: pool.clone(), instance_id });
        }

        let held: Option<(String, String, i64, i64, String)> = sqlx::query_as(
            "SELECT instance_id, hostname, pid, heartbeat_ms, version FROM instance_lease WHERE id = 1",
        )
        .fetch_optional(pool)
        .await?;

        if let Some((other_id, other_host, other_pid, beat, other_version)) = held {
            let age_ms = now - beat;
            // A lease recorded by this process is not a second process (tests build several states over one database).
            let mine_already = other_pid == me_pid && other_host == me_host;
            let holder_gone =
                other_host == me_host && pid_alive(other_pid) == Some(false);
            let expired = age_ms > STALE_MS;

            if !(mine_already || holder_gone || expired) {
                anyhow::bail!(
                    "another process is already serving this database and this one will not \
                     start alongside it.\n\n  \
                     holder:      pid {other_pid} on {other_host}\n  \
                     running:     telium-server {other_version}\n  \
                     last seen:   {}s ago\n  \
                     instance id: {other_id}\n\n\
                     Telium's homeserver is single-writer by design -- the rate limiter, the \
                     gateway's subscriber map and every scheduled background job assume they are \
                     the only one. Two processes on one database do not split the work; they \
                     duplicate it, halve event delivery, and this one's startup would have ended \
                     the voice calls the other is currently carrying.\n\n\
                     If the other process is the one you meant to replace, stop it and start this \
                     one; a clean shutdown releases the lease immediately and a crash releases it \
                     within {}s. If you are trying to run two instances, read docs/scaling.md -- \
                     the work that has to happen first is listed there. To start anyway, set \
                     TELIUM_INSTANCE_LOCK=off and accept every consequence above.",
                    age_ms / 1000,
                    STALE_MS / 1000,
                );
            }

            if holder_gone {
                tracing::info!(
                    target: crate::logcat::STARTUP,
                    pid = other_pid,
                    "taking over the instance lease from a process that is no longer running"
                );
            } else if expired && !mine_already {
                tracing::warn!(
                    target: crate::logcat::STARTUP,
                    host = %other_host,
                    pid = other_pid,
                    age_secs = age_ms / 1000,
                    "taking over an instance lease whose holder stopped reporting"
                );
            }
        }

        sqlx::query(
            "INSERT INTO instance_lease (id, instance_id, hostname, pid, heartbeat_ms, started_at_ms, version) \
             VALUES (1, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET \
               instance_id = excluded.instance_id, hostname = excluded.hostname, \
               pid = excluded.pid, heartbeat_ms = excluded.heartbeat_ms, \
               started_at_ms = excluded.started_at_ms, version = excluded.version",
        )
        .bind(&instance_id)
        .bind(&me_host)
        .bind(me_pid)
        .bind(now)
        .bind(now)
        .bind(env!("CARGO_PKG_VERSION"))
        .execute(pool)
        .await?;

        Ok(Lease { pool: pool.clone(), instance_id })
    }

    /// Refresh the lease; the conditional UPDATE's row count says whether we still hold it. Losing it logs loudly instead of exiting.
    pub fn spawn_heartbeat(self: std::sync::Arc<Self>) {
        if disabled() {
            return;
        }
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_SECS));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let updated = sqlx::query(
                    "UPDATE instance_lease SET heartbeat_ms = ? WHERE id = 1 AND instance_id = ?",
                )
                .bind(now_ms())
                .bind(&self.instance_id)
                .execute(&self.pool)
                .await;
                match updated {
                    Ok(done) if done.rows_affected() == 0 => {
                        tracing::error!(
                            target: crate::logcat::STARTUP,
                            "another process has taken this database's instance lease while this \
                             one was still running. Two processes are now serving one homeserver: \
                             rate limits and quotas are doubled, federated deliveries and \
                             notifications are being sent twice, and gateway events reach only \
                             the clients connected to whichever process produced them. Stop one \
                             of them. See docs/scaling.md."
                        );
                    }
                    Ok(_) => {}
                    // A failed heartbeat isn't itself a problem; the lease has spares.
                    Err(e) => tracing::debug!(target: crate::logcat::STARTUP, error = %e, "instance lease heartbeat failed"),
                }
            }
        });
    }

    /// Release on clean shutdown; conditional so a process that lost the lease doesn't delete the winner's row.
    pub async fn release(&self) {
        let _ = sqlx::query("DELETE FROM instance_lease WHERE id = 1 AND instance_id = ?")
            .bind(&self.instance_id)
            .execute(&self.pool)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn schema() -> (Scratch, SqlitePool) {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("telium-lease-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let pool = SqlitePool::connect(&format!("sqlite://{}/t.db?mode=rwc", dir.display())).await.expect("connect");
        sqlx::migrate!("./migrations").run(&pool).await.expect("migrate");
        (Scratch(dir), pool)
    }

    async fn put_lease(pool: &SqlitePool, id: &str, host: &str, pid: i64, age_ms: i64) {
        sqlx::query(
            "INSERT INTO instance_lease (id, instance_id, hostname, pid, heartbeat_ms, started_at_ms, version) \
             VALUES (1, ?, ?, ?, ?, ?, '0.0.0') ON CONFLICT(id) DO UPDATE SET instance_id = excluded.instance_id, \
             hostname = excluded.hostname, pid = excluded.pid, heartbeat_ms = excluded.heartbeat_ms",
        )
        .bind(id).bind(host).bind(pid).bind(now_ms() - age_ms).bind(now_ms() - age_ms)
        .execute(pool).await.expect("insert lease");
    }

    async fn holder(pool: &SqlitePool) -> Option<String> {
        sqlx::query_scalar("SELECT instance_id FROM instance_lease WHERE id = 1").fetch_optional(pool).await.unwrap()
    }

    #[tokio::test]
    async fn claim_takeover_and_release() {
        let (_dir, pool) = schema().await;
        let lease = Lease::claim(&pool).await.expect("empty db is claimable");
        assert_eq!(holder(&pool).await.as_deref(), Some(lease.instance_id.as_str()));
        lease.release().await;
        assert_eq!(holder(&pool).await, None, "clean shutdown leaves no lease");

        put_lease(&pool, "other", "some-other-host", 999_999, STALE_MS + 1_000).await;
        let lease = Lease::claim(&pool).await.expect("a stale lease is claimable");
        // Lost the lease: release must not delete the winner's row.
        put_lease(&pool, "other", "some-other-host", 424_242, 0).await;
        lease.release().await;
        assert_eq!(holder(&pool).await.as_deref(), Some("other"));
    }

    #[tokio::test]
    async fn a_live_foreign_lease_refuses_and_names_the_way_out() {
        let (_dir, pool) = schema().await;
        put_lease(&pool, "other", "some-other-host", 999_999, 1_000).await;
        let Err(err) = Lease::claim(&pool).await else { panic!("live lease must refuse") };
        let text = err.to_string();
        for want in ["999999", "some-other-host", "TELIUM_INSTANCE_LOCK=off"] {
            assert!(text.contains(want), "missing {want}: {text}");
        }
    }

    #[tokio::test]
    async fn a_dead_process_on_this_host_does_not_block_a_restart() {
        let (_dir, pool) = schema().await;
        if pid_alive(999_999) != Some(false) {
            return;
        }
        put_lease(&pool, "previous", &hostname(), 999_999, 1_000).await;
        Lease::claim(&pool).await.expect("dead holder on this host must not block");
    }
}
