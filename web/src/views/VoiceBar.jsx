import { useEffect, useState } from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { cn } from '../lib/cn.js';
import { useStore, useStoreEventFor } from '../hooks/useStore.jsx';
import { conversationName, shortName } from '../lib/util.js';
import { roomFace } from '../lib/faces.js';
import { VoiceStatusLine } from './dialogs/VoiceStatusDialog.jsx';
import { PING_WINDOW, useVoice } from '../hooks/useVoice.jsx';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { Avatar, EmojiText, IconButton, SpinnerIcon } from '../components/index.js';
import { Tooltip } from '../components/Tooltip.jsx';
import {
  HeadphoneOffIcon, HeadphonesIcon, MicIcon, MicOffIcon,
  PhoneOffIcon, ScreenIcon, ScreenOffIcon, VideoIcon, VideoOffIcon,
} from '../components/index.js';

function formatElapsed(ms) {
  if (!ms) return '00:00';
  const total = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function connectionLevel(ping) {
  if (ping == null) return { bars: 0, level: 'unknown', tip: t('voice.bar.measuring') };
  const ms = Math.round(ping);
  const tip = t('voice.bar.ping', { ms });
  if (ms < 60) return { bars: 4, level: 'ok', tip };
  if (ms < 120) return { bars: 3, level: 'ok', tip };
  if (ms < 250) return { bars: 2, level: 'fair', tip };
  return { bars: 1, level: 'poor', tip };
}

function pingStats(samples) {
  if (!samples.length) return null;
  let sum = 0;
  for (const ms of samples) sum += ms;
  return {
    avg: Math.round(sum / samples.length),
    last: Math.round(samples[samples.length - 1]),
  };
}

function ceiling(max) {
  if (!(max > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 2.5, 5, 10].find((s) => max <= s * magnitude) ?? 10;
  return step * magnitude;
}

const LEVEL_TEXT = {
  unknown: 'text-muted',
  ok: 'text-success',
  fair: 'text-warning',
  poor: 'text-danger',
};

const RUNGS = [
  { x: 0.4, y: 9.5, h: 3 },
  { x: 3.9, y: 7, h: 5.5 },
  { x: 7.4, y: 4.5, h: 8 },
  { x: 10.9, y: 2, h: 10.5 },
];

function SignalMeter({ bars, level }) {
  return (
    <svg viewBox="0 0 14 14" className="signal size-3.5 shrink-0" data-level={level} aria-hidden>
      {RUNGS.map((rung, i) => (
        <rect
          key={rung.x}
          className="signal__rung"
          data-lit={i < bars ? '' : undefined}
          x={rung.x}
          y={rung.y}
          width={2}
          height={rung.h}
          rx={1}
        />
      ))}
    </svg>
  );
}

const GRAPH_W = 196;
const GRAPH_H = 72;
const GRAPH_TOP = 16;
const GRAPH_FLOOR = 68;

function PingGraph({ samples, stats }) {
  const shown = samples.slice(-PING_WINDOW);
  const plot = GRAPH_FLOOR - GRAPH_TOP;
  const slot = GRAPH_W / PING_WINDOW;
  const width = Math.max(2, slot - 1.4);
  const scale = ceiling(Math.max(0, ...shown));
  const at = (ms) => GRAPH_FLOOR - Math.max(1, (plot * ms) / scale);

  return (
    <svg
      width="100%"
      height={GRAPH_H}
      viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        x1={0}
        y1={GRAPH_FLOOR + 0.5}
        x2={GRAPH_W}
        y2={GRAPH_FLOOR + 0.5}
        strokeWidth="1"
        stroke="currentColor"
        className="text-separator"
      />
      {stats ? (
        <line
          x1={0}
          y1={at(stats.avg)}
          x2={GRAPH_W}
          y2={at(stats.avg)}
          strokeWidth="1"
          stroke="currentColor"
          className="ping-graph__avg"
        />
      ) : null}
      {shown.map((ms, i) => (
        <rect
          key={i}
          className={cn('ping-graph__bar', LEVEL_TEXT[connectionLevel(ms).level])}
          x={(PING_WINDOW - shown.length + i) * slot + (slot - width) / 2}
          y={at(ms)}
          width={width}
          height={GRAPH_FLOOR - at(ms)}
          rx={0.5}
        />
      ))}
    </svg>
  );
}

function PingHistoryPanel({ samples }) {
  useT();
  const stats = pingStats(samples);
  return (
    <div>
      <span className="block text-sm font-semibold text-foreground">{t('voice.bar.pingHistory')}</span>
      <PingGraph samples={samples} stats={stats} />
      {stats ? (
        <dl className="mt-2 space-y-1 text-xs">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{t('voice.bar.pingAvg')}</dt>
            <dd className="tnum text-foreground">{t('voice.bar.ping', { ms: stats.avg })}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted">{t('voice.bar.pingLast')}</dt>
            <dd className="tnum text-foreground">{t('voice.bar.ping', { ms: stats.last })}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted">{t('voice.bar.measuring')}</p>
      )}
    </div>
  );
}

function Tool({ title, icon: Glyph, on, danger, disabled, onClick }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-center justify-center gap-1.5 rounded-row px-2 py-1.5',
        'text-xs font-medium transition-colors duration-[var(--dur-1)] ease-[var(--ease)]',
        disabled && 'cursor-not-allowed opacity-50',
        on
          ? danger
            ? cn('bg-danger text-danger-foreground', !disabled && 'hover:opacity-90')
            : cn('bg-accent text-accent-foreground', !disabled && 'hover:bg-accent-hover')
          : cn(
            'bg-surface-secondary text-muted',
            !disabled && 'hover:bg-surface-tertiary hover:text-foreground',
          ),
      )}
    >
      <Glyph className="size-[15px] shrink-0" />
      <span className="truncate">{title}</span>
    </button>
  );
}

