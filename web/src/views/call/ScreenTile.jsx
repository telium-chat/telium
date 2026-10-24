import { useEffect, useRef } from 'react';
import { reportError } from '../../hooks/useToast.jsx';
import { shortName } from '../../lib/util.js';
import { cn } from '../../lib/cn.js';
import {
  FullscreenIcon, MenuButton, MenuItem, MenuSeparator, MoreIcon, ScreenIcon, ScreenOffIcon,
} from '../../components/index.js';
import { n } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { Picture } from './Picture.jsx';
import { PipIcon, openFullscreen, openPictureInPicture } from './pictureInPicture.jsx';

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 2;

function useScreenZoom(containerRef, videoRef, stream) {
  const chipRef = useRef(null);
  const api = useRef(null);

  useEffect(() => {
    const box = containerRef.current;
    const video = videoRef.current;
    if (!box || !video) return undefined;

    const z = { scale: 1, x: 0, y: 0, dragging: false, px: 0, py: 0 };

    const picture = () => {
      const w = video.clientWidth;
      const h = video.clientHeight;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!w || !h || !vw || !vh) return { w, h, pw: w, ph: h };
      const fit = Math.min(w / vw, h / vh);
      return { w, h, pw: vw * fit, ph: vh * fit };
    };

    const clamp = () => {
      const { w, h, pw, ph } = picture();
      const maxX = Math.max(0, (pw * z.scale - w) / 2);
      const maxY = Math.max(0, (ph * z.scale - h) / 2);
      z.x = Math.min(maxX, Math.max(-maxX, z.x));
      z.y = Math.min(maxY, Math.max(-maxY, z.y));
    };

    const paint = () => {
      clamp();
      video.style.transform = z.scale === 1
        ? ''
        : `translate3d(${z.x}px, ${z.y}px, 0) scale(${z.scale})`;
      box.style.cursor = z.scale > 1 ? (z.dragging ? 'grabbing' : 'grab') : '';
      const chip = chipRef.current;
      if (chip) {
        chip.hidden = z.scale === 1;
        chip.textContent = n(z.scale, 'percent');
      }
    };

    const stepped = (fn) => {
      video.classList.add('screen-zoom--step');
      fn();
    };
    const settle = () => video.classList.remove('screen-zoom--step');

    const from = (e) => {
      const r = video.getBoundingClientRect();
      return {
        cx: e.clientX - (r.left + r.width / 2 - z.x),
        cy: e.clientY - (r.top + r.height / 2 - z.y),
      };
    };

    const zoomTo = (next, cx, cy) => {
      const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
      const k = scale / z.scale;
      z.x = cx - k * (cx - z.x);
      z.y = cy - k * (cy - z.y);
      z.scale = scale;
      paint();
    };

    const chrome = (e) => e.target.closest('button, select, a, input, [role="menu"]');

    const onWheel = (e) => {
      if (chrome(e)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? box.clientHeight : 1);
      const rate = e.ctrlKey ? 0.01 : 0.0022;
      const at = from(e);
      settle();
      zoomTo(z.scale * Math.exp(-e.deltaY * unit * rate), at.cx, at.cy);
    };

    const onPointerDown = (e) => {
      if (z.scale === 1 || e.button !== 0 || chrome(e)) return;
      z.dragging = true;
      z.px = e.clientX;
      z.py = e.clientY;
      box.setPointerCapture?.(e.pointerId);
      settle();
      paint();
    };

    const onPointerMove = (e) => {
      if (!z.dragging) return;
      z.x += e.clientX - z.px;
      z.y += e.clientY - z.py;
      z.px = e.clientX;
      z.py = e.clientY;
      paint();
    };

    const onPointerUp = (e) => {
      if (!z.dragging) return;
      z.dragging = false;
      box.releasePointerCapture?.(e.pointerId);
      paint();
    };

    const onDoubleClick = (e) => {
      if (chrome(e)) return;
      const at = from(e);
      stepped(() => zoomTo(z.scale > 1 ? ZOOM_MIN : ZOOM_STEP, at.cx, at.cy));
    };

    const onKeyDown = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') stepped(() => zoomTo(z.scale * 1.5, 0, 0));
      else if (e.key === '-' || e.key === '_') stepped(() => zoomTo(z.scale / 1.5, 0, 0));
      else if (e.key === '0') stepped(() => zoomTo(ZOOM_MIN, 0, 0));
      else return;
      e.preventDefault();
    };

    const observer = new ResizeObserver(() => paint());
    observer.observe(box);

    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('pointerdown', onPointerDown);
    box.addEventListener('pointermove', onPointerMove);
    box.addEventListener('pointerup', onPointerUp);
    box.addEventListener('pointercancel', onPointerUp);
    box.addEventListener('dblclick', onDoubleClick);
    box.addEventListener('keydown', onKeyDown);
    video.addEventListener('transitionend', settle);

    api.current = { reset: () => stepped(() => zoomTo(ZOOM_MIN, 0, 0)) };
    paint();

    return () => {
      observer.disconnect();
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('pointerdown', onPointerDown);
      box.removeEventListener('pointermove', onPointerMove);
      box.removeEventListener('pointerup', onPointerUp);
      box.removeEventListener('pointercancel', onPointerUp);
      box.removeEventListener('dblclick', onDoubleClick);
      box.removeEventListener('keydown', onKeyDown);
      video.removeEventListener('transitionend', settle);
      video.style.transform = '';
      video.classList.remove('screen-zoom--step');
      box.style.cursor = '';
      api.current = null;
    };
  }, [stream, containerRef, videoRef]);

  return { chipRef, reset: () => api.current?.reset() };
}

