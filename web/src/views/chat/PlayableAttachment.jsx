import { useEffect, useRef, useState } from 'react';
import { bytes } from '../../lib/util.js';
import { hostingNote } from '../../lib/attachment-note.js';
import { duration as mediaTime } from '../../lib/i18n/index.js';
import { t as translate } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { usePersistentAudio } from '../../hooks/usePersistentAudio.jsx';
import {
  AttachIcon, EmojiText, FullscreenIcon, PauseIcon, PlayIcon, VolumeMuteIcon,
  VoiceIcon,
} from '../../components/index.js';

const AUDIO_EXTENSIONS = new Set([
  'aac', 'aif', 'aiff', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'wave',
]);

const VIDEO_EXTENSIONS = new Set([
  'avi', 'm4v', 'mkv', 'mov', 'mp4', 'ogv', 'webm',
]);

const EXTENSION_MIME = {
  aac: 'audio/aac', aif: 'audio/aiff', aiff: 'audio/aiff', flac: 'audio/flac',
  m4a: 'audio/mp4', mp3: 'audio/mpeg', oga: 'audio/ogg', ogg: 'audio/ogg',
  opus: 'audio/ogg', wav: 'audio/wav', wave: 'audio/wav',
  avi: 'video/x-msvideo', m4v: 'video/mp4', mkv: 'video/x-matroska',
  mov: 'video/quicktime', mp4: 'video/mp4', ogv: 'video/ogg', webm: 'video/webm',
};

export function playableKind(att) {
  const mime = String(att?.mime || '').toLowerCase().split(';', 1)[0].trim();
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';

  const name = String(att?.name || att?.filename || '').toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return null;
}

function playableMime(att, kind) {
  const mime = String(att?.mime || '').toLowerCase().split(';', 1)[0].trim();
  if (mime.startsWith(`${kind}/`)) return mime;
  const name = String(att?.name || att?.filename || '').toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXTENSION_MIME[extension];
}

export function isGofileUrl(url) {
  try { return /(^|\.)gofile\.io$/i.test(new URL(url).hostname); } catch { return false; }
}

export function isGofileAttachment(att, url) {
  if (isGofileUrl(url)) return true;
  return /(^|\.)gofile\.io$/i.test(String(att?.origin || ''));
}

export function playableKindForUrl(url) {
  try {
    const parsed = new URL(url);
    return playableKind({ name: parsed.pathname });
  } catch {
    return null;
  }
}

export function isPlayableLink(url) {
  return !isGofileUrl(url) && Boolean(playableKindForUrl(url));
}

