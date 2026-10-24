import { useEffect, useState, useRef, useCallback } from 'react';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { PersistentAudioProvider } from '../hooks/usePersistentAudio.jsx';
import { Action, Kind, summarize } from '../lib/failure.js';
import { relative } from '../lib/util.js';
import { describeFallback } from '../lib/failover.js';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { reportError } from '../hooks/useToast.jsx';
import {
  Banner, Button, EmptyState, PinIcon, SearchField, ThreadIcon, CloseIcon,
} from '../components/index.js';
import { checkIsMobile } from '../lib/platform.js';
import { GuildRail } from './GuildRail.jsx';
import { Sidebar } from './Sidebar.jsx';
import { Topbar } from './Topbar.jsx';
import { ChatView } from './ChatView.jsx';
import { MembersPane } from './MembersPane.jsx';
import { SearchResultsPane } from './SearchResults.jsx';
import { DmView } from './DmView.jsx';
import { FriendsView } from './FriendsView.jsx';
import { VoiceView } from './VoiceView.jsx';
import { PersistentMediaMiniView } from './PersistentMediaMiniView.jsx';
import { MigrationBanner } from './MigrationBanner.jsx';
import { SunsetBanner } from './SunsetBanner.jsx';
import { VersionBanner } from './VersionBanner.jsx';
import { UpdateBanner } from './UpdateBanner.jsx';
import { ReceiveMigrationDialog } from './user-settings/ReceiveMigrationDialog.jsx';
import { clearHandoff, pendingHandoff } from '../lib/handoff.js';
import { ForumView } from './ForumView.jsx';
import { QuickSwitcher } from './dialogs/QuickSwitcher.jsx';
import { ThreadsDialog } from './dialogs/ThreadsDialog.jsx';
import { PinsDialog } from './dialogs/PinsDialog.jsx';
import {
  MobileLeftDrawer, MobileTopbar, MobileTopbarButton, MobileVoicePill, mobileBackAction,
} from './mobile/MobileNavigation.jsx';
import { useMobileBackDismiss } from '../hooks/useMobileBackDismiss.js';
import { useMobileViewport } from '../hooks/useMobileViewport.js';
import { UserSettings } from './settings.jsx';

export function Shell() {
  const [mobile, setMobile] = useState(() => checkIsMobile());
  usePendingHandoff();

  useEffect(() => {
    const onResize = () => setMobile(checkIsMobile());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <PersistentAudioProvider>
      {mobile ? <MobileShell /> : <DesktopShell />}
    </PersistentAudioProvider>
  );
}

function DesktopShell() {
  const store = useStore();
  const voice = useVoice();
  useStoreEvent('route');
  const modal = useModal();
  const route = store.route;
  const callVisible = activeCallIsVisible(store, voice, route);

  const switcher = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'k') return;
      e.preventDefault();
      if (switcher.current) {
        const dismiss = switcher.current;
        switcher.current = null;
        dismiss();
        return;
      }
      let dispose = null;
      dispose = modal.open(
        (close) => (
          <QuickSwitcher
            close={close}
            onGone={() => { if (switcher.current === dispose) switcher.current = null; }}
          />
        ),
        { bare: true, place: 'top', desktopSize: 'switcher' },
      );
      switcher.current = dispose;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  useEffect(() => window.teliumDesktop?.onOpenFeedback?.(() => {
    modal.open(
      (close) => <UserSettings close={close} initial="feedback" />,
      { fullscreen: true },
    );
  }), [modal]);

  return (
    <div className="shell-in flex h-screen flex-col bg-background text-foreground">
      <BannerStack />
      <div className="flex min-h-0 flex-1">
        <GuildRail />
        <Sidebar />
        <Main route={route} />
      </div>
      <PersistentMediaMiniView hidden={callVisible} />
    </div>
  );
}

