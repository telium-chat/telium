
use crate::error::{ApiError, ApiResult};
use crate::replicate::Replica;
use crate::state::AppState;
use crate::util::now_ms;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

pub const SUBJECT: &str = "server";

const MAX_FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

fn not_from_the_future(at: i64, what: &str) -> ApiResult<()> {
    if at > now_ms() + MAX_FUTURE_SKEW_MS {
        return Err(ApiError::Forbidden(format!("{what} is dated in the future")));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Authority {
    pub domain: String,
    pub sequence: i64,
    pub record: Value,
}

pub async fn authorise(
    state: &AppState,
    subject_type: &str,
    subject_id: &str,
    standby: &str,
) -> ApiResult<Value> {
    let previous_authority = current_record(state).await?.unwrap_or(Value::Null);
    let base_sequence = previous_authority
        .get("sequence")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let authorization = crate::crypto::sign_json(
        &state.key,
        serde_json::json!({
            "kind": "failover_authorization",
            "subject_type": subject_type,
            "subject_id": subject_id,
            "primary": state.cfg.server_name,
            "standby": standby,
            "signer": state.signing_origin.as_str(),
            "previous_authority": previous_authority,
            "created_at": now_ms(),
        }),
    );
    sqlx::query(
        "INSERT INTO failover (subject_type, subject_id, standby, authorization, sequence, promoted, record, updated_at) \
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?) \
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET standby = excluded.standby, \
             authorization = excluded.authorization, sequence = excluded.sequence, promoted = 0, \
             record = NULL, updated_at = excluded.updated_at",
    )
    .bind(subject_type)
    .bind(subject_id)
    .bind(standby)
    .bind(authorization.to_string())
    .bind(base_sequence)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;
    Ok(authorization)
}

pub async fn promote(host: &AppState, replica: &Replica) -> ApiResult<Value> {
    let origin = replica.origin.as_str();
    let row: Option<(i64, i64, Option<String>)> =
        sqlx::query_as("SELECT promoted, sequence, record FROM replica_state WHERE origin = ?")
            .bind(origin)
            .fetch_optional(&host.pool)
            .await?;
    let (promoted, sequence, existing) =
        row.ok_or_else(|| ApiError::NotFound(format!("this server holds no copy of {origin}")))?;
    if promoted != 0 {
        if let Some(record) = existing.as_deref().and_then(|r| serde_json::from_str(r).ok()) {
            return Ok(record);
        }
    }

    match crate::replicate::sync_once(host, replica).await {
        Ok(n) => tracing::info!(target: crate::logcat::STANDBY, origin, applied = n, "caught up before promoting"),
        Err(e) => tracing::warn!(target: crate::logcat::STANDBY, origin, error = %e, "promoting without a final catch-up"),
    }

    let (authorization, authorised_after) = authorization(host, replica).await?;
    let previous: i64 =
        sqlx::query_scalar("SELECT sequence FROM failover WHERE subject_type = ? AND subject_id = ?")
            .bind(SUBJECT)
            .bind(origin)
            .fetch_optional(&replica.state.pool)
            .await?
            .unwrap_or(0);
    let next = sequence.max(previous).max(authorised_after) + 1;

    let record = crate::crypto::sign_json(
        &host.key,
        json!({
            "kind": "failover_promotion",
            "subject_type": SUBJECT,
            "subject_id": origin,
            "authority": host.cfg.server_name,
            "signer": host.cfg.server_name,
            "primary": origin,
            "sequence": next,
            "authorization": authorization,
            "promoted_at": now_ms(),
        }),
    );

    crate::replicate::install_triggers(&replica.state.pool).await?;

    let claimed = sqlx::query(
        "UPDATE replica_state SET promoted = 1, sequence = ?, record = ?, promoted_at = ? \
         WHERE origin = ? AND promoted = 0",
    )
    .bind(next)
    .bind(record.to_string())
    .bind(now_ms())
    .bind(origin)
    .execute(&host.pool)
    .await?;
    let record = if claimed.rows_affected() == 0 {
        let published: Option<String> =
            sqlx::query_scalar("SELECT record FROM replica_state WHERE origin = ?")
                .bind(origin)
                .fetch_optional(&host.pool)
                .await?
                .flatten();
        let parsed = published.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok());
        parsed.ok_or_else(|| {
            ApiError::Conflict(format!(
                "{origin} was promoted concurrently by another process and the record it wrote \
                 cannot be read back; check replica_state before promoting again"
            ))
        })?
    } else {
        record
    };

    *replica.state.authority_record.write().await = Some(record.clone());
    crate::replicate::activate(replica);

    tracing::warn!(
        target: crate::logcat::STANDBY,
        origin,
        sequence = next,
        authority = %host.cfg.server_name,
        "promoted: this server is now the authority for {origin}",
    );
    Ok(record)
}

async fn authorization(host: &AppState, replica: &Replica) -> ApiResult<(Value, i64)> {
    let origin = replica.origin.as_str();
    let stored: Option<String> = sqlx::query_scalar(
        "SELECT authorization FROM failover WHERE subject_type = ? AND subject_id = ?",
    )
    .bind(SUBJECT)
    .bind(origin)
    .fetch_optional(&replica.state.pool)
    .await?;
    let stored = stored.ok_or_else(|| {
        ApiError::Conflict(format!(
            "{origin} never authorised this server to take over for it -- \
             pairing has to be done before the authority being replaced disappears"
        ))
    })?;
    let value: Value = serde_json::from_str(&stored)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("unreadable authorisation: {e}")))?;
    let previous = verify_authorization(host, &value, origin, &host.cfg.server_name).await?;
    Ok((value, previous))
}

