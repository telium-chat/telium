
use std::sync::atomic::AtomicI64;
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::admission;
use crate::config::SfuConfig;
use crate::control::control_handler;
use crate::livekit::LivekitManager;
use crate::session::session_handler;
use crate::sessions::SessionRegistry;
use crate::trust::TrustedKeys;
use crate::updates;
use crate::usage::Usage;

#[allow(dead_code)]
pub struct AppState {
    pub cfg: SfuConfig,
    /// Guild servers this relay refuses. Starts as `[limits].blocked_origins`
    /// and follows the config file while the relay runs, so `telium-sfu block`
    /// takes effect without a restart. A std lock: held for one list scan.
    pub blocked: Arc<std::sync::RwLock<Vec<String>>>,
    pub trust: Arc<RwLock<TrustedKeys>>,
    pub livekit: Arc<LivekitManager>,
    pub sessions: Arc<SessionRegistry>,
    /// The estimated-transfer ledger, shared with admission.
    pub usage: Arc<Usage>,
    /// Result of the latest release-manifest check.
    pub updates: Arc<RwLock<updates::Status>>,
    /// Epoch-ms deadline while draining for an update (refuse new joins, let
    /// calls finish); 0 = not draining. An Atomic so the admission hot path
    /// never awaits.
    pub drain_until_ms: Arc<AtomicI64>,
}

impl AppState {
    pub fn is_blocked(&self, origin: &str) -> bool {
        self.blocked.read().unwrap_or_else(|e| e.into_inner()).iter().any(|o| o == origin)
    }
}

async fn root(State(_state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "service": "telium-sfu" }))
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ok = state.livekit.health().await;
    // What a guild server or the directory learns from one knock: liveness,
    // whether new calls are taken, and the room/participant/budget facts.
    Json(admission::health_body(&state, ok))
}

pub fn router(state: Arc<AppState>) -> Router {
    // Browsers join from another origin; admission is the signature check, so permissive CORS is fine.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .route("/session", post(session_handler))
        .route("/control", post(control_handler))
        .layer(cors)
        .with_state(state)
}
