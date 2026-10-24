import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { cn } from '../../lib/cn.js';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Avatar, EmojiText, IconButton, ImageIcon, SearchField, SpinnerIcon, StarIcon,
  Twemoji,
} from '../../components/index.js';
import {
  GROUPS, SKIN_TONES, baseEmojiFor, emojiUrl, loadEmoji, parseCustomEmoji,
  recentEmoji, rememberEmoji, searchEmoji, withTone,
} from '../../lib/emoji.js';
import { KEYS } from '../../lib/sync.js';
import { checkIsMobile } from '../../lib/platform.js';
import { savedStickers, toggleSavedSticker } from '../../lib/saved-stickers.js';

const COLUMNS = 9;

const STICKER_COLUMNS = 4;

const CELL_PITCH = 35;
const STICKER_PITCH = 78;
const SECTION_HEAD = 23;

const tagOf = (sticker) => `${sticker?.origin || ''}\n${sticker?.id || ''}`;

export function EmojiPickerPanel({
  guildId, onPick, onPickSticker, onClose, className = 'emoji-panel',
}) {
  const t = useT();
  const store = useStore();
  const [all, setAll] = useState(null);
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState(() => recentEmoji(store.sync));
  const [tone, setTone] = useState(() => store.sync.get(KEYS.emojiTone) || '');
  const [active, setActive] = useState(null);
  const mobile = checkIsMobile();
  const defaultColumns = mobile ? 8 : COLUMNS;
  const stickerColumns = mobile ? 3 : STICKER_COLUMNS;

  const search = useRef(null);
  const scroller = useRef(null);
  const sections = useRef(new Map());
  const footImage = useRef(null);
  const footName = useRef(null);
  const cursor = useRef(-1);
  const cursorCell = useRef(null);
  const flatRef = useRef([]);

  useEffect(() => { loadEmoji().then(setAll); }, []);
  useEffect(() => { search.current?.focus(); }, []);

  const [customRevision, setCustomRevision] = useState(0);
  useEffect(() => {
    const offs = [
      store.on('guilds', () => setCustomRevision((n) => n + 1)),
      store.on('expressions', () => setCustomRevision((n) => n + 1)),
    ];
    return () => offs.forEach((off) => off());
  }, [store]);

  const [savedRevision, setSavedRevision] = useState(0);
  useEffect(() => store.on('saved-stickers', () => setSavedRevision((n) => n + 1)), [store]);
  const saved = useMemo(
    () => savedStickers(store.sync),
    [store, savedRevision],
  );

  const custom = useAsync(async () => {
    const guilds = [...store.guilds.values()];
    return Promise.all(guilds.map(async (guild) => {
      const api = store.apiForGuild(guild.id);
      if (!api) return null;
      const r = await store.loadExpressionData(guild.id);
      const emojis = (r.emojis || []).map((em) => ({ ...em, origin: guild.domain }));
      const stickers = (r.stickers || []).map((st) => ({ ...st, origin: guild.domain }));
      if (!emojis.length && !stickers.length) return null;
      return {
        guildId: guild.id,
        name: guild.name,
        origin: guild.domain,
        guild,
        icon: guild.icon_ref ? `${api.base}/_telium/v1/media/${guild.icon_ref}` : null,
        emojis,
        stickers,
      };
    })).then((groups) => groups.filter(Boolean));
  }, [store, guildId, customRevision]);

  const base = store.apiForGuild(guildId)?.base || '';
  const wantStickers = Boolean(onPickSticker);

  const cellFor = useCallback((entry) => {
    if (entry.kind === 'sticker') {
      const origin = entry.origin || '';
      return {
        key: `s:${entry.id}`,
        label: entry.name,
        shortcode: entry.name,
        image: `${origin ? store.apiFor(origin)?.base || '' : base}/_telium/v1/sticker/${entry.id}`,
        sticker: { id: entry.id, name: entry.name, origin },
      };
    }
    if (entry.id) {
      const origin = entry.origin || store.guilds.get(entry.guild_id)?.domain || '';
      return {
        key: `c:${entry.id}`,
        value: `<${entry.name}:${entry.id}${origin ? `@${origin}` : ''}>`,
        label: entry.name,
        shortcode: entry.name,
        image: `${origin ? store.apiFor(origin)?.base || '' : base}/_telium/v1/emoji/${entry.id}`,
      };
    }
    const value = withTone(entry, tone);
    return {
      key: entry.unicode,
      value,
      label: entry.label,
      shortcode: entry.shortcode,
      emoji: value,
      src: emojiUrl(value),
    };
  }, [base, store, tone]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const customEmoji = (custom.data || []).flatMap((g) => g.emojis);
    const filteredCustomEmoji = customEmoji
      .filter((em) => !q || em.name.toLowerCase().includes(q));

    const customStickers = !wantStickers ? [] : (custom.data || [])
      .flatMap((g) => g.stickers || [])
      .filter((st) => !q || st.name.toLowerCase().includes(q));

    if (q) {
      const hits = all ? searchEmoji(all, q).slice(0, 180) : [];
      const items = [...filteredCustomEmoji.map(cellFor), ...hits.map(cellFor)];
      const out = [];
      if (items.length) {
        out.push({ id: 'results', label: t('chat.emoji.results', { query: query.trim() }), items });
      }
      if (customStickers.length) {
        out.push({
          id: 'sticker-results',
          label: t('chat.emoji.stickerResults'),
          columns: stickerColumns,
          items: customStickers.map(cellFor),
        });
      }
      return out;
    }

    const out = [];
    if (wantStickers) {
      const available = new Map(customStickers.map((st) => [tagOf(st), st]));
      const items = saved
        .map((entry) => available.get(tagOf(entry)))
        .filter(Boolean)
        .map((st) => ({ ...cellFor(st), key: `saved:${st.origin || ''}:${st.id}` }));
      if (items.length) {
        out.push({
          id: 'stickers:saved',
          label: t('chat.emoji.savedStickers'),
          columns: stickerColumns,
          items,
        });
      }
    }
    for (const g of custom.data || []) {
      const items = g.emojis.map(cellFor);
      if (items.length) {
        out.push({
          id: `custom:${g.guildId}`,
          label: t('chat.emoji.guildEmoji', { guild: g.name }),
          icon: g.icon,
          guild: g.guild,
          items,
        });
      }
      const stickers = wantStickers ? (g.stickers || []).map(cellFor) : [];
      if (stickers.length) {
        out.push({
          id: `stickers:${g.guildId}`,
          label: t('chat.emoji.guildStickers', { guild: g.name }),
          columns: stickerColumns,
          icon: g.icon,
          guild: g.guild,
          items: stickers,
        });
      }
    }
    for (const group of GROUPS) {
      const items = group.id === 'recent'
        ? recent.map((value) => {
          const customValue = parseCustomEmoji(value);
          if (!customValue) {
            const entry = baseEmojiFor(all || [], value);
            return entry
              ? { ...cellFor(entry), key: `r:${value}`, value, emoji: value, src: emojiUrl(value) }
              : { key: `r:${value}`, value, label: value, emoji: value, src: emojiUrl(value) };
          }
          const entry = customEmoji.find((em) => em.id === customValue.id
            && (!customValue.origin || em.origin === customValue.origin));
          return entry ? { ...cellFor(entry), key: `r:${value}` } : null;
        }).filter(Boolean)
        : (all || []).filter((e) => e.group === group.id).map(cellFor);
      if (items.length) out.push({ id: String(group.id), label: t(group.labelKey), items });
    }
    return out;
  }, [all, query, recent, custom.data, cellFor, wantStickers, stickerColumns, saved, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  flatRef.current = flat;

  const savedTags = useMemo(() => new Set(saved.map(tagOf)), [saved]);

  const pick = (cell) => {
    if (!cell) return;
    onClose?.();
    if (cell.sticker) { onPickSticker(cell.sticker); return; }
    setRecent(rememberEmoji(store.sync, cell.value));
    onPick(cell.value);
  };

  const describe = useCallback((cell) => {
    const image = footImage.current;
    const name = footName.current;
    if (!image || !name) return;
    const src = cell?.image || cell?.src || '';
    if (src) { image.src = src; image.hidden = false; } else { image.hidden = true; }
    name.textContent = cell
      ? (cell.shortcode ? `:${cell.shortcode}:` : cell.label)
      : t('chat.emoji.hint');
    name.classList.toggle('text-muted', !cell);
  }, [t]);

  const moveCursor = useCallback((index, scroll = false, node = null) => {
    const el = scroller.current;
    if (!el) return;
    const cell = node || (index >= 0 ? el.querySelector(`.emoji-cell[data-idx="${index}"]`) : null);
    if (cursorCell.current && cursorCell.current !== cell) {
      cursorCell.current.removeAttribute('data-cursor');
      cursorCell.current.removeAttribute('aria-selected');
    }
    cursorCell.current = cell;
    cursor.current = cell ? index : -1;
    if (cell) {
      cell.setAttribute('data-cursor', 'true');
      cell.setAttribute('aria-selected', 'true');
      el.setAttribute('aria-activedescendant', cell.id);
      if (scroll) cell.scrollIntoView({ block: 'nearest' });
    } else {
      el.removeAttribute('aria-activedescendant');
    }
    describe(flatRef.current[index] || null);
  }, [describe]);

  useLayoutEffect(() => {
    cursorCell.current = null;
    moveCursor(flat.length ? 0 : -1);
  }, [flat, moveCursor]);

  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [query]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return undefined;
    const mark = (e) => {
      if (e.target.tagName !== 'IMG') return;
      const cell = e.target.closest('.emoji-cell');
      if (!cell) return;
      if (e.type === 'error') cell.setAttribute('data-broken', 'true');
      else cell.removeAttribute('data-broken');
    };
    el.addEventListener('error', mark, true);
    el.addEventListener('load', mark, true);
    return () => {
      el.removeEventListener('error', mark, true);
      el.removeEventListener('load', mark, true);
    };
  }, []);

  const onCellOver = (e) => {
    const cell = e.target.closest?.('.emoji-cell');
    if (!cell) return;
    const index = Number(cell.dataset.idx);
    if (index === cursor.current) return;
    moveCursor(index, false, cell);
  };

  const onCellClick = (e) => {
    const cell = e.target.closest?.('.emoji-cell');
    if (!cell) return;
    pick(flatRef.current[Number(cell.dataset.idx)]);
  };

  const onKeyDown = (e) => {
    const at = cursor.current;
    const current = flatRef.current[at];
    const width = groups.find((g) => g.items.includes(current))?.columns || defaultColumns;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: width, ArrowUp: -width }[e.key];
    if (step !== undefined) {
      if (step === -width && at < width) return;
      e.preventDefault();
      moveCursor(Math.max(0, Math.min(flatRef.current.length - 1, at + step)), true);
      return;
    }
    if (e.key === 'Enter' && current) { e.preventDefault(); pick(current); }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    let seen = null;
    for (const [id, node] of sections.current) {
      if (node && node.getBoundingClientRect().top - top <= 12) seen = id;
    }
    setActive((prev) => (prev === seen ? prev : seen ?? groups[0]?.id ?? null));
  };

  const jump = (id) => {
    const el = scroller.current;
    const section = sections.current.get(id);
    if (!section || !el) return;
    const land = () => {
      el.scrollTop += section.getBoundingClientRect().top - el.getBoundingClientRect().top;
    };
    land();
    requestAnimationFrame(land);
    setActive(id);
  };

  const chooseTone = (value) => {
    setTone(value);
    store.sync.set(KEYS.emojiTone, value);
  };

  const registerSection = useCallback((id, node) => {
    if (node) sections.current.set(id, node);
    else sections.current.delete(id);
  }, []);

  const onToggleSave = useCallback((sticker) => toggleSavedSticker(store, sticker), [store]);

  const railActive = query.trim() ? 'results' : (active ?? groups[0]?.id);
  const expressionsLoading = !all || custom.loading;

  return (
    <div className={className} onKeyDown={onKeyDown}>
      <div className="emoji-head">
        <SearchField
          ref={search}
          label={t('chat.emoji.search')}
          placeholder={t('chat.emoji.search')}
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
        <div className="emoji-tones" role="group" aria-label={t('chat.emoji.skinTone')}>
          {SKIN_TONES.map(({ value, labelKey }) => (
            <button
              key={labelKey}
              type="button"
              className="emoji-tone"
              title={t(labelKey)}
              aria-label={t('chat.emoji.skinToneOf', { tone: t(labelKey) })}
              aria-pressed={tone === value}
              onClick={() => chooseTone(value)}
            >
              <Twemoji emoji={`\u{270B}${value}`} className="!size-[14px] !align-middle" />
            </button>
          ))}
        </div>
      </div>

      {expressionsLoading ? (
        <div role="status" aria-live="polite" className="emoji-loading">
          <SpinnerIcon className="size-3 shrink-0 animate-spin text-accent" aria-hidden="true" />
          <span>{!all ? t('chat.emoji.loading') : t('chat.emoji.loadingCustom')}</span>
        </div>
      ) : null}

      <div className="emoji-body">
        <nav aria-label={t('chat.emoji.categories')} data-mobile-scroll className="emoji-rail">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              title={g.label}
              aria-label={g.label}
              aria-current={railActive === g.id ? 'true' : undefined}
              onClick={() => jump(g.id)}
              className="emoji-rail-button"
            >
              <RailIcon id={g.id} icon={g.icon} guild={g.guild} />
            </button>
          ))}
        </nav>

        <div
          ref={scroller}
          onScroll={onScroll}
          onMouseOver={onCellOver}
          onClick={onCellClick}
          aria-busy={expressionsLoading}
          data-mobile-scroll
          className="emoji-scroll"
          role="listbox"
          aria-label={t('chat.emoji.grid')}
        >
          <EmojiGrid
            groups={groups}
            defaultColumns={defaultColumns}
            savedTags={savedTags}
            onToggleSave={onToggleSave}
            registerSection={registerSection}
          />

          {all && !groups.length ? (
            <p className="emoji-note">
              {query.trim()
                ? t('chat.emoji.noMatches')
                : t('chat.emoji.empty')}
            </p>
          ) : null}
        </div>
      </div>

      <div className="emoji-foot">
        <img
          ref={footImage}
          alt=""
          hidden
          onError={(e) => { e.currentTarget.hidden = true; }}
          className="emoji-foot-image"
        />
        <span ref={footName} className="min-w-0 flex-1 truncate text-muted">
          {t('chat.emoji.hint')}
        </span>
      </div>
    </div>
  );
}

