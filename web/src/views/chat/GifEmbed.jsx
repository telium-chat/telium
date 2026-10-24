import { useEffect, useMemo, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  gifFavorites, gifUrlsIn, isGifOnlyContent, isGiphyShareUrl, isKlipyShareUrl,
  isTenorShareUrl, GiphyProvider, KlipyProvider, klipyConfig, tenorConfig,
  TenorProvider, toggleGifFavorite,
} from '../../lib/gifs.js';
import { IconButton, StarIcon } from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { ImagePreview } from './ImagePreview.jsx';

export function GifEmbeds({ content }) {
  const t = useT();
  const store = useStore();
  const config = klipyConfig(store);
  const provider = useMemo(() => new KlipyProvider(config), [
    config.enabled, config.apiKey, config.apiBaseUrl,
  ]);
  const tenor = tenorConfig(store);
  const tenorProvider = useMemo(() => new TenorProvider(tenor), [
    tenor.enabled, tenor.apiKey, tenor.clientKey, tenor.apiBaseUrl,
  ]);
  const giphyProvider = useMemo(() => new GiphyProvider(), []);
  const urls = useMemo(() => gifUrlsIn(content, config), [content, config.mediaHosts.join('|')]);
  const directUrls = urls.filter((url) => !isKlipyShareUrl(url) && !isTenorShareUrl(url) && !isGiphyShareUrl(url));
  const shareUrls = urls.filter((url) => isKlipyShareUrl(url) || isTenorShareUrl(url) || isGiphyShareUrl(url));
  const [resolved, setResolved] = useState([]);

  useEffect(() => {
    const controller = new AbortController();
    if (!shareUrls.length) {
      setResolved([]);
      return () => controller.abort();
    }
    setResolved([]);
    Promise.all(shareUrls.map(async (source) => {
      try {
        const resolver = isTenorShareUrl(source)
          ? tenorProvider
          : isGiphyShareUrl(source) ? giphyProvider : provider;
        return { source, url: await resolver.resolveShareUrl(source, { signal: controller.signal }) };
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        return { source, url: null };
      }
    })).then((items) => {
      if (!controller.signal.aborted) setResolved(items.filter(Boolean));
    });
    return () => {
      controller.abort();
      provider.cancel();
      tenorProvider.cancel();
    };
  }, [provider, tenorProvider, shareUrls.join('|')]);

  const resolvedUrls = resolved.filter((item) => item.url);
  const unresolvedUrls = resolved.filter((item) => !item.url).map((item) => item.source);
  if (!directUrls.length && !resolvedUrls.length && !unresolvedUrls.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1.5" data-gif-embeds>
      {directUrls.map((url) => <GifEmbed key={url} url={url} />)}
      {resolvedUrls.map(({ source, url }) => <GifEmbed key={source} url={url} linkUrl={source} />)}
      {unresolvedUrls.map((url) => (
        <a
          key={url}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="embed embed--inline embed--hoverable text-sm text-accent"
        >
          {t('chat.gif.openOn', {
            provider: isTenorShareUrl(url) ? 'Tenor' : isGiphyShareUrl(url) ? 'Giphy' : 'Klipy',
          })}
        </a>
      ))}
    </div>
  );
}

export function GifEmbed({ url, alt = null, linkUrl = url }) {
  const t = useT();
  const store = useStore();
  useStoreEvent('gif-favorites');
  const [broken, setBroken] = useState(false);
  const favorite = gifFavorites(store.sync).includes(url);

  useEffect(() => { setBroken(false); }, [url]);

  return (
    <div className="gif-embed group">
      {broken ? (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="block px-3 py-2 text-sm text-accent hover:underline"
        >
          {t('chat.gif.unavailable')}
        </a>
      ) : (
        <ImagePreview
          src={url}
          alt={alt || t('chat.gif.untitled')}
          href={linkUrl}
          animated
          gif
          onError={() => setBroken(true)}
        />
      )}
      <IconButton
        title={favorite ? t('chat.gif.unfavorite') : t('chat.gif.favorite')}
        active={favorite}
        onClick={() => toggleGifFavorite(store, url)}
        className="touch-visible-action pointer-events-none absolute top-1.5 end-1.5 size-10 rounded-[var(--radius-row)] bg-background/85 opacity-0 backdrop-blur-sm group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 sm:size-8"
      >
        <StarIcon className={favorite ? 'size-4 fill-current text-accent' : 'size-4'} />
      </IconButton>
    </div>
  );
}

export { isGifOnlyContent };
