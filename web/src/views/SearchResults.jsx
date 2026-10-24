import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { reportError } from '../hooks/useToast.jsx';
import { dayOf, relative, shortName, timeOf } from '../lib/util.js';
import { remoteMediaOrigin } from '../lib/media.js';
import { renderContent } from '../lib/markdown.jsx';
import { cn } from '../lib/cn.js';
import { useDismiss } from '../hooks/useAnchoredPopover.js';
import {
  Avatar, BotBadge, Button, CheckIcon, CloseIcon, EmojiText, EmptyState, HashIcon, IconButton,
  MenuButton, MenuItem, Pill, RowSkeleton, SearchIcon, SortIcon, WarnIcon
} from '../components/index.js';
import { Attachments } from './chat/Attachments.jsx';

const PAGE = 25;

const ORDERS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
];

const NoTick = ({ className }) => <span aria-hidden="true" className={className} />;

const TOKEN = {
  from: 'from:', mentions: 'mentions:', has: 'has:', in: 'in:',
};

function useAuthor(guildId, userId) {
  const store = useStore();
  const member = store.members.get(guildId)?.get(userId);
  const own = userId === store.me?.user_id ? store.me?.profile : null;
  return {
    name: member?.nickname || member?.display_name || own?.display_name || shortName(userId),
    colour: store.colourFor(guildId, userId),
    avatar: {
      name: member?.display_name || own?.display_name,
      mediaRef: own?.avatar_ref || member?.avatar_ref || null,
      base: own ? store.home?.base : store.apiForGuild(guildId)?.base,
      mediaOrigin: own
        ? undefined
        : remoteMediaOrigin(userId, store.guilds.get(guildId)?.domain),
    },
  };
}

