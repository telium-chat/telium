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
      this.emit('ready');
      return;
    }
    this.emit('me', this.me);

    this.loadMigrationAlerts();
    this.loadSunset();

    this.adoptLocalDmDrafts();
    this.sync.load(this.home)
      .catch((e) => console.warn('sync store unavailable', e));

    // Not awaited, not fatal: failure should cost only DMs. Recovery key first: every sign-in is a new MLS device.
    encryption()
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
        engine.sendsRead = (id) => this.readReceiptsIn(id);
        engine.sendsDelivered = (id) => this.deliveryAcksIn(id);
        this.refreshCustody().catch(() => {});
        return vault.load(
          this.home,
          null,
          home.user_id,
          this.authRecoveryWrapper,
          this.accountRecoveryWrapper,
        )
          .then(async (loaded) => {
            let v = loaded;

            // Older clients defaulted to homeserver escrow; leave it silently. After a failed upgrade re-read the vault.
            if (v.mode === 'escrowed' && v.raw && !this.authRecoveryWrapper
              && !v.downgradeRefused) {
              try {
                v = await vault.setMode(
                  this.home, v, 'device_custody', null, home.user_id,
                );
              } catch (e) {
                console.warn('could not upgrade legacy DM recovery custody; reloading the vault', e);
                v = await vault.load(
                  this.home, null, home.user_id,
                  this.authRecoveryWrapper, this.accountRecoveryWrapper,
                ).catch((again) => {
                  console.warn('could not reload the DM recovery vault', again);
                  return v;
                });
              }
              await this.refreshCustody().catch(() => {});
            }

            this.vault = v;
            if (v.locked) this.emit('vault', v);
            if (v.created || this.custody?.mode !== v.mode) {
              this.refreshCustody().catch(() => {});
            }
            this.sync.adoptKeyring(v, { current: !!v.created || v !== loaded })
              .catch((e) => console.warn('sync store could not take the key', e));
            return engine.adoptRecoveryKey(v);
          })
          .catch((e) => console.warn('key vault unavailable', e))
          .then(() => engine.start())
          // Published only once it can do crypto, so `this.mls` set means usable.
          .then(() => { this.mls = engine; })
          // Drain before the ready emit so the first render has them read.
          .then(() => this.drainStartup().catch((e) => {
            console.warn('could not walk frames that arrived during startup', e);
          }));
      })
      .then(() => this.emit('dm', { ready: true }))
      .then(() => this.startTrust())
      .catch((e) => {
        console.warn('encryption unavailable', e);
        this.mls = null;
        this.emit('dm', { ready: false });
      });

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
};
