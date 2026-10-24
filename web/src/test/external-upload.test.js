import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadExternal } from '../lib/external-upload.js';

const home = { base: 'https://home.example', token: 'home-token' };
const gofile = {
  id: 'gofile', provider: 'gofile', name: 'Gofile', domain: 'gofile.io',
  upload_url: 'https://upload.gofile.io/uploadfile',
  browser_direct: true,
};

const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
let responses;
let requests;

beforeEach(() => {
  responses = [];
  requests = [];
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('generateWT', vi.fn(() => 'website-token'));
  class FakeXhr {
    constructor() { this.upload = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) {
      this.headers ||= {};
      this.headers[name] = value;
    }
    send(body) {
      requests.push({ method: this.method, url: this.url, body, headers: this.headers });
      const next = responses.shift();
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size || 1, total: body.size || 1 });
      Promise.resolve().then(() => {
        this.status = next.status || 200;
        this.responseText = next.body;
        this.onload();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

describe('external upload', () => {
  it('uploads Gofile directly and resolves the provider-issued media link', async () => {
    responses.push({ body: JSON.stringify({ data: {
      id: 'file1', name: 'hello.txt', downloadPage: 'https://gofile.io/d/page1',
      guestToken: 'guest-token',
    } }) });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://store1.gofile.io/download/direct/file1/hello.txt' }),
    });

    const attachment = await uploadExternal(home, gofile, file);

    expect(attachment.url).toBe('https://store1.gofile.io/download/direct/file1/hello.txt');
    expect(attachment.origin).toBe('store1.gofile.io');
    expect(requests[0].url).toBe(gofile.upload_url);
    expect(requests[0].body).toBeInstanceOf(FormData);
    expect(fetch).toHaveBeenCalledWith(
      'https://home.example/_telium/v1/media/external/gofile/resolve',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer home-token',
        }),
        body: expect.stringContaining('"website_token":"website-token"'),
      }),
    );
  });

  it('reports Gofile upload progress from start through completion', async () => {
    responses.push({ body: JSON.stringify({ data: {
      id: 'file1', name: 'hello.txt', downloadPage: 'https://gofile.io/d/page1',
      guestToken: 'guest-token',
    } }) });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://store1.gofile.io/download/web/file1/hello.txt' }),
    });
    const onProgress = vi.fn();

    await uploadExternal(home, gofile, file, { onProgress });

    expect(onProgress.mock.calls[0]).toEqual([0, file.size]);
    expect(onProgress.mock.calls.at(-1)).toEqual([file.size, file.size]);
  });

  it('never relays Gofile upload bytes through the homeserver even if config says browser_direct=false', async () => {
    responses.push({ body: JSON.stringify({ data: {
      id: 'file1', name: 'hello.txt', downloadPage: 'https://gofile.io/d/page1',
      guestToken: 'guest-token',
    } }) });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://store1.gofile.io/download/web/file1/hello.txt' }),
    });

    await uploadExternal(home, { ...gofile, browser_direct: false }, file);

    expect(requests[0].url).toBe(gofile.upload_url);
    expect(requests.some((request) => request.url.startsWith(home.base))).toBe(false);
  });

  it('resolves Gofile metadata instead of guessing a page-redirecting storage link', async () => {
    responses.push({ body: JSON.stringify({ data: {
      id: 'file1', name: 'hello.txt',
      downloadPage: 'https://gofile.io/d/page1', guestToken: 'guest-token',
    } }) });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://store-na-phx-5.gofile.io/download/direct/file1/hello.txt' }),
    });

    const attachment = await uploadExternal(home, gofile, file);

    expect(attachment.url).toBe('https://store-na-phx-5.gofile.io/download/direct/file1/hello.txt');
    expect(fetch).toHaveBeenCalledWith(
      'https://home.example/_telium/v1/media/external/gofile/resolve',
      expect.anything(),
    );
  });

  it('does not require wt.obf.js for the normal Gofile lookup', async () => {
    vi.stubGlobal('generateWT', undefined);
    responses.push({ body: JSON.stringify({ data: {
      id: 'file1', name: 'hello.txt', downloadPage: 'https://gofile.io/d/page1',
      guestToken: 'guest-token',
    } }) });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://store1.gofile.io/download/direct/file1/hello.txt' }),
    });

    await uploadExternal(home, gofile, file);

    const requestBody = JSON.parse(fetch.mock.calls[0][1].body);
    const websiteToken = requestBody.website_token;
    expect(websiteToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a provider response that is not an HTTPS URL', async () => {
    const relayHost = {
      id: 'example', provider: 'example', name: 'Example', domain: 'files.example',
      upload_url: 'https://files.example/upload',
    };
    responses.push({ body: JSON.stringify({ url: 'http://files.example/abc123.txt' }) });
    await expect(uploadExternal(home, relayHost, file)).rejects.toThrow('HTTPS');
  });
});
