/// `per-guild` means no global answer, distinct from `direct`.
export const GLOBAL_MODES = ['direct', 'protected', 'per-guild'];

export const MODES = ['direct', 'protected'];

export const MODE_COPY = {
  direct: {
    label: 'Direct (Recommended)',
    description: 'Connect straight to each server. Fastest, most reliable, and what '
      + 'almost everyone should use. Every server you are on learns the IP address '
      + 'your internet connection answers on, the same way every website you visit does.',
  },
  protected: {
    label: 'Protect my IP',
    description: 'Guild traffic goes through your account server, which passes it along '
      + 'without being able to read it, so guild servers see your account server instead '
      + 'of you. It hides you from guild servers only -- not from your account server, '
      + 'and not from anything listed below. Slower, and your account server learns which '
      + 'servers you talk to, when, and how much.',
  },
  'per-guild': {
    label: 'Choose per guild',
    description: 'Direct everywhere, except the guilds you mark. Use this to protect '
      + 'connections to servers you do not trust without relaying everything you do.',
  },
};

/// Absence reads as `direct`.
export const DEFAULT_NETWORK_PREFS = {
  mode: 'direct',
  guilds: {},
  autoFallback: false,
};

export function normalizeNetworkPrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const mode = GLOBAL_MODES.includes(source.mode) ? source.mode : DEFAULT_NETWORK_PREFS.mode;
  const guilds = {};
  const overrides = source.guilds && typeof source.guilds === 'object' ? source.guilds : {};
  for (const [guildId, value] of Object.entries(overrides)) {
    if (MODES.includes(value)) guilds[guildId] = value;
  }
  return { mode, guilds, autoFallback: source.autoFallback === true };
}

export function guildMode(prefs, guildId) {
  const net = normalizeNetworkPrefs(prefs);
  const override = net.guilds[guildId];
  if (override) return override;
  return net.mode === 'protected' ? 'protected' : 'direct';
}

export function guildModeSource(prefs, guildId) {
  const net = normalizeNetworkPrefs(prefs);
  return net.guilds[guildId] ? 'guild' : 'account';
}

/// Strictest guild on the host wins; only ratchets toward protection.
export function domainMode(prefs, guilds, domain) {
  const net = normalizeNetworkPrefs(prefs);
  let seen = false;
  for (const guild of guilds || []) {
    if (!guild || guild.domain !== domain) continue;
    seen = true;
    if (guildMode(net, guild.id) === 'protected') return 'protected';
  }
  if (seen) return 'direct';
  return net.mode === 'protected' ? 'protected' : 'direct';
}

export function protectedGuilds(prefs, guilds) {
  const net = normalizeNetworkPrefs(prefs);
  const out = [];
  for (const guild of guilds || []) {
    if (guild && guildMode(net, guild.id) === 'protected') out.push(guild);
  }
  return out;
}

export const REFUSAL = {
  unsupported: 'unsupported',
  outdated: 'outdated',
  unavailable: 'unavailable',
  failed: 'failed',
};

/// No silent fallback: failed protection is a refusal the person answers.
export function decide({
  prefs,
  guilds,
  domain,
  homeDomain = null,
  relay = null,
  supported = true,
  understood = true,
  allowDirectOnce = false,
}) {
  const net = normalizeNetworkPrefs(prefs);

  // The account server already knows the address; it cannot be protected.
  if (homeDomain && domain === homeDomain) {
    return { route: 'direct', refusal: null, reason: 'home' };
  }

  const wanted = domainMode(net, guilds, domain);
  if (wanted !== 'protected') return { route: 'direct', refusal: null, reason: 'chosen' };

  if (!supported) {
    if (net.autoFallback || allowDirectOnce) {
      return { route: 'direct', refusal: null, reason: 'fallback' };
    }
    return { route: 'refuse', refusal: REFUSAL.unsupported, reason: 'unsupported' };
  }
  // Checked before the relay: "too old" is more specific than "unavailable".
  if (!understood) {
    if (net.autoFallback || allowDirectOnce) {
      return { route: 'direct', refusal: null, reason: 'fallback' };
    }
    return { route: 'refuse', refusal: REFUSAL.outdated, reason: 'outdated' };
  }
  if (!relay || !relay.available) {
    if (net.autoFallback || allowDirectOnce) {
      return { route: 'direct', refusal: null, reason: 'fallback' };
    }
    return { route: 'refuse', refusal: REFUSAL.unavailable, reason: 'unavailable' };
  }
  return { route: 'protected', refusal: null, reason: 'chosen' };
}

