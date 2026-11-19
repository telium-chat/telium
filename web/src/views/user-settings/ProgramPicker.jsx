import { useCallback, useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  Button, Field, Hint, IconButton, Section, SearchField, TextInput, TrashIcon,
} from '../../components/index.js';
import { addCustomProgram, customPrograms, removeCustomProgram } from '../../lib/rich-presence.js';
import { friendlyName, pickableProcesses } from '../../lib/process-picker.js';

/// Discord-style "add it as a game": pick any running program and Telium shows "Playing <name>" while it runs, for programs no detection list knows.
export function ProgramPicker() {
  const store = useStore();
  useStoreEvent('prefs');
  const listed = customPrograms(store);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [icons, setIcons] = useState({});
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState(null);
  const [name, setName] = useState('');

  const refresh = useCallback(() => {
    setRows(null);
    window.teliumDesktop.listProcesses()
      .then((next) => {
        const list = next || [];
        setRows(list);
        // Icons arrive after the list so it is never held up by them; only the rows a person can plausibly pick are asked for.
        const likely = pickableProcesses(list, { listed: customPrograms(store) }).slice(0, 80);
        window.teliumDesktop.programIcons?.(likely)?.then((found) => setIcons(found || {})).catch(() => {});
      })
      .catch(() => setRows([]));
  }, [store]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const shown = rows ? pickableProcesses(rows, { query, listed }) : [];
  const choose = (row) => { setChosen(row); setName(friendlyName(row.executable)); };
  const close = () => { setOpen(false); setChosen(null); setQuery(''); };
  const add = () => {
    if (!chosen || !addCustomProgram(store, { name, executable: chosen.executable })) return;
    close();
  };

  return (
    <Section
      title="Programs"
      description="Pick a program that isn't a detected game and Telium will show it as what you're playing while it runs."
    >
      {listed.length ? (
        <ul className="divide-y divide-border panel px-3" aria-label="Added programs">
          {listed.map((p) => (
            <li key={p.executable} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{p.name}</div>
                <div className="truncate font-mono text-xs text-muted">{p.executable}</div>
              </div>
              <IconButton title={`Remove ${p.name}`} onClick={() => removeCustomProgram(store, p.executable)}>
                <TrashIcon className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : null}

      {!open ? (
        <div><Button onClick={() => setOpen(true)}>Add a program</Button></div>
      ) : chosen ? (
        <div className="grid gap-3 panel p-3">
          <div className="truncate font-mono text-xs text-muted" title={chosen.path}>{chosen.executable}</div>
          <Field label="Shown as">
            <TextInput value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" disabled={!name.trim()} onClick={add}>Add</Button>
            <Button onClick={() => setChosen(null)}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 panel p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchField value={query} placeholder="Search running programs" onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button onClick={refresh}>Refresh</Button>
            <Button onClick={close}>Cancel</Button>
          </div>
          {rows === null ? <Hint>Looking at what's running…</Hint> : null}
          {rows && !rows.length ? (
            <Hint>Nothing came back. Programs can only be listed while Game presence is on.</Hint>
          ) : null}
          {rows && rows.length && !shown.length ? <Hint>No running program matches.</Hint> : null}
          <ul className="max-h-64 overflow-y-auto" aria-label="Running programs">
            {shown.map((row) => (
              <li key={row.executable}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-surface-hover"
                  onClick={() => choose(row)}
                >
                  <span className="flex min-w-0 max-w-full items-center gap-2">
                    {icons[row.executable]
                      ? <img src={icons[row.executable]} alt="" className="size-6 shrink-0 rounded" />
                      : <span className="size-6 shrink-0 rounded bg-surface-hover" aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="block text-sm">{row.executable}</span>
                      <span className="block max-w-full truncate font-mono text-xs text-muted">{row.path}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
