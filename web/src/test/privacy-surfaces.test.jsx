import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { EN } from '../lib/i18n/catalog/index.js';

vi.mock('../lib/serviceworker.js', () => ({
  supported: true,
  workerSupported: true,
  currentSubscription: async () => null,
  subscribe: async () => {},
  unsubscribe: async () => {},
  register: async () => {},
  unregisterAll: async () => {},
  onNotificationNavigate: () => () => {},
}));

const { mount, signedInStore } = await import('./harness.jsx');
const { useMenus } = await import('../views/menus.jsx');
const { MenuButton, PrivacyNote, PRESENCE } = await import('../components/index.js');
const { GifPickerPanel } = await import('../views/chat/GifPicker.jsx');
const { EncryptionChip } = await import('../views/chat/encryption.jsx');
const { NotificationsPane } = await import('../views/user-settings/NotificationsPane.jsx');

const clause = (text) => (_content, node) => {
  if (!node?.textContent?.includes(text)) return false;
  return !Array.from(node.children).some((child) => child.textContent?.includes(text));
};

afterEach(() => { vi.restoreAllMocks(); });

function Menu({ kind, arg }) {
  const menus = useMenus();
  return <MenuButton label="Menu" content={menus[kind](arg)}>Menu</MenuButton>;
}

describe('privacy disclosures', () => {
  it('Invisible admits the home server still sees the connection, as a statement not a menuitem', async () => {
    const { user, container } = mount(<Menu kind="account" />, signedInStore());
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(PRESENCE.online.label) }));

    const note = await screen.findByText(clause('Your home server still sees this connection'));
    expect(note.textContent).toBe(EN['privacy.presence.invisible']);
    const box = container.ownerDocument.querySelector('.privacy-note--menu');
    expect(box.getAttribute('role')).toBeNull();
    expect(box.closest('[role="menuitem"]')).toBeNull();
  });

  it('a block says messages are still taken and stored, and the sender cannot tell', async () => {
    const row = { user_id: '@mallory:elsewhere.example', state: 'accepted' };
    const { user } = mount(<Menu kind="friend" arg={row} />, signedInStore({ friends: [row] }));
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Block' }));

    const body = await screen.findByText(clause('It does not stop them sending'));
    expect(body.textContent).toBe(EN['privacy.block.body']);
    expect(body.textContent).toContain('still takes their messages and stores them');
  });

  it.each([
    [true, 'names the configured GIF provider in an encrypted conversation'],
    [false, 'says nothing about the GIF provider in a channel'],
  ])('encrypted=%s %s', async (encrypted) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { data: [] } }) });
    const store = signedInStore();
    store.gif_provider = { api_base_url: 'https://gifs.example.test/v1' };
    mount(<GifPickerPanel onPick={() => {}} onClose={() => {}} encrypted={encrypted} />, store);

    if (encrypted) {
      expect(await screen.findByText(EN['privacy.gif.head'])).toBeTruthy();
      const body = await screen.findByText(clause('gifs.example.test'));
      expect(body.textContent).toContain('they see your address and which GIF you picked');
    } else {
      await waitFor(() => expect(screen.queryByText(EN['privacy.gif.head'])).toBeNull());
      expect(screen.queryByText(clause('gifs.example.test'))).toBeNull();
    }
  });

  it('the encryption chip carries the typing exception only while typing is sent', () => {
    const chip = (typing) => {
      const { unmount } = mount(
        <EncryptionChip custody="client" unverified={0} changed={null} typing={typing} onOpen={() => {}} />,
        signedInStore(),
      );
      const title = screen.getByRole('button').getAttribute('title');
      unmount();
      return title;
    };
    expect(chip(true)).toContain(EN['privacy.typing.inEncrypted']);
    expect(chip(false)).not.toContain('Typing indicators are the exception');
  });

  it('background push says what the provider accumulates', async () => {
    mount(<NotificationsPane />, signedInStore());
    expect(await screen.findByText(EN['privacy.push.head'])).toBeTruthy();
    const note = screen.getByText(clause('a stable address for this browser'));
    expect(note.textContent).toContain('the time and size of every wake-up');
  });

  it('a PrivacyNote is not drawn as an alert', () => {
    const { container } = mount(<PrivacyNote head="Somebody is on the wire." />, signedInStore());
    const note = container.querySelector('.privacy-note');
    expect(note.getAttribute('role')).toBeNull();
    expect(note.getAttribute('aria-live')).toBeNull();
    expect(container.querySelector('.notice')).toBeNull();
  });
});
