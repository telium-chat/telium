// Call privacy posture (direct, relay or sfu): each person enforces their own; the call's effective posture is the strictest in the roster, learned from hellos sealed under a key only the MLS group can derive. A participant not heard from counts as `relay`. The sequencer is only told "route me through an SFU" (`wantsSfu`).

import { b64, unb64 } from './util.js';

export const POSTURES = ['direct', 'relay', 'sfu'];

/// Distinct labels, so a key that opens hellos is no use against media and the reverse.
export const SIGNAL_LABEL = 'telium call signal v1';
export const MEDIA_LABEL = 'telium call media v1';

export const UNKNOWN = 'relay';

export const POSTURE_COPY = {
  direct: {
    label: 'Direct',
    description: 'Connect straight to the others when the network allows. The quickest '
      + 'path, but in a peer-to-peer call everyone in it can see your IP address.',
  },
  relay: {
    label: 'Relay only',
    description: 'Every connection goes through a TURN relay, so nobody in the call learns '
      + 'your address. Needs a relay on your server, or an SFU.',
  },
  sfu: {
    label: 'Through an SFU',
    description: 'Media goes through an SFU and is encrypted end to end, so the SFU cannot '
      + 'hear or see it. The SFU still sees your address and when you talk.',
  },
};

/// Who can observe what in each posture, as parties rather than mechanisms. The relay username is `{expiry}:{user_id}` in plaintext (`turn_credentials` in `server/src/routes/voice.rs`). The SFU sees timing and identity but not content. Keep in agreement with `docs/privacy.md`.
export const POSTURE_OBSERVERS = {
  direct: {
    parties: [
      {
        who: 'Everyone else in the call',
        sees: 'your IP address, and from it roughly where you are. A peer-to-peer '
          + 'connection is made out of addresses; there is no way to hold one without '
          + 'handing yours to the other end.',
      },
      {
        who: 'A STUN server',
        sees: 'your address, and that you started a call at that moment. Your server '
          + 'chooses which one; unless its operator has changed the default, it is '
          + 'Google’s public STUN service.',
      },
    ],
    note: 'If somebody else in the call asks for a relay and your server has one, your '
      + 'client goes through it too for that call, and what \u201cRelay only\u201d says '
      + 'applies to you instead.',
  },
  relay: {
    parties: [
      {
        who: 'Your server’s relay operator',
        sees: 'your address, how much media you send and when you send it, and your '
          + 'Telium account — the relay credential is issued to you by name, so this '
          + 'is not an anonymous address in a log.',
      },
      {
        who: 'Everyone else in the call',
        sees: 'the relay’s address. Not yours.',
      },
    ],
    note: 'While the connection is pinned to a relay, your client stops asking a STUN '
      + 'server for its own address as well. If your server has no relay and the call '
      + 'falls back to an SFU that has none either, it asks again.',
  },
  sfu: {
    parties: [
      {
        who: 'The SFU operator',
        sees: 'your address, who is in the call with you, how long you stay and when each '
          + 'of you is speaking. Not what is said or shown: media is sealed with a key '
          + 'the SFU never holds.',
      },
      {
        who: 'Everyone else in the call',
        sees: 'the SFU’s address. Not yours.',
      },
    ],
    note: 'The SFU learns your address however you reach it, and unless it offers a relay '
      + 'of its own your client asks a STUN server for that address on the way.',
  },
};

export function normalize(posture) {
  return POSTURES.includes(posture) ? posture : 'direct';
}

export function rank(posture) {
  return POSTURES.indexOf(normalize(posture));
}

export function strictest(postures) {
  let out = 'direct';
  for (const p of postures) if (rank(p) > rank(out)) out = normalize(p);
  return out;
}

export function effectivePosture({ own, me, roster = [], hellos = new Map(), epoch = null }) {
  const seen = [normalize(own)];
  for (const userId of roster) {
    if (userId === me) continue;
    const hello = hellos.get(userId);
    const current = hello && (epoch === null || hello.epoch === epoch);
    seen.push(current ? hello.posture : UNKNOWN);
  }
  return strictest(seen);
}

/// `relay` asks for an SFU when this home has no TURN to pin to, which is a fact about the network rather than the person.
export function wantsSfu(own, relayAvailable) {
  const p = normalize(own);
  return p === 'sfu' || (p === 'relay' && !relayAvailable);
}

/// My own posture is binding. The call's effective posture is a courtesy: relaying my side too, unless my home has no TURN.
export function icePolicy({ own, effective, relayAvailable }) {
  if (rank(own) >= rank('relay')) return 'relay';
  if (rank(effective) >= rank('relay') && relayAvailable) return 'relay';
  return 'all';
}

/// `mode` and `endpoint` can disagree, so an SFU with no endpoint is collapsed to a mesh, matching the sequencer (`Call::from_json`). A conversation's own SFU has no endpoint on purpose; its address is in the MLS group.
export function dialable(voiceServer) {
  if (!voiceServer || typeof voiceServer !== 'object') return null;
  const addressed = voiceServer.custom === true
    || (typeof voiceServer.endpoint === 'string' && voiceServer.endpoint.trim() !== '');
  if (voiceServer.mode === 'sfu' && addressed) return voiceServer;
  return { ...voiceServer, mode: 'mesh' };
}

/// Codes: `nothing` (no voice server), `sfu` (posture needs an SFU the call lacks), `relay` (posture needs at least a relay). A posture is never lowered to get a call through.
export function refusalCode(own, voiceServer) {
  const p = normalize(own);
  if (!voiceServer) return 'nothing';
  if (voiceServer.mode === 'sfu') return null;
  if (p === 'sfu') return 'sfu';
  if (p === 'relay' && !voiceServer.relay) return 'relay';
  return null;
}

const te = new TextEncoder();
const td = new TextDecoder();

function aad(conversationId, sender) {
  return te.encode(`telium call hello|${conversationId}|${sender}`);
}

async function importKey(raw, use) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [use]);
}

/// The epoch travels in the clear so a receiver can tell "another epoch" from "forged" without trying keys it lacks.
export async function sealHello(raw, { conversationId, sender, posture, counter, epoch }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = te.encode(JSON.stringify({ posture: normalize(posture), counter }));
  const key = await importKey(raw, 'encrypt');
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(conversationId, sender) }, key, body,
  ));
  return { v: 1, epoch, iv: b64(iv), ct: b64(ct) };
}

export async function openHello(raw, { conversationId, sender, epoch }, sealed) {
  if (!sealed || sealed.v !== 1 || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') return null;
  if (epoch !== undefined && epoch !== null && sealed.epoch !== epoch) return null;
  try {
    const key = await importKey(raw, 'decrypt');
    const body = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv), additionalData: aad(conversationId, sender) },
      key, unb64(sealed.ct),
    );
    const parsed = JSON.parse(td.decode(body));
    if (!POSTURES.includes(parsed?.posture) || !Number.isFinite(parsed?.counter)) return null;
    return { posture: parsed.posture, counter: parsed.counter, epoch: sealed.epoch };
  } catch {
    return null;
  }
}

/// Keeps only the newest hello per sender; the counter stops a replay winning over what they said since.
export function noteHello(hellos, sender, opened) {
  if (!opened) return false;
  const held = hellos.get(sender);
  if (held && held.epoch === opened.epoch && held.counter >= opened.counter) return false;
  hellos.set(sender, opened);
  return true;
}
