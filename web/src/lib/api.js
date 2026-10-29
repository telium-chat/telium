// REST client for the home server (holds the account) and guild servers (each mints its own session).

import { dialable } from './callmode.js';
import { withRetry } from './retry.js';
import { withFrameId } from './frame-id.js';
import { teliumFetch } from './net/transport.js';

/// Unwraps the join and `.../voice/server` envelopes so callers never dial an envelope.
function joined(body) {
  if (!body || typeof body !== 'object') return body;
  return { ...body, voice_server: dialable(body.voice_server) };
}

export class HttpError extends Error {
  constructor(status, body) {
    super(body?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

export async function request(base, method, path, { token, body, query } = {}) {
  let url = `${base}${path}`;
  if (query) {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null));
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Always through the transport, never `fetch`: this carries every REST call, and the network-privacy setting applies to it (see `lib/net/transport.js`).
  const resp = await teliumFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { purpose: 'API request' });
  let payload = null;
  try { payload = await resp.json(); } catch { payload = null; }
  if (!resp.ok) throw new HttpError(resp.status, payload);
  return payload;
}

export async function discover(domain) {
  const bases = domain.startsWith('http')
    ? [domain]
    : [`https://${domain}`, `http://${domain}`];
  let lastError = null;
  for (const base of bases) {
    try {
      const doc = await request(base, 'GET', '/.well-known/telium/server');
      return {
        server_name: doc.server_name,
        api: doc.api || base,
        gateway: doc.gateway || `${(doc.api || base).replace(/^http/, 'ws')}/gateway/v1`,
        moved_to: doc.moved_to || null,
        sunset: doc.sunset || null,
        /// This server's own web client, where an account move is received; http(s) only.
        client: typeof doc.client === 'string' && /^https?:\/\//i.test(doc.client) ? doc.client : null,
        /// Where to look if this server stops answering; read while it still answers.
        fallback: doc.fallback || null,
        /// Set when this server has been superseded by its standby; read before anything else in the document.
        authority: doc.authority || null,
        /// Read strictly: anything but an explicit yes means "make the account here".
        suggest_alternatives: doc.onboarding?.recommendations?.suggest_alternatives === true,
        /// Verbatim and filtered to strings; unknown tokens are kept, absent means absent.
        capabilities: Array.isArray(doc.protocol?.capabilities)
          ? doc.protocol.capabilities.filter((c) => typeof c === 'string')
          : [],
        /// `null` unless `enabled: true` with a `wss://` endpoint (an `http://` tunnel would expose the connection).
        relay: doc.relay && doc.relay.enabled === true
          && typeof doc.relay.url === 'string' && /^wss:\/\//i.test(doc.relay.url)
          ? {
            enabled: true,
            url: doc.relay.url,
            maxTunnelBytes: Number(doc.relay.max_tunnel_bytes) || 0,
            maxConcurrent: Number(doc.relay.max_concurrent) || 0,
            dailyBytes: Number(doc.relay.daily_bytes) || 0,
            logsDestinations: doc.relay.logs_destinations === true,
          }
          : null,
      };
    } catch (e) { lastError = e; }
  }
  // A status means the server answered; otherwise name the address that failed.
  if (lastError && typeof lastError.status === 'number') throw lastError;
  const unreachable = new Error(`could not reach ${domain}`);
  unreachable.sentence = `Could not reach ${domain}. Check the address; if it is right, that server is down.`;
  throw unreachable;
}

export class Api {
  /// `renew` mints a new guild session and the refused request retries once; the home connection has none (refused token is a sign-out).
  constructor({ base, token, domain, gateway, renew = null }) {
    this.base = base;
    this.token = token;
    this.domain = domain;
    this.gateway = gateway;
    this.renew = renew;
  }

  async req(method, path, opts = {}) {
    // Inner: 401 session retry, safe because the server did nothing. Outer: network retry, decided per route by `retry.js`.
    return withRetry(method, path, async () => {
      try {
        return await request(this.base, method, path, { token: this.token, ...opts });
      } catch (e) {
        if (e.status !== 401 || !this.renew) throw e;
        const token = await this.renew().catch(() => null);
        if (!token || token === this.token) throw e;
        this.token = token;
        return request(this.base, method, path, { token, ...opts });
      }
    }, { body: opts.body });
  }

  get(path, query) { return this.req('GET', path, { query }); }
  post(path, body) { return this.req('POST', path, { body }); }
  put(path, body) { return this.req('PUT', path, { body }); }
  patch(path, body) { return this.req('PATCH', path, { body }); }
  del(path, body) { return this.req('DELETE', path, { body }); }

