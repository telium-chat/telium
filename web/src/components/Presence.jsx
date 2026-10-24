import { cn } from '../lib/cn.js';
import { DndIcon, IdleIcon, OfflineIcon, OnlineIcon } from './icons.jsx';

export const PRESENCE_STATES = ['online', 'idle', 'dnd', 'invisible'];

export const PRESENCE = {
  online: { label: 'Online', icon: OnlineIcon },
  idle: { label: 'Idle', icon: IdleIcon },
  dnd: { label: 'Do not disturb', icon: DndIcon, note: 'no notifications' },
  invisible: { label: 'Invisible', icon: OfflineIcon, note: 'you appear offline' },
  offline: { label: 'Offline', icon: OfflineIcon },
};

const DISC = 'M0 8a8 8 0 1 0 16 0a8 8 0 1 0-16 0Z';
const SHAPES = {
  online: DISC,
  idle: 'M15.92 9.12A8 8 0 1 1 6.88 0.08A6.4 6.4 0 0 0 15.92 9.12Z',
  dnd: `${DISC}M4.8 6.6h6.4a1.4 1.4 0 0 1 0 2.8H4.8a1.4 1.4 0 0 1 0-2.8Z`,
  offline: `${DISC}M3.6 8a4.4 4.4 0 1 0 8.8 0a4.4 4.4 0 1 0-8.8 0Z`,
};

export function Presence({ status, size = 36, typing = false, className }) {
  if (status === 'invisible') return null;
  const shape = SHAPES[status];
  if (!shape && !typing) return null;
  const label = PRESENCE[status]?.label || status;
  return (
    <span
      className={cn('presence', typing && 'is-typing', className)}
      data-status={status || 'unknown'}
      style={{ '--presence-avatar': `${size}px` }}
      role="img"
      aria-label={typing ? [label, 'typing'].filter(Boolean).join(', ') : label}
      title={typing ? 'typing' : label}
    >
      {shape ? (
        <svg viewBox="0 0 16 16" aria-hidden className="presence-glyph">
          <path fillRule="evenodd" d={shape} />
        </svg>
      ) : null}
      <span className="presence-typing" aria-hidden>
        <i className="presence-typing-dot" />
        <i className="presence-typing-dot" />
        <i className="presence-typing-dot" />
      </span>
    </span>
  );
}
