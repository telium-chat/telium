import { useId, useRef } from 'react';
import { useSheetDrag } from '../../hooks/useSheetDrag.js';
import { useMobileBackDismiss } from '../../hooks/useMobileBackDismiss.js';
import { ProfileBody } from '../profile/ProfileBody.jsx';

export function MobileProfileSheet({ userId, guildId, close, zIndex = 50 }) {
  const scrimRef = useRef(null);
  const { sheetRef, dismiss } = useSheetDrag(close, { scrimRef });
  useMobileBackDismiss(dismiss);
  const nameId = useId();

  return (
    <>
      <button
        ref={scrimRef}
        type="button"
        aria-label="Close profile"
        className="fixed inset-0 bg-black/60 backdrop-blur-xs animate-fade-in"
        style={{ zIndex: zIndex - 1 }}
        onClick={dismiss}
      />
      <section
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={nameId}
        data-mobile-gesture-lock
        className="pc-sheet mobile-bottom-sheet fixed inset-x-0 bottom-0 rounded-t-3xl animate-sheet-in"
        style={{ zIndex }}
      >
        <span className="pc-sheet__grip" aria-hidden="true" />
        <ProfileBody
          guildId={guildId}
          userId={userId}
          close={close}
          surface="sheet"
          nameId={nameId}
        />
      </section>
    </>
  );
}
