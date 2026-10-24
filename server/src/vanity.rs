
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::{now_ms, valid_localpart};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MAX_HOPS: usize = 6;

const RESERVED: &[&str] = &[
    ".",
    "..",
    "abuse",
    "admin",
    "administrator",
    "everyone",
    "guild",
    "guilds",
    "here",
    "mod",
    "moderator",
    "moderators",
    "official",
    "operator",
    "postmaster",
    "root",
    "security",
    "staff",
    "support",
    "sys",
    "system",
    "telium",
    "webmaster",
    "well-known",
];

pub fn normalise(input: &str) -> ApiResult<String> {
    let folded = input.trim().trim_start_matches('#').to_ascii_lowercase();
    if !valid_localpart(&folded) {
        return Err(ApiError::BadRequest(
            "a guild address is 1-32 characters of a-z, 0-9, dot, dash or underscore".into(),
        ));
    }
    if RESERVED.contains(&folded.as_str()) {
        return Err(ApiError::Conflict(format!(
            "#{folded} is reserved by this server"
        )));
    }
    Ok(folded)
}

pub fn split_address(address: &str) -> Option<(String, String)> {
    let rest = address.trim().trim_start_matches('#');
    let (local, origin) = rest.split_once(':')?;
    let local = local.to_ascii_lowercase();
    let origin = federation::normalise_origin(origin);
    if local.is_empty() || origin.is_empty() {
        return None;
    }
    if !valid_localpart(&local) || local.trim_matches('.').is_empty() {
        return None;
    }
    // Reject `@`: it would turn the preceding text into userinfo.
    if origin.contains(|c: char| c.is_whitespace() || "/@?#\\".contains(c)) {
        return None;
    }
    Some((local, origin))
}

pub fn format_address(local: &str, origin: &str) -> String {
    format!("#{local}:{origin}")
}

pub async fn claim(state: &AppState, guild_id: &str, alias: &str) -> ApiResult<String> {
    let alias = normalise(alias)?;
    let mut tx = state.pool.begin().await?;

    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("guild not found".into()));
    }

    let live: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE alias = ? AND id <> ?")
        .bind(&alias)
        .bind(guild_id)
        .fetch_optional(&mut *tx)
        .await?;
    if live.is_some() {
        return Err(ApiError::Conflict(format!("#{alias} is taken")));
    }
    let retired: Option<String> =
        sqlx::query_scalar("SELECT guild_id FROM guild_alias_redirects WHERE alias = ? AND guild_id <> ?")
            .bind(&alias)
            .bind(guild_id)
            .fetch_optional(&mut *tx)
            .await?;
    if retired.is_some() {
        return Err(ApiError::Conflict(format!(
            "#{alias} belonged to another guild here and still points at it"
        )));
    }

    let invite: Option<String> = sqlx::query_scalar(
        "SELECT code FROM invites WHERE code = ? \
         AND (expires_at IS NULL OR expires_at > ?) \
         AND (max_uses IS NULL OR uses < max_uses) LIMIT 1",
    )
    .bind(&alias)
    .bind(now_ms())
    .fetch_optional(&mut *tx)
    .await?;
    if invite.is_some() {
        return Err(ApiError::Conflict(format!(
            "#{alias} is currently used by an invite link"
        )));
    }

    sqlx::query(
        "DELETE FROM guild_alias_redirects \
         WHERE guild_id = ? AND to_origin = ? AND to_guild_id = ?",
    )
    .bind(guild_id)
    .bind(&state.cfg.server_name)
    .bind(guild_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM guild_alias_redirects WHERE alias = ?")
        .bind(&alias)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE guilds SET alias = ? WHERE id = ?")
        .bind(&alias)
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(alias)
}

