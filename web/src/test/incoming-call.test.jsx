import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { mount, ME, signedInStore } from './harness.jsx';
import { IncomingCallHost } from '../views/IncomingCall.jsx';
import { RING_MS } from '../lib/store/calls.js';
import { installNotificationSounds } from '../lib/notify-sound.js';

const CAROL = '@carol:other.example';
const DAVE = '@dave:other.example';

const CONVO = {
  id: 'dm1',
  kind: 'dm',
  sequencer: 'home.example',
  members: [{ user_id: ME }, { user_id: CAROL }, { user_id: DAVE }],
};

function store(prefs = {}) {
  return signedInStore({
    conversations: [CONVO],
    guilds: [{
      id: 'g1',
      name: 'Guild',
      channels: [{ id: 'vc1', name: 'Voice', kind: 'voice' }],
      roles: [],
      me: { user_id: ME, roles: [] },
    }],
    prefs,
  });
}

const joins = (userId) => ({
  user_id: userId, conversation_id: 'dm1', channel_id: 'dm1',
});

const leaves = (userId) => ({
  user_id: userId, conversation_id: 'dm1', channel_id: null,
});

describe('a call ringing', () => {
  it('rings, and says who is calling', async () => {
    const s = store();
    mount(<IncomingCallHost />, s);

    act(() => s.onVoice(joins(CAROL)));

    expect(s.ringing.has('dm1')).toBe(true);
    expect(await screen.findByText('carol')).toBeTruthy();
    expect(screen.getByLabelText('Answer call from carol')).toBeTruthy();
    expect(screen.getByLabelText('Decline call from carol')).toBeTruthy();
  });

  it('says nothing about your own arrival in a call', () => {
    const s = store();
    act(() => s.onVoice(joins(ME)));
    expect(s.ringing.size).toBe(0);
  });

  it('does not ring for a call that was already running when it was hydrated', () => {
    const s = store();
    act(() => s.hydrateVoice('dm1', [joins(CAROL), joins(DAVE)]));
    expect(s.voice.get('dm1')).toHaveLength(2);
    expect(s.ringing.size).toBe(0);
  });

  it('stops when the call is answered on another device', () => {
    const s = store();
    act(() => s.onVoice(joins(CAROL)));
    expect(s.ringing.has('dm1')).toBe(true);

    act(() => s.onVoice(joins(ME)));
    expect(s.ringing.size).toBe(0);
  });

  it('stops when declined, and does not ring again for the same call', async () => {
    const s = store();
    const { user } = mount(<IncomingCallHost />, s);
    act(() => s.onVoice(joins(CAROL)));

    await user.click(await screen.findByLabelText('Decline call from carol'));
    expect(s.ringing.size).toBe(0);
    expect(screen.queryByText('carol')).toBeNull();

    act(() => s.onVoice(joins(DAVE)));
    expect(s.ringing.size).toBe(0);
    expect(s.voice.get('dm1')).toHaveLength(2);

    act(() => { s.onVoice(leaves(CAROL)); s.onVoice(leaves(DAVE)); });
    act(() => s.onVoice(joins(CAROL)));
    expect(s.ringing.has('dm1')).toBe(true);
  });

  it('stops when the caller gives up', async () => {
    const s = store();
    mount(<IncomingCallHost />, s);
    act(() => s.onVoice(joins(CAROL)));
    expect(await screen.findByText('carol')).toBeTruthy();

    act(() => s.onVoice(leaves(CAROL)));
    expect(s.ringing.size).toBe(0);
    await waitFor(() => expect(screen.queryByText('carol')).toBeNull());
  });

  it('stops by itself when nobody answers', () => {
    vi.useFakeTimers();
    try {
      const s = store();
      act(() => s.onVoice(joins(CAROL)));
      expect(s.ringing.has('dm1')).toBe(true);
      act(() => vi.advanceTimersByTime(RING_MS + 10));
      expect(s.ringing.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rings once, however many people join', () => {
    const s = store();
    const rings = [];
    s.on('ring', (r) => rings.push(r));

    act(() => { s.onVoice(joins(CAROL)); s.onVoice(joins(DAVE)); });

    expect(rings.filter((r) => r.ringing)).toHaveLength(1);
    expect(rings[0].from).toBe(CAROL);
  });

  it('stays quiet in a muted conversation', () => {
    const s = store({ muted: { dm1: true } });
    act(() => s.onVoice(joins(CAROL)));
    expect(s.ringing.size).toBe(0);
  });

  it('stays quiet while the dot says do not disturb', () => {
    const s = store({ presence: 'dnd' });
    act(() => s.onVoice(joins(CAROL)));
    expect(s.ringing.size).toBe(0);
  });

  it('never rings for a guild voice channel', () => {
    const s = store();
    act(() => s.onVoice({ user_id: CAROL, guild_id: 'g1', channel_id: 'vc1' }));
    expect(s.voice.get('vc1')).toHaveLength(1);
    expect(s.ringing.size).toBe(0);
  });

  it('takes its ringing calls with it when the session ends', () => {
    const s = store();
    act(() => s.onVoice(joins(CAROL)));
    act(() => s.clearRings());
    expect(s.ringing.size).toBe(0);
  });
});

const sources = [];
const contexts = [];

class FakeSource {
  constructor() {
    this.loop = false;
    this.playing = false;
    sources.push(this);
  }

  connect() {}

  disconnect() {}

  start() { this.playing = true; }

  stop() { this.playing = false; }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = {};
    contexts.push(this);
  }

  async resume() { this.state = 'running'; }

  async decodeAudioData() { return { duration: 3 }; }

  createBufferSource() { return new FakeSource(); }
}

const playing = () => sources.filter((s) => s.playing);

describe('the ringtone', () => {
  let offs = [];

  beforeEach(() => {
    sources.length = 0;
    window.AudioContext = FakeAudioContext;
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  });

  afterEach(() => {
    offs.forEach((off) => off());
    offs = [];
  });

  async function ringing(prefs) {
    const s = store(prefs);
    const { user } = mount(<IncomingCallHost />, s);
    offs.push(installNotificationSounds(s));
    act(() => s.onVoice(joins(CAROL)));
    return { s, user };
  }

  it('loops while a call is ringing', async () => {
    await ringing();
    await waitFor(() => expect(playing()).toHaveLength(1));
    expect(playing()[0].loop).toBe(true);
  });

  it('stops on every ending there is, and never outlives the card', async () => {
    const endings = [
      ['answered here', (s) => s.stopRing('dm1', 'answered')],
      ['answered elsewhere', (s) => s.onVoice(joins(ME))],
      ['declined', (s) => s.declineCall('dm1')],
      ['the caller giving up', (s) => s.onVoice(leaves(CAROL))],
      ['nobody answering', (s) => s.stopRing('dm1', 'missed')],
      ['the session ending', (s) => s.clearRings()],
    ];

    for (const [, end] of endings) {
      // eslint-disable-next-line no-await-in-loop
      const { s } = await ringing();
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(playing()).toHaveLength(1));

      act(() => end(s));

      expect(playing()).toHaveLength(0);
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.queryByText('carol')).toBeNull());
      act(() => { offs.pop()(); });
      cleanup();
    }
  });

  it('is silent when the preference is off, and still shows the call', async () => {
    await ringing({ notifyCallRing: false });
    expect(await screen.findByLabelText('Answer call from carol')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(playing()).toHaveLength(0);
  });

  it('draws an answerable call even where there can be no sound', async () => {
    const s = store();
    mount(<IncomingCallHost />, s);
    offs.push(installNotificationSounds(s));
    window.dispatchEvent(new Event('pointerdown'));
    const audio = contexts[contexts.length - 1];
    audio.state = 'suspended';
    audio.resume = async () => {};

    act(() => s.onVoice(joins(CAROL)));

    expect(await screen.findByLabelText('Answer call from carol')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(playing()).toHaveLength(0);
  });
});
