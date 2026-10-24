import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useWatch } from '../../hooks/useWatch.jsx';
import { correctionFor, positionAt, theirClock } from '../../lib/watch/timeline.js';
import { RATES } from '../../lib/watch/protocol.js';
import { connectsTo, createPlayer } from '../../lib/watch/player.js';
import { hostOf, providerById } from '../../lib/watch/providers.js';
import { shortName } from '../../lib/util.js';
import { cn } from '../../lib/cn.js';
import {
  Button, LockIcon, PauseIcon, PlayIcon, ShieldAlertIcon, SpinnerIcon, WatchingIcon,
} from '../../components/index.js';
import { t } from '../../lib/i18n/index.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';

const TICK_MS = 250;

const SEEK_COOLDOWN_MS = 1200;

export function WatchTogether({ mobile = false, mini = false }) {
  const watch = useWatch();
  const { session, consented } = watch;
  if (!session) return null;
  return consented
    ? <WatchStage key={session.id} mobile={mobile} mini={mini} />
    : <WatchConsent key={session.id} />;
}

function WatchConsent() {
  useT();
  const store = useStore();
  const watch = useWatch();
  const { session } = watch;
  const host = hostOf(session.source);
  const about = connectsTo(session.source);
  const starter = session.by === store.me?.user_id ? t('voice.watch.you') : shortName(session.by);

  return (
    <div className="mx-auto flex w-full max-w-[560px] shrink-0 flex-col gap-3 rounded-2xl bg-surface p-4">
      <div className="flex items-center gap-2">
        <WatchingIcon className="size-[18px] shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          {t('voice.watch.started', {
            who: starter,
            what: about && about.kind !== 'file' ? about.name : t('voice.watch.aVideo'),
          })}
        </span>
      </div>
      <p className="text-sm text-muted">
        <Trans
          k="voice.watch.consentHost"
          values={{ host }}
          components={{ b: <span className="font-medium text-foreground" /> }}
        />
        {' '}
        {t(about?.kind === 'file' ? 'voice.watch.noteFile' : 'voice.watch.noteFrame', {
          provider: about?.name,
        })}
      </p>
      <p className="text-sm text-muted">{t('voice.watch.proxyNote')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={watch.consent}>
          {t('voice.watch.connectTo', { host })}
        </Button>
        <Button onClick={watch.end}>{t('voice.watch.notNow')}</Button>
      </div>
      {watch.sealed ? null : (
        <p className="flex items-start gap-2 text-xs text-muted">
          <ShieldAlertIcon className="mt-px size-[14px] shrink-0" />
          <span>{t('voice.watch.relayedConsent')}</span>
        </p>
      )}
    </div>
  );
}

