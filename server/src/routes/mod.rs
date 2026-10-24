
pub mod dm;
pub mod dmvoice;
pub mod failover;
pub mod friends;
pub mod voice;
pub mod guild;
pub mod hosting;
pub mod identity;
pub mod identity_continuity;
pub mod media;
pub mod messages;
pub mod moderation;
pub mod opaque;
pub mod push;
pub mod social;
pub mod migrate;
pub mod memberships;
pub mod alerts;
pub mod bots;
pub mod interactions;
pub mod recovery;
pub mod wellknown;

use crate::federation;
use crate::gateway;
use crate::state::AppState;
use axum::extract::DefaultBodyLimit;
use axum::routing::{delete, get, patch, post, put};
use axum::response::IntoResponse;
use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .merge(interactions::routes())
        .route("/.well-known/telium/server", get(wellknown::well_known))
        .route("/_telium/v1/keys", get(wellknown::keys))
        .route("/_telium/v1/health", get(wellknown::health))
        .route("/_telium/v1/capabilities", get(media::capabilities))
        .route("/_telium/v1/hosting/providers", get(hosting::providers))
        .route("/_telium/v1/hosting/catalog", get(hosting::catalog))
        .route("/_telium/v1/hosting/publication", get(hosting::publication))
        .route("/metrics", get(crate::metrics::prometheus));

    if state.cfg.roles.identity {
        app = app.merge(identity_routes()).merge(bot_identity_routes());
        let external_body_limit = state.cfg.media_registry.external_hosts.iter()
            .filter_map(|host| host.max_file_bytes.and_then(|limit| usize::try_from(limit).ok()))
            .max()
            .unwrap_or(0)
            .max(state.cfg.media_policy.max_file_bytes);
        app = app.route(
            "/_telium/v1/media/external/{host_id}",
            post(media::external_upload)
                .layer(DefaultBodyLimit::max(external_body_limit)),
        );
        app = app.route(
            "/_telium/v1/media/external/{host_id}/resolve",
            post(media::external_resolve),
        );
        app = app.route(
            "/_telium/v1/media/external/gofile/session",
            post(media::gofile_guest_session),
        );
        if state.cfg.media_registry.gofile_playback_proxy {
            app = app.route(
                "/_telium/v1/media/external/gofile/playback",
                post(media::gofile_playback_prepare),
            );
            app = app.route(
                "/_telium/v1/media/external/gofile/play",
                get(media::gofile_playback_stream),
            );
        }
    }
    if state.cfg.roles.guild {
        app = app.merge(guild_routes()).merge(bot_guild_routes());
        app = app.route("/gateway/v1", get(gateway::handler));
    }
    if state.cfg.roles.relay {
        app = app.route("/_telium/v1/relay/v1", get(crate::relay::handler));
    }
    if state.cfg.roles.media {
        app = app.merge(media_routes(&state));
    }
    app = app.merge(federation_routes()).merge(bot_federation_routes());
    if state.cfg.roles.identity && state.cfg.roles.guild {
        app = app.route("/_telium/v1/sessions/local", post(guild::local_session));
    }

    if let Some(dir) = &state.cfg.web.dir {
        let index = dir.join("index.html");
        app = app.fallback_service(
            ServeDir::new(dir).fallback(ServeFile::new(index)),
        );
    }

    app.layer(axum::middleware::from_fn(demotion_guard(state.clone())))
        .layer(axum::middleware::from_fn(crate::sunset::guard(state.clone())))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::ratelimit::layer,
        ))
        .layer(axum::middleware::from_fn(crate::security_headers::layer))
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::metrics::layer))
        .layer(TraceLayer::new_for_http())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
                .expose_headers(Any),
        )
        .layer(tower_http::timeout::RequestBodyTimeoutLayer::new(
            std::time::Duration::from_secs(state.cfg.limits.request_body_timeout_secs),
        ))
        .layer(DefaultBodyLimit::max(state.cfg.limits.max_request_bytes))
        .with_state(state)
}

