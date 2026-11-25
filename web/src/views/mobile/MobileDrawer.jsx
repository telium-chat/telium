import { forwardRef, useLayoutEffect, useRef } from 'react';
import { cn } from '../../lib/cn.js';

/// A side drawer that stays mounted, so it animates out as well as in and keeps its
/// scroll position between openings. Position is driven by `--drawer-progress`
/// (0 closed … 1 open): React sets it from `open`, and useDrawerGestures sets it
/// directly while a finger is dragging.
export const MobileDrawer = forwardRef(function MobileDrawer({
  side = 'start',
  open,
  onClose,
  closeLabel,
  className,
  style,
  children,
}, ref) {
  const rootRef = useRef(null);
  const setRef = (el) => {
    rootRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  // Imperative on purpose: a drag may have left the variable anywhere in between, and
  // React would skip re-applying an unchanged style value.
  useLayoutEffect(() => {
    rootRef.current?.style.setProperty('--drawer-progress', open ? '1' : '0');
  }, [open]);

  return (
    <div ref={setRef} className="mobile-drawer" data-side={side} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-label={closeLabel}
        tabIndex={open ? 0 : -1}
        aria-hidden={open ? undefined : true}
        className="mobile-drawer-scrim"
        onClick={onClose}
      />
      <div
        data-drawer-panel
        inert={!open}
        aria-hidden={open ? undefined : true}
        className={cn('mobile-drawer-panel', className)}
        style={style}
      >
        {children}
      </div>
    </div>
  );
});
