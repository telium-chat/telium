// Frame id is a hash of the ciphertext, so every retry of a frame carries the same id.
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url } from './util.js';

const encoder = new TextEncoder();

export function frameIdOf(ciphertext) {
  return b64url(sha256(encoder.encode(String(ciphertext ?? ''))));
}

/// A `rejoin` has an empty ciphertext, so every one would hash the same.
export function withFrameId(body) {
  if (!body || body.frame_id || body.kind === 'rejoin' || !body.ciphertext) return body;
  return { ...body, frame_id: frameIdOf(body.ciphertext) };
}
