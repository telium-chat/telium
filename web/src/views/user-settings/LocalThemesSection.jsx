import { useRef, useState } from 'react';
import { Button, Notice, TextArea, TrashIcon } from '../../components/index.js';
import { cn } from '../../lib/cn.js';
import { saveBlob } from '../../lib/download.js';
import {
  STARTER_THEME, exportThemeCss, importLocalThemeFile, installedTheme, localThemes,
  saveLocalTheme, themeFileName,
} from '../../lib/themes.js';
import { themeOutcomeMessage } from './themeMessages.js';

/// Themes that never went through the catalog: imported from a file someone
/// sent, or written here. The private way to share a theme — export, send the
/// file, import — with the same network policy as the catalog, so a file from
/// a friend cannot do anything a published theme could not.
export function LocalThemesSection({
  t, activeId, usable, query = '', onApply, onDeactivate, onRemove,
}) {
  const fileInput = useRef(null);
  const [editing, setEditing] = useState(null); // { id: string|null, css }
  const [problem, setProblem] = useState(null);
  const [, bump] = useState(0);

  const needle = query.trim().toLowerCase();
  const themes = localThemes().filter((theme) => !needle
    || theme.meta.name.toLowerCase().includes(needle)
    || theme.meta.author.toLowerCase().includes(needle));

  const finish = (outcome) => {
    if (outcome.error) {
      setProblem(themeOutcomeMessage(outcome, t));
      return false;
    }
    setProblem(null);
    onApply(outcome.theme.id);
    bump((n) => n + 1);
    return true;
  };

  const importFile = async (file) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    finish(await importLocalThemeFile(file));
  };

  const save = () => {
    if (!editing) return;
    if (finish(saveLocalTheme(editing.css, { id: editing.id }))) setEditing(null);
  };

  const exportTheme = async (id) => {
    const css = exportThemeCss(id);
    if (!css) return;
    try {
      await saveBlob(new Blob([css], { type: 'text/css' }), themeFileName(installedTheme(id)?.meta), 'text/css');
    } catch (error) {
      setProblem(error?.message || t('settings.market.unreadable'));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{t('settings.market.local.title')}</span>
        <span className="flex gap-1.5">
          <Button size="sm" onClick={() => fileInput.current?.click()}>{t('settings.market.local.import')}</Button>
          <Button size="sm" onClick={() => { setProblem(null); setEditing({ id: null, css: STARTER_THEME }); }}>
            {t('settings.market.local.new')}
          </Button>
        </span>
      </div>
      <p className="text-xs leading-[1.5] text-muted">{t('settings.market.local.description')}</p>
      <input
        ref={fileInput}
        type="file"
        accept=".css,text/css"
        className="sr-only"
        aria-label={t('settings.market.local.importLabel')}
        onChange={(event) => importFile(event.target.files?.[0])}
      />

      {problem ? <Notice tone="warn">{problem}</Notice> : null}

      {editing ? (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <TextArea
            label={t('settings.market.local.editor')}
            rows={14}
            spellCheck={false}
            className="font-mono text-xs"
            value={editing.css}
            onChange={(event) => setEditing({ ...editing, css: event.target.value })}
          />
          <div className="flex gap-1.5">
            <Button variant="primary" size="sm" onClick={save}>{t('settings.market.local.save')}</Button>
            <Button size="sm" onClick={() => { setEditing(null); setProblem(null); }}>
              {t('settings.market.local.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {themes.length ? (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          {themes.map((theme) => {
            const active = activeId === theme.id && usable;
            return (
              <div
                key={theme.id}
                className={cn(
                  'flex flex-col gap-2 rounded-xl border border-border bg-surface p-3',
                  active && 'border-accent/60 ring-1 ring-accent',
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{theme.meta.name}</span>
                  <span className="shrink-0 rounded-full bg-rail px-2 py-0.5 text-xs text-muted">
                    {t('settings.market.local.badge')}
                  </span>
                </div>
                <div className="truncate text-xs text-muted">
                  {theme.meta.author}
                  {theme.meta.version ? ` · v${theme.meta.version}` : ''}
                </div>
                <p className="line-clamp-2 text-xs leading-[1.5] text-muted">{theme.meta.description}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  {active ? (
                    <Button variant="primary" size="sm" className="grow" title={t('settings.market.activeHint')} onClick={onDeactivate}>
                      {t('settings.market.active')}
                    </Button>
                  ) : (
                    <Button size="sm" className="grow" onClick={() => onApply(theme.id)}>{t('settings.market.apply')}</Button>
                  )}
                  <Button size="sm" onClick={() => { setProblem(null); setEditing({ id: theme.id, css: theme.css }); }}>
                    {t('settings.market.local.edit')}
                  </Button>
                  <Button size="sm" onClick={() => exportTheme(theme.id)}>{t('settings.market.local.export')}</Button>
                  {active ? null : (
                    <Button
                      size="sm"
                      shape="square"
                      aria-label={t('settings.market.remove')}
                      onClick={() => { onRemove(theme.id); bump((n) => n + 1); }}
                    >
                      <TrashIcon />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        needle ? null : <p className="text-xs text-muted">{t('settings.market.local.empty')}</p>
      )}
    </div>
  );
}
