import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FORMATS, chordFor, formatEdit } from '../views/chat/formatting.js';
import { t } from '../lib/i18n/index.js';
import { Composer } from '../views/chat/Composer.jsx';
import { loadEmoji } from '../lib/emoji.js';
import { StoreProvider } from '../hooks/useStore.jsx';
import { ModalProvider } from '../hooks/useModal.jsx';

const format = (id) => FORMATS.find((f) => f.id === id);

function applied(id, text, start, end) {
  const edit = formatEdit(format(id), text, start, end);
  const next = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
  const [from, to] = edit.select;
  return `${next.slice(0, from)}[${next.slice(from, to)}]${next.slice(to)}`;
}

describe('what a format does to a string', () => {
  it('wraps the selection and leaves it around the same characters', () => {
    expect(applied('bold', 'say hello there', 4, 9)).toBe('say **[hello]** there');
  });

  it('takes the markers off again when the selection is already dressed', () => {
    expect(applied('bold', 'say **hello** there', 4, 13)).toBe('say [hello] there');
  });

  it('takes the markers off again from around the highlight as well as inside it', () => {
    expect(applied('bold', 'say **hello** there', 6, 11)).toBe('say [hello] there');
  });

  it('takes it off again on the press after it went on', () => {
    const first = formatEdit(format('bold'), 'say hello there', 4, 9);
    const once = `say hello there`.slice(0, first.from) + first.text + `say hello there`.slice(first.to);
    expect(once).toBe('say **hello** there');
    const [from, to] = first.select;
    expect(applied('bold', once, from, to)).toBe('say [hello] there');
  });

  it("leaves a neighbour's pair alone when the markers are not this highlight's", () => {
    expect(applied('bold', '**a** and **b**', 5, 10)).toBe('**a****[ and ]****b**');
  });

  it('composes rather than unwraps when one marker sits inside another', () => {
    expect(applied('italic', 'say **hello** there', 6, 11)).toBe('say ***[hello]*** there');
    expect(applied('bold', 'say ***hello*** there', 7, 12)).toBe('say *[hello]* there');
  });

  it('has a marker for every format the renderer understands', () => {
    expect(applied('italic', 'a word b', 2, 6)).toBe('a *[word]* b');
    expect(applied('strike', 'a word b', 2, 6)).toBe('a ~~[word]~~ b');
    expect(applied('code', 'a word b', 2, 6)).toBe('a `[word]` b');
    expect(applied('spoiler', 'a word b', 2, 6)).toBe('a ||[word]|| b');
  });

  it('gives a code block its fences a line to themselves', () => {
    expect(applied('block', 'one\ntwo', 0, 7)).toBe('```\n[one\ntwo]\n```');
  });

  it('takes a code block off again', () => {
    expect(applied('block', '```\none\ntwo\n```', 0, 15)).toBe('[one\ntwo]');
  });
});

describe('a quote, which is a line and not a word', () => {
  it('quotes every line the selection touches', () => {
    expect(applied('quote', 'one\ntwo\nthree', 1, 9)).toBe('[> one\n> two\n> three]');
  });

  it('grows out to the line ends rather than quoting half a word', () => {
    expect(applied('quote', 'hello there', 2, 5)).toBe('[> hello there]');
  });

  it('does not reach the line after a selection that ends on a newline', () => {
    expect(applied('quote', 'one\ntwo\nthree', 0, 8)).toBe('[> one\n> two]\nthree');
  });

  it('unquotes when every line already carries the marker', () => {
    expect(applied('quote', '> one\n> two', 0, 11)).toBe('[one\ntwo]');
  });

  it('quotes again when only some of the lines carry it', () => {
    expect(applied('quote', '> one\ntwo', 0, 9)).toBe('[> > one\n> two]');
  });
});

describe('the chords', () => {
  it('answers a modifier chord with the format it is bound to', () => {
    const chord = chordFor({ metaKey: true, altKey: false, shiftKey: false, key: 'b' });
    expect(chord.id).toBe('bold');
  });

  it('wants the shift where the chord wants it, and not where it does not', () => {
    expect(chordFor({ ctrlKey: true, altKey: false, shiftKey: true, key: 'x' }).id).toBe('spoiler');
    expect(chordFor({ ctrlKey: true, altKey: false, shiftKey: false, key: 'x' })).toBeNull();
    expect(chordFor({ ctrlKey: true, altKey: false, shiftKey: true, key: 'b' })).toBeNull();
  });

  it('leaves the key alone without a modifier, and with alt held', () => {
    expect(chordFor({ altKey: false, shiftKey: false, key: 'b' })).toBeNull();
    expect(chordFor({ metaKey: true, altKey: true, shiftKey: false, key: 'b' })).toBeNull();
  });

  it('claims no key a format has not asked for', () => {
    const bound = FORMATS.filter((f) => f.chord).map((f) => `${f.chord.shift ? 'S' : ''}${f.chord.key}`);
    expect(bound.sort()).toEqual(['b', 'e', 'i', 'Sx'].sort());
  });
});