fn demotion_guard(
    state: AppState,
) -> impl Fn(
    axum::extract::Request,
    axum::middleware::Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>
       + Clone
       + Send
       + 'static {
    move |req: axum::extract::Request, next: axum::middleware::Next| {
        let state = state.clone();
        Box::pin(async move {
            let writing = !matches!(
                *req.method(),
                axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
            );
            if writing {
                if let Ok(Some(authority)) = crate::promotion::authority(&state).await {
                    return (
                        axum::http::StatusCode::CONFLICT,
                        axum::Json(serde_json::json!({
                            "error": "demoted",
                            "code": crate::errcodes::DEMOTED,
                            "message": format!(
                                "{} is no longer the authority for this account; {} is",
                                state.cfg.server_name, authority.domain
                            ),
                            "authority": authority.domain,
                            "sequence": authority.sequence,
                            "record": authority.record,
                        })),
                    )
                        .into_response();
                }
            }
            next.run(req).await
        })
    }
}

pub fn router_with_standbys(state: AppState, replicas: &[crate::replicate::Replica]) -> Router {
    let mut app = router(state.clone());
    for replica in replicas {
        let guard = read_only_guard(state.clone(), replica.origin.clone());
        let mirror = router(replica.state.clone()).layer(axum::middleware::from_fn(guard));
        app = app.nest_service(&crate::replicate::mount_path(&replica.origin), mirror);
    }
    app
}

fn read_only_guard(
    host: AppState,
    origin: String,
) -> impl Fn(
    axum::extract::Request,
    axum::middleware::Next,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = axum::response::Response> + Send>>
       + Clone
       + Send
       + 'static {
    move |req: axum::extract::Request, next: axum::middleware::Next| {
        let host = host.clone();
        let origin = origin.clone();
        Box::pin(async move {
            let writing = !matches!(
                *req.method(),
                axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
            );
            if writing {
                let promoted: i64 = sqlx::query_scalar(
                    "SELECT promoted FROM replica_state WHERE origin = ?",
                )
                .bind(&origin)
                .fetch_optional(&host.pool)
                .await
                .ok()
                .flatten()
                .unwrap_or(0);
                if promoted == 0 {
                    return (
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        axum::Json(serde_json::json!({
                            "error": "standby_read_only",
                            "code": crate::errcodes::STANDBY_READ_ONLY,
                            "message": format!(
                                "this is a standby copy of {origin}; it can be read but not written to"
                            ),
                            "origin": origin,
                        })),
                    )
                        .into_response();
                }
            }
            next.run(req).await
        })
    }
}

fn bot_identity_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/_telium/v1/applications",
            get(bots::list_applications).post(bots::create_application),
        )
        .route(
            "/_telium/v1/applications/{application_id}",
            get(bots::get_application)
                .patch(bots::patch_application)
                .delete(bots::delete_application),
        )
        .route(
            "/_telium/v1/applications/{application_id}/token/reset",
            post(bots::reset_token),
        )
        .route("/_telium/v1/bots/assertions", post(bots::bot_assertion))
        .route(
            "/_telium/v1/bots/installations",
            get(bots::bot_installations),
        )
}

fn bot_guild_routes() -> Router<AppState> {
    Router::new()
        .route("/_telium/v1/bots/session", post(bots::create_bot_session))
        .route(
            "/_telium/v1/guilds/{guild_id}/bots",
            get(bots::list_guild_bots).post(bots::install_bot),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/bots/preview",
            post(bots::preview_bot),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/bots/{bot_user_id}",
            patch(bots::patch_bot).delete(bots::uninstall_bot),
        )
}

fn bot_federation_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/_telium/v1/applications/{application_id}/federation",
            get(bots::federated_application),
        )
        .route(
            "/_telium/v1/bots/installations/receipt",
            post(bots::installation_receipt),
        )
}