export function refusalCopy(refusal, { domain = 'that server' } = {}) {
  switch (refusal) {
    case REFUSAL.unsupported:
      return {
        title: 'Protection is not available in a browser',
        body: `You asked to hide your IP address from ${domain}. A browser tab cannot do `
          + 'that: hiding the address means this app holding the encrypted connection '
          + 'itself, and a web page is not allowed to. The desktop app can. Until then, '
          + `connecting to ${domain} means it learns your address.`,
      };
    case REFUSAL.outdated:
      return {
        title: 'Your account server is too old to hide your address',
        body: `You asked to hide your IP address from ${domain}, which works by sending `
          + 'that traffic through your own account server. This one is running a version '
          + 'from before that existed, so there is nothing for its operator to turn on -- '
          + `it needs updating. Connecting anyway means ${domain} learns your address.`,
      };
    case REFUSAL.unavailable:
      return {
        title: 'Your account server is not offering to pass traffic along',
        body: `You asked to hide your IP address from ${domain}, which works by sending `
          + 'that traffic through your own account server. It is not offering to do that '
          + `right now. Connecting anyway means ${domain} learns your address.`,
      };
    case REFUSAL.failed:
    default:
      return {
        title: 'The protected connection could not be made',
        body: `You asked to hide your IP address from ${domain}. The connection through `
          + `your account server failed. Connecting anyway means ${domain} learns your `
          + 'address.',
      };
  }
}

export const NOT_COVERED = [
  'Voice and video calls. Those have their own setting, under Conversation signals.',
  'Your own account server, which holds your account and always sees your address.',
  'GIF search, link previews, emoji images and anything else loaded from a third party.',
  'Files you upload to an outside host, which you connect to directly.',
  'Watching a video together, which plays from the site or host it lives on.',
  'Pictures and files a guild stores on a different host than its own.',
  // The relay only carries registered origins; a stranger's homeserver goes direct.
  'Opening somebody\'s profile link, which asks their own server for the page directly.',
];

export const FOLLOW_ACCOUNT = {
  label: 'Use my account setting',
  description: 'No choice of its own. This guild does whatever Network privacy says, '
    + 'including when you change it later.',
};

export const BROWSER_NOTICE = {
  title: 'This is a browser tab, so it cannot hide your address',
  body: 'Hiding your address means this app holding the encrypted connection to the guild '
    + 'itself, and a web page is not allowed to do that. The desktop app is. You can still '
    + 'choose below, and the choice follows your account to your other devices -- but here, '
    + 'a guild you protect will not be connected to at all. You will be asked once, for that '
    + 'guild, whether to connect to it directly instead.',
};

export const AUTO_FALLBACK_COPY = {
  label: 'If protection is unavailable, connect directly automatically',
  description: 'Off by default. While it is off, a guild you protect that cannot be '
    + 'protected right now is not connected to until you say so -- once, for that guild, for '
    + 'as long as this app is open. Turning this on removes that question: connections you '
    + 'asked to protect are made in the ordinary way instead, and the guild learns your IP '
    + 'address without anything telling you it did. Turn it on only if you would rather be '
    + 'reachable than hidden.',
};

export const CALLS_ELSEWHERE = {
  label: 'Voice and video calls are a separate setting',
  description: 'This page is only about the connections that carry servers, channels and '
    + 'messages. A call reaches the other people in it another way, it is settled with them '
    + 'rather than by you alone, and nothing on this page changes it. It lives under '
    + 'Conversation signals, as Call privacy.',
  pane: 'calls',
};

export const PANE_COPY = {
  notCoveredTitle: 'What this does not protect',
  notCoveredLead: 'Whatever you choose above, these carry on the ordinary way, and whoever '
    + 'is on the other end of them learns the IP address your internet connection answers on.',
  markedTitle: 'Guilds you have marked',
  markedEmpty: 'Nothing is marked yet. Right-click a guild in the sidebar to choose for it.',
};

