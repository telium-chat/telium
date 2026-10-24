import { useMemo } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { quickEmoji, rememberEmoji } from '../../lib/emoji.js';
import { has } from '../../lib/perms.js';
import { Twemoji } from '../../components/Twemoji.jsx';
import { PlusIcon } from '../../components/index.js';
import { EmojiPickerDialog } from '../dialogs/EmojiPickerDialog.jsx';
import { useMobileBackDismiss } from '../../hooks/useMobileBackDismiss.js';
import { MenuRows } from './MobileActionSheet.jsx';

const DEFAULT_QUICK_EMOJIS = ['❤️', '👍', '😂', '🎉', '🔥', '😮'];

export function MobileMessageActionSheet({ msg, surface, onClose, onReply, onEdit }) {
  useMobileBackDismiss(onClose);
  const store = useStore();
  const modal = useModal();
  const mayReact = has(surface.perms, 'ADD_REACTIONS');
  const quick = useMemo(() => quickEmoji(store.sync, 6) || DEFAULT_QUICK_EMOJIS, [store]);

  const toggleReaction = async (emoji) => {
    try {
      const held = (msg.reactions || []).find((r) => r.emoji === emoji)?.me;
      if (held) await surface.unreact(msg, emoji);
      else {
        await surface.react(msg, emoji);
        rememberEmoji(store.sync, emoji);
      }
      onClose();
    } catch (e) {
      // ignore
    }
  };

  const handleOpenEmojiPicker = () => {
    onClose();
    setTimeout(() => {
      modal.open((close) => (
        <EmojiPickerDialog
          guildId={surface.guildId}
          close={close}
          onPick={(emoji) => toggleReaction(emoji)}
        />
      ), { wide: true, desktopSize: 'emoji' });
    }, 50);
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close message options"
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs animate-fade-in"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        data-mobile-gesture-lock
        aria-label="Message Actions"
        className="mobile-bottom-sheet fixed inset-x-0 bottom-0 z-50 overflow-y-auto overscroll-contain rounded-t-3xl bg-background shadow-2xl animate-sheet-in"
        style={{
          maxHeight: 'min(85dvh, calc(100dvh - var(--safe-area-top) - 0.5rem))',
          paddingBottom: 'max(0.75rem, var(--safe-area-bottom))',
        }}
      >
        <div className="flex justify-center pt-3 pb-2">
          <span className="h-1.25 w-10 rounded-full bg-border" />
        </div>

        {mayReact && !msg.deleted && !msg.unreadable ? (
        <div className="mx-3 mb-2 flex items-center justify-between gap-1 rounded-2xl bg-surface px-2 py-2">
          {quick.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => toggleReaction(emoji)}
              className="flex size-10 items-center justify-center rounded-xl"
            >
              <Twemoji emoji={emoji} className="size-6 pointer-events-none" />
            </button>
          ))}
          <button
            type="button"
            onClick={handleOpenEmojiPicker}
            aria-label="More reactions"
            className="flex size-10 items-center justify-center rounded-xl bg-surface-secondary text-muted active:bg-surface-tertiary"
          >
            <PlusIcon className="size-5" />
          </button>
        </div>
        ) : null}

        <div className="flex flex-col gap-0.5 px-3 pb-2">
          <MenuRows onClose={onClose}>{surface.menu(msg, { onReply, onEdit })}</MenuRows>
        </div>
      </section>
    </>
  );
}
