import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { HashIcon } from '../components/index.js';
import { Conversation, ConversationStart } from './chat/Conversation.jsx';
import { useChannelSurface } from './chat/surface.jsx';

export function ChatView({ channelId, mobile = false, onOpenNavigation }) {
  const store = useStore();
  const guildId = store.channels.get(channelId)?.guild_id;
  useStoreEvent('channels');
  useStoreEventFor((e) => channelOf(e) === channelId, 'message', 'message-update', 'history', 'threads', 'typing', 'pins');
  useStoreEventFor((g) => !g || g === guildId, 'members', 'roles');

  const surface = useChannelSurface(channelId);

  const [loading, setLoading] = useState(() => !(store.messages.get(channelId) || []).length);
  const [error, setError] = useState(null);
  const [fetchingOlder, setFetchingOlder] = useState(false);

  const firstUnread = useRef(null);

  const channel = store.channels.get(channelId);
  const list = store.messages.get(channelId) || [];

  useEffect(() => {
    store.openTimeline(channelId);
    return () => store.closeTimeline(channelId);
  }, [store, channelId]);

  useEffect(() => {
    let live = true;
    const state = store.unreadFor(channelId);
    firstUnread.current = state.unread > 0 ? state.last_read_id : null;
    setLoading(!(store.messages.get(channelId) || []).length);
    setError(null);
    store.loadChannelPins(channelId);
    store.loadHistory(channelId)
      .then(() => {
        if (!live) return;
        setLoading(false);
        store.ack(channelId);
        loadThreads();
      })
      .catch((e) => { if (live) { setError(e); setLoading(false); } });

    async function loadThreads() {
      const ch = store.channels.get(channelId);
      if (!ch || ch.type === 'thread') return;
      try {
        const resp = await store.apiForChannel(ch.id).threads(ch.id, false);
        store.threads.set(ch.id, resp.threads || []);
        store.emit('threads', ch.id);
      } catch { /* threads are an enhancement; a failure must not blank the channel */ }
    }

    return () => { live = false; };
  }, [store, channelId]);

  const loadOlder = useCallback(async () => {
    const current = store.messages.get(channelId) || [];
    if (!current.length) return;
    setFetchingOlder(true);
    try { await store.loadHistory(channelId, { before: current[0].id }); }
    finally { setFetchingOlder(false); }
  }, [store, channelId]);

  const send = useCallback(async (body, content, nonce) => {
    const resp = await store.apiForChannel(channelId).send(
      channelId,
      nonce ? { ...body, nonce } : body,
    );
    if (resp?.id) {
      if (nonce) resp.nonce = nonce;
      store.onMessage(store.channels.get(channelId)?.domain, resp);
    }
    return resp;
  }, [store, channelId]);

  const typing = [...(store.typing.get(channelId) || new Map()).keys()]
    .filter((u) => u !== store.me?.user_id);

  return (
    <Conversation
      surface={surface}
      items={list}
      typing={typing}
      loading={loading}
      error={error}
      intro={<ChannelIntro channel={channel} />}
      hasMore={Boolean(store.hasMore.get(channelId))}
      fetchingOlder={fetchingOlder}
      onLoadOlder={loadOlder}
      firstUnread={firstUnread.current}
      send={channel ? send : null}
      mobile={mobile}
      onOpenNavigation={onOpenNavigation}
    />
  );
}

function channelOf(event) {
  if (typeof event === 'string') return event;
  return event?.channel_id ?? event?.channelId ?? null;
}

function ChannelIntro({ channel }) {
  if (!channel) return null;
  return (
    <ConversationStart
      mark={(
        <div className="flex size-11 items-center justify-center rounded-2xl bg-surface-secondary">
          <HashIcon className="size-5 text-muted" />
        </div>
      )}
      title={channel.type === 'thread' ? channel.name : `#${channel.name}`}
      blurb={channel.topic || 'This is the beginning of the channel.'}
    />
  );
}
