import { useState } from 'react';
import {
  Button, DataTable, Hint, Notice, Pill, Section,
} from '../../components/index.js';
import { text as safeText, link as safeLink, marketplace } from '../../lib/hosting.js';
import { Facts, Fact, Freshness, Tile } from './Bits.jsx';
import { DangerAction } from './StepUp.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, clock, count, duration, present } from './format.js';

const POLL_MS = 120_000;

const STATES = {
  active: {
    tone: undefined,
    why: 'A verified copy is held and inside its validity window. Its providers are being '
      + 'offered to anybody creating a guild here.',
  },
  pending: {
    tone: undefined,
    why: 'Configured, and not fetched yet. Every subscription looks like this between a '
      + 'restart and the first scheduled fetch; it is not a fault.',
  },
  expired: {
    tone: 'warn',
    why: 'A verified copy is held but it is past its expiry, so it lists nobody. A stale '
      + 'blocklist keeps blocking because the cautious direction is obvious; there is no '
      + 'cautious direction for a price that was true last quarter, so this goes quiet '
      + 'instead. The publisher has stopped re-signing it.',
  },
  key_mismatch: {
    tone: 'warn',
    why: 'A document is arriving and it does not verify against the pinned key. Either the '
      + 'publisher has rotated the key it signs with, or somebody is serving a forgery -- '
      + 'nothing in the document can tell those apart, which is what pinning is for. Both are '
      + 'fixed the same way: get the publisher\u2019s current key from somewhere that is not '
      + 'this document, and re-pin it in telium.toml.',
  },
  failed: {
    tone: 'danger',
    why: 'Fetched and refused: a bad signature, a serial that went backwards, a second '
      + 'document signed under a serial already seen, or a field outside the bounds the '
      + 'protocol sets. The last good copy, if there was one, is still what is listed.',
  },
  invalid: {
    tone: 'danger',
    why: 'The URL or the pinned key in telium.toml does not pass validation, so this server '
      + 'never fetches it at all. That is an edit to the file and a restart, not something '
      + 'a refresh can fix.',
  },
  disabled: {
    tone: 'warn',
    why: 'hosting.enabled is false. Nothing is fetched, the cache is pruned, and the list is '
      + 'empty however many subscriptions are still written in the file.',
  },
};

const FAILURES = {
  misconfigured: {
    tone: 'danger',
    title: 'Never fetched: the subscription itself is malformed',
    next: 'The URL or the pinned key in telium.toml does not pass validation, so this server '
      + 'does not fetch it and no retry will change that. Fix the block and restart.',
  },
  unreachable: {
    tone: 'danger',
    title: 'No document arrived',
    next: 'This server could not get bytes out of that URL at all \u2014 a name that would not '
      + 'resolve, a connection refused, a timeout, an error status, a redirect this fetcher '
      + 'will not follow, or a body over the ceiling. That is somebody else\u2019s machine, '
      + 'and waiting is usually the right response; the schedule keeps trying.',
  },
  key_mismatch: {
    tone: 'warn',
    title: 'The pinned key and the publisher disagree',
    next: 'A real catalogue is arriving and this server will not believe it, because it is not '
      + 'signed by the key this subscription pins. Ask the publisher \u2014 by some route other '
      + 'than the document, which is the one thing that cannot be trusted to answer this \u2014 '
      + 'which key it signs with now, then edit the key in telium.toml and restart. Until then '
      + 'this subscription contributes nothing new and its held copy, if it has one, is '
      + 'running down to its expiry.',
  },
  rejected: {
    tone: 'danger',
    title: 'The document was refused',
    next: 'A document arrived and this server would not adopt it: a serial that went backwards, '
      + 'one serial signed over two different documents, a copy already past its expiry, a '
      + 'field outside the bounds the protocol sets, or something that was never a catalogue. '
      + 'That is the publisher\u2019s end, and the words below are what to send them.',
  },
};

function safeRow(row) {
  const url = safeLink(row.url);
  return {
    ...row,
    label: safeText(row.label, 64),
    url: safeText(row.url, 512),
    href: url,
    publisher: safeText(row.publisher, 64),
    error: safeText(row.error, 600),
    failure: row.failure
      ? { ...row.failure, message: safeText(row.failure.message, 600), kind: safeText(row.failure.kind, 32) }
      : null,
  };
}