function PersistentAudioControls({
  player, url, name, kind, onSave = null, fallbackUrl = null, onOpenOriginal = null, probeUnavailable = null, note = null,
}) {
  const t = useT();
  const label = kind === 'video'
    ? t('chat.player.videoOf', { name })
    : t('chat.player.audioOf', { name });
  const active = player.track?.url === url;
  const playing = active && player.playing;
  const currentTime = active ? player.currentTime : 0;
  const duration = active ? player.duration : 0;
  const mediaError = active && player.error;
  const seekProgress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volumeProgress = (player.muted ? 0 : player.volume) * 100;
  const togglePlay = () => player.toggleTrack({ url, label: name });
  const seek = (event) => {
    if (!active || duration <= 0) return;
    const fraction = Number(event.currentTarget.value) / 100;
    if (!Number.isFinite(fraction)) return;
    event.currentTarget.style.setProperty(
      '--media-range-progress',
      Math.max(0, Math.min(100, fraction * 100)) + '%',
    );
    player.seek(fraction);
  };
  const changeVolume = (event) => {
    const next = Number(event.currentTarget.value);
    if (!Number.isFinite(next)) return;
    event.currentTarget.style.setProperty(
      '--media-range-progress',
      Math.max(0, Math.min(100, next * 100)) + '%',
    );
    player.setVolume(next);
  };

  return (
    <div className="media-player-frame max-w-[360px] overflow-hidden rounded-[var(--radius-row)] bg-surface">
      <div className="media-player-controls flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-muted">
        <button
          type="button"
          aria-label={playing ? t('chat.player.pause', { label }) : t('chat.player.play', { label })}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={togglePlay}
        >
          {playing
            ? <PauseIcon className="size-3.5" strokeWidth={2} />
            : <PlayIcon className="size-3.5" strokeWidth={2} />}
        </button>
        <span className="tnum shrink-0 font-mono text-2xs text-foreground" aria-live="off">
          {mediaTime(currentTime)}
        </span>
        <input
          type="range"
          aria-label={t('chat.player.seek', { label })}
          min="0"
          max="100"
          step="any"
          value={seekProgress}
          style={{ '--media-range-progress': seekProgress + '%' }}
          className="media-player-range h-1 min-w-0 flex-1 cursor-pointer"
          disabled={!active || duration <= 0}
          onInput={seek}
          onChange={seek}
        />
        <span className="tnum shrink-0 font-mono text-2xs text-muted">
          {mediaTime(duration)}
        </span>
        <button
          type="button"
          aria-label={player.muted ? t('chat.player.unmute', { label }) : t('chat.player.mute', { label })}
          className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={player.toggleMute}
        >
          {player.muted
            ? <VolumeMuteIcon className="size-3.5" />
            : <VoiceIcon className="size-3.5" />}
        </button>
        <input
          type="range"
          aria-label={t('chat.player.volume', { label })}
          min="0"
          max="1"
          step="0.05"
          value={player.muted ? 0 : player.volume}
          style={{ '--media-range-progress': volumeProgress + '%' }}
          className="media-player-range hidden h-1 w-12 cursor-pointer sm:block"
          onChange={changeVolume}
        />
      </div>
      {mediaError ? (
        <SourceFailure
          probe={probeUnavailable}
          url={url}
          onSave={onSave}
          onOpenOriginal={onOpenOriginal}
          fallbackUrl={fallbackUrl}
        />
      ) : null}
    </div>
  );
}

/// The media element cannot say why a source failed — a deleted or expired
/// file and an unsupported codec look the same through `onError`. When the
/// caller can probe the origin's metadata, a 404 means the file is gone, and
/// "open the original file" would be pointing at a grave.
function SourceFailure({ probe, url, onSave, onOpenOriginal, fallbackUrl }) {
  const t = useT();
  const [gone, setGone] = useState(null);
  useEffect(() => {
    setGone(null);
    if (!probe) return undefined;
    let live = true;
    probe().then((result) => { if (live) setGone(result); })
      .catch(() => { if (live) setGone(false); });
    return () => { live = false; };
  }, [url, probe]);

  if (gone) {
    return (
      <span className="px-2.5 pb-2 text-2xs text-muted">
        {t('chat.attachment.fileGone')}
      </span>
    );
  }
  if (onSave) {
    return (
      <button
        type="button"
        onClick={onSave}
        className="min-h-10 px-2.5 pb-2 text-start text-xs font-medium text-danger hover:underline"
      >
        {t('chat.player.failedSave')}
      </button>
    );
  }
  if (onOpenOriginal) {
    return (
      <button
        type="button"
        onClick={onOpenOriginal}
        className="min-h-10 px-2.5 pb-2 text-start text-xs font-medium text-danger hover:underline"
      >
        {t('chat.player.failedOpen')}
      </button>
    );
  }
  return (
    <a
      href={fallbackUrl || url}
      target="_blank"
      rel="noreferrer noopener"
      className="px-2.5 pb-2 text-2xs text-danger hover:underline"
    >
      {t('chat.player.failedOpen')}
    </a>
  );
}

function MediaPlayer(props) {
  const persistentAudio = usePersistentAudio();
  if (props.kind === 'audio' && persistentAudio) {
    return <PersistentAudioControls player={persistentAudio} {...props} />;
  }
  return <LocalMediaPlayer {...props} />;
}

