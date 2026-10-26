// Maps the store's route to a path and back (`/channels/<guild>/<channel>`, `/channels/@me/<conversation>`, `/invite/<code>`, `/invite/<code>@<server>`, `/u/<user-id>`). Pure.

const DM = '@me';

/// A route with nothing chosen: the shape the others are built from, not a destination.
export const BLANK = { view: 'chat', guildId: null, channelId: null, conversationId: null };

/// Where the app opens and where an unrecognised path falls back to. `/` isn't kept as an address; the bar is rewritten to match. DMs with none open is the friends list.
export const HOME = { ...BLANK, view: 'dms' };

export function pathFor(route = {}) {
  const seg = (s) => encodeURIComponent(s);
  // Keep the Matrix user-id separators readable while encoding the rest.
  const profileId = (s) => seg(s).replace(/%40/gi, '@').replace(/%3A/gi, ':');
  if (route.view === 'invite' && route.inviteCode) {
    const code = seg(route.inviteCode);
    // A server after an `@` is the portal form: the link stays one segment, and the
    // server reads as itself the way a user id does.
    return route.inviteServer ? `/invite/${code}@${profileId(route.inviteServer)}` : `/invite/${code}`;
  }
  if (route.view === 'profile-link' && route.userId) return `/u/${profileId(route.userId)}`;
  if (route.view === 'dms') {
    return route.conversationId ? `/channels/${DM}/${seg(route.conversationId)}` : `/channels/${DM}`;
  }
  if (!route.guildId) return '/';
  return route.channelId
    ? `/channels/${seg(route.guildId)}/${seg(route.channelId)}`
    : `/channels/${seg(route.guildId)}`;
}

/// Neither voice nor forum is in the URL; the route says `chat` and the shell corrects it once the channel loads.
export function routeFrom(pathname) {
  const parts = decodeURI(pathname || '/').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { ...HOME };
  if (parts[0] === 'invite' && parts.length === 2 && parts[1]) {
    // Invite codes and vanity aliases contain no `@`, so one is a portal separator.
    // The server half is not validated here: a malformed name is routing's to carry
    // and the invite screen's to refuse with a sentence.
    const at = parts[1].lastIndexOf('@');
    if (at > 0) {
      return {
        ...BLANK,
        view: 'invite',
        inviteCode: parts[1].slice(0, at),
        inviteServer: parts[1].slice(at + 1),
      };
    }
    return { ...BLANK, view: 'invite', inviteCode: parts[1], inviteServer: null };
  }
  if (parts[0] === 'u' && parts.length === 2 && /^@[^:]+:.+$/.test(parts[1])) {
    return { ...BLANK, view: 'profile-link', userId: parts[1] };
  }
  if (parts[0] !== 'channels' || parts.length > 3) return null;
  if (parts[1] === DM) {
    return { ...BLANK, view: 'dms', conversationId: parts[2] || null };
  }
  if (!parts[1]) return null;
  return { ...BLANK, guildId: parts[1], channelId: parts[2] || null };
}

/// Store -> URL via `store.navigate` events; URL -> store via `popstate`, which matches the path so nothing is pushed.
export function bindRouting(store, win = window) {
  const { history, location } = win;
  const apply = () => store.navigate(routeFrom(location.pathname) || { ...HOME });

  apply();
  // Rewritten in place rather than pushed, so Back still leaves the app.
  const canonical = pathFor(store.route);
  if (canonical !== location.pathname) history.replaceState(null, '', canonical);

  const off = store.on('route', (route) => {
    const path = pathFor(route);
    if (path !== location.pathname) history.pushState(null, '', path);
  });
  win.addEventListener('popstate', apply);
  return () => { off(); win.removeEventListener('popstate', apply); };
}
