import { useCallback, useMemo, useState } from 'react';
import {
  Button, Field, Hint, Notice, Pill, Section, Select, TextInput,
} from '../../components/index.js';
import { Pager, usePages } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { ABSENT, clock, count } from './format.js';

const PAGE = 50;

const KNOWN_ACTIONS = [
  ['account.suspend', 'Account suspended'],
  ['account.reinstate', 'Account reinstated'],
  ['guild.purge', 'Guild history reclaimed'],
  ['report.resolve', 'Report resolved'],
  ['federation.defederate', 'Domain blocked'],
  ['federation.refederate', 'Domain unblocked'],
  ['federation.revalidate', 'Peers revalidated'],
  ['blocklist.feed.add', 'Blocklist feed added'],
  ['blocklist.feed.remove', 'Blocklist feed removed'],
  ['blocklist.feed.refresh', 'Blocklist feed refreshed'],
  ['storage.sweep', 'Cache swept'],
  ['archive.run', 'History archived'],
  ['sunset.announce', 'Sunset announced'],
  ['sunset.cancel', 'Sunset cancelled'],
  ['sunset.execute', 'Sunset executed'],
  ['sunset.finalize', 'Server shut down'],
  ['standby.promote', 'Standby promoted'],
  ['failover.authorize', 'Failover authorised'],
  ['failover.promote', 'Failover promoted'],
  ['curator.key.rotate', 'Curator key rotated'],
  ['hosting.catalogs.refresh', 'Hosting catalogs refreshed'],
  ['step_up.grant', 'Elevation granted'],
  ['step_up.deny', 'Elevation refused'],
  ['step_up.end', 'Elevation ended'],
];

const ACTION_LABEL = new Map(KNOWN_ACTIONS);

const TONES = {
  'guild.purge': 'danger',
  'sunset.finalize': 'danger',
  'sunset.execute': 'danger',
  'standby.promote': 'danger',
  'failover.promote': 'danger',
  'account.suspend': 'warn',
  'step_up.deny': 'warn',
};

export function AuditPane() {
  const { home } = useControlPlane();
  const [action, setAction] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [actor, setActor] = useState('');

  const filter = `${action}|${actor}`;
  const loadPage = useCallback(async (before) => {
    const r = await home.adminAudit({
      limit: PAGE,
      ...(action ? { action } : {}),
      ...(actor ? { actor } : {}),
      ...(before ? { before } : {}),
    });
    return { items: r.entries || [], cursor: r.next_before };
  }, [home, action, actor]);
  const pages = usePages(loadPage, filter);

  const options = useMemo(() => {
    const extra = [...new Set(pages.items.map((e) => e.action))]
      .filter((a) => a && !ACTION_LABEL.has(a))
      .sort()
      .map((a) => [a, a]);
    return [['', 'Every action'], ...KNOWN_ACTIONS, ...extra];
  }, [pages.items]);

  const submitActor = (e) => {
    e.preventDefault();
    setActor(actorInput.trim());
  };

  return (
    <>
      <Section
        title="Audit log"
        description="Every administrator action this server has recorded, including the ones it
          refused. Nothing here can be edited or deleted, by anybody."
        actions={<Button size="sm" variant="ghost" onClick={pages.reload}>Refresh</Button>}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Action">
            <Select value={action} options={options} onChange={(e) => setAction(e.target.value)} />
          </Field>
          <form onSubmit={submitActor} className="flex items-end gap-2">
            <TextInput
              label="Actor"
              className="min-w-0 flex-1"
              value={actorInput}
              placeholder="@operator:example.org"
              hint="A whole user id — the filter is an exact match, not a search."
              onChange={(e) => setActorInput(e.target.value)}
            />
            <Button size="sm" variant="secondary" type="submit">Filter</Button>
          </form>
        </div>

        {actor ? (
          <Hint>
            {`Showing only what ${actor} did. `}
            <button type="button" className="cp-link" onClick={() => { setActorInput(''); setActor(''); }}>
              Show everybody
            </button>
          </Hint>
        ) : null}
      </Section>

      <Section title={action ? ACTION_LABEL.get(action) || action : 'Everything'}>
        {pages.error ? (
          <Notice tone="danger">
            {pages.error?.body?.message || pages.error?.message || String(pages.error)}
          </Notice>
        ) : null}

        {pages.loading && !pages.items.length ? <Hint>Reading the log.</Hint> : null}

        {!pages.loading && !pages.items.length && !pages.error ? (
          <Notice>
            {action || actor
              ? 'Nothing in the log matches that filter.'
              : 'Nothing has been recorded yet. Every administrator action lands here as it '
                + 'happens.'}
          </Notice>
        ) : null}

        <div className="cp-reports">
          {pages.items.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
        </div>

        <Pager pages={pages} noun="entries" />
      </Section>
    </>
  );
}

function AuditRow({ entry }) {
  const [open, setOpen] = useState(false);
  const refused = entry.data && typeof entry.data.refused === 'string';
  const tone = refused ? 'warn' : TONES[entry.action];
  const fields = describe(entry.data);

  return (
    <div className="cp-report" data-open={open ? '' : undefined} data-state={refused ? 'refused' : undefined}>
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          <Pill tone={tone || 'default'}>
            {ACTION_LABEL.get(entry.action) || entry.action}
          </Pill>
          {refused ? <Pill tone="warn">refused</Pill> : null}
          <span className="truncate">{entry.actor}</span>
          {entry.target ? <span className="cp-report__meta truncate">{entry.target}</span> : null}
        </span>
        <span className="cp-report__meta">{clock(entry.created_at, true)}</span>
      </button>

      {open ? (
        <div className="cp-report__body">
          {refused ? (
            <Notice tone="warn">
              {`This was refused: ${entry.data.refused}. The attempt is recorded because an `
                + 'attempt turned away is frequently the more interesting entry.'}
            </Notice>
          ) : null}

          <dl className="cp-kv">
            <dt>Action</dt>
            <dd className="font-mono text-xs">{entry.action}</dd>
            <dt>Actor</dt>
            <dd className="font-mono text-xs">{entry.actor}</dd>
            {entry.target ? (
              <>
                <dt>Subject</dt>
                <dd className="font-mono text-xs">{entry.target}</dd>
              </>
            ) : null}
            <dt>When</dt>
            <dd>{clock(entry.created_at, true)}</dd>
            <dt>Entry</dt>
            <dd className="font-mono text-xs">{entry.id}</dd>
            {fields.map(([name, value]) => (
              <Detail key={name} name={name} value={value} />
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ name, value }) {
  const scalar = value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
  return (
    <>
      <dt>{humanise(name)}</dt>
      <dd>
        {scalar
          ? readable(value)
          : <pre className="cp-json">{JSON.stringify(value, null, 2)}</pre>}
      </dd>
    </>
  );
}

function describe(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data).filter(([key]) => key !== 'refused');
}

function humanise(key) {
  const words = String(key).replace(/[_.]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function readable(value) {
  if (value === null || value === '') return ABSENT;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return count(value);
  return String(value);
}
