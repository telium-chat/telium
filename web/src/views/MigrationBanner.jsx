import { useState } from 'react';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { toast } from '../hooks/useToast.jsx';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { errorMessage } from '../lib/i18n/errors.js';
import { Banner, Button } from '../components/index.js';

export function describeMigration(alert, now = Date.now()) {
  return t('migration.banner.alert', {
    subject: alert.subject_type === 'guild' ? 'guild' : 'user',
    subjectId: alert.subject_id,
    destination: alert.destination,
    when: alert.executes_at > now ? 'at' : 'soon',
    at: alert.executes_at,
    mailed: alert.email === 'sent' ? 'sent' : 'none',
  });
}

const SHOWN_IN_FULL = 2;

export function MigrationBanner() {
  const store = useStore();
  useStoreEvent('migration-alerts');
  useT();
  const [busy, setBusy] = useState(null);
  const alerts = store.migrationAlerts || [];
  if (!alerts.length) return null;
  const shown = alerts.slice(0, SHOWN_IN_FULL);
  const rest = alerts.length - shown.length;

  return (
    <>
      {shown.map((alert) => (
        <Banner key={alert.id} tone="danger" role="alert">
          {describeMigration(alert)}
          <Button
            size="sm"
            variant="danger-soft"
            className="ms-1 min-h-9 shrink-0 rounded-lg"
            disabled={busy === alert.id}
            onClick={async () => {
              setBusy(alert.id);
              try {
                await store.cancelMigration(alert.id);
              } catch (e) {
                toast(t('migration.banner.cancelFailed', { reason: errorMessage(e) }), { error: true });
              } finally {
                setBusy(null);
              }
            }}
          >
            {t('migration.banner.cancel')}
          </Button>
        </Banner>
      ))}
      {rest ? (
        <Banner tone="danger" role="alert">
          {t('migration.banner.more', { count: rest })}
        </Banner>
      ) : null}
    </>
  );
}
