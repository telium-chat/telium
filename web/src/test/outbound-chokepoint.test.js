import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = {
  'lib/net/transport.js fetch': 'the chokepoint',
  'lib/net/transport.js WebSocket': 'the chokepoint',
  'lib/net/transport.js XMLHttpRequest': 'the chokepoint',
  'lib/denoise-chain.js fetch': 'bundled model, same origin',
  'lib/external-upload.js fetch': 'third-party upload host, declared in NOT_COVERED',
  'lib/external-upload.js XMLHttpRequest': 'upload progress for the same host',
  'lib/favicon.js fetch': 'own <link rel=icon>, same origin',
  'lib/gifs.js fetch': 'GIF provider, declared in NOT_COVERED',
  'lib/notify-sound.js fetch': 'bundled sound or user-supplied blob/data URL',
  'lib/upload.js XMLHttpRequest': 'progress path; upload() checks the mode first and uses teliumFetch when protected',
  'lib/voice-sfu.js fetch': 'SFU session; voice has its own privacy setting',
  'sw.js fetch': 'service worker, own origin only',
  'views/guild-settings/VoicePane.jsx fetch': 'admin-typed SFU /health probe',
};

const PRIMITIVES = [
  ['fetch', /(?<![\w$.])fetch\s*\(/g],
  ['fetch', /\b(?:globalThis|window|self)\.fetch\s*\(/g],
  ['WebSocket', /new\s+(?:globalThis\.|window\.|self\.)?WebSocket\s*\(/g],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/g],
  ['sendBeacon', /\bsendBeacon\s*\(/g],
  ['EventSource', /new\s+EventSource\s*\(/g],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!['test', '__mocks__', 'node_modules'].includes(name)) walk(full, out);
    } else if (/\.(js|jsx|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function scan() {
  const sites = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    const path = relative(SRC, file).split('\\').join('/');
    for (const [kind, pattern] of PRIMITIVES) {
      for (const match of text.matchAll(pattern)) {
        if (/telium$/i.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
        sites.push({ key: `${path} ${kind}`, line: text.slice(0, match.index).split('\n').length });
      }
    }
  }
  return sites;
}

describe('outbound call sites', () => {
  const sites = scan();

  it('makes every direct network call through the transport chokepoint', () => {
    const escaped = sites.filter((s) => !(s.key in ALLOWED)).map((s) => `${s.key} (line ${s.line})`);
    expect(escaped, 'Use teliumFetch/teliumSocket from lib/net/transport.js, or allowlist with a reason').toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    const live = new Set(sites.map((s) => s.key));
    expect(Object.keys(ALLOWED).filter((k) => !live.has(k))).toEqual([]);
  });
});
