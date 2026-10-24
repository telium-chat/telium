import { discover, requireGatewayUrl } from './discovery.js';
import { request } from './http.js';
import { GatewayConnection } from './gateway.js';

export { discover } from './discovery.js';

const DEFAULT_INSTALLATION_REFRESH_MS = 5000;

// Machine-readable code for "not installed here any more"; the sentence may be reworded.
export const BOT_NOT_INSTALLED_CODE = 'bot_not_installed';

// Own-credential refusals are terminal: retrying sends the same dead token to an auth endpoint.
export const UNKNOWN_BOT_TOKEN_CODE = 'unknown_bot_token';
export const BOT_CREDENTIAL_REVOKED_CODE = 'bot_credential_revoked';

export function isDeadCredential(error) {
  if (Number(error?.status) !== 401) return false;
  const code = errorCode(error);
  return code === UNKNOWN_BOT_TOKEN_CODE || code === BOT_CREDENTIAL_REVOKED_CODE;
}

// Statuses that mean "not allowed in"; retried.
const AUTH_STATUSES = new Set([401, 403, 407]);

// Authorisation failures before a domain is deemed not transient.
export const AUTH_RETRY_LIMIT = 10;

function installationFingerprint(rows) {
  return [...rows]
    .sort((a, b) => String(a.guild_id).localeCompare(String(b.guild_id)))
    .map((row) => [
      row.guild_id,
      row.installed_at ?? null,
      row.allowed_intents ?? null,
      row.permissions ?? null,
    ])
    .map((row) => JSON.stringify(row))
    .join('|');
}

function groupedInstallations(installations) {
  const grouped = new Map();
  for (const row of installations) {
    const domain = row.guild_domain;
    if (!domain) continue;
    const rows = grouped.get(domain) || [];
    rows.push(row);
    grouped.set(domain, rows);
  }
  return grouped;
}

function errorCode(error) {
  const body = error?.body;
  const explicit = body?.code;
  if (typeof explicit === 'string' && explicit) return explicit.toLowerCase();
  const legacy = body?.error;
  if (typeof legacy === 'string' && legacy) return legacy.toLowerCase();
  return '';
}

export function isNotInstalled(error) {
  if (Number(error?.status) !== 403) return false;
  const code = errorCode(error);
  if (code === BOT_NOT_INSTALLED_CODE) return true;
  // `forbidden` is generic, so it alone earns a look at the sentence.
  if (code && code !== 'forbidden') return false;
  return String(error?.body?.message || error?.message || '')
    .toLowerCase()
    .includes('not installed on this guild server');
}

// Temporary on the guild side: clock skew, key rotation, missed key fetch.
export function isAuthError(error) {
  return AUTH_STATUSES.has(Number(error?.status));
}

// Retrying sends the same bytes; authorisation failures use the threshold path.
export function isTerminalHttpError(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status < 400 || status >= 500) return false;
  if (status === 408 || status === 429) return false;
  // A dead credential is terminal, so check it before the blanket exemption below.
  if (isDeadCredential(error)) return true;
  if (AUTH_STATUSES.has(status)) return false;
  return true;
}

export class BotClient {
  constructor({
    home,
    token,
    intents = ['GUILD_MESSAGES', 'GUILD_STRUCTURE'],
    installationRefreshMs = DEFAULT_INSTALLATION_REFRESH_MS,
    allowInsecureHttp,
    requestTimeoutMs,
    authRetryLimit = AUTH_RETRY_LIMIT,
  }) {
    if (!home || !token) throw new Error('home and token are required');
    this.home = home;
    this.token = token;
    this.intents = intents;
    this.allowInsecureHttp = allowInsecureHttp;
    this.requestTimeoutMs = requestTimeoutMs;
    this.authRetryLimit = Math.max(1, Number(authRetryLimit) || AUTH_RETRY_LIMIT);
    this.installationRefreshMs = installationRefreshMs === false
      ? 0
      : Math.max(1000, Number(installationRefreshMs) || DEFAULT_INSTALLATION_REFRESH_MS);
    this.homeInfo = null;
    this.installations = [];
    this.connections = new Map();
    this.connectingDomains = new Set();
    this.channelDomains = new Map();
    this.handlers = new Map();
    this.domainFingerprints = new Map();
    this.suppressedDomains = new Map();
    this.installationRefreshTimer = null;
    this.installationRefreshDueAt = null;
    this.installationRefreshFailures = 0;
    this.installationSync = null;
    this.authFailures = new Map();
    this.domainRetryAt = new Map();
    this.closed = false;
  }

