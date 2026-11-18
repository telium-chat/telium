#!/usr/bin/env node
// Builds the DeepFilterNet3 noise-suppression engine and stages it where the client looks for it:
//
//   src/assets/dsp/deepfilter.wasm        the engine (dsp/deepfilter, a plain wasm module with a C ABI)
//   src/assets/dsp/deepfilter-model.bin   upstream's DeepFilterNet3 weights (a .tar.gz, named .bin so no server or CDN "helpfully" decompresses it in transit)
//
// Both are build output and are not committed. A client built without them still works: the call code asks whether they exist and uses RNNoise when they do not (src/lib/denoise-chain.js).
//
// The weights are fetched from upstream at a pinned commit and checked against a pinned SHA-256 before they are used, so a moved branch or a changed file fails the build instead of shipping. Needs Rust with the wasm32-unknown-unknown target: `rustup target add wasm32-unknown-unknown`.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRATE = join(WEB, 'dsp', 'deepfilter')
const OUT = join(WEB, 'src', 'assets', 'dsp')
const CACHE = join(CRATE, 'target', 'model')

// Rikorose/DeepFilterNet, the commit the vendored sources in dsp/deepfilter/src came from.
const UPSTREAM_COMMIT = '7b14b895fe7fc42cab72b4a4c1e49c982bd6404b'
const MODEL_PATH = 'models/DeepFilterNet3_onnx.tar.gz'
const MODEL_SHA256 = 'c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616'
const MODEL_URL = `https://raw.githubusercontent.com/Rikorose/DeepFilterNet/${UPSTREAM_COMMIT}/${MODEL_PATH}`

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function model() {
  const cached = join(CACHE, 'DeepFilterNet3_onnx.tar.gz')
  if (existsSync(cached) && sha256(readFileSync(cached)) === MODEL_SHA256) return cached
  console.log(`fetching ${MODEL_URL}`)
  const response = await fetch(MODEL_URL)
  if (!response.ok) throw new Error(`model fetch returned ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const got = sha256(bytes)
  if (got !== MODEL_SHA256) {
    throw new Error(`model hash mismatch: expected ${MODEL_SHA256}, got ${got}. Refusing to use it.`)
  }
  mkdirSync(CACHE, { recursive: true })
  writeFileSync(cached, bytes)
  return cached
}

const weights = await model()
execFileSync(
  'cargo',
  ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', join(CRATE, 'Cargo.toml')],
  { stdio: 'inherit', cwd: CRATE }, // cwd so the crate's .cargo/config.toml (getrandom backend flag) applies
)

mkdirSync(OUT, { recursive: true })
copyFileSync(join(CRATE, 'target', 'wasm32-unknown-unknown', 'release', 'telium_deepfilter.wasm'), join(OUT, 'deepfilter.wasm'))
copyFileSync(weights, join(OUT, 'deepfilter-model.bin'))
console.log(`staged DeepFilterNet3 in ${OUT}`)
