import { describe, it, expect, vi } from 'vitest';
import { freshStore } from './fake-server.js';

describe('membership reports', () => {
  it('reports each guild server’s READY to the home', () => {
    const store = freshStore();
    const reportMemberships = vi.fn(() => Promise.resolve({ ok: true }));
    store.home = { domain: 'home.example', reportMemberships };

    store.onReady({ domain: 'guilds.example', data: { d: { guilds: [{ id: 'g1' }, { id: 'g2' }] } } });

    expect(reportMemberships).toHaveBeenCalledWith('guilds.example', ['g1', 'g2']);
  });

  it('does not report the home’s own guilds back to it', () => {
    const store = freshStore();
    const reportMemberships = vi.fn(() => Promise.resolve({ ok: true }));
    store.home = { domain: 'home.example', reportMemberships };

    store.onReady({ domain: 'home.example', data: { d: { guilds: [{ id: 'g1' }] } } });

    expect(reportMemberships).not.toHaveBeenCalled();
  });

  it('survives a home that refuses the report', () => {
    const store = freshStore();
    store.home = { domain: 'home.example', reportMemberships: () => Promise.reject(new Error('older server')) };
    expect(() => store.onReady({ domain: 'guilds.example', data: { d: { guilds: [] } } })).not.toThrow();
  });
});
