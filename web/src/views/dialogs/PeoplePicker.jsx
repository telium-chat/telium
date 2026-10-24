import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { faceOf } from '../../lib/faces.js';
import { fullId, knownPeople, rankPeople } from '../../lib/people.js';
import { shortName } from '../../lib/util.js';
import {
  Avatar, CloseIcon, EmojiText, Hint, Marked, MarkedHandle,
} from '../../components/index.js';

const listPresence = (status) => (
  !status || status === 'offline' || status === 'invisible' ? null : status
);

export function pickedWithTyped(picked, query, domain) {
  const typed = query.trim() ? fullId(query, domain) : '';
  return [...new Set([...picked, ...(typed ? [typed] : [])])];
}

export function PeoplePicker({
  query, setQuery, picked, setPicked, exclude = null, onSubmit, placeholder = 'Name or handle',
}) {
  const store = useStore();
  useStoreEvent('friends', 'conversations', 'members', 'peers', 'presence');
  const [at, setAt] = useState(-1);
  const input = useRef(null);
  const list = useRef(null);
  const listId = useId();

  const people = knownPeople(store);
  const skip = useMemo(
    () => new Set([...(exclude || []), ...picked]),
    [exclude, picked],
  );
  const rows = rankPeople(people, query, { exclude: skip });
  const typed = query.trim() ? fullId(query, store.home?.domain) : '';

  const q = query.trim().replace(/^@/, '').toLowerCase();
  const top = rows[0]?.person;
  const meant = Boolean(top) && (
    rows.length === 1
    || top.name.toLowerCase().startsWith(q)
    || top.id.slice(1).toLowerCase().startsWith(q)
  );
  const literal = query.includes(':') && !rows.some((r) => r.person.id === typed);
  const cursor = !rows.length || literal
    ? -1
    : (at >= 0 ? Math.min(at, rows.length - 1) : (q && meant ? 0 : -1));

  useEffect(() => { setAt(-1); }, [query]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const add = (id) => {
    if (id) setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setQuery('');
    input.current?.focus();
  };
  const drop = (id) => {
    setPicked((prev) => prev.filter((p) => p !== id));
    input.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Backspace' && !query && picked.length) {
      e.preventDefault();
      setPicked((prev) => prev.slice(0, -1));
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : rows.length - 1;
      setAt(() => (cursor < 0
        ? (step === 1 ? 0 : rows.length - 1)
        : (cursor + step) % rows.length));
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (query.trim()) add(cursor >= 0 ? rows[cursor].person.id : typed);
    else onSubmit?.();
  };

  const nameFor = (id) => faceOf(store, id)?.name || shortName(id) || id;

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          'flex min-h-10 flex-wrap items-center gap-1.5 rounded-row bg-[var(--field-background)] px-2 py-1.5',
          'cursor-text',
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); }
        }}
      >
        {picked.map((id) => {
          const face = faceOf(store, id);
          return (
            <button
              key={id}
              type="button"
              aria-label={`Remove ${nameFor(id)}`}
              onClick={() => drop(id)}
              className={cn(
                'flex min-w-0 max-w-full items-center gap-1.5 rounded-md bg-accent/12 py-0.5 pe-1.5 ps-0.5',
                'text-sm text-accent transition-colors duration-[var(--dur-1)] ease-[var(--ease)]',
                'hover:bg-accent/18',
              )}
            >
              <Avatar
                id={id}
                name={face?.name}
                size="xxs"
                mediaRef={face?.avatarRef}
                base={face?.base}
                mediaOrigin={face?.mediaOrigin}
              />
              <span className="truncate">{nameFor(id)}</span>
              <CloseIcon className="size-3 shrink-0 opacity-60" />
            </button>
          );
        })}
        <input
          ref={input}
          autoFocus
          type="text"
          aria-label="Who"
          placeholder={picked.length ? '' : placeholder}
          role="combobox"
          aria-expanded={rows.length > 0}
          aria-controls={listId}
          aria-activedescendant={cursor >= 0 ? `${listId}-${cursor}` : undefined}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 text-base text-foreground outline-none placeholder:text-muted"
        />
      </div>

      {rows.length ? (
        <div
          id={listId}
          ref={list}
          role="listbox"
          aria-label="People"
          data-mobile-scroll
          className="-mx-1 flex max-h-[min(38dvh,320px)] flex-col overflow-y-auto px-1"
        >
          {rows.map(({ person, positions, idPositions }, i) => {
            const live = store.presence?.get(person.id) || store.friends?.get(person.id)?.presence;
            return (
              <button
                key={person.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === cursor}
                data-active={i === cursor}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setAt(i)}
                onClick={() => add(person.id)}
                className={cn(
                  'flex min-h-11 w-full shrink-0 items-center gap-2.5 rounded-row px-2 text-start',
                  'transition-colors duration-[var(--dur-1)] ease-[var(--ease)]',
                  i === cursor ? 'bg-accent-soft text-foreground' : 'text-foreground',
                )}
              >
                <Avatar
                  id={person.id}
                  name={person.name}
                  size="sm"
                  mediaRef={person.face?.avatarRef}
                  base={person.face?.base}
                  mediaOrigin={person.face?.mediaOrigin}
                  presence={listPresence(live?.status)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">
                    {positions.length
                      ? <Marked text={person.name} positions={positions} />
                      : <EmojiText>{person.name}</EmojiText>}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    <MarkedHandle text={person.id} positions={idPositions} />
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {rows.length ? null : (
        <Hint className="px-2">
          {query.trim()
            ? (literal ? 'Press Enter to add this handle.' : 'Nobody you know. A full handle works too.')
            : (picked.length ? null : 'Type a name or a full handle.')}
        </Hint>
      )}
    </div>
  );
}
