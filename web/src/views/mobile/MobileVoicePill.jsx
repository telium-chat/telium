import { useEffect, useState } from 'react';
import { useStore, useStoreEventFor } from '../../hooks/useStore.jsx';
import { useVoice } from '../../hooks/useVoice.jsx';
import { cn } from '../../lib/cn.js';
import { conversationName } from '../../lib/util.js';
import { EmojiText, MicIcon, MicOffIcon, PhoneOffIcon } from '../../components/index.js';

export function MobileVoicePill({ onExpand }) {
  const voice = useVoice();
  const store = useStore();
  const [elapsed, setElapsed] = useState('00:00');

  useStoreEventFor((id) => id === voice.channelId, 'voice');

  useEffect(() => {
    if (voice.phase !== 'connected') return undefined;
    const interval = setInterval(() => {
      if (!voice.joinedAt) return;
      const sec = Math.max(0, Math.floor((Date.now() - voice.joinedAt) / 1000));
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      setElapsed(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(interval);
  }, [voice.phase, voice.joinedAt]);

  if (!voice.active) return null;

  const channel = voice.channelId ? store.channels.get(voice.channelId) : null;
  const convo = !channel && voice.channelId ? store.conversations.find((c) => c.id === voice.channelId) : null;
  const name = channel?.name ? `#${channel.name}` : conversationName(convo, store.me?.user_id) || 'Voice Call';

  const mine = (store.voice.get(voice.channelId) || [])
    .find((v) => v.user_id === store.me?.user_id);
  const deafened = voice.local.self_deaf || Boolean(mine?.server_deaf);
  const held = Boolean(mine?.server_mute) || deafened;
  const silent = voice.local.self_mute || held;
  const micLabel = mine?.server_mute ? 'Server muted'
    : deafened ? 'Muted'
      : voice.local.self_mute ? 'Unmute' : 'Mute';

  return (
    <div className="shrink-0 border-b border-border bg-emerald-500/15 px-3 py-2 text-emerald-400 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onExpand}
          className="flex min-w-0 flex-1 items-center gap-2 text-start"
        >
          <span className="flex size-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold uppercase tracking-wider text-emerald-400">Voice Connected</span>
              <span className="text-xs text-emerald-400/70">{elapsed}</span>
            </div>
            <p className="truncate text-sm font-medium text-foreground"><EmojiText>{name}</EmojiText></p>
          </div>
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={micLabel}
            title={micLabel}
            aria-pressed={silent}
            disabled={held}
            onClick={() => voice.toggle('self_mute')}
            className={cn(
              'flex size-9 items-center justify-center rounded-full transition-colors',
              silent ? 'bg-danger text-white' : 'bg-surface text-foreground',
              held ? 'cursor-not-allowed opacity-50' : !silent && 'active:bg-surface-tertiary',
            )}
          >
            {silent ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
          </button>

          <button
            type="button"
            aria-label="Disconnect"
            onClick={voice.leave}
            className="flex size-9 items-center justify-center rounded-full bg-danger text-white transition-colors active:opacity-80"
          >
            <PhoneOffIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
