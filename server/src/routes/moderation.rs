
use crate::auth::GuildAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::media_feeds;
use crate::gateway::events::{Event, INTENT_GUILD_MEMBERS, INTENT_GUILD_MESSAGES};
use crate::guildstore::{self, Membership};
use crate::perms;
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
pub struct RuleInput {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub threshold: Option<i64>,
    #[serde(default)]
    pub exempt_roles: Vec<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

const KINDS: [&str; 5] = ["keyword", "regex", "link", "flood", "mention"];
const ACTIONS: [&str; 3] = ["block", "flag", "timeout"];

fn validate_rule(req: &RuleInput) -> ApiResult<()> {
    if !KINDS.contains(&req.kind.as_str()) {
        return Err(ApiError::BadRequest(format!("kind must be one of {}", KINDS.join(", "))));
    }
    let action = req.action.as_deref().unwrap_or("block");
    if !ACTIONS.contains(&action) {
        return Err(ApiError::BadRequest(format!("action must be one of {}", ACTIONS.join(", "))));
    }
    if req.name.trim().is_empty() || req.name.chars().count() > 64 {
        return Err(ApiError::BadRequest("rule name must be 1-64 characters".into()));
    }
    match req.kind.as_str() {
        "regex" => {
            compile(&req.pattern)
                .ok_or_else(|| ApiError::BadRequest("that regex is invalid or too large".into()))?;
        }
        "flood" | "mention" if req.threshold.unwrap_or(0) < 1 => {
            return Err(ApiError::BadRequest("this rule kind needs a threshold of 1 or more".into()));
        }
        "keyword" if req.pattern.trim().is_empty() => {
            return Err(ApiError::BadRequest("a keyword rule needs at least one word".into()));
        }
        _ => {}
    }
    Ok(())
}

fn compile(pattern: &str) -> Option<regex::Regex> {
    regex::RegexBuilder::new(pattern)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .dfa_size_limit(1 << 20)
        .build()
        .ok()
}

async fn require_perm_here(
    state: &AppState,
    guild_id: &str,
    user_id: &str,
    bit: u64,
) -> ApiResult<guildstore::Membership> {
    let member = guildstore::require_guild_perm(state, guild_id, user_id, bit).await?;
    guildstore::ensure_authoritative(state, guild_id).await?;
    Ok(member)
}

pub async fn create_rule(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<RuleInput>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    validate_rule(&req)?;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM automod_rules WHERE guild_id = ?")
        .bind(&guild_id)
        .fetch_one(&state.pool)
        .await?;
    if count >= 100 {
        return Err(ApiError::Conflict("this guild is at its AutoMod rule limit".into()));
    }

    let id = ulid();
    sqlx::query(
        "INSERT INTO automod_rules (id, guild_id, name, kind, pattern, action, threshold, \
         exempt_roles, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&guild_id)
    .bind(req.name.trim())
    .bind(&req.kind)
    .bind(&req.pattern)
    .bind(req.action.as_deref().unwrap_or("block"))
    .bind(req.threshold.unwrap_or(0))
    .bind(serde_json::to_string(&req.exempt_roles).unwrap_or_else(|_| "[]".into()))
    .bind(req.enabled.unwrap_or(true) as i64)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "automod.create", Some(&id),
        json!({ "kind": req.kind, "action": req.action })).await?;
    Ok(Json(rule_json(&state, &id).await?))
}

pub async fn rule_json(state: &AppState, id: &str) -> ApiResult<Value> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, String, String, String, String, i64, String, i64)> =
        sqlx::query_as(
            "SELECT id, guild_id, name, kind, pattern, action, threshold, exempt_roles, enabled \
             FROM automod_rules WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    let (id, guild_id, name, kind, pattern, action, threshold, exempt, enabled) =
        row.ok_or_else(|| ApiError::NotFound("no such rule".into()))?;
    Ok(json!({
        "id": id, "guild_id": guild_id, "name": name, "kind": kind, "pattern": pattern,
        "action": action, "threshold": threshold,
        "exempt_roles": serde_json::from_str::<Value>(&exempt).unwrap_or(json!([])),
        "enabled": enabled != 0,
    }))
}

