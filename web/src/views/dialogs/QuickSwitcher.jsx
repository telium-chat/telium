import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { cn } from '../../lib/cn.js';
import { mediaUrl } from '../../lib/media.js';
import { tint } from '../../lib/util.js';
import {
  FILTERS, MAX_ROWS, destinations, parseQuery, rankDestinations,
} from '../../lib/switcher.js';
import {
  AnnouncementIcon, Avatar, ForumIcon, HashIcon, SearchIcon, UserIcon, VoiceIcon,
} from '../../components/index.js';
import { dmPeer } from '../../lib/conversations.js';

const GLYPH = {
  text: HashIcon,
  voice: VoiceIcon,
  forum: ForumIcon,
  announcement: AnnouncementIcon,
  user: UserIcon,
};

function GuildFace({ store, entry }) {
  const base = store.apiForGuild(entry.guildId)?.base || '';
  const src = entry.iconRef ? mediaUrl(base, entry.iconRef) : null;
  if (src) return <img src={src} alt="" draggable={false} className="qs-guild" />;
  return (
    <span className="qs-guild qs-guild--blank" style={{ background: tint(entry.guildId) }}>
      {(entry.title || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

function Face({ store, entry }) {
  if (entry.group === 'guild') return <GuildFace store={store} entry={entry} />;
  if (entry.group === 'channel') {
    const Icon = GLYPH[entry.kind] || HashIcon;
    return <Icon className="qs-glyph size-4" />;
  }
  const peer = entry.kind === 'dm' && entry.userId ? dmPeer(store, entry.userId) : null;
  return (
    <Avatar
      size="xs"
      id={entry.userId || entry.conversationId}
      name={peer?.name || entry.title}
      mediaRef={peer?.avatarRef || entry.avatarRef || null}
      base={peer?.base || entry.base || null}
      mediaOrigin={peer?.mediaOrigin || entry.mediaOrigin || null}
      presence={peer?.presence || null}
    />
  );
}

function Marked({ text, positions }) {
  if (!positions.length) return text;
  const parts = [];
  let cut = 0;
  for (let i = 0; i < positions.length;) {
    let end = i;
    while (end + 1 < positions.length && positions[end + 1] === positions[end] + 1) end += 1;
    const from = positions[i];
    const to = positions[end] + 1;
    if (from > cut) parts.push(text.slice(cut, from));
    parts.push(<b key={from} className="qs-hit">{text.slice(from, to)}</b>);
    cut = to;
    i = end + 1;
  }
  if (cut < text.length) parts.push(text.slice(cut));
  return parts;
}

export function QuickSwitcher({ close, onGone }) {
  const store = useStore();
  useStoreEvent('guilds', 'channels', 'conversations', 'friends', 'members', 'unread', 'prefs');
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const list = useRef(null);

  const entries = destinations(store);
  const rows = rankDestinations(entries, query, {
    recent: store.recentSurfaces(),
    limit: MAX_ROWS,
  });
  const { filter, text } = parseQuery(query);
  const cursor = rows.length ? Math.min(at, rows.length - 1) : 0;
  const active = rows[cursor] || null;

  useEffect(() => { setAt(0); }, [query]);

  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => () => gone.current?.(), []);

  useEffect(() => {
    const row = list.current?.querySelector('[data-active="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor, query]);

  const go = async (row) => {
    if (!row) return;
    const entry = row.entry;
    close();
    try {
      if (entry.group === 'guild') {
        const channels = store.channelsOf(entry.guildId);
        const first = channels.find((c) => c.type === 'text')
          || channels.find((c) => c.type !== 'category');
        store.navigate({ view: 'chat', guildId: entry.guildId, channelId: first?.id || null });
        return;
      }
      if (entry.group === 'channel') {
        store.navigate({ view: entry.view, guildId: entry.guildId, channelId: entry.channelId });
        return;
      }
      if (entry.group === 'conversation') {
        store.navigate({ view: 'dms', conversationId: entry.conversationId });
        return;
      }
      const convo = store.dmWith(entry.userId) || await store.startConversation([entry.userId]);
      store.navigate({ view: 'dms', conversationId: convo.id });
    } catch (e) {
      reportError(e, 'Could not open that');
    }
  };

  const onKeyDown = (e) => {
    const step = (by) => {
      e.preventDefault();
      if (!rows.length) return;
      setAt((was) => (was + by + rows.length) % rows.length);
    };
    if (e.key === 'ArrowDown') step(1);
    else if (e.key === 'ArrowUp') step(-1);
    else if (e.key === 'Tab') step(e.shiftKey ? -1 : 1);
    else if (e.key === 'Enter' && active) { e.preventDefault(); go(active); }
  };

  return (
    <div className="quick-switcher">
      <Dialog.Title className="sr-only">Quick switcher</Dialog.Title>
      <div className="qs-field">
        <SearchIcon className="qs-field-glyph size-4" />
        <input
          type="text"
          className="qs-input"
          autoFocus
          value={query}
          placeholder="Where would you like to go?"
          aria-label="Where would you like to go?"
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-switcher-list"
          aria-activedescendant={active ? `qs-${active.entry.key}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <p className="qs-hint">
        <span className="qs-hint-lead">Protip:</span>
        {FILTERS.map((f, i) => (
          <span key={f.token} className={cn('qs-hint-item', filter === f && 'qs-hint-item--on')}>
            <span className="qs-hint-token">{f.token}</span>
            {' '}
            {f.label}
            {i < FILTERS.length - 1 ? <span className="qs-hint-sep">·</span> : null}
          </span>
        ))}
      </p>

      <div className="qs-list" id="quick-switcher-list" role="listbox" ref={list}>
        {rows.map((row, i) => (
          <button
            key={row.entry.key}
            id={`qs-${row.entry.key}`}
            type="button"
            role="option"
            aria-selected={i === cursor}
            data-active={i === cursor}
            className="qs-row"
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => setAt(i)}
            onClick={() => go(row)}
          >
            <Face store={store} entry={row.entry} />
            <span className="qs-name">
              <Marked text={row.entry.title} positions={row.positions} />
            </span>
            {row.entry.where
              ? <span className="qs-where">{row.entry.where}</span>
              : null}
          </button>
        ))}
        {rows.length ? null : (
          <p className="qs-empty">
            {text
              ? `Nothing you can reach is called “${text}”.`
              : `No ${filter ? filter.label : 'places to go'} yet.`}
          </p>
        )}
      </div>
    </div>
  );
}
