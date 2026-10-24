// Bootstrap: the Store is created once, outside React, so a re-render never costs a websocket.
// Module-scope work has no error boundary; the bootstrap is wrapped and falls back to the recovery screen.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { beginBoot, noteBootFault } from './lib/local-state.js';
import { RecoveryScreen } from './views/RecoveryScreen.jsx';
import { Store } from './lib/store.js';
import { toast } from './hooks/useToast.jsx';
import { t } from './lib/i18n/index.js';
import { register, onNotificationNavigate } from './lib/serviceworker.js';
import { bindRouting } from './lib/routing.js';
import { captureHandoff } from './lib/handoff.js';
import { installDesktopRichPresence } from './lib/rich-presence.js';
import { installAndroidNotificationNavigation } from './lib/android-notification-navigation.js';
import {
  configureTransport, installTransportGuard, onTransportBypass, publishProtectedHosts,
} from './lib/net/transport.js';
import { App } from './App.jsx';
import './index.css';

// The network guard goes up first: modules that captured the original globals before the swap keep them.
try {
  installTransportGuard();
  onTransportBypass(({ url, kind }) => {
    // Loud: some code went around the chokepoint while protection was on.
    console.error(`[network privacy] refused a ${kind} to ${url} that bypassed the transport`);
  });
} catch (error) {
  console.error('[network privacy] the bypass guard could not be installed:', error);
}

const root = createRoot(document.getElementById('root'));

// Before any durable state is read; touches one localStorage key so it can run outside the guard.
beginBoot();

try {
  boot();
} catch (error) {
  console.error('Telium could not start:', error);
  noteBootFault(error?.message || String(error));
  showRecovery(error);
}

function boot() {
  let store = null;
  let unbind = [];
  let applyUpdate = null;
  let serviceWorker = null;

  const render = () => root.render(
    <StrictMode>
      <App store={store} />
    </StrictMode>,
  );

  const mount = (next) => {
    store = next;
    unbind = [
      // The desktop shell's deny guard holds a snapshot; re-send it when the mode changes.
      store.on('network-privacy', () => publishProtectedHosts()),
      installDesktopRichPresence(store),
      installAndroidNotificationNavigation(store),
      bindRouting(store),
    ];
    if (applyUpdate) store.applyUpdate = applyUpdate;
    if (serviceWorker) store.serviceWorker = serviceWorker;
    store.replace = () => {
      const prev = store;
      for (const off of unbind) off?.();
      prev.dispose();
      window.history.replaceState(null, '', '/');
      mount(new Store());
      publishProtectedHosts();
      render();
    };
    window.telium = store;
  };

  // Accessors, not copies: a cached mode would go stale and connections would obey the old answer.
  store = new Store();
  configureTransport({
    getPrefs: () => store.networkPrefs(),
    getGuilds: () => store.guilds.values(),
    getHomeDomain: () => store.session?.home?.domain || null,
    onRefusal: (domain, refusal) => store.emit('network-refusal', { domain, refusal }),
  });

  // A guided-move link carries a secret in its fragment; take it out of the address bar first.
  captureHandoff();

  mount(store);

  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.status === 401) return;
    console.error('unhandled', e.reason);
  });

  render();

  // An update is offered, not applied, so a live session is not swapped under.
  register((apply) => {
    toast(t('notifications.wake.updateToast'), { ms: 12_000 });
    applyUpdate = () => { apply(); window.location.reload(); };
    store.applyUpdate = applyUpdate;
  }).then((reg) => { serviceWorker = reg; store.serviceWorker = reg; });

  onNotificationNavigate(({ destination, guildId, channelId, conversationId }) => {
    if (destination?.type === 'conversation' || conversationId) {
      store.navigate({
        view: 'dms',
        guildId: null,
        channelId: null,
        conversationId: destination?.conversation_id || conversationId,
      });
    } else if (destination?.type === 'guild_message' || (guildId && channelId)) {
      store.navigate({
        view: 'chat',
        guildId: destination?.guild_id || guildId,
        channelId: destination?.channel_id || channelId,
        conversationId: null,
      });
    }
  });
}

/// Plain-HTML floor: no imports, framework or design-system classes, in case rendering React is what broke.
function showRecovery(error) {
  try {
    root.render(
      <RecoveryScreen
        title="Telium could not start. Something in this browser's stored data is stopping it."
        message={error?.message || String(error)}
      />,
    );
    return;
  } catch (second) {
    console.error('the recovery screen could not render either:', second);
  }

  const node = document.getElementById('root');
  if (!node) return;
  node.textContent = '';
  const html = document.createElement('div');
  html.style.cssText = 'font:14px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;line-height:1.6';
  html.innerHTML = '<h1 style="font-size:1.1rem;margin:0 0 .5rem">Telium could not start</h1>'
    + '<p style="margin:0 0 1rem">Something stored in this browser is stopping the app from opening.'
    + ' Clearing the cached copy is safe: it is rebuilt from your server on the next connection,'
    + ' and it does not touch your account, your session or your encrypted conversations.</p>';
  const button = document.createElement('button');
  button.textContent = 'Clear cached data and reload';
  button.style.cssText = 'font:inherit;padding:.5rem .9rem;border:0;border-radius:.5rem;cursor:pointer;background:#6d5ae0;color:#fff';
  button.onclick = () => {
    // Not `clearCacheState`: importing it may be what broke.
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('telium.') && key !== 'telium.session.v1'
          && key !== 'telium.accounts.v1') localStorage.removeItem(key);
      }
    } catch {}
    try { indexedDB.deleteDatabase('telium'); } catch {}
    window.location.reload();
  };
  html.append(button);
  node.append(html);
}
