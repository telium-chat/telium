import {
  BaseKeyProvider, createKeyMaterialFromBuffer, CryptorErrorReason, KeyProviderEvent,
} from 'livekit-client';
import { isAndroid, isElectronRuntime, isTauri } from './platform.js';

// Conversation-call E2EE on an SFU: every group member exports the same secret per epoch; the epoch picks the slot in LiveKit's key ring so frames sealed just before a membership change still open.

/// LiveKit's key ring is 16 deep.
export function keySlot(epoch) {
  return Number(epoch) % 16;
}

/// A new key opens frames at once but seals only after this delay, so listeners have it installed.
export const KEY_SWITCH_DELAY_MS = 2000;

export class MlsKeyProvider extends BaseKeyProvider {
  constructor({ switchDelay = KEY_SWITCH_DELAY_MS } = {}) {
    // No ratcheting (the group never agreed on a derived key). No failure tolerance: the count is per slot for the whole room, so one participant a commit ahead would drop the slot for everybody.
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1 });
    this.epoch = null;
    this.pending = null;
    this.newest = null;
    this.switchDelay = switchDelay;
  }

  /// Compares bytes, not epoch: a restarted conversation can sit at the same epoch under a different key.
  holds(raw) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw || []);
    const have = this.newest;
    if (!have || have.length !== bytes.length) return false;
    return have.every((b, i) => b === bytes[i]);
  }

  /// The first key seals straight away. The latest call wins whatever its number: a guild call's group can restart at epoch 0.
  async setEpochKey(raw, epoch) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    const material = await createKeyMaterialFromBuffer(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const next = Number(epoch);
    if (this.holds(bytes) && next === this.latest) return;
    this.newest = bytes.slice();
    // Held back only with a slot of its own: the worker seals under whatever is in the sending slot.
    if (this.epoch === null || this.switchDelay <= 0 || keySlot(next) === keySlot(this.epoch)) {
      this.seal(material, next);
      return;
    }
    this.hold(material, next);
    clearTimeout(this.pending?.timer);
    const timer = setTimeout(() => {
      if (this.pending?.timer !== timer) return;
      this.seal(material, next);
    }, this.switchDelay);
    this.pending = { epoch: next, timer };
  }

  get latest() {
    return this.pending ? this.pending.epoch : this.epoch;
  }

  hold(material, epoch) {
    const keyInfo = { key: material, participantIdentity: undefined, keyIndex: keySlot(epoch) };
    // Filed with the rest, so a reconnect hands the worker this one too.
    this.keyInfoMap.set(`shared-${keyInfo.keyIndex}`, keyInfo);
    this.emit(KeyProviderEvent.SetKey, keyInfo, false);
  }

  seal(material, epoch) {
    clearTimeout(this.pending?.timer);
    this.pending = null;
    this.epoch = epoch;
    this.onSetEncryptionKey(material, undefined, keySlot(epoch));
  }

  dispose() {
    clearTimeout(this.pending?.timer);
    this.pending = null;
  }
}

/// Asked of the key ring, not the epoch hellos were sealed under, and of the key as well as its epoch (a restarted conversation can return at the same epoch under a different key).
export function mediaKeyBehind(call, secret) {
  const ring = call?.e2ee?.keyProvider;
  if (!ring || !call.rekey || !secret?.key) return false;
  return ring.latest === null || Number(ring.latest) !== Number(secret.epoch)
    || !ring.holds(secret.key);
}

/// The worker posts a plain `Error` whose message leads with the reason's name; the numeric `reason` only survives on this side. Both are read.
export function keyFailure(error) {
  if (error?.reason === CryptorErrorReason.MissingKey
    || error?.reason === CryptorErrorReason.InvalidKey) return true;
  return /^(MissingKey|InvalidKey)\b/.test(String(error?.message || ''));
}

/// A few seconds of failures is normal at every join and leave.
export const KEY_TROUBLE_GRACE_MS = 4000;
/// A pause this long ends the spell.
export const KEY_TROUBLE_GAP_MS = 2500;
/// A persistent mismatch may merit another warning, but not every MLS commit.
export const KEY_TROUBLE_REPORT_COOLDOWN_MS = 120_000;
/// The server rejects group resets made within 15 seconds of a key commit.
export const KEY_REPAIR_DELAY_MS = 16_000;

/// No event says a frame opened, so a spell is failures with no gap over `gap`; one lasting `grace` is reported once per key.
export class KeyTrouble {
  constructor({
    report, grace = KEY_TROUBLE_GRACE_MS, gap = KEY_TROUBLE_GAP_MS,
    cooldown = KEY_TROUBLE_REPORT_COOLDOWN_MS, now = () => Date.now(),
  }) {
    this.report = report;
    this.grace = grace;
    this.gap = gap;
    this.cooldown = cooldown;
    this.now = now;
    this.spells = new Map();
    this.reported = new Map();
    this.lastFailed = new Map();
  }

