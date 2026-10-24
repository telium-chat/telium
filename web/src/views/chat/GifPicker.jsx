import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useLocale, useT } from '../../lib/i18n/react.jsx';
import { cn } from '../../lib/cn.js';
import {
  ExitFullscreenIcon, FullscreenIcon, IconButton, PrivacyNote, SearchField, StarIcon,
} from '../../components/index.js';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import {
  GiphyProvider, gifFavorites, gifProviderFor, gifSizeOf, isGiphyShareUrl, isKlipyShareUrl,
  isTenorShareUrl, KlipyProviderError, klipyConfig, noteGifSize, removeGifFavorite,
  tenorConfig, TenorProvider, toggleGifFavorite,
} from '../../lib/gifs.js';

const PAGE_SIZE = 24;
const DEBOUNCE_MS = 150;

const COLUMN_WIDTH = 195;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 10;

const columnsFor = (width) => clampTo(
  Math.round((width - 10) / COLUMN_WIDTH),
  MIN_COLUMNS,
  MAX_COLUMNS,
);

const CATEGORIES = [
  { query: 'Reactions', labelKey: 'chat.gif.category.reactions' },
  { query: 'Happy', labelKey: 'chat.gif.category.happy' },
  { query: 'Cry', labelKey: 'chat.gif.category.cry' },
  { query: 'Love', labelKey: 'chat.gif.category.love' },
  { query: 'Dance', labelKey: 'chat.gif.category.dance' },
  { query: 'Cats', labelKey: 'chat.gif.category.cats' },
  { query: 'Dogs', labelKey: 'chat.gif.category.dogs' },
  { query: 'Thumbs up', labelKey: 'chat.gif.category.thumbsUp' },
  { query: 'Facepalm', labelKey: 'chat.gif.category.facepalm' },
  { query: 'Applause', labelKey: 'chat.gif.category.applause' },
  { query: 'Shrug', labelKey: 'chat.gif.category.shrug' },
  { query: 'Excited', labelKey: 'chat.gif.category.excited' },
];

const MIN_WIDTH = 300;
const MIN_HEIGHT = 240;
const COLLISION = 12;
const KEY_STEP = 16;

const FAVORITES_TILE = {
  kind: 'favorites',
  id: '__favorites__',
  width: 1,
  height: 1,
};

const clampTo = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function restoredSize(store) {
  const saved = store?.prefs?.gifSize;
  const width = Number(saved?.width);
  const height = Number(saved?.height);
  if (!(width > 0) || !(height > 0)) return null;
  return {
    width: clampTo(Math.round(width), MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - COLLISION * 2)),
    height: clampTo(Math.round(height), MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 96)),
  };
}

function useNearViewport(rootRef) {
  const [seen, setSeen] = useState(() => new Set());
  const observer = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver !== 'function') return undefined;
    const io = new IntersectionObserver((entries) => {
      const arrived = entries.filter((e) => e.isIntersecting).map((e) => e.target.dataset.gifKey);
      if (!arrived.length) return;
      setSeen((current) => {
        const next = new Set(current);
        for (const key of arrived) next.add(key);
        return next;
      });
      for (const entry of entries) if (entry.isIntersecting) io.unobserve(entry.target);
    }, { root, rootMargin: '400px 0px' });
    observer.current = io;
    return () => { io.disconnect(); observer.current = null; };
  }, [rootRef]);

  const watch = useCallback((node) => {
    if (node) observer.current?.observe(node);
  }, []);

  return [seen, watch];
}

function gifHost(config) {
  try {
    return new URL(config.apiBaseUrl).hostname;
  } catch {
    return null;
  }
}

