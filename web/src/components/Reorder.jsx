import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';

const Ctx = createContext(null);

const reduced = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const carries = (meta) => meta.carries || (meta.leader ? meta.group : null);

const THRESHOLD = 5;
const HOLD_MS = 600;
const EDGE = 48;
const SCROLL_RATE = 14;
const SETTLE_MS = 200;

export function Reorder({
  as: Tag = 'div', onDrop, onHold, canCombine, disabled = false, scroller,
  className, children, ref: outerRef, ...rest
}) {
  const root = useRef(null);
  const scroll = useRef(null);
  scroll.current = scroller?.current || null;
  const items = useRef(new Map());
  const say = useRef(null);
  const live = useRef(null);
  const api = useRef(null);
  api.current = { onDrop, onHold, canCombine, disabled };

  const setRoot = useCallback((node) => {
    root.current = node;
    if (typeof outerRef === 'function') outerRef(node);
    else if (outerRef) outerRef.current = node;
  }, [outerRef]);

  const ctx = useMemo(() => {
    const box = () => scroll.current || root.current;

    const snapshot = () => {
      const pane = box();
      const scrollTop = pane ? pane.scrollTop : 0;
      const rows = [];
      for (const [key, it] of items.current) {
        if (!it.el || !it.el.isConnected) continue;
        it.el.style.transform = '';
        rows.push({ key, meta: it.metaRef.current, el: it.el, t: 0 });
      }
      for (const r of rows) {
        const box = r.el.getBoundingClientRect();
        r.top = box.top + scrollTop;
        r.height = box.height;
        r.bottom = r.top + box.height;
        r.center = r.top + box.height / 2;
      }
      rows.sort((a, b) => a.top - b.top);
      return { rows, scrollTop };
    };

    const arrange = (rows, key) => {
      const src = rows.find((r) => r.key === key);
      if (!src) return null;
      const family = [src];
      const seen = new Set(family);
      for (let i = 0; i < family.length; i += 1) {
        const group = carries(family[i].meta);
        if (!group) continue;
        for (const r of rows) {
          if (seen.has(r) || r.meta.group !== group) continue;
          seen.add(r);
          family.push(r);
        }
      }
      const block = family.filter((r) => !family.some((o) => o !== r && o.el.contains(r.el)));
      const rest = rows.filter((r) => !family.includes(r));
      const top = Math.min(...block.map((b) => b.top));
      return { src, family, block, rest, top, home: rest.filter((r) => r.top < top).length };
    };

    const whole = (rest, gap, dir) => {
      while (gap > 0 && gap < rest.length && rest[gap].meta.carried) gap += dir < 0 ? -1 : 1;
      return gap;
    };

    const slotOf = (rows, rest, gap) => (
      gap >= rest.length ? rows.length : rows.indexOf(rest[gap])
    );

    const build = (d) => {
      const { rows, scrollTop } = snapshot();
      const parts = arrange(rows, d.key);
      if (!parts) return false;
      const { src, block, rest, top } = parts;
      const bottom = Math.max(...block.map((b) => b.bottom));
      const after = rest.find((r) => r.top >= bottom);
      const prev = [...rest].reverse().find((r) => r.bottom <= top);
      let gap = after ? after.top - bottom : prev ? top - prev.bottom : 0;
      if (!(gap >= 0) || gap > 28) gap = 4;
      const first = rows[0];
      const last = rows[rows.length - 1];
      const slack = Math.min(src.height, 40);
      Object.assign(d, {
        rows,
        rest,
        block,
        source: src.meta,
        top,
        bottom,
        centre: (top + bottom) / 2,
        step: (bottom - top) + gap,
        home: rest.filter((r) => r.top < top).length,
        min: first.top - slack - top,
        max: last.bottom + slack - bottom,
        scroll0: scrollTop,
        gap: rest.filter((r) => r.top < top).length,
        over: null,
      });
      for (const b of d.block) b.el.classList.add('is-lifted');
      return true;
    };

    const paint = () => {
      const d = live.current;
      if (!d || !d.on) return;
      const scrolled = (box()?.scrollTop ?? d.scroll0) - d.scroll0;
      const dy = Math.max(d.min, Math.min(d.max, (d.y - d.startY) + scrolled));
      d.dy = dy;
      const shift = `translate3d(0,${dy}px,0)`;
      for (const b of d.block) b.el.style.transform = shift;

      const centre = d.centre + dy;
      let over = null;
      const combines = api.current.canCombine;
      if (combines) {
        for (const r of d.rest) {
          const band = r.height * 0.3;
          if (centre > r.top + band && centre < r.bottom - band
            && combines(d.source, r.meta)) { over = r; break; }
        }
      }
      let slot = d.home;
      if (!over) {
        slot = 0;
        for (const r of d.rest) if (centre > r.center) slot += 1;
        slot = whole(d.rest, slot, slot - d.home);
      }
      d.over = over;
      d.gap = slot;

      for (let i = 0; i < d.rest.length; i += 1) {
        const r = d.rest[i];
        let t = 0;
        if (!over) {
          if (slot > d.home && i >= d.home && i < slot) t = -d.step;
          else if (slot < d.home && i >= slot && i < d.home) t = d.step;
        }
        if (r.t !== t) {
          r.t = t;
          r.el.style.transform = t ? `translate3d(0,${t}px,0)` : '';
        }
        r.el.classList.toggle('is-over', over === r);
      }

      const mark = over ? `on:${over.key}` : `gap:${slot}`;
      if (mark !== d.mark) {
        d.mark = mark;
        d.markAt = performance.now();
        d.held = false;
      }
    };

    const regeometry = (d) => {
      const dy = d.dy || 0;
      if (!build(d)) return;
      d.startY = d.y - dy;
      d.mark = null;
    };

    const tick = () => {
      const d = live.current;
      if (!d || !d.on) return;
      const pane = box();
      if (pane) {
        const bounds = pane.getBoundingClientRect();
        let speed = 0;
        if (d.y < bounds.top + EDGE) speed = -(1 - Math.max(0, d.y - bounds.top) / EDGE);
        else if (d.y > bounds.bottom - EDGE) {
          speed = 1 - Math.max(0, bounds.bottom - d.y) / EDGE;
        }
        if (speed) {
          const was = pane.scrollTop;
          pane.scrollTop = was + speed * SCROLL_RATE;
          if (pane.scrollTop !== was) paint();
        }
      }
      if (!d.held && d.mark && performance.now() - d.markAt > HOLD_MS) {
        d.held = true;
        const target = d.over ? d.over.meta : d.rest[d.gap - 1]?.meta;
        if (target && api.current.onHold) {
          api.current.onHold(target, d.source);
          requestAnimationFrame(() => {
            if (live.current === d && d.on) { regeometry(d); paint(); }
          });
        }
      }
      d.raf = requestAnimationFrame(tick);
    };

    const wipe = () => {
      for (const [, it] of items.current) {
        if (!it.el) continue;
        it.el.style.transform = '';
        it.el.classList.remove('is-lifted', 'is-settling', 'is-over');
      }
    };

    const slotIndex = (d) => slotOf(d.rows, d.rest, d.gap);

    const announce = (text) => {
      const el = say.current;
      if (!el) return;
      if (el.textContent === text) el.textContent = '';
      el.textContent = text;
    };

    let swallow = null;
    const unswallow = () => {
      if (!swallow) return;
      window.removeEventListener('click', swallow, true);
      swallow = null;
    };

    const detach = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
    };

    const finish = (commit) => {
      const d = live.current;
      if (!d) return;
      detach();
      if (!d.on) { live.current = null; return; }
      cancelAnimationFrame(d.raf);
      try { d.el.releasePointerCapture(d.pointerId); } catch { /* already gone */ }
      unswallow();
      swallow = (e) => { e.stopPropagation(); e.preventDefault(); unswallow(); };
      window.addEventListener('click', swallow, true);
      setTimeout(unswallow, 400);

      const done = () => {
        const el = root.current;
        el?.classList.add('is-committing');
        wipe();
        el?.classList.remove('is-dragging');
        live.current = null;
        if (commit) {
          flushSync(() => api.current.onDrop?.({
            source: d.source,
            entries: d.rows.map((r) => r.meta),
            index: slotIndex(d),
            over: d.over ? d.over.meta : null,
          }));
        }
        void el?.offsetHeight;
        el?.classList.remove('is-committing');
      };

      if (!commit || reduced()) { done(); return; }
      const rest = d.over ? 0
        : d.gap > d.home ? d.rest[d.gap - 1].bottom - d.bottom
          : d.gap < d.home ? d.rest[d.gap].top - d.top
            : 0;
      const lead = d.block[0].el;
      for (const b of d.block) {
        b.el.classList.add('is-settling');
        b.el.style.transform = `translate3d(0,${rest}px,0)`;
      }
      let fired = false;
      const end = (e) => {
        if (e && e.target !== lead) return;
        if (fired) return;
        fired = true;
        lead.removeEventListener('transitionend', end);
        done();
      };
      lead.addEventListener('transitionend', end);
      setTimeout(end, SETTLE_MS + 120);
    };

    const activate = () => {
      const d = live.current;
      if (!root.current) return;
      root.current.classList.add('is-dragging');
      d.startY = d.y;
      if (!build(d)) { root.current.classList.remove('is-dragging'); live.current = null; return; }
      d.on = true;
      try { d.el.setPointerCapture(d.pointerId); } catch { /* not capturable */ }
      paint();
      d.raf = requestAnimationFrame(tick);
    };

    function onMove(e) {
      const d = live.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.y = e.clientY;
      if (!d.on) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < THRESHOLD) return;
        activate();
        return;
      }
      e.preventDefault();
      paint();
    }
    function onUp(e) {
      const d = live.current;
      if (!d || e.pointerId !== d.pointerId) return;
      finish(true);
    }
    function onCancel(e) {
      const d = live.current;
      if (!d || e.pointerId !== d.pointerId) return;
      finish(false);
    }
    function onKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      finish(false);
    }

    return {
      register(key, el, metaRef) {
        if (el) items.current.set(key, { el, metaRef });
        else items.current.delete(key);
      },
      begin(key, e) {
        if (api.current.disabled) return;
        if (e.button !== 0 || e.pointerType === 'touch') return;
        if (live.current) finish(false);
        const it = items.current.get(key);
        if (!it?.el) return;
        live.current = {
          key,
          el: it.el,
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          y: e.clientY,
          on: false,
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
        window.addEventListener('pointercancel', onCancel, true);
        window.addEventListener('keydown', onKey, true);
      },
      stop() { if (live.current) finish(false); },
      nudge(key, dir) {
        if (api.current.disabled) return false;
        if (live.current) return false;
        const { rows } = snapshot();
        const parts = arrange(rows, key);
        if (!parts) return false;
        const { src, rest, home } = parts;
        const gap = whole(rest, home + dir, dir);
        const name = (src.el.textContent || '').trim() || 'Row';
        if (gap < 0 || gap > rest.length) {
          announce(`${name} is already ${dir < 0 ? 'first' : 'last'}.`);
          return false;
        }
        const held = document.activeElement;
        const inside = held && src.el.contains(held);
        flushSync(() => api.current.onDrop?.({
          source: src.meta,
          entries: rows.map((r) => r.meta),
          index: slotOf(rows, rest, gap),
          over: null,
        }));
        if (inside) {
          const again = held.isConnected ? held : (() => {
            const el = items.current.get(key)?.el;
            return el?.querySelector('a[href],button,[tabindex]:not([tabindex="-1"])') || el;
          })();
          again?.focus?.({ preventScroll: false });
        }
        announce(`${name} moved to ${gap + 1} of ${rest.length + 1}.`);
        return true;
      },
    };
  }, []);

  useEffect(() => () => ctx.stop(), [ctx]);

  return (
    <Ctx.Provider value={ctx}>
      <Tag {...rest} ref={setRoot} className={className}>{children}</Tag>
      <div ref={say} className="sr-only" role="status" aria-live="polite" />
    </Ctx.Provider>
  );
}

export function useReorderItem(meta) {
  const ctx = useContext(Ctx);
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const key = meta?.key || null;

  const ref = useCallback((node) => {
    if (!ctx || !key) return undefined;
    ctx.register(key, node, metaRef);
    return () => ctx.register(key, null, metaRef);
  }, [ctx, key]);

  const onPointerDown = useCallback((e) => {
    if (!ctx || !key) return;
    e.stopPropagation();
    ctx.begin(key, e);
  }, [ctx, key]);

  const onKeyDown = useCallback((e) => {
    if (!ctx || !key) return;
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const dir = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    ctx.nudge(key, dir);
  }, [ctx, key]);

  if (!ctx || !key) return { ref: undefined, dragProps: {} };
  if (meta.carried) return { ref, dragProps: { className: 'drag-item' } };
  return { ref, dragProps: { onPointerDown, onKeyDown, className: 'drag-item' } };
}
