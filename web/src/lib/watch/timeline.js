// The clock a room watches by, and the smallest correction that keeps a player on it.
// A tuple (position, instant, rate, paused) lets receivers compute the room position at any moment; a dropped heartbeat costs nothing.

// Offset to the publisher's clock, NTP-style; assumes symmetric legs, and the latency filter discards worse samples.

const HISTORY = 16;
const BELIEVED = 5;

export class ClockOffset {
  constructor() {
    this.samples = [];
  }

  note(t0, t1, t3) {
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || !Number.isFinite(t3)) return;
    const rtt = t3 - t0;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: t1 - (t0 + t3) / 2 });
    if (this.samples.length > HISTORY) this.samples.shift();
  }

  get ready() { return this.samples.length > 0; }

  /// The median of the quickest trips: a slow sample is a worse measurement, not a second opinion.
  get offset() {
    if (!this.samples.length) return 0;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, BELIEVED);
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2);
    return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
  }

  get confidence() {
    if (!this.samples.length) return Infinity;
    return Math.min(...this.samples.map((s) => s.rtt)) / 2;
  }
}

// Below the 50 ms dead zone, correcting costs more in pitch wobble than the error costs.
// Between dead zone and seek threshold the rate is bent; a re-seek stutters worse than being half a second out.
// At or above the seek threshold, jump: closing a one second gap by rate would take twenty.

export const DEAD_ZONE = 0.05;

export const SEEK_AFTER = 1;

export const CATCH_UP_SECONDS = 8;

/// About where a browser's pitch-preserving stretch stops being free.
export const MAX_NUDGE = 0.05;

export function idleTimeline() {
  return { seq: 0, by: '', at: 0, position: 0, rate: 1, paused: true };
}

/// `at` is on the publisher's clock, so advancing by elapsed time accounts for time in flight.
export function positionAt(timeline, theirNow) {
  if (!timeline) return 0;
  if (timeline.paused) return Math.max(0, timeline.position);
  const elapsed = Math.max(0, theirNow - timeline.at) / 1000;
  return Math.max(0, timeline.position + elapsed * timeline.rate);
}

export function theirClock(now, offsetMs) {
  return now + (Number.isFinite(offsetMs) ? offsetMs : 0);
}

export function correctionFor(timeline, position, { now, offset = 0 } = {}) {
  const line = timeline || idleTimeline();
  const target = positionAt(line, theirClock(now, offset));
  const drift = position - target;

  // A paused room only has a place to stand; the dead zone still applies.
  if (line.paused) {
    return {
      paused: true,
      rate: line.rate,
      seek: Math.abs(drift) > DEAD_ZONE ? target : null,
      drift,
      target,
    };
  }

  if (Math.abs(drift) >= SEEK_AFTER) {
    // Seeking lands slightly behind target; not compensated, since overshooting is slower to undo.
    return { paused: false, rate: line.rate, seek: target, drift, target };
  }

  const nudge = Math.abs(drift) > DEAD_ZONE
    ? clamp(-drift / CATCH_UP_SECONDS, -MAX_NUDGE, MAX_NUDGE)
    : 0;
  return { paused: false, rate: line.rate * (1 + nudge), seek: null, drift, target };
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

// Counter one above the highest seen, ties to the lower user id: a total order with no coordinator.

export function supersedes(incoming, held) {
  if (!incoming) return false;
  if (!held || !held.seq) return true;
  if (incoming.seq !== held.seq) return incoming.seq > held.seq;
  return String(incoming.by) < String(held.by);
}

/// `at` is unadjusted; receivers translate it, so correcting here would correct twice.
export function publish(held, { by, now, position, rate, paused }) {
  const line = held || idleTimeline();
  return {
    seq: (line.seq || 0) + 1,
    by,
    at: now,
    position: Math.max(0, Number(position) || 0),
    rate: rate === undefined ? line.rate : rate,
    paused: paused === undefined ? line.paused : Boolean(paused),
  };
}

// A stall cannot be repaired afterwards, so it stops the room, bounded by a grace period.

export const STALL_GRACE_MS = 20000;

/// `stalls` is on this device's clock so a broken remote clock cannot stretch the wait.
export function waitingOn(stalls, now, limit = STALL_GRACE_MS) {
  const waiting = [];
  const abandoned = [];
  for (const [userId, since] of stalls) {
    if (now - since >= limit) abandoned.push(userId);
    else waiting.push(userId);
  }
  waiting.sort();
  abandoned.sort();
  return { hold: waiting.length > 0, waiting, abandoned };
}
