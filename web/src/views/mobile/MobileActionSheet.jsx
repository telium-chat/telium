import { Children, Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn.js';
import { EmojiText, extractMenuItemProps } from '../../components/index.js';
import { useMobileBackDismiss } from '../../hooks/useMobileBackDismiss.js';

export function MobileContextMenu({ children, content, isDisabled = false, title }) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);
  const startPos = useRef(null);
  const suppressClickUntil = useRef(0);

  const start = useCallback((e) => {
    if (isDisabled) return;
    const touch = e.touches[0];
    startPos.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      if (startPos.current) {
        // Android may synthesize a click after touchend.
        suppressClickUntil.current = Number.POSITIVE_INFINITY;
        setOpen(true);
        navigator.vibrate?.(15);
      }
    }, 400);
  }, [isDisabled]);

  const move = useCallback((e) => {
    if (!startPos.current || !timerRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - startPos.current.x);
    const dy = Math.abs(touch.clientY - startPos.current.y);
    if (dx > 8 || dy > 8) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      startPos.current = null;
    }
  }, []);

  const end = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPos.current = null;
    if (suppressClickUntil.current === Number.POSITIVE_INFINITY) {
      suppressClickUntil.current = Date.now() + 120;
    }
  }, []);

  const spanRef = useRef(null);
  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    const handler = () => { if (!isDisabled) setOpen(true); };
    el.addEventListener('open-sheet', handler);
    return () => el.removeEventListener('open-sheet', handler);
  }, [isDisabled]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const child = (
    <span
      ref={spanRef}
      onTouchStart={start}
      onTouchMove={move}
      onTouchEnd={end}
      onTouchCancel={end}
      onClickCapture={(e) => {
        if (Date.now() >= suppressClickUntil.current) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      className="block w-full"
    >
      {children}
    </span>
  );

  return (
    <>
      {child}
      {open ? (
        <MobileActionSheet title={title} onClose={() => setOpen(false)}>
          {content()}
        </MobileActionSheet>
      ) : null}
    </>
  );
}

export function MenuRows({ children, onClose }) {
  const items = [];
  let key = 0;

  const collect = (nodes) => {
    for (const child of Children.toArray(nodes)) {
      if (!child || typeof child === 'string' || typeof child === 'number') continue;
      if (child.type === Fragment) {
        collect(child.props.children);
        continue;
      }

      const props = extractMenuItemProps(child);
      if (props?.kind === 'item') {
        items.push({ ...props, key: key++ });
        continue;
      }
      if (props?.kind === 'separator') {
        if (items.length && items[items.length - 1].kind !== 'separator') {
          items.push({ kind: 'separator', key: key++ });
        }
        continue;
      }

      if (child.props?.children) collect(child.props.children);
    }
  };
  collect(children);
  while (items[items.length - 1]?.kind === 'separator') items.pop();

  const handleAction = (item) => {
    if (item.isDisabled) return;
    onClose?.();
    setTimeout(() => item.onAction?.(), 50);
  };

  return (
    <>
      {items.map((item) => (
        item.kind === 'separator' ? (
          <div key={item.key} className="mx-3 my-1 h-px bg-border" aria-hidden />
        ) : (
          <button
            key={item.key}
            type="button"
            disabled={item.isDisabled}
            onClick={() => handleAction(item)}
            className={cn(
              'flex min-h-[48px] w-full items-center gap-3 rounded-xl px-3 text-start transition-colors active:bg-surface-tertiary',
              item.tone === 'danger' ? 'text-danger' : 'text-foreground',
              item.isDisabled && 'opacity-40',
            )}
          >
            {item.icon ? <item.icon className="size-5 shrink-0 opacity-70" /> : <span className="size-5 shrink-0" />}
            <span className="min-w-0 flex-1 text-lg font-medium"><EmojiText>{item.label}</EmojiText></span>
          </button>
        )
      ))}
    </>
  );
}

export function MobileActionSheet({ title, onClose, children }) {
  useMobileBackDismiss(onClose);

  return createPortal((
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-xs animate-fade-in"
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        data-mobile-gesture-lock
        aria-label={title || 'Actions'}
        className="mobile-bottom-sheet fixed inset-x-0 bottom-0 z-[101] overflow-y-auto overscroll-contain rounded-t-3xl bg-background shadow-2xl animate-sheet-in"
        style={{
          maxHeight: 'min(85dvh, calc(100dvh - var(--safe-area-top) - 0.5rem))',
          paddingBottom: 'max(0.75rem, var(--safe-area-bottom))',
        }}
      >
        <div className="flex justify-center pt-3 pb-1">
          <span className="h-1.25 w-10 rounded-full bg-border" />
        </div>
        {title ? (
          <div className="flex items-center justify-center border-b border-border px-4 py-2.5">
            <span className="text-base font-semibold text-muted"><EmojiText>{title}</EmojiText></span>
          </div>
        ) : null}
        <div className="px-2 pt-1 pb-1">
          <MenuRows onClose={onClose}>{children}</MenuRows>
        </div>
        <div className="border-t border-border px-2 pt-1 pb-1">
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-[48px] w-full items-center justify-center rounded-xl text-base font-medium text-muted active:bg-surface-tertiary"
          >
            Cancel
          </button>
        </div>
      </section>
    </>
  ), document.body);
}
