import { useEffect, useRef, useState } from 'react';
import { useStore, useAsync, useStoreEvent, useStoreEventFor } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { cn } from '../../lib/cn.js';
import { dayOf, relative, shortName, timeOf } from '../../lib/util.js';
import { remoteMediaOrigin } from '../../lib/media.js';
import { renderContent } from '../../lib/markdown.jsx';
import { HeaderPanel, PanelEmpty, PanelSkeleton } from './HeaderPanel.jsx';
import {
  Async, Avatar, BotBadge, Button, CloseIcon, EmojiText, IconButton, ModalShell, PinIcon
} from '../../components/index.js';
import { Attachments } from '../chat/Attachments.jsx';
import { dmPeer } from '../../lib/conversations.js';

function useAuthor(guildId, userId, conversationId) {
  const store = useStore();
  const own = userId === store.me?.user_id ? store.me?.profile : null;

  if (conversationId) {
    const peer = own ? null : dmPeer(store, userId);
    return {
      name: own?.display_name || peer?.name || shortName(userId) || 'Unknown',
      colour: null,
      avatar: {
        name: own?.display_name || peer?.name,
        mediaRef: own?.avatar_ref || peer?.avatarRef || null,
        base: own ? store.home?.base : peer?.base,
        mediaOrigin: own ? undefined : peer?.mediaOrigin || undefined,
      },
    };
  }

  const member = store.members.get(guildId)?.get(userId);
  return {
    name: member?.nickname || member?.display_name || own?.display_name || shortName(userId),
    colour: store.colourFor(guildId, userId),
    avatar: {
      name: member?.display_name || own?.display_name,
      mediaRef: own?.avatar_ref || member?.avatar_ref || null,
      base: own ? store.home?.base : store.apiForGuild(guildId)?.base,
      mediaOrigin: own
        ? undefined
        : remoteMediaOrigin(userId, store.guilds.get(guildId)?.domain),
    },
  };
}

