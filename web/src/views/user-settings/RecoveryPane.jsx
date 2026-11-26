import { useEffect, useState } from 'react';
import { useAsync, useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { errorMessage } from '../../lib/i18n/errors.js';
import { list } from '../../lib/i18n/index.js';
import {
  Button, Hint, Notice, PasswordInput, Section, TextInput, useDialogs,
} from '../../components/index.js';
import {
  Advanced, Detail, Explain, Fact, RecoveryKeyText, Verdict, downloadRecoveryKey,
} from './RecoveryParts.jsx';

// The three retired modes share one name and note: the reader cannot do anything different about them.
const RETIRED_MODES = ['device_custody', 'self_custody', 'escrowed'];

const MODE_NOTE_KEY = {
  opaque_custody: 'auth.custody.opaque.note',
  ...Object.fromEntries(RETIRED_MODES.map((m) => [m, 'auth.custody.retired.note'])),
};

const MODE_NAME_KEY = {
  opaque_custody: 'auth.custody.opaque.name',
  ...Object.fromEntries(RETIRED_MODES.map((m) => [m, 'auth.custody.retired.name'])),
};

export function RecoveryPane() {
  const store = useStore();
  useStoreEvent('dm', 'vault', 'verify', 'friends');
  const dialogs = useDialogs();
  const t = useT();
  const vault = store.vault;
  const mode = store.custody?.mode && store.custody.mode !== 'none'
    ? store.custody.mode
    : vault?.mode || null;
  const backup = store.custody?.backup || null;

  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [guardianIds, setGuardianIds] = useState(['', '', '']);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newRecoveryKey, setNewRecoveryKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [identityRecoveryKey, setIdentityRecoveryKey] = useState('');

  const trust = store.trust;
  const recoveryPolicy = trust?.recoveryPolicy || null;
  const policyVersion = Number(trust?.continuity?.currentPolicyVersion || 0);
  const friends = store.friendsIn('accepted');
  const verifiedFriends = friends.filter(
    (friend) => trust?.signed?.has(friend.user_id),
  );
  useEffect(() => {
    if (!recoveryPolicy?.guardians?.length) return;
    setGuardianIds([
      recoveryPolicy.guardians[0]?.user_id || '',
      recoveryPolicy.guardians[1]?.user_id || '',
      recoveryPolicy.guardians[2]?.user_id || '',
    ]);
  }, [policyVersion]);

  const deviceList = useAsync(
    () => store.home.devices().then((r) => (r.devices || []).filter((d) => d.active)),
    [],
  );
  const [verifiedDevices, setVerifiedDevices] = useState(null);
  useEffect(() => {
    const me = store.me?.user_id;
    if (!trust || !me) return undefined;
    let live = true;
    trust.refresh(me)
      .then((peer) => {
        if (!live) return;
        let count = 0;
        for (const id of peer.devices.keys()) {
          if (trust.statusFor(me, id, null) === 'verified') count += 1;
        }
        setVerifiedDevices(count);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [trust, store.me, deviceList.data]);

  const hasKey = Boolean(vault?.recoveryKey);
  const copyMissing = Boolean(store.custody?.recovery_copy_missing) && !hasKey;
  // The server's flag too: a vault that lost its recovery-key copy still has a key that can replace the account key.
  const recoveryEnrolled = hasKey || copyMissing || Boolean(store.custody?.recovery_key_enrolled);
  const locked = Boolean(vault?.locked);
  // The vault is in a custody mode Telium no longer reads; a new one is the only way to use encrypted messages again.
  const retired = Boolean(vault?.retiredMode);
  const canEnroll = mode === 'opaque_custody' && Boolean(vault?.raw) && !locked;

  const failed = (key, e) => toast(t(key, { detail: errorMessage(e) }), { error: true });

  const unlockWithRecoveryKey = async () => {
    if (!recoveryKey.trim()) {
      toast(t('auth.unlock.enterKey'));
      return;
    }
    setBusy(true);
    try {
      await store.unlockVault(recoveryKey);
      setRecoveryKey('');
      toast(t('auth.unlock.done'));
    } catch (e) {
      failed('auth.unlock.failed', e);
    } finally {
      setBusy(false);
    }
  };

  const unlockWithPassword = async () => {
    if (!password) {
      toast(t('auth.unlock.enterPassword'));
      return;
    }
    setBusy(true);
    try {
      await store.unlockVaultWithPassword(password);
      setPassword('');
      toast(t('auth.unlock.done'));
    } catch (e) {
      failed('auth.unlock.failed', e);
    } finally {
      setBusy(false);
    }
  };

  const restoreRecoveryCopy = async () => {
    if (!recoveryKey.trim()) {
      toast(t('auth.unlock.enterKey'));
      return;
    }
    setBusy(true);
    try {
      await store.restoreRecoveryCopy(recoveryKey);
      setRecoveryKey('');
      toast(t('auth.recoveryKey.restored'));
    } catch (e) {
      failed('auth.recoveryKey.restoreFailed', e);
    } finally {
      setBusy(false);
    }
  };

  const startNewVault = async () => {
    setBusy(true);
    try {
      await store.startNewVault();
      // The new vault has no recovery-key copy yet; an account that has a key is pointed at "Needs reconnecting".
      toast(t(store.custody?.recovery_key_enrolled ? 'auth.retired.doneReconnect' : 'auth.retired.done'));
    } catch (e) {
      failed('auth.retired.failed', e);
    } finally {
      setBusy(false);
    }
  };

  // Replacing the vault loses the old history for good: always ask.
  const askStartNewVault = () => {
    if (!store.authRecoveryWrapper) {
      toast(t('auth.retired.signInAgain'), { error: true });
      return;
    }
    dialogs.confirm({
      title: t('auth.retired.confirmTitle'),
      body: t(vault?.hasRecoveryCopy ? 'auth.retired.confirmBodyCopy' : 'auth.retired.confirmBody'),
      confirmLabel: t('auth.retired.confirmButton'),
      danger: true,
      onConfirm: startNewVault,
    });
  };

  const enrollAccountRecovery = async () => {
    if (!currentPassword) {
      toast(t('auth.recoveryKey.enterPassword'));
      return;
    }
    setBusy(true);
    try {
      const key = await store.enrollRecoveryKey(currentPassword, {
        replace: (replacing && hasKey) || copyMissing,
      });
      setCurrentPassword('');
      setReplacing(false);
      setNewRecoveryKey(key);
    } catch (e) {
      failed('auth.recoveryKey.createFailed', e);
    } finally {
      setBusy(false);
    }
  };

  const finishAccountRecovery = async () => {
    setBusy(true);
    try {
      await store.confirmRecoveryKey(newRecoveryKey);
      setNewRecoveryKey('');
      toast(t('auth.recoveryKey.savedToast'));
    } catch (e) {
      failed('auth.recoveryKey.finishFailed', e);
    } finally {
      setBusy(false);
    }
  };

  const replaceIdentity = async () => {
    setBusy(true);
    try {
      await store.recoverIdentity(identityRecoveryKey);
      setIdentityRecoveryKey('');
      toast(t('auth.identityKey.replacedReset'));
    } catch (e) {
      failed('auth.identityKey.replaceFailed', e);
    } finally {
      setBusy(false);
    }
  };

  // A reset starts a new identity, which contacts will see: always warn.
  const askReplaceIdentity = () => {
    dialogs.confirm({
      title: t('auth.identityKey.resetTitle'),
      body: t('auth.identityKey.resetBody'),
      confirmLabel: t('auth.identityKey.resetConfirm'),
      danger: true,
      onConfirm: replaceIdentity,
    });
  };

  const confirmReplace = () => dialogs.confirm({
    title: t('auth.recoveryKey.replaceTitle'),
    body: t('auth.recoveryKey.replaceBody'),
    confirmLabel: t('auth.recoveryKey.replaceConfirm'),
    danger: true,
    onConfirm: () => { setReplacing(true); setCurrentPassword(''); },
  });

  const saveGuardians = async () => {
    const selected = guardianIds.filter(Boolean);
    if (selected.length !== 3 || new Set(selected).size !== 3) {
      toast(t('auth.guardians.needThree'));
      return;
    }
    if (!trust?.canSign || !trust?.continuity?.valid) {
      toast(t('auth.guardians.cannotSign'));
      return;
    }

    setBusy(true);
    try {
      await trust.setRecoveryGuardians(selected, 2);
      store.emit('verify', { type: 'recovery_policy' });
      toast(t('auth.guardians.saved'));
    } catch (e) {
      failed('auth.guardians.saveFailed', e);
    } finally {
      setBusy(false);
    }
  };

  const dropMirror = () => dialogs.confirm({
    title: t('auth.backup.deleteTitle'),
    body: t('auth.backup.deleteBody'),
    confirmLabel: t('auth.backup.deleteConfirm'),
    danger: true,
    onConfirm: async () => {
      try {
        await store.backup?.drop(null);
        await store.refreshCustody().catch(() => {});
        toast(t('auth.backup.deleted'));
      } catch (e) {
        failed('auth.backup.deleteFailed', e);
      }
    },
  });

  const verdict = !vault
    ? {
      state: 'working',
      title: t('auth.encryption.settingUp.title'),
      note: t('auth.encryption.settingUp.note'),
    }
    : retired
      ? {
        state: 'attention',
        title: t('auth.encryption.retired.title'),
        note: t('auth.encryption.retired.note'),
      }
      : locked
        ? {
          state: 'attention',
          title: t('auth.encryption.locked.title'),
          note: t('auth.encryption.locked.note'),
        }
        : {
          state: 'ok',
          title: t('auth.encryption.ok.title'),
          note: MODE_NOTE_KEY[mode]
            ? t(MODE_NOTE_KEY[mode])
            : t('auth.encryption.ok.noteFallback'),
        };

  const filledGuardians = guardianIds.filter(Boolean);
  const guardianFault = filledGuardians.length < 3
    ? t('auth.guardians.incomplete')
    : new Set(filledGuardians).size !== 3
      ? t('auth.guardians.duplicate')
      : null;

  const deviceCount = deviceList.data?.length ?? null;
  const deviceValue = deviceCount === null
    ? t('auth.encryption.devicesCounting')
    : verifiedDevices === null
      ? t('auth.encryption.devicesSignedIn', { count: deviceCount })
      : t('auth.encryption.devicesVerified', { verified: verifiedDevices, total: deviceCount });

  return (
    <>
      <Section>
        <Verdict state={verdict.state} title={verdict.title}>{verdict.note}</Verdict>

        <div className="ekey-facts">
          <Fact
            tone={hasKey ? 'ok' : 'todo'}
            label={t('auth.encryption.keyFact')}
            value={hasKey
              ? t('auth.encryption.keySaved')
              : copyMissing
                ? t('auth.encryption.keyCopyMissing')
                : t('auth.encryption.keyMissing')}
          />
          <Fact
            tone={verifiedDevices === null || deviceCount === null
              ? 'neutral'
              : verifiedDevices === deviceCount ? 'ok' : 'todo'}
            label={t('auth.encryption.devicesFact')}
            value={deviceValue}
          />
          <Fact
            tone={backup?.items ? 'ok' : 'neutral'}
            label={t('auth.encryption.backupFact')}
            value={backup?.items
              ? t('auth.encryption.backupItems', { count: backup.items })
              : t('auth.encryption.backupEmpty')}
          />
        </div>
        <Hint>{t('auth.encryption.devicesHint')}</Hint>
      </Section>

      {locked && (!retired || (vault?.retiredMode === 'device_custody' && vault?.hasRecoveryCopy)) ? (
        <Section title={t('auth.unlock.title')}>
          {!retired && vault?.needs_password ? (
            <>
              <TextInput
                label={t('auth.unlock.passwordLabel')}
                type="password"
                value={password}
                autoComplete="current-password"
                hint={t('auth.unlock.passwordHint')}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) unlockWithPassword();
                }}
              />
              <Button
                variant="primary"
                className="self-start"
                disabled={busy || !password}
                onClick={unlockWithPassword}
              >
                {t('auth.unlock.button')}
              </Button>
            </>
          ) : null}
          {vault?.needs_recovery_key || (retired && !vault?.needs_password) ? (
            <>
              <TextInput
                label={t('auth.recoveryKey.fieldLabel')}
                type="password"
                value={recoveryKey}
                autoComplete="off"
                placeholder={t('auth.recoveryKey.placeholder')}
                hint={t('auth.unlock.keyHint')}
                onChange={(e) => setRecoveryKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) unlockWithRecoveryKey();
                }}
              />
              <Button
                variant="primary"
                className="self-start"
                disabled={busy || !recoveryKey.trim()}
                onClick={unlockWithRecoveryKey}
              >
                {t('auth.unlock.button')}
              </Button>
            </>
          ) : null}

          {/* Conversion needs the password's key, which a restored session does not hold. */}
          {retired && vault?.needs_password ? <Hint>{t('auth.retired.signInAgain')}</Hint> : null}
          {retired ? null : <Hint>{t('auth.unlock.otherDevice')}</Hint>}
        </Section>
      ) : null}

      {retired ? (
        <Section title={t('auth.retired.title')}>
          <Explain>{t('auth.retired.explain')}</Explain>
          <Button
            variant="primary"
            className="self-start"
            disabled={busy}
            onClick={askStartNewVault}
          >
            {t('auth.retired.button')}
          </Button>
        </Section>
      ) : null}

      <Section title={t('auth.recoveryKey.title')}>
        {newRecoveryKey ? (
          <>
            <Notice tone="warn">
              <Trans k="auth.recoveryKey.onceWarning" components={{ b: <strong /> }} />
            </Notice>
            <RecoveryKeyText value={newRecoveryKey} />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => copyToClipboard(newRecoveryKey, t('auth.recoveryKey.clipboardName'))}
              >
                {t('auth.recoveryKey.copy')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => downloadRecoveryKey(newRecoveryKey, store.me?.user_id)}
              >
                {t('auth.recoveryKey.download')}
              </Button>
            </div>
            <Button
              variant="primary"
              className="self-start"
              loading={busy}
              onClick={finishAccountRecovery}
            >
              {t('auth.recoveryKey.saved')}
            </Button>
          </>
        ) : replacing ? (
          <>
            <Explain>{t('auth.recoveryKey.replaceExplain')}</Explain>
            <PasswordInput
              label={t('auth.recoveryKey.passwordLabel')}
              value={currentPassword}
              autoComplete="current-password"
              disabled={busy}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || !currentPassword}
                loading={busy}
                onClick={enrollAccountRecovery}
              >
                {t('auth.recoveryKey.makeNew')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => { setReplacing(false); setCurrentPassword(''); }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : copyMissing && canEnroll ? (
          <>
            <Explain>{t('auth.recoveryKey.missingExplain')}</Explain>
            <TextInput
              label={t('auth.recoveryKey.fieldLabel')}
              type="password"
              value={recoveryKey}
              autoComplete="off"
              placeholder={t('auth.recoveryKey.placeholder')}
              onChange={(e) => setRecoveryKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) restoreRecoveryCopy();
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={busy || !recoveryKey.trim()}
                loading={busy}
                onClick={restoreRecoveryCopy}
              >
                {t('auth.recoveryKey.restoreButton')}
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={confirmReplace}
              >
                {t('auth.recoveryKey.replaceButton')}
              </Button>
            </div>
          </>
        ) : hasKey ? (
          <>
            <Explain>{t('auth.recoveryKey.haveExplain')}</Explain>
            <Button
              variant="secondary"
              className="self-start"
              disabled={busy || !canEnroll}
              onClick={confirmReplace}
            >
              {t('auth.recoveryKey.replaceButton')}
            </Button>
          </>
        ) : canEnroll ? (
          <>
            <Explain>{t('auth.recoveryKey.noneExplain')}</Explain>
            <PasswordInput
              label={t('auth.recoveryKey.passwordLabel')}
              value={currentPassword}
              autoComplete="current-password"
              disabled={busy}
              hint={t('auth.recoveryKey.passwordHint')}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <Button
              variant="primary"
              className="self-start"
              disabled={busy || !currentPassword}
              loading={busy}
              onClick={enrollAccountRecovery}
            >
              {t('auth.recoveryKey.makeButton')}
            </Button>
          </>
        ) : (
          <Explain>
            {locked
              ? t('auth.recoveryKey.lockedFirst')
              : t('auth.recoveryKey.unsupported')}
          </Explain>
        )}
      </Section>

      {/* Only for a device that does not hold the account key: one that does has nothing to replace. */}
      {trust && recoveryEnrolled && !trust.canSign ? (
        <Section title={t('auth.identityKey.title')}>
          {trust.continuity?.reason === 'immutable-id-changed' ? (
            <Explain>{t('auth.identityKey.resetElsewhere')}</Explain>
          ) : (
            <>
              <Explain>{t('auth.identityKey.lostExplain')}</Explain>
              <TextInput
                label={t('auth.recoveryKey.fieldLabel')}
                type="password"
                value={identityRecoveryKey}
                autoComplete="off"
                placeholder={t('auth.recoveryKey.placeholder')}
                onChange={(e) => setIdentityRecoveryKey(e.target.value)}
              />
              <Button
                variant="secondary"
                className="self-start"
                disabled={busy || !identityRecoveryKey.trim()}
                loading={busy}
                onClick={askReplaceIdentity}
              >
                {t('auth.identityKey.replaceButton')}
              </Button>
            </>
          )}
        </Section>
      ) : null}

      <Section title={t('auth.backup.title')}>
        <Explain>
          {backup?.items
            ? t('auth.backup.explain', { at: backup.updated_at })
            : t('auth.backup.empty')}
        </Explain>
        {backup?.items ? (
          <Button
            variant="danger-soft"
            className="self-start"
            disabled={busy}
            onClick={dropMirror}
          >
            {t('auth.backup.delete')}
          </Button>
        ) : null}
      </Section>

      <Section>
        <Advanced>
          <Detail name={t('auth.advanced.modeName')}>
            {MODE_NAME_KEY[mode]
              ? t('auth.custody.line', {
                name: t(MODE_NAME_KEY[mode]),
                note: t(MODE_NOTE_KEY[mode]),
              })
              : t('auth.custody.unknown')}
          </Detail>

          {backup?.items ? (
            <Detail name={t('auth.backup.detailName')}>
              {t('auth.backup.detail', { count: backup.items })}
            </Detail>
          ) : null}

          {trust?.immutableId ? (
            <Detail name={t('auth.advanced.identityName')}>
              <span className="font-mono">{trust.immutableId}</span>
              {trust.continuity?.sequence !== undefined
                ? t('auth.advanced.rootSequence', { sequence: String(trust.continuity.sequence) })
                : null}
            </Detail>
          ) : null}

          {trust?.identityMismatch ? (
            <Notice tone="danger">{t('auth.advanced.identityMismatch')}</Notice>
          ) : null}

          {trust?.continuity?.valid && trust?.immutableId ? (
            <div className="ekey-more__group">
              <Detail name={t('auth.guardians.name')}>
                {recoveryPolicy
                  ? t('auth.guardians.set', { version: policyVersion })
                  : t('auth.guardians.unset')}
              </Detail>
              {[0, 1, 2].map((index) => (
                <TextInput
                  key={index}
                  label={t('auth.guardians.person', { index: index + 1 })}
                  value={guardianIds[index]}
                  placeholder={t('auth.guardians.placeholder')}
                  disabled={busy}
                  onChange={(e) => {
                    const next = [...guardianIds];
                    next[index] = e.target.value.trim();
                    setGuardianIds(next);
                  }}
                />
              ))}
              {guardianFault ? (
                <Hint className="text-danger">{guardianFault}</Hint>
              ) : (
                <Hint>
                  {verifiedFriends.length
                    ? t('auth.guardians.verifiedList', {
                      people: list(verifiedFriends.map((f) => f.user_id)),
                    })
                    : t('auth.guardians.verifyFirst')}
                </Hint>
              )}
              <Button
                variant="secondary"
                className="self-start"
                disabled={busy || Boolean(guardianFault)}
                onClick={saveGuardians}
              >
                {recoveryPolicy ? t('auth.guardians.replace') : t('auth.guardians.save')}
              </Button>
            </div>
          ) : trust?.continuity?.supported === false ? (
            <Detail name={t('auth.guardians.unsupportedName')}>
              {t('auth.guardians.unsupported')}
            </Detail>
          ) : null}
        </Advanced>
      </Section>
    </>
  );
}