  /// `who` is null when LiveKit couldn't say whose frame it was.
  note(who, error) {
    const id = who || '';
    const at = this.now();
    // Keep observing failures after the first toast. A repair should happen
    // only if media continues failing, not if an old error was followed by
    // healthy playback.
    this.lastFailed.set(id, at);
    if (at - (this.reported.get(id) ?? -Infinity) < this.cooldown) return;
    let spell = this.spells.get(id);
    if (!spell || at - spell.last > this.gap) {
      spell = { first: at, last: at };
      this.spells.set(id, spell);
    }
    spell.last = at;
    if (at - spell.first < this.grace) return;
    this.spells.delete(id);
    this.reported.set(id, at);
    this.report(error, who);
  }

  recent(who, within = this.gap) {
    return this.now() - (this.lastFailed.get(who || '') ?? -Infinity) <= within;
  }

  keyArrived() {
    this.spells.clear();
    // A new key is not proof that any received media decrypted. Keep the
    // report cooldown until a peer leaves or the period actually expires.
  }

  forget(who) {
    this.spells.delete(who || '');
    this.reported.delete(who || '');
    this.lastFailed.delete(who || '');
  }
}

/// One bounded attempt to repair a persistently incompatible guild media
/// key. The server decides whether its encryption group is quiet enough to
/// reset; callers must also guard their call and MLS-group identity.
export class KeyRepair {
  constructor({
    check, reset, recent, active, delay = KEY_REPAIR_DELAY_MS,
    onFailure = () => {},
  }) {
    this.check = check;
    this.reset = reset;
    this.recent = recent;
    this.active = active;
    this.delay = delay;
    this.onFailure = onFailure;
    this.timer = null;
    this.attempted = false;
    this.stopped = false;
  }

  note(who) {
    if (this.stopped || !this.active()) return;
    // Give normal commit catch-up the first opportunity to repair the call.
    Promise.resolve().then(() => this.check()).catch(() => {});
    if (this.timer || this.attempted) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.stopped || !this.active() || !this.recent(who)) return;
      try {
        await this.check();
      } catch {
        // An unavailable homeserver cannot safely confirm group state.
        return;
      }
      if (this.stopped || !this.active() || !this.recent(who)) return;
      this.attempted = true;
      try {
        await this.reset();
      } catch (error) {
        this.onFailure(error);
      }
    }, this.delay);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/// Key failures get the usual cause (a commit apart); anything else passes LiveKit's message through.
export function unopenedMedia(error, who) {
  const whose = who ? `${who}’s` : 'Somebody’s';
  if (keyFailure(error)) {
    return `${whose} audio and video will not open under any key this device holds. Usually `
      + 'that is one of you a commit ahead of the other, which the next one settles.';
  }
  return `${whose} call media could not be decrypted: ${error?.message || String(error)}`;
}

/// Copied from livekit-client's `isE2EESupported`; `callmode.test.js` pins the copy.
export function encodedTransform(scope = globalThis) {
  if (typeof scope?.RTCRtpScriptTransform !== 'undefined') return 'script-transform';
  if (typeof scope?.RTCRtpSender?.prototype?.createEncodedStreams !== 'undefined') {
    return 'encoded-streams';
  }
  return null;
}

/// WebKit GTK/WPE expose `RTCRtpScriptTransform` but the GStreamer transform is a stub (webkit.org/b/235885), so the presence check is overruled. Detected by absence of Chromium/Gecko/Android markers.
export function isWebKitGTK(ua) {
  const agent = String(ua || '');
  if (!/AppleWebKit/.test(agent)) return false;
  if (/Chrome|Chromium|Android|Edg\//.test(agent)) return false;
  return /X11|Linux|Wayland|WPE/.test(agent);
}

/// The remedy differs by host; the refusal does not.
export function unsealableMedia(host) {
  const what = {
    electron: 'This build of the desktop app',
    webkitgtk: 'WebKitGTK, the engine behind this window,',
    'desktop-webview': 'The webview hosting this desktop build',
    android: 'This device’s system WebView',
    browser: 'This browser',
  }[host] || 'This device';
  const fix = {
    // Chromium has had `createEncodedStreams` since 2020: a broken build.
    electron: 'That should not be possible in this build — please report it.',
    webkitgtk: 'It offers the API but never applies it. Firefox, Chrome, or the '
      + 'packaged desktop app can place the call.',
    'desktop-webview': 'The packaged desktop app, or this client in Firefox or Chrome, can place it.',
    android: 'Updating Android System WebView is usually the fix.',
  }[host] || 'A current Firefox, Chrome, Edge or Safari can place it.';
  return `${what} cannot encrypt call media end to end, and a conversation’s call on an SFU `
    + `is never carried any other way. ${fix}`;
}

/// WebKitGTK is asked first: it is the engine under both GNOME Web and Tauri's Linux webview.
function callHost(scope = globalThis) {
  if (isWebKitGTK(scope?.navigator?.userAgent)) return 'webkitgtk';
  if (isElectronRuntime()) return 'electron';
  if (isTauri) return isAndroid ? 'android' : 'desktop-webview';
  return 'browser';
}

/// The worker loads lazily.
export async function callE2EE(scope = globalThis) {
  const host = callHost(scope);
  // Absent, or (WebKitGTK) present but hollow.
  if (host === 'webkitgtk' || !encodedTransform(scope)) throw new Error(unsealableMedia(host));
  const { default: E2EEWorker } = await import('livekit-client/e2ee-worker?worker');
  return { keyProvider: new MlsKeyProvider(), worker: new E2EEWorker() };
}

