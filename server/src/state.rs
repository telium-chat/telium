
use crate::config::Config;
use crate::crypto::ServerKey;
use crate::gateway::hub::Hub;
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub pool: SqlitePool,
    pub key: Arc<ServerKey>,
    pub signing_origin: Arc<String>,
    pub authority_record: Arc<RwLock<Option<Value>>>,
    pub authority_workers_started: Arc<std::sync::atomic::AtomicBool>,
    pub replica_host_pool: Option<SqlitePool>,
    pub hub: Arc<Hub>,
    pub shutting_down: Arc<std::sync::atomic::AtomicBool>,
    pub shutdown: Arc<tokio::sync::Notify>,
    pub metrics: Arc<crate::metrics::Metrics>,
    pub http: reqwest::Client,
    pub http_no_redirect: reqwest::Client,
    pub limiter: Arc<crate::ratelimit::RateLimiter>,
    pub relay: Arc<crate::relay::RelayState>,
    pub vapid: Arc<crate::webpush::VapidKey>,
    pub mfa: Arc<crate::mfa::Keyring>,
    pub push_providers: Arc<crate::pushproviders::Providers>,
    pub archive_store: Arc<crate::objectstore::ObjectStore>,
    pub media_store: Arc<crate::objectstore::ObjectStore>,
    pub big_bodies: Arc<crate::federation::BigBodies>,
    pub imports_in_flight: Arc<crate::migration::ImportsInFlight>,
    pub send_once: Arc<crate::sendonce::SendOnce>,
    pub hash_lists: Arc<crate::scan::HashLists>,
    pub gofile_guest_token: Arc<Mutex<Option<String>>>,
    /// One lock per account, held from the quota check to the row insert, so
    /// an account's parallel uploads cannot all read a stale total and land
    /// over its quota. The instance lease keeps this single-process.
    pub upload_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    pub demoted: Arc<std::sync::atomic::AtomicBool>,
    pub shut_down: Arc<std::sync::atomic::AtomicBool>,
    pub updates: Arc<RwLock<crate::updates::Status>>,
    pub lease: Option<Arc<crate::instance::Lease>>,
}

impl AppState {
    pub async fn resolve_verify_key(&self, origin: &str, key_id: &str) -> Option<String> {
        if origin == self.signing_origin.as_str() && key_id == self.key.key_id {
            return Some(self.key.public_b64());
        }
        crate::federation::verify_key(self, origin, key_id).await
    }
}
