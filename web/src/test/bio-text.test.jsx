import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BioText } from '../components/index.js';
import { BIO_MAX_FALLBACK, clampBio } from '../lib/bio.js';

const draw = (text) => render(<BioText>{text}</BioText>).container;

describe('bio rendering', () => {
  it('gives a bio the emphasis a person explaining themselves needs', () => {
    const el = draw('**Maths** and *cats*, ~~briefly~~, in `lambda`.');
    expect(el.querySelector('strong')?.textContent).toBe('Maths');
    expect(el.querySelector('em')?.textContent).toBe('cats');
    expect(el.querySelector('s')?.textContent).toBe('briefly');
    expect(el.querySelector('code')?.textContent).toBe('lambda');
  });

  it('draws unicode emoji as pictures but leaves custom emoji as text', () => {
    const el = draw('cats 🐈 and <partyparrot:01H0000000000000000000000@evil.example>');
    const images = [...el.querySelectorAll('img')];
    expect(images.map((i) => i.getAttribute('alt'))).toEqual(['🐈']);
    expect(el.textContent).toContain('<partyparrot:01H0000000000000000000000@evil.example>');
    expect(el.innerHTML).not.toContain('evil.example/_telium');
  });

  it('keeps guild-shaped tokens as the characters that were typed', () => {
    const el = draw('ping <@&01H0000000000000000000000> in <#01H0000000000000000000001> @everyone');
    expect(el.querySelector('.mention')).toBeNull();
    expect(el.textContent).toContain('@everyone');
  });

  it('autolinks a URL that was typed out in full, and shows where it goes', () => {
    const el = draw('see https://example.com/a-page, really');
    const link = el.querySelector('a');
    expect(link.getAttribute('href')).toBe('https://example.com/a-page');
    expect(link.getAttribute('rel')).toContain('nofollow');
    expect(el.textContent).toContain(', really');
  });

  it('leaves a masked link as the characters somebody typed', () => {
    const el = draw('[PayPal](https://evil.example)');
    expect([...el.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['evil.example']);
    expect(el.textContent).toContain('[PayPal](');
  });

  it('renders a bio from a laxer server rather than refusing it', () => {
    const el = draw('x'.repeat(BIO_MAX_FALLBACK * 3));
    expect(el.textContent.length).toBeLessThanOrEqual(BIO_MAX_FALLBACK);
    expect(el.textContent.endsWith('…')).toBe(true);
  });
});

describe('clampBio', () => {
  it('leaves a bio inside the limit exactly as it was written', () => {
    expect(clampBio('A short bio.', 100)).toBe('A short bio.');
  });

  it('never returns more characters than it was asked for', () => {
    expect(Array.from(clampBio('a'.repeat(50), 10)).length).toBe(10);
  });

  it('breaks between words when a word boundary is close behind', () => {
    expect(clampBio('number theory and the occasional cat', 20)).toBe('number theory and…');
  });

  it('cuts mid-run rather than throw away a whole line to a distant space', () => {
    expect(clampBio(`hi ${'z'.repeat(60)}`, 20)).toBe(`hi ${'z'.repeat(16)}…`);
  });

  it('cuts between characters, not through one', () => {
    const cut = clampBio('👩‍🚀🐈🐈🐈🐈🐈', 4);
    expect(cut).not.toContain('�');
    expect(cut.endsWith('…')).toBe(true);
  });

  it('is a no-op on the values a missing profile hands it', () => {
    expect(clampBio(null, 10)).toBe('');
    expect(clampBio(undefined, 10)).toBe('');
  });
});
