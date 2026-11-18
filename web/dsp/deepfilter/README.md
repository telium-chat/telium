# telium-deepfilter

DeepFilterNet3 noise suppression compiled to a plain WebAssembly module, for the client's call audio (`src/lib/denoise-worklet.js`).

## Where the code comes from

`src/lib.rs`, `src/tract.rs`, `src/transforms.rs` and `src/logging.rs` are copied from
[Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) (`libDF/src`) at commit
`7b14b895fe7fc42cab72b4a4c1e49c982bd6404b`, under its MIT / Apache-2.0 licence (`LICENSE-MIT`, `LICENSE-APACHE`, both
copied alongside). The changes are:

- `src/lib.rs` has `mod ffi;` appended.
- `src/tract.rs` spells `m.symbol_table` as `m.symbols` in three places, the one name tract 0.21.16+ changed.
- `Cargo.toml` is ours. It declares the feature names upstream's `cfg`s test (`tract`, `transforms`, `logging`) and holds
  `tract-*` to `~0.21.16` (see the comment there for why not 0.21.4, and why not 0.23).

`src/ffi.rs` is entirely ours. It is the whole interface: `df_alloc`, `df_free`, `df_create`, `df_frame_len`,
`df_process`, `df_destroy`. There is no wasm-bindgen glue, because an `AudioWorkletGlobalScope` has no `TextDecoder`,
and the finished module has **no imports** and needs nothing from JavaScript. (`getrandom`, which tract's hashing asks
for, is given a fixed byte stream in `ffi.rs`; nothing here depends on it being unpredictable.)

To update upstream: copy the four files from the new commit, re-append `mod ffi;`, update `UPSTREAM_COMMIT` and
`MODEL_SHA256` in `../../scripts/build-deepfilter.mjs`, build, and run `bun run test -- src/test/denoise-worklet.test.js`.

## The weights

Not committed. `scripts/build-deepfilter.mjs` fetches upstream's `models/DeepFilterNet3_onnx.tar.gz` at the same pinned
commit and refuses to use it unless its SHA-256 matches. The model is under the same licence as the code.

## Building

```sh
rustup target add wasm32-unknown-unknown
bun run dsp:build        # from web/
```

That writes `src/assets/dsp/deepfilter.wasm` and `deepfilter-model.bin`, both ignored by git. A client built without
them is fine: `denoise-chain.js` finds no engine and every call uses RNNoise. Release builds run the step
(`build-appimage.yml`, `build-windows.yml`), so a failure there is a failed release and not a quieter one.

## What it costs

Measured in Node's WebAssembly engine on a development machine, per 10 ms frame: about 0.9 ms (about 9% of a core),
against about 0.08 ms for RNNoise. Algorithmic delay is 30 ms against RNNoise's 10 ms. The module is 11.7 MB
(2.9 MB gzipped) and the weights 8 MB; neither is fetched unless someone turns Neural noise suppression on.
