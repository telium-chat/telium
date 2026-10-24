import { useEffect, useState } from 'react';
import { useAsync, useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { codeOf, errorMessage } from '../../lib/i18n/errors.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Async, Button, DataTable, EmojiText, Hint, Notice, Pill, Section
} from '../../components/index.js';
import { VerifyDialog } from '../dialogs/VerifyDialog.jsx';
import { Advanced, Detail, Verdict } from './RecoveryParts.jsx';

export function DevicesPane() {
  const store = useStore();
  const modal = useModal();
  const t = useT();
  const state = useAsync(() => store.home.devices().then((r) => r.devices || []), []);
  const trust = store.trust;
  useStoreEvent('verify', 'vault');

  const [status, setStatus] = useState(new Map());
  useEffect(() => {
    if (!trust) return;
    trust.refresh(store.me?.user_id)
      .then((peer) => setStatus(new Map(
        [...peer.devices.keys()].map((id) => [id, trust.statusFor(store.me.user_id, id, null)]),
      )))
      .catch(() => {});
  }, [trust, store.me, state.data]);

  const verify = (deviceId) => modal.open((close) => (
    <VerifyDialog userId={store.me.user_id} deviceId={deviceId} close={close} />
  ));

  const live = (state.data || []).filter((d) => d.active);
  const active = live.length;
  const checked = status.size > 0;
  const unverified = checked
    ? live.filter((d) => status.get(d.device_id) !== 'verified').length
    : 0;

  const verdictKey = !active || !checked
    ? 'security.devices.checking'
    : unverified === 0
      ? 'security.devices.allVerified'
      : unverified === active
        ? 'security.devices.noneVerified'
        : 'security.devices.someUnverified';
  const verdictValues = verdictKey === 'security.devices.someUnverified'
    ? { count: unverified, total: active }
    : { count: active };

  return (
    <>
      <Section>
        <Verdict
          state={unverified ? 'attention' : (active && checked) ? 'ok' : 'working'}
          title={t(verdictKey, verdictValues)}
        >
          {unverified
            ? t('security.devices.unverifiedNote')
            : t('security.devices.recogniseNote')}
        </Verdict>
        {trust && !trust.canSign ? (
          <Notice tone="warn">
            {t('security.devices.cannotSign', { pane: t('settings.nav.recovery') })}
          </Notice>
        ) : null}
        <Async state={state}>
          {(devices) => (
            <DataTable
              rows={devices}
              rowKey={(d) => d.device_id}
              empty={t('security.devices.empty')}
              label={t('security.devices.tableLabel')}
              layout="rows"
              columns={[
                {
                  key: 'device',
                  header: t('security.devices.colDevice'),
                  render: (d) => (
                    <>
                      <EmojiText>{d.name || d.device_id}</EmojiText>
                      {d.current ? <Pill>{t('security.devices.thisDevice')}</Pill> : null}
                      {d.active ? null : <Pill>{t('security.devices.signedOut')}</Pill>}
                      {d.active && status.get(d.device_id) === 'verified'
                        ? <Pill tone="success">{t('security.devices.verifiedBadge')}</Pill> : null}
                      {d.active && status.get(d.device_id) === 'unverified'
                        ? <Pill tone="warn">{t('security.devices.unverifiedBadge')}</Pill> : null}
                    </>
                  ),
                },
                {
                  key: 'added',
                  header: t('security.devices.colAdded'),
                  render: (d) => t('security.devices.addedAt', { at: d.created_at }),
                },
                {
                  key: 'seen',
                  header: t('security.devices.colLastSeen'),
                  render: (d) => t('security.devices.lastSeenAt', { at: d.last_seen }),
                },
                {
                  key: 'verify',
                  header: '',
                  render: (d) => (d.active && !d.current && status.get(d.device_id) !== 'verified' ? (
                    <Button
                      variant="ghost"
                      aria-label={t('security.devices.verifyDevice', { device: d.name || d.device_id })}
                      onClick={() => verify(d.device_id)}
                    >
                      {t('security.devices.verify')}
                    </Button>
                  ) : null),
                },
                {
                  key: 'revoke',
                  header: '',
                  render: (d) => (d.active && !d.current ? (
                    <Button
                      variant="danger-soft"
                      aria-label={t('security.devices.signOutDevice', { device: d.name || d.device_id })}
                      onClick={async () => {
                        try { await store.revokeDevice(d.device_id); state.reload(); }
                        catch (e) {
                          toast(
                            codeOf(e)
                              ? errorMessage(e)
                              : t('security.devices.signOutFailed', { reason: errorMessage(e) }),
                            { error: true },
                          );
                        }
                      }}
                    >
                      {t('security.devices.signOut')}
                    </Button>
                  ) : null),
                },
              ]}
            />
          )}
        </Async>
        <Hint>{t('security.devices.revokeHint')}</Hint>

        <Advanced>
          <Detail name={t('security.devices.whatVerifiedTitle')}>
            {t('security.devices.whatVerifiedBody')}
          </Detail>
          <Detail name={t('security.devices.revocationTitle')}>
            {t('security.devices.revocationBody')}
          </Detail>
        </Advanced>
      </Section>
    </>
  );
}
