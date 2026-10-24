import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { ControlPlaneContext } from '../views/control-plane/context.js';
import { OverviewPane } from '../views/control-plane/OverviewPane.jsx';
import { restoreReadiness, signals } from '../views/control-plane/health.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plane(status) {
  const store = signedInStore({ me: { admin: true } });
  const home = new Proxy({
    adminMetricsSeries: async () => ({ enabled: true, points: [] }),
  }, { get: (target, key) => (key in target ? target[key] : async () => ({})) });
  store.home = home;
  const snap = (data) => ({ data, error: null, at: Date.now(), loading: false, reload: () => {} });
  const value = {
    home,
    metrics: snap({
      enabled: true, server_name: 'home.example', uptime_ms: HOUR, requests: {}, latency: {},
      storage: {}, gateway: {}, federation: {}, messages: {}, pool: {}, routes: [],
    }),
    status: snap(status),
    pollMs: 15_000,
  };
  mount(<ControlPlaneContext.Provider value={value}><OverviewPane /></ControlPlaneContext.Provider>, store);
  return screen.getByText('Could this server recover right now?').closest('.cp-tile');
}

const VERIFIED = {
  schema_version: 57, binary_schema_version: 57, integrity: true, database_bytes: 82_100_224,
  signing_keys: 1, accounts: 412, devices: 907, push_keys: 1, auth_secrets: 1, guilds: 14,
  messages: 1_204_887,
  parts: [{ kind: 'media', files_declared: 3120, files_seen: 3120, bytes: 4_000_000_000 }],
};

function passing(over = {}, backup = {}) {
  return {
    backup: {
      enabled: true,
      age_ms: 20 * MINUTE,
      ...backup,
      drill: {
        enabled: true, verdict: 'passed', interval_secs: 86_400, stale_after_secs: 3 * 86_400,
        at: Date.now() - 2 * HOUR, age_ms: 2 * HOUR,
        passed_at: Date.now() - 2 * HOUR, passed_age_ms: 2 * HOUR,
        source: 'remote', archive: 's3://backups/telium/2026-09-20T02-00-00Z.tbk',
        archive_age_ms: 3 * HOUR, took_ms: 41_000,
        failure: null, reason: null, advice: null, warnings: [], verified: VERIFIED,
        ...over,
      },
    },
  };
}

const restoreSignal = (status) => signals({ metrics: { enabled: true }, status })
  .find((s) => s.key === 'restore');

describe('the answer on screen', () => {
  it('is Yes with the drill age, the source and the counts when one passed', async () => {
    const box = plane(passing());
    expect(within(box).getByText('Yes')).toBeTruthy();
    expect(box.dataset.tone).toBe('accent');
    expect(within(box).getByText(/from the bucket/)).toBeTruthy();
    expect(within(box).getByText(/2h ago/)).toBeTruthy();
    expect(await screen.findByText('Federation signing keys')).toBeTruthy();
    expect(screen.getByText('412 — 907 devices')).toBeTruthy();
    expect(screen.getByText(/integrity check passed/)).toBeTruthy();
    expect(screen.getByText(/3,120 of 3,120 files/)).toBeTruthy();
    expect(screen.getByText(/does not prove the key exists anywhere else/)).toBeTruthy();
    expect(restoreSignal(passing())).toBeUndefined();
  });

  it('is No with the reason, the advice and the last pass when the drill failed', () => {
    const box = plane(passing({
      verdict: 'failed', ok: false, failure: 'cannot-decrypt',
      reason: 'chunk 0 failed to authenticate: this key does not open this archive',
      advice: 'The key on this machine does not open the archive. Find the key they were sealed under.',
      verified: null,
    }));
    expect(within(box).getByText('No')).toBeTruthy();
    expect(box.dataset.tone).toBe('danger');
    expect(within(box).getByText(/this key does not open this archive/)).toBeTruthy();
    expect(within(box).getByText(/Find the key they were sealed under/)).toBeTruthy();
    expect(screen.getByText('Last proved recoverable')).toBeTruthy();
    expect(screen.getByText('2h ago')).toBeTruthy();

    const signal = restoreSignal(passing({ verdict: 'failed', ok: false, failure: 'corrupt', reason: 'chunk 41 failed' }));
    expect(signal.tone).toBe('danger');
    expect(signal.detail).toMatch(/chunk 41 failed/);
  });

  it('is Unknown, not No, and only warns, when no drill has ever run', () => {
    const neverRun = passing({
      verdict: 'never-run', at: null, age_ms: null, passed_at: null, passed_age_ms: null,
      source: null, archive: null, archive_age_ms: null, took_ms: null, verified: null,
    });
    const box = plane(neverRun);
    expect(within(box).getByText('Unknown')).toBeTruthy();
    expect(within(box).queryByText('No')).toBeNull();
    expect(box.dataset.tone).toBe('warn');
    expect(within(box).getByText(/files nobody has ever read/)).toBeTruthy();
    expect(screen.getByText('never')).toBeTruthy();
    expect(restoreSignal(neverRun).tone).toBe('warn');
  });
});

