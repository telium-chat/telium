import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { sameServer } from '../../lib/handoff.js';
import { prettyHost } from '../../lib/homeserver.js';
import { t } from '../../lib/i18n/index.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { errorMessage } from '../../lib/i18n/errors.js';
import {
  Button, Field, ModalShell, Notice, Select, TextInput,
} from '../../components/index.js';

function report(error, key) {
  const reason = errorMessage(error);
  toast(t(key, { reason }), { error: true });
  return reason;
}

export function ReceiveMigrationDialog({ close, handoff = null }) {
  const store = useStore();
  useT();
  const homeDomain = store.session?.home?.domain || '';
  const [subjectType, setSubjectType] = useState('user');
  const [source, setSource] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [claim, setClaim] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  if (handoff) {
    return <ReceiveHandoff handoff={handoff} close={close} />;
  }

  const changeType = (next) => {
    setSubjectType(next);
    setSource('');
    setSourceId('');
    setClaim(null);
    setStatus('');
  };

  const changeSourceId = (value) => {
    setSourceId(value);
    if (subjectType === 'user') setSource(sourceFromUserId(value));
  };

  const prepare = async () => {
    setBusy(true);
    setStatus(t('migration.receive.preparing'));
    try {
      const next = await store.home.acceptMigration({
        subject_type: subjectType,
        source: prettyHost(source),
        source_id: sourceId.trim(),
      });
      setClaim(next);
      setStatus('');
    } catch (err) {
      setStatus(report(err, 'migration.receive.prepareFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (claim) {
    const destination = claim.destination || homeDomain || t('migration.receive.thisServer');
    return (
      <ModalShell
        title={t('migration.receive.title')}
        footer={(
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setClaim(null);
                setStatus('');
              }}
            >
              {t('migration.receive.another')}
            </Button>
            <Button variant="primary" onClick={close}>{t('common.done')}</Button>
          </>
        )}
      >
        <Notice tone="success">
          <Trans
            k="migration.receive.ready"
            values={{ destination }}
            components={{ b: <strong /> }}
          />
        </Notice>

        <Field
          label={t('migration.importCode.label')}
          hint={t('migration.importCode.hint')}
        >
          <div className="flex items-center gap-2">
            <TextInput
              aria-label={t('migration.importCode.label')}
              value={claim.import_token || ''}
              readOnly
              className="font-mono"
            />
            <Button
              size="sm"
              onClick={() => copyToClipboard(claim.import_token || '', t('migration.importCode.label'))}
            >
              {t('common.copy')}
            </Button>
          </div>
        </Field>

        <Notice>
          <div className="flex flex-col gap-1">
            <strong>{t('migration.receive.nextTitle')}</strong>
            <span>{t('migration.receive.nextUse', { destination })}</span>
            <span>
              {t('migration.receive.approvalFor', {
                subjectId: claim.source_id || sourceId,
                source,
              })}
            </span>
            {claim.expires_at ? (
              <span>{t('migration.receive.expires', { expiresAt: claim.expires_at })}</span>
            ) : null}
          </div>
        </Notice>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={t('migration.receive.title')}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            disabled={busy || !source.trim() || !sourceId.trim()}
            onClick={prepare}
          >
            {busy ? t('migration.receive.creating') : t('migration.receive.create')}
          </Button>
        </>
      )}
    >
      <Notice>
        <Trans
          k="migration.receive.intro"
          values={{ destination: homeDomain || t('migration.receive.thisServer') }}
          components={{ b: <strong /> }}
        />
      </Notice>

      <Field label={t('migration.receive.subject')}>
        <Select
          value={subjectType}
          options={[
            ['user', t('migration.receive.subjectAccount')],
            ['guild', t('migration.receive.subjectGuild')],
          ]}
          onChange={(e) => changeType(e.target.value)}
        />
      </Field>

      <Field
        label={subjectType === 'guild'
          ? t('migration.field.oldGuildId')
          : t('migration.field.oldAccountId')}
        hint={subjectType === 'user'
          ? t('migration.receive.accountIdHint')
          : t('migration.receive.guildIdHint')}
      >
        <TextInput
          value={sourceId}
          placeholder={subjectType === 'guild'
            ? t('migration.receive.guildIdPlaceholder')
            : t('migration.receive.accountIdPlaceholder')}
          onChange={(e) => changeSourceId(e.target.value)}
        />
      </Field>

      <Field
        label={t('migration.field.oldServer')}
        hint={subjectType === 'user'
          ? t('migration.receive.sourceFromId')
          : t('migration.receive.sourceGuildHint')}
      >
        <TextInput
          value={source}
          readOnly={subjectType === 'user'}
          placeholder={t('migration.receive.sourcePlaceholder')}
          onChange={(e) => setSource(e.target.value)}
        />
      </Field>

      {subjectType === 'guild' ? (
        <Notice>{t('migration.receive.guildOwner')}</Notice>
      ) : null}

      {status ? (
        <p className="text-xs leading-[1.5] text-muted" role="status">{status}</p>
      ) : null}
    </ModalShell>
  );
}

