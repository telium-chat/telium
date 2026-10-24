use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_MEMBERS, INTENT_GUILD_STRUCTURE};
use crate::guildstore::{self, member_json};
use crate::perms;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::roles::{bot_managed_conflict, is_bot_managed_role, is_bot_member};
use super::guild_json;

#[derive(Deserialize)]
pub struct MemberQuery {
    #[serde(default)]
    pub offset: Option<i64>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
}

pub async fn list_members(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Query(q): Query<MemberQuery>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let limit = q.limit.unwrap_or(100).clamp(1, 200);
    let rows = guildstore::member_page(
        &state.pool,
        &guild_id,
        q.offset.unwrap_or(0),
        limit,
        q.role.as_deref(),
        q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()),
    )
    .await?;
    let online = state.hub.online_users_in(&guild_id).await;

    let mut members = Vec::new();
    for row in &rows {
        let presence = if online.contains(&row.user_id) {
            Some(state.hub.presence_of(&row.user_id).await.to_json(&row.user_id))
        } else {
            None
        };
        members.push(member_json(row, presence));
    }
    Ok(Json(json!({
        "members": members,
        "member_count": guildstore::member_count(&state.pool, &guild_id).await?,
        "online_count": online.len(),
    })))
}

pub async fn member_status(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let member: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members WHERE guild_id = ? AND user_id = ? AND banned = 0",
    )
    .bind(&guild_id)
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(Json(json!({ "member": member.is_some() })))
}

#[derive(Deserialize)]
pub struct PatchMember {
    #[serde(default)]
    pub nickname: Option<String>,
    #[serde(default)]
    pub add_roles: Option<Vec<String>>,
    #[serde(default)]
    pub remove_roles: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_until: Option<i64>,
}

pub async fn patch_member(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
    Json(req): Json<PatchMember>,
) -> ApiResult<Json<Value>> {
    let actor = guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    let target_exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(&guild_id).bind(&user_id).fetch_optional(&state.pool).await?;
    if target_exists.is_none() {
        return Err(ApiError::NotFound("member not found".into()));
    }

    let self_edit = auth.user_id == user_id;
    let actor_perms = actor.guild_permissions();

    if let Some(nickname) = &req.nickname {
        if !self_edit {
            if !perms::has(actor_perms, perms::MODERATE_MEMBERS) {
                return Err(crate::guildstore::missing_permission(perms::MODERATE_MEMBERS));
            }
            require_outranks(&state, &guild_id, &actor, &user_id).await?;
        }
        if nickname.chars().count() > 32 {
            return Err(ApiError::BadRequest("nickname must be at most 32 characters".into()));
        }
        sqlx::query("UPDATE members SET nickname = ? WHERE guild_id = ? AND user_id = ?")
            .bind(if nickname.is_empty() { None } else { Some(nickname) })
            .bind(&guild_id).bind(&user_id).execute(&state.pool).await?;
    }

    if req.add_roles.is_some() || req.remove_roles.is_some() {
        if is_bot_member(&state, &guild_id, &user_id).await? {
            return Err(bot_managed_conflict());
        }
        if !perms::has(actor_perms, perms::MANAGE_ROLES) {
            return Err(crate::guildstore::missing_permission(perms::MANAGE_ROLES));
        }
        let actor_top = guildstore::top_role_position(&state.pool, &guild_id, &auth.user_id).await?;
        let is_owner = auth.user_id == actor.owner;

        let before = if req.add_roles.iter().flatten().next().is_some() {
            Some((
                guildstore::visible_channels(&state, &guild_id, &user_id)
                    .await?
                    .into_iter()
                    .collect::<std::collections::HashSet<String>>(),
                guildstore::channel_heads(&state.pool, &guild_id).await?,
            ))
        } else {
            None
        };

        let mut adding: Vec<&String> = Vec::new();
        for role_id in req.add_roles.iter().flatten() {
            if is_bot_managed_role(&state, &guild_id, role_id).await? {
                return Err(bot_managed_conflict());
            }
            let pos: Option<i64> = sqlx::query_scalar("SELECT position FROM roles WHERE id = ? AND guild_id = ?")
                .bind(role_id).bind(&guild_id).fetch_optional(&state.pool).await?;
            let pos = pos.ok_or_else(|| ApiError::NotFound("role not found".into()))?;
            if !is_owner && pos >= actor_top {
                return Err(ApiError::Forbidden("cannot assign a role at or above your own".into()));
            }
            adding.push(role_id);
        }
        let mut removing: Vec<&String> = Vec::new();
        for role_id in req.remove_roles.iter().flatten() {
            if is_bot_managed_role(&state, &guild_id, role_id).await? {
                return Err(bot_managed_conflict());
            }
            removing.push(role_id);
        }

        let mut tx = state.pool.begin().await?;
        for role_id in &adding {
            sqlx::query(
                "INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?) \
                 ON CONFLICT DO NOTHING",
            )
                .bind(&guild_id).bind(&user_id).bind(role_id).execute(&mut *tx).await?;
        }
        for role_id in &removing {
            sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?")
                .bind(&guild_id).bind(&user_id).bind(role_id).execute(&mut *tx).await?;
        }
        if !adding.is_empty() || !removing.is_empty() {
            crate::guildstore::audit(
                &mut *tx,
                &guild_id,
                &auth.user_id,
                "member.roles",
                Some(&user_id),
                json!({ "added": adding, "removed": removing }),
            )
            .await?;
        }
        tx.commit().await?;

        if let Some((was_visible, heads)) = before {
            let opened: Vec<(String, String)> =
                heads.into_iter().filter(|(id, _)| !was_visible.contains(id)).collect();
            guildstore::seed_read_state(&state, &guild_id, &user_id, &opened).await?;
        }
    }

    if let Some(timeout_until) = req.timeout_until {
        if !perms::has(actor_perms, perms::MODERATE_MEMBERS) {
            return Err(crate::guildstore::missing_permission(perms::MODERATE_MEMBERS));
        }
        require_outranks(&state, &guild_id, &actor, &user_id).await?;
        let value = if timeout_until <= now_ms() { None } else { Some(timeout_until) };
        sqlx::query("UPDATE members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?")
            .bind(value).bind(&guild_id).bind(&user_id).execute(&state.pool).await?;
        guildstore::audit(&state.pool, &guild_id, &auth.user_id, "member.timeout", Some(&user_id),
            json!({ "until": value })).await?;
    }

    let updated = member_row_json(&state, &guild_id, &user_id).await?;
    state.hub.publish(Event::new("MEMBER_UPDATE", guild_id, INTENT_GUILD_MEMBERS, updated.clone())).await;
    Ok(Json(updated))
}

