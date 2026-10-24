
use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{now_ms, ulid};
use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

pub use crate::admin::require_admin;

#[derive(Deserialize)]
pub struct ReportRequest {
    pub destination: String,
    pub target_type: String,
    pub target_id: String,
    pub category: String,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub evidence: Value,
}

pub async fn submit_report(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<ReportRequest>,
) -> ApiResult<Json<Value>> {
    if !["message", "media", "account", "guild"].contains(&req.target_type.as_str()) {
        return Err(ApiError::BadRequest(
            "target_type must be message, media, account or guild".into(),
        ));
    }
    let id = ulid();
    let evidence = if req.evidence.is_null() {
        json!([])
    } else {
        req.evidence.clone()
    };
    let payload = json!({
        "report_id": id,
        "reporter": auth.user_id,
        "target_type": req.target_type,
        "target_id": req.target_id,
        "category": req.category,
        "detail": req.detail,
        "evidence": evidence,
    });

    sqlx::query(
        "INSERT INTO reports (id, direction, origin, destination, reporter, target_type, target_id, \
         category, detail, evidence, status, created_at) \
         VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?)",
    )
    .bind(&id)
    .bind(&state.cfg.server_name)
    .bind(&req.destination)
    .bind(&auth.user_id)
    .bind(&req.target_type)
    .bind(&req.target_id)
    .bind(&req.category)
    .bind(&req.detail)
    .bind(evidence.to_string())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    if req.destination == state.cfg.server_name {
        store_inbound(&state, &state.cfg.server_name.clone(), &payload).await?;
        return Ok(Json(
            json!({ "ok": true, "report_id": id, "delivered": true }),
        ));
    }

    match super::post_signed(&state, &req.destination, "/_telium/v1/report", &payload).await {
        Ok(_) => Ok(Json(
            json!({ "ok": true, "report_id": id, "delivered": true }),
        )),
        Err(e) => {
            sqlx::query("UPDATE reports SET status = 'undeliverable' WHERE id = ?")
                .bind(&id)
                .execute(&state.pool)
                .await?;
            Ok(Json(json!({
                "ok": false, "report_id": id, "delivered": false, "error": e.to_string()
            })))
        }
    }
}

pub async fn emoji_entitlement(
    State(state): State<AppState>,
    fed: super::Fed<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        crate::emoji::inbound_entitlement(&state, &fed.body).await?,
    ))
}

pub async fn inbound_report(
    State(state): State<AppState>,
    fed: super::Fed<Value>,
) -> ApiResult<Json<Value>> {
    store_inbound(&state, &fed.origin, &fed.body).await?;
    Ok(Json(json!({
        "ok": true,
        "abuse_contact": state.cfg.moderation.abuse_contact,
    })))
}

async fn store_inbound(state: &AppState, origin: &str, body: &Value) -> ApiResult<()> {
    let s = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_string);
    let target_type = s("target_type")
        .ok_or_else(|| ApiError::BadRequest("report names no target_type".into()))?;
    let target_id =
        s("target_id").ok_or_else(|| ApiError::BadRequest("report names no target".into()))?;
    sqlx::query(
        "INSERT INTO reports (id, direction, origin, destination, reporter, target_type, target_id, \
         category, detail, evidence, status, created_at) \
         VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
    )
    .bind(ulid())
    .bind(origin)
    .bind(&state.cfg.server_name)
    .bind(s("reporter"))
    .bind(&target_type)
    .bind(&target_id)
    .bind(s("category").unwrap_or_else(|| "other".into()))
    .bind(s("detail"))
    .bind(body.get("evidence").cloned().unwrap_or_else(|| json!([])).to_string())
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(())
}

pub async fn record_scan_hit(
    state: &AppState,
    uploader: &str,
    hash: &str,
    list: &str,
) -> ApiResult<()> {
    store_inbound(
        state,
        &state.cfg.server_name.clone(),
        &json!({
            "reporter": state.cfg.server_name,
            "target_type": "media",
            "target_id": hash,
            "category": "hash_list_match",
            "detail": format!("upload refused: matched hash list {list}"),
            "evidence": [{ "uploader": uploader, "list": list, "blake3": hash }],
        }),
    )
    .await
}