pub async fn list_rules(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM automod_rules WHERE guild_id = ? ORDER BY created_at")
            .bind(&guild_id)
            .fetch_all(&state.pool)
            .await?;
    let mut rules = Vec::new();
    for id in ids {
        rules.push(rule_json(&state, &id).await?);
    }
    Ok(Json(json!({ "rules": rules })))
}

pub async fn patch_rule(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, rule_id)): Path<(String, String)>,
    Json(req): Json<RuleInput>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    validate_rule(&req)?;
    let done = sqlx::query(
        "UPDATE automod_rules SET name = ?, kind = ?, pattern = ?, action = ?, threshold = ?, \
         exempt_roles = ?, enabled = ? WHERE id = ? AND guild_id = ?",
    )
    .bind(req.name.trim())
    .bind(&req.kind)
    .bind(&req.pattern)
    .bind(req.action.as_deref().unwrap_or("block"))
    .bind(req.threshold.unwrap_or(0))
    .bind(serde_json::to_string(&req.exempt_roles).unwrap_or_else(|_| "[]".into()))
    .bind(req.enabled.unwrap_or(true) as i64)
    .bind(&rule_id)
    .bind(&guild_id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound("no such rule".into()));
    }
    Ok(Json(rule_json(&state, &rule_id).await?))
}

pub async fn delete_rule(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, rule_id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    sqlx::query("DELETE FROM automod_rules WHERE id = ? AND guild_id = ?")
        .bind(&rule_id)
        .bind(&guild_id)
        .execute(&state.pool)
        .await?;
    guildstore::audit(&state.pool, &guild_id, &auth.user_id, "automod.delete", Some(&rule_id),
        json!({})).await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct HitQuery {
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list_hits(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Query(q): Query<HitQuery>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_MESSAGES)
        .await?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, rule_id, user_id, channel_id, action, excerpt, created_at FROM automod_hits \
         WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?",
    )
    .bind(&guild_id)
    .bind(q.limit.unwrap_or(50).clamp(1, 200))
    .fetch_all(&state.pool)
    .await?;
    let hits: Vec<Value> = rows.into_iter().map(hit_json).collect();
    Ok(Json(json!({ "hits": hits })))
}

#[allow(clippy::type_complexity)]
fn hit_json(row: (String, String, String, String, String, String, i64)) -> Value {
    let (id, rule_id, user_id, channel_id, action, content, created_at) = row;
    json!({
        "id": id,
        "rule_id": rule_id,
        "user_id": user_id,
        "channel_id": channel_id,
        "action": action,
        "content": content,
        "created_at": created_at,
    })
}

pub struct Verdict {
    pub rule_id: String,
    pub rule_name: String,
    pub action: String,
    pub reason: String,
}

