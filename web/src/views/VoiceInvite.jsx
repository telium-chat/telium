import { useEffect, useMemo, useState } from 'react';
import { Popover } from '@cloudflare/kumo/primitives/popover';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { ok, reportError } from '../hooks/useToast.jsx';
import { useT } from '../lib/i18n/react.jsx';
import { t } from '../lib/i18n/index.js';
import { faceOf } from '../lib/faces.js';
import { channelRoute } from '../lib/channels.js';
import { shortName } from '../lib/util.js';
import { cn } from '../lib/cn.js';
import {
  AddFriendIcon, Avatar, Button, EmojiText, PhoneIcon, PhoneOffIcon,
} from '../components/index.js';
import { Tooltip } from '../components/Tooltip.jsx';

/// An invite is a moment, not a record: it lives here for this long and is never stored.
export const INVITE_SHOWN_MS = 45_000;

/// The invites worth showing: not from me, not to a call I'm already in, not while I'm on do-not-disturb.
export function liveInvites(invites, { me, inChannel, presence, now }) {
  if (presence === 'dnd') return [];
  return invites.filter((i) => i.from !== me && i.channelId !== inChannel && now - i.shownAt < INVITE_SHOWN_MS);
}

function InviteCard({ invite, onDone }) {
  const tr = useT();
  const store = useStore();
  const voice = useVoice();
  const channel = store.channels.get(invite.channelId);
  const guild = store.guilds.get(invite.guildId);
  const face = faceOf(store, invite.from, { guildId: invite.guildId });
  const named = face?.name || shortName(invite.from) || null;
  const namedArm = named ? 'yes' : 'no';

  const join = () => {
    onDone();
    if (channel) store.navigate(channelRoute(channel));
    voice.join(invite.channelId)?.catch?.((e) => reportError(e, tr('voice.invite.joinFailed')));
  };

  return (
    <div
      className="ringing-call rise-in flex w-[320px] max-w-full items-center gap-3 bg-surface p-3"
      role="group"
      aria-label={tr('voice.invite.from', { named: namedArm, caller: named })}
    >
      <span className="shrink-0">
        <Avatar
          id={invite.from}
          name={face?.name}
          size="lg"
          mediaRef={face?.avatarRef}
          base={face?.base}
          mediaOrigin={face?.mediaOrigin}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold tracking-tight">
          <EmojiText>{tr('voice.invite.from', { named: namedArm, caller: named })}</EmojiText>
        </div>
        <div className="truncate text-sm text-muted">
          <EmojiText>
            {tr('voice.invite.where', { channel: channel?.name || '', guild: guild?.name || '' })}
          </EmojiText>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="danger-soft"
          shape="circle"
          aria-label={tr('voice.invite.dismiss')}
          onClick={onDone}
        >
          <PhoneOffIcon className="size-[18px]" />
        </Button>
        <Button
          variant="primary"
          shape="circle"
          aria-label={tr('voice.invite.join', { channel: channel?.name || '' })}
          onClick={join}
        >
          <PhoneIcon className="size-[18px]" />
        </Button>
      </div>
    </div>
  );
}

export function VoiceInviteHost() {
  const store = useStore();
  const voice = useVoice();
  const [invites, setInvites] = useState([]);
  useStoreEvent('voice');

  useEffect(() => store.on('voice-invite', (d) => {
    if (!d?.channel_id || !d?.guild_id) return;
    setInvites((all) => [
      ...all.filter((i) => i.channelId !== d.channel_id),
      { channelId: d.channel_id, guildId: d.guild_id, from: d.from, shownAt: Date.now() },
    ]);
  }), [store]);

  useEffect(() => {
    if (!invites.length) return undefined;
    const id = setInterval(() => {
      const now = Date.now();
      setInvites((all) => all.filter((i) => now - i.shownAt < INVITE_SHOWN_MS));
    }, 1000);
    return () => clearInterval(id);
  }, [invites.length]);

  const shown = liveInvites(invites, {
    me: store.me?.user_id,
    inChannel: voice.channelId,
    presence: store.prefs?.presence || 'online',
    now: Date.now(),
  }).filter((i) => store.channels.has(i.channelId));
  if (!shown.length) return null;
  const drop = (channelId) => setInvites((all) => all.filter((i) => i.channelId !== channelId));
  return (
    <div className="ringing-calls ringing-calls--invites" role="region" aria-live="polite">
      {shown.map((i) => (
        <InviteCard key={i.channelId} invite={i} onDone={() => drop(i.channelId)} />
      ))}
    </div>
  );
}

