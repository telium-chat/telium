import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { Fragment, createElement as h, useEffect } from 'react';
import {
  baseEmojiFor, clipContent, emojiIn, isJumbo, isPictorial, parseCustomEmoji, recentEmoji,
  rememberEmojiIn, searchEmoji, splitEmoji, toCodePoints, toPlainText, withTone,
} from '../lib/emoji.js';
import {
  ALL_PERMISSIONS, PERMISSION_MASKS, channelPermissions, has, namesOf, outranks, toBits,
} from '../lib/perms.js';
import { bytes, colourOf, colourToInt } from '../lib/util.js';
import { channelGlyph } from '../lib/channels.js';
import { renderContent, ForwardedChip } from '../lib/markdown.jsx';
import { displayNameOf, displayText, splitMentions, wireText } from '../lib/mentions.js';
import { suggestFor, tokenAt, useAutocomplete } from '../views/chat/Autocomplete.jsx';

const mask = (...names) => names.reduce((b, n) => b | PERMISSION_MASKS.get(n), 0n);

describe('byte sizes', () => {
  it('uses readable units instead of displaying large files as kilobytes', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(1024 ** 2)).toBe('1.0 MB');
    expect(bytes(28.8 * 1024 ** 2)).toBe('28.8 MB');
    expect(bytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });
});

describe('emoji', () => {
  it('names the asset the way Twemoji names its files', () => {
    expect(toCodePoints('❤️')).toBe('2764');
    expect(toCodePoints('\u{1F44D}')).toBe('1f44d');
    expect(toCodePoints('\u{1F469}‍\u{1F4BB}')).toBe('1f469-200d-1f4bb');
    expect(toCodePoints('\u{1F3F3}️‍\u{1F308}')).toBe('1f3f3-fe0f-200d-1f308');
  });

  it('leaves the punctuation that only technically is emoji as text', () => {
    expect(isPictorial('\u{1F600}')).toBe(true);
    expect(isPictorial('©')).toBe(false);
    expect(isPictorial('™')).toBe(false);
    expect(isPictorial('❤️')).toBe(true);
    expect(isPictorial('\u{1F1EF}\u{1F1F5}')).toBe(true);
  });

  it('splits a line into runs without losing a character', () => {
    const text = 'hi \u{1F44B} there \u{1F1EF}\u{1F1F5}';
    const parts = splitEmoji(text);
    expect(parts.map((p) => p.emoji ?? p.text).join('')).toBe(text);
    expect(parts.filter((p) => p.emoji).map((p) => p.emoji))
      .toEqual(['\u{1F44B}', '\u{1F1EF}\u{1F1F5}']);
  });

  it('keeps a ZWJ sequence in one piece', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect(splitEmoji(family)).toEqual([{ emoji: family }]);
  });

  it('jumbos only a short, wordless line', () => {
    expect(isJumbo('\u{1F389}')).toBe(true);
    expect(isJumbo(' \u{1F389} \u{1F389} ')).toBe(true);
    expect(isJumbo('nice \u{1F389}')).toBe(false);
    expect(isJumbo('\u{1F389}'.repeat(7))).toBe(false);
    expect(isJumbo('')).toBe(false);
  });

  it('counts a custom emoji as one emoji', () => {
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@example.test>';
    const wave = '<wave:01M2RD1VD19N3BAJ53KX0BQ1XS>';
    expect(isJumbo(party)).toBe(true);
    expect(isJumbo(`${party} ${wave}`)).toBe(true);
    expect(isJumbo(`${party}\u{1F389}`)).toBe(true);
    expect(isJumbo(`nice ${party}`)).toBe(false);
    expect(isJumbo(party.repeat(7))).toBe(false);
    expect(isJumbo(`${party.repeat(5)}\u{1F389}\u{1F389}`)).toBe(false);
  });

  it('matches every search term, not just the first', () => {
    const list = [
      { unicode: 'a', search: 'red heart love' },
      { unicode: 'b', search: 'broken heart' },
    ];
    expect(searchEmoji(list, 'heart').length).toBe(2);
    expect(searchEmoji(list, 'red heart').map((e) => e.unicode)).toEqual(['a']);
    expect(searchEmoji(list, '')).toBe(list);
  });

  it('parses custom emoji recents without changing their synced value', () => {
    expect(parseCustomEmoji('<party:e1@guilds.example>')).toEqual({
      name: 'party', id: 'e1', origin: 'guilds.example',
    });
    expect(parseCustomEmoji('<party:e1>')).toEqual({ name: 'party', id: 'e1', origin: '' });
    expect(parseCustomEmoji('🎉')).toBe(null);
  });

  it('applies skin tones by metadata and can recover a toned Recent entry', () => {
    const legacy = {
      unicode: '\u{1F44D}',
      tones: ['light', 'med-light', 'med', 'med-dark', 'dark'],
    };
    expect(withTone(legacy, '')).toBe('\u{1F44D}');
    expect(withTone(legacy, '\u{1F3FD}')).toBe('med');

    const modern = {
      unicode: '\u{1F91D}',
      tones: [
        { unicode: 'light-both', tone: [1, 1] },
        { unicode: 'mixed', tone: [1, 5] },
        { unicode: 'medium-both', tone: [3, 3] },
        { unicode: 'dark-both', tone: [5, 5] },
      ],
    };
    expect(withTone(modern, '\u{1F3FD}')).toBe('medium-both');
    expect(withTone(modern, '\u{1F3FF}')).toBe('dark-both');

    expect(baseEmojiFor([modern], 'medium-both')).toBe(modern);
    expect(baseEmojiFor([modern], '\u{1F91D}')).toBe(modern);

    expect(withTone({ unicode: '\u{1F389}' }, '\u{1F3FD}')).toBe('\u{1F389}');
  });

  it('reads every emoji a message was sent with, in the order it was written', () => {
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@example.test>';
    expect(emojiIn(`nice ${party} \u{1F389} done`)).toEqual([party, '\u{1F389}']);
    expect(emojiIn(`type \`${party}\` or \`\u{1F389}\``)).toEqual([]);
    expect(emojiIn('nothing here')).toEqual([]);
  });

  it('records a sent message\u2019s emoji in one write, newest first', () => {
    const store = new Map();
    let writes = 0;
    const sync = {
      get: (k) => store.get(k),
      set: (k, v) => { store.set(k, v); writes += 1; },
    };
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@example.test>';
    rememberEmojiIn(sync, `\u{1F44B} hi ${party}`);
    expect(recentEmoji(sync)).toEqual(['\u{1F44B}', party]);
    expect(writes).toBe(1);

    rememberEmojiIn(sync, `again ${party}`);
    expect(recentEmoji(sync)).toEqual([party, '\u{1F44B}']);

    rememberEmojiIn(sync, 'just words');
    expect(writes).toBe(2);
  });

  it('never cuts a custom emoji token or a surrogate pair in half', () => {
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR@example.test>';
    expect(clipContent('short', 90)).toBe('short');
    expect(clipContent(`hi ${party}`, 10)).toBe('hi ');
    expect(clipContent(`hi ${party}`, 3 + party.length)).toBe(`hi ${party}`);
    expect(clipContent('ab\u{1F389}cd', 3)).toBe('ab');
    expect(clipContent('ab\u{1F469}\u200D\u{1F4BB}cd', 4)).toBe('ab');
  });

  it('gives a surface that can only hold characters the characters', () => {
    const party = '<party:01M2RD1VD19N3BAJ53KX0BQ1XR>';
    expect(toPlainText(`ship it ${party}`)).toBe('ship it :party:');
    expect(toPlainText(`ship it ${party.replace('>', '@example.test>')}`))
      .toBe('ship it :party:');
    expect(toPlainText('ship it \u{1F389}')).toBe('ship it \u{1F389}');
    expect(toPlainText('a < b and c > d')).toBe('a < b and c > d');
    expect(toPlainText('<not:an-id>')).toBe('<not:an-id>');
    expect(toPlainText(undefined)).toBe('');
  });
});