const FACE_LIMIT = 7;

function Roster({ participants, store, channel, speaking }) {
  useT();
  if (!participants.length) return null;
  const live = speaking instanceof Set ? speaking : new Set();
  const shown = participants.slice(0, FACE_LIMIT);
  const rest = participants.length - shown.length;
  const guildBase = channel?.guild_id ? (store.apiForGuild?.(channel.guild_id)?.base || null) : null;
  const guildDomain = channel?.guild_id ? store.guilds.get(channel.guild_id)?.domain : null;

  return (
    <div
      role="group"
      aria-label={t('voice.room.inVoice', { count: participants.length })}
      className="mt-1.5 flex flex-wrap items-center gap-1"
    >
      {shown.map((v) => {
        const face = roomFace(store, v.user_id, {
          guildId: channel?.guild_id, guildBase, guildDomain, state: v,
        });
        const label = face?.name || shortName(v.user_id);
        return (
          <Tooltip key={v.user_id} label={label} side="top">
            <Avatar
              id={v.user_id}
              name={face?.name}
              size="sm"
              mediaRef={face.mediaRef}
              base={face.base}
              mediaOrigin={face.mediaOrigin}
              className={cn('voice-face', live.has(v.user_id) && 'is-talking')}
            />
          </Tooltip>
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

export function VoiceBar() {
  useT();
  const voice = useVoice();
  const store = useStore();
  const [, setTick] = useState(0);
  const [pingOpen, setPingOpen] = useState(false);

  useStoreEventFor((id) => id === voice.channelId, 'voice');
  useStoreEventFor((id) => id === voice.channelId, 'channels');

  useEffect(() => {
    if (voice.phase !== 'connected') return undefined;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [voice.phase]);

  if (!voice.active) return null;

  const channel = voice.channelId ? store.channels.get(voice.channelId) : null;
  const convo = !channel && voice.channelId
    ? store.conversations.find((c) => c.id === voice.channelId)
    : null;
  const name = channel?.name || conversationName(convo, store.me?.user_id) || t('voice.bar.channel');
  const guild = channel?.guild_id ? store.guilds.get(channel.guild_id) : null;
  const where = guild?.name || (convo ? t('voice.bar.directMessage') : null);
  const signal = connectionLevel(voice.ping);
  const history = voice.pingHistory || [];
  const connecting = voice.phase === 'connecting';
  const local = voice.local;

  const mine = (store.voice.get(voice.channelId) || [])
    .find((v) => v.user_id === store.me?.user_id);
  const serverMute = Boolean(mine?.server_mute);
  const serverDeaf = Boolean(mine?.server_deaf);

  const deafened = local.self_deaf || serverDeaf;
  const silent = local.self_mute || serverMute || deafened;

  const micState = serverMute ? 'serverMuted'
    : deafened ? 'muted'
      : local.self_mute ? 'unmute' : 'mute';
  const micLabel = t('voice.bar.mic', { state: micState });
  const deafState = serverDeaf ? 'serverDeafened'
    : local.self_deaf ? 'undeafen' : 'deafen';
  const deafLabel = t('voice.bar.deafen', { state: deafState });

  return (
    <div className="shrink-0 bg-rail px-2 pb-1 pt-2">
      <div className="rounded-xl bg-surface/70 px-2.5 py-2">
        <div className="flex items-center gap-2">
          {connecting ? (
            <SpinnerIcon className="size-3.5 shrink-0 animate-spin text-muted" />
          ) : (
            <Popover.Root open={pingOpen} onOpenChange={setPingOpen}>
              <Popover.Trigger
                render={<button type="button" />}
                aria-label={signal.tip}
                className="-m-1 inline-flex items-end rounded-md p-1 hover:bg-surface-secondary"
              >
                <Tooltip label={pingOpen ? null : signal.tip} side="top">
                  <span className={cn('inline-flex shrink-0 items-end', LEVEL_TEXT[signal.level])}>
                    <SignalMeter bars={signal.bars} level={signal.level} />
                  </span>
                </Tooltip>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner
                  side="top"
                  align="start"
                  positionMethod="fixed"
                  sideOffset={8}
                  collisionPadding={12}
                  className="popover z-50"
                >
                  <Popover.Popup
                    aria-label={t('voice.bar.pingHistory')}
                    className="popup popup--panel w-[220px]"
                  >
                    <PingHistoryPanel samples={history} />
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          )}
          <span
            role="status"
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-semibold',
              connecting ? 'text-muted' : 'text-foreground',
            )}
          >
            {connecting ? t('voice.bar.connecting') : t('voice.bar.connected')}
          </span>
          <span className="tnum shrink-0 text-xs tabular-nums text-muted">
            {formatElapsed(voice.joinedAt)}
          </span>
          <IconButton
            title={t('voice.bar.disconnect')}
            className="size-7 min-w-7 shrink-0 hover:bg-danger/10 hover:text-danger"
            onClick={voice.leave}
          >
            <PhoneOffIcon className="size-4" />
          </IconButton>
        </div>

        <div className="mt-0.5 flex min-w-0 items-baseline gap-1 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground"><EmojiText>{name}</EmojiText></span>
          {where ? (
            <>
              <span className="shrink-0 text-muted">/</span>
              <span className="min-w-0 truncate text-muted"><EmojiText>{where}</EmojiText></span>
            </>
          ) : null}
        </div>
        {channel?.type === 'voice' && channel?.voice_status ? (
          <div className="mt-0.5 min-w-0" title={channel.voice_status}>
            <VoiceStatusLine channel={channel} className="block" />
          </div>
        ) : null}

        <Roster
          participants={store.voice.get(voice.channelId) || []}
          store={store}
          channel={channel}
          speaking={voice.speaking}
        />
        <div role="toolbar" aria-label={t('voice.bar.toolbar')} className="mt-2 grid grid-cols-2 gap-1.5">
          <Tool
            title={micLabel}
            icon={silent ? MicOffIcon : MicIcon}
            on={silent}
            danger
            disabled={serverMute || deafened}
            onClick={() => voice.toggle('self_mute')}
          />
          <Tool
            title={deafLabel}
            icon={deafened ? HeadphoneOffIcon : HeadphonesIcon}
            on={deafened}
            danger
            disabled={serverDeaf}
            onClick={() => voice.toggle('self_deaf')}
          />
          <Tool
            title={local.self_video ? t('voice.bar.videoStop') : t('voice.bar.videoStart')}
            icon={local.self_video ? VideoIcon : VideoOffIcon}
            on={local.self_video}
            onClick={() => voice.toggle('self_video')}
          />
          <Tool
            title={local.streaming ? t('voice.bar.shareStop') : t('voice.bar.shareStart')}
            icon={local.streaming ? ScreenIcon : ScreenOffIcon}
            on={local.streaming}
            onClick={voice.toggleStream}
          />
        </div>
      </div>
    </div>
  );
}
