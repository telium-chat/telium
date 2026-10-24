import { useEffect, useMemo, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { embedFor, linksIn } from '../../lib/embeds.js';
import { isLikelyGifUrl, klipyConfig } from '../../lib/gifs.js';
import { EmojiText, GlobeIcon, LinkIcon } from '../../components/index.js';
import { isInviteUrl, InviteCard } from './InviteCard.jsx';
import { isGofileUrl, isPlayableLink } from './PlayableAttachment.jsx';
import { ImagePreview } from './ImagePreview.jsx';
import { EmbedVideo } from './EmbedVideo.jsx';

export function Embeds({ msg }) {
  const store = useStore();
  useStoreEvent('channels');
  const channel = store.channels.get(msg.channel_id);
  const stripped = Boolean(channel?.strip_embeds);
  const gifConfig = klipyConfig(store);
  const [cards, setCards] = useState([]);

  const { links, invites } = useMemo(() => {
    const found = stripped ? [] : linksIn(msg.content || '');
    return {
      links: found.filter((url) => (
        !isInviteUrl(url)
        && !isLikelyGifUrl(url, gifConfig)
        && !isPlayableLink(url)
        && !isGofileUrl(url)
      )),
      invites: found.filter(isInviteUrl),
    };
  }, [msg.content, stripped, gifConfig.mediaHosts.join('|')]);
  const key = links.join(' ');

  useEffect(() => {
    if (!key) { setCards([]); return undefined; }
    let live = true;
    const api = store.apiForChannel(msg.channel_id);
    Promise.all(links.map((url) => embedFor(api, url)))
      .then((all) => { if (live) setCards(all.filter(Boolean)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, msg.channel_id, key]);

  if (!cards.length && !invites.length) return null;
  return (
    <div className="flex flex-col items-start gap-2 pt-1.5">
      {cards.map((card) => <Card key={card.url} card={card} />)}
      {invites.map((url) => <InviteCard key={url} url={url} />)}
    </div>
  );
}

function Card({ card }) {
  const pictureOnly = card.kind === 'image' && !card.title && !card.description;

  const head = (
    <>
      <div className="embed__site">
        <GlobeIcon className="size-3 shrink-0" />
        <span>{card.site || 'external link'}</span>
      </div>
      {pictureOnly ? null : (
        <div className="embed__quote">
          {card.title ? (
            <div className="embed__title"><EmojiText>{card.title}</EmojiText></div>
          ) : (
            <div className="embed__title flex items-start gap-1.5">
              <LinkIcon className="size-3 shrink-0 translate-y-[3px]" />
              <span className="min-w-0">{card.url}</span>
            </div>
          )}
          {card.description ? <p className="embed__text">{card.description}</p> : null}
        </div>
      )}
    </>
  );

  return (
    <div title={`External link: ${card.url}`} className="embed embed--hoverable">
      <a href={card.url} target="_blank" rel="noreferrer noopener" className="block">
        {head}
      </a>
      {card.video ? <EmbedVideo card={card} /> : card.image ? (
        <div className="embed__media">
          <ImagePreview src={card.image} alt="" href={card.url} animated />
        </div>
      ) : null}
    </div>
  );
}