pub(super) async fn member_row_json(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<Value> {
    let row: Option<(Option<String>, String, Option<String>, i64, Option<i64>, i64)> = sqlx::query_as(
        "SELECT nickname, display_name, avatar_ref, joined_at, timeout_until, banned \
         FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id).bind(user_id).fetch_optional(&state.pool).await?;
    let (nickname, display_name, avatar_ref, joined_at, timeout_until, banned) =
        row.ok_or_else(|| ApiError::NotFound("member not found".into()))?;
    let roles: Vec<String> = sqlx::query_scalar("SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id).bind(user_id).fetch_all(&state.pool).await?;
    Ok(json!({
        "user_id": user_id, "guild_id": guild_id, "nickname": nickname,
        "display_name": display_name, "avatar_ref": avatar_ref, "joined_at": joined_at,
        "timeout_until": timeout_until, "banned": banned != 0, "roles": roles,
    }))
}

pub(crate) async fn require_outranks(
    state: &AppState,
    guild_id: &str,
    actor: &guildstore::Membership,
    target: &str,
) -> ApiResult<()> {
    let actor_top = guildstore::top_role_position(&state.pool, guild_id, &actor.user_id).await?;
    let target_top = guildstore::top_role_position(&state.pool, guild_id, target).await?;
    if !perms::outranks(
        actor_top,
        actor.user_id == actor.owner,
        target_top,
        target == actor.owner,
    ) {
        return Err(ApiError::Forbidden("target outranks you".into()));
    }
    Ok(())
}

pub async fn kick_member(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    if is_bot_member(&state, &guild_id, &user_id).await? {
        return Err(bot_managed_conflict());
    }
    let actor = guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::KICK_MEMBERS).await?;
    require_outranks(&state, &guild_id, &actor, &user_id).await?;
    remove_member(&state, &guild_id, &user_id).await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "member.kick", Some(&user_id), json!({})).await?;
    state.hub.publish(Event::new("MEMBER_REMOVE", guild_id, INTENT_GUILD_MEMBERS, json!({ "user_id": user_id }))).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct BanRequest {
    #[serde(default)]
    pub reason: Option<String>,
}

pub async fn ban_member(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
    Json(req): Json<BanRequest>,
) -> ApiResult<Json<Value>> {
    if is_bot_member(&state, &guild_id, &user_id).await? {
        return Err(bot_managed_conflict());
    }
    let actor = guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::BAN_MEMBERS).await?;
    require_outranks(&state, &guild_id, &actor, &user_id).await?;

    sqlx::query(
        "INSERT INTO members (guild_id, user_id, joined_at, banned, ban_reason) VALUES (?, ?, ?, 1, ?) \
         ON CONFLICT (guild_id, user_id) DO UPDATE SET banned = 1, ban_reason = excluded.ban_reason",
    )
    .bind(&guild_id).bind(&user_id).bind(now_ms()).bind(&req.reason)
    .execute(&state.pool).await?;
    sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?")
        .bind(&guild_id).bind(&user_id).execute(&state.pool).await?;
    crate::routes::voice::disconnect(&state, &guild_id, &user_id).await?;
    crate::memberships::notify_home(&state, &user_id, &guild_id, "left");

    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "member.ban", Some(&user_id),
        json!({ "reason": req.reason })).await?;
    state.hub.publish(Event::new("MEMBER_REMOVE", guild_id, INTENT_GUILD_MEMBERS,
        json!({ "user_id": user_id, "banned": true }))).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_bans(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::BAN_MEMBERS).await?;
    let rows: Vec<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT user_id, ban_reason, joined_at FROM members \
         WHERE guild_id = ? AND banned = 1 ORDER BY joined_at DESC LIMIT 500",
    )
    .bind(&guild_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "bans": rows.into_iter().map(|(user_id, reason, at)| json!({
            "user_id": user_id, "reason": reason, "created_at": at,
        })).collect::<Vec<_>>()
    })))
}

