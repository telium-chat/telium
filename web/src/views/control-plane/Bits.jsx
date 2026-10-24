import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { Button, Hint, Pill } from '../../components/index.js';
import { ABSENT, count, duration, present } from './format.js';
import { useNow } from './useLive.js';

export function Tile({ label, value, note, tone, title, children }) {
  return (
    <div className="cp-tile" data-tone={tone || undefined} title={title}>
      <span className="cp-tile__label">{label}</span>
      <span className="cp-tile__value" data-absent={value === ABSENT ? '' : undefined}>
        {value}
      </span>
      {note ? <span className="cp-tile__note">{note}</span> : null}
      {children}
    </div>
  );
}

export function Facts({ children, className }) {
  return <div className={cn('cp-facts', className)}>{children}</div>;
}

export function Fact({ name, value, why, mono }) {
  return (
    <div className="cp-fact">
      <span className="cp-fact__name">{name}</span>
      <span className={cn('cp-fact__value', mono && 'font-mono text-xs')}>
        {present(value) && value !== '' ? value : ABSENT}
      </span>
      {why ? <span className="cp-fact__why">{why}</span> : null}
    </div>
  );
}

export function Freshness({ at, error, interval = 15_000 }) {
  const now = useNow();
  const age = at ? now - at : null;
  const stale = error || (present(age) && age > interval * 2.5);
  return (
    <span className="cp-freshness" data-stale={stale ? '' : undefined} role="status">
      <span aria-hidden="true" className="cp-freshness__dot" />
      {at === null && !error ? 'Loading' : null}
      {error ? 'Server not answering' : null}
      {at && !error ? `Updated ${age < 2000 ? 'just now' : `${duration(age)} ago`}` : null}
    </span>
  );
}

export function Readout({ tone, question, answer, children }) {
  return (
    <div
      className="cp-tile gap-3 p-4 sm:flex-row sm:items-baseline sm:gap-5"
      data-tone={tone || undefined}
    >
      <div className="flex flex-col gap-0.5 sm:w-52 sm:shrink-0">
        <span className="cp-tile__label">{question}</span>
        <span className="cp-tile__value text-3xl">{answer}</span>
      </div>
      <div className="min-w-0 flex-1 text-sm leading-[1.5]">{children}</div>
    </div>
  );
}

export function Verdict({ tone, children }) {
  return <Pill tone={tone}>{children}</Pill>;
}

export function usePages(loadPage, key) {
  const [state, setState] = useState({ items: [], cursor: null, done: false, error: null });
  const [loading, setLoading] = useState(true);

  const generation = useRef(0);
  const call = useRef(loadPage);
  call.current = loadPage;

  const load = useCallback(async (cursor, mine) => {
    setLoading(true);
    try {
      const page = await call.current(cursor);
      if (generation.current !== mine) return;
      setState((s) => ({
        items: cursor ? [...s.items, ...(page.items || [])] : (page.items || []),
        cursor: page.cursor || null,
        done: !page.cursor,
        error: null,
      }));
    } catch (error) {
      if (generation.current !== mine) return;
      setState((s) => ({ ...s, error }));
    } finally {
      if (generation.current === mine) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    setState({ items: [], cursor: null, done: false, error: null });
    load(null, mine);
  }, [key, load]);

  const more = useCallback(() => {
    if (!state.cursor) return;
    load(state.cursor, generation.current);
  }, [load, state.cursor]);

  const reload = useCallback(() => {
    generation.current += 1;
    load(null, generation.current);
  }, [load]);

  return { ...state, loading, more, reload };
}

export function Pager({ pages, total, noun }) {
  const shown = pages.items.length;
  if (!shown) return null;
  if (pages.done && !present(total)) return null;
  if (pages.done && total <= shown) return null;
  return (
    <div className="cp-pager">
      <Hint className="cp-pager__count">
        {present(total) && total > shown
          ? `${count(shown)} of ${count(total)} ${noun}`
          : `${count(shown)} ${noun}`}
      </Hint>
      {pages.done ? null : (
        <Button size="sm" variant="ghost" disabled={pages.loading} onClick={pages.more}>
          {pages.loading ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  );
}
