import { Component, useCallback, useEffect, useRef, useState } from 'react';
import { StoreProvider, useStore, useStoreEvent } from './hooks/useStore.jsx';
import { ModalHost, ModalProvider, useModal } from './hooks/useModal.jsx';
import { VoiceProvider, useVoice } from './hooks/useVoice.jsx';
import { WatchProvider } from './hooks/useWatch.jsx';
import { ToastHost, reportError } from './hooks/useToast.jsx';
import { shortName } from './lib/util.js';
import { crashReportUrl } from './lib/feedback.js';
import { PENDING_RECOVERY_STORAGE_KEY } from './lib/account-recovery.js';
import { noteBootFault, noteBootHealthy } from './lib/local-state.js';
import { RecoveryPanel } from './views/RecoveryScreen.jsx';
import { BootLoader, Button, Notice } from './components/index.js';
import { LoginView } from './views/LoginView.jsx';
import { InviteLanding } from './views/InviteLanding.jsx';
import { PublicProfileLanding } from './views/PublicProfileLanding.jsx';
import { Shell } from './views/Shell.jsx';
import { IncomingCallHost } from './views/IncomingCall.jsx';
import { conversationTitle } from './lib/conversations.js';
import { ProfileCardProvider } from './views/ProfileCard.jsx';
import { TooltipProvider } from './components/Tooltip.jsx';
import { reduced } from './components/Swap.jsx';
import { VerifyDialog } from './views/dialogs/VerifyDialog.jsx';
import { ForwardDialog } from './views/chat/ForwardDialog.jsx';
import { ExternalLinkDialog } from './views/dialogs/ExternalLinkDialog.jsx';
import { isTauriRuntime, openExternal, takeAndroidSharedText } from './lib/platform.js';
import { needsConfirmation } from './lib/link-trust.js';
import { setLocale, t } from './lib/i18n/index.js';
import { errorMessage } from './lib/i18n/errors.js';
import { useT } from './lib/i18n/react.jsx';
import { applyScheme, resolveScheme } from './lib/scheme.js';
import { showLocalNotification } from './lib/notifications.js';
import { notificationPreview } from './lib/notification-preview.js';
import { answerAndroidCallNotification } from './lib/android-call-notification.js';
import { clipContent, toPlainText } from './lib/emoji.js';

const COVER_MIN_MS = 650;

export function App({ store }) {
  // The switch loader sits outside the remounted tree so the same mark keeps turning.
  const [cover, setCover] = useState(null);
  const shownAt = useRef(0);
  useEffect(() => store.on('switching', (next) => {
    shownAt.current = Date.now();
    setCover({ name: next?.name || null, leaving: false });
  }), [store]);
  const settled = useCallback(() => {
    const wait = Math.max(0, shownAt.current + COVER_MIN_MS - Date.now());
    setTimeout(() => setCover((c) => (c && !c.leaving ? { ...c, leaving: true } : c)), wait);
  }, []);
  return (
    <>
      <AppTree key={store.instance} store={store} covered={Boolean(cover)} onSettled={settled} />
      {cover ? <SwitchCover cover={cover} onGone={() => setCover(null)} /> : null}
    </>
  );
}

function SwitchCover({ cover, onGone }) {
  const tr = useT();
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (!cover.leaving) return undefined;
    // The animation's own end is the signal; the timer covers reduced motion and background tabs.
    const id = setTimeout(() => gone.current(), 600);
    return () => clearTimeout(id);
  }, [cover.leaving]);
  return (
    <div
      className={`boot-cover${cover.leaving ? ' boot-cover--leaving' : ''}`}
      onAnimationEnd={(e) => { if (cover.leaving && e.target === e.currentTarget) gone.current(); }}
    >
      <BootLoader label={cover.name ? tr('app.boot.switching', { name: cover.name }) : null} />
    </div>
  );
}

function AppTree({ store, covered, onSettled }) {
  return (
    // Two nested boundaries: the inner keeps providers, store and voice alive; the outer covers a provider that throws.
    <ErrorBoundary>
      <AppProviders store={store}>
        <ErrorBoundary>
          <Phases covered={covered} onSettled={onSettled} />
          <IncomingCallHost />
          <ToastHost />
        </ErrorBoundary>
      </AppProviders>
    </ErrorBoundary>
  );
}

