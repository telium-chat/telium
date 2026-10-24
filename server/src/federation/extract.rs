use super::{check_envelope, verify_request, verify_signed_by};
use super::negotiation::note_inbound_compat;
use crate::error::ApiError;
use crate::state::AppState;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::de::DeserializeOwned;
use std::sync::Arc;

pub struct FedOrigin(pub String);

impl FromRequestParts<AppState> for FedOrigin {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::Unauthorized("federation signature required".into()))?;
        let path = parts.uri.path().to_string();
        let origin = verify_request(state, header, parts.method.as_str(), &path, b"").await?;
        note_inbound_compat(state, &parts.headers, &origin).await?;
        Ok(FedOrigin(origin))
    }
}

pub struct Fed<T, const MB: usize = 4, G: Gate = Anyone> {
    pub origin: String,
    pub body: T,
    _gate: std::marker::PhantomData<G>,
}

pub trait Gate {
    fn allows(state: &AppState, claimed: &str) -> impl std::future::Future<Output = bool> + Send;
}

pub struct Anyone;

impl Gate for Anyone {
    async fn allows(_state: &AppState, _claimed: &str) -> bool {
        true
    }
}

pub(super) const UNGATED_MB: usize = 4;

pub const CONCURRENT_BIG_BODIES: usize = 2;

pub(super) const BIG_BODY_READ_SECS: u64 = 300;

const BIG_BODY_FLOOR_BYTES_PER_SEC: u64 = 16 * 1024;

const BIG_BODY_GRACE_SECS: u64 = 15;

const ORDINARY_FLOOR_BYTES_PER_SEC: u64 = 1024;

#[derive(Clone, Copy)]
pub struct Pace {
    pub deadline: std::time::Duration,
    pub floor_bytes_per_sec: u64,
    pub ordinary_floor_bytes_per_sec: u64,
    pub grace: std::time::Duration,
}

impl Default for Pace {
    fn default() -> Self {
        Self {
            deadline: std::time::Duration::from_secs(BIG_BODY_READ_SECS),
            floor_bytes_per_sec: BIG_BODY_FLOOR_BYTES_PER_SEC,
            ordinary_floor_bytes_per_sec: ORDINARY_FLOOR_BYTES_PER_SEC,
            grace: std::time::Duration::from_secs(BIG_BODY_GRACE_SECS),
        }
    }
}

const BIG_BODY_MIN_HOP: std::time::Duration = std::time::Duration::from_millis(50);

pub struct BigBodies {
    slots: Arc<tokio::sync::Semaphore>,
    reading: std::sync::Mutex<std::collections::HashSet<String>>,
    pace: Pace,
}

impl BigBodies {
    pub fn new(slots: usize) -> Self {
        Self::paced(slots, Pace::default())
    }

    pub fn paced(slots: usize, pace: Pace) -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(slots)),
            reading: Default::default(),
            pace,
        }
    }

    pub fn claim(self: &Arc<Self>, sender: &str) -> Result<BigBodyGuard, ApiError> {
        // Under the lock so two sockets arriving together cannot both insert.
        if !self.reading.lock().unwrap().insert(sender.to_string()) {
            return Err(ApiError::RateLimited(
                "this server is already reading a large bundle from you; finish that one first"
                    .into(),
            ));
        }
        Ok(BigBodyGuard {
            pool: self.clone(),
            sender: sender.to_string(),
        })
    }

    async fn read_paced(
        &self,
        body: axum::body::Body,
        limit: usize,
        holds_a_place: bool,
    ) -> Result<(axum::body::Bytes, Option<tokio::sync::OwnedSemaphorePermit>), ApiError> {
        use futures_util::StreamExt;
        let too_slow = |holding: bool| {
            ApiError::BadRequest(if holding {
                "the body arrived too slowly to go on holding a place kept for a bundle; \
                 try again"
                    .to_string()
            } else {
                "the body stopped arriving; try again".to_string()
            })
        };
        let mut holding = holds_a_place;
        let started = std::time::Instant::now();
        let mut last = started;
        let mut stream = body.into_data_stream();
        let mut buf: Vec<u8> = Vec::new();
        let mut permit = None;
        loop {
            let elapsed = started.elapsed();
            let Some(left) = self.pace.deadline.checked_sub(elapsed) else {
                return Err(too_slow(holding));
            };
            let Some(slack) = self.allowance(holding, buf.len()).checked_sub(elapsed) else {
                return Err(too_slow(holding));
            };
            let Some(quiet) = self.pace.grace.checked_sub(last.elapsed()) else {
                return Err(too_slow(holding));
            };
            let hop = slack.min(quiet).max(BIG_BODY_MIN_HOP).min(left);
            let chunk = match tokio::time::timeout(hop, stream.next()).await {
                Err(_) => continue,
                Ok(None) => break,
                Ok(Some(Ok(chunk))) => {
                    last = std::time::Instant::now();
                    chunk
                }
                Ok(Some(Err(_))) => {
                    return Err(ApiError::BadRequest("the body stopped arriving".into()))
                }
            };
            if buf.len() + chunk.len() > limit {
                return Err(ApiError::TooLarge("federation body is too large".into()));
            }
            buf.extend_from_slice(&chunk);
            // Past the ordinary ceiling a body takes a permit, judged on the bytes not the declaration.
            if permit.is_none() && buf.len() > UNGATED_MB * 1024 * 1024 {
                holding = true;
                permit = Some(self.slots.clone().try_acquire_owned().map_err(|_| {
                    ApiError::RateLimited(
                        "this server is already reading as many large bundles as it will hold \
                         at once; try again shortly"
                            .into(),
                    )
                })?);
            }
        }
        Ok((buf.into(), permit))
    }

    pub fn hold_a_permit(&self) -> Option<tokio::sync::OwnedSemaphorePermit> {
        self.slots.clone().try_acquire_owned().ok()
    }

    fn allowance(&self, holding: bool, delivered: usize) -> std::time::Duration {
        let floor = if holding {
            self.pace.floor_bytes_per_sec
        } else {
            self.pace.ordinary_floor_bytes_per_sec
        };
        if floor == 0 {
            return self.pace.deadline;
        }
        let earned = delivered as f64 / floor as f64;
        self.pace.grace + std::time::Duration::from_secs_f64(earned.min(u32::MAX as f64))
    }
}

