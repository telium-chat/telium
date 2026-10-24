import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../lib/cn.js';
import { GuildFace } from '../components/GuildFace.jsx';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { useConversationPeer } from '../hooks/useConversationPeer.js';
import { Status } from '../lib/gateway.js';
import {
  addToFolder, combine, dissolveFolder, folderLabel, moveTo, renameFolder, setCollapsed,
} from '../lib/rail.js';
import {
  cachedChangelog, hasUnreadChangelog, readMarker, refreshChangelogIfStale,
} from '../lib/changelog.js';
import {
  Avatar, Badge, ContextMenu, EditIcon, EmojiText, FolderOpenIcon, MenuItem, MenuSeparator, PlusIcon, Reorder, SparklesIcon, TeliumMark, TrashIcon, useDialogs, useReorderItem,
} from '../components/index.js';
import { Tooltip } from '../components/Tooltip.jsx';
import { useMenus } from './menus.jsx';
import { AddGuildDialog } from './dialogs/AddGuildDialog.jsx';
import { ChangelogDialog } from './dialogs/ChangelogDialog.jsx';

const RAILED_MAX = 6;

export function GuildRail() {
  return (
    <div
      className="flex w-[60px] shrink-0 bg-strip [--presence-ring:var(--strip)]"
      style={{ '--badge-ring': 'var(--strip)', '--badge-ring-width': '3px', '--badge-size-override': '18px' }}
    >
      <Rail />
    </div>
  );
}

const ROW = 46;
const travelMs = (distance) => Math.round(Math.min(360, 150 + ROW * Math.sqrt(distance / ROW)));
const travelStretch = (distance) => 1 + Math.min(0.42, distance / 1400);

function useTravellingMark(railRef) {
  const held = useRef(null);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const now = rail.querySelector('.rail-pill[data-state="active"]');
    const was = held.current;
    held.current = now;
    if (!now || !was || was === now || !was.isConnected) return;

    const from = was.getBoundingClientRect();
    const to = now.getBoundingClientRect();
    const offset = (from.top + from.height / 2) - (to.top + to.height / 2);
    if (!offset) return;

    was.removeAttribute('data-travel');
    was.setAttribute('data-handoff', '');
    requestAnimationFrame(() => was.removeAttribute('data-handoff'));

    const distance = Math.abs(offset);
    now.removeAttribute('data-travel');
    void now.offsetWidth;
    now.style.setProperty('--rail-travel-from', `${Math.round(offset)}px`);
    now.style.setProperty('--rail-travel-dur', `${travelMs(distance)}ms`);
    now.style.setProperty('--rail-travel-smear', travelStretch(distance).toFixed(3));
    now.setAttribute('data-travel', '');
  });
}