#[derive(Deserialize)]
pub struct ReportQuery {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn list_reports(
    State(state): State<AppState>,
    auth: HomeAuth,
    Query(q): Query<ReportQuery>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    type Row = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
        Option<String>,
        Option<i64>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, direction, origin, reporter, target_type, target_id, category, detail, \
         evidence, status, created_at, handled_by, handled_at, resolution_note FROM reports \
         WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?",
    )
    .bind(&q.status)
    .bind(&q.status)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    let reports: Vec<Value> = rows
        .into_iter()
        .map(
            |(
                id,
                direction,
                origin,
                reporter,
                tt,
                tid,
                category,
                detail,
                evidence,
                status,
                created_at,
                handled_by,
                handled_at,
                note,
            )| {
                json!({
                    "id": id, "direction": direction, "origin": origin, "reporter": reporter,
                    "target_type": tt, "target_id": tid, "category": category, "detail": detail,
                    "evidence": serde_json::from_str::<Value>(&evidence).unwrap_or(json!([])),
                    "status": status, "created_at": created_at,
                    "handled_by": handled_by,
                    "handled_at": handled_at,
                    "resolution_note": note,
                })
            },
        )
        .collect();
    Ok(Json(json!({ "reports": reports })))
}

#[derive(Deserialize)]
pub struct ResolveReport {
    pub status: String,
    #[serde(default)]
    pub note: Option<String>,
}

const MAX_RESOLUTION_NOTE: usize = 2000;