describe('permissions', () => {
  it('survives bit 40 crossing the wire as a string', () => {
    expect(toBits('18446744073709551615')).toBe(ALL_PERMISSIONS);
    expect(toBits(null)).toBe(0n);
    expect(toBits('nonsense')).toBe(0n);
    expect(has('1099511627776', 'ADMINISTRATOR')).toBe(true);
  });

  it('names what it holds', () => {
    expect(namesOf(mask('VIEW_CHANNEL', 'SEND_MESSAGES')))
      .toEqual(['VIEW_CHANNEL', 'SEND_MESSAGES']);
  });

  it('short-circuits an owner past every overwrite', () => {
    const member = { user_id: '@a:h', roles: ['g'], permissions: ALL_PERMISSIONS.toString() };
    const deny = [{ target_type: 'role', target_id: 'g', deny: mask('SEND_MESSAGES').toString(), allow: '0' }];
    expect(channelPermissions(member, 'g', deny)).toBe(ALL_PERMISSIONS);
  });

  it('applies @everyone, then roles, then the member', () => {
    const base = mask('VIEW_CHANNEL', 'SEND_MESSAGES');
    const member = { user_id: '@a:h', roles: ['g', 'r1'], permissions: base.toString() };
    const overwrites = [
      { target_type: 'role', target_id: 'g', allow: '0', deny: mask('SEND_MESSAGES').toString() },
      { target_type: 'role', target_id: 'r1', allow: mask('SEND_MESSAGES').toString(), deny: '0' },
      { target_type: 'member', target_id: '@a:h', allow: '0', deny: mask('SEND_MESSAGES').toString() },
    ];
    expect(has(channelPermissions(member, 'g', overwrites), 'SEND_MESSAGES')).toBe(false);
    expect(has(channelPermissions(member, 'g', overwrites.slice(0, 2)), 'SEND_MESSAGES')).toBe(true);
    expect(has(channelPermissions(member, 'g', overwrites.slice(0, 1)), 'SEND_MESSAGES')).toBe(false);
  });

  it('ignores an overwrite for a role the member does not hold', () => {
    const member = { user_id: '@a:h', roles: ['g'], permissions: mask('VIEW_CHANNEL').toString() };
    const overwrites = [
      { target_type: 'role', target_id: 'r9', allow: mask('BAN_MEMBERS').toString(), deny: '0' },
    ];
    expect(has(channelPermissions(member, 'g', overwrites), 'BAN_MEMBERS')).toBe(false);
  });

  it('cuts a timed-out member down to reading', () => {
    const member = {
      user_id: '@a:h',
      roles: ['g'],
      permissions: mask('VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY').toString(),
      timeout_until: Date.now() + 60_000,
    };
    const perms = channelPermissions(member, 'g', []);
    expect(has(perms, 'VIEW_CHANNEL')).toBe(true);
    expect(has(perms, 'READ_MESSAGE_HISTORY')).toBe(true);
    expect(has(perms, 'SEND_MESSAGES')).toBe(false);
  });

  it('lets an expired timeout lapse on its own', () => {
    const member = {
      user_id: '@a:h', roles: ['g'],
      permissions: mask('SEND_MESSAGES').toString(),
      timeout_until: Date.now() - 1,
    };
    expect(has(channelPermissions(member, 'g', []), 'SEND_MESSAGES')).toBe(true);
  });

  it('ranks by highest role, with the owner above everything', () => {
    expect(outranks({ top_role_position: 3 }, 2)).toBe(true);
    expect(outranks({ top_role_position: 3 }, 3)).toBe(false);
    expect(outranks({ is_owner: true, top_role_position: 0 }, 99)).toBe(true);
    expect(outranks(null, 0)).toBe(false);
  });
});

