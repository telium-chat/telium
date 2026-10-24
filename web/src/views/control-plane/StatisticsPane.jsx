import { useState } from 'react';
import { Button, Hint, Notice, Section } from '../../components/index.js';
import { TimeChart } from './Chart.jsx';
import { Facts, Fact, Freshness } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { clock, count, duration, millis, present, size } from './format.js';

const MINUTE = 60_000;

const RANGES = [
  { key: '1h', label: '1 hour', span: 60 * MINUTE, points: 60, refresh: 30_000 },
  { key: '6h', label: '6 hours', span: 6 * 60 * MINUTE, points: 120, refresh: 60_000 },
  { key: '24h', label: '24 hours', span: 24 * 60 * MINUTE, points: 144, refresh: 120_000 },
  { key: '7d', label: '7 days', span: 7 * 24 * 60 * MINUTE, points: 168, refresh: 300_000 },
  { key: '30d', label: '30 days', span: 30 * 24 * 60 * MINUTE, points: 180, refresh: 600_000 },
];

export function StatisticsPane() {
  const { home } = useControlPlane();
  const [rangeKey, setRangeKey] = useState('6h');
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[1];

  const series = useLive(
    () => home.adminMetricsSeries({
      since: Date.now() - range.span,
      until: Date.now(),
      points: range.points,
    }),
    { interval: range.refresh, deps: [rangeKey] },
  );

  const data = series.data;
  const points = data?.points || [];
  const partial = points.filter((p) => p.covered_ms < (p.end - p.start) * 0.98).length;
  const spanDays = range.span > 36 * 60 * MINUTE;

  if (data?.enabled === false) {
    return (
      <Notice tone="warn">
        Measurement is switched off in this server’s configuration, so there is no history to
        draw. Nothing has been lost — the collector simply is not running.
      </Notice>
    );
  }

  return (
    <>
      <Section
        description="Rolled up once a rollup interval and kept for as long as the retention
          setting says. Nothing here is a per-message record; there is no such record to draw."
        actions={<Freshness at={series.at} error={series.error} interval={range.refresh} />}
      >
        <div className="cp-bar">
          {RANGES.map((r) => (
            <Button
              key={r.key}
              size="sm"
              variant={r.key === rangeKey ? 'primary' : 'ghost'}
              onClick={() => setRangeKey(r.key)}
            >
              {r.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="ms-auto" onClick={() => series.reload()}>
            Refresh
          </Button>
        </div>

        {series.loading && !data ? <Hint>Reading the history.</Hint> : null}
        {series.error ? (
          <Notice tone="danger">
            {series.error?.body?.message || series.error?.message || String(series.error)}
          </Notice>
        ) : null}

        {data && !points.length ? (
          <Notice>
            {present(data.earliest)
              ? `Nothing was rolled up in this window. The oldest history this server still holds
                 is from ${clock(data.earliest, true)}; anything older than
                 ${data.retention_days} days has been deleted.`
              : 'This server has not written a rollup bucket yet. The first one lands at the end '
                + 'of the current interval.'}
          </Notice>
        ) : null}

        {partial ? (
          <Hint>
            {`${partial} of these ${points.length} points cover less wall-clock time than their span —
              the server was not running for all of it. The counts in those points are real; they are
              just counts of a shorter window.`}
          </Hint>
        ) : null}
      </Section>

      {points.length ? (
        <>
          <Section title="Requests">
            <TimeChart
              points={points}
              label="Requests per bucket"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'req', label: 'All requests', tone: 'accent', kind: 'area', value: (p) => p.requests },
                { key: 'fed', label: 'From peers', tone: 'success', kind: 'line', value: (p) => p.requests_federation },
              ]}
            />
            <TimeChart
              points={points}
              height={110}
              label="Refused and failed responses per bucket"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'c4', label: 'Refused (4xx)', tone: 'warning', kind: 'line', value: (p) => p.responses_4xx },
                { key: 'c5', label: 'Errors (5xx)', tone: 'danger', kind: 'area', value: (p) => p.responses_5xx },
              ]}
            />
          </Section>

          <Section
            title="Latency"
            description="Merged from the stored histograms and re-computed for this range, so the
              percentiles are exact at every zoom level rather than averages of averages."
          >
            <TimeChart
              points={points}
              label="Request latency percentiles"
              format={(v) => millis(v)}
              series={[
                { key: 'p50', label: 'p50', tone: 'muted', kind: 'line', value: (p) => p.p50_ms },
                { key: 'p90', label: 'p90', tone: 'accent', kind: 'line', value: (p) => p.p90_ms },
                { key: 'p99', label: 'p99', tone: 'danger', kind: 'line', value: (p) => p.p99_ms },
              ]}
            />
            <Hint>
              A percentile is missing from a bucket that had too few requests to support it — a
              hundred for p99, ten for p90, two for p50. The line breaks there rather than
              reporting the slowest request of three under a name that promises otherwise.
            </Hint>
          </Section>

          <Section
            title="Messages"
            description="Counts by transport. Nothing about who sent them, to whom, or what
              they said — direct messages are end-to-end encrypted and this server could not
              tell you the last of those even if this screen asked."
          >
            <TimeChart
              points={points}
              label="Messages accepted per bucket"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'guild', label: 'Guild', tone: 'accent', kind: 'area', value: (p) => p.messages_guild },
                { key: 'dm', label: 'Direct', tone: 'success', kind: 'area', value: (p) => p.messages_dm },
              ]}
            />
            <TimeChart
              points={points}
              height={110}
              label="Gateway traffic per bucket"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'out', label: 'Events pushed', tone: 'accent', kind: 'line', value: (p) => p.gateway_events_out },
                { key: 'in', label: 'Frames received', tone: 'muted', kind: 'line', value: (p) => p.gateway_frames_in },
                { key: 'conn', label: 'Connections', tone: 'warning', kind: 'line', value: (p) => p.gateway_connections },
              ]}
            />
          </Section>

          <Section
            title="Bandwidth"
            description="Declared Content-Length, in and out. A response the server streams
              without declaring a length is counted as one unmeasured response rather than
              guessed at, so this is a floor with a known number of omissions."
          >
            <TimeChart
              points={points}
              label="Bytes in and out per bucket"
              format={(v) => size(Math.round(v))}
              series={[
                { key: 'out', label: 'Out', tone: 'accent', kind: 'area', value: (p) => p.bytes_out },
                { key: 'in', label: 'In', tone: 'success', kind: 'area', value: (p) => p.bytes_in },
              ]}
            />
          </Section>

          <Section
            title="Federation"
            description="Deliveries this server made to other servers, and the ones that failed
              and went back on the queue."
          >
            <TimeChart
              points={points}
              label="Federation deliveries per bucket"
              format={(v) => count(Math.round(v))}
              series={[
                { key: 'ok', label: 'Delivered', tone: 'accent', kind: 'area', value: (p) => p.federation_deliveries },
                { key: 'fail', label: 'Failed', tone: 'danger', kind: 'line', value: (p) => p.federation_delivery_failures },
                { key: 'queue', label: 'Queued', tone: 'warning', kind: 'line', value: (p) => p.federation_backlog },
              ]}
            />
          </Section>

          <Section
            title="Storage"
            description="Sampled on a slower clock than the counters, so these lines are drawn
              from the buckets that carry a sample and break across the ones that do not."
          >
            <TimeChart
              points={points}
              label="Stored bytes over time"
              format={(v) => size(Math.round(v))}
              series={[
                { key: 'db', label: 'Database', tone: 'accent', kind: 'line', value: (p) => p.db_bytes },
                { key: 'media', label: 'Media', tone: 'success', kind: 'line', value: (p) => p.media_bytes },
                { key: 'cache', label: 'Remote cache', tone: 'muted', kind: 'line', value: (p) => p.media_cache_bytes },
                { key: 'cold', label: 'Cold archive', tone: 'warning', kind: 'line', value: (p) => p.cold_bytes },
              ]}
            />
          </Section>

          <Section title="This range">
            <Facts>
              <Fact name="From" value={clock(data.since, spanDays)} />
              <Fact name="To" value={clock(data.until, spanDays)} />
              <Fact name="Points" value={`${points.length} × ${duration(points[0].end - points[0].start)}`} />
              <Fact
                name="Oldest history held"
                value={present(data.earliest) ? clock(data.earliest, true) : 'nothing rolled up yet'}
                why={`Retention is ${data.retention_days} days; rows older than that are deleted as
                  each new bucket is written.`}
              />
            </Facts>
          </Section>
        </>
      ) : null}
    </>
  );
}
