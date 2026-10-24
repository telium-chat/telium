import { describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { mount, signedInStore } from './harness.jsx';
import { QueuePane } from '../views/guild-settings/QueuePane.jsx';

const GUILD = 'g1';
const BOB = '@bob:home.example';
const GUILD_DOMAIN = 'guilds.example';

const applicant = (userId) => ({
  user_id: userId,
  state: 'pending',
  created_at: Date.now(),
  answers: [{ question: 'why do you want to join?', answer: 'I like the topic' }],
});

function fakeApi({ queues = [[]], decide } = {}) {
  const asked = [];
  return {
    base: 'https://guilds.example',
    asked,
    held: async () => ({ held: [] }),
    applicants: async () => {
      const at = Math.min(asked.length, queues.length - 1);
      asked.push(at);
      return { applicants: queues[at] };
    },
    decideHeld: async () => ({ ok: true }),
    decideApplicant: decide || (async () => ({ ok: true, state: 'approved' })),
  };
}

const say = (store, d) => act(() => {
  store.onDispatch({ domain: GUILD_DOMAIN, t: 'GUILD_APPLICANT', d });
});

describe('a card another moderator has already ruled on', () => {
  it('goes away when the guild says the queue moved', async () => {
    const api = fakeApi({ queues: [[applicant(BOB)], []] });
    const store = signedInStore();
    mount(<QueuePane guildId={GUILD} api={api} />, store);
    await screen.findByText('bob');

    say(store, { guild_id: GUILD, removed: true });

    await waitFor(() => expect(screen.queryByText('bob')).toBeNull());
    expect(screen.getByText('Nobody is waiting')).toBeTruthy();
    expect(api.asked.length).toBe(2);
  });

  it('appears when somebody answers the questions while the pane is open', async () => {
    const api = fakeApi({ queues: [[], [applicant(BOB)]] });
    const store = signedInStore();
    mount(<QueuePane guildId={GUILD} api={api} />, store);
    await screen.findByText('Nobody is waiting');

    say(store, { guild_id: GUILD });

    expect(await screen.findByText('bob')).toBeTruthy();
    expect(screen.getByText('I like the topic')).toBeTruthy();
  });

  it('ignores a queue moving in a guild this pane is not drawing', async () => {
    const api = fakeApi({ queues: [[applicant(BOB)], []] });
    const store = signedInStore();
    mount(<QueuePane guildId={GUILD} api={api} />, store);
    await screen.findByText('bob');

    say(store, { guild_id: 'g2', removed: true });

    await Promise.resolve();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(api.asked.length).toBe(1);
  });
});

describe('pressing the button on a card that is already gone', () => {
  it('still reloads, so the row goes even though the call failed', async () => {
    const decide = vi.fn(async () => {
      const e = new Error('no pending application from that user');
      e.status = 404;
      throw e;
    });
    const api = fakeApi({ queues: [[applicant(BOB)], []], decide });
    const store = signedInStore();
    const { user } = mount(<QueuePane guildId={GUILD} api={api} />, store);
    await screen.findByText('bob');

    await user.click(screen.getByRole('button', { name: 'Admit' }));

    expect(decide).toHaveBeenCalledWith(GUILD, BOB, 'approve');
    await waitFor(() => expect(screen.queryByText('bob')).toBeNull());
    expect(await screen.findByText(/Could not act on that applicant/)).toBeTruthy();
  });
});