function Rail() {
  const store = useStore();
  useStoreEvent('guilds', 'unread', 'status', 'route', 'conversations', 'capabilities', 'friends', 'prefs');
  const modal = useModal();
  const route = store.route;
  const railRef = useRef(null);
  useTravellingMark(railRef);

  const [whatsNew, setWhatsNew] = useState(() => cachedChangelog());
  useEffect(() => {
    let alive = true;
    refreshChangelogIfStale().then((parsed) => {
      if (alive && parsed) setWhatsNew(parsed);
    });
    return () => { alive = false; };
  }, []);
  const openWhatsNew = () => {
    modal.open(() => (
      <ChangelogDialog onClosed={() => setWhatsNew(cachedChangelog())} />
    ), { wide: true });
  };
  const whatsNewUnread = hasUnreadChangelog(whatsNew, readMarker());

  const nodes = store.railNodes();

  const inDms = route.view === 'dms';
  const openConvo = route.view === 'dms' ? route.conversationId : null;
  const waiting = store.conversations.filter((c) => store.dmUnreadFor(c.id) > 0);
  const railed = waiting.slice(0, RAILED_MAX);
  const dmWaiting = store.pendingFriendCount()
    + waiting.slice(RAILED_MAX).reduce((total, c) => total + store.dmUnreadFor(c.id), 0);
  const railedOpen = railed.some((c) => c.id === openConvo);

  const openGuild = (guildId) => {
    const channels = store.channelsOf(guildId);
    const first = channels.find((c) => c.type === 'text') || channels.find((c) => c.type !== 'category');
    store.navigate({ view: 'chat', guildId, channelId: first?.id || null });
  };

  const drop = ({ source, entries, index, over }) => {
    const ref = { type: source.kind, id: source.id };
    if (over) {
      store.setRail(over.kind === 'folder'
        ? addToFolder(nodes, ref, over.id)
        : combine(nodes, ref, over.id));
      return;
    }
    let into = null;
    if (source.kind !== 'folder') {
      for (let i = index - 1; i >= 0; i -= 1) {
        const row = entries[i];
        if (row.kind === 'folder') { into = row.open ? row.id : null; break; }
        if (row.kind === 'guild') { into = row.parent; break; }
      }
    }
    if (into) {
      let at = 0;
      for (let i = 0; i < index; i += 1) {
        const row = entries[i];
        if (row.kind === 'guild' && row.parent === into && row.id !== source.id) at += 1;
      }
      store.setRail(addToFolder(nodes, ref, into, at));
      return;
    }
    let gap = 0;
    for (let i = 0; i < index; i += 1) {
      const row = entries[i];
      if (row.kind === 'folder' || (row.kind === 'guild' && !row.parent)) gap += 1;
    }
    store.setRail(moveTo(nodes, ref, gap));
  };

  const canCombine = (source, target) => source.kind === 'guild'
    && (target.kind === 'folder' ? !target.open : !target.parent);

  const hold = (target) => {
    if (target?.kind === 'folder' && !target.open) {
      store.setRail(setCollapsed(store.railNodes(), target.id, false));
    }
  };

  return (
    <Reorder
      as="nav"
      ref={railRef}
      onDrop={drop}
      onHold={hold}
      canCombine={canCombine}
      className="flex w-full flex-col items-center gap-1.5 overflow-y-auto py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {store.supports(store.session?.home?.domain, 'dms') ? (
        <RailTile
          label="Direct messages"
          active={inDms && !railedOpen}
          round
          unread={dmWaiting > 0}
          badge={dmWaiting || null}
          onClick={() => store.navigate({ view: 'dms' })}
        >
          <TeliumMark className="size-[22px]" />
        </RailTile>
      ) : null}

      {railed.map((convo) => (
        <DmTile
          key={convo.id}
          convo={convo}
          active={openConvo === convo.id}
        />
      ))}

      <Divider />

      {nodes.map((node) => (node.kind === 'folder'
        ? (
          <Folder
            key={node.id}
            folder={node}
            inDms={inDms}
            onOpen={openGuild}
          />
        )
        : (
          <GuildTile
            key={node.id}
            guild={store.guilds.get(node.id)}
            active={!inDms && route.guildId === node.id}
            onOpen={openGuild}
          />
        )))}

      <Divider />

      <RailTile
        label="Add a guild or server"
        onClick={() => modal.open((close) => <AddGuildDialog close={close} />)}
      >
        <PlusIcon className="size-[18px]" />
      </RailTile>

      <RailTile
        label="What's new"
        unread={whatsNewUnread}
        badge={whatsNewUnread ? '!' : null}
        onClick={openWhatsNew}
      >
        <SparklesIcon className="size-[18px]" />
      </RailTile>
    </Reorder>
  );
}

function Divider() {
  return <div className="my-0.5 h-px w-6 shrink-0 bg-separator" />;
}

function GuildTile({ guild, active, onOpen, inFolder = null }) {
  const store = useStore();
  const menus = useMenus();
  const { ref, dragProps } = useReorderItem(guild ? {
    key: guild.id,
    kind: 'guild',
    id: guild.id,
    parent: inFolder?.id || null,
    group: inFolder?.id || null,
  } : null);

  if (!guild) return null;
  const status = store.gw.statusOf(guild.domain);
  const unreachable = status !== Status.Ready;
  const { unread, mentions } = store.guildUnread(guild.id);
  return (
    <ContextMenu content={() => menus.guild(guild)}>
      <RailTile
        innerRef={ref}
        wrapClass={cn(dragProps.className, 'drag-item--tile')}
        onPointerDown={dragProps.onPointerDown}
        onKeyDown={dragProps.onKeyDown}
        label={unreachable
          ? `${guild.name} - ${guild.domain} is ${status}`
          : `${guild.name} on ${guild.domain}`}
        active={active}
        unread={Boolean(unread || mentions)}
        dim={unreachable}
        badge={mentions || null}
        onClick={() => onOpen(guild.id)}
      >
        <GuildFace guild={guild} size="size-10" radius="rounded-[inherit]" className="text-sm text-white/95" />
      </RailTile>
    </ContextMenu>
  );
}

