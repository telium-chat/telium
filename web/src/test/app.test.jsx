import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App.jsx';
import { recentEmoji, rememberEmoji } from '../lib/emoji.js';
import { open, syncKeys } from '../lib/sealed-sync.js';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';
import { signIn as walkSignIn } from './sign-in.js';
import { ConnectionManager, Status } from '../lib/gateway.js';
import { FakePC, stubMedia } from './fake-webrtc.js';
import { Store } from '../lib/store.js';
import { dayOf } from '../lib/util.js';
import { EN } from '../lib/i18n/catalog/index.js';

async function signIn(user, { legacy = false } = {}) {
  await walkSignIn(user, { home: HOME });
  if (legacy) {
    await user.click(await screen.findByRole('button', { name: 'Use legacy sign-in' }));
  }
}

async function boot(overrides) {
  const server = createFakeServer(overrides);
  server.install();
  const store = freshStore();
  const user = userEvent.setup();
  render(<App store={store} />);
  await signIn(user, { legacy: overrides?.opaqueAuth === false });
  await waitFor(() => expect(store.signedIn).toBe(true));
  await act(async () => { await store.addServer('guilds.example'); });
  await screen.findByTitle('Telium on guilds.example');
  return { server, store, user };
}

async function openGuildSettings(user) {
  await user.click(await screen.findByRole('button', { name: 'Guild menu' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Server settings' }));
}

describe('the client', () => {
  it('refuses to send a password if a previously OPAQUE home is downgraded', async () => {
    const server = createFakeServer({ opaqueAuth: false });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    const pin = 'telium.auth.opaque.v1:' + HOME;
    localStorage.setItem(pin, JSON.stringify(true));

    try {
      render(<App store={store} />);
      await walkSignIn(user, { home: HOME, password: 'do not disclose me' });

      expect(await screen.findByText(EN['errors.opaque_downgrade'])).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Use legacy sign-in' })).toBeNull();
      expect(server.state.authBodies).toEqual([]);
      expect(store.signedIn).toBe(false);
    } finally {
      localStorage.removeItem(pin);
    }
  });

  it('signs in, joins a guild server, and shows its channels', async () => {
    const { store, user } = await boot();

    expect(store.guilds.get('g1').domain).toBe('guilds.example');

    await user.click(screen.getByTitle('Telium on guilds.example'));
    const topbar = document.querySelector('.topbar');
    await waitFor(() => expect(within(topbar).getByText('general')).toBeTruthy());
    expect(within(topbar).getByText('The first channel')).toBeTruthy();
    expect(await screen.findByText('first')).toBeTruthy();
    expect(screen.getByText('second')).toBeTruthy();
  });

  it('sends a message and folds the response into the timeline', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'hello from the test');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(server.state.sent).toHaveLength(1));
    expect(server.state.sent[0].content).toBe('hello from the test');
    expect(await screen.findByText('hello from the test')).toBeTruthy();
    expect(composer.value).toBe('');
  });

  it('keeps a message you just sent in the block it will land in', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    server.state.blackhole.add(GUILD);
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'one');
    await user.keyboard('{Enter}');
    await user.type(composer, 'two');
    await user.keyboard('{Enter}');

    const first = (await screen.findByText('one')).closest('.msg-row');
    const second = (await screen.findByText('two')).closest('.msg-row');
    expect(first.getAttribute('aria-busy')).toBe('true');
    expect(second.getAttribute('aria-busy')).toBe('true');

    expect(within(first).getByText('Sending\u2026')).toBeTruthy();
    expect(within(second).queryByText('Sending\u2026')).toBeNull();
  });

  it('renders a message that arrives over the gateway', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm99',
        channel_id: 'c1',
        author: '@carol:home.example',
        content: 'pushed, not polled',
        created_at: Date.now(),
      });
    });

    expect(await screen.findByText('pushed, not polled')).toBeTruthy();
  });

  it('emits a mention for the open channel without marking it unread', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    await waitFor(() => expect(store.reading).toBe('c1'));

    const mentions = [];
    store.on('mention', (event) => mentions.push(event));
    const unreadBefore = store.unreadFor('c1').unread;

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm-open-mention',
        channel_id: 'c1',
        author: '@carol:home.example',
        content: `hey ${store.me.user_id}`,
        created_at: Date.now(),
      });
    });

    await waitFor(() => expect(mentions).toHaveLength(1));
    expect(mentions[0].channelId).toBe('c1');
    expect(mentions[0].message.id).toBe('m-open-mention');
    expect(store.unreadFor('c1').unread).toBe(unreadBefore);
  });

  it('emits a reply notification when the realtime event replies to me', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const mentions = [];
    store.on('mention', (event) => mentions.push(event));

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm-reply-notify',
        channel_id: 'c1',
        guild_id: 'g1',
        author: '@carol:home.example',
        content: 'plain reply with no textual mention',
        reply_to: 'm1',
        reply_author: store.me.user_id,
        created_at: Date.now(),
      });
    });

    await waitFor(() => expect(mentions).toHaveLength(1));
    expect(mentions[0].message.id).toBe('m-reply-notify');
    expect(mentions[0].kind).toBe('reply');

    act(() => {
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm-reply-and-mention',
        channel_id: 'c1',
        guild_id: 'g1',
        author: '@carol:home.example',
        content: `also pinging ${store.me.user_id}`,
        reply_to: 'm1',
        reply_author: store.me.user_id,
        created_at: Date.now(),
      });
    });

    await waitFor(() => expect(mentions).toHaveLength(2));
    expect(mentions[1].kind).toBe('mention');
  });

  it('subscribes to a member range when the member list mounts', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    await waitFor(() => {
      const subscribe = server.framesFor(GUILD).find((f) => f.op === 'SUBSCRIBE');
      expect(subscribe).toBeTruthy();
      expect(subscribe.d.guild_id).toBe('g1');
      expect(subscribe.d.member_ranges[0]).toEqual([0, 99]);
    });
  });

  it('asks for the member list again when the socket comes back', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    const asks = () => server.framesFor(GUILD).filter((f) => f.op === 'SUBSCRIBE').length;
    await waitFor(() => expect(asks()).toBe(1));

    const host = new URL(GUILD).host;
    const socket = server.state.sockets
      .filter((s) => new URL(s.url.replace(/^ws/, 'http')).host === host)
      .at(-1);
    act(() => {
      socket.readyState = 3;
      socket.onclose({ code: 1006, reason: 'dropped' });
      store.gw.wake();
    });

    await waitFor(() => expect(store.gw.statusOf('guilds.example')).toBe(Status.Ready));
    await waitFor(() => expect(asks()).toBe(2));
  });

  it('asks for the member list on entering a guild with the sidebar closed', async () => {
    const { server, store, user } = await boot();
    act(() => { store.prefs.members = false; store.savePrefs(); });

    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    expect(screen.queryAllByLabelText('Members')).toHaveLength(0);

    const asks = () => server.framesFor(GUILD).filter((f) => f.op === 'SUBSCRIBE');
    await waitFor(() => expect(asks()).toHaveLength(1));
    expect(asks()[0].d.guild_id).toBe('g1');
    expect(asks()[0].d.member_ranges[0]).toEqual([0, 99]);

    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 2,
        online_count: 1,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [{ user_id: '@bob:home.example', display_name: 'Bob', roles: ['g1'] }],
        }],
      });
    });
    expect(store.members.get('g1')?.get('@bob:home.example')?.display_name).toBe('Bob');

    act(() => { store.prefs.members = true; store.savePrefs(); });
    expect(await screen.findByLabelText('Members')).toBeTruthy();
    expect(asks()).toHaveLength(1);
  });

  it('opens a profile card with each identity piece labelled', async () => {
    const server = createFakeServer({
      mutualFriends: [{
        user_id: '@carol:home.example',
        display_name: 'Carol',
        avatar_ref: null,
      }],
      profiles: {
        '@bob:home.example': {
          user_id: '@bob:home.example',
          display_name: 'Bob',
          pronouns: 'he/him',
          bio: 'Number theorist.',
          banner_ref: 'bob-banner?cap=cap-1',
          created_at: 1_542_492_000_000,
        },
        '@carol:home.example': {
          user_id: '@carol:home.example',
          display_name: 'Carol',
          bio: 'Cryptographer.',
        },
      },
    });
    server.install();
    const store = new Store();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user);
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 3,
        online_count: 2,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [
            { user_id: '@bob:home.example', display_name: 'Bob', roles: ['g1'] },
            { user_id: '@carol:home.example', display_name: 'Carol', roles: ['g1'] },
          ],
        }],
      });
    });

    await user.click(await screen.findByRole('button', { name: 'Open profile for Bob' }));
    const avatarCard = await screen.findByRole('dialog');
    expect(within(avatarCard).getByText('Number theorist.')).toBeTruthy();
    expect(avatarCard.querySelector('img')?.getAttribute('src'))
      .toBe(`${GUILD}/_telium/v1/media/remote/home.example/bob-banner?cap=cap-1`);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const members = await screen.findByRole('complementary', { name: 'Members' });
    await user.click(await within(members).findByText('Bob'));

    let dialog = await screen.findByRole('dialog');
    const name = within(dialog).getAllByText('Bob');
    expect(name.length).toBe(1);
    expect(within(dialog).queryByText(/Identity, from/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Open full profile' }));
    dialog = await waitFor(() => {
      const full = screen.getAllByRole('dialog').find((d) => !d.closest('.popover'));
      expect(full).toBeTruthy();
      return full;
    });

    const under = (label) => within(dialog).getByText(label).nextElementSibling.textContent;
    expect(under('Member since')).toBe(dayOf(1_542_492_000_000));

    expect(within(dialog).getByText('Number theorist.')).toBeTruthy();
    expect(within(dialog).queryByText(/About me/i)).toBeNull();

    await user.click(within(dialog).getByRole('tab', { name: /mutual friends?$/i }));
    expect(await within(dialog).findByRole('button', { name: 'Open Carol’s profile' })).toBeTruthy();
    expect(within(dialog).queryByText('@carol:home.example')).toBeNull();

    await user.click(within(dialog).getByRole('tab', { name: /mutual servers?$/i }));
    expect(await within(dialog).findByTitle(/\(guilds\.example\)$/)).toBeTruthy();

    expect(within(dialog).queryByRole('tab', { name: 'About' })).toBeNull();
    expect(within(dialog).getByText('Number theorist.')).toBeTruthy();

    await user.click(within(dialog).getByRole('tab', { name: /mutual friends?$/i }));
    await within(dialog).findByRole('button', { name: 'Open Carol’s profile' });
    await user.click(within(dialog).getByRole('button', { name: 'See how you are connected' }));
    const graphTitle = await screen.findByRole('heading', { name: /^Mutual friends\s*\d+$/ });
    const graphDialog = graphTitle.closest('[role="dialog"]');
    expect(graphDialog).toBeTruthy();
    expect(within(graphDialog).getByText('You')).toBeTruthy();
    expect(within(graphDialog).getByText('Bob')).toBeTruthy();
    expect(within(graphDialog).queryByRole('button', { name: /Bob/ })).toBeNull();
    expect(within(graphDialog).getByRole('button', { name: 'Open Carol’s profile' })).toBeTruthy();
    expect(within(graphDialog).queryByText(/social-graph probes/)).toBeNull();
    await user.click(within(graphDialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /^Mutual friends/ })).toBeNull());

    expect(screen.getAllByRole('dialog').some((d) => !d.closest('.popover'))).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(members).getByText('Bob'));
    dialog = await screen.findByRole('dialog');

    expect(dialog.closest('.popover')).toBeTruthy();
    expect(within(dialog).queryByText(/Looking up/)).toBeNull();

    await user.click(within(document.querySelector('.topbar')).getByText('The first channel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(within(members).getByText('Bob'));
    dialog = await screen.findByRole('dialog');

    await user.click(within(members).getByText('Carol'));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Cryptographer.')).toBeTruthy());
    await user.click(within(members).getByText('Bob'));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('Number theorist.')).toBeTruthy());
    dialog = screen.getByRole('dialog');

    expect(Number(dialog.closest('.popover').style.zIndex)).toBeLessThan(50);

    await user.click(within(dialog).getByRole('button', { name: 'Open full profile' }));
    await waitFor(() => {
      expect(screen.getAllByRole('dialog').some((d) => !d.closest('.popover'))).toBe(true);
    });
    const opened = screen.getAllByRole('dialog').find((d) => !d.closest('.popover'));
    expect(within(opened).getByText('Number theorist.')).toBeTruthy();
    expect(document.querySelector('.popover')).toBeNull();
  });

  it('offers a DM and a friend request beside the way in to the full profile', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 2,
        online_count: 1,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [{ user_id: '@bob:home.example', display_name: 'Bob', roles: [] }],
        }],
      });
    });

    const members = await screen.findByRole('complementary', { name: 'Members' });
    await user.click(await within(members).findByText('Bob'));
    const card = await screen.findByRole('dialog');

    const add = within(card).getByRole('button', { name: 'Add Bob as a friend' });
    const call = within(card).getByRole('button', { name: 'Call Bob' });
    const full = within(card).getByRole('button', { name: 'Open full profile' });
    const dm = within(card).getByRole('textbox', { name: 'Message Bob' });

    expect(add.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(call.compareDocumentPosition(full) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(full.compareDocumentPosition(dm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(add);
    await waitFor(() => expect(store.friends.get('@bob:home.example')?.state).toBe('pending_out'));

    const sent = await within(card).findByRole('button', { name: 'Friend request sent' });
    await user.click(sent);
    await user.click(await screen.findByRole('menuitem', { name: 'Cancel request' }));
    await waitFor(() => expect(store.friends.get('@bob:home.example')?.state).not.toBe('pending_out'));
    expect(await within(card).findByRole('button', { name: 'Add Bob as a friend' })).toBeTruthy();
  });

  it('degrades one server without degrading the client', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.state.reachable.delete(GUILD);
      for (const socket of server.state.sockets) {
        if (socket.url.includes('guilds.example')) socket.onclose?.({ code: 1006, reason: 'gone' });
      }
    });

    expect(screen.queryByText(/Reconnecting to guilds\.example/)).toBeNull();
    const banner = await screen.findByText(
      /Reconnecting to guilds\.example/, {}, { timeout: 5000 },
    );
    expect(banner.textContent).toMatch(/Other servers are unaffected/);
    expect(store.signedIn).toBe(true);
    expect(screen.getByTitle(/Telium - guilds\.example is degraded/)).toBeTruthy();
  });