pub async fn resolve_report(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<ResolveReport>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    if !["open", "actioned", "rejected", "duplicate"].contains(&req.status.as_str()) {
        return Err(ApiError::BadRequest(
            "status must be open, actioned, rejected or duplicate".into(),
        ));
    }
    let note = req
        .note
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    if note
        .as_ref()
        .is_some_and(|n| n.chars().count() > MAX_RESOLUTION_NOTE)
    {
        return Err(ApiError::BadRequest("resolution note is too long".into()));
    }
    let reopening = req.status == "open";
    let done = sqlx::query(
        "UPDATE reports SET status = ?, handled_by = ?, handled_at = ?, resolution_note = ? \
         WHERE id = ?",
    )
    .bind(&req.status)
    .bind(if reopening { None } else { Some(&auth.user_id) })
    .bind(if reopening { None } else { Some(now_ms()) })
    .bind(if reopening { None } else { note.as_ref() })
    .bind(&id)
    .execute(&state.pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError::NotFound("no such report".into()));
    }
    crate::admin::record(
        &state,
        &auth.user_id,
        "report.resolve",
        Some(&id),
        json!({ "status": req.status, "note": note }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct DefederateRequest {
    pub domain: String,
    #[serde(default = "all_scope")]
    pub scope: String,
    #[serde(default)]
    pub reason: Option<String>,
}

fn all_scope() -> String {
    "all".into()
}

pub async fn defederate(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<DefederateRequest>,
) -> ApiResult<Json<Value>> {
    // Step-up: silently dropping other people's traffic is not a storage-sweep-grade operation.
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    if !["all", "identity", "dm", "media"].contains(&req.scope.as_str()) {
        return Err(ApiError::BadRequest(
            "scope must be all, identity, dm or media".into(),
        ));
    }
    if req.domain == state.cfg.server_name {
        return Err(ApiError::BadRequest(
            "a server cannot defederate from itself".into(),
        ));
    }
    sqlx::query(
        "INSERT INTO defederation (domain, scope, reason, source, created_at) \
         VALUES (?, ?, ?, 'local', ?) \
         ON CONFLICT(domain) DO UPDATE SET scope = excluded.scope, reason = excluded.reason",
    )
    .bind(req.domain.to_ascii_lowercase())
    .bind(&req.scope)
    .bind(&req.reason)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    // Block the whole applied relocation chain, or announcing a move walks around it.
    crate::relocation::spread_defederation(&state, &req.domain.to_ascii_lowercase()).await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "federation.defederate",
        Some(&req.domain),
        json!({ "scope": req.scope, "reason": req.reason }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn list_defederation(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let rows: Vec<(String, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT domain, scope, reason, source, created_at FROM defederation ORDER BY domain",
    )
    .fetch_all(&state.pool)
    .await?;
    let blocks: Vec<Value> = rows
        .into_iter()
        .map(|(domain, scope, reason, source, created_at)| {
            json!({ "domain": domain, "scope": scope, "reason": reason,
                    "source": source, "created_at": created_at })
        })
        .collect();
    Ok(Json(json!({ "defederation": blocks })))
}

pub async fn refederate(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(domain): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let domain = domain.to_ascii_lowercase();
    sqlx::query("DELETE FROM defederation WHERE domain = ?")
        .bind(&domain)
        .execute(&state.pool)
        .await?;
    crate::admin::record(&state, &auth.user_id, "federation.refederate", Some(&domain), json!({}))
        .await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct FeedRequest {
    pub url: String,
    #[serde(default)]
    pub public_b64: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

pub async fn add_feed(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<FeedRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    sqlx::query(
        "INSERT INTO blocklist_feeds (url, public_b64, label, enabled) VALUES (?, ?, ?, 1) \
         ON CONFLICT(url) DO UPDATE SET public_b64 = excluded.public_b64, label = excluded.label",
    )
    .bind(&req.url)
    .bind(&req.public_b64)
    .bind(&req.label)
    .execute(&state.pool)
    .await?;
    let applied = refresh_feed(&state, &req.url).await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "blocklist.feed.add",
        Some(&req.url),
        json!({ "label": req.label, "public_b64": req.public_b64, "entries": applied }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "entries": applied })))
}

pub async fn list_feeds(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let rows: Vec<(String, Option<String>, Option<i64>, i64, i64)> = sqlx::query_as(
        "SELECT url, label, fetched_at, entries, enabled FROM blocklist_feeds ORDER BY url",
    )
    .fetch_all(&state.pool)
    .await?;
    let feeds: Vec<Value> = rows
        .into_iter()
        .map(|(url, label, fetched_at, entries, enabled)| {
            json!({ "url": url, "label": label, "fetched_at": fetched_at,
                    "entries": entries, "enabled": enabled == 1 })
        })
        .collect();
    Ok(Json(json!({ "feeds": feeds })))
}

pub async fn remove_feed(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(req): Json<FeedRequest>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    sqlx::query("DELETE FROM blocklist_feeds WHERE url = ?")
        .bind(&req.url)
        .execute(&state.pool)
        .await?;
    let unblocked = sqlx::query("DELETE FROM defederation WHERE source = ?")
        .bind(&req.url)
        .execute(&state.pool)
        .await?
        .rows_affected();
    crate::admin::record(
        &state,
        &auth.user_id,
        "blocklist.feed.remove",
        Some(&req.url),
        json!({ "domains_unblocked": unblocked }),
    )
    .await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn refresh_feeds(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let urls: Vec<String> = sqlx::query_scalar("SELECT url FROM blocklist_feeds WHERE enabled = 1")
        .fetch_all(&state.pool)
        .await?;
    let mut total = 0i64;
    let mut errors = Vec::new();
    for url in urls {
        match refresh_feed(&state, &url).await {
            Ok(n) => total += n,
            Err(e) => errors.push(json!({ "url": url, "error": e.to_string() })),
        }
    }
    crate::admin::record(
        &state,
        &auth.user_id,
        "blocklist.feed.refresh",
        None,
        json!({ "entries": total, "errors": errors.len() }),
    )
    .await;
    Ok(Json(
        json!({ "ok": errors.is_empty(), "entries": total, "errors": errors }),
    ))
}

#[derive(Deserialize, Default)]
pub struct RotateCuratorKey {
    pub overlap_secs: Option<i64>,
}

pub async fn rotate_curator_key(
    State(state): State<AppState>,
    auth: HomeAuth,
    body: Option<Json<RotateCuratorKey>>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let overlap = body
        .and_then(|Json(b)| b.overlap_secs)
        .unwrap_or(7 * 24 * 60 * 60);
    let result = super::media_feeds::rotate(&state, overlap).await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "curator.key.rotate",
        None,
        json!({ "overlap_secs": overlap }),
    )
    .await;
    Ok(Json(result))
}

const BLOCKLIST_MAX_BYTES: usize = 4 * 1024 * 1024;

pub async fn refresh_feed(state: &AppState, url: &str) -> ApiResult<i64> {
    let public: Option<String> =
        sqlx::query_scalar("SELECT public_b64 FROM blocklist_feeds WHERE url = ?")
            .bind(url)
            .fetch_optional(&state.pool)
            .await?
            .flatten();

    let timeout = std::time::Duration::from_secs(state.cfg.federation.request_timeout_secs.max(1));
    let body = super::feeds::fetch(state, url, BLOCKLIST_MAX_BYTES, timeout).await?;
    let doc: Value = serde_json::from_slice(&body)
        .map_err(|e| ApiError::BadRequest(format!("feed is not JSON: {e}")))?;

    if let Some(public) = &public {
        if !crate::crypto::verify_json(public, &doc) {
            return Err(ApiError::Forbidden("feed signature does not verify".into()));
        }
    }

    let entries = doc
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    sqlx::query("DELETE FROM defederation WHERE source = ?")
        .bind(url)
        .execute(&state.pool)
        .await?;

    // Carry blocks along relocation chains, or a listed domain escapes by renaming.
    let relocated: Vec<String> = sqlx::query_scalar(
        "SELECT old_domain FROM domain_relocations WHERE state = 'applied'          UNION SELECT new_domain FROM domain_relocations WHERE state = 'applied'",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut spread = Vec::new();
    let mut count = 0i64;
    for entry in &entries {
        let Some(domain) = entry.get("domain").and_then(Value::as_str) else {
            continue;
        };
        if domain == state.cfg.server_name {
            continue;
        }
        let scope = entry.get("scope").and_then(Value::as_str).unwrap_or("all");
        let reason = entry.get("reason").and_then(Value::as_str);
        let done = sqlx::query(
            "INSERT INTO defederation (domain, scope, reason, source, created_at) \
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(domain) DO NOTHING",
        )
        .bind(domain.to_ascii_lowercase())
        .bind(scope)
        .bind(reason)
        .bind(url)
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
        if done.rows_affected() > 0 {
            let lowered = domain.to_ascii_lowercase();
            if relocated.contains(&lowered) {
                spread.push(lowered);
            }
        }
        count += done.rows_affected() as i64;
    }
    for domain in spread {
        crate::relocation::spread_defederation(&state, &domain).await?;
    }

    sqlx::query("UPDATE blocklist_feeds SET fetched_at = ?, entries = ? WHERE url = ?")
        .bind(now_ms())
        .bind(entries.len() as i64)
        .bind(url)
        .execute(&state.pool)
        .await?;
    Ok(count)
}

fn local_protocol_json() -> Value {
    let local = telium_protocol::compat::PeerCompat::local();
    json!({
        "version": local.version,
        "min_supported": local.min_supported,
        "capabilities": local.capabilities.iter().collect::<Vec<_>>(),
    })
}

fn peer_protocol_json(
    version: Option<i64>,
    min_supported: Option<i64>,
    capabilities: Option<&str>,
    status: Option<&str>,
    checked_at: Option<i64>,
    now: i64,
) -> Value {
    use telium_protocol::compat::{self, PeerCompat};

    let Some(version) = version else {
        return json!({
            "status": "unknown",
            "version": Value::Null,
            "min_supported": Value::Null,
            "capabilities": Vec::<String>::new(),
            "message": "this server has not yet observed what protocol version this peer speaks",
            "remedy": Value::Null,
            "recorded_age_ms": Value::Null,
        });
    };

    let peer = PeerCompat::from_wire(
        Some(&version.to_string()),
        min_supported.map(|m| m.to_string()).as_deref(),
        capabilities,
    );
    let negotiated = compat::negotiate(&PeerCompat::local(), &peer);
    let (message, remedy) = match &negotiated {
        Ok(agreed) => (
            format!("speaking Telium protocol v{}", agreed.version),
            Value::Null,
        ),
        Err(why) => (why.to_string(), json!(why.remedy())),
    };
    json!({
        "status": status.map(str::to_string).unwrap_or_else(|| match &negotiated {
            Ok(_) => "ok".to_string(),
            Err(why) => why.code().to_string(),
        }),
        "version": peer.version,
        "min_supported": peer.min_supported,
        "capabilities": peer.capabilities.iter().collect::<Vec<_>>(),
        "message": message,
        "remedy": remedy,
        "recorded_age_ms": checked_at.map(|at| (now - at).max(0)),
    })
}

pub async fn peer_status(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(origin): Path<String>,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let peer = super::discover(&state, &origin).await?;
    let keys: Vec<(String, i64, i64)> =
        sqlx::query_as("SELECT key_id, valid_from, valid_until FROM remote_keys WHERE origin = ?")
            .bind(&peer.origin)
            .fetch_all(&state.pool)
            .await?;
    let failures: i64 = sqlx::query_scalar("SELECT failures FROM remote_servers WHERE origin = ?")
        .bind(&peer.origin)
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(0);
    let compat: Option<(Option<i64>, Option<i64>, Option<String>, Option<String>, Option<i64>)> =
        sqlx::query_as(
            "SELECT protocol_version, protocol_min_supported, capabilities, compat_status, \
                    compat_checked_at FROM remote_servers WHERE origin = ?",
        )
        .bind(&peer.origin)
        .fetch_optional(&state.pool)
        .await?;
    let (version, min_supported, capabilities, status, checked_at) =
        compat.unwrap_or((None, None, None, None, None));
    let health = super::get_signed(&state, &peer.origin, "/_telium/v1/health")
        .await
        .ok();
    Ok(Json(json!({
        "origin": peer.origin,
        "api_base": peer.api_base,
        "gateway": peer.gateway,
        "moved_to": peer.moved_to,
        "failures": failures,
        "keys": keys.into_iter().map(|(key_id, from, until)| json!({
            "key_id": key_id, "valid_from": from, "valid_until": until
        })).collect::<Vec<_>>(),
        "reachable": health.is_some(),
        "protocol": peer_protocol_json(
            version,
            min_supported,
            capabilities.as_deref(),
            status.as_deref(),
            checked_at,
            now_ms(),
        ),
        "local_protocol": local_protocol_json(),
    })))
}

pub async fn revalidate_now(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    sqlx::query("UPDATE guild_sessions SET revalidate_at = 0")
        .execute(&state.pool)
        .await?;
    let dropped = super::revalidate_sessions(&state).await?;
    // No step-up: worst case is sessions re-checked early.
    crate::admin::record(
        &state,
        &auth.user_id,
        "federation.revalidate",
        None,
        json!({ "sessions_dropped": dropped }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "sessions_dropped": dropped })))
}

pub async fn admin_status(State(state): State<AppState>, auth: HomeAuth) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let open_reports: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM reports WHERE status = 'open'")
            .fetch_one(&state.pool)
            .await?;
    let defederated: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM defederation")
        .fetch_one(&state.pool)
        .await?;
    let feeds: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM blocklist_feeds WHERE enabled = 1")
        .fetch_one(&state.pool)
        .await?;
    let build = crate::updates::build();
    let incompatible_peers: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM remote_servers WHERE compat_status IS NOT NULL \
         AND compat_status != 'ok'",
    )
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "server_name": state.cfg.server_name,
        "open_reports": open_reports,
        "defederated": defederated,
        "blocklist_feeds": feeds,
        "backup": crate::backup::report(&state.cfg),
        "version": build.version,
        "commit": if build.commit.is_empty() { Value::Null } else { json!(build.commit) },
        "protocol_version": crate::routes::wellknown::protocol_version(),
        "uptime_ms": (crate::util::now_ms() - state.metrics.started_at()).max(0),
        "roles": {
            "identity": state.cfg.roles.identity,
            "guild": state.cfg.roles.guild,
            "media": state.cfg.roles.media,
        },
        "registration_open": crate::sunset::registration_open(&state).await,
        "read_only": state.demoted.load(std::sync::atomic::Ordering::Relaxed),
        "shut_down": state.shut_down.load(std::sync::atomic::Ordering::Relaxed),
        "protocol": local_protocol_json(),
        "incompatible_peers": incompatible_peers,
    })))
}

