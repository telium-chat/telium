import { beforeAll, describe, expect, it } from 'vitest';
import { expandShortcodes, loadEmoji, mayHoldShortcode, shortcodeBefore } from '../lib/emoji.js';

beforeAll(() => loadEmoji());

describe('expanding shortcodes', () => {
  it('turns every alias it knows into the emoji', () => {
    expect(expandShortcodes('crying :sob: and :eyes:')).toBe('crying 😭 and 👀');
    expect(expandShortcodes(':loudly_crying_face::skull:')).toBe('😭💀');
    expect(expandShortcodes(':SOB:')).toBe('😭');
  });

  it('leaves names it does not know, clocks and code alone', () => {
    expect(expandShortcodes(':notanemoji:')).toBe(':notanemoji:');
    expect(expandShortcodes('at 12:30:45')).toBe('at 12:30:45');
    expect(expandShortcodes('say `:sob:` like this')).toBe('say `:sob:` like this');
  });

  it('does not touch a custom emoji token', () => {
    const token = '<blob:01HZZZZZZZZZZZZZZZZZZZZZZZ>';
    expect(expandShortcodes(`${token} :fire:`)).toBe(`${token} 🔥`);
  });

  it('knows when a text is worth checking', () => {
    expect(mayHoldShortcode('hi :sob:')).toBe(true);
    expect(mayHoldShortcode('hi there')).toBe(false);
  });
});

describe('the shortcode the caret just closed', () => {
  it('finds it as the second colon lands', () => {
    expect(shortcodeBefore('oh no :sob:', 11)).toEqual({ from: 6, to: 11, unicode: '😭' });
  });

  it('finds nothing while the name is still open, or after a word', () => {
    expect(shortcodeBefore('oh no :sob', 10)).toBe(null);
    expect(shortcodeBefore('a:sob:', 6)).toBe(null);
    expect(shortcodeBefore('`:sob:`', 6)).toBe(null);
  });
});
