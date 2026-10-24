import { render, screen, waitFor, within } from '@testing-library/react';
import { ed25519 } from '@noble/curves/ed25519.js';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { HttpError } from '../lib/api.js';
import { recentAccounts, rememberAccount } from '../lib/account-address.js';
import {
  DEFAULT_RECOMMENDATION_URL,
  RECOMMENDATION_KIND,
  RECOMMENDATION_VERSION,
  canonicalRecommendationJson,
} from '../lib/account-home-recommendations.js';
import { generateAccountRecovery, normalizeRecoveryKey } from '../lib/account-recovery.js';
import { b64url } from '../lib/util.js';
import { LoginView } from '../views/LoginView.jsx';
import { freshStore } from './fake-server.js';
import { chooseWay } from './sign-in.js';

const HERE = window.location.origin;
const HERE_HOST = window.location.host;

const PASSWORD = 'placeholder-password';

const SERVERS = [
  {
    origin: 'https://atlas.example',
    serverName: 'atlas.example',
    api: 'https://atlas.example',
    accounts: { '@ada:atlas.example': { status: 'active' } },
  },
  {
    origin: 'https://example.org',
    serverName: 'example.org',
    api: 'https://chat.example.org',
    accounts: { '@ada:example.org': { status: 'active' } },
  },
  {
    origin: 'https://telium.chat',
    serverName: 'telium.chat',
    api: 'https://telium.chat',
    accounts: { '@ada:telium.chat': { status: 'active' } },
  },
  {
    origin: 'https://old.example',
    serverName: 'old.example',
    api: 'https://old.example',
    accounts: { '@ada:old.example': { status: 'moved', moved_to: '@ada:new.example' } },
  },
  {
    origin: 'https://new.example',
    serverName: 'new.example',
    api: 'https://new.example',
    accounts: { '@ada:new.example': { status: 'active' } },
  },
  {
    origin: 'https://cascade.example',
    serverName: 'cascade.example',
    api: 'https://api.cascade.example',
    accounts: { '@kim:cascade.example': { status: 'active' } },
  },
  {
    origin: 'https://ridge.example',
    serverName: 'ridge.example',
    api: 'https://api.ridge.example',
    accounts: {},
  },
  {
    origin: HERE,
    serverName: HERE_HOST,
    api: HERE,
    accounts: { [`@mo:${HERE_HOST}`]: { status: 'active' } },
  },
];

const FEED_SEED = new Uint8Array(32).fill(11);
const FEED_KEY = b64url(ed25519.getPublicKey(FEED_SEED));
const OTHER_KEY = b64url(ed25519.getPublicKey(new Uint8Array(32).fill(12)));

function signedFeed() {
  const now = Date.now();
  const body = {
    kind: RECOMMENDATION_KIND,
    version: RECOMMENDATION_VERSION,
    publisher: 'telium.chat',
    generated_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 3_600_000).toISOString(),
    criteria: {},
    servers: [
      {
        domain: 'cascade.example',
        api_origin: 'https://api.cascade.example',
        name: 'Cascade',
        region_label: 'Oregon, US',
        weight: 1,
      },
      {
        domain: 'ridge.example',
        api_origin: 'https://api.ridge.example',
        name: 'Ridge Commons',
        region_label: 'Dublin, IE',
        weight: 1,
      },
    ],
  };
  const signature = ed25519.sign(new TextEncoder().encode(canonicalRecommendationJson(body)), FEED_SEED);
  return { ...body, key_id: 'ed25519:test', signature: b64url(signature) };
}

