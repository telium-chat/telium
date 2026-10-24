import { describe, expect, it } from 'vitest';
import { act, screen } from '@testing-library/react';
import { Timeline } from '../views/chat/Timeline.jsx';
import { AppearancePane } from '../views/user-settings/AppearancePane.jsx';
import { dateOrdered, dateTimeOrdered, dateOrder } from '../lib/i18n/index.js';
import { beforeToday, timeOf } from '../lib/util.js';
import { freshStore, HOME } from './fake-server.js';
import { ME, mount } from './harness.jsx';

const BOB = '@bob:home.example';

const at = (days, hour, minute = 0) => {
  const when = new Date();
  when.setDate(when.getDate() - days);
  when.setHours(hour, minute, 0, 0);
  return when.getTime();
};

describe('what counts as older than a day', () => {
  const now = at(0, 14, 30);

  it('counts days off the calendar rather than hours off the clock', () => {
    expect(beforeToday(at(0, 9), now)).toBe(false);
    expect(beforeToday(at(1, 9), now)).toBe(true);
    expect(beforeToday(at(2, 23, 59), now)).toBe(true);
    expect(beforeToday(at(-1, 9), now)).toBe(false);
  });

  it('holds the boundary at midnight however the clock has moved', () => {
    expect(beforeToday(at(1, 23), at(0, 6))).toBe(true);
    expect(beforeToday(at(0, 1), at(0, 6))).toBe(false);
  });
});

const messages = [
  { id: 'm-old', channel_id: 'c1', author: BOB, content: 'old head', created_at: at(2, 10, 0) },
  { id: 'm-old-2', channel_id: 'c1', author: BOB, content: 'old grouped', created_at: at(2, 10, 5) },
  { id: 'm-yesterday', channel_id: 'c1', author: BOB, content: 'yesterday message', created_at: at(1, 9, 0) },
  { id: 'm-today', channel_id: 'c1', author: BOB, content: 'today message', created_at: at(0, 14, 30) },
  { id: 'm-today-2', channel_id: 'c1', author: BOB, content: 'today grouped', created_at: at(0, 14, 35) },
];
const [old, oldGrouped, yesterday, today, todayGrouped] = messages.map((m) => m.created_at);

const surface = {
  id: 'c1', kind: 'channel', guildId: 'g1',
  ack: () => {}, memberOf: () => null, colourFor: () => null,
  mayEdit: () => false, avatarFor: () => ({}), menu: () => [],
};

function timelineStore() {
  const store = freshStore();
  store.me = { user_id: ME };
  store.session = { home: { user_id: ME, device_id: 'd1', domain: HOME } };
  return store;
}

function draw() {
  const store = timelineStore();
  mount(
    <Timeline
      surface={surface}
      items={messages}
      pending={[]}
      loading={false}
      intro={<div>the conversation begins</div>}
      hasMore={false}
      onEdit={() => {}}
      onReply={() => {}}
    />,
    store,
  );
  return store;
}

const row = (text) => screen.getByText(text).closest('.msg-row');

const spaced = (s) => s.replace(/\s/g, ' ');

const gutter = (rowEl) => rowEl.querySelector('.w-10 span');

describe('the date beside an old message', () => {
  it('says only the time for today, and the date from yesterday on', () => {
    draw();
    const todayRow = row('today message');
    expect(spaced(todayRow.textContent)).toContain(spaced(timeOf(today)));
    expect(todayRow.textContent).not.toContain(dateOrdered(today));
    const yesterdayRow = row('yesterday message');
    expect(spaced(yesterdayRow.textContent)).toContain(spaced(timeOf(yesterday)));
    expect(yesterdayRow.textContent).toContain(dateOrdered(yesterday));
  });

  it('writes the date into the header of the day’s first message', () => {
    draw();
    expect(row('old head').textContent).toContain(dateTimeOrdered(old));
  });

  it('stacks the date over the time in the gutter of the messages under it', () => {
    draw();
    const stamp = gutter(row('old grouped'));
    expect(stamp.querySelector('br')).toBeTruthy();
    expect(stamp.textContent).toContain(dateOrdered(oldGrouped, undefined, { year: false }));
    expect(spaced(stamp.textContent)).toContain(spaced(timeOf(oldGrouped)));
    expect(stamp.textContent).not.toContain(String(new Date(oldGrouped).getFullYear()));
  });

  it('leaves a grouped row of today unwrapped and undated', () => {
    draw();
    const stamp = gutter(row('today grouped'));
    expect(stamp.querySelector('br')).toBeNull();
    expect(stamp.textContent).not.toContain(dateOrdered(todayGrouped));
  });

  it('follows the order the reader chose', () => {
    const store = draw();
    expect(row('old head').textContent).toContain(dateTimeOrdered(old, dateOrder()));
    act(() => {
      store.prefs.dateFormat = 'dmy';
      store.savePrefs();
    });
    expect(row('old head').textContent).toContain(dateTimeOrdered(old, 'dmy'));
    expect(gutter(row('old grouped')).textContent).toContain(
      dateOrdered(oldGrouped, 'dmy', { year: false }),
    );
    expect(row('yesterday message').textContent).toContain(dateTimeOrdered(yesterday, 'dmy'));
  });
});

describe('the date format setting', () => {
  it('writes the order the row reads, to the preference it belongs to', async () => {
    const store = freshStore();
    store.session = { home: { user_id: ME, device_id: 'd1', domain: HOME } };
    const { user } = mount(<AppearancePane />, store);

    const trigger = screen.getByRole('combobox', { name: 'Date format' });
    expect(trigger).toBeTruthy();
    await user.click(trigger);
    await screen.findByRole('listbox');
    await user.click(screen.getByRole('option', { name: 'DD/MM/YY' }));
    expect(store.prefs.dateFormat).toBe('dmy');
  });

  it('reads a preference it does not recognise as no preference at all', () => {
    expect(dateOrder('medium')).toBe(dateOrder());
    expect(dateOrder('')).toBe(dateOrder());
    expect(dateOrder(undefined)).toBe(dateOrder());
  });
});
