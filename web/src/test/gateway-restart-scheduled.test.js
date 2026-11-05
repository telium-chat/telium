import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../lib/store.js';
import { isClassified, mayInterrupt } from '../lib/interrupts.js';

const SOON = () => Date.now() + 5 * 60_000;

let store;

beforeEach(() => {
  store = new Store();
});

describe('a restart the server has scheduled', () => {
  it('is bookkeeping, never an interrupt', () => {
    expect(isClassified('SERVER_RESTART_SCHEDULED')).toBe(true);
    expect(isClassified('SERVER_RESTART_CANCELLED')).toBe(true);
    expect(mayInterrupt('SERVER_RESTART_SCHEDULED')).toBe(false);
    expect(mayInterrupt('SERVER_RESTART_CANCELLED')).toBe(false);
  });

  it('stands a notice where the banner can find it, and says so once', () => {
    const seen = [];
    store.on('restart-notice', () => seen.push(1));

    store.onDispatch({ domain: 'guild.example', t: 'SERVER_RESTART_SCHEDULED', d: { at: SOON(), in_ms: 300_000 } });

    expect(store.restartNotices.size).toBe(1);
    expect(seen).toEqual([1]);
  });

  it('takes the notice down when the restart is withdrawn', () => {
    const seen = [];
    store.on('restart-notice', () => seen.push(1));
    store.onDispatch({ domain: 'guild.example', t: 'SERVER_RESTART_SCHEDULED', d: { at: SOON() } });

    store.onDispatch({ domain: 'guild.example', t: 'SERVER_RESTART_CANCELLED', d: {} });

    expect(store.restartNotices.has('guild.example')).toBe(false);
    expect(seen).toEqual([1, 1]);
  });

  it('believes a READY that says a notice is standing, and one that says it is not', () => {
    store.onReady({ domain: 'guild.example', data: { d: { restart: { at: SOON() } } } });
    expect(store.restartNotices.has('guild.example')).toBe(true);

    store.onReady({ domain: 'guild.example', data: { d: {} } });
    expect(store.restartNotices.has('guild.example')).toBe(false);
  });

  it('refuses a deadline already in the past', () => {
    store.onDispatch({ domain: 'guild.example', t: 'SERVER_RESTART_SCHEDULED', d: { at: Date.now() - 1_000 } });
    expect(store.restartNotices.size).toBe(0);
  });

  it('keeps two servers straight: one restarting says nothing about the other', () => {
    const at = SOON();
    store.onDispatch({ domain: 'guild.example', t: 'SERVER_RESTART_SCHEDULED', d: { at } });
    store.onDispatch({ domain: 'other.example', t: 'SERVER_RESTART_CANCELLED', d: {} });

    expect(store.restartNotices.get('guild.example')).toBe(at);
    expect(store.restartNotices.has('other.example')).toBe(false);
  });

  it('hands the voice relay its own slot, cleared when the call ends', () => {
    const seen = [];
    store.on('restart-notice', () => seen.push(1));

    store.setSfuNotice({ phase: 'draining', until_ms: SOON(), name: 'relay.example:7890' });
    expect(store.sfuNotice?.phase).toBe('draining');

    store.setSfuNotice(null);
    expect(store.sfuNotice).toBe(null);
    expect(seen).toEqual([1, 1]);
  });
});
