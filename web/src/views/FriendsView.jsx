import { useState } from 'react';
import { cn } from '../lib/cn.js';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { reportError, toast } from '../hooks/useToast.jsx';
import { faceOf } from '../lib/faces.js';
import { shortName } from '../lib/util.js';
import {
  Avatar, BanIcon, Button, CheckIcon, CloseIcon, ContextMenu, EmojiText, EmptyState,
  IconButton, MembersIcon, MessageIcon, MoreIcon, Pill, RemoveFriendIcon, StatusLine,
  TeliumMark, TextInput
} from '../components/index.js';
import { useMenus } from './menus.jsx';
import { useProfileCard } from '../hooks/useProfileCard.js';
import { MobileActionSheet, MobileContextMenu, MobileTopbar } from './mobile/MobileNavigation.jsx';

const TABS = [
  ['online', 'Online'],
  ['all', 'All'],
  ['pending', 'Pending'],
  ['blocked', 'Blocked'],
];

const EMPTY = {
  online: 'None of your friends are online right now.',
  all: 'Add someone by their full ID to get started.',
  pending: 'No requests waiting, in either direction.',
  blocked: 'Nobody is blocked.',
};

export function FriendsView({ mobile = false, onMore }) {
  const store = useStore();
  useStoreEvent('friends', 'presence');
  const [tab, setTab] = useState('online');

  const accepted = store.friendsIn('accepted');
  const groups = {
    online: [['Online', accepted.filter((f) => store.statusOf(f.user_id) !== 'offline')]],
    all: [['All', accepted]],
    pending: [
      ['Waiting on you', store.friendsIn('pending_in')],
      ['Waiting on them', store.friendsIn('pending_out')],
    ],
    blocked: [['Blocked', store.friendsIn('blocked')]],
  }[tab].filter(([, rows]) => rows.length);

  const pending = store.pendingFriendCount();

  return (
    <div className={`flex min-w-0 flex-1 flex-col${mobile ? ' page-in mobile-friends-view' : ''}`}>
      {mobile ? (
        <>
          <MobileTopbar title="Friends" onMenu={onMore} />
          <nav
            data-mobile-scroll
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-2 overscroll-contain"
          >
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-pressed={tab === key}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-row px-3.5 py-1.5 text-sm',
                  'text-muted transition-[background-color,color] duration-[--dur-2] ease-[--ease]',
                  tab === key
                    ? 'bg-surface-secondary font-medium text-foreground'
                    : 'active:bg-surface-tertiary',
                )}
              >
                {label}
                {key === 'pending' && pending ? <Pill tone="danger">{String(pending)}</Pill> : null}
              </button>
            ))}
          </nav>
        </>
      ) : (
      <header className="topbar flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="flex items-center gap-2">
          <TeliumMark className="size-4.5" />
          <h1 className="shrink-0 text-base font-semibold tracking-tight">Friends</h1>
        </div>
        <span className="h-4 w-px shrink-0 bg-border" />
        <nav className="flex min-w-0 flex-1 items-center gap-1">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              aria-pressed={tab === key}
              className={cn(
                'flex items-center gap-1.5 rounded-row px-3 py-1 text-sm',
                'text-muted transition-[background-color,color] duration-[--dur-2] ease-[--ease]',
                tab === key
                  ? 'bg-surface-secondary font-medium text-foreground'
                  : 'hover:bg-rail-hover hover:text-foreground',
              )}
            >
              {label}
              {key === 'pending' && pending ? <Pill tone="danger">{String(pending)}</Pill> : null}
            </button>
          ))}
        </nav>
      </header>
      )}

      <div data-mobile-scroll={mobile ? '' : undefined} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <AddFriend mobile={mobile} />
        {groups.length ? (
          <div className="flex flex-col px-3 pb-6">
            {groups.map(([label, rows]) => (
              <div key={label} className="flex flex-col gap-px">
                <div className="eyebrow px-2 pt-2 pb-1">{`${label} - ${rows.length}`}</div>
                {rows.map((f) => <FriendRow key={f.user_id} friend={f} mobile={mobile} />)}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={MembersIcon} title="Nothing here yet">{EMPTY[tab]}</EmptyState>
        )}
      </div>
    </div>
  );
}

function AddFriend({ mobile = false }) {
  const store = useStore();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const id = value.trim();
    if (!id || busy) return;
    setBusy(true);
    try {
      const row = await store.addFriend(id);
      toast(row.state === 'accepted'
        ? `You and ${shortName(id)} are now friends.`
        : 'Request sent.');
      setValue('');
    } catch (e) {
      reportError(e, 'Could not send that request');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className={cn(
        'flex shrink-0 gap-2 border-b border-border px-4 py-3',
        mobile ? 'flex-col items-stretch' : 'items-center',
      )}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <TextInput
        aria-label="Add friend"
        placeholder="Add a friend with their ID, like @alice:example.org"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={cn('min-w-0 flex-1', !mobile && 'max-w-xl')}
      />
      <Button
        type="submit"
        variant="primary"
        className={mobile ? 'min-h-11 w-full rounded-xl' : 'shrink-0'}
        disabled={busy || !value.trim()}
      >
        Send request
      </Button>
    </form>
  );
}

function FriendRow({ friend, mobile = false }) {
  const store = useStore();
  const menus = useMenus();
  const profiles = useProfileCard();
  const id = friend.user_id;
  const status = store.statusOf(id);
  const presence = store.presence.get(id) || friend.presence || {};
  const accepted = friend.state === 'accepted';
  const face = faceOf(store, id);
  const [actionsOpen, setActionsOpen] = useState(false);

  const act = (what, run) => async () => {
    try { await run(); } catch (e) { reportError(e, what); }
  };

  const message = act('Could not open a conversation', async () => {
    const convo = await store.startConversation([id]);
    store.navigate({ view: 'dms', conversationId: convo.id });
  });

  const ContextWrapper = mobile ? MobileContextMenu : ContextMenu;

  return (
    <>
      <ContextWrapper content={() => menus.friend(friend)}>
        <div
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors',
            mobile ? 'min-h-12 active:bg-rail-hover' : 'hover:bg-rail-hover',
            accepted && status === 'offline' && 'opacity-60',
          )}
        >
        <button
          type="button"
          onClick={accepted ? message : (e) => profiles.open(id, { anchor: e.currentTarget })}
          onPointerEnter={() => profiles.prefetch(id)}
          onPointerLeave={profiles.cancel}
          aria-haspopup={accepted ? undefined : 'dialog'}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
        >
          <Avatar
            id={id}
            name={friend.display_name}
            size="sm"
            mediaRef={face?.avatarRef}
            base={face?.base}
            mediaOrigin={face?.mediaOrigin}
            presence={accepted ? status : null}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base text-foreground">
              <EmojiText>{friend.display_name || shortName(id)}</EmojiText>
            </span>
            <StatusLine
              presence={presence}
              store={store}
              fallback={id}
              className="block truncate text-xs text-muted [&_.emoji]:size-[1.15em] [&_.emoji]:align-[-0.25em]"
            />
          </span>
        </button>

          <div className="flex shrink-0 items-center gap-0.5">
            {accepted ? (
              <IconButton
                title="Message"
                className={mobile ? 'size-10 rounded-xl' : undefined}
                onClick={message}
              >
                <MessageIcon />
              </IconButton>
            ) : null}
            {friend.state === 'pending_in' ? (
              <IconButton
                title="Accept"
                className={mobile ? 'size-10 rounded-xl' : undefined}
                onClick={act('Could not accept', () => store.acceptFriend(id))}
              >
                <CheckIcon />
              </IconButton>
            ) : null}
            {friend.state === 'blocked' ? (
              <IconButton
                title="Unblock"
                className={mobile ? 'size-10 rounded-xl' : undefined}
                onClick={act('Could not unblock', () => store.unblockUser(id))}
              >
                <CloseIcon />
              </IconButton>
            ) : null}

            {mobile ? (
              <IconButton
                title="More friend actions"
                className="size-10 rounded-xl"
                onClick={() => setActionsOpen(true)}
              >
                <MoreIcon />
              </IconButton>
            ) : friend.state === 'blocked' ? null : (
              <>
                <IconButton
                  title={accepted ? 'Remove friend' : friend.state === 'pending_in' ? 'Decline' : 'Cancel'}
                  onClick={act('Could not update that', () => store.removeFriend(id))}
                >
                  {accepted ? <RemoveFriendIcon /> : <CloseIcon />}
                </IconButton>
                <IconButton title="Block" onClick={act('Could not block', () => store.blockUser(id))}>
                  <BanIcon />
                </IconButton>
              </>
            )}
          </div>
        </div>
      </ContextWrapper>

      {mobile && actionsOpen ? (
        <MobileActionSheet
          title={friend.display_name || shortName(id)}
          onClose={() => setActionsOpen(false)}
        >
          {menus.friend(friend)}
        </MobileActionSheet>
      ) : null}
    </>
  );
}
