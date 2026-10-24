import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { ControlPlaneContext } from '../views/control-plane/context.js';
import { OverviewPane } from '../views/control-plane/OverviewPane.jsx';
import { ModerationPane } from '../views/control-plane/ModerationPane.jsx';
import { FederationPane } from '../views/control-plane/FederationPane.jsx';
import { HostingPane } from '../views/control-plane/HostingPane.jsx';
import { signals, verdict } from '../views/control-plane/health.js';
import { UserSettings } from '../views/user-settings/UserSettings.jsx';

function fakeHome(overrides = {}) {
  const base = {
    adminMetricsSeries: async () => ({ enabled: true, points: [], retention_days: 14 }),
    adminModerationSummary: async () => ({ counts: {}, resolution: { samples: 0 } }),
    adminReports: async () => ({ reports: [] }),
    adminStatus: async () => ({ server_name: 'home.example', open_reports: 0, defederated: 0 }),
    ...overrides,
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : async () => ({})),
  });
}

function plane(ui, { metrics = {}, status = {}, home = fakeHome(), stepUp = {} } = {}) {
  const store = signedInStore({ me: { admin: true } });
  store.home = home;
  const value = {
    home,
    metrics: { data: null, error: null, at: Date.now(), loading: false, reload: () => {}, ...metrics },
    status: { data: null, error: null, at: Date.now(), loading: false, reload: () => {}, ...status },
    stepUp: {
      elevated: true,
      expiresAt: Date.now() + 300_000,
      isElevated: () => true,
      elevate: async () => true,
      drop: () => {},
      reload: () => {},
      ...stepUp,
    },
    pollMs: 15_000,
  };
  return mount(
    <ControlPlaneContext.Provider value={value}>{ui}</ControlPlaneContext.Provider>,
    store,
  );
}