const EmojiGrid = memo(function EmojiGrid({
  groups, defaultColumns, savedTags, onToggleSave, registerSection,
}) {
  const t = useT();
  let index = 0;
  return groups.map((g) => {
    const columns = g.columns || defaultColumns;
    const start = index;
    index += g.items.length;
    const rows = Math.ceil(g.items.length / columns);
    const pitch = g.columns ? STICKER_PITCH : CELL_PITCH;
    return (
      <section
        key={g.id}
        ref={(node) => { registerSection(g.id, node); }}
        role="group"
        aria-label={g.label}
        className="emoji-section"
        style={{ '--emoji-section-height': `${rows * pitch + SECTION_HEAD}px` }}
      >
        <h3 aria-hidden="true" className="eyebrow emoji-section-head"><EmojiText>{g.label}</EmojiText></h3>
        <div
          className="emoji-grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {g.items.map((cell, i) => {
            const at = start + i;
            const button = (
              <button
                key={cell.key}
                id={`emoji-cell-${at}`}
                data-idx={at}
                type="button"
                tabIndex={-1}
                role="option"
                title={cell.shortcode ? `:${cell.shortcode}:` : cell.label}
                data-native={cell.emoji}
                className={cn('emoji-cell', cell.sticker && 'emoji-cell--sticker')}
              >
                <img
                  src={cell.image || cell.src}
                  alt={cell.emoji || `:${cell.label}:`}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className={cell.sticker ? 'emoji-cell-sticker-image' : 'emoji-cell-image'}
                />
              </button>
            );
            if (!cell.sticker) return button;
            const isSaved = savedTags.has(`${cell.sticker.origin || ''}\n${cell.sticker.id}`);
            return (
              <div key={cell.key} className="emoji-sticker">
                {button}
                <IconButton
                  title={isSaved ? t('chat.emoji.unsaveSticker') : t('chat.emoji.saveSticker')}
                  active={isSaved}
                  className="emoji-sticker-star"
                  onClick={(e) => { e.stopPropagation(); onToggleSave(cell.sticker); }}
                >
                  <StarIcon className={isSaved ? 'size-3.5 fill-current text-accent' : 'size-3.5'} />
                </IconButton>
              </div>
            );
          })}
        </div>
      </section>
    );
  });
});

