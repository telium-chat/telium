// A scheme is six numbers (page lightness, step, grey hue and chroma, accent hue and chroma); the ramp is derived and layered over `palette.css`. Ranges are clamps that keep text legible; `test/scheme.test.js` sweeps them.

/// Dark and light lift differently (on light, `--surface` is above the page and `--surface-tertiary` below), so two tables.
const RAMPS = {
  dark: {
    background: [0, 1],
    'background-secondary': [0.75, 1.1],
    surface: [1.25, 1.15],
    'surface-secondary': [2.25, 1.3],
    'surface-tertiary': [3.25, 1.4],
    overlay: [1.25, 1.15],
    border: [2.5, 0.9],
    'border-secondary': [2, 0.85],
    separator: [2.25, 0.9],
    rail: [-0.75, 0.9],
    'rail-hover': [0.5, 1.1],
    'rail-active': [1.75, 1.25],
    strip: [-1.25, 0.85],
  },
  light: {
    background: [0, 1],
    'background-secondary': [-0.4, 1.2],
    surface: [1, 0.3],
    'surface-secondary': [0.25, 0.8],
    'surface-tertiary': [-0.5, 1.15],
    overlay: [1.1, 0.2],
    border: [-0.675, 0.85],
    'border-secondary': [-0.1, 0.65],
    separator: [-0.35, 0.8],
    rail: [-0.35, 1.15],
    'rail-hover': [-0.9, 1.45],
    'rail-active': [-1.6, 1.85],
    strip: [-0.95, 1.5],
  },
};

/// Ink does not ride the ramp: a deeper background must not buy darker text.
const INK = {
  dark: { foreground: [94.5, 0.5], muted: [70, 0.9] },
  light: { foreground: [24, 2.5], muted: [50, 1.6] },
};

/// The solid fill is solved below, since a dark theme's link colour is too light to carry ink on a button.
const ACCENTS = {
  dark: { accent: [71, 1], 'accent-solid': [56, 1.15] },
  light: { accent: [38.5, 1], 'accent-solid': [38.5, 1] },
};

/// Ink on the solid fill as `scheme.css` derives it; keep them equal.
const FILL_INK = { l: 99, c: 0.01 };

/// `step` is capped so `--surface-tertiary` never eats the ink's contrast.
export const RANGES = {
  dark: { depth: [0, 21], step: [2.4, 5.2] },
  light: { depth: [92, 98], step: [2.4, 5.2] },
  chroma: [0, 0.03],
  hue: [0, 360],
  accentChroma: [0.02, 0.19],
};

export const MIN_CONTRAST = 4.5;
const TARGET_CONTRAST = 4.65;

export const SCHEME_TOKENS = [
  ...Object.keys(RAMPS.dark),
  ...Object.keys(INK.dark),
  ...Object.keys(ACCENTS.dark),
  'unread',
];

const clamp = (value, [lo, hi]) => Math.min(hi, Math.max(lo, value));
const wrap = (value) => ((value % 360) + 360) % 360;

/// `native` marks the two schemes `palette.css` states in full. `id` is also the catalogue key in `settings.theme.preset.<id>`.
export const PRESETS = [
  {
    id: 'graphite',
    native: true,
    mode: 'dark',
    hue: 286,
    chroma: 0.005,
    depth: 15.5,
    step: 4,
    accentHue: 302,
    accentChroma: 0.145,
  },
  {
    id: 'obsidian',
    mode: 'dark',
    hue: 264,
    chroma: 0,
    depth: 0,
    step: 3.2,
    accentHue: 264,
    accentChroma: 0.16,
  },
  {
    id: 'ash',
    mode: 'dark',
    hue: 75,
    chroma: 0.009,
    depth: 21,
    step: 4.2,
    accentHue: 45,
    accentChroma: 0.13,
  },
  {
    id: 'midnight',
    mode: 'dark',
    hue: 296,
    chroma: 0.024,
    depth: 19.5,
    step: 4,
    accentHue: 302,
    accentChroma: 0.145,
  },
  {
    id: 'evergreen',
    mode: 'dark',
    hue: 158,
    chroma: 0.014,
    depth: 16.5,
    step: 4,
    accentHue: 152,
    accentChroma: 0.12,
  },
  {
    id: 'paper',
    native: true,
    mode: 'light',
    hue: 298,
    chroma: 0.014,
    depth: 95.2,
    step: 4,
    accentHue: 295,
    accentChroma: 0.136,
  },
];

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]));