export function routeCopy(decision, { domain = 'this server' } = {}) {
  const reason = decision?.reason;
  if (decision?.route === 'protected') {
    return {
      label: 'Sees your account server',
      tone: 'success',
      sentence: `Connections to ${domain} go through your account server, so ${domain} sees `
        + 'that server rather than the address your internet connection answers on.',
    };
  }
  if (decision?.route === 'refuse') {
    return {
      label: 'Not connecting',
      tone: 'warn',
      sentence: `You asked to hide your address from ${domain} and that cannot be done right `
        + 'now, so nothing is being connected. You will be asked once whether to connect '
        + 'directly instead.',
    };
  }
  if (reason === 'home') {
    return {
      label: 'Sees your address',
      tone: 'default',
      sentence: 'This is your account server. It holds your account and every byte of yours '
        + 'arrives there, so it has always known your address and nothing here could hide it.',
    };
  }
  if (reason === 'fallback') {
    return {
      label: 'Sees your address',
      tone: 'warn',
      sentence: `You asked to hide your address from ${domain}, that could not be done, and a `
        + 'direct connection was made instead -- either because you allowed it for this '
        + 'session, or because automatic fallback is on under Advanced.',
    };
  }
  return {
    label: 'Sees your address',
    tone: 'default',
    sentence: `${domain} learns the IP address your internet connection answers on, the same `
      + 'way every website you visit does.',
  };
}

function names(guilds) {
  const list = guilds.map((g) => g?.name || g?.id).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

const SHARED_HOST = 'One connection serves every guild on a host, so the strictest setting '
  + 'among them decides for all of them.';

export function domainExplanation(prefs, guilds, domain, { homeDomain = null } = {}) {
  const net = normalizeNetworkPrefs(prefs);
  const here = [...(guilds || [])].filter((g) => g && g.domain === domain);
  const asking = here.filter((g) => guildMode(net, g.id) === 'protected');

  if (homeDomain && domain === homeDomain) {
    return { mode: 'direct', source: 'home', asking: [], sentence: '' };
  }

  const mode = domainMode(net, here, domain);

  if (mode === 'direct') {
    const refused = here.filter((g) => guildModeSource(net, g.id) === 'guild');
    if (net.mode === 'protected' && refused.length) {
      return {
        mode,
        source: 'guild',
        asking: [],
        sentence: `Your account setting protects every server, and you set ${names(refused)} `
          + 'back to connecting directly.',
      };
    }
    if (net.mode === 'per-guild') {
      return {
        mode,
        source: 'account',
        asking: [],
        sentence: here.length
          ? `You are choosing guild by guild and have not marked ${names(here)}.`
          : 'You are choosing guild by guild and have not marked anything on this host.',
      };
    }
    return { mode, source: 'account', asking: [], sentence: 'This is your account setting.' };
  }

  if (!asking.length) {
    return {
      mode,
      source: 'account',
      asking: [],
      sentence: 'Your account setting protects every server.',
    };
  }

  const chosen = asking.filter((g) => guildModeSource(net, g.id) === 'guild');
  if (!chosen.length) {
    return {
      mode,
      source: 'account',
      asking,
      sentence: 'Your account setting protects every server.',
    };
  }

  const carried = here.filter((g) => guildMode(net, g.id) !== 'protected');
  const because = `You asked for this on ${names(chosen)}.`;
  if (!carried.length) return { mode, source: 'guild', asking, sentence: because };
  return {
    mode,
    source: 'guild',
    asking,
    sentence: `${because} ${names(carried)} on this host ${carried.length === 1 ? 'is' : 'are'} `
      + `protected too, without having asked. ${SHARED_HOST}`,
  };
}

export function guildExplanation(prefs, guilds, guildId) {
  const net = normalizeNetworkPrefs(prefs);
  const all = [...(guilds || [])];
  const guild = all.find((g) => g && g.id === guildId) || null;
  const mode = guildMode(net, guildId);
  const source = guildModeSource(net, guildId);
  const effective = guild ? domainMode(net, all, guild.domain) : mode;
  const inherited = effective === 'protected' && mode !== 'protected';

  if (inherited) {
    const neighbours = all.filter((g) => (
      g && g.domain === guild.domain && g.id !== guildId && guildMode(net, g.id) === 'protected'
    ));
    return {
      mode,
      source,
      effective,
      inherited,
      sentence: neighbours.length
        ? `Protected anyway: ${names(neighbours)} is on the same host and you asked for it `
          + `there. ${SHARED_HOST}`
        : `Protected anyway, because of another guild on the same host. ${SHARED_HOST}`,
    };
  }

  const owned = source === 'guild';
  if (mode === 'protected') {
    return {
      mode,
      source,
      effective,
      inherited,
      sentence: owned
        ? 'Protected, because you chose it for this guild.'
        : 'Protected, because your account setting protects every server.',
    };
  }
  return {
    mode,
    source,
    effective,
    inherited,
    sentence: owned
      ? 'Direct, because you chose it for this guild.'
      : 'Direct, because that is your account setting.',
  };
}
