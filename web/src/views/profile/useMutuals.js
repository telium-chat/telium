import { useEffect, useRef } from 'react';
import { useStoreEventFor } from '../../hooks/useStore.jsx';

const OFF = Object.freeze({ off: true });

export function useMutuals(store, userId, isMe) {
  useStoreEventFor((e) => e?.user_id === userId, 'mutuals');

  const off = !isMe && (store.mutualLookups?.() ?? 'open') === 'never';

  useEffect(() => {
    if (!isMe && !off) store.ensureMutuals(userId);
  }, [store, userId, isMe, off]);

  const held = isMe ? null : store.mutualsFor(userId);

  const opened = useRef(null);
  if (opened.current?.userId !== userId) {
    opened.current = { userId, cold: !isMe && !off && !held };
  }

  return {
    mutualFriends: off ? OFF : held?.friends,
    mutualGuilds: off ? OFF : held?.guilds,
    reserveMutuals: opened.current.cold,
  };
}
