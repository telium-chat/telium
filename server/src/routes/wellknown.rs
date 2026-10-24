
use crate::crypto;
use crate::error::ApiResult;
use crate::state::AppState;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use telium_protocol::compat;

pub fn protocol_version() -> String {
    format!("v{}", compat::PROTOCOL_VERSION)
}

pub async fn well_known(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    if let Some(old) = crate::relocation::previous_name_for_host(&state, &headers).await {
        if let Some(doc) = crate::relocation::previous_domain_document(&state, &old).await? {
            return Ok(Json(doc));
        }
    }

    let sunset: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'sunset'")
            .fetch_optional(&state.pool)
            .await?;
    let sunset: Option<Value> = sunset.and_then(|v| serde_json::from_str(&v).ok());
    let relocation = crate::relocation::announced(&state).await?;

    let fallback = state.cfg.failover.standbys.first().map(|standby| {
        json!({
            "standby": standby,
            "path": crate::replicate::mount_path(&state.cfg.server_name),
        })
    });

    let authority = crate::promotion::authority(&state).await?.map(|a| {
        json!({
            "domain": a.domain,
            "sequence": a.sequence,
            "path": crate::replicate::mount_path(&state.cfg.server_name),
            "record": a.record,
        })
    });

    let relay = if state.cfg.roles.relay {
        json!({
            "enabled": true,
            "url": format!("{}/_telium/v1/relay/v1", state.cfg.public_base_url.replace("http", "ws")),
            "max_tunnel_bytes": state.cfg.relay.max_tunnel_bytes,
            "max_concurrent": state.cfg.relay.max_concurrent_per_account,
            "daily_bytes": state.cfg.relay.daily_bytes_per_account,
            "logs_destinations": state.cfg.relay.log_destinations,
        })
    } else {
        Value::Null
    };

    let key_document = build_key_document(&state).await.ok();

    let local = compat::PeerCompat::local();

    let client = state
        .cfg
        .web
        .client_url
        .clone()
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        .map(|u| u.trim_end_matches('/').to_string())
        .or_else(|| state.cfg.web.dir.as_ref().map(|_| state.cfg.public_base_url.clone()));

    Ok(Json(json!({
        "server_name": state.cfg.server_name,
        "client": client,
        "api": state.cfg.public_base_url,
        "fallback": fallback,
        "authority": authority,
        "keys": key_document,
        "gateway": format!("{}/gateway/v1", state.cfg.public_base_url.replace("http", "ws")),
        "relay": relay,
        "protocol_version": protocol_version(),
        "protocol": {
            "version": local.version,
            "min_supported": local.min_supported,
            "capabilities": local.capabilities.iter().collect::<Vec<_>>(),
        },
        "moved_to": Value::Null,
        "sunset": sunset,
        "relocation": relocation,
        "onboarding": {
            "recommendations": {
                "accepting": state.cfg.registration.recommendations.accepting,
                "referral_weight": state.cfg.registration.recommendations.referral_weight,
                "suggest_alternatives": state.cfg.registration.recommendations.suggest_alternatives,
            }
        },
    })))
}

pub(crate) async fn build_key_document(state: &AppState) -> ApiResult<Value> {
    let delegated = state.signing_origin.as_str() != state.cfg.server_name;
    let mut verify_keys = serde_json::Map::new();

    let authority = crate::promotion::current_record(state).await?;
    if delegated {
        let record = authority.as_ref().ok_or_else(|| {
            crate::error::ApiError::Conflict(
                "this is a read-only replica, not the federation authority".into(),
            )
        })?;
        if state.demoted.load(std::sync::atomic::Ordering::Relaxed)
            || record.get("authority").and_then(Value::as_str)
                != Some(state.signing_origin.as_str())
        {
            return Err(crate::error::ApiError::Conflict(
                "this replica has been superseded by another authority".into(),
            ));
        }

        verify_keys.insert(
            state.key.key_id.clone(),
            json!({
                "key": state.key.public_b64(),
                "valid_from": state.key.valid_from,
                "valid_until": state.key.valid_until,
            }),
        );
    } else {
        for (key_id, public_b64, valid_from, valid_until) in
            crypto::historical_keys(&state.pool).await?
        {
            verify_keys.insert(
                key_id,
                json!({ "key": public_b64, "valid_from": valid_from, "valid_until": valid_until }),
            );
        }
    }

    let authority = if delegated {
        authority.unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let body = json!({
        "server_name": state.cfg.server_name,
        "signer": state.signing_origin.as_str(),
        "authority": authority,
        "current_key_id": state.key.key_id,
        "verify_keys": Value::Object(verify_keys),
        "generated_at": crate::util::now_ms(),
    });
    Ok(crypto::sign_json(&state.key, body))
}

pub async fn keys(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if let Some(old) = crate::relocation::previous_name_for_host(&state, &headers).await {
        if let Some(doc) = crate::relocation::previous_domain_document(&state, &old).await? {
            return Ok(Json(doc["keys"].clone()));
        }
    }
    Ok(Json(build_key_document(&state).await?))
}

pub async fn health(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let ok: i64 = sqlx::query_scalar("SELECT 1").fetch_one(&state.pool).await?;
    let authority = crate::promotion::authority(&state)
        .await?
        .map(|a| a.domain)
        .unwrap_or_else(|| state.cfg.server_name.clone());
    Ok(Json(json!({
        "ok": ok == 1,
        "server_name": state.cfg.server_name,
        "authority": authority,
    })))
}
