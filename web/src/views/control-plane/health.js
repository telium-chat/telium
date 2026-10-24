import { count, duration, present, size } from './format.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const TONES = { critical: 'danger', warning: 'warn', notice: 'accent' };

const SUPERSEDED_BY = {
  backup: ['backup.stale', 'backup.never'],
  'backup-error': ['backup.error'],
  backlog: ['federation.backlog'],
  peers: ['federation.peers_failing'],
};

export function signals({ metrics, status, health }) {
  const out = [];
  const add = (key, tone, title, detail) => out.push({
    key, tone, title, detail, action: null, source: 'client',
  });

  if (metrics && metrics.enabled === false) {
    add('collector', 'warn', 'Measurement is off',
      'This server is running with [metrics] enabled = false, so the numbers on '
      + 'this screen are not being collected. The rest of the control plane still works.');
  }

  if (metrics?.enabled) {
    const req = metrics.requests || {};
    const total = req.total || 0;
    if (total > 200 && req.responses_5xx) {
      const rate = req.responses_5xx / total;
      if (rate >= 0.01) {
        add('errors', 'danger', 'Requests are failing',
          `${req.responses_5xx.toLocaleString()} of ${total.toLocaleString()} responses since `
          + 'this process started were server errors. Look at the statistics pane to see whether '
          + 'that is now or was earlier.');
      } else if (rate >= 0.001) {
        add('errors', 'warn', 'Some requests are failing',
          `${req.responses_5xx.toLocaleString()} server errors out of ${total.toLocaleString()} responses.`);
      }
    }

    const lat = metrics.latency || {};
    if (present(lat.p99_ms) && lat.p99_ms >= 2000) {
      add('latency', lat.p99_ms >= 8000 ? 'danger' : 'warn', 'The slow tail is slow',
        `The 99th percentile is ${Math.round(lat.p99_ms)}ms. One request in a hundred is taking `
        + 'at least that long.');
    }
    if (lat.over_ceiling > 0) {
      add('ceiling', 'warn', 'Requests past the measurable ceiling',
        `${lat.over_ceiling.toLocaleString()} requests took longer than ${lat.ceiling_ms}s, which is `
        + 'past the top of the histogram — the percentiles above cannot see how far past.');
    }

    const fed = metrics.federation || {};
    if (present(fed.backlog_oldest_ms) && fed.backlog_oldest_ms >= 15 * MINUTE) {
      add('backlog', fed.backlog_oldest_ms >= 2 * HOUR ? 'danger' : 'warn',
        'Federation is behind',
        `The oldest undelivered item has been waiting ${Math.round(fed.backlog_oldest_ms / MINUTE)} `
        + `minutes; ${(fed.backlog ?? 0).toLocaleString()} are queued. Check the federation pane for `
        + 'which peer is not answering.');
    }
    if (fed.peers_failing > 0) {
      add('peers', 'warn', 'Peers are not answering',
        `${fed.peers_failing} of ${fed.peers ?? '?'} known peers have consecutive discovery failures.`);
    }

    const pool = metrics.pool || {};
    if (present(pool.connections) && pool.max && pool.connections >= pool.max && pool.idle === 0) {
      add('pool', 'warn', 'The database pool is saturated',
        `All ${pool.max} connections are checked out and none is idle. Requests are queueing for the `
        + 'database rather than for the network.');
    }
  }

  if (status?.incompatible_peers > 0) {
    const n = status.incompatible_peers;
    add('protocol', 'warn',
      n === 1 ? 'A peer speaks a protocol version this server does not'
        : `${n} peers speak a protocol version this server does not`,
      'Nothing federates with them until one side is upgraded, and no amount of waiting '
      + 'will change that. The federation pane names each one, which version it speaks, '
      + 'and whose move it is.');
  }

  const backup = status?.backup;
  if (backup?.enabled && backup.stale) {
    add('backup', 'warn', 'Backups are stale',
      backup.age_ms == null
        ? 'No backup has ever been taken on this server.'
        : 'The newest backup is older than the schedule says it should be.');
  }
  if (backup?.last_error || backup?.remote?.last_error) {
    add('backup-error', 'danger', 'The last backup failed',
      backup.last_error || backup.remote?.last_error);
  }

  const ready = restoreReadiness(status);
  if (ready.answer === 'no') {
    add('restore', 'danger', 'This server could not be restored right now', ready.because);
  } else if (ready.answer === 'unknown' && ready.firing) {
    add('restore', 'warn', 'Nothing has checked whether this server can be restored',
      ready.because);
  }

  for (const e of ready.excluded) {
    add(`backup-excluded-${e.kind}`, 'warn',
      `The backup cannot contain this server’s ${e.kind}`,
      e.says || `${e.kind} is stored somewhere the backup does not read.`);
  }

  const fromServer = (health?.signals || [])
    .filter((s) => s && s.key)
    .map((s) => ({
      key: s.key,
      tone: TONES[s.severity] || 'accent',
      title: s.title,
      detail: s.cause,
      action: s.action || null,
      source: 'server',
    }));

  const covered = new Set(fromServer.map((s) => s.key));
  const kept = out.filter(
    (s) => !(SUPERSEDED_BY[s.key] || []).some((key) => covered.has(key)),
  );

  const order = { danger: 0, warn: 1, accent: 2 };
  const first = (s) => (s.source === 'server' ? 0 : 1);
  return [...fromServer, ...kept].sort(
    (a, b) => (order[a.tone] ?? 3) - (order[b.tone] ?? 3) || first(a) - first(b),
  );
}

