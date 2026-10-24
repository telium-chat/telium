use crate::auth::HomeAuth;
use crate::error::{ApiError, ApiResult};
use crate::federation::{self, Fed};
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use super::*;

#[derive(Deserialize)]
pub struct Reanchor {
    pub sequencer: String,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub epoch: i64,
}

const HANDOFF_TYPE: &str = "telium.dm.handoff";
const HANDOFF_PATH: &str = "/_telium/v1/dm/handoff";

pub async fn reanchor(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(id): Path<String>,
    Json(req): Json<Reanchor>,
) -> ApiResult<Json<Value>> {
    require_member(&state, &id, &auth.user_id).await?;
    if !active_homes(&state, &id).await?.contains(&req.sequencer) {
        return Err(ApiError::BadRequest(
            "a sequencer must be one of the members' homeservers".into(),
        ));
    }
    let sequencer: String = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.pool)
        .await?;
    let outcome = if sequencer == state.cfg.server_name {
        hand_off(&state, &id, &req.sequencer).await?
    } else {
        federation::ensure_reachable(&state, &sequencer, "dm").await?;
        let outcome = federation::post_signed(
            &state,
            &sequencer,
            "/_telium/v1/dm/handoff/request",
            &json!({ "conversation_id": id, "to": req.sequencer, "user_id": auth.user_id }),
        )
        .await?;
        if let Some(doc) = outcome.get("handoff").filter(|d| d.is_object()) {
            if let Err(e) = receive_handoff(&state, doc).await {
                tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "handoff not applied here yet");
            }
        }
        outcome
    };
    let pending = outcome.get("pending").and_then(Value::as_bool).unwrap_or(false);
    let commit = match req.commit.as_deref() {
        Some(commit) if !pending => Some(
            forward_or_sequence(
                &state, &id, "commit", &auth, commit, req.epoch, FrameExtras::default(), None,
            )
            .await?,
        ),
        _ => None,
    };
    Ok(Json(json!({
        "sequencer": req.sequencer,
        "handoff": outcome.get("handoff").cloned().unwrap_or(Value::Null),
        "pending": pending,
        "commit": commit,
    })))
}

async fn active_homes(state: &AppState, id: &str) -> ApiResult<Vec<String>> {
    Ok(sqlx::query_scalar(
        "SELECT DISTINCT home_domain FROM conversation_members WHERE conversation_id = ? \
         AND state = 'active'",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?)
}

pub(super) async fn latest_handoff(state: &AppState, id: &str) -> ApiResult<Option<(i64, Value)>> {
    let row: Option<(i64, String)> = sqlx::query_as(
        "SELECT n, document FROM dm_handoffs WHERE conversation_id = ? ORDER BY n DESC LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.and_then(|(n, doc)| serde_json::from_str(&doc).ok().map(|d| (n, d))))
}

pub(super) async fn hand_off(state: &AppState, id: &str, to: &str) -> ApiResult<Value> {
    let me = state.cfg.server_name.clone();
    if to == me {
        return Ok(json!({ "unchanged": true }));
    }
    let now = now_ms();
    let mut tx = state.pool.begin().await?;
    let frozen: Option<(i64, i64, i64)> = sqlx::query_as(
        "UPDATE conversations SET sequencer = ?, updated_at = ? WHERE id = ? AND sequencer = ? \
         RETURNING last_seq, epoch, generation",
    )
    .bind(to)
    .bind(now)
    .bind(id)
    .bind(&me)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((last_seq, epoch, generation)) = frozen else {
        let current: Option<String> =
            sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        drop(tx);
        return match current {
            Some(s) if s == to => Ok(json!({
                "handoff": latest_handoff(state, id).await?.map(|(_, d)| d),
                "pending": false,
            })),
            Some(s) => Err(not_sequencer(&s)),
            None => Err(ApiError::NotFound("no such conversation".into())),
        };
    };
    let n: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(n), 0) + 1 FROM dm_handoffs WHERE conversation_id = ?",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let doc = crate::crypto::sign_json(
        &state.key,
        json!({
            "type": HANDOFF_TYPE, "conversation_id": id, "n": n, "from": me, "to": to,
            "last_seq": last_seq, "epoch": epoch, "generation": generation, "issued_at": now,
        }),
    );
    record_handoff(&mut tx, &Handoff::read(&doc)?, &doc).await?;
    tx.commit().await?;

    let body = json!({ "handoff": doc });
    let pending = match federation::post_signed(state, to, HANDOFF_PATH, &body).await {
        Ok(_) => false,
        Err(e) if definite_refusal(&e) => {
            let mut tx = state.pool.begin().await?;
            sqlx::query("UPDATE conversations SET sequencer = ? WHERE id = ? AND sequencer = ?")
                .bind(&me)
                .bind(id)
                .bind(to)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM dm_handoffs WHERE conversation_id = ? AND n = ?")
                .bind(id)
                .bind(n)
                .execute(&mut *tx)
                .await?;
            tx.commit().await?;
            return Err(e);
        }
        Err(e) => {
            tracing::warn!(
                target: crate::logcat::SOCIAL, error = %e, %to,
                "sequencer handoff not delivered yet; the outbox will keep trying"
            );
            queue(state, id, &format!("handoff-{n}"), to, HANDOFF_PATH, &body).await?;
            true
        }
    };
    for home in active_homes(state, id).await? {
        if home != me && home != to {
            queue(state, id, &format!("handoff-{n}"), &home, HANDOFF_PATH, &body).await?;
        }
    }
    Ok(json!({ "handoff": doc, "pending": pending }))
}

