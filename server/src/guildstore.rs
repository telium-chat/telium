use crate::error::{ApiError, ApiResult};
use crate::perms::{self, MemberContext, Overwrite};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub struct MemberRow {
    pub user_id: String,
    pub nickname: Option<String>,
    pub display_name: String,
    pub avatar_ref: Option<String>,
    pub joined_at: i64,
    pub timeout_until: Option<i64>,
    pub banned: bool,
    pub roles: Vec<String>,
    pub application_id: Option<String>,
}

pub async fn guild_owner(pool: &SqlitePool, guild_id: &str) -> ApiResult<String> {
    sqlx::query_scalar::<_, String>("SELECT owner_user_id FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("guild not found".into()))
}

pub async fn member_roles(
    pool: &SqlitePool,
    guild_id: &str,
    user_id: &str,
) -> ApiResult<Vec<(String, u64)>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT r.id, r.permissions FROM roles r \
         WHERE r.guild_id = ? AND (r.id = ? OR r.id IN \
           (SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?)) \
         ORDER BY r.position",
    )
    .bind(guild_id)
    .bind(guild_id)
    .bind(guild_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id, p)| (id, p as u64)).collect())
}

fn bot_permission_ceiling(
    application_id: Option<&str>,
    bot_role_id: Option<&str>,
    roles: &[(String, u64)],
) -> Option<u64> {
    application_id.map(|_| {
        bot_role_id
            .and_then(|role_id| roles.iter().find(|(id, _)| id == role_id).map(|(_, bits)| *bits))
            // Bot row without its managed role is corrupt; fail closed rather than fall back to @everyone.
            .unwrap_or(0)
    })
}

pub async fn top_role_position(pool: &SqlitePool, guild_id: &str, user_id: &str) -> ApiResult<i64> {
    let pos: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(r.position) FROM roles r \
         JOIN member_roles m ON m.role_id = r.id \
         WHERE m.guild_id = ? AND m.user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(pos.unwrap_or(0))
}

pub async fn roles_json(state: &AppState, guild_id: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, i64, i64, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT r.id, r.name, r.color, r.position, r.permissions, r.hoist, r.mentionable, \
                (SELECT COUNT(*) FROM member_roles mr \
                  WHERE mr.guild_id = r.guild_id AND mr.role_id = r.id), \
                EXISTS(SELECT 1 FROM members m \
                  WHERE m.guild_id = r.guild_id AND m.bot_role_id = r.id \
                    AND m.bot_application_id IS NOT NULL) \
         FROM roles r WHERE r.guild_id = ? ORDER BY r.position DESC",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;
    // @everyone has no `member_roles` rows; use the guild's own count.
    let everyone = member_count(&state.pool, guild_id).await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, color, position, permissions, hoist, mentionable, members, managed)| {
            let members = if id == guild_id { everyone } else { members };
            json!({
                "id": id,
                "name": name,
                // 0xRRGGBB; 0 means no colour, not black.
                "color": color,
                "position": position,
                "permissions": (permissions as u64).to_string(),
                "permission_names": perms::bits_to_names(permissions as u64),
                "hoist": hoist != 0,
                "mentionable": mentionable != 0,
                "managed": managed != 0,
                "managed_kind": if managed != 0 { Some("bot") } else { None },
                // Counted here; the client only holds a window of the member list.
                "member_count": members,
            })
        })
        .collect())
}

/// Caller's standing in this guild for the interface; an affordance, never an authority.
pub async fn me_json(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<Value> {
    let row: Option<(Option<String>, Option<i64>, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT nickname, timeout_until, banned, bot_application_id, bot_role_id \
         FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((nickname, timeout_until, banned, application_id, bot_role_id)) = row else {
        return Ok(Value::Null);
    };
    let owner = guild_owner(&state.pool, guild_id).await?;
    let roles = member_roles(&state.pool, guild_id, user_id).await?;
    let permission_ceiling =
        bot_permission_ceiling(application_id.as_deref(), bot_role_id.as_deref(), &roles);
    let m = Membership {
        guild_id: guild_id.to_string(),
        user_id: user_id.to_string(),
        owner: owner.clone(),
        roles: roles.clone(),
        permission_ceiling,
        timed_out: timeout_until.is_some_and(|t| t > now_ms()),
    };
    Ok(json!({
        "user_id": user_id,
        "nickname": nickname,
        "banned": banned != 0,
        "timeout_until": timeout_until,
        "is_owner": user_id == owner,
        "roles": roles.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
        // Guild-level bits only; the client applies channel overwrites itself.
        "permissions": m.guild_permissions().to_string(),
        "top_role_position": top_role_position(&state.pool, guild_id, user_id).await?,
        "is_bot": application_id.is_some(),
        "application_id": application_id,
    }))
}

pub async fn channel_overwrites(pool: &SqlitePool, channel_id: &str) -> ApiResult<Vec<Overwrite>> {
    let rows: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(target_type, target_id, allow, deny)| Overwrite {
            target_type,
            target_id,
            allow: allow as u64,
            deny: deny as u64,
        })
        .collect())
}

