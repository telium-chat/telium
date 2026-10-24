//! Emoji export policy: whether a member may use a guild's emoji in other guilds (`everyone`, `members`, `role`).

use crate::error::{ApiError, ApiResult};
use crate::federation;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::{json, Value};

pub const TTL_MS: i64 = 5 * 60 * 1000;

/// How long a stale verdict is kept as a fallback when the owner is unreachable.
pub const KEEP_MS: i64 = 24 * 60 * 60 * 1000;

pub const PATH: &str = "/_telium/v1/emoji/entitlement";

/// `Ok(false)` is a real answer, distinct from `NotFound` for an unknown id.
pub async fn export_verdict(state: &AppState, emoji_id: &str, user_id: &str) -> ApiResult<bool> {
    let owner: Option<String> = sqlx::query_scalar("SELECT guild_id FROM emojis WHERE id = ?")
        .bind(emoji_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(guild_id) = owner else {
        return Err(ApiError::NotFound("no such custom emoji".into()));
    };
    guild_verdict(state, &guild_id, user_id).await
}

pub async fn guild_verdict(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<bool> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT emoji_export_policy, emoji_export_role_id FROM guilds WHERE id = ?")
            .bind(guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((policy, role_id)) = row else {
        return Err(ApiError::NotFound("guild not found".into()));
    };
    match policy.as_str() {
        "members" => Ok(is_member(state, guild_id, user_id).await?),
        "role" => {
            // A deleted `role` falls back to members-only rather than silently breaking the emoji.
            let Some(role_id) = role_id else {
                return is_member(state, guild_id, user_id).await;
            };
            let Some(floor) = role_position(state, guild_id, &role_id).await? else {
                return is_member(state, guild_id, user_id).await;
            };
            if !is_member(state, guild_id, user_id).await? {
                return Ok(false);
            }
            // At or above by position, so promotion past the named role keeps access.
            let held: Option<i64> = sqlx::query_scalar(
                "SELECT MAX(r.position) FROM roles r \
                 JOIN member_roles m ON m.role_id = r.id AND m.guild_id = r.guild_id \
                 WHERE r.guild_id = ? AND m.user_id = ?",
            )
            .bind(guild_id)
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
            Ok(held.is_some_and(|pos| pos >= floor))
        }
        // Also unknown future policies: an unreadable policy must not lock a guild out of its own emoji.
        _ => Ok(true),
    }
}

async fn is_member(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<bool> {
    let found: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(guild_id)
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(found.is_some())
}

async fn role_position(state: &AppState, guild_id: &str, role_id: &str) -> ApiResult<Option<i64>> {
    Ok(sqlx::query_scalar("SELECT position FROM roles WHERE id = ? AND guild_id = ?")
        .bind(role_id)
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?)
}

/// May `user_id` use this emoji here? `origin` is the owning server, `None` meaning this one.
pub async fn ensure_may_carry(
    state: &AppState,
    emoji_id: &str,
    origin: Option<&str>,
    user_id: &str,
) -> ApiResult<()> {
    let local = match origin {
        None => true,
        Some(origin) => federation::normalise_origin(origin) == state.cfg.server_name,
    };
    let allowed = if local {
        export_verdict(state, emoji_id, user_id).await?
    } else {
        remote_verdict(state, &federation::normalise_origin(origin.unwrap_or_default()), emoji_id, user_id)
            .await?
    };
    if allowed {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "that emoji's guild does not let you use it outside itself".into(),
        ))
    }
}

async fn remote_verdict(
    state: &AppState,
    origin: &str,
    emoji_id: &str,
    user_id: &str,
) -> ApiResult<bool> {
    let cached: Option<(i64, i64)> = sqlx::query_as(
        "SELECT allowed, checked_at FROM emoji_entitlements \
         WHERE origin = ? AND emoji_id = ? AND user_id = ?",
    )
    .bind(origin)
    .bind(emoji_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let now = now_ms();
    if let Some((allowed, checked_at)) = cached {
        if now.saturating_sub(checked_at) < TTL_MS {
            return Ok(allowed != 0);
        }
    }

    let asked = federation::post_signed(
        state,
        origin,
        PATH,
        &json!({ "emoji_id": emoji_id, "user_id": user_id }),
    )
    .await;
    match asked {
        Ok(doc) => {
            let allowed = doc.get("allowed").and_then(Value::as_bool).unwrap_or(true);
            sqlx::query(
                "INSERT INTO emoji_entitlements (origin, emoji_id, user_id, allowed, checked_at) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (origin, emoji_id, user_id) DO UPDATE SET \
                   allowed = excluded.allowed, checked_at = excluded.checked_at",
            )
            .bind(origin)
            .bind(emoji_id)
            .bind(user_id)
            .bind(i64::from(allowed))
            .bind(now)
            .execute(&state.pool)
            .await?;
            Ok(allowed)
        }
        // Owner unreachable: use a stale verdict if any, else allow; the local `external_emoji` check still applies.
        Err(e) => {
            tracing::debug!(target: crate::logcat::FEDERATION, origin, emoji = emoji_id, error = %e, "emoji entitlement unanswered");
            Ok(cached.map(|(allowed, _)| allowed != 0).unwrap_or(true))
        }
    }
}

pub async fn sweep(state: &AppState) -> ApiResult<u64> {
    let cutoff = now_ms() - KEEP_MS;
    let gone = sqlx::query("DELETE FROM emoji_entitlements WHERE checked_at < ?")
        .bind(cutoff)
        .execute(&state.pool)
        .await?;
    Ok(gone.rows_affected())
}

pub async fn policy_json(state: &AppState, guild_id: &str) -> ApiResult<Value> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT emoji_export_policy, emoji_export_role_id FROM guilds WHERE id = ?")
            .bind(guild_id)
            .fetch_optional(&state.pool)
            .await?;
    let (policy, role_id) = row.unwrap_or_else(|| ("everyone".into(), None));
    Ok(json!({ "policy": policy, "role_id": role_id }))
}

pub async fn validate_policy(
    state: &AppState,
    guild_id: &str,
    policy: &str,
    role_id: Option<&str>,
) -> ApiResult<()> {
    match policy {
        "everyone" | "members" => Ok(()),
        "role" => {
            let role_id = role_id.ok_or_else(|| {
                ApiError::BadRequest("emoji_export_policy 'role' needs emoji_export_role_id".into())
            })?;
            // A role of another guild is a rule its managers cannot see.
            match role_position(state, guild_id, role_id).await? {
                Some(_) => Ok(()),
                None => Err(ApiError::BadRequest("that role is not in this guild".into())),
            }
        }
        _ => Err(ApiError::BadRequest(
            "emoji_export_policy is one of everyone, members, role".into(),
        )),
    }
}

/// A peer asking about one of this server's emoji; one bit, nothing about rosters or roles.
pub async fn inbound_entitlement(state: &AppState, body: &Value) -> ApiResult<Value> {
    let emoji_id = body
        .get("emoji_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("no emoji_id".into()))?;
    let user_id = body
        .get("user_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("no user_id".into()))?;
    // Keyed by the account row, so a moved user is still the same person.
    let user_id = federation::resolve_id(state, "user", user_id).await;
    let allowed = match export_verdict(state, emoji_id, &user_id).await {
        Ok(allowed) => allowed,
        // Unknown emoji is not a refusal; the asker stops asking.
        Err(ApiError::NotFound(_)) => {
            return Ok(json!({ "emoji_id": emoji_id, "known": false, "allowed": false }))
        }
        Err(e) => return Err(e),
    };
    Ok(json!({ "emoji_id": emoji_id, "known": true, "allowed": allowed }))
}
