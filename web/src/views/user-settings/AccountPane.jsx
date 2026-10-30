import { useEffect, useState } from 'react';
import { useAsync, useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { t as i18nT } from '../../lib/i18n/index.js';
import { useModal } from '../../hooks/useModal.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { bytes, dayOf, relative } from '../../lib/util.js';
import {
  Async, Button, ChoiceCard, ChoiceList, DataTable, Field, GlobeIcon, Hint, HomeIcon,
  LinkIcon, Notice, Section, Select, TextInput, useDialogs,
} from '../../components/index.js';
import { MigrationDialog } from './MigrationDialog.jsx';
import { ReceiveMigrationDialog } from './ReceiveMigrationDialog.jsx';

const TIERS = [
  [1, HomeIcon, 'settings.media.tier1', 'settings.media.tier1Desc'],
  [2, GlobeIcon, 'settings.media.tier2', 'settings.media.tier2Desc'],
  [3, LinkIcon, 'settings.media.tier3', 'settings.media.tier3Desc'],
];

function AccountBundle({ store }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    try {
      const bundle = await store.accountBundle(password);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `telium-account-bundle-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(href);
      setPassword('');
    } catch (e) {
      reportError(e, 'Could not download the account bundle');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      <div>
        {'You can also download a signed copy of your account. It needs your password.'}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TextInput
          type="password"
          autoComplete="current-password"
          aria-label="Password for the account bundle"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button disabled={busy || !password} onClick={download}>Download account bundle</Button>
      </div>
    </div>
  );
}

export function AccountPane({ onClose }) {
  const store = useStore();
  const modal = useModal();
  const dialogs = useDialogs();
  const state = useAsync(() => Promise.all([
    store.home.migrations().then((r) => r.migrations || []).catch(() => []),
    store.home.sunset().catch(() => null),
    store.home.mediaPreference().catch(() => ({ tier: 1, origin: null })),
    store.home.mediaRegistry().then((r) => ({
      hosts: r.hosts || [], externalHosts: r.external_hosts || [],
    })).catch(() => ({ hosts: [], externalHosts: [] })),
    store.home.mediaRegistryFeeds().then((r) => r.hosts || []).catch(() => []),
  ]).then(([migrations, sunset, media, registry, feedHosts]) => ({
    migrations,
    sunset,
    media,
    hosts: registry.hosts,
    externalHosts: registry.externalHosts,
    feedHosts,
  })), []);

  return (
    <>
      <Async state={state}>
        {({ migrations, sunset, media, hosts, externalHosts, feedHosts }) => (
          <>
            {sunset && sunset.mode && sunset.mode !== 'none' ? (
              <Section>
                <Notice tone="warn">
                  <strong>
                    {sunset.mode === 'relocate'
                      ? `${sunset.domain} is relocating to ${sunset.new_domain}.`
                      : `${sunset.domain} has announced that it is shutting down.`}
                  </strong>
                  {sunset.message ? <div>{sunset.message}</div> : null}
                  {sunset.effective_at ? (
                    <div>
                      {`Effective ${dayOf(sunset.effective_at)} - ${relative(sunset.effective_at)}.`}
                    </div>
                  ) : null}
                  <div>
                    {'Your id keeps working after the move.'}
                  </div>
                  {sunset.mode === 'shutdown' ? <AccountBundle store={store} /> : null}
                </Notice>
              </Section>
            ) : null}

            <MediaTierSection
              store={store}
              pref={media}
              hosts={hosts}
              feedHosts={feedHosts}
              externalHosts={externalHosts}
            />

            <Section title="Receive a move on this server">
              <Hint>
                {'Only needed when the old server could not send you here directly. '
                  + 'This creates a single-use import code; nothing moves yet.'}
              </Hint>
              <Button
                className="self-start"
                onClick={() => modal.open((close) => (
                  <ReceiveMigrationDialog close={close} />
                ))}
              >
                Prepare to receive
              </Button>
            </Section>

            <Section title="Move this account">
              <Hint>
                {'Name the server you are moving to, then authorise the move here with '
                  + 'your password. Every active device gets a window in which it can cancel.'}
              </Hint>
              {migrations.length ? (
                <DataTable
                  rows={migrations}
                  rowKey={(m) => m.id}
                  columns={[
                    { key: 'destination', header: 'Destination', render: (m) => m.destination },
                    { key: 'state', header: 'State', render: (m) => m.state },
                    {
                      key: 'executes',
                      header: 'Executes',
                      render: (m) => (m.executes_at ? relative(m.executes_at) : '-'),
                    },
                    {
                      key: 'cancel',
                      header: '',
                      render: (m) => (['pending', 'ready'].includes(m.state) ? (
                        <Button
                          variant="danger-soft"
                          onClick={async () => {
                            try { await store.home.cancelMigration(m.id); state.reload(); }
                            catch (e) { reportError(e, 'Could not cancel'); }
                          }}
                        >
                          Cancel
                        </Button>
                      ) : null),
                    },
                  ]}
                />
              ) : null}
              <Button
                className="self-start"
                onClick={() => modal.open((close) => (
                  <MigrationDialog
                    subjectType="user"
                    close={close}
                    onScheduled={() => state.reload()}
                  />
                ))}
              >
                Start a move
              </Button>
            </Section>

            <AccountSafetySections store={store} onClose={onClose} />

            <Section title="Sign out">
              <Hint>Other devices are untouched.</Hint>
              <Button
                variant="danger"
                className="self-start"
                onClick={() => dialogs.confirm({
                  title: 'Sign out',
                  body: 'You will need your password to sign back in.',
                  confirmLabel: 'Sign out',
                  danger: true,
                  onConfirm: () => { onClose?.(); store.signOut(); },
                })}
              >
                Sign out
              </Button>
            </Section>
          </>
        )}
      </Async>
    </>
  );
}

function AccountSafetySections({ store, onClose }) {
  const dialogs = useDialogs();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const finishSignOut = () => {
    onClose?.();
    store.signOut();
  };

  const downloadExport = async () => {
    try {
      const data = await store.home.accountExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `telium-account-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(href);
    } catch (e) { reportError(e, 'Could not export account data'); }
  };

  return (
    <>
      <RecoveryEmailSection store={store} />
      <MembershipMovesSection store={store} />

      <Section title="Your data">
        <Hint>
          {'Your account, profile, memberships, uploads and settings, as JSON. The export '
            + 'lists what it leaves out and why, including guild messages and anything other '
            + 'servers hold.'}
        </Hint>
        <Button className="self-start" onClick={downloadExport}>Download account export</Button>
      </Section>

      <Section title="Account sessions">
        <Hint>
          {'Revokes every session and device, including this one. You will be returned to sign in.'}
        </Hint>
        <Button
          variant="danger-soft"
          className="self-start"
          onClick={() => dialogs.confirm({
            title: 'Sign out everywhere',
            body: 'Every device session will be revoked, including this one.',
            confirmLabel: 'Sign out everywhere',
            danger: true,
            onConfirm: async () => {
              try { await store.home.logoutAll(); finishSignOut(); }
              catch (e) { reportError(e, 'Could not revoke sessions'); }
            },
          })}
        >
          Sign out everywhere
        </Button>
      </Section>

      <Section title="Deactivate or delete account">
        <Hint>
          {'Deactivation disables sign-in but keeps the account. Deletion cannot be reversed: '
            + 'it erases your private state on this server and tells the servers you federated '
            + 'with that the account is gone. Messages you sent stay in the guilds you sent '
            + 'them to, and copies already held by other servers are theirs to keep -- this '
            + 'server can ask, not compel. Your username is not released for reuse. '
            + 'Either action needs your password.'}
        </Hint>
        <Field label="Password">
          <TextInput
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger-soft"
            disabled={busy || !password}
            onClick={() => dialogs.confirm({
              title: 'Deactivate account',
              body: 'You will be signed out everywhere and this account will no longer accept logins.',
              confirmLabel: 'Deactivate',
              danger: true,
              onConfirm: async () => {
                setBusy(true);
                try {
                  const proof = await store.reauthProof(password);
                  await store.home.deactivateAccount(proof);
                  finishSignOut();
                }
                catch (e) { reportError(e, 'Could not deactivate account'); setBusy(false); }
              },
            })}
          >
            Deactivate
          </Button>
          <Button
            variant="danger"
            disabled={busy || !password}
            onClick={() => dialogs.confirm({
              title: 'Permanently delete account',
              body: 'This erases your private state on this server, permanently disables the '
                + 'account and notifies the servers you federated with. Messages you sent to '
                + 'guilds stay there, and other servers keep what they already hold. This '
                + 'cannot be undone.',
              confirmLabel: 'Delete permanently',
              danger: true,
              onConfirm: async () => {
                setBusy(true);
                try {
                  const proof = await store.reauthProof(password);
                  await store.home.deleteAccount(proof);
                  finishSignOut();
                }
                catch (e) { reportError(e, 'Could not delete account'); setBusy(false); }
              },
            })}
          >
            Delete permanently
          </Button>
        </div>
      </Section>
    </>
  );
}

