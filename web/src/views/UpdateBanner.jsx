import { useCallback, useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { Banner, Button, ProgressBar } from '../components/index.js';
import { Kind } from '../lib/failure.js';
import { openExternal } from '../lib/platform.js';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { bytes } from '../lib/util.js';
import {
  Blocked, Delivery, assess, fetchManifest, readDismissal, updateNotice, writeDismissal,
} from '../lib/updates.js';

const POLL_MS = 6 * 60 * 60 * 1000;

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

const desktopUpdates = () => globalThis.teliumDesktop?.updates || null;

export function UpdateBanner() {
  const store = useStore();
  useStoreEvent('status', 'guilds');
  useT();

  const [manifest, setManifest] = useState(null);
  const [dismissal, setDismissal] = useState(() => readDismissal(storage()));
  const [now, setNow] = useState(() => Date.now());
  const [desktop, setDesktop] = useState(null);

  useEffect(() => {
    let live = true;
    const ask = async () => {
      const result = await fetchManifest();
      if (!live) return;
      setManifest(result.manifest);
      setNow(Date.now());
    };
    ask();
    const timer = setInterval(ask, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const bridge = desktopUpdates();
    if (!bridge) return undefined;
    let live = true;
    bridge.state().then((state) => { if (live) setDesktop(state); }).catch(() => {});
    const off = bridge.onChanged((state) => { if (live) setDesktop(state); });
    return () => { live = false; off(); };
  }, []);

  const incompatible = (store.gw?.failures?.() || []).some(
    (failure) => failure?.kind === Kind.Protocol,
  );

  const state = assess({ manifest, incompatible });
  const notice = updateNotice(state, { now, dismissal });

  const later = useCallback((key, snoozeMs) => {
    const until = Date.now() + snoozeMs;
    writeDismissal(storage(), key, until);
    setDismissal({ key, until });
    setNow(Date.now());
  }, []);

  if (desktop?.phase === 'ready') {
    return (
      <Banner role="status">
        <span className="font-medium">{t('updates.state.ready', { version: desktop.version })}</span>
        <Button
          size="sm"
          variant="flat"
          className="ms-1 min-h-9 shrink-0 rounded-lg"
          onClick={() => { desktopUpdates()?.restart()?.catch(() => {}); }}
        >
          {t('updates.action.restart')}
        </Button>
      </Banner>
    );
  }

  if (!notice) return null;

  const busy = desktop?.phase === 'downloading' || desktop?.phase === 'verifying';
  const failed = desktop?.phase === 'failed';
  // `assess` knows the manifest; only the desktop process knows whether this
  // install can actually be swapped (`electron/updater.cjs`). Overruling it
  // here is what keeps the button from promising an install the click cannot
  // keep -- which used to surface, after the fact, as the failure sentence.
  const installable = notice.canInstall && desktop?.canInstall !== false;

  return (
    <Banner
      tone={notice.incompatible ? 'danger' : notice.security ? 'warning' : undefined}
      role={notice.incompatible || notice.security ? 'alert' : 'status'}
    >
      <span className="font-medium">
        {notice.incompatible
          ? t('updates.incompatible')
          : t('updates.available', { version: notice.version })}
      </span>
      {notice.security ? <span>{t('updates.security')}</span> : null}
      {notice.blocked === Blocked.Runtime && notice.delivery === Delivery.Package
        ? <span>{t('updates.blocked.package')}</span>
        : null}
      {notice.blocked === Blocked.NoArtifact ? <span>{t('updates.blocked.artifact')}</span> : null}
      {desktop && notice.canInstall && !installable
        ? <span>{t('updates.blocked.package')}</span>
        : null}
      {busy ? <span>{t(`updates.state.${desktop.phase}`, { version: desktop.version })}</span> : null}
      {desktop?.phase === 'downloading' && desktop.total > 0 ? (
        <span className="flex items-center gap-2 whitespace-nowrap text-xs tabular-nums">
          <ProgressBar
            value={Math.min(100, Math.round((desktop.received / desktop.total) * 100))}
            label={t('updates.state.downloading', { version: desktop.version })}
            className="w-36"
          />
          <span>
            {t('updates.state.progress', { received: bytes(desktop.received), total: bytes(desktop.total) })}
          </span>
        </span>
      ) : null}
      {failed ? <span>{t('updates.state.failed')}</span> : null}

      <UpdateAction notice={notice} busy={busy} installable={installable} desktop={desktop} store={store} />

      <Button
        size="sm"
        variant={notice.incompatible ? 'danger-soft' : 'flat'}
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={() => later(notice.key, notice.snoozeMs)}
      >
        {t('updates.action.later')}
      </Button>
    </Banner>
  );
}

function UpdateAction({ notice, busy, installable, desktop, store }) {
  if (busy) return null;

  if (notice.delivery === Delivery.Reload) {
    return (
      <Button
        size="sm"
        variant="flat"
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={() => {
          if (typeof store.applyUpdate === 'function') store.applyUpdate();
          else globalThis.location?.reload();
        }}
      >
        {t('updates.action.reload')}
      </Button>
    );
  }

  const install = installable ? (
    <Button
      key="install"
      size="sm"
      variant="flat"
      className="ms-1 min-h-9 shrink-0 rounded-lg"
      onClick={() => { desktopUpdates()?.install()?.catch(() => {}); }}
    >
      {t('updates.action.install')}
    </Button>
  ) : null;
  // The release page travels with a failure -- the failure sentence says to
  // download it yourself, which without this link is advice going nowhere --
  // and with any state where this client cannot install. Otherwise it stays
  // out of the way of the button that works.
  const page = notice.page && (desktop?.phase === 'failed' || !installable) ? (
    <Button
      key="page"
      size="sm"
      variant="flat"
      className="ms-1 min-h-9 shrink-0 rounded-lg"
      onClick={() => { openExternal(notice.page).catch(() => {}); }}
    >
      {notice.delivery === Delivery.Store ? t('updates.action.store') : t('updates.action.page')}
    </Button>
  ) : null;

  return (
    <>
      {install}
      {page}
    </>
  );
}
