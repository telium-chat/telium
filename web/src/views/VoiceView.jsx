import { useCallback, useEffect, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { useMenus } from './menus.jsx';
import { reportError } from '../hooks/useToast.jsx';
import { roomFace } from '../lib/faces.js';
import { VoiceStatusDialog, VoiceStatusLine, canSetVoiceStatus } from './dialogs/VoiceStatusDialog.jsx';
import { cn } from '../lib/cn.js';
import { CallStage, ChatToggle, DockButton } from './CallStage.jsx';
import { Tooltip } from '../components/Tooltip.jsx';
import {
  Avatar, ChoiceCard, ChoiceList, EmojiText, EmptyState, GlobeIcon, HashIcon, Hint, Loading,
  ModalShell, ServerIcon, VoiceIcon,
} from '../components/index.js';
import { ChatView } from './ChatView.jsx';
import { MobileSheet, MobileTopbar } from './mobile/MobileNavigation.jsx';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';

const SILENT = new Set();
const NO_WATCHERS = [];

export function VoiceView({
  channelId, mobile = false, onOpenNavigation, onOpenMore, onMinimize,
}) {
  useT();
  const store = useStore();
  const voice = useVoice();
  useStoreEvent('voice', 'channels', 'unread', 'prefs', 'watchers', 'route');
  const modal = useModal();
  const menus = useMenus();

  const watchers = store.watchers.get(channelId) || NO_WATCHERS;
  const setWatchers = useCallback((next) => {
    const now = store.watchers.get(channelId) || NO_WATCHERS;
    const rows = typeof next === 'function' ? next(now) : next;
    if (rows === now) return;
    store.watchers.set(channelId, rows);
    store.emit('watchers', channelId);
  }, [store, channelId]);
  const [chatOpen, setChatOpen] = useState(() => store.route.chat === true);
  useEffect(() => {
    if (store.route.chat === true) {
      setChatOpen(true);
      delete store.route.chat;
    }
  }, [store, channelId, store.route.chat]);

  const channel = store.channels.get(channelId);
  const participants = store.voice.get(channelId) || [];
  const me = store.me?.user_id;
  const guildId = channel?.guild_id || null;
  useStoreEventFor((id) => id === guildId, 'members');
  const setScreenSubscription = voice.setScreenSubscription;
  const setWatchQuality = voice.setWatchQuality;

  useEffect(() => {
    let live = true;
    const api = store.voiceApi(channelId);
    if (!api) return undefined;
    api.voiceStates(channelId)
      .then((resp) => {
        if (!live) return;
        store.voice.set(channelId, resp.voice_states || []);
        store.emit('voice', channelId);
        const rows = resp.watchers || [];
        setWatchers(rows);
        for (const row of rows) {
          if (row.viewer === store.me?.user_id) {
            setScreenSubscription?.(row.streamer, true, row.quality || 'auto');
          }
        }
      })
      .catch((e) => reportError(e, t('voice.room.readFailed')));
    return () => { live = false; };
  }, [store, channelId, setWatchers, setScreenSubscription]);

  const toggleWatch = async (streamer, on, quality = 'auto') => {
    try {
      const api = store.voiceApi(channelId);
      if (on) {
        const previous = watchers.filter((w) => (
          w.viewer === me && w.streamer !== streamer
        ));
        for (const row of previous) {
          await api.voiceWatch(channelId, { streamer: row.streamer, watching: false });
          setScreenSubscription?.(row.streamer, false);
        }
      }
      await api.voiceWatch(channelId, { streamer, watching: on, quality });
      setScreenSubscription?.(streamer, on, quality);
      setWatchers((list) => {
        const withoutMine = on
          ? list.filter((w) => w.viewer !== me)
          : list.filter((w) => !(w.viewer === me && w.streamer === streamer));
        return on
          ? [...withoutMine, { viewer: me, streamer, quality }]
          : withoutMine;
      });
    } catch (e) {
      reportError(e, t(on ? 'voice.room.watchFailed' : 'voice.room.unwatchFailed'));
    }
  };

  const changeWatchQuality = async (streamer, quality) => {
    const before = watchers.find((w) => w.viewer === me && w.streamer === streamer)?.quality;
    setWatchers((list) => list.map((w) => (
      w.viewer === me && w.streamer === streamer ? { ...w, quality } : w
    )));
    try {
      const api = store.voiceApi(channelId);
      await api.voiceWatch(channelId, { streamer, watching: true, quality });
      setWatchQuality?.(streamer, quality);
    } catch (e) {
      setWatchers((list) => list.map((w) => (
        w.viewer === me && w.streamer === streamer ? { ...w, quality: before || 'auto' } : w
      )));
      reportError(e, t('voice.room.qualityFailed'));
    }
  };

  const streamingKey = participants
    .map((v) => `${v.user_id}:${v.streaming ? 1 : 0}`)
    .sort()
    .join('|');
  useEffect(() => {
    const live = new Set(participants.filter((v) => v.streaming).map((v) => v.user_id));
    setWatchers((rows) => {
      const next = rows.filter((row) => live.has(row.streamer));
      for (const row of rows) {
        if (!live.has(row.streamer) && row.viewer === me) {
          setScreenSubscription?.(row.streamer, false);
        }
      }
      return next.length === rows.length ? rows : next;
    });
  }, [streamingKey, me, setScreenSubscription, setWatchers]);

  if (!channel) {
    return (
      <EmptyState icon={VoiceIcon} title={t('voice.room.goneTitle')}>
        {t('voice.room.goneBody')}
      </EmptyState>
    );
  }

  const unread = store.unreadFor(channelId);
  const speaking = voice.channelId === channelId ? voice.speaking : SILENT;
  const region = store.prefs.voiceRegion && store.prefs.voiceRegion !== 'auto'
    ? store.prefs.voiceRegion
    : null;
  const openRegions = () => modal.open((close) => (
    <RegionDialog channelId={channelId} close={close} />
  ));

  return (
    <>
      <div className="page-in flex min-w-0 flex-1 flex-col bg-strip">
        {mobile ? (
          <MobileTopbar
            title={channel.name}
            subtitle={participants.length
              ? t('voice.room.inVoice', { count: participants.length })
              : t('voice.room.empty')}
            onMenu={onOpenNavigation}
            onMore={onOpenMore}
            actions={(
              <div className="flex items-center gap-0.5">
                <ChatToggle
                  open={chatOpen}
                  unread={chatOpen ? null : unread}
                  onClick={() => setChatOpen((v) => !v)}
                />
                {onMinimize ? (
                  <button
                    type="button"
                    aria-label={t('voice.room.minimize')}
                    title={t('voice.room.minimize')}
                    onClick={onMinimize}
                    className="mobile-touch-target flex size-11 shrink-0 items-center justify-center rounded-xl text-muted active:bg-surface-tertiary"
                  >
                    <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                ) : null}
              </div>
            )}
          />
        ) : (
        <div className="flex shrink-0 items-center gap-2.5 px-4 py-3">
          <VoiceIcon className="size-[18px] shrink-0 text-muted" />
          <h2 className="min-w-0 shrink truncate text-lg font-semibold tracking-tight">
            <EmojiText>{channel.name}</EmojiText>
          </h2>
          <Faces
            participants={participants}
            speaking={speaking}
            store={store}
            guildId={guildId}
            guildBase={guildId ? store.apiForGuild?.(guildId)?.base || null : null}
            guildDomain={guildId ? store.guilds.get(guildId)?.domain : null}
          />
          <div className="flex-1" />
          <Watchers
            watchers={watchers}
            store={store}
            guildId={guildId}
            guildBase={guildId ? store.apiForGuild?.(guildId)?.base || null : null}
            guildDomain={guildId ? store.guilds.get(guildId)?.domain : null}
          />
          {region ? (
            <button
              type="button"
              title={t('voice.region.title')}
              onClick={openRegions}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-secondary px-2.5 py-1 text-xs font-medium text-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-surface-tertiary hover:text-foreground"
            >
              <GlobeIcon className="size-3.5" />
              {region}
            </button>
          ) : null}
          <ChatToggle
            open={chatOpen}
            unread={chatOpen ? null : unread}
            onClick={() => setChatOpen((v) => !v)}
          />
        </div>
        )}
        {channel.type === 'voice' && (channel.voice_status || canSetVoiceStatus(store, channel)) ? (
          <div className="flex shrink-0 items-center gap-2 px-4 pb-2">
            <VoiceStatusLine channel={channel} className="min-w-0 flex-1 text-sm" />
            {canSetVoiceStatus(store, channel) ? (
              <button
                type="button"
                title={t(channel.voice_status ? 'voice.status.edit' : 'voice.status.set')}
                aria-label={t(channel.voice_status ? 'voice.status.edit' : 'voice.status.set')}
                onClick={() => modal.open((close) => (
                  <VoiceStatusDialog channel={channel} close={close} />
                ))}
                className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium text-muted transition-colors hover:bg-surface-secondary hover:text-foreground"
              >
                {channel.voice_status ? t('voice.status.edit') : t('voice.status.set')}
              </button>
            ) : null}
          </div>
        ) : null}

        <CallStage
          roomId={channelId}
          participants={participants}
          watchers={watchers}
          onWatch={toggleWatch}
          onWatchQuality={changeWatchQuality}
          mobile={mobile}
          menuFor={(v) => menus.voice(v, channel.guild_id, {
            onMention: (id) => store.emit('compose', `<${id}>`),
          })}
          extras={(
            <DockButton title={t('voice.region.title')} onClick={openRegions}>
              <GlobeIcon className="size-5" />
            </DockButton>
          )}
          emptyBody={t('voice.room.emptyBody')}
          joinHint={t('voice.room.joinHint')}
          staleHint={t('voice.room.staleHint')}
        />
      </div>

      {chatOpen ? (
        mobile ? (
          <MobileSheet title={channel.name} subtitle={t('voice.room.chatTitle')} onClose={() => setChatOpen(false)}>
            <ChatView key={channelId} channelId={channelId} mobile />
          </MobileSheet>
        ) : <div className="flex w-[360px] shrink-0 flex-col border-s border-border bg-background">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3">
            <HashIcon className="size-[18px] shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
              <EmojiText>{channel.name}</EmojiText>
            </span>
          </div>
          <ChatView key={channelId} channelId={channelId} />
        </div>
      ) : null}
    </>
  );
}

const FACE_LIMIT = 7;

function Faces({
  participants, speaking, store, guildId, guildBase, guildDomain,
}) {
  useT();
  if (!participants.length) return null;
  const shown = participants.slice(0, FACE_LIMIT);
  const rest = participants.length - shown.length;

  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="group"
      aria-label={t('voice.room.inVoice', { count: participants.length })}
    >
      {shown.map((v) => {
        const face = roomFace(store, v.user_id, {
          guildId, guildBase, guildDomain, state: v,
        });
        return (
          <Avatar
            key={v.user_id}
            id={v.user_id}
            size="sm"
            mediaRef={face.mediaRef}
            base={face.base}
            mediaOrigin={face.mediaOrigin}
            className={cn('voice-face', speaking.has(v.user_id) && 'is-talking')}
          />
        );
      })}
      {rest > 0 ? (
        <span className="tnum ltr-notation flex h-7 shrink-0 items-center rounded-full bg-surface-secondary px-2 text-xs font-medium text-muted">
          {t('voice.room.more', { count: rest })}
        </span>
      ) : null}
    </div>
  );
}

