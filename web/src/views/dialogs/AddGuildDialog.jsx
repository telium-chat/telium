import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { protectionPromptFor } from '../../hooks/useProtectionPrompt.jsx';
import { shortName } from '../../lib/util.js';
import { entryPlan, limits, marketplace, price } from '../../lib/hosting.js';
import { openExternal } from '../../lib/platform.js';
import {
  Avatar, Button, Field, Flow, GlobeIcon, Hint, LinkIcon, Loading, Meta,
  ModalShell, Notice, Pill, Select, ServerIcon, TextInput, TextSwap, Way, Ways,
} from '../../components/index.js';
import { ScreeningDialog } from './ScreeningDialog.jsx';

const DEPTH = { ways: 0, create: 1, join: 1, connect: 1, self: 2, provider: 2 };

export function AddGuildDialog({ close }) {
  const store = useStore();
  const modal = useModal();
  const domains = Object.keys(store.session.servers);

  const [step, setStep] = useState('ways');
  const [invite, setInvite] = useState('');
  const [domain, setDomain] = useState('');
  const [guildName, setGuildName] = useState('');
  const [host, setHost] = useState(domains[0] || '');
  const [busy, setBusy] = useState(false);
  const [market, setMarket] = useState(null);
  const [provider, setProvider] = useState(null);
  const [preview, setPreview] = useState({ status: 'idle' });

  useEffect(() => {
    if (step !== 'create' || market) return undefined;
    let live = true;
    const asked = store.home?.hostingProviders();
    if (!asked) { setMarket(marketplace(null)); return undefined; }
    asked
      .then((payload) => { if (live) setMarket(marketplace(payload)); })
      .catch(() => { if (live) setMarket(marketplace(null)); });
    return () => { live = false; };
  }, [store, step, market]);

  useEffect(() => {
    const raw = invite.trim();
    if (step !== 'join' || !raw) { setPreview({ status: 'idle' }); return undefined; }
    let live = true;
    setPreview({ status: 'loading' });
    const timer = setTimeout(() => {
      store.previewGuildJoin(raw)
        .then((p) => {
          if (live) setPreview(p ? { status: 'ready', preview: p } : { status: 'unknown' });
        })
        .catch((e) => { if (live) setPreview({ status: 'error', error: e }); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [store, step, invite]);

  const join = async () => {
    const raw = invite.trim();
    const resolved = preview.status === 'ready' ? preview.preview : null;
    if (!resolved) return;
    close();
    if (resolved.kind === 'address') {
      await joinVanity(store, modal, resolved);
      return;
    }
    const code = resolved.code || (raw.split('/').pop() || '').trim();
    if (!code) return;
    await joinInvite(store, modal, code, raw, resolved.domain);
  };

  const connect = async () => {
    const d = domain.trim();
    if (!d) return;
    setBusy(true);
    const attempt = async () => {
      const name = await store.addServer(d);
      toast(`Connected to ${name}.`);
      close();
    };
    try {
      await attempt();
    } catch (e) {
      protectionPromptFor(modal)(e, { context: 'Could not connect', retry: attempt });
    } finally { setBusy(false); }
  };

  const create = async () => {
    const name = guildName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await store.renewServer(host);
      const guild = await store.apiFor(host).createGuild(name);
      close();
      toast(`Created ${guild.name}.`);
      store.connectServer(host, store.session.servers[host]);
    } catch (e) { reportError(e, 'Could not create guild'); }
    finally { setBusy(false); }
  };

  const managed = market?.enabled ? market.providers : [];
  const forked = managed.length > 0;
  const forwards = Boolean(market) && !forked
    && market.self_hosted.available && domains.length > 0;

  useEffect(() => {
    if (step === 'create' && forwards) setStep('self');
  }, [step, forwards]);

  const titles = {
    ways: 'Add a guild',
    create: 'Create a guild',
    self: 'Create a guild',
    join: 'Join a guild',
    connect: 'Connect to a server',
    provider: provider?.name || '',
  };
  const back = step === 'ways'
    ? null
    : (step === 'self' || step === 'provider') && forked
      ? () => setStep('create')
      : () => setStep('ways');

  let body = null;
  switch (step) {
    case 'ways':
      body = (
        <Ways>
          {domains.length ? (
            <Way
              icon={ServerIcon}
              tone="accent"
              name="Create my own"
              onClick={() => setStep('create')}
            />
          ) : null}
          <Way icon={LinkIcon} name="Join a guild" onClick={() => setStep('join')} />
          <Way icon={GlobeIcon} name="Connect to a server" onClick={() => setStep('connect')} />
        </Ways>
      );
      break;

    case 'create':
      body = market && !forwards
        ? (
          <Ways>
            <Way
              icon={ServerIcon}
              tone="accent"
              name="Host it here"
              description={domains.length
                ? market.self_hosted.server_name || host
                : 'Connect to a server first.'}
              disabled={!domains.length || !market.self_hosted.available}
              onClick={() => setStep('self')}
            />
            {managed.map((p) => (
              <Way
                key={p.id}
                icon={GlobeIcon}
                name={p.name}
                description={offerLine(p)}
                onClick={() => { setProvider(p); setStep('provider'); }}
              />
            ))}
            <PortabilityNote guided={market.guided_handoff} />
          </Ways>
        )
        : <Loading />;
      break;

    case 'self':
      body = (
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => { e.preventDefault(); create(); }}
        >
          <TextInput
            autoFocus
            label="Guild name"
            value={guildName}
            placeholder="My guild"
            onChange={(e) => setGuildName(e.target.value)}
          />
          {domains.length > 1 ? (
            <Field label="Hosted on">
              <Select value={host} options={domains} onChange={(e) => setHost(e.target.value)} />
            </Field>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            isDisabled={!guildName.trim()}
            className="mt-1 w-full"
          >
            Create guild
          </Button>
          <PortabilityNote guided={market?.guided_handoff} />
        </form>
      );
      break;

    case 'provider':
      body = provider
        ? <ProviderScreen provider={provider} guided={market?.guided_handoff} close={close} />
        : null;
      break;

    case 'join':
      body = (
        <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); join(); }}>
          <TextInput
            autoFocus
            label="Guild address or invite"
            value={invite}
            placeholder="#linuxcommunity:example.org or invite link"
            onChange={(e) => setInvite(e.target.value)}
          />
          {preview.status === 'unknown' ? (
            <Notice tone="warn">No server we can reach knows that address or invite.</Notice>
          ) : null}
          {preview.status === 'error' ? (
            <Notice tone="danger">
              {preview.error?.message || 'Could not reach the server named by that address or link.'}
            </Notice>
          ) : null}
          {preview.status === 'ready' ? <InvitePreview preview={preview.preview} /> : null}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={preview.status === 'loading'}
            isDisabled={preview.status !== 'ready'}
            className="mt-1 w-full"
          >
            {preview.status === 'ready'
              ? `Join ${preview.preview.guild?.name || ''}`.trim()
              : 'Join'}
          </Button>
        </form>
      );
      break;

    default:
      body = (
        <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); connect(); }}>
          <TextInput
            autoFocus
            label="Domain"
            value={domain}
            placeholder="guilds.example.org"
            onChange={(e) => setDomain(e.target.value)}
          />
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            isDisabled={!domain.trim()}
            className="mt-1 w-full"
          >
            Connect
          </Button>
        </form>
      );
      break;
  }

  return (
    <ModalShell
      title={<TextSwap k={step}>{titles[step]}</TextSwap>}
      onBack={back}
      bodyClassName="pt-0 pb-5"
    >
      <Flow step={step} depth={DEPTH[step]} className="is-tight">{body}</Flow>
    </ModalShell>
  );
}

