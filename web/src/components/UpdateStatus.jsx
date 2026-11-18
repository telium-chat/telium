import { useEffect, useState } from 'react';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import {
  Publisher, Unchecked, assess, fetchManifest, publishCheck, publisherState,
} from '../lib/updates.js';

export function UpdateStatus() {
  useT();
  const [error, setError] = useState(null);
  const [manifest, setManifest] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let live = true;
    // The desktop updater polls on its own timer; opening settings asks it too.
    globalThis.teliumDesktop?.updates?.check?.()?.catch?.(() => {});
    fetchManifest().then((result) => {
      // Published even if this footer has unmounted: the check still happened.
      publishCheck(result);
      if (!live) return;
      setError(result.error || null);
      setManifest(result.manifest);
      setDone(true);
    });
    return () => { live = false; };
  }, []);

  if (publisherState() !== Publisher.Configured) {
    return <span className="settings__updates">{t('updates.footer.unkeyed')}</span>;
  }
  if (!done) return <span className="settings__updates">{t('updates.footer.checking')}</span>;

  const behind = assess({ manifest }).latest;
  const message = error === Unchecked.Forged ? t('updates.footer.forged')
    : error === Unchecked.Unreachable || error === Unchecked.Unreadable
      ? t('updates.footer.unreachable')
      : behind ? t('updates.available', { version: behind.version })
        : t('updates.footer.current');

  return (
    <span className={`settings__updates${error === Unchecked.Forged ? ' settings__updates--bad' : ''}`}>
      {message}
    </span>
  );
}
