import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createRelayGuard } = require('../../electron/relay-guard.cjs');

const RELAY = 'wss://home.example/_telium/v1/relay/v1';

function guardFor(hosts) {
  const guard = createRelayGuard();
  guard.setRelayEndpoint(RELAY);
  guard.setProtectedHosts(hosts);
  return guard;
}

function installed(guard) {
  let registered = null;
  guard.install({ webRequest: { onBeforeRequest: (fn) => { registered = fn; } } });
  return (details) => {
    let answer;
    registered(details, (result) => { answer = result; });
    return answer;
  };
}

describe('the desktop deny guard', () => {
  it('cancels every scheme and resource shape to a protected host, case- and dot-insensitively', () => {
    const guard = guardFor(['Telium.Guild.Example']);
    for (const url of [
      'https://telium.guild.example/_telium/v1/channels/1/messages',
      'https://telium.guild.example/avatars/abc.png',
      'wss://telium.guild.example/gateway',
      'http://telium.guild.example/insecure',
      'https://TELIUM.guild.example/x',
      'https://telium.guild.example./x',
    ]) {
      expect(guard.allows(url)).toEqual({ allow: false, reason: 'protected' });
    }
  });

  it('follows the renderer when a host is dropped', () => {
    const guard = guardFor(['telium.guild.example']);
    guard.setProtectedHosts([]);
    expect(guard.allows('https://telium.guild.example/x')).toEqual({ allow: true, reason: 'unprotected' });
    expect(guard.protectedHosts()).toEqual([]);
  });

  it('exempts exactly the relay URL and nothing else on its host', () => {
    const guard = guardFor(['home.example']);
    expect(guard.allows(RELAY)).toEqual({ allow: true, reason: 'relay' });
    expect(guard.allows('https://home.example/_telium/v1/users/@me').allow).toBe(false);
    expect(guard.allows('wss://home.example/_telium/v1/relay/v2').allow).toBe(false);
    expect(guard.allows('wss://other.example/_telium/v1/relay/v1')).toEqual({ allow: true, reason: 'unprotected' });
  });

  it('cancels subdomains but not look-alike names or third parties', () => {
    const guard = guardFor(['guild.example']);
    expect(guard.allows('https://media.guild.example/x.png')).toEqual({ allow: false, reason: 'protected-subdomain' });
    expect(guard.allows('https://a.b.guild.example/x.png').allow).toBe(false);
    for (const url of ['https://notguild.example/x.png', 'https://guild.example.evil.test/collect', 'https://cdn.jsdelivr.net/emoji/1f600.svg']) {
      expect(guard.allows(url)).toEqual({ allow: true, reason: 'unprotected' });
    }
  });

  it('leaves non-network schemes alone', () => {
    const guard = guardFor(['telium.guild.example']);
    for (const url of ['file:///Applications/Telium/renderer/index.html', 'blob:file:///9f1c-abc', 'data:image/png;base64,AAAA']) {
      expect(guard.allows(url).allow).toBe(true);
    }
    expect(guard.allows('not a url at all')).toEqual({ allow: true, reason: 'unparsable' });
  });

  it('answers the session callback, cancelling unattributed requests too', () => {
    const handler = installed(guardFor(['telium.guild.example']));
    expect(handler({ url: 'https://telium.guild.example/avatars/abc.png' })).toEqual({ cancel: true });
    expect(handler({ url: 'https://telium.guild.example/x', webContentsId: 7 })).toEqual({ cancel: true });
    expect(handler({ url: 'https://cdn.jsdelivr.net/emoji/1f600.svg' })).toEqual({});
    expect(handler({})).toEqual({});
  });
});
