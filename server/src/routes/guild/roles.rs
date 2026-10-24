use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_STRUCTURE};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::ulid;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Deserialize)]
pub struct CreateRole {
    pub name: String,
    #[serde(default)]
    pub color: Option<i64>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub hoist: Option<bool>,
    #[serde(default)]
    pub mentionable: Option<bool>,
}

async fn role_json(state: &AppState, guild_id: &str, role_id: &str) -> ApiResult<Value> {
    Ok(guildstore::roles_json(state, guild_id)
        .await?
        .into_iter()
        .find(|r| r["id"] == role_id)
        .unwrap_or_else(|| json!({ "id": role_id })))
}

pub(super) async fn is_bot_managed_role(state: &AppState, guild_id: &str, role_id: &str) -> ApiResult<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members \
         WHERE guild_id = ? AND bot_role_id = ? AND bot_application_id IS NOT NULL LIMIT 1",
    )
    .bind(guild_id)
    .bind(role_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(found.is_some())
}

pub(super) async fn is_bot_member(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<bool> {
    let found: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members \
         WHERE guild_id = ? AND user_id = ? AND bot_application_id IS NOT NULL LIMIT 1",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(found.is_some())
}

pub(super) fn bot_managed_conflict() -> ApiError {
    ApiError::Conflict(
        "bot-managed membership and roles are changed from Guild Settings > Bots".into(),
    )
}

fn permission_bits(names: &[String]) -> ApiResult<u64> {
    let mut bits = 0u64;
    for name in names {
        bits |= perms::name_to_bit(name)
            .ok_or_else(|| ApiError::BadRequest(format!("unknown permission {name}")))?;
    }
    Ok(bits)
}

pub async fn list_roles(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::membership(&state, &guild_id, &auth.user_id).await?;
    Ok(Json(json!({ "roles": guildstore::roles_json(&state, &guild_id).await? })))
}

async fn renumber_roles(state: &AppState, guild_id: &str) -> ApiResult<Vec<String>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT id, position FROM roles WHERE guild_id = ? AND id <> ? ORDER BY position DESC, id",
    )
    .bind(guild_id)
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;

    let total = rows.len() as i64;
    let mut moved = Vec::new();
    let mut tx = state.pool.begin().await?;
    for (i, (id, position)) in rows.iter().enumerate() {
        let want = total - i as i64;
        if *position == want {
            continue;
        }
        sqlx::query("UPDATE roles SET position = ? WHERE id = ?")
            .bind(want)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        moved.push(id.clone());
    }
    tx.commit().await?;
    Ok(moved)
}

async fn publish_role_moves(state: &AppState, guild_id: &str, moved: &[String]) -> ApiResult<()> {
    for id in moved {
        let role = role_json(state, guild_id, id).await?;
        state
            .hub
            .publish(Event::new(
                "ROLE_UPDATE",
                guild_id.to_string(),
                INTENT_GUILD_STRUCTURE,
                role,
            ))
            .await;
    }
    Ok(())
}

pub async fn create_role(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<CreateRole>,
) -> ApiResult<Json<Value>> {
    let m = guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    let bits = permission_bits(&req.permissions.unwrap_or_default())?;
    let mine = m.guild_permissions();
    if mine != u64::MAX && bits & !mine != 0 {
        return Err(ApiError::Forbidden("cannot grant permissions you do not hold".into()));
    }

    let id = ulid();
    sqlx::query(
        "INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist, mentionable) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&guild_id)
    .bind(req.name.trim())
    .bind(req.color.unwrap_or(0))
    .bind(req.position.unwrap_or(1).max(1))
    .bind(bits as i64)
    .bind(i64::from(req.hoist.unwrap_or(false)))
    .bind(i64::from(req.mentionable.unwrap_or(false)))
    .execute(&state.pool)
    .await?;

    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "role.create", Some(&id), json!({ "name": req.name })).await?;
    let moved = renumber_roles(&state, &guild_id).await?;
    let out = role_json(&state, &guild_id, &id).await?;
    state.hub.publish(Event::new("ROLE_CREATE", guild_id.clone(), INTENT_GUILD_STRUCTURE, out.clone())).await;
    let knocked: Vec<String> = moved.into_iter().filter(|m| *m != id).collect();
    publish_role_moves(&state, &guild_id, &knocked).await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct PatchRole {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<i64>,
    #[serde(default)]
    pub permissions: Option<Vec<String>>,
    #[serde(default)]
    pub position: Option<i64>,
    #[serde(default)]
    pub hoist: Option<bool>,
    #[serde(default)]
    pub mentionable: Option<bool>,
}

pub async fn patch_role(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, role_id)): Path<(String, String)>,
    Json(req): Json<PatchRole>,
) -> ApiResult<Json<Value>> {
    let m = guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    let exists: Option<i64> = sqlx::query_scalar("SELECT position FROM roles WHERE id = ? AND guild_id = ?")
        .bind(&role_id).bind(&guild_id).fetch_optional(&state.pool).await?;
    let role_position = exists.ok_or_else(|| ApiError::NotFound("role not found".into()))?;
    if is_bot_managed_role(&state, &guild_id, &role_id).await? {
        return Err(bot_managed_conflict());
    }

    let actor_top = guildstore::top_role_position(&state.pool, &guild_id, &auth.user_id).await?;
    let is_owner = m.user_id == m.owner;
    if !is_owner && role_position >= actor_top {
        return Err(ApiError::Forbidden("cannot edit a role at or above your highest role".into()));
    }

    if let Some(name) = &req.name {
        sqlx::query("UPDATE roles SET name = ? WHERE id = ?").bind(name.trim()).bind(&role_id)
            .execute(&state.pool).await?;
    }
    if let Some(color) = req.color {
        sqlx::query("UPDATE roles SET color = ? WHERE id = ?").bind(color).bind(&role_id)
            .execute(&state.pool).await?;
    }
    if let Some(position) = req.position {
        if !is_owner && position >= actor_top {
            return Err(ApiError::Forbidden("cannot move a role to or above your highest role".into()));
        }
        sqlx::query("UPDATE roles SET position = ? WHERE id = ?").bind(position.max(1)).bind(&role_id)
            .execute(&state.pool).await?;
    }
    if let Some(hoist) = req.hoist {
        sqlx::query("UPDATE roles SET hoist = ? WHERE id = ?").bind(i64::from(hoist)).bind(&role_id)
            .execute(&state.pool).await?;
    }
    if let Some(mentionable) = req.mentionable {
        sqlx::query("UPDATE roles SET mentionable = ? WHERE id = ?")
            .bind(i64::from(mentionable)).bind(&role_id)
            .execute(&state.pool).await?;
    }
    if let Some(names) = &req.permissions {
        let bits = permission_bits(names)?;
        let mine = m.guild_permissions();
        if mine != u64::MAX && bits & !mine != 0 {
            return Err(ApiError::Forbidden("cannot grant permissions you do not hold".into()));
        }
        sqlx::query("UPDATE roles SET permissions = ? WHERE id = ?").bind(bits as i64).bind(&role_id)
            .execute(&state.pool).await?;
    }

    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "role.update", Some(&role_id), json!({})).await?;
    let out = role_json(&state, &guild_id, &role_id).await?;
    state.hub.publish(Event::new("ROLE_UPDATE", guild_id.clone(), INTENT_GUILD_STRUCTURE, out.clone())).await;
    Ok(Json(out))
}