fn federation_routes() -> Router<AppState> {
    Router::new()
        .route("/_telium/v1/report", post(federation::routes::inbound_report))
        .route("/_telium/v1/emoji/entitlement", post(federation::routes::emoji_entitlement))
        .route("/_telium/v1/media/authorize", post(federation::media::authorize))
        .route("/_telium/v1/media/purge", post(federation::media::purge))
        .route("/_telium/v1/media/moved", post(federation::media::moved))
        .route("/_telium/v1/media/moved/list", post(federation::media::moved_list))
        .route(
            "/_telium/v1/users/{user_id}/notification-keys",
            post(push::notification_keys),
        )
        .route(
            "/_telium/v1/users/{user_id}/notifications",
            post(push::federated_notifications),
        )
        .route(
            "/_telium/v1/notifications/keys/batch",
            post(push::notification_keys_batch),
        )
        .route(
            "/_telium/v1/notifications/batch",
            post(push::federated_notifications_batch),
        )
        .route(
            "/_telium/v1/relocation",
            post(crate::relocation::inbound).get(crate::relocation::status),
        )
        .route(
            "/_telium/v1/relocation/{old}/discovery",
            get(crate::relocation::discovery),
        )
        .route("/_telium/v1/reports", post(federation::routes::submit_report))
        .route("/_telium/v1/media/remote/{origin}/{hash}", get(federation::media::fetch_remote))
        .route("/_telium/v1/media/vouchers", post(federation::media::issue_voucher))
        .route("/_telium/v1/media/voucher-upload", post(federation::media::voucher_upload))
        .route("/_telium/v1/embed", get(federation::embed::preview))
        .route("/_telium/v1/camo/{hash}", get(federation::embed::camo))
        .route(
            "/_telium/v1/admin/defederation",
            get(federation::routes::list_defederation).post(federation::routes::defederate),
        )
        .route("/_telium/v1/admin/defederation/{domain}", delete(federation::routes::refederate))
        .route(
            "/_telium/v1/admin/blocklist-feeds",
            get(federation::routes::list_feeds)
                .post(federation::routes::add_feed)
                .delete(federation::routes::remove_feed),
        )
        .route("/_telium/v1/admin/blocklist-feeds/refresh", post(federation::routes::refresh_feeds))
        .route(
            "/_telium/v1/admin/media/curator-key/rotate",
            post(federation::routes::rotate_curator_key),
        )
        .route("/_telium/v1/admin/hosting-catalogs", get(hosting::admin_catalogs))
        .route("/_telium/v1/admin/hosting-catalogs/refresh", post(hosting::admin_refresh))
        .route("/_telium/v1/admin/status", get(federation::routes::admin_status))
        .route("/_telium/v1/admin/version", get(crate::updates::admin_version))
        .route("/_telium/v1/admin/ownership", get(crate::ownership::overview))
        .route("/_telium/v1/admin/ownership/grant", post(crate::ownership::grant))
        .route("/_telium/v1/admin/ownership/revoke", post(crate::ownership::revoke))
        .route("/_telium/v1/admin/ownership/sessions", get(crate::ownership::sessions))
        .route(
            "/_telium/v1/admin/ownership/sessions/{device_id}",
            delete(crate::ownership::revoke_session),
        )
        .route(
            "/_telium/v1/admin/ownership/recovery/{id}/cancel",
            post(crate::ownership::cancel_claim),
        )
        .route(
            "/_telium/v1/admin/step-up",
            get(crate::admin::step_up_state)
                .post(crate::admin::step_up)
                .delete(crate::admin::end_step_up),
        )
        .route("/_telium/v1/admin/audit", get(crate::admin::list_audit))
        .route("/_telium/v1/admin/health", get(crate::admin::health::get))
        .route("/_telium/v1/admin/accounts", get(crate::admin::accounts::list))
        .route("/_telium/v1/admin/accounts/{user_id}", get(crate::admin::accounts::detail))
        .route(
            "/_telium/v1/admin/accounts/{user_id}/suspend",
            post(crate::admin::accounts::suspend),
        )
        .route(
            "/_telium/v1/admin/accounts/{user_id}/reinstate",
            post(crate::admin::accounts::reinstate),
        )
        .route("/_telium/v1/admin/guilds", get(crate::admin::guilds::list))
        .route("/_telium/v1/admin/guilds/{guild_id}", get(crate::admin::guilds::detail))
        .route("/_telium/v1/admin/continuity", get(crate::admin::continuity::get))
        .route("/_telium/v1/admin/metrics", get(crate::metrics::admin_metrics))
        .route("/_telium/v1/admin/metrics/series", get(crate::metrics::admin_series))
        .route("/_telium/v1/admin/storage", get(crate::metrics::admin_storage))
        .route("/_telium/v1/admin/storage/sweep", post(crate::metrics::admin_storage_sweep))
        .route("/_telium/v1/admin/moderation/summary", get(federation::routes::moderation_summary))
        .route("/_telium/v1/admin/peers", get(federation::routes::peers_overview))
        .route("/_telium/v1/admin/reports", get(federation::routes::list_reports))
        .route("/_telium/v1/admin/reports/{id}", patch(federation::routes::resolve_report))
        .route("/_telium/v1/admin/peers/{origin}", get(federation::routes::peer_status))
        .route("/_telium/v1/admin/revalidate", post(federation::routes::revalidate_now))
        .route("/_telium/v1/admin/archive", post(crate::cold::archive_now))
        .route("/_telium/v1/admin/guilds/{guild_id}/purge", post(guild::purge_moved_guild))
        .route("/_telium/v1/failover/head", get(failover::head))
        .route("/_telium/v1/failover/log", get(failover::log))
        .route("/_telium/v1/failover/snapshot", get(failover::snapshot))
        .route("/_telium/v1/failover/media/{hash}", get(failover::media))
        .route("/_telium/v1/failover/status/{origin}", get(failover::status))
        .route("/_telium/v1/admin/standby/{origin}/promote", post(failover::promote))
        .route("/_telium/v1/dm/submit", post(dm::inbound_submit))
        .route("/_telium/v1/dm/deliver", post(dm::inbound_deliver))
        .route("/_telium/v1/dm/frames/{id}/{since}", get(dm::inbound_frames))
        .route("/_telium/v1/dm/notification-keys", post(dm::inbound_dm_notification_keys))
        .route("/_telium/v1/dm/notification-hints", post(dm::inbound_dm_notification_hints))
        .route("/_telium/v1/dm/reanchor", post(dm::inbound_reanchor))
        .route("/_telium/v1/dm/handoff", post(dm::inbound_handoff))
        .route("/_telium/v1/dm/handoff/request", post(dm::inbound_handoff_request))
        .route("/_telium/v1/dm/handoff/{id}", get(dm::inbound_handoff_latest))
        .route("/_telium/v1/dm/typing", post(dm::inbound_typing))
        .route("/_telium/v1/dm/leave", post(dm::inbound_leave))
        .route("/_telium/v1/dm/departed", post(dm::inbound_departed))
        .route("/_telium/v1/dm/voice", post(dmvoice::inbound_roster))
        .route("/_telium/v1/dm/voice/notify", post(dmvoice::inbound_notify))
        .route("/_telium/v1/dm/voice/token", post(dmvoice::inbound_token))
        .route("/_telium/v1/dm/keypackages/claim", post(dm::inbound_claim))
        .route("/_telium/v1/dm/verify", post(dm::inbound_verification))
        .route(
            "/_telium/v1/keypackages",
            get(dm::my_key_packages).post(dm::publish_key_packages),
        )
        .route("/_telium/v1/keypackages/last-resort", delete(dm::withdraw_last_resort))
        .route("/_telium/v1/users/{user_id}/keypackages/claim", post(dm::claim_key_packages))
        .route("/_telium/v1/verify", post(dm::relay_verification))
        .route("/_telium/v1/vault", get(dm::get_vault).put(dm::put_vault))
        .route("/_telium/v1/vault/mode", post(dm::set_vault_mode))
        .route(
            "/_telium/v1/vault/backup",
            get(dm::get_backup).put(dm::put_backup).delete(dm::delete_backup),
        )
        .route(
            "/_telium/v1/conversations",
            get(dm::list_conversations).post(dm::create_conversation),
        )
        .route("/_telium/v1/conversations/{id}", get(dm::get_conversation))
        .route(
            "/_telium/v1/conversations/{id}/request/accept",
            post(dm::accept_message_request),
        )
        .route(
            "/_telium/v1/conversations/{id}/request/decline",
            post(dm::decline_message_request),
        )
        .route(
            "/_telium/v1/conversations/{id}/messages",
            get(dm::history).post(dm::send_frame),
        )
        .route(
            "/_telium/v1/conversations/{id}/notification-keys",
            get(dm::conversation_notification_keys),
        )
        .route(
            "/_telium/v1/conversations/{id}/notification-hints",
            post(dm::conversation_notification_hints),
        )
        .route("/_telium/v1/conversations/{id}/members", post(dm::add_member).delete(dm::remove_member))
        .route("/_telium/v1/conversations/{id}/policy", delete(dm::withdraw_policy))
        .route(
            "/_telium/v1/conversations/{id}/notifications",
            put(dm::set_notification_preference),
        )
        .route("/_telium/v1/conversations/{id}/leave", post(dm::leave_conversation))
        .route("/_telium/v1/conversations/{id}/reanchor", post(dm::reanchor))
        .route("/_telium/v1/conversations/{id}/promote", post(dm::promote_to_guild))
        .route("/_telium/v1/conversations/{id}/voice", get(dmvoice::states))
        .route("/_telium/v1/conversations/{id}/voice/join", post(dmvoice::join))
        .route("/_telium/v1/conversations/{id}/voice/leave", post(dmvoice::leave))
        .route("/_telium/v1/conversations/{id}/voice/state", post(dmvoice::update_state))
        .route("/_telium/v1/conversations/{id}/voice/signal", post(dmvoice::signal))
        .route("/_telium/v1/conversations/{id}/voice/server", post(dmvoice::server))
        .route("/_telium/v1/friends/relay", post(friends::inbound_relay))
        .route("/_telium/v1/friends/presence", post(friends::inbound_presence))
        .route("/_telium/v1/friends/mutual-check", post(friends::inbound_mutual_check))
        .route("/_telium/v1/friends/mutual/{user_id}", get(friends::mutual))
        .route("/_telium/v1/friends", get(friends::list).post(friends::request))
        .route("/_telium/v1/friends/{user_id}", delete(friends::remove))
        .route("/_telium/v1/friends/{user_id}/accept", post(friends::accept))
        .route(
            "/_telium/v1/friends/{user_id}/block",
            put(friends::block).delete(friends::unblock),
        )
        .route("/_telium/v1/voice/regions", get(voice::regions))
        .route(
            "/_telium/v1/guilds/{guild_id}/voice/regions",
            get(voice::guild_voice_regions_list).post(voice::guild_voice_region_add),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/voice/regions/default",
            patch(voice::guild_voice_region_set_default),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/voice/regions/{name}",
            delete(voice::guild_voice_region_delete),
        )
        .route("/_telium/v1/channels/{id}/voice", get(voice::channel_states))
        .route("/_telium/v1/channels/{id}/voice/join", post(voice::join))
        .route("/_telium/v1/channels/{id}/voice/leave", post(voice::leave))
        .route("/_telium/v1/channels/{id}/voice/state", post(voice::update_state))
        .route("/_telium/v1/channels/{id}/voice/token", post(voice::refresh_token))
        .route("/_telium/v1/channels/{id}/voice/stream", post(voice::set_stream))
        .route("/_telium/v1/channels/{id}/voice/watch", post(voice::watch))
        .route("/_telium/v1/channels/{id}/voice/signal", post(voice::signal))
        .route("/_telium/v1/channels/{id}/voice/e2ee", get(voice::e2ee_state).post(voice::e2ee_commit))
        .route("/_telium/v1/channels/{id}/voice/e2ee/commits", get(voice::e2ee_commits))
        .route("/_telium/v1/channels/{id}/voice/e2ee/refuse", post(voice::e2ee_refuse))
        .route("/_telium/v1/guilds/{guild_id}/voice/{user_id}", post(voice::moderate))
        .route("/_telium/v1/migrate/import", post(migrate::import))
        .route("/_telium/v1/migrate/receipt", post(migrate::receipt))
        .route("/_telium/v1/migrate/media/fetch", post(migrate::media_fetch))
        .route("/_telium/v1/migrate/media/confirm", post(migrate::media_confirm))
        .route("/_telium/v1/migrate", get(migrate::list).post(migrate::start))
        .route("/_telium/v1/migrate/grant-payload", post(migrate::grant_payload))
        .route("/_telium/v1/migrate/accept", post(migrate::accept))
        .route("/_telium/v1/migrate/handoff", post(migrate::handoff_open))
        .route("/_telium/v1/migrate/handoff/deliver", post(migrate::handoff_deliver))
        .route("/_telium/v1/migrate/handoff/{id}", get(migrate::handoff_status))
        .route("/_telium/v1/migrate/{id}/cancel", post(migrate::cancel))
        .route("/_telium/v1/migrate/{id}/execute", post(migrate::execute))
        .route("/_telium/v1/migrate/{id}/retry", post(migrate::retry))
        .route("/_telium/v1/memberships", get(memberships::list).post(memberships::report))
        .route("/_telium/v1/users/{user_id}/memberships", post(memberships::notice))
        .route("/_telium/v1/users/{user_id}/moved", post(memberships::moved))
        .route("/_telium/v1/users/{user_id}/revoked", post(memberships::revoked))
        .route("/_telium/v1/migrate/memberships", get(memberships::move_status))
        .route("/_telium/v1/migrate/memberships/retry", post(memberships::move_retry))
        .route("/_telium/v1/migrate/alerts", get(alerts::list))
        .route("/_telium/v1/migrate/cancel-link", get(alerts::link_page).post(alerts::link_cancel))
        .route(
            "/_telium/v1/account/recovery-email",
            get(recovery::get).put(recovery::set),
        )
        .route(
            "/_telium/v1/account/recovery-email/confirm",
            get(recovery::confirm_page).post(recovery::confirm),
        )
        .route(
            "/_telium/v1/account/recovery-email/disown",
            get(recovery::disown_page).post(recovery::disown),
        )
        .route("/_telium/v1/admin/mail/bounce", post(recovery::report_bounce))
        .route("/_telium/v1/sunset", get(migrate::get_sunset))
        .route("/_telium/v1/admin/sunset", post(migrate::set_sunset))
        .route("/_telium/v1/admin/sunset/execute", post(crate::sunset::execute))
        .route("/_telium/v1/admin/sunset/finalize", post(crate::sunset::finalize))
        .route("/_telium/v1/admin/failover", post(migrate::set_failover))
        .route(
            "/_telium/v1/admin/failover/{subject_type}/{subject_id}/promote",
            post(migrate::promote),
        )
}

