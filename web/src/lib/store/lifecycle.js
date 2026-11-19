import { Api, discover, HttpError } from '../api.js';
import { Backup } from '../backup.js';
import { learnFallback } from '../failover.js';
import { findHomeRelocation, relocateSession } from '../relocation.js';
import * as snapshot from '../snapshot.js';
import * as vault from '../vault.js';
import { registerOrigin } from '../net/transport.js';
import { setRelayCapability } from '../net/tunnel.js';
import { encryption } from './shared.js';

/// Any failure reads as no: "probably fine" is how a privacy mode ends up silently off.
async function discoverRelay(home) {
  const doc = await discover(home.base).catch(() => null);
  return {
    relay: doc?.relay || null,
    // Two noes: never advertised means the server needs upgrading; advertised with no relay means switched off.
    understood: Array.isArray(doc?.capabilities) && doc.capabilities.includes('transport.relay'),
  };
}

// Seconds between asks while the homeserver is out of reach; the last wait repeats.
const STARTUP_RETRY_MS = [3000, 10000, 30000, 60000, 120000];

/// No answer, not a refusal: a 4xx means the homeserver was reached and said no. Without a status, only what the
/// network layer throws counts (a failed fetch, a timeout, `request`'s "could not reach"); any other error is a bug
/// or a broken local state that asking again every two minutes would not fix.
function isUnanswered(e) {
  const status = e?.status;
  if (typeof status === 'number') return status >= 500 || [408, 425, 429].includes(status);
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return true;
  return /failed to fetch|networkerror|network error|load failed|could not reach/i.test(String(e?.message || ''));
}

