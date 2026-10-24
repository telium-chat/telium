import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Avatar, EmojiText, ModalShell } from '../components/index.js';
import { faceOf } from '../lib/faces.js';
import { remoteMediaOrigin } from '../lib/media.js';
import { shortName } from '../lib/util.js';

function personOf(store, row) {
  const face = faceOf(store, row.user_id);
  return {
    user_id: row.user_id,
    name: row.display_name || face?.name || shortName(row.user_id),
    avatar_ref: row.avatar_ref || face?.avatarRef || null,
    base: face?.base || store.home?.base,
    mediaOrigin: face?.mediaOrigin || remoteMediaOrigin(row.user_id, store.home?.domain),
  };
}

function curve(a, b) {
  const mid = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`;
}

function Face({ person, size }) {
  return (
    <Avatar
      id={person.user_id}
      name={person.name}
      size={size}
      mediaRef={person.avatar_ref}
      base={person.base}
      mediaOrigin={person.mediaOrigin}
    />
  );
}

function Anchor({ person, label, anchorRef, side }) {
  return (
    <div className={`mfg__anchor mfg__anchor--${side}`}>
      <div ref={anchorRef} className="mfg__anchor-face">
        <Face person={person} size="lg" />
      </div>
      <span className="mfg__name">
        <EmojiText>{label}</EmojiText>
      </span>
    </div>
  );
}

export function MutualFriendGraphDialog({
  close,
  store,
  target,
  mutuals,
  onOpenPerson = null,
}) {
  const me = useMemo(() => personOf(store, { user_id: store.me?.user_id }), [store]);
  const them = useMemo(() => personOf(store, target), [store, target]);
  const people = useMemo(() => {
    const seen = new Set([me.user_id, them.user_id]);
    const out = [];
    for (const row of mutuals || []) {
      if (!row?.user_id || seen.has(row.user_id)) continue;
      seen.add(row.user_id);
      out.push(personOf(store, row));
    }
    return out;
  }, [store, mutuals, me.user_id, them.user_id]);

  const [lit, setLit] = useState(null);
  const [lines, setLines] = useState({ width: 0, height: 0, paths: [] });
  const scroller = useRef(null);
  const canvas = useRef(null);
  const left = useRef(null);
  const right = useRef(null);
  const faces = useRef(new Map());

  const measure = useCallback(() => {
    const box = canvas.current?.getBoundingClientRect();
    const a = left.current?.getBoundingClientRect();
    const b = right.current?.getBoundingClientRect();
    if (!box || !a || !b) return;
    const edge = (r, side) => ({
      x: (side === 'start' ? r.left : r.right) - box.left,
      y: r.top + r.height / 2 - box.top,
    });
    const leftIsFirst = a.left < b.left;
    const [west, east] = leftIsFirst ? [a, b] : [b, a];
    const paths = [];
    for (const person of people) {
      const el = faces.current.get(person.user_id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      paths.push({
        id: person.user_id,
        d: `${curve(edge(west, 'end'), edge(r, 'start'))} ${curve(edge(r, 'end'), edge(east, 'start'))}`,
      });
    }
    setLines({ width: box.width, height: box.height, paths });
  }, [people]);

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (canvas.current) observer.observe(canvas.current);
    if (scroller.current) observer.observe(scroller.current);
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const el = scroller.current;
    el?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      el?.removeEventListener('scroll', onScroll);
    };
  }, [measure]);

  const open = (userId) => {
    close();
    onOpenPerson?.(userId);
  };

  return (
    <ModalShell
      title={(
        <>
          Mutual friends
          <span className="ms-2 font-normal text-muted tnum">{people.length}</span>
        </>
      )}
      bodyClassName="p-0 gap-0 overflow-hidden"
    >
      <div ref={scroller} className="mfg" data-mobile-scroll>
        <div ref={canvas} className="mfg__canvas">
          <svg
            aria-hidden="true"
            className="mfg__lines"
            width={lines.width}
            height={lines.height}
            viewBox={`0 0 ${lines.width || 1} ${lines.height || 1}`}
          >
            {[...lines.paths.filter((p) => p.id !== lit), ...lines.paths.filter((p) => p.id === lit)]
              .map((path) => (
                <path key={path.id} d={path.d} className={cn('mfg__line', lit === path.id && 'is-lit')} />
              ))}
          </svg>

          <Anchor person={me} label="You" anchorRef={left} side="start" />

          <ul className="mfg__people">
            {people.map((person) => (
              <li key={person.user_id}>
                <button
                  type="button"
                  className="mfg__person"
                  aria-label={`Open ${person.name}’s profile`}
                  onPointerEnter={() => setLit(person.user_id)}
                  onPointerLeave={() => setLit(null)}
                  onFocus={() => setLit(person.user_id)}
                  onBlur={() => setLit(null)}
                  onClick={() => open(person.user_id)}
                >
                  <span
                    className="mfg__person-face"
                    ref={(el) => {
                      if (el) faces.current.set(person.user_id, el);
                      else faces.current.delete(person.user_id);
                    }}
                  >
                    <Face person={person} size="chat" />
                  </span>
                  <span className="mfg__name">
                    <EmojiText>{person.name}</EmojiText>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <Anchor person={them} label={them.name} anchorRef={right} side="end" />
        </div>
      </div>
    </ModalShell>
  );
}
