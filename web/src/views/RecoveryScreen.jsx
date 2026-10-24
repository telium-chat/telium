import { useEffect, useRef, useState } from 'react';
import { Button, Notice } from '../components/index.js';
import { clearCacheState, clearIdentityState, healedThisBoot } from '../lib/local-state.js';
import { useT } from '../lib/i18n/react.jsx';

export function RecoveryScreen({ title, message, children }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-strip px-5 py-10 text-center">
      <h1 className="max-w-[420px] text-base font-normal leading-[1.6] text-muted">{title}</h1>
      {message ? (
        <p className="max-w-[420px] break-words font-mono text-xs leading-[1.6] text-danger">
          {message}
        </p>
      ) : null}
      {children}
      <RecoveryPanel />
    </div>
  );
}

export function RecoveryPanel({ store = null, compact = false }) {
  const t = useT();
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const clearCache = async () => {
    setBusy('cache');
    await clearCacheState().catch(() => {});
    setBusy('');
    setDone('cache');
  };

  const eraseIdentity = async () => {
    setBusy('identity');
    await clearIdentityState(store).catch(() => {});
    window.location.reload();
  };

  return (
    <div className={compact ? 'flex flex-col gap-4' : 'flex w-full max-w-[420px] flex-col gap-4 pt-2 text-start'}>
      {healedThisBoot() ? (
        <Notice tone="warn">{t('auth.localData.healed')}</Notice>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('auth.localData.cache.title')}</h2>
        <p className="text-xs leading-[1.6] text-muted">{t('auth.localData.cache.body')}</p>
        <Costs items={[
          t('auth.localData.cache.cost1'),
          t('auth.localData.cache.cost2'),
          t('auth.localData.cache.cost3'),
        ]}
        />
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" loading={busy === 'cache'} onClick={clearCache}>
            {t('auth.localData.cache.button')}
          </Button>
          <Button onClick={() => window.location.reload()}>{t('auth.localData.cache.reload')}</Button>
        </div>
        {done === 'cache' ? (
          <Notice tone="success">{t('auth.localData.cache.done')}</Notice>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('auth.localData.identity.title')}</h2>
        <p className="text-xs leading-[1.6] text-muted">{t('auth.localData.identity.body')}</p>
        {confirming ? (
          <>
            <Notice tone="danger">
              <p className="pb-1 font-semibold">{t('auth.localData.identity.confirmTitle')}</p>
              <Costs items={[
                t('auth.localData.identity.cost1'),
                t('auth.localData.identity.cost2'),
                t('auth.localData.identity.cost3'),
                t('auth.localData.identity.cost4'),
              ]}
              />
            </Notice>
            <div className="flex items-center gap-2">
              <Button
                ref={confirmRef}
                variant="danger"
                loading={busy === 'identity'}
                onClick={eraseIdentity}
              >
                {t('auth.localData.identity.confirm')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            </div>
          </>
        ) : (
          <div className="pt-1">
            <Button variant="danger-soft" onClick={() => setConfirming(true)}>
              {t('auth.localData.identity.open')}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function Costs({ items }) {
  return (
    <ul className="flex list-disc flex-col gap-1 ps-4 text-xs leading-[1.6] text-muted">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}