describe('role colour', () => {
  it('round-trips an integer through CSS', () => {
    expect(colourOf(0x5865f2)).toBe('#5865f2');
    expect(colourOf('5793266')).toBe('#5865f2');
    expect(colourOf(0)).toBe(null);
    expect(colourOf(0x0000ff)).toBe('#0000ff');
    expect(colourToInt('#5865f2')).toBe(0x5865f2);
    expect(colourToInt('garbage')).toBe(0);
  });
});

describe('autocomplete', () => {
  it('opens a trigger only at a word boundary', () => {
    expect(tokenAt('@ali', 4)).toMatchObject({ kind: 'mention', query: 'ali', start: 0 });
    expect(tokenAt('hey @ali', 8)).toMatchObject({ kind: 'mention', query: 'ali', start: 4 });
    expect(tokenAt('mail me at bob@ali', 18)).toBe(null);
    expect(tokenAt('see #gen', 8)).toMatchObject({ kind: 'channel', query: 'gen', start: 4 });
  });

  it('waits for two characters before offering emoji', () => {
    expect(tokenAt('at 3:0', 6)).toBe(null);
    expect(tokenAt(':sm', 3)).toMatchObject({ kind: 'emoji', query: 'sm', start: 0 });
  });

  it('reads the token under the caret, not at the end of the line', () => {
    expect(tokenAt('hi @al there', 6)).toMatchObject({ kind: 'mention', query: 'al' });
  });

  const channel = { id: 'c1', guild_id: 'g1' };
  const stubStore = (perms) => ({
    permissionsIn: (id) => (id === 'c9' ? perms : perms | mask('VIEW_CHANNEL')),
    roleList: () => [
      { id: 'r1', name: 'Moderator', color: 0x5865f2, position: 2, mentionable: true },
      { id: 'r2', name: 'Muted', color: 0, position: 1, mentionable: false },
    ],
    members: new Map([['g1', new Map([
      ['@alice:home', { user_id: '@alice:home', display_name: 'Alice' }],
      ['@bob:home', { user_id: '@bob:home', nickname: 'Bobby' }],
    ])]]),
    channels: new Map([
      ['c1', { id: 'c1', guild_id: 'g1', type: 'text', name: 'general' }],
      ['c2', { id: 'c2', guild_id: 'g1', type: 'voice', name: 'general voice', user_limit: 4 }],
      ['c3', { id: 'c3', guild_id: 'g2', type: 'text', name: 'general elsewhere' }],
      ['c4', { id: 'c4', guild_id: 'g1', type: 'forum', name: 'general forum' }],
      ['c5', { id: 'c5', guild_id: 'g1', type: 'announcement', name: 'general news' }],
      ['c6', { id: 'c6', guild_id: 'g1', type: 'category', name: 'general category' }],
      ['c7', { id: 'c7', guild_id: 'g1', type: 'thread', name: 'general thread' }],
      ['c9', { id: 'c9', guild_id: 'g1', type: 'text', name: 'general secrets' }],
    ]),
    voice: new Map([['c2', [{ user_id: '@alice:home' }]]]),
    guilds: new Map([
      ['g1', { id: 'g1', name: 'Guild', domain: 'guilds.example' }],
    ]),
    emojis: new Map([['g1', [{ id: 'e1', name: 'party' }]]]),
    colourFor: () => null,
    apiForGuild: () => ({ base: 'https://guilds.example' }),
  });

  it('inserts the id, never the name', () => {
    const store = stubStore(mask('SEND_MESSAGES'));
    const [role] = suggestFor(store, channel, tokenAt('@Mod', 4), []);
    expect(role.insert).toBe('<@&r1>');
    expect(role.label).toBe('Moderator');

    const [ch] = suggestFor(store, channel, tokenAt('#gen', 4), []);
    expect(ch.insert).toBe('<#c1>');
  });

  it('offers a person as a delimited token, because that is what the renderer matches', () => {
    const store = stubStore(0n);
    const items = suggestFor(store, channel, tokenAt('@bob', 4), []);
    expect(items.map((i) => i.insert)).toContain('<@bob:home>');
  });

  it('gives a person a face, a name, and the id demoted underneath it', () => {
    const store = stubStore(0n);
    const [bob] = suggestFor(store, channel, tokenAt('@bob', 4), []);
    expect(bob.label).toBe('Bobby');
    expect(bob.hint).toBe('@bob:home');
    expect(bob.avatar).toMatchObject({ id: '@bob:home' });
  });

  it('matches a nickname as readily as an id', () => {
    const store = stubStore(0n);
    expect(suggestFor(store, channel, tokenAt('@bobby', 6), []).map((i) => i.key))
      .toEqual(['@bob:home']);
  });

  it('puts the people the store knows above the ones the server found', () => {
    const store = stubStore(0n);
    const found = [
      { user_id: '@alice:home', display_name: 'Alice' },
      { user_id: '@alistair:home', display_name: 'Alistair' },
    ];
    const items = suggestFor(store, channel, tokenAt('@ali', 4), [], found);
    expect(items.map((i) => i.key)).toEqual(['@alice:home', '@alistair:home']);
    expect(items[1].label).toBe('Alistair');
  });

  it('hides @everyone and unmentionable roles without MENTION_EVERYONE', () => {
    const quiet = suggestFor(stubStore(0n), channel, tokenAt('@', 1), []);
    expect(quiet.map((i) => i.key)).not.toContain('@everyone');
    expect(quiet.map((i) => i.key)).not.toContain('r2');

    const loud = suggestFor(stubStore(mask('MENTION_EVERYONE')), channel, tokenAt('@', 1), []);
    expect(loud.map((i) => i.insert).slice(0, 2)).toEqual(['@everyone', '@here']);
    expect(loud.map((i) => i.key)).toContain('r2');
  });

  it('offers every kind of room, not only the ones full of messages', () => {
    const keys = suggestFor(stubStore(0n), channel, tokenAt('#general', 8), []).map((i) => i.key);
    expect(keys).toEqual(['c1', 'c2', 'c4', 'c5']);
  });

  it('wears the type’s own glyph rather than a hash on everything', () => {
    const items = suggestFor(stubStore(0n), channel, tokenAt('#general', 8), []);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.c2.label).toBe('general voice');
    expect(byKey.c1.icon).toBe(channelGlyph({ type: 'text' }));
    expect(byKey.c2.icon).toBe(channelGlyph({ type: 'voice' }));
    expect(byKey.c4.icon).toBe(channelGlyph({ type: 'forum' }));
    expect(byKey.c5.icon).toBe(channelGlyph({ type: 'announcement' }));
    expect(new Set(items.map((i) => i.icon)).size).toBe(4);
  });

  it('never names a channel the reader is not allowed to see', () => {
    const keys = suggestFor(stubStore(0n), channel, tokenAt('#secrets', 8), []).map((i) => i.key);
    expect(keys).toEqual([]);
    const open = suggestFor(stubStore(mask('VIEW_CHANNEL')), channel, tokenAt('#secrets', 8), []);
    expect(open.map((i) => i.key)).toEqual(['c9']);
  });

  it('tells a voice row who is in it, since the gateway already said', () => {
    const [, voice] = suggestFor(stubStore(0n), channel, tokenAt('#general', 8), []);
    expect(voice.key).toBe('c2');
    expect(voice.hint).toBe('1/4 in voice');
  });

  it('puts this guild’s own emoji above the unicode ones', () => {
    const catalogue = [{ unicode: '\u{1F389}', label: 'party popper', search: 'party popper' }];
    const items = suggestFor(stubStore(0n), channel, tokenAt(':party', 6), catalogue);
    expect(items[0].insert).toBe('<party:e1@guilds.example>');
    expect(items[1].insert).toBe('\u{1F389}');
  });

  it('offers another guild’s emoji, origin-qualified', () => {
    const store = stubStore(0n);
    store.guilds.set('g2', { id: 'g2', name: 'Elsewhere', domain: 'elsewhere.example' });
    store.emojis.set('g2', [{ id: 'e2', name: 'cheers' }]);
    store.apiForGuild = (gid) => ({
      base: gid === 'g1' ? 'https://guilds.example' : 'https://elsewhere.example',
    });
    const items = suggestFor(store, channel, tokenAt(':cheers', 7), []);
    expect(items[0].insert).toBe('<cheers:e2@elsewhere.example>');
    expect(items[0].image).toBe('https://elsewhere.example/_telium/v1/emoji/e2');
  });
});

