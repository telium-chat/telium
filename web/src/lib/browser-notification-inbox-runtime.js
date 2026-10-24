(function installTeliumNotificationInboxRuntime(root) {
  const ALGORITHM = 'P256-HKDF-SHA256-A256GCM';
  const DB_NAME = 'telium-notification-inbox-v1';
  const STORE = 'registrations';
  const ACTIVE = 'active';
  const PREFIX = new TextEncoder().encode('telium-notification-v1');
  const INFO_PREFIX = new TextEncoder().encode('Telium notification v1\0');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function concat(...parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function encodedPart(value) {
    const bytes = encoder.encode(String(value ?? ''));
    const size = new Uint8Array(4);
    new DataView(size.buffer).setUint32(0, bytes.length, false);
    return concat(size, bytes);
  }

  function notificationAad(userId, deviceId, origin, sourceId, guildId, kind) {
    return concat(
      PREFIX,
      encodedPart(userId),
      encodedPart(deviceId),
      encodedPart(origin),
      encodedPart(sourceId),
      encodedPart(guildId || ''),
      encodedPart(kind),
    );
  }

  function encode64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function decode64(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new Error('Malformed notification envelope.');
    }
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }

  function requireScope(scope) {
    if (!scope?.home_base || !scope?.user_id || !scope?.device_id) {
      throw new Error('Browser notification enrollment needs the current Telium device.');
    }
    return {
      home_base: scope.home_base,
      user_id: scope.user_id,
      device_id: scope.device_id,
    };
  }

  function sameScope(left, right) {
    return Boolean(left && right
      && left.home_base === right.home_base
      && left.user_id === right.user_id
      && left.device_id === right.device_id);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open notification storage.'));
    });
  }

  async function idb(mode, action) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let result;
        try { result = action(store); } catch (error) { reject(error); return; }
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = () => reject(tx.error || new Error('Notification storage failed.'));
        tx.onabort = () => reject(tx.error || new Error('Notification storage was aborted.'));
      });
    } finally {
      db.close();
    }
  }

  async function saveActiveRegistration(registration) {
    requireScope(registration);
    await idb('readwrite', (store) => store.put(registration, ACTIVE));
  }

  async function loadActiveRegistration() {
    return idb('readonly', (store) => store.get(ACTIVE));
  }

  async function clearActiveRegistration(scope = null) {
    const current = await loadActiveRegistration().catch(() => null);
    if (!current) return false;
    if (scope && !sameScope(current, requireScope(scope))) return false;
    await idb('readwrite', (store) => store.delete(ACTIVE));
    return true;
  }

  function envelopeForRow(row) {
    if (row?.kind === 'dm_hint') return row?.ciphertext?.envelope;
    return row?.ciphertext;
  }

  async function decryptInboxRow(row, registration) {
    const scope = requireScope(registration);
    const envelope = envelopeForRow(row);
    if (!row?.id || !row?.origin || !row?.source_id || !row?.kind || !envelope) {
      throw new Error('Malformed notification row.');
    }
    if (envelope.v !== 1 || envelope.alg !== ALGORITHM) {
      throw new Error('Unsupported notification envelope.');
    }
    const ephemeral = decode64(envelope.ephemeral);
    const salt = decode64(envelope.salt);
    const nonce = decode64(envelope.nonce);
    const ciphertext = decode64(envelope.ciphertext);
    if (ephemeral.length !== 65 || ephemeral[0] !== 0x04 || salt.length !== 16 || nonce.length !== 12) {
      throw new Error('Malformed notification envelope.');
    }
    if (!registration.private_key || registration.private_key.type !== 'private') {
      throw new Error('Browser notification private key is unavailable.');
    }
    const peer = await crypto.subtle.importKey(
      'raw', ephemeral, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    const shared = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peer }, registration.private_key, 256,
    ));
    const associatedData = notificationAad(
      scope.user_id,
      scope.device_id,
      row.origin,
      row.source_id,
      row.guild_id || '',
      row.kind,
    );
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const rawKey = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: concat(INFO_PREFIX, associatedData),
    }, hkdf, 256));
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: nonce, additionalData: associatedData, tagLength: 128,
    }, key, ciphertext);
    let descriptor;
    try { descriptor = JSON.parse(decoder.decode(plaintext)); } catch {
      throw new Error('Notification descriptor is malformed.');
    }
    if (descriptor?.v !== 1 || descriptor?.kind !== row.kind) {
      throw new Error('Notification descriptor does not match its inbox row.');
    }
    return descriptor;
  }

  function notificationForInboxRow(row, descriptor, now = Date.now()) {
    if (descriptor?.v !== 1 || descriptor?.kind !== row?.kind) {
      throw new Error('Notification descriptor does not match its inbox row.');
    }
    if (row.kind === 'dm_hint') {
      const conversationId = row?.ciphertext?.conversation_id;
      if (!conversationId || row.origin !== `dm:${conversationId}`) {
        throw new Error('DM notification destination does not match its inbox row.');
      }
      if (descriptor.notify === 0) return { silent: true };
      if (descriptor.notify !== 1) throw new Error('DM notification policy is malformed.');
      return {
        title: 'Telium',
        body: 'Encrypted message',
        tag: `conversation:${conversationId}`,
        destination: { type: 'conversation', conversation_id: conversationId },
      };
    }
    if (row.kind === 'mention' || row.kind === 'reply') {
      const destination = descriptor.destination;
      if (destination?.type !== 'guild_message'
        || destination.guild_origin !== row.origin
        || destination.guild_id !== row.guild_id
        || destination.message_id !== row.source_id
        || !destination.channel_id) {
        throw new Error('Guild notification destination does not match its inbox row.');
      }
      return {
        title: 'Telium',
        body: row.kind === 'reply' ? 'New reply in a channel you follow.' : 'New mention in a channel.',
        tag: `channel:${destination.channel_id}`,
        destination,
      };
    }
    if (row.kind === 'incoming_call') {
      const destination = descriptor.destination;
      const createdAt = Number(descriptor.created_at);
      if (destination?.type !== 'conversation' || !destination.conversation_id || !Number.isFinite(createdAt)) {
        throw new Error('Incoming call notification is malformed.');
      }
      if (createdAt <= 0 || now - createdAt > 60_000) return { silent: true };
      return {
        title: 'Telium',
        body: 'Incoming call',
        tag: `call:${destination.conversation_id}`,
        requireInteraction: true,
        destination,
      };
    }
    if (row.kind === 'migration') {
      if (row.guild_id != null) throw new Error('Migration notification row is malformed.');
      return {
        title: 'Telium',
        body: 'A move of your account was requested. Open Telium to review or cancel it.',
        tag: `migration:${row.source_id}`,
        requireInteraction: true,
        destination: { type: 'home' },
      };
    }
    throw new Error(`Unsupported notification kind: ${row.kind}`);
  }

  async function drainNotificationInbox(registration, options = {}) {
    const scope = requireScope(registration);
    if (!registration.background_token) throw new Error('Notification credential is unavailable.');
    const fetchImpl = options.fetchImpl || fetch;
    const onNotification = options.onNotification || (async () => {});
    let processed = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await fetchImpl(`${scope.home_base}/_telium/v1/notifications?limit=50`, {
        headers: { Authorization: `Telium-Notification ${registration.background_token}` },
      });
      if (!response.ok) throw new Error(`Notification inbox pull failed (${response.status}).`);
      const payload = await response.json();
      const rows = Array.isArray(payload?.notifications) ? payload.notifications : [];
      let through = null;
      let blocked = false;
      for (const row of rows) {
        try {
          const descriptor = await decryptInboxRow(row, registration);
          const notification = notificationForInboxRow(row, descriptor, options.now?.() ?? Date.now());
          if (!notification.silent) await onNotification(notification, row, descriptor);
          through = row.id;
          processed += 1;
        } catch {
          blocked = true;
          break;
        }
      }
      if (through) {
        const ack = await fetchImpl(`${scope.home_base}/_telium/v1/notifications/ack`, {
          method: 'POST',
          headers: {
            Authorization: `Telium-Notification ${registration.background_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ through }),
        });
        if (!ack.ok) throw new Error(`Notification inbox ack failed (${ack.status}).`);
      }
      if (blocked || rows.length < 50) return { processed, blocked };
    }
    return { processed, blocked: false };
  }

  root.TeliumNotificationInboxRuntime = {
    ALGORITHM,
    encode64,
    requireScope,
    sameScope,
    notificationAad,
    saveActiveRegistration,
    loadActiveRegistration,
    clearActiveRegistration,
    decryptInboxRow,
    notificationForInboxRow,
    drainNotificationInbox,
  };
}(globalThis));
