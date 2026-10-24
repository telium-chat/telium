use super::*;

const MAX_NOTIFICATION_OUTBOX_ATTEMPTS: i64 = 40;
const NOTIFICATION_OUTBOX_BATCH: i64 = 256;
const NOTIFICATION_OUTBOX_ERROR_RETRY_MS: u64 = 5_000;
const BROADCAST_EXPANSION_PAGE: i64 = 256;
const BROADCAST_PENDING_WINDOW: i64 = 2_048;
const BROADCAST_BACKPRESSURE_MS: i64 = 500;
const NOTIFICATION_FEDERATION_CONCURRENCY: usize = 8;
const BROADCAST_OUTBOX_RECIPIENT: &str = "@everyone";
const BROADCAST_OUTBOX_KIND: &str = "broadcast";

static NOTIFICATION_OUTBOX_WORKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

pub(super) async fn queue_broadcast_notification(
    state: &AppState,
    source: &NotificationSource,
    exclude_user_ids: Vec<String>,
) -> ApiResult<()> {
    let payload = serde_json::to_string(&BroadcastNotificationJob {
        source: source.clone(),
        after_user_id: None,
        exclude_user_ids,
    })
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("broadcast notification payload: {e}")))?;
    let now = now_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO notification_outbox \
         (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(BROADCAST_OUTBOX_RECIPIENT)
    .bind(&state.cfg.server_name)
    .bind(&source.guild_id)
    .bind(&source.id)
    .bind(BROADCAST_OUTBOX_KIND)
    .bind(payload)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;
    spawn_notification_outbox(state.clone());
    Ok(())
}