  discoveryOptions(expectServerName) {
    return {
      allowInsecureHttp: this.allowInsecureHttp,
      timeoutMs: this.requestTimeoutMs,
      ...(expectServerName ? { expectServerName } : {}),
    };
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  // An async handler's rejection escapes try/catch; with no `error` handler, rethrow from a microtask to stay loud.
  deliverHandlerFailure(event, error) {
    if (event !== 'error' && this.handlers.get('error')?.size) {
      this.emit('error', error, { phase: 'handler', event });
      return;
    }
    queueMicrotask(() => { throw error; });
  }

  invokeHandler(event, handler, args) {
    let result;
    try {
      result = handler(...args);
    } catch (error) {
      this.deliverHandlerFailure(event, error);
      return;
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(undefined, (error) => this.deliverHandlerFailure(event, error));
    }
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) || []) {
      this.invokeHandler(event, handler, args);
    }
    for (const handler of this.handlers.get('*') || []) {
      this.invokeHandler(event, handler, [event, ...args]);
    }
  }

  async login() {
    this.closed = false;
    this.homeInfo = await discover(this.home, this.discoveryOptions());
    const result = await this.refreshInstallations({ phase: 'login' });
    this.scheduleInstallationRefresh();
    this.emit('ready', {
      installations: this.installations,
      domains: result.connectedDomains,
      unavailableDomains: result.unavailableDomains,
    });
    return this;
  }

  async fetchInstallations() {
    if (!this.homeInfo) throw new Error('BotClient is not logged in');
    const index = await request(
      this.homeInfo.api,
      'GET',
      '/_telium/v1/bots/installations',
      { botToken: this.token, timeoutMs: this.requestTimeoutMs },
    );
    return index.installations || [];
  }

  async refreshInstallations({ phase = 'installation-refresh' } = {}) {
    if (this.closed) {
      return { connectedDomains: [], unavailableDomains: [] };
    }
    if (this.installationSync) return this.installationSync;

    this.installationSync = (async () => {
      const nextInstallations = await this.fetchInstallations();
      if (this.closed) return { connectedDomains: [], unavailableDomains: [] };

      this.installations = nextInstallations;
      const grouped = groupedInstallations(nextInstallations);
      const nextDomains = new Set(grouped.keys());

      // A domain gone from the home index is no authority to stay connected to; also clears its channel routing.
      for (const domain of [...this.connections.keys()]) {
        if (!nextDomains.has(domain)) this.disconnectDomain(domain);
      }

      for (const domain of [...this.domainFingerprints.keys()]) {
        if (!nextDomains.has(domain)) {
          this.domainFingerprints.delete(domain);
          this.suppressedDomains.delete(domain);
          this.authFailures.delete(domain);
          this.domainRetryAt.delete(domain);
        }
      }

      const toConnect = [];
      for (const [domain, rows] of grouped) {
        const fingerprint = installationFingerprint(rows);
        const previous = this.domainFingerprints.get(domain);
        const suppressed = this.suppressedDomains.get(domain);

        // Reinstalling updates installed_at, so a changed fingerprint releases a 403 suppression.
        if (suppressed && suppressed !== fingerprint) {
          this.suppressedDomains.delete(domain);
        }

        // One connection per homeserver: any install-set or grant change needs a fresh READY.
        if (
          this.connections.has(domain)
          && previous !== undefined
          && previous !== fingerprint
        ) {
          this.disconnectDomain(domain);
        }

        // A fingerprint change also clears the authorisation backoff.
        if (previous !== undefined && previous !== fingerprint) {
          this.authFailures.delete(domain);
          this.domainRetryAt.delete(domain);
        }

        this.domainFingerprints.set(domain, fingerprint);
        // Per-domain gate, or an auth failure would be retried every five seconds forever.
        const retryAt = this.domainRetryAt.get(domain);
        if (retryAt !== undefined && Date.now() < retryAt) continue;

        if (
          !this.connections.has(domain)
          && !this.connectingDomains.has(domain)
          && this.suppressedDomains.get(domain) !== fingerprint
        ) {
          toConnect.push({ domain, fingerprint });
        }
      }

      const attempts = await Promise.allSettled(
        toConnect.map(({ domain }) => this.connectDomain(domain)),
      );
      const unavailableDomains = [];
      attempts.forEach((result, index) => {
        const { domain, fingerprint } = toConnect[index];
        if (result.status === 'fulfilled') {
          this.authFailures.delete(domain);
          this.domainRetryAt.delete(domain);
          return;
        }
        unavailableDomains.push(domain);
        const error = result.reason;
        if (isNotInstalled(error)) {
          this.suppressedDomains.set(domain, fingerprint);
          this.emit('warning', {
            code: 'INSTALLATION_INACTIVE',
            message: `Telium no longer sees this bot installed on ${domain}; waiting for the installation index to change before reconnecting.`,
            domain,
            phase,
            status: error.status,
          });
          return;
        }
        if (isAuthError(error)) {
          const attemptCount = this.noteAuthFailure(domain);
          if (attemptCount < this.authRetryLimit) {
            this.emit('warning', {
              code: 'GUILD_AUTH_RETRY',
              message: `Could not authorise with ${domain} (HTTP ${error?.status}); Telium will retry with backoff (${attemptCount}/${this.authRetryLimit}).`,
              domain,
              phase,
              status: error?.status,
              attempt: attemptCount,
              limit: this.authRetryLimit,
              retryAt: this.domainRetryAt.get(domain),
              cause: error,
            });
            return;
          }
          this.clearAuthFailure(domain);
          this.suppressedDomains.set(domain, fingerprint);
          this.emit('error', error, {
            domain, phase, terminal: true, attempts: attemptCount,
          });
          return;
        }
        if (isTerminalHttpError(error)) {
          this.suppressedDomains.set(domain, fingerprint);
          this.emit('error', error, { domain, phase, terminal: true });
          return;
        }
        this.emit('warning', {
          code: 'GUILD_CONNECT_RETRY',
          message: `Could not connect to ${domain}; Telium will retry automatically.`,
          domain,
          phase,
          status: error?.status,
          cause: error,
        });
      });

      return {
        connectedDomains: [...this.connections.keys()],
        unavailableDomains,
      };
    })();

    try {
      const result = await this.installationSync;
      this.installationRefreshFailures = 0;
      return result;
    } finally {
      this.installationSync = null;
    }
  }

  noteAuthFailure(domain) {
    const attemptCount = (this.authFailures.get(domain) || 0) + 1;
    this.authFailures.set(domain, attemptCount);
    const backoff = Math.min(30000, 1000 * (2 ** Math.min(attemptCount, 5)));
    this.domainRetryAt.set(domain, Date.now() + backoff);
    return attemptCount;
  }

  clearAuthFailure(domain) {
    this.authFailures.delete(domain);
    this.domainRetryAt.delete(domain);
  }

  scheduleInstallationRefresh(delay = this.installationRefreshMs) {
    clearTimeout(this.installationRefreshTimer);
    this.installationRefreshTimer = null;
    this.installationRefreshDueAt = null;
    if (this.closed || this.installationRefreshMs <= 0) return;

    this.installationRefreshDueAt = Date.now() + Math.max(0, delay);
    this.installationRefreshTimer = setTimeout(async () => {
      this.installationRefreshTimer = null;
      this.installationRefreshDueAt = null;
      if (this.closed) return;
      try {
        await this.refreshInstallations();
        this.installationRefreshFailures = 0;
        this.scheduleInstallationRefresh();
      } catch (error) {
        this.installationRefreshFailures += 1;
        this.emit('warning', {
          code: 'INSTALLATION_INDEX_RETRY',
          message: 'Could not refresh bot installations from the bot home; Telium will retry automatically.',
          status: error?.status,
          cause: error,
        });
        const retry = Math.min(
          30000,
          this.installationRefreshMs * (2 ** Math.min(this.installationRefreshFailures, 3)),
        );
        this.scheduleInstallationRefresh(retry);
      }
    }, Math.max(0, delay));
    this.installationRefreshTimer.unref?.();
  }

  // A hint may move the next poll earlier when healthy, never later; replacing the timer undid backoff.
  expediteInstallationRefresh(delay = 250) {
    if (this.installationRefreshFailures > 0) return;
    const soonest = Date.now() + Math.max(0, delay);
    if (this.installationRefreshDueAt !== null && this.installationRefreshDueAt <= soonest) return;
    this.scheduleInstallationRefresh(delay);
  }

  async freshSession(domain) {
    // Makes the peer prove its document agrees with the looked-up name.
    const remote = await discover(domain, this.discoveryOptions(domain));
    const asserted = await request(
      this.homeInfo.api,
      'POST',
      '/_telium/v1/bots/assertions',
      {
        botToken: this.token,
        // Audience is the indexed domain, never `remote.serverName`, which a malicious index entry could forge.
        body: { audience: domain },
        timeoutMs: this.requestTimeoutMs,
      },
    );
    const session = await request(
      remote.api,
      'POST',
      '/_telium/v1/bots/session',
      { body: { assertion: asserted.assertion }, timeoutMs: this.requestTimeoutMs },
    );
    return {
      remote,
      token: session.session_token,
      gateway: session.gateway
        ? requireGatewayUrl(session.gateway, domain, { allowInsecureHttp: this.allowInsecureHttp })
        : remote.gateway,
    };
  }

  clearDomainChannels(domain) {
    for (const [channelId, channelDomain] of this.channelDomains) {
      if (channelDomain === domain) this.channelDomains.delete(channelId);
    }
  }

  disconnectDomain(domain) {
    const entry = this.connections.get(domain);
    if (entry) entry.connection.close();
    this.connections.delete(domain);
    this.clearDomainChannels(domain);
  }

  handleRefreshError(domain, error, attempt) {
    const fingerprint = this.domainFingerprints.get(domain);
    if (isNotInstalled(error)) {
      if (fingerprint !== undefined) this.suppressedDomains.set(domain, fingerprint);
      this.emit('warning', {
        code: 'INSTALLATION_INACTIVE',
        message: `The bot is no longer installed on ${domain}. Telium will reconnect automatically if it is installed again.`,
        domain,
        status: error.status,
      });
      this.clearAuthFailure(domain);
      // Re-read the home index soon so removal/reinstall is noticed.
      this.expediteInstallationRefresh(250);
      return false;
    }

    // Only caps retries; the gateway reconnect loop supplies backoff.
    if (isAuthError(error)) {
      const attemptCount = this.noteAuthFailure(domain);
      if (attemptCount < this.authRetryLimit) {
        this.emit('warning', {
          code: 'GATEWAY_AUTH_RETRY',
          message: `${domain} rejected the bot's session assertion (HTTP ${error?.status}); Telium will retry (${attemptCount}/${this.authRetryLimit}).`,
          domain,
          status: error?.status,
          attempt: attemptCount,
          limit: this.authRetryLimit,
          cause: error,
        });
        return true;
      }
      this.clearAuthFailure(domain);
      if (fingerprint !== undefined) this.suppressedDomains.set(domain, fingerprint);
      this.emit('error', error, {
        domain, phase: 'gateway-refresh', terminal: true, attempts: attemptCount,
      });
      return false;
    }

    if (isTerminalHttpError(error)) {
      if (fingerprint !== undefined) this.suppressedDomains.set(domain, fingerprint);
      this.emit('error', error, { domain, phase: 'gateway-refresh', terminal: true });
      return false;
    }

    // Expected to be temporary; keep reconnecting without an error stack per attempt.
    if (attempt === 1 || attempt % 5 === 0) {
      this.emit('warning', {
        code: 'GATEWAY_RECONNECT_RETRY',
        message: `Connection to ${domain} is unavailable; Telium will keep retrying automatically.`,
        domain,
        status: error?.status,
        attempt,
        cause: error,
      });
    }
    return true;
  }

  async connectDomain(domain) {
    if (this.closed || this.connections.has(domain) || this.connectingDomains.has(domain)) return;
    this.connectingDomains.add(domain);
    try {
      const fresh = await this.freshSession(domain);
      if (this.closed) return;
      const connection = new GatewayConnection({
        domain,
        gateway: fresh.gateway,
        token: fresh.token,
        intents: this.intents,
        refresh: async () => {
          const next = await this.freshSession(domain);
          return { token: next.token, gateway: next.gateway };
        },
        onReady: (data) => {
          this.suppressedDomains.delete(domain);
          // READY proves the assertion chain worked, so the auth-failure count is spent.
          this.clearAuthFailure(domain);
          this.clearDomainChannels(domain);
          for (const guild of data?.guilds || []) {
            for (const channel of guild.channels || []) {
              this.channelDomains.set(channel.id, domain);
            }
            if (Array.isArray(guild.bot_allowed_intent_names)) {
              const granted = new Set(guild.bot_allowed_intent_names);
              const missing = this.intents.filter((intent) => !granted.has(intent));
              if (missing.length) {
                this.emit('warning', {
                  code: 'MISSING_GUILD_INTENTS',
                  message: `Guild ${guild.name || guild.id} is missing requested bot intents: ${missing.join(', ')}`,
                  domain,
                  guildId: guild.id,
                  guildName: guild.name,
                  requestedIntents: [...this.intents],
                  grantedIntents: [...granted],
                  missingIntents: missing,
                });
              }
            }
          }
          this.emit('gatewayReady', { domain, data });
        },
        onDispatch: (type, data) => {
          if (data?.channel_id) this.channelDomains.set(data.channel_id, domain);
          this.emit(type || 'dispatch', data, { domain });
          this.emit('dispatch', { type, data, domain });
        },
        onError: (error) => this.emit('warning', {
          code: 'GATEWAY_SOCKET_ERROR',
          message: `Gateway transport error for ${domain}; reconnect will be attempted automatically.`,
          domain,
          cause: error,
        }),
        onRefreshError: (error, attempt) => this.handleRefreshError(domain, error, attempt),
        onHeartbeatTimeout: (error) => this.emit('warning', {
          code: 'GATEWAY_HEARTBEAT_TIMEOUT',
          message: `Gateway for ${domain} stopped acknowledging heartbeats; the connection is being rebuilt.`,
          domain,
          cause: error,
        }),
        onStopped: () => {
          const current = this.connections.get(domain);
          if (current?.connection === connection) {
            this.connections.delete(domain);
            this.clearDomainChannels(domain);
          }
        },
      });
      this.connections.set(domain, { connection, remote: fresh.remote });
      connection.open();
    } finally {
      this.connectingDomains.delete(domain);
    }
  }

  async sendMessage(channelId, content, { domain } = {}) {
    domain ||= this.channelDomains.get(channelId);
    if (!domain) {
      throw new Error('Unknown channel homeserver; pass { domain } or wait for READY/message activity');
    }
    const entry = this.connections.get(domain);
    if (!entry) throw new Error(`No bot connection for ${domain}`);

    const send = (bearer) => request(
      entry.remote.api,
      'POST',
      `/_telium/v1/channels/${encodeURIComponent(channelId)}/messages`,
      { bearer, body: { content }, timeoutMs: this.requestTimeoutMs },
    );
    try {
      return await send(entry.connection.token);
    } catch (error) {
      if (error.status !== 401) throw error;
      const fresh = await this.freshSession(domain);
      entry.remote = fresh.remote;
      entry.connection.token = fresh.token;
      entry.connection.gateway = fresh.gateway;
      return send(fresh.token);
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.installationRefreshTimer);
    this.installationRefreshTimer = null;
    for (const { connection } of this.connections.values()) connection.close();
    this.connections.clear();
    this.connectingDomains.clear();
    this.channelDomains.clear();
    this.domainFingerprints.clear();
    this.suppressedDomains.clear();
    this.authFailures.clear();
    this.domainRetryAt.clear();
    this.installationRefreshDueAt = null;
  }
}
