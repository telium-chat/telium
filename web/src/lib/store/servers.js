import { Api, discover, HttpError, request } from '../api.js';
import {
  FALLBACK_AFTER_MS, learnFallback, primaryStatus, PROBE_EVERY_MS, resolveStandby,
} from '../failover.js';
import { Status } from '../gateway.js';
import { activeSunset } from '../sunset.js';
import { DEFAULT_INTENTS, RENEW_BEFORE_MS } from './shared.js';
import { BIO_MAX_FALLBACK } from '../bio.js';
import { registerOrigin, teliumFetch } from '../net/transport.js';

function parseGuildAddress(raw) {
  const text = String(raw || '').trim();
  const rest = text.startsWith('#') ? text.slice(1) : text;
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const local = rest.slice(0, split).trim().toLowerCase();
  const host = rest.slice(split + 1).trim();
  if (!/^[a-z0-9._-]{1,32}$/.test(local) || !local.replace(/\./g, '')) return null;
  if (!host || /[\s/@?#\\]/.test(host)) return null;
  return { address: `#${local}:${host}`, host };
}

export const serverMethods = {
  isReadOnly() {
    return Boolean(this.fallback) && this.fallback.status?.read_only !== false;
  },

  /// Not on the first failure (tunnel reconnects, wakes, deploys); only a sustained absence.
  watchHome(e) {
    const domain = this.session?.home?.domain;
    if (!domain || e.domain !== domain) return;
    if (e.status === Status.Ready) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      return;
    }
    if (e.status !== Status.Degraded || this.fallback || this.fallbackTimer) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      this.enterFallback().catch((err) => console.warn('no standby available', err));
    }, FALLBACK_AFTER_MS);
  },

  async enterFallback() {
    const home = this.session?.home;
    if (!home || this.fallback) return null;
    const cached = home.fallback || await learnFallback(home.base);
    if (!cached) return null;

    const resolved = await resolveStandby(cached, home.domain);
    // A copy nobody is feeding is not a fallback; stay degraded. A promoted copy is current.
    if (resolved.status?.stale && resolved.status?.read_only !== false) {
      throw new Error(`${resolved.standby} holds a copy of ${home.domain} that has stopped updating`);
    }

    this.fallback = { ...resolved, since: Date.now() };
    this.pointAt(resolved.base, resolved.gateway);
    this.emit('fallback', this.fallback);
    this.probeTimer = setInterval(() => { this.checkPrimary().catch(() => {}); }, PROBE_EVERY_MS);
    return this.fallback;
  },

  async leaveFallback() {
    if (!this.fallback) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
    this.fallback = null;
    const home = this.session.home;
    const entry = this.session.servers?.[home.domain];
    this.pointAt(home.base, entry?.gateway || `${home.base.replace(/^http/, 'ws')}/gateway/v1`);
    this.emit('fallback', null);
    this.refreshConversations().catch(() => {});
    this.refreshFriends().catch(() => {});
  },

  /// The domain stays the primary's (an identity, not an address).
  pointAt(base, gateway) {
    const domain = this.session.home.domain;
    if (this.home) this.home.base = base;
    const api = this.apis.get(domain);
    if (api) { api.base = base; api.gateway = gateway; }
    const entry = this.session.servers?.[domain];
    if (entry?.token) {
      this.gw.add({
        domain,
        url: gateway,
        token: entry.token,
        intents: DEFAULT_INTENTS,
        presence: this.presenceFor(domain),
      });
    }
    this.emit('status', { domain, status: this.gw.statusOf(domain), detail: null });
  },

  /// Is the real server back and still in charge? A replaced server answers too; going home to it would write into nothing.
  async checkPrimary() {
    if (!this.fallback) return;
    const home = this.session.home;
    const { alive, authority } = await primaryStatus(home.base);
    if (alive && (!authority || authority === home.domain)) {
      await this.leaveFallback();
      return;
    }
    const status = await request(
      this.fallback.api, 'GET', `/_telium/v1/failover/status/${this.session.home.domain}`,
    ).catch(() => null);
    if (!status) return;
    this.fallback = { ...this.fallback, status };
    this.emit('fallback', this.fallback);
  },

  async loadMediaPreference() {
    const pref = await this.home.mediaPreference();
    this.mediaPreference = { tier: pref.tier || 1, origin: pref.origin || null };
    this.emit('media-preference', this.mediaPreference);
    return this.mediaPreference;
  },

  async loadMediaRegistry() {
    const registry = await this.home.mediaRegistry();
    this.externalMediaHosts = registry.external_hosts || [];
    this.gofilePlaybackProxy = registry.gofile_playback_proxy !== false;
    this.emit('media-registry', this.externalMediaHosts);
    return this.externalMediaHosts;
  },

  async setMediaPreference(tier, origin = null) {
    const saved = await this.home.setMediaPreference({ tier, origin });
    this.mediaPreference = { tier: saved.tier, origin: saved.origin || null };
    this.emit('media-preference', this.mediaPreference);
    return this.mediaPreference;
  },

  async loadCapabilities(domain) {
    const api = domain === this.session?.home?.domain ? this.home : this.apis.get(domain);
    if (!api) return null;
    const doc = await api.capabilities();
    this.caps.set(domain, doc);
    this.emit('capabilities', domain);
    return doc;
  },

  bioLimit() {
    const n = Number(this.caps.get(this.session?.home?.domain)?.profile?.bio_max_chars);
    return Number.isFinite(n) && n > 0 ? n : BIO_MAX_FALLBACK;
  },

  /// True unless the server says otherwise: a 404 on a rarely used button beats hiding half the client.
  supports(domain, feature) {
    const doc = this.caps.get(domain);
    if (!doc) return true;
    if (doc.features && feature in doc.features) return doc.features[feature];
    return !(doc.unimplemented || []).includes(feature);
  },

  supportsForGuild(guildId, feature) {
    return this.supports(this.guilds.get(guildId)?.domain, feature);
  },

  async addServer(domain, { base, silent = false } = {}) {
    const doc = base
      ? { server_name: domain, api: base, gateway: `${base.replace(/^http/, 'ws')}/gateway/v1` }
      : await discover(domain);
    if (doc.moved_to) {
      return this.addServer(doc.moved_to);
    }
    const name = doc.server_name || domain;
    const { assertion } = await this.home.assertion(name);
    // First request to a never-contacted server: goes through the transport after origins are registered.
    registerOrigin(name, [doc.api, doc.gateway]);
    const resp = await teliumFetch(`${doc.api}/_telium/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion }),
    }, { purpose: 'sign in to server' });
    const payload = await resp.json().catch(() => null);
    if (!resp.ok) throw new HttpError(resp.status, payload);

    const entry = {
      base: doc.api,
      gateway: payload.gateway || doc.gateway,
      token: payload.session_token,
      expires_at: payload.expires_at,
      // Revalidation is how a revoked account loses access to a guild server that never hears from home.
      revalidate_at: payload.revalidate_at || null,
      sunset: doc.sunset || null,
    };
    this.session.servers[name] = entry;
    this.save();
    this.connectServer(name, entry);
    this.loadCapabilities(name).catch(() => {});
    if (!silent) this.emit('servers');
    return name;
  },

  connectServer(domain, entry) {
    this.apis.set(domain, new Api({
      base: entry.base,
      token: entry.token,
      domain,
      gateway: entry.gateway,
      renew: () => this.renewServer(domain).then(() => this.session.servers[domain]?.token || null),
    }));
    this.gw.add({
      domain,
      url: entry.gateway,
      token: entry.token,
      intents: DEFAULT_INTENTS,
      presence: this.presenceFor(domain),
    });
  },

  removeServer(domain) {
    this.gw.remove(domain);
    this.apis.delete(domain);
    delete this.session.servers[domain];
    this.save();
    for (const [id, guild] of [...this.guilds]) if (guild.domain === domain) this.guilds.delete(id);
    this.emit('servers');
    this.emit('guilds');
  },

  /// Deduplicated per server: the refused socket and every in-flight request notice the stale token at once.
  renewServer(domain) {
    const running = this.renewals.get(domain);
    if (running) return running;
    const attempt = this.mintSession(domain).finally(() => {
      if (this.renewals.get(domain) === attempt) this.renewals.delete(domain);
    });
    this.renewals.set(domain, attempt);
    return attempt;
  },

  async mintSession(domain) {
    const entry = this.session.servers[domain];
    if (!entry) return;
    const { assertion } = await this.home.assertion(domain);
    const resp = await teliumFetch(`${entry.base}/_telium/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assertion }),
    }, { purpose: 'renew server session' });
    if (!resp.ok) throw new HttpError(resp.status, await resp.json().catch(() => null));
    const payload = await resp.json();
    entry.token = payload.session_token;
    entry.expires_at = payload.expires_at;
    entry.revalidate_at = payload.revalidate_at || null;
    this.renewedAt.set(domain, Date.now());
    this.save();
    this.connectServer(domain, entry);
  },

  /// Assertions live minutes and sessions an hour; renew quietly. Home is not here: its token is the login.
  freshenSessions() {
    if (!this.home) return;
    const soon = Date.now() + RENEW_BEFORE_MS;
    for (const [domain, entry] of Object.entries(this.session.servers)) {
      if (entry.expires_at && entry.expires_at > soon) continue;
      this.renewServer(domain).catch(() => {
        // An unreachable home leaves the old token; the banner offers manual retry.
      });
    }
  },

  async previewGuildJoin(raw) {
    const address = parseGuildAddress(raw);
    if (!address) {
      const invite = await this.previewInvite(raw);
      return invite ? { ...invite, kind: 'invite' } : null;
    }

    // Public invite onboarding arrives before any account session; preview must stay a public read.
    const known = this.session?.servers?.[address.host];
    let first = known
      ? { server_name: address.host, api: known.base }
      : await discover(address.host);
    if (first.moved_to) first = await discover(first.moved_to);
    const firstDomain = first.server_name || address.host;
    const resolver = new Api({ base: first.api, domain: firstDomain });
    let resolved;
    try {
      resolved = await resolver.resolveGuildAddress(address.address);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }

    const domain = resolved.origin;
    let base = this.session?.servers?.[domain]?.base;
    if (!base && domain === firstDomain) base = first.api;
    if (!base) {
      let final = await discover(domain);
      if (final.moved_to) final = await discover(final.moved_to);
      base = final.api;
    }

    let preview;
    try {
      preview = await new Api({ base, domain }).guildJoinPreview(resolved.guild_id);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
    return {
      ...preview,
      kind: 'address',
      base,
      domain,
      resolved,
      address: preview.address || address.address,
    };
  },

  async previewInvite(raw) {
    const text = String(raw).trim();
    let code = (text.split('/').pop() || '').trim();
    if (!code) return null;
    // A portal link names its server after the code (`.../invite/CODE@server`); the portal
    // host itself carries nothing and is never asked.
    let host = null;
    const at = code.lastIndexOf('@');
    if (at > 0) {
      host = code.slice(at + 1).toLowerCase();
      if (!host) return null;
      code = code.slice(0, at);
    } else {
      try { host = new URL(text).host; } catch { host = null; }
    }

    let candidates;
    if (host) {
      const known = this.session.servers[host];
      const doc = known ? { server_name: host, api: known.base } : await discover(host);
      candidates = [{ domain: doc.server_name || host, base: doc.api }];
    } else {
      candidates = Object.entries(this.session.servers)
        .map(([domain, entry]) => ({ domain, base: entry.base }));
    }

    for (const { domain, base } of candidates) {
      try {
        const preview = await new Api({ base, domain }).invitePreview(code);
        // `guild.host` is the host's own name, whose certificate the connection carries.
        return { ...preview, code, base, domain: preview.guild?.host || domain };
      } catch (e) {
        if (e.status === 404) continue;
        throw e;
      }
    }
    return null;
  },

  apiFor(domain) { return this.apis.get(domain); },

  apiForGuild(guildId) {
    const guild = this.guilds.get(guildId);
    return guild ? this.apis.get(guild.domain) : null;
  },

  apiForChannel(channelId) {
    const ch = this.channels.get(channelId);
    return ch ? this.apis.get(ch.domain) : null;
  },

  voiceApi(roomId) {
    const channel = this.channels.get(roomId);
    if (channel) return this.apis.get(channel.domain);
    // A conversation: only our home can answer. Not checked against the list: a DM opened from a link is on screen before it.
    if (!this.home) return null;
    const home = this.home;
    return {
      voiceStates: (id) => home.conversationVoiceStates(id),
      voiceJoin: (id, body) => home.conversationVoiceJoin(id, body),
      voiceLeave: (id) => home.conversationVoiceLeave(id),
      voiceState: (id, body) => home.conversationVoiceState(id, body),
      voiceSignal: (id, body) => home.conversationVoiceSignal(id, body),
      voiceServer: (id) => home.conversationVoiceServer(id),
      /// A mesh carries the screen on the peer connection; the flag only draws the pill.
      voiceStream: (id, body) => home.conversationVoiceState(id, { streaming: Boolean(body?.enabled) }),
      voiceWatch: () => Promise.resolve({ ok: true }),
    };
  },

  statusFor(guildId) {
    const guild = this.guilds.get(guildId);
    return guild ? this.gw.statusOf(guild.domain) : Status.Closed;
  },

  voiceDomain(roomId) {
    const channel = this.channels.get(roomId);
    if (channel) return channel.domain;
    return this.home?.domain || this.session?.home?.domain || null;
  },

  claimVoiceSeat(roomId, voiceState) {
    const sessionId = voiceState?.session_id;
    if (!roomId || !sessionId) return;
    this.gw.claimVoice(this.voiceDomain(roomId), roomId, sessionId);
  },

  releaseVoiceSeat(roomId) {
    this.gw.releaseVoice(roomId);
  },

  async loadMigrationAlerts() {
    try {
      const r = await this.home.migrationAlerts();
      this.migrationAlerts = r.alerts || [];
    } catch {
      return;
    }
    this.emit('migration-alerts');
  },

  async loadSunset() {
    let record;
    try {
      record = await this.home.sunset();
    } catch {
      return;
    }
    const next = activeSunset(record);
    this.sunset = next ? { finalized: this.sunset?.finalized === true, ...next } : null;
    this.emit('sunset', this.sunset);
  },

  async accountBundle(password) {
    if (!password) throw new Error('Enter your account password.');
    const proof = await this.reauthProof(password);
    return this.home.accountBundle(proof);
  },

  onMigrationAlert(d) {
    if (!d?.id) return;
    const rest = this.migrationAlerts.filter((a) => a.id !== d.id);
    const waiting = d.state === 'pending' || d.state === 'ready';
    this.migrationAlerts = waiting ? [...rest, { ...rest.find((a) => a.id === d.id), ...d }] : rest;
    this.emit('migration-alerts');
    if (waiting) this.loadMigrationAlerts();
  },

  onRecoveryEmail(d) {
    if (!d) return;
    this.recoveryEmail = d;
    this.emit('recovery-email');
  },

  async cancelMigration(id) {
    await this.home.cancelMigration(id);
    this.onMigrationAlert({ id, state: 'cancelled' });
  },
};