const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function installNetwork() {
  const fetch = vi.fn(async (url) => {
    if (String(url) === DEFAULT_RECOMMENDATION_URL) return reply(signedFeed());
    const { origin, pathname } = new URL(url);
    if (pathname === '/.well-known/telium/server') {
      const server = SERVERS.find((s) => s.origin === origin);
      if (server) return reply({ server_name: server.serverName, api: server.api });
    }
    const status = /^\/_telium\/v1\/users\/([^/]+)\/status$/.exec(pathname);
    if (status) {
      const server = SERVERS.find((s) => s.api === origin);
      if (server) {
        const id = decodeURIComponent(status[1]);
        return reply(server.accounts[id] || { status: 'unknown' });
      }
    }
    throw new TypeError(`Failed to fetch: ${origin} is unreachable`);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function mount({ onInvite, homeRandom = () => 0 } = {}) {
  const store = freshStore();
  const signIn = vi.spyOn(store, 'signIn').mockImplementation(async (base, user) => ({
    user_id: user,
    server_name: user.split(':')[1],
  }));
  const onSignedIn = vi.fn();
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <LoginView onSignedIn={onSignedIn} onInvite={onInvite} homeRandom={homeRandom} />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
  return { user, signIn, onSignedIn };
}

const addressField = () => screen.findByRole('textbox', { name: 'Telium address' });

async function enterAddress(user, text) {
  const field = await addressField();
  await user.clear(field);
  await user.type(field, `${text}{Enter}`);
}

async function signInWithPassword(user) {
  const field = await screen.findByLabelText('Password');
  await user.type(field, PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('the desktop first screen', () => {
  beforeEach(() => {
    window.teliumDesktop = { runtime: 'electron' };
    installNetwork();
  });
  afterEach(() => {
    delete window.teliumDesktop;
    vi.unstubAllGlobals();
  });

  it('asks for a Telium address and assumes no server', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Sign in to Telium' })).toBeTruthy();
    const field = await addressField();
    expect(field.getAttribute('placeholder')).toBe('@you:telium.chat');
    expect(screen.getByText(/Forgot your server\? Just type your username\./)).toBeTruthy();
    expect(document.querySelector('.auth-host')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Get started/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it('takes a full handle straight to its password and signs in there', async () => {
    const { user, signIn, onSignedIn } = mount();
    await enterAddress(user, '@ada:atlas.example');
    await screen.findByLabelText('Password');
    expect(document.querySelector('.stage__cur').textContent).toContain('Signing in as @ada:atlas.example');
    await signInWithPassword(user);
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0][0]).toBe('https://atlas.example');
    expect(signIn.mock.calls[0][1]).toBe('@ada:atlas.example');
    expect(recentAccounts().map((a) => a.userId)).toEqual(['@ada:atlas.example']);
    expect(localStorage.getItem('telium.lastHome')).toBe('https://atlas.example');
  });

  it('reads the email-shaped ada@host the same way', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'ada@atlas.example');
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://atlas.example', '@ada:atlas.example']);
  });

  it('signs in against the API a delegated server names, not its domain', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'ada@example.org');
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://chat.example.org', '@ada:example.org']);
  });

  it('says so under the field when there is no such account', async () => {
    const { user } = mount();
    await enterAddress(user, '@bob:atlas.example');
    const alert = await screen.findByText(/There's no account called bob on atlas\.example/);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'create an account' }));
    const name = await screen.findByRole('textbox', { name: 'Username' });
    expect(name.value).toBe('bob');
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('atlas.example');
  });

  it('says a server that does not answer did not answer', async () => {
    const { user } = mount();
    await enterAddress(user, '@ada:nowhere.example');
    expect(await screen.findByText("Couldn't reach nowhere.example. Check the spelling, or your connection."))
      .toBeTruthy();
  });

  it('says what an address looks like when the text is not one', async () => {
    const { user } = mount();
    await enterAddress(user, 'not an address');
    expect(await screen.findByText("That doesn't look like a Telium address. Try @name:server."))
      .toBeTruthy();
  });

  it('asks which server a bare name is on when none of the known ones has it', async () => {
    const { user } = mount();
    await enterAddress(user, 'zoe');
    expect(await screen.findByText('Which server is zoe on?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'telium.chat' }));
    expect(await screen.findByText(/There's no account called zoe on telium\.chat/)).toBeTruthy();
  });

  it('asks for the username when only a server was given', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'atlas.example');
    const name = await screen.findByRole('textbox', { name: 'Username' });
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('atlas.example');
    await waitFor(() => expect(document.activeElement).toBe(name));
    await user.type(name, 'ada');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://atlas.example', 'ada']);
  });

  it('hands an invite link to the invite landing', async () => {
    const onInvite = vi.fn();
    const { user } = mount({ onInvite });
    await enterAddress(user, 'https://example.org/invite/welcome-code');
    await waitFor(() => expect(onInvite).toHaveBeenCalledWith({
      base: 'https://chat.example.org',
      code: 'welcome-code',
    }));
  });

  it('follows a moved account once and says where it went', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, '@ada:old.example');
    expect(await screen.findByText('Your account moved to new.example.')).toBeTruthy();
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://new.example', '@ada:new.example']);
  });

  it('offers accounts used before as one click, and forgets one on request', async () => {
    rememberAccount({ userId: '@ada:atlas.example', host: 'atlas.example', base: 'https://api.atlas.example' });
    rememberAccount({ userId: '@cy:telium.chat', host: 'telium.chat', base: 'https://telium.chat' });
    const { user, signIn } = mount();

    await user.click(await screen.findByRole('button', { name: 'Forget @cy:telium.chat on this device' }));
    expect(screen.queryByRole('button', { name: /@cy:telium\.chat$/ })).toBeNull();
    expect(recentAccounts().map((a) => a.userId)).toEqual(['@ada:atlas.example']);

    await user.click(screen.getByRole('button', { name: '@ada:atlas.example' }));
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://api.atlas.example', '@ada:atlas.example']);
  });

  it('says there is no such account when a password is refused for one', async () => {
    rememberAccount({ userId: '@zed:atlas.example', host: 'atlas.example', base: 'https://atlas.example' });
    const { user, signIn } = mount();
    signIn.mockRejectedValue(new HttpError(401, { error: 'unauthorized', message: 'invalid credentials' }));
    await user.click(await screen.findByRole('button', { name: '@zed:atlas.example' }));
    await signInWithPassword(user);
    expect(await screen.findByText("There's no account called zed on atlas.example.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use a different address' }));
    expect((await addressField()).value).toBe('@zed:atlas.example');
  });

  it('drops a lookup whose address was edited while it was in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const network = installNetwork();
    const real = network.getMockImplementation();
    network.mockImplementation(async (url) => {
      if (String(url).startsWith('https://atlas.example/.well-known')) await gate;
      return real(url);
    });
    const { user } = mount();
    await enterAddress(user, '@ada:atlas.example');
    expect(await screen.findByText('Looking up atlas.example…')).toBeTruthy();
    const field = await addressField();
    await user.type(field, 'x');
    expect(screen.queryByText('Looking up atlas.example…')).toBeNull();
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(field.value).toBe('@ada:atlas.examplex');
  });

  it('leaves no network request behind before anything is typed', async () => {
    const network = installNetwork();
    mount();
    await addressField();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(network).not.toHaveBeenCalled();
  });

  it('goes back a step on Escape', async () => {
    const { user } = mount();
    await enterAddress(user, '@ada:atlas.example');
    await screen.findByLabelText('Password');
    await user.keyboard('{Escape}');
    expect((await addressField()).value).toBe('@ada:atlas.example');
  });

  it('carries a typed handle onto the recovery step', async () => {
    const { user } = mount();
    const field = await addressField();
    await user.type(field, '@ada:example.org');
    await user.click(screen.getByRole('button', { name: /recover/i }));
    const name = await screen.findByRole('textbox', { name: 'Username' });
    expect(name.value).toBe('@ada:example.org');
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('example.org');
  });

  it('creates an account on telium.chat, with the way to choose another in sight', async () => {
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    expect(await screen.findByRole('heading', { name: 'Pick a username' })).toBeTruthy();
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('telium.chat');
    expect(screen.getByText(/Your account home keeps your profile/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Choose a different home' }));
    expect(await screen.findByRole('textbox', { name: 'Home server' })).toBeTruthy();
  });
});

describe('recommending a server, and not having to remember it', () => {
  beforeEach(() => {
    window.teliumDesktop = { runtime: 'electron' };
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', FEED_KEY);
    installNetwork();
  });
  afterEach(() => {
    delete window.teliumDesktop;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const recommended = () => screen.findByTestId('recommended-home');

  async function createAccountAs(user, name) {
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    const field = await screen.findByRole('textbox', { name: 'Username' });
    await waitFor(() => expect(document.activeElement).toBe(field));
    await user.type(field, name);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('picks a vetted server from the signed list for a new account, and keeps the pick', async () => {
    const { user, signIn } = mount({ homeRandom: () => 0.9 });
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    const card = await recommended();
    expect(within(card).getByText('Ridge Commons')).toBeTruthy();
    expect(card.textContent).toContain('We picked Ridge Commons for you');
    expect(card.textContent).toContain('ridge.example');
    expect(card.textContent).toContain('Dublin, IE');
    expect(card.textContent).toMatch(/where your account lives/);
    expect(document.querySelector('.stage__cur .auth-host')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Telium address' }));
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    expect((await recommended()).textContent).toContain('We picked Ridge Commons for you');

    const field = await screen.findByRole('textbox', { name: 'Username' });
    await user.type(field, 'ada');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0][0]).toBe('https://api.ridge.example');
    expect(signIn.mock.calls[0][3]).toMatchObject({ register: true });
  });

  it('lets somebody choose a different recommended server, or another server entirely', async () => {
    const { user } = mount({ homeRandom: () => 0.9 });
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await recommended();
    await user.click(screen.getByRole('button', { name: 'Choose a different one' }));
    const others = screen.getByRole('group', { name: 'Other recommended account homes' });
    expect(within(others).queryByText('Ridge Commons')).toBeNull();
    await user.click(within(others).getByRole('button', { name: /Cascade/ }));
    expect((await recommended()).textContent).toContain('We picked Cascade for you');

    await user.click(screen.getByRole('button', { name: 'Choose a different one' }));
    await user.click(screen.getByRole('button', { name: 'Use another server' }));
    expect(await screen.findByRole('textbox', { name: 'Home server' })).toBeTruthy();
  });

  it('falls back to telium.chat, without a word, when the list does not verify', async () => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', OTHER_KEY);
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await waitFor(() => expect(document.querySelector('.stage__cur .auth-host')).toBeTruthy());
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('telium.chat');
    expect(screen.queryByTestId('recommended-home')).toBeNull();
    expect(screen.queryByText(/recommendation/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose a different home' })).toBeTruthy();
  });

  it('falls back to telium.chat on a build that pinned no key, and asks the list for nothing', async () => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', '');
    const network = installNetwork();
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain('telium.chat');
    expect(screen.queryByTestId('recommended-home')).toBeNull();
    expect(network.mock.calls.map(([url]) => String(url))).not.toContain(DEFAULT_RECOMMENDATION_URL);
  });

  it('shows the new address beside the recovery key, and saves the two together', async () => {
    const { text: key } = generateAccountRecovery();
    const { user, signIn } = mount({ homeRandom: () => 0.9 });
    signIn.mockImplementation(async () => ({
      user_id: '@ada:ridge.example',
      server_name: 'ridge.example',
      recovery_key: key,
    }));
    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await recommended();
    await user.click(screen.getByRole('button', { name: 'Telium address' }));
    await createAccountAs(user, 'ada');

    expect(await screen.findByRole('heading', { name: 'Save your recovery key' })).toBeTruthy();
    const address = screen.getByTestId('account-address');
    expect(address.textContent).toBe(
      "Your Telium address is @ada:ridge.example. You'll need it to sign in on another device.Copy address",
    );
    await user.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(await navigator.clipboard.readText()).toBe('@ada:ridge.example');

    await user.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('Account: @ada:ridge.example');
    expect(copied).toContain('Server: ridge.example');
    expect(copied).toContain(key);
    expect(normalizeRecoveryKey(copied)).toBe(key);
    expect(normalizeRecoveryKey(copied.replace(/\n/g, ''))).toBe(key);
  });

  it('finds a bare name on one of the known servers and goes straight to its password', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'kim');
    const row = await screen.findByRole('button', { name: 'Found kim on cascade.example' });
    expect(screen.queryByText('Which server is kim on?')).toBeNull();
    await user.click(row);
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://api.cascade.example', '@kim:cascade.example']);
  });

  it('asks every known server only once Continue is pressed', async () => {
    const network = installNetwork();
    const { user } = mount();
    const field = await addressField();
    await user.type(field, 'kim');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(network).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Found kim on cascade.example' });
    const asked = network.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/status'));
    expect(asked).toEqual(expect.arrayContaining([
      'https://api.cascade.example/_telium/v1/users/%40kim%3Acascade.example/status',
      'https://api.ridge.example/_telium/v1/users/%40kim%3Aridge.example/status',
      'https://telium.chat/_telium/v1/users/%40kim%3Atelium.chat/status',
    ]));
  });

  it('falls back to asking which server when no known server has the name', async () => {
    const { user } = mount();
    await enterAddress(user, 'nobody');
    expect(await screen.findByText('Which server is nobody on?')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Found / })).toBeNull();
  });

  it('drops a name search whose field was edited while it was in flight', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const network = installNetwork();
    const real = network.getMockImplementation();
    network.mockImplementation(async (url) => {
      if (String(url).startsWith('https://api.cascade.example/_telium/v1/users/')) await gate;
      return real(url);
    });
    const { user } = mount();
    await enterAddress(user, 'kim');
    expect(await screen.findByText('Looking for kim…')).toBeTruthy();
    const field = await addressField();
    await user.type(field, 'x');
    expect(screen.queryByText('Looking for kim…')).toBeNull();
    release();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(screen.queryByRole('button', { name: /^Found / })).toBeNull();
    expect(screen.queryByText('Which server is kim on?')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(field.value).toBe('kimx');
  });
});

describe('the plumbing the web flow shares', () => {
  beforeEach(() => { installNetwork(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('keeps an OPAQUE pin written under the home name when signing in at its API', async () => {
    const pin = 'telium.auth.opaque.v1:https://example.org';
    localStorage.setItem(pin, JSON.stringify(true));
    const fetch = vi.fn(async (url) => {
      if (new URL(url).pathname === '/_telium/v1/capabilities') return reply({ auth: { opaque: false } });
      throw new TypeError('no other request belongs here');
    });
    vi.stubGlobal('fetch', fetch);
    const store = freshStore();
    try {
      await expect(store.signIn('https://chat.example.org', '@ada:example.org', PASSWORD, {
        home: 'example.org',
        allowLegacyAuth: true,
      })).rejects.toMatchObject({ code: 'opaque_downgrade' });
      expect(fetch.mock.calls.map(([url]) => new URL(url).pathname))
        .toEqual(['/_telium/v1/capabilities']);
    } finally {
      localStorage.removeItem(pin);
    }
  });

  it('opens on the same address field as the desktop', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Sign in to Telium' })).toBeTruthy();
    await addressField();
    expect(screen.queryByRole('button', { name: /^Get started/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create an account' })).toBeTruthy();
  });

  it('does not make one sign-in elsewhere the default for every later tab', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'ada@atlas.example');
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://atlas.example', '@ada:atlas.example']);
    expect(localStorage.getItem('telium.lastHome')).toBeNull();
  });

  it('signs in at the API a delegated server names', async () => {
    const { user, signIn } = mount();
    await enterAddress(user, 'ada@example.org');
    await signInWithPassword(user);
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    expect(signIn.mock.calls[0].slice(0, 2)).toEqual(['https://chat.example.org', '@ada:example.org']);
  });

  it('says so under the field when the named server does not answer', async () => {
    const { user } = mount();
    await enterAddress(user, '@ada:nowhere.example');
    expect(await screen.findByText("Couldn't reach nowhere.example. Check the spelling, or your connection."))
      .toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('looks for a bare name on the server serving the page', async () => {
    const { user } = mount();
    await enterAddress(user, 'mo');
    expect(await screen.findByRole('button', { name: `Found mo on ${HERE_HOST}` })).toBeTruthy();
  });

  it('makes a new account on the server serving the page, and says so', async () => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', FEED_KEY);
    const { user } = mount();
    await chooseWay(user, { register: true });
    expect(screen.queryByTestId('recommended-home')).toBeNull();
    expect(document.querySelector('.stage__cur .auth-host').textContent).toContain(HERE_HOST);
    expect(screen.getByRole('button', { name: 'Choose a different home' })).toBeTruthy();
    vi.unstubAllEnvs();
  });
});
