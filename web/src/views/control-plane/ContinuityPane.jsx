import {
  Button, Hint, Notice, Pill, Section,
} from '../../components/index.js';
import { Fact, Facts, Freshness, Tile, Verdict } from './Bits.jsx';
import { ContinuityOps } from './ContinuityOps.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, clock, count, duration, present } from './format.js';

const CONTINUITY_MS = 30_000;

const SILENT_WARN_MS = 5 * 60_000;

export function ContinuityPane() {
  const { home } = useControlPlane();
  const live = useLive(() => home.adminContinuity(), { interval: CONTINUITY_MS });
  const c = live.data;

  const standbys = c?.standbys || [];
  const mirrors = c?.mirrors || [];
  const tombstones = c?.tombstones || [];
  const moved = tombstones
    .filter((t) => t.kind === 'moved')
    .reduce((n, t) => n + (t.count || 0), 0);

  return (
    <>
      <Section
        title="Continuity"
        description="Who could speak for this server if it stopped, whose data this server is
          holding for the same reason, and whether an ending has been announced."
        actions={(
          <>
            <Freshness at={live.at} error={live.error} interval={CONTINUITY_MS} />
            <Button size="sm" variant="ghost" onClick={live.reload}>Refresh</Button>
          </>
        )}
      >
        {live.error && !c ? (
          <Notice tone="danger">
            {live.error?.body?.message || live.error?.message || String(live.error)}
          </Notice>
        ) : null}

        {c?.read_only ? (
          <Notice tone="danger">
            <div className="font-medium">This process is no longer the authority.</div>
            <div className="mt-0.5">
              A standby has been promoted for this domain, so this server is answering read-only
              and every write is being refused. Nothing on this console will change that; the
              server that was promoted is the one that is live.
            </div>
          </Notice>
        ) : null}

        {c?.shut_down ? (
          <Notice tone="danger">
            This server has been shut down for good. It is answering so that people can still
            export, and nothing new is being accepted.
          </Notice>
        ) : null}

        <div className="cp-tiles">
          <Tile
            label="Answering for"
            value={c?.server_name || ABSENT}
            note={c && c.signing_origin !== c.server_name
              ? `signing as ${c.signing_origin}`
              : 'signing under its own name'}
          />
          <Tile
            label="Standbys"
            value={count(standbys.length)}
            note={standbys.length
              ? `${count(standbys.filter((s) => s.paired).length)} authorised to take over`
              : 'nobody is streaming this log'}
            tone={standbys.length ? undefined : 'warn'}
          />
          <Tile
            label="Mirrors held"
            value={count(mirrors.length)}
            note={mirrors.length
              ? `${count(mirrors.filter((m) => m.stale).length)} stale`
              : 'not copying anybody else'}
            tone={mirrors.some((m) => m.stale) ? 'warn' : undefined}
          />
          <Tile
            label="Log head"
            value={count(c?.log_head)}
            note={c?.replicating ? 'replication on' : 'replication off'}
            tone={c && !c.replicating && standbys.length ? 'warn' : undefined}
          />
        </div>

        {c && !c.replicating && standbys.length ? (
          <Notice tone="warn">
            Standbys are configured but <code>failover.replicate</code> is off, so nothing is
            being streamed to them. Whatever they hold is as old as the day it was set up.
          </Notice>
        ) : null}
      </Section>

      <Authority authority={c?.authority} />
      <Sunset sunset={c?.sunset} registrationOpen={c?.registration_open} />

      <Section
        title="Standbys"
        description="Servers streaming this one’s change log. The gap between the log head and
          what a standby has acknowledged is exactly what a promotion right now would lose."
      >
        {!standbys.length ? (
          <Notice tone="warn">
            No standby is configured. If this machine is lost, what is restorable is whatever
            the backup on the storage pane last wrote — see <code>[failover]</code> in the
            server configuration for the other half of the answer.
          </Notice>
        ) : null}

        <div className="cp-reports">
          {standbys.map((s) => <StandbyRow key={s.domain} standby={s} head={c?.log_head} />)}
        </div>
      </Section>

      <Section
        title="Mirrors"
        description="Databases this server is holding for somebody else, and would serve
          read-only if they stopped answering."
      >
        {!mirrors.length ? (
          <Hint>
            This server is not mirroring anybody. That is the ordinary case; mirroring is
            something two operators agree to set up for each other.
          </Hint>
        ) : null}

        <div className="cp-reports">
          {mirrors.map((m) => <MirrorRow key={m.origin} mirror={m} />)}
        </div>
      </Section>

      <Section
        title="What has moved"
        description="Accounts and guilds that relocated or ended. Rows for a subject that moved
          away stay on this disk until somebody reclaims them."
      >
        <Facts>
          <Fact name="Accounts here" value={count(c?.accounts)} />
          <Fact name="Guilds here" value={count(c?.guilds)} />
          {tombstones.map((t) => (
            <Fact
              key={`${t.subject}-${t.kind}`}
              name={`${t.subject} · ${t.kind}`}
              value={count(t.count)}
            />
          ))}
        </Facts>
        {moved ? (
          <Hint>
            {`${count(moved)} subject${moved === 1 ? '' : 's'} moved away. A guild among those `
              + 'still has its history on this disk; the guilds pane can reclaim the space '
              + 'without disturbing the forwarding address.'}
          </Hint>
        ) : null}
      </Section>

      {c ? <ContinuityOps continuity={c} reload={live.reload} /> : null}
    </>
  );
}