pub async fn unban_member(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::BAN_MEMBERS).await?;
    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ? AND banned = 1")
        .bind(&guild_id).bind(&user_id).execute(&state.pool).await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "member.unban", Some(&user_id), json!({})).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct TransferOwnership {
    pub user_id: String,
}

pub async fn transfer_ownership(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<TransferOwnership>,
) -> ApiResult<Json<Value>> {
    let owner = guildstore::guild_owner(&state.pool, &guild_id).await?;
    if owner != auth.user_id {
        return Err(ApiError::Forbidden("only the current owner can transfer ownership".into()));
    }
    if req.user_id == auth.user_id {
        return Err(ApiError::BadRequest("that account already owns this guild".into()));
    }
    if is_bot_member(&state, &guild_id, &req.user_id).await? {
        return Err(bot_managed_conflict());
    }
    // Recheck the recipient and UPDATE ... AND owner_user_id = ? inside the transaction; zero rows means someone got there first.
    let mut tx = state.pool.begin().await?;
    let member: Option<i64> = sqlx::query_scalar(
        "SELECT banned FROM members WHERE guild_id = ? AND user_id = ?",
    ).bind(&guild_id).bind(&req.user_id).fetch_optional(&mut *tx).await?;
    match member {
        Some(0) => {}
        Some(_) => return Err(ApiError::BadRequest("ownership cannot be transferred to a banned member".into())),
        None => return Err(ApiError::BadRequest("ownership can only be transferred to a current member".into())),
    }
    let moved = sqlx::query("UPDATE guilds SET owner_user_id = ? WHERE id = ? AND owner_user_id = ?")
        .bind(&req.user_id).bind(&guild_id).bind(&auth.user_id).execute(&mut *tx).await?;
    if moved.rows_affected() == 0 {
        return Err(ApiError::Conflict(
            "ownership of this guild moved while the transfer was being processed; it was not \
             transferred again".into(),
        ));
    }
    guildstore::audit(&mut *tx, &guild_id, &auth.user_id, "guild.transfer_owner", Some(&req.user_id),
        json!({ "previous_owner": auth.user_id })).await?;
    tx.commit().await?;
    let guild = guild_json(&state, &guild_id).await?;
    state.hub.publish(Event::new("GUILD_UPDATE", guild_id, INTENT_GUILD_STRUCTURE, guild.clone())).await;
    Ok(Json(guild))
}

pub async fn leave_guild(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if auth.is_bot {
        return Err(bot_managed_conflict());
    }
    let here: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?;
    if here.is_none() && guildstore::moved_to(&state, &guild_id).await?.is_some() {
        let shed = sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(&guild_id)
            .bind(&auth.user_id)
            .execute(&state.pool)
            .await?;
        if shed.rows_affected() > 0 {
            state
                .hub
                .publish(Event::new(
                    "MEMBER_REMOVE",
                    guild_id.clone(),
                    INTENT_GUILD_MEMBERS,
                    json!({ "user_id": auth.user_id }),
                ))
                .await;
        }
        return Ok(Json(json!({ "ok": true })));
    }
    let owner = guildstore::guild_owner(&state.pool, &guild_id).await?;
    if owner == auth.user_id {
        return Err(ApiError::BadRequest(
            "the owner cannot leave; transfer ownership or delete the guild".into(),
        ));
    }
    remove_member(&state, &guild_id, &auth.user_id).await?;
    state.hub.publish(Event::new("MEMBER_REMOVE", guild_id, INTENT_GUILD_MEMBERS,
        json!({ "user_id": auth.user_id }))).await;
    Ok(Json(json!({ "ok": true })))
}



async fn remove_member(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<()> {
    crate::routes::voice::disconnect(state, guild_id, user_id).await?;
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?")
        .bind(guild_id).bind(user_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM members WHERE guild_id = ? AND user_id = ? AND banned = 0")
        .bind(guild_id).bind(user_id).execute(&mut *tx).await?;
    tx.commit().await?;
    crate::memberships::notify_home(state, user_id, guild_id, "left");
    Ok(())
}
