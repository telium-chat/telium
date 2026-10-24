use super::{export_key_backup, int, portable_sync_store, text, BUNDLE_VERSION};
use crate::error::{ApiError, ApiResult};
use crate::rows;
use crate::state::AppState;
use crate::util::{b64, now_ms};
use serde_json::{json, Value};

pub async fn export_user(state: &AppState, user_id: &str) -> ApiResult<Value> {
    let account: Option<(String, i64, i64)> =
        sqlx::query_as("SELECT localpart, created_at, deactivated FROM accounts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let (localpart, created_at, _) =
        account.ok_or_else(|| ApiError::NotFound("no such account".into()))?;

    let profile = crate::routes::identity::load_profile(state, user_id).await?;

    let sync: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT key, value, updated_at FROM sync_store WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await?;
    let sync_store = portable_sync_store(sync);
    let sync_sealed = crate::routes::identity::sync_is_sealed(&state.pool, user_id).await?;
    let (key_backup, key_backup_omitted) = export_key_backup(state, user_id).await?;

    let media_preference: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT tier, origin FROM media_preferences WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.pool)
            .await?;
    let media_preference =
        media_preference.map(|(tier, origin)| json!({ "tier": tier, "origin": origin }));

    let devices: Vec<(String, String, String, i64)> = sqlx::query_as(
        "SELECT device_id, name, pubkey_b64, created_at FROM devices WHERE user_id = ? AND active = 1",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let devices: Vec<Value> = devices
        .into_iter()
        .map(|(id, name, pubkey, created)| {
            json!({ "device_id": id, "name": name, "pubkey": pubkey, "created_at": created })
        })
        .collect();

    let friends: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT peer_id, peer_domain, state, created_at, updated_at FROM friends \
         WHERE user_id = ? ORDER BY peer_id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let friends: Vec<Value> = friends
        .into_iter()
        .map(|(peer_id, peer_domain, state, created_at, updated_at)| {
            json!({
                "peer_id": peer_id,
                "peer_domain": peer_domain,
                "state": state,
                "created_at": created_at,
                "updated_at": updated_at,
            })
        })
        .collect();

    let explicit_requests: Vec<(String, String, String, i64, i64)> = sqlx::query_as(
        "SELECT conversation_id, sender_id, state, created_at, updated_at \
         FROM dm_message_requests WHERE user_id = ? ORDER BY conversation_id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    let mut message_requests: Vec<Value> = explicit_requests
        .into_iter()
        .map(|(conversation_id, sender_id, state, created_at, updated_at)| json!({
            "conversation_id": conversation_id,
            "sender_id": sender_id,
            "state": state,
            "created_at": created_at,
            "updated_at": updated_at,
        }))
        .collect();
    let ordinary_dms: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT c.id, peer.user_id, c.created_at, c.updated_at \
         FROM conversations c \
         JOIN conversation_members me \
           ON me.conversation_id = c.id AND me.user_id = ? AND me.state = 'active' \
         JOIN conversation_members peer \
           ON peer.conversation_id = c.id AND peer.user_id != ? AND peer.state = 'active' \
         LEFT JOIN dm_message_requests r \
           ON r.conversation_id = c.id AND r.user_id = ? \
         WHERE c.kind = 'dm' AND r.conversation_id IS NULL ORDER BY c.id",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    message_requests.extend(ordinary_dms.into_iter().map(
        |(conversation_id, sender_id, created_at, updated_at)| json!({
            "conversation_id": conversation_id,
            "sender_id": sender_id,
            "state": "accepted",
            "created_at": created_at,
            "updated_at": updated_at,
        }),
    ));
    message_requests.sort_by(|a, b| text(a, "conversation_id").cmp(text(b, "conversation_id")));

    let vault: Option<(String, String, Option<String>, i64, i64)> = sqlx::query_as(
        "SELECT mode, ciphertext, independent_ciphertext, version, updated_at \
         FROM key_vault WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let key_vault = vault.map(|(mode, ciphertext, independent, version, updated_at)| {
        json!({
            "mode": mode,
            "ciphertext": ciphertext,
            "independent_ciphertext": independent,
            "version": version,
            "updated_at": updated_at,
        })
    });

    #[allow(clippy::type_complexity)]
    let queued: Vec<(String, String, String, String, String, String, i64, i64, Option<String>, i64)> =
        sqlx::query_as(
            "SELECT o.id, o.conversation_id, o.message_id, o.destination, o.path, o.payload, \
             o.attempts, o.next_attempt_at, o.last_error, o.created_at \
             FROM dm_outbox o \
             JOIN conversation_members m ON m.conversation_id = o.conversation_id \
             WHERE m.user_id = ? AND m.state = 'active' ORDER BY o.created_at",
        )
        .bind(user_id)
        .fetch_all(&state.pool)
        .await?;
    let dm_outbox: Vec<Value> = queued
        .into_iter()
        .filter_map(
            |(id, conversation_id, message_id, destination, path, payload, attempts, next, error, created_at)| {
                let payload: Value = serde_json::from_str(&payload).ok()?;
                let sender = payload.pointer("/message/sender").and_then(Value::as_str)?;
                (sender == user_id).then(|| {
                    json!({
                        "id": id,
                        "conversation_id": conversation_id,
                        "message_id": message_id,
                        "destination": destination,
                        "path": path,
                        "payload": payload,
                        "attempts": attempts,
                        "next_attempt_at": next,
                        "last_error": error,
                        "created_at": created_at,
                    })
                })
            },
        )
        .collect();

    let memberships: Vec<String> =
        sqlx::query_scalar("SELECT guild_id FROM members WHERE user_id = ? AND banned = 0")
            .bind(user_id)
            .fetch_all(&state.pool)
            .await
            .unwrap_or_default();

    let chain: Option<(String, i64, String)> = sqlx::query_as(
        "SELECT previous_id, original_created_at, chain FROM imported_identities WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;
    let (original_created_at, chain) = match chain {
        Some((_, original, chain)) => (
            original,
            serde_json::from_str::<Value>(&chain).unwrap_or_else(|_| json!([])),
        ),
        None => (created_at, json!([])),
    };

    let (media, media_omitted) = user_media(state, user_id).await?;

    let remote_memberships = crate::memberships::export(state, user_id).await?;

    Ok(json!({
        "version": BUNDLE_VERSION,
        "kind": "user",
        "subject": user_id,
        "source": state.cfg.server_name,
        "localpart": localpart,
        "created_at": created_at,
        "original_created_at": original_created_at,
        "chain": chain,
        "profile": profile,
        "sync_store": sync_store,
        "sync_sealed": sync_sealed,
        "media_preference": media_preference,
        "devices": devices,
        "friends": friends,
        "message_requests": message_requests,
        "key_vault": key_vault,
        "key_backup": key_backup,
        "key_backup_omitted": key_backup_omitted,
        "dm_outbox": dm_outbox,
        "media": media,
        "media_omitted": media_omitted,
        "memberships": memberships,
        "remote_memberships": remote_memberships,
        "exported_at": now_ms(),
    }))
}

