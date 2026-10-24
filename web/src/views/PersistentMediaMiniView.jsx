import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { useWatch } from '../hooks/useWatch.jsx';
import { WatchTogether } from './call/WatchTogether.jsx';
import {
  ChevronRightIcon, CloseIcon, EmojiText, FullscreenIcon, IconButton, ScreenIcon,
  VideoIcon,
} from '../components/index.js';
import { conversationName, shortName } from '../lib/util.js';
import { t } from '../lib/i18n/index.js';
import { useLocale, useT } from '../lib/i18n/react.jsx';

export function PersistentMediaMiniView({ hidden = false, onExpand }) {
  useT();
  const { dir, locale } = useLocale();
  const store = useStore();
  const voice = useVoice();
  const watch = useWatch();
  useStoreEvent('route', 'channels', 'conversations', 'voice');
  const frameRef = useRef(null);
  const videoRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [width, setWidth] = useState(null);
  const [selected, setSelected] = useState(null);
  const [dismissedRoute, setDismissedRoute] = useState(null);

  const me = store.me?.user_id;
  const voiceStates = voice.channelId ? (store.voice.get(voice.channelId) || []) : [];
  const voiceStateKey = voiceStates
    .map((state) => `${state.user_id}:${state.streaming ? 1 : 0}:${state.self_video ? 1 : 0}`)
    .sort()
    .join('|');
  const candidates = useMemo(() => {
    const rows = [];
    const stateOf = new Map(voiceStates.map((state) => [state.user_id, state]));
    for (const [userId, stream] of voice.screens) {
      const live = userId === me ? voice.local.streaming : stateOf.get(userId)?.streaming;
      if (!stream || !live) continue;
      rows.push({
        key: `screen:${userId}`,
        kind: 'screen',
        userId,
        stream,
        label: userId === me
          ? t('voice.media.screenMine')
          : t('voice.media.screenOther', { who: shortName(userId) }),
      });
    }
    for (const [userId, stream] of voice.cameras) {
      const live = userId === me ? voice.local.self_video : stateOf.get(userId)?.self_video;
      if (!stream || !live) continue;
      rows.push({
        key: `camera:${userId}`,
        kind: 'camera',
        userId,
        stream,
        label: userId === me
          ? t('voice.media.cameraMine')
          : t('voice.media.cameraOther', { who: shortName(userId) }),
      });
    }
    return rows;
  }, [
    voice.screens, voice.cameras, voice.local.streaming, voice.local.self_video,
    voiceStateKey, me,
    locale,
  ]);

  const candidateKey = candidates.map((item) => item.key).join('|');
  useEffect(() => {
    setSelected((current) => (
      candidates.some((item) => item.key === current) ? current : candidates[0]?.key || null
    ));
    setDismissedRoute(null);
  }, [candidateKey]);

  const active = candidates.find((item) => item.key === selected) || candidates[0] || null;
  const route = store.route;
  const routeKey = [
    route.view || '', route.guildId || '', route.channelId || '', route.conversationId || '',
  ].join(':');
  const visible = voice.active && !hidden && Boolean(active) && dismissedRoute !== routeKey;
  const watchVisible = !hidden && Boolean(watch.session && watch.consented);

  useEffect(() => {
    const element = videoRef.current;
    if (!visible || !element || !active?.stream) return undefined;
    element.srcObject = active.stream;
    Promise.resolve(element.play?.()).catch(() => {});
    return () => {
      if (element.srcObject === active.stream) element.srcObject = null;
    };
  }, [active?.stream, visible, routeKey]);

  if (!visible && !watchVisible) return null;

  const room = voice.channelId ? store.channels.get(voice.channelId) : null;
  const convo = !room && voice.channelId
    ? store.conversations.find((item) => item.id === voice.channelId)
    : null;
  const roomName = room?.name || conversationName(convo, me) || t('voice.mini.call');

  const expand = () => {
    if (onExpand) {
      onExpand();
      return;
    }
    if (room) {
      store.navigate({
        view: 'voice',
        guildId: room.guild_id,
        channelId: room.id,
        conversationId: null,
      });
    } else if (convo) {
      store.navigate({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId: convo.id,
      });
    }
  };

  const openInChat = (event) => {
    if (event.target.closest?.('button, [data-mini-resize-handle]')) return;
    expand();
  };

  const cycle = () => {
    if (candidates.length < 2) return;
    const at = Math.max(0, candidates.findIndex((item) => item.key === active.key));
    setSelected(candidates[(at + 1) % candidates.length].key);
  };

  const beginDrag = (event) => {
    if (event.button !== 0 || event.target.closest?.('button, [data-mini-resize-handle]')) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    frame.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset,
    };
  };

  const moveDrag = (event) => {
    const drag = dragRef.current;
    const frame = frameRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !frame) return;
    const rect = frame.getBoundingClientRect();
    const home = dir === 'rtl' ? 1 : -1;
    const travelX = Math.max(0, window.innerWidth - rect.width - 12);
    const nextX = drag.offset.x + event.clientX - drag.x;
    const minY = Math.min(0, -(window.innerHeight - rect.height - 12));
    setOffset({
      x: home < 0
        ? Math.max(-travelX, Math.min(0, nextX))
        : Math.min(travelX, Math.max(0, nextX)),
      y: Math.max(minY, Math.min(0, drag.offset.y + event.clientY - drag.y)),
    });
  };

  const endDrag = (event) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    frameRef.current?.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  const beginResize = (event) => {
    if (event.button !== 0) return;
    const frame = frameRef.current;
    if (!frame) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = frame.getBoundingClientRect();
    const inlineRoom = dir === 'rtl'
      ? window.innerWidth - rect.left - 12
      : rect.right - 12;
    const blockRoom = Math.max(0, rect.bottom - 12);
    const maxWidth = Math.max(120, Math.min(720, inlineRoom, blockRoom * (16 / 9)));
    const minWidth = Math.min(140, maxWidth);

    event.currentTarget.setPointerCapture?.(event.pointerId);
    resizeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: rect.width,
      minWidth,
      maxWidth,
      handle: event.currentTarget,
    };
  };

  const moveResize = (event) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const direction = dir === 'rtl' ? 1 : -1;
    const delta = (event.clientX - resize.x) * direction;
    setWidth(Math.max(
      resize.minWidth,
      Math.min(resize.maxWidth, resize.width + delta),
    ));
  };

  const endResize = (event) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resize.handle?.releasePointerCapture?.(event.pointerId);
    resizeRef.current = null;
  };

  return (
    <>
      {watchVisible ? (
        <aside
          aria-label={t('voice.mini.region')}
          className="fixed end-3 bottom-3 z-[45] w-[min(46vw,320px)] overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl sm:end-4 sm:bottom-4 sm:w-[360px]"
          style={{ marginInlineEnd: 'var(--safe-area-end)', marginBlockEnd: 'var(--safe-area-bottom)' }}
        >
          <WatchTogether mobile mini />
        </aside>
      ) : null}
      {visible ? <aside
      ref={frameRef}
      aria-label={t('voice.mini.region')}
      data-mobile-gesture-lock
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={openInChat}
      className={cn(
        'fixed z-[45] touch-none overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl',
        'end-3 bottom-3 w-[min(46vw,220px)] cursor-move sm:end-4 sm:bottom-4 sm:w-[280px]',
      )}
      style={{
        marginInlineEnd: 'var(--safe-area-end)',
        marginBlockEnd: 'var(--safe-area-bottom)',
        transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
        width: width == null ? undefined : `${width}px`,
      }}
    >
      <div
        aria-hidden="true"
        data-mini-resize-handle
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        className="absolute start-0 top-0 z-20 size-6 touch-none"
        style={{ cursor: dir === 'rtl' ? 'nesw-resize' : 'nwse-resize' }}
      >
        <span className="absolute start-1 top-1 size-2.5 border-s-2 border-t-2 border-white/70 drop-shadow" />
      </div>
      <div className="group relative aspect-video w-full bg-black">
        <video
          ref={videoRef}
          muted
          autoPlay
          playsInline
          aria-label={active.label}
          className={cn(
            'size-full bg-black',
            active.kind === 'screen' ? 'object-contain' : 'object-cover',
            active.kind === 'camera' && active.userId === me && '-scale-x-100',
          )}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/80 to-transparent" />

        <div className="absolute end-1.5 top-1.5 flex items-center gap-0.5 rounded-lg bg-black/55 p-0.5 backdrop-blur-sm">
          {candidates.length > 1 ? (
            <IconButton
              title={t('voice.mini.next')}
              className="size-7 min-w-7 text-white/80 hover:bg-white/15 hover:text-white"
              onClick={cycle}
            >
              <ChevronRightIcon className="size-4" />
            </IconButton>
          ) : null}
          <IconButton
            title={t('voice.mini.expand')}
            className="size-7 min-w-7 text-white/80 hover:bg-white/15 hover:text-white"
            onClick={expand}
          >
            <FullscreenIcon className="size-4" />
          </IconButton>
          <IconButton
            title={t('voice.mini.hide')}
            className="size-7 min-w-7 text-white/80 hover:bg-white/15 hover:text-white"
            onClick={() => setDismissedRoute(routeKey)}
          >
            <CloseIcon className="size-4" />
          </IconButton>
        </div>

        <button
          type="button"
          onClick={expand}
          className="absolute inset-x-0 bottom-0 flex min-w-0 items-center gap-2 px-2.5 py-2 text-start text-white"
          title={t('voice.mini.expand')}
        >
          {active.kind === 'screen'
            ? <ScreenIcon className="size-3.5 shrink-0 text-white/80" />
            : <VideoIcon className="size-3.5 shrink-0 text-white/80" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold">{active.label}</span>
            <span className="block truncate text-2xs text-white/65"><EmojiText>{roomName}</EmojiText></span>
          </span>
        </button>
      </div>
      </aside> : null}
    </>
  );
}
