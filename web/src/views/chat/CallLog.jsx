import { memo } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { dateTime } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { faceOf } from '../../lib/faces.js';
import { shortName } from '../../lib/util.js';
import { cn } from '../../lib/cn.js';
import { PhoneIcon, PhoneOffIcon } from '../../components/index.js';

export function formatCallDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export const CallLogRow = memo(function CallLogRow({ entry }) {
  const t = useT();
  const store = useStore();
  const kind = entry?.callKind || 'ended';
  const missed = kind === 'missed';
  const face = entry?.author ? faceOf(store, entry.author) : null;
  const who = face?.name || (entry?.author ? shortName(entry.author) : null);
  let text = t('voice.log.ended');
  if (kind === 'incoming') text = t('voice.log.incoming');
  else if (kind === 'outgoing') text = t('voice.log.outgoing');
  else if (kind === 'missed') text = t('voice.log.missed');
  else if (kind === 'ended' && entry?.durationMs != null) {
    text = t('voice.log.endedDuration', { duration: formatCallDuration(entry.durationMs) });
  }
  return (
    <div className="flex justify-center px-2 py-1" data-call-log={entry?.id}>
      <span
        title={entry?.created_at ? dateTime(entry.created_at) : undefined}
        aria-label={who ? `${text} · ${who}` : text}
        className={cn(
          'flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs',
          missed
            ? 'border-danger/30 bg-danger/10 text-danger'
            : 'border-border bg-surface-secondary text-muted',
        )}
      >
        {missed || kind === 'ended'
          ? <PhoneOffIcon className="size-3.5 shrink-0" />
          : <PhoneIcon className="size-3.5 shrink-0" />}
        <span className="truncate font-medium">{text}</span>
      </span>
    </div>
  );
});
