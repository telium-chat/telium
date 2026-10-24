import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptorErrorReason, isE2EESupported } from 'livekit-client';
import {
  dialable, effectivePosture, icePolicy, noteHello, openHello, rank, refusalCode, sealHello,
  strictest, wantsSfu,
} from '../lib/callmode.js';
import {
  encodedTransform, isWebKitGTK, keyFailure, keySlot, KeyTrouble, mediaKeyBehind, MlsKeyProvider,
  unopenedMedia,
  unsealableMedia,
} from '../lib/voice.js';

const ME = '@a:h';
const BOB = '@b:h';
const CAROL = '@c:h';

const key = (fill) => new Uint8Array(32).fill(fill);

describe('call postures', () => {
  it('orders the postures and takes the strictest', () => {
    expect(rank('direct')).toBeLessThan(rank('relay'));
    expect(rank('relay')).toBeLessThan(rank('sfu'));
    expect(strictest(['direct', 'sfu', 'relay'])).toBe('sfu');
    expect(strictest(['direct', 'direct'])).toBe('direct');
    expect(strictest(['direct', 'paranoid'])).toBe('direct');
  });

  it('counts anybody not heard from this epoch as relay', () => {
    const hellos = new Map([[BOB, { posture: 'direct', counter: 1, epoch: 3 }]]);
    expect(effectivePosture({ own: 'direct', me: ME, roster: [ME, BOB, CAROL], hellos, epoch: 3 }))
      .toBe('relay');
    expect(effectivePosture({ own: 'direct', me: ME, roster: [ME, BOB], hellos, epoch: 3 }))
      .toBe('direct');
    expect(effectivePosture({ own: 'direct', me: ME, roster: [ME, BOB], hellos, epoch: 4 }))
      .toBe('relay');
    expect(effectivePosture({ own: 'direct', me: ME, roster: [ME], hellos, epoch: 4 }))
      .toBe('direct');
    expect(effectivePosture({ own: 'sfu', me: ME, roster: [ME, BOB], hellos, epoch: 3 }))
      .toBe('sfu');
  });

  it('asks the sequencer for an SFU only when the posture cannot be met without one', () => {
    expect(wantsSfu('direct', false)).toBe(false);
    expect(wantsSfu('relay', true)).toBe(false);
    expect(wantsSfu('relay', false)).toBe(true);
    expect(wantsSfu('sfu', true)).toBe(true);
  });

  it('binds its own posture and extends the call’s where it can', () => {
    expect(icePolicy({ own: 'relay', effective: 'relay', relayAvailable: true })).toBe('relay');
    expect(icePolicy({ own: 'sfu', effective: 'sfu', relayAvailable: true })).toBe('relay');
    expect(icePolicy({ own: 'direct', effective: 'relay', relayAvailable: true })).toBe('relay');
    expect(icePolicy({ own: 'direct', effective: 'relay', relayAvailable: false })).toBe('all');
    expect(icePolicy({ own: 'direct', effective: 'direct', relayAvailable: true })).toBe('all');
  });

  it('never lowers a posture to get a call through', () => {
    const mesh = { mode: 'mesh', relay: false };
    const relayed = { mode: 'mesh', relay: true };
    const sfu = { mode: 'sfu' };
    expect(refusalCode('direct', mesh)).toBeNull();
    expect(refusalCode('relay', relayed)).toBeNull();
    expect(refusalCode('relay', mesh)).toBe('relay');
    expect(refusalCode('sfu', relayed)).toBe('sfu');
    expect(refusalCode('sfu', null)).toBe('nothing');
    for (const p of ['direct', 'relay', 'sfu']) expect(refusalCode(p, sfu)).toBeNull();
  });

  it('reads an SFU with no address as a mesh, because that is all it can be', () => {
    expect(dialable({ mode: 'sfu', endpoint: '' }).mode).toBe('mesh');
    expect(dialable({ mode: 'sfu' }).mode).toBe('mesh');
    expect(dialable({ mode: 'sfu', endpoint: '   ' }).mode).toBe('mesh');
    expect(dialable({ voice_server: { mode: 'sfu', endpoint: 'https://sfu.example' } }).mode)
      .toBe('mesh');
    expect(dialable({ generation: 3 }).mode).toBe('mesh');
    expect(dialable(null)).toBeNull();

    const addressed = { mode: 'sfu', endpoint: 'https://sfu.example', region: 'staging' };
    expect(dialable(addressed)).toBe(addressed);
    const custom = { mode: 'sfu', custom: true, endpoint: null };
    expect(dialable(custom)).toBe(custom);
    expect(dialable({ mode: 'mesh', relay: true, ice_servers: [] }))
      .toEqual({ mode: 'mesh', relay: true, ice_servers: [] });

    expect(refusalCode('sfu', dialable({ mode: 'sfu', endpoint: '' }))).toBe('sfu');
  });
});