/// Split out so tests mount the same stack as the app; the error boundaries are deliberately outside.
export function AppProviders({ store, children }) {
  return (
    <StoreProvider store={store}>
      <TooltipProvider delay={400} closeDelay={0}>
        <ModalProvider>
          {/* Voice outside the profile card: `useVoice` threw when nested the other way. */}
          <VoiceProvider>
            <WatchProvider>
              <ProfileCardProvider>
                {children}
                <ModalHost />
              </ProfileCardProvider>
            </WatchProvider>
          </VoiceProvider>
        </ModalProvider>
      </TooltipProvider>
    </StoreProvider>
  );
}

/// Reads no store and makes no request: drawing from the state that just threw would be a second white screen.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: '', recovering: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Telium render error:', error, info);
    noteBootFault(error?.message || String(error));
    this.setState({ stack: info?.componentStack || '' });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const message = this.state.error.message || String(this.state.error);
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-strip px-5 text-center">
        <p className="max-w-[420px] text-base leading-[1.6] text-muted">
          {t('app.crash.title')}
        </p>
        {message ? (
          <p className="max-w-[420px] break-words font-mono text-xs leading-[1.6] text-danger">
            {message}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('app.crash.reload')}
          </Button>
          <Button onClick={() => {
            // Swallowed: a rejected open must not stack on the failure being handled.
            openExternal(crashReportUrl(this.state.error, this.state.stack)).catch(() => {});
          }}
          >
            {t('app.crash.report')}
          </Button>
          {this.state.recovering ? null : (
            <Button variant="ghost" onClick={() => this.setState({ recovering: true })}>
              {t('app.crash.recover')}
            </Button>
          )}
        </div>
        {this.state.recovering ? <RecoveryPanel /> : null}
      </div>
    );
  }
}

function recoveryKeyPending() {
  return typeof sessionStorage !== 'undefined'
    && Boolean(sessionStorage.getItem(PENDING_RECOVERY_STORAGE_KEY));
}

