import { useEffect, useState } from 'react';
import { ed25519 } from '@noble/curves/ed25519.js';
import { useStore } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { discover } from '../../lib/api.js';
import { handoffLink } from '../../lib/handoff.js';
import { prettyHost } from '../../lib/homeserver.js';
import { b64url, unb64 } from '../../lib/util.js';
import { t } from '../../lib/i18n/index.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { codeOf, errorMessage } from '../../lib/i18n/errors.js';
import {
  Button, Field, ModalShell, Notice, TextInput,
} from '../../components/index.js';

const GUIDED_STEPS = 3;

const LOCAL_FAILURES = {
  migration_no_device_key: 'migration.schedule.noDeviceKey',
  migration_sign_failed: 'migration.schedule.signFailed',
};

function localFailure(code, detail, cause) {
  const error = new Error(detail || code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function reasonFor(error) {
  const local = LOCAL_FAILURES[error?.code];
  return local ? t(local) : errorMessage(error);
}

function report(error, key) {
  const reason = reasonFor(error);
  toast(t(key, { reason }), { error: true });
  return reason;
}

export function MigrationDialog({
  subjectType = 'user',
  subjectId = null,
  subjectName = '',
  close,
  onScheduled = null,
  discoverServer = discover,
  openWindow = openInNewWindow,
  pollMs = 2000,
}) {
  const store = useStore();
  useT();
  const [destination, setDestination] = useState('');
  const [importToken, setImportToken] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [scheduled, setScheduled] = useState(null);
  const [manual, setManual] = useState(false);

  const sourceDomain = store.session?.home?.domain || '';
  const guild = subjectType === 'guild';
  const movingId = guild
    ? subjectId
    : (store.me?.user_id || store.session?.home?.user_id || '');
  const title = guild ? t('migration.title.guild') : t('migration.title.account');

  const schedule = async () => {
    setBusy(true);
    setStatus(t('migration.schedule.signing'));
    try {
      const secret = store.session?.home?.device_secret;
      if (!secret) throw localFailure('migration_no_device_key');
      const body = {
        subject_type: subjectType,
        subject_id: subjectId,
        destination: prettyHost(destination),
        import_token: importToken.trim(),
      };
      const grant = await store.home.post('/_telium/v1/migrate/grant-payload', body);
      const signature = await signBytes(secret, unb64(grant.payload));
      setStatus(t('migration.schedule.scheduling'));
      const proof = await store.reauthProof(password);
      const resp = await store.home.startMigration({
        ...body,
        ...proof,
        device_signature: signature,
        created_at: grant.created_at,
      });
      setScheduled(resp);
      setPassword('');
      setStatus('');
      onScheduled?.(resp);
    } catch (err) {
      setStatus(report(err, 'migration.schedule.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (scheduled) {
    return (
      <ModalShell
        title={title}
        footer={<Button variant="primary" onClick={close}>{t('common.done')}</Button>}
      >
        <Notice tone="success">
          <Trans
            k="migration.scheduled.headline"
            values={{ destination: scheduled.destination, at: scheduled.executes_at }}
            components={{ b: <strong /> }}
          />
        </Notice>
        <Notice>{t('migration.scheduled.cancelHint')}</Notice>
      </ModalShell>
    );
  }

  if (!manual) {
    return (
      <GuidedMove
        subjectType={subjectType}
        subjectId={subjectId}
        subjectName={subjectName}
        close={close}
        onManual={() => setManual(true)}
        onScheduled={(resp) => { setScheduled(resp); onScheduled?.(resp); }}
        discoverServer={discoverServer}
        openWindow={openWindow}
        pollMs={pollMs}
      />
    );
  }

  return (
    <ModalShell
      title={title}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { setStatus(''); setManual(false); }}>
            {t('migration.manual.useGuided')}
          </Button>
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={
              busy
              || !destination.trim()
              || !importToken.trim()
              || !password
            }
            onClick={schedule}
          >
            {busy ? t('migration.schedule.busy') : t('migration.schedule.action')}
          </Button>
        </>
      )}
    >
      <Notice>
        <div className="flex flex-col gap-1.5">
          <strong>{t('migration.manual.step1', { step: 1 })}</strong>
          <span>{t('migration.manual.step1Where')}</span>
          <span>{t('migration.manual.step1Which')}</span>
        </div>
      </Notice>

      <div className="flex flex-col gap-2 panel px-3 py-2.5">
        <SourceValue label={t('migration.field.oldServer')} value={sourceDomain} />
        <SourceValue
          label={guild ? t('migration.field.oldGuildId') : t('migration.field.oldAccountId')}
          value={movingId}
        />
      </div>

      <Field
        label={t('migration.field.destination')}
        hint={t('migration.manual.destinationHint')}
      >
        <TextInput
          value={destination}
          placeholder={t('migration.field.destinationPlaceholder')}
          onChange={(e) => setDestination(e.target.value)}
        />
      </Field>

      <Field
        label={t('migration.importCode.label')}
        hint={t('migration.importCode.sourceHint')}
      >
        <TextInput
          value={importToken}
          placeholder={t('migration.importCode.placeholder')}
          onChange={(e) => setImportToken(e.target.value)}
        />
      </Field>

      <Notice>
        <div className="flex flex-col gap-1.5">
          <strong>{t('migration.manual.step2', { step: 2 })}</strong>
          <span>{t('migration.manual.step2Password')}</span>
          <span>{t('migration.manual.step2Cooling')}</span>
        </div>
      </Notice>

      <Field
        label={t('migration.field.password')}
        hint={t('migration.field.passwordHint')}
      >
        <TextInput
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {status ? (
        <p className="text-xs leading-[1.5] text-muted" role="status">{status}</p>
      ) : null}
    </ModalShell>
  );
}

function SourceValue({ label, value }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</div>
        <div className="break-all font-mono text-sm text-foreground">{value || t('common.empty')}</div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={!value}
        onClick={() => copyToClipboard(value, label)}
      >
        {t('common.copy')}
      </Button>
    </div>
  );
}

// Not WebCrypto: SubtleCrypto can be absent on Tauri Android's http origin.
export async function signBytes(secretB64, payload) {
  const seed = unb64(secretB64);
  if (seed.length !== 32) {
    throw localFailure('migration_sign_failed', 'stored device key is not a 32-byte seed');
  }
  try {
    return b64url(ed25519.sign(payload, seed));
  } catch (cause) {
    throw localFailure('migration_sign_failed', 'ed25519 signing failed', cause);
  }
}

function openInNewWindow(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function GuidedMove({
  subjectType, subjectId, subjectName, close, onManual, onScheduled, discoverServer, openWindow, pollMs,
}) {
  const store = useStore();
  useT();
  const [destination, setDestination] = useState('');
  const [handoff, setHandoff] = useState(null);
  const [link, setLink] = useState('');
  const [delivered, setDelivered] = useState(null);
  const [noClient, setNoClient] = useState(false);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const guild = subjectType === 'guild';
  const title = guild ? t('migration.title.guild') : t('migration.title.account');
  const movingId = guild ? subjectId : (store.me?.user_id || store.session?.home?.user_id || '');
  const subject = guild ? { subject_type: 'guild', subject_id: subjectId } : null;
  const kind = guild ? 'guild' : 'user';

  const restart = (line) => {
    setHandoff(null);
    setDelivered(null);
    setLink('');
    setStatus(line);
  };

  useEffect(() => {
    if (!handoff || delivered) return undefined;
    let live = true;
    const check = async () => {
      try {
        const now = await store.home.migrationHandoff(handoff.id);
        if (!live) return;
        if (now.state === 'delivered') {
          setDelivered(now);
          setStatus('');
        } else if (now.state === 'expired' || now.state === 'used') {
          setHandoff(null);
          setLink('');
          setStatus(t('migration.guided.linkExpired'));
        }
      } catch { /* try again on the next tick */ }
    };
    const timer = setInterval(check, pollMs);
    return () => { live = false; clearInterval(timer); };
  }, [store, handoff, delivered, pollMs]);

  const begin = async () => {
    setBusy(true);
    setNoClient(false);
    const target = prettyHost(destination);
    setStatus(t('migration.guided.lookingUp', { destination: target }));
    try {
      const info = await discoverServer(target);
      if (!info?.client) {
        setNoClient(true);
        setStatus('');
        return;
      }
      const named = info.server_name || target;
      const opened = subject
        ? await store.home.openMigrationHandoff(named, subject)
        : await store.home.openMigrationHandoff(named);
      const url = handoffLink(info.client, guild ? { ...opened, name: subjectName } : opened);
      setHandoff(opened);
      setLink(url);
      setStatus('');
      openWindow(url);
    } catch (err) {
      setStatus(report(err, 'migration.guided.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const schedule = async () => {
    setBusy(true);
    setStatus(t('migration.schedule.signing'));
    try {
      const secret = store.session?.home?.device_secret;
      if (!secret) throw localFailure('migration_no_device_key');
      const body = {
        ...(subject || { subject_type: 'user' }),
        destination: handoff.destination,
        handoff_id: handoff.id,
      };
      const grant = await store.home.post('/_telium/v1/migrate/grant-payload', body);
      const signature = await signBytes(secret, unb64(grant.payload));
      setStatus(t('migration.schedule.scheduling'));
      const proof = await store.reauthProof(password);
      const resp = await store.home.startMigration({
        ...body,
        ...proof,
        device_signature: signature,
        created_at: grant.created_at,
      });
      setPassword('');
      setStatus('');
      onScheduled(resp);
    } catch (err) {
      if (codeOf(err) === 'migration_handoff_invalid') {
        setPassword('');
        restart(t('migration.guided.linkExpired'));
        toast(t('migration.schedule.failed', { reason: errorMessage(err) }), { error: true });
      } else {
        setStatus(report(err, 'migration.schedule.failed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const statusLine = status ? (
    <p className="text-xs leading-[1.5] text-muted" role="status">{status}</p>
  ) : null;

  const step = (current) => t('migration.guided.step', { current, total: GUIDED_STEPS });

  if (delivered) {
    return (
      <ModalShell
        title={title}
        subtitle={step(3)}
        footer={(
          <>
            <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={busy || !password} onClick={schedule}>
              {busy ? t('migration.schedule.busy') : t('migration.schedule.action')}
            </Button>
          </>
        )}
      >
        <Notice tone="success">
          <Trans
            k="migration.guided.ready"
            values={{
              destination: handoff.destination,
              subject: kind,
              name: guild ? (subjectName || movingId) : movingId,
              target: delivered.target_id,
            }}
            components={{ b: <strong />, id: <span className="font-mono" /> }}
          />
        </Notice>
        <Notice>{t('migration.guided.authorize')}</Notice>
        <Field
          label={t('migration.field.password')}
          hint={t('migration.field.passwordHint')}
        >
          <TextInput
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {statusLine}
      </ModalShell>
    );
  }

  if (handoff) {
    return (
      <ModalShell
        title={title}
        subtitle={step(2)}
        footer={(
          <>
            <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button variant="ghost" onClick={() => openWindow(link)}>
              {t('migration.guided.openAgain')}
            </Button>
          </>
        )}
      >
        <Notice>
          <Trans
            k="migration.guided.finishThere"
            values={{ destination: handoff.destination, subject: kind }}
            components={{ b: <strong /> }}
          />
        </Notice>
        <p className="text-sm text-muted" role="status">
          {t('migration.guided.waiting', {
            destination: handoff.destination,
            expiresAt: handoff.expires_at,
          })}
        </p>
        <p className="break-all text-xs text-muted">
          <Trans
            k="migration.guided.noWindow"
            values={{ url: link.split('#')[0] }}
            components={{ a: <a href={link} target="_blank" rel="noopener noreferrer" /> }}
          />
        </p>
        {statusLine}
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={title}
      subtitle={step(1)}
      footer={(
        <>
          <Button variant="ghost" onClick={onManual}>{t('migration.guided.useCode')}</Button>
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={busy || !destination.trim()} onClick={begin}>
            {busy ? t('migration.guided.opening') : t('migration.guided.continue')}
          </Button>
        </>
      )}
    >
      <Notice>{t('migration.guided.intro', { subject: kind })}</Notice>
      <Field label={t('migration.field.destination')}>
        <TextInput
          value={destination}
          placeholder={t('migration.field.destinationPlaceholder')}
          onChange={(e) => { setDestination(e.target.value); setNoClient(false); }}
        />
      </Field>
      {noClient ? (
        <Notice tone="warn">
          {t('migration.guided.noClient', { destination: destination.trim() })}
        </Notice>
      ) : null}
      {statusLine}
    </ModalShell>
  );
}
