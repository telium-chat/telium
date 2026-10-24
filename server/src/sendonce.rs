
use crate::error::ApiError;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REMEMBER: Duration = Duration::from_secs(5 * 60);

const CAPACITY: usize = 20_000;

const NONCE_MAX: usize = 64;
const NONCE_MIN: usize = 8;

#[derive(Clone, Debug)]
pub enum Outcome {
    Sent(String),
    Held { id: String, reason: String },
}

pub enum Claim {
    Fresh(Ticket),
    Repeat(Outcome),
    Busy,
}

enum Entry {
    InFlight,
    Settled(Outcome),
}

struct Slot {
    entry: Entry,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    slots: HashMap<String, Slot>,
    order: VecDeque<String>,
}

#[derive(Default)]
pub struct SendOnce {
    inner: Mutex<Inner>,
}

pub struct Ticket {
    registry: Arc<SendOnce>,
    key: String,
    settled: bool,
}

impl Ticket {
    pub fn settle(mut self, outcome: Outcome) {
        self.settled = true;
        let mut inner = self.registry.inner.lock().unwrap();
        if let Some(slot) = inner.slots.get_mut(&self.key) {
            slot.entry = Entry::Settled(outcome);
            slot.at = Instant::now();
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let mut inner = self.registry.inner.lock().unwrap();
        if matches!(inner.slots.get(&self.key), Some(Slot { entry: Entry::InFlight, .. })) {
            inner.slots.remove(&self.key);
        }
    }
}

impl SendOnce {
    pub fn claim(self: &Arc<Self>, author_id: &str, channel_id: &str, nonce: &str) -> Claim {
        let key = format!("{author_id}\u{1f}{channel_id}\u{1f}{nonce}");
        let mut inner = self.inner.lock().unwrap();
        sweep(&mut inner);
        match inner.slots.get(&key) {
            Some(Slot { entry: Entry::Settled(outcome), .. }) => return Claim::Repeat(outcome.clone()),
            Some(Slot { entry: Entry::InFlight, .. }) => return Claim::Busy,
            None => {}
        }
        inner.slots.insert(key.clone(), Slot { entry: Entry::InFlight, at: Instant::now() });
        inner.order.push_back(key.clone());
        drop(inner);
        Claim::Fresh(Ticket { registry: self.clone(), key, settled: false })
    }
}

fn sweep(inner: &mut Inner) {
    let now = Instant::now();
    while let Some(key) = inner.order.front() {
        match inner.slots.get(key) {
            None => {
                inner.order.pop_front();
            }
            Some(slot) if now.duration_since(slot.at) >= REMEMBER => {
                let key = inner.order.pop_front().expect("front exists");
                inner.slots.remove(&key);
            }
            Some(_) => break,
        }
    }
    // `>=`: runs before the claim inserts its own entry.
    while inner.slots.len() >= CAPACITY {
        let Some(key) = inner.order.pop_front() else { break };
        inner.slots.remove(&key);
    }
}

pub fn validate(nonce: &str) -> Result<(), ApiError> {
    if nonce.len() < NONCE_MIN || nonce.len() > NONCE_MAX {
        return Err(ApiError::BadRequest(format!(
            "nonce must be between {NONCE_MIN} and {NONCE_MAX} characters"
        )));
    }
    if !nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err(ApiError::BadRequest(
            "nonce may only contain letters, digits, '-' and '_'".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const N: &str = "abcdefgh";

    fn fresh(reg: &Arc<SendOnce>, who: &str, ch: &str, nonce: &str) -> Ticket {
        match reg.claim(who, ch, nonce) {
            Claim::Fresh(t) => t,
            _ => panic!("expected a fresh claim"),
        }
    }

    #[test]
    fn claim_rules() {
        let reg = Arc::new(SendOnce::default());
        let t = fresh(&reg, "@a:h", "c1", N);
        assert!(matches!(reg.claim("@a:h", "c1", N), Claim::Busy));
        t.settle(Outcome::Sent("msg-1".into()));
        assert!(matches!(reg.claim("@a:h", "c1", N), Claim::Repeat(Outcome::Sent(id)) if id == "msg-1"));
        (fresh(&reg, "@b:h", "c1", N), fresh(&reg, "@a:h", "c2", N));
        drop(fresh(&reg, "@a:h", "c2", N));
        fresh(&reg, "@a:h", "c3", N).settle(Outcome::Held { id: "held-1".into(), reason: "r".into() });
        assert!(matches!(reg.claim("@a:h", "c3", N), Claim::Repeat(Outcome::Held { id, .. }) if id == "held-1"));
    }

    #[test]
    fn nonces_are_bounded_and_opaque_and_the_map_is_bounded() {
        assert!(validate(N).is_ok() && validate("A-Z_0123456789abcdef").is_ok());
        for bad in ["short", &"x".repeat(NONCE_MAX + 1), "has space", "has\u{1f}separator"] {
            assert!(validate(bad).is_err(), "{bad:?}");
        }
        let reg = Arc::new(SendOnce::default());
        for i in 0..(CAPACITY + 500) {
            fresh(&reg, "@a:h", "c1", &format!("nonce{i:012}")).settle(Outcome::Sent(format!("m{i}")));
        }
        assert!(reg.inner.lock().unwrap().slots.len() <= CAPACITY);
    }
}
