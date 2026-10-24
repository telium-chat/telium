
use crate::admin::require_admin;
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct GuildQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub cursor: Option<String>,
}

const GUILD_COLUMNS: &str = "\
    g.id, g.name, g.alias, g.owner_user_id, g.created_at, \
    (SELECT COUNT(*) FROM members m WHERE m.guild_id = g.id) AS members, \
    (SELECT COUNT(*) FROM channels c WHERE c.guild_id = g.id) AS channels, \
    (SELECT COUNT(*) FROM messages msg WHERE msg.guild_id = g.id AND msg.deleted = 0) AS messages, \
    (SELECT COUNT(*) FROM cold_segments cs JOIN channels c2 ON c2.id = cs.channel_id \
       WHERE c2.guild_id = g.id) AS archived_segments, \
    (SELECT COALESCE(SUM(cs.bytes), 0) FROM cold_segments cs \
       JOIN channels c3 ON c3.id = cs.channel_id WHERE c3.guild_id = g.id) AS archived_bytes, \
    (SELECT t.new_id FROM tombstones t WHERE t.subject_type = 'guild' \
       AND t.subject_id = g.id AND t.kind = 'moved') AS moved_to, \
    (SELECT COUNT(*) FROM tombstones t2 WHERE t2.subject_type = 'guild' \
       AND t2.subject_id = g.id AND t2.kind = 'gone') AS gone";

type GuildRow = (
    String,         // id
    String,         // name
    Option<String>, // alias
    String,         // owner_user_id
    i64,            // created_at
    i64,            // members
    i64,            // channels
    i64,            // messages
    i64,            // archived_segments
    i64,            // archived_bytes
    Option<String>, // moved_to
    i64,            // gone
);

fn guild_json(r: &GuildRow) -> Value {
    json!({
        "id": r.0,
        "name": r.1,
        "alias": r.2,
        "owner_user_id": r.3,
        "created_at": r.4,
        "members": r.5,
        "channels": r.6,
        "messages": r.7,
        "archived_segments": r.8,
        "archived_bytes": r.9,
        "moved_to": r.10,
        "gone": r.11 != 0,
    })
}

pub async fn list(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<GuildQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let search = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty());

    let mut sql = format!("SELECT {GUILD_COLUMNS} FROM guilds g WHERE 1 = 1");
    if search.is_some() {
        sql.push_str(" AND (g.name LIKE ? OR g.alias LIKE ?)");
    }
    if q.cursor.is_some() {
        sql.push_str(" AND g.id < ?");
    }
    sql.push_str(" ORDER BY g.id DESC LIMIT ?");

    let mut query = sqlx::query_as::<_, GuildRow>(&sql);
    if let Some(term) = search {
        let pattern = format!("%{term}%");
        query = query.bind(pattern.clone()).bind(pattern);
    }
    if let Some(cursor) = &q.cursor {
        query = query.bind(cursor);
    }
    let rows = query.bind(limit + 1).fetch_all(&state.pool).await?;

    let has_more = rows.len() as i64 > limit;
    let page = &rows[..rows.len().min(limit as usize)];

    let mut count_sql = String::from("SELECT COUNT(*) FROM guilds g WHERE 1 = 1");
    if search.is_some() {
        count_sql.push_str(" AND (g.name LIKE ? OR g.alias LIKE ?)");
    }
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    if let Some(term) = search {
        let pattern = format!("%{term}%");
        count_query = count_query.bind(pattern.clone()).bind(pattern);
    }
    let total = count_query.fetch_one(&state.pool).await?;

    Ok(Json(json!({
        "guilds": page.iter().map(guild_json).collect::<Vec<_>>(),
        "next_cursor": if has_more { page.last().map(|r| r.0.clone()) } else { None },
        "total": total,
    })))
}

pub async fn detail(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;

    let sql = format!("SELECT {GUILD_COLUMNS} FROM guilds g WHERE g.id = ?");
    let row = sqlx::query_as::<_, GuildRow>(&sql)
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("this server does not host that guild".into()))?;

    let roles: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM roles WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    let emojis: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM emojis WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    let stickers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stickers WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    let invites: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM invites WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    let threads: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM threads WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    let remote_members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM members WHERE guild_id = ? AND user_id NOT LIKE ?",
    )
    .bind(&guild_id)
    .bind(format!("%:{}", state.cfg.server_name))
    .fetch_one(&state.pool)
    .await?;
    let banned: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM members WHERE guild_id = ? AND banned = 1")
            .bind(&guild_id)
            .fetch_one(&state.pool)
            .await?;
    let last_message_at: Option<i64> = sqlx::query_scalar(
        "SELECT MAX(created_at) FROM messages WHERE guild_id = ?",
    )
    .bind(&guild_id)
    .fetch_optional(&state.pool)
    .await?
    .flatten();

    let owner_local: Option<(String, Option<String>, i64)> = sqlx::query_as(
        "SELECT a.user_id, p.display_name, a.deactivated FROM accounts a \
         LEFT JOIN profiles p ON p.user_id = a.user_id WHERE a.user_id = ?",
    )
    .bind(&row.3)
    .fetch_optional(&state.pool)
    .await?;
    let owner = match &owner_local {
        Some((id, name, deactivated)) => json!({
            "user_id": id,
            "display_name": name,
            "local": true,
            "deactivated": *deactivated != 0,
        }),
        None => json!({ "user_id": row.3, "display_name": null, "local": false }),
    };

    let reports_against: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM reports WHERE target_type = 'guild' AND target_id = ?",
    )
    .bind(&guild_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(json!({
        "guild": guild_json(&row),
        "roles": roles,
        "emojis": emojis,
        "stickers": stickers,
        "invites": invites,
        "threads": threads,
        "remote_members": remote_members,
        "banned_members": banned,
        "last_message_at": last_message_at,
        "owner": owner,
        "reports_against": reports_against,
    })))
}
