import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { faceOf } from '../lib/faces.js';
import { relative, shortName } from '../lib/util.js';
import { cn } from '../lib/cn.js';
import { clipContent } from '../lib/emoji.js';
import { renderContent } from '../lib/markdown.jsx';
import { reportError } from '../hooks/useToast.jsx';
import { useDmItems } from './chat/surface.jsx';
import {
  AttachIcon, Avatar, CloseIcon, EmojiText, EmptyState, HashIcon, ImageIcon, LinkIcon,
  MentionIcon, Pill, RowSkeleton, SearchIcon, UserIcon, VideoIcon, VoiceIcon, WarnIcon
} from '../components/index.js';

const IDLE = { status: 'idle', hits: [], message: null };
const BUSY = { status: 'busy', hits: [], message: null };

const FILTERS = [
  {
    kind: 'from',
    param: 'author',
    icon: UserIcon,
    label: 'From a specific user',
    token: 'from:',
    hint: 'from: user',
  },
  {
    kind: 'mentions',
    param: 'mentions',
    icon: MentionIcon,
    label: 'Mentions a specific user',
    token: 'mentions:',
    hint: 'mentions: user',
  },
  {
    kind: 'has',
    param: 'has',
    icon: AttachIcon,
    label: 'Includes a specific type of data',
    token: 'has:',
    hint: 'has: link, file, image, video or sound',
  },
  {
    kind: 'in',
    param: 'channel_id',
    icon: HashIcon,
    label: 'In a specific channel',
    token: 'in:',
    hint: 'in: channel',
  },
];

const BY_KIND = Object.fromEntries(FILTERS.map((f) => [f.kind, f]));

const HAS = [
  { value: 'link', icon: LinkIcon },
  { value: 'file', icon: AttachIcon },
  { value: 'image', icon: ImageIcon },
  { value: 'video', icon: VideoIcon },
  { value: 'sound', icon: VoiceIcon },
];

const family = (item, prefix) => (item.attachments || [])
  .some((a) => String(a.mime || '').toLowerCase().startsWith(prefix));

const CARRIES = {
  link: (item) => /https?:\/\//i.test(item.content || ''),
  file: (item) => (item.attachments || []).length > 0,
  image: (item) => family(item, 'image/'),
  video: (item) => family(item, 'video/'),
  sound: (item) => family(item, 'audio/'),
};

const TYPED_TOKEN = /(?:^|\s)(from|mentions|has|in):$/i;

const FULL_ID = /^@?[^:@\s]+:[^\s@]+$/;

const named = (m) => m.nickname || m.display_name || shortName(m.user_id);

const LIMIT = 50;

function paramsFor(chips, text) {
  const q = text.trim();
  if (!q && !chips.length) return null;
  const out = {};
  for (const chip of chips) out[BY_KIND[chip.kind].param] = chip.value;
  if (q) out.q = q;
  return out;
}

function hasCandidates(term) {
  return HAS
    .filter((h) => h.value.includes(term))
    .map((h) => ({ key: h.value, value: h.value, label: h.value, icon: h.icon }));
}

function memberCandidates(rows, term) {
  return rows
    .filter((m) => !term
      || named(m).toLowerCase().includes(term)
      || m.user_id.toLowerCase().includes(term))
    .sort((a, b) => named(a).localeCompare(named(b)))
    .slice(0, 60)
    .map((m) => ({
      key: m.user_id, value: m.user_id, label: named(m), sub: m.user_id, member: m,
    }));
}

function guildCandidates(store, guildId, kind, raw) {
  const term = raw.trim().replace(/^@/, '').toLowerCase();

  if (kind === 'has') return hasCandidates(term);

  if (kind === 'in') {
    return store.channelsOf(guildId)
      .filter((c) => c.type !== 'category' && (c.name || '').toLowerCase().includes(term))
      .slice(0, 60)
      .map((c) => ({ key: c.id, value: c.id, label: c.name || c.id, icon: HashIcon }));
  }

  const out = memberCandidates([...(store.members.get(guildId)?.values() || [])], term);

  const typed = FULL_ID.test(raw.trim()) ? `@${raw.trim().replace(/^@/, '')}` : null;
  if (typed && !out.some((o) => o.value.toLowerCase() === typed.toLowerCase())) {
    out.unshift({ key: typed, value: typed, label: typed, sub: 'Use this ID', icon: UserIcon });
  }
  return out;
}