export function restoreReadiness(status) {
  const backup = status?.backup;
  const d = backup?.drill;
  const unknown = (because) => ({
    answer: 'unknown', tone: 'warn', word: 'Unknown', because,
    advice: null, failure: null, since: null, source: null, archive: null,
    took: null, checked: [], warnings: [], excluded: [], omitted: [], firing: false,
    caveat: CAVEAT,
  });

  if (!status) return unknown('This server has not answered yet.');
  if (!backup) return unknown('This server does not report anything about its backups.');
  if (!d) {
    return unknown(
      'This server is running a build with no restore drill in it, so nothing has ever '
      + 'opened one of its archives to find out.',
    );
  }

  const exclusions = backup.excluded || [];
  const said = exclusions.map((e) => e.says);
  const since = present(d.passed_age_ms) ? duration(d.passed_age_ms) : null;
  const source = d.source === 'remote' ? 'remote' : d.source === 'local' ? 'local' : null;
  const base = {
    since,
    source,
    sourceText: source === 'remote'
      ? 'the copy in the bucket — the one that survives this machine'
      : source === 'local'
        ? 'the copy on this machine’s own disk, which is the copy a lost disk takes with it'
        : null,
    archive: d.archive || null,
    took: present(d.took_ms) ? duration(d.took_ms) : null,
    checked: whatWasChecked(d),
    warnings: (d.warnings || []).filter(
      (w) => !said.some((sentence) => sentence && w.endsWith(sentence)),
    ),
    excluded: exclusions.filter((e) => e.reason === 'object-store'),
    omitted: exclusions.filter((e) => e.reason === 'disabled'),
    caveat: CAVEAT,
  };

  if (backup.enabled === false) {
    return {
      ...base,
      answer: 'no',
      tone: 'danger',
      word: 'No',
      because: 'Backups are switched off in this server’s configuration. There is nothing to '
        + 'restore from.',
      advice: 'Set enabled = true under [backup] and restart, then run telium-server backup now.',
      failure: null,
      firing: true,
    };
  }

  switch (d.verdict) {
    case 'passed':
      return {
        ...base,
        answer: 'yes',
        tone: 'accent',
        word: 'Yes',
        because: `A full rehearsal ${since ? `${since} ago` : 'just now'} fetched the newest `
          + `archive from ${source === 'remote' ? 'the bucket' : 'this machine'}, decrypted every `
          + 'chunk, opened the database inside it and found this server’s identity intact.',
        advice: null,
        failure: null,
        firing: false,
      };
    case 'failed':
      return {
        ...base,
        answer: 'no',
        tone: 'danger',
        word: 'No',
        because: d.reason || 'The last restore drill failed and did not say why.',
        advice: d.advice || null,
        failure: d.failure || null,
        firing: true,
      };
    case 'stale':
      return {
        ...base,
        answer: 'unknown',
        tone: 'warn',
        word: 'Unknown',
        because: `The last rehearsal passed, but that was ${since || 'a long time'} ago — longer `
          + 'than this server’s own threshold for trusting the result. The archives, the key and '
          + 'the bucket have all had time to change since.',
        advice: 'Run telium-server backup drill, or check why the scheduled one stopped.',
        failure: null,
        firing: true,
      };
    default:
      return {
        ...base,
        answer: 'unknown',
        tone: 'warn',
        word: 'Unknown',
        because: d.enabled === false
          ? 'Restore drills are switched off, so no archive on this server has ever been opened '
            + 'to see whether it would come back.'
          : 'No restore drill has finished yet on this server. Until one does, the backups are '
            + 'files nobody has ever read.',
        advice: d.enabled === false
          ? 'Set drill = true under [backup], or run telium-server backup drill by hand.'
          : 'Run telium-server backup drill to get an answer now.',
        failure: null,
        firing: d.enabled !== false,
      };
  }
}

const CAVEAT = 'A pass means this binary, on this machine, with the key this machine holds, '
  + 'opened the newest archive and found the server inside it. It does not prove the key exists '
  + 'anywhere else — and a lost machine takes its key with it.';

function whatWasChecked(d) {
  const v = d.verified;
  if (!v) return [];
  const out = [];
  const push = (key, name, value) => out.push({ key, name, value });

  push('database', 'Database opened',
    `${size(v.database_bytes)}${v.integrity ? ', integrity check passed' : ', integrity check FAILED'}`);
  push('schema', 'Schema version',
    present(v.schema_version)
      ? `${v.schema_version}${present(v.binary_schema_version) && v.binary_schema_version !== v.schema_version
        ? ` — this build carries ${v.binary_schema_version} and can migrate it forward`
        : ' — the version this build carries'}`
      : null);
  push('identity', 'Federation signing keys', count(v.signing_keys));
  push('accounts', 'Accounts', `${count(v.accounts)} — ${count(v.devices)} devices`);
  push('push', 'Web Push identity', v.push_keys > 0 ? 'present' : 'missing');
  push('auth', 'OPAQUE server setup',
    v.auth_secrets === null || v.auth_secrets === undefined
      ? 'not in this archive’s schema'
      : v.auth_secrets > 0 ? 'present' : 'empty');
  push('content', 'Carried', `${count(v.guilds)} guilds — ${count(v.messages)} messages`);
  for (const part of v.parts || []) {
    push(`part-${part.kind}`, `Part: ${part.kind}`,
      `${count(part.files_seen)} of ${count(part.files_declared)} files — ${size(part.bytes)}`);
  }
  return out;
}

export function verdict(list) {
  if (list.some((s) => s.tone === 'danger')) return { tone: 'danger', text: 'Something is wrong' };
  if (list.some((s) => s.tone === 'warn')) return { tone: 'warn', text: 'Worth a look' };
  return { tone: 'success', text: 'Nothing is on fire' };
}
