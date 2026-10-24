import { useEffect, useState } from 'react';
import { Api, discover } from '../lib/api.js';
import { shortName } from '../lib/util.js';
import { displayHomeserver, normalizeHomeserver, prettyHost } from '../lib/homeserver.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { PENDING_RECOVERY_STORAGE_KEY } from '../lib/account-recovery.js';
import { useStore } from '../hooks/useStore.jsx';
import { useModal } from '../hooks/useModal.jsx';
import {
  Avatar, Button, EmojiText, Hint, Notice, PasswordInput, TextInput,
} from '../components/index.js';
import { AccountHomePicker } from './AccountHomePicker.jsx';
import { AccountAddress, HomeChip, useAlternativeHomesOffered } from './AccountHome.jsx';
import { downloadRecoveryKey, recoveryKeyNote } from './user-settings/RecoveryParts.jsx';
import { ScreeningDialog } from './dialogs/ScreeningDialog.jsx';
import { Trans, useT } from '../lib/i18n/react.jsx';
import { codeOf, errorMessage } from '../lib/i18n/errors.js';

function inviteBase() {
  return window.location.origin;
}

function normalApiBase(value) {
  const trimmed = String(value || '').trim().replace(/\/$/, '');
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function homeRefusal(t, key, values) {
  const error = new Error(t(key, values));
  error.homeRefusal = true;
  return error;
}

async function resolveHomeServer(raw, { registering, t }) {
  const typed = String(raw || '').trim();
  if (!typed) throw homeRefusal(t, 'onboarding.invite.needHome');

  if (/^https?:\/\//i.test(typed)) {
    const directBase = normalApiBase(typed);
    try {
      const directCaps = await new Api({
        base: directBase,
        domain: prettyHost(typed),
      }).capabilities();
      const name = directCaps.server_name || prettyHost(typed);
      if (!directCaps.roles?.identity) throw homeRefusal(t, 'onboarding.invite.noIdentityRole', { name });
      if (registering && !directCaps.registration_open) {
        throw homeRefusal(t, 'onboarding.invite.registrationClosed', { name });
      }
      return { api: directBase, server_name: name, caps: directCaps };
    } catch (error) {
      if (error?.homeRefusal) throw error;
    }
  }

  const value = normalizeHomeserver(raw) || typed;
  const doc = await discover(value);
  const apiBase = normalApiBase(doc.api || value);
  const api = new Api({ base: apiBase, domain: doc.server_name || prettyHost(value) });
  const caps = await api.capabilities();
  const name = doc.server_name || prettyHost(value);
  if (!caps.roles?.identity) {
    throw homeRefusal(t, 'onboarding.invite.noIdentityRole', { name });
  }
  if (registering && !caps.registration_open) {
    throw homeRefusal(t, 'onboarding.invite.registrationClosed', { name });
  }
  return { ...doc, api: apiBase, caps };
}

export function InviteLanding({
  code,
  onEntered,
  base: inviteOrigin = inviteBase(),
  onBack,
  loadHomeRecommendations,
  homeRandom,
}) {
  const t = useT();
  const store = useStore();
  const modal = useModal();
  const [state, setState] = useState({ status: 'loading' });
  const [mode, setMode] = useState(store.signedIn ? 'join' : 'register');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [legacyAuth, setLegacyAuth] = useState(null);
  const [legacyApproved, setLegacyApproved] = useState(false);
  const [initialHome] = useState(
    () => sessionStorage.getItem('telium.lastHome') || inviteOrigin,
  );
  const [customHome, setCustomHome] = useState(initialHome);
  const [changingHome, setChangingHome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const fail = (text) => setNotice({ tone: 'danger', text });
  const warn = (text) => setNotice({ tone: 'warn', text });
  const clearNotice = () => setNotice(null);
  const [recoveryKey, setRecoveryKey] = useState(
    () => sessionStorage.getItem(PENDING_RECOVERY_STORAGE_KEY) || '',
  );
  const [createdAddress, setCreatedAddress] = useState(
    () => (recoveryKey ? store.session?.user_id || '' : ''),
  );
  const [sessionReady, setSessionReady] = useState(Boolean(store.signedIn && store.home));
  const offerAlternatives = useAlternativeHomesOffered(initialHome);

  useEffect(() => {
    let live = true;
    const base = inviteOrigin;
    const originHost = (() => {
      try { return new URL(base).host; } catch { return window.location.host; }
    })();
    const api = new Api({ base, domain: originHost });
    const load = async () => {
      try {
        const value = await api.invitePreview(code);
        if (!live) return;
        const preview = {
          ...value,
          kind: 'invite',
          code,
          base,
          domain: value.guild?.host || originHost,
        };
        setState({ status: 'ready', preview });
      } catch (previewError) {
        if (!live) return;
        if (previewError?.status !== 404) {
          setState({ status: 'error', error: previewError });
          return;
        }
        try {
          const value = await store.previewGuildJoin(`#${code}:${originHost}`);
          if (!live) return;
          if (!value) {
            setState({ status: 'error', error: previewError });
            return;
          }
          setState({ status: 'ready', preview: { ...value, code, kind: 'address' } });
        } catch (vanityError) {
          if (!live) return;
          setState({ status: 'error', error: vanityError });
        }
      }
    };
    load();
    return () => { live = false; };
  }, [code, inviteOrigin, store]);

  const preview = state.preview;

  const join = async () => {
    if (!preview || busy) return false;
    setBusy(true);
    clearNotice();
    try {
      if (!store.home) await store.start();
      setSessionReady(true);

      let domain = preview.domain;
      if (!store.session?.servers?.[domain]) {
        domain = await store.addServer(domain, { base: preview.base });
      }
      const api = store.apiFor(domain);
      const resp = preview.kind === 'address'
        ? await api.joinGuild(preview.guild?.id || preview.resolved?.guild_id)
        : await api.joinInvite(code);
      if (resp.pending) {
        setSessionReady(true);
        setMode('join');
        modal.open((close) => <ScreeningDialog domain={domain} resp={resp} close={close} />);
        warn(t('onboarding.invite.screeningPending'));
        return false;
      }

      store.connectServer(domain, store.session.servers[domain]);
      onEntered?.();
      store.navigate({
        view: 'chat',
        guildId: preview.guild?.id || null,
        channelId: preview.channel_id || null,
      });
      return true;
    } catch (e) {
      fail(errorMessage(e, { fallbackKey: 'onboarding.invite.joinFailed' }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event, allowLegacyAuth = legacyApproved) => {
    event?.preventDefault();
    if (busy || state.status !== 'ready') return;
    if (sessionReady || (store.signedIn && store.home)) {
      await join();
      return;
    }

    const registering = mode === 'register';
    if (registering && !displayName.trim()) {
      fail(t('onboarding.invite.needDisplayName'));
      return;
    }
    if (!username.trim() || !password) {
      fail(t('onboarding.invite.needCredentials'));
      return;
    }

    setBusy(true);
    clearNotice();
    try {
      const home = await resolveHomeServer(customHome, { registering, t });

      sessionStorage.setItem('telium.lastHome', home.api);
      const auth = await store.signIn(home.api, username.trim(), password, {
        register: registering,
        mfaCode: requiresMfa ? mfaCode.trim() : null,
        allowLegacyAuth,
      });
      if (registering && auth.recovery_key) {
        setRecoveryKey(auth.recovery_key);
        setCreatedAddress(auth.user_id || '');
        setBusy(false);
        return;
      }
      await store.start();
      setSessionReady(true);

      if (registering && displayName.trim()) {
        await store.home.patchProfile({ display_name: displayName.trim() });
      }

      setMode('join');
      setBusy(false);
      await join();
    } catch (e) {
      const code = codeOf(e);
      if (code === 'legacy_auth_required') {
        setLegacyAuth(e.legacyKind || 'server');
        setLegacyApproved(false);
        clearNotice();
      } else if (code === 'opaque_downgrade') {
        setLegacyAuth(null);
        setLegacyApproved(false);
        fail(errorMessage(e));
      } else if (!registering && code === 'mfa_required') {
        setRequiresMfa(true);
        warn(t('onboarding.invite.mfaPrompt'));
      } else if (!registering && code === 'invalid_mfa_code') {
        setRequiresMfa(true);
        fail(errorMessage(e));
      } else if (e?.homeRefusal) {
        fail(e.message);
      } else {
        fail(errorMessage(e, {
          fallbackKey: registering
            ? 'onboarding.invite.createFailed'
            : 'onboarding.invite.signInFailed',
        }));
      }
      setBusy(false);
    }
  };

  const finishRecoveryKey = async () => {
    setBusy(true);
    clearNotice();
    try {
      await store.confirmRecoveryKey(recoveryKey);
      setRecoveryKey('');
      await store.start();
      setSessionReady(true);

      if (displayName.trim()) {
        await store.home.patchProfile({ display_name: displayName.trim() });
      }

      setMode('join');
      setBusy(false);
      await join();
    } catch (e) {
      fail(errorMessage(e, { fallbackKey: 'onboarding.invite.setupFailed' }));
      setBusy(false);
    }
  };

  if (recoveryKey) {
    return (
      <InviteFrame>
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t('onboarding.recoveryKey.title')}</h1>
            <p className="mt-2 text-sm leading-[1.6] text-muted">
              {t('onboarding.recoveryKey.body')}
            </p>
          </div>
          <AccountAddress userId={createdAddress} />
          <Notice tone="warn">
            <Trans k="onboarding.recoveryKey.warning" components={{ b: <strong /> }} />
          </Notice>
          <div className="rounded-lg border border-border bg-field-background p-3">
            <code className="block select-all break-all font-mono text-xs leading-5">
              {recoveryKey}
            </code>
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => copyToClipboard(
              recoveryKeyNote(recoveryKey, createdAddress),
              t('onboarding.recoveryKey.clipboardLabel'),
            )}
          >
            {t('onboarding.recoveryKey.copy')}
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => downloadRecoveryKey(recoveryKey, createdAddress)}
          >
            {t('onboarding.recoveryKey.download')}
          </Button>
          {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
          <Button variant="primary" disabled={busy} onClick={finishRecoveryKey}>
            {busy ? t('onboarding.recoveryKey.finishing') : t('onboarding.recoveryKey.confirm')}
          </Button>
        </div>
      </InviteFrame>
    );
  }

  if (state.status === 'loading') {
    return (
      <InviteFrame>
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <img src="/brand/telium-mark-gradient.svg" alt="" className="size-10" />
          <div className="text-base font-medium">{t('onboarding.invite.opening')}</div>
          <Hint>{t('onboarding.invite.openingHint')}</Hint>
        </div>
      </InviteFrame>
    );
  }

  if (state.status === 'error') {
    const expired = state.error?.status === 404;
    return (
      <InviteFrame>
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <img src="/brand/telium-mark-gradient.svg" alt="" className="size-10" />
          <h1 className="text-2xl font-semibold tracking-tight">
            {expired
              ? t('onboarding.invite.expiredTitle')
              : t('onboarding.invite.unopenableTitle')}
          </h1>
          <p className="max-w-[360px] text-sm leading-[1.6] text-muted">
            {expired
              ? t('onboarding.invite.expiredBody')
              : errorMessage(state.error, { fallbackKey: 'onboarding.invite.unreachable' })}
          </p>
          {onBack ? (
            <Button variant="secondary" onClick={onBack}>
              {t('onboarding.invite.backToSignIn')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => window.location.assign('/')}>
              {t('onboarding.invite.goToTelium')}
            </Button>
          )}
        </div>
      </InviteFrame>
    );
  }

  const guild = preview.guild || {};
  const members = guild.member_count ?? 0;
  const online = guild.online_count;
  const signedIn = sessionReady || store.signedIn;
  const joiningAs = store.me?.profile?.display_name
    || store.me?.user_id
    || store.session?.home?.user_id
    || '';

  return (
    <InviteFrame>
      <div className="flex flex-col items-center text-center">
        <Avatar
          id={guild.id}
          name={guild.name}
          size="xl"
          mediaRef={guild.icon_ref}
          base={preview.base}
          className="mb-4"
        />
        <p className="text-sm text-muted">
          {preview.inviter
            ? t('onboarding.invite.invitedBy', { name: shortName(preview.inviter) })
            : t('onboarding.invite.invited')}
        </p>
        <h1 className="mt-1 max-w-full truncate text-3xl font-semibold tracking-tight">
          <EmojiText>{guild.name}</EmojiText>
        </h1>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm text-muted">
          {online !== undefined && online !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-emerald-500" aria-hidden />
              {t('onboarding.invite.online', { count: online })}
            </span>
          ) : null}
          <span>{t('onboarding.invite.members', { count: members })}</span>
        </div>
      </div>

      {signedIn ? (
        <div className="mt-7 flex flex-col gap-3">
          <Notice>
            {joiningAs
              ? t('onboarding.invite.joiningAs', { name: joiningAs })
              : t('onboarding.invite.accountReady')}
          </Notice>
          {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
          <Button variant="primary" disabled={busy} onClick={join} className="h-auto min-h-9 py-1.5">
            {busy ? t('onboarding.invite.joining') : t('onboarding.invite.join', { guild: guild.name })}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setSessionReady(false);
              setMode('login');
              clearNotice();
              setRequiresMfa(false);
              setMfaCode('');
              setLegacyAuth(null);
              setLegacyApproved(false);
              store.signOut();
            }}
          >
            {t('onboarding.invite.useAnotherAccount')}
          </Button>
        </div>
      ) : (
        <>
          <div className="my-6 h-px bg-border" />

          <form onSubmit={submit} className="flex flex-col gap-3.5">
            {mode === 'register' ? (
              <TextInput
                label={t('onboarding.invite.displayNameLabel')}
                autoComplete="name"
                autoFocus
                value={displayName}
                placeholder={t('onboarding.invite.displayNamePlaceholder')}
                hint={t('onboarding.invite.displayNameHint')}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            ) : null}

            <TextInput
              label={mode === 'register' ? t('common.username') : t('onboarding.invite.accountIdLabel')}
              autoComplete="username"
              value={username}
              placeholder={mode === 'register'
                ? t('onboarding.invite.usernamePlaceholder')
                : t('onboarding.invite.accountIdPlaceholder')}
              hint={mode === 'register' ? t('onboarding.invite.usernameHint') : null}
              onChange={(e) => {
                setUsername(e.target.value);
                setLegacyAuth(null);
                setLegacyApproved(false);
              }}
            />

            <PasswordInput
              label={t('common.password')}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setLegacyAuth(null);
                setLegacyApproved(false);
              }}
            />

            {mode === 'login' && requiresMfa ? (
              <TextInput
                label={t('onboarding.invite.mfaLabel')}
                autoComplete="one-time-code"
                inputMode="numeric"
                value={mfaCode}
                placeholder={t('onboarding.invite.mfaPlaceholder')}
                onChange={(e) => setMfaCode(e.target.value)}
              />
            ) : null}

            {mode === 'register' && offerAlternatives ? (
              <AccountHomePicker
                value={customHome}
                disabled={busy}
                loadRecommendations={loadHomeRecommendations}
                random={homeRandom}
                onChange={(value) => {
                  setCustomHome(value);
                  setLegacyAuth(null);
                  setLegacyApproved(false);
                }}
              />
            ) : mode === 'register' && !changingHome ? (
              <div className="flex flex-col items-start gap-1.5">
                <HomeChip
                  host={prettyHost(customHome)}
                  onClick={busy ? null : () => {
                    setCustomHome(displayHomeserver(customHome));
                    setChangingHome(true);
                  }}
                />
                <Hint>{t('onboarding.invite.homeHint')}</Hint>
              </div>
            ) : (
              <TextInput
                label={t('onboarding.home.label')}
                value={customHome}
                placeholder={t('onboarding.invite.homePlaceholder')}
                hint={mode === 'register'
                  ? t('onboarding.invite.newHomeHint')
                  : t('onboarding.invite.existingHomeHint')}
                onChange={(e) => {
                  setCustomHome(e.target.value);
                  setLegacyAuth(null);
                  setLegacyApproved(false);
                }}
              />
            )}

            {legacyAuth ? (
              <Notice tone="warn">
                <Trans
                  k={legacyAuth === 'upgrade'
                    ? 'onboarding.invite.legacyUpgrade'
                    : 'onboarding.invite.legacyServer'}
                  components={{ b: <strong /> }}
                />
                <div className="mt-2">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setLegacyApproved(true);
                      submit(null, true);
                    }}
                  >
                    {legacyAuth === 'upgrade'
                      ? t('onboarding.invite.legacyUpgradeAction')
                      : (mode === 'register'
                        ? t('onboarding.invite.legacyRegisterAction')
                        : t('onboarding.invite.legacySignInAction'))}
                  </Button>
                </div>
              </Notice>
            ) : null}

            {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

            <Button
              type="submit"
              variant="primary"
              disabled={busy || !customHome.trim()}
              className="mt-1 h-auto min-h-9 w-full py-1.5"
            >
              {busy
                ? (mode === 'register'
                  ? t('onboarding.invite.creating')
                  : t('onboarding.invite.signingIn'))
                : (mode === 'register'
                  ? t('onboarding.invite.createAndJoin', { guild: guild.name })
                  : t('onboarding.invite.signInAndJoin', { guild: guild.name }))}
            </Button>
          </form>

          <div className="mt-4 text-center text-sm text-muted">
            <Trans
              k={mode === 'register'
                ? 'onboarding.invite.haveAccount'
                : 'onboarding.invite.needAccount'}
              components={{
                a: (
                  <button
                    type="button"
                    className="font-medium text-accent hover:underline"
                    onClick={() => {
                      setMode(mode === 'register' ? 'login' : 'register');
                      clearNotice();
                      setRequiresMfa(false);
                      setMfaCode('');
                      setLegacyAuth(null);
                      setLegacyApproved(false);
                    }}
                  />
                ),
              }}
            />
          </div>
        </>
      )}

      <p className="mt-6 text-center text-2xs leading-[1.55] text-muted">
        <Trans
          k="onboarding.invite.hostNote"
          values={{ domain: preview.domain }}
          components={{ b: <strong className="font-medium text-foreground" /> }}
        />
      </p>
      {onBack ? (
        <div className="mt-3 text-center">
          <button
            type="button"
            className="text-sm font-medium text-accent hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={onBack}
          >
            {t('onboarding.invite.backToSignIn')}
          </button>
        </div>
      ) : null}
    </InviteFrame>
  );
}

function InviteFrame({ children }) {
  return (
    <div className="flex h-full max-h-[100dvh] items-start justify-center overflow-y-auto bg-strip px-5 py-8 sm:py-12">
      <div className="my-auto w-full max-w-[470px]">
        <div className="mb-7 flex items-center justify-center gap-2 text-base font-semibold tracking-tight text-muted">
          <img src="/brand/telium-mark-gradient.svg" alt="" className="size-6" />
          Telium
        </div>
        <main className="rise-in rounded-2xl bg-surface p-6 sm:p-7">
          {children}
        </main>
      </div>
    </div>
  );
}
