import { useRef, useState } from 'react';
import { PlayIcon } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';

function ratioOf(card) {
  const w = Number(card.video_width);
  const h = Number(card.video_height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return null;
  return `${Math.round(w)} / ${Math.round(h)}`;
}

export function EmbedVideo({ card }) {
  const t = useT();
  const ref = useRef(null);
  const [started, setStarted] = useState(false);
  const ratio = ratioOf(card);
  const style = ratio ? { '--embed-ratio': ratio } : undefined;

  const start = () => {
    setStarted(true);
    ref.current?.play().catch(() => {});
  };

  return (
    <div className="embed__player" style={style}>
      <video
        ref={ref}
        poster={card.image || undefined}
        controls={started}
        playsInline
        preload="none"
        aria-label={card.title ? `Video: ${card.title}` : 'Video'}
      >
        <source src={card.video} type={card.video_type || undefined} />
      </video>
      {started ? null : (
        <button
          type="button"
          className="embed__play"
          onClick={start}
          aria-label={card.title
            ? t('chat.embed.playVideoTitled', { title: card.title })
            : t('chat.embed.playVideo')}
        >
          <PlayIcon className="size-5" />
        </button>
      )}
    </div>
  );
}