async fn archived_messages(state: &AppState, guild_id: &str) -> ApiResult<Vec<Value>> {
    let segments: Vec<String> = sqlx::query_scalar(
        "SELECT s.id FROM cold_segments s JOIN channels c ON c.id = s.channel_id \
         WHERE c.guild_id = ? ORDER BY s.first_id",
    )
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::new();
    for segment in segments {
        out.extend(crate::cold::read_segment(state, &segment).await?.iter().map(crate::cold::for_row));
    }
    Ok(out)
}

pub(super) fn expression_mime(claimed: &str) -> &'static str {
    match claimed {
        "image/gif" => "image/gif",
        "image/jpeg" => "image/jpeg",
        "image/webp" => "image/webp",
        "image/avif" => "image/avif",
        _ => "image/png",
    }
}

async fn expression_assets(state: &AppState, guild_id: &str) -> ApiResult<Vec<Value>> {
    let hashes: Vec<String> = sqlx::query_scalar(
        "SELECT media_hash FROM emojis WHERE guild_id = ? \
         UNION SELECT media_hash FROM stickers WHERE guild_id = ?",
    )
    .bind(guild_id)
    .bind(guild_id)
    .fetch_all(&state.pool)
    .await?;

    let mut out = Vec::new();
    for hash in hashes {
        let Some(media) = rows::all(&state.pool, "SELECT * FROM media WHERE hash = ?", &hash)
            .await?
            .into_iter()
            .next()
        else {
            continue;
        };
        let Ok(bytes) = state.media_store.get(&crate::routes::media::media_key(state, &hash)).await
        else {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, "expression asset has no bytes on disk; not migrating it");
            continue;
        };
        out.push(json!({ "media": media, "data": b64(&bytes) }));
    }
    Ok(out)
}

