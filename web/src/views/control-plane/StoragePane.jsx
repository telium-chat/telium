import { useState } from 'react';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { Button, Hint, Notice, Section } from '../../components/index.js';
import { Meter, TimeChart } from './Chart.jsx';
import { Facts, Fact, Freshness, Tile } from './Bits.jsx';
import { useControlPlane } from './context.js';
import { useLive } from './useLive.js';
import { ABSENT, count, duration, present, share, size } from './format.js';

const POLL_MS = 60_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function growth(points, pick) {
  const seen = points
    .map((p) => ({ at: (p.start + p.end) / 2, v: pick(p) }))
    .filter((p) => present(p.v));
  if (seen.length < 2) return null;
  const first = seen[0];
  const last = seen[seen.length - 1];
  const days = (last.at - first.at) / 86_400_000;
  if (days <= 0) return null;
  return (last.v - first.v) / days;
}

function Backup({ backup }) {
  if (!backup) return null;
  if (!backup.enabled) {
    return (
      <Notice tone="warn">
        Scheduled backups are switched off. Nothing here is broken; there is simply nothing to
        restore from if this machine is lost.
      </Notice>
    );
  }
  const tone = backup.last_error || backup.remote?.last_error
    ? 'danger'
    : (backup.stale ? 'warn' : 'success');
  return (
    <>
      <Notice tone={tone}>
        {backup.age_ms == null
          ? 'No backup has ever completed on this server.'
          : `Newest local backup is ${duration(backup.age_ms)} old.`}
        {backup.remote?.enabled
          ? (backup.remote.age_ms == null
            ? ' No off-box copy has been uploaded.'
            : ` Off-box copy is ${duration(backup.remote.age_ms)} old.`)
          : ' No off-box copy is configured.'}
      </Notice>
      {backup.last_error || backup.remote?.last_error ? (
        <Notice tone="danger">
          {`Last error: ${backup.last_error || backup.remote?.last_error}`}
        </Notice>
      ) : null}
      <Facts>
        <Fact
          name="Where it lands"
          value={backup.placement}
          why="A backup on the same volume as the database survives a mistake but not a dead
            disk. This is the difference between having a backup and having a copy."
        />
        <Fact name="Off-box" value={backup.offsite ? 'yes' : 'no'} />
        <Fact
          name="Key stranded"
          value={backup.key_stranded ? 'yes — the key lives only where the backup does' : 'no'}
          why={backup.key_stranded
            ? 'An encrypted archive whose only key is on the machine it was taken from '
              + 'cannot be restored after that machine is gone.'
            : undefined}
        />
      </Facts>
    </>
  );
}