describe('call hellos', () => {
  const where = { conversationId: 'conv-1', sender: BOB, epoch: 5 };

  it('opens a hello under the key, conversation and sender it was sealed for', async () => {
    const sealed = await sealHello(key(1), { ...where, posture: 'relay', counter: 7 });
    expect(JSON.stringify(sealed)).not.toContain('relay');
    expect(await openHello(key(1), where, sealed))
      .toEqual({ posture: 'relay', counter: 7, epoch: 5 });
  });

  it('refuses one moved to another sender, conversation, key or epoch', async () => {
    const sealed = await sealHello(key(1), { ...where, posture: 'direct', counter: 1 });
    expect(await openHello(key(1), { ...where, sender: CAROL }, sealed)).toBeNull();
    expect(await openHello(key(1), { ...where, conversationId: 'conv-2' }, sealed)).toBeNull();
    expect(await openHello(key(2), where, sealed)).toBeNull();
    expect(await openHello(key(1), { ...where, epoch: 6 }, sealed)).toBeNull();
    const bytes = atob(sealed.ct);
    const flipped = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    expect(await openHello(key(1), where, { ...sealed, ct: flipped })).toBeNull();
    expect(await openHello(key(1), where, { v: 2 })).toBeNull();
    expect(await openHello(key(1), where, null)).toBeNull();
  });

  it('keeps the newest from each sender, so a replay cannot undo what came after', () => {
    const hellos = new Map();
    expect(noteHello(hellos, BOB, { posture: 'relay', counter: 2, epoch: 5 })).toBe(true);
    expect(noteHello(hellos, BOB, { posture: 'direct', counter: 1, epoch: 5 })).toBe(false);
    expect(hellos.get(BOB).posture).toBe('relay');
    expect(noteHello(hellos, BOB, null)).toBe(false);
    expect(noteHello(hellos, BOB, { posture: 'direct', counter: 1, epoch: 6 })).toBe(true);
  });
});

describe('call media keys', () => {
  it('files each epoch’s key in its own slot, shared by the whole room', async () => {
    const provider = new MlsKeyProvider();
    const seen = [];
    provider.on('setKey', (info) => seen.push(info));
    await provider.setEpochKey(key(9), 17);
    expect(keySlot(17)).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].keyIndex).toBe(1);
    expect(seen[0].participantIdentity).toBeUndefined();
    expect(provider.getOptions()).toMatchObject({ sharedKey: true, ratchetWindowSize: 0 });
  });

  it('never marks a shared slot bad on failures', () => {
    expect(new MlsKeyProvider().getOptions().failureTolerance).toBe(-1);
  });
});