  static register(base, localpart, password, deviceName) {
    return request(base, 'POST', '/_telium/v1/register', {
      body: { localpart, password, device_name: deviceName },
    });
  }
  static login(base, user, password, deviceName, mfaCode = null) {
    return request(base, 'POST', '/_telium/v1/login', {
      body: { user, password, device_name: deviceName, mfa_code: mfaCode },
    });
  }
  static reactivate(base, user, password, deviceName, mfaCode = null) {
    return request(base, 'POST', '/_telium/v1/account/reactivate', {
      body: { user, password, device_name: deviceName, mfa_code: mfaCode },
    });
  }
  whoami() { return this.get('/_telium/v1/whoami'); }
  logoutAll() { return this.post('/_telium/v1/logout-all', {}); }
  accountExport() { return this.get('/_telium/v1/account/export'); }
  /// The signed account bundle a shutting-down server hands out (docs/sunset.md). `proof` is `{ password }` or `{ reauth_token }`.
  accountBundle(proof) { return this.post('/_telium/v1/account/bundle', proof); }
  deactivateAccount(proof) {
    return this.post('/_telium/v1/account/deactivate',
      typeof proof === 'string' ? { password: proof } : proof);
  }
  deleteAccount(proof) {
    return this.del('/_telium/v1/account',
      typeof proof === 'string' ? { password: proof } : proof);
  }
  mfaStatus() { return this.get('/_telium/v1/mfa'); }
  mfaSetup(proof) {
    return this.post('/_telium/v1/mfa/setup',
      typeof proof === 'string' ? { password: proof } : proof);
  }
  mfaEnable(code) { return this.post('/_telium/v1/mfa/enable', { code }); }
  mfaDisable(proof, code) {
    const auth = typeof proof === 'string' ? { password: proof } : proof;
    return this.post('/_telium/v1/mfa/disable', { ...auth, code });
  }

  /// Unauthenticated: a client needs this before it has a session.
  capabilities() { return this.get('/_telium/v1/capabilities'); }
  assertion(audience) { return this.post('/_telium/v1/assertions', { audience }); }
  devices() { return this.get('/_telium/v1/devices'); }
  revokeDevice(id, revocation = null) { return this.del(`/_telium/v1/devices/${id}`, revocation || undefined); }

  crossSigning() { return this.get('/_telium/v1/crosssigning'); }
  putCrossSigning(body) { return this.put('/_telium/v1/crosssigning', body); }

  // The homeserver only transports these; identity-continuity.js verifies them.
  identityContinuity() { return this.get('/_telium/v1/identity'); }
  anchorIdentity(body) { return this.put('/_telium/v1/identity/anchor', body); }
  setIdentityRecoveryPolicy(body) {
    return this.put('/_telium/v1/identity/recovery-policy', body);
  }
  rotateIdentity(body) { return this.post('/_telium/v1/identity/rotate', body); }
  identityDocument(userId) {
    return request(
      this.base,
      'GET',
      `/_telium/v1/users/${encodeURIComponent(userId)}/identity`,
    );
  }
  signDevice(deviceId, body) {
    return this.put(`/_telium/v1/crosssigning/devices/${encodeURIComponent(deviceId)}`, body);
  }
  signUser(userId, body) {
    return this.put(`/_telium/v1/crosssigning/users/${encodeURIComponent(userId)}`, body);
  }
  unsignUser(userId) {
    return this.del(`/_telium/v1/crosssigning/users/${encodeURIComponent(userId)}`);
  }
  /// Anyone's device list, signed by their home server. Unauthenticated.
  deviceList(userId) {
    return request(this.base, 'GET', `/_telium/v1/users/${encodeURIComponent(userId)}/devices`);
  }
  sendVerification(body) { return this.post('/_telium/v1/verify', body); }
  patchProfile(body) { return this.patch('/_telium/v1/profile', body); }
  /// Anyone's profile, asked of our own server so strangers don't fan out requests to every homeserver.
  userProfile(userId) {
    return this.get(`/_telium/v1/users/${encodeURIComponent(userId)}/profile`);
  }
  publicProfilePage(userId) {
    return this.get(`/_telium/v1/users/${encodeURIComponent(userId)}/public-page`);
  }
  userStatus(userId) {
    return this.get(`/_telium/v1/users/${encodeURIComponent(userId)}/status`);
  }
  mediaPreference() { return this.get('/_telium/v1/media/preference'); }
  setMediaPreference(body) { return this.put('/_telium/v1/media/preference', body); }
  mediaRegistry() { return this.get('/_telium/v1/media/registry'); }
  /// Tier-2 origins the curators this account's guilds follow vouch for. Authenticated: guild membership is not public.
  mediaRegistryFeeds() { return this.get('/_telium/v1/media/registry/feeds'); }
  hostingProviders() { return this.get('/_telium/v1/hosting/providers'); }
  /// `sealed` says this client opens sealed values; without it the server leaves them out.
  sync() { return this.get('/_telium/v1/sync', { sealed: 1 }); }
  syncGet(key) { return this.get(`/_telium/v1/sync/${key}`, { sealed: 1 }); }
  syncPut(key, value) { return this.put(`/_telium/v1/sync/${key}`, value); }
  syncDelete(key) { return this.del(`/_telium/v1/sync/${key}`); }