export function GifPickerPanel({
  onPick, onClose, encrypted = false, className = 'gif-popover',
  resizable = false, fullscreen = false, onToggleFullscreen = null,
}) {
  const store = useStore();
  const t = useT();
  const { dir } = useLocale();
  useStoreEvent('gif-favorites', 'capabilities');
  const config = klipyConfig(store);
  const host = gifHost(config);
  const provider = useMemo(() => gifProviderFor(config), [
    config.enabled, config.apiKey, config.apiBaseUrl,
  ]);
  const tenor = tenorConfig(store);
  const tenorProvider = useMemo(() => new TenorProvider(tenor), [
    tenor.enabled, tenor.apiKey, tenor.clientKey, tenor.apiBaseUrl,
  ]);
  const giphyProvider = useMemo(() => new GiphyProvider(), []);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [items, setItems] = useState([]);
  const [nextPage, setNextPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [failed, setFailed] = useState(() => new Set());
  const [cursor, setCursor] = useState(null);
  const scrollRef = useRef(null);
  const panelRef = useRef(null);
  const keyed = useRef(false);
  const [seen, watch] = useNearViewport(scrollRef);

  const favorites = gifFavorites(store.sync);
  const [showFavorites, setShowFavorites] = useState(false);
  const stash = useRef(null);
  const [favoriteItems, setFavoriteItems] = useState([]);
  const [sizes, setSizes] = useState({});

  useEffect(() => {
    if (!showFavorites) return undefined;
    const controller = new AbortController();
    Promise.all(favorites.map(async (source) => {
      if (!isKlipyShareUrl(source) && !isTenorShareUrl(source) && !isGiphyShareUrl(source)) {
        return { id: source, url: source, previewUrl: source, title: t('chat.gif.favorite') };
      }
      try {
        const resolver = isTenorShareUrl(source)
          ? tenorProvider : isGiphyShareUrl(source) ? giphyProvider : provider;
        const url = await resolver.resolveShareUrl(source, { signal: controller.signal });
        return { id: source, url: source, previewUrl: url || source, title: t('chat.gif.favorite') };
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        return { id: source, url: source, previewUrl: source, title: t('chat.gif.favorite') };
      }
    })).then((items) => {
      if (!controller.signal.aborted) setFavoriteItems(items.filter(Boolean));
    });
    return () => {
      controller.abort();
      provider.cancel();
      tenorProvider.cancel();
    };
  }, [showFavorites, favorites.join('|'), provider, tenorProvider, giphyProvider, t]);

  const [settled, setSettled] = useState('');
  useEffect(() => {
    if (query === settled) return undefined;
    const timer = setTimeout(() => setSettled(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, settled]);

  useEffect(() => {
    if (showFavorites) { setLoading(false); setError(null); return undefined; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const result = await provider.list({
          query: settled, page: 1, perPage: PAGE_SIZE, signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setItems(result.items);
        setFailed(new Set());
        setNextPage(result.nextPage);
        setCursor(null);
        scrollRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        if (e?.name !== 'AbortError' && !controller.signal.aborted) setError(e);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [provider, settled, showFavorites]);

  const loadMore = useCallback(async () => {
    if (!nextPage || showFavorites) return;
    try {
      const result = await provider.list({ query: settled, page: nextPage, perPage: PAGE_SIZE });
      setItems((current) => [
        ...current,
        ...result.items.filter((item) => !current.some((old) => old.url === item.url)),
      ]);
      setNextPage(result.nextPage);
    } catch (e) {
      if (e?.name !== 'AbortError') setError(e);
    }
  }, [provider, settled, nextPage, showFavorites]);

  const results = showFavorites ? favoriteItems : items;

  const visible = useMemo(() => {
    if (!showFavorites) return [FAVORITES_TILE, ...results];
    return results.map((item) => {
      const known = sizes[item.url] || gifSizeOf(item.url);
      return known && !item.width
        ? { ...item, width: known.width, height: known.height }
        : item;
    });
  }, [results, showFavorites, sizes]);

  const [columnCount, setColumnCount] = useState(MIN_COLUMNS);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return undefined;
    const measure = () => setColumnCount(
      columnsFor(panel.getBoundingClientRect().width || panel.offsetWidth),
    );
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const columns = useMemo(() => {
    const cols = Array.from({ length: columnCount }, () => []);
    const heights = new Array(columnCount).fill(0);
    for (const item of visible) {
      let at = 0;
      for (let i = 1; i < columnCount; i += 1) if (heights[i] < heights[at]) at = i;
      cols[at].push(item);
      heights[at] += item.width && item.height ? item.height / item.width : 1;
    }
    return cols;
  }, [visible, columnCount]);

  const move = useCallback((dCol, dRow) => {
    keyed.current = true;
    setCursor((current) => {
      const from = current || { col: 0, row: -1 };
      let col = Math.min(Math.max(from.col + dCol, 0), columns.length - 1);
      if (!columns[col]?.length) col = from.col;
      const length = columns[col]?.length || 0;
      if (!length) return current;
      const row = Math.min(Math.max(from.row + dRow, 0), length - 1);
      return { col, row };
    });
  }, [columns]);

  const chosen = cursor ? columns[cursor.col]?.[cursor.row] : null;

  const gridId = useId();
  const tileId = (col, row) => `${gridId}-${col}-${row}`;

  useLayoutEffect(() => {
    if (!cursor || !keyed.current) return;
    keyed.current = false;
    scrollRef.current
      ?.querySelector('[data-cursor="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const resizeRef = useRef(null);
  const [size, setSizeState] = useState(() => restoredSize(store));
  const sizeRef = useRef(size);
  const gripRef = useRef(null);

  const setSize = (next) => {
    sizeRef.current = next;
    setSizeState(next);
  };

  const rememberSize = (next) => {
    store.prefs.gifSize = next;
    store.savePrefs();
  };

  const paintSize = (next) => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.width = `${next.width}px`;
    panel.style.height = `${next.height}px`;
    gripRef.current?.setAttribute('aria-valuenow', String(Math.round(next.width)));
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !resizable) return;
    if (size && !fullscreen) paintSize(size);
    else { panel.style.width = ''; panel.style.height = ''; }
  }, [resizable, size, fullscreen]);

  const roomFor = (rect) => ({
    maxWidth: Math.max(MIN_WIDTH, (dir === 'rtl'
      ? window.innerWidth - rect.left
      : rect.right) - COLLISION),
    maxHeight: Math.max(MIN_HEIGHT, rect.bottom - COLLISION),
  });

  const resizeBy = (start, dx, dy) => ({
    width: clampTo(start.width + dx * (dir === 'rtl' ? 1 : -1), MIN_WIDTH, start.maxWidth),
    height: clampTo(start.height - dy, MIN_HEIGHT, start.maxHeight),
  });

  const beginResize = (event) => {
    if (event.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      axis: event.currentTarget.dataset.resize || 'xy',
      width: rect.width,
      height: rect.height,
      ...roomFor(rect),
      handle: event.currentTarget,
    };
  };

  const moveResize = (event) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = drag.axis === 'y' ? 0 : event.clientX - drag.x;
    const dy = drag.axis === 'x' ? 0 : event.clientY - drag.y;
    const next = resizeBy(drag, dx, dy);
    sizeRef.current = next;
    paintSize(next);
  };

  const endResize = (event) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.handle?.releasePointerCapture?.(event.pointerId);
    resizeRef.current = null;
    const final = sizeRef.current;
    if (!final) return;
    setSize(final);
    rememberSize(final);
  };

  const resizeByKey = (event) => {
    const panel = panelRef.current;
    const step = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    }[event.key];
    if (!step || !panel) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const next = resizeBy(
      { width: rect.width, height: rect.height, ...roomFor(rect) },
      step[0], step[1],
    );
    setSize(next);
    rememberSize(next);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && fullscreen) {
      event.preventDefault();
      event.stopPropagation();
      onToggleFullscreen?.();
    } else if (event.key === 'Escape' && showFavorites) {
      event.preventDefault();
      event.stopPropagation();
      closeFavorites();
    } else if (event.key === 'ArrowDown') { event.preventDefault(); move(0, 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(0, -1); }
    else if (event.key === 'ArrowRight' && chosen) { event.preventDefault(); move(1, 0); }
    else if (event.key === 'ArrowLeft' && chosen) { event.preventDefault(); move(-1, 0); }
    else if (event.key === 'Enter' && chosen) { event.preventDefault(); activate(chosen); }
  };

  const pick = async (url) => {
    try {
      await onPick(url);
      onClose?.();
    } catch (e) {
      setError(e);
    }
  };

  const activate = (item) => (item?.kind === 'favorites' ? openFavorites() : pick(item.url));

  const openFavorites = () => {
    stash.current = { query, active, settled };
    setShowFavorites(true);
    setQuery('');
    setSettled('');
    setActive('');
  };

  const closeFavorites = () => {
    const back = stash.current;
    stash.current = null;
    setShowFavorites(false);
    setQuery(back?.query || '');
    setSettled(back?.settled || '');
    setActive(back?.active || '');
  };

  const chip = (label, value) => (
    <button
      key={value || label}
      type="button"
      className="gif-chip press"
      aria-pressed={!showFavorites && !query && active === value}
      onClick={() => {
        stash.current = null;
        setShowFavorites(false);
        setActive(value);
        setQuery(value);
        setSettled(value);
      }}
    >
      {label}
    </button>
  );

  const message = (() => {
    if (!showFavorites) {
      if (!config.enabled) return t('chat.gif.disabled');
      if (!config.apiKey) return t('chat.gif.notConfigured');
      if (error) {
        return error instanceof KlipyProviderError
          ? error.message
          : (error?.message || t('chat.gif.loadFailed'));
      }
    }
    if (loading && !results.length) return t('chat.gif.loading');
    if (!results.length) {
      return showFavorites ? t('chat.gif.favoritesEmpty') : t('chat.gif.noMatches');
    }
    return null;
  })();

  return (
    <div
      ref={panelRef}
      className={cn(className, fullscreen && 'gif-popover--fill')}
      style={resizable && !fullscreen
        ? {
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 96px)',
        }
        : undefined}
      onKeyDown={onKeyDown}
    >
      {encrypted && host ? (
        <PrivacyNote
          className="gif-privacy"
          head={t('privacy.gif.head')}
          note={t('privacy.gif.body', { host })}
        />
      ) : null}

      <div className="gif-popover-head">
        <div className="gif-popover-search">
          <SearchField
            label={t('chat.gif.search')}
            placeholder={t('chat.gif.search')}
            size="sm"
            autoFocus
            role="combobox"
            aria-expanded={visible.length > 0}
            aria-controls={gridId}
            aria-activedescendant={chosen ? tileId(cursor.col, cursor.row) : undefined}
            value={query}
            className="min-w-0 flex-1"
            onChange={(e) => {
              stash.current = null;
              setShowFavorites(false);
              setQuery(e.target.value);
              setActive(e.target.value);
            }}
            onClear={() => { setQuery(''); setSettled(''); setActive(''); }}
          />
          {onToggleFullscreen ? (
            <IconButton
              className="shrink-0"
              active={fullscreen}
              title={fullscreen ? t('chat.gif.exitFullscreen') : t('chat.gif.fullscreen')}
              onClick={() => onToggleFullscreen()}
            >
              {fullscreen
                ? <ExitFullscreenIcon className="size-4" />
                : <FullscreenIcon className="size-4" />}
            </IconButton>
          ) : null}
        </div>
        <div className="gif-chips">
          {chip(t('chat.gif.trending'), '')}
          {CATEGORIES.map((c) => chip(t(c.labelKey), c.query))}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="gif-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) loadMore();
        }}
      >
        {message ? <p className="gif-note" role="status">{message}</p> : null}
        <div
          id={gridId}
          className="gif-grid"
          role={visible.length ? 'listbox' : undefined}
          aria-label={visible.length
            ? t(showFavorites ? 'chat.gif.favorites' : 'chat.gif.results')
            : undefined}
          style={loading && results.length ? { opacity: 0.6 } : undefined}
        >
          {columns.map((column, col) => (
            // eslint-disable-next-line react/no-array-index-key
            <div className="gif-col" role="presentation" key={col}>
              {column.map((item, row) => {
                const key = item.id || item.url;
                const ready = seen.has(key);
                const unavailable = failed.has(key);
                const starred = showFavorites || favorites.includes(item.url);
                const at = cursor?.col === col && cursor?.row === row;
                const door = item.kind === 'favorites';
                return (
                  <div
                    key={key}
                    id={tileId(col, row)}
                    ref={watch}
                    data-gif-key={key}
                    data-cursor={at ? 'true' : undefined}
                    className={door ? 'gif-tile gif-tile--door' : 'gif-tile'}
                    role="option"
                    aria-selected={at}
                    aria-label={door
                      ? t('chat.gif.favorites')
                      : item.title || t('chat.gif.untitled')}
                    style={{ aspectRatio: item.width && item.height ? `${item.width} / ${item.height}` : '1 / 1' }}
                    onMouseEnter={() => { keyed.current = false; setCursor({ col, row }); }}
                    onMouseDown={door ? (event) => event.preventDefault() : undefined}
                    onClick={door ? openFavorites : undefined}
                  >
                    {door ? (
                      <div className="gif-fav">
                        <StarIcon className={favorites.length ? 'size-7 fill-current text-accent' : 'size-7'} />
                        <span>{t('chat.gif.favorites')}</span>
                        {favorites.length ? (
                          <span className="gif-fav-count" aria-hidden="true">{favorites.length}</span>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          title={t('chat.gif.send', { title: item.title || t('chat.gif.untitled') })}
                          onClick={() => pick(item.url)}
                          className="size-full cursor-pointer"
                        >
                          {unavailable ? (
                            <span className="gif-unavailable" aria-hidden="true">
                              <img src="/brand/telium-mark-solid.svg" alt="" />
                              <span className="gif-unavailable-face">☹</span>
                              <span className="gif-unavailable-label">{t('chat.gif.unavailable')}</span>
                            </span>
                          ) : ready ? (
                            <AnimatedImage
                              src={item.previewUrl || item.url}
                              alt={item.title || t('chat.gif.untitled')}
                              animated
                              gif
                              className="size-full object-cover"
                              onError={() => setFailed((current) => new Set(current).add(key))}
                              onLoad={showFavorites ? (event) => {
                                const width = event.currentTarget.naturalWidth;
                                const height = event.currentTarget.naturalHeight;
                                if (!noteGifSize(item.url, width, height)) return;
                                setSizes((current) => ({
                                  ...current,
                                  [item.url]: { width, height },
                                }));
                              } : undefined}
                            />
                          ) : <span className="gif-hold" />}
                        </button>
                        <IconButton
                          title={starred ? t('chat.gif.unfavorite') : t('chat.gif.favorite')}
                          className="gif-star"
                          onClick={() => {
                            noteGifSize(item.url, item.width, item.height);
                            if (showFavorites) removeGifFavorite(store, item.url);
                            else toggleGifFavorite(store, item.url);
                          }}
                        >
                          <StarIcon className={starred ? 'size-3.5 fill-current text-accent' : 'size-3.5'} />
                        </IconButton>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {resizable && !fullscreen ? (
        <>
          <div
            data-resize="x"
            aria-hidden="true"
            className="gif-resize gif-resize--x"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            data-resize="y"
            aria-hidden="true"
            className="gif-resize gif-resize--y"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
          />
          <div
            ref={gripRef}
            role="separator"
            tabIndex={0}
            aria-label={t('chat.gif.resize')}
            aria-valuenow={Math.round(size?.width ?? 400)}
            aria-valuemin={MIN_WIDTH}
            aria-valuemax={Math.max(MIN_WIDTH, window.innerWidth)}
            className="gif-resize gif-resize--corner"
            style={{ cursor: dir === 'rtl' ? 'nesw-resize' : 'nwse-resize' }}
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onKeyDown={resizeByKey}
          />
        </>
      ) : null}

    </div>
  );
}

export function GifPopover({ open, onOpenChange, anchor, onPick, onClosed, encrypted = false }) {
  const t = useT();
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => { if (!open) setFullscreen(false); }, [open]);
  return (
    <Popover.Root
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => { if (!next) onClosed?.(); }}
      modal
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor}
          positionMethod="fixed"
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={COLLISION}
          className={cn('popover z-50', fullscreen && 'gif-positioner--fill')}
        >
          <Popover.Popup
            aria-label={t('chat.gif.picker')}
            className={cn('popup gif-popup', fullscreen && 'gif-popup--fill')}
          >
            <GifPickerPanel
              onPick={onPick}
              onClose={() => onOpenChange(false)}
              encrypted={encrypted}
              resizable
              fullscreen={fullscreen}
              onToggleFullscreen={() => setFullscreen((current) => !current)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
