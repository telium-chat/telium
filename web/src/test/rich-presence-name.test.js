import { describe, expect, it, vi } from 'vitest';
import {
  cleanApplicationId,
  createApplicationNameResolver,
} from '../../electron/rich-presence-name.mjs';

describe('rich presence application metadata', () => {
  it('prefers an application name learned locally and caches it', async () => {
    const localLookup = vi.fn(async (id) => (
      id === '123456789012345678' ? 'Content Warning' : null
    ));
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({ localLookup, fetchImpl });

    await expect(resolver.resolve('123456789012345678')).resolves.toBe('Content Warning');
    await expect(resolver.resolve('123456789012345678')).resolves.toBe('Content Warning');
    expect(localLookup).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses Discord RPC application metadata when the local database has no match', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        id: '987654321098765432',
        name: url.includes('/applications/') ? 'Music Player' : 'wrong fallback',
      }),
    }));
    const resolver = createApplicationNameResolver({
      localLookup: async () => null,
      fetchImpl,
    });

    await expect(resolver.resolve('987654321098765432')).resolves.toBe('Music Player');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://discord.com/api/v10/applications/987654321098765432/rpc',
    );
  });

  it('falls back to the legacy RPC metadata route and deduplicates concurrent lookups', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (url) => {
      calls += 1;
      if (!url.includes('/oauth2/')) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ name: 'Legacy RPC App' }) };
    });
    const resolver = createApplicationNameResolver({
      localLookup: async () => null,
      fetchImpl,
    });

    const [first, second] = await Promise.all([
      resolver.resolve('111111111111111111'),
      resolver.resolve('111111111111111111'),
    ]);
    expect(first).toBe('Legacy RPC App');
    expect(second).toBe('Legacy RPC App');
    expect(calls).toBe(2);
  });

  it('lets an RPC-provided name override future lookups', async () => {
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({ fetchImpl });

    expect(resolver.remember('222222222222222222', '  Custom Game Name  ')).toBe('Custom Game Name');
    await expect(resolver.resolve('222222222222222222')).resolves.toBe('Custom Game Name');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses bundled detectable metadata for a program icon without hitting Discord', async () => {
    const localLookup = vi.fn(async () => ({
      name: 'Overwatch',
      icon_hash: 'd20f9f39f2eec584dcdbc7b206786124',
    }));
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({ localLookup, fetchImpl });

    await expect(resolver.resolveArtwork('356875221078245376', null)).resolves.toEqual({
      large_image: 'https://cdn.discordapp.com/app-icons/356875221078245376/d20f9f39f2eec584dcdbc7b206786124.png?size=128',
      large_text: 'Overwatch',
      small_image: null,
      small_text: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves RPC asset keys through the public application asset list once', async () => {
    const fetchImpl = vi.fn(async (url) => {
      expect(url).toBe('https://discord.com/api/v10/oauth2/applications/333333333333333333/assets');
      return {
        ok: true,
        json: async () => [
          { id: '444444444444444444', name: 'main-game-image', type: 1 },
          { id: '555555555555555555', name: 'player-class', type: 2 },
        ],
      };
    });
    const resolver = createApplicationNameResolver({
      localLookup: async () => null,
      fetchImpl,
    });

    await expect(resolver.resolveArtwork('333333333333333333', {
      large_image: 'MAIN-GAME-IMAGE',
      large_text: 'Lost Jungle',
      small_image: 'player-class',
      small_text: 'Knight',
    })).resolves.toEqual({
      large_image: 'https://cdn.discordapp.com/app-assets/333333333333333333/444444444444444444.png?size=256',
      large_text: 'Lost Jungle',
      small_image: 'https://cdn.discordapp.com/app-assets/333333333333333333/555555555555555555.png?size=256',
      small_text: 'Knight',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('preserves arbitrary external artwork as data and keeps the app identity badge', async () => {
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({
      localLookup: async () => ({
        name: 'Safe Game',
        icon_hash: 'abcdef0123456789abcdef0123456789',
      }),
      fetchImpl,
    });

    const artwork = await resolver.resolveArtwork('666666666666666666', {
      large_image: 'https://art.example/current-level.png',
      large_text: 'Current level',
    });
    expect(artwork).toEqual({
      large_image: 'https://art.example/current-level.png',
      large_text: 'Current level',
      small_image: 'https://cdn.discordapp.com/app-icons/666666666666666666/abcdef0123456789abcdef0123456789.png?size=128',
      small_text: 'Safe Game',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts Discord media-proxy artwork without contacting the origin', async () => {
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({
      localLookup: async () => null,
      fetchImpl,
    });

    await expect(resolver.resolveArtwork('777777777777777777', {
      large_image: 'mp:external/examplehash/https/example.com/image.png',
    })).resolves.toEqual({
      large_image: 'https://media.discordapp.net/external/examplehash/https/example.com/image.png',
      large_text: null,
      small_image: null,
      small_text: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects non-snowflake application identifiers before doing any lookup', async () => {
    const localLookup = vi.fn();
    const fetchImpl = vi.fn();
    const resolver = createApplicationNameResolver({ localLookup, fetchImpl });

    expect(cleanApplicationId('../oops')).toBeNull();
    await expect(resolver.resolve('../oops')).resolves.toBeNull();
    await expect(resolver.resolveArtwork('../oops', {})).resolves.toBeNull();
    expect(localLookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
