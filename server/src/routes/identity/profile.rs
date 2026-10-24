use super::*;

pub async fn public_profile(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> ApiResult<Json<Value>> {
    if !is_local(&state, &user_id)? {
        return Ok(Json(ask_home(&state, &user_id, "profile").await?));
    }
    let profile = load_profile(&state, &user_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("no such user".into()))?;
    Ok(Json(crypto::sign_json(&state.key, profile_wire(&user_id, &profile))))
}

fn presence_is_observable(state: &AppState) -> bool {
    state.cfg.roles.guild
}

fn no_public_page() -> ApiError {
    ApiError::NotFound("no public profile".into())
}

pub async fn public_profile_page(
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> Response {
    let mut response = match public_profile_page_inner(state, user_id).await {
        Ok(response) => response,
        Err(err) => err.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn public_profile_page_inner(state: AppState, user_id: String) -> ApiResult<Response> {
    let document = if !is_local(&state, &user_id)? {
        ask_home(&state, &user_id, "public-page").await?
    } else {
        let active: Option<i64> =
            sqlx::query_scalar("SELECT deactivated FROM accounts WHERE user_id = ?")
                .bind(&user_id)
                .fetch_optional(&state.pool)
                .await?;
        if active != Some(0) {
            return Err(no_public_page());
        }
        let tombstoned: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM tombstones WHERE subject_type = 'user' AND subject_id = ? LIMIT 1",
        )
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await?;
        if tombstoned.is_some() {
            return Err(no_public_page());
        }

        let profile = load_profile(&state, &user_id).await?.ok_or_else(no_public_page)?;
        if profile["public_page_enabled"].as_bool() != Some(true) {
            return Err(no_public_page());
        }

        let show_status = profile["public_status_enabled"].as_bool() == Some(true);
        let show_activity = profile["public_activity_enabled"].as_bool() == Some(true);
        let presence_known = presence_is_observable(&state);
        let mut presence = serde_json::Map::new();

        if presence_known {
            let live = state.hub.presence_of(&user_id).await.to_json(&user_id);
            if show_status {
                presence.insert("status".into(), live["status"].clone());
                presence.insert("custom_status".into(), live["custom_status"].clone());
            }
            if show_activity {
                presence.insert("activity".into(), live["activity"].clone());
                presence.insert("rich_activity".into(), live["rich_activity"].clone());
                presence.insert("rich_activities".into(), live["rich_activities"].clone());
            }
        }

        crypto::sign_json(
            &state.key,
            json!({
                "user_id": user_id,
                // New load_profile columns must be added to profile_wire's allowlist before they are public.
                "profile": profile_wire(&user_id, &profile),
                "presence": Value::Object(presence),
                "presence_known": presence_known,
                "origin": state.cfg.server_name,
                "generated_at": now_ms(),
            }),
        )
    };

    Ok(Json(document).into_response())
}

pub const BIO_MAX_CHARS: usize = 1024;

pub fn clamp_bio(bio: &str) -> String {
    bio.chars().take(BIO_MAX_CHARS).collect()
}

#[derive(Deserialize)]
pub struct ProfilePatch {
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub avatar_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub banner_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub accent_color: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub theme_colors: Option<Option<[i64; 2]>>,
    #[serde(default, deserialize_with = "double_option")]
    pub bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pronouns: Option<Option<String>>,
    #[serde(default)]
    pub public_page_enabled: Option<bool>,
    #[serde(default)]
    pub public_status_enabled: Option<bool>,
    #[serde(default)]
    pub public_activity_enabled: Option<bool>,
}

pub(crate) fn double_option<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

pub async fn patch_profile(
    State(state): State<AppState>,
    auth: HomeAuth,
    Json(patch): Json<ProfilePatch>,
) -> ApiResult<Json<Value>> {
    if let Some(name) = &patch.display_name {
        if name.trim().is_empty() || name.chars().count() > 64 {
            return Err(ApiError::BadRequest("display_name must be 1-64 characters".into()));
        }
    }
    if let Some(Some(bio)) = &patch.bio {
        let len = bio.chars().count();
        if len > BIO_MAX_CHARS {
            return Err(ApiError::BadRequest(format!(
                "bio must be at most {BIO_MAX_CHARS} characters ({len} given)"
            )));
        }
    }

    if let Some(Some(pair)) = &patch.theme_colors {
        if pair.iter().any(|c| !(0..=0xFF_FFFF).contains(c)) {
            return Err(ApiError::BadRequest("theme_colors must be two RGB integers".into()));
        }
    }

    let profile_changed = patch.display_name.is_some()
        || patch.avatar_ref.is_some()
        || patch.banner_ref.is_some()
        || patch.accent_color.is_some()
        || patch.theme_colors.is_some()
        || patch.bio.is_some()
        || patch.pronouns.is_some();

    let mut tx = state.pool.begin().await?;
    if let Some(v) = &patch.display_name {
        sqlx::query("UPDATE profiles SET display_name = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.avatar_ref {
        sqlx::query("UPDATE profiles SET avatar_ref = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.banner_ref {
        sqlx::query("UPDATE profiles SET banner_ref = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.accent_color {
        sqlx::query("UPDATE profiles SET accent_color = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.theme_colors {
        sqlx::query("UPDATE profiles SET theme_colors = ? WHERE user_id = ?")
            .bind(v.map(|p| json!(p).to_string())).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.bio {
        sqlx::query("UPDATE profiles SET bio = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = &patch.pronouns {
        sqlx::query("UPDATE profiles SET pronouns = ? WHERE user_id = ?")
            .bind(v).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = patch.public_page_enabled {
        sqlx::query("UPDATE profiles SET public_page_enabled = ? WHERE user_id = ?")
            .bind(i64::from(v)).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = patch.public_status_enabled {
        sqlx::query("UPDATE profiles SET public_status_enabled = ? WHERE user_id = ?")
            .bind(i64::from(v)).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if let Some(v) = patch.public_activity_enabled {
        sqlx::query("UPDATE profiles SET public_activity_enabled = ? WHERE user_id = ?")
            .bind(i64::from(v)).bind(&auth.user_id).execute(&mut *tx).await?;
    }
    if profile_changed {
        sqlx::query("UPDATE profiles SET profile_version = profile_version + 1, updated_at = ? WHERE user_id = ?")
            .bind(now_ms())
            .bind(&auth.user_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let profile = load_profile(&state, &auth.user_id).await?;

    if profile_changed && state.cfg.roles.guild {
        if let Some(p) = &profile {
            let display = p["display_name"].as_str().unwrap_or_default().to_string();
            let avatar = p["avatar_ref"].as_str().map(str::to_string);
            let version = p["profile_version"].as_i64().unwrap_or(0);
            let guilds = crate::guildstore::refresh_member_essentials(
                &state.pool, &auth.user_id, &display, avatar.as_deref(), version,
            )
            .await?;
            for guild_id in guilds {
                state.hub.publish(crate::gateway::events::Event::new(
                    "MEMBER_UPDATE",
                    guild_id,
                    crate::gateway::events::INTENT_GUILD_MEMBERS,
                    json!({
                        "user_id": auth.user_id, "display_name": display,
                        "avatar_ref": avatar, "profile_version": version
                    }),
                )).await;
            }
        }
    }
    if profile_changed {
        if let Some(p) = &profile {
            fanout_profile(&state, &auth.user_id, p).await;
        }
    }
    Ok(Json(profile.unwrap_or(json!({}))))
}

pub(crate) fn theme_pair(v: &Value) -> Value {
    match v.as_array().map(|a| a.iter().map(Value::as_i64).collect::<Vec<_>>()) {
        Some(p) if p.len() == 2 && p.iter().all(|c| matches!(c, Some(0..=0xFF_FFFF))) => json!(p),
        _ => Value::Null,
    }
}

fn profile_wire(user_id: &str, p: &Value) -> Value {
    json!({
        "user_id": user_id,
        "display_name": p["display_name"],
        "avatar_ref": p["avatar_ref"],
        "banner_ref": p["banner_ref"],
        "accent_color": p["accent_color"],
        "theme_colors": theme_pair(&p["theme_colors"]),
        "bio": p["bio"],
        "pronouns": p["pronouns"],
        "profile_version": p["profile_version"],
        "updated_at": p["updated_at"],
        "created_at": p["created_at"],
        "is_bot": p["is_bot"].as_bool().unwrap_or(false),
    })
}

async fn profile_audience(state: &AppState, user_id: &str) -> Vec<String> {
    let mut who = Vec::new();
    if is_local(state, user_id).unwrap_or(false) {
        who.push(user_id.to_string());
    }
    let watchers: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM friends WHERE peer_id = ? AND state = 'accepted'",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    who.extend(watchers);
    let peers: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT them.user_id FROM conversation_members them \
         JOIN conversation_members mine ON mine.conversation_id = them.conversation_id \
         WHERE mine.user_id = ? AND mine.state = 'active' AND them.state = 'active' \
           AND them.home_domain = ? AND them.user_id != ?",
    )
    .bind(user_id)
    .bind(&state.cfg.server_name)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    who.extend(peers);
    who.sort();
    who.dedup();
    who
}

async fn profile_homes(state: &AppState, user_id: &str) -> Vec<String> {
    let mut homes: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT peer_domain FROM friends \
         WHERE user_id = ? AND state = 'accepted' AND peer_domain != ?",
    )
    .bind(user_id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    let dm: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT them.home_domain FROM conversation_members them \
         JOIN conversation_members mine ON mine.conversation_id = them.conversation_id \
         WHERE mine.user_id = ? AND mine.state = 'active' AND them.state = 'active' \
           AND them.home_domain != ?",
    )
    .bind(user_id)
    .bind(&state.cfg.server_name)
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();
    homes.extend(dm);
    homes.sort();
    homes.dedup();
    homes
}

pub const PROFILE_PUSH_PATH: &str = "/_telium/v1/profile/update";

pub async fn fanout_profile(state: &AppState, user_id: &str, profile: &Value) {
    let body = profile_wire(user_id, profile);
    for who in profile_audience(state, user_id).await {
        state
            .hub
            .publish_user(
                &who,
                crate::gateway::events::Event::to_account("PROFILE_UPDATE", &who, body.clone()),
            )
            .await;
    }

    if !crate::federation::is_local(state, user_id) {
        return;
    }
    for home in profile_homes(state, user_id).await {
        let state = state.clone();
        let payload = json!({ "user_id": user_id, "profile": body.clone() });
        tokio::spawn(async move {
            if let Err(err) =
                crate::federation::post_signed(&state, &home, PROFILE_PUSH_PATH, &payload).await
            {
                tracing::debug!(target: crate::logcat::ACCOUNT, %err, %home, "could not carry a profile update");
            }
        });
    }
}

#[derive(Deserialize)]
pub struct RemoteProfile {
    pub user_id: String,
    pub profile: Value,
}

pub async fn inbound_profile(
    State(state): State<AppState>,
    fed: crate::federation::Fed<RemoteProfile>,
) -> ApiResult<Json<Value>> {
    crate::federation::ensure_reachable(&state, &fed.origin, "dm").await?;
    let (_, domain) = split_user_id(&fed.body.user_id)
        .ok_or_else(|| ApiError::BadRequest("malformed user id".into()))?;
    if domain != fed.origin {
        return Err(ApiError::Forbidden(
            "a server may only speak for its own users".into(),
        ));
    }
    fanout_profile(&state, &fed.body.user_id, &fed.body.profile).await;
    Ok(Json(json!({ "ok": true })))
}

pub async fn load_profile(state: &AppState, user_id: &str) -> ApiResult<Option<Value>> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        Option<i64>,
        i64,
        i64,
        i64,
        i64,
    )> = sqlx::query_as(
        "SELECT p.display_name, p.avatar_ref, p.banner_ref, p.accent_color, \
                p.theme_colors, p.bio, p.pronouns, \
                p.profile_version, p.updated_at, COALESCE(i.original_created_at, a.created_at), \
                EXISTS (SELECT 1 FROM bot_identities b WHERE b.user_id = p.user_id), \
                p.public_page_enabled, p.public_status_enabled, p.public_activity_enabled \
         FROM profiles p \
         LEFT JOIN accounts a ON a.user_id = p.user_id \
         LEFT JOIN imported_identities i ON i.user_id = p.user_id \
         WHERE p.user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?;

    Ok(row.map(
        |(
            display_name,
            avatar_ref,
            banner_ref,
            accent_color,
            theme_colors,
            bio,
            pronouns,
            version,
            updated_at,
            created_at,
            is_bot,
            public_page_enabled,
            public_status_enabled,
            public_activity_enabled,
        )| {
            json!({
                "user_id": user_id,
                "display_name": display_name,
                "avatar_ref": avatar_ref,
                "banner_ref": banner_ref,
                "accent_color": accent_color,
                "theme_colors": theme_colors
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .map_or(Value::Null, |t| theme_pair(&t)),
                "bio": bio,
                "pronouns": pronouns,
                "profile_version": version,
                "updated_at": updated_at,
                "created_at": created_at,
                "is_bot": is_bot != 0,
                "public_page_enabled": public_page_enabled != 0,
                "public_status_enabled": public_status_enabled != 0,
                "public_activity_enabled": public_activity_enabled != 0,
            })
        },
    ))
}
