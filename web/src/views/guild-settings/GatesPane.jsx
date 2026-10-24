import { useEffect, useState } from 'react';
import { useAsync } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Async, AsyncButton, Button, DataTable, EmojiText, Field, Hint, Meta, Pill, Section, Select,
  TextArea, TextInput
} from '../../components/index.js';

export function GatesPane({ guildId, api }) {
  const state = useAsync(() => api.gates(guildId), [guildId]);
  return (
    <>
      <Async state={state}>{(gates) => <Editor guildId={guildId} api={api} gates={gates} />}</Async>
    </>
  );
}

const POLICIES = [
  ['open', 'guild.gates.policy.open'],
  ['allowlist', 'guild.gates.policy.allowlist'],
  ['blocklist', 'guild.gates.policy.blocklist'],
];

function Editor({ guildId, api, gates: loaded }) {
  const tr = useT();
  const [gates, setGates] = useState(loaded);
  const [age, setAge] = useState(String(gates.min_account_age_days ?? 0));
  const [policy, setPolicy] = useState(gates.domain_policy || 'open');
  const [domains, setDomains] = useState(
    (gates.domains || []).map((d) => `${d.action} ${d.domain}`).join('\n'),
  );
  const [screening, setScreening] = useState((gates.screening || []).join('\n'));
  const [hold, setHold] = useState(String(gates.hold_first_messages ?? 0));
  const [originPolicy, setOriginPolicy] = useState(gates.origin_policy || 'open');
  const [origins, setOrigins] = useState(originsText(gates.origins));

  const save = async () => {
    const rules = domains.split('\n').map((line) => line.trim()).filter(Boolean)
      .map((line) => {
        const [action, domain] = line.split(/\s+/);
        return {
          action: action === 'deny' ? 'deny' : 'allow',
          domain: (domain || action || '').toLowerCase(),
        };
      })
      .filter((r) => r.domain);
    try {
      const saved = await api.setGates(guildId, {
        min_account_age_days: Number(age) || 0,
        domain_policy: policy,
        domains: rules,
        screening: screening.split('\n').map((s) => s.trim()).filter(Boolean),
        hold_first_messages: Number(hold) || 0,
        origin_policy: originPolicy,
        origins: parseOrigins(origins),
      });
      if (saved) setGates(saved);
      toast(t('guild.gates.saved'));
    } catch (e) { reportError(e, t('guild.gates.saveFailed')); }
  };

  const refreshFeeds = async () => {
    try {
      setGates(await api.refreshGateFeeds(guildId));
    } catch (e) { reportError(e, t('guild.gates.refreshFailed')); }
  };

  return (
    <Section>
      <Hint>
        {tr('guild.gates.hint')}
      </Hint>
      <Field
        label={tr('guild.gates.minAge.label')}
        hint={tr('guild.gates.minAge.hint')}
      >
        <TextInput type="number" value={age} onChange={(e) => setAge(e.target.value)} />
      </Field>
      <Field label={tr('guild.gates.domainPolicy.label')}>
        <Select
          value={policy}
          options={POLICIES.map(([value, key]) => [value, tr(key)])}
          onChange={(e) => setPolicy(e.target.value)}
        />
      </Field>
      <Field
        label={tr('guild.gates.domainRules.label')}
        hint={tr('guild.gates.domainRules.hint')}
      >
        <TextArea rows={5} value={domains} onChange={(e) => setDomains(e.target.value)} />
      </Field>
      <Field
        label={tr('guild.gates.screening.label')}
        hint={tr('guild.gates.screening.hint')}
      >
        <TextArea rows={4} value={screening} onChange={(e) => setScreening(e.target.value)} />
      </Field>
      <Field
        label={tr('guild.gates.hold.label')}
        hint={tr('guild.gates.hold.hint')}
      >
        <TextInput type="number" value={hold} onChange={(e) => setHold(e.target.value)} />
      </Field>
      <Hint>
        {tr('guild.gates.origins.hint')}
      </Hint>
      <Field label={tr('guild.gates.originPolicy.label')}>
        <Select
          value={originPolicy}
          options={POLICIES.map(([value, key]) => [value, tr(key)])}
          onChange={(e) => setOriginPolicy(e.target.value)}
        />
      </Field>
      <Field
        label={tr('guild.gates.originRules.label')}
        hint={tr('guild.gates.originRules.hint')}
      >
        <TextArea rows={5} value={origins} onChange={(e) => setOrigins(e.target.value)} />
      </Field>
      <FeedStatus feeds={(gates.origins || []).filter((o) => o.feed)} onRefresh={refreshFeeds} />
      <CuratorDirectory
        guildId={guildId}
        api={api}
        subscribed={(gates.origins || []).filter((o) => o.feed)}
        onPin={(curator) => {
          setOrigins((text) => [text.trim(), `allow feed:${curator.feed} key:${curator.key}`]
            .filter(Boolean).join('\n'));
          toast(t('guild.gates.pinned'));
        }}
      />
      <Button variant="primary" className="self-start" onClick={save}>
        {tr('guild.gates.save')}
      </Button>
    </Section>
  );
}

