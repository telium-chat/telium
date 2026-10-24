import { Mls } from '../lib/mls.js';
import { frameIdOf } from '../lib/frame-id.js';


export class FakeHome {
  constructor() {
    this.stock = new Map();
    this.lastResort = new Map();
    this.frames = new Map();
    this.epochs = new Map();
    this.generations = new Map();
    this.seq = 0;
    this.as = null;
    this.cross = new Map();
    this.vouched = new Map();
    this.endorsed = new Map();
    this.identities = new Map();
    this.revocations = new Map();
    this.mirror = new Map();
    this.mirrorClock = 0;
    this.notificationHints = [];
    this.domain = 'home.example';
  }

  mirrorFor(userId) {
    if (!this.mirror.has(userId)) this.mirror.set(userId, new Map());
    return this.mirror.get(userId);
  }

  vouchedFor(userId) {
    if (!this.vouched.has(userId)) this.vouched.set(userId, new Map());
    return this.vouched.get(userId);
  }

  endorsedBy(signer) {
    if (!this.endorsed.has(signer)) this.endorsed.set(signer, new Map());
    return this.endorsed.get(signer);
  }

  device(userId, deviceId) {
    if (!this.stock.has(userId)) this.stock.set(userId, new Map());
    const devices = this.stock.get(userId);
    if (!devices.has(deviceId)) devices.set(deviceId, []);
    return devices.get(deviceId);
  }