function Phases({ covered = false, onSettled }) {
  const store = useStore();
  useStoreEvent('route');
  const tr = useT();
  const pendingRecovery = recoveryKeyPending();
  const [phase, setPhase] = useState(
    store.signedIn && !pendingRecovery ? 'connecting' : 'login',
  );
  const [error, setError] = useState(null);
  // Public profile actions survive the auth funnel.
  const [profileAction, setProfileAction] = useState(null);
  const [profileAuth, setProfileAuth] = useState(false);
  // A pasted invite link must outlive LoginView: the invite screen signs in and joins before the shell exists.
  const [pastedInvite, setPastedInvite] = useState(null);

  const boot = useCallback(async () => {
    // Registration persists the session before the recovery-key interstitial, so a reload must return to it.
    if (!store.signedIn || recoveryKeyPending()) { setPhase('login'); return; }
    setPhase('connecting');
    setError(null);
    try {
      await store.start();
      setPhase('shell');
    } catch (e) {
      setError(e);
      setPhase('unreachable');
    }
  }, [store]);

  useEffect(() => { boot(); }, [boot]);

  useEffect(() => store.on('hydrated', () => {
    if (!recoveryKeyPending()) setPhase('shell');
  }), [store]);

  useEffect(() => store.on('signout', () => { setPhase('login'); setError(null); }), [store]);

  usePreferences();
  useExternalLinks(store);
  useAndroidShareIntent(phase === 'shell');
  useMentionNotifications();
  useDmNotifications();
  useCallNotifications();
  useAndroidCallNotificationActions();
  useIncomingVerification();

  // Reaching a settled screen clears the fault ledger that arms self-heal. Last among the effects so a throw above skips it.
  useEffect(() => {
    if (phase === 'connecting') return;
    noteBootHealthy();
  }, [phase]);

  const handingOff = useHandoff(phase) && !covered;

  const settled = useRef(onSettled);
  settled.current = onSettled;
  useEffect(() => {
    if (phase !== 'connecting') settled.current?.();
  }, [phase]);
  const connectingLabel = tr('app.boot.connecting', { domain: store.session?.home?.domain });

  const inviteCode = store.route?.view === 'invite' ? store.route.inviteCode : null;
  const inviteServer = store.route?.view === 'invite' ? store.route.inviteServer || null : null;
  const profileUserId = store.route?.view === 'profile-link' ? store.route.userId : null;

  useEffect(() => {
    if (profileUserId) return;
    setProfileAction(null);
    setProfileAuth(false);
  }, [profileUserId]);

  // A pasted invite holds whatever `phase` says: `hydrated` flipping phase to shell mid-join would unmount it.
  if (pastedInvite) {
    return (
      <InviteLanding
        key={`${pastedInvite.base} ${pastedInvite.code}`}
        code={pastedInvite.code}
        base={pastedInvite.base}
        onEntered={() => {
          setPastedInvite(null);
          setPhase('shell');
        }}
        onBack={() => {
          setPastedInvite(null);
          // Someone signed in on the invite screen who leaves without joining goes into the app.
          if (store.signedIn && store.home && !recoveryKeyPending()) setPhase('shell');
          else boot();
        }}
      />
    );
  }
  if (profileUserId) {
    if (profileAuth) {
      return (
        <LoginView
          onSignedIn={() => {
            setProfileAuth(false);
            boot();
          }}
          onInvite={setPastedInvite}
        />
      );
    }
    const queue = (action) => {
      setProfileAction(action);
      if (!store.signedIn || pendingRecovery) setProfileAuth(true);
    };
    return (
      <PublicProfileLanding
        userId={profileUserId}
        sessionReady={phase === 'shell' && !pendingRecovery}
        pendingAction={profileAction}
        onQueueAction={queue}
        onRequireAuth={queue}
        onActionHandled={() => setProfileAction(null)}
      />
    );
  }

  if (inviteCode && (pendingRecovery || !store.signedIn)) {
    return (
      <InviteLanding
        code={inviteCode}
        serverName={inviteServer || undefined}
        onEntered={() => setPhase('shell')}
      />
    );
  }
  if (phase === 'login') return <LoginView onSignedIn={boot} onInvite={setPastedInvite} />;
  if (phase === 'connecting') return <Connecting label={connectingLabel} />;
  if (phase === 'unreachable') return <Unreachable error={error} onRetry={boot} />;
  if (inviteCode) {
    return (
      <InviteLanding
        code={inviteCode}
        serverName={inviteServer || undefined}
        onEntered={() => setPhase('shell')}
      />
    );
  }
  return (
    <>
      <Shell />
      {handingOff ? (
        <div className="auth-handoff" inert aria-hidden="true">
          <Connecting label={connectingLabel} />
        </div>
      ) : null}
    </>
  );
}

/// A second, inert render of `Connecting` holds the pre-session card so connecting to shell does not read as a reload.
function useHandoff(phase) {
  const from = useRef(phase);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const was = from.current;
    from.current = phase;
    if (phase !== 'shell' || was !== 'connecting' || reduced()) return undefined;
    setLeaving(true);
    const id = setTimeout(() => setLeaving(false), 420);
    return () => clearTimeout(id);
  }, [phase]);

  return leaving;
}

function useAndroidShareIntent(active) {
  const modal = useModal();
  const taking = useRef(false);

  useEffect(() => {
    if (!active) return undefined;

    let live = true;
    const take = async () => {
      if (taking.current) return;
      taking.current = true;
      try {
        const text = await takeAndroidSharedText();
        if (!live || !text) return;
        modal.open(
          (close) => (
            <ForwardDialog
              payload={{ text, attachments: [] }}
              shared
              close={close}
            />
          ),
          { wide: true },
        );
      } catch (error) {
        if (live) reportError(error, 'Could not open Android share');
      } finally {
        taking.current = false;
      }
    };

    take();
    window.addEventListener('telium:share-intent', take);
    return () => {
      live = false;
      window.removeEventListener('telium:share-intent', take);
    };
  }, [active, modal]);
}