async fn expand_broadcast_notification(
    state: &AppState,
    outbox_id: &str,
    payload: &str,
) -> ApiResult<u64> {
    let mut job: BroadcastNotificationJob = serde_json::from_str(payload)
        .map_err(|e| ApiError::BadRequest(format!("malformed broadcast notification job: {e}")))?;

    if crate::guildstore::moved_to(state, &job.source.guild_id).await?.is_some() {
        sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
            .bind(outbox_id)
            .execute(&state.pool)
            .await?;
        return Ok(1);
    }

    let pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM notification_outbox \
         WHERE guild_id = ? AND source_id = ? AND kind IN ('mention', 'reply')",
    )
    .bind(&job.source.guild_id)
    .bind(&job.source.id)
    .fetch_one(&state.pool)
    .await?;
    if pending >= BROADCAST_PENDING_WINDOW {
        sqlx::query(
            "UPDATE notification_outbox SET next_attempt_at = ? WHERE id = ?",
        )
        .bind(now_ms() + BROADCAST_BACKPRESSURE_MS)
        .bind(outbox_id)
        .execute(&state.pool)
        .await?;
        return Ok(1);
    }

    let scan_limit = BROADCAST_EXPANSION_PAGE + 1;
    let mut members: Vec<String> = if let Some(after) = job.after_user_id.as_deref() {
        sqlx::query_scalar(
            "SELECT user_id FROM members \
             WHERE guild_id = ? AND banned = 0 AND joined_at <= ? AND user_id > ? \
             ORDER BY user_id LIMIT ?",
        )
        .bind(&job.source.guild_id)
        .bind(job.source.created_at)
        .bind(after)
        .bind(scan_limit)
        .fetch_all(&state.pool)
        .await?
    } else {
        sqlx::query_scalar(
            "SELECT user_id FROM members \
             WHERE guild_id = ? AND banned = 0 AND joined_at <= ? \
             ORDER BY user_id LIMIT ?",
        )
        .bind(&job.source.guild_id)
        .bind(job.source.created_at)
        .bind(scan_limit)
        .fetch_all(&state.pool)
        .await?
    };

    if members.is_empty() {
        sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
            .bind(outbox_id)
            .execute(&state.pool)
            .await?;
        return Ok(1);
    }

    let has_more = members.len() > BROADCAST_EXPANSION_PAGE as usize;
    if has_more {
        members.truncate(BROADCAST_EXPANSION_PAGE as usize);
    }
    let next_cursor = members.last().cloned();
    let excluded: HashSet<&str> = job.exclude_user_ids.iter().map(String::as_str).collect();
    let source_payload = serde_json::to_string(&job.source)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("notification outbox payload: {e}")))?;
    let now = now_ms();

    let mut ready = Vec::new();
    for user_id in members {
        if excluded.contains(user_id.as_str()) {
            continue;
        }
        if !recipient_allows_background_notification(state, &job.source, &user_id).await {
            continue;
        }
        let Some(destination) = crate::federation::domain_of(&user_id).map(str::to_string) else {
            continue;
        };
        if destination != state.cfg.server_name && !state.cfg.federation.enabled {
            continue;
        }
        ready.push((user_id, destination));
    }

    let mut tx = state.pool.begin().await?;
    for (user_id, destination) in ready {
        sqlx::query(
            "INSERT OR IGNORE INTO notification_outbox \
             (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
             VALUES (?, ?, ?, ?, ?, 'mention', ?, ?, ?)",
        )
        .bind(ulid())
        .bind(user_id)
        .bind(destination)
        .bind(&job.source.guild_id)
        .bind(&job.source.id)
        .bind(&source_payload)
        .bind(now)
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }

    if has_more {
        job.after_user_id = next_cursor;
        let payload = serde_json::to_string(&job)
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("broadcast notification payload: {e}")))?;
        sqlx::query(
            "UPDATE notification_outbox SET payload = ?, next_attempt_at = ?, attempts = 0, last_error = NULL \
             WHERE id = ?",
        )
        .bind(payload)
        .bind(now)
        .bind(outbox_id)
        .execute(&mut *tx)
        .await?;
    } else {
        sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
            .bind(outbox_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(1)
}

fn notification_worker_key(state: &AppState) -> String {
    format!("{}|{}", state.cfg.server_name, state.cfg.database_url)
}

fn remove_notification_worker(key: &str) {
    if let Some(workers) = NOTIFICATION_OUTBOX_WORKERS.get() {
        if let Ok(mut workers) = workers.lock() {
            workers.remove(key);
        }
    }
}

pub fn spawn_notification_outbox(state: AppState) {
    if !state.cfg.roles.guild {
        return;
    }
    let key = notification_worker_key(&state);
    let workers = NOTIFICATION_OUTBOX_WORKERS.get_or_init(|| Mutex::new(HashSet::new()));
    let Ok(mut workers) = workers.lock() else { return };
    if !workers.insert(key.clone()) {
        return;
    }
    drop(workers);

    tokio::spawn(async move {
        loop {
            match flush_notification_outbox(&state).await {
                Ok(processed) if processed > 0 => continue,
                Ok(_) => {
                    let next: Result<Option<i64>, _> = sqlx::query_scalar(
                        "SELECT MIN(next_attempt_at) FROM notification_outbox",
                    )
                    .fetch_one(&state.pool)
                    .await;
                    let Ok(next) = next else {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            NOTIFICATION_OUTBOX_ERROR_RETRY_MS,
                        ))
                        .await;
                        continue;
                    };
                    let Some(next) = next else { break };
                    let wait_ms = (next - now_ms()).clamp(50, 60_000) as u64;
                    tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                }
                Err(error) => {
                    tracing::warn!(target: crate::logcat::PUSH, %error, "notification outbox flush failed");
                    tokio::time::sleep(std::time::Duration::from_millis(
                        NOTIFICATION_OUTBOX_ERROR_RETRY_MS,
                    ))
                    .await;
                }
            }
        }

        // Drop the active marker before the final recheck so a concurrent insert is seen.
        remove_notification_worker(&key);
        match sqlx::query_scalar::<_, i64>("SELECT 1 FROM notification_outbox LIMIT 1")
            .fetch_optional(&state.pool)
            .await
        {
            Ok(Some(_)) => spawn_notification_outbox(state),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(target: crate::logcat::PUSH, %error, "could not recheck notification outbox after worker exit");
                tokio::time::sleep(std::time::Duration::from_millis(
                    NOTIFICATION_OUTBOX_ERROR_RETRY_MS,
                ))
                .await;
                spawn_notification_outbox(state);
            }
        }
    });
}

#[derive(Clone, Debug)]
struct NotificationOutboxRow {
    id: String,
    recipient_id: String,
    destination: String,
    guild_id: String,
    source_id: String,
    kind: String,
    source: NotificationSource,
    attempts: i64,
}

