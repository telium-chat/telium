'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  VIRTUAL_MIC_LABEL,
  createScreenShareAudioService,
} = require('./screen-share-audio.cjs');

test('Linux screenshare audio links application playback but excludes Telium call audio and inputs', () => {
  const calls = [];
  class FakePatchBay {
    static hasPipeWire() { return true; }
    link(data) { calls.push(['link', data]); }
    unmute() { calls.push(['unmute']); }
    unlink() { calls.push(['unlink']); }
    list() {
      calls.push(['list']);
      return [
        { 'node.name': 'Firefox', 'media.class': 'Stream/Output/Audio', 'application.process.id': '5000' },
        { 'node.name': 'AudioRelay Speaker', 'media.class': 'Audio/Sink' },
        { 'node.name': 'Virtual Source', 'media.class': 'Stream/Output/Audio', 'node.virtual': 'true' },
        { 'node.name': 'MIDI Through', 'media.class': 'Stream/Output/Midi' },
        { 'node.name': 'Built-in Audio', 'device.id': '12', 'media.class': 'Audio/Sink' },
        { 'node.name': 'Microphone', 'media.class': 'Stream/Input/Audio' },
        { 'node.name': 'Telium', 'media.class': 'Stream/Output/Audio', 'application.process.id': '4242' },
        { 'node.name': 'vencord-screen-share', 'media.class': 'Audio/Source' },
      ];
    }
  }

  const service = createScreenShareAudioService({
    electronApp: {
      getAppMetrics: () => [
        { name: 'GPU Process', pid: 10 },
        { name: 'Audio Service', pid: 4242 },
      ],
    },
    platform: 'linux',
    loadVenmic: () => ({ PatchBay: FakePatchBay }),
    logger: { warn() {} },
  });

  const result = service.startSystem();
  assert.deepEqual(result, {
    available: true,
    reason: null,
    deviceLabel: VIRTUAL_MIC_LABEL,
    hasPipewirePulse: true,
    targetCount: 1,
  });

  assert.equal(calls[0][0], 'unlink');
  assert.equal(calls[1][0], 'link');
  assert.deepEqual(calls[1][1], {
    mute: false,
    include: [],
    exclude: [
      { 'media.class': 'Stream/Input/Audio' },
      { 'application.process.id': '4242' },
      { 'node.virtual': 'true' },
    ],
    ignore_devices: true,
    only_speakers: true,
    only_default_speakers: false,
  });
  assert.equal(calls[2][0], 'list');
  assert.equal(calls.some(([name]) => name === 'unmute'), false);

  assert.equal(service.stop(), true);
  assert.equal(calls.at(-1)[0], 'unlink');
});

test('screenshare audio is created unmuted and never relies on an unmute race', () => {
  const calls = [];
  class FakePatchBay {
    static hasPipeWire() { return true; }
    unlink() { calls.push('unlink'); }
    link(options) { calls.push(['link', options]); }
    list() { calls.push('list'); return []; }
    unmute() { calls.push('unmute'); }
  }

  const service = createScreenShareAudioService({
    platform: 'linux',
    loadVenmic: () => ({ PatchBay: FakePatchBay }),
    logger: { warn() {} },
  });

  assert.equal(service.startSystem().available, true);
  assert.equal(calls[1][0], 'link');
  assert.equal(calls[1][1].mute, false);
  assert.equal(calls.includes('unmute'), false);
});

test('system audio routing is scoped to app playback streams, not PipeWire plumbing', () => {
  let options = null;
  class FakePatchBay {
    static hasPipeWire() { return true; }
    unlink() {}
    link(value) { options = value; }
    unmute() {}
    list() { return []; }
  }

  const service = createScreenShareAudioService({
    platform: 'linux',
    loadVenmic: () => ({ PatchBay: FakePatchBay }),
    logger: { warn() {} },
  });

  service.startSystem();

  assert.deepEqual(options.include, []);
  assert.equal(options.mute, false);
  assert.equal(options.only_speakers, true);
  assert.equal(options.only_default_speakers, false);
  assert.equal(options.ignore_devices, true);
  assert.ok(options.exclude.some((item) => item['node.virtual'] === 'true'));
});

test('screenshare audio is inert off Linux', () => {
  let loaded = false;
  const service = createScreenShareAudioService({
    platform: 'win32',
    loadVenmic: () => {
      loaded = true;
      throw new Error('must not load');
    },
    logger: { warn() {} },
  });

  assert.deepEqual(service.startSystem(), {
    available: false,
    reason: 'unsupported-platform',
    deviceLabel: null,
    hasPipewirePulse: null,
    targetCount: null,
  });
  assert.equal(loaded, false);
});

test('a running venmic source can report zero shareable playback targets instead of looking healthy', () => {
  class EmptyPatchBay {
    static hasPipeWire() { return true; }
    unlink() {}
    link() {}
    unmute() {}
    list() {
      return [
        { 'node.name': 'Built-in Audio', 'device.id': '12', 'media.class': 'Audio/Sink' },
        { 'node.name': 'AudioRelay Speaker', 'media.class': 'Audio/Sink' },
        { 'node.name': 'MIDI Through', 'media.class': 'Stream/Output/Midi' },
        { 'node.name': 'Microphone', 'media.class': 'Stream/Input/Audio' },
        { 'node.name': 'vencord-screen-share', 'media.class': 'Audio/Source' },
      ];
    }
  }

  const service = createScreenShareAudioService({
    platform: 'linux',
    loadVenmic: () => ({ PatchBay: EmptyPatchBay }),
    logger: { warn() {} },
  });

  const result = service.startSystem();
  assert.equal(result.available, true);
  assert.equal(result.targetCount, 0);
});

test('a refused PipeWire link is reported as unavailable', () => {
  class RefusingPatchBay {
    static hasPipeWire() { return true; }
    unlink() {}
    link() { return false; }
    unmute() { throw new Error('must not unmute a refused graph'); }
  }

  const service = createScreenShareAudioService({
    platform: 'linux',
    loadVenmic: () => ({ PatchBay: RefusingPatchBay }),
    logger: { warn() {} },
  });

  const result = service.startSystem();
  assert.equal(result.available, false);
  assert.match(result.reason, /refused/i);
});

test('a venmic failure leaves video-only sharing available', () => {
  const service = createScreenShareAudioService({
    platform: 'linux',
    loadVenmic: () => { throw new Error('missing native addon'); },
    logger: { warn() {} },
  });

  assert.deepEqual(service.startSystem(), {
    available: false,
    reason: 'missing native addon',
    deviceLabel: null,
    hasPipewirePulse: null,
    targetCount: null,
  });
  assert.equal(service.stop(), false);
});