pub const USER_MEDIA_BUDGET_BYTES: usize = 96 * 1024 * 1024;

pub const MAX_USER_MEDIA_OBJECTS: usize = 10_000;

async fn user_media(state: &AppState, user_id: &str) -> ApiResult<(Vec<Value>, Vec<Value>)> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        String,
        String,
        String,
        i64,
        Option<i64>,
        Option<i64>,
        Option<String>,
        String,
        String,
        i64,
        Option<i64>,
    )> = sqlx::query_as(
        "SELECT hash, filename, mime, size, width, height, thumbhash, capability, purpose, \
         created_at, expires_at FROM media \
         WHERE owner_user_id = ? AND moved_to IS NULL \
         AND purpose IN ('attachment', 'profile', 'expression') \
         AND (expires_at IS NULL OR expires_at > ?) \
         AND hash NOT IN (SELECT media_hash FROM emojis UNION SELECT media_hash FROM stickers) \
         ORDER BY CASE purpose WHEN 'profile' THEN 0 ELSE 1 END, created_at DESC, hash",
    )
    .bind(user_id)
    .bind(now_ms())
    .fetch_all(&state.pool)
    .await?;

    let mut carried = Vec::new();
    let mut omitted = Vec::new();
    let mut budget = USER_MEDIA_BUDGET_BYTES;
    for (hash, filename, mime, size, width, height, thumbhash, capability, purpose, created_at, expires_at) in
        rows
    {
        let left_behind = json!({ "hash": hash, "size": size, "purpose": purpose });
        if carried.len() >= MAX_USER_MEDIA_OBJECTS {
            omitted.push(left_behind);
            continue;
        }
        let Ok(bytes) = state.media_store.get(&crate::routes::media::media_key(state, &hash)).await else {
            tracing::warn!(target: crate::logcat::MIGRATION, hash, user_id, "upload has no bytes on disk; not migrating it");
            continue;
        };
        if bytes.len() > budget {
            omitted.push(left_behind);
            continue;
        }
        budget -= bytes.len();
        carried.push(json!({
            "media": {
                "hash": hash,
                "filename": filename,
                "mime": mime,
                "size": bytes.len(),
                "width": width,
                "height": height,
                "thumbhash": thumbhash,
                "capability": capability,
                "purpose": purpose,
                "created_at": created_at,
                "expires_at": expires_at,
            },
            "data": b64(&bytes),
        }));
    }
    if !omitted.is_empty() {
        let bytes: i64 = omitted.iter().map(|o| int(o, "size", 0)).sum();
        tracing::warn!(
            target: crate::logcat::MIGRATION,
            user_id,
            count = omitted.len(),
            bytes,
            "uploads did not fit in the migration bundle; they stay on this origin and are not forwarded"
        );
    }
    Ok((carried, omitted))
}