function seedSession(origins, { expiresAt = Date.now() + 3_600_000 } = {}) {
  localStorage.setItem('telium.session.v1', JSON.stringify({
    home: {
      base: HOME, domain: 'home.example', token: 'home-token',
      user_id: '@alice:home.example', device_id: 'd1',
      expires_at: Date.now() + 86_400_000, device_secret: null,
    },
    servers: Object.fromEntries(origins.map((origin) => [new URL(origin).host, {
      base: origin,
      gateway: `${origin.replace(/^http/, 'ws')}/gateway/v1`,
      token: `session-for-${new URL(origin).host}`,
      expires_at: expiresAt,
    }])),
  }));
}

  it('paints the shell and the servers that answer while one hangs', async () => {
    const DEAD = 'https://dead.example';
    const server = createFakeServer();
    server.state.latency = 50;
    server.state.blackhole.add(DEAD);
    server.install();
    seedSession([HOME, DEAD, GUILD]);
    const store = freshStore();
    render(<App store={store} />);

    expect(await screen.findByTitle('Add a guild or server')).toBeTruthy();
    expect(store.guilds.size).toBe(0);

    expect(await screen.findByTitle('Telium on guilds.example')).toBeTruthy();
    expect(store.gw.statusOf('dead.example')).toBe(Status.Connecting);
  });

  it('mints a new guild session for one that ran out, without asking the user', async () => {
    const server = createFakeServer();
    server.install();
    seedSession([HOME, GUILD], { expiresAt: Date.now() - 1000 });
    server.state.expired.add('session-for-guilds.example');
    const store = freshStore();
    render(<App store={store} />);

    await waitFor(() => {
      expect(store.session.servers['guilds.example'].token).not.toBe('session-for-guilds.example');
    });
    await waitFor(() => expect(store.gw.statusOf('guilds.example')).toBe(Status.Ready));
    expect(store.guilds.get('g1').domain).toBe('guilds.example');
  });

  it('retries the request the guild server refused, rather than losing it', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const stale = store.session.servers['guilds.example'].token;
    server.state.expired.add(stale);

    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'sent across the expiry');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('sent across the expiry')).toBeTruthy();
    expect(store.session.servers['guilds.example'].token).not.toBe(stale);
  });

  it('opens one session per server across sign-in, not two', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user);
    await waitFor(() => expect(store.gw.statusOf('home.example')).toBe(Status.Ready));

    expect(server.state.sockets.length).toBe(1);
    expect(server.framesFor(HOME).filter((f) => f.op === 'IDENTIFY').length).toBe(1);
  });

  it('replaces an edited message rather than patching it in place', async () => {
    const { server, store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const before = store.messages.get('c1').find((m) => m.content === 'first');
    act(() => {
      server.dispatch(GUILD, 'MESSAGE_UPDATE', { ...before, content: 'edited' });
    });

    expect(store.messages.get('c1').find((m) => m.id === before.id)).not.toBe(before);
    expect(await screen.findByText('edited')).toBeTruthy();
  });

  it('opens user settings and names the home server it is talking to', async () => {
    const { user } = await boot();
    await user.click(screen.getByTitle('Settings'));

    const dialog = await screen.findByRole('dialog');
    const nav = await within(dialog).findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByText('Home server')).toBeTruthy();
    expect(within(nav).getByText('home.example')).toBeTruthy();

    await user.click(within(nav).getByRole('button', { name: 'Connected servers' }));
    expect(await within(dialog).findByText('guilds.example')).toBeTruthy();
    expect(within(dialog).getByText('home')).toBeTruthy();
  });

  it('guides a move without asking the user to call the migration API', async () => {
    const { user } = await boot();
    await user.click(screen.getByTitle('Settings'));

    const settings = await screen.findByRole('dialog');
    await user.click(within(settings).getByRole('button', { name: 'Account' }));
    await within(settings).findByText('Move this account');

    await user.click(within(settings).getByRole('button', { name: 'Start a move' }));
    const dialogs = screen.getAllByRole('dialog');
    const move = dialogs.at(-1);

    expect(within(move).getByLabelText('Destination server')).toBeTruthy();
    expect(within(move).queryByLabelText('Import code')).toBe(null);
    expect(within(move).getByRole('button', { name: 'Continue on the new server' })).toBeTruthy();

    await user.click(within(move).getByRole('button', { name: 'Use an import code' }));
    expect(within(move).getByText('1. Prepare the destination server.')).toBeTruthy();
    expect(within(move).getByText('home.example')).toBeTruthy();
    expect(within(move).getByText('@alice:home.example')).toBeTruthy();
    expect(within(move).getByLabelText('Destination server')).toBeTruthy();
    expect(within(move).getByLabelText('Import code')).toBeTruthy();
    expect(move.textContent).not.toContain('/_telium/v1/migrate/accept');
    expect(move.textContent).toContain('Settings → Account → Receive a move');
  });

  it('prepares the destination half of a move from account settings', async () => {
    const { store, user } = await boot();
    let request = null;
    store.home.acceptMigration = async (body) => {
      request = body;
      return {
        import_token: 'claim-token-123',
        expires_at: Date.now() + 86_400_000,
        destination: 'home.example',
        target_id: '@alice:home.example',
        subject_type: 'user',
        source_id: '@alice:old.example',
      };
    };

    await user.click(screen.getByTitle('Settings'));
    const settings = await screen.findByRole('dialog');
    await user.click(within(settings).getByRole('button', { name: 'Account' }));
    await within(settings).findByText('Receive a move on this server');

    await user.click(within(settings).getByRole('button', { name: 'Prepare to receive' }));
    const receive = screen.getAllByRole('dialog').at(-1);

    await user.type(within(receive).getByLabelText('Old account ID'), '@alice:old.example');
    expect(within(receive).getByLabelText('Old server').value).toBe('old.example');

    await user.click(within(receive).getByRole('button', { name: 'Create import code' }));
    expect(await within(receive).findByDisplayValue('claim-token-123')).toBeTruthy();
    expect(request).toEqual({
      subject_type: 'user',
      source: 'old.example',
      source_id: '@alice:old.example',
    });
    expect(receive.textContent).toContain('home.example is ready to receive this move.');
    expect(receive.textContent).toContain('Nothing has moved yet.');
    expect(receive.textContent).toContain('Now go back to the old server.');
  });
  it('falls back to trusted-device recovery on a pre-OPAQUE homeserver', async () => {
    const { server, store, user } = await boot({ opaqueAuth: false });
    await waitFor(() => expect(store.vault?.raw).toBeTruthy());
    const held = server.state.vaults.get('@alice:home.example');
    expect(held.mode).toBe('device_custody');
    expect(held.escrow_key).toBe(null);

    await user.click(screen.getByTitle('Settings'));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole(
      'button', { name: 'Encryption key' }, { timeout: 5000 },
    ));

    const how = await within(dialog).findByText('How this account recovers');
    expect(how.nextElementSibling.textContent).toMatch(/^Trusted-device recovery\./);
    expect(within(dialog).queryByText(/server-assisted recovery is still active/i)).toBeNull();
  });

  it('shows history oldest-first and pages backwards until it runs out', async () => {
    const server = createFakeServer({
      messages: Array.from({ length: 130 }, (_, i) => ({
        id: `m${String(i + 1).padStart(4, '0')}`,
        channel_id: 'c1',
        author: '@bob:home.example',
        content: `line ${i + 1}`,
        created_at: 1_700_000_000_000 + i * 1000,
      })),
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user);
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));

    await waitFor(() => expect(store.hasMore.get('c1')).toBe(false), { timeout: 5000 });
    const list = store.messages.get('c1');
    expect(list.length).toBe(130);
    expect(list.map((m) => m.id)).toEqual([...list].sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((m) => m.id));
    expect(list[0].content).toBe('line 1');
    expect(list.at(-1).content).toBe('line 130');

    const first = await screen.findByText('line 1');
    const last = screen.getByText('line 130');
    expect(first.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    const cursors = fetch.mock.calls
      .map(([url]) => new URL(url).searchParams.get('before'))
      .filter(Boolean);
    expect(cursors).toEqual(['m0081', 'm0031']);
  });

  it('pages back to the message a reply points at, however far above the window it is', async () => {
    const server = createFakeServer({
      messages: Array.from({ length: 130 }, (_, i) => ({
        id: `m${String(i + 1).padStart(4, '0')}`,
        channel_id: 'c1',
        author: '@bob:home.example',
        content: `line ${i + 1}`,
        created_at: 1_700_000_000_000 + i * 1000,
      })),
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user);
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await screen.findByTitle('Telium on guilds.example');

    await act(async () => {
      expect(await store.loadUntil('c1', 'm0005')).toBe(true);
      expect(await store.loadUntil('c1', 'm9999')).toBe(false);
    });
    expect(store.messages.get('c1').some((m) => m.id === 'm0005')).toBe(true);

    const cursors = fetch.mock.calls
      .map(([url]) => new URL(url).searchParams.get('before'))
      .filter(Boolean);
    expect(cursors).toEqual(['m0081', 'm0031']);
  });

  it('keeps jump-loaded history when a tail refresh finishes afterwards', async () => {
    const store = freshStore();
    store.channels.set('c1', { id: 'c1', guild_id: 'g1', domain: 'guilds.example' });

    const messages = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
      id: `m${String(from + i).padStart(4, '0')}`,
      channel_id: 'c1',
      author: '@bob:home.example',
      content: `line ${from + i}`,
      created_at: 1_700_000_000_000 + (from + i) * 1000,
    }));
    const latest = messages(51, 100);
    const older = messages(1, 50);
    store.messages.set('c1', latest);
    store.hasMore.set('c1', true);

    let finishRefresh;
    const refreshResponse = new Promise((resolve) => { finishRefresh = resolve; });
    store.apis.set('guilds.example', {
      history: (_channelId, { before } = {}) => (
        before ? Promise.resolve({ messages: older }) : refreshResponse
      ),
    });

    const refreshing = store.loadHistory('c1');
    await store.loadHistory('c1', { before: 'm0051' });
    expect(store.messages.get('c1').map((m) => m.id)).toHaveLength(100);

    finishRefresh({ messages: latest });
    await refreshing;
    expect(store.messages.get('c1').map((m) => m.id))
      .toEqual(messages(1, 100).map((m) => m.id));
  });

  async function synced(server, store, key) {
    const row = server.state.sync[key];
    if (!row) return undefined;
    expect(row.value.sealed).toBe('v1');
    const { doc } = await open(await syncKeys(store.vault), key, row.value);
    return doc.v;
  }

  it('carries preferences to a second device through the account sync store', async () => {
    const { server, store } = await boot();
    await waitFor(() => expect(store.sync.keys).toBeTruthy());

    await act(async () => {
      store.prefs.theme = 'light';
      store.prefs.muted.c1 = true;
      store.prefs.voiceRegion = 'eu-west';
      store.prefs.dateFormat = 'dmy';
      store.savePrefs();
      rememberEmoji(store.sync, '\u{1F954}');
      await store.sync.push();
    });

    const prefs = await synced(server, store, 'prefs.v1');
    expect(prefs.theme).toBe('light');
    expect(prefs.muted).toEqual({ c1: true });
    expect(prefs.voiceRegion).toBeUndefined();
    expect(store.prefs.dateFormat).toBe('dmy');
    expect(prefs.dateFormat).toBeUndefined();
    expect(JSON.stringify(server.state.sync)).not.toContain('eu-west');
    expect(JSON.stringify(server.state.sync)).not.toMatch(/\\?"c1\\?"/);

    localStorage.clear();
    const second = freshStore();
    expect(second.prefs.theme).toBe('dark');
    await act(async () => {
      await second.signIn(HOME, 'alice', 'hunter2hunter2');
      await second.start();
    });

    await waitFor(() => expect(second.prefs.theme).toBe('light'));
    expect(second.prefs.muted.c1).toBe(true);
    expect(recentEmoji(second.sync)).toEqual(['\u{1F954}']);
    expect(second.prefs.voiceRegion).toBeUndefined();
    expect(second.prefs.dateFormat).toBeUndefined();
  });

  it('keeps preferences working while the home server is unreachable', async () => {
    const { server, store } = await boot();
    await waitFor(() => expect(server.state.sync['prefs.v1']).toBeTruthy());

    server.state.reachable.delete(HOME);
    await act(async () => {
      store.prefs.theme = 'light';
      store.savePrefs();
      await store.sync.push();
    });

    expect(store.sync.online).toBe(false);
    expect(store.prefs.theme).toBe('light');
    expect((await synced(server, store, 'prefs.v1')).theme).toBe('dark');

    server.state.reachable.add(HOME);
    await act(async () => { await store.sync.push(); });
    expect(store.sync.online).toBe(true);
    expect((await synced(server, store, 'prefs.v1')).theme).toBe('light');
  });

  it('migrates preferences that predate the sync store rather than dropping them', async () => {
    localStorage.setItem('telium.prefs.v1', JSON.stringify({ theme: 'light', muted: { c1: true }, collapsed: {} }));
    localStorage.setItem('telium.emoji.recent.v1', JSON.stringify(['\u{1F954}']));
    localStorage.setItem('telium.emoji.tone.v1', '\u{1F3FD}');

    const { server, store } = await boot();

    expect(store.prefs.theme).toBe('light');
    await waitFor(async () => expect(await synced(server, store, 'emoji.recent.v1')).toEqual(['\u{1F954}']));
    expect((await synced(server, store, 'prefs.v1')).muted).toEqual({ c1: true });
    expect(await synced(server, store, 'emoji.tone.v1')).toBe('\u{1F3FD}');
  });

  it('knows who holds the key even when the vault itself would not open', async () => {
    const { store } = await boot({
      vaults: new Map([['@alice:home.example', {
        mode: 'escrowed',
        escrow_key: btoa(String.fromCharCode(...new Uint8Array(32))),
        ciphertext: 'AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }]]),
    });
    await waitFor(() => expect(store.custody?.mode).toBe('escrowed'));
    expect(store.custody.server_can_recover).toBe(true);
    expect(store.vault).toBe(null);
  });

  it('keeps paging past the hot window when cold segments say there is more', async () => {
    const message = (id, i) => ({
      id, channel_id: 'c1', author: '@bob:home.example',
      content: `line ${i}`, created_at: 1_700_000_000_000 + i * 1000,
    });
    const server = createFakeServer({
      messages: Array.from({ length: 3 }, (_, i) => message(`m000${i + 1}`, i + 4)),
      archived: Array.from({ length: 3 }, (_, i) => message(`a000${i + 1}`, i + 1)),
      segments: [{
        id: 's1', first_id: 'a0001', last_id: 'a0003', messages: 3, bytes: 400, created_at: 1,
      }],
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    render(<App store={store} />);
    await signIn(user);
    await waitFor(() => expect(store.signedIn).toBe(true));
    await act(async () => { await store.addServer('guilds.example'); });
    await user.click(await screen.findByTitle('Telium on guilds.example'));

    expect(await screen.findByText('line 1')).toBeTruthy();
    await waitFor(() => expect(store.hasMore.get('c1')).toBe(false), { timeout: 5000 });
    expect(store.messages.get('c1').map((m) => m.id))
      .toEqual(['a0001', 'a0002', 'a0003', 'm0001', 'm0002', 'm0003']);
    const asks = fetch.mock.calls.filter(([url]) => String(url).endsWith('/segments'));
    expect(asks.length).toBe(1);
  });

  it('reacts from the row menu without opening the picker, and keeps the row hover-gated', async () => {
    const { server, user } = await boot();
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const more = (await screen.findAllByRole('button', { name: 'More actions' }))[0];
    const toolbar = more.closest('.reveal');
    expect(toolbar).toBeTruthy();

    expect(within(toolbar).getByRole('button', { name: 'React' })).toBeTruthy();
    expect(within(toolbar).getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(within(toolbar).queryAllByTitle(/^React with /).length).toBe(3);

    await user.click(more);
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByTitle(/^React with /).length).toBe(4);
    await user.click(within(menu).getByTitle('React with \u{1F44D}'));
    await waitFor(() => expect(server.state.reactions).toEqual([
      { message_id: 'm1', emoji: '\u{1F44D}', method: 'PUT' },
    ]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('saves media origin rules, including one that names a registry feed', async () => {
    const { server, user } = await boot();
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await openGuildSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Gates and origins' }));

    const rules = await within(dialog).findByLabelText('Media origin rules');
    await user.click(rules);
    await user.keyboard('allow files.trusted.example{enter}'
      + 'allow feed:https://registry.example/hosts.json key:CURATORKEY{enter}'
      + 'block Sketchy.Example');
    await user.click(within(dialog).getByRole('button', { name: 'Save gates' }));

    await waitFor(() => expect(server.state.gates.origins).toEqual([
      { action: 'allow', domain: 'files.trusted.example' },
      { action: 'allow', feed: 'https://registry.example/hosts.json', key: 'CURATORKEY' },
      { action: 'block', domain: 'sketchy.example' },
    ]));
  });

  it('shows what each subscribed feed resolved to and refreshes it on request', async () => {
    const { server, user } = await boot();
    Object.assign(server.state.gates, {
      origin_policy: 'allowlist',
      origins: [{
        action: 'allow',
        feed: 'https://registry.example/hosts.json',
        key: 'CURATORKEY',
        status: {
          state: 'failed', hosts: 0, allows: 0, blocks: 0,
          attempted_at: Date.now(), error: 'feed host answered 503 Service Unavailable',
        },
      }],
    });
    server.state.feedStatusAfterRefresh = {
      state: 'active', curator: 'curator.example', serial: 4,
      hosts: 12, allows: 11, blocks: 1, fetched_at: Date.now(), error: null,
    };
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await openGuildSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Gates and origins' }));

    expect((await within(dialog).findByLabelText('Media origin rules')).value)
      .toBe('allow feed:https://registry.example/hosts.json key:CURATORKEY');
    expect(await within(dialog).findByText('feed host answered 503 Service Unavailable')).toBeTruthy();
    expect(within(dialog).getByText('Failed')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Refresh feeds' }));
    await waitFor(() => expect(server.state.feedRefreshes).toBe(1));
    expect(await within(dialog).findByText('Active')).toBeTruthy();
    expect(within(dialog).getByText(/curator\.example/)).toBeTruthy();
    expect(within(dialog).getByText('12 (1 blocked)')).toBeTruthy();
    expect(within(dialog).queryByText('feed host answered 503 Service Unavailable')).toBeNull();
  });

  it('suggests curators from a directory, and pinning one is the moderator’s act', async () => {
    const { server, user } = await boot();
    server.state.curators = [
      {
        name: 'House Curators',
        feed: 'https://house.example/feed.json',
        key: 'HOUSEKEY',
        description: 'The operator’s own picks.',
        contact: 'curators@house.example',
        source: 'guilds.example',
        local: true,
      },
      {
        name: 'Example Curators',
        feed: 'https://curator.example/feed.json',
        key: 'CURATORKEY',
        description: 'Hosts that answer takedowns within a day.',
        contact: null,
        source: 'friend.example',
        local: false,
      },
    ];
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await openGuildSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Gates and origins' }));

    expect(await within(dialog).findByText('Example Curators')).toBeTruthy();
    expect(within(dialog).getByText('This server')).toBeTruthy();
    expect(within(dialog).getByText('friend.example')).toBeTruthy();
    expect(within(dialog).getByText('CURATORKEY')).toBeTruthy();

    expect(server.state.gates.origins).toEqual([]);

    const rows = within(dialog).getAllByRole('button', { name: 'Pin key' });
    await user.click(rows[1]);
    expect((await within(dialog).findByLabelText('Media origin rules')).value)
      .toBe('allow feed:https://curator.example/feed.json key:CURATORKEY');
    expect(server.state.gates.origins).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Save gates' }));
    await waitFor(() => expect(server.state.gates.origins).toEqual([
      { action: 'allow', feed: 'https://curator.example/feed.json', key: 'CURATORKEY' },
    ]));
  });

  it('shows where a subscribed feed’s key stands when its curator rotates', async () => {
    const { server, user } = await boot();
    Object.assign(server.state.gates, {
      origin_policy: 'allowlist',
      origins: [{
        action: 'allow',
        feed: 'https://registry.example/hosts.json',
        key: 'PINNEDKEY',
        status: {
          state: 'active', curator: 'curator.example', serial: 4,
          hosts: 3, allows: 3, blocks: 0, fetched_at: Date.now(), error: null,
          rotation: 1, active_key: 'SECONDKEY', pending_key: 'THIRDKEY',
        },
      }],
    });
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await openGuildSettings(user);
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Gates and origins' }));

    expect((await within(dialog).findByLabelText('Media origin rules')).value)
      .toBe('allow feed:https://registry.example/hosts.json key:PINNEDKEY');
    expect(within(dialog).getByText('Rotated once')).toBeTruthy();
    expect(within(dialog).getByText('In force: SECONDKEY')).toBeTruthy();
    expect(within(dialog).getByText('Rotation announced')).toBeTruthy();
    expect(within(dialog).getByText('Next: THIRDKEY')).toBeTruthy();
  });

  it('shows a typing indicator the moment the event lands', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'TYPING_START', {
        guild_id: 'g1', channel_id: 'c1', user_id: '@dave:home.example', timestamp: Date.now(),
      });
    });

    expect(await screen.findByText('dave is typing')).toBeTruthy();
  });

  it('shows my local typing badge in the member rail', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 2,
        online_count: 2,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [
            { user_id: '@alice:home.example', display_name: 'Alice', roles: ['g1'] },
            { user_id: '@bob:home.example', display_name: 'Bob', roles: ['g1'] },
          ],
        }],
      });
    });

    const members = await screen.findByRole('complementary', { name: 'Members' });
    const alice = within(members).getByText('Alice').closest('button');
    const composer = screen.getByPlaceholderText('Message #general');
    await user.type(composer, 'draft');
    expect(await within(alice).findByText('typing')).toBeTruthy();

    await user.clear(composer);
    await waitFor(() => expect(within(alice).queryByText('typing')).toBeNull());
  });

  it('shows and clears the typing badge on the member rail', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');
    act(() => {
      server.dispatch(GUILD, 'MEMBER_LIST_UPDATE', {
        guild_id: 'g1',
        member_count: 2,
        online_count: 2,
        ops: [{
          op: 'SYNC',
          range: [0, 99],
          items: [{ user_id: '@bob:home.example', display_name: 'Bob', roles: ['g1'] }],
        }],
      });
    });

    const members = await screen.findByRole('complementary', { name: 'Members' });
    const bob = within(members).getByText('Bob').closest('button');
    expect(within(bob).queryByText('typing')).toBeNull();

    act(() => {
      server.dispatch(GUILD, 'TYPING_START', {
        guild_id: 'g1', channel_id: 'c1', user_id: '@bob:home.example', timestamp: Date.now(),
      });
    });
    expect(await within(bob).findByText('typing')).toBeTruthy();

    act(() => {
      server.dispatch(GUILD, 'TYPING_STOP', {
        guild_id: 'g1', channel_id: 'c1', user_id: '@bob:home.example',
      });
    });
    await waitFor(() => expect(within(bob).queryByText('typing')).toBeNull());
  });

  it('follows someone in and out of a voice channel', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: 'c2', user_id: '@carol:home.example', self_mute: false,
      });
    });
    expect(await screen.findByText('carol')).toBeTruthy();

    act(() => {
      server.dispatch(GUILD, 'VOICE_STATE_UPDATE', {
        guild_id: 'g1', channel_id: null, user_id: '@carol:home.example',
      });
    });
    await waitFor(() => expect(screen.queryByText('carol')).toBeNull());
  });

  it('takes the guild off the rail when the membership ends', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      server.dispatch(GUILD, 'MEMBER_REMOVE', { guild_id: 'g1', user_id: '@alice:home.example' });
    });

    await waitFor(() => expect(screen.queryByTitle('Telium on guilds.example')).toBeNull());
    expect(await screen.findByText('Join or create a guild to get started.')).toBeTruthy();
  });

  it('forgets a guild a fresh READY no longer lists', async () => {
    const { store, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    act(() => {
      store.onReady({ domain: 'guilds.example', data: { d: { guilds: [] } } });
    });

    await waitFor(() => expect(screen.queryByTitle('Telium on guilds.example')).toBeNull());
    expect(await screen.findByText('Join or create a guild to get started.')).toBeTruthy();
  });

  it('ends a membership with the guild\u2019s voice room open, without taking the screen down', async () => {
    stubMedia();
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await user.click(await screen.findByText('lounge'));
    await screen.findByRole('toolbar', { name: 'Call controls' });

    act(() => {
      server.dispatch(GUILD, 'MEMBER_REMOVE', { guild_id: 'g1', user_id: '@alice:home.example' });
    });

    await waitFor(() => expect(screen.queryByTitle('Telium on guilds.example')).toBeNull());
    expect(screen.queryByText('Something went wrong while rendering this screen.')).toBeNull();
    expect(await screen.findByText('Join or create a guild to get started.')).toBeTruthy();
  });

  it('shows a conversation a stranger opened, from the frame alone', async () => {
    const { server, user } = await boot();
    await user.click(screen.getByTitle('Direct messages'));
    expect(await screen.findByText('No conversations yet.')).toBeTruthy();

    server.state.conversations = [{
      id: 'k1',
      kind: 'dm',
      sequencer: 'home.example',
      members: [{ user_id: '@alice:home.example' }, { user_id: '@erin:home.example' }],
    }];
    act(() => {
      server.dispatch(HOME, 'DM_MESSAGE', {
        id: 'f1', conversation_id: 'k1', kind: 'application', seq: 1,
        sender: '@erin:home.example', ciphertext: 'AAAA',
      });
    });

    expect(await screen.findByText('erin')).toBeTruthy();
  });

  it('renders and sends the animated DM typing protocol', async () => {
    const { server, store, user } = await boot({ conversations: [CONVERSATION] });
    await user.click(screen.getByLabelText('Direct messages'));
    await user.click(await screen.findByText('bob'));

    act(() => server.dispatch(HOME, 'DM_TYPING_START', {
      conversation_id: 'dm1', user_id: '@bob:home.example', timestamp: Date.now(),
    }));
    expect(await screen.findByText('bob is typing')).toBeTruthy();
    expect(document.querySelector('.typing-indicator-label')).toBeTruthy();

    act(() => server.dispatch(HOME, 'DM_TYPING_STOP', {
      conversation_id: 'dm1', user_id: '@bob:home.example', timestamp: Date.now(),
    }));
    await waitFor(() => expect(screen.queryByText('bob is typing')).toBeNull());

    const composer = screen.getByPlaceholderText('Message');
    await user.type(composer, 'hello');
    await waitFor(() => expect(server.framesFor(HOME)
      .some((frame) => frame.op === 'DM_TYPING_START')).toBe(true));
    await user.clear(composer);
    await waitFor(() => expect(server.framesFor(HOME)
      .some((frame) => frame.op === 'DM_TYPING_STOP')).toBe(true));
    expect(store.dmTypistsIn('dm1')).toEqual([]);
  });

  it('does not replay a stopped typing state after reconnect', async () => {
    const server = createFakeServer({ latency: 20 });
    server.install();
    const gateway = new ConnectionManager();
    const domain = new URL(HOME).host;
    gateway.add({
      domain, url: 'wss://home.example/gateway/v1', token: 'typing-token', intents: 0,
    });
    gateway.dmTyping(domain, 'dm1', true);
    await waitFor(() => expect(server.framesFor(HOME)
      .some((frame) => frame.op === 'DM_TYPING_START')).toBe(true));

    const socket = server.state.sockets.at(-1);
    socket.readyState = 3;
    socket.onclose({ code: 1006, reason: 'dropped' });
    gateway.dmTyping(domain, 'dm1', false);
    gateway.wake();
    await waitFor(() => expect(server.state.sockets.length).toBeGreaterThan(1));
    await waitFor(() => expect(gateway.statusOf(domain)).toBe(Status.Ready));
    expect(server.framesFor(HOME).filter((frame) => frame.op === 'DM_TYPING_START'))
      .toHaveLength(1);
    gateway.closeAll();
  });

  it('joins a voice channel, dials whoever is already in it, and plays them back', async () => {
    stubMedia();
    const { server, store, user } = await boot();
    store.members.set('g1', new Map([[
      '@alice:home.example', {
        user_id: '@alice:home.example', display_name: 'Alice', avatar_ref: 'alice-avatar?cap=cap-1',
      },
    ]]));
    store.emit('members', 'g1');
    server.state.voiceStates.push({ user_id: '@bob:home.example', channel_id: 'c2' });

    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByText('lounge'));

    const avatarUrl = `${GUILD}/_telium/v1/media/remote/home.example/alice-avatar?cap=cap-1`;
    await waitFor(() => expect(
      document.querySelector('[data-voice-participant="@alice:home.example"] img')
        ?.getAttribute('src'),
    ).toBe(avatarUrl));
    await waitFor(() => expect(
      document.querySelector('[data-user="@alice:home.example"] img')?.getAttribute('src'),
    ).toBe(avatarUrl));

    await waitFor(() => expect(server.state.signals).toHaveLength(1));
    expect(FakePC.all).toHaveLength(1);
    const [pc] = FakePC.all;
    expect(pc.config.iceServers).toEqual(server.state.iceServers);
    expect(server.state.signals[0].target).toBe('@bob:home.example');
    expect(server.state.signals[0].payload.description.type).toBe('offer');

    expect(document.querySelector('[data-user="@bob:home.example"] .animate-spin')).toBeTruthy();
    await act(async () => {
      server.dispatch(GUILD, 'VOICE_SIGNAL', {
        channel_id: 'c2',
        from: '@bob:home.example',
        payload: { description: { type: 'answer', sdp: 'remote-answer' } },
      });
    });
    await waitFor(() => expect(pc.signalingState).toBe('stable'));

    await act(async () => { pc.receive(); pc.settle('connected'); });
    const playing = [...document.querySelectorAll('audio')].filter((el) => el.srcObject);
    expect(playing).toHaveLength(1);
    await waitFor(() => expect(
      document.querySelector('[data-user="@bob:home.example"] .animate-spin'),
    ).toBeNull());

    await user.click(
      within(screen.getByRole('toolbar', { name: 'Call controls' }))
        .getByRole('button', { name: 'Disconnect' }),
    );
    await waitFor(() => expect(pc.closed).toBe(true));
    expect([...document.querySelectorAll('audio')].filter((el) => el.srcObject))
      .toHaveLength(0);
  });
  it('offers a way out of a call the server still lists you in', async () => {
    stubMedia();
    const { server, store, user } = await boot();
    server.state.voiceStates.push({ user_id: '@alice:home.example', channel_id: 'c2' });

    act(() => {
      store.navigate({ view: 'voice', guildId: 'g1', channelId: 'c2' });
    });

    await screen.findByRole('button', { name: 'Rejoin' });
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBeNull();
    expect(await screen.findByText(/Nothing on this tab is connected/)).toBeTruthy();
    expect(FakePC.all).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(server.state.voiceStates).toHaveLength(0));
    await screen.findByRole('button', { name: 'Join voice' });
  });
  it('opens the room a voice mention points at without dialling it', async () => {
    stubMedia();
    const { server, store, user } = await boot();
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const voiceId = `01H${'0'.repeat(22)}2`;
    act(() => {
      server.dispatch(GUILD, 'CHANNEL_CREATE', {
        id: voiceId, guild_id: 'g1', name: 'lounge two', type: 'voice', permission_overwrites: [],
      });
      server.dispatch(GUILD, 'MESSAGE_CREATE', {
        id: 'm-voice-mention',
        channel_id: 'c1',
        author: '@carol:home.example',
        content: `we are all in <#${voiceId}>`,
        created_at: Date.now(),
      });
    });

    const chip = await waitFor(() => {
      const found = document.querySelector('button.mention');
      expect(found).toBeTruthy();
      return found;
    });
    await user.click(chip);

    await waitFor(() => expect(store.route).toMatchObject({ view: 'voice', channelId: voiceId }));
    await screen.findByRole('button', { name: 'Join voice' });
    expect(server.state.voiceStates).toHaveLength(0);
    expect(FakePC.all).toHaveLength(0);
  });
  it('keeps the chat beside a call shut, and counts what is said into it', async () => {
    stubMedia();
    const { server, user } = await boot();
    await user.click(await screen.findByTitle('Telium on guilds.example'));
    await user.click(await screen.findByRole('button', { name: 'lounge' }));

    const toggle = await screen.findByRole('button', { name: 'Open chat' });
    expect(screen.queryByPlaceholderText(/Message/)).toBeNull();

    const said = {
      id: 'm9', channel_id: 'c2', guild_id: 'g1', author: '@bob:home.example',
      content: 'look at this @alice:home.example', created_at: 1_700_000_120_000,
    };
    server.state.messages.push(said);
    act(() => { server.dispatch(GUILD, 'MESSAGE_CREATE', said); });

    await waitFor(() => expect(within(toggle).getByText('1')).toBeTruthy());
    const rail = document.querySelector('[class*="w-[248px]"]');
    const row = within(rail).getAllByText('lounge')
      .map((node) => node.closest('button'))
      .find(Boolean);
    expect(row).toBeTruthy();
    expect(within(row).getByText('1')).toBeTruthy();

    await user.click(toggle);
    await waitFor(() => expect(document.body.textContent).toContain('look at this'));
    await waitFor(() => expect(within(row).queryByText('1')).toBeNull());
    expect(screen.getByRole('button', { name: 'Close chat' })).toBeTruthy();
  });
  it('counts a DM that arrives while you are elsewhere, and clears it on open', async () => {
    const { server, store, user } = await boot({ conversations: [CONVERSATION] });
    await user.click(screen.getByTitle('Telium on guilds.example'));
    await screen.findByText('first');

    const notified = [];
    store.on('dm-notify', (frame) => notified.push(frame));
    act(() => { server.dispatch(HOME, 'DM_MESSAGE', dmFrame('f1')); });

    const tile = (await screen.findByLabelText('bob')).parentElement;
    await waitFor(() => expect(within(tile).getByText('1')).toBeTruthy());
    expect(notified).toHaveLength(1);
    const dmTile = screen.getByLabelText('Direct messages').parentElement;
    expect(within(dmTile).queryByText('1')).toBeNull();

    await user.click(screen.getByLabelText('Direct messages'));
    const row = await screen.findByText('bob');
    expect(within(row.closest('button')).getByText('1')).toBeTruthy();

    await user.click(row);
    await waitFor(() => expect(store.dmUnreadFor('dm1')).toBe(0));
    await waitFor(() => expect(screen.queryByLabelText('bob')).toBeNull());
    expect(screen.getByLabelText('Direct messages')).toBeTruthy();
  });

  it('caps the faces on the rail, and counts what is over the line on the button', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...CONVERSATION,
      id: `dm${i + 1}`,
      members: [
        { user_id: '@alice:home.example', state: 'joined' },
        { user_id: `@u${i + 1}:home.example`, state: 'joined' },
      ],
    }));
    const { server, store, user } = await boot({ conversations: many });
    await user.click(screen.getByTitle('Telium on guilds.example'));

    act(() => {
      for (const convo of many) {
        server.dispatch(HOME, 'DM_MESSAGE', { ...dmFrame('f1'), conversation_id: convo.id });
      }
    });
    await waitFor(() => expect(store.dmUnreadFor('dm8')).toBe(1));

    await screen.findByLabelText('u1');
    expect(screen.getByLabelText('u6')).toBeTruthy();
    expect(screen.queryByLabelText('u7')).toBeNull();
    expect(screen.queryByLabelText('u8')).toBeNull();

    const dmTile = screen.getByLabelText('Direct messages').parentElement;
    expect(within(dmTile).getByText('2')).toBeTruthy();
  });

  it('folds pending friend requests into the rail tile before anyone navigates', async () => {
    const { server } = await boot({
      conversations: [CONVERSATION],
      friends: [{
        user_id: '@carol:other.example', domain: 'other.example', state: 'pending_in',
        presence: null, display_name: null, avatar_ref: null,
      }],
    });

    const tile = screen.getByLabelText('Direct messages').parentElement;
    await waitFor(() => expect(within(tile).getByText('1')).toBeTruthy());

    act(() => { server.dispatch(HOME, 'DM_MESSAGE', dmFrame('f1')); });
    const bob = (await screen.findByLabelText('bob')).parentElement;
    await waitFor(() => expect(within(bob).getByText('1')).toBeTruthy());
    expect(within(tile).getByText('1')).toBeTruthy();

    act(() => {
      server.dispatch(HOME, 'FRIEND_UPDATE', {
        user_id: '@erin:home.example', domain: 'home.example', state: 'pending_in',
        presence: null, display_name: null, avatar_ref: null,
      });
    });
    await waitFor(() => expect(within(tile).getByText('2')).toBeTruthy());

    act(() => {
      server.dispatch(HOME, 'FRIEND_UPDATE', {
        user_id: '@erin:home.example', domain: 'home.example', state: 'accepted',
        presence: null, display_name: null, avatar_ref: null,
      });
    });
    await waitFor(() => expect(within(tile).getByText('1')).toBeTruthy());
  });

  it('keeps the rail pointing at the DM half while the friends list is open', async () => {
    const { user } = await boot({ conversations: [CONVERSATION] });
    const guild = screen.getByTitle('Telium on guilds.example');
    await user.click(guild);
    await screen.findByText('first');
    expect(guild.getAttribute('aria-current')).toBe('page');

    await user.click(screen.getByLabelText('Direct messages'));
    await user.click(await screen.findByRole('button', { name: /^Friends/ }));

    expect(screen.getByLabelText('Direct messages').getAttribute('aria-current')).toBe('page');
    expect(guild.getAttribute('aria-current')).toBeNull();
  });

  it('raises nothing for the conversation already on screen', async () => {
    const { server, store, user } = await boot({ conversations: [CONVERSATION] });
    await user.click(screen.getByLabelText('Direct messages'));
    await user.click(await screen.findByText('bob'));
    await waitFor(() => expect(store.dmFrames.has('dm1')).toBe(true));

    const notified = [];
    store.on('dm-notify', (frame) => notified.push(frame));
    act(() => { server.dispatch(HOME, 'DM_MESSAGE', dmFrame('f2')); });

    await waitFor(() => expect(store.dmFrames.get('dm1')).toHaveLength(1));
    expect(store.dmUnreadFor('dm1')).toBe(0);
    expect(notified).toEqual([]);
    const tile = screen.getByLabelText('Direct messages').parentElement;
    expect(within(tile).queryByText('1')).toBeNull();
  });

  it('sets a custom status from the account menu and announces it over the gateway', async () => {
    const { server, store, user } = await boot();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set a custom status' }));

    await user.type(screen.getByLabelText('Status'), 'beating the final boss');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(store.prefs.status?.text).toBe('beating the final boss');
    const frames = [...server.framesFor(HOME), ...server.framesFor(GUILD)];
    const updates = frames.filter((f) => f.op === 'PRESENCE_UPDATE');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) expect(u.d.custom_status).toBe('beating the final boss');

    expect(await screen.findByText('beating the final boss')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit custom status' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(store.prefs.status?.text).toBe('');
    const cleared = server.framesFor(HOME).filter((f) => f.op === 'PRESENCE_UPDATE').at(-1);
    expect(cleared.d.custom_status).toBeNull();
    expect(screen.queryByText('beating the final boss')).toBeNull();
  });

  it('shows a custom status while offline when the toggle is on, off by default', async () => {
    const { server, store, user } = await boot();

    const idents = [...server.framesFor(HOME), ...server.framesFor(GUILD)]
      .filter((f) => f.op === 'IDENTIFY');
    expect(idents.length).toBeGreaterThanOrEqual(2);
    for (const i of idents) expect(i.d.presence.show_custom_status_offline).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Set a custom status' }));
    await user.type(screen.getByLabelText('Status'), 'beating the final boss');
    const toggle = () => screen.getByRole('switch', { name: 'Keep it while offline' });
    await user.click(toggle());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(store.prefs.status?.text).toBe('beating the final boss');
    expect(store.prefs.showCustomStatusOffline).toBe(true);
    const updates = [...server.framesFor(HOME), ...server.framesFor(GUILD)]
      .filter((f) => f.op === 'PRESENCE_UPDATE');
    expect(updates.length).toBeGreaterThanOrEqual(2);
    for (const u of updates) expect(u.d.show_custom_status_offline).toBe(true);

    await act(async () => { await store.addServer('guilds.example'); });
    await waitFor(() => {
      const id = server.framesFor(GUILD).filter((f) => f.op === 'IDENTIFY').at(-1);
      expect(id.d.presence.custom_status).toBe('beating the final boss');
      expect(id.d.presence.show_custom_status_offline).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Account menu' }));
    const states = await screen.findByRole('menuitem', { name: 'Online' });
    states.focus();
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByRole('menuitem', { name: /^Do not disturb/ }));
    const after = server.framesFor(GUILD).filter((f) => f.op === 'PRESENCE_UPDATE').at(-1);
    expect(after.d.status).toBe('dnd');
    expect(after.d.show_custom_status_offline).toBe(true);
    expect(after.d.custom_status).toBe('beating the final boss');
  });

});

const CONVERSATION = {
  id: 'dm1',
  kind: 'dm',
  sequencer: 'home.example',
  epoch: 1,
  last_seq: 0,
  members: [
    { user_id: '@alice:home.example', state: 'joined' },
    { user_id: '@bob:home.example', state: 'joined' },
  ],
};

const dmFrame = (id) => ({
  id,
  conversation_id: 'dm1',
  seq: Number(id.slice(1)),
  epoch: 1,
  kind: 'application',
  sender: '@bob:home.example',
  sender_device: 'd-bob',
  ciphertext: 'AAAA',
  created_at: Date.now(),
});
