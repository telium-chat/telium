# Interoperability fixtures

Frozen wire artifacts (discovery document, gateway IDENTIFY, federation
headers), one directory per shape, replayed by `tests/interop.rs`.

* `v0-legacy/` — every release before the compatibility contract (no `protocol` block).
* `v1/` — the shape this release writes.
* `hypothetical-v2/` — synthetic, outside this build's window, to test refusal.

Never edit a frozen shape; add a new directory. Unknown fields in a fixture are
deliberate. `<token>` placeholders are substituted at replay time.
