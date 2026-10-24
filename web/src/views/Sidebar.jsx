import { useCallback, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { useDragRoot } from '../hooks/useDragRoot.js';
import { useModal } from '../hooks/useModal.jsx';
import { useConversationPeer } from '../hooks/useConversationPeer.js';
import { useProfileCard } from '../hooks/useProfileCard.js';
import { reportError } from '../hooks/useToast.jsx';
import {
  channelGlyph, channelMoves, channelRoute, channelTree, isPrivate, moveCategory, moveChannel,
} from '../lib/channels.js';
import { Status } from '../lib/gateway.js';
import { conversationTitle, dmPeer } from '../lib/conversations.js';
import { faceOf } from '../lib/faces.js';
import { remoteMediaOrigin } from '../lib/media.js';
import { participants, shortName, statusLine } from '../lib/util.js';
import {
  Avatar, Badge, ChevronDownIcon, ChevronRightIcon,
  ContextMenu, DeafenIcon, EmojiText, IconButton, LockIcon,
  MembersIcon, MenuButton, MenuSlider, MenuSeparator, MessageIcon, MicOffIcon,
  Pill, PlusIcon, Reorder, ScreenIcon, SettingsIcon, StatusLine, StatusText, ThreadIcon,
  useReorderItem,
} from '../components/index.js';
import { useMenus } from './menus.jsx';
import { VoiceStatusLine } from './dialogs/VoiceStatusDialog.jsx';
import { CreateChannelDialog } from './dialogs/CreateChannelDialog.jsx';
import { NewConversationDialog } from './dialogs/NewConversationDialog.jsx';
import { MessageRequestsDialog } from './dialogs/MessageRequestsDialog.jsx';
import { UserSettings } from './settings.jsx';
import { VoiceBar } from './VoiceBar.jsx';

const FRAME = 'flex w-[248px] shrink-0 flex-col bg-rail [--presence-ring:var(--rail)]';
const HEAD = 'flex h-12 shrink-0 items-center gap-1 px-2';
const BODY = 'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2';
const VOICE_MEMBER = 'telium/voice-member';
const VOICE_SHOWN = 5;

export function Sidebar() {
  const store = useStore();
  useStoreEvent('guilds', 'channels', 'threads', 'unread', 'status', 'conversations', 'route', 'voice', 'prefs', 'friends');
  const route = store.route;

  if (route.view === 'dms') return <DmSidebar />;

  const guild = store.guilds.get(route.guildId);
  if (!guild) {
    return (
      <div className={FRAME}>
        <div className={HEAD}>
          <span className="truncate px-2 text-lg font-semibold tracking-tight">Telium</span>
        </div>
        <div className={BODY}>
          <p className="px-2 py-6 text-center text-sm leading-[1.6] text-muted">
            Join or create a guild to get started.
          </p>
        </div>
        <VoiceBar />
      <UserBar />
      </div>
    );
  }
  return <GuildSidebar guild={guild} />;
}

function GuildSidebar({ guild }) {
  const store = useStore();
  const menus = useMenus();
  const status = store.gw.statusOf(guild.domain);
  const [setRoot, manager] = useDragRoot();
  const bodyRef = useRef(null);
  const setBody = useCallback((node) => {
    bodyRef.current = node;
    setRoot(node);
  }, [setRoot]);
  const mayManage = store.canInGuild(guild.id, 'MANAGE_CHANNELS');

  const tree = channelTree(store.channelsOf(guild.id));

  const toggle = (categoryId) => {
    store.prefs.collapsed[categoryId] = !store.prefs.collapsed[categoryId];
    store.savePrefs();
  };

  const arrange = async (next) => {
    const moves = channelMoves(next);
    if (!moves.length) return;
    const undo = moves.map(({ id }) => {
      const ch = store.channels.get(id);
      return { id, position: ch?.position, parent_id: ch?.parent_id };
    });
    const apply = (rows) => {
      for (const row of rows) {
        const ch = store.channels.get(row.id);
        if (ch) store.channels.set(row.id, { ...ch, position: row.position, parent_id: row.parent_id });
      }
      store.emit('channels', guild.id);
    };
    apply(moves);
    try {
      await store.apiForGuild(guild.id).reorderChannels(guild.id, moves);
    } catch (e) {
      apply(undo);
      reportError(e, 'Could not move the channel');
    }
  };

  const drop = ({ source, entries, index }) => {
    if (source.kind === 'category') {
      let at = 0;
      for (let i = 0; i < index; i += 1) if (entries[i].kind === 'category') at += 1;
      arrange(moveCategory(tree, source.id, at));
      return;
    }
    let parent = null;
    for (let i = index - 1; i >= 0; i -= 1) {
      const row = entries[i];
      if (row.kind === 'category') { parent = row.id; break; }
      if (row.kind === 'channel') { parent = row.parent; break; }
    }
    let at = 0;
    for (let i = 0; i < index; i += 1) {
      const row = entries[i];
      if (row.kind === 'channel' && row.parent === parent) at += 1;
    }
    arrange(moveChannel(tree, source.id, parent, at));
  };

  const hold = (target) => {
    if (target?.kind !== 'category') return;
    if (!store.prefs.collapsed[target.id]) return;
    toggle(target.id);
  };

  const hasAny = tree.loose.length || tree.groups.length;

  const list = (
    <>
      {tree.loose.map((ch) => (
        <ChannelRow key={ch.id} channel={ch} parentId={null} mayManage={mayManage} />
      ))}
      {tree.groups.map((group) => {
        const collapsed = store.prefs.collapsed[group.category.id];
        return (
          <div key={group.category.id} className="pt-3 first:pt-1">
            <CategoryRow
              group={group}
              collapsed={collapsed}
              onToggle={() => toggle(group.category.id)}
              mayManage={mayManage}
            />
            {collapsed ? null : group.items.map((ch) => (
              <ChannelRow
                key={ch.id}
                channel={ch}
                parentId={group.category.id}
                mayManage={mayManage}
              />
            ))}
          </div>
        );
      })}
    </>
  );

  return (
    <div className={FRAME}>
      <ContextMenu content={() => menus.guild(guild)}>
        <div className={HEAD}>
          <MenuButton
            label="Guild menu"
            placement="bottom start"
            className="nav-row nav-row--fit group min-w-0 shrink text-lg font-semibold tracking-tight hover:bg-rail-hover"
            content={menus.guild(guild)}
          >
            <span className="min-w-0 truncate"><EmojiText>{guild.name}</EmojiText></span>
            <ChevronDownIcon className="size-4 shrink-0 text-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] group-hover:text-foreground" />
          </MenuButton>
          {status !== Status.Ready ? <Pill tone="warn">{status}</Pill> : null}
        </div>
      </ContextMenu>
      <div ref={setBody} className={BODY}>
        <ContextMenu content={() => menus.guild(guild)}>
          <Reorder
            scroller={bodyRef}
            disabled={!mayManage}
            onDrop={drop}
            onHold={hold}
            className="flex grow flex-col gap-0.5"
          >
            {!hasAny ? (
              <p className="px-2 py-6 text-center text-sm leading-[1.6] text-muted">
                No channels you can see here.
              </p>
            ) : manager ? (
              <DndProvider manager={manager}>{list}</DndProvider>
            ) : null}
          </Reorder>
        </ContextMenu>
      </div>
      <VoiceBar />
      <UserBar />
    </div>
  );
}

function Row({ active, indent, person, muted, unread, onClick, onContextMenu, children, ...rest }) {
  const note = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-describedby={unread && !active ? note : undefined}
      aria-current={active ? 'page' : undefined}
      {...rest}
      className={cn(
        'nav-row text-muted',
        indent && 'nav-row--indent',
        muted && !active && 'nav-row--muted',
        person && 'nav-row--person',
        !active && 'hover:bg-rail-hover hover:text-foreground active:bg-rail-active',
        unread && !active && 'font-medium text-foreground',
        active && 'bg-accent-soft font-medium text-accent-soft-foreground',
      )}
    >
      {children}
      <span id={note} aria-hidden="true" className="sr-only">{unread && !active ? 'Unread' : ''}</span>
    </button>
  );
}

