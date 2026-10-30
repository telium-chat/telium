import { act } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { Store } from '../lib/store.js';
import { wipeDeviceSecrets } from '../lib/device-secrets.js';

function browserEvent(fn) {
  if (globalThis.IS_REACT_ACT_ENVIRONMENT === true) return act(fn);
  return fn();
}

export const HOME = 'https://home.example';
export const GUILD = 'https://guilds.example';
export const KLIPY = 'https://api.klipy.com';
export const TENOR = 'https://tenor.googleapis.com';

const running = [];
afterEach(async () => {
  for (const store of running.splice(0)) store.gw.closeAll();
  await wipeDeviceSecrets();
});

export function freshStore() {
  const store = new Store();
  running.push(store);
  return store;
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

export const PASSWORD = 'hunter2hunter2';

let opaque = null;
let serverSetup = null;
const records = new Map();

async function opaqueSetup() {
  opaque ??= await import('@serenity-kit/opaque');
  await opaque.ready;
  serverSetup ??= opaque.server.createSetup();
  return serverSetup;
}

async function opaqueRecord(userIdentifier, password) {
  const setup = await opaqueSetup();
  const key = `${userIdentifier}\u0000${password}`;
  if (!records.has(key)) {
    const start = opaque.client.startRegistration({ password });
    const { registrationResponse } = opaque.server.createRegistrationResponse({
      serverSetup: setup,
      userIdentifier,
      registrationRequest: start.registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
      clientRegistrationState: start.clientRegistrationState,
      registrationResponse,
      password,
    });
    records.set(key, registrationRecord);
  }
  return records.get(key);
}

export function createFakeServer(overrides = {}) {
  const state = {
    userId: '@alice:home.example',
    authBodies: [],
    guild: {
      id: 'g1',
      name: 'Telium',
      domain: 'guilds.example',
      owner: '@alice:home.example',
      media_expiry_limit_secs: null,
      channels: [
        {
          id: 'c1', name: 'general', type: 'text', topic: 'The first channel',
          permission_overwrites: [],
          media_expiry_limit_secs: null,
        },
        { id: 'c2', name: 'lounge', type: 'voice', permission_overwrites: [] },
        { id: 'c3', name: 'notices', type: 'announcement', permission_overwrites: [] },
      ],
      roles: [
        {
          id: 'g1', name: '@everyone', color: 0, position: 0,
          permissions: '3151875', permission_names: ['VIEW_CHANNEL', 'SEND_MESSAGES'],
          hoist: false, mentionable: false,
        },
        {
          id: 'r1', name: 'Moderator', color: 0x5865f2, position: 1,
          permissions: '4', permission_names: ['MANAGE_MESSAGES'],
          hoist: true, mentionable: true,
        },
      ],
      me: {
        user_id: '@alice:home.example',
        nickname: null,
        banned: false,
        timeout_until: null,
        is_owner: true,
        roles: ['g1'],
        permissions: '18446744073709551615',
        top_role_position: 2147483647,
      },
      member_count: 2,
    },
    members: [
      {
        user_id: '@alice:home.example', display_name: 'Alice', nickname: null,
        avatar_ref: null, roles: ['g1'], banned: false, timeout_until: null,
      },
      {
        user_id: '@bob:home.example', display_name: 'Bob', nickname: null,
        avatar_ref: null, roles: ['g1', 'r1'], banned: false, timeout_until: null,
      },
    ],
    messages: [
      {
        id: 'm1', channel_id: 'c1', guild_id: 'g1', author: '@bob:home.example',
        content: 'first', created_at: 1_700_000_000_000,
      },
      {
        id: 'm2', channel_id: 'c1', guild_id: 'g1', author: '@alice:home.example',
        content: 'second', created_at: 1_700_000_060_000,
      },
    ],
    pins: [],
    conversations: [],
    dmFrames: [],
    friends: [],
    mutualFriends: [],
    emojis: [],
    stickers: [
      {
        kind: 'sticker', id: 'st1', guild_id: 'g1', name: 'partyblob',
        reference: 'media://guilds.example/stickerhash',
        url: `${GUILD}/_telium/v1/media/stickerhash`, animated: false,
      },
    ],
    gates: {
      min_account_age_days: 0,
      domain_policy: 'open',
      domains: [],
      screening: [],
      hold_first_messages: 0,
      origin_policy: 'open',
      origins: [],
    },
    feedRefreshes: 0,
    feedStatusAfterRefresh: null,
    profiles: {},
    profileHits: [],
    reachable: new Set([HOME, GUILD, KLIPY, TENOR]),
    mediaPreference: { tier: 1, origin: null, updated_at: 0 },
    mediaWrites: [],
    mediaHosts: [{
      origin: 'files.example',
      name: 'Example Files',
      description: '2 GB per file, kept for a year.',
      max_file_bytes: 2_147_483_648,
      abuse_contact: 'abuse@files.example',
    }],
    feedVouchedHosts: [],
    curators: [],
    gofilePlaybackProxy: true,
    externalHosts: [{
      id: 'gofile', provider: 'gofile', name: 'Gofile', domain: 'gofile.io',
      upload_url: 'https://upload.gofile.io/uploadfile',
      description: 'Guest files are temporary and are normally kept for about ten days.',
      browser_direct: true,
    }],
    externalUploads: [],
    hosting: { enabled: false, providers: [], guild_role: true, guided_handoff: true },
    latency: 0,
    expressionLatency: 0,
    serverMediaExpirySecs: 0,
    serverMediaMaxFileBytes: 2_147_483_648,
    failNextUpload: false,
    uploadSeen: 0,
    serverQuotaBytes: null,
    serverQuotaUsed: 0,
    uploadGate: null,
    mediaUploads: [],
    storedMedia: new Map(),
    blackhole: new Set(),
    expired: new Set(),
    minted: new Map(),
    sync: {},
    syncSealed: false,
    invite: {
      code: 'INVITE1',
      guild: {
        id: 'g1', name: 'Telium', icon_ref: null, member_count: 2, host: 'guilds.example',
      },
      channel_id: 'c1',
      inviter: '@alice:home.example',
      expires_at: null,
    },
    inviteCreates: [],
    segments: [],
    archived: [],
    follows: [],
    watching: [],
    moderated: [],
    deleted: [],
    guildCreates: [],
    reorders: [],
    rolePatches: [],
    devices: [
      {
        device_id: 'd1', name: 'web (test)', pubkey: 'AAAA', created_at: 1_700_000_000_000,
        last_seen: 1_700_000_000_000, active: true, current: true,
      },
    ],
    crossSigning: { exists: false },
    userSignatures: [],
    verifications: [],
    sent: [],
    embedRequests: [],
    expressionRequests: [],
    klipyRequests: [],
    tenorRequests: [],
    klipyResults: [
      {
        id: 'klipy-1',
        slug: 'big-brother-is-watching-you-5--kNcWQFFAe',
        title: 'Celebration',
        file: {
          sm: { gif: { url: 'https://media.klipy.com/test/celebrate.gif', width: 160, height: 120 } },
          hd: { gif: { url: 'https://media.klipy.com/test/celebrate.gif', width: 640, height: 480 } },
        },
      },
    ],
    tenorResults: [
      {
        id: '6459198981897272921',
        title: '',
        media_formats: {
          mediumgif: { url: 'https://media1.tenor.com/test/hypergamy.gif', dims: [373, 266] },
          gif: { url: 'https://media1.tenor.com/test/hypergamy-full.gif', dims: [498, 355] },
          tinygif: { url: 'https://media1.tenor.com/test/hypergamy-small.gif', dims: [165, 118] },
        },
      },
    ],
    reactions: [],
    channelPatches: [],
    keyStock: new Map(),
    vaults: new Map(),
    backups: new Map(),
    backupClock: 0,
    tokens: new Map(),
    dmSeq: 0,
    joins: [],
    sockets: [],
    reclaimsVoice: true,
    voiceStates: [],
    streams: [],
    streamDenied: false,
    signals: [],
    calls: new Map(),
    threads: new Map(),
    threadSeq: 0,
    iceServers: [{ urls: ['stun:stun.example:3478'] }],
    opaqueAuth: true,
    recoveryKeyReset: false,
    suggestAlternatives: false,
    password: PASSWORD,
    opaqueAccounts: new Map(),
    legacyAccounts: new Set(),
    opaqueLogins: new Map(),
    opaqueLoginSeq: 0,
    upgradeTokens: new Set(),
    ...overrides,
  };

  const friendRow = (userId, relation) => {
    const row = {
      user_id: userId,
      domain: userId.split(':')[1],
      state: relation,
      presence: relation === 'accepted' ? { user_id: userId, status: 'online' } : null,
      display_name: null,
      avatar_ref: null,
    };
    state.friends = [...state.friends.filter((f) => f.user_id !== userId), row];
    return row;
  };

  const dropFriend = (userId) => {
    state.friends = state.friends.filter((f) => f.user_id !== userId);
    return { user_id: userId, state: null };
  };

  const headerOf = (headers) => (name) => {
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target && value != null && value !== '') return String(value);
    }
    return null;
  };

  const expiryCapFor = (headers) => {
    let cap = state.serverMediaExpirySecs > 0 ? state.serverMediaExpirySecs : null;
    const tighten = (secs) => {
      if (secs == null || secs <= 0) return;
      cap = cap == null ? secs : Math.min(cap, secs);
    };
    const channelId = headerOf(headers)('x-telium-channel-id');
    const channel = channelId ? state.guild.channels.find((c) => c.id === channelId) : null;
    if (channel || headerOf(headers)('x-telium-guild-id') === state.guild.id) {
      tighten(channel?.media_expiry_limit_secs);
      tighten(state.guild.media_expiry_limit_secs);
    }
    return cap;
  };

  const expiredRow = (row) => row.expires_at !== null && row.expires_at <= Date.now();

  const storeUpload = async (origin2, headers) => {
    const header = headerOf(headers);
    const ttlRaw = header('x-telium-ttl-secs');
    const ttl = ttlRaw === null ? null : Number(ttlRaw);
    const cap = expiryCapFor(headers);
    const candidates = [ttl, cap].filter((v) => v != null && v > 0);
    const lifetime = candidates.length ? Math.min(...candidates) : null;
    const expires_at = lifetime == null ? null : Date.now() + lifetime * 1000;
    let filename = 'file';
    try { filename = decodeURIComponent(header('x-telium-filename') || 'file'); } catch {}
    const host = new URL(origin2).host;
    const hash = `hash${state.storedMedia.size + 1}`;
    state.storedMedia.set(hash, { expires_at });
    state.uploadSeen += 1;
    if (state.uploadGate) await state.uploadGate;
    if (state.failNextUpload) {
      state.failNextUpload = false;
      return json({ error: 'too_large', message: 'the origin is pretending to be broken' }, 507);
    }
    state.mediaUploads.push({
      purpose: header('x-telium-purpose'),
      ttl,
      channel_id: header('x-telium-channel-id'),
      guild_id: header('x-telium-guild-id'),
      filename,
      expires_at,
    });
    return json({
      origin: host,
      hash,
      reference: `media://${host}/${hash}`,
      capability: 'cap-1',
      url: `${origin2}/_telium/v1/media/${hash}?cap=cap-1`,
      filename,
      mime: header('content-type') || 'application/octet-stream',
      size: 30,
      expires_at,
    });
  };

  const routes = (origin, path, method, body, query, auth, headers = {}) => {
    if (origin === KLIPY && path.startsWith('/api/v1/')) {
      state.klipyRequests.push({ path, query: Object.fromEntries(query || []) });
      return json({ data: state.klipyResults, meta: { next_page: null } });
    }
    if (origin === TENOR && path === '/v2/posts') {
      state.tenorRequests.push({ path, query: Object.fromEntries(query || []) });
      return json({ results: state.tenorResults });
    }
    if (path === '/.well-known/telium/server') {
      return json({
        server_name: new URL(origin).host,
        api: origin,
        gateway: `${origin.replace(/^http/, 'ws')}/gateway/v1`,
        onboarding: {
          recommendations: {
            accepting: false,
            referral_weight: 1,
            suggest_alternatives: state.suggestAlternatives,
          },
        },
      });
    }
    const session = ({ fresh = false, upgrade = null } = {}) => {
      state.tokens.set('home-token', state.userId);
      return json({
        access_token: 'home-token',
        user_id: state.userId,
        device_id: 'd1',
        server_name: new URL(origin).host,
        expires_at: Date.now() + 86_400_000,
        device_secret: fresh ? 'AAAA' : null,
        ...(upgrade ? { opaque_upgrade_token: upgrade } : {}),
      });
    };

    if (path === '/_telium/v1/register/opaque/start') {
      return opaqueSetup().then((setup) => json({
        registration_response: opaque.server.createRegistrationResponse({
          serverSetup: setup,
          userIdentifier: body.localpart,
          registrationRequest: body.registration_request,
        }).registrationResponse,
      }));
    }
    if (path === '/_telium/v1/register/opaque/finish') {
      state.opaqueAccounts.set(body.localpart, body.registration_record);
      const answer = session({ fresh: true });
      if (!state.recoveryKeyReset) return answer;
      return Promise.resolve(answer).then(async (response) => {
        const payload = await response.json();
        return json({
          ...payload,
          recovery_key_enrolled: Boolean(body.recovery_public_key),
        });
      });
    }
    if (path === '/_telium/v1/login/opaque/start') {
      const user = String(body.user).replace(/^@/, '').split(':')[0];
      if (state.legacyAccounts.has(user)) {
        return json({ legacy_upgrade_required: true });
      }
      return opaqueSetup()
        .then(async (setup) => {
          const record = state.opaqueAccounts.get(user)
            ?? await opaqueRecord(user, state.password);
          const started = opaque.server.startLogin({
            serverSetup: setup,
            registrationRecord: record,
            startLoginRequest: body.start_login_request,
            userIdentifier: user,
          });
          const id = `login-${(state.opaqueLoginSeq += 1)}`;
          state.opaqueLogins.set(id, {
            serverLoginState: started.serverLoginState,
            user,
          });
          return json({ login_id: id, login_response: started.loginResponse });
        });
    }
    if (path === '/_telium/v1/login/opaque/finish') {
      const attempt = state.opaqueLogins.get(body.login_id);
      state.opaqueLogins.delete(body.login_id);
      if (!attempt) {
        return json({ error: 'unauthorized', message: 'unknown login' }, 401);
      }
      return opaqueSetup().then(() => {
        try {
          opaque.server.finishLogin({
            serverLoginState: attempt.serverLoginState,
            finishLoginRequest: body.finish_login_request,
          });
        } catch {
          return json({ error: 'unauthorized', message: 'invalid credentials' }, 401);
        }
        return session();
      });
    }
    if (path === '/_telium/v1/auth/opaque/enroll/start') {
      if (!state.upgradeTokens.has(body.upgrade_token)) {
        return json({ error: 'unauthorized', message: 'bad upgrade token' }, 401);
      }
      return opaqueSetup().then((setup) => json({
        registration_response: opaque.server.createRegistrationResponse({
          serverSetup: setup,
          userIdentifier: state.userId.slice(1).split(':')[0],
          registrationRequest: body.registration_request,
        }).registrationResponse,
      }));
    }
    if (path === '/_telium/v1/auth/opaque/enroll/finish') {
      if (!state.upgradeTokens.has(body.upgrade_token)) {
        return json({ error: 'unauthorized', message: 'bad upgrade token' }, 401);
      }
      const localpart = state.userId.slice(1).split(':')[0];
      state.opaqueAccounts.set(localpart, body.registration_record);
      state.legacyAccounts.delete(localpart);
      state.upgradeTokens.delete(body.upgrade_token);
      return json({ ok: true });
    }
    if (path === '/_telium/v1/auth/opaque/reauth/start') {
      const localpart = state.userId.slice(1).split(':')[0];
      return opaqueSetup()
        .then(async (setup) => {
          const record = state.opaqueAccounts.get(localpart)
            ?? await opaqueRecord(localpart, state.password);
          const started = opaque.server.startLogin({
            serverSetup: setup,
            registrationRecord: record,
            startLoginRequest: body.start_login_request,
            userIdentifier: localpart,
          });
          const id = `reauth-${(state.opaqueLoginSeq += 1)}`;
          state.opaqueLogins.set(id, {
            serverLoginState: started.serverLoginState,
            user: localpart,
          });
          return json({ login_id: id, login_response: started.loginResponse });
        });
    }
    if (path === '/_telium/v1/auth/opaque/reauth/finish') {
      const attempt = state.opaqueLogins.get(body.login_id);
      state.opaqueLogins.delete(body.login_id);
      if (!attempt) {
        return json({ error: 'unauthorized', message: 'unknown login' }, 401);
      }
      return opaqueSetup().then(() => {
        try {
          opaque.server.finishLogin({
            serverLoginState: attempt.serverLoginState,
            finishLoginRequest: body.finish_login_request,
          });
        } catch {
          return json({ error: 'unauthorized', message: 'invalid credentials' }, 401);
        }
        return json({ reauth_token: 'reauth-1' });
      });
    }
    if (path === '/_telium/v1/login' || path === '/_telium/v1/register') {
      state.authBodies.push({ path, body: { ...body } });
      const localpart = state.userId.slice(1).split(':')[0];
      const upgrade = state.opaqueAuth && state.legacyAccounts.has(localpart)
        ? 'upgrade-1'
        : null;
      if (upgrade) state.upgradeTokens.add(upgrade);
      return session({ fresh: path.endsWith('register'), upgrade });
    }
    if (path === '/_telium/v1/whoami') {
      return json({
        user_id: state.userId,
        device_id: state.deviceId ?? 'device-1',
        server_name: 'home.example',
        admin: false,
        mfa_enabled: false,
        profile: state.profiles?.[state.userId] ?? {
          user_id: state.userId,
          display_name: 'Alice',
          avatar_ref: null,
          banner_ref: null,
          accent_color: null,
          bio: null,
          pronouns: null,
          profile_version: 1,
          updated_at: 1_700_000_000_000,
        },
      });
    }
    if (path === '/_telium/v1/profile' && method === 'PATCH') {
      state.profileWrites = state.profileWrites || [];
      state.profileWrites.push({ ...body });
      return json({
        user_id: state.userId,
        display_name: body.display_name || 'Alice',
        avatar_ref: body.avatar_ref ?? null,
      });
    }
    if (path === '/_telium/v1/capabilities') {
      return json({
        server_name: new URL(origin).host,
        roles: { identity: true, guild: true, media: true },
        calls: state.callCaps || {
          relay: false, sfu: false, mesh_max_participants: 4, e2ee: 'mls-exporter',
        },
        profile: { bio_max_chars: state.bioMaxChars ?? 1024 },
        registration_open: true,
        auth: state.opaqueAuth
          ? {
            opaque: true,
            recovery_key_reset: state.recoveryKeyReset,
            protocol: 'rfc9807',
          }
          : { opaque: false, recovery_key_reset: false },
        features: { gif_picker: true },
        gif_provider: {
          enabled: true,
          provider: 'klipy',
          api_key: 'test-key',
          api_base_url: `${KLIPY}/api/v1`,
          media_hosts: ['media.klipy.com'],
        },
        media: { max_expiry_secs: state.serverMediaExpirySecs, max_file_bytes: state.serverMediaMaxFileBytes },
        account: { tier1_upload: true, quota_bytes: state.serverQuotaBytes, used_bytes: state.serverQuotaUsed },
      });
    }
    if (path === '/_telium/v1/assertions') return json({ assertion: 'assert-1' });
    if (path === '/_telium/v1/sessions') {
      const host = new URL(origin).host;
      const n = (state.minted.get(host) || 0) + 1;
      state.minted.set(host, n);
      const first = `session-for-${host}`;
      return json({
        session_token: n === 1 && !state.expired.has(first) ? first : `${first}-${n + 1}`,
        gateway: `${origin.replace(/^http/, 'ws')}/gateway/v1`,
        expires_at: Date.now() + 3_600_000,
      });
    }
    if (path === '/_telium/v1/guilds' && method === 'POST') {
      state.guildCreates.push({ name: body.name, token: auth.replace(/^Bearer /, '') });
      return json({
        id: `g${state.guildCreates.length + 1}`,
        name: body.name,
        domain: new URL(origin).host,
        icon_ref: null,
        member_count: 1,
      });
    }
    const mediaDelete = path.match(/^\/_telium\/v1\/media\/([\w-]+)$/);
    if (mediaDelete && method === 'DELETE') {
      if (!state.storedMedia.delete(mediaDelete[1])) return json({ error: 'not_found', message: 'no such media' }, 404);
      return json({ ok: true, hash: mediaDelete[1] });
    }
    if (path === '/_telium/v1/media/preference') {
      if (method === 'PUT') {
        state.mediaWrites.push(body);
        state.mediaPreference = {
          tier: body.tier,
          origin: body.tier === 2 ? body.origin : null,
          updated_at: Date.now(),
        };
      }
      return json(state.mediaPreference);
    }
    if (path === '/_telium/v1/media/vouchers' && method === 'POST') {
      return json({
        voucher: {
          kind: 'media_voucher', guild_id: body.guild_id, origin: body.origin,
          max_bytes: body.max_bytes,
        },
      });
    }
    if (path === '/_telium/v1/hosting/providers') {
      return json({
        enabled: state.hosting.enabled,
        self_hosted: { server_name: origin.replace(/^https?:\/\//, ''), available: state.hosting.guild_role },
        providers: state.hosting.providers,
        portability: { guided_handoff: state.hosting.guided_handoff },
      });
    }
    if (path === '/_telium/v1/media/registry') {
      return json({
        hosts: state.mediaHosts,
        external_hosts: state.externalHosts,
        gofile_playback_proxy: state.gofilePlaybackProxy,
      });
    }
    if (path === '/_telium/v1/media/registry/feeds') {
      return json({ hosts: state.feedVouchedHosts });
    }
    if (path.startsWith('/_telium/v1/media/external/') && method === 'POST') {
      const hostId = decodeURIComponent(path.split('/').pop());
      state.externalUploads.push({ hostId, headers, size: body?.size || 0 });
      const host = state.externalHosts.find((entry) => entry.id === hostId);
      if (!host) return json({ error: 'not_found', message: 'no such external upload host' }, 404);
      return json({ url: `https://${host.domain}/external-test.bin`, expires_at: null });
    }
    if ((path === '/_telium/v1/media' || path === '/_telium/v1/media/voucher-upload')
      && method === 'POST') {
      return storeUpload(origin, headers);
    }
    if (/^\/_telium\/v1\/media\/[^/]+\/meta$/.test(path)) {
      const row = state.storedMedia.get(path.split('/')[4]);
      if (!row || expiredRow(row)) return json({ error: 'not_found', message: 'no such media' }, 404);
      return json({ hash: path.split('/')[4], expires_at: row.expires_at });
    }
    if (/^\/_telium\/v1\/media\/[^/]+$/.test(path) && method === 'GET') {
      const hash = path.split('/')[4];
      const row = state.storedMedia.get(hash);
      if (!row || expiredRow(row)) return json({ error: 'not_found', message: 'no such media' }, 404);
      return json({ hash, expires_at: row.expires_at });
    }
    if (path === '/_telium/v1/friends') {
      if (method === 'POST') {
        const id = body.user_id;
        const waiting = state.friends.find((f) => f.user_id === id && f.state === 'pending_in');
        return json(friendRow(id, waiting ? 'accepted' : 'pending_out'));
      }
      return json({ friends: state.friends });
    }
    if (path.startsWith('/_telium/v1/friends/mutual/') && method === 'GET') {
      return json({ friends: state.mutualFriends, complete: true });
    }
    if (path.startsWith('/_telium/v1/friends/')) {
      const id = decodeURIComponent(path.split('/')[4]);
      if (path.endsWith('/accept')) return json(friendRow(id, 'accepted'));
      if (path.endsWith('/block')) {
        return json(method === 'PUT' ? friendRow(id, 'blocked') : dropFriend(id));
      }
      return json(dropFriend(id));
    }
    if (path === '/_telium/v1/conversations' && method === 'POST') {
      const convo = {
        id: `dm-${state.conversations.length + 1}`,
        kind: body.kind,
        sequencer: new URL(origin).host,
        epoch: 0,
        last_seq: 0,
        members: (body.members || []).map((u) => ({ user_id: u, state: 'joined' })),
      };
      state.conversations.push(convo);
      return json(convo);
    }
    if (path === '/_telium/v1/conversations') return json({ conversations: state.conversations });
    if (/^\/_telium\/v1\/conversations\/[^/]+\/voice$/.test(path)) {
      const id = path.split('/')[4];
      return json({ conversation_id: id, voice_states: state.calls.get(id) || [], watchers: [] });
    }
    if (/^\/_telium\/v1\/conversations\/[^/]+\/voice\//.test(path)) {
      const id = path.split('/')[4];
      const what = path.split('/').pop();
      if (!state.calls.has(id)) state.calls.set(id, []);
      const roster = state.calls.get(id);
      if (what === 'signal') {
        state.signals.push({ conversation_id: id, ...body });
        return json({ ok: true });
      }
      if (what === 'leave') {
        state.calls.set(id, roster.filter((v) => v.user_id !== state.userId));
        return json({ ok: true });
      }
      let mine = roster.find((v) => v.user_id === state.userId);
      if (!mine) {
        mine = { user_id: state.userId, conversation_id: id, channel_id: id, session_id: 'cs1' };
        roster.push(mine);
      }
      if (body.streaming !== undefined) state.streams.push({ enabled: body.streaming });
      if (what === 'join') {
        state.callJoins = state.callJoins || [];
        state.callJoins.push({ conversation_id: id, ...body });
      }
      Object.assign(mine, body);
      const voiceServer = state.callServer?.(id, body) || {
        mode: 'mesh',
        channel_id: id,
        conversation_id: id,
        max_participants: 4,
        generation: 0,
        host: null,
        relay: false,
        ice_servers: state.iceServers,
      };
      if (what === 'server') return json({ voice_server: voiceServer });
      if (what !== 'join') return json(mine);
      return json({ voice_state: mine, voice_server: voiceServer });
    }
    const sealedValue = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
      && typeof v.sealed === 'string' && typeof v.ct === 'string';
    const wantsSealed = new URLSearchParams(query || undefined).get('sealed') === '1';
    if (path === '/_telium/v1/sync') {
      return json(Object.fromEntries(Object.entries(state.sync)
        .filter(([, row]) => wantsSealed || !sealedValue(row.value))));
    }
    if (path.startsWith('/_telium/v1/sync/')) {
      const key = decodeURIComponent(path.slice('/_telium/v1/sync/'.length));
      if (method === 'PUT') {
        if (!sealedValue(body) && ['drafts.v2', 'stickers.saved.v1'].includes(key)) {
          return json({ error: 'bad_request' }, 400);
        }
        if (!sealedValue(body) && state.syncSealed) return json({ error: 'conflict' }, 409);
        if (sealedValue(body)) state.syncSealed = true;
        state.sync[key] = { value: body, updated_at: Date.now() };
        return json({ ok: true, key });
      }
      if (method === 'DELETE') {
        delete state.sync[key];
        return json({ ok: true });
      }
      const row = state.sync[key];
      if (!row || (!wantsSealed && sealedValue(row.value))) return json({ error: 'not_found' }, 404);
      return json({ key, ...row });
    }
    if (/^\/_telium\/v1\/conversations\/[^/]+\/messages$/.test(path)) {
      const id = path.split('/')[4];
      if (method === 'POST') {
        state.dmSeq += 1;
        const frame = {
          id: `f${state.dmSeq}`,
          conversation_id: id,
          seq: state.dmFrames.filter((f) => f.conversation_id === id).length + 1,
          epoch: body.epoch || 0,
          kind: body.kind || 'application',
          sender: state.tokens.get(auth.replace(/^Bearer /, '')) || state.userId,
          sender_device: 'd1',
          ciphertext: body.ciphertext,
          created_at: Date.now(),
        };
        state.dmFrames.push(frame);
        for (const socket of state.sockets) {
          if (socket.readyState !== FakeSocket.OPEN) continue;
          if (new URL(socket.url.replace(/^ws/, 'http')).host !== new URL(origin).host) continue;
          socket.deliver({ op: 'DISPATCH', t: 'DM_MESSAGE', d: frame, s: 1 });
        }
        return json(frame);
      }
      const mine = state.dmFrames
        .filter((f) => f.conversation_id === id)
        .sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const after = Number(query.get('after') || 0);
      const above = mine.filter((f) => (f.seq || 0) > after);
      const tail = query.get('tail');
      if (tail) return json({ messages: above.slice(-Number(tail)) });
      return json({ messages: above.slice(0, Number(query.get('limit') || 100)) });
    }
    if (path === '/_telium/v1/keypackages') {
      const who = state.tokens.get(auth.replace(/^Bearer /, '')) || state.userId;
      if (!state.keyStock.has(who)) state.keyStock.set(who, []);
      if (method === 'POST') {
        state.keyStock.get(who).push(...(body.packages || []));
        return json({ published: (body.packages || []).length });
      }
      return json({
        available: state.keyStock.get(who).length,
        devices: [{ device_id: 'd1', available: state.keyStock.get(who).length }],
      });
    }
    if (/^\/_telium\/v1\/users\/[^/]+\/keypackages\/claim$/.test(path)) {
      const target = decodeURIComponent(path.split('/')[4]);
      const stock = state.keyStock.get(target) || [];
      return json({ user_id: target, key_packages: [{ device_id: 'd1', package: stock.shift() ?? null }] });
    }
    if (/^\/_telium\/v1\/conversations\/[^/]+$/.test(path)) {
      const found = state.conversations.find((c) => c.id === path.split('/')[4]);
      return found ? json(found) : json({ error: 'not_found', message: 'no such conversation' }, 404);
    }
    if (path === '/_telium/v1/vault') {
      const who = state.tokens.get(auth.replace(/^Bearer /, '')) || state.userId;
      const held = state.vaults.get(who) || null;
      const stale = () => json({
        error: 'conflict', code: 'vault_version_conflict', version: held?.version || 0,
      }, 409);
      if (method === 'PUT') {
        if (typeof body.expected_version === 'number'
          && body.expected_version !== (held?.version || 0)) return stale();
        state.vaults.set(who, {
          version: (held?.version || 0) + 1,
          ciphertext: body.ciphertext,
          mode: body.mode || (body.escrow_key ? 'escrowed' : 'device_custody'),
          escrow_key: body.escrow_key || null,
          independent_ciphertext: body.independent_ciphertext || null,
        });
        return json({ ok: true, version: state.vaults.get(who).version });
      }
      const mirror = state.backups.get(who);
      const rows = mirror ? [...mirror.values()] : [];
      if (!held) return json({ exists: false });
      return json({
        exists: true,
        mode: held.mode,
        version: held.version,
        ciphertext: held.ciphertext,
        escrow_key: held.escrow_key || undefined,
        independent_ciphertext: held.independent_ciphertext || null,
        server_can_recover: Boolean(held.escrow_key),
        backup: {
          items: rows.length,
          updated_at: rows.reduce((n, r) => Math.max(n, r.updated_at), 0) || null,
          server_can_read: Boolean(held.escrow_key) && rows.length > 0,
        },
      });
    }
    if (path === '/_telium/v1/vault/mode') {
      const who = state.tokens.get(auth.replace(/^Bearer /, '')) || state.userId;
      const held = state.vaults.get(who) || null;
      if (typeof body.expected_version === 'number'
        && body.expected_version !== (held?.version || 0)) {
        return json({
          error: 'conflict', code: 'vault_version_conflict', version: held?.version || 0,
        }, 409);
      }
      const independent = body.mode !== 'opaque_custody'
        ? held?.independent_ciphertext || null
        : body.clear_independent
          ? null
          : body.independent_ciphertext || held?.independent_ciphertext || null;
      state.vaults.set(who, {
        version: (held?.version || 0) + 1,
        ciphertext: body.ciphertext,
        mode: body.mode,
        escrow_key: body.mode === 'escrowed' ? (body.escrow_key || null) : null,
        independent_ciphertext: independent,
      });
      return json({ mode: body.mode, version: state.vaults.get(who).version });
    }
    if (path === '/_telium/v1/vault/backup') {
      const who = state.tokens.get(auth.replace(/^Bearer /, '')) || state.userId;
      if (!state.backups.has(who)) state.backups.set(who, new Map());
      const mirror = state.backups.get(who);
      if (method === 'PUT') {
        for (const item of body.items || []) {
          state.backupClock += 1;
          mirror.set(`${item.scope}\u0000${item.item}`, {
            scope: item.scope,
            item: item.item,
            ciphertext: item.ciphertext,
            updated_at: state.backupClock,
          });
        }
        return json({ stored: (body.items || []).length });
      }
      if (method === 'DELETE') {
        const scope = body?.scope || null;
        for (const [key, row] of [...mirror]) {
          if (!scope || row.scope === scope) mirror.delete(key);
        }
        return json({ ok: true });
      }
      const scope = query?.get('scope') || null;
      const after = Number(query?.get('after') || 0);
      const limit = Math.min(Number(query?.get('limit') || 256), 512);
      const rows = [...mirror.values()]
        .filter((r) => (!scope || r.scope === scope) && r.updated_at > after)
        .sort((a, b) => a.updated_at - b.updated_at)
        .slice(0, limit);
      return json({
        scope,
        items: rows,
        cursor: rows.length ? rows[rows.length - 1].updated_at : after,
        complete: rows.length < limit,
      });
    }
    if (path === '/_telium/v1/guild-addresses/resolve' && method === 'GET') {
      const alias = state.vanity?.alias;
      const host = new URL(origin).host;
      const address = query?.get('address');
      if (origin !== GUILD || !alias || address !== `#${alias}:${host}`) {
        return json({ error: 'not_found', message: 'unknown guild address' }, 404);
      }
      return json({
        guild_id: state.guild.id,
        origin: host,
        landed: address,
        redirected: false,
      });
    }
    if (/^\/_telium\/v1\/guilds\/[^/]+\/join-preview$/.test(path) && method === 'GET') {
      const guildId = path.split('/')[4];
      const alias = state.vanity?.alias;
      if (origin !== GUILD || !alias || guildId !== state.guild.id) {
        return json({ error: 'not_found', message: 'vanity link is disabled' }, 404);
      }
      return json({
        address: `#${alias}:guilds.example`,
        url: `${GUILD}/invite/${alias}`,
        guild: {
          id: state.guild.id,
          name: state.guild.name,
          icon_ref: null,
          member_count: state.guild.member_count,
          host: 'guilds.example',
        },
      });
    }
    if (/^\/_telium\/v1\/guilds\/[^/]+\/join$/.test(path) && method === 'POST') {
      const guildId = path.split('/')[4];
      const alias = state.vanity?.alias;
      if (origin !== GUILD || !alias || guildId !== state.guild.id) {
        return json({ error: 'not_found', message: 'vanity link is disabled' }, 404);
      }
      state.joins.push(`vanity:${alias}`);
      return json({ id: state.guild.id, name: state.guild.name });
    }

    if (/^\/_telium\/v1\/invites\/[^/]+$/.test(path) && method === 'GET') {
      const code = path.split('/').pop();
      if (origin !== GUILD || code !== state.invite.code) {
        return json({ error: 'not_found', message: 'unknown invite' }, 404);
      }
      return json({
        ...state.invite,
        guild: { ...state.invite.guild, online_count: 1 },
      });
    }
    if (/^\/_telium\/v1\/invites\/[^/]+\/join$/.test(path) && method === 'POST') {
      const code = path.split('/')[4];
      if (origin !== GUILD || code !== state.invite.code) {
        return json({ error: 'not_found', message: 'unknown invite' }, 404);
      }
      state.joins.push(code);
      return json({ ok: true });
    }
    if (/\/channels\/[^/]+\/segments$/.test(path)) return json({ segments: state.segments });
    if (/\/channels\/[^/]+\/follow(\/|$)/.test(path)) {
      const source = path.split('/')[4];
      if (method === 'POST') state.follows.push({ source, target: body.target_id });
      else state.follows = state.follows.filter((f) => f.source !== source);
      return json({ ok: true });
    }
    if (/\/channels\/[^/]+\/voice\/watch$/.test(path)) {
      state.watching.push({ channel_id: path.split('/')[4], ...body });
      return json({ watching: body.watching !== false, streamer: body.streamer });
    }
    if (/\/guilds\/[^/]+\/voice\/[^/]+$/.test(path) && method === 'POST') {
      state.moderated.push({ user_id: decodeURIComponent(path.split('/')[6]), ...body });
      return json({ ok: true });
    }
    if (path.endsWith('/gates/refresh-feeds') && method === 'POST') {
      state.feedRefreshes += 1;
      if (state.feedStatusAfterRefresh) {
        state.gates.origins = state.gates.origins.map((o) => (
          o.feed ? { ...o, status: state.feedStatusAfterRefresh } : o
        ));
      }
      return json({ ...state.gates });
    }
    if (path.endsWith('/gates/curators')) {
      return json({ curators: state.curators });
    }
    if (path.endsWith('/gates')) {
      if (method === 'PUT') Object.assign(state.gates, body);
      return json(state.gates);
    }
    if (/\/_telium\/v1\/users\/[^/]+\/profile$/.test(path)) {
      const target = decodeURIComponent(path.split('/')[4]);
      state.profileHits.push(target);
      const seeded = state.profiles[target];
      if (!seeded) return json({ error: 'not_found', message: 'no such user' }, 404);
      return json(seeded);
    }
    if (path.endsWith('/read-state')) return json({ channels: [] });
    if (path.endsWith('/roles')) {
      const withCounts = () => state.guild.roles
        .map((r) => ({
          ...r,
          member_count: r.id === state.guild.id
            ? state.members.length
            : state.members.filter((m) => (m.roles || []).includes(r.id)).length,
        }))
        .sort((a, b) => b.position - a.position);
      if (method === 'PATCH') {
        state.reorders.push(body.roles);
        for (const place of body.roles || []) {
          const role = state.guild.roles.find((r) => r.id === place.id);
          if (role) role.position = place.position;
        }
        return json({ roles: withCounts() });
      }
      if (method === 'POST') {
        const role = {
          id: `r${state.guild.roles.length}`, name: body.name, color: body.color || 0,
          position: 1, permissions: '0', permission_names: [],
          hoist: false, mentionable: false,
        };
        for (const r of state.guild.roles) if (r.id !== state.guild.id) r.position += 1;
        state.guild.roles.push(role);
        return json(role);
      }
      return json({ roles: withCounts() });
    }
    if (/\/roles\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      const role = state.guild.roles.find((r) => r.id === id);
      if (!role) return json({ error: 'not_found', message: 'no such role' }, 404);
      if (method === 'DELETE') {
        state.guild.roles = state.guild.roles.filter((r) => r.id !== id);
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        state.rolePatches.push({ id, ...body });
        if (body.name !== undefined) role.name = body.name;
        if (body.color !== undefined) role.color = body.color;
        if (body.hoist !== undefined) role.hoist = body.hoist;
        if (body.mentionable !== undefined) role.mentionable = body.mentionable;
        if (body.permissions !== undefined) role.permission_names = body.permissions;
      }
      return json(role);
    }
    if (path.endsWith('/expressions')) {
      state.expressionRequests.push({ origin, guild_id: path.split('/')[4] });
      return json({ emojis: state.emojis, stickers: state.stickers });
    }
    if (/\/guilds\/[^/]+\/stickers$/.test(path) && method === 'POST') {
      const sticker = {
        kind: 'sticker', id: `st${state.stickers.length + 1}`, guild_id: 'g1',
        name: body.name, reference: `media://guilds.example/${body.name}`,
        url: `${origin}/_telium/v1/media/${body.name}`, animated: false,
      };
      state.stickers.push(sticker);
      return json(sticker);
    }
    if (path === '/_telium/v1/embed') {
      const target = query?.get('url') || '';
      state.embedRequests.push(target);
      return json({
        url: target,
        url_hash: 'embedhash',
        status: 'ok',
        kind: 'link',
        title: 'Example Domain',
        description: 'Reserved for documentation.',
        site: new URL(target).host,
        image: `${origin}/_telium/v1/camo/camohash`,
      });
    }
    if (/\/guilds\/[^/]+$/.test(path)) {
      if (method === 'PATCH') Object.assign(state.guild, body);
      if (method === 'DELETE') {
        state.deleted.push(path.split('/').pop());
        return json({ ok: true });
      }
      return json({ ...state.guild });
    }
    if (/\/channels\/[^/]+\/threads$/.test(path)) {
      const parent = path.split('/')[4];
      const list = state.threads.get(parent) || [];
      if (method === 'POST') {
        const now = Date.now() + (state.threadSeq += 1);
        const id = `t${state.threadSeq}`;
        const opening = {
          id: `m${id}`,
          channel_id: id,
          guild_id: state.guild.id,
          author: state.userId,
          content: body.content || '',
          attachments: body.attachments || [],
          created_at: now,
        };
        const post = {
          id,
          parent_id: parent,
          guild_id: state.guild.id,
          owner: state.userId,
          title: body.title,
          tags: body.tags || [],
          archived: false,
          locked: false,
          pinned: false,
          message_count: 1,
          last_active: now,
          created_at: now,
          opening,
        };
        state.messages.push(opening);
        state.threads.set(parent, [post, ...list]);
        return json(post);
      }
      const archived = query?.get('archived') === 'true';
      const sort = query?.get('sort') || 'activity';
      const ordered = list
        .filter((t) => Boolean(t.archived) === archived)
        .sort((a, b) => (Number(b.pinned) - Number(a.pinned))
          || (sort === 'creation'
            ? b.created_at - a.created_at
            : b.last_active - a.last_active));
      return json({ threads: ordered });
    }
    if (/\/_telium\/v1\/threads\/[^/]+$/.test(path)) {
      const id = path.split('/').pop();
      for (const [parent, list] of state.threads) {
        const at = list.findIndex((t) => t.id === id);
        if (at < 0) continue;
        if (method === 'DELETE') {
          state.threads.set(parent, list.filter((t) => t.id !== id));
          return json({ ok: true });
        }
        Object.assign(list[at], body);
        return json({ ...list[at] });
      }
      return json({ error: 'not_found', message: 'no such thread' }, 404);
    }
    if (/\/members$/.test(path)) {
      const role = query?.get('role');
      const q = (query?.get('q') || '').toLowerCase();
      const rows = state.members.filter((m) => {
        if (role && role !== state.guild.id && !(m.roles || []).includes(role)) return false;
        if (q && !`${m.nickname || m.display_name || m.user_id}`.toLowerCase().includes(q)) {
          return false;
        }
        return true;
      });
      return json({ members: rows, member_count: state.members.length, total: rows.length });
    }
    if (/\/members\/[^/]+$/.test(path) && method === 'GET') {
      const userId = decodeURIComponent(path.split('/').pop());
      return json({ member: state.members.some((m) => m.user_id === userId && !m.banned) });
    }
    if (/\/members\/[^/]+$/.test(path) && method === 'PATCH') {
      const userId = decodeURIComponent(path.split('/').pop());
      const member = state.members.find((m) => m.user_id === userId);
      if (!member) return json({ error: 'not_found', message: 'no such member' }, 404);
      const held = new Set(member.roles || []);
      for (const id of body.add_roles || []) held.add(id);
      for (const id of body.remove_roles || []) held.delete(id);
      member.roles = [...held];
      if (body.nickname !== undefined) member.nickname = body.nickname;
      return json(member);
    }
    if (/\/channels\/[^/]+\/pins$/.test(path) && method === 'GET') {
      const channelId = path.split('/')[4];
      const pinned = state.pins
        .filter((p) => p.channel_id === channelId)
        .map((p) => state.messages.find((m) => m.id === p.message_id))
        .filter(Boolean);
      return json({ pins: pinned });
    }
    if (/\/channels\/[^/]+\/messages$/.test(path)) {
      const channelId = path.split('/')[4];
      if (method === 'POST') {
        const msg = {
          id: `m${state.messages.length + 1}`,
          channel_id: channelId,
          guild_id: state.guild.id,
          author: state.userId,
          content: body.content,
          created_at: Date.now(),
          sticker: body.sticker || null,
          attachments: body.attachments || [],
        };
        state.messages.push(msg);
        state.sent.push(msg);
        return json(msg);
      }
      const all = state.messages
        .filter((m) => m.channel_id === channelId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const limit = Number(query?.get('limit')) || 50;
      const before = query?.get('before');
      const window = before ? all.filter((m) => m.id < before) : all;
      if (!window.length && before) {
        const cold = state.archived
          .filter((m) => m.channel_id === channelId && m.id < before)
          .sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cold.length) return json({ messages: cold.slice(-limit), archived: true });
      }
      return json({ messages: window.slice(-limit) });
    }
    if (/\/channels\/[^/]+\/overwrites\//.test(path) && method === 'PUT') {
      const parts = path.split('/');
      const channel = state.guild.channels.find((c) => c.id === parts[4]);
      if (!channel) return json({ error: 'not_found' }, 404);
      const row = { target_type: parts[6], target_id: parts[7], allow: body.allow, deny: body.deny };
      const rest = (channel.permission_overwrites || [])
        .filter((o) => !(o.target_type === row.target_type && o.target_id === row.target_id));
      channel.permission_overwrites = [...rest, row];
      return json({ ...channel });
    }
    if (/\/channels\/[^/]+$/.test(path) && method === 'PATCH') {
      const channel = state.guild.channels.find((c) => c.id === path.split('/').pop());
      state.channelPatches.push(body);
      if (channel) Object.assign(channel, body);
      return json({ ...channel });
    }
    if (/\/messages\/[^/]+\/reactions\//.test(path)) {
      state.reactions.push({ message_id: path.split('/')[4], emoji: decodeURIComponent(path.split('/')[6]), method });
      return json({ ok: true });
    }
    if (/\/guilds\/[^/]+\/invites$/.test(path) && method === 'POST') {
      state.inviteCreates.push({ ...body });
      const expiresAt = body.expires_in_secs ? Date.now() + body.expires_in_secs * 1000 : null;
      return json({
        code: 'INVITE1',
        uses: 0,
        max_uses: body.max_uses ?? null,
        expires_at: expiresAt,
      });
    }
    if (/\/channels\/[^/]+\/voice$/.test(path)) {
      return json({
        channel_id: path.split('/')[4], voice_states: state.voiceStates, watchers: [],
      });
    }
    if (/\/channels\/[^/]+\/voice\//.test(path)) {
      const channelId = path.split('/')[4];
      const what = path.split('/').pop();
      if (what === 'signal') {
        state.signals.push({ channel_id: channelId, ...body });
        return json({ ok: true });
      }
      if (what === 'leave') {
        state.voiceStates = state.voiceStates.filter((v) => v.user_id !== state.userId);
        return json({ ok: true });
      }
      let mine = state.voiceStates.find((v) => v.user_id === state.userId);
      if (!mine) {
        mine = { user_id: state.userId, channel_id: channelId, session_id: 'vs1' };
        state.voiceStates.push(mine);
      }
      if (what === 'stream') {
        state.streams.push({ ...body });
        if (body.enabled && state.streamDenied) {
          return json({ error: 'forbidden', message: 'missing permission STREAM' }, 403);
        }
        mine.streaming = Boolean(body.enabled);
        mine.stream_preset = body.enabled ? (body.preset ?? null) : null;
        return json({ voice_state: mine });
      }
      Object.assign(mine, body);
      if (what !== 'join') return json({ voice_state: mine });
      return json({
        voice_state: mine,
        voice_server: {
          mode: 'mesh',
          channel_id: channelId,
          max_participants: 4,
          ice_servers: state.iceServers,
        },
      });
    }
    if (path.endsWith('/ack')) return json({ ok: true });
    if (path === '/_telium/v1/devices') return json({ devices: state.devices });
    if (path === '/_telium/v1/crosssigning') {
      if (method === 'PUT') {
        state.crossSigning = { exists: true, ...body, created_at: Date.now() };
        return json({ ok: true });
      }
      return json({
        ...state.crossSigning,
        devices: state.devices.map((d) => ({
          device_id: d.device_id, mls_key: d.mls_key || null, cross_sig: d.cross_sig || null,
        })),
        signatures: state.userSignatures,
      });
    }
    if (path.startsWith('/_telium/v1/crosssigning/devices/')) {
      const id = decodeURIComponent(path.split('/').pop());
      const device = state.devices.find((d) => d.device_id === id);
      if (device) Object.assign(device, { mls_key: body.mls_key, cross_sig: body.signature });
      return json({ ok: true });
    }
    if (path.startsWith('/_telium/v1/crosssigning/users/')) {
      const subject = decodeURIComponent(path.split('/').pop());
      state.userSignatures = state.userSignatures.filter((r) => r.subject !== subject);
      if (method === 'PUT') state.userSignatures.push({ subject, ...body, signed_at: Date.now() });
      return json({ ok: true });
    }
    if (/\/users\/[^/]+\/devices$/.test(path)) {
      return json({
        user_id: decodeURIComponent(path.split('/')[4]),
        identity_key: state.crossSigning.identity_key || null,
        devices: state.devices,
        origin: new URL(origin).host,
      });
    }
    if (path === '/_telium/v1/verify') {
      state.verifications.push(body);
      return json({ ok: true });
    }
    return json({ error: 'not_found', message: `no route for ${method} ${path}` }, 404);
  };

  const wait = (ms) => (ms ? new Promise((resolve) => { setTimeout(resolve, ms); }) : null);

  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (state.blackhole.has(origin)) return new Promise(() => {});
    await wait(state.latency);
    if (parsed.pathname.endsWith('/expressions')) await wait(state.expressionLatency);
    if (!state.reachable.has(origin)) {
      throw new TypeError(`Failed to fetch: ${origin} is unreachable`);
    }
    const auth = init.headers?.Authorization || init.headers?.authorization || '';
    if (state.expired.has(auth.replace(/^Bearer /, ''))) {
      return json({ error: 'unauthorized', message: 'guild session expired' }, 401);
    }
    let body;
    if (init.body !== undefined && init.body !== null) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    return routes(origin, parsed.pathname, init.method || 'GET', body, parsed.searchParams, auth, init.headers || {});
  };

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeSocket.CONNECTING;
      this.frames = [];
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.onopen = null;
      state.sockets.push(this);
      const origin = new URL(url.replace(/^ws/, 'http')).origin;
      if (state.blackhole.has(origin)) return;
      const greet = () => {
        if (!state.reachable.has(origin)) {
          this.readyState = FakeSocket.CLOSED;
          this.onclose?.({ code: 1006, reason: 'unreachable' });
          return;
        }
        this.readyState = FakeSocket.OPEN;
        this.onopen?.({});
        this.deliver({ op: 'HELLO', d: { heartbeat_interval: 45_000 } });
      };
      if (state.latency) setTimeout(greet, state.latency);
      else queueMicrotask(greet);
    }

    deliver(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }

    send(raw) {
      const frame = JSON.parse(raw);
      this.frames.push(frame);
      if (frame.op === 'IDENTIFY') {
        const host = new URL(this.url.replace(/^ws/, 'http')).host;
        if (state.expired.has(frame.d?.token)) {
          this.readyState = FakeSocket.CLOSED;
          this.onclose?.({ code: 4001, reason: 'guild session expired' });
          return;
        }
        const ready = () => this.deliver({
          op: 'READY',
          d: {
            user: { user_id: state.userId },
            guilds: host === new URL(GUILD).host ? [state.guild] : [],
            voice_reclaimed: state.reclaimsVoice === false
              ? []
              : (frame.d?.voice || []).map((claim) => claim.room_id),
          },
        });
        if (state.latency) setTimeout(ready, state.latency);
        else ready();
      }
      if (frame.op === 'HEARTBEAT') this.deliver({ op: 'HEARTBEAT_ACK' });
    }

    close() {
      this.readyState = FakeSocket.CLOSED;
      this.onclose?.({ code: 1000, reason: 'closed by client' });
    }
  }

  class FakeUploadRequest {
    constructor() {
      this.headers = {};
      this.upload = {};
      this.status = 0;
      this.responseText = '';
    }

    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) {
      if (body?.size && this.upload.onprogress) {
        browserEvent(() => this.upload.onprogress({ lengthComputable: true, loaded: 0, total: body.size }));
      }
      fetchImpl(this.url, { method: this.method, headers: this.headers, body })
        .then(async (response) => {
          this.status = response.status;
          this.responseText = JSON.stringify(await response.json());
          if (body?.size && this.upload.onprogress) {
            browserEvent(() => this.upload.onprogress({ lengthComputable: true, loaded: body.size, total: body.size }));
          }
          browserEvent(() => this.onload?.());
        })
        .catch(() => browserEvent(() => this.onerror?.()));
    }
  }

  const install = () => {
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    vi.stubGlobal('XMLHttpRequest', FakeUploadRequest);
    vi.stubGlobal('WebSocket', FakeSocket);
  };

  return {
    state,
    install,
    dispatch(origin, t, d) {
      const host = new URL(origin).host;
      for (const socket of state.sockets) {
        if (socket.readyState !== FakeSocket.OPEN) continue;
        if (new URL(socket.url.replace(/^ws/, 'http')).host !== host) continue;
        socket.deliver({ op: 'DISPATCH', t, d, s: 1 });
      }
    },
    framesFor(origin) {
      const host = new URL(origin).host;
      return state.sockets
        .filter((s) => new URL(s.url.replace(/^ws/, 'http')).host === host)
        .flatMap((s) => s.frames);
    },
  };
}
