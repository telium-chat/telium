import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { wipe } from '../lib/mls.js';
import { FakeHome, device } from './mls-home.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONV = 'walk-prop';
const OPEN = { add: 'anyone', remove: 'anyone', policy: 'anyone' };

function expectedEpoch(frames, seq, generation, founded) {
  let epoch = founded;
  for (const f of frames) {
    if (f.seq > seq) break;
    if (f.kind === 'commit' && f.generation === generation) epoch = Number(f.epoch);
  }
  return epoch;
}

async function run(seed, steps) {
  const random = mulberry32(seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const home = new FakeHome();
  const ids = { a: ['@a:h', 'd-alice'], b: ['@b:h', 'd-bob'], c: ['@c:h', 'd-carol'] };
  const engines = {};
  for (const [k, [u, d]] of Object.entries(ids)) engines[k] = await device(home, u, d);
  const built = await engines.a.establish(CONV, ['@b:h', '@c:h'], { policy: OPEN });
  await home.for(...ids.a).sendFrame(CONV, { kind: 'welcome', ciphertext: built.welcome, epoch: built.epoch });
  const founded = built.epoch;
  const generation = home.generations.get(CONV);
  const log = () => home.frames.get(CONV);
  const seen = { a: 0, b: 0, c: 0 };
  let n = 0;
  const trail = [];

  const check = (k) => {
    const mls = engines[k];
    const where = `seed ${seed}, step ${trail.length}: ${trail.join(',')} (${k}) walked ${mls.walkedTo(CONV)} log ${log().map((f) => `${f.seq}${f.kind[0]}${f.epoch}${f.sender_device.slice(2, 3)}g${f.generation}`).join(' ')}`;
    const walked = mls.walkedTo(CONV);
    expect(walked, `lastSeq went backwards at ${where}`).toBeGreaterThanOrEqual(seen[k]);
    seen[k] = walked;
    if (!mls.joined(CONV)) return;
    const own = log().findLast((f) => f.kind === 'commit' && f.sender_device === ids[k][1]
      && f.generation === generation);
    expect(mls.errorFor(CONV), `walk stopped at ${where}`).toBeFalsy();
    expect(mls.epochOf(CONV), `epoch off the log at ${where}`)
      .toBe(expectedEpoch(log(), Math.max(walked, own?.seq || 0), generation, founded));
  };
  const full = async (k) => { await engines[k].sync(CONV, log()); check(k); };
  const commit = (k) => engines[k].setPolicy(CONV, {
    ...engines[k].policyOf(CONV), ...OPEN, admins: [`@x${n += 1}:h`],
  });

  for (const k of Object.keys(engines)) await full(k);

  for (let i = 0; i < steps; i += 1) {
    const k = pick(['a', 'b', 'c']);
    const other = pick(['a', 'b', 'c'].filter((x) => x !== k));
    const frames = log();
    const op = pick([
      'send', 'send', 'commit', 'race', 'prefix', 'hole', 'replay', 'shuffle', 'stale', 'restart',
    ]);
    trail.push(op);
    switch (op) {
      case 'send':
        await full(k);
        await engines[k].send(CONV, `m${i}`);
        break;
      case 'commit':
        await full(k);
        await commit(k);
        break;
      case 'race': {
        await full(k);
        await full(other);
        await commit(k);
        await commit(other).catch((e) => {
          expect(e.status).toBe(409);
        });
        break;
      }
      case 'prefix':
        await engines[k].sync(CONV, frames.slice(0, Math.floor(random() * (frames.length + 1))));
        break;
      case 'hole': {
        const at = Math.floor(random() * frames.length);
        await engines[k].sync(CONV, frames.filter((_, j) => j !== at));
        check(k);
        await engines[k].sync(CONV, frames);
        break;
      }
      case 'replay': {
        const upto = Math.floor(random() * (frames.length + 1));
        await engines[k].sync(CONV, frames.slice(0, upto));
        check(k);
        await engines[k].sync(CONV, frames.slice(0, upto));
        break;
      }
      case 'shuffle': {
        const copy = [...frames];
        for (let j = copy.length - 1; j > 0; j -= 1) {
          const r = Math.floor(random() * (j + 1));
          [copy[j], copy[r]] = [copy[r], copy[j]];
        }
        await engines[k].sync(CONV, copy);
        break;
      }
      case 'stale': {
        const candidates = frames.filter((f) => f.kind === 'application' || f.kind === 'commit');
        if (!candidates.length) break;
        const old = pick(candidates);
        frames.push({ ...old, id: `late${i}`, frame_id: undefined, seq: frames.length + 1, generation: generation - 1 });
        break;
      }
      case 'restart':
        engines[k] = await device(home, ...ids[k]);
        await engines[k].sync(CONV, []);
        break;
      default:
        break;
    }
    check(k);
    if (op === 'race') check(other);
  }

  for (const k of Object.keys(engines)) await full(k);
  const epochs = new Set(Object.values(engines).map((m) => m.epochOf(CONV)));
  expect(epochs.size, `seed ${seed}: members ended on different epochs`).toBe(1);
  await engines.a.send(CONV, 'last word');
  const last = log().at(-1);
  for (const k of ['b', 'c']) {
    await full(k);
    expect(engines[k].textOf(last.id)).toBe('last word');
  }
}

describe('the walk', () => {
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    localStorage.clear();
    await wipe();
  });

  for (const seed of [1, 7, 42, 1019, 2026, 31337]) {
    it(`never rewinds and always sits on the last commit it walked (seed ${seed})`, async () => {
      await run(seed, 50);
    });
  }
});
