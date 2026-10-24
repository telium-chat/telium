import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { GUILD_DOMAIN, HOME_DOMAIN, ME, mount, signedInStore } from './harness.jsx';
import { useStoreEvent } from '../hooks/useStore.jsx';
import {
  AUTO_FALLBACK_COPY, BROWSER_NOTICE, decide, FOLLOW_ACCOUNT, MODE_COPY, NOT_COVERED, PANE_COPY,
  REFUSAL, refusalCopy,
} from '../lib/net/policy.js';

const fake = vi.hoisted(() => ({ supported: true, decisions: {}, granted: [] }));

vi.mock('../lib/net/transport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  protectionSupported: () => fake.supported,
  effectiveMode: (domain) => fake.decisions[domain] || { route: 'direct', refusal: null, reason: 'unconfigured' },
  permitDirectOnce: (domain) => { fake.granted.push(domain); },
}));

const { ProtectionRefused } = await import('../lib/net/transport.js');
const { NetworkPrivacyPane } = await import('../views/user-settings/NetworkPrivacyPane.jsx');
const { ServersPane } = await import('../views/user-settings/ServersPane.jsx');
const { useProtectionPrompt, clearProtectionPrompts } = await import('../hooks/useProtectionPrompt.jsx');
const { useMenus } = await import('../views/menus.jsx');
const { MenuButton } = await import('../components/index.js');

const OTHER_DOMAIN = 'other.example';

const guild = (id, name, domain = GUILD_DOMAIN) => ({
  id, name, domain, channels: [],
  roles: [{ id, name: '@everyone', permissions: '0' }],
  me: { user_id: ME, roles: [], permissions: '0' },
});

const card = (mode) => screen.getByRole('radio', {
  name: new RegExp(MODE_COPY[mode].label.replace(/[()]/g, '\\$&')),
});

beforeEach(() => {
  fake.supported = true;
  fake.decisions = {};
  fake.granted = [];
  clearProtectionPrompts();
});

describe('the network privacy pane', () => {
  it.each(['direct', 'protected', 'per-guild'])('writes "%s" when its card is picked', async (mode) => {
    const store = signedInStore();
    store.prefs.network = { mode: mode === 'direct' ? 'protected' : 'direct' };
    const { user } = mount(<NetworkPrivacyPane />, store);
    expect(screen.getByText(MODE_COPY[mode].description)).toBeTruthy();
    await user.click(card(mode));
    expect(store.networkPrefs().mode).toBe(mode);
  });

  it('lists every uncovered thing in the open, even in direct mode', () => {
    const store = signedInStore();
    store.prefs.network = { mode: 'direct' };
    mount(<NetworkPrivacyPane />, store);
    expect(screen.getByText(PANE_COPY.notCoveredTitle)).toBeTruthy();
    for (const line of NOT_COVERED) expect(screen.getByText(line).closest('details')).toBe(null);
  });

  it('warns a build that cannot protect, without removing the option', () => {
    fake.supported = false;
    mount(<NetworkPrivacyPane />, signedInStore());
    expect(screen.getByText(BROWSER_NOTICE.body)).toBeTruthy();
    expect(card('protected')).toBeTruthy();
  });

  it('keeps automatic fallback off until turned on', async () => {
    const store = signedInStore();
    const { user } = mount(<NetworkPrivacyPane />, store);
    expect(screen.queryByText(BROWSER_NOTICE.title)).toBe(null);
    expect(store.networkPrefs().autoFallback).toBe(false);
    await user.click(screen.getByRole('switch', { name: new RegExp(AUTO_FALLBACK_COPY.label) }));
    expect(store.networkPrefs().autoFallback).toBe(true);
  });
});

function GuildMenu({ g }) {
  useStoreEvent('network-privacy');
  const menus = useMenus();
  return <MenuButton label="Guild menu" content={menus.guild(g)}>Guild</MenuButton>;
}

const openNetworkSub = async (user) => {
  await user.click(screen.getByRole('button', { name: 'Guild menu' }));
  await user.click(await screen.findByRole('menuitem', { name: /Network privacy/ }));
};
const pick = async (name) => fireEvent.click(await screen.findByRole('menuitem', { name }));

describe('choosing for one guild from its menu', () => {
  it('records the choice, marks it as current, and clears it on follow-account', async () => {
    const store = signedInStore({ guilds: [guild('g1', 'Cartography')] });
    const { user } = mount(<GuildMenu g={store.guilds.get('g1')} />, store);

    await openNetworkSub(user);
    await pick(MODE_COPY.protected.label);
    await waitFor(() => expect(store.networkPrefs().guilds.g1).toBe('protected'));

    await openNetworkSub(user);
    expect((await screen.findByRole('menuitem', { name: MODE_COPY.protected.label })).querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: MODE_COPY.direct.label }).querySelector('svg')).toBe(null);
    await pick(FOLLOW_ACCOUNT.label);
    await waitFor(() => expect(store.networkPrefs().guilds.g1).toBeUndefined());
  });

  it('admits when a neighbour on the same host has already decided', async () => {
    const store = signedInStore({ guilds: [guild('g1', 'Cartography'), guild('g2', 'Bathymetry')] });
    store.setGuildNetworkMode('g2', 'protected');
    const { user } = mount(<GuildMenu g={store.guilds.get('g1')} />, store);
    await openNetworkSub(user);
    expect(await screen.findByText(/Bathymetry is on the same host/)).toBeTruthy();
  });
});

