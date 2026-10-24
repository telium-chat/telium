import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { FormatBar } from '../views/chat/FormatBar.jsx';
import { FORMATS, formatEdit } from '../views/chat/formatting.js';
import { t } from '../lib/i18n/index.js';
import { EditBox } from '../views/chat/MessageRow.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';

const format = (id) => FORMATS.find((f) => f.id === id);

function Harness({ initial = 'hello world' }) {
  const ref = useRef(null);
  const [value, setValue] = useState(initial);
  const apply = (edit) => {
    const node = ref.current;
    if (!node) return;
    const next = node.value.slice(0, edit.from) + edit.text + node.value.slice(edit.to);
    setValue(next);
    requestAnimationFrame(() => {
      node.setSelectionRange(edit.select[0], edit.select[1]);
      node.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    });
  };
  return (
    <>
      <textarea ref={ref} value={value} onChange={(e) => setValue(e.target.value)} />
      <FormatBar textareaRef={ref} apply={apply} />
    </>
  );
}

const LAYOUT_PROPS = ['clientWidth'];
const ORIGINALS = new Map([
  ...LAYOUT_PROPS.map((p) => [p, Object.getOwnPropertyDescriptor(HTMLElement.prototype, p)]),
  ['getBoundingClientRect', HTMLElement.prototype.getBoundingClientRect],
]);

const ZERO_RECT = () => ({
  left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
  toJSON() { return this; },
});

const BOX_RECT = { left: 40, top: 80, right: 440, bottom: 124, width: 400, height: 44 };

function laidOut(box, { left = 200, top = 100 } = {}) {
  const mirror = () => document.querySelector('.format-bar-mirror');
  const marker = () => mirror()?.lastElementChild || null;

  HTMLElement.prototype.getBoundingClientRect = function patched() {
    if (this === marker()) {
      return {
        left, top, right: left + 8, bottom: top + 20, width: 8, height: 20,
        x: left, y: top, toJSON() { return this; },
      };
    }
    if (this === box) {
      return { ...BOX_RECT, x: BOX_RECT.left, y: BOX_RECT.top, toJSON() { return this; } };
    }
    return ZERO_RECT();
  };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true, get() { return this === box ? BOX_RECT.width : 0; },
  });
}

afterEach(() => {
  for (const p of LAYOUT_PROPS) {
    const desc = ORIGINALS.get(p);
    if (desc) Object.defineProperty(HTMLElement.prototype, p, desc);
  }
  HTMLElement.prototype.getBoundingClientRect = ORIGINALS.get('getBoundingClientRect');
});

function select(box, from, to) {
  act(() => { box.focus(); });
  box.setSelectionRange(from, to);
  act(() => { document.dispatchEvent(new Event('selectionchange', { bubbles: true })); });
}

function dragged(box, from, to) {
  act(() => { box.focus(); });
  act(() => {
    box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  box.setSelectionRange(from, to);
  act(() => { document.dispatchEvent(new Event('selectionchange', { bubbles: true })); });
}

const released = () => act(() => {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});

const bar = () => screen.queryByRole('toolbar', { name: t('chat.format.bar') });
const tile = (id) => screen.getByRole('button', { name: t(format(id).labelKey) });

describe('when the bar arrives and leaves', () => {
  it('is not there until something is selected', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    act(() => { box.focus(); });
    expect(bar()).toBeNull();
  });

  it('appears over a selection in the focused box', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    select(screen.getByRole('textbox'), 0, 5);
    expect(bar()).not.toBeNull();
  });

  it('waits for the release of a drag, and not the highlight', async () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    const box = screen.getByRole('textbox');
    dragged(box, 0, 5);
    expect(bar()).toBeNull();
    released();
    expect(bar()).not.toBeNull();
  });

  it('takes the bar away when a new drag starts', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    const box = screen.getByRole('textbox');
    select(box, 0, 5);
    expect(bar()).not.toBeNull();
    dragged(box, 6, 11);
    expect(bar()).toBeNull();
    released();
    expect(bar()).not.toBeNull();
    expect(tile('bold')).toBeTruthy();
  });

  it('still answers a keyboard selection while nothing is held down', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    const box = screen.getByRole('textbox');
    dragged(box, 0, 5);
    released();
    select(box, 0, 11);
    expect(bar()).not.toBeNull();
  });

  it('leaves again when the selection collapses', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    const box = screen.getByRole('textbox');
    select(box, 0, 5);
    expect(bar()).not.toBeNull();
    select(box, 3, 3);
    expect(bar()).toBeNull();
  });

  it('ignores a selection made in some other box', () => {
    const view = render(
      <>
        <Harness />
        <textarea data-testid="other" />
      </>,
    );
    laidOut(screen.getByTestId('other'));
    const other = screen.getByTestId('other');
    act(() => { other.focus(); });
    other.setSelectionRange(0, 2);
    act(() => { document.dispatchEvent(new Event('selectionchange', { bubbles: true })); });
    expect(bar()).toBeNull();
    view.unmount();
  });

  it('goes away when the box hands the focus to the rest of the page', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    const box = screen.getByRole('textbox');
    select(box, 0, 5);
    expect(bar()).not.toBeNull();
    act(() => { box.blur(); });
    expect(bar()).toBeNull();
  });
});

