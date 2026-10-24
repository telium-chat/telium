import { useRef } from 'react';
import { reportError } from '../../hooks/useToast.jsx';
import { shortName } from '../../lib/util.js';
import { cn } from '../../lib/cn.js';
import {
  Avatar, Button, ContextMenu, DeafenIcon, FullscreenIcon, MenuButton, MenuItem, MenuSeparator, MicOffIcon,
  MoreIcon, Pill, ScreenIcon, SpinnerIcon, VideoIcon,
} from '../../components/index.js';
import { MobileContextMenu } from '../mobile/MobileNavigation.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { Picture } from './Picture.jsx';
import { PipIcon, openPictureInPicture } from './pictureInPicture.jsx';
import { WatchQualitySelect } from './WatchQualitySelect.jsx';

export function Tile({
  v, me, compact, camera, cameraFacing, speaking, connecting, micDenied, mediaRef, mediaBase,
  mediaOrigin, watchable, watching, onWatch, watchQuality = 'auto', onWatchQuality, menu, mobile,
  staged, onStage, onExpand,
}) {
  const t = useT();
  const videoRef = useRef(null);
  const muted = v.self_mute || v.server_mute;
  const deafened = v.self_deaf || v.server_deaf;
  const mine = v.user_id === me;
  const ContextWrapper = mobile ? MobileContextMenu : ContextMenu;
  const touchControls = watchable && mobile && watching;

  const hasMenu = Boolean(menu) || Boolean(camera);
  const expandable = Boolean(camera) && Boolean(onExpand);
  const expandLabel = staged
    ? t('voice.tile.collapse', { mine: mine ? 'yes' : 'no', who: shortName(v.user_id) })
    : t('voice.tile.expand', { mine: mine ? 'yes' : 'no', who: shortName(v.user_id) });
  const content = () => (
    <>
      {camera ? (
        <MenuItem
          icon={PipIcon}
          onAction={() => openPictureInPicture(videoRef.current)
            .catch((e) => reportError(e, t('voice.error.pip')))}
        >
          {t('voice.tile.pip')}
        </MenuItem>
      ) : null}
      {camera && menu ? <MenuSeparator /> : null}
      {menu ? menu() : null}
    </>
  );

  return (
    <ContextWrapper content={hasMenu ? content : undefined}>
      <div
        data-user={v.user_id}
        className={cn(
          'group relative flex items-center justify-center overflow-hidden rounded-xl bg-surface',
          compact
            ? (mobile ? 'h-[84px] w-[132px] shrink-0' : 'h-[102px] w-[160px] shrink-0')
            : (mobile ? 'aspect-video min-w-0' : 'aspect-video'),
          speaking && 'speaking',
        )}
      >
        {connecting ? (
          <SpinnerIcon className="absolute size-8 animate-spin text-muted/60" />
        ) : null}
        {camera ? (
          <Picture
            stream={camera}
            mirrored={mine && cameraFacing !== 'environment'}
            className="absolute inset-0 size-full object-cover"
            label={t('voice.tile.cameraLabel', {
              mine: mine ? 'yes' : 'no',
              who: shortName(v.user_id),
            })}
            videoRef={videoRef}
          />
        ) : (
          <Avatar
            id={v.user_id}
            size={compact ? 'md' : 'lg'}
            mediaRef={mediaRef}
            base={mediaBase}
            mediaOrigin={mediaOrigin}
            className={cn(connecting && 'opacity-30')}
          />
        )}

        {expandable ? (
          <button
            type="button"
            aria-pressed={Boolean(staged)}
            title={expandLabel}
            aria-label={expandLabel}
            onClick={onExpand}
            className="absolute inset-0 cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
          />
        ) : null}

        <div className="pointer-events-none absolute inset-x-2 bottom-2 flex">
          <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-white backdrop-blur-sm">
            {muted ? (
              <span className="flex shrink-0 items-center text-rose-400" title={t('voice.tile.muted')}>
                <MicOffIcon className="size-3.5" />
                <span className="sr-only">{t('voice.tile.muted')}</span>
              </span>
            ) : null}
            {deafened ? (
              <span className="flex shrink-0 items-center text-rose-400" title={t('voice.tile.deafened')}>
                <DeafenIcon className="size-3.5" />
                <span className="sr-only">{t('voice.tile.deafened')}</span>
              </span>
            ) : null}
            <span className="truncate text-sm font-medium">{shortName(v.user_id)}</span>
            {speaking ? <span className="sr-only">, speaking</span> : null}
          </span>
        </div>

        {!touchControls ? (
          <div className="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap justify-end gap-1">
            {micDenied ? <Pill tone="danger">{t('voice.tile.noMic')}</Pill> : null}
            {staged && !onStage ? (
              <Pill tone="accent">
                <FullscreenIcon className="size-3" />
                {compact ? null : t('voice.tile.yourPick')}
              </Pill>
            ) : null}
            {v.streaming ? (
              <Pill tone="accent">
                <ScreenIcon className="size-3" />
                {compact ? null : t(`voice.preset.${v.stream_preset || 'live'}`)}
              </Pill>
            ) : null}
            {v.self_video && !camera ? (
              <Pill tone="accent">
                <VideoIcon className="size-3" />
                {compact ? null : t('voice.tile.camera')}
              </Pill>
            ) : null}
            {v.region && v.region !== 'auto' && !compact ? <Pill>{v.region}</Pill> : null}
            {hasMenu && !mobile && !compact ? (
              <MenuButton
                label={t('voice.tile.more')}
                placement="bottom end"
                className="stage-chip pointer-events-auto size-7 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100 focus-visible:opacity-100"
                content={content()}
              >
                <MoreIcon className="size-4" />
              </MenuButton>
            ) : null}
          </div>
        ) : null}

        {watchable ? (
          touchControls ? (
            <div className="absolute end-2 top-2 flex items-center gap-2">
              {onWatchQuality ? (
                <WatchQualitySelect
                  value={watchQuality}
                  onChange={onWatchQuality}
                  className="bg-background/85 backdrop-blur-sm"
                />
              ) : null}
              <Button
                variant="secondary"
                className="min-h-10 rounded-xl bg-background/85 px-3 backdrop-blur-sm"
                onClick={onWatch}
              >
                <ScreenIcon className="size-4" />
                {t('voice.tile.watchGate', { state: 'stop' })}
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                'absolute inset-0 flex items-center justify-center gap-2 bg-black/45 pb-9 transition-opacity',
                watching && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
              )}
            >
              <Button variant={watching ? 'secondary' : 'primary'} onClick={onWatch}>
                <ScreenIcon className="size-4" />
                {t('voice.tile.watchGate', {
                  state: watching ? (compact ? 'stop' : 'stopWatching') : 'watch',
                })}
              </Button>
              {watching && onWatchQuality && !compact ? (
                <WatchQualitySelect value={watchQuality} onChange={onWatchQuality} />
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </ContextWrapper>
  );
}