function HitCard({ guildId, hit }) {
  const store = useStore();
  const { name, colour, avatar } = useAuthor(guildId, hit.author);
  const channel = store.channels.get(hit.channel_id);

  const go = (e) => {
    if (e.target.closest?.('a, button, [role="button"]:not(.hit-card)')) return;
    if (hit.archived) store.navigate({ view: 'chat', guildId, channelId: hit.channel_id });
    else store.jumpTo(hit.channel_id, hit.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Jump to the message ${name} sent in ${channel?.name || hit.channel_id}`}
      className="hit-card rise-in flex gap-3 px-3 py-2.5 focus-outside"
      onClick={go}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        go(e);
      }}
    >
      <Avatar size="md" id={hit.author} {...avatar} />

      <div className="min-w-0 flex-1">
        <div className="hit-card__where">
          <HashIcon className="size-3 shrink-0" />
          <span className="truncate"><EmojiText>{channel?.name || hit.channel_id}</EmojiText></span>
          {hit.archived ? <Pill>archived</Pill> : null}
        </div>

        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={colour ? 'truncate text-sm font-medium role-ink' : 'truncate text-sm font-medium'}
            style={colour ? { '--role': colour } : undefined}
            title={hit.author}
          >
            <EmojiText>{name}</EmojiText>
          </span>
          <BotBadge userId={hit.author} guildId={guildId} />
          <span
            className="tnum shrink-0 text-2xs text-muted"
            title={hit.created_at ? `${dayOf(hit.created_at)} at ${timeOf(hit.created_at)}` : undefined}
          >
            {hit.created_at ? relative(hit.created_at) : 'from archived history'}
          </span>
        </div>

        <div className="hit-card__body md pt-0.5 text-base leading-[1.55] break-words">
          {renderContent(hit.content || '', { me: store.me?.user_id, store, guildId })}
        </div>

        <Attachments msg={hit} base={store.apiForGuild(guildId)?.base} encrypted={false} />
      </div>
    </div>
  );
}

function Asked({ chips, query }) {
  if (!chips.length && !query.trim()) return null;
  return (
    <div className="search-results__asked">
      {chips.map((chip) => (
        <span key={chip.kind} className="search-results__token">
          <span className="search-results__token-key">{TOKEN[chip.kind] || `${chip.kind}:`}</span>
          <span className="truncate"><EmojiText>{chip.label}</EmojiText></span>
        </span>
      ))}
      {query.trim() ? <span className="truncate">{JSON.stringify(query.trim())}</span> : null}
    </div>
  );
}

function pageNumbers(page, count) {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const from = Math.min(Math.max(page - 1, 1), count - 4);
  const window = [from, from + 1, from + 2];
  return [
    0,
    ...(window[0] > 2 ? [-1] : window[0] === 2 ? [1] : []),
    ...window,
    ...(window[2] < count - 3 ? [-1] : window[2] === count - 3 ? [count - 2] : []),
    count - 1,
  ];
}

export function SearchResultsPane({ committed }) {
  const store = useStore();
  const { guildId, params, chips, query } = committed;
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState('newest');
  const [state, setState] = useState({ status: 'busy', hits: [], message: null });
  const list = useRef(null);
  useStoreEventFor((g) => !g || g === guildId, 'members', 'roles');
  useStoreEvent('channels');

  const wire = JSON.stringify(params);

  useEffect(() => {
    let live = true;
    setState((prev) => ({
      status: 'busy',
      hits: [],
      message: null,
      total: prev.total,
      more: prev.more,
      sortable: prev.sortable,
    }));
    store.apiForGuild(guildId)
      .search(guildId, {
        ...JSON.parse(wire), limit: PAGE, offset: page * PAGE, order,
      })
      .then((resp) => {
        if (!live) return;
        const hits = resp.results || [];
        setState({
          status: 'done',
          hits,
          message: null,
          total: Number.isFinite(resp.total) ? resp.total : null,
          more: typeof resp.has_more === 'boolean' ? resp.has_more : hits.length === PAGE,
          sortable: typeof resp.has_more === 'boolean' && Number.isFinite(resp.total),
        });
        if (list.current) list.current.scrollTop = 0;
      })
      .catch((e) => {
        const message = reportError(e, 'Search failed');
        if (live) setState({ status: 'error', hits: [], message });
      });
    return () => { live = false; };
  }, [store, guildId, wire, page, order]);

  const dismiss = useCallback(() => store.clearSearch(), [store]);

  useDismiss(dismiss, { pointer: false, capture: false });

  const { hits } = state;
  const total = state.total ?? null;
  const pages = total === null ? null : Math.ceil(total / PAGE);
  const first = page * PAGE + 1;
  const sort = ORDERS.find((o) => o.value === order) || ORDERS[0];

  return (
    <aside className="search-results" aria-label="Search results">
      <div className="search-results__head">
        <SearchIcon className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">
          {total === null ? 'Search results' : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`}
          {hits.length ? (
            <span className="search-results__range">
              {`${first.toLocaleString()}–${(first + hits.length - 1).toLocaleString()}`}
            </span>
          ) : null}
        </span>
        <IconButton title="Close search" onClick={dismiss}>
          <CloseIcon className="size-4" />
        </IconButton>
      </div>

      <Asked chips={chips} query={query} />

      {state.sortable ? (
        <div className="search-results__tools">
          <MenuButton
            label="Sort results"
            placement="bottom start"
            className="search-results__sort"
            content={ORDERS.map((o) => (
              <MenuItem
                key={o.value}
                icon={o.value === order ? CheckIcon : NoTick}
                onAction={() => {
                  if (o.value === order) return;
                  setPage(0);
                  setOrder(o.value);
                }}
              >
                {o.label}
              </MenuItem>
            ))}
          >
            <SortIcon className="size-3.5 shrink-0" />
            <span className="truncate">{sort.label}</span>
          </MenuButton>
        </div>
      ) : null}

      <div ref={list} className="search-results__list">
        {state.status === 'busy' ? <RowSkeleton rows={5} /> : null}
        {state.status === 'error' ? (
          <EmptyState icon={WarnIcon} title="Search failed">{state.message}</EmptyState>
        ) : null}
        {state.status === 'done' && !hits.length ? (
          <EmptyState icon={SearchIcon} title={page ? 'End of the results' : 'No matches'}>
            {page
              ? 'There was nothing on this page. Go back a page for the last of the hits.'
              : 'Nothing on this server matches what you asked for.'}
          </EmptyState>
        ) : null}
        {hits.map((hit) => (
          <HitCard
            key={hit.id || `${hit.channel_id}-${hit.created_at}`}
            guildId={guildId}
            hit={hit}
          />
        ))}
      </div>

      <div className="search-results__pager">
        <Button
          variant="ghost"
          size="sm"
          disabled={page === 0 || state.status === 'busy'}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
        >
          Previous
        </Button>
        <div className="search-results__pages">
          {pageNumbers(page, pages ?? page + 1).map((n, i) => (n < 0 ? (
            // eslint-disable-next-line react/no-array-index-key
            <span key={`gap-${i}`} className="search-results__gap">&hellip;</span>
          ) : (
            <button
              key={n}
              type="button"
              className={cn('search-results__page', n === page && 'is-on')}
              aria-current={n === page ? 'page' : undefined}
              onClick={() => setPage(n)}
            >
              {n + 1}
            </button>
          )))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={!state.more || state.status === 'busy'}
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </aside>
  );
}