pub async fn moderation_summary(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let now = now_ms();

    let by_status: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, COUNT(*) FROM reports GROUP BY status")
            .fetch_all(&state.pool)
            .await?;
    let counts: serde_json::Map<String, Value> = by_status
        .into_iter()
        .map(|(status, n)| (status, Value::from(n)))
        .collect();

    let by_direction: Vec<(String, i64)> = sqlx::query_as(
        "SELECT direction, COUNT(*) FROM reports WHERE status = 'open' GROUP BY direction",
    )
    .fetch_all(&state.pool)
    .await?;

    let by_category: Vec<(String, i64)> = sqlx::query_as(
        "SELECT category, COUNT(*) FROM reports WHERE status = 'open' \
         GROUP BY category ORDER BY COUNT(*) DESC LIMIT 12",
    )
    .fetch_all(&state.pool)
    .await?;

    let oldest_open: Option<i64> =
        sqlx::query_scalar("SELECT MIN(created_at) FROM reports WHERE status = 'open'")
            .fetch_one(&state.pool)
            .await?;

    let mut durations: Vec<i64> = sqlx::query_scalar(
        "SELECT handled_at - created_at FROM reports \
         WHERE status != 'open' AND handled_at IS NOT NULL \
         ORDER BY handled_at DESC LIMIT 200",
    )
    .fetch_all(&state.pool)
    .await?;
    durations.retain(|d| *d >= 0);
    durations.sort_unstable();
    let quantile = |q: f64| -> Option<i64> {
        if durations.len() < 5 {
            return None;
        }
        let rank = ((durations.len() as f64 * q).ceil() as usize).clamp(1, durations.len());
        Some(durations[rank - 1])
    };

    Ok(Json(json!({
        "counts": counts,
        "open_by_direction": by_direction.into_iter()
            .map(|(d, n)| json!({ "direction": d, "count": n })).collect::<Vec<_>>(),
        "open_by_category": by_category.into_iter()
            .map(|(c, n)| json!({ "category": c, "count": n })).collect::<Vec<_>>(),
        "oldest_open_ms": oldest_open.map(|at| (now - at).max(0)),
        "resolution": {
            "samples": durations.len(),
            "p50_ms": quantile(0.50),
            "p90_ms": quantile(0.90),
        },
    })))
}

