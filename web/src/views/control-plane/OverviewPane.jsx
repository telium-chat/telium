import { Button, DataTable, Hint, Notice, Section } from '../../components/index.js';
import { Sparkline, TimeChart } from './Chart.jsx';
import { Facts, Fact, Freshness, Readout, Tile } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { restoreReadiness, signals, verdict } from './health.js';
import {
  ABSENT, count, duration, millis, present, rate, share, size,
} from './format.js';

const HOUR = 60 * 60 * 1000;

export function OverviewPane() {
  const { home, metrics, status, health } = useControlPlane();
  const m = metrics.data;

  const recent = useLive(
    () => home.adminMetricsSeries({ since: Date.now() - HOUR, until: Date.now(), points: 60 }),
    { interval: 60_000 },
  );
  const points = recent.data?.points || [];

  const list = signals({ metrics: m, status: status.data, health: health?.data });
  const said = verdict(list);
  const ready = restoreReadiness(status.data);

  const healthMissing = health?.error?.status === 404;
  const healthBroken = Boolean(health?.error) && !healthMissing;

  if (metrics.loading && !m) {
    return <Hint>Reading the server.</Hint>;
  }

  if (metrics.error && !m) {
    return (
      <Notice tone="danger">
        <div className="font-medium">This server did not answer.</div>
        <div className="mt-1">
          {metrics.error?.body?.message || metrics.error?.message || String(metrics.error)}
        </div>
        <Button className="mt-2" variant="ghost" onClick={() => metrics.reload()}>Try again</Button>
      </Notice>
    );
  }

  const req = m?.requests || {};
  const lat = m?.latency || {};
  const fed = m?.federation || {};
  const gw = m?.gateway || {};
  const msg = m?.messages || {};
  const store = m?.storage || {};
  const pool = m?.pool || {};
  const uptime = m?.uptime_ms;

  return (
    <>
      <Section
        title={said.text}
        description={
          m?.enabled === false
            ? 'Measurement is switched off in this server’s configuration.'
            : `Counters below are since this process started ${duration(uptime)} ago. `
              + 'Everything on this screen is a whole-server total.'
        }
        actions={(
          <>
            <Freshness at={metrics.at} error={metrics.error} />
            <Button
              variant="ghost"
              onClick={() => {
                metrics.reload();
                status.reload();
                health?.reload?.();
                recent.reload();
              }}
            >
              Refresh
            </Button>
          </>
        )}
      >
        {list.length ? (
          <div className="cp-signals">
            {list.map((s) => (
              <div key={s.key} className="cp-signal" data-tone={s.tone}>
                <div className="cp-signal__title">{s.title}</div>
                {s.detail ? <div className="cp-signal__cause">{s.detail}</div> : null}
                {s.action ? <div className="cp-signal__action">{s.action}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <Notice tone="success">
            {healthMissing
              ? 'Error rate, the slow tail, the federation queue, peer reachability, the '
                + 'database pool and backup freshness were all checked and none of them had '
                + 'anything to say.'
              : 'Everything both this client and the server itself know how to check was '
                + 'checked — traffic, federation, storage, keys, replication, backups — and '
                + 'none of it had anything to say.'}
          </Notice>
        )}
        {healthMissing ? (
          <Hint>
            This server does not offer the deeper checks — signing keys, replication, the media
            scanner, the voice prober. Everything above is what this client can work out from
            the numbers it already has.
          </Hint>
        ) : null}
        {healthBroken ? (
          <Notice tone="warn">
            <div className="font-medium">The server’s own checks are not answering.</div>
            <div className="mt-0.5">
              {(health?.error?.body?.message || health?.error?.message || String(health?.error))
                + ' — so the list above is only what this client could work out for itself, '
                + 'and a quiet screen is not evidence of a quiet server.'}
            </div>
          </Notice>
        ) : null}
        {metrics.error && m ? (
          <Notice tone="warn">
            The numbers below are the last ones this server gave up. It has stopped answering since.
          </Notice>
        ) : null}
      </Section>

      <Section
        title="Recovery"
        description="Not whether a backup file exists — whether one was fetched, decrypted and
          read back far enough to prove this server is inside it."
      >
        <Readout tone={ready.tone} question="Could this server recover right now?" answer={ready.word}>
          <div>{ready.because}</div>
          {ready.advice ? <div className="mt-1.5 text-muted">{ready.advice}</div> : null}
        </Readout>

        {ready.excluded.map((e) => (
          <Notice key={e.kind} tone="warn">
            <div className="font-medium">
              A restore would come back without this server’s {e.kind}
            </div>
            <div className="mt-0.5">{e.says}</div>
          </Notice>
        ))}

        {ready.warnings.map((w) => (
          <Notice key={w} tone="warn">{w}</Notice>
        ))}

        <Facts>
          <Fact
            name="Last proved recoverable"
            value={ready.since ? `${ready.since} ago` : 'never'}
            why={ready.answer === 'yes' ? undefined
              : 'The last time a drill got all the way through. A failure since then does not '
                + 'erase it, and it does not make it current either.'}
          />
          <Fact name="Drilled from" value={ready.sourceText} />
          <Fact name="Archive" value={ready.archive} mono />
          <Fact name="Rehearsal took" value={ready.took} />
        </Facts>

        {ready.checked.length ? (
          <>
            <div className="cp-tile__label">What the rehearsal saw inside it</div>
            <Facts>
              {ready.checked.map((c) => <Fact key={c.key} name={c.name} value={c.value} />)}
            </Facts>
          </>
        ) : null}

        {ready.omitted.length ? (
          <Hint>
            Left out on purpose:{' '}
            {ready.omitted.map((e) => e.says).join('; ')}. A restore comes back without it.
          </Hint>
        ) : null}

        <Hint>{ready.caveat}</Hint>
      </Section>

      {m?.enabled === false ? (
        <Section title="Measurement is off">
          <Hint>
            Set <code>enabled = true</code> under <code>[metrics]</code> in the server’s
            configuration and restart to collect these. Moderation, federation and storage below
            work either way — they read state the server keeps regardless.
          </Hint>
        </Section>
      ) : (
        <>
          <Section title="Traffic">
            <div className="cp-tiles">
              <Tile
                label="Requests"
                value={count(req.total)}
                note={rate(req.total, uptime)}
                title="Every HTTP request this process has served, including the ones it refused."
              />
              <Tile
                label="From peers"
                value={count(req.federation)}
                note={`${share(req.federation, req.total)} of all requests`}
              />
              <Tile
                label="Refused"
                value={count(req.responses_4xx)}
                note={`${share(req.responses_4xx, req.total)} — rate limits, auth, bad input`}
              />
              <Tile
                label="Server errors"
                value={count(req.responses_5xx)}
                note={share(req.responses_5xx, req.total)}
                tone={req.responses_5xx > 0 ? 'danger' : undefined}
              />
            </div>
            <TimeChart
              points={points}
              height={120}
              label="Requests and server errors over the last hour"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'req', label: 'Requests', tone: 'accent', kind: 'area', value: (p) => p.requests },
                { key: 'err', label: '5xx', tone: 'danger', kind: 'line', value: (p) => p.responses_5xx },
              ]}
            />
          </Section>

          <Section
            title="Latency"
            description="Percentiles, never a mean: one request in a hundred is what an
              operator is being asked about, and an average hides exactly that one."
          >
            <div className="cp-tiles">
              <Tile label="p50" value={millis(lat.p50_ms)} note="half of requests are faster" />
              <Tile label="p90" value={millis(lat.p90_ms)} note="nine in ten are faster" />
              <Tile
                label="p99"
                value={millis(lat.p99_ms)}
                note={present(lat.p99_ms) ? 'ninety-nine in a hundred are faster' : 'needs 100 samples'}
                tone={lat.p99_ms >= 2000 ? 'warn' : undefined}
              />
              <Tile
                label="Past the ceiling"
                value={count(lat.over_ceiling)}
                note={`slower than ${lat.ceiling_ms}s, which the histogram cannot measure`}
                tone={lat.over_ceiling > 0 ? 'warn' : undefined}
              />
            </div>
            <TimeChart
              points={points}
              height={120}
              label="Request latency percentiles over the last hour"
              format={(v) => millis(v)}
              series={[
                { key: 'p50', label: 'p50', tone: 'muted', kind: 'line', value: (p) => p.p50_ms },
                { key: 'p90', label: 'p90', tone: 'accent', kind: 'line', value: (p) => p.p90_ms },
                { key: 'p99', label: 'p99', tone: 'danger', kind: 'line', value: (p) => p.p99_ms },
              ]}
            />
          </Section>

          <Section title="What the server is carrying">
            <div className="cp-tiles">
              <Tile
                label="Gateway connections"
                value={count(gw.connections)}
                note={present(gw.accounts) ? `${count(gw.accounts)} accounts` : undefined}
              >
                <Sparkline points={points} value={(p) => p.gateway_connections} />
              </Tile>
              <Tile
                label="Messages accepted"
                value={count((msg.guild ?? 0) + (msg.dm ?? 0))}
                note={`${count(msg.guild)} guild · ${count(msg.dm)} direct`}
              />
              <Tile
                label="Federation queue"
                value={count(fed.backlog)}
                note={present(fed.backlog_oldest_ms)
                  ? `oldest waiting ${duration(fed.backlog_oldest_ms)}`
                  : 'nothing waiting'}
                tone={fed.backlog_oldest_ms >= 15 * 60_000 ? 'warn' : undefined}
              />
              <Tile
                label="Peers"
                value={count(fed.peers)}
                note={fed.peers_failing ? `${count(fed.peers_failing)} failing` : 'all reachable at last contact'}
                tone={fed.peers_failing > 0 ? 'warn' : undefined}
              />
              <Tile label="Database" value={size(store.db_bytes)} note="file plus write-ahead log" />
              <Tile
                label="Media stored"
                value={size(store.media_bytes)}
                note={present(store.media_objects) ? `${count(store.media_objects)} objects` : 'media role off'}
              />
              <Tile
                label="Bandwidth out"
                value={size(m?.bandwidth?.bytes_out)}
                note={m?.bandwidth?.responses_unmeasured
                  ? `floor — ${count(m.bandwidth.responses_unmeasured)} responses had no declared length`
                  : 'declared response lengths'}
              />
              <Tile
                label="Database pool"
                value={present(pool.connections) ? `${pool.connections}/${pool.max}` : ABSENT}
                note={present(pool.idle) ? `${pool.idle} idle` : undefined}
                tone={pool.connections >= pool.max && pool.idle === 0 ? 'warn' : undefined}
              />
            </div>
          </Section>

          <Section
            title="Routes"
            description="Matched patterns, never paths. A table keyed by the URL as requested
              would be an unbounded list of which conversations and which accounts were busy;
              this one has a row per route the server declares and cannot say more than that."
          >
            <DataTable
              rows={slowest(m?.routes || [])}
              rowKey={(r) => r.route}
              empty="No requests since this process started."
              label="Busiest and slowest routes"
              columns={[
                { key: 'route', header: 'Route', render: (r) => r.route, mono: true },
                { key: 'requests', header: 'Requests', align: 'end', render: (r) => count(r.requests) },
                { key: 'errors', header: 'Errors', align: 'end', render: (r) => count(r.errors) },
                { key: 'p50', header: 'p50', align: 'end', render: (r) => millis(r.p50_ms) },
                { key: 'p99', header: 'p99', align: 'end', render: (r) => millis(r.p99_ms) },
              ]}
            />
          </Section>
        </>
      )}

      <Section title="This server">
        <Facts>
          <Fact name="Server name" value={m?.server_name} mono />
          <Fact name="Up for" value={duration(uptime)} />
          <Fact
            name="Rollup interval"
            value={m?.interval_secs ? `${m.interval_secs}s` : ABSENT}
            why="How often the in-memory counters are written to the history table. Nothing is
              written per request."
          />
          <Fact
            name="History kept"
            value={m?.retention_days ? `${m.retention_days} days` : ABSENT}
            why="Older rollup rows are deleted on the same tick that writes new ones."
          />
        </Facts>
      </Section>
    </>
  );
}

function slowest(routes) {
  return [...routes]
    .sort((a, b) => (b.p99_ms ?? b.p50_ms ?? -1) - (a.p99_ms ?? a.p50_ms ?? -1)
      || b.requests - a.requests)
    .slice(0, 6);
}
