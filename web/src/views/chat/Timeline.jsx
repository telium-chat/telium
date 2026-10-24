import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { copyWithEmoji } from '../../lib/clipboard.js';
import { useT } from '../../lib/i18n/react.jsx';
import { dayOf } from '../../lib/util.js';
import { EmptyState, MessageIcon, RowSkeleton } from '../../components/index.js';
import { MessageRow } from './MessageRow.jsx';
import { CallLogRow } from './CallLog.jsx';
import { PinNoticeRow } from './PinNotice.jsx';
import { EphemeralMessages } from './EphemeralMessages.jsx';

const scrollMemory = new Map();
const SCROLL_MEMORY_MAX = 60;

const BOTTOM_SLACK = 60;

const SKELETON_AFTER_MS = 180;

function useSettled(active, ms) {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!active) { setSettled(false); return undefined; }
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return settled && active;
}

export function Timeline({
  surface, items, pending = [], loading = false, error = null,
  notices = null, intro = null, empty = null,
  hasMore = false, fetchingOlder = false, onLoadOlder = null,
  firstUnread = null,
  editing = null, onEdit, onReply,
  mobile = false, onOpenNavigation = null,
}) {
  const t = useT();
  const store = useStore();
  useStoreEvent('prefs');
  const dateOrder = store.prefs?.dateFormat;
  const [wanted, setWanted] = useState(null);
  const [landed, setLanded] = useState(null);
  const [showJump, setShowJump] = useState(false);

  const scrollerRef = useRef(null);
  const atBottom = useRef(true);
  const anchor = useRef(null);
  const measured = useRef(0);
  const loadingOlder = useRef(false);
  const surfaceId = surface.id;
  useStoreEventFor((e) => e === surfaceId, 'pin-notice');

  const pin = (el) => {
    el.scrollTop = el.scrollHeight;
    measured.current = el.scrollHeight;
  };

  const known = useRef(null);
  const knownFor = useRef(surfaceId);
  if (knownFor.current !== surfaceId) {
    knownFor.current = surfaceId;
    known.current = null;
  }

  useEffect(() => {
    setWanted(null);
    setLanded(null);
  }, [surfaceId]);

  const arriving = useRef(true);
  useLayoutEffect(() => {
    arriving.current = true;
    const remembered = scrollMemory.get(surfaceId);
    atBottom.current = remembered ? remembered.atBottom : true;
    setShowJump(remembered ? !remembered.atBottom : false);
  }, [surfaceId]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (arriving.current && !loading) {
      arriving.current = false;
      const remembered = scrollMemory.get(surfaceId);
      if (remembered && !remembered.atBottom) {
        el.scrollTop = Math.min(remembered.top, el.scrollHeight - el.clientHeight);
        measured.current = el.scrollHeight;
        anchor.current = null;
        return;
      }
    }
    if (anchor.current != null) {
      el.scrollTop += el.scrollHeight - anchor.current;
      measured.current = el.scrollHeight;
      anchor.current = null;
    } else if (atBottom.current && !wanted && !landed) {
      pin(el);
    } else {
      measured.current = el.scrollHeight;
    }
  });

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const stream = el.firstElementChild;
    if (!stream) return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && !wanted && !landed) pin(el);
      else measured.current = el.scrollHeight;
    });
    observer.observe(stream);
    observer.observe(el);
    return () => observer.disconnect();
  }, [surfaceId, wanted, landed]);

  const sentCount = useRef(pending.length);
  useLayoutEffect(() => {
    if (pending.length > sentCount.current) {
      atBottom.current = true;
      setShowJump(false);
    }
    sentCount.current = pending.length;
  }, [pending.length]);

  const loadOlder = useCallback(async () => {
    if (!onLoadOlder || loadingOlder.current || !hasMore) return;
    loadingOlder.current = true;
    anchor.current = scrollerRef.current?.scrollHeight ?? null;
    try { await onLoadOlder(); }
    catch (e) { anchor.current = null; reportError(e, t('chat.timeline.loadOlderFailed')); }
    finally { loadingOlder.current = false; }
  }, [onLoadOlder, hasMore, t]);

  const headRef = useRef(null);
  useEffect(() => {
    const el = headRef.current;
    const root = scrollerRef.current;
    if (!el || !root || !hasMore || typeof IntersectionObserver === 'undefined') return undefined;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadOlder();
    }, { root, rootMargin: '200px 0px 0px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [hasMore, loading, loadOlder]);

  useEffect(() => {
    if (loading || fetchingOlder || !hasMore) return;
    const el = scrollerRef.current;
    if (!el || el.scrollHeight > el.clientHeight + 40) return;
    loadOlder();
  }, [loading, fetchingOlder, hasMore, items.length, loadOlder]);

  useEffect(() => {
    const take = () => {
      const jump = store.takeJump(surfaceId);
      if (jump) setWanted(jump.messageId);
    };
    const off = store.on('jump', take);
    take();
    return off;
  }, [store, surfaceId]);

  useEffect(() => {
    if (!wanted || loading) return undefined;
    let live = true;
    (async () => {
      let found = false;
      if (surface.kind === 'channel') {
        try { found = await store.loadUntil(surfaceId, wanted); }
        catch (e) { if (live) reportError(e, t('chat.timeline.jumpFailed')); }
      } else {
        found = items.some((m) => m.id === wanted);
      }
      if (!live) return;
      setWanted(null);
      if (found) { atBottom.current = false; setLanded(wanted); }
      else toast(t('chat.timeline.messageGone'));
    })();
    return () => { live = false; };
  }, [store, surfaceId, surface.kind, wanted, loading, items, t]);

  useEffect(() => {
    if (!landed) return undefined;
    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
    const center = () => {
      const el = scrollerRef.current;
      const row = el?.querySelector(`[data-id="${CSS.escape(landed)}"]`);
      if (!el || !row) return;
      const elRect = el.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const target = el.scrollTop + (rowRect.top - elRect.top)
        - (el.clientHeight / 2) + (rowRect.height / 2);
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(target, max));
    };
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        center();
        raf3 = requestAnimationFrame(center);
      });
    });
    const timer = setTimeout(() => setLanded(null), 2000);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      cancelAnimationFrame(raf3);
      clearTimeout(timer);
    };
  }, [landed]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    const grew = el.scrollHeight - measured.current;
    measured.current = el.scrollHeight;
    const held = atBottom.current && grew > 0 && gap <= grew + BOTTOM_SLACK;
    const near = gap < BOTTOM_SLACK || held;
    atBottom.current = near;
    remember(surfaceId, el.scrollTop, near);
    setShowJump((shown) => (shown === !near ? shown : !near));
    if (el.scrollTop < 200) loadOlder();
    if (near) surface.ack();
  };

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    atBottom.current = true;
    measured.current = el.scrollHeight;
    remember(surfaceId, el.scrollHeight, true);
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    surface.ack();
  }, [surface, surfaceId]);

  const me = store.me?.user_id;
  const myRoles = store.myMember(surface.guildId)?.roles || [];
  const byId = new Map(items.map((m) => [m.id, m]));
  const threads = new Map(
    (store.threads.get(surfaceId) || []).map((t) => [t.starter_id, t]),
  );

  const pinNotices = store.pinNoticesIn?.(surfaceId) || [];
  const stream = withPinNotices(withPending(items, pending, surfaceId), pinNotices);

  const placeholder = intro ? null : (empty || (
    <EmptyState icon={MessageIcon} title={t('chat.timeline.empty.title')}>
      {t('chat.timeline.empty.body')}
    </EmptyState>
  ));

  const slow = useSettled(loading, SKELETON_AFTER_MS);

  return (
    <>
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        onCopy={copyWithEmoji}
        className="chat-scroller flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-2"
      >
        <div className="chat-stream">
          {notices}
          {slow ? <div className="px-2 pt-4"><RowSkeleton rows={6} /></div> : null}
          {error ? <EmptyState>{reportError(error, t('chat.timeline.loadHistoryFailed'))}</EmptyState> : null}
          {!loading && !error ? (
            <>
              {hasMore ? (
                <div ref={headRef} className="flex min-h-10 items-center justify-center gap-2 py-3 text-xs text-muted">
                  {fetchingOlder ? (
                    <>
                      <span className="size-3 animate-spin rounded-full border-[1.5px] border-border border-t-accent" />
                      {t('chat.timeline.loadingOlder')}
                    </>
                  ) : null}
                </div>
              ) : intro}
              {rowsFor(stream, firstUnread).map((row) => {
                if (row.kind === 'day') return <DayBreak key={`day-${row.key}`} label={row.label} />;
                if (row.kind === 'new') return <NewMarker key="new-marker" />;
                if (row.kind === 'call') return <CallLogRow key={row.msg.id} entry={row.msg} />;
                if (row.kind === 'pin') {
                  return <PinNoticeRow key={row.msg.id} entry={row.msg} surface={surface} mobile={mobile} />;
                }
                const msg = row.msg;
                const key = msg.nonce || msg.id;
                if (known.current === null) {
                  known.current = new Set(items.map((m) => m.nonce || m.id));
                }
                const fresh = !known.current.has(key);
                known.current.add(key);
                return (
                  <MessageRow
                    key={key}
                    msg={msg}
                    surface={surface}
                    grouped={row.grouped}
                    dateOrder={dateOrder}
                    member={surface.memberOf(msg.author)}
                    colour={surface.colourFor(msg.author)}
                    parent={msg.parent !== undefined
                      ? msg.parent
                      : (msg.reply_to ? byId.get(msg.reply_to) : null)}
                    thread={threads.get(msg.id)}
                    mentionsMe={mentions(msg, me, myRoles)}
                    pinned={surface.isPinned?.(msg) ?? Boolean(msg.pinned)}
                    flash={landed === msg.id}
                    fresh={fresh}
                    pending={Boolean(msg.pending || msg.saving)}
                    mobile={mobile}
                    editing={editing === msg.id}
                    onEdit={onEdit}
                    onReply={onReply}
                    onOpenNavigation={onOpenNavigation}
                  />
                );
              })}
              {!stream.length ? placeholder : null}
            </>
          ) : null}
          {/* Outside the row list: ephemeral replies have no position in the ordering. */}
          <EphemeralMessages surface={surface} channelId={surface.id} me={me} />
        </div>
      </div>
      {mobile && showJump ? (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute end-4 bottom-20 z-20 flex size-10 items-center justify-center rounded-full border border-border bg-surface shadow-lg"
          aria-label={t('chat.timeline.jumpToBottom')}
        >
          <svg className="size-5 text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </button>
      ) : null}
    </>
  );
}

