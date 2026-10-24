import { useMemo, useState } from 'react';
import {
  Button, ModalShell, ScreenIcon, TextInput,
} from '../../components/index.js';
import { WATCH_PROVIDERS, hostOf, providerById, sourceFor } from '../../lib/watch/providers.js';
import { connectsTo } from '../../lib/watch/player.js';
import { list, t } from '../../lib/i18n/index.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';

export function WatchTogetherDialog({ close, allowed = [], sealed, onStart }) {
  useT();
  const [url, setUrl] = useState('');
  const source = useMemo(
    () => (url.trim() ? sourceFor(url, { allowed }) : null),
    [url, allowed],
  );
  const services = WATCH_PROVIDERS.filter((p) => allowed.includes(p.id) && p.id !== 'file');
  const files = allowed.includes('file');

  return (
    <ModalShell
      title={t('voice.watch.title')}
      subtitle={t('voice.watch.subtitle')}
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isDisabled={!source}
            onClick={() => { onStart(source); close(); }}
          >
            {t('voice.watch.start')}
          </Button>
        </>
      )}
    >
      {services.length || files ? (
        <TextInput
          autoFocus
          label={t('voice.watch.url')}
          hint={list(
            [...services.map((p) => p.name), files ? t('voice.watch.orFile') : ''].filter(Boolean),
            'disjunction',
          )}
          value={url}
          placeholder={t('voice.watch.urlPlaceholder')}
          onChange={(e) => setUrl(e.target.value)}
        />
      ) : (
        <p className="text-sm text-muted">{t('voice.watch.noEmbeds')}</p>
      )}

      {url.trim() && !source && (services.length || files) ? (
        <div className="flex flex-col gap-2 rounded-card bg-surface-secondary p-3">
          <p className="text-sm text-foreground">{t('voice.watch.unsyncable')}</p>
          <p className="text-sm text-muted">{t('voice.watch.unsyncableWhy')}</p>
          <p className="flex items-start gap-2 text-sm text-muted">
            <ScreenIcon className="mt-0.5 size-4 shrink-0" />
            <span>{t('voice.watch.unsyncableInstead')}</span>
          </p>
        </div>
      ) : null}

      {source ? (
        <div className="flex flex-col gap-2 rounded-card bg-surface-secondary p-3">
          <p className="text-sm text-foreground">
            <Trans
              k="voice.watch.connects"
              values={{ provider: providerById(source.provider)?.name, host: hostOf(source) }}
              components={{ b: <span className="font-medium" /> }}
            />
          </p>
          <p className="text-sm text-muted">
            {t(
              connectsTo(source)?.kind === 'file' ? 'voice.watch.noteFile' : 'voice.watch.noteFrame',
              { provider: providerById(source.provider)?.name },
            )}
          </p>
          <p className="text-sm text-muted">
            {t(sealed ? 'voice.watch.sealed' : 'voice.watch.relayed')}
          </p>
        </div>
      ) : null}
    </ModalShell>
  );
}
