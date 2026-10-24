import { linksIn } from '../../lib/embeds.js';
import { isPlayableLink, PlayableLink } from './PlayableAttachment.jsx';

export function PlayableLinkEmbeds({ content }) {
  const urls = linksIn(content || '').filter(isPlayableLink);
  if (!urls.length) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-1.5">
      {urls.map((url) => <PlayableLink key={url} url={url} />)}
    </div>
  );
}