export function EmojiPopover({
  open, onOpenChange, anchor, guildId, onPick, onPickSticker, onClosed,
  side = 'top', align = 'end',
}) {
  const t = useT();
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
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className="popover z-50"
        >
          <Popover.Popup aria-label={t('chat.emoji.picker')} className="popup emoji-popup">
            <EmojiPickerPanel
              guildId={guildId}
              onPick={onPick}
              onPickSticker={onPickSticker}
              onClose={() => onOpenChange(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function RailIcon({ id, icon, guild }) {
  if (icon) return <AnimatedImage src={icon} alt="" animated className="size-4 rounded object-cover" />;
  if (guild) {
    return (
      <Avatar
        id={guild.id}
        name={guild.name}
        size="xs"
        className="!size-4 !rounded-[5px] !text-[0.5rem]"
      />
    );
  }
  if (id.startsWith('stickers') || id === 'sticker-results') {
    return <ImageIcon className="size-3.5 text-muted" />;
  }
  if (id.startsWith('custom') || id === 'results') {
    return <span className="text-sm text-muted">{id === 'results' ? '⌕' : '★'}</span>;
  }
  return <Twemoji emoji={iconFor(id)} className="!size-4 !align-middle" />;
}

function iconFor(id) {
  return GROUPS.find((g) => String(g.id) === String(id))?.icon || '\u{1F600}';
}
