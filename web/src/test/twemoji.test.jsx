import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EmojiText, Twemoji } from '../components/index.js';

describe('Twemoji', () => {
  it('draws the asset for the emoji, named by the emoji', () => {
    render(<Twemoji emoji={'\u{1F44B}'} />);

    const img = screen.getByRole('img', { name: '\u{1F44B}' });
    expect(img.getAttribute('src').endsWith('/1f44d.svg')).toBe(false);
    expect(img.getAttribute('src').endsWith('/1f44b.svg')).toBe(true);
  });

  it('is not draggable, since dragging an emoji out of a message is not a gesture', () => {
    render(<Twemoji emoji={'\u{1F44B}'} />);
    expect(screen.getByRole('img', { name: '\u{1F44B}' }).draggable).toBe(false);
  });

  it('falls back to the platform glyph when the asset is missing', () => {
    const { container } = render(<Twemoji emoji={'\u{1FAE9}'} />);

    fireEvent.error(container.querySelector('img'));

    expect(container.querySelector('img')).toBe(null);
    expect(container.textContent).toBe('\u{1FAE9}');
  });
});

describe('EmojiText', () => {
  it('replaces the emoji in a line and keeps the words between them', () => {
    const { container } = render(<EmojiText>{'hi \u{1F44B} there \u{1F389}'}</EmojiText>);

    const alts = [...container.querySelectorAll('img')].map((img) => img.alt);
    expect(alts).toEqual(['\u{1F44B}', '\u{1F389}']);
    expect(container.textContent).toBe('hi  there ');
  });

  it('leaves a line with no emoji as plain text', () => {
    const { container } = render(<EmojiText>just words</EmojiText>);

    expect(container.querySelector('img')).toBe(null);
    expect(container.textContent).toBe('just words');
  });

  it('leaves the punctuation that only technically is emoji alone', () => {
    const { container } = render(<EmojiText>{'\u00a9 \u2122 Telium'}</EmojiText>);
    expect(container.querySelector('img')).toBe(null);
  });

  it('keeps a ZWJ sequence as one image rather than its pieces', () => {
    const { container } = render(<EmojiText>{'\u{1F469}\u200D\u{1F4BB}'}</EmojiText>);
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders nothing for nothing, and passes a non-string through', () => {
    expect(render(<EmojiText>{''}</EmojiText>).container.textContent).toBe('');
    expect(render(<EmojiText>{null}</EmojiText>).container.textContent).toBe('');
    expect(render(<EmojiText><b>bold</b></EmojiText>).container.textContent).toBe('bold');
  });
});