pub async fn evaluate(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
    membership: &Membership,
    perms_bits: u64,
    content: &str,
) -> ApiResult<Option<Verdict>> {
    if perms::has(perms_bits, perms::MANAGE_MESSAGES) {
        return Ok(None);
    }
    #[allow(clippy::type_complexity)]
    let rules: Vec<(String, String, String, String, String, i64, String)> = sqlx::query_as(
        "SELECT id, name, kind, pattern, action, threshold, exempt_roles FROM automod_rules \
         WHERE guild_id = ? AND enabled = 1 ORDER BY created_at",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;
    if rules.is_empty() {
        return Ok(None);
    }

    let held: Vec<&str> = membership.roles.iter().map(|(id, _)| id.as_str()).collect();
    let lowered = content.to_lowercase();
    let mut blocking: Option<Verdict> = None;

    for (id, name, kind, pattern, action, threshold, exempt) in rules {
        let exempt: Vec<String> = serde_json::from_str(&exempt).unwrap_or_default();
        if exempt.iter().any(|r| held.contains(&r.as_str())) {
            continue;
        }
        let reason = match kind.as_str() {
            "keyword" => pattern
                .split(',')
                .map(str::trim)
                .filter(|w| !w.is_empty())
                .find(|w| lowered.contains(&w.to_lowercase()))
                .map(|w| format!("matched keyword {w:?}")),
            "regex" => compile(&pattern)
                .filter(|re| re.is_match(content))
                .map(|_| format!("matched rule {name:?}")),
            "link" => link_reason(&pattern, content),
            "mention" => {
                let count = content.matches('@').count() as i64;
                (count >= threshold).then(|| format!("{count} mentions in one message"))
            }
            "flood" => {
                let since = now_ms() - 10_000;
                let recent: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM messages WHERE channel_id = ? AND author_id = ? \
                     AND created_at > ? AND deleted = 0",
                )
                .bind(channel_id)
                .bind(&membership.user_id)
                .bind(since)
                .fetch_one(&state.pool)
                .await?;
                (recent >= threshold).then(|| format!("{recent} messages in ten seconds"))
            }
            _ => None,
        };
        let Some(reason) = reason else { continue };

        let excerpt: String = content.chars().take(200).collect();
        sqlx::query(
            "INSERT INTO automod_hits (id, guild_id, rule_id, user_id, channel_id, action, \
             excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(ulid())
        .bind(guild_id)
        .bind(&id)
        .bind(&membership.user_id)
        .bind(channel_id)
        .bind(&action)
        .bind(&excerpt)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;

        if action == "timeout" {
            sqlx::query("UPDATE members SET timeout_until = ? WHERE guild_id = ? AND user_id = ?")
                .bind(now_ms() + 300_000)
                .bind(guild_id)
                .bind(&membership.user_id)
                .execute(&state.pool)
                .await?;
        }
        state
            .hub
            .publish(Event::in_channel(
                "AUTOMOD_ACTION",
                guild_id.to_string(),
                channel_id.to_string(),
                INTENT_GUILD_MESSAGES,
                json!({
                    "rule_id": id, "rule": name, "action": action, "reason": reason,
                    "user_id": membership.user_id, "channel_id": channel_id,
                }),
            ))
            .await;

        if action != "flag" && blocking.is_none() {
            blocking = Some(Verdict {
                rule_id: id,
                rule_name: name,
                action,
                reason,
            });
        }
    }
    Ok(blocking)
}

fn link_reason(pattern: &str, content: &str) -> Option<String> {
    let allowed: Vec<&str> = pattern.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    for token in content.split_whitespace() {
        let Some(rest) = token.strip_prefix("http://").or_else(|| token.strip_prefix("https://"))
        else {
            continue;
        };
        let host = rest.split(['/', '?', '#']).next().unwrap_or_default().to_lowercase();
        if host.is_empty() {
            continue;
        }
        if pattern.trim() == "*" || allowed.is_empty() {
            return Some(format!("link to {host}"));
        }
        let ok = allowed.iter().any(|a| {
            let a = a.to_lowercase();
            host == a || host.ends_with(&format!(".{a}"))
        });
        if !ok {
            return Some(format!("link to {host}, which is not on the allowlist"));
        }
    }
    None
}

pub async fn should_hold(state: &AppState, guild_id: &str, user_id: &str) -> ApiResult<bool> {
    let hold: i64 = sqlx::query_scalar("SELECT hold_first_messages FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_one(&state.pool)
        .await?;
    if hold <= 0 {
        return Ok(false);
    }
    let sent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM messages WHERE guild_id = ? AND author_id = ? AND deleted = 0",
    )
    .bind(guild_id)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(sent < hold)
}

pub async fn hold(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
    author_id: &str,
    payload: &Value,
    reason: &str,
) -> ApiResult<Value> {
    let id = ulid();
    sqlx::query(
        "INSERT INTO held_messages (id, guild_id, channel_id, author_id, payload, reason, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(guild_id)
    .bind(channel_id)
    .bind(author_id)
    .bind(payload.to_string())
    .bind(reason)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    state
        .hub
        .publish(Event::new(
            "MESSAGE_HELD",
            guild_id.to_string(),
            INTENT_GUILD_MESSAGES,
            json!({ "id": id, "channel_id": channel_id, "author": author_id, "reason": reason }),
        ))
        .await;
    Ok(json!({ "held": true, "id": id, "reason": reason }))
}

pub async fn list_held(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_MESSAGES)
        .await?;
    let rows: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, channel_id, author_id, payload, reason, created_at FROM held_messages \
         WHERE guild_id = ? AND state = 'pending' ORDER BY created_at LIMIT 200",
    )
    .bind(&guild_id)
    .fetch_all(&state.pool)
    .await?;
    let held: Vec<Value> = rows.into_iter().map(held_json).collect();
    Ok(Json(json!({ "held": held })))
}

