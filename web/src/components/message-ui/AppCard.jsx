import { EmojiText } from '../Twemoji.jsx';
import { AppsIcon } from '../icons.jsx';
import { ImagePreview } from '../../views/chat/ImagePreview.jsx';

function stamp(iso) {
  const at = new Date(iso);
  return at.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function AppCards({ cards, appName }) {
  if (!cards?.length) return null;
  return (
    <div className="appcards">
      {cards.map((card, at) => (
        // Cards have no ids; position is the identity.
        // eslint-disable-next-line react/no-array-index-key
        <AppCard key={at} card={card} appName={appName} />
      ))}
    </div>
  );
}

export function AppCard({ card, appName }) {
  const style = card.accent ? { '--mc-accent': card.accent } : undefined;

  return (
    <article className="appcard" style={style} aria-label={appName ? `Card from ${appName}` : 'Card'}>
      <div className="appcard__from">
        <AppsIcon className="appcard__from-glyph" aria-hidden="true" />
        <span className="appcard__from-name">{appName || 'Application'}</span>
      </div>

      <div className="appcard__body">
        <div className="appcard__main">
          {card.author ? (
            <div className="appcard__author">
              {card.author.icon ? (
                <img className="appcard__author-icon" src={card.author.icon} alt="" loading="lazy" />
              ) : null}
              {card.author.url ? (
                <a
                  className="appcard__author-name"
                  href={card.author.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={card.author.url}
                >
                  <EmojiText>{card.author.name}</EmojiText>
                </a>
              ) : (
                <span className="appcard__author-name"><EmojiText>{card.author.name}</EmojiText></span>
              )}
            </div>
          ) : null}

          {card.title ? (
            card.url ? (
              <a
                className="appcard__title appcard__title--link"
                href={card.url}
                target="_blank"
                rel="noreferrer noopener"
                title={card.url}
              >
                <EmojiText>{card.title}</EmojiText>
              </a>
            ) : (
              <h4 className="appcard__title"><EmojiText>{card.title}</EmojiText></h4>
            )
          ) : null}

          {card.description ? (
            <p className="appcard__text"><EmojiText>{card.description}</EmojiText></p>
          ) : null}

          {card.fields.length ? (
            <div className="appcard__fields">
              {card.fields.map((field, at) => (
                // eslint-disable-next-line react/no-array-index-key
                <div key={at} className={`appcard__field${field.inline ? '' : ' is-wide'}`}>
                  {field.name ? (
                    <div className="appcard__field-name"><EmojiText>{field.name}</EmojiText></div>
                  ) : null}
                  {field.value ? (
                    <div className="appcard__field-value"><EmojiText>{field.value}</EmojiText></div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {card.thumbnail ? (
          <img className="appcard__thumb" src={card.thumbnail} alt="" loading="lazy" />
        ) : null}
      </div>

      {card.image ? (
        <div className="appcard__media">
          <ImagePreview src={card.image} alt="" />
        </div>
      ) : null}

      {card.footer || card.timestamp ? (
        <div className="appcard__foot">
          {card.footer?.icon ? (
            <img className="appcard__foot-icon" src={card.footer.icon} alt="" loading="lazy" />
          ) : null}
          {card.footer?.text ? (
            <span className="appcard__foot-text"><EmojiText>{card.footer.text}</EmojiText></span>
          ) : null}
          {card.footer?.text && card.timestamp ? <span aria-hidden="true">&middot;</span> : null}
          {card.timestamp ? (
            <time className="appcard__foot-time" dateTime={card.timestamp}>{stamp(card.timestamp)}</time>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
