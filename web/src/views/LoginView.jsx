import { useEffect, useRef, useState } from 'react';
import { useStore } from '../hooks/useStore.jsx';
import { toast } from '../hooks/useToast.jsx';
import { copyToClipboard } from '../lib/clipboard.js';
import { AuthCard } from '../App.jsx';
import {
  AddFriendIcon,
  Button,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  Crumb,
  Dots,
  Flow,
  FormStatus,
  KeyIcon,
  Notice,
  PasswordInput,
  ServerIcon,
  SpinnerIcon,
  TextInput,
  UserIcon,
  Way,
  isStagePlaceholder,
  nudge,
  useDialogs,
} from '../components/index.js';
import { discover, request } from '../lib/api.js';
import {
  findHome,
  forgetAccount,
  fullHandle,
  lookupAccount,
  parseAddress,
  recentAccounts,
  rememberAccount,
  searchCandidates,
  searchName,
  suggestedHomes,
} from '../lib/account-address.js';
import {
  chooseAccountHome,
  hasPinnedRecommendationKey,
  loadAccountHomeRecommendations,
  secureRandom,
} from '../lib/account-home-recommendations.js';
import { looksLikeRecoveryKey, normalizeRecoveryKey } from '../lib/account-recovery.js';
import { Trans, useT } from '../lib/i18n/react.jsx';
import { codeOf, errorMessage } from '../lib/i18n/errors.js';

import { displayHomeserver, normalizeHomeserver, prettyHost } from '../lib/homeserver.js';
import { isTauriRuntime } from '../lib/platform.js';
import { pendingHandoff } from '../lib/handoff.js';
import { AccountHomePicker, RecommendedHome } from './AccountHomePicker.jsx';
import { AccountAddress, HomeChip, useAlternativeHomesOffered } from './AccountHome.jsx';
import { downloadRecoveryKey, recoveryKeyNote } from './user-settings/RecoveryParts.jsx';
import { BackToAccount } from './login/BackToAccount.jsx';
import {
  DEPTH, DESKTOP_DOTS, DOTS, FLAGSHIP_HOME, PENDING_RECOVERY_KEY, RECOMMENDATION_WAIT_MS, accountId,
  knownServer, looksAddressable, rememberHome, settleWithin,
} from './login/helpers.js';

