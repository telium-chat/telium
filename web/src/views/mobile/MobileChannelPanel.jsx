import { useMemo, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { useVoice } from '../../hooks/useVoice.jsx';
import { cn } from '../../lib/cn.js';
import { channelGlyph, channelRoute, channelTree } from '../../lib/channels.js';
import { Badge, CloseIcon, EmojiText, MoreIcon, SearchField, SearchIcon } from '../../components/index.js';
import { SearchDialog } from '../dialogs/SearchDialog.jsx';
import { useMenus } from '../menus.jsx';
import { VoiceStatusLine } from '../dialogs/VoiceStatusDialog.jsx';
import { MobileActionSheet, MobileContextMenu } from './MobileActionSheet.jsx';

export function MobileChannelPanel({ guildId, close, onSelectChannel }) {
  const store = useStore();
  const voice = useVoice();
  const modal = useModal();
  const menus = useMenus();
  useStoreEvent('guilds', 'channels', 'route', 'unread', 'status', 'prefs', 'voice');
  const route = store.route;
  const [guildMenuOpen, setGuildMenuOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const guild = guildId ? store.guilds.get(guildId) : null;
  const tree = guild ? channelTree(store.channelsOf(guild.id)) : { loose: [], groups: [] };
  const normalizedFilter = filter.trim().toLocaleLowerCase();

  const addUnreadInfo = (channels) => channels.map((ch) => {
    const state = store.unreadFor(ch.id);
    const muted = store.isMuted(ch.id);
    return {
      ...ch,
      unread: Boolean(state?.unread && !muted),
      mentions: muted ? 0 : (state?.mentions || 0),
    };
  });

  const treeWithUnread = {
    loose: addUnreadInfo(tree.loose),
    groups: tree.groups.map((group) => ({
      ...group,
      items: addUnreadInfo(group.items),
    })),
  };
  const visibleTree = useMemo(() => {
    if (!normalizedFilter) return treeWithUnread;
    const matches = (channel) => channel.name.toLocaleLowerCase().includes(normalizedFilter);
    return {
      loose: treeWithUnread.loose.filter(matches),
      groups: treeWithUnread.groups
        .map((group) => ({ ...group, items: group.items.filter(matches) }))
        .filter((group) => group.items.length > 0 || group.category.name.toLocaleLowerCase().includes(normalizedFilter)),
    };
  }, [normalizedFilter, treeWithUnread]);

  const toggleCategory = (categoryId) => {
    store.prefs.collapsed[categoryId] = !store.prefs.collapsed[categoryId];
    store.savePrefs();
  };

  const openChannel = (channel) => {
    store.navigate(channelRoute(channel));
    if (channel.type === 'voice' && voice.channelId !== channel.id) voice.join(channel.id);
    onSelectChannel();
  };

  return (
    <div className="mobile-channel-panel flex min-h-full flex-col">
      {guild ? (
        <div className="flex items-stretch border-b border-border">
          <button
            type="button"
            aria-label={`Open ${guild.name} server menu`}
            aria-expanded={guildMenuOpen}
            onClick={() => setGuildMenuOpen(true)}
            className="flex min-h-12 min-w-0 flex-1 items-center justify-between px-3.5 text-start transition-colors active:bg-surface-tertiary"
          >
            <span className="truncate text-lg font-bold text-foreground"><EmojiText>{guild.name}</EmojiText></span>
            <MoreIcon className="size-5 shrink-0 text-muted" />
          </button>
          <button
            type="button"
            aria-label={`Search ${guild.name}`}
            onClick={() => {
              close();
              modal.open((dismiss) => <SearchDialog guildId={guild.id} close={dismiss} />, { wide: true });
            }}
            className="mobile-touch-target flex w-12 shrink-0 items-center justify-center text-muted active:bg-surface-tertiary active:text-foreground"
          >
            <SearchIcon className="size-4.5" />
          </button>
          <button
            type="button"
            aria-label="Close navigation"
            onClick={close}
            className="mobile-touch-target flex w-12 shrink-0 items-center justify-center text-muted active:bg-surface-tertiary active:text-foreground"
          >
            <CloseIcon className="size-5" />
          </button>
        </div>
      ) : null}

      {guild && guildMenuOpen ? (
        <MobileActionSheet title={guild.name} onClose={() => setGuildMenuOpen(false)}>
          {menus.guild(guild)}
        </MobileActionSheet>
      ) : null}

      <div className="px-3 pt-2">
        <SearchField
          label="Find a channel"
          placeholder="Find a channel"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onClear={() => setFilter('')}
          size="base"
          className="min-h-11 rounded-xl border-0 bg-surface"
        />
      </div>
      <div className="px-2 py-2">
        {visibleTree.loose.map((channel) => (
          <MobileChannelRow
            key={channel.id}
            channel={channel}
            onClick={() => openChannel(channel)}
            isActive={route.channelId === channel.id}
          />
        ))}

        {visibleTree.groups.map((group) => {
          const isCollapsed = Boolean(store.prefs.collapsed[group.category.id]);
          const filteredItems = normalizedFilter
            ? group.items
            : (isCollapsed ? [] : group.items);
          const matchesCategory = normalizedFilter
            && group.category.name.toLocaleLowerCase().includes(normalizedFilter);
          const categoryItems = normalizedFilter && matchesCategory
            ? group.items
            : filteredItems;
          return (
            <div key={group.category.id} className="pt-3">
              <button
                type="button"
                onClick={() => toggleCategory(group.category.id)}
                className="flex min-h-11 w-full items-center gap-1.5 rounded-lg px-2 text-xs font-bold uppercase tracking-wider text-muted active:bg-surface-tertiary active:text-foreground"
              >
                <svg
                  className={cn('size-3 shrink-0 transition-transform duration-200', isCollapsed && '-rotate-90')}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                <span className="truncate"><EmojiText>{group.category.name}</EmojiText></span>
              </button>
              <div className="folder-body" data-open={String(Boolean(normalizedFilter) || !isCollapsed)}>
                {categoryItems.map((channel) => (
                  <MobileChannelRow
                    key={channel.id}
                    channel={channel}
                    onClick={() => openChannel(channel)}
                    indent
                    isActive={route.channelId === channel.id}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {!visibleTree.loose.length && !visibleTree.groups.some((group) => group.items.length) ? (
          <p className="px-2 py-8 text-center text-sm text-muted">
            {normalizedFilter ? 'No channels match your search.' : 'No channels available.'}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MobileChannelRow({ channel, onClick, indent = false, isActive = false }) {
  const store = useStore();
  const menus = useMenus();
  const Glyph = channelGlyph(channel);
  const liveCount = channel.type === 'voice' ? (store.voice.get(channel.id) || []).length : 0;
  return (
    <MobileContextMenu content={() => menus.channel(channel)} title={channel.name}>
      <button
        type="button"
        onClick={onClick}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'relative flex min-h-[44px] w-full items-center gap-2.5 rounded-xl px-2.5 text-start text-base transition-colors active:bg-surface-tertiary',
          indent && 'ps-5',
          isActive
            ? 'bg-surface-secondary text-foreground font-semibold shadow-sm'
            : channel.unread
              ? 'font-semibold text-foreground active:bg-surface-tertiary'
              : 'text-muted hover:text-foreground',
        )}
      >
        {channel.unread && !isActive ? (
          <span
            aria-hidden
            className="absolute start-0 top-1/2 h-2 w-1 -translate-y-1/2 rounded-e-full bg-foreground"
          />
        ) : null}
        <Glyph className={cn('size-5 shrink-0', isActive ? 'text-accent' : 'opacity-70')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate"><EmojiText>{channel.name}</EmojiText></span>
          {channel.type === 'voice' && channel.voice_status ? (
            <VoiceStatusLine channel={channel} className="block" />
          ) : null}
        </span>
        {liveCount ? (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-semibold text-accent">
            {`${liveCount} live`}
          </span>
        ) : null}
        <Badge count={channel.mentions} />
      </button>
    </MobileContextMenu>
  );
}
