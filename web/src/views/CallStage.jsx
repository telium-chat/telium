import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { getAndroidAudioRoutes, isAndroid, setAndroidAudioRoute } from '../lib/platform.js';
import { useVoice } from '../hooks/useVoice.jsx';
import { useWatch } from '../hooks/useWatch.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { reportError } from '../hooks/useToast.jsx';
import { faceOf } from '../lib/faces.js';
import { remoteMediaOrigin } from '../lib/media.js';
import { shortName } from '../lib/util.js';
import { cn } from '../lib/cn.js';
import {
  Button, DeafenIcon, EmptyState, HeadphonesIcon, Hint, MenuItem, MenuSlider, MenuSeparator, MessageIcon,
  MicIcon, MicOffIcon, Notice, PhoneOffIcon, ScreenIcon, ScreenOffIcon, SwitchCameraIcon, VideoIcon,
  VideoOffIcon, VoiceIcon, WatchingIcon,
} from '../components/index.js';
import { MobileActionSheet } from './mobile/MobileNavigation.jsx';
import { n } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { WatchTogether } from './call/WatchTogether.jsx';
import { WatchTogetherDialog } from './dialogs/WatchTogetherDialog.jsx';
import { Picture } from './call/Picture.jsx';
import { ScreenTile } from './call/ScreenTile.jsx';
import { Tile } from './call/Tile.jsx';

const SPREAD = ['max-w-md', 'max-w-md', 'max-w-2xl', 'max-w-4xl', 'max-w-4xl', 'max-w-5xl'];

const TILE_SETTLE = { duration: 0.2, ease: [0.16, 1, 0.3, 1] };
const TILE_LEAVE = { duration: 0.09, ease: [0.32, 0.72, 0, 1] };

const TILE_GONE = { opacity: 0, scale: 0.94 };
const TILE_HERE = { opacity: 1, scale: 1 };

