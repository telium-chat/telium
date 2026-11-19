import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DmSidePanel } from '../views/DmSidePanel.jsx';
import { freshStore, HOME } from './fake-server.js';
import { ME, mount } from './harness.jsx';

const BOB = '@bob:home.example';

describe("a group conversation's member list", () => {
  it('shows what we are playing on our own row, as a guild member list does', () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.session = { home: { user_id: ME, device_id: 'd1', domain: HOME } };
    const convo = { id: 'gc1', kind: 'gc', members: [{ user_id: ME }, { user_id: BOB }] };
    mount(<DmSidePanel convo={convo} />, store);
    const list = screen.getByRole('complementary', { name: 'Members' });
    expect(within(list).queryByText('THE FINALS')).toBeNull();

    // What the desktop rich presence writes for us when a game starts.
    act(() => {
      const mine = { user_id: ME, status: 'online', activity: { type: 0, name: 'THE FINALS' }, rich_activities: [{ type: 0, name: 'THE FINALS' }] };
      store.presence.set(ME, mine);
      store.emit('presence', mine);
    });
    expect(within(list).getByText('THE FINALS')).toBeTruthy();
  });

  it('closes a member\u2019s profile when their row is pressed again', async () => {
    const store = freshStore();
    store.me = { user_id: ME };
    store.session = { home: { user_id: ME, device_id: 'd1', domain: HOME } };
    const convo = { id: 'gc1', kind: 'gc', members: [{ user_id: ME }, { user_id: BOB }] };
    mount(<DmSidePanel convo={convo} />, store);
    const user = userEvent.setup();
    const row = within(screen.getByRole('complementary', { name: 'Members' })).getByRole('button', { name: /bob/ });

    await user.click(row);
    expect(await screen.findByRole('dialog')).toBeTruthy();

    await user.click(row);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