const WATCHER_LIMIT = 3;

function Watchers({ watchers, store, guildId, guildBase, guildDomain }) {
  useT();
  const viewers = [...new Set(watchers.map((w) => w.viewer))];
  if (!viewers.length) return null;
  const shown = viewers.slice(0, WATCHER_LIMIT);
  const rest = viewers.length - shown.length;
  const label = t('voice.room.watching', { count: viewers.length });

  return (
    <Tooltip label={label}>
      <div
        role="img"
        aria-label={label}
        className="flex shrink-0 items-center -space-x-1.5"
      >
        {shown.map((id) => {
          const face = roomFace(store, id, { guildId, guildBase, guildDomain });
          return (
            <Avatar
              key={id}
              id={id}
              size="xs"
              mediaRef={face.mediaRef}
              base={face.base}
              mediaOrigin={face.mediaOrigin}
              className="outline-2 outline-background"
            />
          );
        })}
        {rest > 0 ? (
          <span className="tnum ltr-notation flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-secondary text-[0.5625rem] font-medium text-muted outline-2 outline-background">
            {t('voice.room.more', { count: rest })}
          </span>
        ) : null}
      </div>
    </Tooltip>
  );
}

function RegionDialog({ channelId, close }) {
  useT();
  const store = useStore();
  const [regions, setRegions] = useState(null);

  useEffect(() => {
    let live = true;
    store.apiForChannel(channelId).regions()
      .then((resp) => { if (live) setRegions(resp.regions || []); })
      .catch(() => { if (live) setRegions(false); });
    return () => { live = false; };
  }, [store, channelId]);

  const chosen = store.prefs.voiceRegion || 'auto';
  const pick = (name) => { store.prefs.voiceRegion = name; store.savePrefs(); close(); };

  return (
    <ModalShell title={t('voice.region.title')} subtitle={t('voice.region.subtitle')}>
      {regions === null ? <Loading label={t('voice.region.loading')} /> : null}
      {regions === false ? <Hint>{t('voice.region.none')}</Hint> : null}
      {Array.isArray(regions) ? (
        <ChoiceList value={chosen} onChange={pick} aria-label={t('voice.region.title')}>
          <ChoiceCard
            value="auto"
            icon={GlobeIcon}
            label={t('voice.region.auto')}
            description={t('voice.region.autoHint')}
          />
          {regions.map((r) => (
            <ChoiceCard
              key={r.name}
              value={r.name}
              icon={ServerIcon}
              label={r.name}
              disabled={r.healthy === false}
              description={r.healthy === false ? t('voice.region.unhealthy') : undefined}
            />
          ))}
        </ChoiceList>
      ) : null}
    </ModalShell>
  );
}