export const lifecycleMethods = {
  /// A fast READY can land before IndexedDB answers; `snapshot.apply` refuses a non-empty store.
  /// Must not throw: `Root` shows only a generic outage for a `start` rejection.
  async hydrate(userId) {
    let snap = null;
    try { snap = await snapshot.read(userId); }
    catch (e) { console.warn('offline snapshot unreadable', e); return false; }

    let filled = false;
    try { filled = snapshot.apply(this, snap); }
    catch (e) {
      console.warn('offline snapshot could not be applied; discarding it', e);
      snapshot.clear().catch(() => {});
      return false;
    }
    if (!filled) return false;
    this.emit('guilds');
    this.emit('channels');
    this.emit('conversations');
    if (this.me) this.emit('me', this.me);
    this.emit('hydrated');
    return true;
  },

  persist() {
    // Guarded on identity alone: refusing an empty guild set repainted the last guild you left.
    if (!this.me) return;
    snapshot.write(this.session?.home?.user_id, snapshot.capture(this)).catch(() => {});
  },

  async start() {
    const home = this.session.home;
    this.home = new Api({ base: home.base, token: home.token, domain: home.domain });
    // Repeated each start because a migration changes the host.
    this.gw.setHome(home.domain);

    // Home is never protected: it holds the account and has always seen the address.
    registerOrigin(home.domain, [home.base]);

    // Not awaited: don't block first paint; the transport refuses to protect before the answer lands.
    discoverRelay(home)
      .then(({ relay, understood }) => setRelayCapability(relay, home.token, understood))
      .catch(() => {});

    // Asked before the snapshot read so the request isn't queued behind IndexedDB.
    const identity = this.home.whoami();
    identity.catch(() => {}); // handled below; this only silences the race

    await this.hydrate(home.user_id);

    try {
      this.me = await identity;
      this.rememberCard();
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) { this.signOut(); throw e; }
      if (!this.me) throw e;
      // Showing the saved view is all that can be done now. Everything below needs the homeserver, so it is picked up
      // again by retryStartup() when it answers, rather than staying off until the app is restarted.
      this.startDegraded = true;
      this.scheduleStartupRetry();
      this.emit('startup');
      this.emit('ready');
      return;
    }
    if (this.startDegraded) { this.startDegraded = false; this.emit('startup'); }
    this.emit('me', this.me);

    this.loadMigrationAlerts();
    this.loadSunset();

    this.adoptLocalDmDrafts();
    this.sync.load(this.home)
      .catch((e) => console.warn('sync store unavailable', e))
      .then(() => this.adoptDmOutbox());

    this.startEncryption();

    const known = { ...this.session.servers };
    if (!known[home.domain]) {
      try { await this.addServer(home.domain, { base: home.base, silent: true }); }
      catch {}
    }
    for (const [domain, entry] of Object.entries(known)) {
      this.connectServer(domain, entry);
    }
    // After the connect: a bad token is renewed on the same path as a woken tab.
    this.freshenSessions();
    this.loadCapabilities(home.domain).catch(() => {});
    // Asked now: where to go when it stops cannot be looked up afterwards.
    learnFallback(home.base).then((f) => {
      if (!this.session?.home || this.session.home.domain !== home.domain) return;
      this.session.home.fallback = f && { standby: f.standby, path: f.path };
      this.save();
      if (f?.authority?.domain && f.authority.domain !== home.domain) {
        this.enterFallback().catch((err) => console.warn('no standby available', err));
      }
    }).catch(() => {});
    findHomeRelocation(home).then((moved) => {
      if (!moved || !this.session?.home || this.session.home.domain !== home.domain) return;
      const from = home.domain;
      this.session = relocateSession(this.session, moved);
      this.save();
      this.emit('relocated', { from, to: moved.domain });
    }).catch(() => {});
    this.loadMediaRegistry().catch(() => {});
    this.loadMediaPreference().catch(() => {});
    this.refreshConversations().catch(() => {});
    this.refreshFriends().catch(() => {});
    this.emit('ready');
  },

  /// Not awaited, not fatal: failure should cost only DMs. Recovery key first: every sign-in is a new MLS device.
  /// Safe to call again: it does nothing while an attempt is running or once the engine is up.
  startEncryption() {
    if (this.mls || this.disposed || !this.session?.home) return this.encryptionStarting || Promise.resolve();
    if (this.encryptionStarting) return this.encryptionStarting;
    const home = this.session.home;
    this.encryptionStarting = encryption()
      .then(({ Mls }) => {
        this.backup = new Backup(this.home, null);
        // Published to `this.mls` only once started, or a half-built engine throws inside the crypto.
        const engine = new Mls(this.home, {
          userId: home.user_id,
          deviceId: home.device_id,
          backup: this.backup,
        });
        engine.verifyClaimedPackage = (userId, deviceId, signatureKey) => (
          this.verifyClaimedPackage(userId, deviceId, signatureKey)
        );
        engine.isRevokedKey = (userId, key) => Boolean(this.trust?.isRevokedKey(userId, key));
        engine.onGroupName = () => this.emit('conversations');
        engine.sendsRead = (id) => this.readReceiptsIn(id);
        engine.sendsDelivered = (id) => this.deliveryAcksIn(id);
        this.refreshCustody().catch(() => {});
        return this.openVault(engine)
          .catch((e) => this.vaultUnavailable(e))
          .then(() => engine.start())
          // Published only once it can do crypto, so `this.mls` set means usable.
          .then(() => { this.mls = engine; })
          // Drain before the ready emit so the first render has them read.
          .then(() => this.drainStartup().catch((e) => {
            console.warn('could not walk frames that arrived during startup', e);
          }))
          // Cold start: the list was fetched before the engine could walk anything, so the
          // badges the rail opens with come from this pass.
          .then(() => this.catchUpDmUnread().catch(() => {}));
      })
      .then(() => {
        this.encryptionUnanswered = false;
        this.encryptionRefused = false;
        this.emit('dm', { ready: true });
        this.emit('startup');
      })
      .then(() => this.startTrust())
      .catch((e) => {
        console.warn('encryption unavailable', e);
        this.mls = null;
        this.encryptionUnanswered = isUnanswered(e);
        // Asked again only when the homeserver did not answer. A refusal or a local failure stays off until the next
        // launch, as before, rather than re-running the engine and the key vault every two minutes for good.
        this.encryptionRefused = !this.encryptionUnanswered;
        this.emit('dm', { ready: false });
        this.emit('startup');
        if (this.encryptionUnanswered) this.scheduleStartupRetry();
      })
      .finally(() => { this.encryptionStarting = null; });
    return this.encryptionStarting;
  },

  /// A session without the password never writes custody: a vault in a retired mode stays locked until a
  /// password sign-in converts it, or the user starts a new one (vault.js loadRetired).
  async openVault(engine) {
    const home = this.session.home;
    const v = await vault.load(
      this.home,
      home.user_id,
      this.authRecoveryWrapper,
      this.accountRecoveryWrapper,
    );
    this.vault = v;
    if (v.locked) this.emit('vault', v);
    if (v.created || this.custody?.mode !== v.mode) {
      this.refreshCustody().catch(() => {});
    }
    this.sync.adoptKeyring(v, { current: !!v.created })
      .catch((e) => console.warn('sync store could not take the key', e));
    if (this.vaultPending) { this.vaultPending = false; this.emit('startup'); }
    return engine.adoptRecoveryKey(v);
  },

  /// DMs still open without the key, but a homeserver that merely did not answer is asked again later.
  vaultUnavailable(e) {
    console.warn('key vault unavailable', e);
    if (isUnanswered(e)) {
      this.vaultPending = true;
      this.emit('startup');
      this.scheduleStartupRetry();
    }
  },

  /// The homeserver did not answer something the app needs from it, and a retry is waiting. Not true for a failure the
  /// homeserver answered or one that has nothing to do with the network, which a banner could not help with.
  homeUnreachable() {
    return Boolean(
      this.startDegraded
      || this.vaultPending
      || (!this.mls && this.encryptionUnanswered && !this.encryptionStarting),
    );
  },

  /// Whatever a start left undone because the homeserver was out of reach. Called when the network or the window
  /// comes back and on a timer, so a restart is not the only way back.
  async retryStartup() {
    if (this.disposed || !this.session?.home) return;
    if (this.startingAgain) return;
    this.startingAgain = true;
    try {
      if (this.startDegraded) {
        await this.start().catch(() => {});
        return;
      }
      if (!this.mls && !this.encryptionRefused) {
        await this.startEncryption();
      } else if (this.vaultPending) {
        await this.openVault(this.mls).catch((e) => this.vaultUnavailable(e));
      }
    } finally {
      this.startingAgain = false;
      if (this.startupPending()) this.scheduleStartupRetry();
      else this.startupAttempts = 0;
    }
  },

  startupPending() {
    return Boolean(this.startDegraded || (!this.mls && !this.encryptionRefused) || this.vaultPending);
  },

  scheduleStartupRetry() {
    if (this.disposed || this.startupTimer) return;
    const attempt = this.startupAttempts || 0;
    this.startupAttempts = attempt + 1;
    const wait = STARTUP_RETRY_MS[Math.min(attempt, STARTUP_RETRY_MS.length - 1)];
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.retryStartup();
    }, wait);
  },
};
