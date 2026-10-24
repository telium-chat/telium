import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { ControlPlaneContext } from '../views/control-plane/context.js';
import { OverviewPane } from '../views/control-plane/OverviewPane.jsx';
import { signals, verdict } from '../views/control-plane/health.js';

const QUIET = {
  enabled: true,
  requests: { total: 5000, responses_5xx: 0 },
  latency: { p99_ms: 40, over_ceiling: 0, ceiling_ms: 8 },
  federation: { backlog: 0, backlog_oldest_ms: 0, peers: 3, peers_failing: 0 },
  pool: { connections: 2, idle: 3, max: 5 },
};
const ERRORING = { ...QUIET, requests: { total: 1000, responses_5xx: 20 } };

const finding = (over = {}) => ({
  key: 'keys.expiring',
  severity: 'warning',
  title: 'A federation signing key expires soon',
  cause: 'The active key for home.example expires in 6 days.',
  action: 'Run `telium keys rotate` and restart.',
  ...over,
});

const run = (health, { metrics = QUIET, status = {} } = {}) => signals({ metrics, status, health });
const keys = (list) => list.map((s) => s.key);

describe('merging server findings', () => {
  it('keeps cause and action separate and marks the source', () => {
    expect(run({ signals: [finding()] })[0]).toMatchObject({
      key: 'keys.expiring',
      detail: 'The active key for home.example expires in 6 days.',
      action: 'Run `telium keys rotate` and restart.',
      source: 'server',
    });
  });

  it('maps severities to tones (unknown -> accent) and drops keyless findings', () => {
    const list = run({
      signals: [
        finding({ key: 'storage.full', severity: 'critical' }),
        finding({ key: 'keys.expiring', severity: 'warning' }),
        finding({ key: 'updates.behind', severity: 'notice' }),
        finding({ key: 'new.word', severity: 'catastrophic' }),
        { severity: 'critical', title: 'nameless' },
      ],
    });
    expect(Object.fromEntries(list.map((s) => [s.key, s.tone]))).toEqual({
      'storage.full': 'danger', 'keys.expiring': 'warn', 'updates.behind': 'accent', 'new.word': 'accent',
    });
  });

  it('sorts loudest first, server ahead of client at the same tone', () => {
    const list = run({ signals: [finding({ key: 'updates.behind', severity: 'notice' }), finding({ key: 'storage.full', severity: 'critical' })] }, { metrics: ERRORING });
    expect(keys(list)).toEqual(['storage.full', 'errors', 'updates.behind']);
    expect(verdict(list)).toMatchObject({ tone: 'danger' });
  });

  it('states a stale backup once, preferring the server, without suppressing unrelated client signals', () => {
    const STALE = { backup: { enabled: true, stale: true, age_ms: 4 * 86_400_000 } };
    expect(keys(run({ signals: [finding({ key: 'backup.stale', severity: 'critical' })] }, { status: STALE }))).toEqual(['backup.stale']);
    expect(run({ signals: [] }, { status: STALE })).toMatchObject([{ key: 'backup', action: null }]);
    const slow = { ...QUIET, latency: { p99_ms: 9000, over_ceiling: 0, ceiling_ms: 16 } };
    expect(keys(run({ signals: [finding({ key: 'backup.stale' })] }, { metrics: slow })).sort()).toEqual(['backup.stale', 'latency']);
  });

  it('leaves client findings intact when the server has no health endpoint', () => {
    expect(run(null)).toEqual([]);
    expect(keys(run(undefined, { metrics: ERRORING }))).toEqual(['errors']);
  });
});

function overview(health) {
  const home = new Proxy({}, { get: () => async () => ({}) });
  const store = signedInStore({ me: { admin: true } });
  store.home = home;
  const slot = (over) => ({ data: null, error: null, at: Date.now(), loading: false, reload: () => {}, ...over });
  const value = {
    home,
    metrics: slot({ data: { ...QUIET, server_name: 'home.example', uptime_ms: 3_600_000, storage: {}, gateway: {}, messages: {}, routes: [] } }),
    status: slot({}),
    health: slot(health),
    stepUp: { elevated: false, expiresAt: null, isElevated: () => false, elevate: async () => false, drop: async () => {}, reload: () => {} },
    pollMs: 15_000,
  };
  return mount(<ControlPlaneContext.Provider value={value}><OverviewPane /></ControlPlaneContext.Provider>, store);
}

describe('the overview', () => {
  it('shows the action, not only the evidence', async () => {
    overview({ data: { signals: [finding({ severity: 'critical' })] } });
    expect(await screen.findByText('A federation signing key expires soon')).toBeTruthy();
    expect(screen.getByText('Run `telium keys rotate` and restart.')).toBeTruthy();
    expect(screen.getByText('Something is wrong')).toBeTruthy();
  });

  it('says the deeper checks were unavailable on an older server', async () => {
    overview({ error: Object.assign(new Error('not found'), { status: 404 }) });
    expect(await screen.findByText('Nothing is on fire')).toBeTruthy();
    expect(screen.getByText(/does not offer the deeper checks/)).toBeTruthy();
  });
});