export const DEFAULT_SCHEME = { light: 'paper', dark: 'graphite' };

const KNOBS = ['hue', 'chroma', 'depth', 'step', 'accentHue', 'accentChroma'];

/// Custom params need all six knobs and a mode, else the default applies: filling holes silently would paint a palette nobody chose.
export function resolveScheme(stored, theme) {
  const fallback = BY_ID.get(DEFAULT_SCHEME[theme === 'light' ? 'light' : 'dark']);
  if (typeof stored === 'string') return BY_ID.get(stored) || fallback;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return fallback;
  if (stored.mode !== 'light' && stored.mode !== 'dark') return fallback;
  if (KNOBS.some((knob) => typeof stored[knob] !== 'number' || !Number.isFinite(stored[knob]))) {
    return fallback;
  }

  const { mode } = stored;
  const range = RANGES[mode];
  return {
    id: 'custom',
    mode,
    hue: wrap(stored.hue),
    chroma: clamp(stored.chroma, RANGES.chroma),
    depth: clamp(stored.depth, range.depth),
    step: clamp(stored.step, range.step),
    accentHue: wrap(stored.accentHue),
    accentChroma: clamp(stored.accentChroma, RANGES.accentChroma),
  };
}

export function schemeParams(scheme) {
  const {
    mode, hue, chroma, depth, step, accentHue, accentChroma,
  } = scheme;
  return {
    mode, hue, chroma, depth, step, accentHue, accentChroma,
  };
}

const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const css = (l, c, h) => `oklch(${round(l, 2)}% ${round(c, 4)} ${round(h, 1)})`;

export function schemeRamp(scheme) {
  const ramp = RAMPS[scheme.mode];
  const ink = INK[scheme.mode];
  const accents = ACCENTS[scheme.mode];
  const out = {};

  for (const [token, [lift, tint]] of Object.entries(ramp)) {
    out[token] = {
      l: clamp(scheme.depth + lift * scheme.step, [0, 100]),
      c: scheme.chroma * tint,
      h: scheme.hue,
    };
  }
  for (const [token, [l, tint]] of Object.entries(ink)) {
    out[token] = { l, c: scheme.chroma * tint, h: scheme.hue };
  }
  for (const [token, [l, tint]] of Object.entries(accents)) {
    out[token] = { l, c: scheme.accentChroma * tint, h: scheme.accentHue };
  }

  // Equal OKLCH lightness isn't equal brightness across hues: walk the fill down until its label clears the contrast line.
  const fillInk = { ...FILL_INK, h: scheme.accentHue };
  while (
    out['accent-solid'].l > 40
    && contrast(fillInk, out['accent-solid']) < TARGET_CONTRAST
  ) {
    out['accent-solid'].l -= 0.5;
  }

  // Written out, not aliased: a `var()` chain on the root would resolve against the previous scheme.
  out.unread = out.foreground;
  return out;
}

export function schemeVars(scheme) {
  if (scheme.native) return null;
  const ramp = schemeRamp(scheme);
  const vars = {};
  for (const [token, { l, c, h }] of Object.entries(ramp)) {
    vars[`--${token}`] = css(l, c, h);
  }
  return vars;
}

export function schemePreview(scheme) {
  const ramp = schemeRamp(scheme);
  const at = ({ l, c, h }) => css(l, c, h);
  return {
    background: at(ramp.background),
    surface: at(ramp['surface-secondary']),
    accent: at(ramp.accent),
  };
}

export function applyScheme(root, scheme) {
  const vars = schemeVars(scheme);
  root.dataset.theme = scheme.mode;
  for (const token of SCHEME_TOKENS) root.style.removeProperty(`--${token}`);
  if (!vars) {
    delete root.dataset.scheme;
    return;
  }
  root.dataset.scheme = scheme.id;
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

// OKLCH is converted to sRGB and clipped, which matches browser gamut-mapping at neutral-ramp chroma.

const encode = (u) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);

export function oklchToRgb({ l, c, h }) {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const lightness = l / 100;
  const long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ].map((channel) => Math.min(1, Math.max(0, encode(Math.max(0, channel)))));
}

const luminanceRgb = ([r, g, b]) => {
  const linear = [r, g, b].map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const luminance = (colour) => luminanceRgb(oklchToRgb(colour));

export function contrastRgb(a, b) {
  const first = luminanceRgb(a);
  const second = luminanceRgb(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

export function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
