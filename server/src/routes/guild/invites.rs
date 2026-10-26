use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_MEMBERS};
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::{invite_code, now_ms};
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::roles::bot_managed_conflict;
use super::members::member_row_json;
use super::guild_json;

#[derive(Deserialize)]
pub struct CreateInvite {
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub max_uses: Option<i64>,
    #[serde(default)]
    pub expires_in_secs: Option<i64>,
}

const MAX_INVITES_PER_GUILD: i64 = 1_000;

const MAX_INVITES_PER_CREATOR: i64 = 100;

pub async fn create_invite(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<CreateInvite>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::CREATE_INVITE).await?;

    let now = now_ms();
    sqlx::query(
        "DELETE FROM invites WHERE guild_id = ? \
           AND ((expires_at IS NOT NULL AND expires_at <= ?) \
                OR (max_uses IS NOT NULL AND uses >= max_uses))",
    )
    .bind(&guild_id)
    .bind(now)
    .execute(&state.pool)
    .await?;

    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    if live >= MAX_INVITES_PER_GUILD {
        return Err(ApiError::Conflict(format!(
            "this guild already holds {MAX_INVITES_PER_GUILD} live invites; revoke some first"
        )));
    }
    let mine: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE guild_id = ? AND creator = ?")
            .bind(&guild_id)
            .bind(&auth.user_id)
            .fetch_one(&state.pool)
            .await?;
    if mine >= MAX_INVITES_PER_CREATOR {
        return Err(ApiError::Conflict(format!(
            "you already hold {MAX_INVITES_PER_CREATOR} live invites to this guild"
        )));
    }
    if req.max_uses.is_some_and(|v| v < 1 || v > 100_000) {
        return Err(ApiError::BadRequest("max_uses must be between 1 and 100000".into()));
    }
    if req.expires_in_secs.is_some_and(|v| v < 60 || v > 31_536_000) {
        return Err(ApiError::BadRequest("expires_in_secs must be between 60 seconds and one year".into()));
    }
    let code = invite_code();
    let expires_at = req.expires_in_secs.map(|s| now_ms() + s * 1000);
    sqlx::query(
        "INSERT INTO invites (code, guild_id, channel_id, creator, max_uses, expires_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&code).bind(&guild_id).bind(&req.channel_id).bind(&auth.user_id)
    .bind(req.max_uses).bind(expires_at).bind(now_ms())
    .execute(&state.pool).await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "invite.create", Some(&code),
        json!({ "channel_id": req.channel_id, "max_uses": req.max_uses, "expires_at": expires_at })).await?;

    Ok(Json(json!({
        "code": code,
        "url": state.cfg.invite_link(&code),
        "guild_id": guild_id,
        "expires_at": expires_at,
        "max_uses": req.max_uses,
    })))
}

pub async fn list_invites(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let rows: Vec<(String, Option<String>, String, i64, Option<i64>, Option<i64>, i64)> =
        sqlx::query_as(
            "SELECT code, channel_id, creator, uses, max_uses, expires_at, created_at              FROM invites WHERE guild_id = ? ORDER BY created_at DESC LIMIT 200",
        )
        .bind(&guild_id)
        .fetch_all(&state.pool)
        .await?;
    let now = now_ms();
    Ok(Json(json!({
        "invites": rows.into_iter().map(|(code, channel_id, creator, uses, max_uses, expires_at, created_at)| {
            let expired = expires_at.is_some_and(|e| e <= now) || max_uses.is_some_and(|m| uses >= m);
            json!({
                "code": code,
                "url": state.cfg.invite_link(&code),
                "channel_id": channel_id,
                "creator": creator,
                "uses": uses,
                "max_uses": max_uses,
                "expires_at": expires_at,
                "created_at": created_at,
                "expired": expired,
            })
        }).collect::<Vec<_>>()
    })))
}

