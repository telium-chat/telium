import { cn } from '../../lib/cn.js';
import { CloseIcon, EmojiText } from '../../components/index.js';
import { useMobileBackDismiss } from '../../hooks/useMobileBackDismiss.js';

export function MobileSheet({ title, subtitle, onClose, children, className = '' }) {
  useMobileBackDismiss(onClose);
  return (
    <>
      <button
        type="button"
        aria-label={`Close ${title}`}
        className="mobile-sheet-scrim fixed inset-0 z-40 bg-black/60 backdrop-blur-xs animate-fade-in"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        data-mobile-gesture-lock
        aria-label={title}
        className={cn(
          'mobile-sheet fixed inset-0 z-50 flex min-h-0 flex-col bg-background shadow-2xl animate-sheet-in',
          className,
        )}
      >
        <header
          className="flex shrink-0 items-center gap-2 border-b border-border px-2 pt-[var(--safe-area-top)]"
          style={{ minHeight: 'calc(3.5rem + var(--safe-area-top))' }}
        >
          <button
            type="button"
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="mobile-touch-target flex size-11 shrink-0 items-center justify-center rounded-xl text-muted active:bg-surface-tertiary"
          >
            <CloseIcon className="size-5" />
          </button>
          <div className="min-w-0 flex-1 py-2">
            <h2 className="truncate text-lg font-semibold tracking-tight"><EmojiText>{title}</EmojiText></h2>
            {subtitle ? <p className="truncate text-xs text-muted"><EmojiText>{subtitle}</EmojiText></p> : null}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </section>
    </>
  );
}
