import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  AsyncButton, Button, Notice, SearchField, Section, StarIcon, TrashIcon,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { cn } from '../../lib/cn.js';
import {
  THEME_ERRORS, THEMES_SUBMIT_URL, cachedCatalog, downloadTheme, favoriteIds, formatDownloads,
  installedTheme, installedThemeIds, localInstallCount, noteLocalInstall, refreshThemes,
  refreshThemesIfStale, removeTheme, searchThemes, toggleFavorite, trendingThemes, TRENDING,
} from '../../lib/themes.js';
import { schemePreview } from '../../lib/scheme.js';

function Thumb({ name, thumbnailUrl }) {
  const [failed, setFailed] = useState(false);
  const classes = 'aspect-video w-full rounded-md border border-border bg-rail object-cover';
  if (!thumbnailUrl || failed) {
    return (
      <div className={cn(classes, 'grid place-items-center')} aria-hidden>
        <span className="text-xl font-bold text-muted">{name.slice(0, 1).toUpperCase()}</span>
      </div>
    );
  }
  return (
    <img
      src={thumbnailUrl}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className={classes}
      onError={() => setFailed(true)}
    />
  );
}

function FavoriteButton({ favorited, label, onClick }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={favorited}
      onClick={onClick}
      className={cn(
        'pointer-events-auto absolute end-1.5 top-1.5 grid size-7 place-items-center rounded-md border',
        favorited
          ? 'border-accent/40 bg-surface text-accent'
          : 'border-border bg-surface/90 text-foreground/70 hover:text-foreground',
      )}
    >
      <StarIcon className={cn('size-4', favorited && 'fill-current')} />
    </button>
  );
}

/// Determinate when the server sent Content-Length, a gentle pulse while the
/// length is unknown — either way, visible: a silent Install button reads as
/// a frozen pane.
function DownloadBar({ progress, t }) {
  const pct = progress.total
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  return (
    <div
      className="flex flex-col gap-1"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-label={t('settings.market.downloading')}
    >
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-rail">
        {pct != null ? (
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
        ) : (
          <div className="h-full w-1/3 rounded-full bg-accent animate-pulse" />
        )}
      </div>
      <span className="text-xs text-muted">
        {t('settings.market.downloading')}
        {pct != null ? ` ${pct}%` : ''}
      </span>
    </div>
  );
}