export function StoragePane() {
  const { home, status } = useControlPlane();
  const [busy, setBusy] = useState(false);
  const [sweep, setSweep] = useState(null);

  const store = useLive(() => home.adminStorage(), { interval: POLL_MS });
  const history = useLive(
    () => home.adminMetricsSeries({ since: Date.now() - WEEK, until: Date.now(), points: 42 }),
    { interval: 300_000 },
  );

  const s = store.data;
  const points = history.data?.points || [];
  const dbPerDay = growth(points, (p) => p.db_bytes);
  const mediaPerDay = growth(points, (p) => p.media_bytes);

  const act = async (fn, label, bad) => {
    setBusy(true);
    try {
      const out = await fn();
      toast(label);
      store.reload();
      return out;
    } catch (e) {
      reportError(e, bad);
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="What is on disk"
        actions={<Freshness at={store.at} error={store.error} interval={POLL_MS} />}
      >
        {store.error ? (
          <Notice tone="danger">
            {store.error?.body?.message || store.error?.message || String(store.error)}
          </Notice>
        ) : null}
        {store.loading && !s ? <Hint>Measuring.</Hint> : null}

        {s ? (
          <div className="cp-tiles">
            <Tile
              label="Database"
              value={size(s.db_bytes)}
              note={present(dbPerDay)
                ? `${dbPerDay >= 0 ? '+' : ''}${size(Math.abs(dbPerDay))}/day`
                : 'growth not measurable yet'}
            />
            <Tile
              label="Media stored"
              value={s.media_enabled ? size(s.media_bytes) : ABSENT}
              note={s.media_enabled
                ? `${count(s.media_objects)} objects`
                : 'this server does not host media'}
            />
            <Tile
              label="Media growth"
              value={present(mediaPerDay)
                ? `${mediaPerDay >= 0 ? '+' : ''}${size(Math.abs(mediaPerDay))}`
                : ABSENT}
              note="per day, over the last week"
            />
            <Tile
              label="Remote cache"
              value={size(s.media_cache_bytes)}
              note={s.media_cache_max_bytes
                ? `${share(s.media_cache_bytes, s.media_cache_max_bytes)} of the cap`
                : 'no cap configured'}
              tone={s.media_cache_max_bytes
                && s.media_cache_bytes / s.media_cache_max_bytes > 0.9 ? 'warn' : undefined}
            />
            <Tile
              label="Reclaimable"
              value={s.media_enabled ? size(s.unreferenced_bytes) : ABSENT}
              note={s.media_enabled
                ? `${count(s.unreferenced_objects)} objects nothing refers to`
                : undefined}
              tone={s.unreferenced_bytes > 0 ? 'warn' : undefined}
            />
            <Tile
              label="Cold archive"
              value={s.cold?.enabled ? size(s.cold.bytes) : ABSENT}
              note={s.cold?.enabled
                ? `${count(s.cold.segments)} segments, ${count(s.cold.messages)} messages`
                : 'archiving is off'}
            />
          </div>
        ) : null}

        {points.length ? (
          <TimeChart
            points={points}
            label="Stored bytes, last seven days"
            format={(v) => size(Math.round(v))}
            series={[
              { key: 'db', label: 'Database', tone: 'accent', kind: 'line', value: (p) => p.db_bytes },
              { key: 'media', label: 'Media', tone: 'success', kind: 'line', value: (p) => p.media_bytes },
              { key: 'cache', label: 'Remote cache', tone: 'muted', kind: 'line', value: (p) => p.media_cache_bytes },
              { key: 'cold', label: 'Cold', tone: 'warning', kind: 'line', value: (p) => p.cold_bytes },
            ]}
          />
        ) : null}
        <Hint>
          Storage is sampled on its own slower clock, so the lines above have gaps where no
          sample was taken. A gap is not a dip to zero and is not drawn as one.
        </Hint>
      </Section>

      {s?.media_enabled && s.media_by_purpose?.length ? (
        <Section
          title="Media by purpose"
          description="What the files are for, not who uploaded them. The media table has an
            uploader column and this screen does not read it."
        >
          <Meter
            rows={s.media_by_purpose.map((r) => ({ label: r.purpose, value: r.bytes }))}
            format={(v) => size(v)}
          />
          <Facts>
            {s.media_by_purpose.map((r) => (
              <Fact key={r.purpose} name={r.purpose} value={`${count(r.objects)} objects`} />
            ))}
          </Facts>
        </Section>
      ) : null}

      <Section
        title="Reclaiming space"
        description="Both of these are safe to run while the server is serving. Neither deletes
          anything a live reference still points at."
      >
        <div className="cp-bar">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              const out = await act(
                () => home.adminStorageSweep(),
                'Sweep finished.',
                'Could not sweep',
              );
              if (out) setSweep(out);
            }}
          >
            Sweep now
          </Button>
          <Hint className="cp-bar__hint">
            Drops expired remote-cache entries and deletes media files whose reference count has
            reached zero.
          </Hint>
        </div>
        {sweep ? (
          <Notice tone="success">
            {`Removed ${count(sweep.cache_entries)} expired cache entries and `
             + `${count(sweep.orphan_files)} unreferenced files.`}
          </Notice>
        ) : null}
        {present(s?.media_cache_expired) && s.media_cache_expired > 0 ? (
          <Hint>{`${count(s.media_cache_expired)} cache entries are already past their expiry.`}</Hint>
        ) : null}

        <div className="cp-bar">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !s?.cold?.enabled}
            title={s?.cold?.enabled
              ? undefined
              : 'Archiving is disabled in [archive]. That is a configuration change and a restart.'}
            onClick={() => act(
              () => home.adminArchiveNow(),
              'Archive pass started.',
              'Could not start the archive pass',
            )}
          >
            Archive old history now
          </Button>
          <Hint className="cp-bar__hint">
            {s?.cold?.enabled
              ? `Compresses guild history older than ${s.cold.horizon_days} days into cold
                 segments, keeping the newest ${count(s.cold.keep_hot_messages)} messages of each
                 channel hot. Archived history stays readable and searchable.`
              : 'Cold archiving is switched off for this server.'}
          </Hint>
        </div>
        {s?.cold?.enabled ? (
          <Facts>
            <Fact name="Segment directory" value={s.cold.dir} mono />
            <Fact
              name="Horizon"
              value={`${s.cold.horizon_days} days`}
              why="Guild messages older than this are candidates for a cold segment."
            />
            <Fact name="Kept hot per channel" value={count(s.cold.keep_hot_messages)} />
          </Facts>
        ) : null}
      </Section>

      <Section
        title="Backups"
        actions={<Freshness at={status.at} error={status.error} interval={60_000} />}
      >
        <Backup backup={s?.backup || status.data?.backup} />
        <Hint>
          A backup you have never restored is an assumption. The restore procedure is in
          docs/backup.md and it is worth a rehearsal on a spare machine before it is worth
          anything here.
        </Hint>
      </Section>
    </>
  );
}