fn held_json(row: (String, String, String, String, String, i64)) -> Value {
    let (id, channel_id, author, payload, reason, created_at) = row;
    json!({
        "id": id,
        "channel_id": channel_id,
        "author": author,
        "reason": reason,
        "created_at": created_at,
        "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null),
    })
}

#[derive(Deserialize)]
pub struct HeldDecision {
    pub decision: String,
}

pub async fn decide_held(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, held_id)): Path<(String, String)>,
    Json(req): Json<HeldDecision>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_MESSAGES).await?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT channel_id, author_id, payload, state FROM held_messages WHERE id = ? AND guild_id = ?",
    )
    .bind(&held_id)
    .bind(&guild_id)
    .fetch_optional(&state.pool)
    .await?;
    let (channel_id, author_id, payload, current) =
        row.ok_or_else(|| ApiError::NotFound("no such held message".into()))?;
    if current != "pending" {
        return Err(ApiError::Conflict(
            "that message has already been decided".into(),
        ));
    }

    let approved = req.decision == "approve";
    sqlx::query("UPDATE held_messages SET state = ?, handled_by = ?, handled_at = ? WHERE id = ?")
        .bind(if approved { "approved" } else { "rejected" })
        .bind(&auth.user_id)
        .bind(now_ms())
        .bind(&held_id)
        .execute(&state.pool)
        .await?;
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "message.held",
        Some(&held_id),
        json!({ "decision": req.decision, "author": author_id }),
    )
    .await?;

    state
        .hub
        .publish(Event::new(
            "MESSAGE_HELD",
            guild_id.clone(),
            INTENT_GUILD_MESSAGES,
            json!({ "removed": &held_id, "channel_id": &channel_id }),
        ))
        .await;

    if !approved {
        return Ok(Json(json!({ "ok": true, "published": false })));
    }
    let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
    let message =
        crate::routes::messages::publish_held(&state, &guild_id, &channel_id, &author_id, &payload)
            .await?;
    Ok(Json(
        json!({ "ok": true, "published": true, "message": message }),
    ))
}

#[derive(Deserialize)]
pub struct GateConfig {
    #[serde(default)]
    pub min_account_age_days: Option<i64>,
    #[serde(default)]
    pub domain_policy: Option<String>,
    #[serde(default)]
    pub domains: Option<Vec<Value>>,
    #[serde(default)]
    pub screening: Option<Vec<String>>,
    #[serde(default)]
    pub hold_first_messages: Option<i64>,
    #[serde(default)]
    pub origin_policy: Option<String>,
    #[serde(default)]
    pub origins: Option<Vec<Value>>,
}

const POLICIES: [&str; 3] = ["open", "allowlist", "blocklist"];

fn origin_rule_key(entry: &Value) -> Option<(String, Option<String>, Option<String>)> {
    if let Some(feed) = entry["feed"]
        .as_str()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        let key = entry["key"]
            .as_str()
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        return Some((format!("feed:{feed}"), Some(feed.to_string()), Some(key)));
    }
    let domain = entry["domain"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    (!domain.is_empty()).then_some((domain, None, None))
}