function ChannelRow({ channel, parentId, mayManage }) {
  const store = useStore();
  const { ref: dragRef, dragProps } = useReorderItem(mayManage ? {
    key: channel.id,
    kind: 'channel',
    id: channel.id,
    parent: parentId || null,
    group: parentId || null,
    carries: channel.id,
  } : null);
  const voice = useVoice();
  useStoreEventFor((guildId) => guildId === channel.guild_id, 'members');
  const menus = useMenus();
  const [pressed, setPressed] = useState(false);
  const routed = store.route.channelId === channel.id;
  if (pressed && !routed && store.route.channelId) setPressed(false);
  const active = routed || pressed;
  const state = store.unreadFor(channel.id);
  const muted = store.isMuted(channel.id);

  const unarchived = (store.threads.get(channel.id) || []).filter((t) => !t.archived);
  const threads = channel.type === 'forum'
    ? unarchived.filter((t) => t.id === store.route.channelId)
    : unarchived;
  const showThreads = active || threads.some((t) => t.id === store.route.channelId);
  const inCall = channel.type === 'voice' ? (store.voice.get(channel.id) || []) : [];
  const guildBase = store.apiForGuild(channel.guild_id)?.base || null;
  const members = store.members.get(channel.guild_id);
  const Glyph = channelGlyph(channel);
  const mayMoveVoice = channel.type === 'voice'
    && store.canInGuild(channel.guild_id, 'MOVE_MEMBERS');
  const voiceDropRef = useRef(null);
  const [everyone, setEveryone] = useState(false);
  const folded = !everyone && inCall.length > VOICE_SHOWN + 1;
  const shown = folded ? inCall.slice(0, VOICE_SHOWN) : inCall;

  const content = () => menus.channel(channel);
  const open = () => {
    setPressed(true);
    store.navigate(channelRoute(channel));
    if (channel.type === 'voice' && voice.channelId !== channel.id) voice.join(channel.id);
  };
  const openChat = () => {
    setPressed(true);
    store.navigate({ ...channelRoute(channel), chat: true });
  };

  const moveVoiceMember = async (item) => {
    if (
      !mayMoveVoice
      || !item?.userId
      || item.guildId !== channel.guild_id
      || item.channelId === channel.id
    ) return;

    try {
      await store.apiForGuild(channel.guild_id).voiceModerate(
        channel.guild_id,
        item.userId,
        { channel_id: channel.id },
      );

      const from = store.voice.get(item.channelId) || [];
      const state = from.find((row) => row.user_id === item.userId);
      if (state) {
        store.voice.set(item.channelId, from.filter((row) => row.user_id !== item.userId));
        const into = (store.voice.get(channel.id) || [])
          .filter((row) => row.user_id !== item.userId);
        into.push({
          ...state,
          channel_id: channel.id,
          streaming: false,
          stream_preset: null,
        });
        store.voice.set(channel.id, into);
        store.emit('voice', item.channelId);
        store.emit('voice', channel.id);
      }
    } catch (e) {
      reportError(e, 'Could not move that member');
    }
  };

  const [{ voiceOver }, voiceDrop] = useDrop({
    accept: VOICE_MEMBER,
    canDrop: (item) => Boolean(
      mayMoveVoice
      && item?.guildId === channel.guild_id
      && item?.channelId !== channel.id
    ),
    drop: (item) => moveVoiceMember(item),
    collect: (monitor) => ({
      voiceOver: monitor.isOver({ shallow: true }) && monitor.canDrop(),
    }),
  }, [mayMoveVoice, channel.id, channel.guild_id, store]);
  voiceDrop(voiceDropRef);

  const voiceMenu = (v) => {
    const base = menus.voice(v, channel.guild_id);
    if (v.user_id === store.me?.user_id) return base;
    const current = voice.volumeFor?.(v.user_id) ?? 100;
    return (
      <>
        {base}
        <MenuSeparator />
        <MenuSlider
          label="Volume"
          value={current}
          max={200}
          onChange={(value) => voice.setUserVolume?.(v.user_id, value)}
        />
      </>
    );
  };

  return (
    <div>
      <div
        ref={voiceDropRef}
        className={cn(
          'rounded-row',
          voiceOver && 'bg-accent/10 ring-1 ring-inset ring-accent/60',
        )}
      >
      <div
        ref={dragRef}
        onPointerDown={dragProps.onPointerDown}
        onKeyDown={dragProps.onKeyDown}
        className={cn('group/row relative', dragProps.className)}
      >
        <ContextMenu content={content}>
          <Row
            active={active}
            muted={muted}
            unread={state.unread && !muted}
            onClick={open}
          >
            <Glyph className="size-4 shrink-0 opacity-70" />
            <span className="min-w-0 flex-1 truncate"><EmojiText>{channel.name}</EmojiText></span>
            {isPrivate(channel) ? (
              <span className="flex shrink-0 items-center text-muted" title="Private channel">
                <LockIcon className="size-3.5" />
                <span className="sr-only">Private</span>
              </span>
            ) : null}
            <Badge count={!muted ? state.mentions : 0} />
            <span className={channel.type === 'voice' ? 'w-[52px] shrink-0' : 'size-5 shrink-0'} aria-hidden />
          </Row>
        </ContextMenu>
        {channel.type === 'voice' ? (
          <button
            type="button"
            title={`Open chat in ${channel.name}`}
            aria-label={`Open chat in ${channel.name}`}
            onClick={openChat}
            className="pointer-events-none absolute end-8 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,background-color,color] duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-rail-active hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100"
          >
            <MessageIcon className="size-3.5" />
          </button>
        ) : null}
        <MenuButton
          label={`${channel.name} settings`}
          placement="bottom end"
          className="pointer-events-none absolute end-2 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,background-color,color] duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-rail-active hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/row:pointer-events-auto group-hover/row:opacity-100 data-[popup-open]:pointer-events-auto data-[popup-open]:opacity-100"
          content={content()}
        >
          <SettingsIcon className="size-3.5" />
        </MenuButton>
      </div>
      </div>

      {channel.type === 'voice' && channel.voice_status ? (
        <VoiceStatusRow channel={channel} mayManage={mayManage} />
      ) : null}

      {showThreads ? threads.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} channel={channel} mayManage={mayManage} />
      )) : null}

      {shown.map((v) => (
        <VoiceParticipantRow
          key={v.user_id}
          state={v}
          channel={channel}
          member={members?.get(v.user_id)}
          guildBase={guildBase}
          mayMove={mayMoveVoice}
          mayManage={mayManage}
          speaking={voice.channelId === channel.id && voice.speaking.has(v.user_id)}
          menu={() => voiceMenu(v)}
        />
      ))}
      {folded || (everyone && inCall.length > VOICE_SHOWN + 1) ? (
        <VoiceOverflowRow
          channel={channel}
          mayManage={mayManage}
          hidden={folded ? inCall.length - VOICE_SHOWN : 0}
          onToggle={() => setEveryone((on) => !on)}
        />
      ) : null}
    </div>
  );
}