fn identity_routes() -> Router<AppState> {
    Router::new()
        .route("/_telium/v1/register", post(identity::register))
        .route("/_telium/v1/register/opaque/start", post(opaque::register_start))
        .route("/_telium/v1/register/opaque/finish", post(opaque::register_finish))
        .route("/_telium/v1/login", post(identity::login))
        .route("/_telium/v1/login/opaque/start", post(opaque::login_start))
        .route("/_telium/v1/login/opaque/finish", post(opaque::login_finish))
        .route(
            "/_telium/v1/password-reset/opaque/start",
            post(opaque::password_reset_start),
        )
        .route(
            "/_telium/v1/password-reset/opaque/finish",
            post(opaque::password_reset_finish),
        )
        .route("/_telium/v1/auth/opaque/enroll/start", post(opaque::enroll_start))
        .route("/_telium/v1/auth/opaque/enroll/finish", post(opaque::enroll_finish))
        .route("/_telium/v1/auth/opaque/reauth/start", post(opaque::reauth_start))
        .route("/_telium/v1/auth/opaque/reauth/finish", post(opaque::reauth_finish))
        .route(
            "/_telium/v1/auth/recovery-key/vault-copy/start",
            post(opaque::recovery_copy_start),
        )
        .route(
            "/_telium/v1/auth/recovery-key/vault-copy/finish",
            post(opaque::recovery_copy_finish),
        )
        .route("/_telium/v1/account/reactivate", post(identity::reactivate))
        .route("/_telium/v1/logout", post(identity::logout))
        .route("/_telium/v1/logout-all", post(identity::logout_all))
        .route("/_telium/v1/whoami", get(identity::whoami))
        .route("/_telium/v1/account/deactivate", post(identity::deactivate))
        .route("/_telium/v1/account/export", get(identity::export_account))
        .route("/_telium/v1/account/bundle", post(crate::sunset::bundle))
        .route("/_telium/v1/account", delete(identity::delete_account))
        .route("/_telium/v1/mfa", get(identity::mfa_status))
        .route("/_telium/v1/mfa/setup", post(identity::mfa_setup))
        .route("/_telium/v1/mfa/enable", post(identity::mfa_enable))
        .route("/_telium/v1/mfa/disable", post(identity::mfa_disable))
        .route("/_telium/v1/devices", get(identity::my_devices))
        .route("/_telium/v1/devices/{device_id}", delete(identity::revoke_device))
        .route(
            "/_telium/v1/crosssigning",
            get(identity::get_cross_signing).put(identity::put_cross_signing),
        )
        .route(
            "/_telium/v1/crosssigning/devices/{device_id}",
            put(identity::sign_device),
        )
        .route(
            "/_telium/v1/crosssigning/users/{user_id}",
            put(identity::sign_user).delete(identity::unsign_user),
        )
        .route(
            "/_telium/v1/identity",
            get(identity_continuity::get_own),
        )
        .route(
            "/_telium/v1/identity/anchor",
            put(identity_continuity::anchor),
        )
        .route(
            "/_telium/v1/identity/recovery-policy",
            put(identity_continuity::set_recovery_policy),
        )
        .route(
            "/_telium/v1/identity/rotate",
            post(identity_continuity::rotate),
        )
        .route("/_telium/v1/profile", patch(identity::patch_profile))
        .route("/_telium/v1/profile/update", post(identity::inbound_profile))
        .route("/_telium/v1/assertions", post(identity::issue_assertion))
        .route(
            "/_telium/v1/media/preference",
            get(media::get_preference).put(media::set_preference),
        )
        .route("/_telium/v1/media/registry", get(media::registry))
        .route("/_telium/v1/media/registry/feed", get(media::registry_feed))
        .route("/_telium/v1/media/registry/feeds", get(media::registry_feed_hosts))
        .route("/_telium/v1/media/curators", get(media::curator_directory))
        .route("/_telium/v1/sync", get(identity::sync_get_all))
        .route(
            "/_telium/v1/sync/{key}",
            get(identity::sync_get).put(identity::sync_put).delete(identity::sync_delete),
        )
        .route("/_telium/v1/users/{user_id}/profile", get(identity::public_profile))
        .route(
            "/_telium/v1/users/{user_id}/public-page",
            get(identity::public_profile_page),
        )
        .route("/_telium/v1/users/{user_id}/devices", get(identity::device_list))
        .route(
            "/_telium/v1/users/{user_id}/identity",
            get(identity_continuity::get_public),
        )
        .route("/_telium/v1/users/{user_id}/status", get(identity::account_status))
        .route("/_telium/v1/push", get(push::list).post(push::subscribe))
        .route("/_telium/v1/push/vapid", get(push::vapid_public_key))
        .route("/_telium/v1/push/{id}", delete(push::unsubscribe))
        .route(
            "/_telium/v1/notifications/device",
            put(push::register_notification_device).delete(push::delete_notification_device),
        )
        .route(
            "/_telium/v1/notifications/test-wake",
            post(push::test_notification_wake),
        )
        .route("/_telium/v1/notifications", get(push::notification_inbox))
        .route(
            "/_telium/v1/notifications/ack",
            post(push::acknowledge_notification_inbox),
        )
}

