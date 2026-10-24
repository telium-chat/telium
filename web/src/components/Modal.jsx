import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { buttonVariants } from '@cloudflare/kumo/components/button';
import { cn } from '../lib/cn.js';
import { Button } from './Button.jsx';
import { Field, TextArea, TextInput } from './Field.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { BackIcon, CloseIcon } from './icons.jsx';
import { EmojiText } from './Twemoji.jsx';

export function ModalShell({
  title, subtitle, onBack, children, footer, bodyClassName, footerClassName,
}) {
  return (
    <>
      <header className="telium-modal-header flex shrink-0 items-center px-3.5 pt-4 pb-1">
        <div
          className={cn(
            'grid transition-[grid-template-columns,opacity]',
            'duration-[var(--dur-3)] ease-[var(--ease)]',
            onBack ? 'grid-cols-[1fr] opacity-100' : 'grid-cols-[0fr] opacity-0 pointer-events-none',
          )}
        >
          <div className="min-w-0 overflow-hidden">
            <button
              type="button"
              aria-label="Back"
              tabIndex={onBack ? 0 : -1}
              onClick={onBack}
              className={cn(
                buttonVariants({ variant: 'ghost', shape: 'square', size: 'sm' }),
                'text-muted hover:text-foreground',
              )}
            >
              <BackIcon className="size-4" />
            </button>
          </div>
        </div>
        <div className="min-w-0 flex-1 ps-1.5">
          <Dialog.Title className="text-lg font-semibold tracking-tight">
            <EmojiText>{title}</EmojiText>
          </Dialog.Title>
          {subtitle ? (
            <Dialog.Description className="mt-0.5 text-sm leading-5 text-muted">
              <EmojiText>{subtitle}</EmojiText>
            </Dialog.Description>
          ) : null}
        </div>
        <Dialog.Close
          aria-label="Close"
          className={cn(
            buttonVariants({ variant: 'ghost', shape: 'square', size: 'sm' }),
            'ms-1.5 shrink-0 text-muted hover:text-foreground',
          )}
        >
          <CloseIcon className="size-4" />
        </Dialog.Close>
      </header>
      {/* `flex-auto`, not `flex-1`: in WebKitGTK a zero basis collapses the body. */}
      <div
        data-mobile-scroll
        className={cn('telium-modal-body flex min-h-0 flex-auto flex-col gap-4 overflow-y-auto overscroll-contain px-5 py-2', bodyClassName)}
      >
        {children}
      </div>
      {footer ? (
        <footer className={cn('telium-modal-footer flex shrink-0 justify-end gap-2 px-5 pt-2 pb-4', footerClassName)}>
          {footer}
        </footer>
      ) : null}
    </>
  );
}

export function ConfirmDialog({
  title, body, confirmLabel = 'Confirm', danger = false, onConfirm, close,
}) {
  const [busy, setBusy] = useState(false);
  return (
    <ModalShell
      title={title}
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            isDisabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await onConfirm(); close(); } finally { setBusy(false); }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      {typeof body === 'string'
        ? <p className="text-base leading-[1.6] text-muted">{body}</p>
        : body}
    </ModalShell>
  );
}

export function PromptDialog({
  title, label, hint, value = '', placeholder = '', multiline = false,
  confirmLabel = 'Save', danger = false, require: required = null, onSubmit, close,
}) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const held = required != null && text.trim() !== required;
  const submit = async () => {
    if (held) return;
    setBusy(true);
    try { await onSubmit(text); close(); } finally { setBusy(false); }
  };

  const Control = multiline ? TextArea : TextInput;
  return (
    <ModalShell
      title={title}
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            isDisabled={busy || held}
            onClick={submit}
          >
            {confirmLabel}
          </Button>
        </>
      )}
    >
      <Control
        ref={ref}
        autoFocus
        label={label}
        hint={hint}
        value={text}
        placeholder={placeholder}
        rows={multiline ? 4 : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !multiline) submit(); }}
      />
    </ModalShell>
  );
}

export function useDialogs() {
  const modal = useModal();
  return {
    confirm: (props) => modal.open((close) => <ConfirmDialog {...props} close={close} />),
    prompt: (props) => modal.open((close) => <PromptDialog {...props} close={close} />),
  };
}

export { Field };