function ThemeCard({
  theme, state, trending, favorited, locked, progress, t,
  onApply, onDeactivate, onInstall, onRemove, onToggleFavorite,
}) {
  const installed = state !== 'none';
  return (
    <div
      className={cn(
        'relative flex flex-col gap-2 rounded-xl border border-border bg-surface p-3',
        state === 'active' && 'border-accent/60 ring-1 ring-accent',
      )}
    >
      <FavoriteButton
        favorited={favorited}
        label={t(favorited ? 'settings.market.unfavorite' : 'settings.market.favorite', { name: theme.name })}
        onClick={onToggleFavorite}
      />
      <Thumb name={theme.name} thumbnailUrl={theme.thumbnailUrl} />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{theme.name}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {trending ? (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
              {t('settings.market.trending')}
            </span>
          ) : null}
          <span className="tnum text-xs text-muted">
            {t('settings.market.downloads', { count: formatDownloads(theme.downloads) })}
          </span>
        </span>
      </div>
      <div className="truncate text-xs text-muted">
        {theme.author}
        {theme.version ? ` · v${theme.version}` : ''}
      </div>
      <p className="line-clamp-2 text-xs leading-[1.5] text-muted">{theme.description}</p>
      {/* The bar belongs to a download in flight only: an installed or active
          card must never wear one, whatever raced above it. */}
      {progress && state === 'none' ? <DownloadBar progress={progress} t={t} /> : null}
      <div className="mt-auto flex items-center gap-1.5">
        {state === 'active' ? (
          <Button variant="primary" size="sm" className="grow" title={t('settings.market.activeHint')} onClick={onDeactivate}>
            {t('settings.market.active')}
          </Button>
        ) : installed ? (
          <AsyncButton size="sm" className="grow" onClick={onApply}>{t('settings.market.apply')}</AsyncButton>
        ) : (
          <AsyncButton variant="primary" size="sm" className="grow" onClick={onInstall}>
            {t('settings.market.install')}
          </AsyncButton>
        )}
        {installed && state !== 'active' ? (
          <Button size="sm" shape="square" aria-label={t('settings.market.remove')} onClick={onRemove}>
            <TrashIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/// Base themes wear the same card shape; their preview is drawn from the
/// scheme's own colors instead of a downloaded thumbnail.
function BaseCard({ preset, active, locked, t, onChoose }) {
  const { background, surface, accent } = schemePreview(preset);
  const name = t(`settings.theme.preset.${preset.id}.name`);
  return (
    <button
      type="button"
      onClick={onChoose}
      disabled={locked}
      aria-pressed={active}
      title={t(`settings.theme.preset.${preset.id}.description`)}
      className={cn(
        'relative flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-start transition-opacity hover:border-accent/50 disabled:pointer-events-none disabled:opacity-60',
        active && 'border-accent/60 ring-1 ring-accent',
      )}
    >
      <span
        aria-hidden
        className="relative block aspect-video w-full overflow-hidden rounded-md border border-border"
        style={{ backgroundColor: background }}
      >
        <span className="absolute left-2 top-2 h-7 w-[70%] rounded-md" style={{ backgroundColor: surface }} />
        <span className="absolute left-2 top-11 h-2.5 w-[85%] rounded-full opacity-70" style={{ backgroundColor: surface }} />
        <span className="absolute left-2 top-15 h-2.5 w-[60%] rounded-full opacity-70" style={{ backgroundColor: surface }} />
        <span className="absolute bottom-2 left-2 h-3 w-9 rounded-full" style={{ backgroundColor: accent }} />
        <span className="absolute bottom-2 right-2 size-4 rounded-full" style={{ backgroundColor: accent, opacity: 0.55 }} />
      </span>
      <span className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{name}</span>
        {active ? (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
            {t('settings.theme.baseActive')}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-muted">
            {t(preset.mode === 'light' ? 'settings.scheme.mode.light' : 'settings.scheme.mode.dark')}
          </span>
        )}
      </span>
      <span className="line-clamp-2 text-xs leading-[1.5] text-muted">
        {t(`settings.theme.preset.${preset.id}.description`)}
      </span>
    </button>
  );
}

const FILTERS = ['all', 'trending', 'favorites'];

export function ThemeMarketplaceSection({ base = [], baseActiveId = null, baseLocked = false, onChooseBase = null }) {
  const t = useT();
  const store = useStore();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [catalog, setCatalog] = useState(() => cachedCatalog());
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useStoreEvent('prefs');

  const load = () => {
    setError(null);
    refreshThemesIfStale()
      .then((parsed) => {
        if (!mounted.current) return;
        setCatalog(parsed || cachedCatalog());
        if (!parsed && !cachedCatalog()) setError(true);
      })
      .catch(() => {
        if (mounted.current) setError(true);
      });
  };
  useEffect(load, []);

  const favorites = favoriteIds(store.prefs);
  const activeId = store.prefs.marketTheme || null;
  // "On" means the CSS is on this device. A synced id without its file is a
  // ghost: nothing is applied, the included themes stay usable, and the card
  // shows Install so the file can come back.
  const marketUsable = activeId ? installedTheme(activeId) : null;
  const marketName = marketUsable?.meta?.name
    || catalog?.themes?.find((entry) => entry.id === activeId)?.name
    || activeId;
  // A catalog smaller than one page is all "top" — trending means nothing
  // until there are more themes than a week can show, so it stays hidden.
  const showTrending = (catalog?.themes?.length || 0) > TRENDING.page;
  const trending = useMemo(
    () => new Set(showTrending ? trendingThemes(catalog).map((theme) => theme.id) : []),
    [catalog, showTrending],
  );
  const filters = showTrending ? FILTERS : FILTERS.filter((name) => name !== 'trending');

  const community = useMemo(() => {
    const found = searchThemes(catalog, query);
    const week = found.filter((theme) => trending.has(theme.id));
    const rest = found.filter((theme) => !trending.has(theme.id));
    const ordered = [...week, ...rest];
    if (filter === 'trending') return { week, rest: [] };
    if (filter === 'favorites') {
      return { week: [], rest: ordered.filter((theme) => favorites.includes(theme.id)) };
    }
    return { week, rest };
  }, [catalog, query, filter, favorites, trending]);

  const baseList = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = base.filter((preset) => {
      if (!needle) return true;
      const name = t(`settings.theme.preset.${preset.id}.name`).toLowerCase();
      return name.includes(needle) || preset.mode.includes(needle);
    });
    if (filter !== 'all') return [];
    return list;
  }, [base, query, filter, t]);

  const nothing = !error
    && (catalog || filter !== 'all')
    && community.week.length === 0
    && community.rest.length === 0
    && (filter === 'all' ? baseList.length === 0 : true)
    && (filter !== 'favorites' || favorites.length > 0);

  const apply = (id) => {
    store.prefs.marketTheme = id;
    store.savePrefs();
  };

  // One install per theme at a time: a second click on the same card must
  // never fork a parallel download (that is how a finished install could end
  // up wearing a stale bar).
  const installingId = useRef(null);

  const install = async (theme) => {
    if (installingId.current) return;
    installingId.current = theme.id;
    setProgress({ id: theme.id, received: 0, total: null });
    const track = ({ received, total }) => {
      if (mounted.current && installingId.current === theme.id) setProgress({ id: theme.id, received, total });
    };
    // Backstop only: if something below somehow never resolves, the bar dies
    // rather than hanging. It deliberately does NOT clear installingId — the
    // download may still be in flight, and unlocking early would let a second
    // click fork a zombie download beside the retry. The lock is released
    // exclusively in the finally, which always runs because downloadTheme
    // now resolves within its own per-attempt budget.
    const deadline = setTimeout(() => {
      if (mounted.current) setProgress(null);
    }, 50_000);
    try {
      let outcome = await downloadTheme({ id: theme.id, cssUrl: theme.cssUrl, onProgress: track });
      if (outcome.error === THEME_ERRORS.unreachable) {
        // A stale cached catalog can carry URLs from a previous host (the CDN
        // before the local rebuild, an old repo name); force one refresh and
        // retry through the fresh URL before reporting failure.
        const fresh = await refreshThemes();
        const updated = fresh?.themes?.find((entry) => entry.id === theme.id);
        if (updated && updated.cssUrl !== theme.cssUrl) {
          setCatalog(fresh);
          outcome = await downloadTheme({ id: theme.id, cssUrl: updated.cssUrl, onProgress: track });
        }
      }
      if (!mounted.current) return;
      if (outcome.error === THEME_ERRORS.noMeta) {
        setError('noMeta');
        return;
      }
      if (outcome.error) {
        setError(true);
        return;
      }
      noteLocalInstall(theme.id);
      apply(theme.id);
    } finally {
      clearTimeout(deadline);
      installingId.current = null;
      // Cleared no matter how the install exits — the bar must never outlive
      // its download, even through an unexpected throw.
      if (mounted.current) setProgress(null);
    }
  };

  const uninstall = (id) => {
    const wasActive = activeId === id;
    removeTheme(id);
    if (wasActive) {
      // The CSS is gone, so the palette must fall back to the base theme now.
      store.prefs.marketTheme = null;
    }
    // Saved unconditionally: the cards read device-local storage at render
    // time, and without a prefs event a removed-but-not-active theme would
    // keep showing Apply and its trash as though nothing happened.
    store.savePrefs();
  };

  const installedList = installedThemeIds()
    .map((id) => installedTheme(id))
    .filter(Boolean);

  const cardProps = (theme) => ({
    // Catalog counts refresh hourly from the CDN; this device's own installs
    // are added so the number moves the moment someone presses Install.
    theme: { ...theme, downloads: theme.downloads + localInstallCount(theme.id) },
    trending: trending.has(theme.id),
    favorited: favorites.includes(theme.id),
    locked: false,
    t,
    onApply: () => apply(theme.id),
    onDeactivate: () => {
      store.prefs.marketTheme = null;
      store.savePrefs();
    },
    onInstall: () => install(theme),
    onRemove: () => uninstall(theme.id),
    onToggleFavorite: () => toggleFavorite(store, theme.id),
  });

  return (
    <Section
      title={t('settings.market.title')}
      description={t('settings.market.description')}
      actions={(
        <a
          href={THEMES_SUBMIT_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="shrink-0 text-sm text-accent underline-offset-2 hover:underline"
        >
          {t('settings.market.submit')}
        </a>
      )}
    >
      {marketUsable ? (
        <Notice tone="accent">{t('settings.market.activeBanner', { name: marketName })}</Notice>
      ) : null}
      {activeId && !marketUsable ? (
        <Notice tone="warn">{t('settings.market.missingBanner', { name: marketName })}</Notice>
      ) : null}

      <SearchField
        label={t('settings.market.search')}
        placeholder={t('settings.market.search')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onClear={() => setQuery('')}
      />

      <div className="flex items-center gap-1.5" role="group" aria-label={t('settings.market.filters')}>
        {filters.map((name) => (
          <Button
            key={name}
            size="sm"
            variant={filter === name ? 'primary' : 'secondary'}
            aria-pressed={filter === name}
            onClick={() => setFilter(name)}
          >
            {name === 'all' ? t('settings.market.all')
              : name === 'trending' ? t('settings.market.trending')
                : t('settings.market.favorites')}
          </Button>
        ))}
      </div>

      {error === true ? (
        <Notice tone="warn">
          {t('settings.market.error')}
          {' '}
          <Button size="sm" onClick={load}>{t('settings.market.retry')}</Button>
        </Notice>
      ) : null}
      {error === 'noMeta' ? <Notice tone="warn">{t('settings.market.noMeta')}</Notice> : null}

      {community.week.length ? (
        <>
          <span className="text-sm font-medium">{t('settings.market.community')}</span>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {community.week.map((theme) => (
              <ThemeCard key={theme.id} state={activeId && marketUsable && activeId === theme.id ? 'active' : installedTheme(theme.id) ? 'installed' : 'none'} {...cardProps(theme)} progress={progress?.id === theme.id ? progress : null} />
            ))}
          </div>
        </>
      ) : null}

      {community.rest.length ? (
        <div className="flex flex-col gap-2">
          {community.week.length ? null : (
            <span className="text-sm font-medium">{t('settings.market.community')}</span>
          )}
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {community.rest.map((theme) => (
              <ThemeCard key={theme.id} state={activeId && marketUsable && activeId === theme.id ? 'active' : installedTheme(theme.id) ? 'installed' : 'none'} {...cardProps(theme)} progress={progress?.id === theme.id ? progress : null} />
            ))}
          </div>
        </div>
      ) : null}

      {baseList.length ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('settings.market.included')}</span>
          <div className={cn('grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]')}>
            {baseList.map((preset) => (
              <BaseCard
                key={preset.id}
                preset={preset}
                active={baseActiveId === preset.id}
                locked={baseLocked}
                t={t}
                onChoose={() => onChooseBase?.(preset.id)}
              />
            ))}
          </div>
          {baseLocked ? <Notice tone="accent">{t('settings.theme.locked')}</Notice> : null}
        </div>
      ) : null}

      {nothing ? (
        <p className="text-sm text-muted">
          {filter === 'favorites' && favorites.length === 0
            ? t('settings.market.favoritesEmpty')
            : t('settings.market.empty')}
        </p>
      ) : null}

      {installedList.length && !catalog && !error ? (
        <p className="text-xs text-muted">{t('settings.market.offlineNote')}</p>
      ) : null}
    </Section>
  );
}