fn guild_routes() -> Router<AppState> {
    Router::new()
        .route("/_telium/v1/sessions", post(guild::create_guild_session))
        .route("/_telium/v1/guilds", get(guild::my_guilds).post(guild::create_guild))
        .route(
            "/_telium/v1/guilds/{guild_id}",
            get(guild::get_guild).patch(guild::patch_guild).delete(guild::delete_guild),
        )
        .route("/_telium/v1/guilds/{guild_id}/transfer-ownership", post(guild::transfer_ownership))
        .route("/_telium/v1/guilds/{guild_id}/status", get(guild::guild_status))
        .route(
            "/_telium/v1/guilds/{guild_id}/alias",
            put(guild::put_guild_alias).delete(guild::delete_guild_alias),
        )
        .route("/_telium/v1/guild-aliases/{alias}", get(guild::alias_status))
        .route("/_telium/v1/guild-addresses/resolve", get(guild::resolve_guild_address))
        .route("/_telium/v1/guilds/{guild_id}/join-preview", get(guild::vanity_join_preview))
        .route("/_telium/v1/guilds/{guild_id}/join", post(guild::join_with_vanity))
        .route(
            "/_telium/v1/guilds/{guild_id}/channels",
            get(guild::list_channels)
                .post(guild::create_channel)
                .patch(guild::reorder_channels),
        )
        .route(
            "/_telium/v1/channels/{channel_id}",
            patch(guild::patch_channel).delete(guild::delete_channel),
        )
        .route(
            "/_telium/v1/channels/{channel_id}/voice-status",
            put(guild::set_voice_status),
        )
        .route(
            "/_telium/v1/channels/{channel_id}/overwrites/{target_type}/{target_id}",
            put(guild::set_overwrite),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/roles",
            get(guild::list_roles).post(guild::create_role).patch(guild::reorder_roles),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/roles/{role_id}",
            patch(guild::patch_role).delete(guild::delete_role),
        )
        .route("/_telium/v1/guilds/{guild_id}/members", get(guild::list_members))
        .route(
            "/_telium/v1/guilds/{guild_id}/members/{user_id}",
            get(guild::member_status)
                .patch(guild::patch_member)
                .delete(guild::kick_member),
        )
        .route("/_telium/v1/guilds/{guild_id}/bans", get(guild::list_bans))
        .route(
            "/_telium/v1/guilds/{guild_id}/bans/{user_id}",
            put(guild::ban_member).delete(guild::unban_member),
        )
        .route("/_telium/v1/guilds/{guild_id}/leave", post(guild::leave_guild))
        .route("/_telium/v1/guilds/{guild_id}/invites", get(guild::list_invites).post(guild::create_invite))
        .route("/_telium/v1/guilds/{guild_id}/invites/{code}", delete(guild::revoke_invite))
        .route("/_telium/v1/invites/{code}", get(guild::invite_preview))
        .route("/_telium/v1/invites/{code}/join", post(guild::join_with_invite))
        .route("/_telium/v1/guilds/{guild_id}/expressions", get(guild::list_expressions))
        .route("/_telium/v1/guilds/{guild_id}/emojis", post(guild::create_emoji))
        .route("/_telium/v1/guilds/{guild_id}/emojis/{emoji_id}", delete(guild::delete_emoji))
        .route("/_telium/v1/emoji/{emoji_id}", get(guild::fetch_emoji))
        .route("/_telium/v1/guilds/{guild_id}/stickers", post(guild::create_sticker))
        .route("/_telium/v1/sticker/{sticker_id}", get(guild::fetch_sticker))
        .route("/_telium/v1/guilds/{guild_id}/audit-log", get(guild::audit_log))
        .route(
            "/_telium/v1/channels/{channel_id}/messages",
            get(messages::history).post(messages::send),
        )
        .route(
            "/_telium/v1/channels/{channel_id}/messages/{message_id}",
            patch(messages::edit).delete(messages::delete),
        )
        .route("/_telium/v1/channels/{channel_id}/typing", post(messages::typing))
        .route(
            "/_telium/v1/messages/{message_id}/reactions",
            get(social::list_reactions).delete(social::clear_reactions),
        )
        .route(
            "/_telium/v1/messages/{message_id}/reactions/{emoji}/@me",
            put(social::add_reaction).delete(social::remove_reaction),
        )
        .route("/_telium/v1/channels/{channel_id}/pins", get(social::list_pins))
        .route(
            "/_telium/v1/channels/{channel_id}/pins/{message_id}",
            put(social::pin).delete(social::unpin),
        )
        .route(
            "/_telium/v1/channels/{channel_id}/threads",
            get(social::list_threads).post(social::create_thread),
        )
        .route(
            "/_telium/v1/threads/{thread_id}",
            patch(social::patch_thread).delete(social::delete_thread),
        )
        .route("/_telium/v1/channels/{channel_id}/follow", post(social::follow_channel))
        .route(
            "/_telium/v1/channels/{channel_id}/follow/{target_id}",
            delete(social::unfollow_channel),
        )
        .route("/_telium/v1/channels/{channel_id}/ack", post(social::ack))
        .route("/_telium/v1/guilds/{guild_id}/read-state", get(social::read_state))
        .route("/_telium/v1/guilds/{guild_id}/search", get(social::search))
        .route("/_telium/v1/channels/{channel_id}/segments", get(crate::cold::segments))
        .route(
            "/_telium/v1/guilds/{guild_id}/automod",
            get(moderation::list_rules).post(moderation::create_rule),
        )
        .route("/_telium/v1/guilds/{guild_id}/moderation/purge", post(moderation::purge_messages))
        .route(
            "/_telium/v1/guilds/{guild_id}/automod/{rule_id}",
            patch(moderation::patch_rule).delete(moderation::delete_rule),
        )
        .route("/_telium/v1/guilds/{guild_id}/automod-hits", get(moderation::list_hits))
        .route(
            "/_telium/v1/guilds/{guild_id}/gates",
            get(moderation::get_gates).put(moderation::set_gates),
        )
        .route(
            "/_telium/v1/guilds/{guild_id}/gates/refresh-feeds",
            post(moderation::refresh_gate_feeds),
        )
        .route("/_telium/v1/guilds/{guild_id}/gates/curators", get(moderation::list_curators))
        .route("/_telium/v1/guilds/{guild_id}/held", get(moderation::list_held))
        .route("/_telium/v1/guilds/{guild_id}/held/{held_id}", post(moderation::decide_held))
        .route("/_telium/v1/guilds/{guild_id}/screening", post(moderation::submit_screening))
        .route("/_telium/v1/guilds/{guild_id}/applicants", get(moderation::list_applicants))
        .route(
            "/_telium/v1/guilds/{guild_id}/applicants/{user_id}",
            post(moderation::decide_applicant),
        )
}

fn media_routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/_telium/v1/media",
            post(media::upload).layer(DefaultBodyLimit::max(state.cfg.media_policy.max_file_bytes)),
        )
        .route("/_telium/v1/media/{hash}", get(media::fetch).delete(media::delete))
        .route("/_telium/v1/media/{hash}/meta", get(media::meta))
}
