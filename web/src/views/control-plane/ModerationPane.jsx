import { useMemo, useState } from 'react';
import { reportError, toast } from '../../hooks/useToast.jsx';
import {
  Button, Field, Hint, Notice, Pill, Section, Select, TextArea,
} from '../../components/index.js';
import { Meter } from './Chart.jsx';
import { Facts, Fact, Freshness, Tile } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { useLive, useNow } from './useLive.js';
import { ABSENT, clock, count, duration, present } from './format.js';

const POLL_MS = 30_000;

const STATUS_TONE = { open: 'warn', actioned: 'danger', rejected: 'default' };

const STATUSES = [
  ['open', 'Open'],
  ['actioned', 'Actioned'],
  ['rejected', 'Rejected'],
  ['', 'Everything'],
];

function Report({ report, onResolve, busy }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const now = useNow(30_000);
  const evidence = Array.isArray(report.evidence) ? report.evidence : [];
  const closed = report.status !== 'open';

  return (
    <div className="cp-report" data-open={open ? '' : undefined}>
      <button type="button" className="cp-report__head" onClick={() => setOpen((v) => !v)}>
        <span className="cp-report__title">
          <Pill tone={STATUS_TONE[report.status] || 'default'}>{report.status}</Pill>
          <span className="truncate">{report.category}</span>
        </span>
        <span className="cp-report__meta">
          {`${report.target_type} · ${report.direction} · ${duration(now - report.created_at)} old`}
        </span>
      </button>

      {open ? (
        <div className="cp-report__body">
          <Facts>
            <Fact name="Target" value={`${report.target_type} ${report.target_id}`} mono />
            <Fact name="Reported by" value={report.reporter || 'a remote server'} mono />
            <Fact name="Origin" value={report.origin} mono />
            <Fact name="Filed" value={clock(report.created_at, true)} />
            {closed ? <Fact name="Closed by" value={report.handled_by} mono /> : null}
            {closed ? (
              <Fact
                name="Closed"
                value={present(report.handled_at) ? clock(report.handled_at, true) : ABSENT}
                why={present(report.handled_at)
                  ? `${duration(report.handled_at - report.created_at)} after it was filed`
                  : undefined}
              />
            ) : null}
          </Facts>

          {report.detail ? (
            <p className="cp-report__detail">{report.detail}</p>
          ) : (
            <Hint>The reporter left no description.</Hint>
          )}

          {evidence.length ? (
            <div className="cp-report__evidence">
              <span className="cp-report__evidence-label">
                {`Evidence submitted with the report (${evidence.length})`}
              </span>
              <pre>{JSON.stringify(evidence, null, 2)}</pre>
            </div>
          ) : null}

          {closed && report.resolution_note ? (
            <Notice>{`Outcome: ${report.resolution_note}`}</Notice>
          ) : null}
          {closed && !report.resolution_note ? (
            <Hint>Closed without a note, so there is no record of why.</Hint>
          ) : null}

          {closed ? (
            <div className="cp-bar">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onResolve(report.id, 'open', '')}
              >
                Reopen
              </Button>
              <Hint className="cp-bar__hint">
                Reopening clears the recorded outcome, because a reopened report has not been
                decided.
              </Hint>
            </div>
          ) : (
            <>
              <TextArea
                label="What you decided, and why"
                rows={2}
                value={note}
                maxLength={2000}
                placeholder="Optional. The next person on the rota reads this."
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="cp-bar">
                <Button size="sm" disabled={busy} onClick={() => onResolve(report.id, 'actioned', note)}>
                  Actioned
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onResolve(report.id, 'rejected', note)}
                >
                  Rejected
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ModerationPane() {
  const { home } = useControlPlane();
  const [status, setStatus] = useState('open');
  const [direction, setDirection] = useState('');
  const [busy, setBusy] = useState(false);

  const summary = useLive(() => home.adminModerationSummary(), { interval: POLL_MS });
  const list = useLive(
    () => home.adminReports(status ? { status, limit: 200 } : { limit: 200 }),
    { interval: POLL_MS, deps: [status] },
  );

  const reports = useMemo(() => {
    const all = list.data?.reports || [];
    return direction ? all.filter((r) => r.direction === direction) : all;
  }, [list.data, direction]);

  const directions = useMemo(() => {
    const seen = new Set((list.data?.reports || []).map((r) => r.direction));
    return [['', 'Either direction'], ...[...seen].sort().map((d) => [d, d])];
  }, [list.data]);

  const resolve = async (id, next, note) => {
    setBusy(true);
    try {
      await home.resolveAdminReport(id, next, note);
      toast(next === 'open' ? 'Report reopened.' : `Report marked ${next}.`);
      list.reload();
      summary.reload();
    } catch (e) {
      reportError(e, 'Could not update the report');
    } finally {
      setBusy(false);
    }
  };

  const s = summary.data;
  const counts = s?.counts || {};
  const res = s?.resolution || {};

  return (
    <>
      <Section
        title="The queue"
        description="Reports filed on this server and reports federated to it. Counts and
          durations only — there is no view here of anything nobody reported."
        actions={<Freshness at={summary.at} error={summary.error} interval={POLL_MS} />}
      >
        <div className="cp-tiles">
          <Tile label="Open" value={count(counts.open ?? 0)} tone={counts.open ? 'warn' : undefined} />
          <Tile
            label="Oldest open"
            value={present(s?.oldest_open_ms) ? duration(s.oldest_open_ms) : ABSENT}
            note={present(s?.oldest_open_ms) ? 'has been waiting' : 'nothing waiting'}
            tone={s?.oldest_open_ms > 2 * 60 * 60 * 1000 ? 'warn' : undefined}
          />
          <Tile
            label="Typical time to close"
            value={present(res.p50_ms) ? duration(res.p50_ms) : ABSENT}
            note={res.samples >= 5
              ? `median of the last ${res.samples}`
              : `${res.samples ?? 0} closed — too few to say`}
            title="A median over the last two hundred closures, shown only once there are at
              least five. Below that it would be one person's afternoon wearing a statistic's name."
          />
          <Tile
            label="Slowest tenth"
            value={present(res.p90_ms) ? duration(res.p90_ms) : ABSENT}
            note="p90 time to close"
          />
          <Tile label="Actioned" value={count(counts.actioned ?? 0)} />
          <Tile label="Rejected" value={count(counts.rejected ?? 0)} />
        </div>

        {s?.open_by_category?.length ? (
          <Meter
            rows={s.open_by_category.map((r) => ({ label: r.category, value: r.count }))}
            format={(v) => count(v)}
            tone="warning"
          />
        ) : null}

        {s?.open_by_direction?.length ? (
          <Hint>
            {s.open_by_direction
              .map((r) => `${r.count} ${r.direction}`)
              .join(', ')}
            {' open.'}
          </Hint>
        ) : null}
      </Section>

      <Section
        title="Reports"
        actions={(
          <Button size="sm" variant="ghost" onClick={() => { list.reload(); summary.reload(); }}>
            Refresh
          </Button>
        )}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Status">
            <Select value={status} options={STATUSES} onChange={(e) => setStatus(e.target.value)} />
          </Field>
          <Field label="Direction">
            <Select
              value={direction}
              options={directions}
              onChange={(e) => setDirection(e.target.value)}
            />
          </Field>
        </div>

        {list.error ? (
          <Notice tone="danger">
            {list.error?.body?.message || list.error?.message || String(list.error)}
          </Notice>
        ) : null}

        {list.loading && !list.data ? <Hint>Reading the queue.</Hint> : null}

        {list.data && !reports.length ? (
          <Notice tone={status === 'open' ? 'success' : 'default'}>
            {status === 'open'
              ? 'Nothing open. The queue is empty rather than unmeasured — this server has '
                + `${count(counts.actioned ?? 0)} actioned and ${count(counts.rejected ?? 0)} `
                + 'rejected reports behind it.'
              : 'No reports match this filter.'}
          </Notice>
        ) : null}

        <div className="cp-reports">
          {reports.map((r) => (
            <Report key={r.id} report={r} onResolve={resolve} busy={busy} />
          ))}
        </div>

        {reports.length >= 200 ? (
          <Hint>
            Two hundred shown. The server caps the page rather than sending a queue that has been
            accumulating for years into a browser.
          </Hint>
        ) : null}
      </Section>

      <Section title="What this pane cannot do">
        <Facts>
          <Fact
            name="Read a conversation"
            value="No"
            why="Direct messages are end-to-end encrypted; the server routes frames it cannot
              read, so there is nothing for this screen to show even if it asked."
          />
          <Fact
            name="Show a person's activity"
            value="No"
            why="Moderation acts on what was reported. A per-account history would be a
              surveillance tool that happens to live behind the same password."
          />
          <Fact
            name="Keep a separate audit store"
            value="No"
            why="The durations above are arithmetic on the report rows themselves — handled_at
              minus created_at — so no second copy of a moderation history exists to leak,
              subpoena or get out of step with the queue."
          />
        </Facts>
      </Section>
    </>
  );
}
