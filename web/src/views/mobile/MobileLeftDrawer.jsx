import { useMemo, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { cn } from '../../lib/cn.js';
import { faceOf } from '../../lib/faces.js';
import { shortName, statusLine } from '../../lib/util.js';
import { orderedGuildIds } from '../../lib/rail.js';
import {
  Avatar, Badge, EmojiText, PlusIcon, SettingsIcon, StatusText, TeliumMark
} from '../../components/index.js';
import { GuildFace } from '../../components/GuildFace.jsx';
import { UserSettings } from '../settings.jsx';
import { AddGuildDialog } from '../dialogs/AddGuildDialog.jsx';
import { useMenus } from '../menus.jsx';
import { MobileActionSheet } from './MobileActionSheet.jsx';
import { MobileChannelPanel } from './MobileChannelPanel.jsx';
import { MobileDmPanel } from './MobileDmPanel.jsx';

const MOBILE_PRESENCE_LABEL = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  invisible: 'Invisible',
};

export function MobileLeftDrawer({
  selectedGuildId,
  onSelectGuild,
  onClose,
}) {
  const store = useStore();
  const modal = useModal();
  useStoreEvent('guilds', 'channels', 'route', 'unread', 'conversations', 'friends', 'prefs');
  const nodes = store.railNodes();
  const ids = useMemo(() => orderedGuildIds(nodes), [nodes]);
  const isDmMode = selectedGuildId === null;
  const dmBadge = store.dmUnreadTotal?.() || 0;
  const pendingFriends = store.pendingFriendCount?.() || 0;
  const menus = useMenus();
  const [accountOpen, setAccountOpen] = useState(false);

  const me = store.me;
  const myName = me?.profile?.display_name || shortName(me?.user_id);
  const myFace = faceOf(store, me?.user_id);
  const myHandle = me?.user_id ? `@${shortName(me.user_id)}` : '';
  const myPresence = store.prefs?.presence || 'online';
  const myStatus = statusLine({ custom_status: store.prefs?.status?.text });

  return (
    <div className="flex h-full w-full overflow-hidden bg-rail">
      <div
        data-mobile-guild-rail
        className="mobile-guild-rail flex w-[72px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto bg-strip pb-3 overscroll-contain"
        style={{ paddingTop: 'max(1.25rem, var(--safe-area-top))' }}
      >
        <div className="rail-tile">
          <button
            type="button"
            aria-label="Direct Messages"
            onClick={() => onSelectGuild(null)}
            className={cn(
              'flex size-12 items-center justify-center rounded-3xl transition-all',
              isDmMode ? 'rounded-2xl bg-accent text-accent-foreground' : 'bg-surface text-muted active:bg-surface-tertiary',
            )}
          >
            <TeliumMark className="size-7" gradient={isDmMode} />
          </button>
          <span
            aria-hidden
            className="rail-pill"
            data-state={isDmMode ? 'active' : dmBadge > 0 ? 'unread' : 'none'}
          />
          <Badge count={dmBadge} className="pointer-events-none absolute -top-1 -end-1" />
        </div>

        <div className="mx-3 my-1 h-px w-8 bg-border/60" />

        {ids.map((id) => {
          const guild = store.guilds.get(id);
          const { unread, mentions } = store.guildUnread(id);
          const isSelected = selectedGuildId === id;
          return (
            <div key={id} className="rail-tile">
              <button
                type="button"
                aria-label={guild?.name || 'Guild'}
                onClick={() => onSelectGuild(id)}
                className="flex size-12 items-center justify-center transition-all"
              >
                <div className={cn('size-12 overflow-hidden transition-all', isSelected ? 'rounded-2xl' : 'rounded-3xl hover:rounded-2xl')}>
                  <GuildFace guild={guild} size="size-12" className="text-base font-bold" />
                </div>
              </button>
              <span
                aria-hidden
                className="rail-pill"
                data-state={isSelected ? 'active' : unread > 0 ? 'unread' : 'none'}
              />
              <Badge count={mentions} className="pointer-events-none absolute -top-1 -end-1" />
            </div>
          );
        })}

        <button
          type="button"
          aria-label="Add server"
          onClick={() => {
            onClose();
            modal.open((c) => <AddGuildDialog close={c} />);
          }}
          className="flex size-12 items-center justify-center rounded-3xl bg-surface text-emerald-500 transition-all active:rounded-2xl active:bg-emerald-500 active:text-white"
        >
          <PlusIcon className="size-6" />
        </button>
      </div>

      <div
        className="flex min-w-0 flex-1 flex-col overflow-hidden bg-rail"
        style={{ paddingTop: 'max(0.75rem, var(--safe-area-top))' }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto" data-mobile-scroll>
          {isDmMode ? (
            <MobileDmPanel onClose={onClose} onSelectConversation={onClose} />
          ) : (
            <MobileChannelPanel guildId={selectedGuildId} close={onClose} onSelectChannel={onClose} />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-strip px-2 py-2" style={{ paddingBottom: 'max(0.5rem, var(--safe-area-bottom))' }}>
          <button
            type="button"
            aria-label="Open account and status menu"
            onClick={() => setAccountOpen(true)}
            className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1.5 text-start active:bg-rail-hover"
          >
            <Avatar
              id={me?.user_id}
              name={myName}
              size="sm"
              mediaRef={myFace?.avatarRef}
              base={myFace?.base}
              mediaOrigin={myFace?.mediaOrigin}
              presence={myPresence}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold leading-6 text-foreground"><EmojiText>{myName}</EmojiText></p>
              <p className="h-[18px] truncate text-xs leading-[1.125rem] text-muted [&_.emoji]:size-[1.15em] [&_.emoji]:align-[-0.25em]">
                {myStatus
                  ? <StatusText store={store}>{myStatus}</StatusText>
                  : (MOBILE_PRESENCE_LABEL[myPresence] || myHandle)}
              </p>
            </div>
          </button>
          <button
            type="button"
            aria-label="User settings"
            onClick={() => {
              onClose();
              modal.open((c) => <UserSettings close={c} />, { fullscreen: true });
            }}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted active:bg-surface-tertiary"
          >
            <SettingsIcon className="size-5" />
          </button>
        </div>

        {accountOpen ? (
          <MobileActionSheet title={myName || 'Account'} onClose={() => setAccountOpen(false)}>
            {menus.account()}
          </MobileActionSheet>
        ) : null}
      </div>
    </div>
  );
}
