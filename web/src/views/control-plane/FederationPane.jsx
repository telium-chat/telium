import { useState } from 'react';
import { reportError, toast } from '../../hooks/useToast.jsx';
import {
  Button, DataTable, Field, Hint, Notice, Pill, Section, Select, TextInput,
} from '../../components/index.js';
import { Facts, Fact, Freshness, Tile } from './Bits.jsx';
import { DangerAction, useElevatedRun } from './StepUp.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, clock, count, duration, present } from './format.js';

const POLL_MS = 30_000;

const SCOPES = [
  ['all', 'Everything'],
  ['identity', 'Identity'],
  ['dm', 'Direct messages'],
  ['media', 'Media'],
];

function PeerProbe({ origin }) {
  const { home } = useControlPlane();
  const [state, setState] = useState({ phase: 'idle' });

  const probe = async () => {
    setState({ phase: 'running' });
    try {
      setState({ phase: 'done', data: await home.adminPeerStatus(origin) });
    } catch (e) {
      setState({ phase: 'failed', error: e });
    }
  };

  if (state.phase === 'idle') {
    return <Button size="sm" variant="ghost" onClick={probe}>Check now</Button>;
  }
  if (state.phase === 'running') return <Hint>{`Asking ${origin}…`}</Hint>;
  if (state.phase === 'failed') {
    return (
      <Notice tone="danger">
        {`Could not reach ${origin}: `}
        {state.error?.body?.message || state.error?.message || 'discovery failed'}
      </Notice>
    );
  }

  const d = state.data;
  return (
    <div className="cp-peer__probe">
      <Facts>
        <Fact name="Reachable" value={d.reachable ? 'yes, health answered' : 'no answer'} />
        <Fact name="API base" value={d.api_base} mono />
        <Fact name="Gateway" value={d.gateway} mono />
        <Fact name="Consecutive failures" value={count(d.failures)} />
        {d.moved_to ? (
          <Fact
            name="Moved to"
            value={d.moved_to}
            why="This origin has published a relocation. Deliveries follow the forwarding
              pointer; the old name is kept so signatures from before the move still verify."
            mono
          />
        ) : null}
        <Fact
          name="Signing keys held"
          value={`${d.keys?.length || 0}`}
          why="Key history, not just the current key: a signature made before a rotation still
            has to verify afterwards."
        />
        <ProtocolFacts protocol={d.protocol} />
        {incompatible(d.protocol) && d.local_protocol ? (
          <Fact
            name="This server speaks"
            value={`v${d.local_protocol.version} (accepts v${d.local_protocol.min_supported} and up)`}
            why="Shown only when the two windows do not overlap, because that is the only
              moment the operator needs both halves in front of them to work out which side
              has to move."
          />
        ) : null}
      </Facts>
      <Button size="sm" variant="ghost" onClick={probe}>Check again</Button>
    </div>
  );
}

function incompatible(protocol) {
  return !!protocol && protocol.status !== 'ok' && protocol.status !== 'unknown';
}

function ProtocolFacts({ protocol }) {
  if (!protocol) return null;
  if (protocol.status === 'unknown') {
    return (
      <Fact
        name="Protocol"
        value="not observed yet"
        why={protocol.message
          || 'This server has not yet seen what version this peer speaks. That is the '
            + 'normal state before first contact, and the permanent state for a peer '
            + 'running a release older than the compatibility contract. It is not a fault.'}
      />
    );
  }
  const caps = protocol.capabilities || [];
  return (
    <>
      <Fact
        name="Protocol"
        value={incompatible(protocol)
          ? protocol.message
          : `v${protocol.version} (accepts v${protocol.min_supported} and up)`}
        why={incompatible(protocol)
          ? protocol.remedy
          : 'The window this peer advertises. Both ends publish a newest and an oldest '
            + 'version, because one number cannot say whether an older peer is still fine.'}
      />
      <Fact
        name="Capabilities"
        value={caps.length ? caps.join(', ') : 'none advertised'}
        why={caps.length
          ? 'Named behaviours this peer has, negotiated separately from the version so a '
            + 'feature can ship without a protocol break. Tokens this client has never '
            + 'heard of are shown as sent: a newer peer is exactly who would send one.'
          : 'A peer that advertises no capabilities has none, and this server takes the '
            + 'defined fallback path for each of them rather than trying and failing. A '
            + 'peer from before capabilities existed looks like this.'}
        mono
      />
    </>
  );
}

