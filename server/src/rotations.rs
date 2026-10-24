
use crate::secrets::{self, SecretEntry};
use crate::util::{now_ms, ulid};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Basis {
    Asserted,
    LocalProcess,
    Authenticated,
    Observed,
}

impl Basis {
    pub fn as_str(self) -> &'static str {
        match self {
            Basis::Asserted => "asserted",
            Basis::LocalProcess => "local-process",
            Basis::Authenticated => "authenticated",
            Basis::Observed => "observed",
        }
    }

    pub fn caveat(self) -> &'static str {
        match self {
            Basis::Asserted => {
                "a name typed on the command line. Nothing checked it, and anybody who could \
                 run the command could have typed anybody"
            }
            Basis::LocalProcess => {
                "the uid and login name the kernel reported for the process. Not forgeable by \
                 another user -- and no proof of anything, because a uid that can rotate a key \
                 can also write this table"
            }
            Basis::Authenticated => {
                "an account that presented a credential to this server and passed the \
                 administrator check"
            }
            Basis::Observed => {
                "nobody. The server noticed the change at startup and is recording that it \
                 happened, not who did it"
            }
        }
    }

    fn parse(text: &str) -> Basis {
        match text {
            "asserted" => Basis::Asserted,
            "local-process" => Basis::LocalProcess,
            "authenticated" => Basis::Authenticated,
            _ => Basis::Observed,
        }
    }
}

pub struct Actor {
    pub rendered: String,
    pub basis: Basis,
    pub evidence: Value,
}

impl Actor {
    pub fn local(operator: Option<&str>) -> Actor {
        let evidence = process_evidence();
        match operator.map(str::trim).filter(|o| !o.is_empty()) {
            Some(name) => Actor {
                rendered: name.to_string(),
                basis: Basis::Asserted,
                evidence,
            },
            None => {
                let who = evidence["sudo_user"]
                    .as_str()
                    .or_else(|| evidence["login"].as_str())
                    .unwrap_or("unknown");
                let uid = evidence["uid"].as_i64().unwrap_or(-1);
                let host = evidence["hostname"].as_str().unwrap_or("unknown");
                Actor {
                    rendered: format!("{who} (uid {uid}) on {host}"),
                    basis: Basis::LocalProcess,
                    evidence,
                }
            }
        }
    }

    pub fn authenticated(user_id: &str) -> Actor {
        Actor {
            rendered: user_id.to_string(),
            basis: Basis::Authenticated,
            evidence: json!({}),
        }
    }

    pub fn observed(how: &'static str) -> Actor {
        Actor {
            rendered: format!("nobody -- {how}"),
            basis: Basis::Observed,
            evidence: json!({}),
        }
    }
}

fn process_evidence() -> Value {
    let uid = unsafe { libc::getuid() } as i64;
    let euid = unsafe { libc::geteuid() } as i64;
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    json!({
        "uid": uid,
        "euid": euid,
        "login": env("USER").or_else(|| env("LOGNAME")),
        "sudo_user": env("SUDO_USER"),
        "hostname": crate::instance::hostname(),
        "pid": std::process::id(),
    })
}

#[derive(Debug, Default, Serialize)]
pub struct Detail {
    pub change: &'static str,
    pub note: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_public_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub affected: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compromised: Option<bool>,
}

pub async fn record(
    pool: &SqlitePool,
    entry: &'static SecretEntry,
    actor: &Actor,
    detail: Detail,
) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO secret_rotations \
         (id, inventory_entry, actor, actor_basis, actor_evidence, detail, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(entry.heading)
    .bind(&actor.rendered)
    .bind(actor.basis.as_str())
    .bind(actor.evidence.to_string())
    .bind(serde_json::to_string(&detail).unwrap_or_else(|_| "{}".into()))
    .bind(now_ms())
    .execute(pool)
    .await
    .map(|_| ())
}

pub struct Rotation {
    pub at: i64,
    pub entry: String,
    pub actor: String,
    pub basis: Basis,
    pub evidence: Value,
    pub detail: Value,
}

pub async fn recent(
    pool: &SqlitePool,
    entry: Option<&str>,
    limit: i64,
) -> sqlx::Result<Vec<Rotation>> {
    let rows: Vec<(i64, String, String, String, String, String)> = match entry {
        Some(fragment) => sqlx::query_as(
            "SELECT created_at, inventory_entry, actor, actor_basis, actor_evidence, detail \
             FROM secret_rotations WHERE lower(inventory_entry) LIKE ? ORDER BY id DESC LIMIT ?",
        )
        .bind(format!("%{}%", fragment.to_lowercase()))
        .bind(limit)
        .fetch_all(pool)
        .await?,
        None => sqlx::query_as(
            "SELECT created_at, inventory_entry, actor, actor_basis, actor_evidence, detail \
             FROM secret_rotations ORDER BY id DESC LIMIT ?",
        )
        .bind(limit)
        .fetch_all(pool)
        .await?,
    };
    Ok(rows
        .into_iter()
        .map(|(at, entry, actor, basis, evidence, detail)| Rotation {
            at,
            entry,
            actor,
            basis: Basis::parse(&basis),
            evidence: serde_json::from_str(&evidence).unwrap_or_else(|_| json!({})),
            detail: serde_json::from_str(&detail).unwrap_or_else(|_| json!({})),
        })
        .collect())
}