pub async fn set_gates(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<GateConfig>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;

    if let Some(days) = req.min_account_age_days {
        sqlx::query("UPDATE guilds SET min_account_age_days = ? WHERE id = ?")
            .bind(days.clamp(0, 3650))
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(policy) = &req.domain_policy {
        if !POLICIES.contains(&policy.as_str()) {
            return Err(ApiError::BadRequest(
                "policy must be open, allowlist, or blocklist".into(),
            ));
        }
        sqlx::query("UPDATE guilds SET domain_policy = ? WHERE id = ?")
            .bind(policy)
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(domains) = &req.domains {
        sqlx::query("DELETE FROM guild_domain_rules WHERE guild_id = ?")
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
        for entry in domains {
            let domain = entry["domain"].as_str().unwrap_or_default().to_lowercase();
            if domain.is_empty() {
                continue;
            }
            sqlx::query(
                "INSERT INTO guild_domain_rules (guild_id, domain, action) VALUES (?, ?, ?) \
                 ON CONFLICT (guild_id, domain) DO UPDATE SET action = excluded.action",
            )
            .bind(&guild_id)
            .bind(&domain)
            .bind(entry["action"].as_str().unwrap_or("allow"))
            .execute(&state.pool)
            .await?;
        }
    }
    if let Some(policy) = &req.origin_policy {
        if !POLICIES.contains(&policy.as_str()) {
            return Err(ApiError::BadRequest(
                "origin policy must be open, allowlist, or blocklist".into(),
            ));
        }
        sqlx::query("UPDATE guilds SET origin_policy = ? WHERE id = ?")
            .bind(policy)
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(origins) = &req.origins {
        let rules: Vec<_> = origins.iter().filter_map(origin_rule_key).collect();
        let feeds = rules.iter().filter(|(_, feed, _)| feed.is_some()).count();
        if feeds > media_feeds::MAX_SUBSCRIPTIONS {
            return Err(ApiError::BadRequest(format!(
                "a guild can subscribe to at most {} media origin feeds",
                media_feeds::MAX_SUBSCRIPTIONS
            )));
        }
        for (_, feed, key) in &rules {
            if let (Some(feed), Some(key)) = (feed, key) {
                media_feeds::validate_subscription(&state, feed, key)?;
            }
        }
        sqlx::query("DELETE FROM guild_origin_rules WHERE guild_id = ?")
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
        for (entry, (key, feed, feed_key)) in origins
            .iter()
            .filter_map(|e| Some((e, origin_rule_key(e)?)))
        {
            let action = match entry["action"].as_str() {
                Some("block") => "block",
                _ => "allow",
            };
            sqlx::query(
                "INSERT INTO guild_origin_rules (guild_id, domain, action, feed_url, feed_key) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT (guild_id, domain) DO UPDATE SET \
                 action = excluded.action, feed_url = excluded.feed_url, feed_key = excluded.feed_key",
            )
            .bind(&guild_id)
            .bind(&key)
            .bind(action)
            .bind(&feed)
            .bind(&feed_key)
            .execute(&state.pool)
            .await?;
        }
    }
    if let Some(questions) = &req.screening {
        if questions.len() > 10 {
            return Err(ApiError::BadRequest(
                "at most ten screening questions".into(),
            ));
        }
        sqlx::query("UPDATE guilds SET screening = ? WHERE id = ?")
            .bind(serde_json::to_string(questions).unwrap_or_else(|_| "[]".into()))
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(hold) = req.hold_first_messages {
        sqlx::query("UPDATE guilds SET hold_first_messages = ? WHERE id = ?")
            .bind(hold.clamp(0, 100))
            .bind(&guild_id)
            .execute(&state.pool)
            .await?;
    }
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "guild.gates",
        Some(&guild_id),
        json!({}),
    )
    .await?;
    if req.origins.is_some() {
        if let Err(e) = media_feeds::refresh_guild(&state, &guild_id, false).await {
            tracing::warn!(target: crate::logcat::MODERATION, error = %e, "fetching newly subscribed media origin feeds failed");
        }
    }
    Ok(Json(gates_json(&state, &guild_id).await?))
}

pub async fn refresh_gate_feeds(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    media_feeds::refresh_guild(&state, &guild_id, true).await?;
    Ok(Json(gates_json(&state, &guild_id).await?))
}

pub async fn list_curators(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    Ok(Json(
        json!({ "curators": crate::federation::curators::listing(&state).await? }),
    ))
}

pub async fn get_gates(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::MANAGE_GUILD).await?;
    Ok(Json(gates_json(&state, &guild_id).await?))
}

pub async fn gates_json(state: &AppState, guild_id: &str) -> ApiResult<Value> {
    let row: Option<(i64, String, String, i64, String)> = sqlx::query_as(
        "SELECT min_account_age_days, domain_policy, screening, hold_first_messages, origin_policy \
         FROM guilds WHERE id = ?",
    )
    .bind(guild_id)
    .fetch_optional(&state.pool)
    .await?;
    let (age, policy, screening, hold, origin_policy) =
        row.ok_or_else(|| ApiError::NotFound("no such guild".into()))?;
    let domains: Vec<(String, String)> =
        sqlx::query_as("SELECT domain, action FROM guild_domain_rules WHERE guild_id = ?")
            .bind(guild_id)
            .fetch_all(&state.pool)
            .await?;
    let origins: Vec<(String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT domain, action, feed_url, feed_key FROM guild_origin_rules WHERE guild_id = ?",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;
    let mut statuses = media_feeds::statuses(state, guild_id).await?;
    Ok(json!({
        "min_account_age_days": age,
        "domain_policy": policy,
        "domains": domains.into_iter()
            .map(|(d, a)| json!({ "domain": d, "action": a })).collect::<Vec<_>>(),
        "screening": serde_json::from_str::<Value>(&screening).unwrap_or(json!([])),
        "hold_first_messages": hold,
        "origin_policy": origin_policy,
        "origins": origins.into_iter().map(|(domain, action, feed, key)| match (feed, key) {
            (Some(feed), Some(key)) => {
                let status = statuses.remove(&(feed.clone(), key.clone())).unwrap_or_else(|| {
                    json!({ "state": "pending", "hosts": 0 })
                });
                json!({ "action": action, "feed": feed, "key": key, "status": status })
            }
            (Some(feed), None) => json!({
                "action": action, "feed": feed, "status": media_feeds::unpinned_status(),
            }),
            (None, _) => json!({ "action": action, "domain": domain }),
        }).collect::<Vec<_>>(),
    }))
}

pub enum Gate {
    Allow,
    Screening(Value),
}

pub async fn check_gate(state: &AppState, guild_id: &str, auth: &GuildAuth) -> ApiResult<Gate> {
    let (min_age, policy, screening): (i64, String, String) = sqlx::query_as(
        "SELECT min_account_age_days, domain_policy, screening FROM guilds WHERE id = ?",
    )
    .bind(guild_id)
    .fetch_one(&state.pool)
    .await?;

    if policy != "open" {
        let rule: Option<String> = sqlx::query_scalar(
            "SELECT action FROM guild_domain_rules WHERE guild_id = ? AND domain = ?",
        )
        .bind(guild_id)
        .bind(auth.home_domain.to_lowercase())
        .fetch_optional(&state.pool)
        .await?;
        let allowed = match policy.as_str() {
            "allowlist" => rule.as_deref() == Some("allow"),
            _ => rule.as_deref() != Some("block"),
        };
        if !allowed {
            return Err(ApiError::Forbidden(format!(
                "this guild does not accept members from {}",
                auth.home_domain
            )));
        }
    }

    if min_age > 0 {
        let created = account_created_at(state, &auth.user_id).await?;
        let age_days = (now_ms() - created) / 86_400_000;
        if age_days < min_age {
            return Err(ApiError::Forbidden(format!(
                "this guild requires accounts at least {min_age} days old; yours is {age_days}"
            )));
        }
    }

    let questions: Vec<String> = serde_json::from_str(&screening).unwrap_or_default();
    if !questions.is_empty() {
        let answered: Option<String> = sqlx::query_scalar(
            "SELECT state FROM screening_answers WHERE guild_id = ? AND user_id = ?",
        )
        .bind(guild_id)
        .bind(&auth.user_id)
        .fetch_optional(&state.pool)
        .await?;
        match answered.as_deref() {
            Some("approved") => return Ok(Gate::Allow),
            Some("rejected") => {
                return Err(ApiError::Forbidden("your application was declined".into()))
            }
            _ => return Ok(Gate::Screening(json!(questions))),
        }
    }
    Ok(Gate::Allow)
}

async fn account_created_at(state: &AppState, user_id: &str) -> ApiResult<i64> {
    if let Some(original) = sqlx::query_scalar::<_, i64>(
        "SELECT original_created_at FROM imported_identities WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    {
        return Ok(original);
    }
    if crate::federation::is_local(state, user_id) {
        return sqlx::query_scalar("SELECT created_at FROM accounts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::NotFound("no such account".into()));
    }
    let domain = crate::federation::domain_of(user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?
        .to_string();
    let answer = crate::federation::get_signed(
        state,
        &domain,
        &format!("/_telium/v1/users/{user_id}/status"),
    )
    .await
    .map_err(|_| {
        ApiError::Forbidden(format!(
            "could not reach {domain} to check this account's age"
        ))
    })?;
    answer["created_at"].as_i64().ok_or_else(|| {
        ApiError::Forbidden(format!("{domain} would not vouch for this account's age"))
    })
}

#[derive(Deserialize)]
pub struct ScreeningAnswers {
    pub answers: Vec<String>,
}

pub async fn submit_screening(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<ScreeningAnswers>,
) -> ApiResult<Json<Value>> {
    let screening: String = sqlx::query_scalar("SELECT screening FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such guild".into()))?;
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    let questions: Vec<String> = serde_json::from_str(&screening).unwrap_or_default();
    if questions.is_empty() {
        return Err(ApiError::BadRequest(
            "this guild is not screening applicants".into(),
        ));
    }
    if req.answers.len() != questions.len() {
        return Err(ApiError::BadRequest("answer every question".into()));
    }
    if req.answers.iter().any(|a| a.chars().count() > 1000) {
        return Err(ApiError::BadRequest(
            "answers are limited to 1000 characters".into(),
        ));
    }
    let paired: Vec<Value> = questions
        .iter()
        .zip(&req.answers)
        .map(|(q, a)| json!({ "question": q, "answer": a }))
        .collect();
    // RETURNING: announce exactly what was written.
    let landed: Option<String> = sqlx::query_scalar(
        "INSERT INTO screening_answers (guild_id, user_id, answers, state, created_at) \
         VALUES (?, ?, ?, 'pending', ?) \
         ON CONFLICT(guild_id, user_id) DO UPDATE SET answers = excluded.answers, \
             state = CASE WHEN screening_answers.state = 'rejected' THEN 'rejected' ELSE 'pending' END \
         RETURNING state",
    )
    .bind(&guild_id)
    .bind(&auth.user_id)
    .bind(serde_json::to_string(&paired).unwrap_or_else(|_| "[]".into()))
    .bind(now_ms())
    .fetch_optional(&state.pool)
    .await?;
    let landed = landed.unwrap_or_else(|| "pending".into());
    if landed == "pending" {
        announce_queue(&state, &guild_id, json!({})).await;
    }
    Ok(Json(json!({ "state": landed })))
}

async fn announce_queue(state: &AppState, guild_id: &str, data: Value) {
    state
        .hub
        .publish(Event::new(
            "GUILD_APPLICANT",
            guild_id.to_string(),
            INTENT_GUILD_MEMBERS,
            data,
        ))
        .await;
}

pub async fn list_applicants(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    guildstore::require_guild_perm(&state, &guild_id, &auth.user_id, perms::KICK_MEMBERS).await?;
    let rows: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT user_id, answers, state, created_at FROM screening_answers \
         WHERE guild_id = ? AND state = 'pending' ORDER BY created_at LIMIT 200",
    )
    .bind(&guild_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(json!({
        "applicants": rows.into_iter().map(|(user, answers, state, at)| json!({
            "user_id": user, "state": state, "created_at": at,
            "answers": serde_json::from_str::<Value>(&answers).unwrap_or(json!([])),
        })).collect::<Vec<_>>()
    })))
}

#[derive(Deserialize)]
pub struct ApplicantDecision {
    pub decision: String,
}

pub async fn decide_applicant(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path((guild_id, user_id)): Path<(String, String)>,
    Json(req): Json<ApplicantDecision>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::KICK_MEMBERS).await?;
    let approved = req.decision == "approve";
    let done = sqlx::query(
        "UPDATE screening_answers SET state = ? WHERE guild_id = ? AND user_id = ? AND state = 'pending'",
    )
    .bind(if approved { "approved" } else { "rejected" })
    .bind(&guild_id)
    .bind(&user_id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound(
            "no pending application from that user".into(),
        ));
    }
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "screening.decide",
        Some(&user_id),
        json!({ "decision": req.decision }),
    )
    .await?;
    announce_queue(&state, &guild_id, json!({ "removed": true })).await;
    Ok(Json(
        json!({ "ok": true, "state": if approved { "approved" } else { "rejected" } }),
    ))
}