describe('what the bar is made of', () => {
  it('carries every format the chords carry, and nothing else', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    select(screen.getByRole('textbox'), 0, 5);
    for (const f of FORMATS) {
      expect(screen.getByRole('button', { name: t(f.labelKey) })).toBeTruthy();
    }
    expect(screen.getAllByRole('button')).toHaveLength(FORMATS.length);
  });

  it('holds position:fixed, because its coordinates are viewport ones', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    select(screen.getByRole('textbox'), 0, 5);
    const style = bar().style;
    expect(style.position).toBe('fixed');
    expect(style.left).toMatch(/px$/);
    expect(style.top).toMatch(/px$/);
  });

  it('is the same surface as the pickers and the panels', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    select(screen.getByRole('textbox'), 0, 5);
    expect(bar().classList.contains('popup')).toBe(true);
    expect(tile('bold').classList.contains('popup-icon-button')).toBe(true);
  });

  it('measures the caret from where the box is, not from the top of the page', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    let seen = null;
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function asked() {
      const m = document.querySelector('.format-bar-mirror');
      if (m && this === m.lastElementChild) {
        seen = { position: m.style.position, top: m.style.top, left: m.style.left };
      }
      return realRect.call(this);
    };
    select(box, 2, 5);
    HTMLElement.prototype.getBoundingClientRect = realRect;
    expect(seen).toEqual({ position: 'fixed', top: '80px', left: '40px' });
  });

  it('sits directly above the highlighted text, not wherever else it likes', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, 0, 5);
    const { left, top } = bar().style;
    expect(left).toBe('81.5px');
    expect(top).toBe('92px');
    expect(bar().dataset.side).toBe('above');
  });

  it('hangs under the line instead when there is no room above it', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    laidOut(box, { top: 30 });
    select(box, 0, 5);
    expect(bar().dataset.side).toBe('below');
    expect(bar().style.left).toBe('81.5px');
    expect(parseFloat(bar().style.top)).toBeGreaterThan(30);
  });

  it('anchors on the start of the selection even when the drag ended far away', () => {
    render(<Harness initial={'one\ntwo\nthree'} />);
    const box = screen.getByRole('textbox');
    let seenText = null;
    laidOut(box);
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function asked() {
      const m = document.querySelector('.format-bar-mirror');
      if (m && this === m.lastElementChild) seenText = m.textContent;
      return realRect.call(this);
    };
    select(box, 4, 11);
    expect(seenText).toBe(`${box.value.slice(0, 4)}\u200b`);
    expect(seenText).not.toBe(`${box.value.slice(0, 11)}\u200b`);
    expect(bar().style.top).toBe('92px');
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  it('renders outside both boxes, in the document body', () => {
    render(<Harness />);
    laidOut(screen.getByRole('textbox'));
    select(screen.getByRole('textbox'), 0, 5);
    expect(document.body.contains(bar())).toBe(true);
    expect(bar().closest('textarea')).toBeNull();
    expect(screen.getByRole('textbox').parentElement.contains(bar())).toBe(false);
  });
});

