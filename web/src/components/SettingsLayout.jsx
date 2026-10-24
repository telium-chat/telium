import {
  createContext, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { Text } from '@cloudflare/kumo/components/text';
import { cn } from '../lib/cn.js';
import { storage } from '../lib/util.js';
import { Async } from './Feedback.jsx';
import { BackIcon, CloseIcon, SearchIcon, ServerIcon, TeliumMark } from './icons.jsx';
import { IconButton } from './Button.jsx';
import { useDialogs } from './Modal.jsx';
import { EmojiText } from './Twemoji.jsx';
import { buildTitle } from '../lib/build.js';
import { UpdateStatus } from './UpdateStatus.jsx';

export function SettingsLayout({
  id, title, panes, initial, footerLabel, footerValue, onClose,
}) {
  const entries = Object.entries(panes);
  const memory = id ? `telium.settings.${id}.pane` : null;
  const [chosen, setChosen] = useState(() => remembered(panes, initial, memory));
  const current = panes[chosen] ? chosen : entries[0][0];
  const pane = panes[current];
  const Pane = pane.component;

  const [view, setView] = useState('pane');
  const [query, setQuery] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const dialogs = useDialogs();
  const findRef = useRef(null);
  const listRef = useRef(null);
  const headingRef = useRef(null);

  useEffect(() => { if (memory) storage.set(memory, current); }, [memory, current]);

  const dirty = useRef(false);
  const guard = useMemo(() => ({ set: (v) => { dirty.current = v; } }), []);
  const leaving = (go) => {
    if (!dirty.current) { go(); return; }
    dialogs.confirm({
      title: 'Discard changes?',
      body: 'Your edits on this page have not been saved.',
      confirmLabel: 'Discard',
      danger: true,
      onConfirm: () => { dirty.current = false; go(); },
    });
  };

  const show = (key) => leaving(() => { setChosen(key); setView('pane'); setQuery(''); });
  const close = () => leaving(() => onClose?.());

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    headingRef.current?.focus({ preventScroll: true });
  }, [current]);

  const groups = sections(entries, query);
  const matches = groups.flatMap((g) => g.items);

  const onKeyDownCapture = (e) => {
    if (e.key !== 'Escape') return;
    if (query && findRef.current === document.activeElement) {
      setQuery('');
      e.stopPropagation();
      return;
    }
    if (dirty.current) {
      e.stopPropagation();
      close();
    }
  };

  const nav = { go: (key) => { if (panes[key]) show(key); }, has: (key) => Boolean(panes[key]) };

  return (
    <GuardContext.Provider value={guard}>
     <PaneContext.Provider value={nav}>
      <div className="settings" data-view={view} onKeyDownCapture={onKeyDownCapture}>
        <nav aria-label="Settings sections" className="settings__nav">
          <div className="settings__head">
            <div className="settings__host">
              <div className="eyebrow">{footerLabel}</div>
              <div className="settings__host-value">
                <ServerIcon className="size-3.5 shrink-0 text-muted" />
                <span className="truncate" title={footerValue}>{footerValue}</span>
              </div>
              <div className="settings__host-title truncate" title={title}><EmojiText>{title}</EmojiText></div>
            </div>
            <IconButton
              title="Close settings"
              className="shrink-0 sm:hidden"
              onClick={close}
            >
              <CloseIcon className="size-4" />
            </IconButton>
          </div>

          <div className="settings__find">
            <SearchIcon className="size-4 shrink-0 text-muted" />
            <input
              ref={findRef}
              type="search"
              value={query}
              aria-label="Filter settings"
              placeholder="Filter"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); end(listRef, 0); }
                if (e.key === 'Enter' && matches.length) { e.preventDefault(); show(matches[0][0]); }
              }}
            />
          </div>

          <div
            ref={listRef}
            data-mobile-scroll
            className="settings__list"
            onKeyDown={(e) => {
              const keys = { ArrowDown: 1, ArrowUp: -1 };
              if (e.key in keys) { e.preventDefault(); walk(listRef, e.target, keys[e.key]); }
              if (e.key === 'Home') { e.preventDefault(); end(listRef, 0); }
              if (e.key === 'End') { e.preventDefault(); end(listRef, -1); }
            }}
          >
            {groups.map((group) => (
              <div key={group.name || '_'} className="settings__group">
                {group.name ? (
                  <div className="settings__group-name eyebrow">{group.name}</div>
                ) : null}
                {group.items.map(([key, item]) => (
                  <button
                    key={key}
                    type="button"
                    data-nav-item
                    aria-current={current === key ? 'page' : undefined}
                    className="settings-item"
                    onClick={() => show(key)}
                  >
                    {group.icons ? (
                      <span className="settings-item__icon">
                        {item.icon
                          ? <item.icon className="size-[17px]" />
                          : <span className="block size-[17px]" />}
                      </span>
                    ) : null}
                    <span className="settings-item__label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
            {matches.length ? null : (
              <div className="settings__none">Nothing here matches “{query}”.</div>
            )}
          </div>

          <div className="settings__mark">
            <TeliumMark className="size-4" gradient={false} />
            <span className="text-xs font-semibold text-foreground/80">Telium</span>
            {panes.feedback ? (
              <button
                type="button"
                className="select-all cursor-pointer text-2xs font-mono opacity-60 transition hover:opacity-100"
                title={`${buildTitle()} -- open Help & feedback`}
                onClick={() => show('feedback')}
              >
                v{__APP_VERSION__}
                <span className="opacity-60"> · {__BUILD_ID__ ?? 'dev'}</span>
              </button>
            ) : (
              <span
                className="select-all text-2xs font-mono opacity-60"
                title={buildTitle()}
              >
                v{__APP_VERSION__}
                <span className="opacity-60"> · {__BUILD_ID__ ?? 'dev'}</span>
              </span>
            )}
          </div>
          <UpdateStatus />
        </nav>

        <div className="settings__pane">
          <div className="settings__controls" data-scrolled={scrolled || undefined}>
            <IconButton
              title="All settings"
              className="shrink-0 sm:hidden"
              onClick={() => leaving(() => setView('nav'))}
            >
              <BackIcon className="size-4" />
            </IconButton>
            <IconButton title="Close settings (Esc)" className="shrink-0" onClick={close}>
              <CloseIcon className="size-4" />
            </IconButton>
          </div>

          <div
            key={current}
            role="region"
            aria-labelledby={`settings-pane-${current}`}
            data-mobile-scroll
            className="settings__body page-in"
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
          >
            <div className="settings__sheet" data-wide={pane.wide || undefined}>
              <h2
                id={`settings-pane-${current}`}
                className="settings__title"
                ref={headingRef}
                tabIndex={-1}
              >
                {pane.label}
              </h2>
              <Pane onClose={onClose} />
            </div>
          </div>
        </div>
      </div>
     </PaneContext.Provider>
    </GuardContext.Provider>
  );
}

function remembered(panes, initial, memory) {
  if (initial && panes[initial]) return initial;
  const last = memory ? storage.get(memory, null) : null;
  if (last && panes[last]) return last;
  return Object.keys(panes)[0];
}

function sections(entries, query) {
  const needle = query.trim().toLowerCase();
  const icons = entries.some(([, pane]) => pane.icon);
  const out = [];
  for (const [key, pane] of entries) {
    if (needle && !hay(pane).includes(needle)) continue;
    const name = pane.group || '';
    let group = out.find((g) => g.name === name);
    if (!group) { group = { name, icons, items: [] }; out.push(group); }
    group.items.push([key, pane]);
  }
  return out;
}

const hay = (pane) => [pane.label, pane.group, ...(pane.keywords || [])]
  .filter(Boolean).join(' ').toLowerCase();

function end(listRef, at) {
  const rows = [...(listRef.current?.querySelectorAll('[data-nav-item]') || [])];
  rows.at(at)?.focus();
}

function walk(listRef, fromEl, direction) {
  const rows = [...(listRef.current?.querySelectorAll('[data-nav-item]') || [])];
  if (!rows.length) return;
  const at = rows.indexOf(fromEl);
  const next = at < 0 ? 0 : (at + direction + rows.length) % rows.length;
  rows[next]?.focus();
}

const GuardContext = createContext(null);
const PaneContext = createContext(null);

export function useSettingsNav() {
  return useContext(PaneContext) || { go: () => {}, has: () => false };
}

export function useUnsavedChanges(dirty) {
  const guard = useContext(GuardContext);
  useEffect(() => {
    if (!guard) return undefined;
    guard.set(dirty);
    return () => guard.set(false);
  }, [guard, dirty]);
}

export function Section({ title, description, actions, children, className }) {
  return (
    <section className={cn('flex flex-col gap-3 pb-6', className)}>
      {title || actions ? (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <Text as="h3" bold>{title}</Text> : null}
            {description ? (
              <div className="mt-0.5">
                <Text variant="secondary" size="sm">{description}</Text>
              </div>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export { Async };
