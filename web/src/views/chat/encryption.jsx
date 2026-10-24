import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { list, onLocaleChange, t } from '../../lib/i18n/index.js';
import { Button, LockIcon, Notice, Pill } from '../../components/index.js';

const note = (title, body, vars) => ({ title, body, vars });

function noteVars(translate, vars) {
  if (!vars) return undefined;
  const out = {};
  for (const [name, key] of Object.entries(vars)) out[name] = translate(key);
  return out;
}

export function noteText(n) {
  const v = noteVars(t, n.vars);
  return n.body ? `${t(n.title, v)} ${t(n.body, v)}` : t(n.title, v);
}

export const NO_ENCRYPTION = note(
  'chat.encryption.unavailable.title',
  'chat.encryption.unavailable.body',
);

export const AWAITING_ADMISSION = note(
  'chat.encryption.awaiting.title',
  'chat.encryption.awaiting.body',
);

export const REJOIN_UNDELIVERABLE = note(
  'chat.encryption.rejoinUndeliverable.title',
  'chat.encryption.rejoinUndeliverable.body',
);

export const CHANGED_IDENTITY = note(
  'chat.encryption.changedIdentity.title',
  'chat.encryption.changedIdentity.body',
);

export const VAULT_LOCKED = note(
  'chat.encryption.vaultLocked.title',
  'chat.encryption.vaultLocked.body',
  { pane: 'settings.nav.recovery' },
);

export const DEVICE_APPROVAL = note(
  'chat.encryption.deviceApproval.title',
  'chat.encryption.deviceApproval.body',
);

export const RECOVERY_FALLBACK = note(
  'chat.encryption.recoveryFallback.title',
  'chat.encryption.recoveryFallback.body',
  { pane: 'settings.nav.recovery' },
);

export const SYNC_FAILED = note(
  'chat.encryption.syncFailed.title',
  'chat.encryption.syncFailed.body',
);

export let ESCROWED_NOTE = '';
export let NOT_YET_READABLE = '';

function refreshNotes() {
  ESCROWED_NOTE = t('chat.encryption.escrowedNote', { pane: t('settings.nav.recovery') });
  NOT_YET_READABLE = t('chat.encryption.notYetReadable');
}
refreshNotes();
onLocaleChange(refreshNotes);

export const CUSTODY_TONE = {
  escrowed: 'warn',
  opaque_custody: 'success',
  device_custody: 'success',
  self_custody: 'success',
};

export function custodyNote(mode) {
  if (mode === 'escrowed') {
    return t('chat.encryption.custody.escrowed', { pane: t('settings.nav.recovery') });
  }
  if (mode === 'opaque_custody') return t('chat.encryption.custody.opaque');
  if (mode === 'device_custody') return t('chat.encryption.custody.device');
  if (mode === 'self_custody') return t('chat.encryption.custody.self');
  return t('chat.encryption.custody.unknown');
}

export function useDeviceTrust(conversationId) {
  const store = useStore();
  const [rows, setRows] = useState([]);
  const devices = store.mls?.devicesIn(conversationId) || [];
  const shape = devices.map((d) => `${d.userId}|${d.deviceId}|${d.signatureKey}`).join(',');
  useEffect(() => {
    if (!store.trust || !shape) { setRows([]); return undefined; }
    let live = true;
    store.trust.survey(store.mls.devicesIn(conversationId))
      .then((surveyed) => { if (live) setRows(surveyed); })
      .catch(() => {});
    return () => { live = false; };
  }, [store, conversationId, shape]);
  return rows;
}

export function EncryptionChip({ custody, unverified, changed, typing = false, onOpen }) {
  const t = useT();
  const tone = changed ? 'danger' : (unverified ? 'warn' : (CUSTODY_TONE[custody] || 'default'));
  const label = changed
    ? t('chat.encryption.chip.keyChanged')
    : unverified
      ? t('chat.encryption.chip.unverified', { count: unverified })
      : custody === 'escrowed' ? t('chat.encryption.chip.serverCanRead')
        : custody === 'opaque_custody'
          || custody === 'device_custody'
          || custody === 'self_custody'
          ? t('chat.encryption.chip.endToEnd')
          : t('chat.encryption.chip.encrypted');
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('chat.encryption.chip.open')}
      title={changed
        ? t('chat.encryption.chip.keyChangedTooltip')
        : [custodyNote(custody), typing ? t('privacy.typing.inEncrypted') : '']
          .filter(Boolean).join(' ')}
    >
      <Pill tone={tone} className="cursor-pointer gap-1">
        <LockIcon className="size-3" />
        {label}
      </Pill>
    </button>
  );
}

