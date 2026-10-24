import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_SECONDS, ClockOffset, DEAD_ZONE, MAX_NUDGE, SEEK_AFTER, STALL_GRACE_MS,
  correctionFor, idleTimeline, positionAt, publish, supersedes, theirClock, waitingOn,
} from '../lib/watch/timeline.js';

const ME = '@a:h';
const BOB = '@b:h';

const running = (at, position, rate = 1) => ({
  seq: 1, by: BOB, at, position, rate, paused: false,
});

describe('reading a timeline', () => {
  it('advances a tuple by the time since it was published', () => {
    const line = running(1_000, 10);
    expect(positionAt(line, 1_000)).toBe(10);
    expect(positionAt(line, 3_000)).toBe(12);
    expect(positionAt(running(1_000, 10, 1.5), 3_000)).toBe(13);
  });

  it('holds a paused tuple where it was left however long ago that was', () => {
    const line = { ...running(1_000, 10), paused: true };
    expect(positionAt(line, 1_000)).toBe(10);
    expect(positionAt(line, 900_000)).toBe(10);
  });

  it('compensates for the transit a message has already spent', () => {
    const line = running(1_000, 10);
    const correction = correctionFor(line, 10, { now: 3_000, offset: 0 });
    expect(correction.target).toBe(12);
    expect(correction.drift).toBe(-2);
    expect(correction.seek).toBe(12);
  });

  it('reads a publisher whose clock is wrong through the offset, not the wire', () => {
    const skew = -60_000;
    const now = 100_000;
    const line = running(now + skew, 10);
    expect(theirClock(now, skew)).toBe(now + skew);
    expect(correctionFor(line, 10, { now, offset: skew }).target).toBe(10);
    expect(correctionFor(line, 10, { now, offset: 0 }).target).toBe(70);
  });
});

describe('correcting a player', () => {
  it('leaves a player inside the dead zone alone', () => {
    const line = running(1_000, 10);
    const correction = correctionFor(line, 10 + DEAD_ZONE / 2, { now: 1_000 });
    expect(correction.seek).toBeNull();
    expect(correction.rate).toBe(1);
  });

  it('nudges the rate for small drift, in the direction that closes it', () => {
    const line = running(1_000, 10);
    const behind = correctionFor(line, 9.75, { now: 1_000 });
    expect(behind.seek).toBeNull();
    expect(behind.rate).toBeCloseTo(1 + 0.25 / CATCH_UP_SECONDS, 6);
    expect(behind.rate).toBeGreaterThan(1);

    const ahead = correctionFor(line, 10.25, { now: 1_000 });
    expect(ahead.seek).toBeNull();
    expect(ahead.rate).toBeLessThan(1);
    expect(ahead.rate).toBeCloseTo(2 - behind.rate, 6);
  });

  it('never bends the rate past what a listener would hear', () => {
    const line = running(1_000, 10);
    const correction = correctionFor(line, 10 - (SEEK_AFTER - 0.01), { now: 1_000 });
    expect(correction.seek).toBeNull();
    expect(correction.rate).toBeLessThanOrEqual(1 + MAX_NUDGE);
  });

  it('seeks rather than nudges once the gap is a line of dialogue', () => {
    const line = running(1_000, 30);
    const correction = correctionFor(line, 10, { now: 1_000 });
    expect(correction.seek).toBe(30);
    expect(correction.rate).toBe(1);
  });

  it('nudges a player running at a rate the room chose, around that rate', () => {
    const line = running(1_000, 10, 1.5);
    const correction = correctionFor(line, 9.75, { now: 1_000 });
    expect(correction.rate).toBeGreaterThan(1.5);
    expect(correction.rate).toBeLessThan(1.5 * (1 + MAX_NUDGE) + 1e-9);
  });

  it('parks a paused room, and only moves a player that is visibly off the mark', () => {
    const line = { ...running(1_000, 10), paused: true };
    expect(correctionFor(line, 10 + DEAD_ZONE / 2, { now: 9_000 }).seek).toBeNull();
    expect(correctionFor(line, 12, { now: 9_000 }).seek).toBe(10);
    expect(correctionFor(line, 12, { now: 9_000 }).paused).toBe(true);
  });

  it('lands somebody who joins ten minutes in where the room is, not at zero', () => {
    const line = running(1_000, 0);
    const correction = correctionFor(line, 0, { now: 1_000 + 600_000 });
    expect(correction.seek).toBe(600);
    expect(correction.paused).toBe(false);
  });
});

