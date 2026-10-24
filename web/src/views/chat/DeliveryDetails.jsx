import { Avatar, Button, Hint, ModalShell } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { shortName } from '../../lib/util.js';

const TITLE = { sent: 'chat.delivery.title.sent', delivered: 'chat.delivery.title.delivered', read: 'chat.delivery.title.read' };

function subtitleKeyFor(state, count) {
  if (state === 'delivered') return 'chat.delivery.subtitle.delivered';
  if (state === 'read') return 'chat.delivery.subtitle.read';
  return count ? 'chat.delivery.subtitle.some' : 'chat.delivery.subtitle.none';
}

export function DeliveryDetails({ state, people, close }) {
  const t = useT();
  return (
    <ModalShell
      title={t(TITLE[state] || 'chat.delivery.title.fallback')}
      subtitle={t(subtitleKeyFor(state, people.length))}
      footer={<Button variant="tertiary" onClick={close}>{t('common.close')}</Button>}
    >
      {people.length ? (
        <div className="delivery-list">
          {people.map((person) => (
            <div
              className="delivery-row"
              data-delivered-to={person.userId}
              key={person.userId}
            >
              <Avatar id={person.userId} size="sm" />
              <span className="delivery-row__name">{shortName(person.userId)}</span>
              <span className="delivery-row__devices">{t('chat.delivery.devices', { count: person.devices })}</span>
              {person.read ? <span className="delivery-row__read">{t('chat.delivery.read')}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="delivery-empty">{t('chat.delivery.empty')}</p>
      )}
      <Hint>{t('chat.delivery.receiptsHint')}</Hint>
    </ModalShell>
  );
}
