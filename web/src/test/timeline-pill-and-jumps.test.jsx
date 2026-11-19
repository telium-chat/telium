import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Timeline } from '../views/chat/Timeline.jsx';
import { carriesMedia } from '../views/chat/MessageRow.jsx';
import { klipyConfig } from '../lib/gifs.js';
import { freshStore, HOME } from './fake-server.js';
import { ME, mount } from './harness.jsx';

const BOB = '@bob:home.example';
const now = Date.now();
const said = (id, content, author = BOB, minutes = 0) => ({
  id, channel_id: 'c1', author, content, created_at: now - 60_000 * (60 - minutes),
});

class QuietResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', QuietResizeObserver); });
afterEach(() => { vi.unstubAllGlobals(); });

function timelineStore() {
  const store = freshStore();
  store.me = { user_id: ME };
  store.session = { home: { user_id: ME, device_id: 'd1', domain: HOME } };
  return store;
}

const channel = {
  id: 'c1', kind: 'channel', guildId: 'g1',
  ack: () => {}, memberOf: () => null, colourFor: () => null,
  mayEdit: () => false, avatarFor: () => ({}), menu: () => [],
};

function fakeLayout(el, { height, view }) {
  const box = { height, view, top: 0 };
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.view });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.top,
    set: (value) => { box.top = Math.max(0, Math.min(Number(value), box.height - box.view)); },
  });
  el.scrollTo = ({ top }) => { el.scrollTop = top; };
  return box;
}

/// Inside the app's providers, with the list swappable the way a live store swaps it.
function draw(items, props = {}, surface = channel, store = timelineStore()) {
  let swap = null;
  function Live() {
    const [list, setList] = useState(items);
    swap = setList;
    return (
      <Timeline
        surface={surface} items={list} pending={[]} loading={false} hasMore={false}
        onEdit={() => {}} onReply={() => {}} {...props}
      />
    );
  }
  const view = mount(<Live />, store);
  const el = view.container.querySelector('.chat-scroller');
  return { ...view, el, redraw: (list) => act(() => swap(list)) };
}

const scrollTo = (el, top) => { el.scrollTop = top; fireEvent.scroll(el); };

describe('the pill above the composer', () => {
  const first = [said('m1', 'one'), said('m2', 'two', BOB, 1)];

  it('counts what arrived while the reader was scrolled up, and takes them there', () => {
    const { el, redraw } = draw(first);
    const box = fakeLayout(el, { height: 2000, view: 500 });
    scrollTo(el, 1500);
    scrollTo(el, 1200);
    expect(screen.queryByRole('button', { name: /new message|jump to present/i })).toBeNull();

    // Two from Bob and one of mine: only Bob's are news.
    redraw([...first, said('m3', 'three', BOB, 2), said('m4', 'mine', ME, 3), said('m5', 'five', BOB, 4)]);
    const pill = screen.getByRole('button', { name: '2 new messages' });

    fireEvent.click(pill);
    expect(box.top).toBe(box.height - box.view);
    expect(screen.queryByRole('button', { name: /new message/i })).toBeNull();
  });

  it('offers the way back from far up even when nothing is new', () => {
    const { el } = draw(first);
    fakeLayout(el, { height: 5000, view: 500 });
    scrollTo(el, 4500);
    scrollTo(el, 3000);
    expect(screen.queryByRole('button', { name: 'Jump to present' })).toBeNull();
    scrollTo(el, 1000);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to present' }));
    expect(el.scrollTop).toBe(4500);
  });
});

describe('jumping to the message a reply quotes, in a conversation', () => {
  it('pages back through history until the quoted message is there, then lands on it', async () => {
    const store = timelineStore();
    const dm = { ...channel, id: 'dm1', kind: 'dm', guildId: null };
    const recent = [said('m9', 'latest')];
    const onLoadOlder = vi.fn(async () => {});
    store.pendingJump = { channelId: 'dm1', messageId: 'm1' };
    const view = draw(recent, { hasMore: true, onLoadOlder }, dm, store);
    await act(async () => {});
    expect(onLoadOlder).toHaveBeenCalledTimes(1);

    view.redraw([said('m1', 'the quoted one'), ...recent]);
    await act(async () => {});
    expect(screen.getByText('the quoted one').closest('.msg-row').className).toContain('msg-flash');
    expect(screen.queryByText('That message is not available any more.')).toBeNull();
  });

  it('says the message is gone once there is no more history to look through', async () => {
    const store = timelineStore();
    const dm = { ...channel, id: 'dm1', kind: 'dm', guildId: null };
    store.pendingJump = { channelId: 'dm1', messageId: 'nope' };
    draw([said('m9', 'latest')], { hasMore: false }, dm, store);
    expect(await screen.findByText('That message is not available any more.')).toBeTruthy();
  });
});

describe('what a row can hide as media', () => {
  const gifs = klipyConfig({ prefs: {}, caps: new Map(), session: null });

  it('counts a GIF in an encrypted conversation, where GIFs are still drawn', () => {
    const gif = { content: 'https://media.giphy.com/media/abc123/giphy.gif', attachments: [] };
    expect(carriesMedia(gif, true, gifs)).toBe(true);
    expect(carriesMedia(gif, false, gifs)).toBe(true);
  });

  it('does not count a plain link there, which is drawn as text', () => {
    const link = { content: 'see https://example.com/page', attachments: [] };
    expect(carriesMedia(link, true, gifs)).toBe(false);
    expect(carriesMedia(link, false, gifs)).toBe(true);
  });
});
