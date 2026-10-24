import { useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { ok, reportError } from '../../hooks/useToast.jsx';
import { relative } from '../../lib/util.js';
import { label } from '../../lib/failure.js';
import { collect, toMarkdown } from '../../lib/diagnostics.js';
import { RESET_EXPLANATION, resetLocalState } from '../../lib/recover.js';
import { useProtectionPrompt } from '../../hooks/useProtectionPrompt.jsx';
import { domainExplanation, routeCopy } from '../../lib/net/policy.js';
import { effectiveMode } from '../../lib/net/transport.js';
import { Button, DataTable, Hint, Pill, Section, useDialogs, useSettingsNav } from '../../components/index.js';

export function ServersPane() {
  const store = useStore();
  useStoreEvent('status', 'session', 'network-privacy');
  const dialogs = useDialogs();
  const onConnectError = useProtectionPrompt();
  const [, bump] = useState(0);
  const redraw = () => bump((n) => n + 1);

  const guilds = [...store.guilds.values()];
  const homeDomain = store.session?.home?.domain || null;

  const rows = Object.entries(store.session?.servers || {})
    .map(([domain, entry]) => ({ domain, entry }));

  const why = (domain) => {
    const decision = effectiveMode(domain);
    const route = routeCopy(decision, { domain });
    const source = domainExplanation(store.networkPrefs(), guilds, domain, { homeDomain });
    return { route, sentence: [route.sentence, source.sentence].filter(Boolean).join(' ') };
  };

  return (
    <>
      <Section>
        <Hint>If one server is unreachable, only its guilds grey out.</Hint>
        <DataTable
          rows={rows}
          rowKey={(r) => r.domain}
          empty="No sessions yet."
          layout="rows"
          columns={[
            {
              key: 'server',
              header: 'Server',
              render: (r) => {
                const seen = why(r.domain);
                return (
                  <>
                    {r.domain}
                    {r.domain === store.session.home.domain ? <Pill>home</Pill> : null}
                    <Pill tone={seen.route.tone}>{seen.route.label}</Pill>
                    <div className="netpriv-why w-full">{seen.sentence}</div>
                  </>
                );
              },
            },
            {
              key: 'status',
              header: 'Status',
              render: (r) => {
                const failure = store.gw.get(r.domain)?.failure();
                return failure ? label(failure.kind) : 'connected';
              },
            },
            {
              key: 'renews',
              header: 'Session renews',
              render: (r) => (r.entry.revalidate_at ? relative(r.entry.revalidate_at) : 'unknown'),
            },
            {
              key: 'actions',
              header: '',
              render: (r) => (
                <>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      const renew = async () => { await store.renewServer(r.domain); redraw(); };
                      try { await renew(); }
                      catch (e) { onConnectError(e, { context: 'Could not renew', retry: renew }); }
                    }}
                  >
                    Renew
                  </Button>
                  {r.domain === store.session.home.domain ? null : (
                    <Button
                      variant="danger-soft"
                      onClick={() => dialogs.confirm({
                        title: `Disconnect ${r.domain}`,
                        body: 'You stay a member of its guilds. Reconnecting restores everything.',
                        confirmLabel: 'Disconnect',
                        danger: true,
                        onConfirm: async () => { await store.removeServer(r.domain); redraw(); },
                      })}
                    >
                      Disconnect
                    </Button>
                  )}
                </>
              ),
            },
          ]}
        />
        <Button
          variant="primary"
          className="self-start"
          onClick={() => dialogs.prompt({
            title: 'Connect to a server',
            label: 'Server domain',
            placeholder: 'guilds.example.org',
            confirmLabel: 'Connect',
            onSubmit: async (domain) => {
              const connect = async () => { await store.addServer(domain.trim()); redraw(); };
              try { await connect(); }
              catch (e) { onConnectError(e, { context: 'Could not connect', retry: connect }); }
            },
          })}
        >
          Connect to a server
        </Button>
      </Section>
      <TroubleshootingSection />
    </>
  );
}

function TroubleshootingSection() {
  const store = useStore();
  const dialogs = useDialogs();
  const nav = useSettingsNav();
  const [busy, setBusy] = useState(false);

  return (
    <Section
      title="If something is not working"
      description="Two things to try before anyone has to look at your account."
    >
      <Hint>
        The report below describes this device and its connections -- versions, domains, close
        codes, and how many of each thing you have. It contains no messages, no drafts, no names
        and nothing that could sign in as you, so it is safe to paste into a public bug report.
      </Hint>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const text = toMarkdown(await collect(store));
              await navigator.clipboard.writeText(text);
              ok('Diagnostics copied. Paste it into your bug report.');
            } catch (e) {
              reportError(e, 'Could not copy the diagnostics');
            } finally { setBusy(false); }
          }}
        >
          Copy diagnostics
        </Button>
        <Button onClick={() => nav.go('feedback')}>
          Report a bug
        </Button>
        <Button
          variant="danger-soft"
          disabled={busy}
          onClick={() => dialogs.confirm({
            title: 'Reload everything from the server',
            body: RESET_EXPLANATION,
            confirmLabel: 'Reload everything',
            danger: true,
            onConfirm: () => resetLocalState(),
          })}
        >
          Reload everything from the server
        </Button>
      </div>
    </Section>
  );
}
