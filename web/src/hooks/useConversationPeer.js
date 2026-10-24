import { useStore, useStoreEventFor } from './useStore.jsx';
import { conversationTitle, dmPeer } from '../lib/conversations.js';
import { participants } from '../lib/util.js';

export function useConversationPeer(convo) {
  const store = useStore();
  const conversationId = convo?.id || null;
  const peers = participants(convo)
    .map((m) => m.user_id || m)
    .filter((id) => id && id !== store.me?.user_id);
  useStoreEventFor((e) => peers.includes(e?.user_id), 'presence', 'peers', 'identity');
  useStoreEventFor(
    (e) => Boolean(conversationId) && e?.conversation_id === conversationId,
    'dm',
  );

  const faces = peers.map((id) => dmPeer(store, id)).filter(Boolean);
  const peer = convo?.kind === 'dm' ? (faces[0] || null) : null;
  if (convo?.kind === 'dm') store.ensureProfile(peers[0]);

  const typing = conversationId ? store.dmTypistsIn(conversationId) : [];

  return {
    peers,
    peer,
    faces,
    title: peer?.name || (convo ? conversationTitle(store, convo) : ''),
    typing,
    peerTyping: Boolean(peer) && typing.includes(peer.id),
  };
}