function Authority({ authority }) {
  if (!authority) return null;
  return (
    <Section title="Authority">
      <Notice tone="danger">
        <div className="font-medium">
          {`A promotion record exists for ${authority.domain}.`}
        </div>
        <div className="mt-0.5">
          {`Sequence ${authority.sequence}. Another server has been authorised to answer for `
            + 'this domain, and peers that have seen this record are already talking to it.'}
        </div>
      </Notice>
    </Section>
  );
}

function Sunset({ sunset, registrationOpen }) {
  if (!sunset) return null;
  const relocating = sunset.mode === 'relocate';
  const when = present(sunset.effective_at) ? clock(sunset.effective_at, true) : ABSENT;
  return (
    <Section title="Announced ending">
      <Notice tone={relocating ? 'accent' : 'warn'}>
        <div className="font-medium">
          {relocating
            ? `This server has announced a move to ${sunset.new_domain}.`
            : 'This server has announced that it is shutting down.'}
        </div>
        <div className="mt-0.5">
          {relocating
            ? `Effective ${when}. The move itself happens when the server is restarted under the `
              + 'new name; until then the new domain does not answer and nothing has changed hands.'
            : `Effective ${when}. Members are being told to export their accounts, and `
              + 'registration is closed regardless of the setting.'}
        </div>
      </Notice>
      <Facts>
        <Fact name="Mode" value={sunset.mode} />
        <Fact name="Effective" value={when} />
        <Fact
          name="Announced"
          value={present(sunset.announced_at) ? clock(sunset.announced_at, true) : ABSENT}
        />
        {sunset.new_domain ? <Fact name="New domain" value={sunset.new_domain} mono /> : null}
        <Fact
          name="Registration"
          value={registrationOpen ? 'open' : 'closed'}
          why="An account made on a server that has said it is ending is an account made to be
            stranded, so a shutdown closes registration whatever the configuration says."
        />
        {sunset.message ? <Fact name="Message to members" value={sunset.message} /> : null}
      </Facts>
    </Section>
  );
}

