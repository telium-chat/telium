import { expect } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App, AppProviders } from '../App.jsx';
import { ToastHost } from '../hooks/useToast.jsx';
import { classify } from '../lib/failure.js';
import { Status } from '../lib/gateway.js';
import { freshStore, HOME } from './fake-server.js';
import { signIn } from './sign-in.js';

export const ME = '@alice:home.example';
export const HOME_DOMAIN = 'home.example';
export const GUILD_DOMAIN = 'guilds.example';

function transport(status) {
  return {
    status,
    send: () => true,
    close: () => {},
    failure: () => (
      status === Status.Ready || status === Status.Closed ? null : classify()
    ),
  };
}

export function signedInStore({
  guilds = [],
  threads = {},
  conversations = [],
  friends = [],
  members = {},
  unread = {},
  dmUnread = {},
  presence = {},
  prefs = {},
  route = {},
  me = {},
  status = Status.Ready,
} = {}) {
  const store = freshStore();

  store.session = {
    home: {
      base: HOME, domain: HOME_DOMAIN, user_id: ME, token: 'harness',
    },
    servers: Object.fromEntries(guilds.map((guild) => {
      const domain = guild.domain || GUILD_DOMAIN;
      return [domain, { base: `https://${domain}`, domain, token: 'harness' }];
    })),
  };
  store.me = {
    user_id: ME,
    server_name: HOME_DOMAIN,
    profile: { display_name: 'Alice', avatar_ref: null },
    ...me,
  };

  Object.assign(store.prefs, prefs);

  store.route = { ...store.route, ...route };

  const domains = new Set(guilds.map((guild) => guild.domain || GUILD_DOMAIN));
  for (const domain of domains) store.gw.connections.set(domain, transport(status));
  for (const domain of domains) {
    store.onReady({
      domain,
      data: { d: { guilds: guilds.filter((guild) => (guild.domain || GUILD_DOMAIN) === domain) } },
    });
  }

  for (const [guildId, rows] of Object.entries(members)) {
    store.members.set(guildId, new Map(rows.map((row) => [row.user_id, row])));
  }
  for (const [parentId, rows] of Object.entries(threads)) store.threads.set(parentId, rows);
  for (const [channelId, state] of Object.entries(unread)) {
    store.readState.set(channelId, { unread: 0, mentions: 0, ...state });
  }
  for (const [conversationId, count] of Object.entries(dmUnread)) {
    store.dmUnread.set(conversationId, count);
  }
  for (const [userId, row] of Object.entries(presence)) store.presence.set(userId, row);

  store.conversations = conversations;
  store.friends = new Map(friends.map((friend) => [friend.user_id, friend]));
  store.friendsLoaded = true;

  return store;
}

export function mount(ui, store) {
  const user = userEvent.setup();
  const result = render(
    <AppProviders store={store}>
      {ui}
      <ToastHost />
    </AppProviders>,
  );
  return { user, store, ...result };
}

export async function signedInApp(server) {
  server.install();
  const store = freshStore();
  const user = userEvent.setup();
  render(<App store={store} />);
  await signIn(user, { home: HOME });
  await waitFor(() => expect(store.signedIn).toBe(true));
  return { store, user };
}
