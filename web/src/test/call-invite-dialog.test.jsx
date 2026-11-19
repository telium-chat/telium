import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { useModal } from '../hooks/useModal.jsx';
import { InviteDialog } from '../views/dialogs/InviteDialog.jsx';
import { ME, mount, signedInStore } from './harness.jsx';

const BOB = '@bob:home.example';
const guild = { id: 'g1', name: 'Guild', domain: 'guilds.example', origin: 'guilds.example' };
const made = { code: 'CALL1', url: 'https://guilds.example/invite/CALL1', expires_at: Date.now() + 3_600_000, call: true };

function Opener({ call }) {
  const modal = useModal();
  useEffect(() => {
    modal.open((close) => <InviteDialog guild={guild} invite={made} call={call} close={close} />);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function open(call) {
  const store = signedInStore({
    friends: [{ user_id: BOB, domain: 'home.example', state: 'accepted', presence: { user_id: BOB, status: 'online' }, display_name: 'Bob' }],
    members: { g1: [{ user_id: BOB }] },
  });
  mount(<Opener call={call} />, store);
  return store;
}

describe('the call invite dialog', () => {
  it('says the link ends with the call and offers no terms to pick', async () => {
    open({ id: 'c1', name: 'Lounge' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stops working when the call ends/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'New link' })).toBeNull();
    expect(within(dialog).getByText('Invite to Lounge')).toBeTruthy();
  });

  it('still offers the link to a friend who is already in the server', async () => {
    open({ id: 'c1', name: 'Lounge' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Invite' })).toBeTruthy();
    expect(within(dialog).queryByText('Already here')).toBeNull();
  });

  it('keeps the ordinary dialog unchanged', async () => {
    open(null);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'New link' })).toBeTruthy();
    expect(within(dialog).getByText('Already here')).toBeTruthy();
  });
});