function Folder({ folder, inDms, onOpen }) {
  const store = useStore();
  const dialogs = useDialogs();
  const { ref, dragProps } = useReorderItem({
    key: folder.id,
    kind: 'folder',
    id: folder.id,
    group: folder.id,
    leader: true,
    open: !folder.collapsed,
  });

  const label = folderLabel(folder, store.guilds);
  const holdsCurrent = !inDms && folder.guilds.includes(store.route.guildId);
  let unread = 0;
  let mentions = 0;
  for (const id of folder.guilds) {
    const state = store.guildUnread(id);
    unread += state.unread;
    mentions += state.mentions;
  }

  const menu = () => (
    <>
      <MenuItem
        icon={EditIcon}
        onAction={() => dialogs.prompt({
          title: 'Rename folder',
          label: 'Folder name',
          hint: 'Left empty, the folder is named after what is in it.',
          value: folder.name,
          onSubmit: (name) => store.setRail(renameFolder(store.railNodes(), folder.id, name)),
        })}
      >
        Rename folder
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={TrashIcon}
        onAction={() => store.setRail(dissolveFolder(store.railNodes(), folder.id))}
      >
        Take these out of the folder
      </MenuItem>
    </>
  );

  const toggle = () => store.setRail(setCollapsed(store.railNodes(), folder.id, !folder.collapsed));

  const lid = (
    <ContextMenu content={menu}>
      <RailTile
        innerRef={ref}
        wrapClass={cn(dragProps.className, 'drag-item--tile')}
        onPointerDown={dragProps.onPointerDown}
        onKeyDown={dragProps.onKeyDown}
        label={folder.collapsed ? `${label} - ${folder.guilds.length} servers` : label}
        active={folder.collapsed ? holdsCurrent : undefined}
        unread={folder.collapsed && Boolean(unread || mentions)}
        badge={folder.collapsed ? mentions || null : null}
        className={cn(
          'bg-transparent',
          !folder.collapsed && 'text-accent',
        )}
        onClick={toggle}
      >
        <span className="grid place-items-center">
          <span
            aria-hidden={!folder.collapsed}
            className={cn(
              'col-start-1 row-start-1 grid grid-cols-2 gap-[3px] transition-opacity duration-200',
              folder.collapsed ? 'opacity-100' : 'opacity-0',
            )}
          >
            {folder.guilds.slice(0, 4).map((id) => (
              <GuildFace
                key={id}
                guild={store.guilds.get(id)}
                size="size-4"
                radius="rounded-[5px]"
                letters={false}
              />
            ))}
          </span>
          <FolderOpenIcon
            aria-hidden
            className={cn(
              'col-start-1 row-start-1 size-[19px] transition-opacity duration-200',
              folder.collapsed ? 'opacity-0' : 'opacity-100',
            )}
          />
        </span>
      </RailTile>
    </ContextMenu>
  );

  return (
    <div
      className={cn(
        'folder-slab flex w-[46px] shrink-0 flex-col items-center rounded-[18px]',
        'bg-accent/10 p-[3px]',
        !folder.collapsed && 'pb-0',
      )}
    >
      {lid}
      <div
        className="folder-body w-full"
        data-open={folder.collapsed ? 'false' : 'true'}
        aria-hidden={folder.collapsed || undefined}
        inert={folder.collapsed || undefined}
      >
        <div className="-ms-2.5 -me-1.5 ps-2.5 pe-1.5">
          <div className="flex flex-col items-center gap-1.5 py-1.5">
          {folder.guilds.map((id) => (
            <GuildTile
              key={id}
              guild={store.guilds.get(id)}
              inFolder={folder}
              active={!inDms && store.route.guildId === id}
              onOpen={onOpen}
            />
          ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function DmTile({ convo, active }) {
  const store = useStore();
  const menus = useMenus();
  const { peer, title, peerTyping } = useConversationPeer(convo);
  const unread = store.dmUnreadFor(convo.id);
  return (
    <ContextMenu content={() => menus.conversation(convo)}>
      <RailTile
        label={title}
        active={active}
        unread={unread > 0}
        round
        badge={unread || null}
        className="bg-transparent"
        onClick={() => store.navigate({ view: 'dms', conversationId: convo.id })}
      >
        <Avatar
          id={peer?.id || convo.id}
          name={title}
          size="chat"
          mediaRef={peer?.avatarRef || null}
          base={peer?.base || null}
          mediaOrigin={peer?.mediaOrigin || null}
          presence={peer?.presence || null}
          typing={peerTyping}
        />
      </RailTile>
    </ContextMenu>
  );
}

function RailTile({
  label, active, dim, unread, badge, round, children, onClick, className, style,
  wrapClass, innerRef, ref: outerRef, ...rest
}) {
  const setNode = useCallback((node) => {
    if (typeof innerRef === 'function') innerRef(node);
    else if (innerRef) innerRef.current = node;
    if (typeof outerRef === 'function') outerRef(node);
    else if (outerRef) outerRef.current = node;
  }, [innerRef, outerRef]);
  const marked = active !== undefined;
  const note = useId();
  const face = (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      aria-describedby={unread && !active ? note : undefined}
      onClick={onClick}
      style={style}
      className={cn(
        'rail-tile__face no-press flex size-10 items-center justify-center',
        round && 'rail-tile__face--round',
        'text-muted',
        !style && 'bg-rail',
        dim && 'opacity-40 saturate-0',
        className,
      )}
    >
      {children}
    </button>
  );
  return (
    <div ref={setNode} className={cn('rail-tile', wrapClass)} {...rest}>
      <Tooltip label={<EmojiText>{label}</EmojiText>} side="right">
        {face}
      </Tooltip>
      <span id={note} className="sr-only">{unread && !active ? 'Unread' : ''}</span>
      {marked ? (
        <span
          aria-hidden
          className="rail-pill"
          data-state={active ? 'active' : unread ? 'unread' : 'none'}
        />
      ) : null}
      <Badge
        count={badge}
        className="pointer-events-none absolute -end-1 -bottom-1"
      />
    </div>
  );
}