function VoiceStatusRow({ channel, mayManage }) {
  const { ref: cargoRef, dragProps } = useReorderItem(mayManage ? {
    key: `voice-status:${channel.id}`,
    kind: 'voice',
    id: `status:${channel.id}`,
    group: channel.id,
    carried: true,
  } : null);
  return (
    <div
      ref={cargoRef}
      className={cn('nav-row--indent pe-2 ps-9', dragProps.className)}
      title={channel.voice_status}
    >
      <VoiceStatusLine channel={channel} className="block" />
    </div>
  );
}

function VoiceOverflowRow({ channel, mayManage, hidden, onToggle }) {
  const { ref: cargoRef, dragProps } = useReorderItem(mayManage ? {
    key: `voice-more:${channel.id}`,
    kind: 'voice',
    id: `more:${channel.id}`,
    group: channel.id,
    carried: true,
  } : null);
  return (
    <div ref={cargoRef} className={dragProps.className}>
      <Row indent onClick={onToggle} aria-expanded={!hidden}>
        <span className="min-w-0 flex-1 truncate text-xs">
          {hidden ? `+${hidden} more` : 'Show fewer'}
        </span>
      </Row>
    </div>
  );
}

function ThreadRow({ thread, channel, mayManage }) {
  const store = useStore();
  const { ref: dragRef, dragProps } = useReorderItem(mayManage ? {
    key: thread.id,
    kind: 'thread',
    id: thread.id,
    group: channel.id,
    carried: true,
  } : null);

  return (
    <div ref={dragRef} className={dragProps.className}>
      <Row
        indent
        active={store.route.channelId === thread.id}
        onClick={() => {
          store.channels.set(thread.id, {
            id: thread.id, name: thread.title, type: 'thread', parent_id: channel.id,
            guild_id: channel.guild_id, domain: channel.domain,
          });
          store.navigate({ view: 'chat', channelId: thread.id });
        }}
      >
        <ThreadIcon className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate"><EmojiText>{thread.title}</EmojiText></span>
      </Row>
    </div>
  );
}

