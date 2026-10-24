import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { t } from '../../lib/i18n/index.js';
import { reportError } from '../../hooks/useToast.jsx';
import {
  Button, EmojiText, ModalShell, TextInput,
} from '../../components/index.js';

export const MAX_VOICE_STATUS = 140;

export function canSetVoiceStatus(store, channel) {
  if (!channel || channel.type !== 'voice') return false;
  try {
    if (['CONNECT', 'MANAGE_CHANNELS', 'MUTE_MEMBERS'].some((p) => store.can?.(channel.id, p))) return true;
  } catch { /* a partial store in a preview is not a denial */ }
  const me = store.me?.user_id;
  if (!me) return false;
  return (store.voice?.get(channel.id) || []).some((v) => v.user_id === me);
}

export function VoiceStatusDialog({ channel: initial, close }) {
  const store = useStore();
  const tt = useT();
  void tt;
  const channel = store.channels.get(initial.id) || initial;
  const [draft, setDraft] = useState(channel.voice_status || '');
  const [busy, setBusy] = useState(false);
  const over = [...draft].length > MAX_VOICE_STATUS;
  const trimmed = draft.trim();

  const apply = async (next) => {
    setBusy(true);
    try {
      const saved = await store.apiForChannel(channel.id).setVoiceStatus(channel.id, next);
      store.channels.set(channel.id, { ...channel, ...saved });
      store.emit('channels', channel.guild_id);
      close();
    } catch (e) {
      reportError(e, t(next ? 'voice.status.saveFailed' : 'voice.status.clearFailed'));
    } finally { setBusy(false); }
  };

  return (
    <ModalShell
      title={channel.voice_status ? t('voice.status.edit') : t('voice.status.set')}
      subtitle={channel.name}
    >
      <TextInput
        label={t('voice.status.label')}
        autoFocus
        value={draft}
        maxLength={MAX_VOICE_STATUS + 10}
        placeholder={t('voice.status.placeholder')}
        hint={t('voice.status.hint', { count: [...draft].length, max: MAX_VOICE_STATUS })}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !over && !busy) apply(trimmed || null); }}
      />
      {over ? <p className="text-xs text-danger">{t('voice.status.tooLong', { max: MAX_VOICE_STATUS })}</p> : null}
      <div className="flex justify-end gap-2 pt-1">
        {channel.voice_status ? (
          <Button variant="ghost" isDisabled={busy} onClick={() => apply(null)} className="me-auto">
            {t('voice.status.clear')}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" isDisabled={busy || over || !trimmed} onClick={() => apply(trimmed)}>
          {t('voice.status.save')}
        </Button>
      </div>
    </ModalShell>
  );
}

export function VoiceStatusLine({ channel, className = '' }) {
  useT();
  if (channel?.type !== 'voice' || !channel?.voice_status) return null;
  return (
    <span className={`min-w-0 truncate text-xs text-muted ${className}`}>
      <EmojiText>{channel.voice_status}</EmojiText>
    </span>
  );
}