describe('the list of connected servers', () => {
  const withServers = (domains, guilds = [guild('g1', 'Cartography')]) => {
    const store = signedInStore({ guilds });
    store.session.servers = Object.fromEntries(domains.map((d) => [d, { revalidate_at: Date.now() + 3600_000 }]));
    return store;
  };

  it('reports the verdict the transport reached, not one derived from prefs', async () => {
    fake.decisions[GUILD_DOMAIN] = { route: 'protected', refusal: null, reason: 'chosen' };
    mount(<ServersPane />, withServers([HOME_DOMAIN, GUILD_DOMAIN]));
    expect(await screen.findByText('Sees your account server')).toBeTruthy();
  });

  it('says when a host is protected only because a neighbour asked', async () => {
    fake.decisions[GUILD_DOMAIN] = { route: 'protected', refusal: null, reason: 'chosen' };
    const store = withServers([GUILD_DOMAIN], [guild('g1', 'Cartography'), guild('g2', 'Bathymetry')]);
    store.setGuildNetworkMode('g2', 'protected');
    mount(<ServersPane />, store);
    expect(await screen.findByText(/Cartography on this host is protected too, without having asked/)).toBeTruthy();
  });

  it('does not pretend the account server could be hidden from', async () => {
    fake.decisions[HOME_DOMAIN] = { route: 'direct', refusal: null, reason: 'home' };
    mount(<ServersPane />, withServers([HOME_DOMAIN]));
    expect(await screen.findByText(/It holds your account and every byte of yours arrives there/)).toBeTruthy();
  });
});

function Connecting({ error, retry }) {
  const onFailure = useProtectionPrompt();
  return (
    <button type="button" onClick={() => onFailure(error, { context: 'Could not connect', retry })}>
      Connect
    </button>
  );
}

describe('being refused, and being asked about it', () => {
  const refusal = () => new ProtectionRefused(OTHER_DOMAIN, REFUSAL.unsupported);
  const connect = (user) => user.click(screen.getByRole('button', { name: 'Connect' }));
  const YES = { name: 'Connect directly this time' };

  it('asks instead of erroring, and grants nothing on open or cancel, nor asks twice', async () => {
    const retry = vi.fn();
    const { user } = mount(<Connecting error={refusal()} retry={retry} />, signedInStore());
    await connect(user);
    const copy = refusalCopy(REFUSAL.unsupported, { domain: OTHER_DOMAIN });
    expect(await screen.findByText(copy.title)).toBeTruthy();
    expect(screen.getByText(copy.body)).toBeTruthy();
    expect(fake.granted).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await connect(user);
    await waitFor(() => expect(screen.queryByRole('button', YES)).toBe(null));
    expect(fake.granted).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
  });

  it('grants the domain exactly once on yes', async () => {
    const retry = vi.fn(async () => {});
    const { user } = mount(<Connecting error={refusal()} retry={retry} />, signedInStore());
    await connect(user);
    await user.click(await screen.findByRole('button', YES));
    await waitFor(() => expect(fake.granted).toEqual([OTHER_DOMAIN]));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary failure alone', async () => {
    const { user } = mount(<Connecting error={new Error('socket closed')} />, signedInStore());
    await connect(user);
    expect(screen.queryByRole('button', YES)).toBe(null);
    expect(fake.granted).toEqual([]);
  });
});

describe('telling an old account server from a switched-off one', () => {
  const want = { mode: 'protected', guilds: {}, autoFallback: false };
  const verdict = (extra) => decide({ prefs: want, guilds: [], domain: 'guild.example', relay: null, ...extra });

  it('refuses with distinct codes and distinct words', () => {
    expect(verdict({ understood: false })).toMatchObject({ route: 'refuse', refusal: REFUSAL.outdated });
    expect(verdict({ understood: true })).toMatchObject({ route: 'refuse', refusal: REFUSAL.unavailable });
    expect(verdict({}).refusal).toBe(REFUSAL.unavailable);
    const older = refusalCopy(REFUSAL.outdated, { domain: 'guild.example' });
    const off = refusalCopy(REFUSAL.unavailable, { domain: 'guild.example' });
    expect(older.body).not.toBe(off.body);
    expect(older.body).toContain('learns your address');
  });

  it('connects through an offered relay, and falls back only on explicit consent', () => {
    expect(verdict({ understood: true, relay: { available: true, url: 'wss://home.example/relay' } }).route).toBe('protected');
    expect(verdict({ understood: false, allowDirectOnce: true })).toMatchObject({ route: 'direct', reason: 'fallback' });
    expect(decide({ prefs: { ...want, autoFallback: true }, guilds: [], domain: 'guild.example', relay: null, understood: false }).route).toBe('direct');
  });
});