pub async fn verify_authorization(
    state: &AppState,
    value: &Value,
    primary: &str,
    standby: &str,
) -> ApiResult<i64> {
    if value["kind"].as_str() != Some("failover_authorization")
        || value["primary"].as_str() != Some(primary)
        || value["standby"].as_str() != Some(standby)
        || value["subject_type"].as_str() != Some(SUBJECT)
        || value["subject_id"].as_str() != Some(primary)
    {
        return Err(ApiError::Forbidden(
            "failover authorisation was written for a different pair".into(),
        ));
    }

    let signer = value["signer"].as_str().unwrap_or(primary);
    let key_id = value["key_id"].as_str().unwrap_or_default();
    let created_at = value["created_at"]
        .as_i64()
        .ok_or_else(|| ApiError::BadRequest("failover authorisation has no timestamp".into()))?;
    not_from_the_future(created_at, "failover authorisation")?;
    if !signed_by_at(state, signer, key_id, value, created_at).await {
        return Err(ApiError::Forbidden(format!(
            "{signer}'s failover authorisation does not verify"
        )));
    }
    if signer == primary {
        return Ok(0);
    }

    let previous = value
        .get("previous_authority")
        .filter(|v| !v.is_null())
        .ok_or_else(|| ApiError::Forbidden(format!(
            "{signer} cannot authorise a standby for {primary} without proving it already has authority"
        )))?;
    let authority = Box::pin(verify(state, previous, primary)).await?;
    if authority.domain != signer {
        return Err(ApiError::Forbidden(format!(
            "{signer} tried to delegate {primary}, but the previous promotion names {}",
            authority.domain
        )));
    }
    Ok(authority.sequence)
}

pub async fn current_record(state: &AppState) -> ApiResult<Option<Value>> {
    if let Some(host_pool) = &state.replica_host_pool {
        let stored: Option<Option<String>> =
            sqlx::query_scalar("SELECT record FROM replica_state WHERE origin = ?")
                .bind(&state.cfg.server_name)
                .fetch_optional(host_pool)
                .await?;
        if let Some(record) = stored.flatten().and_then(|r| serde_json::from_str::<Value>(&r).ok()) {
            *state.authority_record.write().await = Some(record.clone());
            return Ok(Some(record));
        }
    }
    Ok(state.authority_record.read().await.clone())
}

pub async fn published(host: &AppState, origin: &str) -> ApiResult<Option<Value>> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT record FROM replica_state WHERE origin = ?")
            .bind(origin)
            .fetch_optional(&host.pool)
            .await?;
    Ok(stored.flatten().and_then(|r| serde_json::from_str(&r).ok()))
}