describe('turning a call over to a new key', () => {
  afterEach(() => { vi.useRealTimers(); });

  const watch = (provider) => {
    const seen = [];
    provider.on('setKey', (info, sealsUnder) => seen.push({ slot: info.keyIndex, sealsUnder }));
    return seen;
  };

  it('opens with a new key at once and seals with it only after the room has caught up', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = watch(provider);
    await provider.setEpochKey(key(2), 2);
    expect(seen).toEqual([{ slot: 2, sealsUnder: true }]);
    expect(provider.epoch).toBe(2);

    await provider.setEpochKey(key(3), 3);
    expect(seen[1]).toEqual({ slot: 3, sealsUnder: false });
    expect(provider.epoch).toBe(2);
    expect(provider.getKeys().map((k) => k.keyIndex).sort()).toEqual([2, 3]);

    vi.advanceTimersByTime(1999);
    expect(provider.epoch).toBe(2);
    vi.advanceTimersByTime(1);
    expect(seen[2]).toEqual({ slot: 3, sealsUnder: true });
    expect(provider.epoch).toBe(3);
    expect(provider.getLatestManuallySetKeyIndex()).toBe(3);
  });

  it('follows the latest key when two commits land inside one delay', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = watch(provider);
    await provider.setEpochKey(key(2), 2);
    await provider.setEpochKey(key(3), 3);
    vi.advanceTimersByTime(1000);
    await provider.setEpochKey(key(4), 4);
    vi.advanceTimersByTime(1000);
    expect(seen.filter((s) => s.sealsUnder).map((s) => s.slot)).toEqual([2]);
    vi.advanceTimersByTime(1000);
    expect(seen.filter((s) => s.sealsUnder).map((s) => s.slot)).toEqual([2, 4]);
    expect(provider.epoch).toBe(4);
  });

  it('follows a guild call’s group back to epoch 0', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    await provider.setEpochKey(key(5), 5);
    await provider.setEpochKey(key(0), 0);
    vi.advanceTimersByTime(2000);
    expect(provider.epoch).toBe(0);
  });

  it('stops a pending switch when the call ends', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = watch(provider);
    await provider.setEpochKey(key(2), 2);
    await provider.setEpochKey(key(3), 3);
    provider.dispose();
    vi.advanceTimersByTime(5000);
    expect(provider.epoch).toBe(2);
    expect(seen.filter((s) => s.sealsUnder)).toHaveLength(1);
  });
});

describe('whether a call still needs the new media key', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('asks the key ring, which knows a key it is still waiting to seal under', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const call = { e2ee: { keyProvider: provider }, rekey: () => {} };
    const at = (epoch) => ({ key: key(epoch), epoch });
    expect(mediaKeyBehind(call, at(2))).toBe(true);
    await provider.setEpochKey(key(2), 2);
    expect(mediaKeyBehind(call, at(2))).toBe(false);
    expect(mediaKeyBehind(call, at(3))).toBe(true);
    await provider.setEpochKey(key(3), 3);
    expect(provider.epoch).toBe(2);
    expect(mediaKeyBehind(call, at(3))).toBe(false);
  });

  it('knows a group started over at the same epoch is a new key', async () => {
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const call = { e2ee: { keyProvider: provider }, rekey: () => {} };
    await provider.setEpochKey(key(1), 1);
    expect(mediaKeyBehind(call, { key: key(9), epoch: 1 })).toBe(true);
    await provider.setEpochKey(key(9), 1);
    expect(mediaKeyBehind(call, { key: key(9), epoch: 1 })).toBe(false);
  });

  it('has nothing to say about a call that is not sealed under the group', () => {
    expect(mediaKeyBehind(null, { key: key(3), epoch: 3 })).toBe(false);
    expect(mediaKeyBehind({ rekey: () => {} }, { key: key(3), epoch: 3 })).toBe(false);
    expect(mediaKeyBehind({ e2ee: { keyProvider: new MlsKeyProvider() }, rekey: () => {} }, null))
      .toBe(false);
  });
});

