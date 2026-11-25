import { useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useT } from '../../lib/i18n/react.jsx';
import { useMobileBackDismiss } from '../../hooks/useMobileBackDismiss.js';
import { EmojiPickerPanel } from './EmojiPicker.jsx';
import { GifPickerPanel } from './GifPicker.jsx';

/// Emoji and GIFs docked under the composer on phones, in the space the keyboard
/// normally takes (its last height, see useMobileViewport), the way native
/// messengers swap the keyboard for an expression panel. Picking keeps it open.
/// Scrolling down through it grows it to most of the screen; pulling down from the
/// top of the list, or tapping the grip, brings it back to keyboard height.
export function MobileExpressionPanel({
  guildId, onPickEmoji, onPickSticker, onPickGif, encrypted, onClose,
}) {
  const t = useT();
  const [tab, setTab] = useState('emoji');
  const [expanded, setExpanded] = useState(false);
  const pull = useRef(null);
  useMobileBackDismiss(onClose);

  const onScrollCapture = (e) => {
    const el = e.target;
    if (!expanded && el instanceof Element && el.scrollTop > 24) setExpanded(true);
  };

  // A downward pull that starts with the list already at its top shrinks the panel.
  const atTop = (target, root) => {
    for (let el = target; el && el !== root; el = el.parentElement) {
      if (el.scrollTop > 0) return false;
    }
    return true;
  };
  const onTouchStart = (e) => {
    pull.current = expanded && e.touches.length === 1 && atTop(e.target, e.currentTarget)
      ? { y: e.touches[0].clientY } : null;
  };
  const onTouchMove = (e) => {
    if (!pull.current) return;
    if (e.touches[0].clientY - pull.current.y > 48) {
      pull.current = null;
      setExpanded(false);
    }
  };

  return (
    <section
      className="mobile-expressions"
      data-expanded={expanded || undefined}
      aria-label={t('chat.composer.expressions')}
      data-mobile-gesture-lock
      onScrollCapture={onScrollCapture}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
    >
      <button
        type="button"
        className="mobile-expressions__grip"
        aria-label={expanded ? 'Shrink panel' : 'Expand panel'}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden="true" />
      </button>
      <div className="mobile-expressions__tabs" role="tablist">
        {[
          ['emoji', t('chat.composer.emoji')],
          ['gif', t('chat.composer.gifs')],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn('mobile-expressions__tab')}
            onClick={() => { setTab(id); setExpanded(false); }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mobile-expressions__body">
        {tab === 'emoji' ? (
          <EmojiPickerPanel
            guildId={guildId}
            onPick={onPickEmoji}
            onPickSticker={onPickSticker}
            autoFocusSearch={false}
            className="emoji-panel emoji-panel--fill mobile-expressions__panel"
          />
        ) : (
          <GifPickerPanel
            onPick={onPickGif}
            onClose={onClose}
            encrypted={encrypted}
            autoFocusSearch={false}
            className="gif-popover gif-popover--fill mobile-expressions__panel"
          />
        )}
      </div>
    </section>
  );
}
