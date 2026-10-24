import { afterEach, beforeEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { Emitter } from '../lib/util.js';

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo(options) {
    if (typeof options === 'object' && options !== null && 'top' in options) this.scrollTop = options.top;
  };
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
window.focus = () => {};

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
}
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = function getAnimations() { return []; };
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
}

if (!URL.createObjectURL) {
  URL.createObjectURL = () => 'blob:telium/preview';
  URL.revokeObjectURL = () => {};
}

if (typeof CSS === 'undefined') globalThis.CSS = {};
if (!CSS.escape) CSS.escape = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

if (!globalThis.localStorage) {
  globalThis.localStorage = (() => {
    let data = new Map();
    return {
      get length() { return data.size; },
      clear() { data = new Map(); },
      getItem(key) { return data.has(key) ? data.get(key) : null; },
      setItem(key, value) { data.set(key, String(value)); },
      removeItem(key) { data.delete(key); },
      key(i) { return [...data.keys()][i] ?? null; },
    };
  })();
}
if (!globalThis.sessionStorage) {
  globalThis.sessionStorage = globalThis.localStorage;
}

beforeEach(() => {
  globalThis.fetch = async () => ({ ok: false, status: 0 });
});
afterEach(() => {
  delete globalThis.fetch;
});

const ACT_EMITTER = Symbol.for('telium.test.act-emitter');
const ACT_PENDING = Symbol.for('telium.test.pending-acts');
const pendingActs = globalThis[ACT_PENDING] || new Set();
globalThis[ACT_PENDING] = pendingActs;

function trackAct(turn) {
  const pending = new Promise((resolve, reject) => turn.then(resolve, reject));
  pending.then(() => pendingActs.delete(pending), () => {});
  pendingActs.add(pending);
}

if (!Emitter.prototype[ACT_EMITTER]) {
  const rawEmit = Emitter.prototype.emit;
  Emitter.prototype.emit = function emitInAct(...args) {
    if (globalThis.IS_REACT_ACT_ENVIRONMENT !== true) {
      return rawEmit.apply(this, args);
    }
    let result;
    const turn = act(() => {
      result = rawEmit.apply(this, args);
    });
    trackAct(turn);
    return result;
  };
  Object.defineProperty(Emitter.prototype, ACT_EMITTER, { value: true });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  try {
    await Promise.all([...pendingActs]);
  } finally {
    pendingActs.clear();
    cleanup();
  }
});