export function MediaTierSection({ store, pref, hosts, feedHosts = [], externalHosts }) {
  const tr = useT();
  const home = store.session?.home?.domain;
  const account = home ? store.caps.get(home)?.account : null;
  const usage = account?.quota_bytes
    ? { used: account.used_bytes ?? 0, quota: account.quota_bytes, home }
    : null;
  const [tier, setTier] = useState(pref.tier || 1);
  const offered = [
    ...hosts.map((h) => ({ ...h, vouched_by: null })),
    ...feedHosts.filter((h) => !hosts.some((r) => r.origin === h.origin)),
  ];
  const listed = offered.some((h) => h.origin === pref.origin);
  const [choice, setChoice] = useState(() => {
    if (listed) return pref.origin;
    return pref.origin ? 'custom' : (offered[0]?.origin || 'custom');
  });
  const [custom, setCustom] = useState(listed ? '' : (pref.origin || ''));
  const [busy, setBusy] = useState(false);
  const origin = choice === 'custom' ? custom.trim() : choice;

  const save = async () => {
    setBusy(true);
    try {
      await store.setMediaPreference(tier, tier === 2 ? origin : null);
      toast(tr('settings.media.savedToast'));
    } catch (e) { reportError(e, tr('settings.media.saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <Section title={tr('settings.media.sectionTitle')}>
      <Hint>{tr('settings.media.followsAccount')}</Hint>
      <ChoiceList value={tier} onChange={setTier} aria-label={tr('settings.media.sectionTitle')}>
        {TIERS.map(([value, icon, label, description]) => (
          <ChoiceCard
            key={value}
            value={value}
            icon={icon}
            label={tr(label)}
            description={tr(description)}
          />
        ))}
      </ChoiceList>

      {usage ? (
        usage.used / usage.quota > 0.9 ? (
          <Notice tone="warn">
            {tr('settings.media.usageWarn', {
              used: bytes(usage.used), quota: bytes(usage.quota), home: usage.home,
            })}
          </Notice>
        ) : (
          <Hint>{tr('settings.media.usage', {
            used: bytes(usage.used), quota: bytes(usage.quota), home: usage.home,
          })}</Hint>
        )
      ) : null}

      {tier === 2 ? (
        <>
          <Field
            label={tr('settings.media.hostLabel')}
            hint={offered.length
              ? tr('settings.media.hostsRecommended')
              : tr('settings.media.hostsNone')}
          >
            <Select
              value={choice}
              options={[
                ...offered.map((h) => [h.origin, hostLabel(h)]),
                ['custom', tr('settings.media.anotherHost')],
              ]}
              onChange={(e) => setChoice(e.target.value)}
            />
          </Field>
          {choice === 'custom' ? (
            <Field
              label={tr('settings.media.originLabel')}
              hint={tr('settings.media.originHint')}
            >
              <TextInput
                value={custom}
                placeholder="files.example.org"
                onChange={(e) => setCustom(e.target.value)}
              />
            </Field>
          ) : (
            <HostDetail host={offered.find((h) => h.origin === choice)} />
          )}
        </>
      ) : null}

      {tier === 3 ? (
        <div className="flex flex-col gap-1.5">
          {externalHosts.length ? (
            <>
              <div className="text-sm font-medium text-foreground">{tr('settings.media.externalEnabled')}</div>
              {externalHosts.map((host) => <ExternalHostDetail key={host.id} host={host} />)}
            </>
          ) : (
            <Notice tone="warn">{tr('settings.media.externalNone')}</Notice>
          )}
        </div>
      ) : null}

      <Button
        variant="primary"
        className="self-start"
        disabled={busy || (tier === 2 && !origin) || (tier === 3 && !externalHosts.length)}
        onClick={save}
      >
        {tr('common.save')}
      </Button>
    </Section>
  );
}

function vouchers(host) {
  const names = (host?.vouched_by || []).map((v) => v.curator || v.feed).filter(Boolean);
  if (!names.length) return null;
  return i18nT('settings.media.vouchedBy', { names: names.join(', ') });
}

function hostLabel(host) {
  const name = host.name || host.origin;
  const names = (host.vouched_by || []).map((v) => v.curator || v.feed).filter(Boolean);
  const tr = i18nT;
  return names.length ? tr('settings.media.via', { name, names: names.join(', ') }) : name;
}

function HostDetail({ host }) {
  const tr = useT();
  if (!host) return null;
  return (
    <Hint>
      {[
        host.description,
        host.max_file_bytes ? tr('settings.media.upTo', { size: bytes(host.max_file_bytes) }) : null,
        host.abuse_contact ? tr('settings.media.abuseContact', { contact: host.abuse_contact }) : null,
        vouchers(host),
      ].filter(Boolean).join(' ')}
    </Hint>
  );
}

function ExternalHostDetail({ host }) {
  const tr = useT();
  if (!host) return null;
  return (
    <Hint>
      {[
        `${host.name || host.id} (${host.domain})`,
        host.description,
        host.max_file_bytes ? tr('settings.media.upTo', { size: bytes(host.max_file_bytes) }) : null,
      ].filter(Boolean).join(' ')}
    </Hint>
  );
}

export function RecoveryEmailSection({ store }) {
  const [current, setCurrent] = useState(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useStoreEvent('recovery-email');
  const pushed = store.recoveryEmail;

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => store.home.recoveryEmail())
      .then((r) => { if (live) { setCurrent(r); setEmail(r.pending_email || r.verified_email || ''); } })
      .catch(() => { if (live) setCurrent(null); });
    return () => { live = false; };
  }, [store]);

  useEffect(() => {
    if (pushed) setCurrent(pushed);
  }, [pushed]);

  if (!current) return null;

  const offered = store.supports(store.session?.home?.domain, 'recovery_email');
  const onFile = current.verified_email || current.pending_email;
  if (!offered && !onFile) return null;

  const save = async () => {
    setBusy(true);
    try {
      const proof = await store.reauthProof(password);
      const saved = await store.home.setRecoveryEmail({ email: email.trim() || null, ...proof });
      setCurrent(saved);
      setEmail(saved.pending_email || saved.verified_email || '');
      setPassword('');
      if (!saved.pending_email && !saved.verified_email) toast('Recovery email removed');
      else if (saved.challenge_sent === false) {
        reportError(
          new Error(saved.challenge_error || 'The confirmation could not be sent.'),
          'The address was saved but no confirmation was sent',
        );
      } else toast('Check that inbox for a confirmation link');
    } catch (e) {
      reportError(e, 'Could not change the recovery email');
    } finally {
      setBusy(false);
    }
  };

  const typed = email.trim() || null;
  const unchanged = typed === (current.pending_email || current.verified_email || null);

  return (
    <Section title="Recovery email">
      <Hint>
        {'A requested account move is warned about here, with a link that cancels it. '
          + 'An address is only used once the mailbox has confirmed it, and changing '
          + 'this needs your password.'}
      </Hint>
      {offered ? null : (
        <Notice tone="warn">
          This server can no longer send email, so nothing will be sent to this address.
          You can still remove it. Your devices continue to show a warning.
        </Notice>
      )}
      {current.state === 'verified' ? (
        <Notice tone="success">
          {`Confirmed: ${current.verified_email}. Security warnings about this account go here.`}
        </Notice>
      ) : null}
      {current.state === 'pending' ? (
        <Notice tone="warn">
          {`Waiting for ${current.pending_email} to confirm. `
            + (current.verified_email
              ? `Until it does, warnings still go to ${current.verified_email}.`
              : 'Until it does, this account has no recovery address.')}
        </Notice>
      ) : null}
      {current.state === 'bounced' ? (
        <Notice tone="warn">
          {'That address stopped accepting mail, so it is no longer a recovery address'
            + `${current.bounce_reason ? ` (${current.bounce_reason})` : ''}. `
            + 'Add another one to get warnings again.'}
        </Notice>
      ) : null}
      <Field label="Recovery email">
        <TextInput
          type="email"
          autoComplete="email"
          value={email}
          disabled={!offered}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Current password">
        <TextInput
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button
        className="self-start"
        disabled={busy || !password || unchanged || (!offered && typed !== null)}
        onClick={save}
      >
        {typed ? 'Send a confirmation' : 'Remove recovery email'}
      </Button>
    </Section>
  );
}

const MOVE_STATE = {
  pending: 'Waiting to be told',
  done: 'Moved',
  failed: 'Gave up',
};

export function MembershipMovesSection({ store }) {
  const [moves, setMoves] = useState(undefined);
  const [busy, setBusy] = useState(false);

  const load = () => Promise.resolve()
    .then(() => store.home.membershipMoves())
    .then((r) => setMoves(r?.moves || []))
    .catch(() => setMoves(null));

  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => store.home.membershipMoves())
      .then((r) => { if (live) setMoves(r?.moves || []); })
      .catch(() => { if (live) setMoves(null); });
    return () => { live = false; };
  }, [store]);

  if (!moves || moves.length === 0) return null;
  const failed = moves.filter((m) => m.state === 'failed').length;

  const retry = async () => {
    setBusy(true);
    try {
      const r = await store.home.retryMembershipMoves();
      toast(`${r?.retried ?? failed} server${(r?.retried ?? failed) === 1 ? '' : 's'} queued again`);
      await load();
    } catch (e) {
      reportError(e, 'Could not queue the guild servers again');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Guild memberships that moved here">
      <Hint>A server that is offline is tried again later.</Hint>
      <ul className="flex flex-col gap-2" aria-label="Guild servers">
        {moves.map((m) => (
          <li key={m.id} className="flex flex-col">
            <span>
              <strong>{m.guild_server}</strong>
              {` — ${MOVE_STATE[m.state] || m.state}`}
              {` (${m.guild_ids?.length ?? 0} guild${m.guild_ids?.length === 1 ? '' : 's'})`}
            </span>
            {m.state === 'pending' && m.attempts > 0 ? (
              <span className="text-sm opacity-70">
                {`Tried ${m.attempts} time${m.attempts === 1 ? '' : 's'}; next at ${new Date(m.next_attempt_at).toLocaleString()}`}
              </span>
            ) : null}
            {m.last_error && m.state !== 'done' ? (
              <span className="text-sm opacity-70">{m.last_error}</span>
            ) : null}
          </li>
        ))}
      </ul>
      {failed > 0 ? (
        <Button className="self-start" disabled={busy} onClick={retry}>
          Try again
        </Button>
      ) : null}
    </Section>
  );
}