function CuratorDirectory({ guildId, api, subscribed, onPin }) {
  const tr = useT();
  const [curators, setCurators] = useState(null);
  useEffect(() => {
    let live = true;
    api.gateCurators(guildId)
      .then((r) => { if (live) setCurators(r.curators || []); })
      .catch(() => { if (live) setCurators([]); });
    return () => { live = false; };
  }, [api, guildId]);
  if (!curators?.length) return null;

  const already = (c) => subscribed.some((o) => o.feed === c.feed && o.key === c.key);
  return (
    <>
      <Hint>
        {tr('guild.gates.curators.hint')}
      </Hint>
      <DataTable
        label={tr('guild.gates.curators.tableLabel')}
        rows={curators}
        rowKey={(c) => `${c.feed} ${c.key}`}
        columns={[
          {
            key: 'name',
            header: tr('guild.gates.curators.colCurator'),
            render: (c) => (
              <div className="flex min-w-0 flex-col">
                <span><EmojiText>{c.name}</EmojiText></span>
                {c.description ? <Meta className="break-words">{c.description}</Meta> : null}
                {c.contact ? <Meta className="break-words">{c.contact}</Meta> : null}
              </div>
            ),
          },
          {
            key: 'feed',
            header: tr('guild.gates.curators.colFeed'),
            render: (c) => (
              <div className="flex min-w-0 flex-col">
                <span className="break-all">{c.feed}</span>
                <Meta className="break-all">{c.key}</Meta>
              </div>
            ),
          },
          {
            key: 'source',
            header: tr('guild.gates.curators.colSource'),
            render: (c) => (
              <Pill tone={c.local ? 'success' : 'default'}>
                {c.local ? tr('guild.gates.curators.thisServer') : c.source}
              </Pill>
            ),
          },
          {
            key: 'pin',
            header: '',
            render: (c) => (already(c)
              ? <Meta>{tr('guild.gates.curators.subscribed')}</Meta>
              : <Button onClick={() => onPin(c)}>{tr('guild.gates.curators.pin')}</Button>),
          },
        ]}
      />
    </>
  );
}

const FEED_STATES = {
  active: ['success', 'guild.gates.feeds.state.active'],
  expired: ['warn', 'guild.gates.feeds.state.expired'],
  pending: ['default', 'guild.gates.feeds.state.pending'],
  failed: ['danger', 'guild.gates.feeds.state.failed'],
  unpinned: ['warn', 'guild.gates.feeds.state.unpinned'],
};