describe('mention search', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const channel = { id: 'c1', guild_id: 'g1' };

  const searchStore = (members, ask) => ({
    permissionsIn: () => 0n,
    roleList: () => [],
    members: new Map([['g1', new Map(members.map((m) => [m.user_id, m]))]]),
    channels: new Map(),
    guilds: new Map([['g1', { id: 'g1', name: 'Guild', domain: 'guilds.example' }]]),
    emojis: new Map(),
    colourFor: () => null,
    apiForGuild: () => ({ base: 'https://guilds.example', members: (gid, query) => ask(query.q) }),
  });

  function Harness({ store, surface, text, out }) {
    const complete = useAutocomplete({
      store, surface, text, setText: () => {}, textareaRef: { current: null },
    });
    useEffect(() => { complete.sync({ selectionStart: text.length }); }, [text]);
    useEffect(() => { out.current = complete; });
    return null;
  }

  const mount = (store, surface = channel) => {
    const out = { current: null };
    const view = render(h(Harness, { store, surface, text: '', out }));
    return {
      out,
      type: (text) => { view.rerender(h(Harness, { store, surface, text, out })); },
      settle: () => act(async () => { vi.advanceTimersByTime(1000); }),
    };
  };

  it('asks once for a name rather than once per letter', async () => {
    const asked = [];
    const ui = mount(searchStore([], (q) => { asked.push(q); return Promise.resolve({ members: [] }); }));
    ui.type('@a');
    ui.type('@al');
    ui.type('@ali');
    expect(asked).toEqual([]);
    await ui.settle();
    expect(asked).toEqual(['ali']);
  });

  it('never lets a slow answer for a prefix land under a newer query', async () => {
    const waiting = new Map();
    const ui = mount(searchStore([], (q) => new Promise((resolve) => { waiting.set(q, resolve); })));
    ui.type('@ali');
    await ui.settle();
    ui.type('@alice');
    await ui.settle();
    await act(async () => {
      waiting.get('alice')({ members: [{ user_id: '@alice:home', display_name: 'Alice' }] });
    });
    await act(async () => {
      waiting.get('ali')({ members: [{ user_id: '@alistair:home', display_name: 'Alistair' }] });
    });
    expect(ui.out.current.items.map((i) => i.key)).toEqual(['@alice:home']);
  });

  it('holds the popup open across the wait instead of closing and reopening', async () => {
    const waiting = [];
    const ui = mount(searchStore([], () => new Promise((resolve) => { waiting.push(resolve); })));
    ui.type('@zz');
    expect(ui.out.current.items).toEqual([]);
    expect(ui.out.current.searching).toBe(true);
    await ui.settle();
    await act(async () => { waiting[0]({ members: [] }); });
    expect(ui.out.current.searching).toBe(false);
  });

  it('keeps completing from the store when the guild cannot be reached', async () => {
    const local = [{ user_id: '@alice:home', display_name: 'Alice' }];
    const ui = mount(searchStore(local, () => Promise.reject(new Error('offline'))));
    ui.type('@ali');
    await ui.settle();
    expect(ui.out.current.items.map((i) => i.key)).toEqual(['@alice:home']);
    expect(ui.out.current.searching).toBe(false);
  });

  it('asks nothing of a conversation, which has no guild to ask', async () => {
    const asked = [];
    const store = searchStore([], (q) => { asked.push(q); return Promise.resolve({ members: [] }); });
    const ui = mount(store, { id: null, guildId: null, people: () => ['@alice:home'] });
    ui.type('@ali');
    await ui.settle();
    expect(asked).toEqual([]);
    expect(ui.out.current.searching).toBe(false);
  });
});

