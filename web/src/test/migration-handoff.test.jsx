import { useEffect, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider, useModal } from '../hooks/useModal.jsx';
import { Store } from '../lib/store.js';
import { Api } from '../lib/api.js';
import { accountOf, rememberSession } from '../lib/accounts.js';
import { SESSION_KEY } from '../lib/store/shared.js';
import { b64url } from '../lib/util.js';
import {
  captureHandoff, clearHandoff, handoffLink, parseHandoff, pendingHandoff,
} from '../lib/handoff.js';
import { MigrationDialog } from '../views/user-settings/MigrationDialog.jsx';
import { ReceiveMigrationDialog } from '../views/user-settings/ReceiveMigrationDialog.jsx';
import { MigrationDestinationGate } from '../views/MigrationDestinationGate.jsx';

const HANDOFF = {
  id: '01JABCDEFGHJKMNPQRSTVWXYZ0',
  secret: 'abcdefghijklmnopqrstuvwxyz012345',
  source: 'old.example',
  source_id: '@alice:old.example',
  destination: 'new.example',
};
const fragment = (over = {}) => {
  const h = { ...HANDOFF, ...over };
  return '#' + new URLSearchParams({ h: h.id, s: h.secret, from: h.source, id: h.source_id, to: h.destination });
};
const GUILD = {
  ...HANDOFF,
  source_id: '01JGUILD00000000000000MOVE',
  subject_type: 'guild',
  name: 'Movers',
};
const guildFragment = (over = {}) => {
  const h = { ...GUILD, ...over };
  return '#' + new URLSearchParams({
    h: h.id, s: h.secret, from: h.source, id: h.source_id, to: h.destination, k: 'guild', n: h.name,
  });
};

afterEach(() => clearHandoff());

function OnMount({ ui }) {
  const modal = useModal();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open(() => ui);
  }, [modal, ui]);
  return null;
}

function mount(store, ui) {
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <OnMount ui={ui} />
        <ModalHost />
      </ModalProvider>
    </StoreProvider>,
  );
}

describe('the guided-move link', () => {
  it('reads a well-formed link', () => {
    expect(parseHandoff(fragment())).toEqual(HANDOFF);
  });

  it('refuses a link that disagrees with itself or names something that is not a server', () => {
    expect(parseHandoff(fragment({ source_id: '@alice:elsewhere.example' }))).toBe(null);
    expect(parseHandoff(fragment({ destination: 'evil.example/phish' }))).toBe(null);
    expect(parseHandoff(fragment({ destination: 'old.example' }))).toBe(null);
    expect(parseHandoff(fragment({ secret: 'short' }))).toBe(null);
    expect(parseHandoff('')).toBe(null);
  });

  it('reads a guild link, which names the guild by id and its name only as a label', () => {
    expect(parseHandoff(guildFragment())).toEqual(GUILD);
    expect(parseHandoff(guildFragment({ source_id: '@alice:old.example' }))).toBe(null);
    expect(parseHandoff(guildFragment({ source_id: '../../etc' }))).toBe(null);
    expect(parseHandoff(guildFragment({ name: 'x'.repeat(500) })).name).toHaveLength(100);
    expect(parseHandoff(fragment({ source_id: GUILD.source_id }))).toBe(null);

    const link = handoffLink('https://chat.new.example', GUILD);
    expect(parseHandoff(new URL(link).hash)).toEqual(GUILD);
  });

  it('is built only on an http(s) address the destination published', () => {
    const link = handoffLink('https://chat.new.example/', HANDOFF);
    expect(link.startsWith('https://chat.new.example/receive-move#')).toBe(true);
    expect(parseHandoff(new URL(link).hash)).toEqual(HANDOFF);
    expect(() => handoffLink('javascript:alert(1)', HANDOFF)).toThrow();
    expect(() => handoffLink('not a url', HANDOFF)).toThrow();
  });

  it('is taken out of the address bar before anything routes on it, and kept for this tab', () => {
    const win = {
      location: { pathname: '/receive-move', hash: fragment() },
      history: { replaceState: vi.fn() },
      sessionStorage,
    };
    expect(captureHandoff(win)).toEqual(HANDOFF);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/receive-move');
    expect(pendingHandoff()).toMatchObject(HANDOFF);

    clearHandoff();
    const slashed = { ...win, location: { pathname: '/receive-move/', hash: fragment() }, history: { replaceState: vi.fn() } };
    expect(captureHandoff(slashed)).toEqual(HANDOFF);
    expect(slashed.history.replaceState).toHaveBeenCalledWith(null, '', '/receive-move');
    expect(pendingHandoff()).toMatchObject(HANDOFF);

    clearHandoff();
    const elsewhere = { ...win, location: { pathname: '/channels/x', hash: fragment() }, history: { replaceState: vi.fn() } };
    expect(captureHandoff(elsewhere)).toBe(null);
    expect(elsewhere.history.replaceState).not.toHaveBeenCalled();
    expect(pendingHandoff()).toBe(null);

    const broken = { ...win, location: { pathname: '/receive-move', hash: '#h=x' }, history: { replaceState: vi.fn() } };
    expect(captureHandoff(broken)).toBe(null);
    expect(broken.history.replaceState).toHaveBeenCalled();
    expect(pendingHandoff()).toBe(null);
  });
});

