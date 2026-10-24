import { Fragment, useEffect, useRef } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { Status } from '../lib/gateway.js';
import { faceOf } from '../lib/faces.js';
import { shortName } from '../lib/util.js';
import { voiceActivityFor } from '../lib/voice-activity.js';
import { cn } from '../lib/cn.js';
import {
  Avatar, BotBadge, ContextMenu, EmojiText, Hint, Pill, StatusLine,
} from '../components/index.js';
import { MobileContextMenu } from './mobile/MobileNavigation.jsx';
import { useMenus } from './menus.jsx';
import { useOpenProfile, useProfileCard } from '../hooks/useProfileCard.js';

const RAIL = 'member-rail';

export function MembersPane({ guildId, mobile = false, searchQuery = '' }) {
  const store = useStore();
  useStoreEvent('guilds', 'status');
  useStoreEvent('channels');
  useStoreEventFor((g) => !g || g === guildId, 'members', 'roles');
  useStoreEventFor(
    (e) => store.members.get(guildId)?.has(e?.user_id),
    'presence',
  );
  useStoreEventFor(
    (channelId) => store.channels.get(channelId)?.guild_id === guildId,
    'voice',
  );
  useStoreEventFor(
    (channelId) => store.channels.get(channelId)?.guild_id === guildId,
    'typing',
  );
  const profiles = useProfileCard();
  const showing = useOpenProfile();
  const menus = useMenus();
  const rootRef = useRef(null);

  const guild = store.guilds.get(guildId);

  const ready = store.gw.statusOf(guild?.domain) === Status.Ready;

  useEffect(() => {
    if (ready) store.ensureGuildMembers(guildId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, guildId, ready]);

  if (!guild) return null;

  const map = store.members.get(guildId) || new Map();
  const typing = new Set();
  for (const [channelId, channel] of store.channels) {
    if (channel.guild_id !== guildId) continue;
    for (const userId of store.typing.get(channelId)?.keys() || []) typing.add(userId);
    if (store.localTyping.has(channelId) && store.me?.user_id) typing.add(store.me.user_id);
  }
  let rows = [...map.values()];
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    rows = rows.filter((m) => {
      const name = (m.nickname || m.display_name || m.user_id || '').toLowerCase();
      return name.includes(q);
    });
  }
  const online = [];
  const offline = [];
  for (const m of rows) {
    const live = store.presence.get(m.user_id) || m.presence || {};
    const status = live.status || 'offline';
    (status === 'offline' ? offline : online).push({ ...m, status, presence: live });
  }
  const byName = (a, b) => (a.nickname || a.display_name || a.user_id)
    .localeCompare(b.nickname || b.display_name || b.user_id);
  online.sort(byName);
  offline.sort(byName);

  const hoisted = store.roleList(guildId).filter((r) => r.hoist);
  const groups = hoisted.map((role) => ({ role, members: [] }));
  const rank = new Map(hoisted.map((r, i) => [r.id, i]));
  const ungrouped = [];
  for (const m of online) {
    let best = -1;
    for (const id of m.roles || []) {
      const at = rank.get(id);
      if (at !== undefined && (best < 0 || at < best)) best = at;
    }
    if (best >= 0) groups[best].members.push(m);
    else ungrouped.push(m);
  }

  const onScroll = () => {
    const el = rootRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) {
      store.requestMemberWindow(guildId, rows.length);
    }
  };

  const base = store.apiForGuild(guildId)?.base;

  const section = (label, list, key = label) => {
    const ContextWrapper = mobile ? MobileContextMenu : ContextMenu;
    return list.length ? (
      <Fragment key={key}>
        <div className="flex items-baseline gap-1.5 px-2 pt-4 pb-1 text-xs font-medium text-muted first:pt-1">
          <span className="min-w-0 truncate"><EmojiText>{label}</EmojiText></span>
          <span className="tnum shrink-0">{`\u2014 ${list.length}`}</span>
        </div>
        {list.map((m) => {
          const face = faceOf(store, m.user_id, { guildId });
          const selected = showing?.source === RAIL
            && showing.guildId === guildId
            && showing.userId === m.user_id;
          const voiceActivity = voiceActivityFor(store, m.user_id, { guildId });
          return (
          <ContextWrapper
            key={m.user_id}
            content={() => menus.member(m.user_id, guildId, {
              onMention: (id) => store.emit('compose', `<${id}>`),
            })}
          >
            <MemberRow
              member={m}
              store={store}
              mediaRef={face?.avatarRef || null}
              base={face?.base || base}
              mediaOrigin={face?.mediaOrigin || undefined}
              colour={store.colourFor(guildId, m.user_id)}
              typing={typing.has(m.user_id)}
              voiceActivity={voiceActivity}
              mobile={mobile}
              selected={selected}
              onClick={(e) => (selected
                ? profiles.close()
                : profiles.open(m.user_id, { guildId, anchor: e.currentTarget, source: RAIL }))}
              onPointerEnter={() => profiles.prefetch(m.user_id)}
              onPointerLeave={profiles.cancel}
            />
          </ContextWrapper>
          );
        })}
      </Fragment>
    ) : null;
  };

  return (
    <aside
      aria-label="Members"
      ref={rootRef}
      onScroll={onScroll}
      data-mobile-scroll={mobile ? '' : undefined}
      className={cn(
        mobile
          ? 'flex h-full min-h-0 w-full flex-col overflow-y-auto bg-background px-3 py-2'
          : 'hidden w-[220px] shrink-0 flex-col overflow-y-auto bg-rail px-2 py-2 lg:flex',
      )}
    >
      {groups.map((g) => section(g.role.name, g.members, g.role.id))}
      {section('Online', ungrouped)}
      {section('Offline', offline)}
      {rows.length < (guild.member_count || 0) ? (
        <Hint className="px-2 py-3">
          {rows.length
            ? `Showing ${rows.length} of ${guild.member_count}. Scroll for more.`
            : `Waiting on ${guild.domain} for the member list.`}
        </Hint>
      ) : null}
    </aside>
  );
}

function MemberRow({
  member, store, mediaRef, base, mediaOrigin, colour,
  typing = false, voiceActivity = null, mobile = false, selected = false, onClick, ...rest
}) {
  const timedOut = member.timeout_until && member.timeout_until > Date.now();

  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={selected}
      {...rest}
      className={cn(
        'nav-row text-muted',
        mobile
          ? 'nav-row--touch'
          : 'nav-row--person',
        !selected && (mobile
          ? 'active:bg-rail-hover active:text-foreground'
          : 'hover:bg-rail-hover hover:text-foreground'),
        member.status === 'offline' && !selected && 'opacity-55',
        selected && 'bg-accent-soft font-medium text-accent-soft-foreground',
      )}
    >
      <Avatar
        id={member.user_id}
        name={member.display_name}
        size="sm"
        mediaRef={mediaRef}
        base={base}
        mediaOrigin={mediaOrigin}
        presence={member.status}
      />
      <span className="min-w-0 flex-1">
        <span
          className={colour ? 'block truncate role-ink' : 'block truncate'}
          style={colour ? { '--role': colour } : undefined}
        >
          <EmojiText>{member.nickname || member.display_name || shortName(member.user_id)}</EmojiText>
        </span>
        <StatusLine
          presence={member.presence}
          store={store}
          className="nav-note"
          typing={typing}
          priorityActivity={voiceActivity ? {
            kind: 'voice',
            verb: 'In',
            name: voiceActivity.channel_name,
          } : null}
        />
      </span>
      <BotBadge member={member} />
      {timedOut ? <Pill tone="warn">timeout</Pill> : null}
    </button>
  );
}