export function LoginView({
  onSignedIn,
  onInvite = null,
  loadHomeRecommendations = loadAccountHomeRecommendations,
  homeRandom = secureRandom,
}) {
  const store = useStore();
  const dialogs = useDialogs();
  const t = useT();
  const [mode, setMode] = useState('login');
  const [handoff] = useState(() => pendingHandoff());
  const [findFlow] = useState(() => !handoff);
  const [native] = useState(() => isTauriRuntime());
  const [initialHome] = useState(() => knownServer(handoff));
  const [server, setServer] = useState(initialHome);
  const [picked, setPicked] = useState(initialHome);
  const [serverExplicit, setServerExplicit] = useState(false);
  const [registerReturnHome, setRegisterReturnHome] = useState(null);
  const [serverInfo, setServerInfo] = useState(null);
  const [checking, setChecking] = useState(false);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [legacyAuth, setLegacyAuth] = useState(null);
  const [legacyApproved, setLegacyApproved] = useState(false);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [createdRecoveryKey, setCreatedRecoveryKey] = useState(
    () => sessionStorage.getItem(PENDING_RECOVERY_KEY) || '',
  );
  const [createdAddress, setCreatedAddress] = useState(
    () => (createdRecoveryKey ? store.session?.user_id || '' : ''),
  );
  const [recoveryKey, setRecoveryKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [resetMin, setResetMin] = useState(8);
  const [newPasswordConfirm, setNewPasswordConfirm] = useState('');
  const [step, setStep] = useState(() => {
    if (createdRecoveryKey) return 'key';
    return findFlow ? 'find' : 'start';
  });
  const first = findFlow ? 'find' : 'start';
  const [address, setAddress] = useState('');
  const [finding, setFinding] = useState(null);
  const [findError, setFindError] = useState(null);
  const [askServer, setAskServer] = useState(null);
  const [recent, setRecent] = useState(() => (findFlow ? recentAccounts() : []));
  const [searching, setSearching] = useState(null);
  const [found, setFound] = useState(null);
  const [rec, setRec] = useState({ phase: 'idle', servers: [], selected: null });
  const recLoad = useRef(null);
  const [movedTo, setMovedTo] = useState(null);
  const [passwordFrom, setPasswordFrom] = useState('identity');
  const [noAccount, setNoAccount] = useState(null);
  const [identityError, setIdentityError] = useState('');
  const lookedUp = useRef(new Set());
  const findSeq = useRef(0);
  const findLive = useRef(false);
  const identitySeq = useRef(0);
  const [recoverFrom, setRecoverFrom] = useState(first);
  const [probe, setProbe] = useState(null);
  const probed = useRef(new Map());
  const userRef = useRef(null);
  const addressRef = useRef(null);
  const serverRef = useRef(null);
  const passwordRef = useRef(null);
  const recoveryRef = useRef(null);
  const newPasswordRef = useRef(null);

  const registering = mode === 'register';
  const regNow = useRef({ registering, serverExplicit });
  regNow.current = { registering, serverExplicit };
  const offerAlternatives = useAlternativeHomesOffered(native ? null : initialHome);
  const passwordsMatch = !registering || password === passwordConfirm;
  const ready = Boolean(
    server.trim()
    && user.trim()
    && password
    && passwordsMatch
    && (!registering || passwordConfirm)
    && (!requiresMfa || mfaCode.trim()),
  );

  useEffect(() => {
    const target = {
      find: addressRef,
      server: serverRef,
      identity: userRef,
      password: passwordRef,
      recover: recoveryRef,
      reset: newPasswordRef,
    };
    const ref = target[step];
    if (!ref) return undefined;
    const timer = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const active = el.ownerDocument.activeElement;
      if (active
        && active !== el.ownerDocument.body
        && active !== el
        && !isStagePlaceholder(active)) return;
      el.focus({ preventScroll: true });
    }, 220);
    return () => clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    const domain = normalizeHomeserver(server);
    if (step !== 'server' || !domain || !looksAddressable(server)) {
      setProbe(null);
      return undefined;
    }
    const seen = probed.current.get(domain);
    if (seen) {
      setProbe({ domain, ...seen });
      return undefined;
    }
    let live = true;
    const timer = setTimeout(async () => {
      if (live) setProbe({ domain, state: 'checking' });
      let result;
      try {
        result = { state: 'ok', info: await discover(domain) };
      } catch {
        result = { state: 'bad' };
      }
      probed.current.set(domain, result);
      if (live) setProbe({ domain, ...result });
    }, 650);
    return () => { live = false; clearTimeout(timer); };
  }, [server, step]);

  const resetLegacy = () => {
    setLegacyAuth(null);
    setLegacyApproved(false);
  };

  const failed = (key, err) => toast(t(key, { detail: errorMessage(err) }), { error: true });

  const refuse = (ref) => {
    nudge(ref.current);
    ref.current?.focus({ preventScroll: true });
    ref.current?.select?.();
  };

  const resolveHome = async (home) => {
    if (serverInfo?.api) return { api: serverInfo.api, serverName: serverInfo.server_name || prettyHost(home) };
    const seen = probed.current.get(home)?.info;
    if (seen?.api) return { api: seen.api, serverName: seen.server_name || prettyHost(home) };
    try {
      const found = await findHome(home);
      const info = { server_name: found.serverName, api: found.api };
      probed.current.set(home, { state: 'ok', info });
      return found;
    } catch {
      return { api: home, serverName: prettyHost(home) };
    }
  };

  const missingAccount = async (api, serverName) => {
    const id = accountId(user.trim(), serverName);
    if (!id || lookedUp.current.has(`${api}|${id}`)) return null;
    lookedUp.current.add(`${api}|${id}`);
    const { status: found } = await lookupAccount(api, id);
    if (found !== 'unknown' && found !== 'gone') return null;
    return { user: id.slice(1).split(':')[0], host: serverName };
  };

  const run = async (allowLegacyAuth = legacyApproved) => {
    setBusy(true);
    setStatus('');
    setNoAccount(null);
    const home = normalizeHomeserver(server) || server.trim();
    const { api, serverName } = await resolveHome(home);
    try {
      rememberHome(home);
      const resp = await store.signIn(api, user.trim(), password, {
        home,
        register: registering,
        reactivate: mode === 'reactivate',
        mfaCode: requiresMfa ? mfaCode.trim() : null,
        allowLegacyAuth,
      });
      if (resp.device_secret) sessionStorage.setItem('telium.deviceSecretShown', '1');
      if (resp.user_id) {
        rememberAccount({ userId: resp.user_id, host: resp.server_name || serverName, base: api });
      }
      if (registering && resp.recovery_key) {
        setCreatedRecoveryKey(resp.recovery_key);
        setCreatedAddress(resp.user_id || accountId(user.trim(), serverName) || '');
        setStatus('');
        setBusy(false);
        setStep('key');
        return;
      }
      onSignedIn();
    } catch (err) {
      setBusy(false);
      const code = codeOf(err);
      if (code === 'legacy_auth_required') {
        setLegacyAuth(err.legacyKind || 'server');
        setStatus('');
        return;
      }
      if (code === 'opaque_downgrade') {
        setLegacyAuth(null);
        setStatus(errorMessage(err));
        return;
      }
      if (mode === 'login' && code === 'account_deactivated') {
        setMode('reactivate');
        setStatus(t('auth.password.deactivated'));
        return;
      }
      if (!registering && code === 'mfa_required') {
        setRequiresMfa(true);
        setStatus(t('auth.password.mfaPrompt'));
        return;
      }
      if (!registering && code === 'invalid_mfa_code') {
        setRequiresMfa(true);
        setStatus(errorMessage(err));
        return;
      }
      if (!registering && (err?.status === 401 || code === 'invalid_credentials')) {
        const missing = await missingAccount(api, serverName);
        if (missing) {
          setStatus('');
          setNoAccount(missing);
          return;
        }
      }
      setStatus('');
      refuse(passwordRef);
      failed(
        registering
          ? 'auth.password.registerFailed'
          : mode === 'reactivate'
            ? 'auth.password.reactivateFailed'
            : 'auth.password.signInFailed',
        err,
      );
    }
  };

  const pickServer = (domain = normalizeHomeserver(server) || server.trim(), info = null) => {
    setServerExplicit(true);
    setPicked(domain);
    setServer(domain);
    setServerInfo(info);
    rememberHome(domain);
    setStatus('');
    setStep(findFlow ? 'identity' : 'start');
  };

  const warnUnreachable = (domain) => dialogs.confirm({
    title: t('auth.server.unreachableTitle', { host: prettyHost(domain) }),
    body: (
      <p className="text-base leading-[1.6] text-muted">
        <Trans
          k="auth.server.unreachableBody"
          components={{
            a: (
              <a
                href="https://telium.chat/servers"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-link hover:underline"
              />
            ),
          }}
        />
      </p>
    ),
    confirmLabel: t('auth.server.useAnyway'),
    onConfirm: () => pickServer(domain),
  });

  const confirmServer = async (e) => {
    e?.preventDefault?.();
    const domain = normalizeHomeserver(server) || server.trim();
    if (!domain || checking) return;
    const seen = probed.current.get(domain);
    if (seen?.state === 'ok') { pickServer(domain, seen.info); return; }
    if (seen?.state === 'bad') { warnUnreachable(domain); return; }
    setChecking(true);
    try {
      pickServer(domain, await discover(domain));
    } catch {
      probed.current.set(domain, { state: 'bad' });
      setProbe({ domain, state: 'bad' });
      setServerInfo(null);
      warnUnreachable(domain);
    } finally {
      setChecking(false);
    }
  };

  const readHomeFrom = (value) => {
    const parsed = parseAddress(value);
    const home = parsed.kind === 'handle'
      ? parsed.host
      : /^@?[^@:\s]+:(\S*)$/.exec(value.trim())?.[1];
    const next = home ? (normalizeHomeserver(home) || home) : picked;
    if (next === server) return;
    setServer(next);
    setServerInfo(null);
  };

  const choose = (next) => {
    if (next === 'register' && !handoff && !serverExplicit && !registerReturnHome) {
      setRegisterReturnHome(server);
    } else if (next !== 'register' && registerReturnHome && !serverExplicit) {
      setServer(registerReturnHome);
      setPicked(registerReturnHome);
      setServerInfo(null);
      setRegisterReturnHome(null);
    }
    setMode(next);
    setRequiresMfa(false);
    setMfaCode('');
    setStatus('');
    resetLegacy();
    setStep('identity');
  };

  const submit = (e) => {
    e.preventDefault();
    if (!ready) return;
    run();
  };

  const confirmIdentity = async (e) => {
    e.preventDefault();
    const typed = user.trim();
    if (!typed || checking) return;
    setIdentityError('');
    const parsed = parseAddress(typed);
    if (parsed.kind === 'handle') {
      const token = ++identitySeq.current;
      setChecking(true);
      try {
        const found = await findHome(parsed.base || parsed.host);
        if (token !== identitySeq.current) return;
        const info = { server_name: found.serverName, api: found.api };
        probed.current.set(normalizeHomeserver(parsed.host) || parsed.host, { state: 'ok', info });
        setServerInfo(info);
        setUser(fullHandle(parsed.user, found.serverName));
      } catch {
        if (token === identitySeq.current) {
          setIdentityError(t('auth.find.unreachable', { host: parsed.host }));
        }
        return;
      } finally {
        if (token === identitySeq.current) setChecking(false);
      }
    }
    setStatus('');
    setNoAccount(null);
    setPasswordFrom('identity');
    setStep('password');
  };

  const settle = (found) => {
    const info = { server_name: found.serverName, api: found.api };
    probed.current.set(found.api, { state: 'ok', info });
    setServer(found.api);
    setPicked(found.api);
    setServerInfo(info);
  };

  const clearAttempt = () => {
    setPassword('');
    setPasswordConfirm('');
    setRequiresMfa(false);
    setMfaCode('');
    setStatus('');
    setNoAccount(null);
    resetLegacy();
  };

  const findAccount = async (e, text = address) => {
    e?.preventDefault?.();
    if (findLive.current) return;
    const parsed = parseAddress(text);
    setFindError(null);
    setAskServer(null);
    if (parsed.kind === 'empty') return;
    const refuseAddress = (error) => {
      setFindError(error);
      addressRef.current?.focus({ preventScroll: true });
    };
    if (parsed.kind === 'invalid') { refuseAddress({ kind: 'invalid' }); return; }
    setFound(null);
    if (parsed.kind === 'name') { searchFor(parsed.user); return; }
    const token = ++findSeq.current;
    const stale = () => token !== findSeq.current;
    findLive.current = true;
    let asking = parsed.host;
    setFinding(asking);
    try {
      let home = await findHome(parsed.base || parsed.host);
      if (stale()) return;
      if (parsed.kind === 'invite' && onInvite) {
        onInvite({ base: home.api, code: parsed.code });
        return;
      }
      clearAttempt();
      setMovedTo(null);
      if (parsed.kind !== 'handle') {
        settle(home);
        setUser('');
        setMode('login');
        setPasswordFrom('identity');
        setStep('identity');
        return;
      }
      let userId = fullHandle(parsed.user, home.serverName);
      let { status: found, movedTo: forward } = await lookupAccount(home.api, userId);
      if (stale()) return;
      let moved = null;
      if (found === 'moved') {
        const next = forward ? parseAddress(forward) : null;
        if (next?.kind === 'handle') {
          asking = next.host;
          setFinding(asking);
          home = await findHome(next.host);
          if (stale()) return;
          userId = fullHandle(next.user, home.serverName);
          ({ status: found } = await lookupAccount(home.api, userId));
          if (stale()) return;
          moved = home.serverName;
        }
        if (found === 'moved') found = null;
      }
      if (found === 'unknown' || found === 'gone') {
        refuseAddress({ kind: 'unknown', user: parsed.user, host: home.serverName, home });
        return;
      }
      if (found) lookedUp.current.add(`${home.api}|${userId}`);
      settle(home);
      setUser(userId);
      setMovedTo(moved);
      setMode(found === 'deactivated' ? 'reactivate' : 'login');
      if (found === 'deactivated') setStatus(t('auth.find.deactivated'));
      setPasswordFrom('find');
      setStep('password');
    } catch {
      if (!stale()) refuseAddress({ kind: 'unreachable', host: asking });
    } finally {
      if (!stale()) {
        findLive.current = false;
        setFinding(null);
      }
    }
  };

  const cancelFind = () => {
    if (!findLive.current) return;
    findSeq.current += 1;
    findLive.current = false;
    setFinding(null);
    setSearching(null);
  };

  const completeWith = (host) => {
    const full = `@${askServer}:${host}`;
    setAddress(full);
    findAccount(null, full);
  };

  const pickRecent = (account) => {
    const base = account.base || normalizeHomeserver(account.host) || account.host;
    cancelFind();
    clearAttempt();
    setMovedTo(null);
    setServer(base);
    setPicked(base);
    setServerInfo(account.base ? { server_name: account.host, api: account.base } : null);
    setUser(account.userId);
    setMode('login');
    setPasswordFrom('find');
    setStep('password');
  };

  const forgetRecent = (userId) => {
    forgetAccount(userId);
    setRecent(recentAccounts());
  };

  const verifiedHomes = () => {
    if (!hasPinnedRecommendationKey()) return Promise.resolve([]);
    if (!recLoad.current) {
      const attempt = settleWithin(
        Promise.resolve().then(() => loadHomeRecommendations()),
        RECOMMENDATION_WAIT_MS,
        null,
      ).then((result) => (Array.isArray(result?.servers) ? result.servers : []));
      recLoad.current = attempt;
      attempt.then((servers) => { if (!servers.length && recLoad.current === attempt) recLoad.current = null; });
    }
    return recLoad.current;
  };

  const applyRecommended = (choice) => {
    setServer(choice.api_origin);
    setPicked(choice.api_origin);
    setServerInfo({ server_name: choice.domain, api: choice.api_origin });
    resetLegacy();
  };

  const recommendHome = () => {
    if (rec.phase === 'ready') { applyRecommended(rec.selected); return; }
    if (rec.phase === 'loading') return;
    if (!hasPinnedRecommendationKey()) { setRec({ phase: 'none', servers: [], selected: null }); return; }
    setRec({ phase: 'loading', servers: [], selected: null });
    verifiedHomes().then((servers) => {
      const choice = servers.length ? chooseAccountHome(servers, homeRandom) : null;
      if (!choice) { setRec({ phase: 'none', servers: [], selected: null }); return; }
      setRec({ phase: 'ready', servers, selected: choice });
      if (regNow.current.registering && !regNow.current.serverExplicit) applyRecommended(choice);
    });
  };

  const searchFor = async (name) => {
    const token = ++findSeq.current;
    const stale = () => token !== findSeq.current;
    findLive.current = true;
    setSearching(name);
    try {
      const recommended = await verifiedHomes();
      if (stale()) return;
      const accounts = await searchName(name, searchCandidates({
        recent: recentAccounts(),
        recommended,
        here: native ? null : initialHome,
      }));
      if (stale()) return;
      if (accounts.length) setFound({ user: name, accounts });
      else setAskServer(name);
    } finally {
      if (!stale()) {
        findLive.current = false;
        setSearching(null);
      }
    }
  };

  const pickFound = (account) => {
    setFound(null);
    setAddress(account.userId);
    if (account.status === 'moved') { findAccount(null, account.userId); return; }
    cancelFind();
    clearAttempt();
    setMovedTo(null);
    lookedUp.current.add(`${account.api}|${account.userId}`);
    settle({ serverName: account.host, api: account.api });
    setUser(account.userId);
    setMode(account.status === 'deactivated' ? 'reactivate' : 'login');
    if (account.status === 'deactivated') setStatus(t('auth.find.deactivated'));
    setPasswordFrom('find');
    setStep('password');
  };

  const createAccount = (carry = null) => {
    const home = carry?.home ?? null;
    const base = home?.api || (native ? FLAGSHIP_HOME : initialHome);
    cancelFind();
    clearAttempt();
    setFindError(null);
    setAskServer(null);
    setServer(base);
    setPicked(base);
    setServerInfo(home ? { server_name: home.serverName, api: home.api } : null);
    setServerExplicit(Boolean(home));
    setRegisterReturnHome(null);
    setUser(carry?.user || '');
    setMode('register');
    setStep('identity');
    regNow.current = { registering: true, serverExplicit: Boolean(home) };
    if (!home && native) recommendHome();
  };

  const checkRecovery = async (e) => {
    e?.preventDefault?.();
    if (busy || !server.trim() || !user.trim() || !recoveryKey.trim()) return;
    try {
      normalizeRecoveryKey(recoveryKey);
    } catch {
      setStatus(looksLikeRecoveryKey(recoveryKey)
        ? t('auth.recover.malformed')
        : t('auth.recover.notAKey'));
      refuse(recoveryRef);
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const home = normalizeHomeserver(server) || server.trim();
      const info = serverInfo
        || probed.current.get(home)?.info
        || await discover(home);
      const caps = await request(info.api, 'GET', '/_telium/v1/capabilities');
      if (!caps?.auth?.opaque || !caps?.auth?.recovery_key_reset) {
        setStatus(t('auth.recover.unsupported'));
        return;
      }
      setResetMin(Number(caps?.registration_min_password_len) || 8);
      setStatus('');
      setStep('reset');
    } catch (err) {
      setStatus('');
      failed('auth.recover.reachFailed', err);
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (e) => {
    e?.preventDefault?.();
    if (!server.trim() || !user.trim() || !recoveryKey.trim() || !newPassword) return;
    if (newPassword !== newPasswordConfirm) {
      setStatus(t('auth.reset.mismatch'));
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const home = normalizeHomeserver(server) || server.trim();
      const { api } = await resolveHome(home);
      rememberHome(home);
      const resp = await store.resetPassword(
        api,
        user.trim(),
        recoveryKey.trim(),
        newPassword,
        { home },
      );
      if (resp.device_secret) sessionStorage.setItem('telium.deviceSecretShown', '1');
      setStatus('');
      onSignedIn();
    } catch (err) {
      setBusy(false);
      if (codeOf(err) === 'invalid_recovery_proof') {
        setStatus(t('auth.recover.rejected'));
        setStep('recover');
        return;
      }
      setStatus('');
      refuse(newPasswordRef);
      failed('auth.reset.failed', err);
    }
  };

  const finishRecoveryKey = async () => {
    setBusy(true);
    try {
      await store.confirmRecoveryKey(createdRecoveryKey);
      sessionStorage.removeItem(PENDING_RECOVERY_KEY);
      setCreatedRecoveryKey('');
      onSignedIn();
    } catch (err) {
      failed('auth.key.acceptFailed', err);
      setBusy(false);
    }
  };

  const legacyCopy = legacyAuth === 'upgrade'
    ? {
      title: t('auth.legacy.upgrade.title'),
      body: t('auth.legacy.upgrade.body'),
      action: t('auth.legacy.upgrade.action'),
    }
    : legacyAuth === 'register'
      ? {
        title: t('auth.legacy.register.title'),
        body: t('auth.legacy.register.body'),
        action: t('auth.legacy.register.action'),
      }
      : {
        title: t('auth.legacy.server.title'),
        body: t('auth.legacy.server.body'),
        action: mode === 'reactivate'
          ? t('auth.legacy.server.actionReactivate')
          : t('auth.legacy.server.action'),
      };

  const host = serverInfo?.server_name || prettyHost(server);

  const toStart = () => {
    setStatus('');
    resetLegacy();
    setIdentityError('');
    setStep(first);
  };
  const toFind = () => {
    clearAttempt();
    setMovedTo(null);
    if (user.trim()) setAddress(user.trim());
    setMode('login');
    setStep('find');
  };
  const toIdentity = () => {
    setNoAccount(null);
    setStatus('');
    resetLegacy();
    setRequiresMfa(false);
    setMfaCode('');
    setPassword('');
    setPasswordConfirm('');
    setStep('identity');
  };

  const toRecover = () => {
    setStatus('');
    setNewPassword('');
    setNewPasswordConfirm('');
    setStep('recover');
  };

  const startCrumb = findFlow
    ? { label: t('auth.crumb.address'), to: toStart }
    : { label: t('auth.crumb.welcome'), to: toStart };
  const backFromPassword = passwordFrom === 'find' ? toFind : toIdentity;

  const crumb = step === 'server' && findFlow
    ? {
      label: t('auth.crumb.username'),
      to: () => {
        setStatus('');
        if (!serverExplicit) {
          if (rec.phase === 'ready') applyRecommended(rec.selected);
          else { setServer(picked); setServerInfo(null); }
        }
        setStep('identity');
      },
    }
    : step === 'server' || step === 'identity'
    ? startCrumb
    : step === 'password'
      ? { label: user.trim() || t('auth.crumb.username'), to: backFromPassword }
      : step === 'reset'
        ? { label: t('auth.crumb.recoveryKey'), to: toRecover }
        : step === 'recover'
          ? recoverFrom === 'password'
            ? { label: t('auth.crumb.password'), to: () => { setStatus(''); setStep('password'); } }
            : startCrumb
          : null;

  const escapeTo = native && findFlow && !busy && !checking ? crumb?.to : null;
  useEffect(() => {
    if (!escapeTo) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      escapeTo();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [escapeTo]);

  const fresh = probe?.domain === normalizeHomeserver(server) ? probe.state : null;
  const verdict = fresh ?? (looksAddressable(server) ? 'checking' : null);
  const MARK = {
    checking: <SpinnerIcon className="size-3.5 animate-spin text-muted" aria-label={t('auth.server.probeChecking')} />,
    ok: <CheckIcon className="size-3.5 text-success" aria-label={t('auth.server.probeFound')} />,
    bad: <CloseIcon className="size-3.5 text-warning" aria-label={t('auth.server.probeUnreachable')} />,
  };
  const probeMark = <span className="auth-probe" aria-live="polite">{MARK[verdict] ?? null}</span>;

  let title = null;
  let sub = null;
  let body = null;

  switch (step) {
    case 'server':
      title = t('auth.server.title');
      sub = t('auth.server.sub');
      body = (
        <form onSubmit={confirmServer} className="flex flex-col gap-3.5">
          <TextInput
            inputRef={serverRef}
            label={t('auth.server.label')}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            value={server}
            placeholder={t('auth.server.placeholder')}
            endContent={probeMark}
            onChange={(e) => {
              setServer(e.target.value);
              setServerInfo(null);
              setStatus('');
              resetLegacy();
            }}
          />
          <p className="-mt-1 text-xs text-muted">
            <Trans
              k="auth.server.noServer"
              components={{
                a: (
                  <a
                    href="https://telium.chat/servers"
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-link hover:underline"
                  />
                ),
              }}
            />
          </p>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={checking}
            isDisabled={!server.trim()}
            className="mt-1 w-full"
          >
            {t('auth.server.use')}
          </Button>
        </form>
      );
      break;

    case 'find': {
      let below = null;
      if (searching) {
        below = (
          <p className="text-xs text-muted" aria-live="polite">
            {t('auth.find.searching', { user: searching })}
          </p>
        );
      } else if (finding) {
        below = (
          <p className="text-xs text-muted" aria-live="polite">
            {t('auth.find.lookingUp', { host: finding })}
          </p>
        );
      } else if (findError?.kind === 'unknown') {
        below = (
          <FormStatus tone="danger">
            <Trans
              k="auth.find.noAccount"
              values={{ user: findError.user, host: findError.host }}
              components={{
                create: (
                  <button
                    type="button"
                    className="font-medium text-link hover:underline"
                    onClick={() => createAccount({ user: findError.user, home: findError.home })}
                  />
                ),
              }}
            />
          </FormStatus>
        );
      } else if (findError?.kind === 'unreachable') {
        below = <FormStatus tone="danger">{t('auth.find.unreachable', { host: findError.host })}</FormStatus>;
      } else if (findError?.kind === 'invalid') {
        below = <FormStatus tone="danger">{t('auth.find.invalid')}</FormStatus>;
      } else if (found) {
        below = (
          <div className="auth-ask" aria-live="polite">
            <ul className="auth-recent" aria-label={t('auth.find.foundLabel', { user: found.user })}>
              {found.accounts.map((account) => (
                <li key={account.userId} className="auth-recent-row">
                  <button
                    type="button"
                    className="way auth-recent-pick"
                    onClick={() => pickFound(account)}
                  >
                    <span className="way-icon"><UserIcon className="size-4" /></span>
                    <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                      {t('auth.find.found', { user: found.user, host: account.host })}
                    </span>
                    <ChevronRightIcon className="way-caret size-3.5 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="self-start rounded text-xs font-medium text-link hover:underline"
              onClick={() => { const name = found.user; setFound(null); setAskServer(name); }}
            >
              {t('auth.find.elsewhere')}
            </button>
          </div>
        );
      } else if (askServer) {
        below = (
          <div className="auth-ask" aria-live="polite">
            <p className="text-sm font-medium">{t('auth.find.whichServer', { user: askServer })}</p>
            <div className="flex flex-wrap gap-2">
              {suggestedHomes().map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="auth-suggest"
                  onClick={() => completeWith(suggestion)}
                >
                  <ServerIcon className="size-3.5 shrink-0 text-muted" />
                  <span className="truncate">{suggestion}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">{t('auth.find.afterColon', { user: askServer })}</p>
          </div>
        );
      }

      title = t('auth.find.title');
      body = (
        <div className="flex flex-col gap-5">
          {recent.length ? (
            <ul className="auth-recent" aria-label={t('auth.find.recentLabel')}>
              {recent.map((account) => (
                <li key={account.userId} className="auth-recent-row">
                  <button
                    type="button"
                    className="way auth-recent-pick"
                    disabled={Boolean(finding || searching)}
                    onClick={() => pickRecent(account)}
                  >
                    <span className="way-icon"><UserIcon className="size-4" /></span>
                    <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">
                      {account.userId}
                    </span>
                    <ChevronRightIcon className="way-caret size-3.5 text-muted" />
                  </button>
                  <button
                    type="button"
                    className="auth-recent-forget"
                    aria-label={t('auth.find.forget', { user: account.userId })}
                    onClick={() => forgetRecent(account.userId)}
                  >
                    <CloseIcon className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <form onSubmit={findAccount} className="auth-find flex flex-col gap-3" noValidate>
            <TextInput
              inputRef={addressRef}
              label={t('auth.find.label')}
              size="lg"
              value={address}
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              placeholder={t('auth.find.placeholder')}
              hint={t('auth.find.hint')}
              onChange={(e) => {
                setAddress(e.target.value);
                setFindError(null);
                setAskServer(null);
                setFound(null);
                cancelFind();
              }}
            />
            {below}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              isDisabled={!address.trim() || Boolean(finding || searching)}
              className="mt-1 w-full"
            >
              {finding || searching ? t('auth.find.busy') : t('common.continue')}
            </Button>
          </form>
          <div className="auth-new">
            <p className="text-sm font-medium">{t('auth.find.newTitle')}</p>
            <Button variant="secondary" size="lg" className="w-full" onClick={() => createAccount()}>
              {t('auth.find.create')}
            </Button>
          </div>
          <p className="text-center text-xs text-muted">
            <Trans
              k="auth.start.lostPassword"
              components={{
                recover: (
                  <button
                    type="button"
                    className="rounded font-medium text-link hover:underline"
                    onClick={() => {
                      cancelFind();
                      setMode('login');
                      setStatus('');
                      const typed = parseAddress(address);
                      if (typed.kind === 'handle') {
                        setUser(address.trim());
                        readHomeFrom(address.trim());
                      }
                      setRecoverFrom('find');
                      setStep('recover');
                    }}
                  />
                ),
              }}
            />
          </p>
        </div>
      );
      break;
    }

    case 'start':
      title = t('auth.start.title');
      body = (
        <div className="flex flex-col gap-2">
          <HomeChip
            host={host}
            onClick={() => {
              setStatus('');
              setServer(displayHomeserver(server));
              setStep('server');
            }}
          />
          <Way icon={KeyIcon} name={t('auth.start.signIn')} onClick={() => choose('login')} />
          <Way
            icon={AddFriendIcon}
            tone="accent"
            name={t('auth.start.register')}
            onClick={() => choose('register')}
          />
          <p className="pt-1 text-center text-xs text-muted">
            <Trans
              k="auth.start.lostPassword"
              components={{
                recover: (
                  <button
                    type="button"
                    className="rounded font-medium text-link hover:underline"
                    onClick={() => {
                      setMode('login');
                      setStatus('');
                      setRecoverFrom('start');
                      setStep('recover');
                    }}
                  />
                ),
              }}
            />
          </p>
        </div>
      );
      break;

    case 'identity':
      title = registering ? t('auth.identity.titleRegister') : t('auth.identity.titleLogin');
      sub = null;
      body = (
        <form onSubmit={confirmIdentity} className="flex flex-col gap-3.5">
          {registering && !handoff && !serverExplicit && offerAlternatives ? (
            <AccountHomePicker
              value={server}
              disabled={busy}
              loadRecommendations={loadHomeRecommendations}
              random={homeRandom}
              restoreOnUnmount={false}
              onSelect={(choice) => {
                setServerInfo(choice
                  ? { server_name: choice.domain, api: choice.api_origin }
                  : null);
              }}
              onChange={(next) => {
                setServer(next);
                setPicked(next);
                if (!next) setServerInfo(null);
                resetLegacy();
              }}
            />
          ) : findFlow && registering && !serverExplicit && rec.phase === 'ready' ? (
            <RecommendedHome
              selected={rec.selected}
              servers={rec.servers}
              disabled={busy || checking}
              onChoose={(choice) => {
                setRec((prev) => ({ ...prev, selected: choice }));
                applyRecommended(choice);
              }}
              onElsewhere={() => {
                setStatus('');
                setServer('');
                setServerInfo(null);
                setStep('server');
              }}
              elsewhereLabel={t('onboarding.home.useAnother')}
            />
          ) : findFlow && registering && !serverExplicit && rec.phase === 'loading' ? (
            <p className="text-xs text-muted" aria-live="polite">{t('onboarding.home.finding')}</p>
          ) : findFlow && registering ? (
            <div className="auth-home-note">
              <HomeChip host={host} />
              <p className="text-xs leading-[1.6] text-muted">{t('auth.find.homeExplainer')}</p>
              <button
                type="button"
                className="self-start rounded text-sm font-medium text-link hover:underline"
                onClick={() => {
                  setStatus('');
                  setServer(displayHomeserver(server));
                  setStep('server');
                }}
              >
                {t('auth.find.changeHome')}
              </button>
            </div>
          ) : (
            <HomeChip host={host} />
          )}
          <TextInput
            inputRef={userRef}
            label={t('common.username')}
            value={user}
            autoComplete="username"
            autoCapitalize={registering ? 'words' : 'none'}
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            placeholder={registering
              ? t('auth.identity.placeholderNew')
              : t('auth.identity.placeholder', { host })}
            onChange={(e) => {
              setUser(e.target.value);
              setIdentityError('');
              if (checking) { identitySeq.current += 1; setChecking(false); }
              resetLegacy();
              readHomeFrom(e.target.value);
            }}
          />
          {identityError ? <FormStatus tone="danger">{identityError}</FormStatus> : null}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={checking}
            isDisabled={!user.trim() || (findFlow && registering && !serverExplicit && rec.phase === 'loading')}
            className="mt-1 w-full"
          >
            {t('common.continue')}
          </Button>
        </form>
      );
      break;

    case 'password':
      title = registering
        ? t('auth.password.titleRegister')
        : mode === 'reactivate'
          ? t('auth.password.titleReactivate')
          : t('auth.password.titleLogin');
      sub = registering
        ? null
        : (
          <Trans
            k="auth.password.signingInAs"
            values={{ user: user.trim() }}
            components={{ b: <b className="font-medium text-foreground" /> }}
          />
        );
      body = (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <input
            className="pointer-events-none absolute size-0 opacity-0"
            type="text"
            autoComplete="username"
            value={user}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
          {movedTo ? (
            <Notice>{t('auth.find.moved', { host: movedTo })}</Notice>
          ) : null}
          <PasswordInput
            inputRef={passwordRef}
            label={t('common.password')}
            value={password}
            autoComplete={registering ? 'new-password' : 'current-password'}
            enterKeyHint={registering ? 'next' : 'go'}
            onChange={(e) => { setPassword(e.target.value); setNoAccount(null); resetLegacy(); }}
          />
          {registering ? (
            <PasswordInput
              label={t('auth.password.confirmLabel')}
              value={passwordConfirm}
              autoComplete="new-password"
              enterKeyHint="go"
              hint={passwordConfirm && !passwordsMatch ? t('auth.password.mismatch') : null}
              onChange={(e) => setPasswordConfirm(e.target.value)}
            />
          ) : null}
          {!registering && requiresMfa ? (
            <TextInput
              label={t('auth.password.mfaLabel')}
              value={mfaCode}
              autoComplete="one-time-code"
              inputMode="numeric"
              enterKeyHint="go"
              placeholder={t('auth.password.mfaPlaceholder')}
              onChange={(e) => setMfaCode(e.target.value)}
            />
          ) : null}

          {legacyAuth ? (
            <div
              role="alert"
              className="rounded-row bg-warning/12 p-3.5 text-xs leading-relaxed"
            >
              <strong className="block text-foreground">{legacyCopy.title}</strong>
              <p className="mt-1 text-muted">{legacyCopy.body}</p>
              <Button
                type="button"
                variant="ghost"
                className="mt-2"
                isDisabled={busy || !ready}
                onClick={() => { setLegacyApproved(true); run(true); }}
              >
                {legacyCopy.action}
              </Button>
            </div>
          ) : null}

          {noAccount ? (
            <div className="auth-miss">
              <FormStatus tone="danger">
                {t('auth.find.noSuchAccount', noAccount)}
              </FormStatus>
              <button type="button" className="self-start rounded text-sm font-medium text-link hover:underline" onClick={backFromPassword}>
                {t('auth.find.changeAddress')}
              </button>
            </div>
          ) : null}
          <FormStatus>{status}</FormStatus>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            isDisabled={!ready}
            className="mt-1 w-full"
          >
            {registering
              ? t('auth.password.submitRegister')
              : mode === 'reactivate'
                ? t('auth.password.submitReactivate')
                : t('auth.password.submitLogin')}
          </Button>
          {mode === 'login' ? (
            <p className="text-center text-xs text-muted">
              <Trans
                k="auth.password.forgot"
                components={{
                  recover: (
                    <button
                      type="button"
                      className="rounded font-medium text-link hover:underline"
                      disabled={busy}
                      onClick={() => {
                        setStatus('');
                        resetLegacy();
                        setRecoverFrom('password');
                        setStep('recover');
                      }}
                    />
                  ),
                }}
              />
            </p>
          ) : null}
        </form>
      );
      break;

    case 'recover':
      title = t('auth.recover.title');
      body = (
        <form onSubmit={checkRecovery} className="flex flex-col gap-3.5">
          <HomeChip host={host} />
          <TextInput
            label={t('common.username')}
            value={user}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('auth.identity.placeholder', { host })}
            onChange={(e) => { setUser(e.target.value); readHomeFrom(e.target.value); }}
          />
          <TextInput
            inputRef={recoveryRef}
            label={t('auth.recoveryKey.fieldLabel')}
            value={recoveryKey}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t('auth.recoveryKey.placeholder')}
            onChange={(e) => { setRecoveryKey(e.target.value); setStatus(''); }}
          />
          <FormStatus>{status}</FormStatus>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            isDisabled={!user.trim() || !recoveryKey.trim()}
            className="mt-1 w-full"
          >
            {t('common.continue')}
          </Button>
        </form>
      );
      break;

    case 'reset': {
      const tooShort = Boolean(newPassword) && newPassword.length < resetMin;
      title = t('auth.reset.title');
      body = (
        <form onSubmit={resetPassword} className="flex flex-col gap-3.5">
          <PasswordInput
            inputRef={newPasswordRef}
            label={t('auth.reset.newLabel')}
            value={newPassword}
            autoComplete="new-password"
            hint={tooShort ? t('auth.reset.minLength', { count: resetMin }) : null}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <PasswordInput
            label={t('auth.reset.confirmLabel')}
            value={newPasswordConfirm}
            autoComplete="new-password"
            hint={newPasswordConfirm && newPassword !== newPasswordConfirm
              ? t('auth.password.mismatch')
              : null}
            onChange={(e) => setNewPasswordConfirm(e.target.value)}
          />
          <FormStatus>{status}</FormStatus>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={busy}
            isDisabled={tooShort || !newPassword || newPassword !== newPasswordConfirm}
            className="mt-1 w-full"
          >
            {t('auth.reset.submit')}
          </Button>
        </form>
      );
      break;
    }

    case 'key':
      title = t('auth.key.title');
      sub = t('auth.key.sub');
      body = (
        <div className="flex flex-col gap-3.5">
          <AccountAddress userId={createdAddress} />
          <Notice tone="warn">
            <Trans k="auth.key.warning" components={{ b: <strong /> }} />
          </Notice>
          <div className="rounded-row bg-surface-secondary p-3.5">
            <code className="block select-all break-all font-mono text-xs leading-5">
              {createdRecoveryKey}
            </code>
          </div>
          <Button
            variant="secondary"
            onClick={() => copyToClipboard(
              recoveryKeyNote(createdRecoveryKey, createdAddress),
              t('auth.recoveryKey.clipboardName'),
            )}
          >
            {t('auth.key.copy')}
          </Button>
          <Button
            variant="ghost"
            onClick={() => downloadRecoveryKey(createdRecoveryKey, createdAddress)}
          >
            {t('auth.recoveryKey.download')}
          </Button>
          <Button variant="primary" size="lg" loading={busy} onClick={finishRecoveryKey}>
            {t('auth.key.saved')}
          </Button>
        </div>
      );
      break;

    default:
      break;
  }

  return (
    <AuthCard
      aside={<Dots steps={findFlow ? DESKTOP_DOTS : DOTS} at={step} />}
    >

      {handoff ? (
        <Notice>
          <Trans
            k={handoff.subject_type === 'guild' ? 'auth.handoff.guild' : 'auth.handoff.account'}
            values={{
              name: handoff.name || handoff.source_id,
              account: handoff.source_id,
              destination: handoff.destination,
              source: handoff.source,
            }}
            components={{ b: <strong /> }}
          />
        </Notice>
      ) : null}

      <Flow step={step} depth={DEPTH[step]}>
        {crumb ? <Crumb label={crumb.label} onClick={crumb.to} /> : null}
        {title ? <h1 className="text-lg font-semibold tracking-tight">{title}</h1> : null}
        {sub ? <p className="text-sm leading-[1.6] text-muted">{sub}</p> : null}
        {body}
      </Flow>
      <BackToAccount />
    </AuthCard>
  );
}