function StandbyRow({ standby, head }) {
  const never = !present(standby.acked_sequence);
  const silent = present(standby.silent_ms) && standby.silent_ms > SILENT_WARN_MS;
  const behind = standby.behind_entries;

  return (
    <div className="cp-report" data-open="">
      <div className="cp-report__head">
        <span className="cp-report__title">
          <Verdict tone={never || !standby.paired ? 'warn' : (silent ? 'warn' : 'success')}>
            {never ? 'never acknowledged' : (silent ? 'silent' : 'streaming')}
          </Verdict>
          <span className="truncate">{standby.domain}</span>
          {standby.paired ? null : <Pill tone="warn">not authorised</Pill>}
        </span>
        <span className="cp-report__meta">
          {never
            ? ABSENT
            : `${count(behind)} entries behind · last heard ${duration(standby.silent_ms)} ago`}
        </span>
      </div>
      <div className="cp-report__body">
        {never ? (
          <Hint>
            This standby has never acknowledged a log entry. Either it has not been started, or
            it cannot reach this server — what it holds is whatever it was given when it was set
            up.
          </Hint>
        ) : null}
        {!standby.paired ? (
          <Hint>
            Streaming is configured but no signed authorisation exists, so this standby holds a
            perfect copy it could not prove it was entitled to serve. Pairing is the second
            consent, and it is given from the failover route rather than from here.
          </Hint>
        ) : null}
        <Facts>
          <Fact name="Domain" value={standby.domain} mono />
          <Fact
            name="Entries behind"
            value={never ? ABSENT : count(behind)}
            why={never
              ? 'Nothing acknowledged, so there is no gap to measure — which is worse than a '
                + 'large gap, not better.'
              : 'What a promotion right now would lose: entries written here that the standby '
                + 'has not confirmed holding.'}
          />
          <Fact name="Log head here" value={count(head)} />
          <Fact name="Acknowledged" value={never ? ABSENT : count(standby.acked_sequence)} />
          <Fact
            name="Last acknowledgement"
            value={present(standby.last_ack_at) ? clock(standby.last_ack_at, true) : ABSENT}
          />
          <Fact
            name="Authorised"
            value={standby.paired ? `sequence ${standby.authorized_sequence}` : 'no'}
            why="A signed consent given in advance, which a promoted standby carries as proof
              that it was entitled to take over. Configuration alone is not it."
          />
        </Facts>
      </div>
    </div>
  );
}

function MirrorRow({ mirror }) {
  return (
    <div className="cp-report" data-open="" data-state={mirror.stale ? 'stale' : undefined}>
      <div className="cp-report__head">
        <span className="cp-report__title">
          <Verdict tone={mirror.promoted ? 'accent' : (mirror.stale ? 'warn' : 'success')}>
            {mirror.promoted ? 'promoted' : (mirror.stale ? 'stale' : 'following')}
          </Verdict>
          <span className="truncate">{mirror.origin}</span>
        </span>
        <span className="cp-report__meta">
          {mirror.promoted
            ? 'this server is now the authority'
            : (present(mirror.behind_ms) ? `${duration(mirror.behind_ms)} behind` : ABSENT)}
        </span>
      </div>
      <div className="cp-report__body">
        {mirror.promoted ? (
          <Hint>
            This mirror was promoted, so nothing feeds it any more and it has no lag to report.
            A promoted mirror is not behind; it is finished.
          </Hint>
        ) : null}
        {mirror.last_error ? <Notice tone="danger">{mirror.last_error}</Notice> : null}
        <Facts>
          <Fact name="Origin" value={mirror.origin} mono />
          <Fact name="Cursor" value={count(mirror.cursor)} />
          <Fact
            name="Behind"
            value={present(mirror.behind_ms) ? duration(mirror.behind_ms) : ABSENT}
            why="Measured from the last entry actually applied, not from the last time the
              connection was alive."
          />
          <Fact
            name="Last applied"
            value={present(mirror.applied_at) ? clock(mirror.applied_at, true) : ABSENT}
          />
          <Fact
            name="Snapshot taken"
            value={present(mirror.snapshot_at) ? clock(mirror.snapshot_at, true) : ABSENT}
            why="The full copy this mirror started from. Everything since is the change log
              applied on top of it."
          />
        </Facts>
      </div>
    </div>
  );
}
