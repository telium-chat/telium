import { useStore } from '../../hooks/useStore.jsx';
import { Section } from '../../components/index.js';
import { RecoveryPanel } from '../RecoveryScreen.jsx';

export function LocalDataPane() {
  const store = useStore();
  return (
    <Section
      title="Local data"
      description={
        'Telium keeps a copy of your recent conversations and your encryption '
        + 'keys on this device so it can open instantly and read your DMs. '
        + 'Nothing here affects your account or any other device.'
      }
    >
      <div className="panel p-4">
        <RecoveryPanel store={store} compact />
      </div>
    </Section>
  );
}
