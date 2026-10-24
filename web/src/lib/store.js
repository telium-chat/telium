// `home` is the account server; `servers` maps guild hosts, each with its own token and socket. Methods are mixed in from lib/store/.

import { rememberSession } from './accounts.js';
import { ConnectionManager, Status } from './gateway.js';
import { KEYS, SyncStore } from './sync.js';
import { debounce, Emitter, storage } from './util.js';
import { readStored } from './local-state.js';
import {
  OPAQUE_PIN_PREFIX, PENDING_RECOVERY_KEY,
  RENEW_EVERY_MS, RENEW_MIN_GAP_MS, SESSION_KEY,
} from './store/shared.js';
import { callMethods } from './store/calls.js';
import { dispatchMethods } from './store/dispatch.js';
import { dmMethods } from './store/dms.js';
import { friendMethods } from './store/friends.js';
import { guildMethods } from './store/guilds.js';
import { lifecycleMethods } from './store/lifecycle.js';
import { permissionMethods } from './store/permissions.js';
import { prefsMethods } from './store/prefs.js';
import { routeMethods } from './store/route.js';
import { serverMethods } from './store/servers.js';
import { sessionMethods } from './store/session.js';
import { signalMethods } from './store/signals.js';
import { timelineMethods } from './store/timeline.js';
import { trustMethods } from './store/trust.js';

export { DEFAULT_INTENTS } from './store/shared.js';

