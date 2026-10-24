import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useVoice } from '../../hooks/useVoice.jsx';
import {
  Button, ChoiceCard, ChoiceList, Hint, MicIcon, MicOffIcon, Pill, PrivacyNote,
  Section, SignalIcon, Spinner,
} from '../../components/index.js';
import { POSTURE_COPY, POSTURE_OBSERVERS, POSTURES } from '../../lib/callmode.js';
import { conversationTitle } from '../../lib/conversations.js';
import { unavailableBecause } from '../../lib/denoise.js';

const MODES = [
  ['off', 'Off', 'Send the microphone as it is.', MicOffIcon],
  ['browser', 'Standard', 'Your browser’s own suppressor. Free, and good at steady noise — a fan, a hum, traffic.', MicIcon],
  ['neural', 'Neural', 'A small model runs on this device and removes noise the standard one leaves behind.', SignalIcon],
];

function Observers({ posture }) {
  const copy = POSTURE_COPY[posture];
  const observers = POSTURE_OBSERVERS[posture];
  return copy && observers ? <PrivacyNote head={`With “${copy.label}” selected, this is who is on the wire.`} parties={observers.parties} note={observers.note} /> : null;
}

export function CallsPane() {
  const store = useStore();
  const voice = useVoice();
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const set = (fn) => { fn(); bump((n) => n + 1); };
  const overrides = Object.entries(store.prefs.signals?.conversations || {})
    .filter(([, per]) => per.call !== undefined);
  const support = voice.noiseSupport || { ok: true };
  const blocked = !support.ok ? (unavailableBecause(support.reason) || 'This device cannot run neural noise cancellation.') : null;

  const chooseNoise = async (key) => {
    if (busy) return;
    setBusy(key === 'neural');
    try { await voice.setNoiseMode(key); } finally { setBusy(false); }
  };

  return (
    <Section>
      <Section title="Call privacy" description="In a call, the strictest choice among the people in it wins.">
        <div className="flex flex-col gap-1.5">
          <ChoiceList aria-label="Call privacy" value={store.callPrivacyFor(null)} onChange={(next) => set(() => store.setCallPrivacy(next))}>
            {POSTURES.map((p) => <ChoiceCard key={p} value={p} label={POSTURE_COPY[p].label} description={POSTURE_COPY[p].description} />)}
          </ChoiceList>
          <Observers posture={store.callPrivacyFor(null)} />
        </div>
      </Section>

      {overrides.length ? (
        <Section title="Per-conversation call settings" description="These choices override the call privacy setting above for individual conversations.">
          <div className="flex flex-col gap-1.5">
            {overrides.map(([id, per]) => {
              const convo = store.conversations.find((c) => c.id === id);
              return <div className="flex items-center gap-2" key={id}>
                <span className="min-w-0 flex-1 truncate text-base">{convo ? conversationTitle(store, convo) : id}</span>
                <Pill tone={per.call === 'direct' ? 'default' : 'success'}>{`calls: ${POSTURE_COPY[per.call]?.label.toLowerCase() || per.call}`}</Pill>
                <Button onClick={() => set(() => store.setSignal('call', null, id))}>Reset</Button>
              </div>;
            })}
          </div>
        </Section>
      ) : null}

      <Section title="Microphone" description="Noise cancellation applies to your microphone in calls, on this device only.">
        <ChoiceList value={voice.noiseMode} onChange={chooseNoise}>
          {MODES.map(([key, label, description, Glyph]) => <ChoiceCard key={key} value={key} icon={Glyph} label={label} description={key === 'neural' && blocked ? blocked : description} disabled={key === 'neural' && (Boolean(blocked) || busy)} trailing={key === 'neural' && busy ? <Spinner /> : undefined} />)}
        </ChoiceList>
        <Hint>Neural uses noticeably more battery and CPU, and about 20 ms more delay. If it cannot keep up mid-call, Telium switches back to standard and says so.</Hint>
      </Section>
    </Section>
  );
}