function PortabilityNote({ guided }) {
  return (
    <Hint>
      {'Wherever it starts, a guild can move. Its owner can hand it to another '
        + 'server from Guild settings → Moving this guild, which carries the '
        + 'members, channels and history across and leaves a signed pointer '
        + 'behind so old invites keep resolving.'}
      {guided === false
        ? ' This server does not federate, so that move has to be arranged by its operator.'
        : null}
    </Hint>
  );
}

function InvitePreview({ preview }) {
  const guild = preview.guild || {};
  const count = guild.member_count ?? 0;
  return (
    <div className="flex items-center gap-3 rounded-row bg-surface-secondary p-3">
      <Avatar
        id={guild.id}
        name={guild.name}
        size="lg"
        mediaRef={guild.icon_ref}
        base={preview.base}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{guild.name}</div>
        <Meta>
          {`${count} ${count === 1 ? 'member' : 'members'} on ${preview.domain}`}
          {preview.kind === 'address' && preview.address ? ` - ${preview.address}` : null}
          {preview.inviter ? ` - invited by ${shortName(preview.inviter)}` : null}
        </Meta>
      </div>
    </div>
  );
}

export async function joinVanity(store, modal, preview) {
  let domain = preview.domain;
  const guildId = preview.resolved?.guild_id || preview.guild?.id;
  if (!domain || !guildId) return;
  const attempt = async () => {
    if (!store.session.servers[domain]) {
      domain = await store.addServer(domain, { base: preview.base });
    }
    const api = store.apiFor(domain);
    const resp = await api.joinGuild(guildId);
    if (resp.pending) {
      modal.open((close) => <ScreeningDialog domain={domain} resp={resp} close={close} />);
      return;
    }
    toast('Joined.');
    store.connectServer(domain, store.session.servers[domain]);
  };
  try {
    await attempt();
  } catch (e) {
    protectionPromptFor(modal)(e, {
      context: 'Could not join',
      retry: attempt,
    });
  }
}

