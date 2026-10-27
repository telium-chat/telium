import { describe, expect, it, vi } from 'vitest';
import {
  defaultLifetime, generateKeyPackage, getCiphersuiteFromName, getCiphersuiteImpl,
} from 'ts-mls';
import { GuildCallKeys, committerOf, planChange } from '../lib/guild-call-keys.js';
import { capabilities } from '../lib/mls.js';

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const te = new TextEncoder();
const hex = (b) => Array.from(b || [], (x) => x.toString(16).padStart(2, '0')).join('');

async function engine(cs, userId, deviceId, { vouches = () => true } = {}) {
  const credential = { credentialType: 'basic', identity: te.encode(`${userId}|${deviceId}`) };
  const first = await generateKeyPackage(credential, capabilities(), defaultLifetime, [], cs);
  const pair = {
    signKey: first.privatePackage.signaturePrivateKey,
    publicKey: first.publicPackage.leafNode.signaturePublicKey,
  };
  return {
    cs, userId, deviceId,
    credential: () => credential,
    signatureKeyPair: async () => pair,
    verifyClaimedPackage: async (u, d) => vouches(u, d),
  };
}

class FakeCall {
  constructor(channelId) {
    this.channelId = channelId;
    this.groupId = 'g1';
    this.epoch = 0;
    this.seats = new Map();
    this.clock = 0;
    this.away = new Set();
    this.faults = [];
    this.held = [];
    this.log = [];
    this.committer = null;
    this.asked = [];
  }

  relay(event) {
    for (const [user, s] of this.seats) {
      if (!this.away.has(user)) s.keys.hear(event);
      else this.held.push({ user, event });
    }
  }

  elect() {
    const holder = this.seats.get(this.committer);
    if (!holder?.member) {
      const next = committerOf(this.roster());
      if (next !== this.committer) this.name(next);
    }
    return this.committer;
  }

  name(user) {
    this.committer = user;
    if (user) this.relay({ op: 'committer', channel_id: this.channelId, group_id: this.groupId, committer: user });
  }

  deliver(user) {
    const keys = this.seats.get(user).keys;
    const mine = this.held.filter((h) => h.user === user);
    this.held = this.held.filter((h) => h.user !== user);
    for (const { event } of mine) keys.hear(event);
    return keys.chain;
  }

  fault() {
    const f = this.faults.shift();
    if (f === 'down') throw Object.assign(new Error('Failed to fetch'), { status: 0 });
    return f;
  }

  roster() {
    return [...this.seats.entries()].map(([user_id, s]) => ({
      user_id, e2ee_member: s.member, joined_at: s.joined_at,
    }));
  }

  api(me) {
    return {
      voiceE2ee: async () => {
        this.fault();
        this.asked.push(me);
        const mine = this.seats.get(me);
        return {
          group_id: this.groupId,
          epoch: this.epoch,
          committer: this.elect(),
          standing: mine?.member ? 'member' : mine?.refused ? 'refused' : 'pending',
          participants: [...this.seats.entries()].map(([user_id, s]) => ({
            user_id, device_id: s.device_id, member: s.member, refused: Boolean(s.refused),
            key_package: s.member || s.refused ? null : s.key_package,
          })),
        };
      },
      voiceE2eeCommits: async (_, since) => {
        this.fault();
        return {
          group_id: this.groupId,
          epoch: this.epoch,
          oldest: this.log[0]?.epoch ?? null,
          commits: this.log.filter((c) => c.epoch > since),
        };
      },
      voiceE2eeRefuse: async (_, body) => {
        const s = this.seats.get(body.user_id);
        if (!s || s.member || s.key_package !== body.key_package) return { refused: false };
        s.refused = true;
        this.relay({ op: 'refused', channel_id: this.channelId, user_id: body.user_id });
        return { refused: true };
      },
      voiceE2eeCommit: async (_, body) => {
        const fault = this.fault();
        const committer = this.elect();
        if (me && committer && committer !== me) {
          throw Object.assign(new Error('not yours'), { status: 409, body: { code: 'not_committer', committer } });
        }
        if (body.group_id !== this.groupId || body.epoch !== this.epoch) {
          throw Object.assign(new Error('moved on'), { status: 409 });
        }
        this.epoch += 1;
        const added = [];
        for (const a of body.added) {
          const s = this.seats.get(a.user_id);
          if (s && !s.member && s.key_package === a.key_package) { s.member = true; added.push(a.user_id); }
        }
        const event = {
          op: 'commit', channel_id: this.channelId, group_id: this.groupId, epoch: this.epoch,
          commit: body.commit, welcome: body.welcome, added, by: me,
        };
        this.log.push(event);
        this.relay(event);
        if (fault === 'lost') throw Object.assign(new Error('Failed to fetch'), { status: 0 });
        return { epoch: this.epoch, added };
      },
    };
  }

