import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import {
  Button, Hint, Notice, Pill, PrivacyNote, Section, Select, Switch,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { errorMessage } from '../../lib/i18n/errors.js';
import * as sw from '../../lib/serviceworker.js';
import { isMobileTauri, isTauriRuntime } from '../../lib/platform.js';
import {
  androidNotificationStatus,
  enrollAndroidNotifications,
  setAndroidDmNotifications,
  setAndroidNotificationPreview,
} from '../../lib/android-notifications.js';
import {
  normalizeNotificationPreview,
} from '../../lib/notification-preview.js';
import {
  localNotificationsSupported,
  notificationPermission,
  requestNotificationPermission,
} from '../../lib/notifications.js';

const ASKABLE = new Set(['default', 'prompt', 'prompt-with-rationale']);

export function NotificationsPane() {
  const store = useStore();
  const t = useT();
  const nativeHost = isTauriRuntime();
  const localSupported = localNotificationsSupported();
  const [permission, setPermission] = useState(localSupported ? 'loading' : 'unsupported');
  const [subscribed, setSubscribed] = useState(sw.supported ? null : false);
  const [androidPush, setAndroidPush] = useState(
    isMobileTauri ? { loading: true, registered: false } : null,
  );
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [androidBusy, setAndroidBusy] = useState(false);
  const [, bump] = useState(0);
  const set = (fn) => { fn(); store.savePrefs(); bump((n) => n + 1); };
  const previewMode = normalizeNotificationPreview(store.prefs.notificationPreview);

  useEffect(() => {
    let live = true;
    notificationPermission()
      .then((value) => { if (live) setPermission(value); })
      .catch(() => { if (live) setPermission('unsupported'); });
    if (sw.supported) {
      sw.currentSubscription()
        .then((s) => { if (live) setSubscribed(Boolean(s)); })
        .catch(() => { if (live) setSubscribed(false); });
    }
    if (isMobileTauri && store.session?.home) {
      androidNotificationStatus(store.session.home)
        .then((status) => {
          if (live) setAndroidPush({ loading: false, ...status });
        })
        .catch(() => {
          if (live) setAndroidPush({ loading: false, supported: false, registered: false });
        });
    }
    return () => { live = false; };
  }, [store.session?.home?.device_id]);

  useEffect(() => {
    if (!isMobileTauri || !store.session?.home) return;
    setAndroidNotificationPreview(store.session.home, previewMode).catch(() => {});
  }, [
    previewMode,
    store.session?.home?.base,
    store.session?.home?.user_id,
    store.session?.home?.device_id,
  ]);

  useEffect(() => {
    if (!isMobileTauri || !store.session?.home) return;
    setAndroidDmNotifications(
      store.session.home,
      store.prefs.notifyDms !== false,
    ).catch(() => {});
  }, [
    store.prefs.notifyDms,
    store.session?.home?.base,
    store.session?.home?.user_id,
    store.session?.home?.device_id,
  ]);

  const enableAndroid = async () => {
    if (!isMobileTauri || !store.session?.home) return;
    setAndroidBusy(true);
    try {
      await enrollAndroidNotifications(store.home, store.session.home, previewMode);
      const status = await androidNotificationStatus(store.session.home);
      setAndroidPush({ loading: false, ...status });
      toast(t('notifications.push.android.enrolled', {
        outcome: status.wake_verified
          ? 'verified'
          : status.wake_endpoint_registered ? 'endpoint' : 'pending',
      }));
    } catch (e) {
      toast(t('notifications.push.android.enrollFailed', { reason: errorMessage(e) }), { error: true });
      setAndroidPush(await androidNotificationStatus(store.session.home)
        .then((status) => ({ loading: false, ...status }))
        .catch(() => ({ loading: false, supported: false, registered: false })));
    } finally {
      setAndroidBusy(false);
    }
  };

  const enableLocal = async () => {
    setPermissionBusy(true);
    try {
      const next = await requestNotificationPermission();
      setPermission(next);
      if (next === 'granted') {
        if (isMobileTauri && !androidPush?.wake_endpoint_registered) await enableAndroid();
        toast(t('notifications.local.enabled'));
      }
    } catch (e) {
      toast(t('notifications.local.enableFailed', { reason: errorMessage(e) }), { error: true });
      setPermission(await notificationPermission().catch(() => 'unsupported'));
    } finally {
      setPermissionBusy(false);
    }
  };

  const togglePush = async (wanted) => {
    setPushBusy(true);
    try {
      if (wanted) await sw.subscribe(store.home, store.session.home);
      else await sw.unsubscribe(store.home, store.session.home);
      setSubscribed(wanted);
      setPermission(await notificationPermission());
      toast(wanted ? t('notifications.push.web.on') : t('notifications.push.web.off'));
    } catch (e) {
      const reason = errorMessage(e);
      toast(
        wanted
          ? t('notifications.push.web.onFailed', { reason })
          : t('notifications.push.web.offFailed', { reason }),
        { error: true },
      );
      setPermission(await notificationPermission().catch(() => permission));
    } finally {
      setPushBusy(false);
    }
  };

  const permissionTone = permission === 'granted' ? 'success' : 'default';
  const androidWakeReady = Boolean(
    androidPush?.registered
      && androidPush?.wake_endpoint_registered
      && androidPush?.wake_verified,
  );
  const androidStage = androidWakeReady
    ? 'ready'
    : androidPush?.wake_endpoint_registered
      ? 'unverified'
      : androidPush?.registered
        ? 'inbox'
        : permission === 'granted'
          ? 'none'
          : 'blocked';
  const androidStateToken = androidPush?.loading ? 'checking' : androidStage;

  return (
    <>
      <Section
        title={t('notifications.local.title')}
        description={t('notifications.local.description')}
      >
        {localSupported ? (
          <>
            <div className="flex flex-wrap items-center gap-2 panel px-3 py-2.5">
              <span className="min-w-0 flex-1 text-base">
                {nativeHost
                  ? t('notifications.local.systemPermission')
                  : t('notifications.local.browserPermission')}
              </span>
              <Pill tone={permissionTone}>
                {t('notifications.local.permissionState', { state: permission })}
              </Pill>
              {ASKABLE.has(permission) ? (
                <Button disabled={permissionBusy} onClick={enableLocal}>
                  {permissionBusy
                    ? t('notifications.local.enabling')
                    : t('notifications.local.enable')}
                </Button>
              ) : null}
            </div>
            {permission === 'denied' ? (
              <Notice tone="warn">
                {nativeHost
                  ? t('notifications.local.blockedSystem')
                  : t('notifications.local.blockedBrowser')}
              </Notice>
            ) : null}
          </>
        ) : (
          <Notice tone="warn">{t('notifications.local.unsupported')}</Notice>
        )}

        {store.applyUpdate ? (
          <div className="flex flex-wrap items-center gap-2 panel px-3 py-2.5">
            <span className="min-w-0 flex-1 text-base">{t('notifications.local.updateReady')}</span>
            <Button onClick={() => store.applyUpdate()}>{t('notifications.local.reload')}</Button>
          </div>
        ) : null}
      </Section>

      <Section
        title={t('notifications.push.title')}
        description={t('notifications.push.description')}
      >
        {isMobileTauri ? (
          <>
            <div className="flex flex-wrap items-center gap-2 panel px-3 py-2.5">
              <span className="min-w-0 flex-1 text-base">{t('notifications.push.android.label')}</span>
              <Pill tone={androidWakeReady ? 'success' : 'default'}>
                {t('notifications.push.android.state', { stage: androidStateToken })}
              </Pill>
              {!androidPush?.loading && !androidWakeReady && permission === 'granted' ? (
                <Button disabled={androidBusy} onClick={enableAndroid}>
                  {androidBusy
                    ? t('notifications.push.android.testing')
                    : t('notifications.push.android.action', { stage: androidStage })}
                </Button>
              ) : null}
            </div>
            <Notice tone={androidWakeReady ? 'default' : 'warn'}>
              {t('notifications.push.android.notice', { stage: androidStage })}
            </Notice>
          </>
        ) : sw.supported ? (
          <>
            <div className="divide-y divide-border panel px-3">
              <Switch
                label={t('notifications.push.web.label')}
                hint={t('notifications.push.web.hint')}
                checked={Boolean(subscribed)}
                disabled={pushBusy || subscribed === null || permission === 'denied'}
                onChange={(next) => togglePush(next)}
              />
            </div>
            <PrivacyNote
              head={t('privacy.push.head')}
              note={t('privacy.push.provider')}
            />
          </>
        ) : (
          <Notice tone={nativeHost ? 'default' : 'warn'}>
            {nativeHost
              ? t('notifications.push.desktopOnly')
              : t('notifications.push.unsupported')}
          </Notice>
        )}
        <Hint>{t('notifications.push.privacyHint')}</Hint>
      </Section>

      <Section title={t('notifications.alerts.title')}>
        <Select
          label={t('notifications.alerts.preview.label')}
          hint={t('notifications.alerts.preview.hint')}
          value={previewMode}
          options={[
            ['full', t('notifications.alerts.preview.full')],
            ['sender', t('notifications.alerts.preview.sender')],
            ['hidden', t('notifications.alerts.preview.hidden')],
          ]}
          onChange={(event) => set(() => {
            store.prefs.notificationPreview = normalizeNotificationPreview(event.target.value);
          })}
        />
        <div className="divide-y divide-border panel px-3">
          <Switch
            label={t('notifications.alerts.mentions.label')}
            hint={t('notifications.alerts.mentions.hint')}
            checked={store.prefs.notifyMentions !== false}
            onChange={(next) => set(() => { store.prefs.notifyMentions = next; })}
          />
          <Switch
            label={t('notifications.alerts.dms.label')}
            hint={isMobileTauri
              ? t('notifications.alerts.dms.hintAndroid')
              : t('notifications.alerts.dms.hint')}
            checked={store.prefs.notifyDms !== false}
            onChange={(next) => set(() => { store.prefs.notifyDms = next; })}
          />
          <Switch
            label={t('notifications.alerts.sound.label')}
            hint={t('notifications.alerts.sound.hint')}
            checked={Boolean(store.prefs.notifySounds)}
            onChange={(next) => set(() => { store.prefs.notifySounds = next; })}
          />
          <Switch
            label={t('notifications.alerts.soundMessages.label')}
            hint={t('notifications.alerts.soundMessages.hint')}
            checked={Boolean(store.prefs.notifySoundMessages)}
            disabled={!store.prefs.notifySounds}
            onChange={(next) => set(() => { store.prefs.notifySoundMessages = next; })}
          />
          <Switch
            label={t('notifications.alerts.callRing.label')}
            hint={t('notifications.alerts.callRing.hint')}
            checked={store.prefs.notifyCallRing !== false}
            onChange={(next) => set(() => { store.prefs.notifyCallRing = next; })}
          />
        </div>
      </Section>
    </>
  );
}
