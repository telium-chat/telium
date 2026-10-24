import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';
import { useStore, useStoreEvent } from './useStore.jsx';
import {
  PauseIcon, PlayIcon, StopIcon, VoiceIcon,
} from '../components/index.js';

const PersistentAudioContext = createContext(null);

function mediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  if (mins < 60) return mins + ':' + secs;
  const hours = Math.floor(mins / 60);
  return hours + ':' + String(mins % 60).padStart(2, '0') + ':' + secs;
}

function routeKey(route) {
  return [
    route?.view || '',
    route?.guildId || '',
    route?.channelId || '',
    route?.conversationId || '',
  ].join(':');
}

export function usePersistentAudio() {
  return useContext(PersistentAudioContext);
}

export function PersistentAudioProvider({ children }) {
  const store = useStore();
  useStoreEvent('route');
  const audioRef = useRef(null);
  const trackRef = useRef(null);
  const [track, setTrack] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(false);

  const currentRouteKey = routeKey(store.route);

  const stop = useCallback(() => {
    const media = audioRef.current;
    if (media) {
      try { media.pause(); } catch { /* already stopped */ }
      try { media.currentTime = 0; } catch { /* no seekable source */ }
      media.removeAttribute('src');
    }
    trackRef.current = null;
    setTrack(null);
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setError(false);
  }, []);

  const playTrack = useCallback(({ url, label }) => {
    const media = audioRef.current;
    if (!media || !url) return;

    const sameTrack = trackRef.current?.url === url;
    if (!sameTrack) {
      if (trackRef.current) {
        try { media.pause(); } catch { /* previous track was already stopped */ }
      }
      media.src = url;
      media.currentTime = 0;
      const next = {
        url,
        label: label || 'Audio',
        originRouteKey: currentRouteKey,
      };
      trackRef.current = next;
      setTrack(next);
      setCurrentTime(0);
      setDuration(0);
      setError(false);
    }

    try {
      const result = media.play();
      result?.catch(() => {});
    } catch {
      // Source failures surface through the media element's error event
    }
  }, [currentRouteKey]);

  const toggle = useCallback(() => {
    const media = audioRef.current;
    if (!media || !trackRef.current) return;
    if (media.paused || media.ended) {
      try {
        const result = media.play();
        result?.catch(() => {});
      } catch {
        // Source failures surface through the media element's error event
      }
    } else {
      media.pause();
    }
  }, []);

  const toggleTrack = useCallback((next) => {
    if (trackRef.current?.url === next?.url) toggle();
    else playTrack(next || {});
  }, [playTrack, toggle]);

  const seek = useCallback((fraction) => {
    const media = audioRef.current;
    if (!media || !trackRef.current) return;
    const mediaDuration = media.duration;
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
    const next = Math.max(0, Math.min(1, Number(fraction)));
    if (!Number.isFinite(next)) return;
    media.currentTime = next * mediaDuration;
    setCurrentTime(media.currentTime || 0);
  }, []);

  const setVolume = useCallback((nextValue) => {
    const media = audioRef.current;
    const next = Math.max(0, Math.min(1, Number(nextValue)));
    if (!media || !Number.isFinite(next)) return;
    media.volume = next;
    media.muted = next === 0;
    setVolumeState(next);
    setMuted(next === 0);
  }, []);

  const toggleMute = useCallback(() => {
    const media = audioRef.current;
    if (!media) return;
    if (media.muted || muted) {
      const next = volume || 0.75;
      media.volume = next;
      media.muted = false;
      setVolumeState(next);
      setMuted(false);
    } else {
      media.muted = true;
      setMuted(true);
    }
  }, [muted, volume]);

  const value = useMemo(() => ({
    track,
    playing,
    currentTime,
    duration,
    volume,
    muted,
    error,
    awayFromSource: Boolean(track && track.originRouteKey !== currentRouteKey),
    playTrack,
    toggleTrack,
    toggle,
    seek,
    setVolume,
    toggleMute,
    stop,
  }), [
    track, playing, currentTime, duration, volume, muted, error, currentRouteKey,
    playTrack, toggleTrack, toggle, seek, setVolume, toggleMute, stop,
  ]);

  return (
    <PersistentAudioContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        aria-hidden="true"
        className="sr-only"
        preload="none"
        onLoadedMetadata={(event) => {
          const next = event.currentTarget.duration;
          setDuration(Number.isFinite(next) ? next : 0);
        }}
        onDurationChange={(event) => {
          const next = event.currentTarget.duration;
          setDuration(Number.isFinite(next) ? next : 0);
        }}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime || 0)}
        onPlay={() => setPlaying(true)}
        onPause={(event) => {
          setPlaying(false);
          setCurrentTime(event.currentTarget.currentTime || 0);
        }}
        onEnded={stop}
        onVolumeChange={(event) => {
          setVolumeState(event.currentTarget.volume);
          setMuted(event.currentTarget.muted);
        }}
        onError={() => {
          setPlaying(false);
          setError(true);
        }}
      />
    </PersistentAudioContext.Provider>
  );
}

export function PersistentAudioTopbar() {
  const player = usePersistentAudio();
  if (!player?.track || !player.awayFromSource) return null;

  const progress = player.duration > 0
    ? Math.max(0, Math.min(100, (player.currentTime / player.duration) * 100))
    : 0;

  return (
    <div
      aria-label="Audio player"
      className="ms-1 flex h-8 w-[min(420px,38vw)] min-w-[220px] shrink items-center gap-2 rounded-lg border border-border bg-surface-secondary px-2"
    >
      <VoiceIcon className="size-3.5 shrink-0 text-accent" />
      <span
        className="max-w-[130px] min-w-0 truncate text-2xs font-medium text-foreground"
        title={player.track.label}
      >
        {player.track.label}
      </span>
      <span className="tnum shrink-0 font-mono text-[0.5625rem] text-muted">
        {mediaTime(player.currentTime)}
      </span>
      <input
        type="range"
        aria-label={'Seek ' + player.track.label}
        min="0"
        max="100"
        step="any"
        value={progress}
        style={{ '--media-range-progress': progress + '%' }}
        className="media-player-range h-1 min-w-[60px] flex-1 cursor-pointer"
        disabled={player.duration <= 0}
        onInput={(event) => player.seek(Number(event.currentTarget.value) / 100)}
        onChange={(event) => player.seek(Number(event.currentTarget.value) / 100)}
      />
      <span className="tnum shrink-0 font-mono text-[0.5625rem] text-muted">
        {mediaTime(player.duration)}
      </span>
      <button
        type="button"
        aria-label={(player.playing ? 'Pause ' : 'Play ') + player.track.label}
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={player.toggle}
      >
        {player.playing
          ? <PauseIcon className="size-3" strokeWidth={2} />
          : <PlayIcon className="size-3" strokeWidth={2} />}
      </button>
      <button
        type="button"
        aria-label={'Stop ' + player.track.label}
        title="Stop and close"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-tertiary hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        onClick={player.stop}
      >
        <StopIcon className="size-3" strokeWidth={2} />
      </button>
    </div>
  );
}