export function ScreenTile({ id, stream, mine, shareVolume = 100, onShareVolume, onStop, mobile = false }) {
  const t = useT();
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const zoom = useScreenZoom(containerRef, videoRef, stream);
  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={mine ? 'Your screen share' : `${shortName(id)}'s screen share`}
      tabIndex={0}
      aria-keyshortcuts="+ - 0"
      className={cn(
        'group relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
        mobile && 'min-h-[min(52dvh,420px)]',
      )}
    >
      <Picture
        stream={stream}
        label={t('voice.screen.label', { mine: mine ? 'yes' : 'no', who: shortName(id) })}
        videoRef={videoRef}
        className="screen-zoom max-h-full w-full bg-black object-contain"
      />
      <button
        ref={zoom.chipRef}
        type="button"
        hidden
        title={t('voice.screen.resetZoom')}
        aria-label={t('voice.screen.resetZoom')}
        className="stage-chip tnum absolute start-2 top-2 h-7 px-2 text-xs font-medium"
        onClick={zoom.reset}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <ScreenIcon className="size-3.5 shrink-0 text-white/80" />
        <span className="truncate text-sm font-medium text-white">
          {t('voice.stage.shareName', { mine: mine ? 'yes' : 'no', who: shortName(id) })}
        </span>
      </div>
      {!mine ? (
        <label
          className={cn(
            'absolute bottom-10 end-2 flex items-center gap-2 rounded-lg bg-black/70 px-2 py-1.5 text-xs text-white backdrop-blur-sm transition-opacity',
            mobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
          title={t('voice.tile.screenAudioVolume')}
        >
          <span className="sr-only">{t('voice.tile.screenAudioVolume')}</span>
          <input
            type="range"
            min="0"
            max="200"
            value={shareVolume}
            aria-label={t('voice.tile.screenAudioVolumeFor', { name: shortName(id) })}
            onChange={(event) => onShareVolume?.(Number(event.target.value))}
            className="h-4 w-24 cursor-pointer accent-[var(--accent)]"
          />
          <span className="tnum w-8 text-end">{shareVolume}%</span>
        </label>
      ) : null}
      <div className={cn(
        'absolute end-2 top-2 flex items-center gap-1.5 transition-opacity',
        mobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
      )}>
        <button
          type="button"
          title={t('voice.screen.fullscreen')}
          aria-label={t('voice.screen.fullscreen')}
          className={cn('stage-chip', mobile ? 'size-10' : 'size-8')}
          onClick={() => openFullscreen(containerRef.current)
            .catch((e) => reportError(e, t('voice.error.fullscreen')))}
        >
          <FullscreenIcon className="size-4" />
        </button>
        <MenuButton
          label={t('voice.tile.more')}
          placement="bottom end"
          className={cn('stage-chip', mobile ? 'size-10' : 'size-8')}
          content={(
            <>
              <MenuItem
                icon={PipIcon}
                onAction={() => openPictureInPicture(videoRef.current)
                  .catch((e) => reportError(e, t('voice.error.pip')))}
              >
                {t('voice.tile.pip')}
              </MenuItem>
              {mine ? <MenuSeparator /> : null}
              {mine ? (
                <MenuItem icon={ScreenOffIcon} tone="danger" onAction={onStop}>
                  {t('voice.screen.stopSharing')}
                </MenuItem>
              ) : null}
            </>
          )}
        >
          <MoreIcon className="size-4" />
        </MenuButton>
      </div>
    </div>
  );
}
