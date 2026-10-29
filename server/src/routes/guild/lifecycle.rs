use crate::auth::{GuildAuth, HomeAuth};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::gateway::events::{Event, INTENT_GUILD_STRUCTURE};
use crate::guildstore;
use crate::state::AppState;
use crate::util::now_ms;
use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};
use super::moved_guild_stub;

pub async fn delete_guild(
    State(state): State<AppState>,
    auth: GuildAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    let owner = guildstore::guild_owner(&state.pool, &guild_id).await?;
    if owner != auth.user_id {
        return Err(ApiError::Forbidden("only the owner can delete a guild".into()));
    }
    guildstore::ensure_authoritative(&state, &guild_id).await?;
    erase_guild(&state, &guild_id, true).await?;
    Ok(Json(json!({ "ok": true })))
}

pub async fn purge_moved_guild(
    State(state): State<AppState>,
    auth: HomeAuth,
    Path(guild_id): Path<String>,
) -> ApiResult<Json<Value>> {
    crate::admin::require_step_up(&state, &auth.user_id).await?;
    let Some(new_id) = guildstore::moved_to(&state, &guild_id).await? else {
        return Err(ApiError::Conflict(
            "that guild has not moved; its owner deletes it the ordinary way".into(),
        ));
    };
    let here: Option<String> = sqlx::query_scalar("SELECT id FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?;
    if here.is_none() {
        return Err(already_gone(false));
    }
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM guilds WHERE id = ?")
        .bind(&guild_id)
        .fetch_optional(&state.pool)
        .await?;
    let messages: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE guild_id = ?")
            .bind(&guild_id)
            .fetch_one(&state.pool)
            .await?;
    erase_guild(&state, &guild_id, false).await?;
    crate::admin::record(
        &state,
        &auth.user_id,
        "guild.purge",
        Some(&guild_id),
        json!({ "name": name, "messages": messages, "moved_to": new_id }),
    )
    .await;
    Ok(Json(json!({ "ok": true, "moved_to": new_id })))
}

const ALREADY_RECLAIMED: &str =
    "that guild's history has already been reclaimed; its forwarding address stands";

const ALREADY_DELETED: &str = "that guild has already been deleted";

fn already_gone(gravestone: bool) -> ApiError {
    ApiError::Conflict(if gravestone { ALREADY_DELETED } else { ALREADY_RECLAIMED }.into())
}

async fn erase_guild(state: &AppState, guild_id: &str, gravestone: bool) -> ApiResult<()> {
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM guilds WHERE id = ?")
        .bind(guild_id)
        .fetch_optional(&state.pool)
        .await?;
    let Some(name) = name else {
        return Err(already_gone(gravestone));
    };

    let calling: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM voice_states WHERE guild_id = ?")
            .bind(guild_id)
            .fetch_all(&state.pool)
            .await?;
    for user_id in &calling {
        crate::routes::voice::disconnect(state, guild_id, user_id).await?;
    }

    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT path FROM cold_segments WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "DELETE FROM channel_follows WHERE source_id IN (SELECT id FROM channels WHERE guild_id = ?) \
         OR target_id IN (SELECT id FROM channels WHERE guild_id = ?)",
    )
    .bind(guild_id)
    .bind(guild_id)
    .execute(&mut *tx)
    .await?;
    // Release the message references before the rows go. Cold-archived history
    // keeps its references: its segments are deleted below without ever being
    // read back for hashes, so those attachment rows stay (the conservative
    // direction — reclamation that does not happen, never a live file pulled).
    crate::routes::media::release_message_refs(&mut *tx, "messages.guild_id = ?", guild_id).await?;
    for sql in [
        "DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE guild_id = ?)",
        "DELETE FROM pins WHERE message_id IN (SELECT id FROM messages WHERE guild_id = ?)",
        "DELETE FROM message_mentions WHERE message_id IN (SELECT id FROM messages WHERE guild_id = ?)",
        "DELETE FROM messages WHERE guild_id = ?",
        "DELETE FROM channel_overwrites WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM read_state WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM cold_segments WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM voice_watchers WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM voice_e2ee_log WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM voice_e2ee_groups WHERE channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
        "DELETE FROM channels WHERE guild_id = ?",
        "DELETE FROM member_roles WHERE guild_id = ?",
        "DELETE FROM roles WHERE guild_id = ?",
        "DELETE FROM emojis WHERE guild_id = ?",
        "DELETE FROM stickers WHERE guild_id = ?",
        "DELETE FROM invites WHERE guild_id = ?",
        "DELETE FROM threads WHERE guild_id = ?",
        "DELETE FROM voice_states WHERE guild_id = ?",
        "DELETE FROM guild_voice_regions WHERE guild_id = ?",
        "DELETE FROM automod_hits WHERE guild_id = ?",
        "DELETE FROM automod_rules WHERE guild_id = ?",
        "DELETE FROM held_messages WHERE guild_id = ?",
        "DELETE FROM screening_answers WHERE guild_id = ?",
        "DELETE FROM guild_domain_rules WHERE guild_id = ?",
        "DELETE FROM guild_origin_rules WHERE guild_id = ?",
        "DELETE FROM media_vouchers WHERE guild_id = ?",
        "DELETE FROM audit_log WHERE guild_id = ?",
        "DELETE FROM messages_fts WHERE guild_id = ?",
        "DELETE FROM ephemeral_messages WHERE guild_id = ?",
        "DELETE FROM interactions WHERE guild_id = ?",
        "DELETE FROM notification_inbox WHERE guild_id = ?",
        "DELETE FROM notification_outbox WHERE guild_id = ?",
    ] {
        sqlx::query(sql).bind(guild_id).execute(&mut *tx).await?;
    }
    let claimed = sqlx::query("DELETE FROM guilds WHERE id = ?")
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;
    if claimed.rows_affected() == 0 {
        return Err(already_gone(gravestone));
    }
    if gravestone {
        sqlx::query("DELETE FROM members WHERE guild_id = ?")
            .bind(guild_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM remote_memberships WHERE guild_id = ?")
            .bind(guild_id)
            .execute(&mut *tx)
            .await?;
        crate::vanity::forget(&mut tx, guild_id).await?;
    }
    tx.commit().await?;

    if gravestone {
        let record = crypto::sign_json(
            &state.key,
            json!({
                "subject_type": "guild", "subject_id": guild_id, "kind": "gone",
                "name": name, "origin": state.cfg.server_name, "deleted_at": now_ms(),
            }),
        );
        sqlx::query(
            "INSERT INTO tombstones (subject_type, subject_id, kind, new_id, record, created_at) \
             VALUES ('guild', ?, 'gone', NULL, ?, ?) \
             ON CONFLICT (subject_type, subject_id) DO UPDATE SET \
             kind = excluded.kind, new_id = excluded.new_id, record = excluded.record, \
             created_at = excluded.created_at",
        )
        .bind(guild_id)
        .bind(record.to_string())
        .bind(now_ms())
        .execute(&state.pool)
        .await?;
    }

    let event = if gravestone {
        Event::new("GUILD_DELETE", guild_id.to_string(), INTENT_GUILD_STRUCTURE,
            json!({ "id": guild_id }))
    } else {
        let new_id = guildstore::moved_to(state, guild_id).await?.unwrap_or_default();
        Event::new("GUILD_UPDATE", guild_id.to_string(), INTENT_GUILD_STRUCTURE,
            moved_guild_stub(&state.cfg.server_name, guild_id, &new_id))
    };
    state.hub.publish(event).await;

    for path in segments {
        if let Err(e) = state.archive_store.delete(&path).await {
            tracing::warn!(target: crate::logcat::MEDIA, %path, error = %e, "could not remove an archive segment of a deleted guild");
        }
    }
    Ok(())
}