function VoiceParticipantRow({
  state, channel, member, guildBase, mayMove, mayManage, speaking, menu,
}) {
  const store = useStore();
  const profiles = useProfileCard();
  const { ref: cargoRef, dragProps } = useReorderItem(mayManage ? {
    key: `voice:${channel.id}:${state.user_id}`,
    kind: 'voice',
    id: state.user_id,
    group: channel.id,
    carried: true,
  } : null);
  const ref = useRef(null);
  const [{ dragging }, drag] = useDrag({
    type: VOICE_MEMBER,
    item: {
      userId: state.user_id,
      guildId: channel.guild_id,
      channelId: channel.id,
    },
    canDrag: mayMove,
    collect: (monitor) => ({ dragging: monitor.isDragging() }),
  }, [state.user_id, channel.guild_id, channel.id, mayMove]);
  drag(ref);

  const face = faceOf(store, state.user_id, { guildId: channel.guild_id });
  const mediaRef = face?.avatarRef || state.avatar_ref || null;
  const mediaBase = face?.avatarRef ? face.base : (state.avatar_ref ? guildBase : null);
  const mediaOrigin = face?.avatarRef
    ? face.mediaOrigin
    : (state.avatar_ref ? remoteMediaOrigin(state.user_id, channel.domain) : null);

  return (
    <div ref={cargoRef} className={dragProps.className}>
    <ContextMenu content={menu}>
      <button
        ref={ref}
        type="button"
        data-voice-participant={state.user_id}
        title={mayMove ? 'Drag to another voice channel' : undefined}
        onClick={(e) => profiles.open(state.user_id, {
          guildId: channel.guild_id,
          anchor: e.currentTarget,
        })}
        onPointerEnter={() => profiles.prefetch(state.user_id)}
        onPointerLeave={profiles.cancel}
        aria-label={`Open ${shortName(state.user_id)}'s profile`}
        className={cn(
          'nav-row nav-row--indent w-full text-muted',
          'hover:bg-rail-hover hover:text-foreground',
          mayMove && 'cursor-grab active:cursor-grabbing',
          dragging && 'opacity-40',
        )}
      >
        <Avatar
          id={state.user_id}
          name={member?.display_name}
          size="xs"
          mediaRef={mediaRef}
          base={mediaBase}
          mediaOrigin={mediaOrigin}
          className={cn('voice-face', speaking && 'is-talking')}
        />
        <span className="min-w-0 flex-1 truncate">{shortName(state.user_id)}</span>
        {state.streaming ? (
          <span className="flex shrink-0 items-center text-accent" title="Sharing their screen">
            <ScreenIcon className="size-3.5" />
            <span className="sr-only">Sharing their screen</span>
          </span>
        ) : null}
        {state.self_deaf || state.server_deaf ? (
          <span className="flex shrink-0 items-center" title="Deafened">
            <DeafenIcon className="size-3.5" />
            <span className="sr-only">Deafened</span>
          </span>
        ) : state.self_mute || state.server_mute ? (
          <span className="flex shrink-0 items-center" title="Muted">
            <MicOffIcon className="size-3.5" />
            <span className="sr-only">Muted</span>
          </span>
        ) : null}
      </button>
    </ContextMenu>
    </div>
  );
}