export function CallStage({
  roomId,
  participants,
  extras = null,
  watchers = [],
  onWatch = null,
  onWatchQuality = null,
  menuFor = null,
  emptyTitle,
  emptyBody,
  joinLabel,
  joinHint,
  staleHint,
  mobile = false,
}) {
  const t = useT();
  const store = useStore();
  const voice = useVoice();
  const watch = useWatch();
  const modal = useModal();
  const still = useReducedMotion();
  useStoreEvent('prefs');
  const [audioRouteSheet, setAudioRouteSheet] = useState(false);
  const [audioRouteState, setAudioRouteState] = useState({
    loading: false,
    supported: true,
    selected: 'auto',
    automatic_label: t('voice.route.automatic'),
    routes: [],
  });
  const me = store.me?.user_id;
  const guildId = store.channels.get(roomId)?.guild_id || null;
  useStoreEventFor((id) => id === guildId, 'members');
  const guildBase = guildId ? store.apiForGuild(guildId)?.base || null : null;
  const members = guildId ? store.members.get(guildId) : null;
  const mine = participants.find((v) => v.user_id === me);
  const listed = Boolean(mine);
  const here = voice.channelId === roomId;
  const joined = listed && here;
  const stale = listed && !here;
  const server = here ? voice.server : null;
  const p2p = server?.mode === 'mesh';

  const local = voice.local;
  const speaking = voice.speaking;
  const connected = voice.connected;
  const cameras = here ? voice.cameras : new Map();
  const screens = here ? [...voice.screens.entries()] : [];
  const [focusedScreen, setFocusedScreen] = useState(null);
  const [stagePerson, setStagePerson] = useState(null);
  const screenIds = screens.map(([id]) => id).sort().join('|');
  const watchedScreen = watchers.find((w) => w.viewer === me)?.streamer || null;

  const [unseenShares, setUnseenShares] = useState(() => new Set());
  const knownShares = useRef(new Set());
  const focusedRef = useRef(null);
  focusedRef.current = focusedScreen;

  useEffect(() => {
    const available = new Set(screens.map(([id]) => id));
    const preferred = watchedScreen && available.has(watchedScreen) ? watchedScreen : null;
    setFocusedScreen((current) => (
      (current && available.has(current) ? current : null)
      || preferred
      || screens[0]?.[0]
      || null
    ));
    setUnseenShares((seen) => {
      const next = new Set([...seen].filter((id) => available.has(id)));
      for (const id of available) {
        if (!knownShares.current.has(id) && focusedRef.current && focusedRef.current !== id) {
          next.add(id);
        }
      }
      knownShares.current = available;
      return next;
    });
  }, [screenIds, watchedScreen]);

  const roster = participants.map((v) => v.user_id).join('|');
  useEffect(() => {
    const here = new Set(roster ? roster.split('|') : []);
    setStagePerson((current) => (current && here.has(current) ? current : null));
  }, [roster]);

  const join = () => voice.join(roomId);
  const leave = () => voice.leave(roomId);
  const toggleStream = () => voice.toggleStream();

  const inSession = here && watch.session && watch.room === roomId;
  const mayWatch = Boolean(watch.allowed?.length)
    && (guildId ? store.can(roomId, 'STREAM') : true);
  const openWatch = () => {
    modal.open((close) => (
      <WatchTogetherDialog
        close={close}
        allowed={watch.allowed || []}
        sealed={watch.sealed}
        onStart={(source) => watch.start(source)}
      />
    ));
  };

  const openAudioRoutes = async () => {
    setAudioRouteSheet(true);
    setAudioRouteState((state) => ({ ...state, loading: true }));
    try {
      const routes = await getAndroidAudioRoutes();
      setAudioRouteState({ ...routes, loading: false });
    } catch (error) {
      setAudioRouteSheet(false);
      reportError(error, t('voice.error.readRoutes'));
    }
  };

  const chooseAudioRoute = async (routeId) => {
    try {
      const selected = await setAndroidAudioRoute(routeId);
      setAudioRouteState((state) => ({ ...state, selected }));
    } catch (error) {
      reportError(error, t('voice.error.switchOutput'));
    }
  };

  const watching = (streamer) => watchers.some((w) => w.viewer === me && w.streamer === streamer);
  const watchQuality = (streamer) => (
    watchers.find((w) => w.viewer === me && w.streamer === streamer)?.quality || 'auto'
  );
  const focusScreen = (streamer) => {
    setFocusedScreen(streamer);
    setUnseenShares((seen) => {
      if (!seen.has(streamer)) return seen;
      const next = new Set(seen);
      next.delete(streamer);
      return next;
    });
    if (!p2p && streamer !== me && onWatch && !watching(streamer)) onWatch(streamer, true);
  };
  const visibleScreens = screens;
  const sharing = participants.filter((v) => v.streaming);

  const cameraOf = (v) => (v && (v.user_id === me || v.self_video) ? cameras.get(v.user_id) || null : null);
  const staged = stagePerson ? participants.find((v) => v.user_id === stagePerson) : null;
  const stageVideo = screens.length ? null : cameraOf(staged);
  const focusPerson = (id) => setStagePerson((current) => (current === id ? null : id));

  const tileMenu = (v) => {
    const base = menuFor?.(v);
    if (v.user_id === me) return base;
    const level = voice.volumeFor?.(v.user_id) ?? 100;
    const shareLevel = voice.shareVolumeFor?.(v.user_id) ?? 100;
    return (
      <>
        {base}
        {base ? <MenuSeparator /> : null}
        <MenuSlider
          label={t('voice.tile.volume')}
          value={level}
          max={200}
          onChange={(value) => voice.setUserVolume?.(v.user_id, value)}
        />
        {v.streaming ? (
          <MenuSlider
            label={t('voice.tile.screenAudio')}
            value={shareLevel}
            max={200}
            onChange={(value) => voice.setUserShareVolume?.(v.user_id, value)}
          />
        ) : null}
      </>
    );
  };

  // Chromium can keep painting the last frame after replaceTrack(null), with no mute/ended.
  const tile = (v, compact) => {
    const face = faceOf(store, v.user_id, { guildId });
    const stateRef = members?.get(v.user_id)?.avatar_ref || v.avatar_ref;
    return (
      <motion.div
        key={v.user_id}
        className={compact ? 'shrink-0' : 'min-w-0'}
        layout={still ? false : 'position'}
        initial={still ? false : TILE_GONE}
        animate={still ? false : TILE_HERE}
        exit={still ? undefined : { ...TILE_GONE, transition: TILE_LEAVE }}
        transition={TILE_SETTLE}
      >
        <Tile
          v={v}
          me={me}
          compact={compact}
          mobile={mobile}
          camera={cameraOf(v)}
          cameraFacing={v.user_id === me ? voice.cameraFacing : null}
          staged={stagePerson === v.user_id}
          onStage={Boolean(stageVideo) && stagePerson === v.user_id}
          onExpand={() => focusPerson(v.user_id)}
          speaking={speaking.has(v.user_id)}
          connecting={v.user_id !== me && p2p && joined && !connected.has(v.user_id)}
          micDenied={v.user_id === me && voice.micDenied}
          mediaRef={face?.avatarRef || stateRef || null}
          mediaBase={face?.avatarRef ? face.base : (stateRef ? guildBase : null)}
          mediaOrigin={face?.avatarRef
            ? face.mediaOrigin
            : (stateRef ? remoteMediaOrigin(v.user_id, store.guilds.get(guildId)?.domain) : null)}
          watchable={Boolean(v.streaming) && v.user_id !== me && !p2p && Boolean(onWatch)}
          watching={watching(v.user_id)}
          onWatch={onWatch ? () => onWatch(v.user_id, !watching(v.user_id)) : undefined}
          watchQuality={watchQuality(v.user_id)}
          onWatchQuality={onWatchQuality ? (quality) => onWatchQuality(v.user_id, quality) : undefined}
          menu={(menuFor || v.user_id !== me) ? () => tileMenu(v) : undefined}
        />
      </motion.div>
    );
  };

  const filmstrip = participants.length ? (
    <div className="flex shrink-0 gap-2 overflow-x-auto p-1">
      <AnimatePresence initial={false}>
        {participants.map((v) => tile(v, true))}
      </AnimatePresence>
    </div>
  ) : null;

  return (
    <div className={cn('mobile-call-stage relative flex min-h-0 flex-1 flex-col', mobile && 'is-mobile')}>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto pt-1',
          mobile ? 'gap-2 px-2' : 'gap-3 px-4',
          joined ? 'pb-[92px]' : 'pb-[84px]',
        )}
      >
        {server ? <ServerNotice server={server} joined={joined} /> : null}

        {joined && voice.audioBlocked ? (
          <div
            role="status"
            className="mx-auto flex w-full max-w-[560px] items-center gap-3 rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm"
          >
            <span className="min-w-0 flex-1 text-foreground">
              {t('voice.stage.audioBlocked')}
            </span>
            <Button variant="secondary" className="min-h-10 shrink-0 rounded-xl" onClick={voice.resumeAudio}>
              {t('voice.stage.resumeAudio')}
            </Button>
          </div>
        ) : null}

        {inSession ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
              <WatchTogether mobile={mobile} />
            </div>
            {filmstrip}
          </>
        ) : screens.length ? (
          <>
            <div className={cn(
              'grid min-h-0 flex-1 gap-2',
              visibleScreens.length === 1 ? 'grid-cols-1'
                : visibleScreens.length === 2 ? 'grid-cols-2'
                  : 'grid-cols-[repeat(auto-fit,minmax(min(100%,360px),1fr))]',
            )}>
              {visibleScreens.map(([id, stream]) => (
                <ScreenTile
                  key={id}
                  id={id}
                  stream={stream}
                  mine={id === me}
                  shareVolume={voice.shareVolumeFor?.(id) ?? 100}
                  onShareVolume={(value) => voice.setUserShareVolume?.(id, value)}
                  onStop={toggleStream}
                  mobile={mobile}
                />
              ))}
            </div>
            {filmstrip}
          </>
        ) : stageVideo ? (
          <>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
              <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black">
                <Picture
                  stream={stageVideo}
                  mirrored={stagePerson === me && voice.cameraFacing !== 'environment'}
                  label={t('voice.tile.cameraLabel', {
                    mine: stagePerson === me ? 'yes' : 'no',
                    who: shortName(stagePerson),
                  })}
                  className="max-h-full w-full object-contain"
                />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
                  <span className="truncate text-sm font-medium text-white">
                    {t('voice.stage.cameraName', {
                      mine: stagePerson === me ? 'yes' : 'no',
                      who: shortName(stagePerson),
                    })}
                  </span>
                </div>
              </div>
            </div>
            {filmstrip}
          </>
        ) : participants.length ? (
          <div className="flex min-h-0 flex-1 items-center justify-center py-2">
            <div
              className={cn(
                mobile ? 'grid w-full min-w-0 gap-2' : 'grid w-full gap-3',
                mobile
                  ? 'grid-cols-2'
                  : cn('grid-cols-[repeat(auto-fit,minmax(200px,1fr))]', SPREAD[Math.min(participants.length, SPREAD.length - 1)]),
              )}
            >
              <AnimatePresence initial={false}>
                {participants.map((v) => tile(v, false))}
              </AnimatePresence>
            </div>
          </div>
        ) : (
          <EmptyState icon={VoiceIcon} title={emptyTitle || t('voice.stage.emptyTitle')}>{emptyBody}</EmptyState>
        )}
      </div>

      <div className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4',
        mobile ? 'pb-[calc(1.25rem+var(--safe-area-bottom))]' : 'pb-5',
      )}>
        {joined ? (
          <div
            role="toolbar"
            aria-label={t('voice.stage.controls')}
            data-mobile-scroll={mobile ? '' : undefined}
            className={cn(
              'pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-surface/95 p-1.5 shadow-xl backdrop-blur-md',
              mobile && 'max-w-full flex-nowrap justify-start overflow-x-auto overscroll-x-contain rounded-3xl',
            )}
          >
            <DockButton
              title={t('voice.dock.camera', { on: local.self_video ? 'yes' : 'no' })}
              on={local.self_video}
              onClick={() => voice.toggle('self_video')}
            >
              {local.self_video ? <VideoIcon className="size-5" /> : <VideoOffIcon className="size-5" />}
            </DockButton>
            {mobile && local.self_video ? (
              <DockButton
                title={t('voice.dock.flip', { facing: voice.cameraFacing === 'environment' ? 'environment' : 'user' })}
                onClick={voice.flipCamera}
              >
                <SwitchCameraIcon className="size-5" />
              </DockButton>
            ) : null}
            {!isAndroid ? (
              <DockButton
                title={t('voice.dock.share', { on: local.streaming ? 'yes' : 'no' })}
                on={local.streaming}
                onClick={toggleStream}
              >
                {local.streaming ? <ScreenIcon className="size-5" /> : <ScreenOffIcon className="size-5" />}
              </DockButton>
            ) : null}
            <DockButton
              title={t('voice.dock.mic', { muted: local.self_mute ? 'yes' : 'no' })}
              off={local.self_mute}
              onClick={() => voice.toggle('self_mute')}
            >
              {local.self_mute ? <MicOffIcon className="size-5" /> : <MicIcon className="size-5" />}
            </DockButton>
            <DockButton
              title={t('voice.dock.deafen', { deafened: local.self_deaf ? 'yes' : 'no' })}
              off={local.self_deaf}
              onClick={() => voice.toggle('self_deaf')}
            >
              {local.self_deaf ? <DeafenIcon className="size-5" /> : <HeadphonesIcon className="size-5" />}
            </DockButton>
            {mobile && isAndroid ? (
              <DockButton title={t('voice.route.title')} onClick={openAudioRoutes}>
                <HeadphonesIcon className="size-5" />
              </DockButton>
            ) : null}
            {mayWatch ? (
              <DockButton
                title={t('voice.dock.watch', { on: inSession ? 'yes' : 'no' })}
                on={Boolean(inSession)}
                onClick={inSession ? watch.end : openWatch}
              >
                <WatchingIcon className="size-5" />
              </DockButton>
            ) : null}
            {extras}
            <span className="mx-0.5 h-6 w-px bg-border" aria-hidden />
            <DockButton title={t('voice.dock.disconnect')} danger onClick={leave}>
              <PhoneOffIcon className="size-5" />
            </DockButton>
          </div>
        ) : stale ? (
          <div className="pointer-events-auto flex flex-col items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-full border border-border bg-surface/95 p-1.5 shadow-xl backdrop-blur-md">
              <button
                type="button"
                onClick={join}
                className="flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-base font-semibold text-accent-foreground transition-colors hover:bg-accent-hover"
              >
                <VoiceIcon className="size-[17px]" />
                {t('voice.stage.rejoin')}
              </button>
              <button
                type="button"
                onClick={leave}
                className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-base font-semibold text-danger-foreground transition-opacity hover:opacity-90"
              >
                <PhoneOffIcon className="size-[17px]" />
                {t('voice.dock.disconnect')}
              </button>
            </div>
            <Hint>{staleHint}</Hint>
          </div>
        ) : (
          <div className="pointer-events-auto flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={join}
              className="flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-base font-semibold text-accent-foreground shadow-xl transition-colors hover:bg-accent-hover"
            >
              <VoiceIcon className="size-[18px]" />
              {joinLabel || t('voice.stage.join')}
            </button>
            <Hint>{joinHint}</Hint>
          </div>
        )}
      </div>

      {audioRouteSheet ? (
        <MobileActionSheet title={t('voice.route.title')} onClose={() => setAudioRouteSheet(false)}>
          {audioRouteState.loading ? (
            <MenuItem icon={HeadphonesIcon} isDisabled onAction={() => {}}>
              {t('voice.route.finding')}
            </MenuItem>
          ) : audioRouteState.supported ? (
            <>
              <MenuItem icon={HeadphonesIcon} onAction={() => chooseAudioRoute('auto')}>
                {t('voice.route.option', {
                  state: audioRouteState.selected === 'auto' ? 'selected' : 'other',
                  label: audioRouteState.automatic_label,
                })}
              </MenuItem>
              {audioRouteState.routes.map((route) => (
                <MenuItem
                  key={route.id}
                  icon={HeadphonesIcon}
                  onAction={() => chooseAudioRoute(route.id)}
                >
                  {t('voice.route.option', {
                    state: audioRouteState.selected === String(route.id) ? 'selected' : 'other',
                    label: route.label,
                  })}
                </MenuItem>
              ))}
            </>
          ) : (
            <MenuItem icon={HeadphonesIcon} isDisabled onAction={() => {}}>
              {t('voice.route.unsupported')}
            </MenuItem>
          )}
        </MobileActionSheet>
      ) : null}
    </div>
  );
}