function mentions(msg, me, myRoles) {
  if (!me || msg.author === me) return false;
  const text = msg.content || '';
  return text.includes(me)
    || /@everyone\b|@here\b/.test(text)
    || myRoles.some((id) => text.includes(`<@&${id}>`));
}

const CLOCK_SLACK = 60 * 1000;

function withPending(items, pending, surfaceId) {
  if (!pending.length) return items;

  const confirmed = new Set();
  const mine = [];
  for (const m of items) {
    if (m.nonce) confirmed.add(m.nonce);
    else if (!m.pending) mine.push(m);
  }
  const claimed = new Set();
  const waiting = pending.filter((g) => {
    if (confirmed.has(g.nonce)) return false;
    const echo = mine.find((m) => (
      !claimed.has(m.id)
      && m.author === g.author
      && m.content === g.content
      && m.created_at >= g.created_at - CLOCK_SLACK
    ));
    if (!echo) return true;
    claimed.add(echo.id);
    return false;
  });
  if (!waiting.length) return items;
  return items.concat(waiting.map((g) => ({
    kind: 'msg',
    id: g.nonce,
    nonce: g.nonce,
    channel_id: surfaceId,
    author: g.author,
    created_at: g.created_at,
    content: g.content,
    reply_to: g.reply_to || null,
    attachments: [],
    reactions: [],
    pending: true,
  })));
}

