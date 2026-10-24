# telium-protocol

`telium-protocol` is the small Rust crate for protocol details that **must agree byte-for-byte between independent Telium components**.

Today its primary consumers are `telium-server` and `telium-sfu`. It intentionally is not a general utility crate.

## Why it exists

The homeserver mints signed data that the SFU verifies. If the two binaries disagree about JSON bytes, base64 alphabet, signature stripping, or shared token constants, calls fail even though both sides are individually “correct.” Keeping those rules in one crate removes that drift class.

## Signed JSON format

A signed object carries:

```json
{
  "...": "payload fields",
  "key_id": "ed25519:...",
  "signature": "..."
}
```

`sign_json` performs these steps:

1. clone/use the JSON object;
2. remove any pre-existing `key_id` and `signature` fields;
3. serialize the remaining `serde_json::Value` with `serde_json::to_vec`;
4. Ed25519-sign those bytes;
5. append `key_id` and the signature.

`verify_json` repeats the same stripping/serialization and verifies the signature against the supplied public key.

This is a protocol contract. Do not change canonicalization on one side only.

## Base64

Published Ed25519 keys and signatures use URL-safe base64 without padding:

```text
URL_SAFE_NO_PAD
```

That matches the reference homeserver's signing helpers. Using standard base64 would reject valid `-` / `_` characters or create a server/SFU incompatibility.

Helpers:

- `b64(bytes)` — encode URL-safe, no-padding base64;
- `unb64(str)` — decode, returning `None` for malformed input;
- `verify_bytes(public_b64, message, sig_b64)` — verify a raw Ed25519 signature.

## Screenshare watch-quality vocabulary

The crate defines the closed watch-quality set shared by guild server, SFU, and client:

```text
auto
low
medium
high
```

`is_watch_quality` rejects unknown/case-changed values rather than silently creating a new quality semantic on one component.

`auto` leaves layer selection to LiveKit's adaptive behavior. The other values are Telium's explicit viewer preference levels.

## Shared LiveKit metadata

`MAX_BITRATE_ATTRIBUTE` is the LiveKit participant attribute used for the effective per-participant publish ceiling stamped into the SFU access token:

```text
telium.max_bitrate
```

The participant cannot arbitrarily rewrite this as an authoritative value because the issued token does not grant self-metadata mutation for that purpose.

`WATCH_TOPIC` is the LiveKit data-message topic used for the SFU/watch-quality control message:

```text
telium.watch
```

The payload identifies the streamer and requested quality for the viewer.

## Tests

The crate has deterministic tests for:

- sign -> verify round trips;
- tampered body rejection;
- wrong-key rejection;
- the closed watch-quality vocabulary.

Run them with:

```sh
cd telium-protocol
cargo test
```

When changing a value consumed by both server and SFU, also run the corresponding server/SFU tests and packaged/browser call integration where relevant.

## What does not belong here

Do not put ordinary server helpers or client product logic in this crate merely because two files could share code. A good candidate belongs here when protocol interoperability would break if two Rust components implemented it independently and drifted.

For the overall call protocol, see [`../docs/calls.md`](../docs/calls.md). For federation signing/discovery, see [`../docs/federation.md`](../docs/federation.md).
