import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent } from './useStore.jsx';
import { useModal } from './useModal.jsx';
import { reportError, toast } from './useToast.jsx';
import { callE2EE, MeshCall, mediaKeyBehind, SfuCall } from '../lib/voice.js';
import { GuildCallKeys } from '../lib/guild-call-keys.js';
import {
  effectivePosture, icePolicy, MEDIA_LABEL, noteHello, openHello, rank, refusalCode, sealHello,
  SIGNAL_LABEL, wantsSfu,
} from '../lib/callmode.js';
import {
  displayAudioFailureReason, displayAudioSupport, withScreenShareConstraints,
} from '../lib/screenShare.js';
import { neuralCapability, normalizeNoiseMode } from '../lib/denoise.js';
import { chooseVoiceRegion } from '../lib/voiceRegion.js';
import { ScreenShareDialog } from '../views/dialogs/ScreenShareDialog.jsx';
import {
  isAndroid,
  isElectronRuntime,
  setAndroidCallActive,
  subscribeAndroidCallControls,
} from '../lib/platform.js';
import { t, tOrNull } from '../lib/i18n/index.js';
import {
  DESKTOP_AUDIO_INPUT_KEY,
  DesktopAudioDevices,
} from '../components/DesktopAudioDevices.jsx';
import {
  applyDesktopAudioOutput, desktopAudioPreference, playCallTone, switchCallInput,
} from './voice/callAudio.js';

const VoiceContext = createContext(null);

export const PING_WINDOW = 40;

export const RETAKE_WINDOW_MS = 60_000;

export const CATCH_UP_WAIT_MS = 3000;

export function recordPing(history, ping) {
  if (ping == null) return history;
  const next = [...history, ping];
  return next.length > PING_WINDOW ? next.slice(next.length - PING_WINDOW) : next;
}

