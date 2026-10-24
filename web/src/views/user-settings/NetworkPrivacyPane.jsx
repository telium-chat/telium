import { useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  Button, ChoiceCard, ChoiceList, Hint, Notice, PhoneIcon, Pill, Section, Switch, useSettingsNav,
} from '../../components/index.js';
import {
  AUTO_FALLBACK_COPY, BROWSER_NOTICE, CALLS_ELSEWHERE, GLOBAL_MODES, MODE_COPY, NOT_COVERED,
  PANE_COPY, guildExplanation,
} from '../../lib/net/policy.js';
import { protectionSupported } from '../../lib/net/transport.js';
import { Advanced } from './RecoveryParts.jsx';

function NotCovered() {
  return (
    <div className="netpriv-uncovered">
      <div className="netpriv-uncovered__title">{PANE_COPY.notCoveredTitle}</div>
      <div className="netpriv-uncovered__lead">{PANE_COPY.notCoveredLead}</div>
      <ul className="netpriv-uncovered__list">
        {NOT_COVERED.map((line) => (
          <li className="netpriv-uncovered__item" key={line}><span>{line}</span></li>
        ))}
      </ul>
    </div>
  );
}

function CallsElsewhere() {
  const nav = useSettingsNav();
  const reachable = nav.has(CALLS_ELSEWHERE.pane);
  const body = (
    <>
      <PhoneIcon className="netpriv-elsewhere__glyph size-[17px]" aria-hidden="true" />
      <span className="netpriv-elsewhere__body">
        <span className="netpriv-elsewhere__title">{CALLS_ELSEWHERE.label}</span>
        <span className="netpriv-elsewhere__text">{CALLS_ELSEWHERE.description}</span>
      </span>
    </>
  );
  if (!reachable) return <div className="netpriv-elsewhere">{body}</div>;
  return (
    <button type="button" className="netpriv-elsewhere" onClick={() => nav.go(CALLS_ELSEWHERE.pane)}>
      {body}
    </button>
  );
}

export function NetworkPrivacyPane() {
  const store = useStore();
  useStoreEvent('network-privacy', 'guilds', 'prefs');
  const [, bump] = useState(0);
  const set = (fn) => { fn(); bump((n) => n + 1); };

  const net = store.networkPrefs();
  const supported = protectionSupported();
  const guilds = [...store.guilds.values()];
  const marked = guilds.filter((g) => net.guilds[g.id]);

  return (
    <Section>
      {supported ? null : (
        <Notice tone="warn">
          <div className="text-base font-medium">{BROWSER_NOTICE.title}</div>
          <p className="pt-0.5 text-sm leading-[1.55]">{BROWSER_NOTICE.body}</p>
        </Notice>
      )}

      <ChoiceList
        aria-label="Network privacy"
        value={net.mode}
        onChange={(next) => set(() => store.setNetworkMode(next))}
      >
        {GLOBAL_MODES.map((mode) => (
          <ChoiceCard
            key={mode}
            value={mode}
            label={MODE_COPY[mode].label}
            description={MODE_COPY[mode].description}
          />
        ))}
      </ChoiceList>

      <NotCovered />

      <CallsElsewhere />

      <Section title={PANE_COPY.markedTitle}>
        {marked.length ? (
          <div className="flex flex-col gap-1.5">
            {marked.map((guild) => {
              const why = guildExplanation(net, guilds, guild.id);
              return (
                <div className="netpriv-marked" key={guild.id}>
                  <span className="netpriv-marked__name">{guild.name || guild.id}</span>
                  <Pill tone={why.effective === 'protected' ? 'success' : 'default'}>
                    {MODE_COPY[why.effective].label}
                  </Pill>
                  <Button onClick={() => set(() => store.setGuildNetworkMode(guild.id, null))}>
                    Reset
                  </Button>
                  <div className="netpriv-why w-full">{why.sentence}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <Hint>{PANE_COPY.markedEmpty}</Hint>
        )}
      </Section>

      <Advanced>
        <Switch
          label={AUTO_FALLBACK_COPY.label}
          hint={AUTO_FALLBACK_COPY.description}
          checked={net.autoFallback}
          onChange={(next) => set(() => store.setNetworkAutoFallback(next))}
        />
      </Advanced>
    </Section>
  );
}
