import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { VoiceView } from '../views/VoiceView.jsx';
import { useMenus } from '../views/menus.jsx';
import { MenuButton } from '../components/index.js';
import { GUILD_DOMAIN, ME, mount, signedInStore } from './harness.jsx';

const OWNER = '18446744073709551615';
const BOB = '@bob:guilds.example';
const CARA = '@cara:guilds.example';
const DEV = '@dev:guilds.example';

function room({ name = 'lounge', voice_states = [] } = {}) {
  return {
    id: 'g1',
    name: 'Telium',
    domain: GUILD_DOMAIN,
    channels: [{ id: 'c-lounge', name, type: 'voice', position: 0, parent_id: null }],
    roles: [{ id: 'g1', name: '@everyone', permissions: '0' }],
    me: { user_id: ME, roles: [], permissions: OWNER },
    voice_states: voice_states.map((v) => ({ channel_id: 'c-lounge', ...v })),
  };
}

const open = (over = {}) => signedInStore({
  guilds: [room(over)],
  route: { view: 'voice', guildId: 'g1', channelId: 'c-lounge' },
});

const header = (name = /lounge/) => screen.findByRole('heading', { name });

const tile = (userId) => document.querySelector(`[data-user="${userId}"]`);

describe('a guild voice room', () => {
  it('names the channel at the top of the screen', async () => {
    const store = open({ name: '🔊 lounge' });
    mount(<VoiceView channelId="c-lounge" />, store);

    const heading = await header();
    expect(within(heading).getByRole('img', { name: '🔊' })).toBeTruthy();
    expect(heading.textContent).toContain('lounge');
  });

  it('counts the room in the header roster', async () => {
    const store = open({ voice_states: [{ user_id: BOB }, { user_id: CARA }] });
    mount(<VoiceView channelId="c-lounge" />, store);

    expect(await screen.findByLabelText('2 in voice')).toBeTruthy();
  });

  it('draws a tile for everybody in the room, whether or not this tab is in it', async () => {
    const store = open({ voice_states: [{ user_id: BOB }, { user_id: CARA }] });
    mount(<VoiceView channelId="c-lounge" />, store);

    await header();
    expect(within(tile(BOB)).getByText('bob')).toBeTruthy();
    expect(within(tile(CARA)).getByText('cara')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBe(null);
  });

  it('says in words whether somebody can speak and hear', async () => {
    const store = open({
      voice_states: [
        { user_id: BOB },
        { user_id: CARA, self_mute: true },
        { user_id: DEV, server_deaf: true, server_mute: true },
      ],
    });
    mount(<VoiceView channelId="c-lounge" />, store);
    await header();

    expect(within(tile(BOB)).queryByText('Muted')).toBe(null);
    expect(within(tile(BOB)).queryByText('Deafened')).toBe(null);
    expect(within(tile(CARA)).getByText('Muted')).toBeTruthy();
    expect(within(tile(DEV)).getByText('Deafened')).toBeTruthy();
  });

  it('offers the region picker only once somebody has picked a region', async () => {
    const store = open({ voice_states: [{ user_id: BOB }] });
    const { unmount } = mount(<VoiceView channelId="c-lounge" />, store);
    await header();
    expect(screen.queryByTitle('Voice region')).toBe(null);
    unmount();

    const chosen = signedInStore({
      guilds: [room({ voice_states: [{ user_id: BOB, channel_id: 'c-lounge' }] })],
      prefs: { voiceRegion: 'eu-west' },
      route: { view: 'voice', guildId: 'g1', channelId: 'c-lounge' },
    });
    mount(<VoiceView channelId="c-lounge" />, chosen);
    const pill = await screen.findByTitle('Voice region');
    expect(pill.textContent).toContain('eu-west');
  });

  it('carries the channel’s unread count on the way into its chat', async () => {
    const store = signedInStore({
      guilds: [room({ voice_states: [{ user_id: BOB }] })],
      unread: { 'c-lounge': { unread: 4, mentions: 2 } },
      route: { view: 'voice', guildId: 'g1', channelId: 'c-lounge' },
    });
    mount(<VoiceView channelId="c-lounge" />, store);

    const toggle = await screen.findByRole('button', { name: 'Open chat, 2 mentions' });
    expect(within(toggle).getByText('2')).toBeTruthy();
  });

  it('says the room is empty rather than drawing an empty room', async () => {
    const store = open();
    mount(<VoiceView channelId="c-lounge" />, store);

    expect(await screen.findByText('Nobody is here yet')).toBeTruthy();
    expect(screen.getByText('Join to open it.')).toBeTruthy();
    expect(await header()).toBeTruthy();
  });

  it('opens the chat straight away on an Open-chat navigation, without joining', async () => {
    const store = signedInStore({
      guilds: [room()],
      route: { view: 'voice', guildId: 'g1', channelId: 'c-lounge', chat: true },
    });
    mount(<VoiceView channelId="c-lounge" />, store);
    await header();

    expect(await screen.findByRole('button', { name: 'Close chat' })).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Call controls' })).toBe(null);
    expect(store.route.chat).toBe(undefined);
  });

  it('opens the room text from its menu without joining the call', async () => {
    function ChannelMenu({ channel }) {
      const menus = useMenus();
      return <MenuButton label="Menu" content={menus.channel(channel)}>Menu</MenuButton>;
    }
    const store = signedInStore({ guilds: [room()] });
    const { user } = mount(
      <ChannelMenu channel={store.channels.get('c-lounge')} />,
      store,
    );
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open chat' }));

    expect(store.route.view).toBe('voice');
    expect(store.route.channelId).toBe('c-lounge');
    expect(store.route.chat).toBe(true);
    expect(store.voice.get('c-lounge') || []).toHaveLength(0);
  });

  it('says so when the channel has gone out from under it', async () => {
    const store = signedInStore({
      guilds: [room()],
      route: { view: 'voice', guildId: 'g1', channelId: 'c-gone' },
    });
    mount(<VoiceView channelId="c-gone" />, store);

    expect(await screen.findByText('This voice channel is gone')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /lounge/ })).toBe(null);
    expect(screen.queryByRole('button', { name: 'Open chat' })).toBe(null);
  });
});