pub async fn verify(state: &AppState, record: &Value, primary: &str) -> ApiResult<Authority> {
    if record["kind"].as_str() != Some("failover_promotion")
        || record["subject_type"].as_str() != Some(SUBJECT)
        || record["subject_id"].as_str() != Some(primary)
    {
        return Err(ApiError::BadRequest("not a promotion record for this server".into()));
    }
    let authority = record["authority"]
        .as_str()
        .filter(|a| !a.is_empty() && *a != primary)
        .ok_or_else(|| ApiError::BadRequest("a promotion has to name somebody".into()))?
        .to_string();
    let sequence = record["sequence"]
        .as_i64()
        .filter(|s| *s > 0)
        .ok_or_else(|| ApiError::BadRequest("a promotion has to be sequenced".into()))?;
    let key_id = record["key_id"].as_str().unwrap_or_default();
    let promoted_at = record["promoted_at"]
        .as_i64()
        .ok_or_else(|| ApiError::BadRequest("promotion record has no timestamp".into()))?;
    not_from_the_future(promoted_at, "promotion record")?;

    if signed_by_at(state, &authority, key_id, record, promoted_at).await {
        let authorization = record
            .get("authorization")
            .filter(|a| a.is_object())
            .ok_or_else(|| ApiError::Forbidden(format!(
                "{authority} claims {primary}'s authority without {primary}'s authorisation"
            )))?;
        let previous =
            verify_authorization(state, authorization, primary, &authority).await?;
        if sequence <= previous {
            return Err(ApiError::Conflict(format!(
                "promotion sequence {sequence} does not advance past {previous}"
            )));
        }
    } else {
        let signer = record["signer"].as_str().unwrap_or(primary);
        if !signed_by_at(state, signer, key_id, record, promoted_at).await {
            return Err(ApiError::Forbidden(
                "a promotion record is signed by neither the new authority nor the current authority".into(),
            ));
        }
        if signer != primary {
            let previous_record = record
                .get("previous_authority")
                .filter(|v| !v.is_null())
                .ok_or_else(|| ApiError::Forbidden(
                    "delegated planned handover carries no previous authority proof".into(),
                ))?;
            let previous = Box::pin(verify(state, previous_record, primary)).await?;
            if previous.domain != signer || sequence <= previous.sequence {
                return Err(ApiError::Forbidden(
                    "planned handover does not extend the current authority chain".into(),
                ));
            }
        }
    }

    Ok(Authority { domain: authority, sequence, record: record.clone() })
}

async fn signed_by_at(
    state: &AppState,
    origin: &str,
    key_id: &str,
    value: &Value,
    at: i64,
) -> bool {
    if key_id.is_empty() {
        return false;
    }
    match crate::federation::verify_key_at(state, origin, key_id, at).await {
        Some(key) => crate::crypto::verify_json(&key, value),
        None => false,
    }
}

pub async fn check(state: &AppState) -> ApiResult<Option<Authority>> {
    let me = state.cfg.server_name.clone();
    let current: i64 =
        sqlx::query_scalar("SELECT sequence FROM failover WHERE subject_type = ? AND subject_id = ?")
            .bind(SUBJECT)
            .bind(&me)
            .fetch_optional(&state.pool)
            .await?
            .unwrap_or(0);

    for standby in &state.cfg.failover.standbys {
        let record = match fetch_record(state, standby, &me).await {
            Ok(Some(r)) => r,
            Ok(None) => continue,
            Err(e) => {
                tracing::debug!(target: crate::logcat::STANDBY, %standby, error = %e, "could not ask about promotions");
                continue;
            }
        };
        let authority = match verify(state, &record, &me).await {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(target: crate::logcat::STANDBY, %standby, error = %e, "ignoring an unverifiable promotion record");
                continue;
            }
        };
        if authority.sequence <= current {
            continue;
        }
        demote(state, &authority).await?;
        return Ok(Some(authority));
    }
    Ok(None)
}

