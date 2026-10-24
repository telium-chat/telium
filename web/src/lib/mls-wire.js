// Wire formats: base64 frames, the DM body envelope, and the typed plaintext inside an application message.

import { decodeMlsMessage, encodeMlsMessage } from 'ts-mls';
import { b64, unb64 } from './util.js';

const te = new TextEncoder();
const td = new TextDecoder();

/// The NUL means typed text can never match.
const ENVELOPE = '\u0000telium/dm-body/1\n';

/// Attachment keys go in the encrypted body so only devices that can read the message can open the files.
export function encodeBody(text, attachments, reply = null) {
  if (!attachments?.length && !reply) return text;
  return `${ENVELOPE}${JSON.stringify({ text, attachments: attachments || [], reply })}`;
}

export function decodeBody(raw) {
  if (typeof raw !== 'string' || !raw.startsWith(ENVELOPE)) {
    return { text: raw, attachments: [], reply: null };
  }
  try {
    const body = JSON.parse(raw.slice(ENVELOPE.length));
    return {
      text: body.text || '',
      attachments: body.attachments || [],
      // Older clients ignore the field.
      reply: body.reply || null,
    };
  } catch {
    // Malformed envelope: still readable, so show it.
    return { text: raw, attachments: [], reply: null };
  }
}

// Standard padded alphabet: frames are JSON strings, not URLs.

export const encode64 = b64;

export const wire = {
  keyPackage: (keyPackage) =>
    encodeMlsMessage({ version: 'mls10', wireformat: 'mls_key_package', keyPackage }),
  welcome: (welcome) =>
    encodeMlsMessage({ version: 'mls10', wireformat: 'mls_welcome', welcome }),
  privateMessage: (privateMessage) =>
    encodeMlsMessage({ version: 'mls10', wireformat: 'mls_private_message', privateMessage }),
  publicMessage: (publicMessage) =>
    encodeMlsMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage }),
  groupInfo: (groupInfo) =>
    encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo }),
};


export function decodeMessage(text) {
  const decoded = decodeMlsMessage(unb64(text), 0);
  if (!decoded) throw new Error('frame is not a well-formed MLS message');
  return decoded[0];
}

// The type is a leading byte, not a JSON field, so pasted text can't pose as a receipt.

export const MESSAGE = 0x00;
export const RECEIPT = 0x01;
export const TYPING = 0x02;
export const REACTION = 0x03;
export const EDIT = 0x04;
export const DELETE = 0x05;
export const PIN = 0x06;
export const CALL_SFU = 0x07;
/// A device saying it has opened everything up to a point: a machine got the bytes, not that a person looked. It names the one device it speaks for, which must be the MLS leaf the frame came from (`applyAck`). When both are due, the ack rides inside the RECEIPT as `ack`.
export const DELIVERED = 0x08;


export function pack(tag, body) {
  const bytes = te.encode(body);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = tag;
  out.set(bytes, 1);
  return out;
}

function typedJson(type, bytes, fallback) {
  try { return { type, ...JSON.parse(td.decode(bytes.subarray(1))) }; }
  catch { return fallback; }
}

/// Unknown leading bytes become signals (rendered as nothing), not text that would print a newer wire format.
export function unpack(bytes) {
  switch (bytes[0]) {
    case MESSAGE:
      return { type: 'message', text: td.decode(bytes.subarray(1)) };
    case RECEIPT:
      return typedJson('receipt', bytes, { type: 'receipt' });
    case TYPING:
      return { type: 'typing' };
    case REACTION:
      return typedJson('reaction', bytes, { type: 'unknown' });
    case EDIT:
      return typedJson('edit', bytes, { type: 'unknown' });
    case DELETE:
      return typedJson('delete', bytes, { type: 'unknown' });
    case PIN:
      return typedJson('pin', bytes, { type: 'unknown' });
    case CALL_SFU:
      return typedJson('call_sfu', bytes, { type: 'unknown' });
    case DELIVERED:
      try { return { type: 'delivered', ack: JSON.parse(td.decode(bytes.subarray(1))) }; }
      catch { return { type: 'delivered', ack: null }; }
    default:
      return { type: 'unknown' };
  }
}