function withPinNotices(items, notices) {
  if (!notices.length) return items;
  return [...items, ...notices].sort(
    (a, b) => (a.created_at || 0) - (b.created_at || 0),
  );
}

function rowsFor(list, firstUnread) {
  const rows = [];
  let previous = null;
  let previousMsg = null;
  for (const msg of list) {
    if (!previous || dayOf(msg.created_at) !== dayOf(previous.created_at)) {
      rows.push({ kind: 'day', key: msg.id, label: dayOf(msg.created_at) });
      previous = null;
      previousMsg = null;
    }
    if (msg.kind === 'call' || msg.kind === 'pin') {
      rows.push({ kind: msg.kind, msg, grouped: false });
      previous = null;
      continue;
    }
    if (firstUnread && previousMsg && previousMsg.id <= firstUnread && msg.id > firstUnread) {
      rows.push({ kind: 'new' });
    }
    rows.push({ kind: 'msg', msg, grouped: groupsWith(previous, msg) });
    previous = msg;
    previousMsg = msg;
  }
  return rows;
}

function groupsWith(previous, msg) {
  return Boolean(previous)
    && previous.author === msg.author
    && dayOf(previous.created_at) === dayOf(msg.created_at)
    && msg.created_at - previous.created_at < 7 * 60 * 1000
    && !msg.reply_to;
}

function DayBreak({ label }) {
  return (
    <div className="flex items-center gap-3 pt-6">
      <span className="h-px flex-1 bg-border" />
      <span className="tnum text-2xs font-medium tracking-wider text-muted uppercase">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function NewMarker() {
  const t = useT();
  return (
    <div className="flex items-center gap-3 pt-4 pb-1">
      <span className="h-px flex-1 bg-mention" />
      <span className="rounded-full bg-mention px-1.5 py-px text-[0.59375rem] font-semibold tracking-wider text-white uppercase">
        {t('chat.timeline.unreadMarker')}
      </span>
    </div>
  );
}

function remember(surfaceId, top, atBottom) {
  scrollMemory.delete(surfaceId);
  scrollMemory.set(surfaceId, { top, atBottom });
  if (scrollMemory.size > SCROLL_MEMORY_MAX) {
    scrollMemory.delete(scrollMemory.keys().next().value);
  }
}