pub async fn peers_overview(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    require_admin(&state, &auth.user_id).await?;
    let now = now_ms();

    let peers: Vec<(
        String,
        String,
        i64,
        i64,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT origin, api_base, fetched_at, failures, moved_to, protocol_version, \
                protocol_min_supported, capabilities, compat_status, compat_checked_at \
         FROM remote_servers \
         ORDER BY (compat_status IS NOT NULL AND compat_status != 'ok') DESC, \
                  failures DESC, origin LIMIT 500",
    )
    .fetch_all(&state.pool)
    .await?;

    let backlog: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT destination, COUNT(*), MIN(created_at) FROM (\
            SELECT destination, created_at FROM dm_outbox \
            UNION ALL SELECT destination, created_at FROM friend_outbox\
         ) GROUP BY destination",
    )
    .fetch_all(&state.pool)
    .await?;
    let backlog: std::collections::HashMap<String, (i64, i64)> = backlog
        .into_iter()
        .map(|(d, n, oldest)| (d, (n, oldest)))
        .collect();

    let blocked: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT domain, scope, reason, source FROM defederation ORDER BY domain LIMIT 1000",
    )
    .fetch_all(&state.pool)
    .await?;
    let blocked_domains: std::collections::HashSet<String> =
        blocked.iter().map(|(d, _, _, _)| d.clone()).collect();

    let incompatible: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM remote_servers WHERE compat_status IS NOT NULL \
         AND compat_status != 'ok'",
    )
    .fetch_one(&state.pool)
    .await?;

    let rows: Vec<Value> = peers
        .into_iter()
        .map(|(
            origin,
            api_base,
            fetched_at,
            failures,
            moved_to,
            protocol_version,
            protocol_min,
            capabilities,
            compat_status,
            compat_checked_at,
        )| {
            let queued = backlog.get(&origin);
            json!({
                "origin": origin,
                "api_base": api_base,
                "discovered_age_ms": (now - fetched_at).max(0),
                "failures": failures,
                "moved_to": moved_to,
                "defederated": blocked_domains.contains(&origin),
                "protocol": peer_protocol_json(
                    protocol_version,
                    protocol_min,
                    capabilities.as_deref(),
                    compat_status.as_deref(),
                    compat_checked_at,
                    now,
                ),
                "queued": queued.map(|(n, _)| *n),
                "queued_oldest_ms": queued.map(|(_, oldest)| (now - oldest).max(0)),
            })
        })
        .collect();

    Ok(Json(json!({
        "local": local_protocol_json(),
        "incompatible": incompatible,
        "peers": rows,
        "defederated": blocked.into_iter().map(|(domain, scope, reason, source)| json!({
            "domain": domain, "scope": scope, "reason": reason, "source": source,
        })).collect::<Vec<_>>(),
    })))
}
