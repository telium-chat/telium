import { readFileSync, readdirSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { Api } from '../lib/api.js';
import {
  PublicProfileLanding, publicProfileLink, publicProfilePath,
} from '../views/PublicProfileLanding.jsx';
import { configureTransport, forgetOrigin, registerOrigin, teliumMediaSrc } from '../lib/net/transport.js';
import { createFakeServer, freshStore, HOME } from './fake-server.js';
import { mount } from './harness.jsx';
import { signIn } from './sign-in.js';

const BOB = '@bob:home.example';
const BOB_MOVED = '@bob:new.example';
const PROFILE = {
  display_name: 'Bob',
  pronouns: 'he/him',
  bio: 'Runs a small homeserver.',
  created_at: '2021-03-04T10:00:00Z',
  accent_color: '#7A5AF8',
};
const LOUD = {
  profile: PROFILE,
  presence: {
    status: 'dnd',
    custom_status: 'shipping the thing',
    activity: 'Telium',
    rich_activity: { name: 'Beat Saber', type: 0 },
    rich_activities: [
      { name: 'Beat Saber', type: 0 },
      { name: 'Dark Side of the Moon', type: 2 },
      { name: 'Kernel talk', type: 3 },
    ],
  },
  presence_known: true,
};
const QUIET = { profile: PROFILE, presence: {}, presence_known: true };

function serve({ status = {}, page = {} } = {}) {
  const fake = createFakeServer();
  for (const id of [...Object.keys(status), ...Object.keys(page),
    ...Object.values(status).map((a) => a?.moved_to).filter(Boolean)]) {
    const domain = String(id).split(':')[1];
    if (!domain) continue;
    fake.state.reachable.add(`https://${domain}`);
    fake.state.reachable.add(`http://${domain}`);
  }
  fake.install();
  const userStatus = vi.spyOn(Api.prototype, 'userStatus').mockImplementation(async (id) => {
    if (!(id in status)) throw new Error(`no /status scripted for ${id}`);
    return status[id];
  });
  const publicProfilePage = vi.spyOn(Api.prototype, 'publicProfilePage').mockImplementation(async (id) => {
    if (!(id in page)) throw new Error(`no /public-page scripted for ${id}`);
    return page[id];
  });
  return { userStatus, publicProfilePage };
}

const active = (userId, body) => ({
  status: { [userId]: { status: 'active' } },
  page: { [userId]: body },
});
const moved = (body = QUIET) => ({
  status: {
    [BOB]: { status: 'moved', moved_to: BOB_MOVED },
    [BOB_MOVED]: { status: 'active' },
  },
  page: { [BOB_MOVED]: body },
});

async function landing(userId, { store = freshStore(), ...props } = {}) {
  const view = mount(
    <PublicProfileLanding userId={userId} sessionReady={false} {...props} />,
    store,
  );
  await waitFor(() => {
    if (screen.queryByLabelText('Loading profile')) throw new Error('still loading');
  });
  return view;
}

function signedInStore() {
  const store = freshStore();
  store.session = { home: { base: HOME, domain: 'home.example', user_id: '@alice:home.example', token: 't' } };
  store.me = { user_id: '@alice:home.example' };
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the public profile page', () => {
  it('encodes the federated id and keeps the current web origin', () => {
    expect(publicProfilePath('@alice:home.example')).toBe('/u/@alice:home.example');
    expect(publicProfileLink('@alice:home.example'))
      .toBe(`${window.location.origin}/u/@alice:home.example`);
  });

  it('draws nothing where a withheld field would have gone', async () => {
    serve(active(BOB, QUIET));
    const { container } = await landing(BOB);
    expect(screen.getByRole('heading', { name: 'Bob' })).toBeTruthy();
    for (const text of ['Offline', 'Do not disturb', 'Beat Saber', 'Playing Telium', 'Status unavailable']) {
      expect(screen.queryByText(text)).toBeNull();
    }
    expect(container.querySelector('.pc__bubble')).toBeNull();
  });

  it('draws the published fields when the server sends them', async () => {
    serve(active(BOB, LOUD));
    const { container } = await landing(BOB);
    expect(screen.getByText('Do not disturb')).toBeTruthy();
    expect(container.querySelector('.pc__bubble')?.textContent).toContain('shipping the thing');
    expect(screen.getByText('Beat Saber')).toBeTruthy();
    expect(screen.getByText('Dark Side of the Moon')).toBeTruthy();
    expect(screen.getByText('Kernel talk')).toBeTruthy();
  });

  it.each([
    ['presence_known false', { presence: {}, presence_known: false }, 'Status unavailable', 'Offline'],
    ['older server, known status', { presence: { status: 'online' } }, 'Online', 'Status unavailable'],
    ['older server, no status', { presence: {} }, null, 'Status unavailable'],
  ])('reads presence honestly: %s', async (_, body, shown, absent) => {
    serve(active(BOB, { profile: PROFILE, ...body }));
    await landing(BOB);
    if (shown) expect(screen.getByText(shown)).toBeTruthy();
    expect(screen.queryByText(absent)).toBeNull();
    expect(screen.queryByText('Offline')).toBeNull();
  });

  it('follows a move and keeps the original join date', async () => {
    const { publicProfilePage } = serve(moved({ ...QUIET, profile: { ...PROFILE, display_name: 'Bob Elsewhere' } }));
    await landing(BOB);
    expect(screen.getByRole('heading', { name: 'Bob Elsewhere' })).toBeTruthy();
    expect(screen.getByRole('button', { name: `Copy username ${BOB_MOVED}` })).toBeTruthy();
    expect(screen.getByText(`Moved from ${BOB}`)).toBeTruthy();
    expect(publicProfilePage).toHaveBeenCalledTimes(1);
    expect(publicProfilePage).toHaveBeenCalledWith(BOB_MOVED);
    const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date(PROFILE.created_at));
    expect(screen.getByText('On Telium since')).toBeTruthy();
    expect(screen.getByText(day)).toBeTruthy();
  });

  it('refuses a relocation loop', async () => {
    serve({
      status: {
        [BOB]: { status: 'moved', moved_to: BOB_MOVED },
        [BOB_MOVED]: { status: 'moved', moved_to: BOB },
      },
    });
    await landing(BOB);
    expect(screen.getByText('This account migration points in a loop.')).toBeTruthy();
  });

  it('gives up on an over-long relocation chain', async () => {
    const chain = Array.from({ length: 7 }, (_, i) => `@bob:h${i}.example`);
    const status = Object.fromEntries(chain.map((id, i) => [id, i + 1 < chain.length
      ? { status: 'moved', moved_to: chain[i + 1] } : { status: 'active' }]));
    const { userStatus } = serve({ status });
    await landing(chain[0]);
    expect(screen.getByText('This account has moved too many times to resolve safely.')).toBeTruthy();
    expect(userStatus).toHaveBeenCalledTimes(5);
  });

  it.each([
    ['gone', 'This account is no longer available.'],
    ['unknown', 'That Telium account does not exist.'],
    ['deactivated', 'This account is deactivated.'],
  ])('says what %s means without fetching the page', async (state, message) => {
    const { publicProfilePage } = serve({ status: { [BOB]: { status: state } } });
    await landing(BOB);
    expect(screen.getByText(message)).toBeTruthy();
    expect(publicProfilePage).not.toHaveBeenCalled();
  });

  it('rejects an address that is not a Telium id', async () => {
    serve({});
    await landing('bob-at-home-dot-example');
    expect(screen.getByText('That is not a valid Telium user address.')).toBeTruthy();
  });

  it.each([[undefined], ['soon']])('omits the join date row for created_at=%s', async (createdAt) => {
    serve(active(BOB, { ...QUIET, profile: { display_name: 'Bob', created_at: createdAt } }));
    await landing(BOB);
    expect(screen.queryByText('On Telium since')).toBeNull();
    expect(screen.queryByText('Invalid Date')).toBeNull();
  });
});

