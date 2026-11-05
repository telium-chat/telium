import { useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { Banner } from '../components/index.js';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';

const TICK_MS = 15_000;

/// Per-server "scheduled to restart" banners: the gateway dispatch and READY
/// feed `store.restartNotices`, the voice relay's `telium.drain` feeds
/// `store.sfuNotice`. Short-lived by nature, so there is no dismissal --
/// withdrawn by the server's cancellation, a READY without the notice, or the
/// deadline simply passing.
export function RestartBanner() {
  const store = useStore();
  useStoreEvent('restart-notice');
  useT();

  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now();
  const notices = [...store.restartNotices]
    .filter(([, at]) => at > now);
  // Expired notices leave the map the same way they leave the screen; the
  // emit from the removal re-renders, which lands on the filtered list above.
  useEffect(() => {
    for (const [domain, at] of store.restartNotices) {
      if (at <= now) store.onRestartCancelled(domain);
    }
    if (store.sfuNotice && store.sfuNotice.expires_at <= now) {
      store.setSfuNotice(null);
    }
  });

  // The SFU's drain has a ceiling, not a permanent warning. Even when its
  // updater dies (and no cancellation message arrives), the banner expires.
  const sfu = store.sfuNotice?.expires_at > now ? store.sfuNotice : null;
  if (!notices.length && !sfu) return null;

  return (
    <>
      {notices.map(([domain, at]) => (
        <Banner key={domain} tone="warning" role="status">
          <span className="font-medium">
            {t('shell.restart.server', {
              name: store.gw.connections.get(domain)?.name || domain,
            })}
          </span>
          <span>{t('shell.restart.brief')}</span>
        </Banner>
      ))}
      {sfu ? (
        <Banner tone="warning" role="status">
          {sfu.phase === 'now'
            ? <span className="font-medium">{t('shell.restart.sfuNow', { name: sfu.name })}</span>
            : (
              <span className="font-medium">
                {sfu.until_ms
                  ? t('shell.restart.sfu', {
                      name: sfu.name,
                      // A countdown to the drain deadline: the actual restart
                      // lands whenever rooms empty inside this ceiling.
                      count: Math.max(1, Math.ceil((sfu.until_ms - now) / 60_000)),
                    })
                  : t('shell.restart.sfuSoon', { name: sfu.name })}
              </span>
            )}
          <span>{t('shell.restart.brief')}</span>
        </Banner>
      ) : null}
    </>
  );
}