export async function joinInvite(store, modal, code, raw, known = null) {
  let host = known;
  if (!host) { try { host = new URL(raw).host; } catch { host = null; } }
  if (host && !store.session.servers[host]) {
    try { host = await store.addServer(host); }
    catch (e) {
      protectionPromptFor(modal)(e, {
        context: 'Could not reach that server',
        retry: () => joinInvite(store, modal, code, raw, known),
      });
      return;
    }
  }
  const candidates = host ? [host] : Object.keys(store.session.servers);
  for (const domain of candidates) {
    const api = store.apiFor(domain);
    if (!api) continue;
    try {
      const resp = await api.joinInvite(code);
      if (resp.pending) {
        modal.open((close) => <ScreeningDialog domain={domain} resp={resp} close={close} />);
        return;
      }
      toast('Joined.');
      store.connectServer(domain, store.session.servers[domain]);
      return;
    } catch (e) {
      if (e.status === 404) continue;
      protectionPromptFor(modal)(e, {
        context: 'Could not join',
        retry: () => joinInvite(store, modal, code, raw, domain),
      });
      return;
    }
  }
  toast('No server we are connected to knows that invite code.', { error: true });
}

function offerLine(p) {
  const entry = entryPlan(p);
  const parts = entry ? [`From ${price(entry)}`, ...limits(entry)] : [];
  if (!parts.length) return p.description || 'Managed hosting.';
  return parts.join(' - ');
}

function ProviderScreen({ provider, guided, close }) {
  const goto = async () => {
    try { await openExternal(provider.signup_url); }
    catch (e) { reportError(e, 'Could not open that page'); return; }
    close();
    toast(`Opened ${provider.name}. Connect to the server they give you to see your guild here.`);
  };

  return (
    <div className="flex flex-col gap-3.5">
      <Meta>
        {provider.source.kind === 'catalog'
          ? `Listed in ${provider.source.label || provider.source.publisher || 'a catalogue'} your server subscribes to.`
          : 'Listed by the operator of your server.'}
      </Meta>
      {provider.description ? <Hint>{provider.description}</Hint> : null}
      {provider.regions.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Meta>Regions</Meta>
          {provider.regions.map((r) => <Pill key={r}>{r}</Pill>)}
        </div>
      ) : null}
      {provider.plans.length ? (
        <div className="flex flex-col gap-1.5">
          {provider.plans.map((plan) => (
            <div key={plan.id} className="rounded-row bg-surface-secondary p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-medium">{plan.name}</span>
                <span className="shrink-0 tnum">{price(plan)}</span>
              </div>
              {limits(plan).length ? <Meta>{limits(plan).join(' - ')}</Meta> : null}
              {plan.notes ? <Hint>{plan.notes}</Hint> : null}
            </div>
          ))}
        </div>
      ) : (
        <Notice tone="warn">This entry lists no prices or limits.</Notice>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {provider.terms_url ? <ExternalLink href={provider.terms_url}>Terms</ExternalLink> : null}
        {provider.privacy_url ? <ExternalLink href={provider.privacy_url}>Privacy</ExternalLink> : null}
        {provider.base_url ? <ExternalLink href={provider.base_url}>Website</ExternalLink> : null}
        {provider.contact ? <Meta>{`Contact: ${provider.contact}`}</Meta> : null}
      </div>
      <Notice>
        {`Telium takes no payment and holds no account with ${provider.name}. They give `
          + 'you a domain; connecting to it brings the guild into this client.'}
      </Notice>
      <PortabilityNote guided={guided} />
      <Button variant="primary" size="lg" onClick={goto} className="mt-1 w-full">
        {`Continue to ${provider.name}`}
      </Button>
    </div>
  );
}

function ExternalLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sm text-accent hover:underline"
    >
      {children}
    </a>
  );
}
