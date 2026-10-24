import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../lib/cn.js';

const GLIDE_CLIP = 'inset(-12px -12px 0 -12px)';

export const reduced = () => typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

const StageGhost = createContext(false);
export const useIsStageGhost = () => useContext(StageGhost);

export function TextSwap({ k, dir = 1, as: Tag = 'span', className, children }) {
  const ref = useRef(null);
  const last = useRef(null);
  const [prev, setPrev] = useState(null);
  const [enterKey, setEnterKey] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const was = last.current;
    if (was && was.k !== k) {
      if (reduced()) {
        setPrev(null);
      } else {
        setPrev({ k: was.k, node: was.node });
        setEnterKey(k);
        const to = { h: el.offsetHeight, w: el.offsetWidth };
        const from = {};
        const end = {};
        if (was.h !== to.h) {
          from.height = `${was.h}px`;
          end.height = `${to.h}px`;
        }
        if (was.w !== to.w) {
          from.width = `${was.w}px`;
          end.width = `${to.w}px`;
        }
        if (Object.keys(end).length) {
          el.style.clipPath = end.width ? 'inset(-8px 0 0 0)' : GLIDE_CLIP;
          const a = el.animate([from, end], {
            duration: 260,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          });
          a.onfinish = () => { el.style.clipPath = ''; };
          a.oncancel = a.onfinish;
        }
      }
    }
    last.current = { k, node: children, h: el.offsetHeight, w: el.offsetWidth };
  });

  return (
    <Tag ref={ref} className={cn('swap', className)} style={{ '--swap-dir': dir }}>
      <span key={k} className="swap__cur" data-enter={enterKey === k || undefined}>
        {children}
      </span>
      {prev ? (
        <span
          key={`prev:${prev.k}`}
          className="swap__prev"
          aria-hidden="true"
          onAnimationEnd={() => setPrev(null)}
        >
          {prev.node}
        </span>
      ) : null}
    </Tag>
  );
}

const GLIDE_MS = 220;
const GLIDE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export function StageSwap({ k, dir = 1, className, children }) {
  const ref = useRef(null);
  const curRef = useRef(null);
  const glide = useRef(null);
  const last = useRef(null);
  const [cur, setCur] = useState(k);
  const [prev, setPrev] = useState(null);
  const [enter, setEnter] = useState(null);
  const [gliding, setGliding] = useState(false);
  const [landing, setLanding] = useState(null);

  if (cur !== k) {
    setCur(k);
    const was = last.current;
    const active = document.activeElement;
    const held = active instanceof HTMLElement && ref.current?.contains(active);
    if (held) active.blur();
    setLanding(held ? k : null);
    const ghost = was && !reduced() ? { k: was.k, node: was.node, dir } : null;
    setPrev(ghost);
    setEnter(ghost ? k : null);
  }

  const measure = () => curRef.current?.getBoundingClientRect().height ?? 0;

  const glideTo = (from, to, duration = GLIDE_MS) => {
    const el = ref.current;
    if (!el || Math.abs(from - to) < 0.5) return;
    glide.current?.cancel();
    el.style.clipPath = GLIDE_CLIP;
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration,
      easing: GLIDE_EASE,
      fill: 'backwards',
    });
    a.to = to;
    const done = () => {
      if (glide.current !== a) return;
      glide.current = null;
      el.style.clipPath = '';
      setGliding(false);
    };
    a.onfinish = done;
    a.oncancel = done;
    glide.current = a;
    setGliding(true);
  };

  useLayoutEffect(() => {
    const was = last.current;
    const to = measure();
    if (was && was.k !== k && !reduced()) glideTo(was.h, to);
    last.current = { k, node: children, h: to };
  });

  useEffect(() => {
    const el = curRef.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => {
      const h = measure();
      if (last.current) last.current.h = h;
      const a = glide.current;
      if (!a || a.playState !== 'running' || Math.abs(h - (a.to ?? h)) < 0.5) return;
      const now = ref.current?.getBoundingClientRect().height ?? h;
      glideTo(now, h, Math.max(120, GLIDE_MS - (a.currentTime ?? 0)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cur]);

  useEffect(() => {
    if (landing !== cur) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    curRef.current?.focus({ preventScroll: true });
  }, [landing, cur]);

  useEffect(() => {
    if (enter == null) return undefined;
    const id = setTimeout(() => { setPrev(null); setEnter(null); }, 600);
    return () => clearTimeout(id);
  }, [enter]);

  const swapping = prev != null || enter === k || gliding;

  return (
    <div
      ref={ref}
      className={cn('stage', className)}
      data-swapping={swapping || undefined}
      style={{ '--swap-dir': prev?.dir ?? dir }}
    >
      {prev ? (
        <div
          key={prev.k}
          className="stage__prev"
          inert
          aria-hidden="true"
          onAnimationEnd={(e) => { if (e.target === e.currentTarget) setPrev(null); }}
        >
          <StageGhost.Provider value>{prev.node}</StageGhost.Provider>
        </div>
      ) : null}
      <div
        key={k}
        ref={curRef}
        className="stage__cur"
        tabIndex={-1}
        data-enter={enter === k || undefined}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setEnter((x) => (x === k ? null : x));
        }}
      >
        {children}
      </div>
    </div>
  );
}

export const isStagePlaceholder = (el) => Boolean(el && el.classList?.contains('stage__cur'));

export function nudge(el) {
  if (!el || typeof el.animate !== 'function' || reduced()) return;
  el.animate(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(-2px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
  );
}
