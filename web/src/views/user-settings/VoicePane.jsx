import { useState } from 'react';
import { useVoice } from '../../hooks/useVoice.jsx';
import {
  ChoiceCard, ChoiceList, Hint, MicIcon, MicOffIcon, Section, SignalIcon, Spinner,
} from '../../components/index.js';
import { unavailableBecause } from '../../lib/denoise.js';

const MODES = [
  ['off', 'Off', 'Send the microphone as it is.', MicOffIcon],
  ['browser', 'Standard', 'Your browser’s own suppressor. Free, and good at steady noise — a fan, a hum, traffic.', MicIcon],
  ['neural', 'Neural', 'A small model runs on this device and removes noise the standard one leaves behind.', SignalIcon],
];

export function VoicePane() {
  const voice = useVoice();
  const [busy, setBusy] = useState(false);

  const support = voice.noiseSupport || { ok: true };
  const blocked = !support.ok ? (unavailableBecause(support.reason)
    || 'This device cannot run neural noise cancellation.') : null;

  const choose = async (key) => {
    if (busy) return;
    setBusy(key === 'neural');
    try { await voice.setNoiseMode(key); } finally { setBusy(false); }
  };

  return (
    <Section
      title="Noise cancellation"
      description="Applies to your microphone in calls, on this device only."
    >
      <ChoiceList value={voice.noiseMode} onChange={choose}>
        {MODES.map(([key, label, description, Glyph]) => (
          <ChoiceCard
            key={key}
            value={key}
            icon={Glyph}
            label={label}
            description={key === 'neural' && blocked ? blocked : description}
            disabled={key === 'neural' && (Boolean(blocked) || busy)}
            trailing={key === 'neural' && busy ? <Spinner /> : undefined}
          />
        ))}
      </ChoiceList>
      <Hint>
        Neural uses noticeably more battery and CPU, and about 20 ms more delay.
        If it cannot keep up mid-call, Telium switches back to standard and says so.
      </Hint>
    </Section>
  );
}
