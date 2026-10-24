import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { StoreProvider } from '../hooks/useStore.jsx';
import { Timeline } from '../views/chat/Timeline.jsx';

let observers = [];

class TestResizeObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() { observers = observers.filter((o) => o !== this); }
}

function fakeLayout(el, { height, view }) {
  const box = { height, view, top: 0 };
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.view });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.height });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => box.top,
    set: (value) => { box.top = Math.max(0, Math.min(Number(value), box.height - box.view)); },
  });
  return box;
}

function fakeStore() {
  return {
    me: { user_id: '@alice:home.example' },
    threads: new Map(),
    myMember: () => null,
    takeJump: () => null,
    on: () => () => {},
  };
}

function settle(el) {
  el.scrollTop = el.scrollHeight;
  fireEvent.scroll(el);
}

function mount(id) {
  const surface = {
    id, kind: 'channel', guildId: 'g1',
    ack: () => {}, memberOf: () => null, colourFor: () => null,
  };
  const { container } = render(
    <StoreProvider store={fakeStore()}>
      <Timeline surface={surface} items={[]} pending={[]} loading={false} onEdit={() => {}} onReply={() => {}} />
    </StoreProvider>,
  );
  return container.querySelector('.chat-scroller');
}

function embedLoads(el, box, pixels) {
  box.height += pixels;
  fireEvent.scroll(el);
  act(() => { observers.forEach((o) => o.callback([], o)); });
}

beforeEach(() => {
  observers = [];
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('the timeline scroller', () => {
  it('stays pinned when an embed grows under the reader', () => {
    const el = mount('grow');
    const box = fakeLayout(el, { height: 600, view: 500 });
    settle(el);
    expect(box.top).toBe(100);

    embedLoads(el, box, 400);

    expect(box.top).toBe(500);
  });

  it('follows a card that grows twice', () => {
    const el = mount('twice');
    const box = fakeLayout(el, { height: 600, view: 500 });
    settle(el);
    embedLoads(el, box, 80);
    embedLoads(el, box, 320);
    expect(box.top).toBe(500);
  });

  it('leaves a reader who scrolled up where they put themselves', () => {
    const el = mount('reading');
    const box = fakeLayout(el, { height: 2000, view: 500 });
    settle(el);
    expect(box.top).toBe(1500);

    box.top = 400;
    fireEvent.scroll(el);

    embedLoads(el, box, 300);
    expect(box.top).toBe(400);
  });
});