pub struct BigBodyGuard {
    pool: Arc<BigBodies>,
    sender: String,
}

impl Drop for BigBodyGuard {
    fn drop(&mut self) {
        self.pool.reading.lock().unwrap().remove(&self.sender);
    }
}

impl<T: DeserializeOwned, const MB: usize, G: Gate> FromRequest<AppState> for Fed<T, MB, G> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let (parts, body) = req.into_parts();
        let header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| ApiError::Unauthorized("federation signature required".into()))?
            .to_string();
        let claimed = check_envelope(state, &header)?;
        let sender = crate::ratelimit::peer_address(
            &parts.extensions,
            &parts.headers,
            &state.cfg.rate_limit.trusted_proxies,
        );
        let ceiling = if MB > UNGATED_MB && sender.is_some() && G::allows(state, &claimed).await {
            MB
        } else {
            UNGATED_MB
        };
        let declared = parts
            .headers
            .get(axum::http::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok());
        let limit = ceiling * 1024 * 1024;
        // Measured against the route maximum so refusal does not reveal whether a claim names the caller.
        if declared.is_some_and(|len| len > MB * 1024 * 1024) {
            return Err(ApiError::TooLarge("federation body is too large".into()));
        }
        let declares_big = declared.is_none_or(|len| len > UNGATED_MB * 1024 * 1024);
        let slot = match sender {
            // Gate-capable routes pace every large body alike so callers cannot learn the gate's answer.
            Some(sender) if declares_big && MB > UNGATED_MB => {
                Some(state.big_bodies.claim(&sender)?)
            }
            _ => None,
        };
        let (bytes, permit) = state
            .big_bodies
            .read_paced(body, limit, slot.is_some())
            .await?;
        let origin = verify_signed_by(
            state,
            &header,
            parts.method.as_str(),
            parts.uri.path(),
            &bytes,
            claimed.clone(),
        )
        .await?;
        note_inbound_compat(state, &parts.headers, &origin).await?;
        let body: T = serde_json::from_slice(&bytes)
            .map_err(|e| ApiError::BadRequest(format!("federation body: {e}")))?;
        drop(permit);
        drop(slot);
        Ok(Fed {
            origin,
            body,
            _gate: std::marker::PhantomData,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_pace_asks_a_real_migration_for_nothing_it_cannot_give() {
        let pool = BigBodies::new(CONCURRENT_BIG_BODIES);
        let pace = Pace::default();
        let full = 160 * 1024 * 1024;

        assert!(
            pool.allowance(true, full) > pace.deadline,
            "a sender delivering the whole ceiling could still be cut by the floor"
        );

        let to_the_deadline = (pace.deadline - pace.grace).as_secs() * BIG_BODY_FLOOR_BYTES_PER_SEC;
        assert_eq!(to_the_deadline, 4_669_440);
        assert!(pool.allowance(true, to_the_deadline as usize) >= pace.deadline);
        assert!(
            pool.allowance(true, to_the_deadline as usize - 1) < pace.deadline,
            "a slot could be held to the deadline for less than the floor asks"
        );
    }

    #[test]
    fn a_body_that_holds_nothing_still_pays_for_the_time_it_takes() {
        let pool = BigBodies::new(CONCURRENT_BIG_BODIES);
        let pace = Pace::default();

        let to_the_deadline = (pace.deadline - pace.grace).as_secs() * ORDINARY_FLOOR_BYTES_PER_SEC;
        assert_eq!(to_the_deadline, 291_840);
        assert!(pool.allowance(false, to_the_deadline as usize) >= pace.deadline);
        assert!(
            pool.allowance(false, to_the_deadline as usize - 1) < pace.deadline,
            "a socket could be held to the deadline for less than the ordinary floor asks"
        );

        assert!(
            pool.allowance(true, to_the_deadline as usize) < pace.deadline,
            "the two floors charge the same, so nothing is gained by holding nothing"
        );
    }

    #[test]
    fn a_sender_that_has_delivered_nothing_has_only_the_grace() {
        let pool = BigBodies::new(1);
        assert_eq!(pool.allowance(true, 0), pool.pace.grace);
        assert_eq!(pool.allowance(false, 0), pool.pace.grace);
    }
}
