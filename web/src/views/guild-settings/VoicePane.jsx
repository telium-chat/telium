import { useEffect, useRef, useState } from 'react';
import { reportError } from '../../hooks/useToast.jsx';
import { t } from '../../lib/i18n/index.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import {
  Button,
  CheckIcon,
  Crumb,
  DataTable,
  Dots,
  Flow,
  Hint,
  Notice,
  Section,
  Select,
  SpinnerIcon,
  Switch,
  TextInput,
  WarnIcon,
} from '../../components/index.js';

function looksLikeHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function addressProblem(raw) {
  const s = raw.trim();
  if (!s || looksLikeHttpUrl(s)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1];
  if (scheme) {
    const kind = scheme.toLowerCase();
    if (kind === 'http' || kind === 'https') return t('guild.voice.address.needsHost');
    return t('guild.voice.address.wrongScheme', { scheme });
  }
  return t('guild.voice.address.bareHost');
}

const worthJudging = (s) => s.includes('.') || s.includes('://') || s.length >= 10;

const GENERIC_HOST_LABEL = new Set(['sfu', 'www', 'media', 'voice', 'rtc', 'turn']);

function suggestName(url) {
  try {
    const parts = new URL(url).hostname.split('.').filter(Boolean);
    if (!parts.length) return '';
    if (parts.length > 2 && GENERIC_HOST_LABEL.has(parts[0].toLowerCase())) return parts[1];
    return parts[0];
  } catch {
    return '';
  }
}

async function probe(sfu) {
  const url = sfu.trim();
  if (!looksLikeHttpUrl(url)) return 'invalid';
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/health', { method: 'GET' });
    return res.ok ? 'reachable' : 'unreachable';
  } catch {
    return 'unverified';
  }
}

const VERDICT = {
  reachable: {
    tone: 'success',
    icon: CheckIcon,
    title: 'guild.voice.probe.reachable.title',
    body: 'guild.voice.probe.reachable.body',
  },
  unreachable: {
    tone: 'warn',
    icon: WarnIcon,
    title: 'guild.voice.probe.unreachable.title',
    body: 'guild.voice.probe.unreachable.body',
  },
  unverified: {
    tone: 'warn',
    icon: WarnIcon,
    title: 'guild.voice.probe.unverified.title',
    body: 'guild.voice.probe.unverified.body',
  },
};

const DEPTH = { address: 0, details: 1 };
const DOTS = ['address', 'details'];

const NOTICE_SEEN_KEY = 'telium.voice.automaticNotice.v1';

const VOICE_MODES = ['automatic', 'fixed', 'direct'];