  async join(mls, options = {}) {
    const keys = new GuildCallKeys({
      mls, api: this.api(mls.userId), channelId: this.channelId, me: mls.userId,
      roster: () => this.roster(),
      onTrouble: (e) => { keys.trouble = e; },
      onLost: (e) => { keys.lostWith = e; },
      retryMs: 5, grace: 5, vouchBackoff: [1, 1],
      ...options,
    });
    const founder = this.seats.size === 0;
    this.seats.set(mls.userId, {
      device_id: mls.deviceId, key_package: await keys.offer(),
      member: founder, joined_at: (this.clock += 1), keys,
    });
    await keys.begin({ group_id: this.groupId, epoch: this.epoch, member: founder });
    await this.tend();
    return keys;
  }

  leave(userId) {
    this.seats.get(userId).keys.stop();
    this.seats.delete(userId);
    this.elect();
    return this.tend();
  }

  async tend() {
    const all = [...this.seats.values()].map((s) => s.keys);
    await Promise.all(all.map((k) => k.tend()));
    await Promise.all(all.map((k) => k.chain));
  }
}

describe('guild call keys', () => {
  it('names the longest-standing member as the one who commits', () => {
    expect(committerOf([
      { user_id: 'b', e2ee_member: true, joined_at: 2 },
      { user_id: 'a', e2ee_member: false, joined_at: 1 },
      { user_id: 'c', e2ee_member: true, joined_at: 2 },
    ])).toBe('b');
    expect(committerOf([])).toBe(null);
  });

  it('drops a leaf whose owner left, moved device or is waiting again, and adds whoever waits', () => {
    const leaves = [
      { index: 0, userId: 'me', deviceId: 'd' },
      { index: 1, userId: 'gone', deviceId: 'd' },
      { index: 2, userId: 'moved', deviceId: 'old' },
      { index: 3, userId: 'back', deviceId: 'd' },
      { index: 4, userId: 'stays', deviceId: 'd' },
    ];
    const plan = planChange(leaves, [
      { user_id: 'me', device_id: 'd', member: true },
      { user_id: 'moved', device_id: 'new', member: false, key_package: 'p1' },
      { user_id: 'back', device_id: 'd', member: false, key_package: 'p2' },
      { user_id: 'stays', device_id: 'd', member: true },
      { user_id: 'fresh', device_id: 'd', member: false, key_package: 'p3' },
    ], 'me');
    expect(plan.removes).toEqual([1, 2, 3]);
    expect(plan.adds.map((p) => p.user_id)).toEqual(['moved', 'back', 'fresh']);
  });

  it('gives everyone in the call the same key, and a new one when somebody leaves', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    expect(alice.epoch).toBe(0);

    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;
    expect(alice.epoch).toBe(1);
    expect(bob.epoch).toBe(1);
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));

    const carol = await call.join(await engine(cs, 'carol', 'c1'));
    await Promise.all([bob.chain, carol.chain]);
    expect([alice.epoch, bob.epoch, carol.epoch]).toEqual([2, 2, 2]);
    expect(hex(carol.latest.raw)).toBe(hex(alice.latest.raw));
    const withBob = hex(alice.latest.raw);

    await call.leave('bob');
    await carol.chain;
    expect([alice.epoch, carol.epoch]).toEqual([3, 3]);
    expect(hex(carol.latest.raw)).toBe(hex(alice.latest.raw));
    expect(hex(alice.latest.raw)).not.toBe(withBob);
    expect(alice.trouble || carol.trouble).toBeUndefined();
  });

  it('leaves out a device its account never signed', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const vouches = (u) => u !== 'mallory';
    const alice = await call.join(await engine(cs, 'alice', 'a1', { vouches }));
    const mallory = await call.join(await engine(cs, 'mallory', 'm1', { vouches }));
    expect(alice.epoch).toBe(0);
    expect(mallory.state).toBe(null);
  });

  it('keys media to the channel and the group, never a conversation label', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const one = new FakeCall('chan-1');
    const two = new FakeCall('chan-2');
    const a = await one.join(await engine(cs, 'alice', 'a1'));
    const b = await two.join(await engine(cs, 'alice', 'a1'));
    expect(hex(a.latest.raw)).not.toBe(hex(b.latest.raw));
  });

  it('reads back the commit a reconnect cost it, rather than being readmitted', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;

    call.away.add('bob');
    const carol = await call.join(await engine(cs, 'carol', 'c1'));
    await carol.chain;
    call.away.delete('bob');
    expect([alice.epoch, bob.epoch, carol.epoch]).toEqual([2, 1, 2]);

    await bob.check();
    expect(bob.epoch).toBe(2);
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
    expect(bob.lostWith || bob.trouble).toBeUndefined();
  });

  it('fills a gap in the commits it heard from the server', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;
    call.away.add('bob');
    await call.join(await engine(cs, 'carol', 'c1'));
    call.away.delete('bob');
    const dave = await call.join(await engine(cs, 'dave', 'd1'));
    await bob.chain;
    expect(bob.epoch).toBe(3);
    expect(hex(bob.latest.raw)).toBe(hex(dave.latest.raw));
    expect(bob.lostWith || bob.trouble).toBeUndefined();
  });

  it('is readmitted when the commits it missed are older than the server keeps', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;
    call.away.add('bob');
    await call.join(await engine(cs, 'carol', 'c1'));
    call.away.delete('bob');
    call.log = call.log.filter((c) => c.epoch > 2);
    await call.join(await engine(cs, 'dave', 'd1'));
    await bob.chain;
    expect(bob.lostWith).toBeTruthy();
    expect(bob.trouble).toBeUndefined();
  });

  it('finds the Welcome it never got in the server\'s log', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    call.away.delete('bob');
    expect(call.seats.get('bob').member).toBe(true);
    expect(bob.state).toBe(null);
    await bob.check();
    expect(bob.epoch).toBe(1);
    expect(bob.lostWith || bob.trouble).toBeUndefined();
  });

  it('asks the server when its Welcome is late, and joins from the log', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'), { welcomeMs: 20 });
    call.away.delete('bob');
    call.held = [];
    await vi.waitFor(() => expect(bob.epoch).toBe(1));
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
    expect(bob.lostWith || bob.trouble).toBeUndefined();
  });

  it('gives its seat up at once when the server says it was refused', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let open = false;
    await call.join(await engine(cs, 'alice', 'a1', { vouches: (u) => open || u !== 'bob' }));
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'), { welcomeMs: 20 });
    call.seats.get('bob').refused = true;
    open = true;
    await vi.waitFor(() => expect(bob.lostWith).toBeTruthy());
    expect(call.asked.filter((u) => u === 'bob')).toHaveLength(1);
  });

  it('tells the server a package it will never add, so its owner stops waiting', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    const keys = new GuildCallKeys({
      mls: await engine(cs, 'mallory', 'm1'), api: call.api('mallory'), channelId: 'chan', me: 'mallory',
      roster: () => call.roster(), onLost: (e) => { keys.lostWith = e; }, retryMs: 5, grace: 5, welcomeMs: 1000,
    });
    await keys.offer();
    call.seats.set('mallory', {
      device_id: 'm1', key_package: 'AAAA', member: false, joined_at: (call.clock += 1), keys,
    });
    await keys.begin({ group_id: call.groupId, epoch: call.epoch, member: false });
    await call.tend();
    await vi.waitFor(() => expect(keys.lostWith).toBeTruthy());
    expect(call.seats.get('mallory').refused).toBe(true);
    expect(call.epoch).toBe(0);
  });

  it('lets the member the server names write the commit, and only them', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;
    call.away.add('alice');
    call.name('bob');
    await bob.chain;
    expect(bob.committer).toBe('bob');
    expect(alice.committer).not.toBe('bob');
    const carol = await call.join(await engine(cs, 'carol', 'c1'));
    await carol.chain;
    expect(carol.epoch).toBe(2);
    expect(call.log.at(-1).by).toBe('bob');
    expect(alice.committer).toBe('bob');
    call.away.delete('alice');
    await call.deliver('alice');
    expect(alice.epoch).toBe(2);
    expect(hex(alice.latest.raw)).toBe(hex(carol.latest.raw));
    expect(alice.trouble || bob.trouble || carol.trouble).toBeUndefined();
  });

  it('leaves a device that is in step alone when asked', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await bob.chain;
    await Promise.all([alice.check(), bob.check()]);
    expect(alice.lostWith || bob.lostWith).toBeUndefined();
  });

  it('asks again when an account lookup fails, rather than ending the call', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let flaky = 2;
    const vouches = (u) => {
      if (u === 'bob' && flaky > 0) { flaky -= 1; throw new Error('Failed to fetch'); }
      return true;
    };
    const alice = await call.join(await engine(cs, 'alice', 'a1', { vouches }));
    const bob = await call.join(await engine(cs, 'bob', 'b1', { vouches }));
    await bob.chain;
    expect([alice.epoch, bob.epoch]).toEqual([1, 1]);
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
    expect(alice.trouble || bob.trouble).toBeUndefined();
  });

  it('tries a commit again after a failed request, rather than ending the call', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    call.faults.push('down');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await vi.waitFor(() => expect(bob.epoch).toBe(1));
    await bob.chain;
    expect(alice.epoch).toBe(1);
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
    expect(alice.trouble).toBeUndefined();
  });

  it('takes its own commit back from the relay when the answer to it was lost', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    call.faults.push(undefined, 'lost');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    await Promise.all([alice.chain, bob.chain]);
    expect([alice.epoch, bob.epoch]).toEqual([1, 1]);
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
    expect(alice.trouble || alice.lostWith).toBeUndefined();
  });
  it('stays in a call whose member it could not check yet, and asks again', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let reachable = false;
    const unreachable = (u) => {
      if (u === 'bob' && !reachable) throw Object.assign(new Error('Bad gateway'), { status: 502 });
      return true;
    };
    const alice = await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    const carol = await call.join(await engine(cs, 'carol', 'c1', { vouches: unreachable }));
    await carol.chain;
    expect(carol.epoch).toBe(2);
    expect(hex(carol.latest.raw)).toBe(hex(alice.latest.raw));
    expect(carol.trouble).toBeUndefined();
    expect(carol.doubts.size).toBe(1);

    reachable = true;
    await vi.waitFor(() => expect(carol.doubts.size).toBe(0));
    expect(carol.trouble || bob.trouble).toBeUndefined();
  });

  it('leaves once a member it could not check turns out never signed', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let answer = 'none';
    const vouches = (u) => {
      if (u !== 'bob') return true;
      if (answer === 'none') throw Object.assign(new Error('Failed to fetch'), { status: 0 });
      return false;
    };
    await call.join(await engine(cs, 'alice', 'a1'));
    await call.join(await engine(cs, 'bob', 'b1'));
    const carol = await call.join(await engine(cs, 'carol', 'c1', { vouches }));
    await carol.chain;
    expect(carol.trouble).toBeUndefined();
    answer = 'no';
    await vi.waitFor(() => expect(carol.trouble?.message).toMatch(/never signed/));
  });

  it('does not trust a member it can never check', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const vouches = (u) => {
      if (u === 'bob') throw Object.assign(new Error('Service unavailable'), { status: 503 });
      return true;
    };
    await call.join(await engine(cs, 'alice', 'a1'));
    await call.join(await engine(cs, 'bob', 'b1'));
    const carol = await call.join(await engine(cs, 'carol', 'c1', { vouches }), { doubtMs: 30 });
    await carol.chain;
    expect(carol.epoch).toBe(2);
    await vi.waitFor(() => expect(carol.trouble?.message).toMatch(/could reach bob/));
  });

  it('is not readmitted when it caught up while the server moved on again', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    const bob = await call.join(await engine(cs, 'bob', 'b1'), { grace: 300 });
    await bob.chain;

    call.away.add('bob');
    await call.join(await engine(cs, 'carol', 'c1'));
    const checking = bob.check();
    await bob.chain;
    await call.deliver('bob');
    expect(bob.epoch).toBe(2);
    await call.join(await engine(cs, 'dave', 'd1'));
    expect(call.epoch).toBe(3);

    await checking;
    expect(bob.lostWith).toBeUndefined();
  });

  it('finds its Welcome in the log when it is the committer and holds nothing', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    call.away.delete('bob');
    expect(bob.state).toBe(null);
    await call.leave('alice');
    expect(committerOf(call.roster())).toBe('bob');
    await vi.waitFor(() => expect(bob.epoch).toBe(2));
    expect(call.log.at(-1).by).toBe('bob');
    expect(bob.lostWith || bob.trouble).toBeUndefined();
  });

  it('asks to be readmitted when the Welcome it was sent will not open', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    call.away.delete('bob');
    await bob.offer();
    await call.deliver('bob');
    expect(bob.state).toBe(null);
    await vi.waitFor(() => expect(bob.lostWith).toBeTruthy());
    expect(bob.trouble).toBeUndefined();
  });

  it('notices a group it was never told about from the announcement alone', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    await call.join(await engine(cs, 'alice', 'a1'));
    // Bob joins while unreachable: the group moves on without him ever hearing.
    call.away.add('bob');
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    call.away.delete('bob');
    expect(bob.state).toBe(null);

    // The group is re-founded elsewhere. The first bob hears of it is an
    // announcement naming a group he holds nothing from — that alone must
    // make him ask the server where things stand, not wait for a roster move.
    call.groupId = 'g2';
    const asked = call.asked.filter((who) => who === 'bob').length;
    call.relay({ op: 'committer', channel_id: 'chan', group_id: 'g2', committer: 'carol' });
    await vi.waitFor(() => expect(bob.lostWith).toBeTruthy());
    expect(call.asked.filter((who) => who === 'bob').length).toBeGreaterThan(asked);
    expect(bob.trouble).toBeUndefined();
  });

  it('asks to be readmitted when nobody adds it, and only then', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    const vouches = (u) => u !== 'mallory';
    await call.join(await engine(cs, 'alice', 'a1', { vouches }));
    const bob = await call.join(await engine(cs, 'bob', 'b1'), { welcomeMs: 150 });
    const mallory = await call.join(await engine(cs, 'mallory', 'm1'), { welcomeMs: 150 });
    expect(mallory.lostWith).toBeUndefined();
    await vi.waitFor(() => expect(mallory.lostWith).toBeTruthy());
    await new Promise((r) => { setTimeout(r, 200); });
    expect(bob.epoch).toBe(1);
    expect(bob.lostWith).toBeUndefined();
  });

  it('adds a joiner again after leaving it out for an account check', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let noes = 3;
    const vouches = (u) => {
      if (u === 'bob' && noes > 0) { noes -= 1; return false; }
      return true;
    };
    const alice = await call.join(await engine(cs, 'alice', 'a1', { vouches }));
    const bob = await call.join(await engine(cs, 'bob', 'b1'));
    expect(bob.state).toBe(null);
    await vi.waitFor(() => expect(bob.epoch).toBe(1));
    await bob.chain;
    expect(hex(bob.latest.raw)).toBe(hex(alice.latest.raw));
  });

  it('does nothing once stopped, even halfway through', async () => {
    const cs = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
    const call = new FakeCall('chan');
    let answer;
    const pending = new Promise((r) => { answer = r; });
    const vouches = (u) => (u === 'bob' ? pending : true);
    await call.join(await engine(cs, 'alice', 'a1'));
    await call.join(await engine(cs, 'bob', 'b1'));
    const onKey = vi.fn();
    const onLost = vi.fn();
    const onTrouble = vi.fn();
    const carol = new GuildCallKeys({
      mls: await engine(cs, 'carol', 'c1', { vouches }), api: call.api(), channelId: 'chan', me: 'carol',
      roster: () => call.roster(), onKey, onLost, onTrouble, retryMs: 5, grace: 5, vouchBackoff: [1, 1], welcomeMs: 1000,
    });
    call.seats.set('carol', {
      device_id: 'c1', key_package: await carol.offer(), member: false, joined_at: (call.clock += 1), keys: carol,
    });
    await carol.begin({ group_id: call.groupId, epoch: call.epoch, member: false });
    const tending = call.tend();
    await vi.waitFor(() => expect(call.epoch).toBe(2));
    carol.stop();
    answer(true);
    await tending;
    await carol.chain;
    await new Promise((r) => { setTimeout(r, 40); });
    expect(onKey).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
    expect(onTrouble).not.toHaveBeenCalled();
    expect(carol.state).toBe(null);
  });
});