function PeerRow({ peer }) {
  const [open, setOpen] = useState(false);
  const failing = peer.failures > 0;
  const broken = incompatible(peer.protocol);
  return (
    <div className="cp-report" data-open={open ? '' : undefined}>
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          {peer.defederated ? <Pill tone="danger">blocked</Pill> : null}
          {broken ? <Pill tone="danger">incompatible</Pill> : null}
          {failing ? <Pill tone="warn">{`${peer.failures} failures`}</Pill> : null}
          {peer.moved_to ? <Pill>moved</Pill> : null}
          <span className="truncate">{peer.origin}</span>
        </span>
        <span className="cp-report__meta">
          {present(peer.queued) ? `${count(peer.queued)} queued` : 'nothing queued'}
          {present(peer.queued_oldest_ms) ? ` · oldest ${duration(peer.queued_oldest_ms)}` : ''}
        </span>
      </button>
      {open ? (
        <div className="cp-report__body">
          <Facts>
            <Fact name="API base" value={peer.api_base} mono />
            <Fact
              name="Last discovered"
              value={duration(peer.discovered_age_ms)}
              why="How old this server's cached view of the peer's endpoint and keys is.
                Discovery refreshes on its own schedule; a stale entry is not by itself a fault."
            />
            <Fact
              name="Queued for this peer"
              value={present(peer.queued) ? count(peer.queued) : ABSENT}
              why={present(peer.queued)
                ? 'Items in the DM and friend outboxes destined for this server.'
                : 'Nothing has ever been queued for this peer, which is not the same as a '
                  + 'queue that is empty right now.'}
            />
            <ProtocolFacts protocol={peer.protocol} />
          </Facts>
          <PeerProbe origin={peer.origin} />
        </div>
      ) : null}
    </div>
  );
}