async fn fetch_record(state: &AppState, standby: &str, subject: &str) -> ApiResult<Option<Value>> {
    let peer = crate::federation::discover(state, standby).await?;
    let url = format!("{}/_telium/v1/failover/status/{subject}", peer.api_base);
    let resp = state
        .http
        .get(&url)
        .send()
        .await
        .map_err(|e| ApiError::BadRequest(format!("{standby} unreachable: {e}")))?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| ApiError::BadRequest(format!("{standby} answered unreadably: {e}")))?;
    match body.get("record") {
        Some(Value::Null) | None => Ok(None),
        Some(record) => Ok(Some(record.clone())),
    }
}

pub async fn demote(state: &AppState, authority: &Authority) -> ApiResult<()> {
    let me = state.cfg.server_name.clone();
    let record = authority.record.to_string();
    sqlx::query(
        "INSERT INTO failover (subject_type, subject_id, standby, authorization, sequence, \
             promoted, record, updated_at) \
         VALUES (?, ?, ?, ?, ?, 1, ?, ?) \
         ON CONFLICT(subject_type, subject_id) DO UPDATE SET sequence = excluded.sequence, \
             promoted = 1, record = excluded.record, updated_at = excluded.updated_at",
    )
    .bind(SUBJECT)
    .bind(&me)
    .bind(&authority.domain)
    .bind(authority.record["authorization"].to_string())
    .bind(authority.sequence)
    .bind(&record)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    sqlx::query(
        "INSERT INTO server_meta (key, value) VALUES ('authority', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(
        json!({
            "domain": authority.domain,
            "sequence": authority.sequence,
            "record": authority.record,
            "at": now_ms(),
        })
        .to_string(),
    )
    .execute(&state.pool)
    .await?;

    state.demoted.store(true, Ordering::Relaxed);
    *state.authority_record.write().await = Some(authority.record.clone());

    if let Some(host_pool) = &state.replica_host_pool {
        sqlx::query(
            "UPDATE replica_state SET promoted = 0, sequence = ?, record = ?, promoted_at = ? \
             WHERE origin = ?",
        )
        .bind(authority.sequence)
        .bind(&record)
        .bind(now_ms())
        .bind(&me)
        .execute(host_pool)
        .await?;
    }

    tracing::warn!(
        target: crate::logcat::STANDBY,
        authority = %authority.domain,
        sequence = authority.sequence,
        "demoted: {} is the authority for {me} now; this server is read-only",
        authority.domain,
    );
    Ok(())
}

pub async fn authority(state: &AppState) -> ApiResult<Option<Authority>> {
    if !state.demoted.load(Ordering::Relaxed) {
        return Ok(None);
    }
    stored(state).await
}

async fn stored(state: &AppState) -> ApiResult<Option<Authority>> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT value FROM server_meta WHERE key = 'authority'")
            .fetch_optional(&state.pool)
            .await?;
    let Some(value) = raw.and_then(|v| serde_json::from_str::<Value>(&v).ok()) else {
        return Ok(None);
    };
    let Some(domain) = value["domain"].as_str() else { return Ok(None) };
    Ok(Some(Authority {
        domain: domain.to_string(),
        sequence: value["sequence"].as_i64().unwrap_or(0),
        record: value["record"].clone(),
    }))
}

pub async fn load(state: &AppState) -> ApiResult<()> {
    if let Some(a) = stored(state).await? {
        state.demoted.store(true, Ordering::Relaxed);
        tracing::warn!(
            target: crate::logcat::STANDBY,
            authority = %a.domain,
            sequence = a.sequence,
            "this server was superseded while it was away; starting read-only",
        );
    }
    Ok(())
}

pub fn spawn(state: AppState) {
    if state.cfg.failover.standbys.is_empty() {
        return;
    }
    let every = std::time::Duration::from_secs(state.cfg.failover.demotion_poll_secs.max(5));
    tokio::spawn(async move {
        loop {
            if let Err(e) = check(&state).await {
                tracing::debug!(target: crate::logcat::STANDBY, error = %e, "promotion check failed");
            }
            tokio::time::sleep(every).await;
        }
    });
}
