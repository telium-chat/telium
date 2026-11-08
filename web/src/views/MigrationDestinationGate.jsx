import { useState } from 'react';
import { useStore } from '../hooks/useStore.jsx';
import { Api } from '../lib/api.js';
import { MAX_ACCOUNTS } from '../lib/accounts.js';
import { clearHandoff, pendingHandoff, sameServer } from '../lib/handoff.js';
import { useT } from '../lib/i18n/react.jsx';
import { errorMessage } from '../lib/i18n/errors.js';
import { Button, Notice } from '../components/index.js';

// The destination receiver is NOT a normal logged-in Telium shell. Every home
// uses the same telium.chat origin and the source tab must keep its session and
// migration wizard until it authorizes the move. In this screen, select an
// account from the registry and call /migrate/accept using THAT account's token.
// Do not call store.switchAccount(), store.addAccount() or store.save().
export function MigrationDestinationGate({ handoff, onSignIn, onCancel }) {
  const store = useStore();
  const t = useT();
  const [selected, setSelected] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const accounts = store.accounts();
  const destination = handoff?.destination || '';
  const guild = handoff?.subject_type === 'guild';
  const targetAccounts = accounts.filter((account) => {
    const home = account.session?.home;
    const identityHome = /^@[^:]+:(.+)$/.exec(account.user_id)?.[1];
    return Boolean(home?.token && home?.base
      && home?.user_id === account.user_id
      && sameServer(home.domain, destination)
      && sameServer(identityHome, destination));
  });
  const chosen = targetAccounts.find((account) => account.user_id === selected);
  const full = accounts.length >= MAX_ACCOUNTS;

  const confirm = async () => {
    if (!chosen || !handoff || busy) return;
    if (!pendingHandoff()) {
      setStatus(t('migration.handoff.expired'));
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const home = chosen.session.home;
      // An isolated API client, not store.home (which may be the SOURCE).
      const api = new Api({ base: home.base, token: home.token, domain: home.domain });
      const response = await api.acceptMigration({
        subject_type: handoff.subject_type === 'guild' ? 'guild' : 'user',
        source: handoff.source,
        source_id: handoff.source_id,
        handoff: { id: handoff.id, secret: handoff.secret },
      });
      if (!response?.delivered || response.target_id !== chosen.user_id) {
        throw new Error(t('migration.handoff.unexpectedTarget'));
      }
      clearHandoff();
      setDone({ target: chosen.user_id });
    } catch (error) {
      setStatus(t('migration.handoff.failed', { reason: errorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  if (!handoff) {
    return (
      <>
        <h1 className="pt-5 text-lg font-semibold">{t('migration.handoff.expiredTitle')}</h1>
        <Notice tone="warn">{t('migration.handoff.expired')}</Notice>
        <div className="pt-4">
          <Button variant="primary" onClick={onCancel}>{t('migration.handoff.back')}</Button>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <>
        <h1 className="pt-5 text-lg font-semibold">{t('migration.handoff.doneTitle')}</h1>
        <Notice tone="success">{t('migration.handoff.done', { target: done.target })}</Notice>
        <p className="pt-3 text-sm text-muted">{t('migration.handoff.returnToSource', { source: handoff.source })}</p>
        <Button variant="secondary" className="mt-4" onClick={onCancel}>
          {t('migration.handoff.close')}
        </Button>
      </>
    );
  }

  return (
    <>
      <h1 className="pt-5 text-lg font-semibold">
        {t('migration.handoff.title', { destination })}
      </h1>
      <p className="py-3 text-sm leading-[1.6] text-muted">
        {t('migration.handoff.explanation', {
          source: handoff.source,
          destination,
        })}
      </p>
      <Notice>{t(guild ? 'migration.handoff.notScheduledGuild' : 'migration.handoff.notScheduled')}</Notice>
      <div className="flex flex-col gap-2 pt-4">
        {targetAccounts.map((account) => (
          <Button
            key={account.user_id}
            variant={selected === account.user_id ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => { setSelected(account.user_id); setStatus(''); }}
          >
            {t('migration.handoff.useAccount', { account: account.user_id })}
          </Button>
        ))}
        <Button variant="secondary" disabled={busy || full} onClick={onSignIn}>
          {t('migration.handoff.signIn', { destination })}
        </Button>
        {full ? <Notice tone="warn">{t('migration.handoff.accountLimit', { max: MAX_ACCOUNTS })}</Notice> : null}
        {chosen ? (
          <>
            <Notice>
              {t(guild ? 'migration.handoff.confirmGuildTarget' : 'migration.handoff.confirmTarget', { sourceId: handoff.source_id, target: chosen.user_id })}
            </Notice>
            <Notice tone="warn">{t(guild ? 'migration.handoff.guildTargetWarning' : 'migration.handoff.targetWarning')}</Notice>
          </>
        ) : null}
        {status ? <p role="status" className="text-sm text-danger">{status}</p> : null}
        {chosen ? (
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {busy ? t('migration.handoff.sending') : t(guild ? 'migration.handoff.receiveGuild' : 'migration.handoff.receive')}
          </Button>
        ) : null}
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t('migration.handoff.back')}
        </Button>
      </div>
    </>
  );
}
