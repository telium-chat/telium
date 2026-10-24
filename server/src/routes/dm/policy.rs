use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use super::*;

const POLICY_RULES: [&str; 3] = ["creator", "admins", "anyone"];
const MAX_POLICY_ADMINS: usize = 256;

pub(super) fn normalise_policy(value: &Value, creator: &str, members: &[String]) -> ApiResult<Value> {
    let bad = |m: String| ApiError::BadRequest(format!("membership policy: {m}"));
    let obj = value.as_object().ok_or_else(|| bad("must be an object".into()))?;
    if obj.get("v").and_then(Value::as_i64) != Some(1) {
        return Err(bad("unknown version; this server understands v1".into()));
    }
    if let Some(given) = obj.get("creator") {
        if given.as_str() != Some(creator) {
            return Err(bad("the creator of a group cannot be changed".into()));
        }
    }
    let mut out = serde_json::Map::new();
    out.insert("v".into(), json!(1));
    out.insert("creator".into(), json!(creator));
    for rule in ["add", "remove", "policy"] {
        let who = obj
            .get(rule)
            .and_then(Value::as_str)
            .filter(|w| POLICY_RULES.contains(w))
            .ok_or_else(|| bad(format!("{rule} must be one of creator, admins, anyone")))?;
        out.insert(rule.into(), json!(who));
    }
    let mut admins: Vec<String> = match obj.get("admins") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|a| {
                a.as_str()
                    .filter(|a| !a.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| bad("admins must be user ids".into()))
            })
            .collect::<ApiResult<_>>()?,
        Some(_) => return Err(bad("admins must be a list".into())),
    };
    admins.sort();
    admins.dedup();
    if admins.len() > MAX_POLICY_ADMINS {
        return Err(bad(format!("at most {MAX_POLICY_ADMINS} admins")));
    }
    if let Some(stranger) = admins.iter().find(|a| !members.contains(a)) {
        return Err(bad(format!("{stranger} is not in this group")));
    }
    out.insert("admins".into(), json!(admins));
    Ok(Value::Object(out))
}

fn policy_allows(policy: &Value, rule: &str, user: &str) -> bool {
    if policy.get("creator").and_then(Value::as_str) == Some(user) {
        return true;
    }
    match policy.get(rule).and_then(Value::as_str) {
        Some("anyone") => true,
        Some("admins") => policy
            .get("admins")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(user))),
        _ => false,
    }
}

pub(super) async fn load_policy(state: &AppState, id: &str) -> ApiResult<Option<Value>> {
    let raw: Option<Option<String>> =
        sqlx::query_scalar("SELECT policy FROM conversations WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(raw.flatten().and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(Value::is_object))
}

async fn active_members(state: &AppState, id: &str) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT user_id FROM conversation_members WHERE conversation_id = ? AND state = 'active'",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?)
}

pub(super) async fn authorize_change(
    state: &AppState,
    conversation_id: &str,
    kind: &str,
    actor: &str,
    change: &Change,
) -> ApiResult<Option<String>> {
    if kind != "commit" {
        return Err(ApiError::BadRequest("only a commit changes a group's membership".into()));
    }
    let policy = load_policy(state, conversation_id).await?;
    let members = active_members(state, conversation_id).await?;
    let denied = |what: &str| {
        ApiError::Forbidden(format!("this group's membership policy does not let {actor} {what}"))
    };
    match change.op.as_str() {
        "add" => {
            let newcomers: Vec<&String> =
                change.user_ids.iter().filter(|u| !members.contains(u)).collect();
            if newcomers.is_empty() {
                return Ok(None);
            }
            let conv_kind: String =
                sqlx::query_scalar("SELECT kind FROM conversations WHERE id = ?")
                    .bind(conversation_id)
                    .fetch_one(&state.pool)
                    .await?;
            if conv_kind == "dm" {
                return Err(ApiError::BadRequest(
                    "a dm has two participants; start a group chat instead".into(),
                ));
            }
            if let Some(p) = &policy {
                if !policy_allows(p, "add", actor) {
                    return Err(denied("add people"));
                }
            }
            if members.len() + newcomers.len() > MAX_GROUP_MEMBERS {
                return Err(ApiError::Conflict(format!(
                    "group chats hold up to {MAX_GROUP_MEMBERS} people; convert it to a guild to grow"
                )));
            }
            for u in newcomers {
                home_of(u)?;
            }
            Ok(None)
        }
        "remove" => {
            if change.user_ids.is_empty() {
                return Err(ApiError::BadRequest("a removal names who it removes".into()));
            }
            if let Some(p) = &policy {
                if change.user_ids.iter().any(|u| u != actor && members.contains(u))
                    && !policy_allows(p, "remove", actor)
                {
                    return Err(denied("remove people"));
                }
            }
            Ok(None)
        }
        "policy" => {
            let next = change.policy.as_ref().ok_or_else(|| {
                ApiError::BadRequest("a policy change carries the new policy".into())
            })?;
            let Some(current) = policy else {
                return Ok(Some(normalise_policy(next, actor, &members)?.to_string()));
            };
            let creator = current.get("creator").and_then(Value::as_str).unwrap_or_default();
            let next = normalise_policy(next, creator, &members)?;
            if !policy_allows(&current, "policy", actor) {
                return Err(denied("change the policy"));
            }
            Ok(Some(next.to_string()))
        }
        _ => Err(ApiError::BadRequest("unknown membership change".into())),
    }
}

pub async fn withdraw_policy(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT creator, sequencer FROM conversations WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.pool)
            .await?;
    let (creator, sequencer) =
        row.ok_or_else(|| ApiError::NotFound("no such conversation".into()))?;
    if creator != auth.user_id {
        return Err(ApiError::Forbidden("only the creator may withdraw a group's policy".into()));
    }
    if sequencer != state.cfg.server_name {
        return Err(ApiError::Conflict("this conversation is sequenced elsewhere".into()));
    }
    let committed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM dm_messages WHERE conversation_id = ? AND kind = 'commit'",
    )
    .bind(&id)
    .fetch_one(&state.pool)
    .await?;
    if committed > 0 {
        return Err(ApiError::Conflict(
            "the group has moved on; change its policy with a commit instead".into(),
        ));
    }
    sqlx::query("UPDATE conversations SET policy = NULL, updated_at = ? WHERE id = ?")
        .bind(now_ms())
        .bind(&id)
        .execute(&state.pool)
        .await?;
    Ok(Json(conversation_json(&state, &id).await?))
}