pub async fn revoke_invite(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, code)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let done = sqlx::query("DELETE FROM invites WHERE guild_id = ? AND code = ?")
        .bind(&guild_id).bind(&code).execute(&state.pool).await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound("invite not found".into()));
    }
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "invite.revoke", Some(&code), json!({})).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn invite_preview(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    let row: Option<(String, Option<String>, String, i64, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT guild_id, channel_id, creator, uses, max_uses, expires_at FROM invites WHERE code = ?",
    )
    .bind(&code).fetch_optional(&state.pool).await?;
    let (guild_id, channel_id, creator, uses, max_uses, expires_at) =
        row.ok_or_else(|| ApiError::NotFound("unknown invite".into()))?;

    if expires_at.is_some_and(|e| e <= now_ms()) || max_uses.is_some_and(|m| uses >= m) {
        return Err(ApiError::NotFound("invite has expired".into()));
    }

    let g: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, icon_ref FROM guilds WHERE id = ?")
            .bind(&guild_id).fetch_optional(&state.pool).await?;
    let (name, icon_ref) = g.ok_or_else(|| ApiError::NotFound("guild is gone".into()))?;

    Ok(Json(json!({
        "code": code,
        "guild": {
            "id": guild_id,
            "name": name,
            "icon_ref": icon_ref,
            "member_count": guildstore::member_count(&state.pool, &guild_id).await?,
            "online_count": state.hub.online_users_in(&guild_id).await.len(),
            "host": state.cfg.server_name,
        },
        "channel_id": channel_id,
        "inviter": creator,
        "expires_at": expires_at,
    })))
}

pub async fn join_with_invite(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(code): Path<String>,
) -> ApiResult<Json<Value>> {
    // Bots are refused before invite lookup so this isn't an invite-code oracle.
    if auth.is_bot {
        return Err(bot_managed_conflict());
    }
    let row: Option<(String, i64, Option<i64>, Option<i64>)> =
        sqlx::query_as("SELECT guild_id, uses, max_uses, expires_at FROM invites WHERE code = ?")
            .bind(&code).fetch_optional(&state.pool).await?;
    let (guild_id, uses, max_uses, expires_at) =
        row.ok_or_else(|| ApiError::NotFound("unknown invite".into()))?;
    if expires_at.is_some_and(|e| e <= now_ms()) || max_uses.is_some_and(|m| uses >= m) {
        return Err(ApiError::NotFound("invite has expired".into()));
    }

    join_guild_member(
        &state,
        &auth,
        &guild_id,
        Some(&code),
        json!({ "invite": code.clone() }),
    )
    .await
}

pub(super) async fn join_guild_member(
    state: &AppState,
    auth: &GuildAuth,
    guild_id: &str,
    invite_code: Option<&str>,
    audit_data: Value,
) -> ApiResult<Json<Value>> {
    if auth.is_bot {
        return Err(bot_managed_conflict());
    }

    let existing: Option<i64> =
        sqlx::query_scalar("SELECT banned FROM members WHERE guild_id = ? AND user_id = ?")
            .bind(guild_id).bind(&auth.user_id).fetch_optional(&state.pool).await?;
    match existing {
        Some(1) => return Err(ApiError::Forbidden("you are banned from this guild".into())),
        Some(_) => return Ok(Json(guild_json(state, guild_id).await?)),
        None => {}
    }

    if let crate::routes::moderation::Gate::Screening(questions) =
        crate::routes::moderation::check_gate(state, guild_id, auth).await?
    {
        return Ok(Json(json!({
            "pending": true, "guild_id": guild_id, "screening": questions,
        })));
    }

    // Captured before membership exists so join-time messages stay unread.
    let heads = guildstore::channel_heads(&state.pool, guild_id).await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO members (guild_id, user_id, joined_at, display_name, avatar_ref) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(guild_id).bind(&auth.user_id).bind(now_ms())
    .bind(&auth.display_name).bind(&auth.avatar_ref)
    .execute(&mut *tx).await?;
    if let Some(code) = invite_code {
        sqlx::query("UPDATE invites SET uses = uses + 1 WHERE code = ?")
            .bind(code).execute(&mut *tx).await?;
    }
    tx.commit().await?;

    guildstore::seed_read_state(state, guild_id, &auth.user_id, &heads).await?;

    let member = member_row_json(state, guild_id, &auth.user_id).await?;
    state.hub.publish(Event::new(
        "MEMBER_ADD",
        guild_id.to_string(),
        INTENT_GUILD_MEMBERS,
        member,
    )).await;
    guildstore::audit(
        &state.pool,
        guild_id,
        &auth.user_id,
        "member.join",
        Some(&auth.user_id),
        audit_data,
    ).await?;
    crate::memberships::notify_home(state, &auth.user_id, guild_id, "joined");
    Ok(Json(guild_json(state, guild_id).await?))
}