/// Checks only what boot dereferences unguarded; older sessions lack newer fields and must still load.
function validSession(value) {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const home = value.home;
  if (home !== null && home !== undefined) {
    if (typeof home !== 'object' || Array.isArray(home)) return false;
    if (typeof home.base !== 'string' || !home.base) return false;
    if (home.token !== null && home.token !== undefined && typeof home.token !== 'string') return false;
  }
  const servers = value.servers;
  if (servers === null || servers === undefined) return true;
  if (typeof servers !== 'object' || Array.isArray(servers)) return false;
  return Object.values(servers).every(
    (entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

let instances = 0;

export class Store extends Emitter {
  constructor() {
    super();
    this.session = readStored(SESSION_KEY, validSession);
    if (this.session?.home?.token) rememberSession(this.session);
    this.on('me', () => this.rememberCard());
    // Another tab changing account must not have its shared slots overwritten by this one.
    this.instance = ++instances;
    this.disposed = false;
    this.unlisten = [];
    const listen = (target, event, fn) => {
      target.addEventListener(event, fn);
      this.unlisten.push(() => target.removeEventListener(event, fn));
    };
    if (typeof window !== 'undefined') {
      listen(window, 'storage', (event) => {
        if (event.key !== SESSION_KEY) return;
        let incoming = null;
        try { incoming = JSON.parse(event.newValue)?.home?.user_id || null; } catch { /* unreadable */ }
        const current = this.session?.home?.user_id || null;
        if (incoming !== current && (incoming || current)) this.restart();
      });
    }
    this.sync = new SyncStore();
    this.sync.onLoad = () => {
      this.sweepMutes();
      this.emit('prefs');
      this.emit('gif-favorites');
      this.emit('saved-stickers');
    };
    this.home = null;
    this.apis = new Map();
    this.renewals = new Map();
    this.renewedAt = new Map();
    this.gw = new ConnectionManager();
    this.fallback = null;            // { standby, base, gateway, status, since }
    this.migrationAlerts = [];       // moves of this account still in their cooling-off window
    this.recoveryEmail = null;       // the recovery address's state, as the home last said it
    this.fallbackTimer = null;       // home has been down this long -- look for a copy
    this.probeTimer = null;          // is the primary back yet
    // A new sign-in waits for the sign-out wipe so it can't erase fresh crypto state.
    this.cryptoCleanup = Promise.resolve();
    this.me = null;

    this.guilds = new Map();
    this.channels = new Map();
    this.messages = new Map();
    this.hasMore = new Map();
    this.coldSegments = new Map();
    this.channelPins = new Map();
    this.pinNotices = new Map();
    this.members = new Map();
    this.memberWindows = new Map();
    this.presence = new Map();
    this.typing = new Map();
    this.localTyping = new Map();
    this.dmTyping = new Map();
    this.readState = new Map();
    this.reading = null;
    this.threads = new Map();
    this.voice = new Map();
    this.ringing = new Map();
    this.ringTimers = new Map();
    this.declinedCalls = new Set();
    this.outgoingCalls = new Map();
    this.callStartedAt = new Map();
    this.callConnected = new Set();
    this.callLogs = new Map();
    this.watchers = new Map();
    this.roles = new Map();
    this.permWrites = new Map();
    this.emojis = new Map();
    this.stickers = new Map();
    this.expressionData = new Map();
    this.expressionLoads = new Map();
    this.conversations = [];
    this.startingDms = new Map();
    this.friends = new Map();
    this.peerProfiles = new Map();
    // `true`: held or in flight; number: when a refusal came back, so a transient failure can retry. See `fetchIdentity`.
    this.peerProfileTried = new Map();   // user_id -> true | refused-at ms
    this.profileWanted = new Set();
    this.identities = new Map();
    this.mutuals = new Map();
    this.mutualsAsked = new Map();    // user_id -> the lookup, while it runs
    this.mutualsRetries = new Map();  // user_id -> incomplete answers so far
    this.friendsLoaded = false;
    this.dmFrames = new Map();
    this.dmOpened = new Map();
    this.dmLoading = new Map();
    this.dmPending = new Map();
    this.dmPendingFull = new Set();
    // Sends in flight; the gateway can echo a frame before the send returns (see `onDmFrame`).
    this.sending = new Set();
    this.dmSyncRetrying = new Set();
    // Not on conversation rows: the home keeps no DM read cursor and `refreshConversations` replaces them.
    this.dmUnread = new Map();
    this.mls = null;
    this.signalFlushes = new Map();
    this.typedAt = new Map();
    this.trust = null;
    this.trustStart = null;
    this.verifications = new Map();
    this.vault = null;
    this.authRecoveryWrapper = null;
    this.accountRecoveryWrapper = null;
    this.opaqueAuth = Boolean(
      this.session?.home?.base
      && storage.get(OPAQUE_PIN_PREFIX + this.session.home.base, false),
    );
    this.backup = null;
    this.custody = null;
    // Rejoin asks that failed, by error; the DM view must not claim one was made.
    this.rejoinBlocked = new Map();
    this.dmMended = new Set();
    this.caps = new Map();
    this.mediaPreference = { tier: 1, origin: null };
    this.externalMediaHosts = [];
    this.gofilePlaybackProxy = true;

    this.cachedAt = null;

    this.route = { view: 'chat', guildId: null, channelId: null, conversationId: null };
    this.pendingJump = null;
    this.committedSearch = null;

    this.gw.on('ready', (e) => this.onReady(e));
    this.gw.on('status', (e) => {
      this.emit('status', e);
      this.watchHome(e);
      // A rejected token needs a new one; waiting won't help.
      if (e.status !== Status.Rejected) return;
      if (Date.now() - (this.renewedAt.get(e.domain) || 0) < RENEW_MIN_GAP_MS) return;
      this.renewServer(e.domain).catch(() => {});
    });
    this.gw.on('dispatch', (e) => this.onDispatch(e));

    const persist = debounce(() => this.persist(), 1000);
    for (const event of ['guilds', 'channels', 'roles', 'message', 'history', 'unread', 'conversations']) {
      this.on(event, persist);
    }

    const wake = () => {
      this.freshenSessions();
      this.gw.wake();
    };
    listen(document, 'visibilitychange', () => {
      if (!document.hidden) wake();
    });
    // Emitted by Android MainActivity.onResume(); visibilitychange doesn't fire there.
    listen(window, 'telium:resume', wake);
    listen(window, 'online', () => { this.emit('status', {}); wake(); });
    listen(window, 'offline', () => this.emit('status', {}));
    this.renewTimer = setInterval(() => this.freshenSessions(), RENEW_EVERY_MS);
  }

  /// Nothing here may write to the shared browser slots after a switch hands the page to another account.
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.gw.closeAll();
    this.sync.retire();
    for (const off of this.unlisten.splice(0)) off();
    clearInterval(this.renewTimer);
    clearTimeout(this.fallbackTimer);
    clearInterval(this.probeTimer);
    clearTimeout(this.muteSweep);
    clearTimeout(this.membersReread);
    this.clearRings();
    this.handlers.clear();
  }

  get prefs() { return this.sync.get(KEYS.prefs); }

  get signedIn() {
    const pendingRecovery = typeof sessionStorage !== 'undefined'
      && sessionStorage.getItem(PENDING_RECOVERY_KEY);
    return !!this.session?.home?.token && !pendingRecovery;
  }

}

// Accessors stay in the class body: `Object.assign` would call a getter and freeze its result.
Object.assign(
  Store.prototype,
  sessionMethods,
  lifecycleMethods,
  prefsMethods,
  serverMethods,
  guildMethods,
  permissionMethods,
  dispatchMethods,
  callMethods,
  dmMethods,
  signalMethods,
  trustMethods,
  timelineMethods,
  friendMethods,
  routeMethods,
);

export { Status };
