import { GifPickerPanel } from '../chat/GifPicker.jsx';
import { ModalShell } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';

export function GifPickerDialog({ close, onPick, encrypted = false }) {
  const t = useT();
  return (
    <ModalShell title={t('chat.gif.dialogTitle')} bodyClassName="min-h-0 p-0">
      <GifPickerPanel
        onPick={onPick}
        onClose={close}
        encrypted={encrypted}
        className="gif-popover gif-popover--fill"
      />
    </ModalShell>
  );
}
