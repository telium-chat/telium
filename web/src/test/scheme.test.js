import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MIN_CONTRAST, PRESETS, RANGES, SCHEME_TOKENS,
  applyScheme, contrast, resolveScheme, schemeParams, schemeRamp, schemeVars,
} from '../lib/scheme.js';

const SURFACES = [
  'background', 'background-secondary', 'surface', 'surface-secondary',
  'surface-tertiary', 'overlay', 'rail', 'rail-hover', 'rail-active', 'strip',
];

const HUE_STEP = 10;
const DEPTH_STEPS = 10;
const STEP_STEPS = 8;
const CHROMAS = [0, 0.01, 0.02, 0.03];

function* space(mode) {
  const range = RANGES[mode];
  for (let hue = 0; hue < 360; hue += HUE_STEP) {
    for (const chroma of CHROMAS) {
      for (let d = 0; d <= DEPTH_STEPS; d += 1) {
        const depth = range.depth[0] + ((range.depth[1] - range.depth[0]) * d) / DEPTH_STEPS;
        for (let s = 0; s <= STEP_STEPS; s += 1) {
          const step = range.step[0] + ((range.step[1] - range.step[0]) * s) / STEP_STEPS;
          yield {
            mode, hue, chroma, depth, step, accentHue: hue, accentChroma: 0.19,
          };
        }
      }
    }
  }
}

function worstCase(mode) {
  let worst = { ratio: Infinity };
  const note = (ratio, pair, scheme) => {
    if (ratio < worst.ratio) worst = { ratio, pair, scheme };
  };
  for (const scheme of space(mode)) {
    const ramp = schemeRamp(scheme);
    for (const surface of SURFACES) {
      note(contrast(ramp.foreground, ramp[surface]), `foreground on ${surface}`, scheme);
    }
    note(contrast(ramp.muted, ramp.background), 'muted on background', scheme);
    note(
      contrast({ l: 99, c: 0.01, h: scheme.accentHue }, ramp['accent-solid']),
      'accent-solid-foreground on accent-solid',
      scheme,
    );
  }
  return worst;
}

describe('the scheme parameter space', () => {
  for (const mode of ['dark', 'light']) {
    it(`keeps every ${mode} scheme the sliders can reach above 4.5:1`, () => {
      const worst = worstCase(mode);
      expect(
        worst.ratio,
        `worst ${mode} pair is ${worst.pair} at ${worst.ratio.toFixed(2)}:1, `
        + `from ${JSON.stringify(worst.scheme)}`,
      ).toBeGreaterThanOrEqual(MIN_CONTRAST);
    });
  }

  it('keeps every shipped preset above the threshold too', () => {
    for (const preset of PRESETS) {
      const ramp = schemeRamp(preset);
      for (const surface of SURFACES) {
        expect(contrast(ramp.foreground, ramp[surface]), `${preset.id}: foreground on ${surface}`)
          .toBeGreaterThanOrEqual(MIN_CONTRAST);
      }
      expect(contrast(ramp.muted, ramp.background), `${preset.id}: muted on background`)
        .toBeGreaterThanOrEqual(MIN_CONTRAST);
    }
  });
});

describe('what prefs can say', () => {
  it('falls back to the mode\'s shipped scheme rather than to half a palette', () => {
    for (const stored of [undefined, null, 'aquamarine', 42, [], {}, { mode: 'dark' }, { hue: NaN }]) {
      expect(schemeVars(resolveScheme(stored, 'dark'))).toBeNull();
      expect(schemeVars(resolveScheme(stored, 'light'))).toBeNull();
    }
  });

  it('clamps a scheme that asks for more than the sliders offer', () => {
    const wild = resolveScheme({
      mode: 'dark', hue: 1000, chroma: 9, depth: -40, step: 400, accentHue: -30, accentChroma: 5,
    }, 'dark');
    expect(wild.hue).toBe(280);
    expect(wild.accentHue).toBe(330);
    expect(wild.chroma).toBe(RANGES.chroma[1]);
    expect(wild.depth).toBe(RANGES.dark.depth[0]);
    expect(wild.step).toBe(RANGES.dark.step[1]);
    expect(wild.accentChroma).toBe(RANGES.accentChroma[1]);
  });

  it('is small enough to seal and push', () => {
    const stored = schemeParams(resolveScheme('evergreen', 'dark'));
    expect(Object.keys(stored)).toHaveLength(7);
    expect(JSON.stringify(stored).length).toBeLessThan(120);
  });
});

describe('applying one', () => {
  let root;
  beforeEach(() => {
    root = document.documentElement;
    root.removeAttribute('style');
    delete root.dataset.scheme;
  });

  it('leaves the page to palette.css for the two it already states', () => {
    applyScheme(root, resolveScheme('graphite', 'dark'));
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.scheme).toBeUndefined();
    expect(root.getAttribute('style')).toBeFalsy();
  });

  it('clears every token of the last scheme before writing the next', () => {
    applyScheme(root, resolveScheme('evergreen', 'dark'));
    expect(root.dataset.scheme).toBe('evergreen');
    expect(root.style.getPropertyValue('--background')).toMatch(/^oklch\(/);

    applyScheme(root, resolveScheme('paper', 'light'));
    expect(root.dataset.theme).toBe('light');
    expect(root.dataset.scheme).toBeUndefined();
    for (const token of SCHEME_TOKENS) {
      expect(root.style.getPropertyValue(`--${token}`), token).toBe('');
    }
  });
});

const paletteCss = readFileSync(`${process.cwd()}/src/palette.css`, 'utf8');

function paletteBlock(selector) {
  const start = paletteCss.indexOf(selector);
  const body = paletteCss.slice(start, paletteCss.indexOf('\n}', start));
  const out = {};
  for (const [, token, value] of body.matchAll(/^\s*(--[a-z-]+):\s*([^;]+);/gm)) out[token] = value;
  return out;
}

describe('palette.css and the generator', () => {
  const RAMP_TOKENS = SCHEME_TOKENS.filter((token) => !token.startsWith('accent'));

  for (const [id, selector] of [['graphite', ':root.dark'], ['paper', ':root,']]) {
    it(`states ${id} exactly as the generator would`, () => {
      const preset = PRESETS.find((entry) => entry.id === id);
      expect(preset.native, `${id} must be native or this comparison means nothing`).toBe(true);
      const written = paletteBlock(selector);
      const generated = schemeVars({ ...preset, native: false });
      for (const token of RAMP_TOKENS) {
        expect(written[`--${token}`], `${id} --${token}`).toBe(generated[`--${token}`]);
      }
    });
  }
});
