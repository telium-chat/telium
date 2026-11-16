import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { bytes, dayOf, relative } from '../../lib/util.js';
import {
  Button, Checkbox, EmptyState, Hint, Loading, Notice, ProgressBar, Section, useDialogs,
} from '../../components/index.js';

const PAGE = 50;

/// Every upload this account is charged for, largest first, with the means to
/// hand the space back. Avatars and emoji count toward the quota too but are
/// still in use, so they are summarised rather than offered for deletion.
export function UploadsPane({ onClose } = {}) {
  const store = useStore();
  const tr = useT();
  const dialogs = useDialogs();
  const home = store.session?.home?.domain;
  const [files, setFiles] = useState([]);
  const [summary, setSummary] = useState(null);
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    try {
      const page = await store.home.listOwnMedia({ limit: PAGE, offset });
      setSummary({
        used: page.used_bytes,
        quota: page.quota_bytes,
        closed: page.tier1_upload === false,
        breakdown: page.breakdown || {},
      });
      setFiles((prev) => (offset ? [...prev, ...page.files] : page.files));
      setNextOffset(page.next_offset ?? null);
      setError(null);
    } catch (e) { setError(e); }
    finally { setLoading(false); }
  }, [store]);

  // Direct-message attachments are uploaded as opaque ciphertext under a fixed name.
  const isEncrypted = (f) => f.filename === 'attachment.bin' && f.mime === 'application/octet-stream';

  useEffect(() => { load(0); }, [load]);

  const deletable = files.filter((f) => f.deletable);
  const chosen = files.filter((f) => selected.has(f.hash));
  const chosenBytes = chosen.reduce((sum, f) => sum + f.size, 0);
  const otherBytes = ['profile', 'expression']
    .reduce((sum, p) => sum + (summary?.breakdown?.[p]?.bytes || 0), 0);

  const show = async (file) => {
    try {
      const where = await store.home.ownMediaMessage(file.hash);
      if (!store.jumpTo(where.channel_id, where.message_id)) throw new Error('unreachable');
      onClose?.();
    } catch { toast(tr('settings.uploads.showFailed')); }
  };

  const expiry = (file) => {
    if (file.expires_at == null) return tr('settings.uploads.noExpiry');
    const key = file.expires_at > Date.now() ? 'settings.uploads.expires' : 'settings.uploads.expired';
    return tr(key, { when: relative(file.expires_at), date: dayOf(file.expires_at) });
  };

  const toggle = (hash) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(hash)) next.delete(hash); else next.add(hash);
    return next;
  });

  const remove = (targets) => dialogs.confirm({
    title: tr('settings.uploads.confirmTitle', { count: targets.length }),
    body: tr('settings.uploads.confirmBody', {
      count: targets.length, size: bytes(targets.reduce((s, f) => s + f.size, 0)),
    }),
    confirmLabel: tr('settings.uploads.confirmAction'),
    danger: true,
    onConfirm: async () => {
      setBusy(true);
      let freed = 0;
      let removed = 0;
      let skipped = 0;
      // One at a time: each delete is its own decision on the server, and a
      // refusal in the middle (shared bytes, already gone) must not abort the rest.
      for (const file of targets) {
        try {
          await store.home.deleteMedia(file.hash);
          freed += file.size;
          removed += 1;
        } catch (e) {
          // Already gone counts as done; anything else (shared bytes, a network error) is skipped.
          if (e?.status === 404) removed += 1; else skipped += 1;
        }
      }
      setSelected(new Set());
      await load(0);
      try { await store.loadCapabilities(home); } catch { /* the list above is already fresh */ }
      setBusy(false);
      if (skipped) {
        toast(tr('settings.uploads.partial', { freed: bytes(freed), count: removed, skipped }));
      } else {
        toast(tr('settings.uploads.freed', { freed: bytes(freed), count: removed }));
      }
    },
  });

  if (error && !files.length) {
    const unsupported = error.status === 404;
    return (
      <Section title={tr('settings.uploads.title')}>
        <Notice tone="warn">
          {unsupported ? tr('settings.uploads.unsupported', { home }) : tr('settings.uploads.loadFailed')}
        </Notice>
        {unsupported ? null : (
          <Button className="self-start" onClick={() => load(0)}>{tr('settings.uploads.retry')}</Button>
        )}
      </Section>
    );
  }
  if (!summary) return <Loading />;

  return (
    <Section title={tr('settings.uploads.title')}>
      <Hint>{tr('settings.uploads.intro', { home })}</Hint>
      {summary.closed ? (
        <Notice>{tr('settings.uploads.closed', { used: bytes(summary.used), home })}</Notice>
      ) : summary.quota ? (
        <>
          <ProgressBar
            value={Math.min(100, (summary.used / summary.quota) * 100)}
            label={tr('settings.uploads.usageLabel')}
          />
          <Hint>{tr('settings.media.usage', {
            used: bytes(summary.used), quota: bytes(summary.quota), home,
          })}</Hint>
        </>
      ) : (
        <Hint>{tr('settings.uploads.usageNoQuota', { used: bytes(summary.used) })}</Hint>
      )}
      {otherBytes > 0 ? (
        <Hint>{tr('settings.uploads.otherBytes', { size: bytes(otherBytes) })}</Hint>
      ) : null}

      {files.length === 0 && !loading ? (
        <EmptyState title={tr('settings.uploads.emptyTitle')}>
          {tr('settings.uploads.emptyBody')}
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              disabled={busy || !deletable.length}
              onClick={() => setSelected(
                selected.size === deletable.length ? new Set() : new Set(deletable.map((f) => f.hash)),
              )}
            >
              {selected.size === deletable.length && deletable.length
                ? tr('settings.uploads.clear') : tr('settings.uploads.selectAll')}
            </Button>
            <Button
              variant="danger"
              disabled={busy || !chosen.length}
              onClick={() => remove(chosen)}
            >
              {chosen.length
                ? tr('settings.uploads.deleteSelected', {
                  count: chosen.length, size: bytes(chosenBytes),
                })
                : tr('settings.uploads.deleteNone')}
            </Button>
          </div>
          <div role="list" aria-label={tr('settings.uploads.title')} className="record-list">
            {files.map((file) => (
              <div role="listitem" key={file.hash} className="record">
                <div className="record__body">
                  <Checkbox
                    label={isEncrypted(file)
                      ? tr('settings.uploads.encrypted')
                      : (file.filename || file.hash.slice(0, 12))}
                    checked={selected.has(file.hash)}
                    disabled={busy || !file.deletable}
                    onChange={() => toggle(file.hash)}
                  />
                  <div className="record__meta">
                    <span className="record__fact">{bytes(file.size)}</span>
                    {isEncrypted(file) ? null : <span className="record__fact">{file.mime}</span>}
                    <span className="record__fact">{dayOf(file.created_at)}</span>
                    {isEncrypted(file) ? (
                      <span className="record__fact">{tr('settings.uploads.encryptedNote')}</span>
                    ) : null}
                    <span className="record__fact">{expiry(file)}</span>
                    {file.in_messages > 0 ? (
                      <span className="record__fact">
                        {tr('settings.uploads.inMessages', { count: file.in_messages })}
                      </span>
                    ) : null}
                    {file.shared ? (
                      <span className="record__fact">{tr('settings.uploads.shared')}</span>
                    ) : null}
                  </div>
                </div>
                {file.in_messages > 0 && !isEncrypted(file) ? (
                  <div className="record__actions">
                    <Button variant="secondary" disabled={busy} onClick={() => show(file)}>
                      {tr('settings.uploads.show')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {loading ? <Loading /> : null}
          {nextOffset !== null && !loading ? (
            <Button className="self-start" variant="secondary" onClick={() => load(nextOffset)}>
              {tr('settings.uploads.more')}
            </Button>
          ) : null}
        </>
      )}
    </Section>
  );
}
