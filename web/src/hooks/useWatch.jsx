import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { useStore, useStoreEvent } from './useStore.jsx';
import { useVoice } from './useVoice.jsx';
import { reportError, toast } from './useToast.jsx';
import { t } from '../lib/i18n/index.js';
import {
  ClockOffset, idleTimeline, publish, supersedes, waitingOn,
} from '../lib/watch/timeline.js';
import { RATES, WATCH_LABEL, openNote, readNote, sealNote } from '../lib/watch/protocol.js';
import { narrow } from '../lib/watch/providers.js';

const WatchContext = createContext(null);

const HEARTBEAT_MS = 5000;
const PROBE_MS = 8000;

export function WatchProvider({ children }) {
  const store = useStore();
  const voice = useVoice();
  useStoreEvent('voice');

  const room = voice.channelId || null;
  const me = store.me?.user_id || '';

  const [session, setSession] = useState(null);
  const [timeline, setTimeline] = useState(idleTimeline);
  const [consented, setConsented] = useState(null);
  const [stalls, setStalls] = useState(() => new Map());
  const [allowed, setAllowed] = useState(null);

  const roomRef = useRef(room);
  const sessionRef = useRef(null);
  const lineRef = useRef(idleTimeline());
  const clocksRef = useRef(new Map());
  const stallsRef = useRef(new Map());
  const stalledRef = useRef(false);
  const toldRef = useRef(new Set());

  const sealedRoom = useCallback((id) => Boolean(id) && !store.channels.get(id), [store]);

  const roster = useCallback(
    (id) => (id ? (store.voice.get(id) || []).map((v) => v.user_id) : []),
    [store],
  );

  const speaksForRoom = useCallback((id, excluding = null) => {
    const here = roster(id).filter((u) => u !== excluding).sort();
    return here.length > 0 && here[0] === me;
  }, [roster, me]);

  const sendTo = useCallback(async (target, note) => {
    const id = roomRef.current;
    if (!id || !target || target === me) return;
    const api = store.voiceApi(id);
    if (!api) return;
    let payload = { watch: note };
    if (sealedRoom(id)) {
      const secret = await store.mls?.callSecret(id, WATCH_LABEL).catch(() => null);
      if (!secret || roomRef.current !== id) return;
      payload = {
        watch_sealed: await sealNote(
          secret.key, { conversationId: id, sender: me, epoch: secret.epoch }, note,
        ),
      };
    }
    await api.voiceSignal(id, { target, payload }).catch(() => {});
  }, [store, me, sealedRoom]);

  const sendAll = useCallback(async (note) => {
    const id = roomRef.current;
    await Promise.all(roster(id).filter((u) => u !== me).map((u) => sendTo(u, note)));
  }, [roster, me, sendTo]);

  const clockFor = useCallback((userId) => {
    let held = clocksRef.current.get(userId);
    if (!held) {
      held = { filter: new ClockOffset(), seed: 0 };
      clocksRef.current.set(userId, held);
    }
    return held;
  }, []);

  const offsetFor = useCallback((userId) => {
    const held = clocksRef.current.get(userId);
    if (!held) return 0;
    return held.filter.ready ? held.filter.offset : held.seed;
  }, []);

  const seedClock = useCallback((userId, theirStamp) => {
    if (!userId || userId === me || !Number.isFinite(theirStamp)) return;
    const held = clockFor(userId);
    if (!held.filter.ready) held.seed = theirStamp - Date.now();
  }, [clockFor, me]);

  const applyLine = useCallback((line) => {
    if (!supersedes(line, lineRef.current)) return;
    lineRef.current = line;
    setTimeline(line);
    seedClock(line.by, line.at);
  }, [seedClock]);

  const forget = useCallback(() => {
    sessionRef.current = null;
    lineRef.current = idleTimeline();
    clocksRef.current = new Map();
    stallsRef.current = new Map();
    stalledRef.current = false;
    toldRef.current = new Set();
    setSession(null);
    setTimeline(idleTimeline());
    setStalls(new Map());
    setConsented(null);
  }, []);

  const adopt = useCallback((next) => {
    sessionRef.current = next;
    lineRef.current = idleTimeline();
    stallsRef.current = new Map();
    stalledRef.current = false;
    toldRef.current = new Set();
    setSession(next);
    setStalls(new Map());
    setTimeline(lineRef.current);
    setConsented(null);
  }, []);

  const receive = useCallback((from, note) => {
    if (!note || !from || from === me) return;
    const held = sessionRef.current;

    if (note.k === 'state') {
      if (!held) {
        adopt({ id: note.id, source: note.source, by: note.by || from });
        applyLine(note.timeline);
      }
      else if (held.id !== note.id) {
        if (note.id > held.id) return;
        adopt({ id: note.id, source: note.source, by: note.by || from });
        applyLine(note.timeline);
      }
      return;
    }

    if (!held || held.id !== note.id) return;

    switch (note.k) {
      case 'line': applyLine(note.timeline); break;
      case 'end': forget(); break;
      case 'ping':
        sendTo(from, { k: 'pong', id: note.id, t0: note.t0, t1: Date.now() }).catch(() => {});
        break;
      case 'pong':
        clockFor(from).filter.note(note.t0, note.t1, Date.now());
        break;
      case 'stall': {
        const next = new Map(stallsRef.current);
        if (note.on) { if (!next.has(from)) next.set(from, Date.now()); } else next.delete(from);
        stallsRef.current = next;
        setStalls(next);
        break;
      }
      default: break;
    }
  }, [me, adopt, applyLine, forget, sendTo, clockFor]);

  useEffect(() => store.on('voice-signal', async (d) => {
    const id = roomRef.current;
    if (!id || (d.channel_id && d.channel_id !== id)) return;
    if (d.payload?.watch) { receive(d.from, readNote(d.payload.watch)); return; }
    const sealed = d.payload?.watch_sealed;
    if (!sealed) return;
    const secret = await store.mls?.callSecret(id, WATCH_LABEL).catch(() => null);
    if (!secret || roomRef.current !== id) return;
    receive(d.from, await openNote(
      secret.key, { conversationId: id, sender: d.from, epoch: secret.epoch }, sealed,
    ));
  }), [store, receive]);

  const drive = useCallback((change) => {
    const held = sessionRef.current;
    if (!held) return;
    const line = publish(lineRef.current, { by: me, now: Date.now(), ...change });
    lineRef.current = line;
    setTimeline(line);
    sendAll({ k: 'line', id: held.id, timeline: line }).catch(() => {});
  }, [me, sendAll]);

  const control = useMemo(() => ({
    play: (position) => drive({ position, paused: false }),
    pause: (position) => drive({ position, paused: true }),
    seek: (position) => drive({ position }),
    rate: (rate, position) => { if (RATES.includes(rate)) drive({ position, rate }); },
  }), [drive]);

  const start = useCallback(async (source) => {
    const id = roomRef.current;
    if (!id || !source) return;
    const next = { id: `${Date.now().toString(36)}:${me}`, source, by: me };
    adopt(next);
    setConsented(next.id);
    await sendAll({ k: 'state', id: next.id, source, by: me, timeline: lineRef.current })
      .catch((e) => reportError(e, t('voice.watch.startFailed')));
  }, [me, adopt, sendAll]);

  const end = useCallback(() => {
    const held = sessionRef.current;
    if (!held) return;
    sendAll({ k: 'end', id: held.id }).catch(() => {});
    forget();
  }, [sendAll, forget]);

  const leave = useCallback(() => {
    forget();
  }, [forget]);

  const consent = useCallback(() => {
    const held = sessionRef.current;
    if (held) setConsented(held.id);
  }, []);

  const setStalled = useCallback((on) => {
    const held = sessionRef.current;
    if (!held || stalledRef.current === Boolean(on)) return;
    stalledRef.current = Boolean(on);
    sendAll({ k: 'stall', id: held.id, on: Boolean(on) }).catch(() => {});
    if (on && !lineRef.current.paused) drive({ position: lineRef.current.position, paused: true });
  }, [sendAll, drive]);

  // Bounded so a stalled player cannot hold the room forever.
  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      const verdict = waitingOn(stallsRef.current, Date.now());
      if (!verdict.abandoned.length) return;
      const next = new Map(stallsRef.current);
      for (const user of verdict.abandoned) next.delete(user);
      stallsRef.current = next;
      setStalls(next);
      if (!speaksForRoom(roomRef.current) || !lineRef.current.paused) return;
      drive({ position: lineRef.current.position, paused: false });
      toast(t('voice.watch.gaveUpWaiting'));
    }, 1000);
    return () => clearInterval(id);
  }, [session, speaksForRoom, drive]);

  useEffect(() => {
    if (!session) return undefined;
    const id = setInterval(() => {
      if (lineRef.current.by !== me) return;
      sendAll({ k: 'line', id: session.id, timeline: lineRef.current }).catch(() => {});
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [session, me, sendAll]);

  const publisher = timeline.by;
  useEffect(() => {
    if (!session || !publisher || publisher === me) return undefined;
    const probe = () => {
      sendTo(publisher, { k: 'ping', id: session.id, t0: Date.now() }).catch(() => {});
    };
    probe();
    const id = setInterval(probe, PROBE_MS);
    return () => clearInterval(id);
  }, [session, publisher, me, sendTo]);

  const here = roster(room);
  const rosterKey = [...here].sort().join(',');
  useEffect(() => {
    if (!sessionRef.current || !roomRef.current) return;
    const present = roster(roomRef.current);
    for (const user of present) {
      if (user === me || toldRef.current.has(user)) continue;
      toldRef.current.add(user);
      if (!speaksForRoom(roomRef.current, user)) continue;
      const held = sessionRef.current;
      sendTo(user, { k: 'state', id: held.id, source: held.source, by: held.by, timeline: lineRef.current })
        .catch(() => toldRef.current.delete(user));
    }
    for (const user of [...toldRef.current]) if (!present.includes(user)) toldRef.current.delete(user);
    if (stallsRef.current.size) {
      const next = new Map([...stallsRef.current].filter(([u]) => present.includes(u)));
      if (next.size !== stallsRef.current.size) {
        stallsRef.current = next;
        setStalls(next);
      }
    }
  }, [rosterKey, session, me, roster, speaksForRoom, sendTo]);

  useEffect(() => {
    if (roomRef.current === room) return;
    roomRef.current = room;
    forget();
  }, [room, forget]);

  useEffect(() => {
    let live = true;
    if (!store.home?.mediaRegistry) { setAllowed(narrow(null)); return undefined; }
    store.home.mediaRegistry()
      .then((registry) => { if (live) setAllowed(narrow(registry)); })
      .catch(() => { if (live) setAllowed(narrow(null)); });
    return () => { live = false; };
  }, [store, store.home]);

  const holding = useMemo(() => waitingOn(stalls, Date.now()), [stalls]);

  const value = {
    room,
    session,
    timeline,
    sealed: sealedRoom(room),
    allowed,
    consented: Boolean(session && consented === session.id),
    consent,
    control,
    start,
    end,
    leave,
    setStalled,
    offsetFor,
    holding,
  };

  return <WatchContext.Provider value={value}>{children}</WatchContext.Provider>;
}

export function useWatch() {
  const ctx = useContext(WatchContext);
  if (!ctx) throw new Error('useWatch called outside a WatchProvider');
  return ctx;
}