struct Handoff {
    conversation_id: String,
    n: i64,
    from: String,
    to: String,
    last_seq: i64,
    epoch: i64,
    generation: i64,
}

impl Handoff {
    fn read(doc: &Value) -> ApiResult<Self> {
        let bad = || ApiError::BadRequest("malformed sequencer handoff".into());
        let text = |k: &str| doc.get(k).and_then(Value::as_str).map(str::to_string).ok_or_else(bad);
        let int = |k: &str| doc.get(k).and_then(Value::as_i64).ok_or_else(bad);
        if doc.get("type").and_then(Value::as_str) != Some(HANDOFF_TYPE) {
            return Err(bad());
        }
        let h = Handoff {
            conversation_id: text("conversation_id")?,
            n: int("n")?,
            from: text("from")?,
            to: text("to")?,
            last_seq: int("last_seq")?,
            epoch: int("epoch")?,
            generation: doc.get("generation").map_or(Ok(0), |_| int("generation"))?,
        };
        if h.n < 1 || h.last_seq < 0 || h.epoch < 0 || h.generation < 0 || h.from == h.to {
            return Err(bad());
        }
        Ok(h)
    }
}

async fn record_handoff(
    tx: &mut sqlx::SqliteConnection,
    h: &Handoff,
    doc: &Value,
) -> ApiResult<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO dm_handoffs (conversation_id, n, from_server, to_server, last_seq, \
         epoch, document, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&h.conversation_id)
    .bind(h.n)
    .bind(&h.from)
    .bind(&h.to)
    .bind(h.last_seq)
    .bind(h.epoch)
    .bind(doc.to_string())
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    Ok(())
}

async fn verified_handoff(state: &AppState, doc: &Value) -> ApiResult<Handoff> {
    let h = Handoff::read(doc)?;
    let key_id = doc
        .get("key_id")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Forbidden("that handoff is not signed".into()))?;
    let public = federation::verify_key(state, &h.from, key_id)
        .await
        .ok_or_else(|| ApiError::Forbidden(format!("{} published no such key", h.from)))?;
    if !crate::crypto::verify_json(&public, doc) {
        return Err(ApiError::Forbidden("that handoff's signature does not check".into()));
    }
    Ok(h)
}

fn stale_handoff(newest: i64) -> ApiError {
    ApiError::Forbidden("that handoff is older than the conversation's own order".into())
        .with_code(crate::errcodes::HANDOFF_STALE)
        .with_detail("n", newest)
}