export function FederationPane() {
  const { home, metrics } = useControlPlane();
  const [domain, setDomain] = useState('');
  const [scope, setScope] = useState('all');
  const [reason, setReason] = useState('');
  const [feed, setFeed] = useState('');
  const [feedKey, setFeedKey] = useState('');
  const [busy, setBusy] = useState(false);

  const peers = useLive(() => home.adminPeers(), { interval: POLL_MS });
  const feeds = useLive(() => home.blocklistFeeds(), { interval: 120_000 });
  const registry = useLive(() => home.mediaRegistry(), { interval: 300_000 });

  const rows = peers.data?.peers || [];
  const blocks = peers.data?.defederated || [];
  const fed = metrics.data?.federation || {};
  const incompatibleCount = peers.data?.incompatible || 0;
  const local = peers.data?.local;

  const act = async (fn, ok, bad) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      peers.reload();
      feeds.reload();
    } catch (e) {
      reportError(e, bad);
    } finally {
      setBusy(false);
    }
  };

  const elevatedRun = useElevatedRun();
  const guarded = async (label, fn, ok) => {
    setBusy(true);
    const happened = await elevatedRun(label, fn, ok);
    setBusy(false);
    if (happened) {
      peers.reload();
      feeds.reload();
    }
  };

  return (
    <>
      <Section
        title="Federation"
        description="Everything on this pane is about servers. Nothing on it is about people."
        actions={<Freshness at={peers.at} error={peers.error} interval={POLL_MS} />}
      >
        <div className="cp-tiles">
          <Tile label="Known peers" value={count(rows.length)} />
          <Tile
            label="Peers failing"
            value={count(rows.filter((p) => p.failures > 0).length)}
            tone={rows.some((p) => p.failures > 0) ? 'warn' : undefined}
            note="consecutive discovery failures"
          />
          <Tile
            label="Queued deliveries"
            value={present(fed.backlog) ? count(fed.backlog) : ABSENT}
            note={present(fed.backlog_oldest_ms) ? `oldest ${duration(fed.backlog_oldest_ms)}` : undefined}
            tone={fed.backlog_oldest_ms > 15 * 60 * 1000 ? 'warn' : undefined}
          />
          <Tile
            label="Delivered since start"
            value={count(fed.deliveries)}
            note={fed.failures ? `${count(fed.failures)} attempts failed` : undefined}
          />
          <Tile
            label="Incompatible peers"
            value={count(incompatibleCount)}
            tone={incompatibleCount ? 'danger' : undefined}
            note={local ? `this server speaks v${local.version}` : undefined}
            title="Peers running a protocol version outside this server's window. They are
              not failing and they are not slow: nothing will federate with them until one
              side is upgraded."
          />
          <Tile label="Blocked domains" value={count(blocks.length)} />
        </div>
        <div className="cp-bar">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => act(
              () => home.adminRevalidate(),
              'Revalidation started.',
              'Could not revalidate',
            )}
          >
            Revalidate peers
          </Button>
          <Hint className="cp-bar__hint">
            Re-runs discovery and key fetch for peers this server has cached. Safe to run at any
            time; it costs one request per peer.
          </Hint>
        </div>
      </Section>

      <Section title="Peers">
        {incompatibleCount ? (
          <Notice tone="danger">
            {incompatibleCount === 1
              ? 'One peer speaks a protocol version this server cannot talk to. '
              : `${incompatibleCount} peers speak a protocol version this server cannot talk to. `}
            {local
              ? `This server speaks v${local.version} and accepts v${local.min_supported} and up. `
              : ''}
            They are listed first below, each with which version it speaks and whose move it
            is. Nothing federates with them until one side is upgraded; waiting will not help.
          </Notice>
        ) : null}
        {peers.error ? (
          <Notice tone="danger">
            {peers.error?.body?.message || peers.error?.message || String(peers.error)}
          </Notice>
        ) : null}
        {peers.loading && !peers.data ? <Hint>Reading the peer table.</Hint> : null}
        {peers.data && !rows.length ? (
          <Notice>
            This server has not met another Telium server yet. Peers appear here the first time
            federation touches them, not from any directory.
          </Notice>
        ) : null}
        <div className="cp-reports">
          {rows.map((p) => <PeerRow key={p.origin} peer={p} />)}
        </div>
      </Section>

      <Section
        title="Defederation"
        description="Blocks stop new federation with a domain. They are reversible, and
          reversing one does not replay what never arrived while it was in force."
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_170px]">
          <TextInput
            label="Domain"
            value={domain}
            placeholder="example.org"
            onChange={(e) => setDomain(e.target.value)}
          />
          <Field label="Scope">
            <Select value={scope} options={SCOPES} onChange={(e) => setScope(e.target.value)} />
          </Field>
        </div>
        <TextInput
          label="Reason"
          value={reason}
          placeholder="Optional, for whoever reads this list next year"
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          className="self-start"
          disabled={busy || !domain.trim()}
          onClick={() => guarded(
            'Block domain',
            async () => {
              await home.defederate({
                domain: domain.trim(),
                scope,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              setDomain('');
              setReason('');
            },
            'Domain blocked.',
          )}
        >
          Block domain
        </Button>

        <DataTable
          rows={blocks}
          rowKey={(r) => r.domain}
          empty="No domains blocked."
          columns={[
            { key: 'domain', header: 'Domain', render: (r) => r.domain },
            { key: 'scope', header: 'Scope', render: (r) => r.scope },
            { key: 'source', header: 'Source', render: (r) => r.source },
            { key: 'reason', header: 'Reason', render: (r) => r.reason || ABSENT },
            {
              key: 'remove',
              header: '',
              render: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || r.source !== 'manual'}
                  title={r.source === 'manual'
                    ? undefined
                    : 'This block came from a signed feed. Remove the feed, or stop subscribing to '
                      + 'it, rather than editing what it says.'}
                  onClick={() => guarded(
                    'Restore federation',
                    () => home.refederate(r.domain),
                    'Federation restored.',
                  )}
                >
                  Unblock
                </Button>
              ),
            },
          ]}
        />
      </Section>

      <Section
        title="Blocklist feeds"
        description="A feed is privileged input: it can deny federation at scale, so it is
          pinned to its publisher's key and every refresh is verified before it applies."
        actions={(
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => guarded(
              'Refresh feeds',
              () => home.refreshBlocklistFeeds(),
              'Feeds refreshed.',
            )}
          >
            Refresh now
          </Button>
        )}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput label="Signed feed URL" value={feed} onChange={(e) => setFeed(e.target.value)} />
          <TextInput
            label="Feed public key"
            placeholder="base64 Ed25519"
            value={feedKey}
            onChange={(e) => setFeedKey(e.target.value)}
          />
        </div>
        <Button
          className="self-start"
          disabled={busy || !feed.trim() || !feedKey.trim()}
          onClick={() => guarded(
            'Add feed',
            async () => {
              await home.addBlocklistFeed({ url: feed.trim(), public_b64: feedKey.trim() });
              setFeed('');
              setFeedKey('');
            },
            'Feed added.',
          )}
        >
          Add feed
        </Button>
        <DataTable
          rows={feeds.data?.feeds || []}
          rowKey={(r) => r.url}
          empty="No feeds configured."
          columns={[
            { key: 'url', header: 'Feed', render: (r) => r.label || r.url },
            { key: 'entries', header: 'Entries', render: (r) => count(r.entries) },
            {
              key: 'refreshed',
              header: 'Refreshed',
              render: (r) => (present(r.fetched_at) ? clock(r.fetched_at, true) : ABSENT),
            },
            {
              key: 'remove',
              header: '',
              render: (r) => (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => guarded(
                    'Remove feed',
                    () => home.removeBlocklistFeed({ url: r.url }),
                    'Feed removed.',
                  )}
                >
                  Remove
                </Button>
              ),
            },
          ]}
        />
      </Section>

      <CuratorKey feed={registry.data?.feed} onDone={registry.reload} />
    </>
  );
}