struct Seen {
    path: String,
    role: &'static str,
    standing: &'static str,
    bytes: i64,
    modified_at: Option<i64>,
}

fn seen_key_files(cfg: &crate::config::Config) -> Vec<Seen> {
    let mut out = Vec::new();
    let mut add = |path: &Path, role: &'static str, standing: &'static str| {
        let Ok(meta) = std::fs::metadata(path) else { return };
        let modified_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let path = std::fs::canonicalize(path)
            .unwrap_or_else(|_| path.to_path_buf())
            .display()
            .to_string();
        out.push(Seen { path, role, standing, bytes: meta.len() as i64, modified_at });
    };
    add(&cfg.backup.key_file, "Backup encryption key", "current");
    for path in &cfg.backup.previous_key_files {
        add(path, "Backup encryption key", "retired");
    }
    if let Some(path) = &cfg.push.fcm.service_account_file {
        add(path, "FCM service account", "current");
    }
    if let Some(path) = &cfg.push.apns.key_file {
        add(path, "APNs signing key", "current");
    }
    out
}

pub async fn witness_key_files(
    pool: &SqlitePool,
    cfg: &crate::config::Config,
) -> anyhow::Result<Vec<String>> {
    let now = now_ms();
    let previous: Vec<(String, String, String, i64, Option<i64>)> = sqlx::query_as(
        "SELECT path, role, standing, bytes, modified_at FROM secret_file_witness",
    )
    .fetch_all(pool)
    .await?;
    let seen = seen_key_files(cfg);
    let first_run = previous.is_empty();

    let mut said = Vec::new();
    if !first_run {
        for file in &seen {
            let before = previous.iter().find(|(p, ..)| *p == file.path);
            let (change, note): (&'static str, &'static str) = match before {
                None => (
                    "added",
                    "a key file appeared at a path this server had not used before, which is \
                     what the first half of a key rotation looks like",
                ),
                Some((_, _, standing, bytes, modified_at)) => {
                    if *bytes != file.bytes || *modified_at != file.modified_at {
                        (
                            "replaced",
                            "the file at this path changed between two starts of this server. \
                             Its contents were not compared -- only its length and its \
                             modification time -- so this is a key having been overwritten in \
                             place unless somebody merely touched it",
                        )
                    } else if standing != file.standing {
                        (
                            "retired",
                            "this key file stopped being the one new archives are sealed under \
                             and became one that only opens old ones",
                        )
                    } else {
                        continue;
                    }
                }
            };
            let Some(entry) = secrets::by_heading(file.role) else { continue };
            record(
                pool,
                entry,
                &Actor::observed("noticed by the server at startup"),
                Detail {
                    change,
                    note,
                    path: Some(file.path.clone()),
                    ..Detail::default()
                },
            )
            .await?;
            said.push(format!("{}: {} ({})", file.role, change, file.path));
        }
        for (path, role, ..) in &previous {
            if seen.iter().any(|f| f.path == *path) {
                continue;
            }
            let Some(entry) = secrets::by_heading(role) else { continue };
            record(
                pool,
                entry,
                &Actor::observed("noticed by the server at startup"),
                Detail {
                    change: "cleared",
                    note: "a key file this server used at its last start is no longer named by \
                           the configuration, or is no longer on disk. If archives sealed under \
                           it still exist, they can no longer be opened",
                    path: Some(path.clone()),
                    ..Detail::default()
                },
            )
            .await?;
            said.push(format!("{role}: cleared ({path})"));
        }
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM secret_file_witness").execute(&mut *tx).await?;
    for file in &seen {
        sqlx::query(
            "INSERT INTO secret_file_witness \
             (path, role, standing, bytes, modified_at, first_seen, last_seen) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&file.path)
        .bind(file.role)
        .bind(file.standing)
        .bind(file.bytes)
        .bind(file.modified_at)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(said)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_detail_payload_has_a_fixed_set_of_keys() {
        let full = Detail {
            change: "replaced",
            note: "a literal",
            public_key_id: Some("ed25519:1".into()),
            retired_public_key_id: Some("ed25519:0".into()),
            path: Some("/var/lib/telium/backup.key".into()),
            affected: Some(3),
            compromised: Some(true),
        };
        let value = serde_json::to_value(&full).expect("Detail serialises");
        let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["affected", "change", "compromised", "note", "path", "public_key_id", "retired_public_key_id"]);
    }

    #[test]
    fn basis_round_trips_and_a_typed_name_is_weaker_than_the_uid() {
        for basis in [Basis::Asserted, Basis::LocalProcess, Basis::Authenticated, Basis::Observed] {
            assert_eq!(Basis::parse(basis.as_str()), basis);
            assert!(!basis.caveat().is_empty());
        }
        assert_eq!(Actor::local(Some("ada")).basis, Basis::Asserted);
        assert_eq!(Actor::local(None).basis, Basis::LocalProcess);
        assert_eq!(Actor::local(Some("   ")).basis, Basis::LocalProcess);
        assert!(Actor::local(Some("ada")).evidence["uid"].is_i64());
    }
}
