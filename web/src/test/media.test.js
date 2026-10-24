import { describe, expect, it } from 'vitest';
import { mediaUrl, remoteMediaOrigin } from '../lib/media.js';

describe('profile media URLs', () => {
  it('keeps local profile media on its normal origin URL', () => {
    expect(mediaUrl('https://home.example', 'hash?cap=secret')).toBe(
      'https://home.example/_telium/v1/media/hash?cap=secret',
    );
  });

  it('routes a foreign profile asset through the current host cache', () => {
    expect(mediaUrl('https://guild.example', 'hash?cap=secret', 'home.example')).toBe(
      'https://guild.example/_telium/v1/media/remote/home.example/hash?cap=secret',
    );
  });

  it('recognizes only a different user homeserver as remote', () => {
    expect(remoteMediaOrigin('@alice:home.example', 'guild.example')).toBe('home.example');
    expect(remoteMediaOrigin('@alice:guild.example', 'guild.example')).toBeNull();
  });
});