function CuratorKey({ feed, onDone }) {
  const { home } = useControlPlane();
  if (!feed) return null;
  const rotating = !!feed.next_key;

  return (
    <Section
      title="Curator key"
      description="The key this server signs its media origin feed with, and that every
        subscriber to that feed has pinned."
    >
      <Facts>
        <Fact name="Current key" value={feed.key || ABSENT} mono />
        <Fact
          name="Rotation"
          value={count(feed.rotation)}
          why="How many times this key has been replaced. A subscriber comparing this against
            what it holds can tell a rollover it missed from one it has already followed."
        />
        <Fact name="Feed" value={feed.url || ABSENT} mono />
        {rotating ? <Fact name="Successor" value={feed.next_key} mono /> : null}
      </Facts>

      {rotating ? (
        <Notice tone="warn">
          A rotation is already under way. The successor key is published alongside the current
          one and subscribers are picking it up as they refresh; the changeover happens on its
          own when the overlap runs out. Nothing needs doing, and a second rotation cannot be
          started until this one finishes.
        </Notice>
      ) : (
        <>
          <Hint>
            Rotating announces a successor and keeps signing with the current key for a week,
            which is how long every subscriber has to fetch the feed once and learn the new key.
            Subscribers that do not refresh in that window stop trusting this feed until
            somebody re-pins it by hand, and this server has no way to find out who they were.
            Rotate because the key may have leaked, not on a schedule.
          </Hint>
          <div className="self-start">
            <DangerAction
              size="base"
              label="Rotate curator key"
              title="Rotate this server’s curator key?"
              body={'The successor is published immediately and the current key keeps signing '
                + 'for seven days. Subscribers that refresh in that window follow the rollover '
                + 'automatically; ones that do not will stop trusting this feed. It cannot be '
                + 'called off once announced.'}
              confirmLabel="Announce rotation"
              run={() => home.rotateCuratorKey()}
              onDone={onDone}
              done="Rotation announced. The current key signs for seven more days."
            />
          </div>
        </>
      )}
    </Section>
  );
}