function FailureNotice({ failure, current, now }) {
  const shape = FAILURES[failure.kind] || {
    tone: 'danger',
    title: 'The last fetch did not produce a copy',
    next: null,
  };
  const when = present(failure.at) ? `${duration(now - failure.at)} ago` : null;
  if (!current) {
    return (
      <Notice>
        <strong>Fetching normally now.</strong>
        {when ? ` It last failed ${when}` : ' It has failed before'}
        {failure.consecutive > 1 ? `, ${count(failure.consecutive)} times in a row` : ''}
        {': '}
        {failure.message}
      </Notice>
    );
  }
  return (
    <Notice tone={shape.tone}>
      <strong>{shape.title}</strong>
      {when ? ` \u2014 ${when}` : ''}
      {failure.consecutive > 1 ? `, ${count(failure.consecutive)} attempts in a row` : ''}
      {'. '}
      {failure.message}
      {shape.next ? ` ${shape.next}` : ''}
    </Notice>
  );
}

function CatalogRow({ row }) {
  const [open, setOpen] = useState(false);
  const state = STATES[row.state] || { tone: undefined, why: undefined };
  const now = Date.now();
  return (
    <div className="cp-report" data-open={open ? '' : undefined}>
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          <Pill tone={state.tone}>{row.state}</Pill>
          <span className="truncate">{row.label || row.url}</span>
        </span>
        <span className="cp-report__meta">
          {row.state === 'active'
            ? `${count(row.providers)} listed`
            : 'listing nothing'}
          {present(row.fetched_at) ? ` · read ${duration(now - row.fetched_at)} ago` : ''}
          {row.error ? ' · not updating' : ''}
        </span>
      </button>
      {open ? (
        <div className="cp-report__body">
          {row.failure
            ? <FailureNotice failure={row.failure} current={!!row.error} now={now} />
            : null}
          <Facts>
            <Fact name="What this state means" value={row.state} why={state.why} />
            <Fact
              name="Document URL"
              value={row.href || row.url}
              why={row.href
                ? undefined
                : 'Not an https URL. This server refuses to fetch it, and it is shown here as '
                  + 'text rather than as a link because there is nowhere safe to send anybody.'}
              mono
            />
            <Fact
              name="Pinned key"
              value={row.key}
              why="The only key this document is ever checked against. A catalogue naming a key
                for itself is not trusted to: there is no key discovery and no rotation inside
                the document, so a publisher who rotates has to tell their subscribers and
                every subscriber has to edit their own file."
              mono
            />
            <Fact
              name="Publisher"
              value={row.publisher}
              why="The name the document gives itself. It is a label the publisher chose, not a
                verified identity; the key above is the part that is checked."
            />
            <Fact
              name="Serial"
              value={count(row.serial)}
              why="Must strictly increase. An older document replayed at this server is refused
                as a rollback, and the same serial carrying different contents is refused as
                equivocation -- a publisher signing two documents under one serial is either
                compromised or telling different subscribers different things."
            />
            <Fact
              name="Providers held"
              value={count(row.providers)}
              why="Adopted in one transaction: the held providers are replaced wholesale rather
                than merged, because a provider dropped from a catalogue is one its publisher
                has stopped listing."
            />
            <Fact
              name="Issued"
              value={present(row.issued_at) ? clock(row.issued_at, true) : ABSENT}
            />
            <Fact
              name="Expires"
              value={present(row.expires_at) ? clock(row.expires_at, true) : ABSENT}
              why={present(row.expires_at) && row.expires_at <= now
                ? 'Already passed, which is why this subscription is listing nobody.'
                : 'After this, the held copy stops offering anybody until the publisher signs a '
                  + 'fresh one.'}
            />
            <Fact
              name="Last read"
              value={present(row.fetched_at) ? `${duration(now - row.fetched_at)} ago` : ABSENT}
              why="The last fetch that produced a document this server accepted."
            />
            <Fact
              name="Last attempted"
              value={present(row.attempted_at) ? `${duration(now - row.attempted_at)} ago` : ABSENT}
              why="The last fetch of any kind. An attempt much more recent than the read above
                is a subscription that is being retried and failing."
            />
            <Fact
              name="Last failed"
              value={present(row.failure?.at) ? `${duration(now - row.failure.at)} ago` : ABSENT}
              why="Kept even after a later fetch succeeded, which is the only way a subscription
                that fails half its fetches ever becomes visible: the current error clears on
                every good fetch, so a console that showed only that would call a flapping
                catalogue healthy every time anybody looked at it."
            />
            <Fact
              name="Failures in a row"
              value={row.failure ? count(row.failure.consecutive) : ABSENT}
              why="Reset by a successful fetch. One is a publisher mid-deploy; a hundred is a
                subscription that has been dead since it was written down, and the two want
                very different amounts of an operator's afternoon."
            />
          </Facts>
        </div>
      ) : null}
    </div>
  );
}