/// A message link's text is not evidence of its destination, so the reader is shown the real host first.
/// `openExternal` runs straight from the dialog's click so the popup blocker sees a gesture.
function useExternalLinks(store) {
  const modal = useModal();
  useEffect(() => {
    const onClick = (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey
        || event.shiftKey || event.altKey) return;
      const anchor = event.target.closest?.('a[href]');
      if (!anchor || anchor.hasAttribute('download')) return;
      const href = anchor.href;
      if (!href || !/^https?:/i.test(href)) return;
      let external = anchor.target === '_blank';
      try {
        external ||= new URL(href).origin !== window.location.origin;
      } catch {
        return;
      }
      if (!external) return;

      const destination = needsConfirmation(store, href);
      if (!destination && !isTauriRuntime()) return;
      event.preventDefault();
      event.stopPropagation();

      const open = () => openExternal(href)
        .catch((error) => reportError(error, 'Could not open link'));
      if (!destination) { open(); return; }
      modal.open((close) => (
        <ExternalLinkDialog
          store={store}
          destination={destination}
          onOpen={open}
          close={close}
        />
      ));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [store, modal]);
}

/// Real height, not min-height, or it never scrolls; centred by auto margin since items-center crops tall cards.
export function AuthCard({ aside, children }) {
  return (
    <div
      className="auth-screen flex h-full max-h-[100dvh] items-start justify-center overflow-y-auto bg-background px-5 py-8 sm:py-10"
      style={{
        paddingTop: 'max(2rem, var(--safe-area-top))',
        paddingBottom: 'max(2rem, var(--safe-area-bottom))',
      }}
    >
      <div className="auth-card my-auto w-full max-w-[400px] bg-background py-2 sm:rounded-3xl sm:bg-surface sm:p-7">
        <div className="flex items-center gap-2.5 pb-1">
          <img
            src="/brand/telium-mark-gradient.svg"
            alt=""
            width="28"
            height="28"
            className="size-7 shrink-0"
          />
          {/* The product name is artwork, not a translatable string (unlike `notifications.system.appName`, which the OS draws). */}
          <span className="text-xl font-semibold tracking-tight">Telium</span>
          {aside ? <div className="ms-auto">{aside}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function Connecting({ label }) {
  return <BootLoader label={label} />;
}

/// Without assertions no guild session can be renewed; offline and unreachable get different screens.
function Unreachable({ error, onRetry }) {
  const tr = useT();
  const store = useStore();
  const domain = store.session?.home?.domain;
  // `navigator.onLine` true proves nothing (captive portals); only false is trusted.
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  // Untagged failures fall through to the server's own text; add a code in `server/src/errcodes.rs`.
  const reason = errorMessage(error);
  return (
    <AuthCard>
      <p className="pt-1 pb-4 text-sm leading-[1.6] text-muted">
        {online ? tr('app.boot.unreachable', { domain, reason }) : tr('app.boot.offline')}
      </p>
      {online ? <Notice tone="warn">{tr('app.boot.unreachableNotice')}</Notice> : null}
      <div className="flex gap-2 pt-4">
        <Button variant="primary" onClick={onRetry}>{tr('common.retry')}</Button>
        <Button variant="ghost" onClick={() => store.signOut()}>{tr('app.boot.signOut')}</Button>
      </div>
    </AuthCard>
  );
}

function usePreferences() {
  const store = useStore();
  useStoreEvent('prefs');
  useEffect(() => {
    applyScheme(document.documentElement, resolveScheme(store.prefs.scheme, store.prefs.theme));
    setLocale(store.prefs.locale || 'auto');
    document.body.classList.toggle('compact', !!store.prefs.compact);
  });
}

/// A verification someone else started is live on their device and expires in minutes.
function useIncomingVerification() {
  const store = useStore();
  const modal = useModal();
  const shown = useRef(new Set());
  useEffect(() => store.on('verify', () => {
    for (const exchange of store.verifications.values()) {
      if (exchange.initiator || !exchange.live) continue;
      if (shown.current.has(exchange.txn)) continue;
      shown.current.add(exchange.txn);
      modal.open((close) => <VerifyDialog exchange={exchange} close={close} />);
    }
  }), [store, modal]);
}

/// Cut with `clipContent`, not `slice`, so it cannot land inside a custom emoji token.
const NOTIFY_MAX = 140;

function notifyBody(content) {
  return toPlainText(clipContent(content || '', NOTIFY_MAX));
}

// Module-level `t()`: these handlers' strings go to the OS and are never re-rendered.

function useMentionNotifications() {
  const store = useStore();
  useEffect(() => store.on('mention', ({ channelId, message, kind = 'mention' }) => {
    const inForeground = document.visibilityState === 'visible' && document.hasFocus();
    if (inForeground) return;
    if (store.prefs.notifyMentions === false) return;
    const channel = store.channels.get(channelId);
    const sender = shortName(message.author);
    const visible = notificationPreview(store.prefs.notificationPreview, {
      title: t('notifications.system.channelTitle', {
        channel: channel?.name || t('notifications.system.unknownChannel'),
      }),
      body: t('notifications.system.messageFrom', {
        sender,
        message: notifyBody(message.content),
      }),
      senderTitle: sender,
      genericBody: t(kind === 'reply'
        ? 'notifications.system.newReply'
        : 'notifications.system.newMention'),
    });
    showLocalNotification({
      title: visible.title,
      body: visible.body,
      tag: channelId,
      onClick: channel ? () => store.navigate({
        view: 'chat',
        guildId: channel.guild_id,
        channelId,
        conversationId: null,
      }) : undefined,
    }).catch((e) => reportError(e, t('notifications.system.showFailed')));
  }), [store]);
}

/// The body is read from the engine because the frame is ciphertext.
function useDmNotifications() {
  const store = useStore();
  useEffect(() => store.on('dm-notify', (frame) => {
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    if (store.prefs.notifyDms === false) return;
    const convo = store.conversations.find((c) => c.id === frame.conversation_id);
    const from = shortName(frame.sender);
    const text = store.mls?.textOf(frame.id);
    // Separate sentences, not a shared prefix: sender/body syntax differs by language.
    let body;
    if (text === undefined) body = t('notifications.system.encryptedFrom', { sender: from });
    else if (text.trim()) body = t('notifications.system.messageFrom', { sender: from, message: notifyBody(text) });
    else body = t('notifications.system.attachmentFrom', { sender: from });
    const visible = notificationPreview(store.prefs.notificationPreview, {
      title: convo ? conversationTitle(store, convo) : from,
      body,
      senderTitle: from,
      genericBody: t('notifications.system.newDm'),
    });
    showLocalNotification({
      title: visible.title,
      body: visible.body,
      tag: frame.conversation_id,
      onClick: () => store.navigate({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId: frame.conversation_id,
      }),
    }).catch((e) => reportError(e, t('notifications.system.showFailed')));
  }), [store]);
}

function useCallNotifications() {
  const store = useStore();
  useEffect(() => store.on('ring', ({ conversationId, from, ringing }) => {
    if (!ringing) return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const convo = store.conversations.find((c) => c.id === conversationId);
    const caller = shortName(from);
    const visible = notificationPreview(store.prefs.notificationPreview, {
      // Hidden mode removes the caller at the final presentation boundary.
      title: caller,
      body: convo && (convo.kind === 'gc' || convo.name)
        ? t('notifications.system.calling', { name: conversationTitle(store, convo) })
        : t('notifications.system.incomingCall'),
      senderTitle: caller,
      genericBody: t('notifications.system.incomingCall'),
    });
    showLocalNotification({
      title: visible.title,
      body: visible.body,
      tag: conversationId,
      // Opens the conversation only; answering from an OS notification would put a live microphone behind a background window.
      onClick: () => store.navigate({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId,
      }),
    }).catch((e) => reportError(e, t('notifications.system.showFailed')));
  }), [store]);
}

function useAndroidCallNotificationActions() {
  const store = useStore();
  const { join } = useVoice();

  useEffect(() => store.on('android-call-answer', async (conversationId) => {
    try {
      // The call may have just ended; check the roster so Answer cannot start a fresh outgoing call.
      await answerAndroidCallNotification(store, join, conversationId);
    } catch (error) {
      reportError(error, 'Could not answer the call');
    }
  }), [store, join]);
}