  guilds() { return this.get('/_telium/v1/guilds'); }
  guild(id) { return this.get(`/_telium/v1/guilds/${id}`); }
  createGuild(name) { return this.post('/_telium/v1/guilds', { name }); }
  patchGuild(id, body) { return this.patch(`/_telium/v1/guilds/${id}`, body); }
  setGuildAlias(id, alias) { return this.put(`/_telium/v1/guilds/${id}/alias`, { alias }); }
  clearGuildAlias(id) { return this.del(`/_telium/v1/guilds/${id}/alias`); }
  resolveGuildAddress(address) {
    return request(this.base, 'GET', '/_telium/v1/guild-addresses/resolve', { query: { address } });
  }
  guildJoinPreview(id) { return request(this.base, 'GET', `/_telium/v1/guilds/${id}/join-preview`); }
  joinGuild(id) { return this.post(`/_telium/v1/guilds/${id}/join`, {}); }
  channels(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/channels`); }
  createChannel(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/channels`, body); }
  /// One request for the whole arrangement, so concurrent admins can't interleave into an order neither chose.
  reorderChannels(guildId, channels) {
    return this.patch(`/_telium/v1/guilds/${guildId}/channels`, { channels });
  }
  patchChannel(id, body) { return this.patch(`/_telium/v1/channels/${id}`, body); }
  deleteChannel(id) { return this.del(`/_telium/v1/channels/${id}`); }
  setVoiceStatus(id, status) { return this.put(`/_telium/v1/channels/${id}/voice-status`, { status }); }
  roles(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/roles`); }
  createRole(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/roles`, body); }
  patchRole(guildId, id, body) { return this.patch(`/_telium/v1/guilds/${guildId}/roles/${id}`, body); }
  deleteRole(guildId, id) { return this.del(`/_telium/v1/guilds/${guildId}/roles/${id}`); }
  /// The whole hierarchy in one request, for the same reason as channels: positions drive permission checks.
  reorderRoles(guildId, roles) {
    return this.patch(`/_telium/v1/guilds/${guildId}/roles`, { roles });
  }
  members(guildId, query) { return this.get(`/_telium/v1/guilds/${guildId}/members`, query); }
  memberStatus(guildId, userId) {
    return this.get(`/_telium/v1/guilds/${guildId}/members/${encodeURIComponent(userId)}`);
  }
  patchMember(guildId, userId, body) { return this.patch(`/_telium/v1/guilds/${guildId}/members/${userId}`, body); }
  kick(guildId, userId) { return this.del(`/_telium/v1/guilds/${guildId}/members/${userId}`); }
  bans(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/bans`); }
  ban(guildId, userId, body) { return this.put(`/_telium/v1/guilds/${guildId}/bans/${userId}`, body || {}); }
  unban(guildId, userId) { return this.del(`/_telium/v1/guilds/${guildId}/bans/${userId}`); }
  leaveGuild(guildId) { return this.post(`/_telium/v1/guilds/${guildId}/leave`, {}); }
  deleteGuild(guildId) { return this.del(`/_telium/v1/guilds/${guildId}`); }
  transferOwnership(guildId, userId) {
    return this.post(`/_telium/v1/guilds/${guildId}/transfer-ownership`, { user_id: userId });
  }
  invites(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/invites`); }
  createInvite(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/invites`, body || {}); }
  revokeInvite(guildId, code) {
    return this.del(`/_telium/v1/guilds/${guildId}/invites/${encodeURIComponent(code)}`);
  }
  purgeMessages(guildId, body) {
    return this.post(`/_telium/v1/guilds/${guildId}/moderation/purge`, body);
  }
  invitePreview(code) { return request(this.base, 'GET', `/_telium/v1/invites/${code}`); }
  joinInvite(code) { return this.post(`/_telium/v1/invites/${code}/join`, {}); }
  auditLog(guildId, query) { return this.get(`/_telium/v1/guilds/${guildId}/audit-log`, query); }
  createEmoji(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/emojis`, body); }
  deleteEmoji(guildId, id) { return this.del(`/_telium/v1/guilds/${guildId}/emojis/${id}`); }
  createSticker(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/stickers`, body); }
  setOverwrite(channelId, targetType, targetId, allow, deny) {
    return this.put(
      `/_telium/v1/channels/${channelId}/overwrites/${targetType}/${targetId}`,
      { allow: String(allow), deny: String(deny) },
    );
  }
  expressions(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/expressions`); }

  history(channelId, query) { return this.get(`/_telium/v1/channels/${channelId}/messages`, query); }
  send(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/messages`, body); }
  editMessage(channelId, id, content) {
    return this.patch(`/_telium/v1/channels/${channelId}/messages/${id}`, { content });
  }
  deleteMessage(channelId, id) { return this.del(`/_telium/v1/channels/${channelId}/messages/${id}`); }
  typing(channelId) { return this.post(`/_telium/v1/channels/${channelId}/typing`, {}); }

  react(messageId, emoji) {
    return this.put(`/_telium/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {});
  }
  unreact(messageId, emoji) {
    return this.del(`/_telium/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }
  /// A guild signing off on an upload to an origin with no account for this user. Short-lived, single-object.
  mediaVoucher(body) { return this.post('/_telium/v1/media/vouchers', body); }
  /// Tier 3: the guild server fetches the link and re-hosts the image under its camo route.
  embed(url) { return this.get('/_telium/v1/embed', { url }); }
  pins(channelId) { return this.get(`/_telium/v1/channels/${channelId}/pins`); }
  pin(channelId, messageId) { return this.put(`/_telium/v1/channels/${channelId}/pins/${messageId}`, {}); }
  unpin(channelId, messageId) { return this.del(`/_telium/v1/channels/${channelId}/pins/${messageId}`); }
  threads(channelId, archived, sort) {
    return this.get(`/_telium/v1/channels/${channelId}/threads`, { archived, sort });
  }

  createThread(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/threads`, body); }
  patchThread(id, body) { return this.patch(`/_telium/v1/threads/${id}`, body); }
  deleteThread(id) { return this.del(`/_telium/v1/threads/${id}`); }
  follow(channelId, targetId) { return this.post(`/_telium/v1/channels/${channelId}/follow`, { target_id: targetId }); }
  unfollow(channelId, targetId) { return this.del(`/_telium/v1/channels/${channelId}/follow/${targetId}`); }
  ack(channelId, messageId) { return this.post(`/_telium/v1/channels/${channelId}/ack`, { message_id: messageId }); }
  readState(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/read-state`); }
  search(guildId, query) { return this.get(`/_telium/v1/guilds/${guildId}/search`, query); }
  segments(channelId) { return this.get(`/_telium/v1/channels/${channelId}/segments`); }

  automod(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/automod`); }
  createRule(guildId, body) { return this.post(`/_telium/v1/guilds/${guildId}/automod`, body); }
  /// A full replacement, not a merge: omitted fields are erased.
  patchRule(guildId, id, body) { return this.patch(`/_telium/v1/guilds/${guildId}/automod/${id}`, body); }
  deleteRule(guildId, id) { return this.del(`/_telium/v1/guilds/${guildId}/automod/${id}`); }
  automodHits(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/automod-hits`); }
  gates(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/gates`); }
  setGates(guildId, body) { return this.put(`/_telium/v1/guilds/${guildId}/gates`, body); }
  refreshGateFeeds(guildId) { return this.post(`/_telium/v1/guilds/${guildId}/gates/refresh-feeds`, {}); }
  /// Every field came from another server: show it, never render it.
  gateCurators(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/gates/curators`); }
  held(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/held`); }
  decideHeld(guildId, id, decision) { return this.post(`/_telium/v1/guilds/${guildId}/held/${id}`, { decision }); }
  applicants(guildId) { return this.get(`/_telium/v1/guilds/${guildId}/applicants`); }
  decideApplicant(guildId, userId, decision) {
    return this.post(`/_telium/v1/guilds/${guildId}/applicants/${userId}`, { decision });
  }
  screening(guildId, answers) { return this.post(`/_telium/v1/guilds/${guildId}/screening`, { answers }); }
  report(body) { return this.post('/_telium/v1/reports', body); }

  conversations() { return this.get('/_telium/v1/conversations'); }
  createConversation(body) { return this.post('/_telium/v1/conversations', body); }
  conversation(id) { return this.get(`/_telium/v1/conversations/${id}`); }
  acceptMessageRequest(id) {
    return this.post(`/_telium/v1/conversations/${id}/request/accept`, {});
  }
  declineMessageRequest(id) {
    return this.post(`/_telium/v1/conversations/${id}/request/decline`, {});
  }
  // `tail` is the newest n frames; `after`/`limit` page forward from a floor.
  dmHistory(id, { after, limit, tail } = {}) {
    return this.get(`/_telium/v1/conversations/${id}/messages`, { after, limit, tail });
  }
  // Sent under an id derived from the ciphertext, so a repeat is safe (`frame-id.js`, `retry.js`).
  sendFrame(id, body) { return this.post(`/_telium/v1/conversations/${id}/messages`, withFrameId(body)); }
  dmNotificationKeys(id) {
    return this.get(`/_telium/v1/conversations/${id}/notification-keys`);
  }
  sendDmNotificationHints(id, body) {
    return this.post(`/_telium/v1/conversations/${id}/notification-hints`, body);
  }
  addConversationMember(id, userId) { return this.post(`/_telium/v1/conversations/${id}/members`, { user_id: userId }); }
  leaveConversation(id) { return this.post(`/_telium/v1/conversations/${id}/leave`, {}); }
  // Withdraws the sequencer's copy of a membership policy the group could not carry. Creator only, before the first commit.
  withdrawConversationPolicy(id) { return this.del(`/_telium/v1/conversations/${id}/policy`); }
  reanchor(id, sequencer) { return this.post(`/_telium/v1/conversations/${id}/reanchor`, { sequencer }); }
  promote(id, body) { return this.post(`/_telium/v1/conversations/${id}/promote`, body || {}); }
  keyPackages() { return this.get('/_telium/v1/keypackages'); }
  publishKeyPackages(packages, lastResort = null) {
    return this.post('/_telium/v1/keypackages', lastResort ? { packages, last_resort: lastResort } : { packages });
  }
  vault() { return this.get('/_telium/v1/vault'); }
  putVault(body) { return this.put('/_telium/v1/vault', body); }
  setVaultMode(body) { return this.post('/_telium/v1/vault/mode', body); }
  /// The recovery key restoring its copy of the vault: a challenge, then the copy and a signature over both.
  recoveryCopyStart() { return this.post('/_telium/v1/auth/recovery-key/vault-copy/start', {}); }
  recoveryCopyFinish(body) {
    return this.post('/_telium/v1/auth/recovery-key/vault-copy/finish', body);
  }

  // Sealed client-side under the recovery key.

  /// One page. `scope` absent means every conversation (used when re-sealing after a key rotation).
  backup({ scope, after, limit } = {}) {
    return this.get('/_telium/v1/vault/backup', { scope, after, limit });
  }

  putBackup(items) { return this.put('/_telium/v1/vault/backup', { items }); }

  /// Scope absent means the whole account's mirror.
  dropBackup(scope) {
    return this.del('/_telium/v1/vault/backup', { scope: scope || null });
  }

  /// Custody without the blob, so the DM view can disclose it even if the vault didn't load.
  async vaultMode() {
    const v = await this.vault();
    return {
      exists: Boolean(v.exists),
      mode: v.mode || 'none',
      server_can_recover: Boolean(v.server_can_recover),
      // A recovery key with no vault copy beside it resets the password and opens nothing.
      recovery_copy_missing: v.mode === 'opaque_custody'
        && Boolean(v.recovery_key_enrolled) && !v.independent_ciphertext,
      // Backup extent and server readability, reported with custody as one disclosure.
      backup: {
        items: Number(v.backup?.items || 0),
        updated_at: v.backup?.updated_at || null,
        server_can_read: Boolean(v.backup?.server_can_read),
      },
    };
  }

  claimKeyPackages(userId) {
    return this.post(`/_telium/v1/users/${encodeURIComponent(userId)}/keypackages/claim`, {});
  }

  // --- friends ------------------------------------------------------------
  // Home server only; the list belongs to the account and peers are that server's job.
  friends() { return this.get('/_telium/v1/friends'); }
  mutualFriends(userId) {
    return this.get(`/_telium/v1/friends/mutual/${encodeURIComponent(userId)}`);
  }
  addFriend(userId) { return this.post('/_telium/v1/friends', { user_id: userId }); }
  acceptFriend(userId) { return this.post(`/_telium/v1/friends/${encodeURIComponent(userId)}/accept`, {}); }
  /// Decline, cancel and unfriend are one call; the server reads which from the row.
  removeFriend(userId) { return this.del(`/_telium/v1/friends/${encodeURIComponent(userId)}`); }
  blockUser(userId) { return this.put(`/_telium/v1/friends/${encodeURIComponent(userId)}/block`, {}); }
  unblockUser(userId) { return this.del(`/_telium/v1/friends/${encodeURIComponent(userId)}/block`); }

  regions() { return this.get('/_telium/v1/voice/regions'); }
  voiceStates(channelId) { return this.get(`/_telium/v1/channels/${channelId}/voice`); }
  voiceJoin(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/join`, body || {}).then(joined); }
  voiceLeave(channelId) { return this.post(`/_telium/v1/channels/${channelId}/voice/leave`, {}); }
  /// A fresh join token for the session this device already holds, so a call
  /// never runs on an expired LiveKit grant (the resume that follows a network
  /// blip is refused once it has expired).
  voiceRefreshToken(channelId) { return this.post(`/_telium/v1/channels/${channelId}/voice/token`, {}); }
  voiceState(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/state`, body); }
  voiceStream(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/stream`, body); }
  voiceWatch(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/watch`, body); }
  voiceModerate(guildId, userId, body) { return this.post(`/_telium/v1/guilds/${guildId}/voice/${userId}`, body); }
  /// The server relays the payload to one other channel member without reading it.
  voiceSignal(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/signal`, body); }
  // A guild call's encryption group (lib/guild-call-keys.js): who is waiting to
  // be added, and the commit that adds them.
  voiceE2ee(channelId) { return this.get(`/_telium/v1/channels/${channelId}/voice/e2ee`); }
  voiceE2eeCommit(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/e2ee`, body); }
  /// The commits the call's group accepted above epoch `since`, oldest first.
  voiceE2eeCommits(channelId, since = 0) {
    return this.get(`/_telium/v1/channels/${channelId}/voice/e2ee/commits?since=${encodeURIComponent(since)}`);
  }
  /// The committer saying a waiting package will never be added.
  voiceE2eeRefuse(channelId, body) { return this.post(`/_telium/v1/channels/${channelId}/voice/e2ee/refuse`, body); }
  /// A member asking for the call's encryption group to be re-founded, for
  /// when this device can no longer follow it. The server refuses while the
  /// group is re-keying happily.
  voiceE2eeReset(channelId) { return this.post(`/_telium/v1/channels/${channelId}/voice/e2ee/reset`, {}); }

  /// Same names against a conversation, so `store.voiceApi` can hand either to the same code.
  conversationVoiceStates(id) { return this.get(`/_telium/v1/conversations/${id}/voice`); }
  conversationVoiceJoin(id, body) { return this.post(`/_telium/v1/conversations/${id}/voice/join`, body || {}).then(joined); }
  conversationVoiceLeave(id) { return this.post(`/_telium/v1/conversations/${id}/voice/leave`, {}); }
  /// The call's current `voice_server`, re-asked after the sequencer moved it (docs/calls.md). Returns the server itself, unwrapped.
  conversationVoiceServer(id) {
    return this.post(`/_telium/v1/conversations/${id}/voice/server`, {})
      .then((body) => dialable(body?.voice_server ?? body));
  }
  conversationVoiceState(id, body) { return this.post(`/_telium/v1/conversations/${id}/voice/state`, body); }
  conversationVoiceSignal(id, body) { return this.post(`/_telium/v1/conversations/${id}/voice/signal`, body); }

  // Per-guild custom SFU regions, on top of the server's global voice pool.
  guildVoiceRegions(guildId) { return this.get(`/_telium/v1/guilds/${encodeURIComponent(guildId)}/voice/regions`); }
  addGuildVoiceRegion(guildId, body) { return this.post(`/_telium/v1/guilds/${encodeURIComponent(guildId)}/voice/regions`, body); }
  setGuildVoiceRegionDefault(guildId, name) { return this.patch(`/_telium/v1/guilds/${encodeURIComponent(guildId)}/voice/regions/default`, { name }); }
  deleteGuildVoiceRegion(guildId, name) { return this.del(`/_telium/v1/guilds/${encodeURIComponent(guildId)}/voice/regions/${encodeURIComponent(name)}`); }

  adminStatus() { return this.get('/_telium/v1/admin/status'); }
  // Admin-only: an exact release lists the advisories that apply.
  adminVersion() { return this.get('/_telium/v1/admin/version'); }
  adminReports(query) { return this.get('/_telium/v1/admin/reports', query); }
  /// `note` is optional and sent only when non-empty.
  resolveAdminReport(id, status, note) {
    const body = { status };
    if (note && note.trim()) body.note = note.trim();
    return this.patch(`/_telium/v1/admin/reports/${id}`, body);
  }
  /// Is the queue being worked or merely accumulating: counts, the age of the
  /// oldest open item, and how long the closed ones took.
  adminModerationSummary() { return this.get('/_telium/v1/admin/moderation/summary'); }

  // --- the control plane --------------------------------------------------
  // Aggregates about the server only, never about a person (server/src/metrics.rs).

  adminMetrics() { return this.get('/_telium/v1/admin/metrics'); }
  /// `since`/`until` are epoch ms; `points` is the bucket count.
  adminMetricsSeries(query) { return this.get('/_telium/v1/admin/metrics/series', query); }
  adminStorage() { return this.get('/_telium/v1/admin/storage'); }
  adminStorageSweep() { return this.post('/_telium/v1/admin/storage/sweep', {}); }
  adminMediaConsumers() { return this.get('/_telium/v1/admin/storage/media-consumers'); }
  adminPeers() { return this.get('/_telium/v1/admin/peers'); }
  adminPeerStatus(origin) { return this.get(`/_telium/v1/admin/peers/${encodeURIComponent(origin)}`); }
  adminRevalidate() { return this.post('/_telium/v1/admin/revalidate', {}); }
  adminArchiveNow() { return this.post('/_telium/v1/admin/archive', {}); }
  defederation() { return this.get('/_telium/v1/admin/defederation'); }
  defederate(body) { return this.post('/_telium/v1/admin/defederation', body); }
  refederate(domain) { return this.del(`/_telium/v1/admin/defederation/${encodeURIComponent(domain)}`); }
  blocklistFeeds() { return this.get('/_telium/v1/admin/blocklist-feeds'); }
  addBlocklistFeed(body) { return this.post('/_telium/v1/admin/blocklist-feeds', body); }
  removeBlocklistFeed(body) { return this.del('/_telium/v1/admin/blocklist-feeds', body); }
  refreshBlocklistFeeds() { return this.post('/_telium/v1/admin/blocklist-feeds/refresh', {}); }
  /// Admin-only hosting catalog subscriptions, unlike `hostingProviders()`.
  adminHostingCatalogs() { return this.get('/_telium/v1/admin/hosting-catalogs'); }
  /// Each row has `error` (refused) or `skipped` (malformed, or inside the one-minute floor); both null if adopted.
  refreshHostingCatalogs() { return this.post('/_telium/v1/admin/hosting-catalogs/refresh', {}); }
  /// The new key is published beside the old, which keeps signing for `overlap_secs` (1 to 90 days); a second rotation is refused meanwhile. Needs step-up.
  rotateCuratorKey(overlapSecs = null) {
    return this.post(
      '/_telium/v1/admin/media/curator-key/rotate',
      overlapSecs == null ? {} : { overlap_secs: overlapSecs },
    );
  }

  // --- the operator's step-up ---------------------------------------------
  // Destructive routes want proof the person at the keyboard is the account, which
  // a bearer token can't give. A password buys a short elevation window, shared
  // across all destructive routes; these three routes move in and out of it.

  /// Am I elevated, and until when. Asked rather than inferred from the last destructive call.
  adminStepUpState() { return this.get('/_telium/v1/admin/step-up'); }
  /// `proof` is `store.reauthProof(password)`: `{ reauth_token }` for OPAQUE, `{ password }` otherwise.
  adminStepUp(proof) { return this.post('/_telium/v1/admin/step-up', proof); }
  /// End the elevation window now.
  adminEndStepUp() { return this.del('/_telium/v1/admin/step-up'); }

  /// Already interpreted, unlike `adminMetrics`.
  adminHealth() { return this.get('/_telium/v1/admin/health'); }

  /// `before` is a keyset cursor (oldest id shown), since an offset would skip or repeat rows.
  adminAudit(query) { return this.get('/_telium/v1/admin/audit', query); }

  // --- accounts and guilds, as the operator sees them ----------------------
  // Shape and status, never content.

  /// `status` is one of all, active, suspended, deleted, admins; `cursor` is the previous `next_cursor`.
  adminAccounts(query) { return this.get('/_telium/v1/admin/accounts', query); }
  adminAccount(userId) { return this.get(`/_telium/v1/admin/accounts/${encodeURIComponent(userId)}`); }
  /// `body` must carry a non-empty `reason`. Needs step-up; a 403 with `step_up_required` is the prompt.
  adminSuspendAccount(userId, body) {
    return this.post(`/_telium/v1/admin/accounts/${encodeURIComponent(userId)}/suspend`, body);
  }
  /// Only for an account an operator switched off; 409 if its owner deactivated it.
  adminReinstateAccount(userId) {
    return this.post(`/_telium/v1/admin/accounts/${encodeURIComponent(userId)}/reinstate`, {});
  }

  adminGuilds(query) { return this.get('/_telium/v1/admin/guilds', query); }
  adminGuild(guildId) { return this.get(`/_telium/v1/admin/guilds/${encodeURIComponent(guildId)}`); }
  /// Reclaims what a moved guild left behind; the `moved` tombstone stays. Needs step-up.
  adminPurgeGuild(guildId) {
    return this.post(`/_telium/v1/admin/guilds/${encodeURIComponent(guildId)}/purge`, {});
  }

  /// Who speaks for this domain, who stands by, and how far behind each is. Read-only.
  adminContinuity() { return this.get('/_telium/v1/admin/continuity'); }

  /// `mode`: 'shutdown', 'relocate' (with `new_domain`) or 'none' to withdraw. Needs step-up.
  adminSetSunset(body) { return this.post('/_telium/v1/admin/sunset', body); }

  /// Shutdown only; 409 after a relocation. Needs step-up.
  adminExecuteSunset() { return this.post('/_telium/v1/admin/sunset/execute', {}); }

  /// Tombstones every account and guild. `confirm` must be this server's name; no undo. Needs step-up.
  adminFinalizeSunset(body) { return this.post('/_telium/v1/admin/sunset/finalize', body); }

  /// Signs in advance that `standby` may answer for `subject_id`. Needs step-up.
  adminAuthorizeFailover(body) { return this.post('/_telium/v1/admin/failover', body); }

  /// The standby becomes authority and this server goes read-only. Needs step-up.
  adminPromoteFailover(subjectType, subjectId) {
    const type = encodeURIComponent(subjectType);
    const id = encodeURIComponent(subjectId);
    return this.post(`/_telium/v1/admin/failover/${type}/${id}/promote`, {});
  }

  /// This server answers for `origin` from its copy; anything not yet received is lost, irreversibly. Needs step-up.
  adminPromoteStandby(origin) {
    return this.post(`/_telium/v1/admin/standby/${encodeURIComponent(origin)}/promote`, {});
  }

  // Destination-side consent: returns the one-time import token the old server must present.
  acceptMigration(body) { return this.post('/_telium/v1/migrate/accept', body); }
  migrations() { return this.get('/_telium/v1/migrate'); }
  startMigration(body) { return this.post('/_telium/v1/migrate', body); }
  /// `subject` is `{ subject_type: 'guild', subject_id }` for a guild move; omitted, the signed-in account moves.
  openMigrationHandoff(destination, subject = null) {
    return this.post('/_telium/v1/migrate/handoff', { destination, ...(subject || {}) });
  }
  migrationHandoff(id) { return this.get(`/_telium/v1/migrate/handoff/${encodeURIComponent(id)}`); }
  cancelMigration(id) { return this.post(`/_telium/v1/migrate/${id}/cancel`, {}); }
  /// Moves still in their cooling-off window, shown by the banner on every device.
  migrationAlerts() { return this.get('/_telium/v1/migrate/alerts'); }
  /// Changing it takes `password` or `reauth_token`.
  recoveryEmail() { return this.get('/_telium/v1/account/recovery-email'); }
  setRecoveryEmail(body) { return this.put('/_telium/v1/account/recovery-email', body); }
  // The home's registry of memberships elsewhere, reported so a move can re-establish them (docs/migration.md).
  reportMemberships(guildServer, guildIds) {
    return this.post('/_telium/v1/memberships', { guild_server: guildServer, guild_ids: guildIds });
  }
  membershipMoves() { return this.get('/_telium/v1/migrate/memberships'); }
  retryMembershipMoves() { return this.post('/_telium/v1/migrate/memberships/retry', {}); }
  sunset() { return this.get('/_telium/v1/sunset'); }
  push(body) { return this.post('/_telium/v1/push', body); }
  pushSubscriptions() { return this.get('/_telium/v1/push'); }
  unpush(id) { return this.del(`/_telium/v1/push/${id}`); }
  /// Unauthenticated: the key a browser pins into a subscription.
  vapidKey() { return request(this.base, 'GET', '/_telium/v1/push/vapid'); }
}