function Publication({ published, curated }) {
  if (!published) return null;
  return (
    <Section
      title="What this server publishes"
      description="This operator's own curated providers, served signed, for other operators to
        subscribe to."
    >
      <Facts>
        <Fact name="Catalogue URL" value={safeText(published.url, 512)} mono />
        <Fact
          name="Key to pin"
          value={safeText(published.key, 128)}
          why="A subscriber writes this into their own telium.toml beside the URL. Minted on
            first use and kept on this server; there is no rotation path inside the document,
            so replacing it means telling every subscriber."
          mono
        />
        <Fact
          name="Published as"
          value={safeText(published.publisher, 64)}
          why="The name this server signs its catalogue under."
        />
        <Fact
          name="Providers curated here"
          value={count(curated)}
          why="Entries from this server's own [[hosting.providers]]. A configured provider that
            fails validation is dropped and logged rather than published broken, and two that
            would host a guild in the same place are listed once, so this can be lower than the
            number of blocks in the file."
        />
      </Facts>
      <Hint>
        Listing a provider is vouching for it, in exactly the way listing a media origin is.
        Nothing here checks that a listed company runs a Telium server or that its prices are
        real, and nothing in this client or this server takes a payment or opens an account on
        anybody&rsquo;s behalf &mdash; a person who picks a provider is sent to that
        company&rsquo;s own signup page and the transaction, if there is one, happens between
        the two of them.
      </Hint>
    </Section>
  );
}

function LastRefresh({ results }) {
  if (!results) return null;
  if (!results.length) {
    return (
      <Notice>
        Nothing was fetched. This server subscribes to no catalogues, or the marketplace is
        switched off.
      </Notice>
    );
  }
  const failed = results.filter((r) => r.error);
  const skipped = results.filter((r) => !r.error && r.skipped);
  const done = results.length - failed.length - skipped.length;
  return (
    <>
      <Notice tone={failed.length ? 'danger' : 'success'}>
        {`${count(done)} of ${count(results.length)} fetched and adopted`}
        {skipped.length ? `, ${count(skipped.length)} not asked` : ''}
        {failed.length ? `, ${count(failed.length)} refused` : ''}
        .
      </Notice>
      <Facts>
        {results.map((r) => (
          <Fact
            key={safeText(r.url, 512)}
            name={safeText(r.label, 64) || safeText(r.url, 512)}
            value={r.error ? 'refused' : (r.skipped ? 'not asked' : 'adopted')}
            why={safeText(r.error || r.skipped, 600) || undefined}
          />
        ))}
      </Facts>
    </>
  );
}

