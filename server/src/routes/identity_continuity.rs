
use crate::auth::HomeAuth;
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::util::{now_ms, split_user_id};
use axum::extract::{Path, State};
use axum::Json;
use base64::engine::general_purpose::{
    STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD,
};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const ANCHOR_DOMAIN: &str = "telium-identity-anchor:v1";
const POLICY_DOMAIN: &str = "telium-identity-recovery-policy:v1";
const ROTATE_DOMAIN: &str = "telium-identity-rotate:v1";
const REVOKE_DOMAIN: &str = "telium-device-revoke:v1";
const DEVICE_DOMAIN: &str = "telium-device-sig:v1";
const ID_DOMAIN: &[u8] = b"telium-identity-id:v1\0";
const MAX_GUARDIANS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Guardian {
    pub user_id: String,
    pub immutable_id: String,
    pub identity_key: String,
}

#[derive(Debug, Deserialize)]
pub struct AnchorIdentity {
    pub immutable_id: String,
    pub identity_key: String,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
pub struct RecoveryPolicyUpload {
    pub version: i64,
    pub identity_sequence: i64,
    pub threshold: i64,
    pub guardians: Vec<Guardian>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuardianApproval {
    pub guardian_immutable_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RotationAuthorization {
    ExistingRoot {
        signature: String,
    },
    Guardians {
        policy_version: i64,
        approvals: Vec<GuardianApproval>,
    },
}

#[derive(Debug, Deserialize)]
pub struct RotateIdentity {
    pub sequence: i64,
    pub previous_key: String,
    pub new_key: String,
    pub sealed_secret: String,
    pub authorization: RotationAuthorization,
    #[serde(default)]
    pub new_key_signature: Option<String>,
    #[serde(default)]
    pub device_signatures: Vec<DeviceResign>,
}

#[derive(Debug, Deserialize)]
pub struct DeviceResign {
    pub device_id: String,
    pub mls_key: String,
    pub signature: String,
}

fn decode_any_b64(raw: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(raw)
        .or_else(|_| URL_SAFE.decode(raw))
        .or_else(|_| STANDARD_NO_PAD.decode(raw))
        .or_else(|_| STANDARD.decode(raw))
        .ok()
}

fn key_bytes(raw: &str) -> ApiResult<[u8; 32]> {
    decode_any_b64(raw)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(|| ApiError::BadRequest("identity key must be 32 base64 bytes".into()))
}

pub(crate) fn verify_signature(public: &str, payload: &[u8], signature: &str) -> bool {
    let Ok(key_bytes) = key_bytes(public) else {
        return false;
    };
    let Some(sig_bytes) = decode_any_b64(signature).and_then(|v| <[u8; 64]>::try_from(v).ok())
    else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&key_bytes) else {
        return false;
    };
    key.verify_strict(payload, &Signature::from_bytes(&sig_bytes))
        .is_ok()
}

pub fn immutable_id_for_key(identity_key: &str) -> ApiResult<String> {
    let key = key_bytes(identity_key)?;
    let mut digest = Sha256::new();
    digest.update(ID_DOMAIN);
    digest.update(key);
    Ok(format!("tid:{}", hex::encode(digest.finalize())))
}

pub fn anchor_payload(user_id: &str, immutable_id: &str, identity_key: &str) -> Vec<u8> {
    format!("{ANCHOR_DOMAIN}|{user_id}|{immutable_id}|{identity_key}").into_bytes()
}

fn canonical_guardians(guardians: &[Guardian]) -> Vec<Guardian> {
    let mut out = guardians.to_vec();
    out.sort_by(|a, b| {
        a.immutable_id
            .cmp(&b.immutable_id)
            .then_with(|| a.user_id.cmp(&b.user_id))
            .then_with(|| a.identity_key.cmp(&b.identity_key))
    });
    out
}

pub fn recovery_policy_payload(
    immutable_id: &str,
    version: i64,
    identity_sequence: i64,
    threshold: i64,
    guardians: &[Guardian],
) -> Vec<u8> {
    let rows: Vec<Value> = canonical_guardians(guardians)
        .into_iter()
        .map(|g| json!([g.user_id, g.immutable_id, g.identity_key]))
        .collect();
    let body = serde_json::to_string(&json!([threshold, rows]))
        .expect("recovery policy payload is serializable");
    format!(
        "{POLICY_DOMAIN}|{immutable_id}|{version}|{identity_sequence}|{body}"
    )
    .into_bytes()
}

pub fn rotation_payload(
    immutable_id: &str,
    sequence: i64,
    previous_key: &str,
    new_key: &str,
) -> Vec<u8> {
    format!(
        "{ROTATE_DOMAIN}|{immutable_id}|{sequence}|{previous_key}|{new_key}"
    )
    .into_bytes()
}

pub fn revocation_payload(
    user_id: &str,
    immutable_id: &str,
    device_id: &str,
    mls_key: &str,
) -> Vec<u8> {
    format!("{REVOKE_DOMAIN}|{user_id}|{immutable_id}|{device_id}|{mls_key}").into_bytes()
}

pub fn device_payload(user_id: &str, device_id: &str, mls_key: &str) -> Vec<u8> {
    format!("{DEVICE_DOMAIN}|{user_id}|{device_id}|{mls_key}").into_bytes()
}

pub async fn is_revoked_key(state: &AppState, user_id: &str, mls_key: &str) -> ApiResult<bool> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM device_revocations WHERE user_id = ? AND mls_key = ?",
    )
    .bind(user_id)
    .bind(mls_key)
    .fetch_optional(&state.pool)
    .await?
    .is_some())
}

