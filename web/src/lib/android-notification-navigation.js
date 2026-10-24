import { isMobileTauri } from './platform.js';

let requestSerial = 0;

function bridge() {
  if (!isMobileTauri || typeof window === 'undefined') return null;
  return window.teliumAndroidNotificationBridge || null;
}

const bounded = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024;

/// Checked exactly, answering false rather than throwing: the blob comes from outside the WebView. A conversation destination names no message because the server holds only ciphertext.
function validDestination(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'guild_message') {
    return ['guild_origin', 'guild_id', 'channel_id', 'message_id']
      .every((field) => bounded(value[field]));
  }
  if (value.type === 'conversation') return bounded(value.conversation_id);
  return false;
}

function validAction(action, destination) {
  if (action == null || action === '') return true;
  return action === 'answer_call' && destination?.type === 'conversation';
}

function takeNativeDestination(timeoutMs = 3000) {
  const host = bridge();
  if (!host?.postMessage || !host?.addEventListener) return Promise.resolve(null);

  const requestId = `notification-nav-${++requestSerial}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      host.removeEventListener?.('message', onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.request_id !== requestId) return;
      if (!message.ok || !message.has_destination) {
        finish(null);
        return;
      }
      const tap = message.tap;
      if (!tap || typeof tap.user_id !== 'string' || tap.user_id.length > 1024
        || !validDestination(tap.destination) || !validAction(tap.action, tap.destination)) {
        finish(null);
        return;
      }
      finish(tap);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    host.addEventListener('message', onMessage);
    try {
      host.postMessage(JSON.stringify({ op: 'take_destination', request_id: requestId }));
    } catch {
      finish(null);
    }
  });
}

/** Route one Android notification tap into the live store, consumed only once the store is READY. */
export function installAndroidNotificationNavigation(store) {
  if (!isMobileTauri || typeof window === 'undefined') return () => {};

  let disposed = false;
  let taking = false;

  const take = async () => {
    if (disposed || taking || !store?.signedIn || !store?.me) return;
    taking = true;
    try {
      const tap = await takeNativeDestination();
      if (!tap || disposed) return;
      if (tap.user_id !== store.session?.home?.user_id) return;

      const destination = tap.destination;
      if (destination.type === 'conversation') {
        // Same `navigate` as the rest of the app: the route mounts the view that fetches the conversation and walks the MLS ratchet. Guild fields are cleared so the route doesn't describe both.
        store.navigate({
          view: 'dms',
          guildId: null,
          channelId: null,
          conversationId: destination.conversation_id,
        });
        if (tap.action === 'answer_call') {
          store.emit('android-call-answer', destination.conversation_id);
        }
        return;
      }
      if (!store.jumpTo(destination.channel_id, destination.message_id)) {
        // The channel may not be in the jump index (e.g. after a reconnect); fall back to the guild/channel destination.
        store.navigate({
          view: 'chat',
          guildId: destination.guild_id,
          channelId: destination.channel_id,
        });
      }
    } finally {
      taking = false;
    }
  };

  const offReady = store.on('ready', take);
  const onResume = () => { take(); };
  window.addEventListener('telium:resume', onResume);

  // Hot install/reload can happen after READY already fired.
  if (store.me) queueMicrotask(take);

  return () => {
    disposed = true;
    if (typeof offReady === 'function') offReady();
    window.removeEventListener('telium:resume', onResume);
  };
}