#[derive(Deserialize)]
pub struct PurgeRequest {
    pub user_id: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn purge_messages(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
    Json(req): Json<PurgeRequest>,
) -> ApiResult<Json<Value>> {
    require_perm_here(&state, &guild_id, &auth.user_id, perms::MANAGE_MESSAGES).await?;
    let limit = req.limit.unwrap_or(100).clamp(1, 1000);
    if let Some(channel_id) = &req.channel_id {
        let owner: Option<String> =
            sqlx::query_scalar("SELECT guild_id FROM channels WHERE id = ?")
                .bind(channel_id)
                .fetch_optional(&state.pool)
                .await?;
        if owner.as_deref() != Some(guild_id.as_str()) {
            return Err(ApiError::NotFound("channel not found in this guild".into()));
        }
    }
    let rows: Vec<(String, String)> = if let Some(channel_id) = &req.channel_id {
        sqlx::query_as(
            "SELECT id, channel_id FROM messages WHERE guild_id = ? AND channel_id = ?              AND author_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
        ).bind(&guild_id).bind(channel_id).bind(&req.user_id).bind(limit)
         .fetch_all(&state.pool).await?
    } else {
        sqlx::query_as(
            "SELECT id, channel_id FROM messages WHERE guild_id = ? AND author_id = ?              AND deleted = 0 ORDER BY id DESC LIMIT ?",
        ).bind(&guild_id).bind(&req.user_id).bind(limit)
         .fetch_all(&state.pool).await?
    };
    for (message_id, channel_id) in &rows {
        let mut tx = state.pool.begin().await?;
        crate::routes::media::release_message_refs(&mut *tx, "messages.id = ? AND messages.deleted = 0", message_id).await?;
        sqlx::query("UPDATE messages SET deleted = 1, content = '', attachments = '[]', sticker = NULL WHERE id = ?")
            .bind(message_id).execute(&mut *tx).await?;
        tx.commit().await?;
        crate::routes::social::unindex_message(&state, message_id).await?;
        sqlx::query("DELETE FROM pins WHERE message_id = ?")
            .bind(message_id)
            .execute(&state.pool)
            .await?;
        sqlx::query("DELETE FROM reactions WHERE message_id = ?")
            .bind(message_id)
            .execute(&state.pool)
            .await?;
        state
            .hub
            .publish(Event::in_channel(
                "MESSAGE_DELETE",
                guild_id.clone(),
                channel_id.clone(),
                INTENT_GUILD_MESSAGES,
                json!({ "id": message_id, "channel_id": channel_id }),
            ))
            .await;
    }
    guildstore::audit(
        &state.pool,
        &guild_id,
        &auth.user_id,
        "message.purge",
        Some(&req.user_id),
        json!({ "count": rows.len(), "channel_id": req.channel_id }),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "deleted": rows.len() })))
}
