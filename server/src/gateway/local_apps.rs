//! ```ignore
//! use telium_server::gateway::local_apps::{
//!     self, BoxFuture, LocalApplication, LocalInteraction, LocalInteractionContext,
//! };
//!
//! struct EchoApp { application_id: String }
//!
//! impl LocalApplication for EchoApp {
//!     fn application_id(&self) -> &str {
//!         &self.application_id
//!     }
//!
//!     fn on_interaction<'a>(
//!         &'a self,
//!         ctx: LocalInteractionContext,
//!         interaction: LocalInteraction,
//!     ) -> BoxFuture<'a, ()> {
//!         Box::pin(async move {
//!             // `custom_id` is a byte string this application authored; look it up
//!             // in your own flow table.
//!             let _ = ctx
//!                 .respond(serde_json::json!({
//!                     "type": "message",
//!                     "data": { "content": "pressed", "ephemeral": true }
//!                 }))
//!                 .await;
//!         })
//!     }
//! }
//!
//! local_apps::register(std::sync::Arc::new(EchoApp {
//!     application_id: app_id,
//! }));
//! ```

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::ApiResult;
use crate::state::AppState;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Serialize, Deserialize)]
pub struct LocalInteraction {
    pub id: String,
    pub token: String,
    pub kind: String,
    pub application_id: String,
    pub application_origin: String,
    pub guild_id: String,
    pub channel_id: String,
    pub message_id: Option<String>,
    pub user_id: String,
    pub member: Value,
    pub data: Value,
}

impl std::fmt::Debug for LocalInteraction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalInteraction")
            .field("id", &self.id)
            .field("token", &"<redacted>")
            .field("kind", &self.kind)
            .field("application_id", &self.application_id)
            .field("application_origin", &self.application_origin)
            .field("guild_id", &self.guild_id)
            .field("channel_id", &self.channel_id)
            .field("message_id", &self.message_id)
            .field("user_id", &self.user_id)
            .field("data_keys", &self.data.as_object().map(|o| o.len()))
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub struct LocalInteractionContext {
    state: AppState,
    id: String,
    token: String,
}

impl LocalInteractionContext {
    pub(crate) fn new(state: AppState, id: String, token: String) -> Self {
        Self { state, id, token }
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    pub fn interaction_id(&self) -> &str {
        &self.id
    }

    /// ```json
    /// { "type": "message",        "data": { "content": "…", "ephemeral": true } }
    /// { "type": "update_message", "data": { "components": [] } }
    /// { "type": "deferred",       "data": { "ephemeral": true } }
    /// { "type": "modal",          "data": { "custom_id": "…", "title": "…", "components": [] } }
    /// ```
    pub async fn respond(&self, response: Value) -> ApiResult<Value> {
        crate::routes::interactions::respond_to_interaction(
            &self.state,
            &self.id,
            &self.token,
            response,
        )
        .await
    }

    pub async fn follow_up(&self, data: Value) -> ApiResult<Value> {
        crate::routes::interactions::follow_up_interaction(
            &self.state,
            &self.id,
            &self.token,
            data,
        )
        .await
    }
}

pub trait LocalApplication: Send + Sync + 'static {
    fn application_id(&self) -> &str;

    fn on_interaction<'a>(
        &'a self,
        ctx: LocalInteractionContext,
        interaction: LocalInteraction,
    ) -> BoxFuture<'a, ()>;
}

type Registry = RwLock<HashMap<String, Arc<dyn LocalApplication>>>;

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn register(app: Arc<dyn LocalApplication>) {
    let id = app.application_id().to_string();
    registry().write().expect("local application registry poisoned").insert(id, app);
}

pub fn deregister(application_id: &str) {
    registry().write().expect("local application registry poisoned").remove(application_id);
}

pub fn is_local(application_id: &str) -> bool {
    registry().read().expect("local application registry poisoned").contains_key(application_id)
}

pub fn lookup(application_id: &str) -> Option<Arc<dyn LocalApplication>> {
    registry().read().expect("local application registry poisoned").get(application_id).cloned()
}

pub(crate) fn dispatch(state: &AppState, interaction: LocalInteraction) -> bool {
    let Some(app) = lookup(&interaction.application_id) else {
        return false;
    };
    let ctx = LocalInteractionContext::new(
        state.clone(),
        interaction.id.clone(),
        interaction.token.clone(),
    );
    tokio::spawn(async move {
        app.on_interaction(ctx, interaction).await;
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counter {
        id: String,
        seen: Arc<AtomicUsize>,
    }

    impl LocalApplication for Counter {
        fn application_id(&self) -> &str {
            &self.id
        }

        fn on_interaction<'a>(
            &'a self,
            _ctx: LocalInteractionContext,
            _interaction: LocalInteraction,
        ) -> BoxFuture<'a, ()> {
            let seen = self.seen.clone();
            Box::pin(async move {
                seen.fetch_add(1, Ordering::SeqCst);
            })
        }
    }

    #[test]
    fn registration_is_by_application_id_and_replaces() {
        let seen = Arc::new(AtomicUsize::new(0));
        register(Arc::new(Counter { id: "app-reg-test".into(), seen: seen.clone() }));
        assert!(is_local("app-reg-test"));
        assert!(!is_local("app-reg-test-other"));
        register(Arc::new(Counter { id: "app-reg-test".into(), seen }));
        assert!(is_local("app-reg-test"));
        deregister("app-reg-test");
        assert!(!is_local("app-reg-test"));
    }
}