function FeedStatus({ feeds, onRefresh }) {
  const tr = useT();
  if (!feeds.length) return null;
  return (
    <>
      <Hint>
        {tr('guild.gates.feeds.hint')}
      </Hint>
      <DataTable
        label={tr('guild.gates.feeds.tableLabel')}
        rows={feeds}
        rowKey={(f) => `${f.action} ${f.feed} ${f.key || ''}`}
        columns={[
          {
            key: 'feed',
            header: tr('guild.gates.feeds.colFeed'),
            render: (f) => (
              <div className="flex min-w-0 flex-col">
                <span className="break-all">{f.feed}</span>
                <Meta>
                  {f.status?.curator
                    ? tr('guild.gates.feeds.curatedBy', { action: f.action, curator: f.status.curator })
                    : f.action}
                </Meta>
              </div>
            ),
          },
          {
            key: 'hosts',
            header: tr('guild.gates.feeds.colHosts'),
            align: 'end',
            render: (f) => hostCount(f.status),
          },
          {
            key: 'serial',
            header: tr('guild.gates.feeds.colSerial'),
            align: 'end',
            render: (f) => f.status?.serial ?? tr('common.empty'),
          },
          {
            key: 'fetched',
            header: tr('guild.gates.feeds.colFetched'),
            render: (f) => when(f.status?.fetched_at),
          },
          {
            key: 'key',
            header: tr('guild.gates.feeds.colKey'),
            render: (f) => <FeedKey rule={f} />,
          },
          {
            key: 'state',
            header: tr('guild.gates.feeds.colState'),
            render: (f) => <FeedState status={f.status} />,
          },
        ]}
      />
      <AsyncButton className="self-start" onClick={onRefresh}>
        {tr('guild.gates.feeds.refresh')}
      </AsyncButton>
    </>
  );
}

function FeedKey({ rule }) {
  const tr = useT();
  const active = rule.status?.active_key;
  const rotated = active && active !== rule.key;
  const pending = rule.status?.pending_key;
  if (!rotated && !pending) return <Meta>{tr('guild.gates.feeds.keyPinned')}</Meta>;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {rotated ? (
        <>
          <Pill tone="success">
            {tr('guild.gates.feeds.keyRotated', { count: rule.status?.rotation ?? 1 })}
          </Pill>
          <Meta className="break-all">{tr('guild.gates.feeds.keyInForce', { key: active })}</Meta>
        </>
      ) : null}
      {pending ? (
        <>
          <Pill tone="warn">{tr('guild.gates.feeds.keyRotationAnnounced')}</Pill>
          <Meta className="break-all">{tr('guild.gates.feeds.keyNext', { key: pending })}</Meta>
        </>
      ) : null}
    </div>
  );
}

function FeedState({ status }) {
  const tr = useT();
  const [tone, key] = FEED_STATES[status?.state] || FEED_STATES.pending;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <Pill tone={tone}>{tr(key)}</Pill>
      {status?.error ? <Meta className="break-words">{status.error}</Meta> : null}
    </div>
  );
}

function hostCount(status) {
  const hosts = status?.hosts ?? 0;
  return status?.blocks
    ? t('guild.gates.feeds.hostsWithBlocks', { hosts, blocks: status.blocks })
    : t('guild.gates.feeds.hosts', { hosts });
}

function when(ms) {
  return ms ? t('guild.gates.feeds.fetchedAt', { at: ms }) : t('common.never');
}

function originsText(origins = []) {
  return origins.map((o) => (o.feed
    ? `${o.action} feed:${o.feed}${o.key ? ` key:${o.key}` : ''}`
    : `${o.action} ${o.domain}`)).join('\n');
}

function parseOrigins(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => {
      const words = line.split(/\s+/);
      const action = words[0] === 'block' ? 'block' : 'allow';
      const rest = words[0] === 'block' || words[0] === 'allow' ? words.slice(1) : words;
      const target = rest[0] || '';
      if (!target.startsWith('feed:')) return { action, domain: target.toLowerCase() };
      const key = rest.slice(1).find((w) => w.startsWith('key:'));
      return key ? { action, feed: target.slice(5), key: key.slice(4) } : { action, feed: target.slice(5) };
    })
    .filter((r) => r.feed || r.domain);
}
