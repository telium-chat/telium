import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredBox, useDismiss } from '../../hooks/useAnchoredPopover.js';
import { EmptyState, SearchField } from '../../components/index.js';

export const PANEL_WIDTH = 420;
const EDGE = 12;

const ROW = '[data-panel-row]';

function walk(e, panel) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...panel.querySelectorAll(ROW)];
  if (!rows.length) return;
  const field = panel.querySelector('input[type="search"]');
  const at = rows.indexOf(document.activeElement);
  e.preventDefault();
  if (e.key === 'ArrowDown') {
    rows[Math.min(at + 1, rows.length - 1)].focus();
  } else if (at > 0) {
    rows[at - 1].focus();
  } else if (field) {
    field.focus();
  }
}

export function PanelEmpty({ icon, children }) {
  return <EmptyState icon={icon}>{children}</EmptyState>;
}

export function PanelSkeleton({ label }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="panel-skeleton flex flex-col gap-2">
      {['38%', '26%'].map((name, i) => (
        <div key={name} aria-hidden="true" className="panel-skeleton__card flex gap-3 px-3 py-2.5">
          <span className="panel-skeleton__shape size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex h-[calc(var(--text-sm)*1.55)] items-center">
              <span className="panel-skeleton__shape h-2.5 rounded-full" style={{ width: name }} />
            </div>
            <div className="flex h-[calc(var(--text-base)*1.55)] items-center mt-0.5">
              <span className="panel-skeleton__shape h-2.5 rounded-full" style={{ width: i ? '54%' : '78%' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HeaderPanel({
  anchor, close, label, icon: Icon, title, search = null, action = null, empty = null, watch = [], children,
}) {
  const panel = useRef(null);
  const body = useRef(null);
  const inner = useRef(null);
  const entered = useRef(false);
  const [scrolls, setScrolls] = useState(false);

  const box = useAnchoredBox(anchor, (r) => ({
    top: r.bottom + 6,
    right: Math.min(
      Math.max(window.innerWidth - r.right, EDGE),
      Math.max(window.innerWidth - PANEL_WIDTH - EDGE, EDGE),
    ),
    maxHeight: Math.max(220, window.innerHeight - r.bottom - 24),
  }));

  useEffect(() => {
    const outer = body.current;
    const content = inner.current;
    if (!outer || !content) return undefined;
    let frame = 0;
    let last = -1;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = content.scrollHeight;
        if (height !== last) { last = height; settle(); return; }
        setScrolls(height > outer.clientHeight + 1);
      });
    };
    const observer = new ResizeObserver(settle);
    observer.observe(outer);
    observer.observe(content);
    settle();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box !== null, ...watch]);

  useDismiss(close, { within: panel, anchor });

  useEffect(() => {
    if (!box) return undefined;
    const el = panel.current;
    if (!el) return undefined;
    if (!entered.current) {
      entered.current = true;
      const field = el.querySelector('input[type="search"]');
      (field || el).focus({ preventScroll: true });
    }
    return () => {
      const active = el.ownerDocument.activeElement;
      const stranded = !active || active === el.ownerDocument.body || el.contains(active);
      if (stranded) anchor?.focus?.({ preventScroll: true });
    };
  }, [box, anchor]);

  if (!box) return null;

  return createPortal((
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className="popup header-panel"
      onKeyDown={(e) => walk(e, panel.current)}
      style={{ top: box.top, right: box.right, maxHeight: box.maxHeight }}
    >
      <header className="header-panel__head">
        {Icon ? <Icon className="size-4 shrink-0 text-muted" /> : null}
        <span className="header-panel__title">{title}</span>
        {search ? (
          <>
            <span className="header-panel__divider" aria-hidden="true" />
            <SearchField
              size="sm"
              className="header-panel__search"
              label={search.label || `Search ${String(title).toLowerCase()}`}
              placeholder={search.placeholder}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              onClear={() => search.onChange('')}
            />
          </>
        ) : null}
        {action ? <span className="header-panel__action">{action}</span> : null}
      </header>
      <div className="header-panel__body" ref={body} data-scroll={scrolls ? 'on' : undefined}>
        <div ref={inner}>
          {empty ? <PanelEmpty icon={Icon}>{empty}</PanelEmpty> : children}
        </div>
      </div>
    </div>
  ), document.body);
}
