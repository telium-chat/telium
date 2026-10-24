import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  ChoiceCard, ChoiceList, Field, MoonIcon, Section, Select, SunIcon, Switch,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { dateOrder, setLocale, translationStatus } from '../../lib/i18n/index.js';
import { loadCatalog } from '../../lib/i18n/catalog/index.js';
import { LOCALES, localeOptions, listLanguages } from '../../lib/i18n/locale.js';
import {
  PRESETS, RANGES, resolveScheme, schemeParams, schemePreview,
} from '../../lib/scheme.js';

function Swatch({ scheme }) {
  const { background, surface, accent } = schemePreview(scheme);
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {[background, surface, accent].map((colour, index) => (
        <span
          key={colour}
          className="size-4 rounded-full border border-border"
          style={{ backgroundColor: colour, marginInlineStart: index ? '-5px' : 0 }}
        />
      ))}
    </span>
  );
}

function Knob({
  label, hint, value, min, max, step, format, onChange,
}) {
  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm font-medium">{label}</span>
        <span className="tnum shrink-0 text-sm text-muted">{format(value)}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-4 w-full cursor-pointer accent-[var(--accent)]"
      />
      {hint ? <span className="text-xs leading-[1.5] text-muted">{hint}</span> : null}
    </div>
  );
}

function LanguageSection() {
  const t = useT();
  const store = useStore();
  const prefs = store.prefs;
  const [, bump] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all(LOCALES.filter((locale) => locale.load).map((locale) => loadCatalog(locale.tag).catch(() => null)))
      .then(() => { if (live) bump((n) => n + 1); });
    return () => { live = false; };
  }, []);

  const status = translationStatus();
  const started = status.filter((entry) => entry.translated > 0);
  const incomplete = started.filter((entry) => entry.translated < entry.total);
  const state = started.length === 0 ? 'none' : (incomplete.length ? 'partial' : 'complete');
  const named = (incomplete.length ? incomplete : started).map((entry) => entry.tag);

  const choose = (preference) => {
    prefs.locale = preference;
    store.savePrefs();
    setLocale(preference).then((active) => {
      if (preference !== 'auto' && active !== preference) {
        prefs.locale = 'auto';
        store.savePrefs();
      }
      bump((n) => n + 1);
    });
  };

  return (
    <Section title={t('settings.language.title')}>
      <Field
        label={t('settings.language.label')}
        hint={t('settings.language.hint', { state, languages: listLanguages(named) })}
      >
        <Select
          value={prefs.locale || 'auto'}
          options={localeOptions(t('settings.language.auto'))}
          onChange={(event) => choose(event.target.value)}
        />
      </Field>
    </Section>
  );
}