  for(userId, deviceId) {
    const home = this;
    return {
      domain: home.domain,
      conversation: async (id) => ({ id, kind: 'dm' }),
      reportMemberships: async () => ({ ok: true }),
      keyPackages: async () => ({
        available: home.device(userId, deviceId).length,
        devices: [...(home.stock.get(userId) || new Map())].map(([id, list]) => ({
          device_id: id, available: list.length,
          last_resort: home.lastResort.has(`${userId}|${id}`),
        })),
      }),
      publishKeyPackages: async (packages, lastResort = null) => {
        home.device(userId, deviceId).push(...packages);
        if (lastResort) home.lastResort.set(`${userId}|${deviceId}`, lastResort);
        return { published: packages.length };
      },
      claimKeyPackages: async (target) => ({
        user_id: target,
        key_packages: [...(home.stock.get(target) || new Map())].map(([id, list]) => {
          const once = list.shift();
          const fallback = once ? null : home.lastResort.get(`${target}|${id}`) ?? null;
          return { device_id: id, package: once ?? fallback, last_resort: !!fallback };
        }),
      }),
      crossSigning: async () => ({
        exists: home.cross.has(userId),
        ...(home.cross.get(userId) || {}),
        devices: [...home.vouchedFor(userId).values()],
        signatures: [...home.endorsedBy(userId).values()],
        revocations: [...(home.revocations.get(userId) || [])],
      }),
      putCrossSigning: async (body) => {
        const protectedIdentity = home.identities.get(userId);
        if (protectedIdentity?.exists && protectedIdentity.current_key !== body.identity_key) {
          const err = new Error('identity continuity blocks direct replacement');
          err.status = 409;
          throw err;
        }
        home.cross.set(userId, body);
        return { ok: true };
      },
      identityContinuity: async () => home.identities.get(userId) || {
        exists: false, user_id: userId,
      },
      anchorIdentity: async (body) => {
        const doc = {
          exists: true,
          user_id: userId,
          immutable_id: body.immutable_id,
          genesis_key: body.identity_key,
          anchor_signature: body.signature,
          current_key: body.identity_key,
          sequence: 0,
          current_policy_version: 0,
          transitions: [],
          recovery_policies: [],
        };
        home.identities.set(userId, doc);
        return doc;
      },
      identityDocument: async (target) => home.identities.get(target) || {
        exists: false, user_id: target,
      },
      signDevice: async (id, body) => {
        home.vouchedFor(userId).set(id, {
          device_id: id, mls_key: body.mls_key, cross_sig: body.signature,
        });
        return { ok: true };
      },
      signUser: async (subject, body) => {
        home.endorsedBy(userId).set(subject, { subject, ...body, signed_at: home.seq });
        return { ok: true };
      },
      unsignUser: async (subject) => { home.endorsedBy(userId).delete(subject); return { ok: true }; },
      deviceList: async (target) => ({
        user_id: target,
        identity_key: home.cross.get(target)?.identity_key || null,
        devices: [...home.vouchedFor(target).values()],
        revocations: [...(home.revocations.get(target) || [])],
      }),
      revokeDevice: async (id, body = null) => {
        const row = home.vouchedFor(userId).get(id);
        home.vouchedFor(userId).delete(id);
        if (body?.mls_key) {
          const doc = home.identities.get(userId);
          const list = home.revocations.get(userId) || [];
          list.push({
            device_id: id, mls_key: body.mls_key, signature: body.signature,
            immutable_id: doc?.immutable_id || null,
            signer_key: doc?.current_key || home.cross.get(userId)?.identity_key || null,
            revoked_at: home.seq,
          });
          home.revocations.set(userId, list);
        }
        return { ok: true, revoked: row ? [id] : [] };
      },
      rotateIdentity: async (body) => {
        const doc = home.identities.get(userId);
        const transition = {
          sequence: body.sequence,
          previous_key: body.previous_key,
          new_key: body.new_key,
          authorization_kind: body.authorization?.kind,
          authorization: body.authorization,
          new_key_signature: body.new_key_signature ?? null,
        };
        const next = {
          ...doc,
          current_key: body.new_key,
          sequence: body.sequence,
          transitions: [...(doc.transitions || []), transition],
        };
        home.identities.set(userId, next);
        home.cross.set(userId, {
          ...(home.cross.get(userId) || {}), identity_key: body.new_key, sealed_secret: body.sealed_secret,
        });
        const vouched = home.vouchedFor(userId);
        for (const row of vouched.values()) row.cross_sig = null;
        for (const d of body.device_signatures || []) {
          vouched.set(d.device_id, { device_id: d.device_id, mls_key: d.mls_key, cross_sig: d.signature });
        }
        return next;
      },
      putBackup: async (items) => {
        for (const item of items) {
          home.mirrorClock += 1;
          home.mirrorFor(userId).set(`${item.scope}/${item.item}`, {
            ...item, updated_at: home.mirrorClock,
          });
        }
        return { stored: items.length };
      },
      backup: async ({ scope, after = 0, limit = 256 } = {}) => {
        const rows = [...home.mirrorFor(userId).values()]
          .filter((r) => (!scope || r.scope === scope) && r.updated_at > after)
          .sort((a, b) => a.updated_at - b.updated_at)
          .slice(0, limit);
        return {
          scope,
          items: rows,
          cursor: rows.length ? rows[rows.length - 1].updated_at : after,
          complete: rows.length < limit,
        };
      },
      dropBackup: async (scope) => {
        for (const [key, row] of [...home.mirrorFor(userId)]) {
          if (!scope || row.scope === scope) home.mirrorFor(userId).delete(key);
        }
        return { ok: true };
      },
      dmNotificationKeys: async (conversationId) => ({
        hint_origin: `dm:${conversationId}`,
        targets: [],
        complete: true,
      }),
      sendDmNotificationHints: async (conversationId, body) => {
        home.notificationHints.push({
          conversation_id: conversationId,
          user_id: userId,
          device_id: deviceId,
          ...body,
        });
        return { ok: true };
      },
      dmHistory: async (conversationId, { after = 0, limit = 100, tail = 0 } = {}) => {
        const above = [...(home.frames.get(conversationId) || [])]
          .filter((f) => (f.seq || 0) > (after || 0))
          .sort((a, b) => (a.seq || 0) - (b.seq || 0));
        if (tail) {
          return {
            conversation_id: conversationId,
            messages: above.slice(-Math.min(Math.max(tail, 1), 500)),
          };
        }
        let page = above.slice(0, Math.min(Math.max(limit || 100, 1), 500));
        const holes = [...(home.missing?.get(conversationId) || [])]
          .filter((seq) => seq > (after || 0)).sort((a, b) => a - b);
        if (holes.length && page.some((f) => f.seq >= holes[0])) {
          page = page.filter((f) => f.seq < holes[0]);
          return {
            conversation_id: conversationId, messages: page,
            incomplete: true, missing_from: holes[0],
          };
        }
        return { conversation_id: conversationId, messages: page };
      },
      sendFrame: async (conversationId, body) => {
        const list = home.frames.get(conversationId) || [];
        const fault = home.faults?.length
          && (!home.faults[0].kind || home.faults[0].kind === body.kind)
          ? home.faults.shift() : null;
        const fail = () => {
          const err = new Error(`fault ${fault.status}`);
          err.status = fault.status;
          err.body = { error: 'injected' };
          return err;
        };
        if (fault?.when === 'before') throw fail();
        if (body.frame_id) {
          const prior = list.find((f) => f.frame_id === body.frame_id);
          if (prior) {
            if (prior.ciphertext !== body.ciphertext || prior.sender_device !== deviceId) {
              const reused = new Error('frame id reused');
              reused.status = 409;
              reused.body = { code: 'frame_id_reused', seq: prior.seq };
              throw reused;
            }
            const welcome = prior.kind === 'commit'
              ? list.find((f) => f.seq === prior.seq + 1 && f.kind === 'welcome'
                && f.sender_device === deviceId)
              : null;
            return { ...prior, replayed: true, ...(welcome ? { welcome } : {}) };
          }
        }
        const current = home.generations.get(conversationId) || 0;
        const conflict = () => {
          const err = new Error('this frame belongs to a group the conversation has replaced');
          err.status = 409;
          err.body = { code: 'generation_conflict', generation: current };
          return err;
        };
        let generation = current;
        if (body.start_over) {
          if (body.generation !== current) throw conflict();
          generation = current + 1;
        } else if (body.generation !== undefined) {
          if (body.generation !== current) throw conflict();
        } else if (body.kind === 'welcome' && Number(body.epoch) === 1
          && (home.epochs.get(conversationId) || 0) !== 1) {
          generation = current + 1;
        }
        if (generation !== current) {
          home.generations.set(conversationId, generation);
          home.epochs.set(conversationId, 1);
        }
        if (body.kind === 'commit') {
          const at = home.epochs.get(conversationId) || 0;
          if (Number(body.epoch) !== at + 1) {
            const stale = new Error('this commit was not built on the conversation\'s current epoch');
            stale.status = 409;
            const winner = list.findLast((f) => f.kind === 'commit'
              && Number(f.epoch) === Number(body.epoch));
            stale.body = {
              code: 'epoch_conflict',
              epoch: at,
              ...(winner ? {
                winner_seq: winner.seq,
                winner_epoch: Number(winner.epoch),
                winner_sender: winner.sender,
                winner_digest: frameIdOf(winner.ciphertext),
                ...(winner.frame_id ? { winner_frame_id: winner.frame_id } : {}),
              } : {}),
            };
            throw stale;
          }
          home.epochs.set(conversationId, Number(body.epoch));
        }
        if (!home.frames.has(conversationId)) home.frames.set(conversationId, []);
        const { welcome, change, start_over: _startOver, ...rest } = body;
        const take = (fields) => {
          home.seq += 1;
          const frame = {
            id: `f${home.seq}`,
            conversation_id: conversationId,
            seq: home.frames.get(conversationId).length + 1,
            sender: userId,
            sender_device: deviceId,
            created_at: home.seq,
            ...fields,
            generation,
          };
          home.frames.get(conversationId).push(frame);
          return frame;
        };
        const frame = take(rest);
        if (change) home.changes = [...(home.changes || []), { conversationId, seq: frame.seq, change }];
        const welcomed = welcome && body.kind === 'commit'
          ? take({ kind: 'welcome', ciphertext: welcome, epoch: body.epoch })
          : null;
        if (fault?.when === 'after') throw fail();
        return welcomed ? { ...frame, welcome: welcomed } : frame;
      },
    };
  }
}

export async function device(home, userId, deviceId, recoveryKey = null, backup = null) {
  const mls = new Mls(home.for(userId, deviceId), { userId, deviceId, recoveryKey, backup });
  await mls.start();
  return mls;
}
