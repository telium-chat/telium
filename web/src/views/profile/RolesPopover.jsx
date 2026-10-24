import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, EmojiText, SearchIcon } from '../../components/index.js';
import { useAnchoredBox, useDismiss } from '../../hooks/useAnchoredPopover.js';
import { colourOf } from '../../lib/util.js';
import { outranks } from '../../lib/perms.js';

const PICKER_WIDTH = 236;
const PICKER_EDGE = 12;

function durationMs(el, token) {
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith('ms') ? n : n * 1000;
}

export function RolesPopover({ store, guildId, anchor, held, busy, onToggle, close, leaving, onLeft }) {
  const panel = useRef(null);
  const search = useRef(null);
  const [query, setQuery] = useState('');
  const me = store.myMember(guildId);

  const box = useAnchoredBox(anchor, (r) => {
    const left = Math.min(
      Math.max(r.left, PICKER_EDGE),
      Math.max(window.innerWidth - PICKER_WIDTH - PICKER_EDGE, PICKER_EDGE),
    );
    const below = window.innerHeight - r.bottom - 16;
    const above = r.top - 16;
    const drops = below >= 220 || below >= above;
    const origin = `${Math.round(r.left + r.width / 2 - left)}px ${drops ? '0' : '100%'}`;
    return drops
      ? { left, top: r.bottom + 6, maxHeight: Math.max(160, below), origin }
      : { left, bottom: window.innerHeight - r.top + 6, maxHeight: Math.max(160, above), origin };
  });

  useDismiss(close, { within: panel, anchor });

  useEffect(() => { if (box && !leaving) search.current?.focus(); }, [box, leaving]);

  useEffect(() => {
    if (!leaving) return;
    const active = document.activeElement;
    const stranded = !active
      || active === document.body
      || (panel.current?.contains(active) ?? false);
    if (stranded) anchor?.focus?.({ preventScroll: true });
  }, [leaving, anchor]);

  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!box || entered) return undefined;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [box, entered]);

  useEffect(() => {
    const el = panel.current;
    if (!leaving || !el) return undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      onLeft();
    };
    const onEnd = (e) => { if (e.target === el) finish(); };
    el.addEventListener('transitionend', onEnd);
    const timer = setTimeout(finish, durationMs(el, '--dur-1') + 40);
    return () => {
      el.removeEventListener('transitionend', onEnd);
      clearTimeout(timer);
    };
  }, [leaving, onLeft]);

  const needle = query.trim().toLowerCase();
  const all = store.roleList(guildId).filter((r) => r.id !== guildId && !r.managed);
  const shown = needle ? all.filter((r) => r.name.toLowerCase().includes(needle)) : all;

  if (!box) return null;

  return createPortal((
    <div
      ref={panel}
      role="dialog"
      aria-label="Add a role"
      className="popup pc-rolepop"
      data-starting-style={entered ? undefined : ''}
      data-ending-style={leaving ? '' : undefined}
      style={{
        left: box.left,
        top: box.top,
        bottom: box.bottom,
        maxHeight: box.maxHeight,
        '--transform-origin': box.origin,
      }}
    >
      <div className="pc-rolepop__search">
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <input
          ref={search}
          type="text"
          value={query}
          aria-label="Search roles"
          placeholder="Search roles"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pc-rolepop__list">
        {shown.length ? shown.map((role) => {
          const on = held.includes(role.id);
          const colour = colourOf(role.color);
          const allowed = outranks(me, role.position);
          return (
            <button
              key={role.id}
              type="button"
              role="switch"
              aria-checked={on}
              className="pc-rolepop__row"
              disabled={!allowed || busy === role.id}
              title={allowed ? role.name : `${role.name} is above your own highest role`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                onToggle(role.id, !on);
              }}
              onClick={(e) => { if (e.detail === 0) onToggle(role.id, !on); }}
            >
              <span
                aria-hidden="true"
                className={colour ? 'pc-rolepop__dot role-ink' : 'pc-rolepop__dot'}
                style={colour ? { '--role': colour } : undefined}
              />
              <span
                className={colour ? 'pc-rolepop__name role-ink' : 'pc-rolepop__name'}
                style={colour ? { '--role': colour } : undefined}
              >
                <EmojiText>{role.name}</EmojiText>
              </span>
              <CheckIcon className="pc-rolepop__tick size-3.5" data-on={on ? 'true' : 'false'} />
            </button>
          );
        }) : (
          <p className="pc-rolepop__empty">
            {needle ? `No role matches “${query.trim()}”.` : 'This guild has no roles to hand out.'}
          </p>
        )}
      </div>
    </div>
  ), document.body);
}