/// Members who could be asked in: not me, not already in the call, online ones first.
export function invitable(store, guildId, channelId, search) {
  const here = new Set((store.voice.get(channelId) || []).map((v) => v.user_id));
  const q = search.trim().toLowerCase();
  const rows = [...(store.members.get(guildId)?.values() || [])]
    .filter((m) => m.user_id !== store.me?.user_id && !here.has(m.user_id) && !m.bot)
    .map((m) => ({ m, name: m.nickname || m.display_name || faceOf(store, m.user_id, { guildId })?.name || shortName(m.user_id) || '' }))
    .filter(({ m, name }) => !q || name.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q));
  const live = (m) => ((store.presence.get(m.user_id) || m.presence)?.status || 'offline') !== 'offline';
  rows.sort((a, b) => (live(b.m) - live(a.m)) || a.name.localeCompare(b.name));
  return rows.slice(0, 30).map(({ m, name }) => ({ userId: m.user_id, name, online: live(m) }));
}

function InviteList({ channel, onClose }) {
  const tr = useT();
  const store = useStore();
  const [search, setSearch] = useState('');
  const [sent, setSent] = useState(() => new Set());
  const guildId = channel.guild_id;
  useStoreEvent('members', 'voice');
  useEffect(() => { store.ensureGuildMembers?.(guildId); }, [store, guildId]);
  const rows = useMemo(
    () => invitable(store, guildId, channel.id, search),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, guildId, channel.id, search, store.voice.get(channel.id), store.members.get(guildId)?.size],
  );

  const send = async (row) => {
    try {
      await store.apiForGuild(guildId).voiceInvite(channel.id, row.userId);
      setSent((s) => new Set(s).add(row.userId));
      ok(tr('voice.invite.sent', { name: row.name }));
      onClose?.();
    } catch (e) {
      reportError(e, tr('voice.invite.failed'));
    }
  };

  return (
    <div className="flex max-h-[320px] flex-col gap-2 p-2">
      <input
        type="search"
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={tr('voice.invite.search')}
        aria-label={tr('voice.invite.search')}
        className="w-full rounded-row bg-surface-secondary px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length ? rows.map((row) => {
          const face = faceOf(store, row.userId, { guildId });
          return (
            <button
              key={row.userId}
              type="button"
              disabled={sent.has(row.userId)}
              onClick={() => send(row)}
              className={cn(
                'flex w-full items-center gap-2 rounded-row px-2 py-1.5 text-start text-sm',
                'hover:bg-surface-secondary disabled:opacity-50',
                !row.online && 'text-muted',
              )}
            >
              <Avatar
                id={row.userId}
                name={face?.name}
                size="sm"
                mediaRef={face?.avatarRef}
                base={face?.base}
                mediaOrigin={face?.mediaOrigin}
              />
              <span className="min-w-0 flex-1 truncate"><EmojiText>{row.name}</EmojiText></span>
            </button>
          );
        }) : (
          <p className="px-2 py-3 text-center text-sm text-muted">{tr('voice.invite.none')}</p>
        )}
      </div>
    </div>
  );
}

/// The call bar's invite button: a guild call only. A DM call already rings its own members.
export function InviteTool({ channel, toolClass }) {
  const [open, setOpen] = useState(false);
  const title = t('voice.invite.open');
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={open ? null : title} side="top">
        <Popover.Trigger
          render={<button type="button" />}
          aria-label={title}
          title={title}
          className={toolClass({ on: false })}
        >
          <AddFriendIcon className="size-[17px] shrink-0" />
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          positionMethod="fixed"
          sideOffset={8}
          collisionPadding={12}
          className="popover z-50"
        >
          <Popover.Popup aria-label={title} className="popup popup--panel w-[260px]">
            <InviteList channel={channel} onClose={() => setOpen(false)} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