pub struct Membership {
    pub guild_id: String,
    pub user_id: String,
    pub owner: String,
    pub roles: Vec<(String, u64)>,
    pub permission_ceiling: Option<u64>,
    pub timed_out: bool,
}

impl Membership {
    pub fn context(&self) -> MemberContext<'_> {
        MemberContext {
            user_id: &self.user_id,
            guild_id: &self.guild_id,
            guild_owner: &self.owner,
            roles: &self.roles,
            permission_ceiling: self.permission_ceiling,
            timed_out: self.timed_out,
        }
    }

    /// Guild-scope bits including timeout: uses `perms::guild_permissions`, not `base_permissions`, which skips the timeout mask.
    pub fn guild_permissions(&self) -> u64 {
        perms::guild_permissions(&self.context())
    }
}

/// Loads membership for permission decisions; rejects non-members and banned.
pub async fn membership(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<Membership> {
    let row: Option<(i64, Option<i64>, Option<String>, Option<String>)> =
        sqlx::query_as(
            "SELECT banned, timeout_until, bot_application_id, bot_role_id \
             FROM members WHERE guild_id = ? AND user_id = ?",
        )
        .bind(guild_id)
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?;
    let (banned, timeout_until, application_id, bot_role_id) =
        row.ok_or_else(|| ApiError::Forbidden("not a member of this guild".into()))?;
    if banned != 0 {
        return Err(ApiError::Forbidden("banned from this guild".into()));
    }
    let roles = member_roles(&state.pool, guild_id, user_id).await?;
    let permission_ceiling =
        bot_permission_ceiling(application_id.as_deref(), bot_role_id.as_deref(), &roles);
    Ok(Membership {
        guild_id: guild_id.to_string(),
        user_id: user_id.to_string(),
        owner: guild_owner(&state.pool, guild_id).await?,
        roles,
        permission_ceiling,
        timed_out: timeout_until.is_some_and(|t| t > now_ms()),
    })
}

/// Refuses writes to a guild that has moved; rows stay readable for the redirect.
pub async fn ensure_authoritative(state: &AppState, guild_id: &str) -> ApiResult<()> {
    match moved_to(state, guild_id).await? {
        Some(new_id) => Err(ApiError::Forbidden(format!("this guild has moved to {new_id}"))),
        None => Ok(()),
    }
}

pub async fn moved_to(state: &AppState, guild_id: &str) -> ApiResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT new_id FROM tombstones \
         WHERE subject_type = 'guild' AND subject_id = ? AND kind = 'moved'",
    )
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await?)
}

/// `missing_permission` carrying the constant name (not the label) for the client to translate, `|`-joined for multi-bit masks. Never for an unseen channel, which must be an uncoded 404.
pub fn missing_permission(bit: u64) -> ApiError {
    let names = perms::bits_to_names(bit).join("|");
    ApiError::Forbidden(format!("missing permission {names}"))
        .with_code(crate::errcodes::MISSING_PERMISSION)
        .with_detail("permission", names)
}

pub async fn require_guild_perm(
    state: &AppState,
    guild_id: &str,
    user_id: &str,
    bit: u64,
) -> ApiResult<Membership> {
    let m = membership(state, guild_id, user_id).await?;
    if !perms::has(m.guild_permissions(), bit) {
        return Err(missing_permission(bit));
    }
    Ok(m)
}

pub struct ChannelInfo {
    pub id: String,
    pub guild_id: String,
    pub kind: String,
    pub slowmode: i64,
}