export function ChatToggle({ open, unread, onClick }) {
  const t = useT();
  const mentions = unread?.mentions || 0;
  const some = Boolean(unread?.unread);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={open}
      title={t('voice.chat.toggle', { open: open ? 'yes' : 'no' })}
      aria-label={
        mentions
          ? t('voice.chat.toggleMentions', { open: open ? 'yes' : 'no', count: mentions })
          : some
            ? t('voice.chat.toggleUnread', { open: open ? 'yes' : 'no' })
            : t('voice.chat.toggle', { open: open ? 'yes' : 'no' })
      }
      className={cn(
        'relative flex h-7 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition-colors',
        open
          ? 'bg-surface-tertiary text-foreground'
          : 'text-muted hover:bg-surface-secondary hover:text-foreground',
      )}
    >
      <MessageIcon className="size-4" />
      {t('voice.chat.label')}
      {mentions ? (
        <span className="tnum flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-mention px-1 text-2xs font-semibold text-white">
          {n(mentions)}
        </span>
      ) : some ? (
        <span aria-hidden className="size-[7px] rounded-full bg-foreground" />
      ) : null}
    </button>
  );
}

export function DockButton({ title, on, off, danger, onClick, children }) {
  const toggles = on !== undefined || off !== undefined;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={toggles ? Boolean(on || off) : undefined}
      onClick={onClick}
      className={cn(
        'flex size-11 items-center justify-center rounded-full transition-colors',
        danger || off
          ? 'bg-danger text-danger-foreground hover:opacity-90'
          : on
            ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
            : 'bg-surface-secondary text-foreground hover:bg-surface-tertiary',
      )}
    >
      {children}
    </button>
  );
}

function ServerNotice({ server, joined }) {
  const t = useT();
  const sealed = server.mode !== 'mesh' && server.e2ee === 'required';
  if (joined || !sealed) return null;
  return <Notice>{t('voice.stage.sealedNotice')}</Notice>;
}
