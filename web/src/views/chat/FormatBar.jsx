import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FORMATS, formatEdit } from './formatting.js';
import { Tooltip } from '../../components/Tooltip.jsx';
import { useT } from '../../lib/i18n/react.jsx';

const BAR_ORDER = ['bold', 'italic', 'strike', 'code', 'spoiler', 'block', 'quote'];
const BAR_FORMATS = BAR_ORDER.map((id) => FORMATS.find((f) => f.id === id));
if (BAR_FORMATS.some((f) => !f)) {
  throw new Error('views/chat/FormatBar: BAR_ORDER must name every format once');
}

const GAP = 4;
const TILE = 28;
const PAD = 4;
const SEPARATOR = GAP + 1 + GAP;
const ABOVE = 8;
const EDGE = 8;

function anchorRect(node, from) {
  const view = node.ownerDocument?.defaultView || window;
  if (!view) return null;

  let mirror = null;
  try {
    mirror = document.createElement('div');
    mirror.className = 'format-bar-mirror';
    const style = view.getComputedStyle(node);
    for (const prop of MIRROR_PROPS) mirror.style[prop] = style.getPropertyValue(prop);
    const box = node.getBoundingClientRect();
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    mirror.style.position = 'fixed';
    mirror.style.top = `${box.top + borderTop}px`;
    mirror.style.left = `${box.left + borderLeft}px`;
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.wordBreak = 'normal';
    mirror.style.overflowY = 'hidden';
    mirror.style.boxSizing = 'border-box';
    mirror.style.width = `${node.clientWidth}px`;
    mirror.textContent = node.value.slice(0, Math.max(0, from));
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const at = marker.getBoundingClientRect();
    if (!at || (at.height === 0 && at.top === 0 && at.left === 0)) return null;
    const top = at.top - node.scrollTop;
    const left = at.left - node.scrollLeft;
    const lineHeight = parseFloat(style.lineHeight) || at.height;
    return { left, top, width: at.width, height: at.height, lineHeight };
  } catch {
    // No usable position.
  } finally {
    mirror?.remove();
  }
  return null;
}

const MIRROR_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'word-spacing', 'line-height', 'padding-top', 'padding-right', 'padding-bottom',
  'padding-left', 'text-indent', 'tab-size', 'direction', 'writing-mode',
];

export function FormatBar({ textareaRef, apply }) {
  const t = useT();
  const [rect, setRect] = useState(null);
  const barRef = useRef(null);

  const measure = useCallback(() => {
    const node = textareaRef.current;
    const view = node?.ownerDocument?.defaultView || window;
    const next = (() => {
      if (!node || node !== document.activeElement) return null;
      const from = node.selectionStart;
      const to = node.selectionEnd;
      if (from == null || to == null || from === to) return null;
      const anchor = anchorRect(node, from);
      if (!anchor) return null;
      const width = (BAR_FORMATS.length - 1) * (TILE + GAP) + SEPARATOR + TILE + PAD * 2;
      const height = TILE + PAD * 2;
      const left = Math.max(EDGE, Math.min(anchor.left - width / 2, view.innerWidth - width - EDGE));
      const foot = anchor.top - ABOVE;
      if (foot - height >= EDGE) return { left, top: foot, side: 'above' };
      return { left, top: anchor.top + anchor.lineHeight + ABOVE, side: 'below' };
    })();
    setRect((prev) => {
      if (prev === null && next === null) return prev;
      if (prev && next && prev.left === next.left && prev.top === next.top
        && prev.side === next.side) return prev;
      return next;
    });
  }, [textareaRef]);

  const dragging = useRef(false);

  useEffect(() => {
    const onSelect = () => {
      if (dragging.current) return;
      measure();
    };
    const onDown = (e) => {
      dragging.current = true;
      if (e.target === textareaRef.current) setRect(null);
    };
    const onUp = () => {
      const wasDragging = dragging.current;
      dragging.current = false;
      if (wasDragging) measure();
    };
    const onBlur = (e) => {
      if (barRef.current?.contains(e.relatedTarget)) return;
      setRect(null);
    };
    document.addEventListener('selectionchange', onSelect);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('touchend', onUp);
    const onFocusOut = (e) => {
      if (e.target !== textareaRef.current) return;
      dragging.current = false;
      onBlur(e);
    };
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('selectionchange', onSelect);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [textareaRef, measure]);

  useEffect(() => {
    if (!rect) return undefined;
    const onMove = () => {
      if (dragging.current) return;
      measure();
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [rect, measure]);

  useLayoutEffect(() => {
    if (rect) measure();
  });

  const press = useCallback((format) => {
    const node = textareaRef.current;
    if (!node) return;
    const from = node.selectionStart;
    const to = node.selectionEnd;
    if (from == null || to == null || from === to) { setRect(null); return; }
    const edit = formatEdit(format, node.value, from, to);
    apply(edit);
    requestAnimationFrame(measure);
  }, [textareaRef, apply, measure]);

  if (!rect) return null;

  return createPortal(
    <div
      ref={barRef}
      data-side={rect.side}
      className="popup format-bar"
      role="toolbar"
      aria-label={t('chat.format.bar')}
      style={{ position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px` }}
    >
      {BAR_FORMATS.map((format, i) => {
        const Icon = format.icon;
        const label = t(format.labelKey);
        return (
          <span key={format.id} className="contents">
            {i === 5 ? <span className="menu-separator format-bar-sep" aria-hidden="true" /> : null}
            <Tooltip label={label} side="top">
              <button
                type="button"
                className="popup-icon-button size-7"
                title={label}
                aria-label={label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => press(format)}
              >
                <Icon className="size-4" />
              </button>
            </Tooltip>
          </span>
        );
      })}
    </div>,
    document.body,
  );
}