pub async fn channel(state: &AppState, channel_id: &str) -> ApiResult<ChannelInfo> {
    let row: Option<(String, String, String, i64)> =
        sqlx::query_as("SELECT id, guild_id, type, slowmode FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await?;
    let (id, guild_id, kind, slowmode) =
        row.ok_or_else(|| ApiError::NotFound("channel not found".into()))?;
    Ok(ChannelInfo { id, guild_id, kind, slowmode })
}

/// A thread inherits its parent's overwrites wholesale.
pub async fn effective_overwrites(
    pool: &SqlitePool,
    channel_id: &str,
) -> ApiResult<Vec<Overwrite>> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT type, parent_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(pool)
            .await?;
    if let Some(("thread", Some(parent))) = row.as_ref().map(|(k, p)| (k.as_str(), p.clone())) {
        return channel_overwrites(pool, &parent).await;
    }
    channel_overwrites(pool, channel_id).await
}

/// Channel-scoped permission check. `VIEW_CHANNEL` is implied: a member who
/// cannot see a channel gets `not found`, never a hint that it exists.
pub async fn require_channel_perm(
    state: &AppState,
    channel_id: &str,
    user_id: &str,
    bit: u64,
) -> ApiResult<(ChannelInfo, Membership, u64)> {
    let ch = channel(state, channel_id).await?;
    let m = membership(state, &ch.guild_id, user_id).await?;
    let ow = effective_overwrites(&state.pool, channel_id).await?;
    let p = perms::channel_permissions(&m.context(), &ow);
    if !perms::has(p, perms::VIEW_CHANNEL) {
        return Err(ApiError::NotFound("channel not found".into()));
    }
    if !perms::has(p, bit) {
        return Err(missing_permission(bit));
    }
    Ok((ch, m, p))
}

/// Channels this member may see; the gateway uses it to drop other events.
pub async fn visible_channels(
    state: &AppState,
    guild_id: &str,
    user_id: &str,
) -> ApiResult<Vec<String>> {
    let m = match membership(state, guild_id, user_id).await {
        Ok(m) => m,
        Err(_) => return Ok(Vec::new()),
    };
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM channels WHERE guild_id = ?")
        .bind(guild_id)
        .fetch_all(&state.pool)
        .await?;

    let mut visible = Vec::with_capacity(ids.len());
    for id in ids {
        let ow = effective_overwrites(&state.pool, &id).await?;
        if perms::has(perms::channel_permissions(&m.context(), &ow), perms::VIEW_CHANNEL) {
            visible.push(id);
        }
    }
    Ok(visible)
}

/// Head message per channel; read before the membership exists so a racing message stays unread.
pub async fn channel_heads(pool: &SqlitePool, guild_id: &str) -> ApiResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT c.id, COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id), '') \
         FROM channels c WHERE c.guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?)
}

