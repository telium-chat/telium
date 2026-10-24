import { describe, expect, it } from 'vitest';
import {
  discordGifFavoriteUrls, exportGifFavoritesJson, processAndRehostFavorites,
} from '../views/user-settings/GifFavoritesPane.jsx';

describe('Discord GIF favorites import', () => {
  it('reads the exported URL map and preserves its order', () => {
    expect(discordGifFavoriteUrls({
      'https://tenor.com/view/second-gif-2': { order: 20, src: 'https://media.tenor.com/second.mp4' },
      'https://cdn.example/first.gif': { order: 10 },
    })).toEqual([
      'https://cdn.example/first.gif',
      'https://tenor.com/view/second-gif-2',
    ]);
  });

  it('accepts a URL list, removes invalid URLs, and tolerates missing metadata', () => {
    expect(discordGifFavoriteUrls([
      'http://insecure.example/a.gif',
      'https://example.test/a.gif',
      'not a URL',
    ])).toEqual(['https://example.test/a.gif']);
  });
});

describe('GIF favorites export', () => {
  it('writes favorites as a JSON list and drops what is not a URL', () => {
    expect(exportGifFavoritesJson([
      'https://tenor.com/view/second-gif-2',
      'http://insecure.example/a.gif',
      'https://example.test/a.gif',
    ])).toBe(
      '[\n  "https://tenor.com/view/second-gif-2",\n  "https://example.test/a.gif"\n]\n',
    );
  });

  it('round-trips through the JSON import unchanged', async () => {
    const favorites = [
      'https://tenor.com/view/second-gif-2',
      'https://example.test/a.gif',
    ];
    const document = JSON.parse(exportGifFavoritesJson(favorites));
    const { urls } = await processAndRehostFavorites({ document });
    expect(urls).toEqual(favorites);
    expect(discordGifFavoriteUrls(document)).toEqual(favorites);
  });

  it('exports nothing when there is nothing to export', () => {
    expect(exportGifFavoritesJson([])).toBe('[]\n');
    expect(exportGifFavoritesJson(null)).toBe('[]\n');
  });
});