describe('mentions', () => {
  const tokensIn = (nodes) => {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.props?.token) out.push(n.props.token);
      walk(n.props?.children);
    };
    walk(nodes);
    return out;
  };
  const shownText = (nodes) => render(h(Fragment, null, ...nodes)).container.textContent;
  const ROLE_ID = '01M2RDZYYE8S36FXGAEW97J7A2';
  const guild = () => ({
    guildId: 'g1',
    store: {
      members: new Map([['g1', new Map([
        ['@bob:home', { user_id: '@bob:home', nickname: 'Bobby', display_name: 'Robert' }],
        ['@dot:home', { user_id: '@dot:home', display_name: 'Dorothy' }],
      ])]]),
      roles: new Map([['g1', new Map([
        [ROLE_ID, { id: ROLE_ID, name: 'Moderator', color: 0x5865f2 }],
      ])]]),
      channels: new Map(),
      myMember: () => ({ roles: [] }),
    },
  });

  it('draws a mention only where a composer put one', () => {
    expect(tokensIn(renderContent('email me @ work', {}))).toEqual([]);
    expect(tokensIn(renderContent('@everyone-ish is not everyone', {}))).toEqual([]);
    expect(tokensIn(renderContent('ask @someone about it', {}))).toEqual([]);
    expect(tokensIn(renderContent('hi <@bob:localhost>', {}))).toEqual(['<@bob:localhost>']);
    expect(tokensIn(renderContent(`<@&${ROLE_ID}>`, {}))).toEqual([`<@&${ROLE_ID}>`]);
    expect(tokensIn(renderContent(`<#${ROLE_ID}>`, {}))).toEqual([`<#${ROLE_ID}>`]);
    expect(shownText(renderContent('@everyone', {}))).toBe('@everyone');
  });

  it('still draws the bare id every message sent before this carried', () => {
    expect(tokensIn(renderContent('hi @bob:localhost', {}))).toEqual(['@bob:localhost']);
    expect(tokensIn(renderContent('hi @bob:home.example', {}))).toEqual(['@bob:home.example']);
    expect(tokensIn(renderContent('hi @bob:home.example:8448', {}))).toEqual(['@bob:home.example:8448']);
    expect(tokensIn(renderContent('note @bob: see above', {}))).toEqual([]);
  });

  it('names the person rather than the address', () => {
    const ctx = guild();
    expect(shownText(renderContent('<@bob:home>', ctx))).toBe('@Bobby');
    expect(shownText(renderContent('<@dot:home>', ctx))).toBe('@Dorothy');
    expect(shownText(renderContent('<@zed:home>', ctx))).toBe('@zed');
  });

  it('keeps the wire identity in the tooltip, where it belongs', () => {
    const ctx = guild();
    const [pill] = renderContent('<@bob:home>', ctx).flat().filter((n) => n.props?.token);
    expect(pill.type(pill.props).props.title).toBe('@bob:home');
  });

  it('opens the person it names', () => {
    const opened = [];
    const nodes = renderContent('<@bob:localhost>', { onOpenUser: (id) => opened.push(id) });
    const [pill] = nodes.flat().filter((n) => n.props?.token);
    expect(pill).toBeTruthy();
    const { type: Mention, props } = pill;
    Mention(props).props.onClick({ currentTarget: null });
    expect(opened).toEqual(['@bob:localhost']);
  });

  it('draws a role by name, in its colour', () => {
    const ctx = guild();
    const nodes = renderContent(`<@&${ROLE_ID}>`, ctx);
    expect(shownText(nodes)).toBe('@Moderator');
    const [pill] = nodes.flat().filter((n) => typeof n?.type === 'function');
    const drawn = pill.type(pill.props);
    expect(drawn.props.style['--role']).toBe(colourOf(0x5865f2));
    expect(drawn.props.className).toContain('role-ink');
  });

  it('answers the display-name question the same way everywhere', () => {
    const { store } = guild();
    expect(displayNameOf(store, 'g1', '@bob:home')).toBe('Bobby');
    expect(displayNameOf(store, 'g1', '@dot:home')).toBe('Dorothy');
    expect(displayNameOf(store, 'g1', '@zed:home')).toBe('zed');
    expect(displayNameOf(store, 'g1', 'nonsense')).toBe('nonsense');
  });
});

