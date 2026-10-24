// Only code that holds the account password: never downgrade a homeserver that once spoke OPAQUE.

import { Api, HttpError } from '../api.js';
import {
  activate, forgetAccount, listAccounts, rememberSession, roomForAnother, stashActive,
} from '../accounts.js';
import { forgetDeviceSecrets, wipeDeviceSecrets } from '../device-secrets.js';
import { forgetEmbeds } from '../embeds.js';
import { normalizeHomeserver } from '../homeserver.js';
import * as snapshot from '../snapshot.js';
import { activeSunset } from '../sunset.js';
import { shortName, storage } from '../util.js';
import * as vault from '../vault.js';
import {
  encryption, LOCAL_DM_DRAFTS_KEY, OPAQUE_PIN_PREFIX,
  PENDING_RECOVERY_KEY, secureAuth, SESSION_KEY,
} from './shared.js';

/// Both keys are read and written, or a pin under the old key would lapse and allow the downgrade.
function pinKeys(normalized, home) {
  const named = home ? normalizeHomeserver(home) : '';
  return [...new Set([normalized, named].filter(Boolean))].map((k) => OPAQUE_PIN_PREFIX + k);
}

function authError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export const sessionMethods = {
  save() {
    if (this.disposed) { rememberSession(this.session); return; }
    storage.set(SESSION_KEY, this.session);
    rememberSession(this.session, { card: this.accountCard() });
  },

  accountCard() {
    const me = this.me;
    if (!me?.user_id) return null;
    const profile = me.profile || {};
    return {
      name: profile.display_name || me.display_name || null,
      avatar_ref: profile.avatar_ref || null,
      base: this.session?.home?.base || null,
    };
  },

  rememberCard() {
    if (this.session?.home?.token) rememberSession(this.session, { card: this.accountCard() });
  },

  accounts() { return listAccounts(); },

  restart() {
    if (typeof this.replace === 'function') this.replace();
    else if (typeof location !== 'undefined') location.reload();
  },

  beforeAway(fn) {
    this.awayTasks ||= new Set();
    this.awayTasks.add(fn);
    return () => this.awayTasks.delete(fn);
  },

  async switchAccount(userId) {
    if (!userId || userId === this.session?.home?.user_id) return false;
    const target = listAccounts().find((a) => a.user_id === userId);
    if (!target) return false;
    this.emit('switching', { name: target.card?.name || shortName(userId) });
    await this.putAway();
    activate(userId);
    this.restart();
    return true;
  },

  async addAccount() {
    if (!roomForAnother()) return false;
    this.emit('switching', null);
    await this.putAway();
    this.restart();
    return true;
  },

  async signOutOther(userId) {
    if (!userId || userId === this.session?.home?.user_id) return;
    forgetAccount(userId);
    const localDrafts = storage.get(LOCAL_DM_DRAFTS_KEY, {});
    if (localDrafts[userId]) {
      delete localDrafts[userId];
      storage.set(LOCAL_DM_DRAFTS_KEY, localDrafts);
    }
    await Promise.allSettled([
      encryption().then((m) => m.wipeScope(userId)),
      forgetDeviceSecrets(userId),
      snapshot.drop(userId),
    ]);
    this.emit('accounts');
  },

  async putAway() {
    const tasks = [...(this.awayTasks || [])].map((fn) => Promise.resolve().then(fn));
    await Promise.race([
      Promise.allSettled([this.backup?.flush(), ...tasks]),
      new Promise((resolve) => { setTimeout(resolve, 1500); }),
    ]);
    this.gw.closeAll();
    stashActive(this.accountCard());
  },

  async signIn(
    base,
    user,
    password,
    {
      register = false,
      reactivate = false,
      mfaCode = null,
      allowLegacyAuth = false,
      home = null,
    } = {},
  ) {
    await this.cryptoCleanup.catch(() => {});
    // A bare host is a relative base that would send credentials to the page's own server.
    const normalized = normalizeHomeserver(base) || base.replace(/\/$/, '');
    const deviceName = `web (${navigator.platform || 'browser'})`;
    const keys = pinKeys(normalized, home);
    const pinnedOpaque = keys.some((key) => storage.get(key, false) === true);
    const probe = new Api({ base: normalized, token: null, domain: null });
    // A failed capabilities request is not evidence of a legacy server.
    const caps = await probe.capabilities();
    const supportsOpaque = Boolean(caps?.auth?.opaque);

    if (supportsOpaque) {
      // Pin the strongest auth mode seen; a later response cannot downgrade it.
      for (const key of keys) storage.set(key, true);
    } else if (pinnedOpaque) {
      throw authError(
        'opaque_downgrade',
        'This homeserver previously supported password-private OPAQUE sign-in but no longer advertises it. Telium will not send your password to a downgraded server.',
      );
    }

    let resp;
    let recoveryWrapper = null;
    let accountRecoveryWrapper = null;
    let recoveryKey = null;

    if (supportsOpaque) {
      const {
        enrollOpaque, loginOpaque, registerOpaque,
      } = await secureAuth();
      if (register) {
        const min = Number(caps?.registration_min_password_len) || 8;
        if (password.length < min) {
          throw new Error(`Password must be at least ${min} characters.`);
        }
        const registered = await registerOpaque(
          normalized,
          user,
          password,
          deviceName,
        );
        resp = registered.session;
        recoveryWrapper = registered.recoveryWrapper;
        if (registered.session?.recovery_key_enrolled === true) {
          accountRecoveryWrapper = registered.accountRecovery.vaultWrapper;
          recoveryKey = registered.accountRecovery.text;
        }
      } else {
        const secure = await loginOpaque(normalized, user, password, deviceName, {
          mfaCode,
          reactivate,
        });
        if (secure?.legacyUpgradeRequired) {
          // A malicious server can lie about legacy state; never auto-disclose the password.
          if (!allowLegacyAuth) {
            throw authError(
              'legacy_auth_required',
              'This account predates OPAQUE and needs one legacy password check before Telium can upgrade it.',
              { legacyKind: 'upgrade' },
            );
          }

          resp = reactivate
            ? await Api.reactivate(normalized, user, password, deviceName, mfaCode)
            : await Api.login(normalized, user, password, deviceName, mfaCode);
          if (!resp.opaque_upgrade_token) {
            throw new Error('This server did not authorize the OPAQUE account upgrade.');
          }
          const upgrading = new Api({
            base: normalized,
            token: resp.access_token,
            domain: resp.server_name || new URL(normalized).host,
          });
          const enrolled = await enrollOpaque(
            upgrading, password, resp.opaque_upgrade_token,
          );
          recoveryWrapper = enrolled.recoveryWrapper;
        } else if (!secure) {
          throw new HttpError(401, { message: 'invalid credentials' });
        } else {
          resp = secure.session;
          recoveryWrapper = secure.recoveryWrapper;
        }
      }
    } else {
      if (!allowLegacyAuth) {
        throw authError(
          'legacy_auth_required',
          'This homeserver does not advertise password-private OPAQUE authentication.',
          { legacyKind: register ? 'register' : 'server' },
        );
      }
      resp = register
        ? await Api.register(normalized, user, password, deviceName)
        : reactivate
          ? await Api.reactivate(normalized, user, password, deviceName, mfaCode)
          : await Api.login(normalized, user, password, deviceName, mfaCode);
    }

    this.authRecoveryWrapper = recoveryWrapper;
    this.accountRecoveryWrapper = accountRecoveryWrapper;
    this.opaqueAuth = supportsOpaque;
    this.sunset = activeSunset(resp.sunset);
    this.session = {
      home: {
        base: normalized,
        domain: resp.server_name || new URL(normalized).host,
        token: resp.access_token,
        user_id: resp.user_id,
        device_id: resp.device_id,
        expires_at: resp.expires_at,
        device_secret: resp.device_secret || null,
      },
      servers: {},
    };
    this.save();
    rememberSession(this.session, { touch: true });
    if (recoveryKey && typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PENDING_RECOVERY_KEY, recoveryKey);
    }
    return recoveryKey ? { ...resp, recovery_key: recoveryKey } : resp;
  },

  async confirmRecoveryKey(recoveryKey = null) {
    const pending = recoveryKey
      || (typeof sessionStorage !== 'undefined'
        ? sessionStorage.getItem(PENDING_RECOVERY_KEY)
        : null);
    if (!pending) return null;

    const {
      normalizeRecoveryKey, recoveryVaultWrapper,
    } = await import('../account-recovery.js');
    const normalized = normalizeRecoveryKey(pending);
    this.accountRecoveryWrapper = recoveryVaultWrapper(normalized);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PENDING_RECOVERY_KEY);
    }
    return normalized;
  },

  /// Replacing is one request, so a wrong password or failed write leaves the old key working.
  async enrollRecoveryKey(password, { replace = false } = {}) {
    if (!password) throw new Error('Enter your current account password.');
    if (!this.home || !this.opaqueAuth || !this.authRecoveryWrapper) {
      throw new Error('Recovery-key enrollment requires a current OPAQUE homeserver.');
    }
    if (!this.vault?.raw || this.vault.mode !== 'opaque_custody') {
      throw new Error('The encrypted recovery vault must be unlocked before enrollment.');
    }
    if (this.vault.recoveryKey && !replace) {
      throw new Error('This account already has a generated recovery key.');
    }
    if (this.vault.legacyIndependent
      || (this.vault.independent && !this.vault.recoveryKey)) {
      throw new Error('Remove the legacy independent recovery passphrase before adding a generated recovery key.');
    }

    const { generateAccountRecovery } = await import('../account-recovery.js');
    const { reauthenticateOpaque } = await secureAuth();
    const accountRecovery = generateAccountRecovery();
    const independentCiphertext = await vault.recoveryKeyCiphertext(
      this.vault,
      accountRecovery.vaultWrapper,
    );
    const enrolled = await reauthenticateOpaque(this.home, password, {
      recoveryPublicKey: accountRecovery.publicKey,
      recoveryVaultCiphertext: independentCiphertext,
      replaceRecoveryKey: replace,
    });
    if (enrolled?.recovery_key_enrolled !== true) {
      throw new Error('The homeserver did not confirm recovery-key enrollment.');
    }

    this.accountRecoveryWrapper = accountRecovery.vaultWrapper;
    this.vault = {
      ...this.vault,
      independent: true,
      recoveryKey: true,
      legacyIndependent: false,
      independentCiphertext,
    };
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(PENDING_RECOVERY_KEY, accountRecovery.text);
    }
    this.emit('vault', this.vault);
    await this.refreshCustody().catch(() => {});
    return accountRecovery.text;
  },

  /// Nothing but the signature over the server's challenge leaves this device.
  async restoreRecoveryCopy(recoveryKey) {
    if (!this.home) throw new Error('sign in before reconnecting a recovery key');
    if (!this.vault?.raw || this.vault.mode !== 'opaque_custody') {
      throw new Error('The encrypted recovery vault must be unlocked first.');
    }
    const {
      normalizeRecoveryKey, recoveryVaultWrapper, signRecoveryCopyRestore,
    } = await import('../account-recovery.js');
    const key = normalizeRecoveryKey(recoveryKey);
    const wrapper = recoveryVaultWrapper(key);
    const independentCiphertext = await vault.recoveryKeyCiphertext(this.vault, wrapper);
    const started = await this.home.recoveryCopyStart();
    const restored = await this.home.recoveryCopyFinish({
      attempt_id: started.attempt_id,
      recovery_vault_ciphertext: independentCiphertext,
      signature: signRecoveryCopyRestore(
        key, started.user_id, started.attempt_id, started.challenge, independentCiphertext,
      ),
    });
    if (restored?.recovery_copy_restored !== true) {
      throw new Error('The homeserver did not confirm the recovery copy.');
    }
    this.accountRecoveryWrapper = wrapper;
    this.vault = {
      ...this.vault,
      independent: true,
      recoveryKey: true,
      legacyIndependent: false,
      independentCiphertext,
    };
    this.emit('vault', this.vault);
    await this.refreshCustody().catch(() => {});
    return this.vault;
  },

  async resetPassword(base, user, recoveryKey, newPassword, { home = null } = {}) {
    await this.cryptoCleanup.catch(() => {});
    // A bare host is a relative base that would send credentials to the page's own server.
    const normalized = normalizeHomeserver(base) || base.replace(/\/$/, '');
    const deviceName = `web (${navigator.platform || 'browser'})`;
    const probe = new Api({ base: normalized, token: null, domain: null });
    const caps = await probe.capabilities();
    if (!caps?.auth?.opaque || !caps?.auth?.recovery_key_reset) {
      throw new Error('This homeserver does not support recovery-key password reset.');
    }
    const min = Number(caps?.registration_min_password_len) || 8;
    if (newPassword.length < min) {
      throw new Error(`Password must be at least ${min} characters.`);
    }

    const { resetPasswordOpaque } = await secureAuth();
    const recovered = await resetPasswordOpaque(
      normalized, user, recoveryKey, newPassword, deviceName,
    );
    const resp = recovered.session;
    for (const key of pinKeys(normalized, home)) storage.set(key, true);
    this.authRecoveryWrapper = recovered.recoveryWrapper;
    this.accountRecoveryWrapper = recovered.accountRecoveryWrapper;
    this.sunset = activeSunset(resp.sunset);
    this.opaqueAuth = true;
    this.session = {
      home: {
        base: normalized,
        domain: resp.server_name || new URL(normalized).host,
        token: resp.access_token,
        user_id: resp.user_id,
        device_id: resp.device_id,
        expires_at: resp.expires_at,
        device_secret: resp.device_secret || null,
      },
      servers: {},
    };
    this.save();
    rememberSession(this.session, { touch: true });
    return resp;
  },

  signOut() {
    // Hang up while there is still a session to do it with.
    for (const fn of this.awayTasks || []) {
      try { Promise.resolve(fn()).catch(() => {}); } catch {}
    }
    clearTimeout(this.fallbackTimer);
    clearInterval(this.probeTimer);
    this.fallbackTimer = null;
    this.probeTimer = null;
    this.fallback = null;
    this.gw.closeAll();
    const outgoing = this.session?.home?.user_id || null;
    const remaining = listAccounts().some((a) => a.user_id !== outgoing);
    if (remaining && outgoing) snapshot.drop(outgoing); else snapshot.clear();
    this.sync.detach();
    // Leaving group states on disk would make sign-out a lie; queued work goes up first.
    const flush = this.backup?.flush().catch(() => {});
    const leaving = this.session?.home?.user_id || null;
    const next = listAccounts().find((a) => a.user_id !== leaving) || null;
    const wipeMls = encryption()
      .then((m) => (next && leaving ? m.wipeScope(leaving) : m.wipe())).catch(() => {});
    const wipeRecovery = (next && leaving
      ? forgetDeviceSecrets(leaving) : wipeDeviceSecrets()).catch(() => {});
    this.cryptoCleanup = Promise.allSettled([
      flush || Promise.resolve(),
      wipeMls,
      wipeRecovery,
    ]);
    this.mls = null;
    this.trust = null;
    this.verifications.clear();
    this.vault = null;
    this.authRecoveryWrapper = null;
    this.accountRecoveryWrapper = null;
    this.opaqueAuth = false;
    this.backup = null;
    this.custody = null;
    const signedOutUser = this.session?.home?.user_id;
    if (signedOutUser) {
      const localDrafts = storage.get(LOCAL_DM_DRAFTS_KEY, {});
      delete localDrafts[signedOutUser];
      storage.set(LOCAL_DM_DRAFTS_KEY, localDrafts);
    }
    storage.remove(SESSION_KEY);
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PENDING_RECOVERY_KEY);
    }
    this.session = null;
    this.home = null;
    this.apis.clear();
    this.guilds.clear();
    this.channels.clear();
    this.localTyping.clear();
    this.messages.clear();
    this.coldSegments.clear();
    this.peerProfiles.clear();
    this.peerProfileTried.clear();
    this.profileWanted.clear();
    this.identities.clear();
    this.friendsLoaded = false;
    this.clearRings();
    forgetEmbeds();
    if (leaving) forgetAccount(leaving);
    if (next) {
      this.emit('switching', { name: next.card?.name || shortName(next.user_id) });
      this.cryptoCleanup.then(() => {
        activate(next.user_id);
        this.restart();
      });
      return;
    }
    this.emit('signout');
  },

  async reauthProof(password) {
    const base = this.session?.home?.base || this.home?.base || '';
    const pinnedOpaque = Boolean(base && storage.get(OPAQUE_PIN_PREFIX + base, false));
    if (this.opaqueAuth || pinnedOpaque) {
      const { reauthenticateOpaque } = await secureAuth();
      return { reauth_token: await reauthenticateOpaque(this.home, password) };
    }
    // A legacy-flow session stays legacy; a fresh capabilities response would reopen the downgrade.
    return { password };
  },
};