pub async fn export_guild(state: &AppState, guild_id: &str) -> ApiResult<Value> {
    let pool = &state.pool;
    let guild = rows::all(pool, "SELECT * FROM guilds WHERE id = ?", guild_id)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::NotFound("guild not found".into()))?;

    Ok(json!({
        "version": BUNDLE_VERSION,
        "kind": "guild",
        "subject": guild_id,
        "source": state.cfg.server_name,
        "guild": guild,

        "channels": rows::all(pool, "SELECT * FROM channels WHERE guild_id = ? ORDER BY position, id", guild_id).await?,
        "roles": rows::all(pool, "SELECT * FROM roles WHERE guild_id = ? ORDER BY position, id", guild_id).await?,
        "threads": rows::all(pool, "SELECT * FROM threads WHERE guild_id = ? ORDER BY id", guild_id).await?,
        "emojis": rows::all(pool, "SELECT * FROM emojis WHERE guild_id = ? ORDER BY id", guild_id).await?,
        "stickers": rows::all(pool, "SELECT * FROM stickers WHERE guild_id = ? ORDER BY id", guild_id).await?,

        "members": rows::all(pool, "SELECT * FROM members WHERE guild_id = ? ORDER BY user_id", guild_id).await?,
        "member_roles": rows::all(pool, "SELECT * FROM member_roles WHERE guild_id = ? ORDER BY user_id, role_id", guild_id).await?,
        "overwrites": rows::all(pool,
            "SELECT o.* FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id \
             WHERE c.guild_id = ? ORDER BY o.channel_id, o.target_id", guild_id).await?,

        "messages": rows::all(pool, "SELECT * FROM messages WHERE guild_id = ? ORDER BY id", guild_id).await?,
        "reactions": rows::all(pool,
            "SELECT r.* FROM reactions r JOIN messages m ON m.id = r.message_id \
             WHERE m.guild_id = ? ORDER BY r.message_id, r.emoji, r.user_id", guild_id).await?,
        "mentions": rows::all(pool,
            "SELECT x.* FROM message_mentions x JOIN channels c ON c.id = x.channel_id \
             WHERE c.guild_id = ? ORDER BY x.message_id, x.user_id", guild_id).await?,
        "pins": rows::all(pool,
            "SELECT p.* FROM pins p JOIN channels c ON c.id = p.channel_id \
             WHERE c.guild_id = ? ORDER BY p.channel_id, p.message_id", guild_id).await?,
        "read_state": rows::all(pool,
            "SELECT r.* FROM read_state r JOIN channels c ON c.id = r.channel_id \
             WHERE c.guild_id = ? ORDER BY r.user_id, r.channel_id", guild_id).await?,
        "follows": rows::all(pool,
            "SELECT f.* FROM channel_follows f JOIN channels c ON c.id = f.source_id \
             WHERE c.guild_id = ? ORDER BY f.source_id, f.target_id", guild_id).await?,

        "invites": rows::all(pool, "SELECT * FROM invites WHERE guild_id = ? ORDER BY code", guild_id).await?,
        "automod_rules": rows::all(pool, "SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY id", guild_id).await?,
        "origin_rules": rows::all(pool, "SELECT * FROM guild_origin_rules WHERE guild_id = ? ORDER BY domain", guild_id).await?,
        "domain_rules": rows::all(pool, "SELECT * FROM guild_domain_rules WHERE guild_id = ? ORDER BY domain", guild_id).await?,
        "screening_answers": rows::all(pool, "SELECT * FROM screening_answers WHERE guild_id = ? ORDER BY user_id", guild_id).await?,
        "held_messages": rows::all(pool, "SELECT * FROM held_messages WHERE guild_id = ? ORDER BY id", guild_id).await?,
        "voice_regions": rows::all(pool, "SELECT * FROM guild_voice_regions WHERE guild_id = ? ORDER BY name", guild_id).await?,
        "audit_log": rows::all(pool, "SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id", guild_id).await?,

        "archived": archived_messages(state, guild_id).await?,
        "expressions": expression_assets(state, guild_id).await?,

        "exported_at": now_ms(),
    }))
}