describe('mentions in the composer', () => {
  const ROLE_ID = '01M2RDZYYE8S36FXGAEW97J7A2';
  const ctx = {
    guildId: 'g1',
    store: {
      members: new Map([['g1', new Map([
        ['@bob:home', { user_id: '@bob:home', nickname: 'Bobby' }],
      ])]]),
      roles: new Map([['g1', new Map([
        [ROLE_ID, { id: ROLE_ID, name: 'Moderator', color: 0 }],
      ])]]),
      channels: new Map(),
      myMember: () => ({ roles: [] }),
    },
  };

  it('shows the name in the box and sends the token', () => {
    const wire = `hey <@&${ROLE_ID}> and <@bob:home>`;
    const shown = displayText(wire, ctx);
    expect(shown).toContain('@Moderator');
    expect(shown).toContain('@Bobby');
    expect(shown).not.toContain(ROLE_ID);
    expect(wireText(shown)).toBe(wire);
  });

  it('marks the run so the ink can colour exactly those characters', () => {
    const shown = displayText(`<@&${ROLE_ID}>!`, ctx);
    const parts = splitMentions(shown);
    expect(parts.map((part) => part.label ?? part.text)).toEqual(['@Moderator', '!']);
    expect(parts[0].token).toBe(`<@&${ROLE_ID}>`);
  });

  it('lets an edited name decay to the words that are left', () => {
    const shown = displayText(`<@&${ROLE_ID}>`, ctx);
    expect(wireText(shown.replace('@Moderator', '@Moderatorz'))).toBe('@Moderatorz');
    expect(wireText(`x${shown.slice(0, 3)}y`)).toBe('xy');
  });

  it('leaves a token between backticks as the characters it is', () => {
    expect(displayText(`\`<@&${ROLE_ID}>\``, ctx)).toBe(`\`<@&${ROLE_ID}>\``);
  });

  it('never promotes something typed into a ping', () => {
    expect(displayText('hi @bob:home', ctx)).toBe('hi @bob:home');
    expect(displayText('email me @ work', ctx)).toBe('email me @ work');
  });
});