function PinCard({ msg, guildId, conversationId, onJump, onUnpin }) {
  const store = useStore();
  const { name, colour, avatar } = useAuthor(guildId, msg.author, conversationId);
  const base = conversationId ? store.home?.base : store.apiForGuild(guildId)?.base;
  const empty = !msg.content && !msg.attachments?.length;

  const jump = (e) => {
    if (e.target.closest?.('a, button, [role="button"]:not(.pin-card)')) return;
    onJump();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Jump to the message ${name} pinned`}
      data-panel-row
      className="panel-card pin-card rise-in relative flex gap-3 px-3 py-2.5 focus-outside"
      onClick={jump}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        onJump();
      }}
    >
      <Avatar size="md" id={msg.author} {...avatar} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 pe-8">
          <span
            className={colour ? 'truncate text-sm font-medium role-ink' : 'truncate text-sm font-medium'}
            style={colour ? { '--role': colour } : undefined}
            title={msg.author}
          >
            <EmojiText>{name}</EmojiText>
          </span>
          <BotBadge userId={msg.author} guildId={guildId} />
          {msg.created_at ? (
            <span
              className="tnum shrink-0 text-2xs text-muted"
              title={`${dayOf(msg.created_at)} at ${timeOf(msg.created_at)}`}
            >
              {relative(msg.created_at)}
            </span>
          ) : null}
        </div>

        <div className="pin-card__body md pt-0.5 text-base leading-[1.55] break-words">
          {empty && conversationId
            ? <span className="text-muted italic">Not readable on this device</span>
            : renderContent(msg.content || '', { me: store.me?.user_id, store, guildId })}
        </div>

        <Attachments msg={msg} base={base} encrypted={Boolean(conversationId)} />
      </div>

      {onUnpin ? (
        <IconButton title="Unpin" className="pin-card__unpin" onClick={onUnpin}>
          <CloseIcon className="size-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

function PinsList({ channelId, conversationId, close }) {
  return conversationId
    ? <ConversationPins conversationId={conversationId} close={close} />
    : <ChannelPins channelId={channelId} close={close} />;
}

function PinsSkeleton() {
  return <PanelSkeleton label="Loading pins" />;
}

function ChannelPins({ channelId, close }) {
  const store = useStore();
  const guildId = store.channels.get(channelId)?.guild_id;
  const state = useAsync(
    () => store.apiForChannel(channelId).pins(channelId).then((r) => r.pins || r.messages || []),
    [channelId],
  );

  useEffect(() => store.on('pins', (e) => {
    if (e === channelId) state.reload();
  }), [store, channelId, state.reload]);
  useEffect(() => { store.markPinsSeen(channelId, null); });

  const [gone, setGone] = useState(() => new Set());
  const forget = (id) => setGone((s) => new Set(s).add(id));
  const restore = (id) => setGone((s) => {
    const next = new Set(s);
    next.delete(id);
    return next;
  });

  if (state.loading && !state.data) return <PinsSkeleton />;

  return (
    <Async state={state.data ? { ...state, loading: false } : state} empty="Nothing pinned yet" emptyIcon={PinIcon}>
      {(pins) => {
        const visible = pins.filter((msg) => !gone.has(msg.id));
        if (!visible.length) {
          return (
            <PanelEmpty icon={PinIcon}>Nothing pinned yet</PanelEmpty>
          );
        }
        return (
          <div className="flex flex-col gap-2">
            {visible.map((msg) => (
              <PinCard
                key={msg.id}
                msg={msg}
                guildId={guildId || msg.guild_id}
                onJump={() => { store.jumpTo(channelId, msg.id); close(); }}
                onUnpin={async () => {
                  forget(msg.id);
                  try {
                    await store.apiForChannel(channelId).unpin(channelId, msg.id);
                    toast('Unpinned.');
                  } catch (e) {
                    restore(msg.id);
                    reportError(e, 'Could not unpin');
                    state.reload();
                  }
                }}
              />
            ))}
          </div>
        );
      }}
    </Async>
  );
}

function ConversationPins({ conversationId, close }) {
  const store = useStore();
  useStoreEventFor(
    (e) => !e?.conversation_id || e.conversation_id === conversationId,
    'dm',
  );
  const pins = store.mls?.pinsIn ? store.mls.pinsIn(conversationId) : [];
  useEffect(() => { store.markPinsSeen(null, conversationId); });

  const frames = store.dmFrames.get(conversationId) || [];
  const when = new Map(frames.map((f) => [f.id, f.created_at]));

  const canUnpin = Boolean(store.mls?.joined?.(conversationId));

  if (!pins.length) {
    return (
      <PanelEmpty icon={PinIcon}>Nothing pinned yet</PanelEmpty>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {pins.map((pin) => (
        <PinCard
          key={pin.id}
          conversationId={conversationId}
          msg={{
            id: pin.id,
            author: pin.author || '',
            created_at: when.get(pin.id) || null,
            content: store.mls?.currentText?.(conversationId, pin.id) || pin.snippet || '',
            attachments: store.mls?.attachmentsOf?.(pin.id) || [],
          }}
          onJump={() => { store.jumpTo(conversationId, pin.id); close(); }}
          onUnpin={canUnpin ? async () => {
            try {
              await store.setPinDm(conversationId, pin.id, false);
              toast('Unpinned.');
            } catch (e) {
              reportError(e, 'Could not unpin');
            }
          } : null}
        />
      ))}
    </div>
  );
}

export function PinsPopover({ channelId, conversationId, anchor, close }) {
  return (
    <HeaderPanel
      anchor={anchor}
      close={close}
      label="Pinned messages"
      icon={PinIcon}
      title="Pinned messages"
      watch={[channelId, conversationId]}
    >
      <PinsList channelId={channelId} conversationId={conversationId} close={close} />
    </HeaderPanel>
  );
}

export function PinsButton({ channelId, conversationId, className }) {
  const store = useStore();
  const [anchor, setAnchor] = useState(null);
  const trigger = useRef(null);

  useEffect(() => store.on('open-pins', (ask) => {
    if (!ask || !trigger.current) return;
    if ((ask.channelId ?? null) !== (channelId ?? null)) return;
    if ((ask.conversationId ?? null) !== (conversationId ?? null)) return;
    ask.taken = true;
    setAnchor(trigger.current);
  }), [store, channelId, conversationId]);

  useStoreEvent('prefs');
  useStoreEventFor(
    (e) => Boolean(conversationId) && (!e?.conversation_id || e.conversation_id === conversationId),
    'dm',
  );
  useStoreEventFor((e) => Boolean(channelId) && e === channelId, 'pins');
  const count = store.unseenPinCount(channelId, conversationId);

  return (
    <>
      <IconButton
        title="Pinned messages"
        ref={trigger}
        className={cn('relative', className)}
        active={Boolean(anchor)}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        aria-label={count ? `Pinned messages, ${count}` : 'Pinned messages'}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <PinIcon />
        {count ? (
          <span className="tnum pointer-events-none absolute -top-1 -end-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[0.59375rem] font-semibold text-accent-foreground">
            {String(count)}
          </span>
        ) : null}
      </IconButton>
      {anchor ? (
        <PinsPopover
          channelId={channelId}
          conversationId={conversationId}
          anchor={anchor}
          close={() => setAnchor(null)}
        />
      ) : null}
    </>
  );
}

export function PinsDialog({ channelId, conversationId, close }) {
  return (
    <ModalShell
      title={<span className="header-panel-title"><PinIcon className="size-4 text-muted" />Pinned messages</span>}
      subtitle={conversationId
        ? 'Pins belong to this conversation, so everyone in it sees this same list.'
        : undefined}
      footer={<Button variant="ghost" onClick={close}>Close</Button>}
    >
      <PinsList channelId={channelId} conversationId={conversationId} close={close} />
    </ModalShell>
  );
}
