import { ModalShell } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { EmojiPickerPanel } from '../chat/EmojiPicker.jsx';

export function EmojiPickerDialog({ guildId, close, onPick, onPickSticker }) {
  const t = useT();
  return (
    <ModalShell title={t('chat.emoji.dialogTitle')} bodyClassName="min-h-0 flex-1 gap-0 p-0">
      <div className="emoji-sheet">
        <EmojiPickerPanel
          guildId={guildId}
          onPick={onPick}
          onPickSticker={onPickSticker}
          onClose={close}
          className="emoji-panel emoji-panel--fill"
        />
      </div>
    </ModalShell>
  );
}