function harness({ onEditLast = () => {} } = {}) {
  const drafts = new Map();
  const store = {
    me: { user_id: '@me:home.example' },
    on: () => () => {},
    emit: () => {},
    sync: { get: () => [] },
    guilds: new Map(),
    channels: new Map(),
    conversations: [],
    users: new Map(),
    saveDraft: (key, value) => drafts.set(key, value),
    draftFor: (key) => drafts.get(key) || '',
    apiForGuild: () => null,
    apiFor: () => null,
  };
  const surface = {
    kind: 'channel',
    id: 'C1',
    guildId: 'G1',
    placeholder: 'Message #general',
    typing: () => {},
    sendBlock: null,
    mayAttach: false,
    mediaTier: 1,
    externalHosts: [],
    expiryCap: null,
    stickers: false,
    members: [],
  };
  render(
    <StoreProvider store={store}>
      <ModalProvider>
        <Composer
          surface={surface}
          replyTo={null}
          onCancelReply={() => {}}
          onEditLast={onEditLast}
          send={vi.fn()}
        />
      </ModalProvider>
    </StoreProvider>,
  );
  return screen.getByPlaceholderText('Message #general');
}

function typed(box, text, from, to) {
  fireEvent.change(box, { target: { value: text } });
  box.setSelectionRange(from, to);
}

function rightClick(node) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  act(() => { node.dispatchEvent(event); });
  return event;
}

describe('when the menu is allowed to take the right-click', () => {
  it('leaves a right-click with nothing selected to the browser', async () => {
    const box = harness();
    typed(box, 'hello there', 5, 5);
    const event = rightClick(box);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menuitem', { name: /^Bold/ })).toBeNull();
  });

  it('takes a right-click on a selection, and says which chord does the same', async () => {
    const box = harness();
    typed(box, 'hello there', 0, 5);
    const event = rightClick(box);
    expect(event.defaultPrevented).toBe(true);
    const bold = await screen.findByRole('menuitem', { name: /^Bold/ });
    expect(bold.textContent).toMatch(/B$/);
    const strike = screen.getByRole('menuitem', { name: /^Strikethrough/ });
    expect(strike.textContent).toBe('Strikethrough');
  });

  it('offers every format, and the two clipboard actions it displaced', async () => {
    const box = harness();
    typed(box, 'hello there', 0, 5);
    rightClick(box);
    await screen.findByRole('menuitem', { name: /^Bold/ });
    for (const f of FORMATS) {
      const label = t(f.labelKey);
      expect(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) })).toBeTruthy();
    }
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Cut' })).toBeTruthy();
  });
});

describe('the two ways in agree', () => {
  it('formats the selection from the chord', async () => {
    const box = harness();
    typed(box, 'hello there', 0, 5);
    fireEvent.keyDown(box, { key: 'b', metaKey: true });
    await waitFor(() => expect(box.value).toBe('**hello** there'));
  });

  it('formats the selection from the menu, to the byte', async () => {
    const box = harness();
    typed(box, 'hello there', 0, 5);
    rightClick(box);
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Bold/ }));
    await waitFor(() => expect(box.value).toBe('**hello** there'));
  });

  it('takes the format off again from the menu, as the chord does', async () => {
    const box = harness();
    typed(box, '**hello** there', 0, 9);
    rightClick(box);
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Bold/ }));
    await waitFor(() => expect(box.value).toBe('hello there'));
  });

  it('applies a line format from the menu over the lines the selection touched', async () => {
    const box = harness();
    typed(box, 'one\ntwo\nthree', 0, 8);
    rightClick(box);
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Quote/ }));
    await waitFor(() => expect(box.value).toBe('> one\n> two\nthree'));
  });

  it('applies the format to the range the right-click caught, not to a lost one', async () => {
    const box = harness();
    typed(box, 'hello there', 0, 5);
    rightClick(box);
    const bold = await screen.findByRole('menuitem', { name: /^Bold/ });
    act(() => { box.setSelectionRange(11, 11); });
    fireEvent.click(bold);
    await waitFor(() => expect(box.value).toBe('**hello** there'));
  });
});

describe('ArrowUp in an empty composer', () => {
  it('opens the last message for editing and keeps the arrow out of the edit box', () => {
    const onEditLast = vi.fn();
    const box = harness({ onEditLast });
    const event = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    act(() => { box.dispatchEvent(event); });
    expect(onEditLast).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('a shortcode typed in full', () => {
  it('becomes the emoji as its second colon is typed', async () => {
    await loadEmoji();
    const box = harness();
    fireEvent.change(box, { target: { value: 'oh no :sob:', selectionStart: 11, selectionEnd: 11 } });
    await waitFor(() => expect(box.value).toBe('oh no 😭'));
  });
});
