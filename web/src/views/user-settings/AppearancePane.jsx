import { useStore } from '../../hooks/useStore.jsx';
import { PRESETS } from '../../lib/scheme.js';
import { usableTheme } from '../../lib/themes.js';
import { ThemeMarketplaceSection } from './ThemeMarketplaceSection.jsx';

export function AppearancePane() {
  const store = useStore();
  const prefs = store.prefs;

  // A marketplace theme owns the palette while it is on — "on" meaning its
  // CSS is actually on this device. A synced id whose CSS went missing (a
  // fresh install, a wiped browser) must not lock the included themes: the
  // honest state is "nothing applied", so they stay clickable.
  // A theme the network policy refuses is not applied either, so it must not
  // lock anything.
  const marketThemeUsable = Boolean(prefs.marketTheme) && Boolean(usableTheme(prefs.marketTheme));
  const marketThemeOn = Boolean(prefs.marketTheme) && marketThemeUsable;
  const activeId = PRESETS.some((preset) => preset.id === prefs.scheme) ? prefs.scheme : PRESETS[0].id;

  const choose = (id) => {
    if (marketThemeOn) return;
    const preset = PRESETS.find((entry) => entry.id === id);
    if (preset) {
      // Picking an included theme also clears a stale synced theme id, so a
      // missing-CSS ghost can never linger and lock anything again.
      prefs.scheme = preset.id;
      prefs.theme = preset.mode;
      prefs.marketTheme = null;
      store.savePrefs();
    }
  };

  return (
    <ThemeMarketplaceSection
      base={PRESETS}
      baseActiveId={activeId}
      baseLocked={marketThemeOn}
      onChooseBase={choose}
    />
  );
}