function NoticeText({ head, children }) {
  const t = useT();
  const vars = noteVars(t, head.vars);
  return (
    <div className="enc-notice">
      <p className="enc-notice__head">{t(head.title, vars)}</p>
      {head.body ? <p className="enc-notice__body">{t(head.body, vars)}</p> : null}
      {children}
    </div>
  );
}

export function StartOver({ store, conversationId }) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setArmed(false); }, [conversationId]);

  const reset = async () => {
    if (!armed) { setArmed(true); return; }
    setBusy(true);
    try {
      const built = await store.resetConversation(conversationId);
      toast(built?.missing?.length
        ? t('chat.encryption.startOver.partial', {
          count: built.missing.length,
          names: list(built.missing),
        })
        : t('chat.encryption.startOver.done'));
      setArmed(false);
    } catch (e) { reportError(e, t('chat.encryption.startOver.failed')); }
    setBusy(false);
  };

  return (
    <div className="enc-notice__actions">
      <Button size="sm" variant="secondary-destructive" isDisabled={busy} onClick={reset}>
        {armed ? t('chat.encryption.startOver.confirm') : t('chat.encryption.startOver.arm')}
      </Button>
      {armed ? (
        <span className="enc-notice__body">
          {t('chat.encryption.startOver.warning')}
        </span>
      ) : null}
    </div>
  );
}

function syncErrorMessage(error) {
  const parts = [];
  let e = error;
  for (let depth = 0; e && depth < 3; depth += 1) {
    const text = e.body?.message || e.message || String(e);
    if (text && !parts.includes(text)) parts.push(text);
    e = e.cause;
  }
  const said = parts.join(' — ') || 'unknown';
  return said.length > 300 ? `${said.slice(0, 300)}…` : said;
}

export function ConversationNotices({
  store, conversationId, awaiting, changedKey, syncError = null, onRetry = null,
}) {
  const t = useT();
  if (!store.mls) {
    return (
      <div className="enc-notices">
        <Notice tone="warn"><NoticeText head={NO_ENCRYPTION} /></Notice>
      </div>
    );
  }
  const needsDevice = Boolean(store.vault?.needs_device);
  const hasIndependentFallback = Boolean(
    needsDevice && store.vault?.needs_independent,
  );
  const undeliverable = awaiting && !needsDevice
    && store.rejoinBlocked?.has(conversationId);
  return (
    <div className="enc-notices">
      {changedKey ? (
        <Notice tone="danger"><NoticeText head={CHANGED_IDENTITY} /></Notice>
      ) : null}
      {needsDevice ? (
        <Notice tone="warn">
          <NoticeText head={hasIndependentFallback ? RECOVERY_FALLBACK : DEVICE_APPROVAL} />
        </Notice>
      ) : null}
      {awaiting && !needsDevice ? (
        <Notice tone={undeliverable ? 'danger' : 'warn'}>
          <NoticeText head={undeliverable ? REJOIN_UNDELIVERABLE : AWAITING_ADMISSION}>
            <StartOver store={store} conversationId={conversationId} />
          </NoticeText>
        </Notice>
      ) : null}
      {store.vault?.locked && !needsDevice
        ? <Notice tone="warn"><NoticeText head={VAULT_LOCKED} /></Notice>
        : null}
      {syncError ? (
        <Notice tone="warn">
          <div className="enc-notice__row">
            <NoticeText head={SYNC_FAILED}>
              <p className="enc-notice__detail">{syncErrorMessage(syncError)}</p>
              <StartOver store={store} conversationId={conversationId} />
            </NoticeText>
            {onRetry ? (
              <Button size="sm" variant="ghost" onClick={onRetry}>
                {t('chat.encryption.retrySync')}
              </Button>
            ) : null}
          </div>
        </Notice>
      ) : null}
    </div>
  );
}
