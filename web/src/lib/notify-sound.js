// Notification sounds are shipped as files; the ringtone holds the whole loop pattern, zero to zero, so it has no seam.

import messageSound from '../assets/sounds/message.mp3';
import pingSound from '../assets/sounds/ping.mp3';
import ringSound from '../assets/sounds/ring.mp3';

const SOUNDS = { message: messageSound, ping: pingSound, ring: ringSound };

const GAP_MS = { message: 3000, ping: 1200 };

let ctx = null;
let bytes = null;                          // kind -> Promise<ArrayBuffer>
const buffers = new Map();
const decoding = new Map();
const lastAt = { message: 0, ping: 0 };

function fetchAll() {
  if (bytes) return bytes;
  bytes = {};
  for (const [kind, url] of Object.entries(SOUNDS)) {
    bytes[kind] = (async () => {
      try {
        const res = await fetch(url);
        return res.ok ? await res.arrayBuffer() : null;
      } catch {
        return null;
      }
    })();
  }
  return bytes;
}

function context() {
  if (ctx) return ctx;
  const Ctx = typeof window !== 'undefined'
    && (window.AudioContext || window.webkitAudioContext);
  if (!Ctx) return null;
  try { ctx = new Ctx(); } catch { ctx = null; }
  return ctx;
}

function decode(kind) {
  if (buffers.has(kind)) return Promise.resolve(buffers.get(kind));
  if (decoding.has(kind)) return decoding.get(kind);
  const work = (async () => {
    const audio = context();
    const data = await fetchAll()[kind];
    if (!audio || !data) return null;
    try {
      // `decodeAudioData` detaches its input; pass a copy.
      const buffer = await audio.decodeAudioData(data.slice(0));
      buffers.set(kind, buffer);
      return buffer;
    } catch {
      return null;
    } finally {
      decoding.delete(kind);
    }
  })();
  decoding.set(kind, work);
  return work;
}

export async function playNotificationSound(kind) {
  try {
    const audio = context();
    if (!audio) return false;
    // Resumes without a gesture if the tab was merely backgrounded.
    if (audio.state === 'suspended') await audio.resume().catch(() => {});
    const buffer = await decode(kind);
    if (!buffer || audio.state !== 'running') return false;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    source.start();
    return true;
  } catch {
    return false;
  }
}

let ringNode = null;
let ringWanted = false;

export async function startRingtone() {
  if (ringWanted) return Boolean(ringNode);
  ringWanted = true;
  try {
    const audio = context();
    if (!audio) return false;
    if (audio.state === 'suspended') await audio.resume().catch(() => {});
    const buffer = await decode('ring');
    // The call may have ended while awaiting.
    if (!ringWanted || ringNode || !buffer || audio.state !== 'running') return false;
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(audio.destination);
    source.start();
    ringNode = source;
    return true;
  } catch {
    return false;
  }
}

export function stopRingtone() {
  ringWanted = false;
  const source = ringNode;
  ringNode = null;
  if (!source) return;
  try { source.stop(); } catch { /* already stopped with the context */ }
  try { source.disconnect(); } catch { /* nothing left to disconnect */ }
}

/// Visible and focused. `store.reading` only says a timeline is mounted.
function inForeground() {
  return typeof document !== 'undefined'
    && document.visibilityState === 'visible'
    && document.hasFocus();
}

/// Carries the old `notifySound` preference over to `notifySounds` and clears it; re-run on every hydration.
function migrate(store) {
  const prefs = store?.prefs;
  if (!prefs) return;
  if (prefs.notifySounds === undefined) prefs.notifySounds = Boolean(prefs.notifySound);
  if (prefs.notifySound) {
    prefs.notifySound = false;
    store.savePrefs?.();
  }
}

function enabled(store) {
  migrate(store);
  return Boolean(store?.prefs?.notifySounds);
}

function messagesEnabled(store) {
  return Boolean(store?.prefs?.notifySoundMessages);
}

function callRingEnabled(store) {
  return store?.prefs?.notifyCallRing !== false;
}

function allow(kind) {
  const now = Date.now();
  if (now - lastAt[kind] < GAP_MS[kind]) return false;
  // A ping outranks a message sound within a burst.
  if (kind === 'message' && now - lastAt.ping < GAP_MS.message) return false;
  lastAt[kind] = now;
  return true;
}

function ring(store, kind) {
  if (!enabled(store)) return;
  if (!allow(kind)) return;
  playNotificationSound(kind);
}

export function installNotificationSounds(store) {
  if (typeof window === 'undefined' || !store) return () => {};

  fetchAll();
  migrate(store);

  const warm = () => {
    const audio = context();
    if (audio?.state === 'suspended') audio.resume().catch(() => {});
    decode('message'); decode('ping'); decode('ring');
  };
  const warmOpts = { once: true, passive: true, capture: true };
  window.addEventListener('pointerdown', warm, warmOpts);
  window.addEventListener('keydown', warm, warmOpts);

  const offs = [
    store.on('hydrated', () => migrate(store)),
    store.on('ready', () => migrate(store)),

    store.on('mention', ({ channelId }) => {
      if (store.isMuted?.(channelId)) return;
      if (store.reading === channelId && inForeground()) return;
      ring(store, 'ping');
    }),

    // Every DM frame is addressed to you; the store already dropped your own and the open conversation.
    store.on('dm-notify', (frame) => {
      if (store.isMuted?.(frame?.conversation_id)) return;
      ring(store, 'ping');
    }),

    store.on('ring', () => {
      if (store.ringing.size > 0 && callRingEnabled(store)) startRingtone();
      else stopRingtone();
    }),

    store.on('message', (msg) => {
      if (!messagesEnabled(store)) return;
      if (!msg || msg.author === store.me?.user_id) return;
      if (store.isMuted?.(msg.channel_id)) return;
      if (store.reading === msg.channel_id && inForeground()) return;
      ring(store, 'message');
    }),
  ];

  return () => {
    offs.forEach((off) => off?.());
    stopRingtone();
    window.removeEventListener('pointerdown', warm, warmOpts);
    window.removeEventListener('keydown', warm, warmOpts);
  };
}