describe('a new key that lands in the slot frames are sealed under', () => {
  afterEach(() => { vi.useRealTimers(); });

  const sealed = (provider) => {
    const seen = [];
    provider.on('setKey', (info, sealsUnder) => seen.push({ slot: info.keyIndex, sealsUnder }));
    return seen;
  };

  it('seals under it at once rather than pretend to hold it back', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = sealed(provider);
    await provider.setEpochKey(key(1), 4);
    await provider.setEpochKey(key(2), 20);
    expect(keySlot(20)).toBe(keySlot(4));
    expect(seen).toEqual([{ slot: 4, sealsUnder: true }, { slot: 4, sealsUnder: true }]);
    expect(provider.epoch).toBe(20);
    expect(provider.pending).toBe(null);
  });

  it('drops a pending switch the new key overtakes', async () => {
    vi.useFakeTimers();
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = sealed(provider);
    await provider.setEpochKey(key(1), 1);
    await provider.setEpochKey(key(2), 2);
    await provider.setEpochKey(key(3), 1);
    vi.advanceTimersByTime(5000);
    expect(provider.epoch).toBe(1);
    expect(seen.filter((s) => s.sealsUnder)).toHaveLength(2);
  });

  it('installs the same key at the same epoch once', async () => {
    const provider = new MlsKeyProvider({ switchDelay: 2000 });
    const seen = sealed(provider);
    await provider.setEpochKey(key(1), 1);
    await provider.setEpochKey(key(1), 1);
    expect(seen).toHaveLength(1);
  });
});

describe('media that has not opened yet', () => {
  const fromWorker = (index) => new Error(
    `MissingKey: missing key at index ${index} for participant ${BOB}`,
  );

  const clocked = () => {
    const clock = { t: 0 };
    const said = [];
    const trouble = new KeyTrouble({
      report: (e, who) => said.push(unopenedMedia(e, who)), now: () => clock.t,
    });
    return { clock, said, trouble };
  };

  it('reads a key failure the worker posted', () => {
    expect(keyFailure(fromWorker(3))).toBe(true);
    expect(keyFailure(new Error('InvalidKey: invalid key at index 3'))).toBe(true);
    expect(keyFailure(new Error('InternalError: worker died'))).toBe(false);
    expect(keyFailure({ reason: CryptorErrorReason.MissingKey })).toBe(true);
    expect(keyFailure(undefined)).toBe(false);
  });

  it('says nothing about a few seconds behind a commit', () => {
    const { clock, said, trouble } = clocked();
    for (clock.t = 0; clock.t <= 3000; clock.t += 1000) trouble.note(BOB, fromWorker(3));
    trouble.keyArrived();
    clock.t = 3500;
    trouble.note(BOB, fromWorker(3));
    clock.t = 60_000;
    trouble.note(BOB, fromWorker(3));
    expect(said).toEqual([]);
  });

  it('treats failures with a pause between them as separate moments', () => {
    const { clock, said, trouble } = clocked();
    for (const t of [0, 1000, 2000, 6000, 7000, 8000, 12_000]) {
      clock.t = t;
      trouble.note(BOB, fromWorker(3));
    }
    expect(said).toEqual([]);
  });

  it('speaks up, once and in words, when the failures outlast the grace', () => {
    const { clock, said, trouble } = clocked();
    for (clock.t = 0; clock.t <= 6000; clock.t += 1000) trouble.note(BOB, fromWorker(3));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(BOB);
    expect(said[0]).toContain('will not open under any key this device holds');
    expect(said[0]).not.toContain('index 3');
    trouble.keyArrived();
    for (clock.t = 10_000; clock.t <= 15_000; clock.t += 1000) trouble.note(BOB, fromWorker(4));
    expect(said).toHaveLength(2);
  });

  it('keeps each person’s spell apart and drops a leaver’s', () => {
    const { clock, said, trouble } = clocked();
    clock.t = 0;
    trouble.note(BOB, fromWorker(3));
    trouble.note(CAROL, fromWorker(3));
    trouble.forget(BOB);
    for (clock.t = 1000; clock.t <= 4000; clock.t += 1000) trouble.note(CAROL, fromWorker(3));
    clock.t = 4000;
    trouble.note(BOB, fromWorker(3));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(CAROL);
  });
});

