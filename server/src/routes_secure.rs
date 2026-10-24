
#[path = "routes/mod.rs"]
mod original;

pub use original::{
    alerts, bots, dm, dmvoice, failover, friends, guild, hosting, identity,
    identity_continuity, interactions, media, memberships, messages, migrate, moderation,
    opaque, push, recovery, social, voice, wellknown,
};

use crate::auth::GuildAuth;
use crate::error::ApiError;
use crate::guildstore;
use crate::perms;
use crate::state::AppState;
use crate::util::now_ms;
use axum::body::{to_bytes, Body};
use axum::extract::{Request, State};
use axum::http::{header, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use serde::de::DeserializeOwned;
use serde::Deserialize;

pub fn router(state: AppState) -> Router {
    let guard_state = state.clone();
    original::router(state).layer(axum::middleware::from_fn_with_state(
        guard_state,
        security_guard,
    ))
}

pub fn router_with_standbys(state: AppState, replicas: &[crate::replicate::Replica]) -> Router {
    let mut app = router(state.clone());
    for replica in replicas {
        let guard = read_only_guard(state.clone(), replica.origin.clone());
        let mirror = router(replica.state.clone()).layer(axum::middleware::from_fn(guard));
        app = app.nest_service(&crate::replicate::mount_path(&replica.origin), mirror);
    }
    app
}

fn read_only_guard(
    host: AppState,
    origin: String,
) -> impl Fn(
    axum::extract::Request,
    axum::middleware::Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>
       + Clone
       + Send
       + 'static {
    move |req: axum::extract::Request, next: axum::middleware::Next| {
        let host = host.clone();
        let origin = origin.clone();
        Box::pin(async move {
            let writing = !matches!(
                *req.method(),
                axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
            );
            if writing {
                let promoted: i64 = sqlx::query_scalar(
                    "SELECT promoted FROM replica_state WHERE origin = ?",
                )
                .bind(&origin)
                .fetch_optional(&host.pool)
                .await
                .ok()
                .flatten()
                .unwrap_or(0);
                if promoted == 0 {
                    return (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        axum::Json(serde_json::json!({
                            "error": "standby_read_only",
                            "code": crate::errcodes::STANDBY_READ_ONLY,
                            "message": format!(
                                "this is a standby copy of {origin}; it can be read but not written to"
                            ),
                            "origin": origin,
                        })),
                    )
                        .into_response();
                }
            }
            next.run(req).await
        })
    }
}

async fn security_guard(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    if let Err(err) = guard_request(&state, &mut req).await {
        return err.into_response();
    }
    next.run(req).await
}

#[derive(Deserialize)]
struct RoleCreateGuard {
    #[serde(default)]
    position: Option<i64>,
}

#[derive(Deserialize)]
struct MemberPatchGuard {
    #[serde(default)]
    add_roles: Option<Vec<String>>,
    #[serde(default)]
    remove_roles: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct OverwriteGuard {
    allow: String,
    deny: String,
}

async fn guard_request(state: &AppState, req: &mut Request) -> Result<(), ApiError> {
    let method = req.method().clone();
    let parts: Vec<String> = req
        .uri()
        .path()
        .trim_matches('/')
        .split('/')
        .map(str::to_string)
        .collect();

    if method == Method::GET
        && parts.len() == 5
        && parts[0] == "_telium"
        && parts[1] == "v1"
        && parts[2] == "media"
        && parts[4] == "meta"
    {
        let presented = query_param(req.uri().query(), "cap").unwrap_or_default();
        guard_media_meta(state, &parts[3], presented).await?;
        return Ok(());
    }

    let token = bearer_token(req);
    let Some(auth) = guild_auth(state, token).await? else {
        return Ok(());
    };

    if method == Method::POST
        && parts.len() == 5
        && parts[0] == "_telium"
        && parts[1] == "v1"
        && parts[2] == "guilds"
        && parts[4] == "roles"
    {
        if let Some(body) = read_json::<RoleCreateGuard>(req).await? {
            guard_role_create(state, &auth, &parts[3], body).await?;
        }
        return Ok(());
    }

    if method == Method::DELETE
        && parts.len() == 6
        && parts[0] == "_telium"
        && parts[1] == "v1"
        && parts[2] == "guilds"
        && parts[4] == "roles"
    {
        guard_role_delete(state, &auth, &parts[3], &parts[5]).await?;
        return Ok(());
    }

    if method == Method::PATCH
        && parts.len() == 6
        && parts[0] == "_telium"
        && parts[1] == "v1"
        && parts[2] == "guilds"
        && parts[4] == "members"
    {
        if let Some(body) = read_json::<MemberPatchGuard>(req).await? {
            guard_member_roles(state, &auth, &parts[3], &parts[5], body).await?;
        }
        return Ok(());
    }

    if method == Method::PUT
        && parts.len() == 7
        && parts[0] == "_telium"
        && parts[1] == "v1"
        && parts[2] == "channels"
        && parts[4] == "overwrites"
    {
        if let Some(body) = read_json::<OverwriteGuard>(req).await? {
            guard_overwrite(state, &auth, &parts[3], &parts[5], &parts[6], body).await?;
        }
    }

    Ok(())
}

fn bearer_token(req: &Request) -> Option<String> {
    req.headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn query_param(query: Option<&str>, wanted: &str) -> Option<String> {
    query.and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == wanted)
            .map(|(_, value)| value.into_owned())
    })
}

