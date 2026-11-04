//! Capacity-aware voice failover. Operators can refuse *new* media sessions;
//! clients report that refusal, but only the guild server can verify it and
//! move a call. A client cannot name a different endpoint or move another room.

use super::*;

/// Resolve a pinned region without using "accepting new calls" as a reason to
/// split an existing room across relays. An already-running room is allowed to
/// remain at a room-full relay; participant-full is reported explicitly.
pub(super) async fn pinned_region(state: &AppState, guild_id: &str, name: &str) -> Option<(Region, String)> {
    for region in &state.cfg.voice.regions {
        if region.name == name {
            let r = Region::new(region.name.clone(), &region.sfu, region.turn.clone(), region.pubkey_hint.clone())?;
            return Some((r, name.to_owned()));
        }
    }
    let guild_row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT sfu, turn, pubkey_hint FROM guild_voice_regions WHERE guild_id = ? AND name = ?",
    )
    .bind(guild_id)
    .bind(name)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten();
    if let Some((sfu, turn, pubkey_hint)) = guild_row {
        let region = Region::new(name.to_owned(), &sfu, turn, pubkey_hint)?;
        return Some((region, format!("g{guild_id}/{name}")));
    }
    let directory = crate::sfu_directory::relays(state).await.ok()?;
    directory.iter().find(|r| r.url == name).and_then(|r| {
        Region::new(r.url.clone(), &r.url, None, r.pubkey_hint.clone())
            .map(|region| (region, crate::sfu_directory::health_key(&r.url)))
    })
}

/// Move one entire channel together; never move one participant at a time.
/// The DB transition is atomic and each affected client receives a reconnect
/// event using the same destination. When all SFUs are unavailable, mesh is a
/// fallback only if the call fits its configured participant ceiling.
pub(super) async fn move_channel(state: &AppState, guild_id: &str, channel_id: &str, failed: &str) -> ApiResult<bool> {
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM voice_states WHERE guild_id = ? AND channel_id = ? AND region = ?",
    )
    .bind(guild_id)
    .bind(channel_id)
    .bind(failed)
    .fetch_all(&state.pool)
    .await?;
    if users.is_empty() { return Ok(false); }

    let next = resolve_region(state, guild_id, "auto").await;
    let next_name = next.as_ref().map(|r| r.name.clone()).unwrap_or_else(|| "auto".into());
    if next_name == failed { return Ok(false); }
    if next.is_none() && state.cfg.voice.mesh_max_participants > 0
        && users.len() as i64 > state.cfg.voice.mesh_max_participants {
        // Don't silently "migrate" a large room to an unusable mesh.
        return Ok(false);
    }

    let updated = sqlx::query(
        "UPDATE voice_states SET region = ?, updated_at = ? \
         WHERE guild_id = ? AND channel_id = ? AND region = ?",
    )
    .bind(&next_name)
    .bind(now_ms())
    .bind(guild_id)
    .bind(channel_id)
    .bind(failed)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if updated == 0 { return Ok(false); }

    for user_id in users {
        state.hub.publish(Event {
            t: "VOICE_SERVER_UPDATE",
            guild_id: guild_id.to_owned(),
            channel_id: Some(channel_id.to_owned()),
            intent: INTENT_GUILD_VOICE_STATES,
            only_user: Some(user_id),
            data: json!({
                "mode": if next.is_some() { "sfu" } else { "mesh" },
                "region": next_name,
                "endpoint": next.as_ref().map(|r| r.sfu()),
                "channel_id": channel_id,
                "reconnect": true,
            }),
        }.into()).await;
    }
    Ok(true)
}

pub(super) async fn reassign_for_failure(state: &AppState, region: &str, guild_filter: Option<&str>) -> ApiResult<()> {
    let channels: Vec<(String, String)> = sqlx::query_as(
        "SELECT DISTINCT guild_id, channel_id FROM voice_states WHERE region = ?",
    )
    .bind(region)
    .fetch_all(&state.pool)
    .await?;
    for (guild_id, channel_id) in channels {
        if guild_filter.is_some_and(|id| id != guild_id) { continue; }
        move_channel(state, &guild_id, &channel_id, region).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct RelayFullReport {
    pub region: String,
}

/// A 503 from an SFU is evidence to investigate, not an instruction to trust.
/// Verify that the caller is *in this channel* on this named server-owned region,
/// check its health at the guild server, then migrate the complete call.
pub async fn report_relay_full(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(body): Json<RelayFullReport>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    let current: Option<String> = sqlx::query_scalar(
        "SELECT region FROM voice_states WHERE guild_id = ? AND channel_id = ? AND user_id = ?",
    )
    .bind(&ctx.guild_id)
    .bind(&channel_id)
    .bind(&auth.user_id)
    .fetch_optional(&state.pool)
    .await?;
    if current.as_deref() != Some(body.region.as_str()) {
        return Ok(Json(json!({ "changed": false, "reason": "call_already_moved" })));
    }

    let (region, health_key) = pinned_region(&state, &ctx.guild_id, &body.region).await
        .ok_or_else(|| ApiError::Conflict("the call's relay is no longer configured or listed".into()))?;
    let probe = crate::sfu_directory::probe_relay(&state, region.sfu()).await;
    // A client-controlled report must not force migration merely because a
    // relay cannot be probed from this server's network. Only a positive,
    // authenticated server-side observation of "not accepting" is actionable.
    // Ordinary outages are handled separately by periodic health checks.
    if !probe.ok || probe.accepting != Some(false) {
        return Err(ApiError::Conflict(
            "relay capacity could not be confirmed by the guild server".into(),
        ));
    }

    // Mark this relay unavailable for *new* call selection. The health checker
    // can restore availability later, without moving still-connected rooms.
    sqlx::query(
        "INSERT INTO sfu_health (region, endpoint, healthy, failures, latency_ms, checked_at) \
         VALUES (?, ?, 0, 1, ?, ?) \
         ON CONFLICT(region) DO UPDATE SET endpoint = excluded.endpoint, healthy = 0, \
         failures = sfu_health.failures + 1, latency_ms = excluded.latency_ms, checked_at = excluded.checked_at",
    )
    .bind(&health_key)
    .bind(region.sfu())
    .bind(probe.latency_ms)
    .bind(now_ms())
    .execute(&state.pool)
    .await?;

    let moved = move_channel(&state, &ctx.guild_id, &channel_id, &body.region).await?;
    Ok(Json(json!({ "changed": moved, "region": body.region })))
}