export function AppearancePane() {
  const t = useT();
  const store = useStore();
  const prefs = store.prefs;
  const [, bump] = useState(0);
  const set = (fn) => { fn(); store.savePrefs(); bump((n) => n + 1); };

  const scheme = resolveScheme(prefs.scheme, prefs.theme);
  const range = RANGES[scheme.mode];

  const percent = (value) => t('settings.scheme.reading.percent', { value });
  const degrees = (value) => t('settings.scheme.reading.degrees', { value });
  const amount = (value) => t('settings.scheme.reading.amount', { value });

  const choose = (id) => set(() => {
    const preset = PRESETS.find((entry) => entry.id === id);
    prefs.scheme = preset ? preset.id : schemeParams(scheme);
    prefs.theme = preset ? preset.mode : scheme.mode;
  });

  const tune = (patch) => set(() => {
    const next = schemeParams(resolveScheme({ ...schemeParams(scheme), ...patch }, prefs.theme));
    prefs.scheme = next;
    prefs.theme = next.mode;
  });

  return (
    <>
      <Section title={t('settings.theme.title')} description={t('settings.theme.description')}>
        <ChoiceList value={scheme.id} onChange={choose}>
          {PRESETS.map((preset) => (
            <ChoiceCard
              key={preset.id}
              value={preset.id}
              icon={preset.mode === 'light' ? SunIcon : MoonIcon}
              label={t(`settings.theme.preset.${preset.id}.name`)}
              description={t(`settings.theme.preset.${preset.id}.description`)}
              trailing={<Swatch scheme={preset} />}
            />
          ))}
          <ChoiceCard
            value="custom"
            icon={scheme.mode === 'light' ? SunIcon : MoonIcon}
            label={t('settings.theme.custom.label')}
            description={t('settings.theme.custom.description')}
            trailing={scheme.id === 'custom' ? <Swatch scheme={scheme} /> : null}
          />
        </ChoiceList>
      </Section>

      {scheme.id === 'custom' ? (
        <Section
          title={t('settings.scheme.title')}
          description={t('settings.scheme.description')}
        >
          <div className="divide-y divide-border panel px-3.5 py-1">
            <Field
              label={t('settings.scheme.mode.label')}
              hint={t('settings.scheme.mode.hint')}
            >
              <Select
                value={scheme.mode}
                options={[
                  ['dark', t('settings.scheme.mode.dark')],
                  ['light', t('settings.scheme.mode.light')],
                ]}
                onChange={(event) => tune({ mode: event.target.value })}
              />
            </Field>
            <Knob
              label={t('settings.scheme.depth.label')}
              hint={scheme.mode === 'dark'
                ? t('settings.scheme.depth.hintDark')
                : t('settings.scheme.depth.hintLight')}
              value={scheme.depth}
              min={range.depth[0]}
              max={range.depth[1]}
              step={0.5}
              format={percent}
              onChange={(depth) => tune({ depth })}
            />
            <Knob
              label={t('settings.scheme.separation.label')}
              hint={t('settings.scheme.separation.hint')}
              value={scheme.step}
              min={range.step[0]}
              max={range.step[1]}
              step={0.1}
              format={percent}
              onChange={(step) => tune({ step })}
            />
            <Knob
              label={t('settings.scheme.tint.label')}
              hint={t('settings.scheme.tint.hint')}
              value={scheme.chroma}
              min={RANGES.chroma[0]}
              max={RANGES.chroma[1]}
              step={0.001}
              format={(value) => (value ? amount(value) : t('settings.scheme.tint.none'))}
              onChange={(chroma) => tune({ chroma })}
            />
            <Knob
              label={t('settings.scheme.greyHue.label')}
              hint={t('settings.scheme.greyHue.hint')}
              value={scheme.hue}
              min={RANGES.hue[0]}
              max={RANGES.hue[1]}
              step={1}
              format={degrees}
              onChange={(hue) => tune({ hue })}
            />
            <Knob
              label={t('settings.scheme.accentHue.label')}
              hint={t('settings.scheme.accentHue.hint')}
              value={scheme.accentHue}
              min={RANGES.hue[0]}
              max={RANGES.hue[1]}
              step={1}
              format={degrees}
              onChange={(accentHue) => tune({ accentHue })}
            />
            <Knob
              label={t('settings.scheme.accentStrength.label')}
              value={scheme.accentChroma}
              min={RANGES.accentChroma[0]}
              max={RANGES.accentChroma[1]}
              step={0.005}
              format={amount}
              onChange={(accentChroma) => tune({ accentChroma })}
            />
          </div>
        </Section>
      ) : null}

      <LanguageSection />

      <Section title={t('settings.messages.title')}>
        <Field
          label={t('settings.messages.dateFormat.label')}
          hint={t('settings.messages.dateFormat.hint')}
        >
          <Select
            value={dateOrder(prefs.dateFormat)}
            options={[
              ['mdy', t('settings.messages.dateFormat.mdy')],
              ['dmy', t('settings.messages.dateFormat.dmy')],
            ]}
            onChange={(event) => set(() => { prefs.dateFormat = event.target.value; })}
          />
        </Field>
        <div className="divide-y divide-border panel px-3">
          <Switch
            label={t('settings.messages.compact.label')}
            hint={t('settings.messages.compact.hint')}
            checked={Boolean(prefs.compact)}
            onChange={(next) => set(() => { prefs.compact = next; })}
          />
          <Switch
            label={t('settings.messages.members.label')}
            hint={t('settings.messages.members.hint')}
            checked={prefs.members !== false}
            onChange={(next) => set(() => { prefs.members = next; })}
          />
          <Switch
            label={t('settings.messages.typing.label')}
            hint={t('settings.messages.typing.hint')}
            checked={prefs.typing !== false}
            onChange={(next) => set(() => { prefs.typing = next; })}
          />
        </div>
      </Section>
    </>
  );
}
