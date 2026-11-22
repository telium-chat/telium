import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  Field, Section, Select, Switch,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { dateOrder, setLocale, translationStatus } from '../../lib/i18n/index.js';
import { loadCatalog } from '../../lib/i18n/catalog/index.js';
import { LOCALES, localeOptions, listLanguages } from '../../lib/i18n/locale.js';
import { PRESETS } from '../../lib/scheme.js';
import { ThemeMarketplaceSection } from './ThemeMarketplaceSection.jsx';

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

  // A marketplace theme owns the palette while it is on: the included themes
  // are display-only until it is deactivated.
  const marketThemeOn = Boolean(prefs.marketTheme);
  const activeId = PRESETS.some((preset) => preset.id === prefs.scheme) ? prefs.scheme : PRESETS[0].id;

  const choose = (id) => {
    if (marketThemeOn) return;
    set(() => {
      const preset = PRESETS.find((entry) => entry.id === id);
      if (preset) {
        prefs.scheme = preset.id;
        prefs.theme = preset.mode;
      }
    });
  };

  return (
    <>
      <ThemeMarketplaceSection
        base={PRESETS}
        baseActiveId={activeId}
        baseLocked={marketThemeOn}
        onChooseBase={choose}
      />

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
          <Switch
            label={t('settings.messages.gifFavorites.label')}
            hint={t('settings.messages.gifFavorites.hint')}
            checked={Boolean(prefs.gifOpensFavorites)}
            onChange={(next) => set(() => { prefs.gifOpensFavorites = next; })}
          />
        </div>
      </Section>
    </>
  );
}