export function VoicePane({ guildId, api }) {
  const tr = useT();
  const [loading, setLoading] = useState(true);
  const [serverDefault, setServerDefault] = useState('');
  const [guildDefault, setGuildDefault] = useState(null);
  const [regions, setRegions] = useState([]);
  const [voiceMode, setVoiceMode] = useState('automatic');
  const [meshMax, setMeshMax] = useState(null);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeNoticeSeen, setModeNoticeSeen] = useState(() => {
    try { return localStorage.getItem(NOTICE_SEEN_KEY) === '1'; } catch { return false; }
  });
  const [directory, setDirectory] = useState({ enabled: false, entries: [] });
  const [directoryLoading, setDirectoryLoading] = useState(true);
  const [directoryBusy, setDirectoryBusy] = useState('');
  const [form, setForm] = useState({ name: '', sfu: '', turn: '', setDefault: false });
  const [step, setStep] = useState('address');
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(null);
  const [recheck, setRecheck] = useState(0);
  const asked = useRef(new Map());
  const sfuRef = useRef(null);
  const nameRef = useRef(null);

  const url = form.sfu.trim();
  const valid = looksLikeHttpUrl(url);
  const problem = worthJudging(form.sfu.trim()) ? addressProblem(form.sfu) : null;
  const verdict = checked?.url === url ? checked.state : null;
  const checking = valid && !verdict;

  async function load() {
    setLoading(true);
    try {
      const data = await api.guildVoiceRegions(guildId);
      setServerDefault(data.server_default || '');
      setGuildDefault(data.guild_default ?? null);
      setRegions(data.regions || []);
      setVoiceMode(data.voice_mode || 'automatic');
      setMeshMax(data.mesh_max_participants ?? null);
    } catch (e) {
      reportError(e, t('guild.voice.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [guildId, api]);

  // The public directory is one fresh probe round served by this guild's own
  // server; loaded alongside the regions so the pane renders in one pass.
  useEffect(() => {
    let live = true;
    setDirectoryLoading(true);
    api.voiceDirectory()
      .then((data) => { if (live) setDirectory({ enabled: data.enabled !== false, entries: data.entries || [] }); })
      .catch(() => { if (live) setDirectory({ enabled: false, entries: [] }); })
      .finally(() => { if (live) setDirectoryLoading(false); });
    return () => { live = false; };
  }, [api]);

  const setMode = async (mode) => {
    setModeBusy(true);
    try {
      await api.setGuildVoiceMode(guildId, mode);
      setVoiceMode(mode);
    } catch (e) {
      reportError(e, t('guild.voice.mode.changeFailed'));
    } finally {
      setModeBusy(false);
    }
  };

  const dismissModeNotice = () => {
    setModeNoticeSeen(true);
    try { localStorage.setItem(NOTICE_SEEN_KEY, '1'); } catch { /* private mode: notice returns next visit */ }
  };

  const addFromDirectory = async (entry) => {
    if (directoryBusy) return;
    setDirectoryBusy(entry.url);
    try {
      // The first relay a mesh-only guild gains becomes its default, so the
      // one-click add actually lifts the mesh cap.
      await api.addGuildVoiceRegion(guildId, {
        name: suggestName(entry.url) || entry.name,
        sfu: entry.url,
        pubkey_hint: entry.pubkey_hint || undefined,
        from_directory: true,
        set_default: !regions.some((r) => r.guild),
      });
      await load();
    } catch (e) {
      reportError(e, t('guild.voice.directory.addFailed'));
    } finally {
      setDirectoryBusy('');
    }
  };

  useEffect(() => {
    if (!valid) return undefined;
    const hit = asked.current.get(url);
    if (hit) { setChecked({ url, state: hit }); return undefined; }
    let live = true;
    const id = setTimeout(() => {
      probe(url).then((state) => {
        asked.current.set(url, state);
        if (live) setChecked({ url, state });
      });
    }, step === 'details' ? 0 : 400);
    return () => { live = false; clearTimeout(id); };
  }, [url, valid, step, recheck]);

  useEffect(() => {
    const ref = step === 'details' ? nameRef : sfuRef;
    const id = setTimeout(() => ref.current?.focus({ preventScroll: true }), 220);
    return () => clearTimeout(id);
  }, [step]);

  const askAgain = () => {
    if (!valid) return;
    asked.current.delete(url);
    setChecked(null);
    setRecheck((n) => n + 1);
  };

  const toDetails = () => {
    if (!valid) return;
    setForm((f) => (f.name.trim() ? f : { ...f, name: suggestName(f.sfu.trim()) }));
    setStep('details');
  };

  const add = async () => {
    if (!form.name.trim() || !valid) return;
    setBusy(true);
    try {
      await api.addGuildVoiceRegion(guildId, {
        name: form.name.trim(),
        sfu: form.sfu.trim(),
        turn: form.turn.trim() || undefined,
        set_default: form.setDefault,
      });
      setForm({ name: '', sfu: '', turn: '', setDefault: false });
      setChecked(null);
      setStep('address');
      await load();
    } catch (e) {
      reportError(e, t('guild.voice.addFailed'));
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (name) => {
    try {
      await api.setGuildVoiceRegionDefault(guildId, name);
      await load();
    } catch (e) { reportError(e, t('guild.voice.defaultFailed')); }
  };

  const remove = async (name) => {
    try {
      await api.deleteGuildVoiceRegion(guildId, name);
      await load();
    } catch (e) { reportError(e, t('guild.voice.removeFailed')); }
  };

  const mark = (
    <span className="auth-probe" aria-live="polite">
      {checking
        ? <SpinnerIcon className="size-3.5 animate-spin text-muted" aria-label={tr('guild.voice.probe.a11yChecking')} />
        : verdict === 'reachable'
          ? <CheckIcon className="size-3.5 text-success" aria-label={tr('guild.voice.probe.a11yReached')} />
          : verdict === 'unreachable' || verdict === 'unverified'
            ? <WarnIcon className="size-3.5 text-warning" aria-label={tr('guild.voice.probe.a11yFailed')} />
            : null}
    </span>
  );

  const said = VERDICT[verdict];

  const noRegions = regions.every((r) => !r.sfu || !r.sfu.trim());
  const addedUrls = new Set(regions.map((r) => (r.sfu || '').replace(/\/$/, '')));

  return (
    <>
      <Section
        title={tr('guild.voice.mode.title')}
        description={tr('guild.voice.mode.description')}
      >
        <div className="flex flex-col gap-3">
          <Select
            aria-label={tr('guild.voice.mode.title')}
            value={voiceMode}
            isDisabled={modeBusy || loading}
            options={VOICE_MODES.map((m) => [m, tr(`guild.voice.mode.${m}`)])}
            onChange={(e) => setMode(e.target.value)}
          />
          <Hint>{tr(`guild.voice.mode.hint.${voiceMode}`)}</Hint>
          {voiceMode === 'automatic' && !modeNoticeSeen ? (
            <Notice tone="warn">
              <strong>{tr('guild.voice.mode.noticeTitle')}</strong>
              {tr('guild.voice.mode.notice')}
              <div className="mt-2">
                <Button variant="ghost" onClick={dismissModeNotice}>
                  {tr('guild.voice.mode.noticeDismiss')}
                </Button>
              </div>
            </Notice>
          ) : null}
        </div>
      </Section>

      <Section
        title={tr('guild.voice.regions.title')}
        description={tr('guild.voice.regions.description')}
      >
        {loading ? null : !noRegions ? (
          <Hint>
            {serverDefault
              ? (
                <Trans
                  k="guild.voice.serverDefault"
                  values={{ name: serverDefault }}
                  components={{ code: <code /> }}
                />
              )
              : tr('guild.voice.serverDefaultNone')}
            {guildDefault ? (
              <>
                {' · '}
                <Trans
                  k="guild.voice.guildDefault"
                  values={{ name: guildDefault }}
                  components={{ code: <code /> }}
                />
              </>
            ) : null}
          </Hint>
        ) : (
          <Notice tone="warn">
            <strong>{tr('guild.voice.meshNoticeTitle')}</strong>
            {meshMax != null
              ? tr('guild.voice.meshNotice', { count: meshMax })
              : tr('guild.voice.meshNoticeUnknown')}
          </Notice>
        )}

        <DataTable
          label={tr('guild.voice.tableLabel')}
          rows={regions}
          rowKey={(region) => region.name}
          empty={loading ? tr('common.loading') : tr('guild.voice.empty')}
          columns={[
            {
              key: 'name',
              header: tr('guild.voice.colName'),
              render: (region) => (
                <span className="font-medium">
                  {region.name}
                  {region.default ? <span title={tr('guild.voice.defaultMarker')}>{' ★'}</span> : null}
                  {region.listed === false ? <span title={tr('guild.voice.unlisted')} className="text-warning">{' ⚠'}</span> : null}
                </span>
              ),
            },
            {
              key: 'sfu',
              header: tr('guild.voice.colSfu'),
              mono: true,
              render: (region) => region.sfu,
            },
            {
              key: 'type',
              header: tr('guild.voice.colType'),
              render: (region) => (region.guild
                ? tr('guild.voice.typeCustom')
                : tr('guild.voice.typeServer')),
            },
            {
              key: 'health',
              header: tr('guild.voice.colHealth'),
              render: (region) => (region.healthy
                ? tr('guild.voice.healthOk')
                : tr('guild.voice.healthDown')),
            },
            {
              key: 'actions',
              header: '',
              align: 'end',
              render: (region) => (region.guild ? (
                <div className="flex flex-wrap justify-end gap-1">
                  {!region.default ? (
                    <Button
                      variant="ghost"
                      aria-label={tr('guild.voice.makeDefaultRegion', { name: region.name })}
                      onClick={() => makeDefault(region.name)}
                    >
                      {tr('guild.voice.makeDefault')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    aria-label={tr('guild.voice.removeRegion', { name: region.name })}
                    onClick={() => remove(region.name)}
                  >
                    {tr('common.remove')}
                  </Button>
                </div>
              ) : null),
            },
          ]}
        />
      </Section>

      <Section title={tr('guild.voice.add.title')} actions={<Dots steps={DOTS} at={step} />}>
        <div className="rounded-2xl bg-surface-secondary px-4 pb-4 pt-3">
          <Flow step={step} depth={DEPTH[step]} className="is-tight">
            {step === 'address' ? (
              <>
                <h4 className="text-sm font-semibold tracking-tight">
                  {tr('guild.voice.add.step1Title')}
                </h4>
                <p className="text-sm leading-[1.6] text-muted">
                  {tr('guild.voice.add.step1Body')}
                </p>
                <form
                  className="flex flex-col gap-3.5"
                  onSubmit={(e) => { e.preventDefault(); toDetails(); }}
                >
                  <TextInput
                    inputRef={sfuRef}
                    label={tr('guild.voice.add.sfuLabel')}
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    enterKeyHint="next"
                    value={form.sfu}
                    placeholder={tr('guild.voice.add.sfuPlaceholder')}
                    endContent={mark}
                    onChange={(e) => setForm({ ...form, sfu: e.target.value })}
                  />
                  {problem ? (
                    <p className="-mt-1 text-xs leading-[1.5] text-warning" role="status">
                      {problem}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    isDisabled={!valid}
                    className="mt-1 w-full"
                  >
                    {tr('common.continue')}
                  </Button>
                </form>
              </>
            ) : (
              <>
                <Crumb label={tr('guild.voice.add.crumb')} onClick={() => setStep('address')} />
                <h4 className="text-sm font-semibold tracking-tight">
                  {tr('guild.voice.add.step2Title')}
                </h4>
                <p className="break-all text-sm leading-[1.6] text-muted">
                  <code>{url}</code>
                </p>
                <form
                  className="flex flex-col gap-3.5"
                  onSubmit={(e) => { e.preventDefault(); add(); }}
                >
                  <TextInput
                    inputRef={nameRef}
                    label={tr('guild.voice.add.nameLabel')}
                    hint={tr('guild.voice.add.nameHint')}
                    value={form.name}
                    placeholder={tr('guild.voice.add.namePlaceholder')}
                    enterKeyHint="done"
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                  <TextInput
                    label={tr('guild.voice.add.turnLabel')}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={form.turn}
                    placeholder={tr('guild.voice.add.turnPlaceholder')}
                    onChange={(e) => setForm({ ...form, turn: e.target.value })}
                  />
                  <Switch
                    label={tr('guild.voice.add.makeDefault')}
                    checked={form.setDefault}
                    onChange={(next) => setForm({ ...form, setDefault: next })}
                  />

                  <div aria-live="polite">
                    {checking ? (
                      <Hint>{tr('guild.voice.probe.checking')}</Hint>
                    ) : said ? (
                      <Notice tone={said.tone}>
                        <strong className="block">{tr(said.title)}</strong>
                        {tr(said.body)}
                      </Notice>
                    ) : null}
                  </div>

                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button
                      size="lg"
                      className="min-w-0 flex-1"
                      loading={checking}
                      onClick={askAgain}
                    >
                      {tr('guild.voice.probe.recheck')}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      className="min-w-0 flex-1"
                      loading={busy}
                      isDisabled={busy || !form.name.trim()}
                    >
                      {tr('guild.voice.add.submit')}
                    </Button>
                  </div>
                </form>
              </>
            )}
          </Flow>
        </div>
      </Section>

      <Section
        title={tr('guild.voice.directory.title')}
        description={tr('guild.voice.directory.description')}
      >
        {directoryLoading ? (
          <p className="text-sm text-muted">{tr('common.loading')}</p>
        ) : !directory.enabled || !directory.entries.length ? (
          <Hint>{directory.enabled ? tr('guild.voice.directory.empty') : tr('guild.voice.directory.disabled')}</Hint>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {directory.entries.map((entry) => {
              const added = addedUrls.has((entry.url || '').replace(/\/$/, ''));
              const busy = directoryBusy === entry.url;
              return (
                <div key={entry.url} className="flex flex-col gap-1.5 rounded-2xl bg-surface-secondary px-4 pb-4 pt-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold tracking-tight">{entry.name}</p>
                      <p className="truncate text-xs text-muted">
                        {entry.region_label}
                        {entry.operator_name ? ` · ${tr('guild.voice.directory.by', { operator: entry.operator_name })}` : ''}
                      </p>
                    </div>
                    <span
                      className={
                        'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' +
                        (!entry.reachable
                          ? 'bg-warning/15 text-warning'
                          : entry.accepting === false
                            ? 'bg-warning/15 text-warning'
                            : 'bg-success/15 text-success')
                      }
                    >
                      {!entry.reachable
                        ? tr('guild.voice.directory.offline')
                        : entry.accepting === false
                          ? tr('guild.voice.directory.full')
                          : entry.latency_ms != null
                            ? tr('guild.voice.directory.latency', { ms: entry.latency_ms })
                            : tr('guild.voice.healthOk')}
                    </span>
                  </div>
                  {entry.description ? (
                    <p className="text-xs leading-[1.5] text-muted">{entry.description}</p>
                  ) : null}
                  <div className="mt-auto pt-1">
                    <Button
                      variant="primary"
                      isDisabled={added}
                      loading={busy}
                      onClick={() => addFromDirectory(entry)}
                    >
                      {added ? tr('guild.voice.directory.added') : tr('guild.voice.directory.add')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
