import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MenuItem, MenuSeparator } from '../components/index.js';
import {
  MobileActionSheet, MobileProfileSheet, MobileSheet, MobileTopbar, MobileTopbarButton, MobileVoicePill, mobileBackAction,
} from '../views/mobile/MobileNavigation.jsx';

const { store, voice } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example' },
    channels: new Map([['voice-1', { name: 'general-voice', guild_id: 'guild-1' }]]),
    conversations: [],
    home: { base: 'https://home.example', domain: 'home.example' },
    prefs: { presence: 'online', status: {}, muted: {}, collapsed: {} },
    guilds: new Map([['guild-1', { id: 'guild-1', name: 'Example', domain: 'guild.example' }]]),
    members: new Map([['guild-1', new Map()]]),
    voice: new Map(),
    friends: new Map(),
    presence: new Map(),
    identityOf: (id) => (id === '@bob:home.example'
      ? {
        user_id: id,
        display_name: 'Bob',
        banner_ref: 'bob-banner?cap=cap-1',
        bio: 'Mobile profile bio',
      }
      : null),
    peerProfile: () => null,
    colourFor: () => null,
    apiForGuild: () => ({ base: 'https://guild.example', domain: 'guild.example' }),
    ensureProfile: vi.fn(),
    ensureFullProfile: vi.fn(),
    loadRoles: vi.fn(() => Promise.resolve()),
    openOrCreateDM: vi.fn(),
    guildPermissions: () => 0,
    myMember: () => null,
    roles: new Map(),
    roleName: (_guildId, id) => id,
    dmWith: () => null,
    statusOf: () => null,
    ensureMutuals: () => Promise.resolve(null),
    mutualsFor: () => null,
    on: () => () => {},
  },
  voice: {
    active: true,
    channelId: 'voice-1',
    phase: 'connected',
    joinedAt: Date.now() - 65000,
    local: { self_mute: false, self_deaf: false },
    toggle: vi.fn(),
    leave: vi.fn(),
  },
}));

vi.mock('../hooks/useStore.jsx', () => ({
  useStore: () => store,
  useOptionalStore: () => store,
  useStoreEvent: () => {},
  useStoreEventFor: () => {},
}));
vi.mock('../hooks/useVoice.jsx', () => ({ useVoice: () => voice }));
vi.mock('../hooks/useModal.jsx', () => ({ useModal: () => ({ open: vi.fn(), close: vi.fn() }) }));
vi.mock('../hooks/useProfileCard.js', () => ({
  useProfileCard: () => ({ open: vi.fn(), close: vi.fn() }),
  useOpenProfile: () => null,
}));

describe('mobile navigation primitives', () => {
  it('keeps Discord-style compact headers keyboard and touch accessible', () => {
    const menu = vi.fn();
    const members = vi.fn();
    const more = vi.fn();
    render(
      <MobileTopbar
        title="#general"
        subtitle="Example server"
        onMenu={menu}
        onMembers={members}
        onMore={more}
      />,
    );

    expect(screen.getByRole('heading', { name: '#general' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open server and channel menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show server members' }));
    fireEvent.click(screen.getByRole('button', { name: 'More options' }));
    expect(menu).toHaveBeenCalledOnce();
    expect(members).toHaveBeenCalledOnce();
    expect(more).toHaveBeenCalledOnce();
  });

  it('gives disabled mobile actions a real disabled state', () => {
    render(<MobileTopbarButton label="Unavailable" onClick={() => {}} disabled>
      <span>Action</span>
    </MobileTopbarButton>);
    expect(screen.getByRole('button', { name: 'Unavailable' }).disabled).toBe(true);
  });

  it('closes a full-screen sheet from either its close button or scrim', () => {
    const close = vi.fn();
    render(
      <MobileSheet title="Channels" onClose={close}>
        <p>general</p>
      </MobileSheet>,
    );
    expect(screen.getByRole('dialog', { name: 'Channels' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Channels' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Channels' })[1]);
    window.dispatchEvent(new Event('androidback'));
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('renders nested desktop menu fragments in a mobile action sheet', () => {
    render(
      <MobileActionSheet title="Actions" onClose={() => {}}>
        <>
          <MenuItem onAction={() => {}}>First action</MenuItem>
          <MenuSeparator />
          <>
            <MenuItem onAction={() => {}}>Second action</MenuItem>
          </>
        </>
      </MobileActionSheet>,
    );

    expect(screen.getByRole('button', { name: 'First action' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Second action' })).toBeTruthy();
  });

  it('renders the real banner in the quick mobile profile sheet', () => {
    const close = vi.fn();
    render(
      <MobileProfileSheet
        userId="@bob:home.example"
        guildId="guild-1"
        close={close}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Bob' });
    const banner = [...dialog.querySelectorAll('img')]
      .find((img) => img.getAttribute('src')?.includes('bob-banner'));
    expect(banner?.getAttribute('src')).toBe(
      'https://guild.example/_telium/v1/media/remote/home.example/bob-banner?cap=cap-1',
    );
    expect(store.ensureFullProfile).toHaveBeenCalledWith('@bob:home.example');
  });

  it('renders persistent voice pill and handles mute/disconnect', () => {
    const expand = vi.fn();
    render(<MobileVoicePill onExpand={expand} />);

    expect(screen.getByText(/Voice Connected/i)).toBeTruthy();
    expect(screen.getByText('#general-voice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(voice.toggle).toHaveBeenCalledWith('self_mute');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(voice.leave).toHaveBeenCalledOnce();
  });

  it('uses the Android back stack in voice stage, drawer, conversation, then exit order', () => {
    expect(mobileBackAction({ voiceStageOpen: true })).toBe('close-voice');
    expect(mobileBackAction({ membersOpen: true })).toBe('close-members');
    expect(mobileBackAction({ drawerOpen: true })).toBe('close-drawer');
    expect(mobileBackAction({ route: { view: 'dms', conversationId: 'dm-1' } })).toBe('dm-list');
    expect(mobileBackAction({ route: { view: 'dms', conversationId: null } })).toBe('exit');
  });
});