#[derive(Deserialize)]
pub struct RolePlace {
    pub id: String,
    pub position: i64,
}

#[derive(Deserialize)]
pub struct ReorderRoles {
    pub roles: Vec<RolePlace>,
}

pub async fn reorder_roles(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<ReorderRoles>,
) -> ApiResult<Json<Value>> {
    let m = guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    if req.roles.len() > 250 {
        return Err(ApiError::BadRequest("too many roles in one move".into()));
    }
    let rows: Vec<(String, i64)> = sqlx::query_as("SELECT id, position FROM roles WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_all(&state.pool)
        .await?;
    let current: HashMap<String, i64> = rows.into_iter().collect();

    let is_owner = m.user_id == m.owner;
    let actor_top = guildstore::top_role_position(&state.pool, &guild_id, &auth.user_id).await?;
    for place in &req.roles {
        let now = *current
            .get(&place.id)
            .ok_or_else(|| ApiError::NotFound("role not found in this guild".into()))?;
        if place.id == guild_id {
            return Err(ApiError::BadRequest("@everyone cannot be moved".into()));
        }
        if place.position < 1 {
            return Err(ApiError::BadRequest("only @everyone sits at the bottom".into()));
        }
        if is_bot_managed_role(&state, &guild_id, &place.id).await? {
            return Err(bot_managed_conflict());
        }
        if !is_owner && (now >= actor_top || place.position >= actor_top) {
            return Err(ApiError::Forbidden(
                "cannot move a role to or above your highest role".into(),
            ));
        }
    }

    let mut tx = state.pool.begin().await?;
    for place in &req.roles {
        sqlx::query("UPDATE roles SET position = ? WHERE id = ? AND guild_id = ?")
            .bind(place.position)
            .bind(&place.id)
            .bind(&guild_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let out = guildstore::roles_json(&state, &guild_id).await?;
    for role in &out {
        if req.roles.iter().any(|p| role["id"] == p.id.as_str()) {
            state
                .hub
                .publish(Event::new(
                    "ROLE_UPDATE",
                    guild_id.clone(),
                    INTENT_GUILD_STRUCTURE,
                    role.clone(),
                ))
                .await;
        }
    }
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "role.reorder",
        None,
        json!({ "count": req.roles.len() }),
    )
    .await?;
    Ok(Json(json!({ "roles": out })))
}

pub async fn delete_role(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, role_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    if role_id == guild_id {
        return Err(ApiError::BadRequest("@everyone cannot be deleted".into()));
    }
    if is_bot_managed_role(&state, &guild_id, &role_id).await? {
        return Err(bot_managed_conflict());
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("DELETE FROM member_roles WHERE role_id = ?").bind(&role_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = ?")
        .bind(&role_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM roles WHERE id = ? AND guild_id = ?").bind(&role_id).bind(&guild_id)
        .execute(&mut *tx).await?;
    tx.commit().await?;

    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "role.delete", Some(&role_id), json!({})).await?;
    let moved = renumber_roles(&state, &guild_id).await?;
    state.hub.publish(Event::new("ROLE_DELETE", guild_id.clone(), INTENT_GUILD_STRUCTURE, json!({ "id": role_id }))).await;
    publish_role_moves(&state, &guild_id, &moved).await?;
    Ok(Json(json!({ "ok": true })))
}