function WatchStage({ mobile, mini = false }) {
  useT();
  const store = useStore();
  const watch = useWatch();
  const { session, timeline, offsetFor, setStalled, holding } = watch;
  const mount = useRef(null);
  const player = useRef(null);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [at, setAt] = useState(0);

  const line = useRef(timeline);
  line.current = timeline;
  const offset = useRef(offsetFor);
  offset.current = offsetFor;
  const stall = useRef(setStalled);
  stall.current = setStalled;
  const hasInitialSync = useRef(false);

  useEffect(() => {
    const container = mount.current;
    if (!container) return undefined;
    hasInitialSync.current = false;
    setReady(false);
    setError(null);
    let made;
    try {
      made = createPlayer(session.source, container, {
        onReady: (seconds) => { setReady(true); setDuration(Number(seconds) || 0); },
        onStall: () => { if (hasInitialSync.current) stall.current(true); },
        onResume: () => { if (hasInitialSync.current) stall.current(false); },
        onEnded: () => stall.current(false),
        onError: (message) => setError(message),
      });
    } catch {
      setError(t('voice.watch.unplayable'));
      return undefined;
    }
    player.current = made;
    return () => {
      player.current = null;
      stall.current(false);
      made.destroy();
    };
  }, [session.id, session.source]);

  useEffect(() => {
    if (!ready) return undefined;
    let playing = true;
    let rate = 1;
    let sought = 0;
    let ticks = 0;
    const id = setInterval(() => {
      const it = player.current;
      if (!it) return;
      const now = Date.now();
      const held = line.current;
      const correction = correctionFor(held, it.position(), { now, offset: offset.current(held.by) });

      if (correction.paused) {
        if (playing) { it.pause(); playing = false; }
      } else if (!playing) { it.play(); playing = true; }

      if (correction.seek !== null && now - sought > SEEK_COOLDOWN_MS) {
        it.seek(correction.seek);
        sought = now;
        hasInitialSync.current = true;
      } else if (!correction.paused && Math.abs(correction.rate - rate) > 0.004) {
        rate = correction.rate;
        it.setRate(rate);
      }

      if (correction.paused && correction.seek === null) hasInitialSync.current = true;

      ticks += 1;
      if (ticks % 4 === 0) setAt(correction.target);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ready]);

  const where = useCallback(() => {
    const it = player.current;
    if (it) return it.position();
    return positionAt(line.current, theirClock(Date.now(), offsetFor(line.current.by)));
  }, [offsetFor]);

  const provider = providerById(session.source.provider);
  const waitingFor = holding.waiting.filter((u) => u !== store.me?.user_id);

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2', mini && 'min-w-0')}>
      <div className={cn(
        'relative grid min-h-0 flex-1 place-items-center overflow-hidden rounded-xl bg-black',
        mini && 'aspect-video w-full flex-none rounded-none',
      )}>
        <div ref={mount} className="absolute inset-0 grid place-items-center" />
        {ready || error ? null : (
          <div className="pointer-events-none relative flex items-center gap-2 text-sm text-white/70">
            <SpinnerIcon className="size-4 animate-spin" />
            {t('voice.watch.opening', { provider: provider?.name || t('voice.watch.thePlayer') })}
          </div>
        )}
        {error ? (
          <div className="relative mx-6 max-w-[420px] text-center text-sm text-white/80">{error}</div>
        ) : null}
        {waitingFor.length ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2 text-center text-sm text-white">
            {waitingFor.length === 1
              ? t('voice.watch.waitingFor', { who: shortName(waitingFor[0]) })
              : t('voice.watch.waitingForMany', { count: waitingFor.length })}
          </div>
        ) : null}
      </div>
      {mini ? null : <WatchControls at={at} duration={duration} where={where} mobile={mobile} />}
    </div>
  );
}

function WatchControls({ at, duration, where, mobile }) {
  useT();
  const store = useStore();
  const watch = useWatch();
  const { session, timeline, control } = watch;
  const mine = session.by === store.me?.user_id;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl bg-surface px-2 py-1.5">
      <button
        type="button"
        aria-label={t(timeline.paused ? 'voice.watch.playAll' : 'voice.watch.pauseAll')}
        onClick={() => (timeline.paused ? control.play(where()) : control.pause(where()))}
        className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground transition-[filter] duration-[var(--dur-1)] ease-[var(--ease)] active:[filter:brightness(var(--press))]"
      >
        {timeline.paused ? <PlayIcon className="size-[18px]" /> : <PauseIcon className="size-[18px]" />}
      </button>

      <Scrubber at={at} duration={duration} onSeek={control.seek} />

      <span className="shrink-0 text-xs tabular-nums text-muted ltr-notation">
        {duration ? t('voice.watch.elapsedOf', { at: clock(at), duration: clock(duration) }) : clock(at)}
      </span>

      {mobile ? null : (
        <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
          <span className="sr-only">{t('voice.watch.speed')}</span>
          <select
            value={timeline.rate}
            onChange={(e) => control.rate(Number(e.target.value), where())}
            className="rounded-lg bg-surface-tertiary px-1.5 py-1 text-xs text-foreground"
          >
            {RATES.map((rate) => (
              <option key={rate} value={rate}>{t('voice.watch.rate', { rate })}</option>
            ))}
          </select>
        </label>
      )}

      {watch.sealed ? (
        <LockIcon className="size-[14px] shrink-0 text-muted" aria-label={t('voice.watch.sealedLabel')} />
      ) : null}

      <Button variant="danger-soft" className="ms-auto shrink-0" onClick={mine ? watch.end : watch.leave}>
        {t(mine ? 'voice.watch.end' : 'voice.watch.leave')}
      </Button>
    </div>
  );
}

function Scrubber({ at, duration, onSeek }) {
  useT();
  if (!duration) return <div className="min-w-[80px] flex-1" />;
  return (
    <input
      type="range"
      min={0}
      max={duration}
      step={0.5}
      value={Math.min(at, duration)}
      aria-label={t('voice.watch.position')}
      onChange={(e) => onSeek(Number(e.target.value))}
      className={cn(
        'h-1.5 min-w-[80px] flex-1 cursor-pointer appearance-none rounded-full bg-surface-tertiary',
        '[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none',
        '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent',
        '[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:border-0',
        '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-accent',
      )}
    />
  );
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
