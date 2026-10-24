import { useEffect, useState } from 'react';
import { useStore } from '../hooks/useStore.jsx';
import { Banner, Button } from '../components/index.js';
import { readDismissal, versionNotice, writeDismissal } from '../lib/version.js';

const POLL_MS = 60 * 60 * 1000;

export function VersionBanner() {
  const store = useStore();
  const [status, setStatus] = useState(null);
  const [dismissal, setDismissal] = useState(() => (
    readDismissal(typeof localStorage === 'undefined' ? null : localStorage)
  ));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    const ask = async () => {
      try {
        const body = await store.home.adminVersion();
        if (live) { setStatus(body); setNow(Date.now()); }
      } catch {
        if (live) setStatus(null);
      }
    };
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [store]);

  const notice = versionNotice(status, { now, dismissal });
  if (!notice) return null;

  return (
    <Banner tone={notice.tone} role={notice.security ? 'alert' : 'status'}>
      <span className="font-medium">{notice.headline}</span>
      {notice.detail ? <span>{notice.detail}</span> : null}
      <Button
        size="sm"
        variant={notice.tone === 'danger' ? 'danger-soft' : 'flat'}
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={() => {
          const until = Date.now() + notice.snoozeMs;
          writeDismissal(typeof localStorage === 'undefined' ? null : localStorage, notice.key, until);
          setDismissal({ key: notice.key, until });
          setNow(Date.now());
        }}
      >
        Dismiss
      </Button>
    </Banner>
  );
}
