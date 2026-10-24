import { useCallback, useMemo, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  Button, Field, Hint, Notice, Pill, SearchField, Section, Select, TextArea,
} from '../../components/index.js';
import { Fact, Facts, Pager, Tile, usePages } from './Bits.jsx';
import { DangerAction, Elevation } from './StepUp.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, clock, count, present } from './format.js';

const PAGE = 50;

const STATUSES = [
  ['all', 'Everything'],
  ['active', 'Active'],
  ['suspended', 'Switched off'],
  ['deleted', 'Deleted'],
  ['admins', 'Administrators'],
];

function stateOf(a) {
  if (a.deleted_at) return 'deleted';
  if (a.suspended_at) return 'suspended';
  if (a.deactivated) return 'off';
  return 'active';
}

const WORDS = {
  deleted: { tone: 'default', label: 'deleted' },
  suspended: { tone: 'danger', label: 'suspended by an operator' },
  off: { tone: 'warn', label: 'switched off by its owner' },
  active: null,
};

function unsuspendable(a, me) {
  if (a.deleted_at) return 'This account has been deleted; there is nothing left to switch off.';
  if (a.user_id === me) {
    return 'This is your own account. Suspending it would sign you out of the console you '
      + 'would need in order to undo it, so the server refuses.';
  }
  if (a.admin) {
    return 'This account is a server administrator. Take the admin flag away first — an '
      + 'operator who can suspend their peers can take the server on their own.';
  }
  if (a.deactivated) return 'This account is already switched off.';
  return null;
}

export function AccountsPane() {
  const { home, stepUp } = useControlPlane();
  const store = useStore();
  const me = store.me?.user_id || store.session?.home?.user_id || null;

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [total, setTotal] = useState(null);

  const term = query.trim();
  const filter = `${status}::${term}`;
  const loadPage = useCallback(async (cursor) => {
    const r = await home.adminAccounts({
      status,
      limit: PAGE,
      ...(term ? { q: term } : {}),
      ...(cursor ? { cursor } : {}),
    });
    setTotal(present(r.total) ? r.total : null);
    return { items: r.accounts || [], cursor: r.next_cursor };
  }, [home, status, term]);
  const pages = usePages(loadPage, filter);

  const shape = useMemo(() => ({
    admins: pages.items.filter((a) => a.admin).length,
    off: pages.items.filter((a) => stateOf(a) === 'off').length,
    suspended: pages.items.filter((a) => stateOf(a) === 'suspended').length,
  }), [pages.items]);

  return (
    <>
      <Section
        title="Accounts"
        description="Shape and status only. When an account was made, how many devices it has,
          what it owns, whether it is switched on and by whom — and nothing about what anybody
          said or read."
        actions={(
          <>
            <Elevation stepUp={stepUp} />
            <Button size="sm" variant="ghost" onClick={pages.reload}>Refresh</Button>
          </>
        )}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
          <SearchField
            label="Search accounts"
            value={query}
            placeholder="Localpart or display name"
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery('')}
          />
          <Field label="Status">
            <Select value={status} options={STATUSES} onChange={(e) => setStatus(e.target.value)} />
          </Field>
        </div>

        {pages.items.length ? (
          <div className="cp-tiles">
            <Tile
              label="Matching"
              value={count(present(total) ? total : pages.items.length)}
              note={present(total) && total > pages.items.length
                ? `${count(pages.items.length)} loaded`
                : 'all loaded'}
            />
            <Tile label="Administrators" value={count(shape.admins)} note="among loaded rows" />
            <Tile
              label="Suspended"
              value={count(shape.suspended)}
              note="by an operator"
              tone={shape.suspended ? 'danger' : undefined}
            />
            <Tile label="Switched off" value={count(shape.off)} note="by their own owner" />
          </div>
        ) : null}
      </Section>

      <Section title="Results">
        {pages.error ? (
          <Notice tone="danger">
            {pages.error?.body?.message || pages.error?.message || String(pages.error)}
          </Notice>
        ) : null}

        {pages.loading && !pages.items.length ? <Hint>Reading the account table.</Hint> : null}

        {!pages.loading && !pages.items.length && !pages.error ? (
          <Notice>
            {term
              ? `Nothing on this server matches “${term}”.`
              : 'No accounts are in this state.'}
          </Notice>
        ) : null}

        <div className="cp-reports">
          {pages.items.map((a) => (
            <AccountRow key={a.user_id} account={a} me={me} onChanged={pages.reload} />
          ))}
        </div>

        <Pager pages={pages} total={total} noun="accounts" />
      </Section>
    </>
  );
}

