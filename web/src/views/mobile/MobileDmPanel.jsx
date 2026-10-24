import { useMemo, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { useConversationPeer } from '../../hooks/useConversationPeer.js';
import { cn } from '../../lib/cn.js';
import {
  Avatar, Badge, CloseIcon, EmojiText, GroupAvatar, MembersIcon, MessageIcon, PlusIcon, SearchField, StatusLine
} from '../../components/index.js';
import { conversationTitle, dmPeer } from '../../lib/conversations.js';
import { NewConversationDialog } from '../dialogs/NewConversationDialog.jsx';
import { MessageRequestsDialog } from '../dialogs/MessageRequestsDialog.jsx';
import { useMenus } from '../menus.jsx';
import { MobileContextMenu } from './MobileActionSheet.jsx';

export function MobileDmPanel({ onSelectConversation, onClose }) {
  const store = useStore();
  const modal = useModal();
  useStoreEvent('conversations', 'friends', 'presence', 'unread', 'route');
  const route = store.route;
  const pending = store.pendingFriendCount?.() || 0;
  const messageRequests = store.pendingMessageRequestCount?.() || 0;
  const [searchQuery, setSearchQuery] = useState('');

  const filteredConversations = useMemo(() => {
    const visible = store.conversations
      .filter((convo) => convo.request_state !== 'pending')
      .slice()
      .sort((a, b) => (
        (b.last_activity_at || b.created_at || 0)
        - (a.last_activity_at || a.created_at || 0)
      ));
    if (!searchQuery.trim()) return visible;
    const q = searchQuery.toLowerCase();
    return visible.filter((convo) => {
      const peers = (convo.members || []).map((m) => m.user_id || m).filter((id) => id && id !== store.me?.user_id);
      const peer = convo.kind === 'dm' ? dmPeer(store, peers[0]) : null;
      const title = peer?.name || conversationTitle(store, convo);
      return title?.toLowerCase().includes(q);
    });
  }, [store.conversations, searchQuery, store]);

  const openConversation = (convoId) => {
    store.navigate({ view: 'dms', conversationId: convoId });
    onSelectConversation();
  };

  return (
    <div className="mobile-dm-panel flex min-h-full flex-col">
      <div className="flex min-h-12 items-center gap-2 px-3 pt-1">
        <h2 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight text-foreground">
          Messages
        </h2>
        <button
          type="button"
          aria-label="New conversation"
          onClick={() => {
            onSelectConversation?.();
            modal.open((close) => <NewConversationDialog close={close} />, { wide: true });
          }}
          className="mobile-touch-target flex size-10 items-center justify-center rounded-xl text-muted active:bg-surface-tertiary active:text-foreground"
        >
          <PlusIcon className="size-5" />
        </button>
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="mobile-touch-target flex size-10 items-center justify-center rounded-xl text-muted active:bg-surface-tertiary active:text-foreground"
        >
          <CloseIcon className="size-5" />
        </button>
      </div>

      <div className="px-3 pt-1 pb-2">
        <SearchField
          label="Find a conversation"
          placeholder="Find a conversation"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          size="base"
          className="min-h-11 rounded-xl border-0 bg-surface"
        />
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            store.navigate({ view: 'dms', guildId: null, channelId: null, conversationId: null });
            onSelectConversation();
          }}
          className={cn(
            'flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-start transition-colors',
            route.view === 'dms' && !route.conversationId
              ? 'bg-accent/15 text-accent'
              : 'active:bg-surface-tertiary text-foreground',
          )}
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-accent/20 text-accent">
            <MembersIcon className="size-5" />
          </span>
          <span className="min-w-0 flex-1 font-semibold text-base">Friends</span>
          <Badge count={pending} />
        </button>
      </div>

      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => {
            onSelectConversation?.();
            modal.open((close) => <MessageRequestsDialog close={close} />, { wide: true });
          }}
          className="flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-start text-foreground transition-colors active:bg-surface-tertiary"
        >
          <span className="flex size-9 items-center justify-center rounded-full bg-surface text-muted">
            <MessageIcon className="size-5" />
          </span>
          <span className="min-w-0 flex-1 font-semibold text-base">Message requests</span>
          <Badge count={messageRequests} />
        </button>
      </div>

      <div className="px-3">
        <div className="eyebrow px-1 pb-1.5 text-muted">Direct Messages</div>
        {filteredConversations.length ? filteredConversations.map((convo) => (
          <MobileConversationRow
            key={convo.id}
            convo={convo}
            onClick={openConversation}
            isActive={route.conversationId === convo.id}
          />
        )) : (
          <div className="mx-1 rounded-2xl border border-dashed border-border px-4 py-6 text-center">
            <p className="text-sm font-semibold text-foreground">
              {searchQuery ? 'No conversations found.' : 'Your inbox is quiet.'}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              {searchQuery ? 'Try a different name.' : 'Start a conversation with someone from your friends list.'}
            </p>
            {!searchQuery ? (
              <button
                type="button"
                onClick={() => {
                  onSelectConversation?.();
                  modal.open((close) => <NewConversationDialog close={close} />, { wide: true });
                }}
                className="mt-4 min-h-10 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-foreground active:opacity-80"
              >
                Start a conversation
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function MobileConversationRow({ convo, onClick, isActive = false }) {
  const store = useStore();
  const menus = useMenus();
  const { peer, faces, title, peerTyping } = useConversationPeer(convo);
  const unread = store.dmUnreadFor(convo.id);

  return (
    <MobileContextMenu content={() => menus.conversation(convo)} title={title}>
      <button
        type="button"
        onClick={() => onClick?.(convo.id)}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'flex min-h-[60px] w-full items-center gap-3 rounded-xl px-2.5 py-2 text-start transition-colors active:bg-surface-tertiary',
          isActive ? 'bg-surface-secondary shadow-sm' : '',
        )}
      >
        {peer ? (
          <Avatar
            id={peer.id}
            name={peer.name}
            size="md"
            mediaRef={peer.avatarRef}
            base={peer.base}
            mediaOrigin={peer.mediaOrigin}
            presence={peer.presence}
            typing={peerTyping}
          />
        ) : (
          <GroupAvatar faces={faces} size="md" />
        )}
        <div className="min-w-0 flex-1">
          <span className={cn('block truncate text-base text-foreground', unread ? 'font-bold' : 'font-medium')}><EmojiText>{title}</EmojiText></span>
          <StatusLine
            presence={peer?.live}
            store={store}
            className={cn('block truncate text-xs', unread ? 'text-foreground/75' : 'text-muted')}
          />
        </div>
        <Badge count={unread} />
      </button>
    </MobileContextMenu>
  );
}