pub(super) async fn queue_remote_notification(
    state: &AppState,
    user_id: &str,
    source: &NotificationSource,
    kind: &str,
) -> ApiResult<()> {
    let Some(destination) = crate::federation::domain_of(user_id).map(str::to_string) else {
        return Err(ApiError::BadRequest("notification recipient id has no homeserver".into()));
    };
    if destination == state.cfg.server_name {
        return deliver_private_notification(state, user_id, source, kind).await;
    }
    if !state.cfg.federation.enabled {
        return Ok(());
    }

    let payload = serde_json::to_string(source)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("notification outbox payload: {e}")))?;
    let now = now_ms();
    sqlx::query(
        "INSERT OR IGNORE INTO notification_outbox \
         (id, recipient_id, destination, guild_id, source_id, kind, payload, next_attempt_at, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(ulid())
    .bind(user_id)
    .bind(&destination)
    .bind(&source.guild_id)
    .bind(&source.id)
    .bind(kind)
    .bind(payload)
    .bind(now)
    .bind(now)
    .execute(&state.pool)
    .await?;

    spawn_notification_outbox(state.clone());
    Ok(())
}

async fn delete_outbox_rows(state: &AppState, rows: &[NotificationOutboxRow]) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    for row in rows {
        sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
            .bind(&row.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn fail_outbox_rows(
    state: &AppState,
    rows: &[NotificationOutboxRow],
    error: String,
) -> ApiResult<()> {
    let mut tx = state.pool.begin().await?;
    for row in rows {
        let attempts = row.attempts + 1;
        if attempts > MAX_NOTIFICATION_OUTBOX_ATTEMPTS {
            tracing::warn!(
                target: crate::logcat::PUSH,
                outbox_id = %row.id,
                recipient_id = %row.recipient_id,
                destination = %row.destination,
                source_id = %row.source_id,
                error = %error,
                "dropping undeliverable notification federation job"
            );
            sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
                .bind(&row.id)
                .execute(&mut *tx)
                .await?;
            continue;
        }
        let base_ms = state.cfg.federation.dm_retry_secs.max(1) as i64 * 1000;
        let backoff = base_ms * (1i64 << attempts.min(10));
        sqlx::query(
            "UPDATE notification_outbox SET attempts = ?, next_attempt_at = ?, last_error = ? \
             WHERE id = ?",
        )
        .bind(attempts)
        .bind(now_ms() + backoff)
        .bind(&error)
        .bind(&row.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn deliver_remote_notification_batch_legacy(
    state: &AppState,
    rows: &[NotificationOutboxRow],
) -> ApiResult<()> {
    for row in rows {
        deliver_private_notification(
            state,
            &row.recipient_id,
            &row.source,
            &row.kind,
        )
        .await?;
    }
    Ok(())
}

async fn deliver_remote_notification_batch(
    state: &AppState,
    destination: &str,
    rows: &[NotificationOutboxRow],
) -> ApiResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    if destination == state.cfg.server_name {
        return Err(ApiError::BadRequest(
            "local notification row entered remote batch delivery".into(),
        ));
    }
    if !state.cfg.federation.enabled {
        return Err(ApiError::TryAgain("federation is disabled".into()));
    }

    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for row in rows {
        let key = format!("{}\0{}", row.recipient_id, row.guild_id);
        if seen.insert(key) {
            targets.push(json!({
                "user_id": row.recipient_id,
                "guild_id": row.guild_id,
            }));
        }
    }

    let key_reply = match crate::federation::post_signed(
        state,
        destination,
        "/_telium/v1/notifications/keys/batch",
        &json!({ "targets": targets }),
    )
    .await
    {
        Ok(reply) => reply,
        Err(ApiError::NotFound(_)) => {
            tracing::info!(
                target: crate::logcat::PUSH,
                %destination,
                "notification peer has no batch key endpoint; using per-user federation"
            );
            return deliver_remote_notification_batch_legacy(state, rows).await;
        }
        Err(error) => return Err(error),
    };

    let mut keys: HashMap<(String, String), Vec<DeviceKey>> = HashMap::new();
    for target in key_reply
        .get("targets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(user_id) = target.get("user_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(guild_id) = target.get("guild_id").and_then(Value::as_str) else {
            continue;
        };
        let devices = target
            .get("devices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| serde_json::from_value::<DeviceKey>(value.clone()).ok())
            .collect::<Vec<_>>();
        keys.insert((user_id.to_string(), guild_id.to_string()), devices);
    }

    let mut descriptors: HashMap<(String, String, String), Vec<u8>> = HashMap::new();
    let mut items = Vec::new();
    let mut envelope_count = 0usize;
    for row in rows {
        let devices = keys
            .get(&(row.recipient_id.clone(), row.guild_id.clone()))
            .cloned()
            .unwrap_or_default();
        if devices.is_empty() {
            continue;
        }

        let descriptor_key = (
            row.guild_id.clone(),
            row.source_id.clone(),
            row.kind.clone(),
        );
        let plaintext = if let Some(cached) = descriptors.get(&descriptor_key) {
            cached.clone()
        } else {
            let built = notification_descriptor(state, &row.source, &row.kind).await?;
            descriptors.insert(descriptor_key, built.clone());
            built
        };

        let mut envelopes = Vec::new();
        for device in devices {
            if device.algorithm != notifications::ALGORITHM_V1 {
                continue;
            }
            let associated_data = notifications::aad(
                &row.recipient_id,
                &device.device_id,
                &state.cfg.server_name,
                &row.source_id,
                Some(&row.guild_id),
                &row.kind,
            );
            let sealed = notifications::seal_descriptor(
                &device.public_key,
                &associated_data,
                &plaintext,
            )?;
            envelopes.push(json!({
                "device_id": device.device_id,
                "ciphertext": serde_json::to_value(sealed).map_err(|e| {
                    ApiError::Internal(anyhow::anyhow!("notification envelope: {e}"))
                })?,
            }));
        }
        if envelopes.is_empty() {
            continue;
        }

        if !items.is_empty()
            && envelope_count + envelopes.len() > FEDERATED_NOTIFICATION_BATCH_ENVELOPES
        {
            match crate::federation::post_signed(
                state,
                destination,
                "/_telium/v1/notifications/batch",
                &json!({ "items": items }),
            )
            .await
            {
                Ok(_) => {}
                Err(ApiError::NotFound(_)) => {
                    tracing::info!(
                        target: crate::logcat::PUSH,
                        %destination,
                        "notification peer has no batch delivery endpoint; using per-user federation"
                    );
                    return deliver_remote_notification_batch_legacy(state, rows).await;
                }
                Err(error) => return Err(error),
            }
            items = Vec::new();
            envelope_count = 0;
        }
        envelope_count += envelopes.len();
        items.push(json!({
            "user_id": row.recipient_id,
            "guild_id": row.guild_id,
            "source_id": row.source_id,
            "kind": row.kind,
            "bucket": notification_bucket(&row.source),
            "envelopes": envelopes,
        }));
    }

    if !items.is_empty() {
        match crate::federation::post_signed(
            state,
            destination,
            "/_telium/v1/notifications/batch",
            &json!({ "items": items }),
        )
        .await
        {
            Ok(_) => {}
            Err(ApiError::NotFound(_)) => {
                tracing::info!(
                    target: crate::logcat::PUSH,
                    %destination,
                    "notification peer has no batch delivery endpoint; using per-user federation"
                );
                return deliver_remote_notification_batch_legacy(state, rows).await;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

async fn process_remote_notification_destination(
    state: AppState,
    destination: String,
    rows: Vec<NotificationOutboxRow>,
) -> ApiResult<u64> {
    let mut processed = 0u64;
    for batch in rows.chunks(FEDERATED_NOTIFICATION_BATCH_RECIPIENTS) {
        match deliver_remote_notification_batch(&state, &destination, batch).await {
            Ok(()) => delete_outbox_rows(&state, batch).await?,
            Err(error) => {
                tracing::warn!(
                    target: crate::logcat::PUSH,
                    %destination,
                    recipients = batch.len(),
                    error = %error,
                    "batched notification federation delivery failed"
                );
                fail_outbox_rows(&state, batch, error.to_string()).await?;
            }
        }
        processed += batch.len() as u64;
    }
    Ok(processed)
}

pub async fn flush_notification_outbox(state: &AppState) -> ApiResult<u64> {
    let now = now_ms();
    let _ = sqlx::query("DELETE FROM notification_outbox WHERE created_at <= ?")
        .bind(now - notifications::DEFAULT_RETENTION_MS)
        .execute(&state.pool)
        .await;

    let due: Vec<(String, String, String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, recipient_id, destination, guild_id, source_id, kind, payload, attempts \
         FROM notification_outbox WHERE next_attempt_at <= ? \
         ORDER BY created_at LIMIT ?",
    )
    .bind(now)
    .bind(NOTIFICATION_OUTBOX_BATCH)
    .fetch_all(&state.pool)
    .await?;

    let mut processed = 0u64;
    let mut remote: HashMap<String, Vec<NotificationOutboxRow>> = HashMap::new();

    for (id, recipient_id, destination, guild_id, source_id, kind, payload, attempts) in due {
        if kind == BROADCAST_OUTBOX_KIND
            && recipient_id == BROADCAST_OUTBOX_RECIPIENT
            && destination == state.cfg.server_name
        {
            match expand_broadcast_notification(state, &id, &payload).await {
                Ok(done) => processed += done,
                Err(error) => {
                    tracing::warn!(target: crate::logcat::PUSH, outbox_id = %id, %error, "notification broadcast expansion failed");
                    let source = serde_json::from_str::<BroadcastNotificationJob>(&payload)
                        .map(|job| job.source)
                        .unwrap_or(NotificationSource {
                            id: source_id.clone(),
                            guild_id: guild_id.clone(),
                            channel_id: String::new(),
                            author_id: String::new(),
                            content: String::new(),
                            has_attachment: false,
                            has_sticker: false,
                            created_at: now,
                        });
                    let row = NotificationOutboxRow {
                        id,
                        recipient_id,
                        destination,
                        guild_id,
                        source_id,
                        kind,
                        source,
                        attempts,
                    };
                    fail_outbox_rows(state, &[row], error.to_string()).await?;
                    processed += 1;
                }
            }
            continue;
        }

        let source: NotificationSource = match serde_json::from_str(&payload) {
            Ok(source) => source,
            Err(error) => {
                tracing::warn!(target: crate::logcat::PUSH, outbox_id = %id, %error, "dropping malformed notification outbox row");
                sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
                    .bind(&id)
                    .execute(&state.pool)
                    .await?;
                processed += 1;
                continue;
            }
        };
        let expected_home = crate::federation::domain_of(&recipient_id);
        if !matches!(kind.as_str(), "mention" | "reply")
            || source.id != source_id
            || source.guild_id != guild_id
            || expected_home != Some(destination.as_str())
        {
            tracing::warn!(target: crate::logcat::PUSH, outbox_id = %id, "dropping inconsistent notification outbox row");
            sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
                .bind(&id)
                .execute(&state.pool)
                .await?;
            processed += 1;
            continue;
        }

        if crate::guildstore::moved_to(state, &guild_id).await?.is_some() {
            tracing::info!(
                target: crate::logcat::PUSH,
                outbox_id = %id,
                %guild_id,
                "dropping notification retry after guild authority moved"
            );
            sqlx::query("DELETE FROM notification_outbox WHERE id = ?")
                .bind(&id)
                .execute(&state.pool)
                .await?;
            processed += 1;
            continue;
        }

        let row = NotificationOutboxRow {
            id,
            recipient_id,
            destination: destination.clone(),
            guild_id,
            source_id,
            kind,
            source,
            attempts,
        };

        if destination == state.cfg.server_name {
            let result = deliver_private_notification(
                state,
                &row.recipient_id,
                &row.source,
                &row.kind,
            )
            .await;
            match result {
                Ok(()) => {
                    wake(
                        state,
                        &row.recipient_id,
                        &row.guild_id,
                        &row.source.channel_id,
                    )
                    .await;
                    delete_outbox_rows(state, std::slice::from_ref(&row)).await?;
                }
                Err(error) => {
                    fail_outbox_rows(state, std::slice::from_ref(&row), error.to_string()).await?;
                }
            }
            processed += 1;
        } else {
            remote.entry(destination).or_default().push(row);
        }
    }

    let destinations = remote.into_iter().collect::<Vec<_>>();
    for wave in destinations.chunks(NOTIFICATION_FEDERATION_CONCURRENCY) {
        let mut tasks = tokio::task::JoinSet::new();
        for (destination, rows) in wave {
            let state = state.clone();
            let destination = destination.clone();
            let rows = rows.clone();
            tasks.spawn(async move {
                process_remote_notification_destination(state, destination, rows).await
            });
        }
        while let Some(result) = tasks.join_next().await {
            let count = result
                .map_err(|error| {
                    ApiError::Internal(anyhow::anyhow!(
                        "notification federation worker task failed: {error}"
                    ))
                })??;
            processed += count;
        }
    }

    Ok(processed)
}