function MobileShell() {
  useMobileViewport();
  useT();
  const store = useStore();
  const voice = useVoice();
  useStoreEvent('route', 'unread', 'friends', 'conversations', 'guilds');
  const route = store.route;

  const [drawerOpen, setDrawerOpen] = useState(() => (
    !route.channelId && !route.conversationId && route.view !== 'dms'
  ));
  const [membersOpen, setMembersOpen] = useState(false);
  const [voiceStageOpen, setVoiceStageOpen] = useState(false);
  const [selectedGuildId, setSelectedGuildId] = useState(route.guildId || null);
  const [memberSearch, setMemberSearch] = useState('');

  const dismissKeyboard = useCallback(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.matches('input, textarea, [contenteditable="true"]')) active.blur();
  }, []);

  const openDrawer = useCallback(() => {
    dismissKeyboard();
    setMembersOpen(false);
    setDrawerOpen(true);
  }, [dismissKeyboard]);

  const openMembers = useCallback(() => {
    dismissKeyboard();
    setDrawerOpen(false);
    setMembersOpen(true);
  }, [dismissKeyboard]);

  const expandActiveCall = useCallback(() => {
    const room = voice.channelId ? store.channels.get(voice.channelId) : null;
    if (room) {
      dismissKeyboard();
      setDrawerOpen(false);
      setMembersOpen(false);
      setVoiceStageOpen(true);
      return;
    }
    const convo = voice.channelId
      ? store.conversations.find((item) => item.id === voice.channelId)
      : null;
    if (convo) {
      setVoiceStageOpen(false);
      setDrawerOpen(false);
      setMembersOpen(false);
      store.navigate({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId: convo.id,
      });
    }
  }, [voice.channelId, store, dismissKeyboard]);

  useEffect(() => {
    if (route.view === 'dms') {
      setSelectedGuildId(null);
    } else if (route.guildId) {
      setSelectedGuildId(route.guildId);
    }
  }, [route.view, route.guildId]);

  useEffect(() => {
    if (!membersOpen) setMemberSearch('');
  }, [membersOpen]);
  useEffect(() => setMemberSearch(''), [route.guildId]);

  const backAction = mobileBackAction({ drawerOpen, membersOpen, voiceStageOpen, route });
  useMobileBackDismiss(() => {
    if (backAction === 'close-voice') {
      setVoiceStageOpen(false);
      return;
    }
    if (backAction === 'close-members') {
      setMembersOpen(false);
      return;
    }
    if (backAction === 'close-drawer') {
      setDrawerOpen(false);
      return;
    }
    if (backAction === 'dm-list') {
      store.navigate({ view: 'dms', conversationId: null });
    }
  }, { active: backAction !== 'exit' });

  const touchStartRef = useRef(null);

  const handleTouchStart = useCallback((e) => {
    if (voiceStageOpen || e.touches.length !== 1) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.msg-row, .composer-shell, input, textarea, [role="dialog"], [data-mobile-gesture-lock]')) {
      touchStartRef.current = null;
      return;
    }
    const touch = e.touches[0];
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
    };
  }, [voiceStageOpen]);

  const handleTouchEnd = useCallback((e) => {
    if (!touchStartRef.current || voiceStageOpen || e.changedTouches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const startX = touchStartRef.current.x;
    touchStartRef.current = null;

    if (Math.abs(dx) < Math.abs(dy) * 1.5 || Math.abs(dx) < 60) return;

    if (dx > 0) {
      if (membersOpen) {
        setMembersOpen(false);
      } else if (!drawerOpen && startX < 70) {
        openDrawer();
      }
    } else {
      if (drawerOpen) {
        setDrawerOpen(false);
      } else if (!membersOpen && route.guildId && startX > window.innerWidth - 30) {
        openMembers();
      }
    }
  }, [drawerOpen, membersOpen, voiceStageOpen, route.guildId, openDrawer, openMembers]);

  return (
    <div
      className="shell-in mobile-shell flex h-screen h-[100dvh] flex-col bg-background text-foreground overflow-hidden"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { touchStartRef.current = null; }}
    >
      <BannerStack />

      {voice.active && !voiceStageOpen && (
        <MobileVoicePill onExpand={expandActiveCall} />
      )}

      <div className="mobile-shell-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <Main
          route={route}
          mobile
          onOpenMenu={openDrawer}
          onOpenMembers={openMembers}
          onOpenVoiceStage={() => {
            dismissKeyboard();
            setVoiceStageOpen(true);
          }}
        />

        {drawerOpen && (
          <>
            <button
              type="button"
              aria-label={t('shell.a11y.closeMenu')}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs animate-fade-in"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              className="fixed inset-y-0 start-0 z-50 flex w-[88vw] max-w-[360px] bg-rail shadow-2xl animate-panel-slide-start"
              style={{ paddingInlineStart: 'var(--safe-area-start)' }}
            >
              <MobileLeftDrawer
                selectedGuildId={selectedGuildId}
                onSelectGuild={(id) => setSelectedGuildId(id)}
                onClose={() => setDrawerOpen(false)}
              />
            </div>
          </>
        )}

        {membersOpen && route.guildId && (
          <>
            <button
              type="button"
              aria-label={t('shell.a11y.closeMembers')}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-xs animate-fade-in"
              onClick={() => setMembersOpen(false)}
            />
            <div
              className="fixed inset-y-0 end-0 z-50 flex w-[82vw] max-w-[320px] flex-col bg-background shadow-2xl animate-panel-slide-end"
              style={{
                paddingTop: 'var(--safe-area-top)',
                paddingInlineEnd: 'var(--safe-area-end)',
                paddingBottom: 'var(--safe-area-bottom)',
              }}
            >
              <div className="flex min-h-14 items-center gap-2 border-b border-separator px-3 py-2">
                <SearchField
                  label={t('shell.members.search')}
                  placeholder={t('shell.members.search')}
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  onClear={() => setMemberSearch('')}
                  size="base"
                  className="min-h-11 min-w-0 flex-1 rounded-xl border-0 bg-surface"
                />
                <button
                  type="button"
                  aria-label={t('shell.a11y.closeMembers')}
                  onClick={() => setMembersOpen(false)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-row text-muted active:bg-surface-tertiary"
                >
                  <CloseIcon className="size-4" />
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-hidden">
                <MembersPane guildId={route.guildId} mobile searchQuery={memberSearch} />
              </div>
            </div>
          </>
        )}

        <PersistentMediaMiniView
          hidden={voiceStageOpen || activeCallIsVisible(store, voice, route)}
          onExpand={expandActiveCall}
        />

        {voiceStageOpen && (
          <div className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background animate-sheet-in">
            <VoiceView
              channelId={voice.channelId}
              mobile
              onMinimize={() => setVoiceStageOpen(false)}
              onOpenNavigation={() => {
                setVoiceStageOpen(false);
                openDrawer();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function activeCallIsVisible(store, voice, route) {
  if (!voice.active || !voice.channelId) return false;
  const room = store.channels.get(voice.channelId);
  if (room) return route.view === 'voice' && route.channelId === voice.channelId;
  return route.view === 'dms' && route.conversationId === voice.channelId;
}

function Main({
  route,
  mobile = false,
  onOpenMenu,
  onOpenMembers,
  onOpenVoiceStage,
}) {
  const store = useStore();
  useStoreEvent('prefs', 'channels', 'threads', 'search');
  useT();

  const committed = store.committedSearch;
  const search = !mobile && committed && committed.guildId === route.guildId ? committed : null;
  const dock = mobile ? null : (search
    ? <SearchResultsPane key={search.at} committed={search} />
    : (store.prefs.members !== false ? <MembersPane guildId={route.guildId} /> : null));

  if (route.view === 'dms' && route.conversationId) {
    return (
      <DmView
        conversationId={route.conversationId}
        mobile={mobile}
        onBack={() => onOpenMenu?.()}
        onMore={() => onOpenMenu?.()}
        onOpenNavigation={() => onOpenMenu?.()}
      />
    );
  }

  if (route.view === 'dms') {
    return <FriendsView mobile={mobile} onMore={() => onOpenMenu?.()} />;
  }

  const kind = route.channelId ? store.channels.get(route.channelId)?.type : null;
  const voice = route.view === 'voice' || kind === 'voice';
  const forum = Boolean(route.channelId) && !voice && (kind === 'forum' || (!kind && route.view === 'forum'));

  let body;
  if (voice) {
    if (mobile) {
      return (
        <VoiceView
          key={route.channelId}
          channelId={route.channelId}
          mobile
          onOpenNavigation={onOpenMenu}
        />
      );
    }
    body = (
      <>
        <VoiceView key={route.channelId} channelId={route.channelId} />
        {dock}
      </>
    );
  } else if (forum) {
    body = <ForumView key={route.channelId} channelId={route.channelId} mobile={mobile} />;
  } else if (!route.channelId) {
    body = mobile ? (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <EmptyState title={t('shell.empty.title')}>{t('shell.empty.body')}</EmptyState>
        <Button variant="primary" onClick={onOpenMenu}>{t('shell.a11y.openChannels')}</Button>
      </div>
    ) : (
      <EmptyState title={t('shell.empty.title')}>{t('shell.empty.body')}</EmptyState>
    );
  } else {
    body = (
      <>
        <ChatView
          key={route.channelId}
          channelId={route.channelId}
          mobile={mobile}
          onOpenNavigation={onOpenMenu}
        />
        {dock}
      </>
    );
  }

  const activeChannel = route.channelId ? store.channels.get(route.channelId) : null;
  const mobileTitle = activeChannel?.name
    ? (activeChannel.type === 'text' || activeChannel.type === 'announcement'
      ? `#${activeChannel.name}`
      : activeChannel.name)
    : route.guildId
      ? (store.guilds.get(route.guildId)?.name || t('shell.title.guild'))
      : t('notifications.system.appName');
  const showChannelActions = Boolean(activeChannel) && activeChannel.type !== 'forum';

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden${mobile ? ' page-in' : ''}`}>
      {mobile ? (
        <MobileTopbar
          title={mobileTitle}
          subtitle={route.guildId && route.channelId ? store.guilds.get(route.guildId)?.name : undefined}
          onMenu={onOpenMenu}
          onMembers={route.guildId ? onOpenMembers : undefined}
          actions={showChannelActions ? <ChannelActions channelId={route.channelId} /> : null}
        />
      ) : <Topbar route={route} />}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">{body}</div>
    </div>
  );
}

function ChannelActions({ channelId }) {
  useT();
  const store = useStore();
  const modal = useModal();
  useStoreEvent('prefs', 'pins');
  const channel = store.channels.get(channelId);
  const threadParent = channel?.parent_id || null;
  const threads = threadParent ? (store.threads.get(threadParent) || []).length : 0;
  const unseenPins = store.unseenPinCount(channelId, null);

  return (
    <div className="flex items-center gap-0.5">
      {threadParent ? (
        <MobileTopbarButton
          label={t('shell.tabs.forum')}
          badge={threads ? (threads > 99 ? '99+' : String(threads)) : null}
          onClick={() => modal.open((close) => (
            <ThreadsDialog channelId={threadParent} close={close} />
          ))}
        >
          <ThreadIcon className="size-5" />
        </MobileTopbarButton>
      ) : null}
      <MobileTopbarButton
        label={t('shell.tabs.pinned')}
        badge={unseenPins ? String(unseenPins) : null}
        onClick={() => modal.open((close) => <PinsDialog channelId={channelId} close={close} />)}
      >
        <PinIcon className="size-5" />
      </MobileTopbarButton>
    </div>
  );
}

const SETTLE_MS = 1600;

function useSettled(value, delay) {
  const [settled, setSettled] = useState(delay ? null : value);
  useEffect(() => {
    if (!value || !delay) { setSettled(value); return undefined; }
    const id = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return settled;
}

function BannerStack() {
  return (
    <div className="banner-stack">
      <ConnectionBanner />
      <MigrationBanner />
      <SunsetBanner />
      <VersionBanner />
      <UpdateBanner />
    </div>
  );
}

function ConnectionBanner() {
  const store = useStore();
  useStoreEvent('status', 'guilds', 'fallback');
  useT();
  const banner = connectionBanner(store);
  const settled = useSettled(banner?.key ?? null, banner?.urgent ? 0 : SETTLE_MS);
  if (!banner || settled !== banner.key) return null;
  return banner.node;
}

function connectionBanner(store) {

  if (store.fallback) {
    const home = store.session?.home?.domain;
    const promoted = store.fallback.status?.read_only === false;
    return {
      key: `fallback:${store.fallback.domain}:${promoted}`,
      urgent: true,
      node: (
        <Banner tone={promoted ? undefined : 'warning'}>
          {describeFallback(store.fallback, home)}
          <Button
            size="sm"
            variant="ghost"
            className="ms-1 min-h-9 shrink-0 rounded-lg"
            onClick={() => store.checkPrimary().catch(() => {})}
          >
            {t('shell.banner.retryHome', { domain: home })}
          </Button>
        </Banner>
      ),
    };
  }

  if (store.cachedAt) {
    return {
      key: 'cached',
      node: <Banner>{t('shell.banner.cached', { when: relative(store.cachedAt) })}</Banner>,
    };
  }

  const summary = summarize(store.gw.failures());
  if (!summary) return null;

  const groups = summary.groups.slice(0, MAX_FAILURE_BANNERS);
  return {
    key: `failure:${groups.map((g) => `${g.kind}@${g.names.join(',')}`).join('|')}`,
    urgent: groups.some((g) => g.action !== Action.Wait),
    node: (
      <>
        {groups.map((group) => (
          <Banner key={group.kind} tone={TONE_FOR_KIND[group.kind]}>
            {group.sentence}
            {failureButton(store, group)}
          </Banner>
        ))}
      </>
    ),
  };
}

const MAX_FAILURE_BANNERS = 3;

const TONE_FOR_KIND = {
  [Kind.Protocol]: 'danger',
  [Kind.Auth]: 'danger',
  [Kind.Offline]: 'warning',
  [Kind.AccountHome]: 'warning',
};

function failureButton(store, group) {
  if (group.action === Action.SignIn) {
    return (
      <Button
        size="sm"
        variant="danger-soft"
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={async () => {
          for (const domain of group.names) {
            try { await store.renewServer(domain); } catch (e) { reportError(e, domain); }
          }
        }}
      >
        {t('shell.banner.signIn')}
      </Button>
    );
  }
  if (group.action === Action.Update) {
    return (
      <Button
        size="sm"
        variant="danger-soft"
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={() => window.location.reload()}
      >
        {t('shell.banner.reload')}
      </Button>
    );
  }
  if (group.action === Action.HomeOperator || group.action === Action.GuildOperator) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="ms-1 min-h-9 shrink-0 rounded-lg"
        onClick={() => store.gw.wake()}
      >
        {t('shell.banner.wake')}
      </Button>
    );
  }
  return null;
}

function usePendingHandoff() {
  const modal = useModal();
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    const handoff = pendingHandoff();
    if (!handoff) return;
    asked.current = true;
    modal.open((close) => (
      <ReceiveMigrationDialog
        handoff={handoff}
        close={() => { clearHandoff(); close(); }}
      />
    ));
  }, [modal]);
}