describe('clock offsets', () => {
  it('is the midpoint of a round trip, and says when it has none', () => {
    const clock = new ClockOffset();
    expect(clock.ready).toBe(false);
    expect(clock.offset).toBe(0);
    clock.note(0, 1_100, 200);
    expect(clock.ready).toBe(true);
    expect(clock.offset).toBe(1_000);
    expect(clock.confidence).toBe(100);
  });

  it('believes the quickest round trips and shrugs off a wild one', () => {
    const clock = new ClockOffset();
    for (let i = 0; i < 5; i += 1) clock.note(0, 1_020, 40);
    clock.note(0, 5_000, 8_000);
    expect(clock.offset).toBe(1_000);
    expect(clock.confidence).toBe(20);
  });

  it('drops a reply that arrived before it was sent', () => {
    const clock = new ClockOffset();
    clock.note(1_000, 1_000, 0);
    expect(clock.ready).toBe(false);
  });
});

describe('who is driving', () => {
  it('orders tuples by counter, then by the lower id, with no clock involved', () => {
    const held = { seq: 4, by: BOB };
    expect(supersedes({ seq: 5, by: BOB }, held)).toBe(true);
    expect(supersedes({ seq: 3, by: BOB }, held)).toBe(false);
    expect(supersedes({ seq: 4, by: ME }, held)).toBe(true);
    expect(supersedes({ seq: 4, by: BOB }, { seq: 4, by: ME })).toBe(false);
    expect(supersedes({ seq: 1, by: ME }, idleTimeline())).toBe(true);
  });

  it('publishes above the highest counter it has seen, stamped in its own time', () => {
    const line = publish({ seq: 7, by: BOB, at: 0, position: 3, rate: 1, paused: true }, {
      by: ME, now: 5_000, position: 12, paused: false,
    });
    expect(line).toEqual({ seq: 8, by: ME, at: 5_000, position: 12, rate: 1, paused: false });
    expect(publish(line, { by: ME, now: 6_000, position: 13 }).rate).toBe(1);
    expect(publish(line, { by: ME, now: 6_000, position: 13 }).paused).toBe(false);
  });

  it('refuses to publish a position before the start of the film', () => {
    expect(publish(idleTimeline(), { by: ME, now: 1, position: -30 }).position).toBe(0);
    expect(publish(idleTimeline(), { by: ME, now: 1, position: NaN }).position).toBe(0);
  });
});

describe('waiting for somebody who is buffering', () => {
  it('holds the room while anybody is stalled', () => {
    const now = 100_000;
    const stalls = new Map([[BOB, now - 2_000]]);
    const verdict = waitingOn(stalls, now);
    expect(verdict.hold).toBe(true);
    expect(verdict.waiting).toEqual([BOB]);
    expect(verdict.abandoned).toEqual([]);
  });

  it('gives up on one connection rather than holding four people forever', () => {
    const now = 100_000;
    const stalls = new Map([[BOB, now - STALL_GRACE_MS - 1], [ME, now - 500]]);
    const verdict = waitingOn(stalls, now);
    expect(verdict.abandoned).toEqual([BOB]);
    expect(verdict.waiting).toEqual([ME]);
    expect(verdict.hold).toBe(true);
  });

  it('holds nothing when nobody is stalled', () => {
    expect(waitingOn(new Map(), 1).hold).toBe(false);
  });
});
