import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileBody } from '../views/profile/ProfileBody.jsx';

const ME = '@alice:home.example';
const THEM = '@bob:home.example';
const CAROL = '@carol:home.example';

const { holder, modal } = vi.hoisted(() => ({
  holder: { store: null },
  modal: { open: vi.fn() },
}));

vi.mock('../hooks/useStore.jsx', () => ({
  useStore: () => holder.store,
  useOptionalStore: () => holder.store,
  useStoreEvent: () => {},
  useStoreEventFor: () => {},
}));
vi.mock('../hooks/useVoice.jsx', () => ({
  useVoice: () => ({ channelId: null, join: vi.fn(), leave: vi.fn() }),
}));
vi.mock('../hooks/useModal.jsx', () => ({ useModal: () => modal }));
vi.mock('../hooks/useProfileCard.js', () => ({ useProfileCard: () => ({ open: vi.fn() }) }));

const GUILDS = [
  { id: 'guild-1', name: 'Allotment', domain: 'guild.example' },
  { id: 'guild-2', name: 'Bookbinding', domain: 'guild.example' },
];

function settledStore({ mutuals, trust, bot = false } = {}) {
  return {
    me: { user_id: ME },
    prefs: { presence: 'online', status: {}, muted: {}, collapsed: {} },
    guilds: new Map(GUILDS.map((g) => [g.id, g])),
    members: new Map([['guild-1', new Map()]]),
    channels: new Map(),
    conversations: [],
    friends: new Map(),
    presence: new Map(),
    voice: new Map(),
    identityOf: (id) => ({ user_id: id, display_name: 'Bob', is_bot: bot }),
    peerProfile: () => null,
    apiForGuild: () => ({ base: 'https://guild.example', domain: 'guild.example' }),
    ensureProfile: vi.fn(),
    ensureFullProfile: vi.fn(),
    loadRoles: vi.fn(() => new Promise(() => {})),
    guildPermissions: () => 0,
    myMember: () => null,
    roles: new Map(),
    roleName: (_guildId, id) => id,
    dmWith: () => null,
    statusOf: () => null,
    navigate: vi.fn(),
    channelsOf: () => [],
    ensureMutuals: vi.fn(() => new Promise(() => {})),
    mutualsFor: () => mutuals || null,
    on: () => () => {},
    trust,
  };
}

const openPopover = (store, userId = THEM) => {
  holder.store = store;
  return render(
    <ProfileBody guildId="guild-1" userId={userId} close={() => {}} surface="popover" />,
  );
};

const settledTrust = (over = {}) => ({
  peers: new Map(),
  signed: new Map(),
  statusFor: () => 'unverified',
  requestFor: () => null,
  refresh: () => new Promise(() => {}),
  ...over,
});

describe('the verification mark', () => {
  it('draws a verdict from what Trust holds, without waiting for a refresh', () => {
    const store = settledStore({
      trust: settledTrust({
        peers: new Map([[THEM, {
          identityKey: 'key-b', continuityValid: true, continuityRejected: false,
          immutableId: null, continuity: null,
          devices: new Map([['dev-1', { device_id: 'dev-1', ok: true }]]),
        }]]),
        signed: new Map([[THEM, { subject_key: 'key-b', signed_at: 1_700_000_000_000 }]]),
        statusFor: () => 'verified',
      }),
    });

    openPopover(store);

    const mark = screen.getByRole('img', { name: 'Verified' });
    expect(mark.getAttribute('title')).toContain('1 of their device');
  });

  it('draws nothing beside a stranger, and keeps verifying in the menu', async () => {
    const store = settledStore({ trust: settledTrust() });
    const user = userEvent.setup();

    openPopover(store);

    expect(screen.queryByRole('button', { name: /Verif/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /Verif/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Verify Bob' })).toBeTruthy();
  });

  it('reports an ask that is already out instead of offering to ask again', async () => {
    const asked = Date.now() - 20 * 60 * 1000;
    const store = settledStore({
      trust: settledTrust({
        requestFor: () => ({ requested_at: asked, may_ask_again_at: asked + 3_600_000 }),
      }),
    });

    const user = userEvent.setup();
    openPopover(store);

    expect(screen.queryByRole('button', { name: /Verify/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: 'Verification requested' });
    expect(screen.queryByRole('menuitem', { name: /^Verify/ })).toBeNull();
    expect(item.getAttribute('title')).toContain('have not answered yet');
    expect(item.getAttribute('title')).toContain('ask again');
  });

  it('has nothing to say about a bot, and says nothing', () => {
    const store = settledStore({ bot: true, trust: settledTrust() });

    openPopover(store);

    expect(screen.queryByRole('button', { name: /Verif/ })).toBeNull();
    expect(screen.queryByRole('img', { name: /Verif/ })).toBeNull();
    expect(screen.getByText('BOT')).toBeTruthy();
  });
});

describe('the mutual chips', () => {
  const mutuals = {
    friends: {
      friends: [{ user_id: CAROL, display_name: 'Carol', avatar_ref: null }],
      complete: true,
    },
    guilds: { guilds: GUILDS, complete: true },
  };

  it('draws both counts from the store on the frame the card opens', () => {
    const store = settledStore({ mutuals, trust: null });

    openPopover(store);

    expect(screen.getByText('1 mutual friend')).toBeTruthy();
    expect(screen.getByText('2 mutual servers')).toBeTruthy();
  });

  it('gives the servers a way in of their own', () => {
    const store = settledStore({ mutuals, trust: null });
    modal.open.mockClear();

    openPopover(store);

    screen.getByRole('button', { name: '2 mutual servers' }).click();
    expect(modal.open).toHaveBeenCalledTimes(1);
    const card = modal.open.mock.calls[0][0](() => {});
    expect(card.props.initialTab).toBe('guilds');
  });

  it('still sends the friends chip to the friends', () => {
    const store = settledStore({ mutuals, trust: null });
    modal.open.mockClear();

    openPopover(store);

    screen.getByRole('button', { name: '1 mutual friend' }).click();
    const card = modal.open.mock.calls[0][0](() => {});
    expect(card.props.initialTab).toBe('friends');
  });

  it('leaves out the half there is nothing to say about', () => {
    const store = settledStore({
      mutuals: { friends: { friends: [], complete: true }, guilds: mutuals.guilds },
      trust: null,
    });

    openPopover(store);

    expect(screen.queryByRole('button', { name: /mutual friend/i })).toBeNull();
    expect(screen.getByRole('button', { name: '2 mutual servers' })).toBeTruthy();
  });

  describe('on a first look at somebody', () => {
    it('keeps the space the answer will need', () => {
      const { container } = openPopover(settledStore({ trust: null }));

      const slot = container.querySelector('.pc__mutuals[data-reserved]');
      expect(slot).toBeTruthy();
      expect(slot.querySelector('.pc__mutual-text')).toBeTruthy();
      expect(slot.getAttribute('aria-hidden')).toBe('true');
      expect(screen.queryByRole('button', { name: /Mutual/ })).toBeNull();
    });

    it('reserves nothing when the card already knows there is nothing', () => {
      const { container } = openPopover(settledStore({
        mutuals: { friends: { friends: [], complete: true }, guilds: { guilds: [], complete: true } },
        trust: null,
      }));

      expect(container.querySelector('.pc__mutuals[data-reserved]')).toBeNull();
    });
  });
});
