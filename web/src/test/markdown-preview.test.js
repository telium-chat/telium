import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewSpans } from '../lib/markdown-preview.js';

const painted = (text) => previewSpans(text).map((s) => [text.slice(s.start, s.end), s.kinds]);

const kindsOn = (text, needle) => {
  const at = text.indexOf(needle);
  const span = previewSpans(text).find((s) => s.start <= at && s.end > at);
  return span ? span.kinds : null;
};

function covers(text) {
  const spans = previewSpans(text);
  let at = 0;
  for (const span of spans) {
    expect(span.start).toBe(at);
    expect(span.end).toBeGreaterThan(span.start);
    at = span.end;
  }
  expect(at).toBe(text.length);
  expect(spans.map((s) => text.slice(s.start, s.end)).join('')).toBe(text);
}

describe('the covering invariant', () => {
  it('reproduces the input exactly, markers and all', () => {
    const texts = [
      '**bold**',
      'a *b* c',
      '> quoted **and bold**',
      '`code` and **bold** and ||spoiler||',
      '```js\nconst x = 1;\n```\nafter',
      '***all three*** and ~~gone~~',
      'https://a.example @bob #general',
      'line one\nline two\n\nline four',
      '\u{1F44B} caf\u00e9 na\u00efve \u4f60\u597d',
      '**\u{1F44B} bold emoji**',
      '*',
      '**',
      '```',
      '||',
      '> ',
      '\n\n\n',
      '   leading spaces',
      '_a_b_c_d_e_',
      '****',
      '`` `a` ``',
    ];
    for (const text of texts) covers(text);
  });

  it('answers with nothing for nothing, rather than a zero-width span', () => {
    expect(previewSpans('')).toEqual([]);
    expect(previewSpans(null)).toEqual([]);
    expect(previewSpans(undefined)).toEqual([]);
    expect(previewSpans(42)).toEqual([]);
    expect(previewSpans({})).toEqual([]);
  });

  it('cannot be made to throw by a half-typed marker', () => {
    const ugly = ['*', '**', '***', '_', '__', '~~', '||', '`', '``', '```', '> ', '>',
      '*`*`*', '**`**`**', '```\n`', '_'.repeat(200), '*'.repeat(200), '`'.repeat(200),
      '\u0000\u0001', '\\', '[](', '||||||'];
    for (const text of ugly) {
      expect(() => previewSpans(text)).not.toThrow();
      covers(text);
    }
  });
});

describe('emphasis', () => {
  it('paints the markers and the run they enclose', () => {
    expect(painted('**bold**')).toEqual([
      ['**', ['bold', 'marker']],
      ['bold', ['bold']],
      ['**', ['bold', 'marker']],
    ]);
  });

  it('carries several treatments on one character rather than nesting', () => {
    expect(kindsOn('***both***', 'both')).toEqual(['bold', 'italic']);
  });

  it('leaves arithmetic and bullets alone', () => {
    expect(painted('2 * 3 * 4')).toEqual([['2 * 3 * 4', []]]);
    expect(painted('* a bullet')).toEqual([['* a bullet', []]]);
  });

  it('keeps underscores out of the middle of a word', () => {
    expect(painted('snake_case_name')).toEqual([['snake_case_name', []]]);
  });

  it('stays bold through the space that was just typed inside it', () => {
    expect(kindsOn('**test **more', 'test ')).toEqual(['bold']);
  });

  it('leaves an opener with no closer at all as plain text', () => {
    expect(painted('**test ')).toEqual([['**test ', []]]);
  });

  it('paints strikethrough and spoilers', () => {
    expect(kindsOn('~~gone~~', 'gone')).toEqual(['strike']);
    expect(kindsOn('||secret||', 'secret')).toEqual(['spoiler']);
  });
});

describe('code', () => {
  it('wins over emphasis, because between backticks there is no markdown', () => {
    expect(painted('`**not bold**`')).toEqual([
      ['`', ['code', 'marker']],
      ['**not bold**', ['code']],
      ['`', ['code', 'marker']],
    ]);
  });

  it('cannot be reached into for the other half of a pair', () => {
    expect(kindsOn('*a`*`b', 'a')).toEqual([]);
  });

  it('lets a longer run hold a backtick of its own', () => {
    expect(kindsOn('`` `a` ``', ' `a` ')).toEqual(['code']);
  });

  it('leaves a run that never meets its match as plain text', () => {
    expect(painted('`unclosed')).toEqual([['`unclosed', []]]);
  });

  it('reads an unterminated fence as an open block to the end of the draft', () => {
    const text = '```js\nstill typing';
    expect(kindsOn(text, 'still typing')).toEqual(['codeblock']);
    expect(kindsOn(text, '```js')).toEqual(['codeblock', 'marker']);
  });

  it('keeps a block and an inline span as two different treatments', () => {
    expect(kindsOn('```\nx\n```', '\nx\n')).toEqual(['codeblock']);
    expect(kindsOn('`x`', 'x')).toEqual(['code']);
  });

  it('reads a fence with a twin on its own line as a one-liner', () => {
    expect(kindsOn('```like this```', 'like this')).toEqual(['code']);
  });
});

describe('quotes, links and names', () => {
  it('paints a quote over the whole line, marker included', () => {
    expect(painted('> quoted')).toEqual([
      ['> ', ['quote', 'marker']],
      ['quoted', ['quote']],
    ]);
  });

  it('paints a bare `>` on a line of its own, which is a quote being started', () => {
    expect(painted('>')).toEqual([['>', ['quote', 'marker']]]);
  });

  it('stops the quote at the newline', () => {
    expect(kindsOn('> quoted\nplain', 'plain')).toEqual([]);
  });

  it('tints a URL, and leaves handle-shaped prose as prose', () => {
    const text = 'see https://x.example/a and @bob in #general';
    expect(kindsOn(text, 'https://x.example/a')).toEqual(['link']);
    expect(kindsOn(text, '@bob')).toEqual([]);
    expect(kindsOn(text, '#general')).toEqual([]);
    expect(kindsOn('tell @everyone about it', '@everyone')).toEqual(['mention']);
    expect(kindsOn('an @everyone-ish opinion', '@everyone-ish')).toEqual([]);
  });

  it('leaves a URL inside code as the characters of a URL', () => {
    expect(kindsOn('`https://x.example`', 'https://x.example')).toEqual(['code']);
  });
});

describe('the ceiling', () => {
  it('gives up on a draft too long to be read as prose while it is typed', () => {
    const huge = `${'a *b* '.repeat(4000)}x`;
    expect(huge.length).toBeGreaterThan(20000);
    expect(previewSpans(huge)).toEqual([{ start: 0, end: huge.length, kinds: [] }]);
  });

  it('still scans a draft just under it', () => {
    const big = `${'a'.repeat(19990)}**b**`;
    expect(kindsOn(big, '**b**')).toEqual(['bold', 'marker']);
  });
});

describe('the module itself', () => {
  it('imports nothing', () => {
    const source = readFileSync(join(import.meta.dirname, '../lib/markdown-preview.js'), 'utf8');
    expect(source).not.toMatch(/^\s*import[\s{'"*]/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});
