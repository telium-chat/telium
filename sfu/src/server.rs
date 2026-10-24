
use std::sync::Arc;

use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};

use crate::config::SfuConfig;
use crate::control::control_handler;
use crate::livekit::LivekitManager;
use crate::session::session_handler;
use crate::sessions::SessionRegistry;
use crate::trust::TrustedKeys;

#[allow(dead_code)]
pub struct AppState {
    pub cfg: SfuConfig,
    pub trust: Arc<RwLock<TrustedKeys>>,
    pub livekit: Arc<LivekitManager>,
    pub sessions: Arc<SessionRegistry>,
}

async fn root(State(_state): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({ "service": "telium-sfu" }))
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ok = state.livekit.health().await;
    Json(json!({ "ok": ok }))
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