function LocalMediaPlayer({
  kind, url, name, mime, onWidthChange, onSave = null, fallbackUrl = null, probeUnavailable = null, note = null,
  onOpenOriginal = null,
}) {
  const t = useT();
  const label = kind === 'video'
    ? t('chat.player.videoOf', { name })
    : t('chat.player.audioOf', { name });
  const mediaRef = useRef(null);
  const frameRef = useRef(null);
  const seekRef = useRef(null);
  const progressAnimationRef = useRef(null);
  const playRequestedRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [frameWidth, setFrameWidth] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  useEffect(() => {
    if (progressAnimationRef.current !== null) {
      cancelAnimationFrame(progressAnimationRef.current);
      progressAnimationRef.current = null;
    }
    playRequestedRef.current = false;
    setPlaying(false);
    setFrameWidth(null);
    setCurrentTime(0);
    setDuration(0);
    setMediaError(false);

    return () => {
      if (progressAnimationRef.current !== null) {
        cancelAnimationFrame(progressAnimationRef.current);
        progressAnimationRef.current = null;
      }
    };
  }, [url]);

  const updateDuration = (event) => {
    const next = event.currentTarget.duration;
    setDuration(Number.isFinite(next) ? next : 0);
  };
  const updateFrameSize = (event) => {
    updateDuration(event);
    if (kind !== 'video') return;
    const media = event.currentTarget;
    if (!media.videoWidth || !media.videoHeight) return;

    if (media.currentTime === 0 && Number.isFinite(media.duration) && media.duration > 0) {
      try {
        media.currentTime = Math.min(0.01, media.duration / 2);
      } catch {
        // Some engines refuse an early seek until more data arrives
      }
    }

    const layoutWidth = frameRef.current?.parentElement?.parentElement?.clientWidth || 440;
    const availableWidth = Math.max(1, layoutWidth - 26);
    const scale = Math.min(1, 320 / media.videoHeight, availableWidth / media.videoWidth);
    const nextWidth = Math.max(1, Math.round(media.videoWidth * scale));
    setFrameWidth(nextWidth);
    onWidthChange?.(nextWidth);
  };
  const updateTime = (event) => setCurrentTime(event.currentTarget.currentTime || 0);
  const stopProgressAnimation = () => {
    if (progressAnimationRef.current === null) return;
    cancelAnimationFrame(progressAnimationRef.current);
    progressAnimationRef.current = null;
  };
  const startProgressAnimation = () => {
    if (progressAnimationRef.current !== null) return;

    const tick = () => {
      const media = mediaRef.current;
      if (!media || media.paused || media.ended) {
        progressAnimationRef.current = null;
        return;
      }

      const mediaDuration = media.duration;
      if (seekRef.current && Number.isFinite(mediaDuration) && mediaDuration > 0) {
        const progress = Math.max(0, Math.min(100, (media.currentTime / mediaDuration) * 100));
        seekRef.current.value = String(progress);
        seekRef.current.style.setProperty('--media-range-progress', `${progress}%`);
      }
      progressAnimationRef.current = requestAnimationFrame(tick);
    };

    progressAnimationRef.current = requestAnimationFrame(tick);
  };
  const tryPlay = (media) => {
    try {
      const result = media.play();
      // Some WebKit builds reject play() while the source attaches; retry on canplay.
      result?.catch(() => {});
    } catch {
      // The media element will surface a real source error through onError
    }
  };
  const togglePlay = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) {
      playRequestedRef.current = true;
      tryPlay(media);
    } else {
      playRequestedRef.current = false;
      media.pause();
    }
  };
  const readyToPlay = (event) => {
    updateDuration(event);
    if (playRequestedRef.current && event.currentTarget.paused) tryPlay(event.currentTarget);
  };
  const seek = (event) => {
    const mediaDuration = duration || mediaRef.current?.duration;
    if (!mediaRef.current || !Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
    const fraction = Number(event.target.value) / 100;
    if (!Number.isFinite(fraction)) return;
    const next = Math.max(0, Math.min(mediaDuration, fraction * mediaDuration));
    event.currentTarget.style.setProperty('--media-range-progress', `${Math.max(0, Math.min(100, fraction * 100))}%`);
    mediaRef.current.currentTime = next;
    setCurrentTime(next);
  };
  const changeVolume = (event) => {
    const next = Number(event.target.value);
    if (!mediaRef.current || !Number.isFinite(next)) return;
    mediaRef.current.volume = next;
    mediaRef.current.muted = next === 0;
    event.currentTarget.style.setProperty('--media-range-progress', `${Math.max(0, Math.min(100, next * 100))}%`);
    setVolume(next);
    setMuted(next === 0);
  };
  const toggleMute = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.muted || muted) {
      const next = volume || 0.75;
      media.volume = next;
      media.muted = false;
      setVolume(next);
      setMuted(false);
    } else {
      media.muted = true;
      setMuted(true);
    }
  };
  const toggleFullscreen = () => {
    const frame = frameRef.current;
    if (!frame) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else frame.requestFullscreen?.();
  };

  const Media = kind === 'audio' ? 'audio' : 'video';
  const compactVideo = kind === 'video' && frameWidth !== null && frameWidth < 320;
  const seekProgress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  const volumeProgress = (muted ? 0 : volume) * 100;
  return (
    <div
      ref={frameRef}
      style={kind === 'video' && frameWidth ? { width: `${frameWidth}px`, maxWidth: '100%' } : undefined}
      className={`media-player-frame overflow-hidden rounded-[var(--radius-row)] bg-surface ${kind === 'audio' ? 'max-w-[360px]' : 'inline-flex w-fit max-w-full flex-col items-stretch'}`}
    >
      <Media
        ref={mediaRef}
        // WebKit/Tauri attach race.
        src={url}
        aria-hidden="true"
        className={kind === 'video' ? 'block h-auto max-h-[320px] max-w-full w-auto object-contain' : 'sr-only'}
        disablePictureInPicture={kind === 'video'}
        disableRemotePlayback={kind === 'video'}
        controlsList="nodownload noremoteplayback"
        preload={kind === 'video' ? 'metadata' : 'none'}
        playsInline={kind === 'video'}
        onLoadedMetadata={updateFrameSize}
        onLoadedData={updateDuration}
        onCanPlay={readyToPlay}
        onDurationChange={updateDuration}
        onError={() => {
          playRequestedRef.current = false;
          setMediaError(true);
        }}
        onTimeUpdate={updateTime}
        onPlay={() => {
          setPlaying(true);
          startProgressAnimation();
        }}
        onPause={(event) => {
          stopProgressAnimation();
          setPlaying(false);
          setCurrentTime(event.currentTarget.currentTime || 0);
        }}
        onEnded={() => {
          stopProgressAnimation();
          playRequestedRef.current = false;
          setPlaying(false);
          setCurrentTime(0);
        }}
        onClick={kind === 'video' ? togglePlay : undefined}
      />
      <div className="media-player-controls flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-muted">
        <button
          type="button"
          aria-label={playing ? t('chat.player.pause', { label }) : t('chat.player.play', { label })}
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover focus-outside"
          onClick={togglePlay}
        >
          {playing ? <PauseIcon className="size-3.5" strokeWidth={2} /> : <PlayIcon className="size-3.5" strokeWidth={2} />}
        </button>
        <span
          className={compactVideo ? 'hidden' : 'tnum shrink-0 font-mono text-2xs text-foreground'}
          aria-live="off"
        >
          {mediaTime(currentTime)}
        </span>
        <input
          ref={seekRef}
          type="range"
          aria-label={t('chat.player.seek', { label })}
          min="0"
          max="100"
          step="any"
          value={seekProgress}
          style={{ '--media-range-progress': `${seekProgress}%` }}
          className="media-player-range h-1 min-w-0 flex-1 cursor-pointer"
          disabled={duration <= 0}
          onInput={seek}
          onChange={seek}
        />
        <span className={compactVideo ? 'hidden' : 'tnum shrink-0 font-mono text-2xs text-muted'}>
          {mediaTime(duration)}
        </span>
        <button
          type="button"
          aria-label={muted ? t('chat.player.unmute', { label }) : t('chat.player.mute', { label })}
          className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-surface-tertiary hover:text-foreground focus-outside"
          onClick={toggleMute}
        >
          {muted ? <VolumeMuteIcon className="size-3.5" /> : <VoiceIcon className="size-3.5" />}
        </button>
        <input
          type="range"
          aria-label={t('chat.player.volume', { label })}
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          style={{ '--media-range-progress': `${volumeProgress}%` }}
          className={compactVideo ? 'hidden' : 'media-player-range hidden h-1 w-12 cursor-pointer sm:block'}
          onChange={changeVolume}
        />
        {kind === 'video' ? (
          <button
            type="button"
            aria-label={t('chat.player.fullscreen', { label })}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors hover:bg-surface-tertiary hover:text-foreground focus-outside sm:size-6 sm:rounded-md"
            onClick={toggleFullscreen}
          >
            <FullscreenIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      {mediaError ? (
        <SourceFailure
          probe={probeUnavailable}
          url={url}
          onSave={onSave}
          onOpenOriginal={onOpenOriginal}
          fallbackUrl={fallbackUrl}
        />
      ) : null}
    </div>
  );
}

export function PlayableAttachment({
  att, url, host, onSave = null, fallbackUrl = null, onOpenOriginal = null,
  probeUnavailable = null,
}) {
  const t = useT();
  const [cardWidth, setCardWidth] = useState(null);
  const kind = playableKind(att);
  if (!kind || !url) return null;
  const name = att.name || att.filename || att.ref || t('chat.attachment.unnamed');
  const note = hostingNote(host, att);


  return (
    <div
      style={cardWidth
        ? { width: `calc(${cardWidth}px + var(--embed-pad-x) * 2)`, maxWidth: '100%' }
        : undefined}
      className="embed embed--stack"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AttachIcon className="size-4 shrink-0 text-muted" />
        {onSave ? (
          <button
            type="button"
            title={t('chat.attachment.saveNamed', { name })}
            className="min-w-0 flex-1 truncate text-start text-foreground hover:text-accent hover:underline focus-outside"
            onClick={onSave}
          >
            <EmojiText>{name}</EmojiText>
          </button>
        ) : onOpenOriginal ? (
          <button
            type="button"
            title={t('chat.attachment.openNamed', { name })}
            className="min-w-0 flex-1 truncate text-start text-foreground hover:text-accent hover:underline focus-outside"
            onClick={onOpenOriginal}
          >
            <EmojiText>{name}</EmojiText>
          </button>
        ) : (
          <a
            href={fallbackUrl || url}
            target="_blank"
            rel="noreferrer noopener"
            title={t('chat.attachment.openNamed', { name })}
            className="min-w-0 flex-1 truncate text-foreground hover:text-accent hover:underline focus-outside"
          >
            <EmojiText>{name}</EmojiText>
          </a>
        )}
        {att.size != null ? <span className="tnum shrink-0 text-xs text-muted">{bytes(att.size)}</span> : null}
        {onSave ? (
          <button
            type="button"
            className="min-h-9 shrink-0 rounded-lg px-2 text-xs font-medium text-accent active:bg-surface-secondary"
            onClick={onSave}
          >
            {t('chat.attachment.save')}
          </button>
        ) : null}
      </div>
      {note ? <span className="text-2xs text-muted">{note}</span> : null}
      <MediaPlayer
        kind={kind}
        url={url}
        name={name}
        mime={playableMime(att, kind)}
        onWidthChange={kind === 'video' ? setCardWidth : undefined}
        onSave={onSave}
        fallbackUrl={fallbackUrl}
        onOpenOriginal={onOpenOriginal}
        probeUnavailable={probeUnavailable}
        note={note}
      />
    </div>
  );
}

function linkFilename(url) {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.host;
  } catch {
    return translate('chat.attachment.externalMedia');
  }
}