/// Seeds a read cursor at each visible channel's head so a joiner doesn't see the whole backlog as unread; `ON CONFLICT DO NOTHING` makes repeating safe.
pub async fn seed_read_state(
    state: &AppState,
    guild_id: &str,
    user_id: &str,
    heads: &[(String, String)],
) -> ApiResult<()> {
    if heads.is_empty() {
        return Ok(());
    }
    let visible: std::collections::HashSet<String> =
        visible_channels(state, guild_id, user_id).await?.into_iter().collect();
    let now = now_ms();
    for (channel_id, head) in heads {
        // Empty channel needs no marker.
        if head.is_empty() || !visible.contains(channel_id) {
            continue;
        }
        sqlx::query(
            "INSERT INTO read_state (user_id, channel_id, last_read_id, muted, updated_at) \
             VALUES (?, ?, ?, 0, ?) ON CONFLICT DO NOTHING",
        )
        .bind(user_id)
        .bind(channel_id)
        .bind(head)
        .bind(now)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

/// Stably ordered member-list slice for lazy range subscriptions, using cached display essentials.
pub async fn member_range(
    pool: &SqlitePool,
    guild_id: &str,
    offset: i64,
    limit: i64,
) -> ApiResult<Vec<MemberRow>> {
    member_page(pool, guild_id, offset, limit, None, None).await
}

/// The same window filtered by `role` and `query` server-side; the client only holds one window.
pub async fn member_page(
    pool: &SqlitePool,
    guild_id: &str,
    offset: i64,
    limit: i64,
    role: Option<&str>,
    query: Option<&str>,
) -> ApiResult<Vec<MemberRow>> {
    // Everyone holds @everyone and it has no `member_roles` rows.
    let role = role.filter(|id| *id != guild_id);
    let name = "COALESCE(NULLIF(nickname, ''), NULLIF(display_name, ''), user_id)";
    let mut sql = String::from(
        "SELECT user_id, nickname, display_name, avatar_ref, joined_at, timeout_until, banned, \
                bot_application_id \
         FROM members WHERE guild_id = ? AND banned = 0",
    );
    if role.is_some() {
        sql.push_str(
            " AND user_id IN (SELECT user_id FROM member_roles \
               WHERE guild_id = members.guild_id AND role_id = ?)",
        );
    }
    if query.is_some() {
        sql.push_str(&format!(" AND {name} LIKE ? ESCAPE '\\'"));
    }
    sql.push_str(&format!(
        " ORDER BY {name} COLLATE NOCASE, user_id LIMIT ? OFFSET ?"
    ));

    let mut q = sqlx::query_as(&sql).bind(guild_id);
    if let Some(role_id) = role {
        q = q.bind(role_id.to_string());
    }
    if let Some(text) = query {
        // The caller's `%` and `_` are literals, not wildcards.
        let escaped = text
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        q = q.bind(format!("%{escaped}%"));
    }
    let rows: Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        i64,
        Option<i64>,
        i64,
        Option<String>,
    )> = q.bind(limit).bind(offset).fetch_all(pool).await?;

    let mut out = Vec::with_capacity(rows.len());
    for (
        user_id,
        nickname,
        display_name,
        avatar_ref,
        joined_at,
        timeout_until,
        banned,
        application_id,
    ) in rows {
        let roles: Vec<String> = sqlx::query_scalar(
            "SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?",
        )
        .bind(guild_id)
        .bind(&user_id)
        .fetch_all(pool)
        .await?;
        out.push(MemberRow {
            user_id,
            nickname,
            display_name,
            avatar_ref,
            joined_at,
            timeout_until,
            banned: banned != 0,
            roles,
            application_id,
        });
    }
    Ok(out)
}

pub fn member_json(m: &MemberRow, presence: Option<Value>) -> Value {
    serde_json::json!({
        "user_id": m.user_id,
        "nickname": m.nickname,
        "display_name": m.display_name,
        "avatar_ref": m.avatar_ref,
        "joined_at": m.joined_at,
        "timeout_until": m.timeout_until,
        "roles": m.roles,
        "presence": presence,
        "is_bot": m.application_id.is_some(),
        "application_id": m.application_id,
    })
}

pub async fn member_count(pool: &SqlitePool, guild_id: &str) -> ApiResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ? AND banned = 0")
        .bind(guild_id)
        .fetch_one(pool)
        .await?)
}

/// Records an administrative action; generic over the executor so authority changes can log in the same transaction.
pub async fn audit<'e, E>(
    executor: E,
    guild_id: &str,
    actor: &str,
    action: &str,
    target: Option<&str>,
    data: Value,
) -> ApiResult<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "INSERT INTO audit_log (id, guild_id, actor, action, target, data, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(guild_id)
    .bind(actor)
    .bind(action)
    .bind(target)
    .bind(data.to_string())
    .bind(now_ms())
    .execute(executor)
    .await?;
    Ok(())
}

/// Refreshes the cached display essentials of a member; called on join and on a newer profile_version.
pub async fn refresh_member_essentials(
    pool: &SqlitePool,
    user_id: &str,
    display_name: &str,
    avatar_ref: Option<&str>,
    profile_version: i64,
) -> ApiResult<Vec<String>> {
    let guilds: Vec<String> = sqlx::query_scalar(
        "SELECT guild_id FROM members WHERE user_id = ? AND profile_version < ?",
    )
    .bind(user_id)
    .bind(profile_version)
    .fetch_all(pool)
    .await?;

    if guilds.is_empty() {
        return Ok(guilds);
    }
    sqlx::query(
        "UPDATE members SET display_name = ?, avatar_ref = ?, profile_version = ? \
         WHERE user_id = ? AND profile_version < ?",
    )
    .bind(display_name)
    .bind(avatar_ref)
    .bind(profile_version)
    .bind(user_id)
    .bind(profile_version)
    .execute(pool)
    .await?;
    Ok(guilds)
}