pub(super) async fn receive_handoff(state: &AppState, doc: &Value) -> ApiResult<bool> {
    let h = verified_handoff(state, doc).await?;
    let id = h.conversation_id.as_str();
    let newest: i64 =
        sqlx::query_scalar("SELECT COALESCE(MAX(n), 0) FROM dm_handoffs WHERE conversation_id = ?")
            .bind(id)
            .fetch_one(&state.pool)
            .await?;
    let local: Option<String> = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    if h.n <= newest {
        let held: Option<String> = sqlx::query_scalar(
            "SELECT document FROM dm_handoffs WHERE conversation_id = ? AND n = ?",
        )
        .bind(id)
        .bind(h.n)
        .fetch_optional(&state.pool)
        .await?;
        let same = held.and_then(|d| serde_json::from_str::<Value>(&d).ok()).as_ref() == Some(doc);
        if same && h.n == newest && local.as_deref() == Some(h.to.as_str()) {
            return Ok(false);
        }
        return Err(stale_handoff(newest));
    }
    if h.to == state.cfg.server_name {
        return take_over(state, &h, doc, local.as_deref(), newest).await;
    }
    let Some(local) = local else {
        return Ok(false);
    };
    if local != h.from {
        return Err(stale_handoff(newest));
    }
    if !active_homes(state, id).await?.contains(&h.to) {
        return Err(ApiError::Forbidden("a sequencer must be one of the members' homeservers".into()));
    }
    let mut tx = state.pool.begin().await?;
    let moved = sqlx::query(
        "UPDATE conversations SET sequencer = ?, last_seq = MAX(last_seq, ?), \
         generation = MAX(generation, ?), updated_at = ? WHERE id = ? AND sequencer = ?",
    )
    .bind(&h.to)
    .bind(h.last_seq)
    .bind(h.generation)
    .bind(now_ms())
    .bind(id)
    .bind(&h.from)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(stale_handoff(newest));
    }
    record_handoff(&mut tx, &h, doc).await?;
    tx.commit().await?;
    Ok(true)
}

async fn take_over(
    state: &AppState,
    h: &Handoff,
    doc: &Value,
    local: Option<&str>,
    newest: i64,
) -> ApiResult<bool> {
    let id = h.conversation_id.as_str();
    if local.is_some_and(|s| s != h.from) {
        return Err(stale_handoff(newest));
    }
    let mut descriptor: Option<Value> = None;
    let mut rounds = 0;
    loop {
        let hole = if local.is_none() && descriptor.is_none() {
            Some(1)
        } else {
            first_hole(state, id, 0, h.last_seq).await?
        };
        let Some(hole) = hole else { break };
        rounds += 1;
        if rounds > 10_000 {
            return Err(ApiError::BadGateway("the old sequencer's log would not come".into()));
        }
        let page = federation::get_signed(
            state,
            &h.from,
            &format!("/_telium/v1/dm/frames/{id}/{}", hole - 1),
        )
        .await?;
        if descriptor.is_none() {
            let mut conv = page.get("conversation").cloned().unwrap_or(Value::Null);
            if conv.get("id").and_then(Value::as_str) != Some(id) {
                return Err(ApiError::BadGateway("the old sequencer sent no descriptor".into()));
            }
            let hosts = conv.get("members").and_then(Value::as_array).is_some_and(|m| {
                m.iter().any(|m| {
                    m.get("home").and_then(Value::as_str) == Some(state.cfg.server_name.as_str())
                        && m.get("state").and_then(Value::as_str) == Some("active")
                })
            });
            if !hosts {
                return Err(ApiError::Forbidden("we host nobody in that conversation".into()));
            }
            conv["sequencer"] = json!(h.from);
            upsert_conversation_from_sequencer(state, &conv).await?;
            descriptor = Some(conv);
        }
        let mut filled = false;
        for m in page.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let seq = m.get("seq").and_then(Value::as_i64).unwrap_or(0);
            if seq >= hole && seq <= h.last_seq {
                store_frame(state, id, m).await?;
                filled |= seq == hole;
            }
        }
        if !filled && h.last_seq >= hole {
            return Err(ApiError::BadGateway(format!(
                "{} could not hand over frame {hole}", h.from
            )));
        }
    }
    let mut tx = state.pool.begin().await?;
    let moved = sqlx::query(
        "UPDATE conversations SET sequencer = ?, last_seq = ?, epoch = ?, generation = ?, \
         updated_at = ? WHERE id = ? AND sequencer = ?",
    )
    .bind(&state.cfg.server_name)
    .bind(h.last_seq)
    .bind(h.epoch)
    .bind(h.generation)
    .bind(now_ms())
    .bind(id)
    .bind(&h.from)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if moved == 0 {
        drop(tx);
        let now: Option<String> = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
        if now.as_deref() == Some(state.cfg.server_name.as_str()) {
            return Ok(false);
        }
        return Err(stale_handoff(newest));
    }
    record_handoff(&mut tx, h, doc).await?;
    tx.commit().await?;
    Ok(true)
}

