import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { useMenus } from '../menus.jsx';
import { shortName } from '../../lib/util.js';
import { has, PERMISSION_MASKS } from '../../lib/perms.js';
import { narrowestLimit, uploadAttachment, uploadEncrypted } from '../../lib/upload.js';
import { faceOf } from '../../lib/faces.js';
import { InfoIcon, MenuItem, MenuSeparator } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { DeliveryDetails } from './DeliveryDetails.jsx';
import { DEVICE_APPROVAL, NO_ENCRYPTION, noteText } from './encryption.jsx';

const EMPTY = [];

const DELIVERY_KEY = {
  sent: 'chat.surface.delivery.sent',
  delivered: 'chat.surface.delivery.delivered',
  read: 'chat.surface.delivery.read',
};

const DM_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY',
  'ADD_REACTIONS', 'ATTACH_FILES', 'EMBED_LINKS', 'USE_EXTERNAL_EMOJI']
  .reduce((bits, name) => bits | PERMISSION_MASKS.get(name), 0n);


const IDLE = 650;

function useTypingSignal(store, key, start, stop) {
  const held = useRef({ idle: null, on: false, start, stop });
  held.current.start = start;
  held.current.stop = stop;

  useEffect(() => {
    const state = held.current;
    const stopThis = stop;
    return () => {
      clearTimeout(state.idle);
      state.idle = null;
      if (!state.on) return;
      state.on = false;
      stopThis();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useCallback((active = true) => {
    const state = held.current;
    if (!active || store.prefs.typing === false) {
      clearTimeout(state.idle);
      state.idle = null;
      if (!state.on) return;
      state.on = false;
      state.stop();
      return;
    }
    if (!state.on) {
      state.on = true;
      state.start();
    }
    clearTimeout(state.idle);
    state.idle = setTimeout(() => {
      state.idle = null;
      if (!state.on) return;
      state.on = false;
      state.stop();
    }, IDLE);
  }, [store, key]);
}

function readOnlyBlock(t, store) {
  return t('chat.surface.standby', {
    home: store.session?.home?.domain,
    standby: store.fallback?.standby,
  });
}

export function useChannelSurface(channelId) {
  const store = useStore();
  const menus = useMenus();
  const t = useT();
  const channel = store.channels.get(channelId);
  const guildId = channel?.guild_id;
  const perms = store.permissionsIn(channelId);
  const members = store.members.get(guildId);
  const thread = channel?.type === 'thread'
    ? (store.threads.get(channel.parent_id) || []).find((t) => t.id === channel.id)
    : null;
  const timeout = store.myMember(guildId)?.timeout_until;
  const timedOut = timeout && new Date(timeout).getTime() > Date.now();
  const sendBlock = store.isReadOnly()
    ? readOnlyBlock(t, store)
    : thread?.locked
    ? t('chat.surface.threadLocked')
    : has(perms, 'SEND_MESSAGES')
      ? null
      : timedOut
        ? t('chat.surface.timedOut')
        : t('chat.surface.noPermission');
  const origin = store.mediaPreference?.tier === 2
    ? store.mediaPreference.origin
    : store.session?.home?.domain;
  const expiryCap = narrowestLimit(
    channel?.media_expiry_limit_secs ?? null,
    store.guilds.get(guildId)?.media_expiry_limit_secs ?? null,
    store.caps.get(origin)?.media?.max_expiry_secs || null,
  );
  const uploadLimit = narrowestLimit(
    channel?.media_max_file_bytes ?? null,
    store.guilds.get(guildId)?.media_max_file_bytes ?? null,
    store.caps.get(origin)?.media?.max_file_bytes || null,
  );
  const mediaTier = store.mediaPreference?.tier || 1;
  const externalHosts = store.externalMediaHosts || EMPTY;
  const typing = useTypingSignal(
    store,
    channelId,
    () => {
      store.setLocalTyping(channelId, true);
      store.gw.typing(channel?.domain, channelId);
    },
    () => {
      store.setLocalTyping(channelId, false);
      store.gw.stopTyping(channel?.domain, channelId);
    },
  );

  return useMemo(() => ({
    kind: 'channel',
    id: channelId,
    guildId,
    perms,
    encrypted: false,
    dropTarget: channel
      ? (channel.type === 'thread' ? channel.name : `#${channel.name}`)
      : null,
    placeholder: channel
      ? t('chat.surface.placeholder', {
        target: channel.type === 'thread' ? channel.name : `#${channel.name}`,
      })
      : t('chat.surface.placeholderPlain'),
    avatarBase: store.apiForGuild(guildId)?.base,
    avatarFor: (msg, member) => {
      const face = faceOf(store, msg.author, { guildId });
      return {
        name: member?.display_name || face?.name || undefined,
        mediaRef: face?.avatarRef || null,
        base: face?.base,
        mediaOrigin: face?.mediaOrigin || undefined,
      };
    },
    sendBlock,
    mayAttach: has(perms, 'ATTACH_FILES'),
    stickers: true,
    expiryCap,
    uploadLimit,
    mediaTier,
    externalHosts,
    upload: (file, opts) => uploadAttachment(store, channel, file, opts),
    typing,
    memberOf: (userId) => members?.get(userId),
    colourFor: (userId) => store.colourFor(guildId, userId),
    react: (msg, emoji) => store.setOwnReaction(msg.channel_id, msg.id, emoji, true),
    unreact: (msg, emoji) => store.setOwnReaction(msg.channel_id, msg.id, emoji, false),
    remove: (msg) => store.deleteMessageNow(msg.channel_id, msg.id),
    edit: (msg, content) => store.editMessageNow(msg.channel_id, msg.id, content),
    mayEdit: (msg) => msg.author === store.me?.user_id,
    isPinned: (msg) => Boolean(store.channelPins.get(channelId)?.has(msg.id)),
    mayPin: () => has(perms, 'MANAGE_MESSAGES'),
    mayDelete: (msg) => msg.author === store.me?.user_id || has(perms, 'MANAGE_MESSAGES'),
    pin: async (msg) => {
      const api = store.apiForChannel(msg.channel_id);
      try { await api.pin(msg.channel_id, msg.id); return 'pinned'; }
      catch (e) {
        if (e.status !== 409) throw e;
        await api.unpin(msg.channel_id, msg.id);
        return 'unpinned';
      }
    },
    canJump: true,
    jump: (msg) => store.jumpTo(msg.channel_id, msg.reply_to),
    ack: () => store.ack(channelId),
    menu: (msg, handlers) => menus.message(msg, handlers),
    reactors: (reaction) => (reaction.users || []).map((id) => {
      const m = members?.get(id);
      const face = faceOf(store, id, { guildId });
      return {
        id,
        name: m?.nickname || m?.display_name || face?.name || shortName(id),
        avatarRef: face?.avatarRef || null,
        avatarBase: face?.base || null,
        mediaOrigin: face?.mediaOrigin || null,
        me: id === store.me?.user_id,
      };
    }),
  }), [store, menus, t, typing, channelId, guildId, perms, members, sendBlock, expiryCap,
    mediaTier, externalHosts, channel?.name, channel?.type, channel?.domain]);
}

export function useDmSurface(convo) {
  const store = useStore();
  const menus = useMenus();
  const modal = useModal();
  const t = useT();
  const conversationId = convo?.id;
  const typing = useTypingSignal(
    store,
    conversationId,
    () => store.notifyTyping(conversationId),
    () => store.notifyTypingStop(conversationId),
  );

  return useMemo(() => ({
    kind: 'dm',
    id: conversationId,
    guildId: null,
    perms: DM_PERMISSIONS,
    encrypted: true,
    dropTarget: null,
    placeholder: t('chat.surface.placeholderPlain'),
    avatarBase: store.home?.base,
    avatarFor: (msg) => {
      const face = faceOf(store, msg.author);
      return { name: face?.name, mediaRef: face?.avatarRef || null, base: face?.base, mediaOrigin: face?.mediaOrigin };
    },
    sendBlock: store.isReadOnly()
      ? readOnlyBlock(t, store)
      : !store.mls
        ? noteText(NO_ENCRYPTION)
        : store.vault?.needs_device
          ? noteText(DEVICE_APPROVAL)
          : null,
    mayAttach: true,
    stickers: false,
    expiryCap: store.caps.get(store.session?.home?.domain)?.media?.max_expiry_secs || null,
    uploadLimit: store.caps.get(store.session?.home?.domain)?.media?.max_file_bytes || null,
    mediaTier: 1,
    externalHosts: EMPTY,
    upload: (file, opts) => uploadEncrypted(store.home, file, opts),
    typing,
    people: () => (convo?.members || []).map((m) => m.user_id).filter(Boolean),
    memberOf: () => undefined,
    colourFor: () => undefined,
    react: (msg, emoji) => store.reactDm(conversationId, msg.id, emoji),
    unreact: (msg, emoji) => store.unreactDm(conversationId, msg.id, emoji),
    remove: (msg) => store.deleteDm(conversationId, msg.id),
    edit: (msg, content) => store.editDm(conversationId, msg.id, content),
    mayEdit: (msg) => msg.author === store.me?.user_id,
    canJump: false,
    jump: () => false,
    ack: () => store.markConversationRead(conversationId),
    menu: (msg, handlers) => (
      <>
        {menus.conversationMessage(convo, msg, handlers)}
        {msg.delivery ? (
          <>
            <MenuSeparator />
            <MenuItem
              icon={InfoIcon}
              onAction={() => modal.open((close) => (
                <DeliveryDetails
                  close={close}
                  people={msg.deliveredTo || []}
                  state={msg.delivery}
                />
              ))}
            >
              {DELIVERY_KEY[msg.delivery] ? t(DELIVERY_KEY[msg.delivery]) : msg.delivery}
            </MenuItem>
          </>
        ) : null}
      </>
    ),
    reactors: (reaction) => (reaction.users || []).map((id) => {
      const face = faceOf(store, id);
      return {
        id,
        name: face?.name || shortName(id),
        avatarRef: face?.avatarRef || null,
        avatarBase: face?.base || null,
        mediaOrigin: face?.mediaOrigin || null,
        me: id === store.me?.user_id,
      };
    }),
    isPinned: (msg) => Boolean(store.mls?.pinsIn?.(conversationId)?.some((p) => p.id === msg.id)),
    togglePin: (msg, pin) => store.setPinDm(conversationId, msg.id, pin),
    mayPin: (msg) => !msg.unreadable,
    mayDelete: (msg) => msg.author === store.me?.user_id,
    pin: async (msg) => {
      await store.setPinDm(conversationId, msg.id, !msg.pinned);
      return msg.pinned ? 'unpinned' : 'pinned';
    },
  }), [store, menus, modal, t, typing, convo, conversationId, store.fallback]);
}

export function useDmItems(frames, convo, mls, me, callLogs = []) {
  const cache = useRef(new Map());
  const conversationId = convo?.id;
  const items = [];
  const seen = new Set();

  for (const frame of frames) {
    if (frame.kind === 'application' && mls?.isSignal(frame.id)) continue;
    if (frame.kind !== 'application') continue;
    const deleted = Boolean(mls?.isDeleted?.(conversationId, frame.id));
    const text = mls?.currentText ? mls.currentText(conversationId, frame.id) : mls?.textOf(frame.id);
    if (!deleted && text === undefined) continue;
    const quote = mls?.replyOf ? mls.replyOf(frame.id) : null;
    items.push(hold(cache.current, seen, {
      kind: 'msg',
      id: frame.id,
      nonce: frame.nonce || undefined,
      channel_id: conversationId,
      guild_id: null,
      author: frame.sender,
      created_at: frame.created_at,
      content: deleted ? '' : (text ?? ''),
      unreadable: false,
      deleted,
      edited_at: mls?.isEdited?.(conversationId, frame.id) ? frame.created_at : null,
      saving: Boolean(mls?.isSaving?.(conversationId, frame.id)),
      attachments: deleted ? [] : (mls?.attachmentsOf(frame.id) || []),
      reactions: deleted ? [] : reactionsOf(mls, conversationId, frame.id, me),
      reply_to: quote?.id || null,
      parent: quote ? { author: quote.author, content: quote.text || '' } : null,
      pinned: Boolean(mls?.pinsIn?.(conversationId)?.some((p) => p.id === frame.id)),
      delivery: me && frame.sender === me && !deleted
        ? (mls?.deliveryState?.(conversationId, frame) || null)
        : null,
      deliveredTo: me && frame.sender === me && !deleted
        ? (mls?.deliveryBreakdown?.(conversationId, frame.id) || [])
        : [],
    }));
  }

  for (const key of cache.current.keys()) if (!seen.has(key)) cache.current.delete(key);
  for (const entry of callLogs || []) {
    if (!entry || entry.conversationId !== conversationId) continue;
    items.push(hold(cache.current, seen, {
      kind: 'call',
      id: entry.id,
      channel_id: conversationId,
      guild_id: null,
      author: entry.from || null,
      created_at: entry.at,
      callKind: entry.kind,
      durationMs: entry.durationMs ?? null,
    }));
  }
  items.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return items;
}

export function hasUnavailableDmHistory(frames, conversationId, mls) {
  if (!mls) return false;
  const walked = mls.walkedTo?.(conversationId) || 0;
  return (frames || []).some((frame) => {
    if (frame.kind !== 'application' || (frame.seq || 0) > walked) return false;
    if (mls.isSignal?.(frame.id) || mls.isDeleted?.(conversationId, frame.id)) return false;
    const text = mls.currentText
      ? mls.currentText(conversationId, frame.id)
      : mls.textOf?.(frame.id);
    return text === undefined;
  });
}

function reactionsOf(mls, conversationId, frameId, me) {
  return (mls?.reactionsTo(conversationId, frameId) || []).map((r) => ({
    emoji: r.emoji,
    count: r.count,
    users: r.users,
    me: r.users.includes(me),
  }));
}

function hold(cache, seen, next) {
  seen.add(next.id);
  const prev = cache.get(next.id);
  if (prev && same(prev, next)) return prev;
  cache.set(next.id, next);
  return next;
}

function sameDelivery(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((row, i) => row.userId === b[i].userId
    && row.devices === b[i].devices
    && row.read === b[i].read);
}

function same(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'call') {
    return a.callKind === b.callKind
      && a.created_at === b.created_at
      && a.author === b.author
      && (a.durationMs ?? null) === (b.durationMs ?? null);
  }
  return a.content === b.content
    && a.nonce === b.nonce
    && a.author === b.author
    && a.created_at === b.created_at
    && a.deleted === b.deleted
    && a.unreadable === b.unreadable
    && a.edited_at === b.edited_at
    && a.saving === b.saving
    && a.pinned === b.pinned
    && a.delivery === b.delivery
    && sameDelivery(a.deliveredTo, b.deliveredTo)
    && a.reply_to === b.reply_to
    && a.attachments.length === b.attachments.length
    && a.attachments.every((att, i) => (att.ref || att.hash) === (b.attachments[i].ref || b.attachments[i].hash))
    && a.reactions.length === b.reactions.length
    && a.reactions.every((r, i) => r.emoji === b.reactions[i].emoji
      && r.count === b.reactions[i].count
      && r.me === b.reactions[i].me);
}
