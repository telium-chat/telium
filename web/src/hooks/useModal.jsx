import { Component, useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@cloudflare/kumo/primitives/dialog';
import { cn } from '../lib/cn.js';
import { isMobileTauri } from '../lib/platform.js';
import { BackDepthContext, backLevel, useMobileBackDismiss } from './useMobileBackDismiss.js';
import { useSheetDrag } from './useSheetDrag.js';

import { ModalContext, useModal } from './modalContext.js';

export { useModal };

let nextId = 1;

function returnTarget() {
  if (typeof document === 'undefined') return undefined;
  const opener = document.activeElement;
  if (!opener || opener === document.body) return undefined;
  return { get current() { return opener.isConnected ? opener : null; } };
}

export const LAYER = (depth) => 50 + depth * 10;

class ModalBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('Telium modal render error:', error, info);
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ModalProvider({ children }) {
  const [stack, setStack] = useState([]);

  const close = useCallback((id) => {
    setStack((s) => {
      if (!s.length) return s;
      const target = id ?? s[s.length - 1].id;
      return s.map((modal) => (
        modal.id === target ? { ...modal, open: false } : modal
      ));
    });
  }, []);

  const remove = useCallback((id) => {
    setStack((s) => s.filter((modal) => modal.id !== id));
  }, []);

  const open = useCallback((render, {
    wide = false,
    fullscreen = false,
    bare = false,
    backdrop = 'opaque',
    place = 'center',
    desktopSize = wide ? 'wide' : 'default',
    // On phones, a bottom sheet (swipe down to close) instead of a full-screen page.
    mobileSheet = false,
  } = {}) => {
    const id = nextId++;
    setStack((s) => [...s, {
      id,
      render,
      wide,
      fullscreen,
      bare,
      backdrop,
      place,
      desktopSize,
      mobileSheet,
      open: true,
      returnTo: returnTarget(),
    }]);
    return () => close(id);
  }, [close]);

  const value = useMemo(
    () => ({ open, close, remove, stack, depth: stack.length }),
    [open, close, remove, stack],
  );

  useEffect(() => {
    if (!stack.length) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stack.length, close]);


  return <ModalContext.Provider value={value}>{children}</ModalContext.Provider>;
}

export function ModalHost() {
  const { stack, close, remove } = useModal();
  return (
    <>
      {stack.map((modal, at) => {
        const phone = isMobileTauri || (typeof window !== 'undefined' && window.innerWidth <= 768);
        const sheet = phone && modal.mobileSheet && !modal.fullscreen;
        const fullscreen = !sheet && (modal.fullscreen || (phone && modal.wide));
        return (
        <Dialog.Root
          key={modal.id}
          open={modal.open !== false}
          onOpenChange={(next) => { if (!next) close(modal.id); }}
          onOpenChangeComplete={(next) => { if (!next) remove(modal.id); }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop
              className={cn(
                'modal__backdrop fixed inset-0 backdrop-fade',
                modal.backdrop === 'transparent' ? 'bg-black/35' : 'bg-black/45',
              )}
              style={{ zIndex: LAYER(at) }}
            />
            <ModalPopup
              sheet={sheet}
              onSheetClose={() => close(modal.id)}
              className={cn(
                'fixed flex flex-col overflow-hidden bg-surface text-foreground outline-none',
                sheet ? 'mobile-modal-sheet inset-x-0 bottom-0 w-full rounded-t-3xl' : 'inset-0 m-auto',
                sheet ? null : fullscreen
                  ? 'mobile-fullscreen-dialog h-dvh w-full max-h-none rounded-none border-0'
                  : cn(
                    'h-fit max-h-[var(--modal-max-h,86dvh)] w-[calc(100vw-2rem)] rounded-card',
                    'shadow-[0_0_0_1px_var(--border),0_24px_64px_-24px_rgb(0_0_0/0.45)]',
                    modal.desktopSize === 'emoji'
                      ? 'max-w-[480px]'
                      : modal.desktopSize === 'switcher'
                        ? 'max-w-[560px]'
                        : modal.wide ? 'max-w-3xl' : 'max-w-[440px]',
                    modal.place === 'top' && 'modal--top',
                  ),
                fullscreen || sheet ? 'sheet-in' : 'overlay-in',
                modal.bare && 'p-0',
                modal.backdrop === 'transparent' && 'bg-transparent shadow-none',
              )}
              style={{ zIndex: LAYER(at) + 1 }}
              finalFocus={modal.returnTo}
            >
              <ModalBoundary onError={() => close(modal.id)}>
                <BackDepthContext.Provider value={at + 1}>
                  <ModalBack depth={at + 1} onBack={() => close(modal.id)} />
                  {modal.render(() => close(modal.id))}
                </BackDepthContext.Provider>
              </ModalBoundary>
            </ModalPopup>
          </Dialog.Portal>
        </Dialog.Root>
        );
      })}
    </>
  );
}

/// Dialog.Popup, or on phones a bottom sheet that follows a downward drag.
function ModalPopup({ sheet, onSheetClose, children, ...props }) {
  if (!sheet) return <Dialog.Popup {...props}>{children}</Dialog.Popup>;
  return <SheetPopup onClose={onSheetClose} {...props}>{children}</SheetPopup>;
}

function SheetPopup({ onClose, children, ...props }) {
  const { sheetRef } = useSheetDrag(onClose);
  return (
    <Dialog.Popup ref={sheetRef} {...props}>
      <span className="mobile-modal-sheet__grip" aria-hidden="true" />
      {children}
    </Dialog.Popup>
  );
}

/// Android Back for one modal of the stack, below whatever that modal shows.
function ModalBack({ depth, onBack }) {
  useMobileBackDismiss(onBack, { level: backLevel.modal(depth) });
  return null;
}
