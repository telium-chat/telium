import { describe, expect, it } from 'vitest';
import { displayHomeserver, normalizeHomeserver, prettyHost } from '../lib/homeserver.js';

describe('normalizeHomeserver', () => {
  it('puts https on a bare host, because a schemeless base is a relative path', () => {
    expect(normalizeHomeserver('home.example')).toBe('https://home.example');
    expect(normalizeHomeserver('  home.example  ')).toBe('https://home.example');
  });

  it('leaves a loopback address on http, where there is no certificate to meet', () => {
    expect(normalizeHomeserver('localhost:8448')).toBe('http://localhost:8448');
    expect(normalizeHomeserver('127.0.0.1:8448')).toBe('http://127.0.0.1:8448');
    expect(normalizeHomeserver('[::1]:8448')).toBe('http://[::1]:8448');
    expect(normalizeHomeserver('dev.localhost')).toBe('http://dev.localhost');
  });

  it('keeps a scheme somebody typed on purpose', () => {
    expect(normalizeHomeserver('http://home.example')).toBe('http://home.example');
    expect(normalizeHomeserver('https://home.example')).toBe('https://home.example');
  });

  it('collapses the spellings of one address onto one string', () => {
    const forms = ['home.example', 'HOME.Example', 'https://home.example/', 'home.example?x=1'];
    for (const form of forms) expect(normalizeHomeserver(form)).toBe('https://home.example');
  });

  it('keeps a path but drops the query, the fragment and the trailing slash', () => {
    expect(normalizeHomeserver('https://home.example/telium/')).toBe('https://home.example/telium');
    expect(normalizeHomeserver('home.example/path?x=1#y')).toBe('https://home.example/path');
  });

  it('keeps a non-default port', () => {
    expect(normalizeHomeserver('https://home.example:8448')).toBe('https://home.example:8448');
  });

  it('writes an international name the way the network will ask for it', () => {
    expect(normalizeHomeserver('t\u00e4st.example')).toBe('https://xn--tst-qla.example');
  });

  it('answers with nothing rather than inventing an address', () => {
    expect(normalizeHomeserver('')).toBe('');
    expect(normalizeHomeserver('   ')).toBe('');
    expect(normalizeHomeserver(null)).toBe('');
    expect(normalizeHomeserver(undefined)).toBe('');
    expect(normalizeHomeserver('not a host')).toBe('');
  });

  it('refuses a scheme that is not the web', () => {
    expect(normalizeHomeserver('ftp://home.example')).toBe('');
  });

  it('refuses credentials, so a mailto is not read as a host', () => {
    expect(normalizeHomeserver('user:pass@home.example')).toBe('');
    expect(normalizeHomeserver('mailto:someone@example.org')).toBe('');
  });
});

describe('prettyHost', () => {
  it('strips the scheme and the trailing slashes and nothing else', () => {
    expect(prettyHost('https://home.example/')).toBe('home.example');
    expect(prettyHost('  HTTP://Home.Example//  ')).toBe('Home.Example');
    expect(prettyHost(null)).toBe('');
  });
});

describe('displayHomeserver', () => {
  it('drops a scheme that reading the field back would put there anyway', () => {
    expect(displayHomeserver('https://home.example')).toBe('home.example');
    expect(displayHomeserver('https://home.example/')).toBe('home.example');
  });

  it('keeps http on screen, because dropping it would silently promote it', () => {
    expect(displayHomeserver('http://home.example')).toBe('http://home.example');
  });

  it('shows a loopback address bare, since it reads back as http either way', () => {
    expect(displayHomeserver('http://localhost:8448')).toBe('localhost:8448');
  });

  it('hands back an unparseable address unchanged rather than blanking the box', () => {
    expect(displayHomeserver('not a host')).toBe('not a host');
    expect(displayHomeserver('')).toBe('');
  });
});