function dmCandidates(convo, kind, raw) {
  const term = raw.trim().replace(/^@/, '').toLowerCase();
  if (kind === 'has') return hasCandidates(term);
  return memberCandidates(convo?.members || [], term);
}

function useSearchQuery(shape, candidatesOf) {
  const [query, setQueryState] = useState('');
  const [chips, setChips] = useState([]);
  const [pending, setPending] = useState(null);
  const [stash, setStash] = useState('');
  const [highlight, setHighlight] = useState(0);
  const queryRef = useRef('');
  const stashRef = useRef('');
  queryRef.current = query;
  stashRef.current = stash;

  const params = pending ? null : paramsFor(chips, query);
  const candidates = pending ? candidatesOf(pending, query) : [];

  const begin = useCallback((kind, keep = null) => {
    setPending(kind);
    setStash(keep === null ? queryRef.current : keep);
    setQueryState('');
    setHighlight(0);
  }, []);

  const restore = useCallback(() => {
    setQueryState(stashRef.current);
    setStash('');
    setHighlight(0);
  }, []);

  const setQuery = useCallback((next) => {
    const typed = TYPED_TOKEN.exec(next);
    if (typed && shape.filters.some((f) => f.kind === typed[1].toLowerCase())) {
      begin(typed[1].toLowerCase(), next.slice(0, typed.index));
      return;
    }
    setQueryState(next);
    setHighlight(0);
  }, [begin, shape]);

  const choose = useCallback((cand) => {
    if (!pending || !cand) return;
    const chip = {
      kind: pending, value: cand.value, label: cand.label, member: cand.member || null,
    };
    setChips((prev) => [...prev.filter((c) => c.kind !== chip.kind), chip]);
    setPending(null);
    restore();
  }, [pending, restore]);

  const removeChip = useCallback((kind) => {
    setChips((prev) => prev.filter((c) => c.kind !== kind));
  }, []);

  const reset = useCallback(() => {
    setQueryState('');
    setStash('');
    setChips([]);
    setPending(null);
    setHighlight(0);
  }, []);

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Backspace' && !query && (e.currentTarget.selectionStart ?? 0) === 0) {
      if (pending) { e.preventDefault(); setPending(null); restore(); return; }
      if (chips.length) { e.preventDefault(); setChips((prev) => prev.slice(0, -1)); }
      return;
    }
    if (!pending || !candidates.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : candidates.length - 1;
      setHighlight((i) => (i + step) % candidates.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      choose(candidates[Math.min(highlight, candidates.length - 1)]);
    }
  }, [query, pending, chips, candidates, highlight, choose, restore]);

  return {
    shape,
    query,
    setQuery,
    stash,
    chips,
    params,
    pending,
    candidates,
    highlight,
    setHighlight,
    begin,
    choose,
    removeChip,
    reset,
    onKeyDown,
  };
}

