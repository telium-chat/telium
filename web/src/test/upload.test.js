import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchEncrypted, profileRef, uploadAttachment, uploadEncrypted, uploadGuildIcon, uploadMedia,
  uploadVouched,
} from '../lib/upload.js';

const MEDIA = {
  origin: 'home.example',
  hash: 'abc', reference: 'media://home.example/abc', capability: 'cap-1',
  url: 'https://home.example/_telium/v1/media/abc?cap=cap-1',
  filename: 'requirements.txt', mime: 'text/plain', size: 30,
};

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}
function fail(status, message) {
  return { ok: false, status, json: async () => ({ error: 'forbidden', message }) };
}

const file = (name = 'requirements.txt') => {
  const f = new File(['flask==3.0.0\nrequests==2.31.0\n'], name, { type: 'text/plain' });
  return f;
};

let store;
beforeEach(() => {
  store = {
    home: { base: 'https://home.example', token: 'home-token', domain: 'home.example' },
    apiForChannel: () => ({
      base: 'https://guild.example',
      token: 'guild-token',
      domain: 'guild.example',
      mediaVoucher: vi.fn(async () => ({ voucher: { kind: 'media_voucher', max_bytes: 30 } })),
    }),
  };
});

describe('uploadAttachment', () => {
  it('uploads to the home server on the home token, not the guild', async () => {
    const fetchMock = vi.fn(async () => ok(MEDIA));
    vi.stubGlobal('fetch', fetchMock);

    const att = await uploadAttachment(store, { id: 'c1', guild_id: 'g1' }, file());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://home.example/_telium/v1/media');
    expect(init.headers.Authorization).toBe('Bearer home-token');
    expect(init.headers['X-Telium-Purpose']).toBe('attachment');
    expect(att).toMatchObject({
      origin: 'home.example', hash: 'abc', filename: 'requirements.txt',
      mime: 'text/plain', size: 30, ref: 'abc', name: 'requirements.txt',
    });
  });

  it('falls back to a guild voucher when the home server hosts nothing', async () => {
    const guild = store.apiForChannel();
    store.apiForChannel = () => guild;
    const fetchMock = vi.fn(async (url) =>
      url.startsWith('https://home.example')
        ? fail(403, 'this server does not host uploads')
        : ok({ ...MEDIA, url: 'https://guild.example/_telium/v1/media/abc?cap=cap-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const att = await uploadAttachment(store, { id: 'c1', guild_id: 'g1' }, file());

    expect(guild.mediaVoucher).toHaveBeenCalledWith({
      guild_id: 'g1', origin: 'guild.example', max_bytes: 30,
    });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://guild.example/_telium/v1/media/voucher-upload');
    expect(init.headers.Authorization).toBeUndefined();
    const voucher = JSON.parse(atob(init.headers['X-Telium-Voucher'].replace(/-/g, '+').replace(/_/g, '/')));
    expect(voucher.kind).toBe('media_voucher');
    expect(att.capability).toBe('cap-1');
  });

  it('does not retry elsewhere when the home server merely failed', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadAttachment(store, { id: 'c1', guild_id: 'g1' }, file()))
      .rejects.toThrow('network down');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('uploadMedia', () => {
  it('declares the purpose so a profile asset can claim the carveout', async () => {
    const fetchMock = vi.fn(async () => ok(MEDIA));
    vi.stubGlobal('fetch', fetchMock);

    await uploadMedia(store.home, file('avatar.png'), 'profile');

    expect(fetchMock.mock.calls[0][1].headers['X-Telium-Purpose']).toBe('profile');
  });

  it('surfaces the refusal the server actually gave', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(413, 'file exceeds the server limit')));
    await expect(uploadMedia(store.home, file())).rejects.toThrow('file exceeds the server limit');
  });
});

describe('uploadVouched', () => {
  it('can stage a guild icon as a profile asset on the guild host', async () => {
    const guild = store.apiForChannel();
    const fetchMock = vi.fn(async () => ok({ ...MEDIA, origin: 'guild.example' }));
    vi.stubGlobal('fetch', fetchMock);

    await uploadVouched(guild, 'g1', 'guild.example', file('guild-icon.png'), { purpose: 'profile' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://guild.example/_telium/v1/media/voucher-upload');
    expect(init.headers['X-Telium-Purpose']).toBe('profile');
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('applies a guild icon after storing the profile asset', async () => {
    const guild = store.apiForChannel();
    guild.patchGuild = vi.fn(async () => ({ icon_ref: 'abc?cap=cap-1' }));
    const fetchMock = vi.fn(async () => ok({ ...MEDIA, origin: 'guild.example' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(uploadGuildIcon(guild, 'g1', file('guild-icon.png')))
      .resolves.toBe('abc?cap=cap-1');
    expect(guild.patchGuild).toHaveBeenCalledWith('g1', { icon_ref: 'abc?cap=cap-1' });
  });
});

describe('uploadEncrypted', () => {
  it('gives the home server ciphertext and nothing that describes it', async () => {
    const fetchMock = vi.fn(async () => ok(MEDIA));
    vi.stubGlobal('fetch', fetchMock);

    const att = await uploadEncrypted(store.home, file('severance-agreement.txt'));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://home.example/_telium/v1/media');
    expect(init.headers.Authorization).toBe('Bearer home-token');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(decodeURIComponent(init.headers['X-Telium-Filename'])).toBe('attachment.bin');
    expect(await init.body.text()).not.toContain('flask');
    expect(att).toMatchObject({ name: 'severance-agreement.txt', mime: 'text/plain', size: 30 });
    expect(att.key).toBeTruthy();
    expect(att.iv).toBeTruthy();
  });

  it('never sends the same file twice, so the origin cannot match two of them', async () => {
    const fetchMock = vi.fn(async () => ok(MEDIA));
    vi.stubGlobal('fetch', fetchMock);

    const first = await uploadEncrypted(store.home, file());
    const second = await uploadEncrypted(store.home, file());

    expect(first.key).not.toBe(second.key);
    expect(await fetchMock.mock.calls[0][1].body.text())
      .not.toBe(await fetchMock.mock.calls[1][1].body.text());
  });

  it('round-trips: what comes back out is the file that went in', async () => {
    let stored = null;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') { stored = init.body; return ok(MEDIA); }
      return { ok: true, status: 200, arrayBuffer: () => stored.arrayBuffer() };
    }));

    const att = await uploadEncrypted(store.home, file());
    const blob = await fetchEncrypted('https://home.example', att);

    expect(await blob.text()).toBe('flask==3.0.0\nrequests==2.31.0\n');
    expect(blob.type).toBe('text/plain');
  });

  it('fails rather than handing back the noise it could not decrypt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, arrayBuffer: async () => new Uint8Array(64).buffer,
    })));
    await expect(fetchEncrypted('https://home.example', {
      url: 'https://home.example/_telium/v1/media/abc?cap=cap-1',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      iv: 'AAAAAAAAAAAAAAAA',
    })).rejects.toThrow();
  });
});

describe('cancelling an upload', () => {
  it('hands the signal to the transport and rejects on abort', async () => {
    let seen;
    vi.stubGlobal('fetch', vi.fn((url, init) => new Promise((_resolve, reject) => {
      seen = init.signal;
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })));

    const controller = new AbortController();
    const pending = uploadMedia(store.home, file(), 'attachment', { signal: controller.signal });
    expect(seen).toBeInstanceOf(AbortSignal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves nothing when the signal was already aborted', async () => {
    const fetchMock = vi.fn(async () => ok(MEDIA));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();
    const pending = uploadMedia(store.home, file(), 'attachment', { signal: controller.signal });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('profileRef', () => {
  it('keeps the capability that unlocks a profile asset', () => {
    expect(profileRef({ hash: 'abc', capability: 'cap-1' })).toBe('abc?cap=cap-1');
    expect(profileRef(MEDIA)).toBe('abc?cap=cap-1');
  });
});
