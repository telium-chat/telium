import { useMemo } from 'react';
import { normalizeCards, normalizeComponents } from '../../lib/interactions.js';
import { useStore } from '../../hooks/useStore.jsx';
import { AppCards } from './AppCard.jsx';
import { MessageComponents } from './MessageComponents.jsx';

export function appNameFor(member, author) {
  return member?.nickname || member?.display_name
    || String(author || '').replace(/^@/, '').split(':')[0] || null;
}

export function AppMessage({ msg, member, base }) {
  const store = useStore();

  const cards = useMemo(
    () => normalizeCards(msg.cards, { store, base }),
    [store, base, msg.cards],
  );
  const rows = useMemo(() => normalizeComponents(msg.components), [msg.components]);

  if (member && member.is_bot === false) return null;
  if (!cards.length && !rows.length) return null;

  const appName = appNameFor(member, msg.author);
  return (
    <>
      <AppCards cards={cards} appName={appName} />
      <MessageComponents msg={msg} rows={rows} appName={appName} />
    </>
  );
}