function linkHost(url) {
  try { return new URL(url).host; } catch { return translate('chat.attachment.externalHost'); }
}

export function PlayableLink({ url }) {
  const t = useT();
  const [cardWidth, setCardWidth] = useState(null);
  const kind = playableKindForUrl(url);
  if (!kind || isGofileUrl(url)) return null;
  const name = linkFilename(url);
  const host = linkHost(url);
  const att = { name };
  const note = hostingNote(host, att);

  return (
    <div
      style={cardWidth
        ? { width: `calc(${cardWidth}px + var(--embed-pad-x) * 2)`, maxWidth: '100%' }
        : undefined}
      className="embed embed--stack"
    >
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <AttachIcon className="size-4 shrink-0 text-muted" />
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          title={t('chat.attachment.openNamed', { name })}
          className="min-w-0 flex-1 truncate text-foreground hover:text-accent hover:underline focus-outside"
        >
          <EmojiText>{name}</EmojiText>
        </a>
      </div>
      {note ? <span className="text-2xs text-muted">{note}</span> : null}
      <MediaPlayer
        kind={kind}
        url={url}
        name={name}
        mime={playableMime(att, kind)}
        onWidthChange={kind === 'video' ? setCardWidth : undefined}
        note={note}
      />
    </div>
  );
}
