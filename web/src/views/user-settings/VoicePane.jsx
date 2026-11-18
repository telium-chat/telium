import { useState } from 'react';
import { useVoice } from '../../hooks/useVoice.jsx';
import {
  ChoiceCard, ChoiceList, Hint, MicIcon, MicOffIcon, Section, SignalIcon, Spinner,
} from '../../components/index.js';
import { t } from '../../lib/i18n/index.js';
import { unavailableBecause } from '../../lib/denoise.js';

const MODES = [
  ['off', 'Off', 'Send the microphone as it is.', MicOffIcon],
  ['browser', 'Standard', 'Your browser’s own suppressor. Free, and good at steady noise — a fan, a hum, traffic.', MicIcon],
  ['neural', 'Neural', 'A model runs on this device and removes what the standard one leaves behind: keyboards, hum, other voices.', SignalIcon],
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
        Neural uses noticeably more battery and CPU, and up to 20 ms more delay than standard.
        If the device gets busy mid-call, the model steps aside and comes back on its own; your choice here is never changed.
      </Hint>
      {voice.noiseMode === 'neural' && voice.noiseState && voice.noiseState !== 'active'
        ? <Hint>{t(`voice.noise.${voice.noiseState}`)}</Hint> : null}
    </Section>
  );
}
