import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { LAYER, useModal } from '../../hooks/useModal.jsx';
import { OpenProfileContext, ProfileCardContext } from '../../hooks/useProfileCard.js';
import { useOptionalStore } from '../../hooks/useStore.jsx';
import { checkIsMobile } from '../../lib/platform.js';
import { MobileProfileSheet } from '../mobile/MobileProfileSheet.jsx';
import { ProfileBody } from './ProfileBody.jsx';

let nextCard = 1;

const WARM_DWELL_MS = 120;

const MUTUAL_DWELL_MS = 450;

export function ProfileCardProvider({ children }) {
  const modal = useModal();
  const store = useOptionalStore();
  const [card, setCard] = useState(null);
  const pointer = useRef({ x: 0, y: 0 });
  const depth = useRef(0);
  depth.current = modal.depth;
  const trigger = useRef(null);

  useEffect(() => {
    const track = (e) => { pointer.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener('pointerdown', track, true);
    return () => document.removeEventListener('pointerdown', track, true);
  }, []);

  const open = useCallback((userId, { guildId = null, anchor = null, source = null } = {}) => {
    if (!userId) return;
    trigger.current = anchor || null;
    if (checkIsMobile()) {
      setCard({
        key: nextCard++,
        userId,
        guildId,
        source,
        mobile: true,
        layer: LAYER(depth.current) + 5,
      });
      return;
    }
    const box = anchor?.getBoundingClientRect?.();
    const at = box && box.width
      ? { left: box.left, top: box.top, width: box.width, height: box.height }
      : { left: pointer.current.x, top: pointer.current.y, width: 0, height: 0 };
    setCard({
      key: nextCard++,
      userId,
      guildId,
      source,
      at,
      layer: LAYER(depth.current) - 1,
      modalDepth: depth.current,
    });
  }, [modal]);

  const warming = useRef({ profile: 0, mutuals: 0, userId: null });

  const cancel = useCallback(() => {
    clearTimeout(warming.current.profile);
    clearTimeout(warming.current.mutuals);
    warming.current.userId = null;
  }, []);

  const prefetch = useCallback((userId) => {
    if (!userId || !store) return;
    if (warming.current.userId === userId) return;
    cancel();
    warming.current.userId = userId;
    warming.current.profile = setTimeout(() => {
      store.ensureFullProfile?.(userId);
    }, WARM_DWELL_MS);
    warming.current.mutuals = setTimeout(() => {
      store.ensureMutuals?.(userId, { trigger: 'hover' });
    }, MUTUAL_DWELL_MS);
  }, [store, cancel]);

  useEffect(() => cancel, [cancel]);

  const close = useCallback(() => {
    setCard((current) => (current && !current.mobile ? { ...current, open: false } : null));
  }, []);

  useEffect(() => {
    if (!card || card.mobile) return undefined;
    const key = card.key;
    const openedAtDepth = card.modalDepth ?? 0;

    const dismissOnOutsidePress = (event) => {
      if (modal.depth > openedAtDepth) return;
      const target = event.target;
      if (!(target instanceof Element)) {
        setCard((current) => (current?.key === key ? { ...current, open: false } : current));
        return;
      }
      if (target.closest('[data-profile-card-popover]')) return;
      if (trigger.current?.contains?.(target)) return;
      if (target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      setCard((current) => (
        current?.key === key ? { ...current, open: false } : current
      ));
    };

    document.addEventListener('pointerdown', dismissOnOutsidePress, true);
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePress, true);
  }, [card, modal.depth]);

  const value = useMemo(
    () => ({ open, close, prefetch, cancel }),
    [open, close, prefetch, cancel],
  );

  const showing = useMemo(() => (card && card.open !== false
    ? { userId: card.userId, guildId: card.guildId, source: card.source ?? null }
    : null), [card]);

  const anchor = useMemo(() => {
    const at = card?.at;
    if (!at) return null;
    const rect = {
      x: at.left, y: at.top, width: at.width, height: at.height,
      left: at.left, top: at.top, right: at.left + at.width, bottom: at.top + at.height,
    };
    return { getBoundingClientRect: () => rect };
  }, [card?.at]);

  return (
    <ProfileCardContext.Provider value={value}>
      <OpenProfileContext.Provider value={showing}>
        {children}
      </OpenProfileContext.Provider>
      {card?.mobile ? (
        <MobileProfileSheet
          userId={card.userId}
          guildId={card.guildId}
          zIndex={card.layer}
          close={() => setCard(null)}
        />
      ) : card ? (
        <Popover.Root
          key={card.key}
          open={card.open !== false}
          onOpenChange={(next, details) => {
            const pressTarget = details?.event?.target;
            if (!next
              && details?.reason === 'outside-press'
              && pressTarget instanceof Element
              && trigger.current?.contains?.(pressTarget)) {
              details.cancel();
              return;
            }
            if (!next) {
              setCard((current) => (
                current?.key === card.key ? { ...current, open: false } : current
              ));
            }
          }}
          onOpenChangeComplete={(next) => {
            if (!next) {
              setCard((current) => (current?.key === card.key ? null : current));
            }
          }}
          modal={false}
        >
          <Popover.Portal>
            <Popover.Positioner
              anchor={anchor}
              positionMethod="fixed"
              side="inline-end"
              align="start"
              sideOffset={10}
              collisionPadding={12}
              className="popover"
              style={{ zIndex: card.layer }}
            >
              <Popover.Popup
                aria-label="Profile"
                data-profile-card-popover=""
                className="popup popup--card pc-popup"
              >
                <ProfileBody
                  guildId={card.guildId}
                  userId={card.userId}
                  close={() => setCard((current) => (
                    current?.key === card.key ? { ...current, open: false } : current
                  ))}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
    </ProfileCardContext.Provider>
  );
}