describe('whether a device can seal call media at all', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const withScriptTransform = () => vi.stubGlobal('RTCRtpScriptTransform', class {});
  const withEncodedStreams = () => vi.stubGlobal('RTCRtpSender', class {
    createEncodedStreams() { return {}; }
  });

  it('names the transform a device has, and agrees with LiveKit about whether it has one', () => {
    expect(encodedTransform()).toBeNull();
    expect(isE2EESupported()).toBe(false);

    withScriptTransform();
    expect(encodedTransform()).toBe('script-transform');
    expect(isE2EESupported()).toBe(true);

    vi.unstubAllGlobals();
    withEncodedStreams();
    expect(encodedTransform()).toBe('encoded-streams');
    expect(isE2EESupported()).toBe(true);

    withScriptTransform();
    expect(encodedTransform()).toBe('script-transform');
    expect(isE2EESupported()).toBe(true);
  });

  it('asks about a scope rather than this window, so an absent platform can be tested', () => {
    expect(encodedTransform({})).toBeNull();
    expect(encodedTransform({ RTCRtpScriptTransform: class {} })).toBe('script-transform');
    expect(encodedTransform({ RTCRtpSender: class {} })).toBeNull();
  });

  it('tells each host what it is, and never offers to place the call in the clear', () => {
    const hosts = ['browser', 'webkitgtk', 'desktop-webview', 'android', 'electron', 'something-new'];
    for (const host of hosts) {
      const said = unsealableMedia(host);
      expect(said).toContain('cannot encrypt call media end to end');
      expect(said).toContain('never carried any other way');
      expect(said.length).toBeGreaterThan(said.indexOf('never carried any other way') + 40);
    }
    expect(unsealableMedia('webkitgtk')).toContain('WebKitGTK');
    expect(unsealableMedia('browser')).toContain('This browser');
    expect(unsealableMedia('android')).toContain('system WebView');
    expect(unsealableMedia('desktop-webview')).toContain('packaged desktop app');
    expect(unsealableMedia('electron')).toContain('report it');
  });

  it('picks WebKitGTK out of the engines that look like it', () => {
    const gtk = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) '
      + 'Version/8.0 Safari/605.1.15';
    expect(isWebKitGTK(gtk)).toBe(true);
    expect(isWebKitGTK(gtk.replace('X11; Linux x86_64', 'Wayland'))).toBe(true);

    expect(isWebKitGTK('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
      + '(KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe(false);
    expect(isWebKitGTK('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Chrome/140.0.0.0 Safari/537.36')).toBe(false);
    expect(isWebKitGTK('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Telium/0.1.0 Chrome/140.0.0.0 Electron/44.3.0 Safari/537.36')).toBe(false);
    expect(isWebKitGTK('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) '
      + 'Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36')).toBe(false);
    expect(isWebKitGTK('Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'))
      .toBe(false);
    expect(isWebKitGTK(undefined)).toBe(false);
  });
});

describe('media that will not open', () => {
  it('reads a key failure back as something a person can act on', () => {
    for (const reason of [CryptorErrorReason.MissingKey, CryptorErrorReason.InvalidKey]) {
      const said = unopenedMedia({ reason, message: 'missing key at index 241' }, BOB);
      expect(said).toContain(BOB);
      expect(said).toContain('will not open under any key this device holds');
      expect(said).toContain('commit ahead');
      expect(said).not.toContain('241');
    }
  });

  it('reads the worker’s own wording as a key failure too', () => {
    const said = unopenedMedia(
      new Error(`MissingKey: missing key at index 3 for participant ${BOB}`), BOB,
    );
    expect(said).toContain('will not open under any key this device holds');
    expect(said).not.toContain('MissingKey');
    expect(said).not.toContain('index 3');
  });

  it('names nobody in particular when LiveKit could not say whose frame it was', () => {
    const said = unopenedMedia({ reason: CryptorErrorReason.MissingKey }, null);
    expect(said).toMatch(/^Somebody’s/);
  });

  it('passes anything else through rather than guessing', () => {
    const said = unopenedMedia(
      { reason: CryptorErrorReason.InternalError, message: 'worker died' }, BOB,
    );
    expect(said).toContain('worker died');
    expect(said).not.toContain('commit ahead');
  });
});