export function useGuildSearch(guildId) {
  const store = useStore();
  const [state, setState] = useState(IDLE);
  const seq = useRef(0);

  useStoreEventFor((g) => !g || g === guildId, 'members');
  useStoreEvent('channels');

  const field = useSearchQuery(
    GUILD_SHAPE,
    useCallback((kind, raw) => guildCandidates(store, guildId, kind, raw), [store, guildId]),
  );
  const { params } = field;
  const wire = params ? JSON.stringify(params) : '';

  useEffect(() => {
    seq.current += 1;
    const ticket = seq.current;
    if (!wire) { setState(IDLE); return undefined; }
    const timer = setTimeout(async () => {
      setState(BUSY);
      try {
        const resp = await store.apiForGuild(guildId).search(
          guildId,
          { ...JSON.parse(wire), limit: LIMIT },
        );
        if (ticket !== seq.current) return;
        setState({ status: 'done', hits: resp.results || resp.hits || [], message: null });
      } catch (e) {
        const message = reportError(e, 'Search failed');
        if (ticket === seq.current) setState({ status: 'error', hits: [], message });
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [store, guildId, wire]);

  return { ...field, guildId, state };
}

function dmHits(items, params) {
  const q = (params.q || '').toLowerCase();
  const author = params.author ? params.author.toLowerCase() : null;
  const mentions = params.mentions ? params.mentions.toLowerCase() : null;
  const carries = params.has ? CARRIES[params.has] : null;
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < LIMIT; i -= 1) {
    const item = items[i];
    if (item.deleted) continue;
    const text = (item.content || '').toLowerCase();
    if (q && !text.includes(q)) continue;
    if (author && (item.author || '').toLowerCase() !== author) continue;
    if (mentions && !text.includes(mentions)) continue;
    if (carries && !carries(item)) continue;
    out.push(item);
  }
  return out;
}

export function useDmSearch(conversationId, given = null) {
  const store = useStore();

  useStoreEventFor(
    (e) => !e?.conversation_id || e.conversation_id === conversationId,
    'dm',
  );
  useStoreEvent('conversations');

  const convo = given || store.conversations.find((c) => c.id === conversationId) || null;
  const frames = store.dmFrames.get(conversationId) || [];
  const items = useDmItems(frames, convo, store.mls, store.me?.user_id);

  const field = useSearchQuery(
    DM_SHAPE,
    useCallback((kind, raw) => dmCandidates(convo, kind, raw), [convo]),
  );
  const { params } = field;
  const state = params
    ? { status: 'done', hits: dmHits(items, params), message: null }
    : IDLE;

  return { ...field, conversationId, convo, state };
}

function MemberFace({ guildId, id, member, size = 'xs', className }) {
  const store = useStore();
  const face = faceOf(store, id, { guildId });
  return (
    <Avatar
      id={id}
      name={member ? named(member) : face?.name}
      size={size}
      mediaRef={face?.avatarRef}
      base={face?.base}
      mediaOrigin={face?.mediaOrigin || undefined}
      className={className}
    />
  );
}

function Chip({ guildId, chip, onRemove }) {
  const filter = BY_KIND[chip.kind];
  const person = chip.kind === 'from' || chip.kind === 'mentions';
  return (
    <button
      type="button"
      className="search-chip"
      aria-label={`Remove filter ${filter.token}${chip.label}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onRemove(chip.kind)}
    >
      <span className="search-chip-token">{filter.token}</span>
      {person ? (
        <MemberFace
          guildId={guildId}
          id={chip.value}
          member={chip.member}
          className="size-4 text-[0.5rem]"
        />
      ) : null}
      <span className="search-chip-value">{chip.label}</span>
      <CloseIcon className="size-3 shrink-0 opacity-60" />
    </button>
  );
}

export function SearchField({
  search, placeholder, label, inputRef, wrapRef, autoFocus = false, wide = false,
  onFocus, onKeyDown, expanded, controls,
}) {
  const {
    guildId, query, setQuery, chips, pending, stash, removeChip,
  } = search;
  const own = useRef(null);
  const input = inputRef || own;

  const handleKeyDown = (e) => {
    search.onKeyDown(e);
    onKeyDown?.(e);
  };

  return (
    <div ref={wrapRef} className={cn('search-field', wide && 'search-field--wide')}>
      <div
        className="search-box"
        onMouseDown={(e) => {
          if (e.target.closest('button, input')) return;
          e.preventDefault();
          input.current?.focus();
        }}
      >
        {chips.length || pending ? (
          <div className="search-tokens">
            {chips.map((chip) => (
              <Chip key={chip.kind} guildId={guildId} chip={chip} onRemove={removeChip} />
            ))}
            {stash ? <span className="search-stash">{stash.trim()}</span> : null}
            {pending ? (
              <span className="search-chip search-chip--open">
                <span className="search-chip-token">{BY_KIND[pending].token}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <input
          ref={input}
          type="text"
          className="search-field-input"
          autoFocus={autoFocus}
          placeholder={chips.length || pending || stash ? '' : placeholder}
          aria-label={label || placeholder}
          aria-expanded={expanded}
          aria-controls={controls}
          value={query}
          onFocus={onFocus}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <SearchIcon className="search-field-glyph size-4" />
    </div>
  );
}

function FilterHints({ filters, onPick }) {
  return (
    <>
      <div className="menu-label">Search options</div>
      {filters.map((f) => (
        <button
          key={f.kind}
          type="button"
          className="search-hint"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(f.kind)}
        >
          <f.icon className="size-4 shrink-0 opacity-80" />
          <span className="min-w-0 flex-1">
            <span className="search-hint-label">{f.label}</span>
            <span className="search-hint-token">{f.hint}</span>
          </span>
        </button>
      ))}
    </>
  );
}

function GuildNoCandidates({ search }) {
  const store = useStore();
  const { pending, guildId, query } = search;
  const typed = query.trim();
  if (pending === 'has') {
    return (
      <EmptyState icon={AttachIcon} title="No such kind">
        {`The server knows ${HAS.map((h) => h.value).join(', ')} and nothing else.`}
      </EmptyState>
    );
  }
  if (pending === 'in') {
    return (
      <EmptyState icon={HashIcon} title="No channel by that name">
        {typed
          ? `No channel you can see here is called ${JSON.stringify(typed)}.`
          : 'There are no channels here to search in.'}
      </EmptyState>
    );
  }
  if (!(store.members.get(guildId)?.size)) {
    return (
      <EmptyState icon={UserIcon} title="No member list yet">
        {'Waiting on this server for the member list. A full user ID works in the '
          + 'meantime -- type it out and press Enter.'}
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={UserIcon} title="Nobody by that name">
      {`No member of this server matches ${JSON.stringify(typed)}, so nothing is being `
        + 'searched yet. Try another name, or a full user ID.'}
    </EmptyState>
  );
}

function DmNoCandidates({ search }) {
  const { pending, convo, query } = search;
  const typed = query.trim();
  if (pending === 'has') {
    return (
      <EmptyState icon={AttachIcon} title="No such kind">
        {`A message can be filtered by ${HAS.map((h) => h.value).join(', ')} and nothing else.`}
      </EmptyState>
    );
  }
  if (!(convo?.members || []).length) {
    return (
      <EmptyState icon={UserIcon} title="No members yet">
        Waiting on your home server for who is in this conversation.
      </EmptyState>
    );
  }
  return (
    <EmptyState icon={UserIcon} title="Nobody by that name">
      {`Nobody in this conversation matches ${JSON.stringify(typed)}. Everyone who has `
        + 'ever written here is in the list above it.'}
    </EmptyState>
  );
}

function ValuePicker({ search }) {
  const {
    guildId, pending, candidates, highlight, choose, setHighlight, shape,
  } = search;
  if (!candidates.length) return <shape.NoCandidates search={search} />;
  const person = pending === 'from' || pending === 'mentions';
  return (
    <>
      <div className="menu-label">{BY_KIND[pending].label}</div>
      <div role="listbox" aria-label={BY_KIND[pending].label} className="flex flex-col">
        {candidates.map((c, i) => (
          <button
            key={c.key}
            type="button"
            role="option"
            aria-selected={i === Math.min(highlight, candidates.length - 1)}
            className={cn('search-pick', i === Math.min(highlight, candidates.length - 1) && 'is-on')}
            onMouseDown={(e) => e.preventDefault()}
            onPointerEnter={() => setHighlight(i)}
            onClick={() => choose(c)}
          >
            {person && !c.icon
              ? <MemberFace guildId={guildId} id={c.value} member={c.member} size="sm" />
              : <c.icon className="size-4 shrink-0 opacity-80" />}
            <span className="min-w-0 flex-1">
              <span className="search-pick-name"><EmojiText>{c.label}</EmojiText></span>
              {c.sub ? <span className="search-pick-sub">{c.sub}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

export function SearchHits({ search, hits, onPick }) {
  const store = useStore();
  const { guildId } = search;
  return hits.map((hit) => (
    <button
      type="button"
      key={hit.id || `${hit.channel_id}-${hit.created_at}`}
      className="search-hit"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPick?.();
        store.navigate({ guildId, channelId: hit.channel_id });
      }}
    >
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <HashIcon className="size-3" />
        <span className="font-medium text-foreground">
          <EmojiText>{store.channels.get(hit.channel_id)?.name || hit.channel_id}</EmojiText>
        </span>
        {shortName(hit.author)}
        {hit.archived ? <Pill>archived</Pill> : null}
      </span>
      <span className="msg-preview text-sm leading-[1.55] break-words">
        {renderContent(clipContent(hit.content || '', 240), {
          me: store.me?.user_id,
          store,
          guildId,
        })}
      </span>
    </button>
  ));
}

function DmHits({ search, hits, onPick }) {
  const store = useStore();
  const { conversationId } = search;
  return hits.map((hit) => (
    <button
      type="button"
      key={hit.id}
      className="search-hit"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onPick?.();
        store.jumpTo(conversationId, hit.id);
      }}
    >
      <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <MemberFace id={hit.author} className="size-4 text-[0.5rem]" />
        <span className="font-medium text-foreground">{shortName(hit.author)}</span>
        {hit.created_at ? relative(hit.created_at) : null}
      </span>
      <span className="msg-preview text-sm leading-[1.55] break-words">
        {renderContent(clipContent(hit.content || '', 240), { me: store.me?.user_id, store })}
      </span>
    </button>
  ));
}

function describe(query, chips, where) {
  const q = query.trim();
  const named_ = chips.map((c) => `${BY_KIND[c.kind].token}${c.label}`).join(' ');
  if (q && named_) return `Nothing in ${where} matches ${JSON.stringify(q)} with ${named_}.`;
  if (q) return `Nothing in ${where} matches ${JSON.stringify(q)}.`;
  return `Nothing in ${where} matches ${named_}.`;
}

export function SearchBody({ search, onPick, idle = null }) {
  const {
    state, pending, query, chips, shape,
  } = search;
  if (pending) return <ValuePicker search={search} />;
  if (state.status === 'busy') return <RowSkeleton rows={4} />;
  if (state.status === 'error') {
    return <EmptyState icon={WarnIcon} title="Search failed">{state.message}</EmptyState>;
  }
  if (state.status === 'idle') {
    return (
      <>
        {idle}
        <FilterHints filters={shape.filters} onPick={search.begin} />
      </>
    );
  }
  if (!state.hits.length) {
    return (
      <EmptyState icon={SearchIcon} title="No matches">
        {describe(query, chips, shape.where)}
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <shape.Hits search={search} hits={state.hits} onPick={onPick} />
    </div>
  );
}

const GUILD_SHAPE = {
  filters: FILTERS,
  where: 'this server',
  Hits: SearchHits,
  NoCandidates: GuildNoCandidates,
};

const DM_SHAPE = {
  filters: FILTERS.filter((f) => f.kind !== 'in'),
  where: 'this conversation',
  Hits: DmHits,
  NoCandidates: DmNoCandidates,
};

function HeaderSearchShell({
  search, placeholder, label, idle = null, onEnter = null, onEscape = null,
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const wrap = useRef(null);
  const panel = useRef(null);
  const input = useRef(null);
  const panelId = useId();

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const r = wrap.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom + 6, right: window.innerWidth - r.right, width: r.width });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrap.current?.contains(e.target) || panel.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (!onEnter || e.defaultPrevented || search.pending || !search.params) return;
      e.preventDefault();
      if (onEnter(search)) setOpen(false);
      return;
    }
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    if (onEscape?.()) return;
    search.reset();
    input.current?.blur();
  };

  return (
    <>
      <SearchField
        search={search}
        wrapRef={wrap}
        inputRef={input}
        placeholder={placeholder}
        label={label || placeholder}
        expanded={open}
        controls={open ? panelId : undefined}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && anchor ? createPortal((
        <div
          ref={panel}
          id={panelId}
          className="popup search-panel"
          role="dialog"
          aria-label="Search"
          style={{ top: anchor.top, right: anchor.right, '--anchor-w': `${anchor.width}px` }}
          onKeyDown={onKeyDown}
        >
          <SearchBody search={search} idle={idle} onPick={() => setOpen(false)} />
        </div>
      ), document.body) : null}
    </>
  );
}

export function HeaderSearch({ guildId, name }) {
  const store = useStore();
  const search = useGuildSearch(guildId);
  return (
    <HeaderSearchShell
      search={search}
      placeholder={`Search ${name || 'this server'}`}
      onEnter={(s) => {
        store.commitSearch(guildId, s.params, { chips: s.chips, query: s.query });
        return true;
      }}
      onEscape={() => {
        if (!store.committedSearch) return false;
        store.clearSearch();
        return true;
      }}
    />
  );
}

export function DmHeaderSearch({ conversationId, convo }) {
  const search = useDmSearch(conversationId, convo);
  return (
    <HeaderSearchShell
      search={search}
      placeholder="Search this conversation"
    />
  );
}
