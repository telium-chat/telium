use super::*;

const MAX_HANDSHAKE: usize = 512 * 1024;

pub(super) async fn group_for(state: &AppState, channel_id: &str, user_id: &str) -> ApiResult<Value> {
    let (group_id, epoch): (String, i64) =
        sqlx::query_as("SELECT group_id, epoch FROM voice_e2ee_groups WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_optional(&state.pool)
            .await?
            .ok_or_else(|| ApiError::Conflict("this call has no encryption group".into()))?;
    let member: Option<i64> = sqlx::query_scalar(
        "SELECT e2ee_member FROM voice_states WHERE channel_id = ? AND user_id = ?",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(json!({ "group_id": group_id, "epoch": epoch, "member": member == Some(1) }))
}

pub(crate) async fn settle_group(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
    joiner: Option<&str>,
) -> ApiResult<()> {
    // Take the write lock before the count (SQLITE_BUSY_SNAPSHOT).
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM voice_states WHERE channel_id = ? AND e2ee_member = 1",
    )
    .bind(channel_id)
    .fetch_one(&mut *tx)
    .await?;
    if members > 0 {
        drop(tx);
        elect(state, guild_id, channel_id).await?;
        return Ok(());
    }
    let exists: Option<String> =
        sqlx::query_scalar("SELECT group_id FROM voice_e2ee_groups WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_optional(&mut *tx)
            .await?;
    if exists.is_none() && joiner.is_none() {
        return Ok(());
    }
    let founder: Option<String> = sqlx::query_scalar(
        "SELECT user_id FROM voice_states WHERE channel_id = ? AND e2ee_package IS NOT NULL \
         ORDER BY joined_at, user_id LIMIT 1",
    )
    .bind(channel_id)
    .fetch_optional(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM voice_e2ee_log WHERE channel_id = ?")
        .bind(channel_id)
        .execute(&mut *tx)
        .await?;
    let Some(founder) = founder else {
        sqlx::query("DELETE FROM voice_e2ee_groups WHERE channel_id = ?")
            .bind(channel_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(());
    };
    let group_id = ulid();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO voice_e2ee_groups (channel_id, group_id, epoch, updated_at, committer, committer_at) \
         VALUES (?, ?, 0, ?, ?, ?) \
         ON CONFLICT(channel_id) DO UPDATE SET group_id = excluded.group_id, epoch = 0, \
             updated_at = excluded.updated_at, committer = excluded.committer, \
             committer_at = excluded.committer_at",
    )
    .bind(channel_id)
    .bind(&group_id)
    .bind(now)
    .bind(&founder)
    .bind(now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE voice_states SET e2ee_member = 1 WHERE channel_id = ? AND user_id = ?")
        .bind(channel_id)
        .bind(&founder)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    announce(
        state,
        guild_id,
        channel_id,
        json!({ "op": "reset", "channel_id": channel_id, "group_id": group_id, "epoch": 0, "founder": founder }),
    )
    .await?;
    if joiner != Some(founder.as_str()) {
        publish_state(state, guild_id, channel_id, &founder).await?;
    }
    Ok(())
}

pub const COMMITTER_SILENT_MS: i64 = 8000;

const E2EE_LOG_KEEP: i64 = 256;

pub(crate) async fn elect(
    state: &AppState,
    guild_id: &str,
    channel_id: &str,
) -> ApiResult<Option<String>> {
    let now = now_ms();
    let mut tx = state.pool.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT group_id, committer, committer_at, updated_at FROM voice_e2ee_groups \
         WHERE channel_id = ?",
    )
    .bind(channel_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((group_id, current, named_at, moved_at)) = row else { return Ok(None) };
    let members: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM voice_states WHERE channel_id = ? AND e2ee_member = 1 \
         ORDER BY joined_at, user_id",
    )
    .bind(channel_id)
    .fetch_all(&mut *tx)
    .await?;
    if members.is_empty() {
        return Ok(None);
    }
    let next = match current.filter(|c| members.contains(c)) {
        Some(holder) => {
            let waiting: Option<i64> = sqlx::query_scalar(
                "SELECT MIN(e2ee_offered_at) FROM voice_states WHERE channel_id = ? \
                 AND e2ee_member = 0 AND e2ee_package IS NOT NULL AND e2ee_refused = 0",
            )
            .bind(channel_id)
            .fetch_one(&mut *tx)
            .await?;
            let quiet = match waiting {
                Some(since) => now - since.max(named_at).max(moved_at) >= COMMITTER_SILENT_MS,
                None => false,
            };
            if !quiet || members.len() < 2 {
                return Ok(Some(holder));
            }
            let at = members.iter().position(|m| *m == holder).unwrap_or(0);
            members[(at + 1) % members.len()].clone()
        }
        None => members[0].clone(),
    };
    sqlx::query("UPDATE voice_e2ee_groups SET committer = ?, committer_at = ? WHERE channel_id = ?")
        .bind(&next)
        .bind(now)
        .bind(channel_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    announce(
        state,
        guild_id,
        channel_id,
        json!({ "op": "committer", "channel_id": channel_id, "group_id": group_id, "committer": next }),
    )
    .await?;
    Ok(Some(next))
}

async fn announce(state: &AppState, guild_id: &str, channel_id: &str, data: Value) -> ApiResult<()> {
    let here: Vec<String> = sqlx::query_scalar("SELECT user_id FROM voice_states WHERE channel_id = ?")
        .bind(channel_id)
        .fetch_all(&state.pool)
        .await?;
    for user in here {
        state
            .hub
            .publish(
                Event {
                    t: "VOICE_E2EE",
                    guild_id: guild_id.to_string(),
                    channel_id: Some(channel_id.to_string()),
                    intent: INTENT_GUILD_VOICE_STATES,
                    only_user: Some(user),
                    data: data.clone(),
                }
                .into(),
            )
            .await;
    }
    Ok(())
}

async fn in_call(state: &AppState, channel_id: &str, user_id: &str) -> ApiResult<bool> {
    let member: Option<i64> = sqlx::query_scalar(
        "SELECT e2ee_member FROM voice_states WHERE channel_id = ? AND user_id = ?",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    member
        .map(|m| m == 1)
        .ok_or_else(|| ApiError::Conflict("you are not connected to that channel".into()))
}

pub async fn e2ee_state(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    in_call(&state, &channel_id, &auth.user_id).await?;
    let committer = elect(&state, &ctx.guild_id, &channel_id).await?;
    let mut group = group_for(&state, &channel_id, &auth.user_id).await?;
    group["committer"] = json!(committer);
    let rows: Vec<(String, String, i64, Option<String>, i64)> = sqlx::query_as(
        "SELECT user_id, device_id, e2ee_member, e2ee_package, e2ee_refused FROM voice_states \
         WHERE channel_id = ? ORDER BY joined_at, user_id",
    )
    .bind(&channel_id)
    .fetch_all(&state.pool)
    .await?;
    let mine = rows.iter().find(|r| r.0 == auth.user_id);
    group["standing"] = json!(match mine {
        Some(r) if r.2 == 1 => "member",
        Some(r) if r.4 == 1 => "refused",
        _ => "pending",
    });
    group["participants"] = rows
        .into_iter()
        .map(|(user_id, device_id, member, package, refused)| {
            json!({
                "user_id": user_id,
                "device_id": device_id,
                "member": member == 1,
                "refused": refused == 1,
                "key_package": if member == 1 || refused == 1 { None } else { package },
            })
        })
        .collect();
    Ok(Json(group))
}

#[derive(Deserialize)]
pub struct Added {
    pub user_id: String,
    pub key_package: String,
}

#[derive(Deserialize)]
pub struct E2eeCommit {
    pub group_id: String,
    pub epoch: i64,
    pub commit: String,
    #[serde(default)]
    pub welcome: Option<String>,
    #[serde(default)]
    pub added: Vec<Added>,
}

pub async fn e2ee_commit(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<E2eeCommit>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if !in_call(&state, &channel_id, &auth.user_id).await? {
        return Err(ApiError::Forbidden(
            "only a device already holding this call's key can change who holds it".into(),
        ));
    }
    if req.commit.len() + req.welcome.as_ref().map_or(0, String::len) > MAX_HANDSHAKE {
        return Err(ApiError::BadRequest("that commit is too large".into()));
    }
    if let Some(committer) = elect(&state, &ctx.guild_id, &channel_id).await? {
        if committer != auth.user_id {
            return Err(ApiError::Conflict("somebody else writes this call's next commit".into())
                .with_code(crate::errcodes::NOT_COMMITTER)
                .with_detail("committer", committer));
        }
    }
    let mut tx = state.pool.begin().await?;
    let moved = sqlx::query(
        "UPDATE voice_e2ee_groups SET epoch = epoch + 1, updated_at = ? \
         WHERE channel_id = ? AND group_id = ? AND epoch = ?",
    )
    .bind(now_ms())
    .bind(&channel_id)
    .bind(&req.group_id)
    .bind(req.epoch)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if moved == 0 {
        return Err(ApiError::Conflict("the call's encryption group has moved on".into()));
    }
    let mut added = Vec::new();
    for a in &req.added {
        let marked = sqlx::query(
            "UPDATE voice_states SET e2ee_member = 1 \
             WHERE channel_id = ? AND user_id = ? AND e2ee_package = ? AND e2ee_member = 0",
        )
        .bind(&channel_id)
        .bind(&a.user_id)
        .bind(&a.key_package)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if marked > 0 {
            added.push(a.user_id.clone());
        }
    }
    let epoch = req.epoch + 1;
    sqlx::query(
        "INSERT OR REPLACE INTO voice_e2ee_log (channel_id, group_id, epoch, commit_msg, welcome, \
         added, committed_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&channel_id)
    .bind(&req.group_id)
    .bind(epoch)
    .bind(&req.commit)
    .bind(&req.welcome)
    .bind(json!(added).to_string())
    .bind(&auth.user_id)
    .bind(now_ms())
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "DELETE FROM voice_e2ee_log WHERE channel_id = ? AND (group_id != ? OR epoch <= ?)",
    )
    .bind(&channel_id)
    .bind(&req.group_id)
    .bind(epoch - E2EE_LOG_KEEP)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    announce(
        &state,
        &ctx.guild_id,
        &channel_id,
        json!({
            "op": "commit", "channel_id": channel_id, "group_id": req.group_id, "epoch": epoch,
            "commit": req.commit, "welcome": req.welcome, "added": added, "by": auth.user_id,
        }),
    )
    .await?;
    for user in &added {
        publish_state(&state, &ctx.guild_id, &channel_id, user).await?;
    }
    Ok(Json(json!({ "epoch": epoch, "added": added })))
}

#[derive(Deserialize)]
pub struct CommitsSince {
    #[serde(default)]
    pub since: i64,
}

pub async fn e2ee_commits(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<CommitsSince>,
) -> ApiResult<Json<Value>> {
    voice_channel(&state, &channel_id, &auth.user_id).await?;
    in_call(&state, &channel_id, &auth.user_id).await?;
    let group = group_for(&state, &channel_id, &auth.user_id).await?;
    let group_id = group["group_id"].as_str().unwrap_or_default().to_string();
    let rows: Vec<(i64, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT epoch, commit_msg, welcome, added, committed_by FROM voice_e2ee_log \
         WHERE channel_id = ? AND group_id = ? AND epoch > ? ORDER BY epoch LIMIT ?",
    )
    .bind(&channel_id)
    .bind(&group_id)
    .bind(q.since)
    .bind(E2EE_LOG_KEEP)
    .fetch_all(&state.pool)
    .await?;
    let oldest: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(epoch) FROM voice_e2ee_log WHERE channel_id = ? AND group_id = ?",
    )
    .bind(&channel_id)
    .bind(&group_id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({
        "group_id": group_id,
        "epoch": group["epoch"],
        "oldest": oldest,
        "commits": rows.into_iter().map(|(epoch, commit, welcome, added, by)| json!({
            "op": "commit", "channel_id": channel_id, "group_id": group_id, "epoch": epoch,
            "commit": commit, "welcome": welcome,
            "added": serde_json::from_str::<Value>(&added).unwrap_or_else(|_| json!([])),
            "by": by,
        })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct Refuse {
    pub user_id: String,
    pub key_package: String,
}

pub async fn e2ee_refuse(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(channel_id): Path<String>,
    Json(req): Json<Refuse>,
) -> ApiResult<Json<Value>> {
    let ctx = voice_channel(&state, &channel_id, &auth.user_id).await?;
    if !in_call(&state, &channel_id, &auth.user_id).await? {
        return Err(ApiError::Forbidden("only a member of the call's group can refuse a package".into()));
    }
    if let Some(committer) = elect(&state, &ctx.guild_id, &channel_id).await? {
        if committer != auth.user_id {
            return Err(ApiError::Conflict("somebody else writes this call's next commit".into())
                .with_code(crate::errcodes::NOT_COMMITTER)
                .with_detail("committer", committer));
        }
    }
    let marked = sqlx::query(
        "UPDATE voice_states SET e2ee_refused = 1 WHERE channel_id = ? AND user_id = ? \
         AND e2ee_package = ? AND e2ee_member = 0",
    )
    .bind(&channel_id)
    .bind(&req.user_id)
    .bind(&req.key_package)
    .execute(&state.pool)
    .await?
    .rows_affected();
    if marked > 0 {
        announce(
            &state,
            &ctx.guild_id,
            &channel_id,
            json!({ "op": "refused", "channel_id": channel_id, "user_id": req.user_id }),
        )
        .await?;
    }
    Ok(Json(json!({ "refused": marked > 0 })))
}