function sourceFromUserId(value) {
  const separator = value.indexOf(':');
  return separator > 0 ? value.slice(separator + 1).trim() : '';
}

function ReceiveHandoff({ handoff, close }) {
  const store = useStore();
  useT();
  const homeDomain = store.session?.home?.domain || '';
  const me = store.session?.home?.user_id || store.me?.user_id || '';
  const guild = handoff.subject_type === 'guild';
  const kind = guild ? 'guild' : 'user';
  const guildLabel = handoff.name
    ? t('migration.confirm.guildNamed', { name: handoff.name, id: handoff.source_id })
    : handoff.source_id;
  const [done, setDone] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  if (!sameServer(homeDomain, handoff.destination)) {
    return (
      <ModalShell
        title={t('migration.receive.title')}
        footer={<Button variant="primary" onClick={close}>{t('common.close')}</Button>}
      >
        <Notice tone="warn">
          <Trans
            k="migration.confirm.wrongServer"
            values={{
              subject: kind,
              destination: handoff.destination,
              here: homeDomain || t('migration.confirm.anotherServer'),
            }}
            components={{ b: <strong /> }}
          />
        </Notice>
      </ModalShell>
    );
  }

  const confirm = async () => {
    setBusy(true);
    setStatus(t('migration.confirm.sending', { source: handoff.source }));
    try {
      const resp = await store.home.acceptMigration({
        subject_type: guild ? 'guild' : 'user',
        source: handoff.source,
        source_id: handoff.source_id,
        handoff: { id: handoff.id, secret: handoff.secret },
      });
      setDone(resp);
      setStatus('');
    } catch (err) {
      setStatus(report(err, 'migration.confirm.failed'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <ModalShell
        title={t('migration.receive.title')}
        footer={<Button variant="primary" onClick={close}>{t('common.done')}</Button>}
      >
        <Notice tone="success">
          <Trans
            k="migration.confirm.done"
            values={{
              source: handoff.source,
              subject: kind,
              target: done.target_id || me,
            }}
            components={{ b: <strong /> }}
          />
        </Notice>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title={t('migration.receive.title')}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>{t('migration.confirm.notNow')}</Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {busy ? t('migration.confirm.confirming') : t('migration.confirm.receive', { subject: kind })}
          </Button>
        </>
      )}
    >
      {guild ? (
        <Notice>
          <Trans
            k="migration.confirm.guild"
            values={{
              guild: guildLabel,
              source: handoff.source,
              me: me || t('migration.confirm.thisAccount'),
            }}
            components={{ b: <strong /> }}
          />
        </Notice>
      ) : (
        <Notice>
          <Trans
            k="migration.confirm.account"
            values={{
              subjectId: handoff.source_id,
              source: handoff.source,
              me: me || t('migration.confirm.thisAccount'),
            }}
            components={{ b: <strong /> }}
          />
        </Notice>
      )}
      <Notice>
        {t('migration.confirm.notYou', { subject: kind, source: handoff.source })}
      </Notice>
      {status ? (
        <p className="text-xs leading-[1.5] text-muted" role="status">{status}</p>
      ) : null}
    </ModalShell>
  );
}