describe('channel mentions', () => {
  const id = (n) => `01H${'0'.repeat(22)}${n}`;
  const VOICE = { id: id('2'), guild_id: 'g1', type: 'voice', name: 'lounge' };
  const TEXT = { id: id('1'), guild_id: 'g1', type: 'text', name: 'general' };
  const FORUM = { id: id('4'), guild_id: 'g1', type: 'forum', name: 'help' };
  const NEWS = { id: id('5'), guild_id: 'g1', type: 'announcement', name: 'notices' };
  const CATEGORY = { id: id('6'), guild_id: 'g1', type: 'category', name: 'Rooms' };

  const chip = (channel, ctx = {}) => {
    const store = {
      channels: new Map(channel ? [[channel.id, channel]] : []),
      ...ctx.store,
    };
    const target = channel ? channel.id : id('9');
    const nodes = renderContent(`<#${target}>`, { ...ctx, store });
    const [node] = nodes.flat().filter((n) => typeof n?.type === 'function');
    return node.type(node.props);
  };

  const hasGlyph = (node, Glyph) => {
    let found = false;
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.type === Glyph) found = true;
      walk(n.props?.children);
    };
    walk(node);
    return found;
  };

  it('wears the glyph for the kind of room it points at', () => {
    expect(hasGlyph(chip(VOICE, { onNavigate: () => {} }), channelGlyph(VOICE))).toBe(true);
    expect(hasGlyph(chip(VOICE, { onNavigate: () => {} }), channelGlyph(TEXT))).toBe(false);
    expect(hasGlyph(chip(TEXT, { onNavigate: () => {} }), channelGlyph(TEXT))).toBe(true);
    expect(hasGlyph(chip(FORUM, { onNavigate: () => {} }), channelGlyph(FORUM))).toBe(true);
  });

  it('goes where the sidebar goes: the call, not a timeline', () => {
    const routes = [];
    const store = { navigate: (r) => routes.push(r) };
    chip(VOICE, { onNavigate: () => {}, store }).props.onClick();
    chip(FORUM, { onNavigate: () => {}, store }).props.onClick();
    chip(TEXT, { onNavigate: () => {}, store }).props.onClick();
    chip(NEWS, { onNavigate: () => {}, store }).props.onClick();
    expect(routes.map((r) => r.view)).toEqual(['voice', 'forum', 'chat', 'chat']);
    expect(routes[0]).toMatchObject({ guildId: 'g1', channelId: VOICE.id });
  });

  it('is a name and not a door where the surface has nowhere to go', () => {
    const node = chip(TEXT);
    expect(node.type).toBe('span');
  });

  it('leaves a category as a heading, because there is nothing to open', () => {
    expect(chip(CATEGORY, { onNavigate: () => {} }).type).toBe('span');
  });

  it('degrades a deleted or unreachable channel to something readable', () => {
    const node = chip(null, { onNavigate: () => {} });
    expect(node.type).toBe('span');
    expect(node.props.children).toBe('#unknown');
  });
});