describe('receiving a guided move', () => {
  function destinationStore(domain) {
    const store = new Store();
    store.session = { home: { user_id: `@alice2:${domain}`, device_id: 'd1', domain } };
    store.home = {
      domain,
      acceptMigration: vi.fn(async (body) => ({ delivered: true, target_id: `@alice2:${domain}`, source: body.source })),
    };
    return store;
  }

  it('asks before sending anything, then sends the handoff and no code', async () => {
    const store = destinationStore('new.example');
    mount(store, <ReceiveMigrationDialog handoff={HANDOFF} close={() => {}} />);

    expect(screen.getByText(/Move @alice:old.example into @alice2:new.example/)).toBeTruthy();
    expect(store.home.acceptMigration).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Receive this account' }));
    expect(store.home.acceptMigration).toHaveBeenCalledWith({
      subject_type: 'user',
      source: 'old.example',
      source_id: '@alice:old.example',
      handoff: { id: HANDOFF.id, secret: HANDOFF.secret },
    });
    await waitFor(() => expect(screen.getByText(/has been told this account is ready/)).toBeTruthy());
    expect(screen.queryByText(/Import code/)).toBe(null);
  });

  it('receives a guild into the account signed in here', async () => {
    const store = destinationStore('new.example');
    mount(store, <ReceiveMigrationDialog handoff={GUILD} close={() => {}} />);

    expect(screen.getByText(/Receive the guild “Movers” \(01JGUILD00000000000000MOVE\) from old.example/)).toBeTruthy();
    expect(screen.getByText(/It would be owned here by @alice2:new.example/)).toBeTruthy();
    expect(store.home.acceptMigration).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Receive this guild' }));
    expect(store.home.acceptMigration).toHaveBeenCalledWith({
      subject_type: 'guild',
      source: 'old.example',
      source_id: GUILD.source_id,
      handoff: { id: GUILD.id, secret: GUILD.secret },
    });
    await waitFor(() => expect(screen.getByText(/has been told this guild is ready/)).toBeTruthy());
    expect(screen.getByText(/as the guild’s new owner/)).toBeTruthy();
  });

  it('will not accept a link meant for another server', async () => {
    const store = destinationStore('other.example');
    mount(store, <ReceiveMigrationDialog handoff={HANDOFF} close={() => {}} />);

    expect(screen.getByText(/This link is for moving an account to new.example/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Receive this account' })).toBe(null);
    expect(store.home.acceptMigration).not.toHaveBeenCalled();
  });
});

describe('starting a guided move', () => {
  function sourceStore(states) {
    const store = new Store();
    store.session = {
      home: {
        user_id: '@alice:old.example', device_id: 'd1', domain: 'old.example',
        device_secret: b64url(new Uint8Array(32).fill(7)),
      },
    };
    const polls = [...states];
    store.home = {
      domain: 'old.example',
      openMigrationHandoff: vi.fn(async (destination) => ({
        ...HANDOFF, destination, expires_at: Date.now() + 1_800_000,
      })),
      migrationHandoff: vi.fn(async () => polls.length > 1 ? polls.shift() : polls[0]),
      post: vi.fn(async () => ({ payload: b64url(new Uint8Array([1, 2, 3])), created_at: 42, device_id: 'd1' })),
      startMigration: vi.fn(async (body) => ({
        id: 'm1', state: 'pending', destination: body.destination, executes_at: Date.now() + 86_400_000,
      })),
    };
    store.reauthProof = vi.fn(async (password) => ({ password }));
    return store;
  }

  it('sends the person to the page the destination publishes and authorizes over the delivered handoff', async () => {
    const store = sourceStore([
      { id: HANDOFF.id, state: 'waiting' },
      { id: HANDOFF.id, state: 'delivered', target_id: '@alice2:new.example' },
    ]);
    const discoverServer = vi.fn(async () => ({ server_name: 'new.example', client: 'https://chat.new.example' }));
    const openWindow = vi.fn();
    const user = userEvent.setup();
    mount(store, (
      <MigrationDialog close={() => {}} discoverServer={discoverServer} openWindow={openWindow} pollMs={10} />
    ));

    await user.type(screen.getByPlaceholderText('newhome.example.org'), 'new.example');
    await user.click(screen.getByRole('button', { name: 'Continue on the new server' }));

    expect(discoverServer).toHaveBeenCalledWith('new.example');
    expect(store.home.openMigrationHandoff).toHaveBeenCalledWith('new.example');
    const [url] = openWindow.mock.calls[0];
    expect(url.startsWith('https://chat.new.example/receive-move#')).toBe(true);
    expect(parseHandoff(new URL(url).hash)).toEqual(HANDOFF);

    await waitFor(() => expect(screen.getByText('@alice2:new.example')).toBeTruthy());
    await user.type(screen.getByLabelText(/Your password on this server/), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Schedule the move' }));

    await waitFor(() => expect(store.home.startMigration).toHaveBeenCalled());
    const grantBody = store.home.post.mock.calls[0][1];
    expect(grantBody).toEqual({ subject_type: 'user', destination: 'new.example', handoff_id: HANDOFF.id });
    const started = store.home.startMigration.mock.calls[0][0];
    expect(started).toMatchObject({ handoff_id: HANDOFF.id, password: 'correct horse', created_at: 42 });
    expect(started.import_token).toBeUndefined();
    expect(typeof started.device_signature).toBe('string');
    await waitFor(() => expect(screen.getByText(/The move is scheduled/)).toBeTruthy());
  });

  it('falls back to the import code when the destination publishes no page', async () => {
    const store = sourceStore([{ state: 'waiting' }]);
    const discoverServer = vi.fn(async () => ({ server_name: 'new.example', client: null }));
    const openWindow = vi.fn();
    const user = userEvent.setup();
    mount(store, (
      <MigrationDialog close={() => {}} discoverServer={discoverServer} openWindow={openWindow} pollMs={10} />
    ));

    await user.type(screen.getByPlaceholderText('newhome.example.org'), 'new.example');
    await user.click(screen.getByRole('button', { name: 'Continue on the new server' }));

    await waitFor(() => expect(screen.getByText(/does not publish a web page/)).toBeTruthy());
    expect(store.home.openMigrationHandoff).not.toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'Use an import code' })[0]);
    expect(screen.getByPlaceholderText('one-time code from the destination')).toBeTruthy();
  });

  it('moves a guild the same way, naming the guild and its new owner', async () => {
    const store = sourceStore([
      { id: GUILD.id, state: 'waiting' },
      { id: GUILD.id, state: 'delivered', target_id: '@owner:new.example' },
    ]);
    store.home.openMigrationHandoff = vi.fn(async (destination, subject) => ({
      id: GUILD.id, secret: GUILD.secret, source: 'old.example', destination,
      subject_type: subject.subject_type, source_id: subject.subject_id, expires_at: Date.now() + 1_800_000,
    }));
    const discoverServer = vi.fn(async () => ({ server_name: 'new.example', client: 'https://chat.new.example' }));
    const openWindow = vi.fn();
    const user = userEvent.setup();
    mount(store, (
      <MigrationDialog
        subjectType="guild"
        subjectId={GUILD.source_id}
        subjectName="Movers"
        close={() => {}}
        discoverServer={discoverServer}
        openWindow={openWindow}
        pollMs={10}
      />
    ));

    expect(screen.getByText(/moving this guild/)).toBeTruthy();
    await user.type(screen.getByPlaceholderText('newhome.example.org'), 'new.example');
    await user.click(screen.getByRole('button', { name: 'Continue on the new server' }));

    expect(await screen.findByText(/the account that will own the guild there/)).toBeTruthy();
    expect(store.home.openMigrationHandoff).toHaveBeenCalledWith(
      'new.example', { subject_type: 'guild', subject_id: GUILD.source_id },
    );
    const [url] = openWindow.mock.calls[0];
    expect(parseHandoff(new URL(url).hash)).toEqual(GUILD);

    await waitFor(() => expect(screen.getByText('@owner:new.example')).toBeTruthy());
    expect(screen.getByText(/This guild, Movers, will move to new.example, owned there by/)).toBeTruthy();
    await user.type(screen.getByLabelText(/Your password on this server/), 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Schedule the move' }));

    await waitFor(() => expect(store.home.startMigration).toHaveBeenCalled());
    expect(store.home.post.mock.calls[0][1]).toEqual({
      subject_type: 'guild', subject_id: GUILD.source_id, destination: 'new.example', handoff_id: GUILD.id,
    });
    const started = store.home.startMigration.mock.calls[0][0];
    expect(started).toMatchObject({
      subject_type: 'guild', subject_id: GUILD.source_id, handoff_id: GUILD.id, password: 'correct horse',
    });
    expect(started.import_token).toBeUndefined();
    await waitFor(() => expect(screen.getByText(/The move is scheduled/)).toBeTruthy());
  });

  it('uses the centralized portal when a homeserver does not advertise its own web client', async () => {
    const marker = document.createElement('meta');
    marker.name = 'telium-portal';
    marker.content = '1';
    document.head.append(marker);
    try {
      const store = sourceStore([{ state: 'waiting' }]);
      const discoverServer = vi.fn(async () => ({ server_name: 'new.example', client: null }));
      const openWindow = vi.fn();
      mount(store, (
        <MigrationDialog close={() => {}} discoverServer={discoverServer} openWindow={openWindow} pollMs={10} />
      ));
      const user = userEvent.setup();
      await user.type(screen.getByPlaceholderText('newhome.example.org'), 'new.example');
      await user.click(screen.getByRole('button', { name: 'Continue on the new server' }));

      await waitFor(() => expect(openWindow).toHaveBeenCalledTimes(1));
      const [url] = openWindow.mock.calls[0];
      expect(new URL(url).origin).toBe(window.location.origin);
      expect(parseHandoff(new URL(url).hash)).toEqual(HANDOFF);
      expect(store.home.openMigrationHandoff).toHaveBeenCalledWith('new.example');
    } finally {
      marker.remove();
    }
  });

  it('keeps the code for guilds behind the guided move', async () => {
    const store = sourceStore([{ state: 'waiting' }]);
    const user = userEvent.setup();
    mount(store, <MigrationDialog subjectType="guild" subjectId="g1" close={() => {}} />);
    expect(screen.getByRole('button', { name: 'Continue on the new server' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Use an import code' }));
    expect(screen.getByPlaceholderText('one-time code from the destination')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use the guided move' })).toBeTruthy();
  });
});

describe('migration handoffs on the centralized Telium website', () => {
  const sourceSession = () => ({
    home: { base: 'https://old.example', domain: 'old.example',
      token: 'source-session', user_id: '@alice:old.example', device_id: 'source-device' },
    servers: {},
  });
  const destSession = () => ({
    home: { base: 'https://new.example', domain: 'new.example',
      token: 'dest-session', user_id: '@target:new.example', device_id: 'dest-device' },
    servers: {},
  });
  const createdStores = [];
  function sourceStore() {
    const store = new Store();
    createdStores.push(store);
    store.session = sourceSession();
    return store;
  }
  function prepare() {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sourceSession()));
    sessionStorage.setItem('telium.pending-handoff.v1', JSON.stringify({ ...HANDOFF, at: Date.now() }));
  }
  afterEach(() => {
    for (const store of createdStores.splice(0)) store.dispose();
    vi.restoreAllMocks();
  });

  it('intercepts handoff before booting the active source account', async () => {
    prepare();
    const store = sourceStore();
    store.start = vi.fn(async () => { throw new Error('source booted in receiver'); });
    render(<App store={store} />);
    expect(await screen.findByRole('heading', { name: 'Continue the move on new.example' })).toBeTruthy();
    expect(screen.getByText(/This move comes from old.example/)).toBeTruthy();
    expect(store.start).not.toHaveBeenCalled();
    expect(pendingHandoff()).toMatchObject(HANDOFF);
  });

  it('confirms on destination token and never switches the browser-wide source session', async () => {
    prepare();
    rememberSession(destSession());
    const store = sourceStore();
    const switched = vi.spyOn(store, 'switchAccount');
    const added = vi.spyOn(store, 'addAccount');
    const accepted = vi.spyOn(Api.prototype, 'acceptMigration').mockResolvedValue({
      delivered: true, target_id: '@target:new.example',
    });
    mount(store, <MigrationDestinationGate handoff={HANDOFF} onSignIn={() => {}} onCancel={() => {}} />);
    expect(accepted).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Continue as @alice:old.example' })).toBe(null);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue as @target:new.example' }));
    expect(accepted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Receive this account' }));
    await waitFor(() => expect(screen.getByText(/Destination confirmed/)).toBeTruthy());
    expect(accepted).toHaveBeenCalledWith({
      subject_type: 'user', source: 'old.example', source_id: '@alice:old.example',
      handoff: { id: HANDOFF.id, secret: HANDOFF.secret },
    });
    expect(accepted.mock.instances[0].token).toBe('dest-session');
    expect(accepted.mock.instances[0].base).toBe('https://new.example');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
    expect(switched).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    expect(pendingHandoff()).toBeNull();
  });

  it('refuses a receipt that names a different destination account', async () => {
    prepare();
    rememberSession(destSession());
    const accepted = vi.spyOn(Api.prototype, 'acceptMigration').mockResolvedValue({
      delivered: true, target_id: '@someone-else:new.example',
    });
    mount(sourceStore(), <MigrationDestinationGate handoff={HANDOFF} onSignIn={() => {}} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue as @target:new.example' }));
    await user.click(screen.getByRole('button', { name: 'Receive this account' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/different target account/));
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(pendingHandoff()).toMatchObject(HANDOFF);
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
  });

  it('offers sign-in without calling addAccount or switchAccount', async () => {
    prepare();
    const store = sourceStore();
    const openLogin = vi.fn();
    const added = vi.spyOn(store, 'addAccount');
    const switched = vi.spyOn(store, 'switchAccount');
    mount(store, <MigrationDestinationGate handoff={HANDOFF} onSignIn={openLogin} onCancel={() => {}} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in or create an account on new.example' }));
    expect(openLogin).toHaveBeenCalledOnce();
    expect(added).not.toHaveBeenCalled();
    expect(switched).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
  });

  it('authenticates the destination without overwriting the source session', async () => {
    prepare();
    vi.spyOn(Api.prototype, 'capabilities').mockResolvedValue({ auth: { opaque: false } });
    vi.spyOn(Api, 'login').mockResolvedValue({
      server_name: 'new.example', user_id: '@target:new.example',
      access_token: 'fresh-dest-token', device_id: 'device2',
    });
    const store = sourceStore();
    await store.signIn('https://new.example', 'target', 'password', {
      allowLegacyAuth: true, handoffOnly: true, handoffDestination: 'new.example',
    });
    expect(accountOf('@target:new.example').session.home.token).toBe('fresh-dest-token');
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
  });

  it('rejects a login to the wrong destination without persisting it', async () => {
    prepare();
    vi.spyOn(Api.prototype, 'capabilities').mockResolvedValue({ auth: { opaque: false } });
    vi.spyOn(Api, 'login').mockResolvedValue({
      server_name: 'wrong.example', user_id: '@target:wrong.example',
      access_token: 'wrong-token', device_id: 'device2',
    });
    await expect(sourceStore().signIn('https://wrong.example', 'target', 'password', {
      allowLegacyAuth: true, handoffOnly: true, handoffDestination: 'new.example',
    })).rejects.toThrow(/not on the destination/);
    expect(accountOf('@target:wrong.example')).toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
  });

  it('confirms guild ownership without presenting account-vault migration copy', async () => {
    prepare();
    rememberSession(destSession());
    const accepted = vi.spyOn(Api.prototype, 'acceptMigration').mockResolvedValue({
      delivered: true, target_id: '@target:new.example',
    });
    mount(sourceStore(), <MigrationDestinationGate handoff={GUILD} onSignIn={() => {}} onCancel={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue as @target:new.example' }));
    expect(screen.getByText(/Receive guild/)).toBeTruthy();
    expect(screen.queryByText(/encrypted key-vault data/)).toBe(null);
    await user.click(screen.getByRole('button', { name: 'Receive this guild' }));
    await waitFor(() => expect(screen.getByText(/Destination confirmed/)).toBeTruthy());
    expect(accepted).toHaveBeenCalledWith({
      subject_type: 'guild', source: GUILD.source, source_id: GUILD.source_id,
      handoff: { id: GUILD.id, secret: GUILD.secret },
    });
    expect(JSON.parse(localStorage.getItem(SESSION_KEY))).toEqual(sourceSession());
  });

  it('will not create a sixth remembered account', () => {
    const store = sourceStore();
    store.accounts = vi.fn(() => Array.from({ length: 5 }, (_, i) => ({
      user_id: '@user' + i + ':old.example', session: sourceSession(),
    })));
    mount(store, <MigrationDestinationGate handoff={HANDOFF} onSignIn={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('button', { name: 'Sign in or create an account on new.example' }).disabled).toBe(true);
  });
});