describe('restoreReadiness', () => {
  it('reads a stale pass as Unknown', () => {
    const ready = restoreReadiness(passing({ verdict: 'stale', passed_age_ms: 41 * DAY, age_ms: 41 * DAY }));
    expect(ready.answer).toBe('unknown');
    expect(ready.word).toBe('Unknown');
    expect(ready.because).toMatch(/41d ago/);
    expect(ready.advice).toMatch(/backup drill/);
  });

  it('reads backups switched off as No', () => {
    const ready = restoreReadiness(passing({}, { enabled: false }));
    expect(ready.answer).toBe('no');
    expect(ready.because).toMatch(/switched off/);
  });

  it('is Unknown without nagging for a build with no drill, or before the server answers', () => {
    const noDrill = restoreReadiness({ backup: { enabled: true, age_ms: 1000 } });
    expect(noDrill.answer).toBe('unknown');
    expect(noDrill.because).toMatch(/no restore drill in it/);
    expect(noDrill.firing).toBe(false);
    const empty = restoreReadiness(null);
    expect(empty.answer).toBe('unknown');
    expect(empty.checked).toEqual([]);
    expect(empty.firing).toBe(false);
  });

  it('keeps a warning without turning Yes into No, and names a local copy as weaker', () => {
    const warned = restoreReadiness(passing({ warnings: ['the backup key is inside the data store'] }));
    expect(warned.answer).toBe('yes');
    expect(warned.warnings).toHaveLength(1);
    const local = restoreReadiness(passing({ source: 'local', archive: '/var/lib/telium/backups/x.tbk' }));
    expect(local.source).toBe('local');
    expect(local.sourceText).toMatch(/a lost disk takes with it/);
  });

  it('reports migratable schemas and tells a pre-OPAQUE archive from an empty table', () => {
    const checked = (v) => restoreReadiness(passing({ verified: { ...VERIFIED, ...v } })).checked;
    const schema = checked({ schema_version: 55 }).find((c) => c.key === 'schema').value;
    expect(schema).toMatch(/55/);
    expect(schema).toMatch(/can migrate it forward/);
    const auth = (v) => checked({ auth_secrets: v }).find((c) => c.key === 'auth').value;
    expect(auth(null)).toMatch(/not in this archive/);
    expect(auth(0)).toBe('empty');
    expect(auth(1)).toBe('present');
  });
});

describe('what the backup cannot contain at all', () => {
  const inBuckets = [
    {
      kind: 'media', reason: 'object-store', detail: 's3://telium-media',
      says: 'media is in s3://telium-media and is not in the backup: a restore brings back the '
        + 'database and every attachment in it would 404',
    },
    {
      kind: 'cold', reason: 'object-store', detail: 's3://telium-cold',
      says: 'cold archive segments are in s3://telium-cold and are not in the backup: they are '
        + 'the only copy of the messages the sweep moved out of the database',
    },
  ];

  it('is said next to a passing drill, on screen and as its own warn signals', () => {
    const status = passing({}, { excluded: inBuckets });
    expect(within(plane(status)).getByText('Yes')).toBeTruthy();
    expect(screen.getAllByText(/every attachment in it would 404/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/only copy of the messages/).length).toBeGreaterThan(0);

    const list = signals({ metrics: { enabled: true }, status });
    const raised = list.filter((s) => s.key.startsWith('backup-excluded-'));
    expect(raised).toHaveLength(2);
    expect(raised.every((s) => s.tone === 'warn')).toBe(true);
    expect(list.find((s) => s.key === 'restore')).toBeUndefined();
  });

  it('does not repeat the drill\'s copy of the same sentence as a warning', () => {
    const ready = restoreReadiness(passing(
      { warnings: [`the archive drilled says ${inBuckets[0].says}`, 'something else entirely'] },
      { excluded: inBuckets },
    ));
    expect(ready.warnings).toEqual(['something else entirely']);
    expect(ready.excluded).toHaveLength(2);
  });

  it('mentions an omission the operator asked for without raising anything', () => {
    const status = passing({}, {
      excluded: [{ kind: 'media', reason: 'disabled', detail: null, says: 'media is excluded by backup.include_media = false' }],
    });
    const ready = restoreReadiness(status);
    expect(ready.excluded).toEqual([]);
    expect(ready.omitted).toHaveLength(1);
    expect(signals({ metrics: { enabled: true }, status }).some((s) => s.key.startsWith('backup-excluded'))).toBe(false);
    plane(status);
    expect(screen.getByText(/include_media = false/)).toBeTruthy();

    const none = restoreReadiness(passing());
    expect(none.excluded).toEqual([]);
    expect(none.omitted).toEqual([]);
  });
});
