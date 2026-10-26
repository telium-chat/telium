/* eslint-env serviceworker */
// App shell cache and push; API responses are never cached (authenticated, per-user).

const VERSION = self.__PRECACHE_VERSION__;
const SHELL = self.__PRECACHE__;
const CACHE = `telium-shell-${VERSION}`;
// The cached page that boots the app. Same file the precache carries; the portal build
// renames it, so it is a placeholder rather than a literal.
const SHELL_URL = self.__SHELL_URL__ ?? '/index.html';
importScripts('/notification-inbox-runtime.js');
const notificationInbox = self.TeliumNotificationInboxRuntime;

// Emitted verbatim by vite.config.js, so it cannot import the catalogue; the page posts strings in.
// The worker cannot ask the page: a push wakes it with no tab open and needs a prompt notification.
// Strings live in the Cache API, separate from the shell cache `activate` deletes, so a new build keeps the reader's language.
const STRINGS = 'telium-strings';
const STRINGS_URL = '/_telium-sw/strings';

/// Duplicated from `lib/i18n/catalog/en/notifications.js`; `sw-strings.test.js` fails on drift.
const FALLBACK = {
  title: 'Telium',
  migration: 'A move of your account was requested. Open Telium to review or cancel it.',
  activity: 'New activity in a channel you follow.',
};

async function strings() {
  try {
    const cache = await caches.open(STRINGS);
    const hit = await cache.match(STRINGS_URL);
    if (!hit) return FALLBACK;
    const stored = await hit.json();
    const out = { ...FALLBACK };
    for (const key of Object.keys(FALLBACK)) {
      if (typeof stored?.[key] === 'string' && stored[key]) out[key] = stored[key];
    }
    return out;
  } catch {
    return FALLBACK;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // `STRINGS` is exempt: it holds the language, not build assets.
    await Promise.all(names
      .filter((n) => n !== CACHE && n !== STRINGS)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// 'skip-waiting' stays a bare string: the old build sends it, so the wire format is frozen.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') { self.skipWaiting(); return; }
  if (event.data?.type !== 'strings') return;
  const posted = event.data.strings;
  if (!posted || typeof posted !== 'object') return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(STRINGS);
      await cache.put(STRINGS_URL, new Response(JSON.stringify(posted), {
        headers: { 'Content-Type': 'application/json' },
      }));
    } catch {}
  })());
});

function isShellAsset(url) {
  return url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest';
}

// The paths the client routes itself. Offline navigation to one of them falls back to the
// cached shell; the rest of the origin -- on the portal, the marketing site -- is
// network-only, because the cached shell is the app, not that page.
const APP_ROUTES = ['/channels', '/invite', '/u', '/login'];

function isAppRoute(pathname) {
  return APP_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The protocol surface is never cached: it is authenticated, and some of it is a websocket upgrade.
  if (url.pathname.startsWith('/_telium/')
    || url.pathname.startsWith('/gateway')
    || url.pathname.startsWith('/.well-known/')) return;

  if (request.mode === 'navigate') {
    const app = isAppRoute(url.pathname);
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (app && (await caches.match(SHELL_URL))) || Response.error();
      }
    })());
    return;
  }

  if (!isShellAsset(url)) return;
  event.respondWith((async () => {
    const hit = await caches.match(request);
    if (hit) return hit;
    const resp = await fetch(request);
    if (resp.ok) (await caches.open(CACHE)).put(request, resp.clone());
    return resp;
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const tag = data.channel_id ? `channel:${data.channel_id}` : 'telium';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focused = clients.some((c) => c.focused);
    if (data.type === 'wake' && notificationInbox) {
      const registration = await notificationInbox.loadActiveRegistration().catch(() => null);
      if (registration) {
        try {
          await notificationInbox.drainNotificationInbox(registration, {
            onNotification: async (notification) => {
              if (focused) return;
              await self.registration.showNotification(notification.title, {
                body: notification.body,
                tag: notification.tag,
                renotify: false,
                requireInteraction: Boolean(notification.requireInteraction),
                data: { destination: notification.destination },
              });
            },
          });
          return;
        } catch {
        }
      }
    }
    if (focused) return;
    // Read after the focused check so a silent push never touches storage.
    const words = await strings();
    if (data.type === 'migration') {
      await self.registration.showNotification(words.title, {
        body: words.migration,
        tag: `migration:${data.migration_id || ''}`,
        renotify: true,
        requireInteraction: true,
        data,
      });
      return;
    }
    await self.registration.showNotification(words.title, {
      body: words.activity,
      tag,
      renotify: false,
      data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const destination = data.destination || null;
  const guildId = destination?.guild_id || data.guild_id || null;
  const channelId = destination?.channel_id || data.channel_id || null;
  const conversationId = destination?.conversation_id || data.conversation_id || null;
  // The app's own front door: on the portal, `/` is the marketing site.
  let target = '/channels/@me';
  if ((destination?.type === 'conversation' || conversationId) && conversationId) {
    target = `/channels/@me/${encodeURIComponent(conversationId)}`;
  } else if ((destination?.type === 'guild_message' || (guildId && channelId)) && guildId && channelId) {
    target = `/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(channelId)}`;
  }
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        client.postMessage({ type: 'navigate', destination, guildId, channelId, conversationId });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