function CategoryRow({ group, collapsed, onToggle, mayManage: mayDrag }) {
  const store = useStore();
  const menus = useMenus();
  const modal = useModal();
  const category = group.category;
  const { ref: dragRef, dragProps } = useReorderItem(mayDrag ? {
    key: category.id,
    kind: 'category',
    id: category.id,
    group: category.id,
    leader: true,
  } : null);
  const guild = store.guilds.get(category.guild_id);
  const mayManage = store.canInGuild(category.guild_id, 'MANAGE_CHANNELS');
  const Chevron = collapsed ? ChevronRightIcon : ChevronDownIcon;

  return (
    <div
      ref={dragRef}
      onPointerDown={dragProps.onPointerDown}
      onKeyDown={dragProps.onKeyDown}
      className={cn('group/row relative flex items-center', dragProps.className)}
    >
      <ContextMenu content={() => menus.category(category)}>
        <button
          type="button"
          onClick={onToggle}
          className="nav-row nav-row--tight min-w-0 flex-1 text-muted hover:bg-rail-hover hover:text-foreground"
        >
          <Chevron className="size-3 shrink-0" />
          <span className="eyebrow truncate"><EmojiText>{category.name}</EmojiText></span>
          {isPrivate(category) ? (
            <span className="flex shrink-0 items-center" title="Private category">
              <LockIcon className="size-3" />
              <span className="sr-only">Private</span>
            </span>
          ) : null}
        </button>
      </ContextMenu>
      {mayManage && guild ? (
        <IconButton
          title={`Create channel in ${category.name}`}
          className="pointer-events-none me-1 size-5 shrink-0 opacity-0 transition group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
          onClick={() => modal.open(
            (c) => <CreateChannelDialog guild={guild} parentId={category.id} close={c} />,
          )}
        >
          <PlusIcon className="size-3.5" />
        </IconButton>
      ) : null}
    </div>
  );
}

