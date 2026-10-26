import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalHost, ModalProvider } from '../hooks/useModal.jsx';
import { ToastHost } from '../hooks/useToast.jsx';
import { InviteLanding } from '../views/InviteLanding.jsx';
import { createFakeServer, freshStore, GUILD, HOME } from './fake-server.js';

const recommendedHomes = [
  {
    domain: 'home.example',
    api_origin: HOME,
    name: 'Community Home',
    region: 'na-west',
    region_label: 'Oregon, US',
    operator_name: 'Test Operator',
    operator_contact: 'https://home.example/about',
    uptime_30d: 100,
    weight: 1,
  },
];

function renderInvite(store, props = {}) {
  const loadHomeRecommendations = props.loadHomeRecommendations
    || vi.fn().mockResolvedValue({ servers: recommendedHomes, reason: null });
  return render(
    <StoreProvider store={store}>
      <ModalProvider>
        <InviteLanding
          code="INVITE1"
          base={GUILD}
          loadHomeRecommendations={loadHomeRecommendations}
          homeRandom={() => 0}
          {...props}
        />
        <ModalHost />
      </ModalProvider>
      <ToastHost />
    </StoreProvider>,
  );
}

describe('public invite onboarding', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_TELIUM_RECOMMENDATION_PUBLIC_KEY', 'test-pinned-recommendation-key');
    return () => vi.unstubAllEnvs();
  });

  it('shows the guild first while independently recommending an account home', async () => {
    const server = createFakeServer({ suggestAlternatives: true });
    server.install();
    const store = freshStore();
    renderInvite(store);

    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    expect(screen.getByText(/alice invited you to join/i)).toBeTruthy();
    expect(screen.getByText('1 online')).toBeTruthy();
    expect(screen.getByText('2 members')).toBeTruthy();

    expect(screen.getByLabelText('Display name')).toBeTruthy();
    expect(screen.getByLabelText('Username')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();

    const accountHome = screen.getByTestId('account-home-picker');
    expect(await within(accountHome).findByText('Community Home')).toBeTruthy();
    expect(within(accountHome).getByText('home.example')).toBeTruthy();
    expect(screen.getByText(/hosts this guild/).textContent).toContain('guilds.example');
    expect(screen.queryByLabelText('Home server')).toBeNull();
  });

  it('opens a portal link by discovering the server the link names', async () => {
    const server = createFakeServer({});
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    // No `base`: on the portal the link carries only a server name, and the page has to
    // discover the API from it. The preview must land on guilds.example regardless.
    renderInvite(store, { base: undefined, serverName: 'guilds.example' });

    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    expect(screen.getByText(/alice invited you to join/i)).toBeTruthy();

    await user.type(screen.getByLabelText('Display name'), 'New Person');
    await user.type(screen.getByLabelText('Username'), 'new');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account & join Telium' }));

    await waitFor(() => expect(server.state.joins).toContain('INVITE1'), { timeout: 15_000 });
    expect(store.route).toMatchObject({ view: 'chat', guildId: 'g1' });
  });

  it('refuses a bare code on the portal instead of guessing a server', async () => {
    const meta = document.createElement('meta');
    meta.name = 'telium-portal';
    meta.content = '1';
    document.head.appendChild(meta);
    try {
      const server = createFakeServer({});
      server.install();
      const store = freshStore();
      renderInvite(store, { base: undefined });

      expect(await screen.findByText('This invite link is incomplete')).toBeTruthy();
      expect(screen.getByText(/names a guild but not the server/i)).toBeTruthy();
      expect(server.state.joins).toEqual([]);
    } finally {
      meta.remove();
    }
  });

  it('lets a visitor choose another account home without leaving the invite', async () => {
    const server = createFakeServer({ suggestAlternatives: true });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    renderInvite(store);

    await screen.findByText('Community Home');
    await user.click(screen.getByRole('button', { name: 'Use a server domain' }));

    const home = screen.getByLabelText('Home server');
    expect(home).toBeTruthy();
    expect(screen.getByText(/enter the HTTPS address of any Telium homeserver/i)).toBeTruthy();
    await user.type(home, 'https://home.example');
    expect(home.value).toBe('https://home.example');
  });

  it('shows and requires saving the recovery key before an invite registration joins', async () => {
    const server = createFakeServer({
      userId: '@new:home.example',
      recoveryKeyReset: true,
      suggestAlternatives: true,
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    renderInvite(store);

    await screen.findByText('Community Home');
    await user.type(screen.getByLabelText('Display name'), 'New Person');
    await user.type(screen.getByLabelText('Username'), 'new');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account & join Telium' }));

    expect(await screen.findByRole('heading', { name: 'Save your recovery key' })).toBeTruthy();
    const key = screen.getByText(/^telium-recovery-v1-/).textContent;
    expect(server.state.joins).toEqual([]);

    expect(screen.getByTestId('account-address').textContent).toContain('@new:home.example');
    await user.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(await navigator.clipboard.readText()).toBe('@new:home.example');
    await user.click(screen.getByRole('button', { name: 'Copy recovery key' }));
    const copied = await navigator.clipboard.readText();
    expect(copied).toContain('Account: @new:home.example');
    expect(copied).toContain(key);

    await user.click(screen.getByRole('button', { name: 'I saved my recovery key' }));

    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']), { timeout: 15_000 });
    expect(sessionStorage.getItem('telium.pending-account-recovery.v1')).toBeNull();
  });

  it('opens a vanity name at /invite/<name> and joins through the vanity path', async () => {
    const server = createFakeServer({
      userId: '@new:home.example',
      suggestAlternatives: true,
      vanity: { alias: 'linuxcommunity' },
    });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    renderInvite(store, { code: 'linuxcommunity' });

    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    expect(screen.getByText('2 members')).toBeTruthy();

    await user.type(screen.getByLabelText('Display name'), 'New Person');
    await user.type(screen.getByLabelText('Username'), 'new');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account & join Telium' }));

    await waitFor(
      () => expect(server.state.joins).toContain('vanity:linuxcommunity'),
      { timeout: 15_000 },
    );
    expect(store.route).toMatchObject({ view: 'chat', guildId: 'g1' });
  });

  it('creates the account on the community home and joins the remote guild in one action', async () => {
    const server = createFakeServer({ userId: '@new:home.example', suggestAlternatives: true });
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    const entered = vi.fn();
    renderInvite(store, { onEntered: entered });

    await screen.findByText('Community Home');
    await user.type(screen.getByLabelText('Display name'), 'New Person');
    await user.type(screen.getByLabelText('Username'), 'new');
    await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
    await user.click(screen.getByRole('button', { name: 'Create account & join Telium' }));

    await waitFor(() => expect(server.state.joins).toEqual(['INVITE1']), { timeout: 15_000 });
    expect(server.state.profileWrites).toContainEqual({ display_name: 'New Person' });
    expect(sessionStorage.getItem('telium.lastHome')).toBe(HOME);
    expect(store.session.home.domain).toBe('home.example');
    expect(store.route).toMatchObject({ view: 'chat', guildId: 'g1', channelId: 'c1' });
    expect(entered).toHaveBeenCalledTimes(1);
  });

  it('names the inviting server as the account home instead of asking, unless its operator asked to be asked', async () => {
    const server = createFakeServer();
    server.install();
    const store = freshStore();
    const user = userEvent.setup();
    renderInvite(store);

    expect(await screen.findByRole('heading', { name: 'Telium' })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Username')).toBeTruthy());
    expect(screen.queryByTestId('account-home-picker')).toBeNull();
    expect(screen.queryByLabelText('Home server')).toBeNull();
    expect(screen.getByText('Where your new account will live. Changing it does not change the invitation.')).toBeTruthy();
    expect(document.querySelector('.auth-host').textContent).toContain('guilds.example');

    await user.click(document.querySelector('button.auth-host'));
    const field = await screen.findByLabelText('Home server');
    await user.clear(field);
    await user.type(field, 'elsewhere.example');
    expect(field.value).toBe('elsewhere.example');
  });
});
