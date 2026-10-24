import { useOptionalStore } from '../hooks/useStore.jsx';
import { Pill } from './Feedback.jsx';
import { cn } from '../lib/cn.js';

export function botMember(store, userId, guildId) {
  if (!store || !userId) return null;
  const here = guildId ? store.members.get(guildId)?.get(userId) : null;
  if (here) return here;
  for (const roster of store.members.values()) {
    const row = roster?.get?.(userId);
    if (row?.is_bot) return row;
  }
  return null;
}

export function isBotAccount(store, userId, guildId, member) {
  const row = member || botMember(store, userId, guildId);
  return row?.is_bot === true || store?.identityOf?.(userId)?.is_bot === true;
}

export function BotBadge({ userId, guildId, member, className }) {
  const store = useOptionalStore();
  if (!isBotAccount(store, userId, guildId, member)) return null;
  return (
    <Pill tone="accent" className={cn('shrink-0', className)}>BOT</Pill>
  );
}
