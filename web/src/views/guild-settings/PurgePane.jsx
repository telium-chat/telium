import { useState } from 'react';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { Button, Field, Hint, Section, TextInput } from '../../components/index.js';

export function PurgePane({ guildId, api }) {
  const tr = useT();
  const [userId, setUserId] = useState('');
  const [limit, setLimit] = useState('100');
  const [busy, setBusy] = useState(false);

  return (
    <Section title={tr('guild.purge.title')}>
      <Hint>
        {tr('guild.purge.hint')}
      </Hint>
      <Field label={tr('guild.purge.accountLabel')}>
        <TextInput
          value={userId}
          placeholder={tr('guild.purge.accountPlaceholder')}
          onChange={(e) => setUserId(e.target.value)}
        />
      </Field>
      <Field label={tr('guild.purge.limitLabel')}>
        <TextInput
          inputMode="numeric"
          value={limit}
          onChange={(e) => setLimit(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
      </Field>
      <Button
        variant="danger-soft"
        className="self-start"
        disabled={busy || !userId.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            const result = await api.purgeMessages(guildId, {
              user_id: userId.trim(),
              limit: Math.min(1000, Math.max(1, Number(limit) || 100)),
            });
            toast(t('guild.purge.deleted', { count: result.deleted ?? 0 }));
            setUserId('');
          } catch (e) { reportError(e, t('guild.purge.failed')); }
          finally { setBusy(false); }
        }}
      >
        {tr('guild.purge.button')}
      </Button>
    </Section>
  );
}
