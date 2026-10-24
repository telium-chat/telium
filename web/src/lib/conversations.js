
import { faceOf } from './faces.js';
import { participants, shortName } from './util.js';

/// `{ ref, base, mediaOrigin }` rather than a URL, so a long rail doesn't fan out to other homeservers. No presence data means no bubble: unknown is not offline.
export function dmPeer(store, userId) {
  if (!userId) return null;
  const face = faceOf(store, userId);
  const live = store.presence.get(userId) || store.friends.get(userId)?.presence || null;
  return {
    ...face,
    presence: live?.status || null,
    live,
  };
}

export function conversationTitle(store, convo) {
  if (convo.name) return convo.name;
  const others = participants(convo).filter((m) => (m.user_id || m) !== store.me?.user_id);
  if (!others.length) return 'Just you';
  return others.map((m) => shortName(m.user_id || m)).join(', ');
}