describe('the three ways in agree', () => {
  async function press(id, text, from, to) {
    const view = render(<Harness initial={text} />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, from, to);
    fireEvent.click(tile(id));
    const edit = formatEdit(format(id), text, from, to);
    const next = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
    await waitFor(() => expect(box.value).toBe(next));
    await waitFor(() => expect([box.selectionStart, box.selectionEnd]).toEqual(edit.select));
    view.unmount();
    return next;
  }

  it('wraps bold, and keeps the highlight on the word rather than the markers', async () => {
    expect(await press('bold', 'say hello there', 4, 9)).toBe('say **hello** there');
  });

  it('takes the markers off again on a second press', async () => {
    expect(await press('bold', 'say **hello** there', 4, 13)).toBe('say hello there');
  });

  it('takes the format off again when the same tile is pressed twice', async () => {
    render(<Harness initial='say hello there' />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, 4, 9);
    fireEvent.click(tile('bold'));
    await waitFor(() => expect(box.value).toBe('say **hello** there'));
    await waitFor(() => expect([box.selectionStart, box.selectionEnd]).toEqual([6, 11]));
    expect(bar()).not.toBeNull();
    fireEvent.click(tile('bold'));
    await waitFor(() => expect(box.value).toBe('say hello there'));
  });

  it('takes a code block off again on a second press', async () => {
    render(<Harness initial={'one\ntwo'} />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, 0, 7);
    fireEvent.click(tile('block'));
    await waitFor(() => expect(box.value).toBe('```\none\ntwo\n```'));
    await waitFor(() => expect([box.selectionStart, box.selectionEnd]).toEqual([4, 11]));
    fireEvent.click(tile('block'));
    await waitFor(() => expect(box.value).toBe('one\ntwo'));
  });

  it('has a marker for every format the renderer understands', async () => {
    expect(await press('italic', 'a word b', 2, 6)).toBe('a *word* b');
    expect(await press('strike', 'a word b', 2, 6)).toBe('a ~~word~~ b');
    expect(await press('code', 'a word b', 2, 6)).toBe('a `word` b');
    expect(await press('spoiler', 'a word b', 2, 6)).toBe('a ||word|| b');
  });

  it('gives a code block its fences a line to themselves', async () => {
    expect(await press('block', 'one\ntwo', 0, 7)).toBe('```\none\ntwo\n```');
  });

  it('quotes every line the selection touches, and not the one after', async () => {
    expect(await press('quote', 'one\ntwo\nthree', 0, 8)).toBe('> one\n> two\nthree');
  });

  it('never moves the focus out of the box it edits', async () => {
    render(<Harness initial='hello there' />);
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, 0, 5);
    fireEvent.mouseDown(tile('bold'));
    expect(document.activeElement).toBe(box);
  });
});

describe('the edit box gets the same bar', () => {
  const store = {
    me: { user_id: '@me:home.example' },
    on: () => () => {},
    emit: () => {},
    sync: { get: () => [] },
    guilds: new Map(),
    channels: new Map(),
    conversations: [],
    users: new Map(),
    saveDraft: () => {},
    draftFor: () => '',
    apiForGuild: () => null,
    apiFor: () => null,
  };
  const surface = { kind: 'channel', id: 'C1', guildId: 'G1', perms: null, edit: vi.fn() };
  const msg = { id: 'M1', author: '@me:home.example', content: 'say hello there' };

  it('floats over a highlight in a message being corrected', async () => {
    render(
      <StoreProvider store={store}>
        <EditBox msg={msg} surface={surface} done={() => {}} />
      </StoreProvider>,
    );
    const box = screen.getByRole('textbox');
    laidOut(box);
    select(box, 4, 9);
    expect(bar()).not.toBeNull();
    fireEvent.click(tile('bold'));
    await waitFor(() => expect(box.value).toBe('say **hello** there'));
  });
});