function DmSidebar() {
  const store = useStore();
  const modal = useModal();
  const pending = store.pendingFriendCount();
  const messageRequests = store.pendingMessageRequestCount();
  const visibleConversations = store.conversations.filter((c) => c.request_state !== 'pending')
    .sort((a, b) => (b.last_activity_at || b.created_at || 0) - (a.last_activity_at || a.created_at || 0));
  const spoken = new Set();
  for (const c of visibleConversations) {
    if (c.kind !== 'dm') continue;
    const others = participants(c)
      .map((m) => m.user_id || m)
      .filter((id) => id && id !== store.me?.user_id);
    if (others.length === 1) spoken.add(others[0]);
  }
  const quiet = store.friendsIn('accepted').filter((f) => !spoken.has(f.user_id));
  return (
    <div className={FRAME}>
      <div className={HEAD}>
        <span className="min-w-0 flex-1 truncate px-2 text-lg font-semibold tracking-tight">
          Direct messages
        </span>
        <IconButton
          title="New conversation"
          onClick={() => modal.open((close) => <NewConversationDialog close={close} />)}
        >
          <PlusIcon />
        </IconButton>
      </div>
      <div className={BODY}>
        <Row
          active={store.route.view === 'dms' && !store.route.conversationId}
          onClick={() => store.navigate({ view: 'dms', conversationId: null })}
        >
          <MembersIcon className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">Friends</span>
          <Badge count={pending} />
        </Row>
        <Row
          onClick={() => modal.open((close) => <MessageRequestsDialog close={close} />)}
        >
          <MessageIcon className="size-4 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">Message requests</span>
          <Badge count={messageRequests} />
        </Row>
        <div className="eyebrow px-2 pt-4 pb-1">Conversations</div>
        {visibleConversations.map((c) => <ConversationRow key={c.id} convo={c} />)}
        {quiet.map((f) => <FriendConversationRow key={f.user_id} friend={f} />)}
        {visibleConversations.length || quiet.length ? null : (
          <p className="px-2 py-6 text-center text-sm leading-[1.6] text-muted">
            No conversations yet.
          </p>
        )}
      </div>
      <VoiceBar />
      <UserBar />
    </div>
  );
}