describe('the web client is never a public directory', () => {
  const webRoot = `${process.cwd()}/`;

  it('ships noindex in index.html and no module mentions robots', () => {
    expect(readFileSync(`${webRoot}index.html`, 'utf8'))
      .toContain('<meta name="robots" content="noindex,nofollow,noarchive" />');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.(js|jsx|ts|tsx|html)$/.test(entry) || path.endsWith('public-profile-link.test.jsx')) continue;
        if (/robots/i.test(readFileSync(path, 'utf8'))) offenders.push(path.slice(webRoot.length));
      }
    };
    walk(`${webRoot}src`);
    expect(offenders).toEqual([]);
  });
});

describe('what a stranger opening the link is made to fetch', () => {
  const permitted = (value) => /^(?:$|[#?/]|\.{1,2}\/|data:|blob:)/.test(value)
    || value.startsWith(`${HOME}/`) || value === HOME;

  function outboundUrls(container) {
    const found = [];
    for (const el of container.querySelectorAll('*')) {
      for (const attr of ['src', 'srcset', 'poster', 'href', 'data', 'action']) {
        if (attr === 'href' && el.tagName !== 'LINK') continue;
        const value = el.getAttribute(attr);
        if (value == null) continue;
        for (const part of value.split(',')) {
          const url = part.trim().split(/\s+/)[0];
          if (url) found.push(url);
        }
      }
      const style = el.getAttribute('style');
      if (style && /url\(/i.test(style)) found.push(style);
    }
    return found;
  }
  const mediaUrls = (container) => outboundUrls(container).filter((u) => u.includes('/_telium/v1/media/'));

  it('reaches no host but the one named in the link, whatever the page says', async () => {
    serve(active(BOB, {
      profile: {
        display_name: 'Bob',
        bio: 'Runs a small homeserver. https://elsewhere.example/bio',
        banner_ref: 'https://tracker.example/banner.png',
        avatar_ref: '//tracker.example/avatar.png',
      },
      presence: {
        status: 'online',
        rich_activity: { name: 'Beat Saber', type: 0, assets: { large_image: 'https://tracker.example/art.png' } },
      },
      presence_known: true,
    }));
    const { container } = await landing(BOB);
    await waitFor(() => expect(mediaUrls(container)).toHaveLength(2));

    expect(outboundUrls(container).filter((u) => !permitted(u))).toEqual([]);
    expect(container.innerHTML).not.toContain('//tracker.example');
    expect(mediaUrls(container).sort()).toEqual([
      `${HOME}/_telium/v1/media/${encodeURIComponent('//tracker.example/avatar.png')}`,
      `${HOME}/_telium/v1/media/${encodeURIComponent('https://tracker.example/banner.png')}`,
    ].sort());
    expect(container.querySelector('.activity-card__cover--empty')).toBeTruthy();
    const link = container.querySelector('a.bio-link');
    expect(link.getAttribute('href')).toBe('https://elsewhere.example/bio');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('withholds both pictures rather than fetching them around protected mode', async () => {
    registerOrigin('home.example', [HOME]);
    configureTransport({
      getPrefs: () => ({ mode: 'protected', guilds: {}, autoFallback: false }),
      getGuilds: () => [],
      getHomeDomain: () => 'my-own.example',
    });
    try {
      serve(active(BOB, { ...LOUD, profile: { ...PROFILE } }));
      const fetched = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, init) => {
        fetched.push(String(url));
        return realFetch(url, init);
      };
      try {
        const banner = await teliumMediaSrc(`${HOME}/_telium/v1/media/bnr-hash`, { purpose: 'profile banner' });
        const avatar = await teliumMediaSrc(`${HOME}/_telium/v1/media/ava-hash`, { purpose: 'profile picture' });
        expect(banner.src).toBeNull();
        expect(avatar.src).toBeNull();
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(fetched.filter((url) => url.includes('/_telium/v1/media/'))).toEqual([]);

      const { container } = await landing(BOB);
      expect(container.querySelector('.pc__banner')?.children).toHaveLength(0);
      expect(container.querySelector('.avatar')?.textContent).toBe('BO');
    } finally {
      forgetOrigin('home.example');
      configureTransport({
        getPrefs: () => ({ mode: 'direct', guilds: {}, autoFallback: false }),
        getGuilds: () => [],
        getHomeDomain: () => null,
      });
    }
  });
});

describe('acting on a public profile before there is an account', () => {
  it.each([
    ['nobody is signed in', freshStore, 'onRequireAuth'],
    ['the session has not finished starting', signedInStore, 'onQueueAction'],
  ])('queues the press instead of calling the store when %s', async (_, makeStore, callback) => {
    serve(active(BOB, QUIET));
    const store = makeStore();
    const addFriend = vi.spyOn(store, 'addFriend');
    const start = vi.spyOn(store, 'startConversation');
    const queued = vi.fn();
    const { user } = await landing(BOB, { store, [callback]: queued });
    await user.click(screen.getByRole('button', { name: /Add Friend/ }));
    expect(queued).toHaveBeenCalledWith('friend');
    await user.click(screen.getByRole('button', { name: /Message/ }));
    expect(queued).toHaveBeenCalledWith('message');
    expect(addFriend).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('resumes a queued action against the moved-to identity', async () => {
    serve(moved());
    const store = signedInStore();
    const addFriend = vi.spyOn(store, 'addFriend').mockResolvedValue({});
    const onActionHandled = vi.fn();
    await landing(BOB, { store, sessionReady: true, pendingAction: 'friend', onActionHandled });
    await waitFor(() => expect(addFriend).toHaveBeenCalledWith(BOB_MOVED));
    expect(addFriend).not.toHaveBeenCalledWith(BOB);
    await waitFor(() => expect(onActionHandled).toHaveBeenCalledTimes(1));
  });

  it('carries Add Friend through creating a brand new account', async () => {
    serve(moved());
    const store = freshStore();
    store.route = { view: 'profile-link', userId: BOB, guildId: null, channelId: null, conversationId: null };
    const user = userEvent.setup();
    render(<App store={store} />);
    await screen.findByRole('heading', { name: 'Bob' });
    const addFriend = vi.spyOn(store, 'addFriend').mockResolvedValue({});

    await user.click(screen.getByRole('button', { name: /Add Friend/ }));
    expect(addFriend).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: 'Create an account' });
    await signIn(user, { home: HOME, username: 'alice', register: true });

    await waitFor(() => expect(addFriend).toHaveBeenCalledWith(BOB_MOVED), { timeout: 25_000 });
    expect(store.route.view).toBe('profile-link');
  });
});
