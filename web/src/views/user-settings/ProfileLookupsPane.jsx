import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  ChoiceCard, ChoiceList, PrivacyNote, Section,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { LOOKUP_MODES } from '../../lib/mutual-lookups.js';

export function ProfileLookupsPane() {
  const store = useStore();
  const t = useT();
  useStoreEvent('prefs');

  const mode = store.mutualLookups();

  return (
    <Section>
      <div className="flex flex-col gap-1.5">
        <ChoiceList
          aria-label={t('settings.lookups.title')}
          value={mode}
          onChange={(next) => store.setMutualLookups(next)}
        >
          {LOOKUP_MODES.map((option) => (
            <ChoiceCard
              key={option}
              value={option}
              label={t(`settings.lookups.${option}.label`)}
              description={t(`settings.lookups.${option}.description`)}
            />
          ))}
        </ChoiceList>

        <PrivacyNote
          head={t('privacy.lookups.head')}
          parties={[
            { who: t('privacy.lookups.party.home'), sees: t('privacy.lookups.sees.home') },
            { who: t('privacy.lookups.party.friendHosts'), sees: t('privacy.lookups.sees.friendHosts') },
            { who: t('privacy.lookups.party.guildHosts'), sees: t('privacy.lookups.sees.guildHosts') },
          ]}
          note={t('privacy.lookups.note')}
        />
      </div>
    </Section>
  );
}