pub async fn release(state: &AppState, guild_id: &str) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    let exists: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(ApiError::NotFound("guild not found".into()));
    }

    sqlx::query(
        "DELETE FROM guild_alias_redirects \
         WHERE guild_id = ? AND to_origin = ? AND to_guild_id = ?",
    )
    .bind(guild_id)
    .bind(&state.cfg.server_name)
    .bind(guild_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE guilds SET alias = NULL WHERE id = ?")
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn follow_move(
    state: &AppState,
    guild_id: &str,
    to_origin: &str,
    to_guild_id: &str,
) -> ApiResult<()> {
    let to_origin = federation::normalise_origin(to_origin);
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let current: Option<String> = sqlx::query_scalar("SELECT alias FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or(None);
    if let Some(alias) = current {
        retire(&mut tx, &alias, guild_id, &to_origin, to_guild_id).await?;
        sqlx::query("UPDATE guilds SET alias = NULL WHERE id = ?")
            .bind(guild_id)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query(
        "UPDATE guild_alias_redirects SET to_origin = ?, to_guild_id = ?, created_at = ? \
         WHERE guild_id = ?",
    )
    .bind(&to_origin)
    .bind(to_guild_id)
    .bind(now)
    .bind(guild_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn forget(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    guild_id: &str,
) -> ApiResult<()> {
    sqlx::query("DELETE FROM guild_alias_redirects WHERE guild_id = ?")
        .bind(guild_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn retire(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    alias: &str,
    guild_id: &str,
    to_origin: &str,
    to_guild_id: &str,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO guild_alias_redirects (alias, guild_id, to_origin, to_guild_id, created_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT (alias) DO UPDATE SET \
           guild_id = excluded.guild_id, to_origin = excluded.to_origin, \
           to_guild_id = excluded.to_guild_id, created_at = excluded.created_at",
    )
    .bind(alias)
    .bind(guild_id)
    .bind(to_origin)
    .bind(to_guild_id)
    .bind(now_ms())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn local_answer(state: &AppState, alias: &str) -> ApiResult<Value> {
    let alias = alias.trim_start_matches('#').to_ascii_lowercase();
    let body = match live_guild(state, &alias).await? {
        Some(guild_id) => match moved_destination(state, &guild_id).await? {
            Some((to_origin, new_id)) => json!({
                "alias": alias, "host": state.cfg.server_name, "status": "moved",
                "guild_id": guild_id,
                "to": { "origin": to_origin, "guild_id": new_id },
            }),
            None => json!({
                "alias": alias, "host": state.cfg.server_name, "status": "active",
                "guild_id": guild_id, "origin": state.cfg.server_name,
            }),
        },
        None => {
            let row: Option<(String, String, String)> = sqlx::query_as(
                "SELECT guild_id, to_origin, to_guild_id FROM guild_alias_redirects WHERE alias = ?",
            )
            .bind(&alias)
            .fetch_optional(&state.pool)
            .await?;
            match row {
                Some((guild_id, to_origin, to_guild_id))
                    if to_origin == state.cfg.server_name && to_guild_id == guild_id =>
                {
                    json!({
                        "alias": alias, "host": state.cfg.server_name, "status": "unknown",
                    })
                }
                Some((guild_id, to_origin, to_guild_id)) => json!({
                    "alias": alias, "host": state.cfg.server_name, "status": "moved",
                    "guild_id": guild_id,
                    "to": { "origin": to_origin, "guild_id": to_guild_id },
                }),
                None => json!({
                    "alias": alias, "host": state.cfg.server_name, "status": "unknown",
                }),
            }
        }
    };
    Ok(crypto::sign_json(&state.key, body))
}

async fn moved_destination(state: &AppState, guild_id: &str) -> ApiResult<Option<(String, String)>> {
    let row: Option<(Option<String>, String)> = sqlx::query_as(
        "SELECT new_id, record FROM tombstones \
         WHERE subject_type = 'guild' AND subject_id = ? AND kind = 'moved'",
    )
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((Some(new_id), record)) = row else { return Ok(None) };
    let origin = serde_json::from_str::<Value>(&record)
        .ok()
        .and_then(|r| r.get("new_server").and_then(Value::as_str).map(federation::normalise_origin))
        .filter(|o| !o.is_empty())
        .unwrap_or_else(|| state.cfg.server_name.clone());
    Ok(Some((origin, new_id)))
}

async fn live_guild(state: &AppState, alias: &str) -> ApiResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT id FROM guilds WHERE alias = ?")
        .bind(alias)
        .fetch_optional(&state.pool)
        .await?)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub origin: String,
    pub guild_id: String,
    pub asked: String,
    pub landed: Option<String>,
    pub hops: usize,
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        json!({
            "origin": self.origin,
            "guild_id": self.guild_id,
            "address": self.asked,
            "landed": self.landed,
            "redirected": self.hops > 0,
            "hops": self.hops,
        })
    }
}

pub async fn resolve(state: &AppState, address: &str) -> ApiResult<Resolved> {
    let (local, origin) = split_address(address)
        .ok_or_else(|| ApiError::BadRequest("a guild address looks like #gaming:guilds.example".into()))?;
    let asked = format_address(&local, &origin);

    let mut next = Hop::Alias { origin, local };
    let mut seen: HashSet<String> = HashSet::new();
    let mut landed: Option<String> = None;

    for hops in 0..MAX_HOPS {
        let key = match &next {
            Hop::Alias { origin, local } => format!("#{local}:{origin}"),
            Hop::Guild { origin, guild_id } => format!("{guild_id}@{origin}"),
        };
        if !seen.insert(key) {
            return Err(ApiError::Conflict(format!(
                "{asked} points in a circle; no server claims the guild"
            )));
        }
        next = match next {
            Hop::Alias { origin, local } => {
                let doc = ask(state, &origin, &format!("/_telium/v1/guild-aliases/{local}")).await?;
                match status_of(&doc) {
                    "active" => {
                        let guild_id = string(&doc, "guild_id").ok_or_else(|| {
                            ApiError::BadRequest(format!("{origin} claimed #{local} names nothing"))
                        })?;
                        landed = Some(format_address(&local, &origin));
                        return Ok(Resolved { origin, guild_id, asked, landed, hops });
                    }
                    "moved" => {
                        let (to_origin, to_guild) = forward(&doc).ok_or_else(|| {
                            ApiError::BadRequest(format!("{origin} forwarded #{local} nowhere"))
                        })?;
                        Hop::Guild { origin: to_origin, guild_id: to_guild }
                    }
                    _ => {
                        return Err(ApiError::NotFound(format!("{origin} has no {}", format_address(&local, &origin))))
                    }
                }
            }
            Hop::Guild { origin, guild_id } => {
                let doc = ask(state, &origin, &format!("/_telium/v1/guilds/{guild_id}/status")).await?;
                match status_of(&doc) {
                    "active" => {
                        let landed_alias = string(&doc, "alias");
                        return Ok(Resolved {
                            origin,
                            guild_id,
                            asked,
                            landed: landed_alias.or(landed),
                            hops,
                        });
                    }
                    "moved" => {
                        let to = string(&doc, "moved_to").ok_or_else(|| {
                            ApiError::BadRequest(format!("{origin} forwarded a guild nowhere"))
                        })?;
                        let to_origin = doc
                            .get("tombstone")
                            .and_then(|t| t.get("new_server"))
                            .and_then(Value::as_str)
                            .or_else(|| federation::domain_of(&to))
                            .map(federation::normalise_origin)
                            .filter(|o| !o.is_empty())
                            .unwrap_or_else(|| origin.clone());
                        Hop::Guild { origin: to_origin, guild_id: to }
                    }
                    _ => return Err(ApiError::NotFound(format!("{origin} has no such guild"))),
                }
            }
        };
    }
    Err(ApiError::Conflict(format!(
        "{asked} forwards further than this server will follow"
    )))
}

enum Hop {
    Alias { origin: String, local: String },
    Guild { origin: String, guild_id: String },
}

async fn ask(state: &AppState, origin: &str, path: &str) -> ApiResult<Value> {
    let doc = if origin == state.cfg.server_name {
        match path.strip_prefix("/_telium/v1/guild-aliases/") {
            Some(alias) => local_answer(state, alias).await?,
            None => {
                let guild_id = path
                    .trim_start_matches("/_telium/v1/guilds/")
                    .trim_end_matches("/status");
                crate::routes::guild::guild_status_json(state, guild_id).await?
            }
        }
    } else {
        federation::get_signed(state, origin, path).await?
    };
    let key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest(format!("{origin} returned an unsigned answer")))?;
    let public = federation::verify_key(state, origin, key_id)
        .await
        .ok_or_else(|| ApiError::BadRequest(format!("{origin} signed with an unpublished key")))?;
    if !crypto::verify_json(&public, &doc) {
        return Err(ApiError::BadRequest(format!("{origin} returned a bad signature")));
    }
    match doc.get("host").and_then(Value::as_str) {
        Some(host) if federation::normalise_origin(host) == origin => Ok(doc),
        _ => Err(ApiError::BadRequest(format!(
            "{origin} answered for a server that is not itself"
        ))),
    }
}

fn status_of(doc: &Value) -> &str {
    doc.get("status").and_then(Value::as_str).unwrap_or("unknown")
}

fn string(doc: &Value, key: &str) -> Option<String> {
    doc.get(key).and_then(Value::as_str).map(str::to_string)
}

fn forward(doc: &Value) -> Option<(String, String)> {
    let to = doc.get("to")?;
    let origin = federation::normalise_origin(to.get("origin")?.as_str()?);
    let guild_id = to.get("guild_id")?.as_str()?.to_string();
    if origin.is_empty() || guild_id.is_empty() {
        return None;
    }
    Some((origin, guild_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_address_folds_to_one_name() {
        assert_eq!(normalise("#Gaming").unwrap(), "gaming");
        assert_eq!(normalise("  gaming  ").unwrap(), "gaming");
        assert_eq!(normalise("g.a-m_1").unwrap(), "g.a-m_1");
    }

    #[test]
    fn a_name_this_server_needs_is_refused() {
        for word in ["admin", "Support", "#SYSTEM", "everyone"] {
            assert!(normalise(word).is_err(), "{word} should be reserved");
        }
    }

    #[test]
    fn a_name_outside_the_grammar_is_refused() {
        for bad in ["", "#", "with space", "slash/es", "colon:s", &"x".repeat(33), "emoji😀"] {
            assert!(normalise(bad).is_err(), "{bad:?} should not be a guild address");
        }
    }

    #[test]
    fn an_address_splits_with_or_without_the_hash() {
        assert_eq!(
            split_address("#Gaming:Guilds.Example"),
            Some(("gaming".into(), "guilds.example".into()))
        );
        assert_eq!(
            split_address("gaming:guilds.example"),
            Some(("gaming".into(), "guilds.example".into()))
        );
        assert_eq!(split_address("gaming"), None);
        assert_eq!(split_address("#:guilds.example"), None);
        assert_eq!(split_address("#gaming:"), None);
    }

    #[test]
    fn an_address_cannot_steer_the_request_it_causes() {
        for bad in [
            "#..:peer.example",
            "#.:peer.example",
            "#...:peer.example",
            "#../../admin:peer.example",
            "#gaming?x=1:peer.example",
            "#gaming here:peer.example",
            "#GAMING%2f..:peer.example",
            &format!("#{}:peer.example", "x".repeat(33)),
        ] {
            assert_eq!(split_address(bad), None, "{bad:?} should not parse");
        }
    }

    #[test]
    fn an_origin_cannot_smuggle_a_different_host() {
        for bad in [
            "#gaming:peer.example@localhost",
            "#gaming:peer.example/../x",
            "#gaming:peer.example?x=1",
            "#gaming:peer.example#x",
            "#gaming:peer example",
        ] {
            assert_eq!(split_address(bad), None, "{bad:?} should not parse");
        }
        assert_eq!(
            split_address("#gaming:peer.example"),
            Some(("gaming".into(), "peer.example".into()))
        );
    }
}