export function HostingPane() {
  const { home } = useControlPlane();
  const [results, setResults] = useState(null);

  const admin = useLive(() => home.adminHostingCatalogs(), { interval: POLL_MS });
  const shown = useLive(() => home.hostingProviders(), { interval: POLL_MS });

  const rows = (admin.data?.catalogs || []).map(safeRow);
  const market = shown.data ? marketplace(shown.data) : null;
  const providers = market?.providers || [];
  const curated = providers.filter((p) => p.source.kind === 'operator').length;
  const enabled = admin.data ? admin.data.enabled !== false : null;
  const broken = rows.filter((r) => r.state === 'failed' || r.state === 'invalid');
  const quiet = rows.filter((r) => r.state === 'expired');
  const mismatched = rows.filter((r) => r.error && r.failure?.kind === 'key_mismatch');
  const stale = rows.filter((r) => r.state === 'active' && r.error);
  const soonest = stale
    .map((r) => r.expires_at)
    .filter((at) => present(at))
    .sort((a, b) => a - b)[0];

  return (
    <>
      <Section
        title="Managed hosting"
        description="Who this server is willing to name when somebody would rather not run a
          server themselves, and where that list came from."
        actions={<Freshness at={admin.at} error={admin.error} interval={POLL_MS} />}
      >
        {admin.error ? (
          <Notice tone="danger">
            {admin.error?.body?.message || admin.error?.message || String(admin.error)}
          </Notice>
        ) : null}
        {admin.loading && !admin.data ? <Hint>Reading the subscriptions.</Hint> : null}

        {enabled === false ? (
          <Notice tone="warn">
            The marketplace is switched off (`hosting.enabled = false`). Nothing is fetched,
            cached copies are pruned, and nobody is offered a managed provider however many
            subscriptions are written in the file. Creating a guild here is the form it always
            was. Turning it back on is an edit and a restart.
          </Notice>
        ) : null}

        {enabled !== false ? (
          <div className="cp-tiles">
            <Tile
              label="Offered right now"
              value={count(providers.length)}
              note={providers.length ? `${count(curated)} curated here` : 'nobody is listed'}
            />
            <Tile label="Subscriptions" value={count(rows.length)} />
            <Tile
              label="Not arriving"
              value={count(broken.length)}
              tone={broken.length ? 'danger' : undefined}
              note="refused or misconfigured"
            />
            {mismatched.length ? (
              <Tile
                label="Pinned key stale"
                value={count(mismatched.length)}
                tone="warn"
                note="the publisher signs with another"
              />
            ) : null}
            <Tile
              label="Listing nothing"
              value={count(quiet.length)}
              tone={quiet.length ? 'warn' : undefined}
              note="held but past expiry"
            />
          </div>
        ) : null}

        {stale.length ? (
          <Notice tone="warn">
            {`${count(stale.length)} of these `}
            {stale.length === 1 ? 'is' : 'are'}
            {' still listing providers from a copy that is held here, and not managing to fetch a '
              + 'new one. Nobody sees anything wrong until the held copy expires'}
            {present(soonest) ? `, which for the first of them is in ${duration(soonest - Date.now())}` : ''}
            {'. Open it below for what the publisher said.'}
          </Notice>
        ) : null}

        {enabled !== false && market && !providers.length && !rows.length ? (
          <Notice>
            This server lists nobody, which is a perfectly ordinary posture and the one every
            server starts in. &ldquo;Create a guild&rdquo; is the form it has always been: a
            name, and this server. Providers appear here when an operator curates some in
            `[[hosting.providers]]` or subscribes to somebody else&rsquo;s catalogue in
            `[[hosting.catalogs]]`.
          </Notice>
        ) : null}
      </Section>

      <Section
        title="Subscriptions"
        description="A catalogue is somebody else's signed document, pinned to somebody else's
          key. It is checked against that key and nothing else, every time."
        actions={(
          <DangerAction
            label="Refresh catalogues"
            title="Fetch every subscribed catalogue now?"
            body={'Each publisher is asked for its current document, and any that verifies '
              + 'replaces the copy held here. The providers, prices and limits that everybody '
              + 'on this server is offered when they create a guild change to whatever those '
              + 'publishers are serving at this moment. Catalogues read in the last minute are '
              + 'not asked again.'}
            confirmLabel="Fetch now"
            run={async () => { setResults((await home.refreshHostingCatalogs()).results || []); }}
            onDone={() => { admin.reload(); shown.reload(); }}
            done="Catalogues fetched."
            disabled={enabled === false || !rows.length}
            disabledReason={enabled === false
              ? 'The marketplace is switched off; there is nothing to fetch.'
              : 'This server subscribes to no catalogues.'}
          />
        )}
      >
        {rows.length ? (
          <div className="cp-reports">
            {rows.map((r) => <CatalogRow key={`${r.url}:${r.key}`} row={r} />)}
          </div>
        ) : (
          <Notice>
            No catalogues are subscribed to. An operator adds one as a `[[hosting.catalogs]]`
            block in telium.toml carrying the document&rsquo;s URL and the publisher&rsquo;s
            public key, then restarts.
          </Notice>
        )}

        <LastRefresh results={results} />

        <Hint>
          Subscriptions are configuration, not a list this console edits: the server reads
          telium.toml once at startup, so a Save button here would be a control over a value
          the running process cannot re-read. Adding, removing or re-pinning one is an edit to
          the file and a restart. The refresh above only asks the publishers already written
          there for their current document.
        </Hint>
      </Section>

      {providers.length ? (
        <Section
          title="Who is being offered"
          description="The same list, read the same way, that a person sees under Create a
            guild. An offer named by two publishers is listed once."
        >
          <DataTable
            rows={providers}
            rowKey={(p) => `${p.source.kind}:${p.id}`}
            empty="Nobody is listed."
            columns={[
              { key: 'name', header: 'Provider', render: (p) => p.name },
              {
                key: 'source',
                header: 'Listed by',
                render: (p) => (p.source.kind === 'operator'
                  ? 'this server'
                  : (p.source.label || p.source.publisher || 'a subscription')),
              },
              { key: 'plans', header: 'Plans', render: (p) => count(p.plans.length) },
              {
                key: 'regions',
                header: 'Regions',
                render: (p) => (p.regions.length ? p.regions.join(', ') : ABSENT),
              },
            ]}
          />
          <Hint>
            &ldquo;Listed by this server&rdquo; is the operator&rsquo;s own curation and carries
            their word for it. Everything else arrived in a subscription, and is shown to people
            here because this server subscribes to a list that mentions it &mdash; which is a
            weaker claim, and the client says which is which on the choice screen too.
          </Hint>
        </Section>
      ) : null}

      <Publication published={admin.data?.published} curated={curated} />
    </>
  );
}