describe('markdown', () => {
  const elementsIn = (nodes, type) => {
    const out = [];
    const walk = (n) => {
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (!n || typeof n !== 'object') return;
      if (n.type === type) out.push(n);
      walk(n.props?.children);
    };
    walk(nodes);
    return out;
  };
  const textOf = (n) => {
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(textOf).join('');
    return n && n.props ? textOf(n.props.children) : '';
  };

  it('renders bold, italic and strikethrough as their own elements', () => {
    expect(elementsIn(renderContent('**bold**', {}), 'strong').map(textOf)).toEqual(['bold']);
    expect(elementsIn(renderContent('*italic*', {}), 'em').map(textOf)).toEqual(['italic']);
    expect(elementsIn(renderContent('~~gone~~', {}), 's').map(textOf)).toEqual(['gone']);
  });

  it('renders inline code literally and fenced code as a block', () => {
    expect(elementsIn(renderContent('run `npm test` now', {}), 'code').map(textOf))
      .toEqual(['npm test']);
    expect(elementsIn(renderContent('`**not bold**`', {}), 'strong')).toEqual([]);
    const [pre] = elementsIn(renderContent('```\nlet x\n```', {}), 'pre');
    expect(pre).toBeTruthy();
    expect(pre.props.children.type).toBe('code');
  });

  it('renders a quote as one element however many lines it spans', () => {
    expect(elementsIn(renderContent('> quoted', {}), 'blockquote').map(textOf))
      .toEqual(['quoted']);
    const quotes = elementsIn(renderContent('> one\n> two\nnot quoted', {}), 'blockquote');
    expect(quotes.map(textOf)).toEqual(['one\ntwo']);
  });

  it('keeps formatting that nests inside other formatting', () => {
    const [b] = elementsIn(renderContent('**a `c` b**', {}), 'strong');
    expect(elementsIn([b], 'code').map(textOf)).toEqual(['c']);
    const [q] = elementsIn(renderContent('> **loud** quiet', {}), 'blockquote');
    expect(elementsIn([q], 'strong').map(textOf)).toEqual(['loud']);
  });

  it('hides a spoiler behind paint until clicked, then leaves it shown', () => {
    const { container } = render(h(Fragment, null, ...renderContent('before ||secret|| after', {})));
    const el = container.querySelector('.spoiler');
    expect(el.textContent).toBe('secret');
    expect(el.className).not.toContain('revealed');
    fireEvent.click(el);
    expect(el.className).toContain('revealed');
  });

  it('reveals only the spoiler that was clicked', () => {
    const { container } = render(h(Fragment, null, ...renderContent('||a||||b||', {})));
    const [first, second] = container.querySelectorAll('.spoiler');
    expect(first).toBeTruthy();
    fireEvent.click(first);
    expect(first.className).toContain('revealed');
    expect(second.className).not.toContain('revealed');
  });

  it('reveals a spoiler from the keyboard too', () => {
    const { container } = render(h(Fragment, null, ...renderContent('||shh||', {})));
    const el = container.querySelector('.spoiler');
    expect(el.getAttribute('role')).toBe('button');
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.className).toContain('revealed');
  });

  it('keeps formatting nested inside a spoiler working', () => {
    const { container } = render(h(Fragment, null, ...renderContent('||x **y** z||', {})));
    expect(container.querySelector('.spoiler strong')?.textContent).toBe('y');
    const { container: quoted } = render(h(Fragment, null, ...renderContent('> ||s|| plain', {})));
    expect(quoted.querySelector('blockquote .spoiler')).toBeTruthy();
  });

  it('leaves unpaired pipes as prose', () => {
    expect(textOf(renderContent('one || two', {}))).toBe('one || two');
  });

  const fwdStore = () => ({
    guilds: new Map([['g1', { id: 'g1', name: 'Test Guild' }]]),
    channels: new Map([['c1', { id: 'c1', guild_id: 'g1', name: 'general' }]]),
    jumpTo: () => true,
  });
  const chipsIn = (nodes) => elementsIn(nodes, ForwardedChip)
    .map((chip) => ForwardedChip(chip.props));

  it('strips a guild-origin marker and draws the chip instead of the URI line', () => {
    const nodes = renderContent('telium://forward/g1/c1/m9\nhello there', {});
    expect(textOf(nodes)).not.toContain('telium://');
    const [chip] = chipsIn(nodes);
    expect(chip.type).toBe('span');
    expect(textOf(chip)).toBe('Forwarded from unknown server');
    expect(textOf(nodes)).toContain('hello there');
  });

  it('makes the chip a jump button for a member of the source guild', () => {
    const [chip] = chipsIn(
      renderContent('telium://forward/g1/c1/m9\nhello', { store: fwdStore() }),
    );
    expect(chip.type).toBe('button');
    expect(chip.props.title).toBe('Jump to message in #general');
    expect(textOf(chip)).toBe('Forwarded from Test Guild#general');
  });

  it('jumps through the same machinery a reply preview uses', () => {
    const store = fwdStore();
    const jumps = [];
    store.jumpTo = (channelId, messageId) => { jumps.push([channelId, messageId]); return true; };
    const [chip] = chipsIn(
      renderContent('telium://forward/g1/c1/m9\nhello', { store }),
    );
    chip.props.onClick();
    expect(jumps).toEqual([['c1', 'm9']]);
  });

  it('keeps a conversation-origin copy inert even with a store in hand', () => {
    const nodes = renderContent('telium://forwarded\nhi', { store: fwdStore() });
    expect(textOf(nodes)).not.toContain('telium://');
    expect(chipsIn(nodes).map((chip) => chip.type)).toEqual(['span']);
  });

  it('reads a stacked chain as forwarded from its newest hop only', () => {
    const store = fwdStore();
    store.guilds.set('g2', { id: 'g2' });
    store.channels.set('c2', { id: 'c2', guild_id: 'g2', name: 'annex' });
    const jumps = [];
    store.jumpTo = (channelId, messageId) => { jumps.push(`${channelId}/${messageId}`); return true; };
    const nodes = renderContent(
      'telium://forward/g2/c2/x2\ntelium://forward/g1/c1/m9\nhello',
      { store },
    );
    const [chip] = chipsIn(nodes);
    expect(chipsIn(nodes)).toHaveLength(1);
    expect(chip.type).toBe('button');
    chip.props.onClick();
    expect(jumps).toEqual(['c2/x2']);
  });

  it('chips an attachment-only forward whose body is empty', () => {
    const nodes = renderContent('telium://forward/g1/c1/m9', { store: fwdStore() });
    expect(textOf(nodes)).not.toContain('telium://');
    expect(chipsIn(nodes)).toHaveLength(1);
  });

  it('leaves prose that merely mentions the scheme alone', () => {
    expect(textOf(renderContent('read telium://forwarded today', {})))
      .toContain('telium://forwarded');
  });
});