export function VoiceProvider({ children }) {
  const store = useStore();
  const modal = useModal();

  const [channelId, setChannelId] = useState(null);
  const [server, setServer] = useState(null);
  const [local, setLocal] = useState({
    self_mute: false, self_deaf: false, self_video: false, streaming: false,
  });
  const [micDenied, setMicDenied] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [cameraFacing, setCameraFacing] = useState('user');
  const [speaking, setSpeaking] = useState(() => new Set());
  const [connected, setConnected] = useState(() => new Set());
  const [screens, setScreens] = useState(() => new Map());
  const [cameras, setCameras] = useState(() => new Map());
  const [phase, setPhase] = useState('idle');
  const [joinedAt, setJoinedAt] = useState(null);
  const [ping, setPing] = useState(null);
  const [pingHistory, setPingHistory] = useState([]);
  const [noiseMode, setNoise] = useState(() => normalizeNoiseMode(store.prefs.micNoise));

  const callRef = useRef(null);
  const localRef = useRef(local); localRef.current = local;
  const cameraFacingRef = useRef(cameraFacing); cameraFacingRef.current = cameraFacing;
  const channelRef = useRef(channelId); channelRef.current = channelId;
  const serverRef = useRef(server); serverRef.current = server;

  const [privacy, setPrivacy] = useState(null);
  const privacyRef = useRef(null);
  const hellosRef = useRef(new Map());
  const greetedRef = useRef(new Set());
  const counterRef = useRef(0);
  const epochRef = useRef(null);
  const generationRef = useRef(null);
  const followRef = useRef(Promise.resolve());
  const diallingRef = useRef(null);
  const rekeyingRef = useRef(Promise.resolve());
  const earlyRef = useRef(null);
  const guildKeysRef = useRef(null);
  const guildProviderRef = useRef(null);
  const leaveRef = useRef(null);
  const retakeRef = useRef(null);
  const retakenAtRef = useRef(0);
  const movingRef = useRef(false);
  const pendingRetakeRef = useRef(null);
  const settleMove = () => {
    movingRef.current = false;
    const pending = pendingRetakeRef.current;
    pendingRetakeRef.current = null;
    if (pending) retakeRef.current?.(pending.target, pending.error);
  };
  const conversationCall = (id) => Boolean(id) && !store.channels.get(id);

  useEffect(() => {
    setAndroidCallActive(Boolean(channelId), {
      muted: local.self_mute,
      deafened: local.self_deaf,
    });
  }, [channelId, local.self_mute, local.self_deaf]);

  useEffect(() => () => setAndroidCallActive(false), []);

  useEffect(() => {
    if (!channelId || !isElectronRuntime() || typeof MutationObserver === 'undefined') return undefined;
    const apply = () => applyDesktopAudioOutput().catch((error) => {
      console.warn('Could not apply the selected desktop audio output:', error);
    });
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [channelId]);

  const hangUp = useCallback(() => {
    callRef.current?.stop();
    callRef.current = null;
    setSpeaking(new Set());
    setConnected(new Set());
    setScreens(new Map());
    setCameras(new Map());
    setMicDenied(false);
    setAudioBlocked(false);
    setCameraFacing('user');
  }, []);

  const dropGuildKeys = useCallback(() => {
    guildKeysRef.current?.stop();
    guildKeysRef.current = null;
    guildProviderRef.current = null;
  }, []);

  const armGuildKeys = useCallback(async (targetChannelId) => {
    guildKeysRef.current?.stop();
    guildKeysRef.current = null;
    if (conversationCall(targetChannelId) || !store.mls) return null;
    const me = store.me?.user_id;
    const keys = new GuildCallKeys({
      mls: store.mls,
      api: store.voiceApi(targetChannelId),
      channelId: targetChannelId,
      me,
      roster: () => store.voice.get(targetChannelId) || [],
      onKey: async (raw, epoch) => {
        if (guildKeysRef.current !== keys) return;
        await guildProviderRef.current?.setEpochKey(raw, epoch);
        callRef.current?.keyArrived?.();
      },
      onTrouble: (e) => {
        if (guildKeysRef.current !== keys) return;
        reportError(e, t('voice.error.trouble'));
        leaveRef.current?.(targetChannelId);
      },
      onLost: (e) => {
        if (guildKeysRef.current !== keys) return;
        retakeRef.current?.(targetChannelId, e);
      },
    });
    try {
      await keys.offer();
    } catch (e) {
      console.warn('Could not offer a key for this call:', e);
      return null;
    }
    guildKeysRef.current = keys;
    return keys;
  }, [store]);

  const picture = (set) => (id, stream) => set((prev) => {
    if (stream ? prev.get(id) === stream : !prev.has(id)) return prev;
    const next = new Map(prev);
    if (stream) next.set(id, stream);
    else next.delete(id);
    return next;
  });

  const setScreen = useCallback(picture(setScreens), []);
  const setCamera = useCallback(picture(setCameras), []);

  const settleStreamOff = useCallback(async () => {
    const currentChannelId = channelRef.current;
    if (!currentChannelId || !localRef.current.streaming) return;
    localRef.current = { ...localRef.current, streaming: false };
    setLocal((l) => ({ ...l, streaming: false }));
    try {
      await store.voiceApi(currentChannelId).voiceStream(currentChannelId, {
        enabled: false, preset: null,
      });
    } catch (e) {
      reportError(e, t('voice.error.stopStream'));
    }
    playCallTone('screen-stop');
  }, [store]);

  const settleVideoOff = useCallback(async () => {
    const currentChannelId = channelRef.current;
    if (!currentChannelId || !localRef.current.self_video) return;
    setLocal((l) => ({ ...l, self_video: false }));
    try {
      await store.voiceApi(currentChannelId).voiceState(currentChannelId, { self_video: false });
    } catch (e) {
      reportError(e, t('voice.error.cameraOff'));
    }
  }, [store]);

  const reposture = useCallback(() => {
    const conv = channelRef.current;
    const held = privacyRef.current;
    if (!conv || !held) return;
    const effective = effectivePosture({
      own: held.own,
      me: store.me?.user_id,
      roster: (store.voice.get(conv) || []).map((v) => v.user_id),
      hellos: hellosRef.current,
      epoch: epochRef.current,
    });
    let { policy } = held;
    if (serverRef.current?.mode === 'mesh') {
      policy = icePolicy({ own: held.own, effective, relayAvailable: Boolean(serverRef.current.relay) });
      callRef.current?.setPolicy?.(policy);
    }
    if (effective === held.effective && policy === held.policy) return;
    privacyRef.current = { ...held, effective, policy };
    setPrivacy(privacyRef.current);
  }, [store]);

  const greet = useCallback(async () => {
    const conv = channelRef.current;
    const held = privacyRef.current;
    const me = store.me?.user_id;
    if (!conv || !held || !store.mls) return;
    const secret = await store.mls.callSecret(conv, SIGNAL_LABEL).catch(() => null);
    if (!secret || channelRef.current !== conv) return;
    if (epochRef.current !== secret.epoch) {
      epochRef.current = secret.epoch;
      greetedRef.current = new Set();
      reposture();
    }
    const api = store.voiceApi(conv);
    for (const v of store.voice.get(conv) || []) {
      if (v.user_id === me || greetedRef.current.has(v.user_id)) continue;
      greetedRef.current.add(v.user_id);
      counterRef.current = Math.max(counterRef.current + 1, Date.now());
      const hello = await sealHello(secret.key, {
        conversationId: conv, sender: me, posture: held.own, counter: counterRef.current, epoch: secret.epoch,
      });
      api.voiceSignal(conv, { target: v.user_id, payload: { hello } })
        .catch(() => greetedRef.current.delete(v.user_id));
    }
  }, [store, reposture]);

  const hear = useCallback(async ({ from, payload }) => {
    const conv = channelRef.current;
    if (!conv || !from || !privacyRef.current || !store.mls) return;
    const secret = await store.mls.callSecret(conv, SIGNAL_LABEL).catch(() => null);
    if (!secret) return;
    const opened = await openHello(
      secret.key, { conversationId: conv, sender: from, epoch: secret.epoch }, payload.hello,
    );
    if (channelRef.current !== conv) return;
    if (noteHello(hellosRef.current, from, opened)) reposture();
    greet().catch(() => {});
  }, [store, reposture, greet]);

  const sealMedia = useCallback(async (conv) => {
    await Promise.race([
      store.catchUpConversation?.(conv)?.catch(() => {}),
      new Promise((resolve) => { setTimeout(resolve, CATCH_UP_WAIT_MS); }),
    ]);
    const secret = await store.mls?.callSecret(conv, MEDIA_LABEL);
    if (!secret) {
      throw new Error(t('voice.call.noKeys'));
    }
    const e2ee = await callE2EE();
    await e2ee.keyProvider.setEpochKey(secret.key, secret.epoch);
    return e2ee;
  }, [store]);

  const catchUpMedia = useCallback((conv) => {
    const run = rekeyingRef.current.then(async () => {
      const calls = [...new Set([callRef.current, diallingRef.current])]
        .filter((call) => call?.rekey && call.e2ee);
      if (!calls.length || channelRef.current !== conv || !store.mls) return false;
      const secret = await store.mls.callSecret(conv, MEDIA_LABEL);
      if (!secret) return false;
      let moved = false;
      for (const call of calls) {
        if (!mediaKeyBehind(call, secret)) continue;
        await call.rekey(secret.key, secret.epoch);
        moved = true;
      }
      return moved;
    }).catch((e) => {
      reportError(e, t('voice.error.rekey'));
      return false;
    });
    rekeyingRef.current = run;
    return run;
  }, [store]);

  const noteNoiseFallback = useCallback(() => {
    if (normalizeNoiseMode(store.prefs.micNoise) !== 'neural') return;
    store.prefs.micNoise = 'browser';
    store.savePrefs();
    toast(t('voice.noise.fellBack'));
  }, [store]);

  const setNoiseMode = useCallback(async (next) => {
    const mode = normalizeNoiseMode(next);
    if (mode === normalizeNoiseMode(store.prefs.micNoise)) return true;
    if (mode === 'neural') {
      const capability = neuralCapability();
      const refuse = (reason) => {
        toast(tOrNull(`voice.noise.reason.${reason}`) || t('voice.noise.cannot'), { error: true });
        return false;
      };
      if (!capability.ok) return refuse(capability.reason);
      try {
        const { probeNeural } = await import('../lib/denoise-chain.js');
        const verdict = await probeNeural();
        if (!verdict.ok) return refuse(verdict.reason);
      } catch (error) {
        reportError(error, t('voice.error.noiseModel'));
        return false;
      }
    }
    store.prefs.micNoise = mode;
    store.savePrefs();
    return true;
  }, [store]);

  const dial = useCallback(async (voiceServer, targetChannelId, { swap = false } = {}) => {
    if (callRef.current && !swap) return;
    const me = store.me?.user_id;
    const api = store.voiceApi(targetChannelId);
    const onError = (e) => reportError(e, t('voice.error.trouble'));
    const held = conversationCall(targetChannelId) ? privacyRef.current : null;
    const gate = { mode: swap ? 'held' : 'live', queue: [] };
    const via = (fn) => (...args) => {
      if (gate.mode === 'live') return fn(...args);
      if (gate.mode === 'held') gate.queue.push(() => fn(...args));
      return undefined;
    };
    const callbacks = {
      me,
      onSpeaking: via(setSpeaking),
      onPeers: via(setConnected),
      onScreen: via(setScreen),
      onCamera: via(setCamera),
      onScreenEnd: via(settleStreamOff),
      onCameraEnd: via(settleVideoOff),
      onError,
      noiseMode: normalizeNoiseMode(store.prefs.micNoise),
      onNoiseFallback: via(noteNoiseFallback),
    };
    let call;

    if (voiceServer?.mode === 'mesh') {
      let policy = 'all';
      if (held) {
        const effective = effectivePosture({
          own: held.own,
          me,
          roster: (store.voice.get(targetChannelId) || []).map((v) => v.user_id),
          hellos: hellosRef.current,
          epoch: epochRef.current,
        });
        policy = icePolicy({ own: held.own, effective, relayAvailable: Boolean(voiceServer.relay) });
      }
      call = new MeshCall({
        ...callbacks,
        policy,
        signal: (target, payload) => api.voiceSignal(targetChannelId, { target, payload }),
      });
    } else if (voiceServer?.mode === 'sfu') {
      let { endpoint } = voiceServer;
      let e2ee = null;
      let policy = 'all';
      if (held) {
        if (voiceServer.custom) endpoint = store.callSfuIn(targetChannelId);
        if (!endpoint) {
          throw new Error(t('voice.call.sfuAddressUnknown'));
        }
        e2ee = await sealMedia(targetChannelId);
        if (rank(held.own) >= rank('relay') && voiceServer.relay) policy = 'relay';
      } else {
        if (voiceServer.e2ee !== 'required') {
          throw new Error(t('voice.call.sfuNotEncrypted'));
        }
        e2ee = await callE2EE();
        guildProviderRef.current = e2ee.keyProvider;
        const latest = guildKeysRef.current?.latest;
        if (latest) await e2ee.keyProvider.setEpochKey(latest.raw, latest.epoch);
      }
      call = new SfuCall({
        ...callbacks,
        onAudioBlocked: via(setAudioBlocked),
        onDropped: (e) => {
          if (callRef.current === call) retakeRef.current?.(targetChannelId, e);
          else onError(e);
        },
        endpoint,
        joinToken: voiceServer.token,
        iceServers: voiceServer.ice_servers,
        maxBitrate: voiceServer.max_bitrate,
        policy,
        e2ee,
      });
    } else {
      return;
    }
    call.retire = () => { gate.mode = 'retired'; gate.queue = []; };
    if (held && call.e2ee) {
      diallingRef.current = call;
      await catchUpMedia(targetChannelId);
    }

    const previous = swap ? callRef.current : null;
    if (!swap) callRef.current = call;
    for (const [userId, value] of Object.entries(store.prefs.voiceVolumes || {})) {
      call.setVolume?.(userId, value);
    }
    for (const [userId, value] of Object.entries(store.prefs.voiceShareVolumes || {})) {
      call.setShareVolume?.(userId, value);
    }
    let gotMic;
    try {
      gotMic = await call.start(voiceServer.ice_servers);
    } catch (e) {
      if (swap) { call.retire(); call.stop(); }
      throw e;
    } finally {
      if (diallingRef.current === call) diallingRef.current = null;
    }

    if (swap) {
      if (!previous || callRef.current !== previous) {
        call.retire();
        call.stop();
        return;
      }
      previous.retire?.();
      previous.stop();
      setSpeaking(new Set());
      setConnected(new Set());
      setScreens(new Map());
      setCameras(new Map());
      callRef.current = call;
      gate.mode = 'live';
      const queued = gate.queue;
      gate.queue = [];
      queued.forEach((replay) => replay());
    }

    if (isElectronRuntime()) {
      const preferredInput = desktopAudioPreference(DESKTOP_AUDIO_INPUT_KEY);
      if (preferredInput !== 'default') {
        try {
          await switchCallInput(call, preferredInput, { ensurePublished: !gotMic });
          gotMic = true;
          setMicDenied(false);
        } catch (error) {
          console.warn('Could not apply the preferred desktop microphone:', error);
        }
      }
      applyDesktopAudioOutput().catch((error) => {
        console.warn('Could not apply the preferred desktop audio output:', error);
      });
    }

    if (!gotMic) {
      setMicDenied(true);
      const denied = call.micError?.name === 'NotAllowedError';
      const reason = denied ? (isAndroid ? 'androidDenied' : 'denied') : 'missing';
      toast(t('voice.call.noMic', { reason }), { error: true });
    }
    call.setMuted(localRef.current.self_mute);
    call.setDeafened(localRef.current.self_deaf);
    call.sync((store.voice.get(targetChannelId) || []).map((v) => v.user_id));

    if (swap) {
      if (localRef.current.self_video) {
        try {
          if (!await call.setVideoEnabled?.(true, { facingMode: cameraFacingRef.current })) {
            await settleVideoOff();
          }
        } catch {
          await settleVideoOff();
        }
      }
      if (localRef.current.streaming) {
        await settleStreamOff();
        toast(t('voice.call.shareStoppedOnMove'));
      }
    }
  }, [store, setScreen, setCamera, settleStreamOff, settleVideoOff, sealMedia, noteNoiseFallback]);

  const coreLeave = useCallback(async (target) => {
    const targetChannelId = typeof target === 'string' ? target : channelRef.current;
    if (!targetChannelId) return;
    const wasLive = channelRef.current === targetChannelId && Boolean(callRef.current);
    const me = store.me?.user_id;
    store.releaseVoiceSeat(targetChannelId);
    try { await store.voiceApi(targetChannelId).voiceLeave(targetChannelId); }
    catch (e) { reportError(e, t('voice.error.leave')); }
    store.voice.set(
      targetChannelId,
      (store.voice.get(targetChannelId) || []).filter((v) => v.user_id !== me),
    );
    if (!store.channels.get(targetChannelId)) {
      store.noteLeft?.(targetChannelId, me, store.voice.get(targetChannelId)?.length || 0);
    }
    store.emit('voice', targetChannelId);
    if (channelRef.current !== targetChannelId) return;
    channelRef.current = null;
    hangUp();
    dropGuildKeys();
    setServer(null);
    setChannelId(null);
    setPhase('idle');
    setJoinedAt(null);
    privacyRef.current = null;
    setPrivacy(null);
    generationRef.current = null;
    hellosRef.current = new Map();
    greetedRef.current = new Set();
    if (wasLive) playCallTone('leave');
  }, [store, hangUp, dropGuildKeys]);
  leaveRef.current = coreLeave;
  useEffect(() => store.beforeAway(() => leaveRef.current?.()), [store]);

  const join = useCallback(async (targetChannelId) => {
    if (callRef.current && channelRef.current === targetChannelId) return;
    if (callRef.current) await coreLeave();
    const me = store.me?.user_id;
    let joinedOnServer = false;
    try {
      setPhase('connecting');
      const body = {
        self_mute: localRef.current.self_mute,
        self_deaf: localRef.current.self_deaf,
        region: conversationCall(targetChannelId)
          ? (store.prefs.voiceRegion || 'auto')
          : await chooseVoiceRegion(
            store.apiForChannel(targetChannelId), store.prefs.voiceRegion || 'auto',
          ),
      };
      hellosRef.current = new Map();
      greetedRef.current = new Set();
      epochRef.current = null;
      earlyRef.current = { conv: targetChannelId, signals: [] };
      if (conversationCall(targetChannelId)) {
        const own = store.callPrivacyFor(targetChannelId);
        body.wants_sfu = wantsSfu(own, Boolean(store.callCaps().relay));
        body.custom_sfu = Boolean(store.callSfuIn(targetChannelId));
        privacyRef.current = { own, effective: own, policy: 'all' };
      } else {
        privacyRef.current = null;
      }
      setPrivacy(privacyRef.current);
      const keys = await armGuildKeys(targetChannelId);
      if (keys) body.key_package = keys.offered;
      const resp = await store.voiceApi(targetChannelId).voiceJoin(targetChannelId, body);
      joinedOnServer = true;
      if (keys && resp.e2ee) keys.begin(resp.e2ee);
      const refused = privacyRef.current
        ? refusalCode(privacyRef.current.own, resp.voice_server)
        : null;
      if (refused) throw new Error(t(`voice.refusal.${refused}`));
      serverRef.current = resp.voice_server;
      generationRef.current = resp.voice_server?.generation ?? null;
      setServer(resp.voice_server);
      const beforeJoin = (store.voice.get(targetChannelId) || [])
        .filter((v) => v.user_id !== me).length;
      const list = (store.voice.get(targetChannelId) || []).filter((v) => v.user_id !== me);
      list.push(resp.voice_state);
      store.voice.set(targetChannelId, list);
      if (conversationCall(targetChannelId)) {
        store.noteJoined?.(targetChannelId, me, beforeJoin);
      }
      store.emit('voice', targetChannelId);
      store.claimVoiceSeat(targetChannelId, resp.voice_state);
      channelRef.current = targetChannelId;
      setChannelId(targetChannelId);
      await dial(resp.voice_server, targetChannelId);
      const early = earlyRef.current;
      if (early?.conv === targetChannelId) {
        earlyRef.current = null;
        for (const d of early.signals) takeSignalRef.current?.(d);
      }
      if (privacyRef.current) {
        reposture();
        greet().catch(() => {});
      }
      setPhase('connected');
      setJoinedAt(Date.now());
      playCallTone('join');
    } catch (e) {
      if (joinedOnServer) {
        store.releaseVoiceSeat(targetChannelId);
        try { await store.voiceApi(targetChannelId).voiceLeave(targetChannelId); } catch { /* best effort rollback */ }
        store.voice.set(
          targetChannelId,
          (store.voice.get(targetChannelId) || []).filter((v) => v.user_id !== me),
        );
        if (conversationCall(targetChannelId)) {
          store.noteLeft?.(targetChannelId, me, store.voice.get(targetChannelId)?.length || 0);
        }
        store.emit('voice', targetChannelId);
      }
      if (channelRef.current === targetChannelId || callRef.current) {
        channelRef.current = null;
        hangUp();
        setServer(null);
        setChannelId(null);
        setJoinedAt(null);
      }
      if (earlyRef.current?.conv === targetChannelId) earlyRef.current = null;
      privacyRef.current = null;
      setPrivacy(null);
      generationRef.current = null;
      dropGuildKeys();
      reportError(e, t('voice.error.join'));
      setPhase('idle');
    }
  }, [store, dial, coreLeave, hangUp, reposture, greet, armGuildKeys, dropGuildKeys]);

  const toggleCamera = useCallback(async () => {
    const currentChannelId = channelRef.current;
    if (!currentChannelId) return;
    const call = callRef.current;
    const next = !localRef.current.self_video;

    if (next) {
      if (!call?.setVideoEnabled) {
        toast(t('voice.call.noCameraSupport'), { error: true });
        return;
      }
      try {
        if (!await call.setVideoEnabled(true, { facingMode: cameraFacingRef.current })) return;
      } catch (e) {
        const denied = e?.name === 'NotAllowedError';
        const missing = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError';
        if (denied || missing) {
          toast(
            t('voice.call.cameraRefused', {
              reason: denied ? (isAndroid ? 'androidDenied' : 'denied') : 'missing',
            }),
            { error: true },
          );
        } else {
          reportError(e, t('voice.error.cameraOn'));
        }
        return;
      }
    } else {
      try { await call?.setVideoEnabled?.(false); } catch { /* already down */ }
    }

    setLocal((l) => ({ ...l, self_video: next }));
    try {
      await store.voiceApi(currentChannelId).voiceState(currentChannelId, { self_video: next });
    } catch (e) {
      reportError(e, t('voice.error.voiceState'));
      setLocal((l) => ({ ...l, self_video: !next }));
      if (next) { try { await call?.setVideoEnabled?.(false); } catch { /* gone */ } }
    }
  }, [store]);

  const flipCamera = useCallback(async () => {
    if (!localRef.current.self_video) return;
    const call = callRef.current;
    if (!call?.switchCamera) {
      toast(t('voice.call.noFlipSupport'), { error: true });
      return;
    }
    const next = cameraFacingRef.current === 'environment' ? 'user' : 'environment';
    try {
      const switched = await call.switchCamera(next);
      if (!switched) {
        toast(t('voice.call.noAlternateCamera'), { error: true });
        return;
      }
      setCameraFacing(next);
      navigator.vibrate?.(8);
    } catch (e) {
      const missing = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError';
      if (missing) toast(t('voice.call.noAlternateCamera'), { error: true });
      else reportError(e, t('voice.error.flipCamera'));
    }
  }, []);

  const volumeFor = useCallback(
    (userId) => Math.max(0, Math.min(200, Number(store.prefs.voiceVolumes?.[userId] ?? 100))),
    [store],
  );

  const setUserVolume = useCallback((userId, percent) => {
    if (!userId) return;
    const value = Math.max(0, Math.min(200, Number(percent) || 0));
    if (!store.prefs.voiceVolumes) store.prefs.voiceVolumes = {};
    store.prefs.voiceVolumes[userId] = value;
    store.savePrefs();
    callRef.current?.setVolume?.(userId, value);
  }, [store]);

  const shareVolumeFor = useCallback(
    (userId) => Math.max(0, Math.min(200, Number(
      store.prefs.voiceShareVolumes?.[userId] ?? store.prefs.voiceVolumes?.[userId] ?? 100,
    ))),
    [store],
  );

  const setUserShareVolume = useCallback((userId, percent) => {
    if (!userId) return;
    const value = Math.max(0, Math.min(200, Number(percent) || 0));
    if (!store.prefs.voiceShareVolumes) store.prefs.voiceShareVolumes = {};
    store.prefs.voiceShareVolumes[userId] = value;
    store.savePrefs();
    callRef.current?.setShareVolume?.(userId, value);
  }, [store]);

  const setScreenSubscription = useCallback((userId, on, quality) => {
    callRef.current?.setScreenSubscription?.(userId, on, quality);
  }, []);

  const setWatchQuality = useCallback((userId, quality) => {
    callRef.current?.setWatchQuality?.(userId, quality);
  }, []);

  const resumeAudio = useCallback(async () => {
    const call = callRef.current;
    if (!call?.resumeAudio) {
      setAudioBlocked(false);
      return;
    }
    try {
      const ready = await call.resumeAudio();
      setAudioBlocked(!ready);
    } catch (e) {
      reportError(e, t('voice.error.resumeAudio'));
    }
  }, []);

  const toggle = useCallback(async (key) => {
    if (key === 'self_video') return toggleCamera();
    const currentChannelId = channelRef.current;
    if (!currentChannelId) return;
    const next = !localRef.current[key];
    setLocal((l) => ({ ...l, [key]: next }));
    if (key === 'self_mute') callRef.current?.setMuted(next);
    if (key === 'self_deaf') callRef.current?.setDeafened(next);
    try {
      await store.voiceApi(currentChannelId).voiceState(currentChannelId, { [key]: next });
    } catch (e) {
      reportError(e, t('voice.error.voiceState'));
      setLocal((l) => ({ ...l, [key]: !next }));
      if (key === 'self_mute') callRef.current?.setMuted(!next);
      if (key === 'self_deaf') callRef.current?.setDeafened(!next);
    }
    return undefined;
  }, [store, toggleCamera]);

  useEffect(() => subscribeAndroidCallControls((action) => {
    if (action === 'disconnect') coreLeave();
    if (action === 'toggle_mute') toggle('self_mute');
    if (action === 'toggle_deafen') toggle('self_deaf');
  }), [coreLeave, toggle]);

  const setStream = useCallback(async (next, settings = null) => {
    const currentChannelId = channelRef.current;
    if (!currentChannelId) return;
    const call = callRef.current;

    if (next) {
      if (!call?.setScreenShareEnabled) {
        toast(t('voice.call.noScreenShareSupport'), { error: true });
        return;
      }
      try {
        const started = await withScreenShareConstraints(
          settings,
          () => call.setScreenShareEnabled(true, settings),
        );
        if (!started) return;
        if (
          settings?.audio !== false
          && call.screenShareHasAudio
          && !call.screenShareHasAudio()
        ) {
          const support = displayAudioSupport();
          const desktopFailure = displayAudioFailureReason();
          toast(desktopFailure
            ? t('voice.share.desktopAudioFailed', { reason: desktopFailure })
            : support.likely
              ? t('voice.share.pickTabAudio')
              : t(support.capture ? 'voice.share.audioUnlikely' : 'voice.share.noCapture'));
        }
      } catch (e) {
        if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
          reportError(e, t('voice.error.shareScreen'));
        }
        return;
      }
    } else {
      // Mark state down first so LiveKit's LocalTrackUnpublished does not race and duplicate the update.
      localRef.current = { ...localRef.current, streaming: false };
      try { await call?.setScreenShareEnabled?.(false); } catch { /* already down */ }
    }

    localRef.current = { ...localRef.current, streaming: next };
    setLocal((l) => ({ ...l, streaming: next }));
    try {
      await store.voiceApi(currentChannelId).voiceStream(currentChannelId, {
        enabled: next,
        preset: next ? (settings?.preset || 'detail') : null,
      });
    } catch (e) {
      reportError(e, t('voice.error.streamState'));
      if (next) {
        localRef.current = { ...localRef.current, streaming: false };
        setLocal((l) => ({ ...l, streaming: false }));
        try { await call?.setScreenShareEnabled?.(false); } catch { /* gone */ }
      }
      return;
    }
    playCallTone(next ? 'screen-start' : 'screen-stop');
  }, [store]);

  const toggleStream = useCallback(async () => {
    if (localRef.current.streaming) return setStream(false);
    modal.open((close) => (
      <ScreenShareDialog
        close={close}
        onStart={(settings) => setStream(true, settings)}
      />
    ));
    return undefined;
  }, [modal, setStream]);

  const follow = useCallback(async (conv, update) => {
    if (channelRef.current !== conv || !callRef.current) return;
    const known = generationRef.current;
    if (known !== null && Number(update?.generation) <= known) return;
    const next = await store.voiceApi(conv).voiceServer(conv);
    if (channelRef.current !== conv) return;
    if (known !== null && Number(next?.generation) <= known) return;
    const refused = privacyRef.current ? refusalCode(privacyRef.current.own, next) : null;
    if (refused) {
      toast(t(`voice.refusal.${refused}`), { error: true });
      await coreLeave(conv);
      return;
    }
    const before = serverRef.current;
    serverRef.current = next;
    try {
      await dial(next, conv, { swap: true });
    } catch (e) {
      serverRef.current = before;
      throw e;
    }
    generationRef.current = next.generation ?? known;
    setServer(next);
    reposture();
    if (next.mode !== before?.mode) {
      toast(t('voice.call.moved', { mode: next.mode === 'sfu' ? 'sfu' : 'mesh' }));
    }
  }, [store, dial, coreLeave, reposture]);

  useEffect(() => store.on('voice-server', async (d) => {
    const currentChannelId = channelRef.current;
    if (d.channel_id !== currentChannelId) return;
    if (conversationCall(currentChannelId)) {
      followRef.current = followRef.current
        .then(() => follow(currentChannelId, d))
        .catch((e) => {
          if (channelRef.current !== currentChannelId) return;
          console.warn(t('voice.error.followServer'), e);
          retakeRef.current?.(currentChannelId, e);
        });
      return;
    }
    setServer((s) => ({ ...s, ...d }));
    if (d.reconnect && store.voice.get(currentChannelId)?.some((v) => v.user_id === store.me?.user_id)) {
      try {
        const keys = await armGuildKeys(currentChannelId);
        const resp = await store.voiceApi(currentChannelId).voiceJoin(currentChannelId, {
          self_mute: localRef.current.self_mute,
          self_deaf: localRef.current.self_deaf,
          region: d.region || 'auto',
          ...(keys ? { key_package: keys.offered } : {}),
        });
        if (keys && resp.e2ee) keys.begin(resp.e2ee);
        store.claimVoiceSeat(currentChannelId, resp.voice_state);
        setServer(resp.voice_server);
        hangUp();
        await dial(resp.voice_server, currentChannelId);
        toast(t('voice.call.movedRegion', { region: resp.voice_server.region }));
      } catch (e) { reportError(e, t('voice.error.followRegion')); }
    }
  }), [store, dial, hangUp, follow, armGuildKeys]);

  const takeSignal = useCallback((d) => {
    const currentChannelId = channelRef.current;
    if (d.channel_id && d.channel_id !== currentChannelId) return;
    if (d.payload?.hello) {
      hear(d).catch(() => {});
      return;
    }
    if (d.payload?.watch || d.payload?.watch_sealed) return;
    callRef.current?.accept(d);
  }, [hear]);
  const takeSignalRef = useRef(takeSignal); takeSignalRef.current = takeSignal;

  useEffect(() => store.on('voice-signal', (d) => {
    const early = earlyRef.current;
    if (early && d.channel_id === early.conv
      && (channelRef.current !== early.conv || !callRef.current)) {
      early.signals.push(d);
      return;
    }
    takeSignal(d);
  }), [store, takeSignal]);

  useEffect(() => store.on('voice-e2ee', (d) => {
    const keys = guildKeysRef.current;
    if (!keys || d.channel_id !== keys.channelId) return;
    keys.hear(d);
  }), [store]);
  useEffect(() => store.on('voice', (roomId) => {
    const keys = guildKeysRef.current;
    if (!keys || (roomId && roomId !== keys.channelId)) return;
    keys.tend();
  }), [store]);

  useEffect(() => store.on('dm', async (d) => {
    const conv = channelRef.current;
    if (!conv || d?.conversation_id !== conv || !privacyRef.current || !store.mls) return;
    const epoch = store.mls.epochOf(conv);
    const rekeyed = await catchUpMedia(conv);
    if (!rekeyed && epoch === epochRef.current) return;
    await greet().catch(() => {});
  }), [store, greet, catchUpMedia]);

  useEffect(() => store.on('voice', () => {
    const current = channelRef.current;
    const me = store.me?.user_id;
    if (!current || !me || movingRef.current) return;
    if ((store.voice.get(current) || []).some((v) => v.user_id === me)) return;

    const currentGuild = store.channels.get(current)?.guild_id;
    const destination = [...store.voice.entries()].find(([roomId, states]) => (
      roomId !== current
      && store.channels.get(roomId)?.guild_id === currentGuild
      && states.some((v) => v.user_id === me)
    ))?.[0];
    if (!destination) return;

    movingRef.current = true;
    store.releaseVoiceSeat(current);
    channelRef.current = null;
    hangUp();
    setServer(null);
    setChannelId(null);
    setPhase('connecting');
    setJoinedAt(null);
    join(destination)
      .then(() => {
        if (channelRef.current === destination) {
          toast(t('voice.call.movedTo', {
            channel: store.channels.get(destination)?.name || t('voice.call.someVoiceChannel'),
          }));
        }
      })
      .finally(settleMove);
  }), [store, join, hangUp]);

  const retakeSeat = useCallback((current) => {
    movingRef.current = true;
    store.releaseVoiceSeat(current);
    channelRef.current = null;
    hangUp();
    setServer(null);
    setPhase('connecting');
    setJoinedAt(null);
    join(current).finally(settleMove);
  }, [store, join, hangUp]);

  const retake = useCallback((target, error) => {
    if (movingRef.current) {
      pendingRetakeRef.current = { target, error };
      return;
    }
    const current = channelRef.current;
    if (current !== target) return;
    if (!callRef.current || Date.now() - retakenAtRef.current < RETAKE_WINDOW_MS) {
      reportError(error, t('voice.error.trouble'));
      leaveRef.current?.(target);
      return;
    }
    retakenAtRef.current = Date.now();
    console.warn('Rejoining the call:', error);
    retakeSeat(current);
  }, [retakeSeat]);
  retakeRef.current = retake;

  useEffect(() => store.on('voice-reclaim', ({ domain, rooms }) => {
    const current = channelRef.current;
    if (!current || !callRef.current || movingRef.current) return;
    if (store.voiceDomain(current) !== domain) return;
    if (rooms.has(current)) {
      const keys = guildKeysRef.current;
      if (keys?.channelId === current) keys.check().catch(() => {});
      callRef.current.recoverAll?.();
      if (conversationCall(current)) {
        store.voiceApi(current)?.voiceStates(current)
          .then((resp) => {
            if (channelRef.current === current) store.hydrateVoice(current, resp.voice_states || []);
          })
          .catch(() => {});
      }
      return;
    }
    retakeSeat(current);
  }), [store, retakeSeat]);

  useStoreEvent('voice');
  const participants = channelId ? (store.voice.get(channelId) || []) : [];
  const roster = participants.map((v) => v.user_id).sort().join(',');
  useEffect(() => {
    const ids = roster ? roster.split(',') : [];
    callRef.current?.sync(ids);
    if (!privacyRef.current) return;
    for (const id of [...greetedRef.current]) if (!ids.includes(id)) greetedRef.current.delete(id);
    reposture();
    greet().catch(() => {});
  }, [roster, reposture, greet]);

  useEffect(() => {
    if (phase !== 'connected') {
      setPing(null);
      setPingHistory([]);
      return undefined;
    }
    let alive = true;
    const sample = async () => {
      if (!alive) return;
      const p = await callRef.current?.measurePing();
      if (!alive) return;
      setPing(p ?? null);
      setPingHistory((history) => recordPing(history, p));
    };
    sample();
    const id = setInterval(sample, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [phase]);

  useEffect(() => {
    const apply = () => {
      const mode = normalizeNoiseMode(store.prefs.micNoise);
      setNoise(mode);
      const changing = callRef.current?.setNoiseMode?.(mode);
      changing?.catch?.((error) => reportError(error, t('voice.error.noiseChange')));
    };
    apply();
    return store.on('prefs', apply);
  }, [store]);

  const chooseDesktopInput = useCallback(async (deviceId) => {
    const call = callRef.current;
    if (!call) return;
    await switchCallInput(call, deviceId, { ensurePublished: micDenied });
    setMicDenied(false);
    call.setMuted(localRef.current.self_mute);
  }, [micDenied]);

  const chooseDesktopOutput = useCallback(async (deviceId) => {
    await applyDesktopAudioOutput(deviceId);
  }, []);

  const value = {
    active: Boolean(channelId),
    channelId,
    phase,
    server,
    local,
    micDenied,
    audioBlocked,
    cameraFacing,
    speaking,
    connected,
    screens,
    cameras,
    joinedAt,
    ping,
    pingHistory,
    privacy,
    noiseMode,
    noiseSupport: neuralCapability(),
    setNoiseMode,
    join,
    leave: coreLeave,
    volumeFor,
    setUserVolume,
    shareVolumeFor,
    setUserShareVolume,
    setScreenSubscription,
    setWatchQuality,
    toggle,
    flipCamera,
    resumeAudio,
    toggleStream,
    hangUp,
  };

  return (
    <VoiceContext.Provider value={value}>
      {children}
      {isElectronRuntime() ? (
        <DesktopAudioDevices
          active={Boolean(channelId)}
          onInput={chooseDesktopInput}
          onOutput={chooseDesktopOutput}
          noiseMode={noiseMode}
          noiseSupport={value.noiseSupport}
          onNoise={setNoiseMode}
        />
      ) : null}
    </VoiceContext.Provider>
  );
}

export function useVoice() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice called outside a VoiceProvider');
  return ctx;
}