#[derive(Deserialize)]
pub struct HandoffNotice {
    pub handoff: Value,
}

pub async fn inbound_handoff(
    State(state): State<AppState>,
    fed: Fed<HandoffNotice>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let applied = receive_handoff(&state, &fed.body.handoff).await?;
    let id = fed.body.handoff.get("conversation_id").and_then(Value::as_str).unwrap_or_default();
    let sequencer: Option<String> = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?;
    Ok(Json(json!({ "ok": true, "applied": applied, "sequencer": sequencer })))
}

#[derive(Deserialize)]
pub struct HandoffRequest {
    pub conversation_id: String,
    pub to: String,
    pub user_id: String,
}

pub async fn inbound_handoff_request(
    State(state): State<AppState>,
    fed: Fed<HandoffRequest>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let req = fed.body;
    if home_of(&req.user_id)? != fed.origin {
        return Err(ApiError::Forbidden("that is not your account to speak for".into()));
    }
    let sequencer: Option<String> = sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(&req.conversation_id)
        .fetch_optional(&state.pool)
        .await?;
    match sequencer {
        Some(s) if s == state.cfg.server_name => {}
        Some(s) => return Err(not_sequencer(&s)),
        None => return Err(ApiError::NotFound("no such conversation".into())),
    }
    require_member(&state, &req.conversation_id, &req.user_id).await?;
    if !active_homes(&state, &req.conversation_id).await?.contains(&req.to) {
        return Err(ApiError::BadRequest(
            "a sequencer must be one of the members' homeservers".into(),
        ));
    }
    Ok(Json(hand_off(&state, &req.conversation_id, &req.to).await?))
}

pub async fn inbound_handoff_latest(
    State(state): State<AppState>,
    federation::FedOrigin(origin): federation::FedOrigin,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    federation::ensure_reachable(&state, &origin, "dm").await?;
    if !active_homes(&state, &id).await?.contains(&origin) {
        return Err(ApiError::Forbidden("you host no member of that conversation".into()));
    }
    Ok(Json(json!({ "handoff": latest_handoff(&state, &id).await?.map(|(_, d)| d) })))
}

pub(super) async fn learn_handoff(state: &AppState, id: &str, asked: &str) -> ApiResult<Option<String>> {
    let answer = match federation::get_signed(state, asked, &format!("{HANDOFF_PATH}/{id}")).await {
        Ok(answer) => answer,
        Err(e) => {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "could not fetch a sequencer handoff");
            return Ok(None);
        }
    };
    let Some(doc) = answer.get("handoff").filter(|d| d.is_object()) else { return Ok(None) };
    match receive_handoff(state, doc).await {
        Ok(true) => {}
        Ok(false) => return Ok(None),
        Err(e) => {
            tracing::warn!(target: crate::logcat::SOCIAL, error = %e, "sequencer handoff not applied");
            return Ok(None);
        }
    }
    Ok(sqlx::query_scalar("SELECT sequencer FROM conversations WHERE id = ?")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?)
}

pub async fn inbound_reanchor(State(_state): State<AppState>, _fed: Fed<Value>) -> ApiResult<Json<Value>> {
    Err(ApiError::BadRequest(
        "re-anchoring is a signed handoff now (/_telium/v1/dm/handoff); upgrade to move a sequencer"
            .into(),
    ))
}
