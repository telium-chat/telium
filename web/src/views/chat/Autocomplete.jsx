import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar.jsx';
import { EmojiText, Twemoji } from '../../components/Twemoji.jsx';
import { loadEmoji, searchEmoji } from '../../lib/emoji.js';
import { displayNameOf, displayText, mentionToken } from '../../lib/mentions.js';
import { remoteMediaOrigin } from '../../lib/media.js';
import { colourOf, shortName } from '../../lib/util.js';
import { channelGlyph, isLinkable } from '../../lib/channels.js';
import { has } from '../../lib/perms.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';

const LIMIT = 8;

const REMOTE_DEBOUNCE_MS = 200;
const REMOTE_LIMIT = 25;

function channelHint(store, channel) {
  if (channel.topic) return channel.topic;
  if (channel.type === 'voice') {
    const here = store.voice?.get(channel.id)?.length || 0;
    const limit = channel.user_limit || 0;
    if (here) {
      return limit
        ? t('chat.autocomplete.voiceHereOfLimit', { count: here, limit })
        : t('chat.autocomplete.voiceHere', { count: here });
    }
    if (limit) return t('chat.autocomplete.voiceLimit', { limit });
  }
  return '';
}

export function tokenAt(text, caret) {
  const before = text.slice(0, caret);
  let m = /(?:^|[\s([{>])([@#])([^\s@#:]{0,32})$/.exec(before);
  if (m) {
    return {
      kind: m[1] === '@' ? 'mention' : 'channel',
      query: m[2],
      start: caret - m[2].length - 1,
    };
  }
  m = /(?:^|[\s([{])(:)([a-zA-Z0-9_+-]{2,32})$/.exec(before);
  if (m) return { kind: 'emoji', query: m[2], start: caret - m[2].length - 1 };
  return null;
}

function person(store, guildId, member) {
  const id = member.user_id;
  const mine = id === store?.me?.user_id;
  const guild = guildId ? store?.guilds?.get?.(guildId) : null;
  return {
    key: id,
    insert: mentionToken('user', id),
    label: member.nickname || member.display_name || displayNameOf(store, guildId, id),
    hint: id,
    colour: guildId ? store.colourFor(guildId, id) : null,
    avatar: {
      id,
      name: member.display_name || member.nickname || null,
      mediaRef: (mine ? store?.me?.profile?.avatar_ref : null) || member.avatar_ref || null,
      base: (mine || !guild ? store?.home?.base : store?.apiForGuild?.(guildId)?.base) || null,
      mediaOrigin: mine ? undefined : remoteMediaOrigin(id, guild?.domain || store?.home?.domain),
      presence: store?.statusOf?.(id) || null,
    },
  };
}

export function suggestFor(store, where, token, emojiCatalogue, remoteMembers) {
  if (!token) return [];
  const guildId = where.guildId ?? where.guild_id ?? null;
  const q = token.query.toLowerCase();
  const out = [];

  if (token.kind === 'mention' && !guildId && where.people) {
    for (const userId of where.people()) {
      if (!userId.toLowerCase().includes(q)) continue;
      out.push(person(store, null, { user_id: userId }));
    }
    return out.slice(0, LIMIT);
  }

  if (token.kind === 'mention' && guildId) {
    const mayBroadcast = has(store.permissionsIn(where.id), 'MENTION_EVERYONE');
    for (const word of ['everyone', 'here']) {
      if (mayBroadcast && word.startsWith(q)) {
        out.push({
          key: `@${word}`,
          insert: `@${word}`,
          label: word,
          hint: t('chat.autocomplete.notifyChannel'),
        });
      }
    }
    for (const role of store.roleList(guildId)) {
      if (!role.mentionable && !mayBroadcast) continue;
      if (!role.name.toLowerCase().includes(q)) continue;
      out.push({
        key: role.id,
        insert: mentionToken('role', role.id),
        label: role.name,
        colour: colourOf(role.color),
        hint: t('chat.autocomplete.role'),
      });
    }
    const members = [...(store.members.get(guildId)?.values() || [])];
    for (const member of members) {
      const name = displayNameOf(store, guildId, member.user_id);
      if (!name.toLowerCase().includes(q) && !member.user_id.toLowerCase().includes(q)) continue;
      out.push(person(store, guildId, member));
    }

    // Server results go below the store's: reordering under Enter would mention the wrong person.
    const offered = new Set(out.map((row) => row.key));
    for (const member of remoteMembers || []) {
      if (offered.has(member.user_id)) continue;
      offered.add(member.user_id);
      out.push(person(store, guildId, member));
    }
  }

  if (token.kind === 'channel' && guildId) {
    for (const ch of store.channels.values()) {
      if (ch.guild_id !== guildId || !isLinkable(ch)) continue;
      if (!has(store.permissionsIn(ch.id), 'VIEW_CHANNEL')) continue;
      if (!ch.name?.toLowerCase().includes(q)) continue;
      out.push({
        key: ch.id,
        insert: `<#${ch.id}>`,
        label: ch.name,
        icon: channelGlyph(ch),
        hint: channelHint(store, ch),
      });
    }
  }

  if (token.kind === 'emoji') {
    for (const [gid, ems] of store.emojis) {
      const base = store.apiForGuild(gid)?.base || '';
      const origin = store.guilds.get(gid)?.domain || '';
      const local = gid === guildId;
      for (const em of ems) {
        if (!em.name.toLowerCase().includes(q)) continue;
        out.push({
          key: em.id,
          insert: `<${em.name}:${em.id}${origin ? `@${origin}` : ''}>`,
          label: `:${em.name}:`,
          image: `${base}/_telium/v1/emoji/${em.id}`,
          hint: local
            ? t('chat.autocomplete.emojiCustom')
            : t('chat.autocomplete.emojiFrom', {
              guild: store.guilds.get(gid)?.name || t('chat.autocomplete.otherGuild'),
            }),
        });
      }
    }
    for (const entry of searchEmoji(emojiCatalogue || [], token.query).slice(0, LIMIT)) {
      out.push({
        key: entry.unicode,
        insert: entry.unicode,
        label: entry.shortcode ? `:${entry.shortcode}:` : entry.label,
        hint: entry.shortcode ? entry.label : '',
        emoji: entry.unicode,
      });
    }
  }

  return out.slice(0, LIMIT);
}

export function useAutocomplete({ store, surface, text, setText, textareaRef }) {
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [catalogue, setCatalogue] = useState(null);
  const [dismissed, setDismissed] = useState('');
  const [remote, setRemote] = useState({ query: null, rows: [] });
  const search = useRef(0);

  const token = useMemo(() => tokenAt(text, caret), [text, caret]);

  useEffect(() => {
    if (token?.kind === 'emoji' && !catalogue) loadEmoji().then(setCatalogue);
    if (token?.kind === 'emoji') {
      for (const guild of store.guilds.values()) {
        store.loadExpressions(guild.id).catch(() => {});
      }
    }
  }, [token?.kind, catalogue, store]);

  const guildId = surface.guildId ?? surface.guild_id ?? null;
  const shut = !!token && dismissed === `${token.kind}:${token.start}`;

  const wanted = !shut && token?.kind === 'mention' && guildId && token.query
    ? token.query
    : null;

  const items = useMemo(
    () => (token && !shut
      ? suggestFor(store, surface, token, catalogue,
        remote.query !== null && remote.query === wanted ? remote.rows : [])
      : []),
    [store, surface, token, catalogue, shut, remote, wanted],
  );

  useEffect(() => {
    if (!wanted) {
      setRemote((held) => (held.query === null ? held : { query: null, rows: [] }));
      return undefined;
    }
    if (wanted === remote.query) return undefined;
    if (items.length >= LIMIT) return undefined;

    const run = ++search.current;
    const timer = setTimeout(() => {
      const api = store.apiForGuild(guildId);
      const settle = (rows) => { if (run === search.current) setRemote({ query: wanted, rows }); };
      if (!api?.members) { settle([]); return; }
      api.members(guildId, { q: wanted, limit: REMOTE_LIMIT })
        .then((resp) => settle(resp.members || []))
        .catch(() => settle([]));
    }, REMOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [store, guildId, wanted, remote.query]);

  const searching = !!wanted && remote.query !== wanted && items.length < LIMIT;

  useEffect(() => { setIndex(0); }, [token?.kind, token?.query]);

  const sync = (el) => setCaret(el.selectionStart ?? 0);

  const accept = (item) => {
    const end = token.start + 1 + token.query.length;
    const shown = displayText(item.insert, { store, guildId, me: store.me?.user_id });
    const next = `${text.slice(0, token.start)}${shown} ${text.slice(end)}`;
    const at = token.start + shown.length + 1;
    setText(next);
    setDismissed('');
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  const onKeyDown = (e) => {
    if (!items.length) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % items.length); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + items.length) % items.length); return true; }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(items[index]); return true; }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(`${token.kind}:${token.start}`);
      setIndex(0);
      return true;
    }
    return false;
  };

  return { items, index, setIndex, accept, onKeyDown, sync, searching, open: items.length > 0 };
}

export function AutocompletePopup({ items, index, onPick, onHover, searching = false }) {
  const t = useT();
  if (!items.length && !searching) return null;
  return (
    <div className="popup absolute inset-x-0 bottom-full z-20 mb-1.5">
      <ul data-mobile-scroll className="max-h-[min(38dvh,280px)] overflow-y-auto">
        {!items.length ? (
          <li className="menu-row text-muted">{t('chat.autocomplete.searching')}</li>
        ) : null}
        {items.map((item, i) => {
          const Icon = item.icon;
          return (
          <li key={item.key}>
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); onPick(item); }}
              onMouseEnter={() => onHover(i)}
              className="menu-row min-h-11 sm:min-h-0"
              data-selected={i === index ? '' : undefined}
            >
              {item.emoji ? <Twemoji emoji={item.emoji} /> : null}
              {item.image ? <img src={item.image} alt="" className="size-[18px]" /> : null}
              {item.avatar ? <Avatar size="sm" {...item.avatar} /> : null}
              {item.avatar ? (
                <span className="min-w-0 flex-1">
                  <span
                    className={item.colour ? 'block truncate font-medium role-ink' : 'block truncate font-medium'}
                    style={item.colour ? { '--role': item.colour } : undefined}
                  >
                    <EmojiText>{item.label}</EmojiText>
                  </span>
                  <span className="block truncate text-xs text-muted">{item.hint}</span>
                </span>
              ) : (
                <>
                  <span
                    className={item.colour ? 'truncate font-medium role-ink' : 'truncate font-medium'}
                    style={item.colour ? { '--role': item.colour } : undefined}
                  >
                    <EmojiText>{item.label}</EmojiText>
                  </span>
                  {item.hint
                    ? <span className="ms-auto truncate ps-2 text-xs text-muted"><EmojiText>{item.hint}</EmojiText></span>
                    : null}
                </>
              )}
            </button>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