function AccountRow({ account, me, onChanged }) {
  const [open, setOpen] = useState(false);
  const state = stateOf(account);
  const word = WORDS[state];

  return (
    <div className="cp-report" data-open={open ? '' : undefined} data-state={state}>
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          {account.admin ? <Pill tone="accent">admin</Pill> : null}
          {word ? <Pill tone={word.tone}>{word.label}</Pill> : null}
          {account.moved_to ? <Pill>moved</Pill> : null}
          <span className="truncate">{account.display_name || account.localpart}</span>
        </span>
        <span className="cp-report__meta">{account.user_id}</span>
      </button>
      {open ? (
        <AccountDetail account={account} me={me} state={state} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

function AccountDetail({ account, me, state, onChanged }) {
  const { home, stepUp } = useControlPlane();
  const [reason, setReason] = useState('');
  const detail = useLive(() => home.adminAccount(account.user_id), { interval: 60_000 });
  const d = detail.data;
  const a = d?.account || account;
  const blocked = unsuspendable(a, me);
  const owned = d?.owned_guilds || [];

  return (
    <div className="cp-report__body">
      {state === 'off' ? (
        <Notice tone="warn">
          <div className="font-medium">This account&rsquo;s owner switched it off.</div>
          <div className="mt-0.5">
            No operator did this, so there is nothing here to reverse. The owner turns it back
            on from their own account settings, and doing it from this console would be
            overriding somebody&rsquo;s decision about their own account.
          </div>
        </Notice>
      ) : null}

      {state === 'suspended' ? (
        <Notice tone="danger">
          <div className="font-medium">
            {`Suspended by ${a.suspended_by || 'an operator'}`}
            {present(a.suspended_at) ? ` on ${clock(a.suspended_at, true)}` : ''}
          </div>
          <div className="mt-0.5">
            {a.suspension_reason || 'No reason was recorded, which should not have been possible.'}
          </div>
        </Notice>
      ) : null}

      <Facts>
        <Fact name="Account" value={a.user_id} mono />
        <Fact name="Display name" value={a.display_name} />
        <Fact name="Created" value={present(a.created_at) ? clock(a.created_at, true) : ABSENT} />
        <Fact
          name="Last device seen"
          value={present(d?.last_session_at) ? clock(d.last_session_at, true) : ABSENT}
          why="The newest sighting of any of this account's devices — bookkeeping the session
            table already keeps for its own sake, not an observation made for this screen. It is
            the closest honest answer to “is this person still around”, and it is not an
            activity log."
        />
        <Fact name="Sessions" value={count(a.sessions)} why="Live sign-ins across all devices." />
        <Fact name="Devices" value={count(a.devices)} />
        <Fact
          name="Two-factor"
          value={a.mfa_enabled ? 'enrolled' : 'not enrolled'}
          why="Shown because an administrator without it is a server one phished password away
            from somebody else."
        />
        <Fact name="Guilds joined" value={count(d?.memberships)} />
        <Fact
          name="Guilds owned"
          value={count(owned.length || a.guilds_owned)}
          why={owned.length
            ? owned.map((g) => g.name).join(', ')
            : 'Suspending an owner does not close their guilds. The guilds stay, and keep '
              + 'running without an owner who can sign in.'}
        />
        <Fact
          name="Reports against"
          value={count(d?.reports_against)}
          why="Counted here, resolved in the moderation pane. A second place to act on the same
            report is a second place that can disagree with the first."
        />
        {a.moved_to ? (
          <Fact
            name="Moved to"
            value={a.moved_to}
            mono
            why="This account now lives on another server. What is left here is the forwarding
              pointer and whatever could not travel."
          />
        ) : null}
        {a.deleted_at ? <Fact name="Deleted" value={clock(a.deleted_at, true)} /> : null}
      </Facts>

      {detail.error ? (
        <Hint>
          The values above are from the list rather than the per-account record: the server did
          not answer the detail query.
        </Hint>
      ) : null}

      {state === 'suspended' ? (
        <div className="cp-bar">
          <DangerAction
            label="Reinstate"
            title={`Reinstate ${a.localpart || a.user_id}`}
            body={`${a.user_id} will be able to sign in again. The sessions revoked when they `
              + 'were suspended are not restored, so they will have to sign in fresh on every '
              + 'device. The suspension stays in the audit log either way.'}
            confirmLabel="Reinstate account"
            run={() => home.adminReinstateAccount(a.user_id)}
            done="Account reinstated."
            onDone={() => { detail.reload(); onChanged(); }}
          />
          <Elevation stepUp={stepUp} />
        </div>
      ) : null}

      {!blocked ? (
        <>
          <TextArea
            label="Why this account is being suspended"
            rows={2}
            value={reason}
            maxLength={2000}
            placeholder="Required. Whoever reads this in six months has only this sentence."
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="cp-bar">
            <DangerAction
              label="Suspend"
              title={`Suspend ${a.localpart || a.user_id}`}
              body={(
                <div className="flex flex-col gap-2">
                  <p>
                    {`${a.user_id} will be signed out of every device immediately and will not be `
                      + 'able to sign in. Their messages, memberships and guilds all stay exactly '
                      + 'where they are.'}
                  </p>
                  <p>
                    {a.guilds_owned
                      ? `They own ${count(a.guilds_owned)} guild${a.guilds_owned === 1 ? '' : 's'}, `
                        + 'which will carry on without an owner who can sign in.'
                      : 'They own no guilds.'}
                  </p>
                  <p className="cp-quote">{reason.trim()}</p>
                </div>
              )}
              confirmLabel="Suspend account"
              disabled={!reason.trim()}
              disabledReason="A suspension needs a reason on file. The server refuses without one."
              run={() => home.adminSuspendAccount(a.user_id, { reason: reason.trim() })}
              done="Account suspended and signed out everywhere."
              onDone={() => { setReason(''); detail.reload(); onChanged(); }}
            />
            <Elevation stepUp={stepUp} />
            <Hint className="cp-bar__hint">
              Suspending revokes every session. It deletes nothing, and it is reversible from
              this same row.
            </Hint>
          </div>
        </>
      ) : null}

      {blocked && state !== 'suspended' ? <Hint>{blocked}</Hint> : null}
    </div>
  );
}