describe('what the server did not measure', () => {
  it('draws a percentile it has too few samples for as absent, not as zero', async () => {
    plane(<OverviewPane />, {
      metrics: {
        data: {
          enabled: true,
          server_name: 'home.example',
          uptime_ms: 60_000,
          requests: { total: 12, federation: 0, responses_4xx: 0, responses_5xx: 0 },
          latency: { samples: 12, p50_ms: 1.5, p90_ms: null, p99_ms: null, over_ceiling: 0, ceiling_ms: 8 },
          storage: { db_bytes: 4096, media_objects: null, media_bytes: null },
          gateway: {}, federation: {}, messages: {}, pool: {}, routes: [],
        },
      },
    });

    const p99 = (await screen.findByText('p99')).closest('.cp-tile');
    expect(within(p99).getByText('—')).toBeTruthy();
    expect(within(p99).queryByText('0ms')).toBeNull();
    expect(within(p99).getByText(/needs 100 samples/)).toBeTruthy();

    const media = (await screen.findByText('Media stored')).closest('.cp-tile');
    expect(within(media).getByText('—')).toBeTruthy();
  });

  it('says so instead of drawing a flat line when a window holds no samples', async () => {
    plane(<OverviewPane />, {
      metrics: {
        data: {
          enabled: true,
          uptime_ms: 1000,
          requests: {}, latency: {}, storage: {}, gateway: {},
          federation: {}, messages: {}, pool: {}, routes: [],
        },
      },
    });
    const empty = await screen.findAllByText('Not measured in this window');
    expect(empty.length).toBeGreaterThan(0);
  });

  it('shows the collector being off as a fact rather than as a quiet server', async () => {
    plane(<OverviewPane />, { metrics: { data: { enabled: false } } });
    expect((await screen.findAllByText('Measurement is off')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Traffic')).toBeNull();
  });
});

describe('the health verdict', () => {
  const ok = {
    enabled: true,
    requests: { total: 5000, responses_5xx: 0 },
    latency: { p50_ms: 2, p90_ms: 9, p99_ms: 40, over_ceiling: 0, ceiling_ms: 8 },
    federation: { backlog: 0, backlog_oldest_ms: null, peers: 3, peers_failing: 0 },
    pool: { connections: 2, idle: 3, max: 5 },
  };

  it('is quiet when every check that could run had nothing to say', () => {
    const list = signals({ metrics: ok, status: { backup: { enabled: true, stale: false } } });
    expect(list).toEqual([]);
    expect(verdict(list).tone).toBe('success');
  });

  it('never fires on a number the server declined to measure', () => {
    const list = signals({
      metrics: {
        enabled: true,
        requests: { total: 4, responses_5xx: 0 },
        latency: { p50_ms: null, p90_ms: null, p99_ms: null, over_ceiling: 0 },
        federation: { backlog: null, backlog_oldest_ms: null, peers: null, peers_failing: null },
        pool: { connections: null, idle: null, max: 5 },
      },
      status: {},
    });
    expect(list).toEqual([]);
  });

  it('calls a one-percent error rate wrong and a tenth of a percent worth a look', () => {
    const bad = signals({ metrics: { ...ok, requests: { total: 1000, responses_5xx: 20 } } });
    expect(bad[0].tone).toBe('danger');
    expect(verdict(bad).text).toBe('Something is wrong');

    const meh = signals({ metrics: { ...ok, requests: { total: 1000, responses_5xx: 2 } } });
    expect(meh[0].tone).toBe('warn');
    expect(verdict(meh).text).toBe('Worth a look');
  });

  it('reads an old federation queue as worse than a deep one', () => {
    const deep = signals({
      metrics: { ...ok, federation: { ...ok.federation, backlog: 9000, backlog_oldest_ms: 1000 } },
    });
    expect(deep.some((s) => s.key === 'backlog')).toBe(false);

    const old = signals({
      metrics: { ...ok, federation: { ...ok.federation, backlog: 2, backlog_oldest_ms: 3 * 3600_000 } },
    });
    expect(old.find((s) => s.key === 'backlog').tone).toBe('danger');
  });

  it('puts the worst thing first', () => {
    const list = signals({
      metrics: {
        ...ok,
        requests: { total: 1000, responses_5xx: 50 },
        latency: { ...ok.latency, over_ceiling: 3 },
      },
    });
    expect(list[0].tone).toBe('danger');
    expect(list[list.length - 1].tone).toBe('warn');
  });

  it('reports the collector being off without claiming anything about the server', () => {
    const list = signals({ metrics: { enabled: false }, status: {} });
    expect(list.map((s) => s.key)).toEqual(['collector']);
    expect(list[0].tone).toBe('warn');
  });
});

describe('the report queue', () => {
  const report = {
    id: 'r1',
    direction: 'inbound',
    origin: 'other.example',
    reporter: '@bob:other.example',
    target_type: 'user',
    target_id: '@carol:home.example',
    category: 'spam',
    detail: 'Posting the same link everywhere.',
    evidence: [],
    status: 'open',
    created_at: Date.now() - 3600_000,
    handled_by: null,
    handled_at: null,
    resolution_note: null,
  };

  it('records the moderator’s reason along with the outcome', async () => {
    const resolveAdminReport = vi.fn(async () => ({ ok: true }));
    const home = fakeHome({
      resolveAdminReport,
      adminReports: async () => ({ reports: [report] }),
      adminModerationSummary: async () => ({
        counts: { open: 1 },
        open_by_direction: [{ direction: 'inbound', count: 1 }],
        open_by_category: [{ category: 'spam', count: 1 }],
        oldest_open_ms: 3600_000,
        resolution: { samples: 0, p50_ms: null, p90_ms: null },
      }),
    });
    const { user, container } = plane(<ModerationPane />, { home });

    await screen.findAllByText('spam');
    await user.click(container.querySelector('.cp-report__head'));
    await user.type(
      await screen.findByLabelText('What you decided, and why'),
      'Same link in four guilds.',
    );
    await user.click(screen.getByRole('button', { name: 'Actioned' }));

    expect(resolveAdminReport).toHaveBeenCalledWith('r1', 'actioned', 'Same link in four guilds.');
  });

  it('refuses to put a median on four closures', async () => {
    const home = fakeHome({
      adminModerationSummary: async () => ({
        counts: { open: 0, actioned: 4 },
        oldest_open_ms: null,
        resolution: { samples: 4, p50_ms: null, p90_ms: null },
      }),
    });
    plane(<ModerationPane />, { home });

    const tile = (await screen.findByText('Typical time to close')).closest('.cp-tile');
    expect(within(tile).getByText('—')).toBeTruthy();
    expect(within(tile).getByText(/too few to say/)).toBeTruthy();

    const oldest = (await screen.findByText('Oldest open')).closest('.cp-tile');
    expect(within(oldest).getByText('—')).toBeTruthy();
  });
});

describe('a peer on the wrong protocol version', () => {
  const federation = (protocol, incompatible) => plane(<FederationPane />, {
    metrics: { data: { enabled: true, federation: {} } },
    home: fakeHome({
      adminPeers: async () => ({
        peers: [{ origin: 'example.org', api_base: 'https://example.org', failures: 0, queued: 0, protocol }],
        defederated: [],
        local: { version: 1, min_supported: 1, capabilities: [] },
        incompatible,
      }),
      blocklistFeeds: async () => ({ feeds: [] }),
    }),
  });

  it.each([
    ['unknown', null, null],
    ['ok', 1, 1],
  ])('draws no badge for a %s peer', async (status, version, min) => {
    federation({ status, version, min_supported: min, capabilities: [], message: '', remedy: null, recorded_age_ms: null }, 0);
    await screen.findByText('example.org');
    expect(screen.queryAllByText('incompatible')).toHaveLength(0);
  });

  it('names the one that cannot be talked to', async () => {
    federation({
      status: 'peer_protocol_too_new', version: 2, min_supported: 2, capabilities: [],
      message: 'example.org speaks Telium protocol v2 and accepts nothing older than v2; this server speaks v1',
      remedy: 'upgrade this server', recorded_age_ms: 1000,
    }, 1);
    expect(await screen.findByText('incompatible')).toBeTruthy();
    expect(await screen.findByText(/speaks a protocol version this server cannot talk to/)).toBeTruthy();
  });

  it('raises an incompatible peer in the health verdict even with metrics off', () => {
    const on = signals({ metrics: { enabled: false }, status: { incompatible_peers: 2 } });
    expect(on.find((s) => s.key === 'protocol').title).toMatch(/2 peers/);
    const off = signals({ metrics: { enabled: false }, status: { incompatible_peers: 0 } });
    expect(off.find((s) => s.key === 'protocol')).toBeFalsy();
  });
});

describe('the hosting catalogues', () => {
  const catalog = (over = {}) => ({
    url: 'https://lists.example/hosting.json',
    label: 'Example list',
    key: 'ZmFrZS1wdWJsaWMta2V5',
    state: 'active',
    publisher: 'Example Hosting Collective',
    serial: 7,
    providers: 3,
    issued_at: Date.now() - 86_400_000,
    expires_at: Date.now() + 86_400_000,
    fetched_at: Date.now() - 600_000,
    attempted_at: Date.now() - 600_000,
    error: null,
    failure: null,
    ...over,
  });
  const failure = (kind, over = {}) => ({
    kind, message: 'the document is not signed by the pinned key', at: Date.now() - 300_000, consecutive: 4, ...over,
  });
  const offer = (over = {}) => ({
    id: 'example',
    name: 'Example Hosting',
    signup_url: 'https://example.com/signup',
    regions: ['eu-west'],
    plans: [{ id: 'small', name: 'Small', period: 'monthly', price_minor: 500, currency: 'EUR' }],
    source: { kind: 'operator' },
    ...over,
  });
  const hosting = ({ catalogs = [], enabled = true, providers = [], home: extra = {}, stepUp } = {}) => {
    const home = fakeHome({
      adminHostingCatalogs: async () => ({ enabled, catalogs, published: null }),
      hostingProviders: async () => ({ enabled, providers }),
      ...extra,
    });
    return { home, ...plane(<HostingPane />, { home, stepUp }) };
  };
  const pick = (label, cls) => screen.getAllByText(label).find((el) => el.classList.contains(cls));
  const tile = (label) => pick(label, 'cp-tile__label').closest('.cp-tile');
  const fact = (name) => pick(name, 'cp-fact__name').closest('.cp-fact');
  const refresh = async (user) => {
    await user.click(screen.getByRole('button', { name: 'Refresh catalogues' }));
    await user.click(await screen.findByRole('button', { name: 'Fetch now' }));
  };

  it('separates a refused subscription from a lapsed one and counts what is offered', async () => {
    hosting({
      catalogs: [
        catalog(),
        catalog({ url: 'https://gone.example/hosting.json', label: 'Lapsed list', state: 'expired', providers: 0, expires_at: Date.now() - 3600_000 }),
        catalog({ url: 'https://broken.example/hosting.json', label: 'Broken list', state: 'failed', providers: 0, error: 'serial 6 is not newer than the 7 already held' }),
      ],
      providers: [offer(), offer({ id: 'other', name: 'Other Hosting', source: { kind: 'catalog', label: 'Example list', publisher: 'Example Hosting Collective' } })],
    });
    await screen.findByText('Broken list');
    expect(within(tile('Not arriving')).getByText('1')).toBeTruthy();
    expect(within(tile('Listing nothing')).getByText('1')).toBeTruthy();
    expect(within(tile('Subscriptions')).getByText('3')).toBeTruthy();
    expect(within(tile('Offered right now')).getByText('2')).toBeTruthy();
    expect(within(tile('Offered right now')).getByText('1 curated here')).toBeTruthy();
  });

  it('shows dashes, not zeros, for a subscription never fetched', async () => {
    const { user, container } = hosting({
      catalogs: [catalog({ state: 'pending', providers: null, serial: null, issued_at: null, expires_at: null, fetched_at: null, attempted_at: null })],
    });
    await screen.findByText('Example list');
    await user.click(container.querySelector('.cp-report__head'));
    expect(within(fact('Providers held')).getByText('—')).toBeTruthy();
    expect(within(fact('Serial')).getByText('—')).toBeTruthy();
    expect(screen.getByText(/not fetched yet/)).toBeTruthy();
  });

  it('confirms before refreshing, and reports skipped publishers', async () => {
    const refreshHostingCatalogs = vi.fn(async () => ({
      ok: true,
      results: [{ url: 'https://lists.example/hosting.json', label: 'Example list', error: null, skipped: 'fetched 12s ago; this server waits a minute between manual fetches' }],
    }));
    const { user } = hosting({ catalogs: [catalog()], home: { refreshHostingCatalogs } });
    await screen.findByText('Example list');
    await user.click(screen.getByRole('button', { name: 'Refresh catalogues' }));
    expect(await screen.findByText('Fetch every subscribed catalogue now?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(refreshHostingCatalogs).not.toHaveBeenCalled();

    await refresh(user);
    expect(refreshHostingCatalogs).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/0 of 1 fetched and adopted, 1 not asked/)).toBeTruthy();
  });

  it('fetches nothing when the operator backs out of the password', async () => {
    const refreshHostingCatalogs = vi.fn(async () => ({ ok: true, results: [] }));
    const { user } = hosting({
      catalogs: [catalog()],
      home: { refreshHostingCatalogs },
      stepUp: { elevated: false, expiresAt: null, isElevated: () => false, elevate: async () => false },
    });
    await screen.findByText('Example list');
    await refresh(user);
    expect(refreshHostingCatalogs).not.toHaveBeenCalled();
  });

  it('draws a stale pinned key as a warning and an unreachable publisher as danger', async () => {
    const { user, container } = hosting({
      catalogs: [
        catalog({ label: 'Rotated list', state: 'key_mismatch', providers: 0, error: 'the document is not signed by the pinned key', failure: failure('key_mismatch') }),
        catalog({ url: 'https://down.example/hosting.json', label: 'Unreachable list', state: 'failed', providers: 0, error: 'connection refused', failure: failure('unreachable', { message: 'connection refused' }) }),
      ],
    });
    await screen.findByText('Rotated list');
    const rows = [...container.querySelectorAll('.cp-report')];
    const tones = [];
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await user.click(row.querySelector('.cp-report__head'));
      tones.push(row.querySelector('.telium-notice').dataset.tone);
    }
    expect(tones).toEqual(['warn', 'danger']);
    expect(screen.getByText('The pinned key and the publisher disagree')).toBeTruthy();
    expect(within(rows[1]).queryByText(/re-pin/)).toBeNull();
  });

  it('says "not updating" on the closed row of an active subscription that keeps failing', async () => {
    const { container } = hosting({
      catalogs: [catalog({ error: 'the document is not signed by the pinned key', expires_at: Date.now() + 7_200_000, failure: failure('key_mismatch') })],
    });
    await screen.findByText('Example list');
    expect(container.querySelector('.cp-report__meta').textContent).toMatch(/3 listed · read .* ago · not updating/);
    expect(within(tile('Pinned key stale')).getByText('1')).toBeTruthy();
  });

  it('remembers a past failure quietly once it is working again', async () => {
    const { user, container } = hosting({
      catalogs: [catalog({ failure: failure('unreachable', { message: 'the request timed out', consecutive: 0, at: Date.now() - 540_000 }) })],
    });
    await screen.findByText('Example list');
    expect(container.querySelector('.cp-report__meta').textContent).not.toMatch(/not updating/);
    await user.click(container.querySelector('.cp-report__head'));
    expect(container.querySelector('.telium-notice').dataset.tone).toBe('default');
    expect(screen.getByText(/It last failed 9m ago: the request timed out/)).toBeTruthy();
  });

  it('disables refresh, with a reason, when there is nothing to fetch', async () => {
    const { unmount } = hosting({ catalogs: [] });
    expect(await screen.findByText(/No catalogues are subscribed to/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh catalogues' }).disabled).toBe(true);
    unmount();

    hosting({ enabled: false, catalogs: [catalog()] });
    expect(await screen.findByText(/marketplace is switched off/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh catalogues' }).disabled).toBe(true);
    expect(screen.queryByText('Offered right now')).toBeNull();
  });
});

describe('the entrance', () => {
  const settings = (admin) => {
    const store = signedInStore({ me: admin ? { admin: true } : {} });
    store.home = fakeHome();
    return mount(<UserSettings close={() => {}} />, store);
  };

  it('is not drawn for an account without the admin column', async () => {
    settings(false);
    await screen.findAllByText('Profile');
    expect(screen.queryAllByText('Control plane')).toHaveLength(0);
    expect(screen.queryAllByText('Server administration')).toHaveLength(0);
  });

  it('is drawn for an administrator', async () => {
    settings(true);
    expect((await screen.findAllByText('Server administration')).length).toBeGreaterThan(0);
  });
});