async fn guild_auth(state: &AppState, token: Option<String>) -> Result<Option<GuildAuth>, ApiError> {
    let Some(token) = token else {
        return Ok(None);
    };

    match GuildAuth::from_token(state, &token).await {
        Ok(auth) => Ok(Some(auth)),
        Err(ApiError::Unauthorized(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

async fn read_json<T: DeserializeOwned>(req: &mut Request) -> Result<Option<T>, ApiError> {
    let body = std::mem::replace(req.body_mut(), Body::empty());
    let bytes = to_bytes(body, 1024 * 1024)
        .await
        .map_err(|_| ApiError::BadRequest("request body could not be read".into()))?;
    *req.body_mut() = Body::from(bytes.clone());

    Ok(serde_json::from_slice::<T>(&bytes).ok())
}

async fn guard_media_meta(
    state: &AppState,
    hash: &str,
    presented: String,
) -> Result<(), ApiError> {
    let row: Option<(String, String, Option<i64>)> = sqlx::query_as(
        "SELECT capability, purpose, expires_at FROM media WHERE hash = ?",
    )
    .bind(hash)
    .fetch_optional(&state.pool)
    .await?;
    let Some((capability, purpose, expires_at)) = row else {
        return Ok(());
    };
    if expires_at.is_some_and(|at| at <= now_ms()) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    if purpose == "expression" {
        return Ok(());
    }

    if !constant_time_eq(presented.as_bytes(), capability.as_bytes()) {
        return Err(ApiError::NotFound("no such media".into()));
    }
    Ok(())
}

async fn guard_role_create(
    state: &AppState,
    auth: &GuildAuth,
    guild_id: &str,
    req: RoleCreateGuard,
) -> Result<(), ApiError> {
    let actor =
        guildstore::require_guild_perm(state, guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    if actor.user_id == actor.owner {
        return Ok(());
    }
    let actor_top = guildstore::top_role_position(&state.pool, guild_id, &auth.user_id).await?;
    let position = req.position.unwrap_or(1).max(1);
    if position >= actor_top {
        return Err(ApiError::Forbidden(
            "cannot create a role at or above your highest role".into(),
        ));
    }
    Ok(())
}

async fn guard_role_delete(
    state: &AppState,
    auth: &GuildAuth,
    guild_id: &str,
    role_id: &str,
) -> Result<(), ApiError> {
    let actor =
        guildstore::require_guild_perm(state, guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;
    if actor.user_id == actor.owner {
        return Ok(());
    }
    let role_position: Option<i64> = sqlx::query_scalar(
        "SELECT position FROM roles WHERE id = ? AND guild_id = ?",
    )
    .bind(role_id)
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(role_position) = role_position else {
        return Ok(());
    };
    let actor_top = guildstore::top_role_position(&state.pool, guild_id, &auth.user_id).await?;
    if role_position >= actor_top {
        return Err(ApiError::Forbidden(
            "cannot delete a role at or above your highest role".into(),
        ));
    }
    Ok(())
}

async fn guard_member_roles(
    state: &AppState,
    auth: &GuildAuth,
    guild_id: &str,
    target: &str,
    req: MemberPatchGuard,
) -> Result<(), ApiError> {
    if req.add_roles.is_none() && req.remove_roles.is_none() {
        return Ok(());
    }
    let actor =
        guildstore::require_guild_perm(state, guild_id, &auth.user_id, perms::MANAGE_ROLES).await?;

    let target_exists: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?",
    )
    .bind(guild_id)
    .bind(target)
    .fetch_optional(&state.pool)
    .await?;
    if target_exists.is_none() {
        return Ok(());
    }

    let actor_top = guildstore::top_role_position(&state.pool, guild_id, &auth.user_id).await?;
    let is_owner = actor.user_id == actor.owner;
    if target != actor.user_id {
        let target_top = guildstore::top_role_position(&state.pool, guild_id, target).await?;
        if !perms::outranks(actor_top, is_owner, target_top, target == actor.owner) {
            return Err(ApiError::Forbidden("target outranks you".into()));
        }
    }

    for role_id in req
        .add_roles
        .iter()
        .flatten()
        .chain(req.remove_roles.iter().flatten())
    {
        let pos: Option<i64> = sqlx::query_scalar(
            "SELECT position FROM roles WHERE id = ? AND guild_id = ?",
        )
        .bind(role_id)
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?;
        let pos = pos.ok_or_else(|| ApiError::NotFound("role not found".into()))?;
        if !is_owner && pos >= actor_top {
            return Err(ApiError::Forbidden(
                "cannot assign or remove a role at or above your own".into(),
            ));
        }
    }
    Ok(())
}

async fn guard_overwrite(
    state: &AppState,
    auth: &GuildAuth,
    channel_id: &str,
    target_type: &str,
    target_id: &str,
    req: OverwriteGuard,
) -> Result<(), ApiError> {
    if target_type != "role" && target_type != "member" {
        return Ok(());
    }
    let guild_id: Option<String> =
        sqlx::query_scalar("SELECT guild_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(guild_id) = guild_id else {
        return Ok(());
    };
    let actor = guildstore::require_guild_perm(
        state,
        &guild_id,
        &auth.user_id,
        perms::MANAGE_ROLES,
    )
    .await?;

    let (Ok(allow), Ok(deny)) = (req.allow.parse::<u64>(), req.deny.parse::<u64>()) else {
        return Ok(());
    };
    let mine = actor.guild_permissions();
    if mine != u64::MAX && (allow | deny) & !mine != 0 {
        return Err(ApiError::Forbidden(
            "cannot set an overwrite for permissions you do not hold".into(),
        ));
    }

    match target_type {
        "role" => {
            let position: Option<i64> = sqlx::query_scalar(
                "SELECT position FROM roles WHERE id = ? AND guild_id = ?",
            )
            .bind(target_id)
            .bind(&guild_id)
            .fetch_optional(&state.pool)
            .await?;
            let position = position
                .ok_or_else(|| ApiError::NotFound("role not found in this guild".into()))?;
            if actor.user_id != actor.owner {
                let actor_top = guildstore::top_role_position(
                    &state.pool,
                    &guild_id,
                    &auth.user_id,
                )
                .await?;
                if position >= actor_top {
                    return Err(ApiError::Forbidden(
                        "cannot edit an overwrite for a role at or above your highest role".into(),
                    ));
                }
            }
        }
        "member" => {
            let exists: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM members WHERE guild_id = ? AND user_id = ? AND banned = 0",
            )
            .bind(&guild_id)
            .bind(target_id)
            .fetch_optional(&state.pool)
            .await?;
            if exists.is_none() {
                return Err(ApiError::NotFound("member not found in this guild".into()));
            }
        }
        _ => {}
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::constant_time_eq;

    #[test]
    fn capability_compare_requires_exact_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