function ConversationRow({ convo }) {
  const store = useStore();
  const menus = useMenus();
  const { peer, title, peerTyping } = useConversationPeer(convo);
  const unread = store.dmUnreadFor(convo.id);

  return (
    <ContextMenu content={() => menus.conversation(convo)}>
      <Row
        active={store.route.view === 'dms' && store.route.conversationId === convo.id}
        person
        unread={unread}
        onClick={() => store.navigate({ view: 'dms', conversationId: convo.id })}
      >
        {peer ? (
          <Avatar
            id={peer.id}
            name={peer.name}
            size="sm"
            mediaRef={peer.avatarRef}
            base={peer.base}
            mediaOrigin={peer.mediaOrigin}
            presence={peer.presence}
          />
        ) : (
          <MessageIcon className="size-4 shrink-0 opacity-70" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-[1.0625rem]"><EmojiText>{title}</EmojiText></span>
          <span className="nav-note">
            <StatusLine presence={peer?.live} store={store} typing={peerTyping} />
          </span>
        </span>
        <Badge count={unread} />
      </Row>
    </ContextMenu>
  );
}

function FriendConversationRow({ friend }) {
  const store = useStore();
  const menus = useMenus();
  const id = friend.user_id;
  useStoreEventFor((e) => e?.user_id === id, 'presence', 'peers');
  const [busy, setBusy] = useState(false);
  const peer = dmPeer(store, id);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const convo = await store.startConversation([id]);
      store.navigate({ view: 'dms', conversationId: convo.id });
    } catch (e) {
      reportError(e, 'Could not open a conversation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContextMenu content={() => menus.friend(friend)}>
      <Row person onClick={open}>
        <Avatar
          id={id}
          name={peer?.name}
          size="sm"
          mediaRef={peer?.avatarRef}
          base={peer?.base}
          mediaOrigin={peer?.mediaOrigin}
          presence={peer?.presence}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate leading-[1.0625rem]">{peer?.name || shortName(id)}</span>
          <span className="nav-note">
            <StatusLine presence={peer?.live} store={store} />
          </span>
        </span>
      </Row>
    </ContextMenu>
  );
}

function UserBar() {
  const store = useStore();
  useStoreEvent('me', 'prefs');
  const menus = useMenus();
  const modal = useModal();
  const voice = useVoice();
  const me = store.me;
  const presence = store.prefs.presence || 'online';
  const talking = voice.active
    && voice.speaking.has(me?.user_id)
    && !voice.local.self_mute
    && !voice.local.self_deaf;
  const mine = statusLine({ custom_status: store.prefs.status?.text });
  const myFace = faceOf(store, me?.user_id);

  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
      <MenuButton
        label="Account menu"
        placement="top start"
        className="nav-row min-w-0 flex-1 hover:bg-rail-hover"
        content={menus.account()}
      >
        <Avatar
          id={me?.user_id}
          name={myFace?.name || me?.profile?.display_name}
          size="sm"
          mediaRef={myFace?.avatarRef}
          base={myFace?.base}
          mediaOrigin={myFace?.mediaOrigin}
          presence={presence}
          className={cn('voice-face', talking && 'is-talking')}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-[1.0625rem]">
            <EmojiText>{me?.profile?.display_name || shortName(me?.user_id)}</EmojiText>
          </span>
          <span className="nav-note" title={mine || me?.server_name || ''}>
            {mine
              ? <StatusText store={store}>{mine}</StatusText>
              : <span className="font-mono">{me?.server_name || ''}</span>}
          </span>
        </span>
      </MenuButton>
      <IconButton
        title="Settings"
        onClick={() => modal.open((close) => <UserSettings close={close} />, { fullscreen: true })}
      >
        <SettingsIcon />
      </IconButton>
    </div>
  );
}