pub async fn revocations(state: &AppState, user_id: &str) -> ApiResult<Vec<Value>> {
    let rows: Vec<(String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT mls_key, device_id, immutable_id, signer_key, signature, revoked_at \
         FROM device_revocations WHERE user_id = ? ORDER BY revoked_at",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(mls_key, device_id, immutable_id, signer_key, signature, revoked_at)| {
            json!({
                "mls_key": mls_key,
                "device_id": device_id,
                "immutable_id": immutable_id,
                "signer_key": signer_key,
                "signature": signature,
                "revoked_at": revoked_at,
            })
        })
        .collect())
}

pub async fn root_of(state: &AppState, user_id: &str) -> ApiResult<Option<(String, String)>> {
    Ok(sqlx::query_as("SELECT immutable_id, current_key FROM identity_roots WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?)
}

async fn load_root(
    state: &AppState,
    user_id: &str,
) -> ApiResult<Option<(String, String, String, String, i64, i64, i64, i64)>> {
    Ok(sqlx::query_as(
        "SELECT immutable_id, genesis_key, anchor_signature, current_key, sequence,          current_policy_version, created_at, updated_at          FROM identity_roots WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?)
}

pub async fn current_key(state: &AppState, user_id: &str) -> ApiResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT current_key FROM identity_roots WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?)
}

async fn key_at_sequence(state: &AppState, user_id: &str, sequence: i64) -> ApiResult<Option<String>> {
    if sequence < 0 {
        return Ok(None);
    }
    if sequence == 0 {
        return Ok(sqlx::query_scalar("SELECT genesis_key FROM identity_roots WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?);
    }
    Ok(sqlx::query_scalar(
        "SELECT new_key FROM identity_transitions WHERE user_id = ? AND sequence = ?",
    )
    .bind(user_id)
    .bind(sequence)
    .fetch_optional(&state.pool)
    .await?)
}

async fn local_document(state: &AppState, user_id: &str) -> ApiResult<Value> {
    let Some((
        immutable_id,
        genesis_key,
        anchor_signature,
        current_key,
        sequence,
        current_policy_version,
        created_at,
        updated_at,
    )) = load_root(state, user_id).await?
    else {
        return Ok(json!({
            "exists": false,
            "user_id": user_id,
        }));
    };

    let transitions: Vec<(i64, String, String, String, String, Option<i64>, i64, Option<String>)> =
        sqlx::query_as(
            "SELECT sequence, previous_key, new_key, authorization_kind,              authorization_json, policy_version, created_at, new_key_signature              FROM identity_transitions WHERE user_id = ? ORDER BY sequence",
        )
        .bind(user_id)
        .fetch_all(&state.pool)
        .await?;

    let policies: Vec<(i64, i64, i64, String, String, i64)> = sqlx::query_as(
        "SELECT version, identity_sequence, threshold, guardians_json, signature, created_at          FROM identity_recovery_policies WHERE user_id = ? ORDER BY version",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(json!({
        "exists": true,
        "user_id": user_id,
        "immutable_id": immutable_id,
        "genesis_key": genesis_key,
        "anchor_signature": anchor_signature,
        "current_key": current_key,
        "sequence": sequence,
        "current_policy_version": current_policy_version,
        "created_at": created_at,
        "updated_at": updated_at,
        "transitions": transitions.into_iter().map(
            |(sequence, previous_key, new_key, authorization_kind, authorization_json, policy_version, created_at, new_key_signature)| {
                json!({
                    "sequence": sequence,
                    "previous_key": previous_key,
                    "new_key": new_key,
                    "new_key_signature": new_key_signature,
                    "authorization_kind": authorization_kind,
                    "authorization": serde_json::from_str::<Value>(&authorization_json).unwrap_or(Value::Null),
                    "policy_version": policy_version,
                    "created_at": created_at,
                })
            }
        ).collect::<Vec<_>>(),
        "recovery_policies": policies.into_iter().map(
            |(version, identity_sequence, threshold, guardians_json, signature, created_at)| {
                json!({
                    "version": version,
                    "identity_sequence": identity_sequence,
                    "threshold": threshold,
                    "guardians": serde_json::from_str::<Value>(&guardians_json).unwrap_or_else(|_| json!([])),
                    "signature": signature,
                    "created_at": created_at,
                })
            }
        ).collect::<Vec<_>>(),
    }))
}

async fn remote_document(state: &AppState, user_id: &str) -> ApiResult<Value> {
    let (_, domain) = split_user_id(user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?;
    let doc = crate::federation::get_signed(
        state,
        domain,
        &format!("/_telium/v1/users/{user_id}/identity"),
    )
    .await?;
    let key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest(format!("{domain} returned an unsigned identity document")))?;
    let public = crate::federation::verify_key(state, domain, key_id)
        .await
        .ok_or_else(|| ApiError::BadRequest(format!("{domain} signed identity state with an unpublished key")))?;
    if !crypto::verify_json(&public, &doc) {
        return Err(ApiError::BadRequest(format!("{domain} returned a bad identity signature")));
    }
    Ok(doc)
}

async fn resolve_document(state: &AppState, user_id: &str) -> ApiResult<Value> {
    let (_, domain) = split_user_id(user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?;
    if domain == state.cfg.server_name {
        local_document(state, user_id).await
    } else {
        remote_document(state, user_id).await
    }
}

pub async fn get_own(
    State(state): State<AppState>,
    auth: HomeAuth,
) -> ApiResult<Json<Value>> {
    Ok(Json(local_document(&state, &auth.user_id).await?))
}

pub async fn get_public(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let (_, domain) = split_user_id(&user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?;
    if domain != state.cfg.server_name {
        return Ok(Json(remote_document(&state, &user_id).await?));
    }
    Ok(Json(crypto::sign_json(
        &state.key,
        local_document(&state, &user_id).await?,
    )))
}

pub async fn anchor(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(body): Json<AnchorIdentity>,
) -> ApiResult<Json<Value>> {
    let expected = immutable_id_for_key(&body.identity_key)?;
    if body.immutable_id != expected {
        return Err(ApiError::BadRequest(
            "immutable identity id does not match the genesis key".into(),
        ));
    }
    let cross_key: Option<String> =
        sqlx::query_scalar("SELECT identity_key FROM cross_signing WHERE user_id = ?")
            .bind(&auth.user_id)
            .fetch_optional(&state.pool)
            .await?;
    if cross_key.as_deref() != Some(body.identity_key.as_str()) {
        return Err(ApiError::Conflict(
            "anchor key must be the account's current cross-signing key".into(),
        ));
    }
    if !verify_signature(
        &body.identity_key,
        &anchor_payload(&auth.user_id, &body.immutable_id, &body.identity_key),
        &body.signature,
    ) {
        return Err(ApiError::Unauthorized(
            "identity anchor proof is not signed by the genesis key".into(),
        ));
    }

    if let Some((immutable_id, genesis_key, _, current_key, ..)) =
        load_root(&state, &auth.user_id).await?
    {
        if immutable_id == body.immutable_id
            && genesis_key == body.identity_key
            && current_key == body.identity_key
        {
            return Ok(Json(local_document(&state, &auth.user_id).await?));
        }
        return Err(ApiError::Conflict(
            "this account already has a different immutable identity".into(),
        ));
    }

    let now = now_ms();
    sqlx::query(
        "INSERT INTO identity_roots          (user_id, immutable_id, genesis_key, anchor_signature, current_key, sequence, current_policy_version, created_at, updated_at)          VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)",
    )
    .bind(&auth.user_id)
    .bind(&body.immutable_id)
    .bind(&body.identity_key)
    .bind(&body.signature)
    .bind(&body.identity_key)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;

    Ok(Json(local_document(&state, &auth.user_id).await?))
}

fn validate_policy_shape(
    self_user: &str,
    self_identity: &str,
    threshold: i64,
    guardians: &[Guardian],
) -> ApiResult<()> {
    if guardians.len() < 2 || guardians.len() > MAX_GUARDIANS {
        return Err(ApiError::BadRequest(
            "recovery policy needs between 2 and 5 guardians".into(),
        ));
    }
    if threshold < 2 || threshold as usize > guardians.len() {
        return Err(ApiError::BadRequest(
            "recovery threshold must be at least 2 and no more than the guardian count".into(),
        ));
    }
    let mut users = HashSet::new();
    let mut identities = HashSet::new();
    let mut keys = HashSet::new();
    for guardian in guardians {
        if split_user_id(&guardian.user_id).is_none() {
            return Err(ApiError::BadRequest("guardian has a malformed user id".into()));
        }
        if guardian.user_id == self_user || guardian.immutable_id == self_identity {
            return Err(ApiError::BadRequest(
                "the account itself cannot be one of its recovery guardians".into(),
            ));
        }
        let key = key_bytes(&guardian.identity_key)?;
        if !users.insert(guardian.user_id.clone())
            || !identities.insert(guardian.immutable_id.clone())
            || !keys.insert(key)
        {
            return Err(ApiError::BadRequest(
                "recovery guardians must have unique accounts, identities, and signing keys".into(),
            ));
        }
    }
    Ok(())
}

pub async fn set_recovery_policy(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(body): Json<RecoveryPolicyUpload>,
) -> ApiResult<Json<Value>> {
    let Some((immutable_id, _, _, current_key, sequence, current_policy, ..)) =
        load_root(&state, &auth.user_id).await?
    else {
        return Err(ApiError::Conflict(
            "anchor the immutable identity before setting recovery guardians".into(),
        ));
    };
    if body.version != current_policy + 1 {
        return Err(ApiError::Conflict(format!(
            "next recovery policy version is {}",
            current_policy + 1
        )));
    }
    if body.identity_sequence != sequence {
        return Err(ApiError::Conflict(
            "recovery policy was signed for a stale identity root".into(),
        ));
    }
    validate_policy_shape(
        &auth.user_id,
        &immutable_id,
        body.threshold,
        &body.guardians,
    )?;

    for guardian in &body.guardians {
        let doc = resolve_document(&state, &guardian.user_id).await?;
        if doc.get("exists").and_then(Value::as_bool) != Some(true)
            || doc.get("immutable_id").and_then(Value::as_str)
                != Some(guardian.immutable_id.as_str())
            || doc.get("current_key").and_then(Value::as_str)
                != Some(guardian.identity_key.as_str())
        {
            return Err(ApiError::Conflict(format!(
                "{} does not currently publish the guardian identity you selected",
                guardian.user_id
            )));
        }
    }

    let payload = recovery_policy_payload(
        &immutable_id,
        body.version,
        body.identity_sequence,
        body.threshold,
        &body.guardians,
    );
    if !verify_signature(&current_key, &payload, &body.signature) {
        return Err(ApiError::Unauthorized(
            "recovery policy is not signed by the current identity root".into(),
        ));
    }

    let guardians_json = serde_json::to_string(&canonical_guardians(&body.guardians))
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serializing recovery guardians: {e}")))?;
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO identity_recovery_policies          (user_id, version, identity_sequence, threshold, guardians_json, signature, created_at)          VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&auth.user_id)
    .bind(body.version)
    .bind(body.identity_sequence)
    .bind(body.threshold)
    .bind(guardians_json)
    .bind(&body.signature)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE identity_roots SET current_policy_version = ?, updated_at = ? WHERE user_id = ?",
    )
    .bind(body.version)
    .bind(now)
    .bind(&auth.user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(local_document(&state, &auth.user_id).await?))
}

async fn verify_guardian_authorization(
    state: &AppState,
    user_id: &str,
    immutable_id: &str,
    payload: &[u8],
    policy_version: i64,
    approvals: &[GuardianApproval],
) -> ApiResult<()> {
    let row: Option<(i64, i64, String, String)> = sqlx::query_as(
        "SELECT identity_sequence, threshold, guardians_json, signature          FROM identity_recovery_policies WHERE user_id = ? AND version = ?",
    )
    .bind(user_id)
    .bind(policy_version)
    .fetch_optional(&state.pool)
    .await?;
    let Some((identity_sequence, threshold, guardians_json, policy_signature)) = row else {
        return Err(ApiError::Unauthorized("unknown recovery policy".into()));
    };
    let guardians: Vec<Guardian> = serde_json::from_str(&guardians_json)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("stored recovery policy unreadable: {e}")))?;

    let signer = key_at_sequence(state, user_id, identity_sequence)
        .await?
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("recovery policy signer is missing")))?;
    let policy_payload = recovery_policy_payload(
        immutable_id,
        policy_version,
        identity_sequence,
        threshold,
        &guardians,
    );
    if !verify_signature(&signer, &policy_payload, &policy_signature) {
        return Err(ApiError::Unauthorized(
            "stored recovery policy is not authorized by this identity chain".into(),
        ));
    }

    let by_id: HashMap<&str, &Guardian> = guardians
        .iter()
        .map(|g| (g.immutable_id.as_str(), g))
        .collect();
    let mut approved = HashSet::new();
    for approval in approvals {
        if !approved.insert(approval.guardian_immutable_id.as_str()) {
            continue;
        }
        let Some(guardian) = by_id.get(approval.guardian_immutable_id.as_str()) else {
            continue;
        };
        if !verify_signature(&guardian.identity_key, payload, &approval.signature) {
            approved.remove(approval.guardian_immutable_id.as_str());
        }
    }
    if approved.len() < threshold as usize {
        return Err(ApiError::Unauthorized(format!(
            "recovery requires {threshold} guardian approvals"
        )));
    }
    Ok(())
}

pub async fn rotate(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(body): Json<RotateIdentity>,
) -> ApiResult<Json<Value>> {
    let Some((immutable_id, _, _, current_key, sequence, _, ..)) =
        load_root(&state, &auth.user_id).await?
    else {
        return Err(ApiError::Conflict(
            "anchor the immutable identity before rotating it".into(),
        ));
    };
    if body.sequence != sequence + 1 {
        return Err(ApiError::Conflict(format!(
            "next identity sequence is {}",
            sequence + 1
        )));
    }
    if body.previous_key != current_key {
        return Err(ApiError::Conflict(
            "identity rotation does not continue from the current root".into(),
        ));
    }
    if body.new_key == current_key {
        return Err(ApiError::BadRequest("new identity root must actually be new".into()));
    }
    key_bytes(&body.new_key)?;
    if body.sealed_secret.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "new identity root needs its sealed secret".into(),
        ));
    }

    let payload = rotation_payload(
        &immutable_id,
        body.sequence,
        &body.previous_key,
        &body.new_key,
    );
    let (authorization_kind, policy_version) = match &body.authorization {
        RotationAuthorization::ExistingRoot { signature } => {
            if !verify_signature(&current_key, &payload, signature) {
                return Err(ApiError::Unauthorized(
                    "identity rotation is not signed by the current root".into(),
                ));
            }
            ("existing_root", None)
        }
        RotationAuthorization::Guardians {
            policy_version,
            approvals,
        } => {
            let current_policy: i64 = sqlx::query_scalar(
                "SELECT current_policy_version FROM identity_roots WHERE user_id = ?",
            )
            .bind(&auth.user_id)
            .fetch_one(&state.pool)
            .await?;
            if *policy_version != current_policy || current_policy == 0 {
                return Err(ApiError::Unauthorized(
                    "guardian recovery must use the account's current recovery policy".into(),
                ));
            }
            verify_guardian_authorization(
                &state,
                &auth.user_id,
                &immutable_id,
                &payload,
                *policy_version,
                approvals,
            )
            .await?;
            ("guardians", Some(*policy_version))
        }
    };

    // The new key must sign too, or a stolen old root could point the account at someone else's key.
    match body.new_key_signature.as_deref() {
        Some(signature) if verify_signature(&body.new_key, &payload, signature) => {}
        _ => {
            return Err(ApiError::Unauthorized(
                "identity rotation is not signed by the new root".into(),
            ))
        }
    }
    for d in &body.device_signatures {
        if !verify_signature(
            &body.new_key,
            &device_payload(&auth.user_id, &d.device_id, &d.mls_key),
            &d.signature,
        ) {
            return Err(ApiError::Unauthorized(format!(
                "device {} is not signed by the new root",
                d.device_id
            )));
        }
        if is_revoked_key(&state, &auth.user_id, &d.mls_key).await? {
            return Err(ApiError::Forbidden(format!(
                "device {} has been revoked",
                d.device_id
            )));
        }
    }

    let authorization_json = serde_json::to_string(&body.authorization)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("serializing identity authorization: {e}")))?;
    let now = now_ms();
    let mut tx = state.pool.begin().await?;

    sqlx::query(
        "UPDATE user_signatures SET signer_key = ? WHERE signer = ? AND signer_key IS NULL",
    )
    .bind(&current_key)
    .bind(&auth.user_id)
    .execute(&mut *tx)
    .await?;

    let changed = sqlx::query(
        "UPDATE cross_signing SET identity_key = ?, sealed_secret = ?, updated_at = ?          WHERE user_id = ? AND identity_key = ?",
    )
    .bind(&body.new_key)
    .bind(&body.sealed_secret)
    .bind(now)
    .bind(&auth.user_id)
    .bind(&current_key)
    .execute(&mut *tx)
    .await?;
    if changed.rows_affected() != 1 {
        return Err(ApiError::Conflict(
            "cross-signing state no longer matches the identity chain".into(),
        ));
    }

    sqlx::query("UPDATE devices SET cross_sig = NULL WHERE user_id = ?")
        .bind(&auth.user_id)
        .execute(&mut *tx)
        .await?;
    for d in &body.device_signatures {
        sqlx::query(
            "UPDATE devices SET mls_key = ?, cross_sig = ? \
             WHERE device_id = ? AND user_id = ? AND active = 1",
        )
        .bind(&d.mls_key)
        .bind(&d.signature)
        .bind(&d.device_id)
        .bind(&auth.user_id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(
        "INSERT INTO identity_transitions          (user_id, sequence, previous_key, new_key, authorization_kind, authorization_json, policy_version, created_at, new_key_signature)          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&auth.user_id)
    .bind(body.sequence)
    .bind(&body.previous_key)
    .bind(&body.new_key)
    .bind(authorization_kind)
    .bind(authorization_json)
    .bind(policy_version)
    .bind(now)
    .bind(&body.new_key_signature)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE identity_roots SET current_key = ?, sequence = ?, updated_at = ? WHERE user_id = ?",
    )
    .bind(&body.new_key)
    .bind(body.sequence)
    .bind(now)
    .bind(&auth.user_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    Ok(Json(local_document(&state, &auth.user_id).await?))
}
