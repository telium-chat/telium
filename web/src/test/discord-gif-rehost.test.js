import { describe, expect, it, vi } from 'vitest';
import {
  isDiscordCdnUrl,
  getCleanDiscordCdnUrl,
  extractFilenameFromUrl,
  processAndRehostFavorites,
} from '../views/user-settings/GifFavoritesPane.jsx';

describe('Discord GIF Re-hosting & Import Helpers', () => {
  describe('isDiscordCdnUrl', () => {
    it('identifies expiring Discord CDN attachment URLs', () => {
      expect(isDiscordCdnUrl('https://cdn.discordapp.com/attachments/123/456/test.gif')).toBe(true);
      expect(isDiscordCdnUrl('https://media.discordapp.net/attachments/123/456/test.gif?ex=66f&is=66f&hm=abc')).toBe(true);
      expect(isDiscordCdnUrl('https://cdn.discordapp.com/ephemeral-attachments/123/456/test.gif')).toBe(true);
    });

    it('rejects external providers and permanent Discord assets', () => {
      expect(isDiscordCdnUrl('https://tenor.com/view/cat-vibing-123')).toBe(false);
      expect(isDiscordCdnUrl('https://media.tenor.com/abc/cat.mp4')).toBe(false);
      expect(isDiscordCdnUrl('https://media3.giphy.com/media/xyz/giphy.gif')).toBe(false);
      expect(isDiscordCdnUrl('https://images-ext-1.discordapp.net/external/abc/https/tenor.com/test.gif')).toBe(false);
      expect(isDiscordCdnUrl('https://cdn.discordapp.com/emojis/123.webp')).toBe(false);
      expect(isDiscordCdnUrl('invalid-url')).toBe(false);
      expect(isDiscordCdnUrl(null)).toBe(false);
    });
  });

  describe('getCleanDiscordCdnUrl', () => {
    it('strips client-side transformation params while preserving auth signatures', () => {
      const input = 'https://media.discordapp.net/attachments/123/456/anim.gif?format=webp&animated=true&width=400&height=300&ex=66f5&is=66f4&hm=secret';
      const cleaned = getCleanDiscordCdnUrl(input);
      expect(cleaned).toContain('ex=66f5');
      expect(cleaned).toContain('is=66f4');
      expect(cleaned).toContain('hm=secret');
      expect(cleaned).not.toContain('format=webp');
      expect(cleaned).not.toContain('animated=true');
      expect(cleaned).not.toContain('width=400');
      expect(cleaned).not.toContain('height=300');
    });

    it('leaves external URLs unchanged', () => {
      const tenor = 'https://media.tenor.com/abc/test.mp4';
      expect(getCleanDiscordCdnUrl(tenor)).toBe(tenor);
    });
  });

  describe('extractFilenameFromUrl', () => {
    it('extracts filename from URL path', () => {
      expect(extractFilenameFromUrl('https://cdn.discordapp.com/attachments/123/456/cool_cat.gif?ex=1')).toBe('cool_cat.gif');
      expect(extractFilenameFromUrl('https://media.tenor.com/123/video.mp4')).toBe('video.mp4');
    });

    it('derives extension from content type if missing or default', () => {
      expect(extractFilenameFromUrl('https://cdn.discordapp.com/attachments/123/456/unnamed', 'video/mp4')).toBe('unnamed.mp4');
      expect(extractFilenameFromUrl('https://cdn.discordapp.com/attachments/123/456/unnamed', 'image/gif')).toBe('unnamed.gif');
    });
  });

  describe('processAndRehostFavorites', () => {
    it('re-hosts Discord attachments and preserves external links in order', async () => {
      const mockDocument = {
        'https://tenor.com/view/second-gif': {
          order: 2,
          src: 'https://media.tenor.com/second.mp4',
        },
        'https://cdn.discordapp.com/attachments/100/200/first_discord.gif?ex=66f&is=66f&hm=abc': {
          order: 1,
          src: 'https://cdn.discordapp.com/attachments/100/200/first_discord.gif?ex=66f&is=66f&hm=abc',
        },
        'https://giphy.com/gifs/third-gif': {
          order: 3,
        }
      };

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockImplementation(async (url, opts) => {
        if (typeof url === 'string' && url.includes('discordapp')) {
          return {
            ok: true,
            status: 200,
            blob: async () => new Blob(['fake-gif-bytes'], { type: 'image/gif' }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            origin: 'telium.test',
            hash: 'rehosted_hash_123',
            url: 'https://telium.test/media/rehosted_hash_123',
          }),
        };
      });

      const mockHome = { domain: 'telium.test', token: 'fake-token' };
      const progressUpdates = [];

      try {
        const result = await processAndRehostFavorites({
          document: mockDocument,
          home: mockHome,
          onProgress: (p) => progressUpdates.push(p),
        });

        expect(result.externalCount).toBe(2);
        expect(result.rehostedCount).toBe(1);
        expect(result.failedCount).toBe(0);
        expect(result.urls).toContain('https://tenor.com/view/second-gif');
        expect(result.urls).toContain('https://giphy.com/gifs/third-gif');
        expect(result.urls).toContain('https://telium.test/media/rehosted_hash_123');
        expect(progressUpdates.length).toBeGreaterThan(0);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
