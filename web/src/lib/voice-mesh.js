// Mesh voice: one RTCPeerConnection per peer; the server only relays signals (`POST /channels/{id}/voice/signal`). Glare uses perfect negotiation (politeness by user id); signals can arrive out of order, so each peer has a promise chain and candidates wait for a description.

import {
  applyContentHint, applyDegradationPreference,
} from './screenShare.js';
import { micConstraints, normalizeNoiseMode } from './denoise.js';
import {
  SPEAKING_LEVEL, SPEAKING_HANG_MS, cameraVideoConstraints, clampPlaybackVolume,
  createPlaybackContext, displayMedia, micLive, openDenoiser, setPlaybackMuted,
  setPlaybackVolume, stopPlaybackGraph, userMedia, sameSet, rttFromPc, preferScreenCodec,
} from './voice-media.js';

/// Relay hops can be lost and perfect negotiation has no retry of its own.
export const MESH_STALL_MS = 8000;
/// 'disconnected' often clears itself; 'failed' takes ~30s.
export const MESH_DISCONNECTED_MS = 4000;
/// Retries continue after this, less often.
export const MESH_RECOVERIES_BEFORE_REPORT = 3;
const MESH_RECOVERY_CEILING_MS = 30000;

export class MeshCall {
  /// `onScreenEnd`/`onCameraEnd` fire when a capture ends outside our control.
  constructor({
    me, signal, onSpeaking, onPeers, onScreen, onCamera, onScreenEnd, onCameraEnd, onError,
    onAudioBlocked, onNoiseFallback, policy, noiseMode,
  }) {
    this.me = me;
    this.signal = signal;
    // 'relay' pins connections to TURN so no peer learns an address.
    this.policy = policy === 'relay' ? 'relay' : 'all';
    this.onSpeaking = onSpeaking || (() => {});
    this.onPeers = onPeers || (() => {});
    this.onScreen = onScreen || (() => {});
    this.onCamera = onCamera || (() => {});
    this.onScreenEnd = onScreenEnd || (() => {});
    this.onCameraEnd = onCameraEnd || (() => {});
    this.onError = onError || (() => {});
    this.onAudioBlocked = onAudioBlocked || (() => {});
    // Fired once if the model is abandoned mid-call; never for a chosen mode.
    this.onNoiseFallback = onNoiseFallback || (() => {});

    this.peers = new Map();
    this.self = { analyser: null, buffer: null };
    this.raw = null;
    this.stream = null;
    this.denoiser = null;
    this.noiseMode = normalizeNoiseMode(noiseMode);
    this.deviceId = 'default';
    this.screen = null;
    this.screenSettings = {};
    this.camera = null;
    this.micError = null;
    this.context = null;
    this.ice = [];
    this.muted = false;
    this.deafened = false;
    this.volumes = new Map();
    this.shareVolumes = new Map();
    this.raf = 0;
    this.speaking = new Set();
    this.since = new Map();
    this.live = false;
  }

  async start(iceServers) {
    this.live = true;
    this.ice = Array.isArray(iceServers) ? iceServers : [];
    if (!this.context) this.context = createPlaybackContext();
    if (this.stream) return true;
    try {
      // `micConstraints` never varies echo cancellation, which matters most in a mesh.
      this.raw = await navigator.mediaDevices.getUserMedia({
        audio: micConstraints(this.noiseMode, this.deviceId),
      });
      await this.route();
    } catch (e) {
      this.raw = null;
      this.stream = null;
      this.micError = e;
      return false;
    }
    this.applyMute();
    this.attachAnalyser(this.me, this.stream);
    // A peer's offer can beat the permission prompt.
    for (const peer of this.peers.values()) this.transmit(peer);
    this.tick();
    return true;
  }

  sync(userIds) {
    if (!this.live) return;
    const want = new Set(userIds.filter((id) => id !== this.me));
    for (const id of want) this.ensure(id);
    for (const id of [...this.peers.keys()]) if (!want.has(id)) this.drop(id);
    this.onPeers(this.connected());
  }

  /// Unknown senders are connected to: their offer can beat the voice state.
  accept({ from, payload }) {
    if (!this.live || !from || from === this.me || !payload) return Promise.resolve();
    const peer = this.ensure(from);
    // Serialise: interleaved description updates corrupt the connection state.
    peer.inbox = peer.inbox.then(() => this.apply(from, peer, payload));
    return peer.inbox;
  }

  /// Peers get `replaceTrack`, no renegotiation.
  async route() {
    const [track] = this.raw?.getAudioTracks() || [];
    if (!track) { this.stream = this.raw; return; }

    if (this.noiseMode !== 'neural') {
      await this.denoiser?.stop?.().catch?.(() => {});
      this.denoiser = null;
      this.stream = this.raw;
      return;
    }

    if (this.denoiser) {
      this.denoiser.setBypass(false);
      this.stream = new MediaStream([await this.denoiser.replace(track)]);
      return;
    }

    // A model load failure must not fail the call.
    try {
      const chain = await openDenoiser((reason) => this.surrender(reason));
      const processed = await chain.start(track);
      this.denoiser = chain;
      this.stream = new MediaStream([processed]);
    } catch (error) {
      await this.denoiser?.stop?.().catch?.(() => {});
      this.denoiser = null;
      this.stream = this.raw;
      this.surrender(error?.reason || 'load-failed');
    }
  }

  settle() {
    this.applyMute();
    if (this.context && this.stream) this.attachAnalyser(this.me, this.stream);
    for (const peer of this.peers.values()) this.transmit(peer);
  }

  async setNoiseMode(mode) {
    const next = normalizeNoiseMode(mode);
    if (next === this.noiseMode) return;
    this.noiseMode = next;
    if (!this.live) return;
    const [track] = this.raw?.getAudioTracks() || [];
    if (track) {
      try {
        await track.applyConstraints(micConstraints(next, this.deviceId));
      } catch {
        await this.reopen();
      }
    }
    await this.route();
    this.settle();
  }

  async useDevice(deviceId) {
    this.deviceId = deviceId || 'default';
    await this.reopen();
    await this.route();
    this.settle();
  }

  async reopen() {
    const next = await navigator.mediaDevices.getUserMedia({
      audio: micConstraints(this.noiseMode, this.deviceId),
      video: false,
    });
    if (!this.live) { next.getTracks().forEach((t) => t.stop()); return; }
    const previous = this.raw;
    this.raw = next;
    previous?.getTracks?.().forEach((t) => t.stop());
    this.micError = null;
  }

  surrender(reason) {
    if (this.noiseMode !== 'neural') return;
    this.noiseMode = 'browser';
    this.denoiser?.setBypass?.(true);
    const [track] = this.raw?.getAudioTracks() || [];
    track?.applyConstraints?.(micConstraints('browser', this.deviceId))?.catch?.(() => {});
    try { this.onNoiseFallback(reason); } catch { /* a UI callback must not break the call */ }
  }

  setMuted(muted) { this.muted = muted; this.applyMute(); }

  setDeafened(deafened) {
    this.deafened = deafened;
    this.applyMute();
    for (const peer of this.peers.values()) {
      setPlaybackMuted(peer.audioGraph, peer.audio, deafened);
      setPlaybackMuted(peer.screenAudioGraph, peer.screenAudioEl, deafened);
    }
  }

  setVolume(userId, percent) {
    const value = clampPlaybackVolume(percent);
    this.volumes.set(userId, value);
    const peer = this.peers.get(userId);
    if (peer?.audio) {
      peer.audioGraph = setPlaybackVolume(
        this.context, peer.audioStream, peer.audio, peer.audioGraph, value,
      );
    }
    if (!this.shareVolumes.has(userId) && peer?.screenAudioEl) {
      peer.screenAudioGraph = setPlaybackVolume(
        this.context, peer.screenAudioStream, peer.screenAudioEl, peer.screenAudioGraph, value,
      );
    }
  }

  setShareVolume(userId, percent) {
    const value = clampPlaybackVolume(percent);
    this.shareVolumes.set(userId, value);
    const peer = this.peers.get(userId);
    if (peer?.screenAudioEl) {
      peer.screenAudioGraph = setPlaybackVolume(
        this.context, peer.screenAudioStream, peer.screenAudioEl, peer.screenAudioGraph, value,
      );
    }
  }

  /// Throws if the picker was dismissed. The SFU watch subscription does not apply to a mesh.
  async setScreenShareEnabled(on, settings = {}) {
    if (!on) return this.stopScreen();
    if (this.screen) return true;
    // A mesh has no publish step.
    this.screenSettings = settings || {};
    const stream = await displayMedia().getDisplayMedia({
      video: { frameRate: { ideal: settings.fps || 30, max: settings.fps || 60 } },
      // Only when the surface exposes audio; it gets its own m-line.
      audio: settings.audio !== false,
    });
    // The picker can outlive the call.
    if (!this.live) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.screen = stream;
    const [track] = stream.getVideoTracks();
    applyContentHint(track, settings.content);
    // The browser's "Stop sharing" bar ends the track without telling us.
    track?.addEventListener?.('ended', () => {
      if (!this.screen) return;
      this.stopScreen();
      this.onScreenEnd();
    });
    for (const peer of this.peers.values()) this.project(peer);
    this.onScreen(this.me, stream);
    return true;
  }

  screenShareHasAudio() {
    return Boolean(this.screen?.getAudioTracks?.().length);
  }

  /// Throws if the device can't be opened. The camera has its own m-line so a screen share doesn't displace it.
  async setVideoEnabled(on, { facingMode = 'user' } = {}) {
    if (!on) return this.stopCamera();
    if (this.camera) return true;
    const stream = await userMedia().getUserMedia({
      video: cameraVideoConstraints(facingMode),
      audio: false,
    });
    if (!this.live) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.camera = stream;
    const [track] = stream.getVideoTracks();
    // Unplugged or claimed elsewhere.
    track?.addEventListener?.('ended', () => {
      // Ignore the late event of a camera replaced by a flip.
      if (this.camera !== stream) return;
      this.stopCamera();
      this.onCameraEnd();
    });
    for (const peer of this.peers.values()) this.face(peer);
    this.onCamera(this.me, stream);
    return true;
  }

  async switchCamera(facingMode = 'environment') {
    if (!this.camera) return false;
    const stream = await userMedia().getUserMedia({
      video: cameraVideoConstraints(facingMode),
      audio: false,
    });
    if (!this.live) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    const previous = this.camera;
    this.camera = stream;
    const [track] = stream.getVideoTracks();
    track?.addEventListener?.('ended', () => {
      if (this.camera !== stream) return;
      this.stopCamera();
      this.onCameraEnd();
    });
    for (const peer of this.peers.values()) this.face(peer);
    previous.getTracks().forEach((t) => t.stop());
    this.onCamera(this.me, stream);
    return true;
  }

  stop() {
    this.live = false;
    cancelAnimationFrame(this.raf);
    this.stopScreen();
    this.stopCamera();
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.denoiser?.stop?.().catch?.(() => {});
    this.denoiser = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.raw?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.raw = null;
    this.context?.close().catch(() => {});
    this.context = null;
    this.speaking = new Set();
    this.onSpeaking(this.speaking);
    this.onPeers(new Set());
  }

  /// Tightening to 'relay' restarts ICE at once; relaxing waits for the next restart.
  setPolicy(policy) {
    const next = policy === 'relay' ? 'relay' : 'all';
    if (next === this.policy) return false;
    this.policy = next;
    for (const peer of this.peers.values()) {
      try {
        const config = peer.pc.getConfiguration?.() || {};
        peer.pc.setConfiguration?.({ ...config, iceServers: this.ice, iceTransportPolicy: next });
        if (next === 'relay') peer.pc.restartIce?.();
      } catch (e) {
        this.onError(e);
      }
    }
    return true;
  }

  applyMute() {
    const on = micLive(this);
    // Both handles, so a muted room doesn't keep feeding the model.
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = on; });
    this.raw?.getAudioTracks().forEach((t) => { t.enabled = on; });
  }

  /// Everything downstream may assume the peer exists.
  send(target, payload) {
    const peer = this.peers.get(target);
    if (!peer) return;
    peer.outbox = peer.outbox
      .then(() => this.signal(target, payload))
      .catch((e) => this.onError(e));
  }

  async apply(from, peer, payload) {
    if (this.peers.get(from) !== peer) return;
    try {
      if (payload.description) {
        const offer = payload.description.type === 'offer';
        // Collision: the impolite side ignores the offer, the polite side rolls back.
        const collision = offer
          && (peer.makingOffer || peer.pc.signalingState !== 'stable');
        peer.ignoring = !peer.polite && collision;
        if (peer.ignoring) return;
        await peer.pc.setRemoteDescription(payload.description);
        for (const candidate of peer.pending.splice(0)) {
          try { await peer.pc.addIceCandidate(candidate); } catch { /* stale generation */ }
        }
        if (offer) {
          await peer.pc.setLocalDescription();
          this.send(from, { description: peer.pc.localDescription });
        }
      } else if (payload.candidate) {
        if (!peer.pc.remoteDescription) peer.pending.push(payload.candidate);
        else await peer.pc.addIceCandidate(payload.candidate);
      }
    } catch (e) {
      if (!peer.ignoring) this.onError(e);
    }
  }

  connected() {
    const ids = new Set();
    for (const [id, peer] of this.peers) if (peer.connected) ids.add(id);
    return ids;
  }

  /// `replaceTrack` doesn't renegotiate; the direction change tells the far side.
  transmit(peer) {
    const [track] = this.stream?.getAudioTracks() || [];
    if (!track || !peer.transceiver) return;
    peer.transceiver.sender.replaceTrack(track);
    peer.transceiver.direction = 'sendrecv';
  }

  project(peer) {
    const [track] = this.screen?.getVideoTracks() || [];
    if (peer.screen) {
      peer.screen.sender.replaceTrack(track || null);
      peer.screen.direction = track ? 'sendrecv' : 'recvonly';
      if (track) {
        applyDegradationPreference(
          peer.screen.sender, this.screenSettings?.degradationPreference,
        ).catch(() => {});
      }
    }
    const [audio] = this.screen?.getAudioTracks() || [];
    if (peer.screenAudio) {
      peer.screenAudio.sender.replaceTrack(audio || null);
      peer.screenAudio.direction = audio ? 'sendrecv' : 'recvonly';
    }
  }

  face(peer) {
    const [track] = this.camera?.getVideoTracks() || [];
    if (!track || !peer.camera) return;
    peer.camera.sender.replaceTrack(track);
    peer.camera.direction = 'sendrecv';
  }

  stopScreen() {
    const had = Boolean(this.screen);
    this.screen?.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.screenSettings = {};
    for (const peer of this.peers.values()) {
      for (const transceiver of [peer.screen, peer.screenAudio]) {
        if (!transceiver) continue;
        transceiver.sender.replaceTrack(null);
        transceiver.direction = 'recvonly';
      }
    }
    if (had) this.onScreen(this.me, null);
    return false;
  }

  /// `enabled = false` would leave the camera light on.
  stopCamera() {
    return this.retract('camera', 'onCamera');
  }

  retract(what, notify) {
    const had = Boolean(this[what]);
    this[what]?.getTracks().forEach((t) => t.stop());
    this[what] = null;
    for (const peer of this.peers.values()) {
      const transceiver = peer[what];
      if (!transceiver) continue;
      transceiver.sender.replaceTrack(null);
      transceiver.direction = 'recvonly';
    }
    if (had) this[notify](this.me, null);
    return false;
  }

  incoming(id, peer, track, stream, slot, notify) {
    peer[slot] = stream;
    const show = () => { if (this.peers.get(id) === peer) this[notify](id, stream); };
    const hide = () => { if (this.peers.get(id) === peer) this[notify](id, null); };
    // A sender that stops sharing swaps its track out, which arrives as a mute.
    track.addEventListener?.('ended', hide);
    track.addEventListener?.('mute', hide);
    track.addEventListener?.('unmute', show);
    show();
  }

  ensure(id) {
    const existing = this.peers.get(id);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.ice, iceTransportPolicy: this.policy });
    const peer = {
      pc,
      // Symmetric: whoever holds the larger id yields.
      polite: this.me > id,
      makingOffer: false,
      ignoring: false,
      connected: false,
      watch: null,
      recoveries: 0,
      reported: false,
      outbox: Promise.resolve(),
      inbox: Promise.resolve(),
      pending: [],
      transceiver: null,
      camera: null,
      screen: null,
      screenAudio: null,
      cameraOf: null,
      screenOf: null,
      audio: null,
      audioStream: null,
      audioGraph: null,
      screenAudioEl: null,
      screenAudioStream: null,
      screenAudioGraph: null,
      analyser: null,
      buffer: null,
    };
    this.peers.set(id, peer);
    this.watch(id, peer);

    // m-lines are laid down up front in a fixed order (audio, camera, screen, screen audio) so later changes are track swaps, not renegotiations.
    const [mic] = this.stream?.getAudioTracks() || [];
    peer.transceiver = mic
      ? pc.addTransceiver(mic, { direction: 'sendrecv', streams: [this.stream] })
      : pc.addTransceiver('audio', { direction: 'recvonly' });

    const [face] = this.camera?.getVideoTracks() || [];
    peer.camera = face
      ? pc.addTransceiver(face, { direction: 'sendrecv', streams: [this.camera] })
      : pc.addTransceiver('video', { direction: 'recvonly' });

    const [display] = this.screen?.getVideoTracks() || [];
    peer.screen = display
      ? pc.addTransceiver(display, { direction: 'sendrecv', streams: [this.screen] })
      : pc.addTransceiver('video', { direction: 'recvonly' });
    // H.264 on Windows reaches the hardware-video path.
    preferScreenCodec(peer.screen);

    const [screenAudio] = this.screen?.getAudioTracks() || [];
    peer.screenAudio = screenAudio
      ? pc.addTransceiver(screenAudio, { direction: 'sendrecv', streams: [this.screen] })
      : pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send(id, { description: pc.localDescription });
      } catch (e) { this.onError(e); }
      finally { peer.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send(id, { candidate });
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const up = state === 'connected';
      if (up !== peer.connected) {
        peer.connected = up;
        this.onPeers(this.connected());
      }
      if (up) {
        // Recovered, so the next failure starts with every attempt left.
        clearTimeout(peer.watch);
        peer.watch = null;
        peer.recoveries = 0;
        peer.reported = false;
      } else if (state === 'failed') {
        this.watch(id, peer, 0);
      } else if (state === 'disconnected') {
        this.watch(id, peer, MESH_DISCONNECTED_MS);
      }
    };
    pc.ontrack = ({ track, streams, transceiver }) => {
      // Never play our own published media back (screenshare feedback loop).
      const localTracks = [
        ...(this.stream?.getTracks?.() || []),
        ...(this.camera?.getTracks?.() || []),
        ...(this.screen?.getTracks?.() || []),
      ];
      if (localTracks.includes(track)) return;
      // A late-swapped track announces no stream.
      const stream = streams[0] || new MediaStream([track]);
      // Video tracks are told apart only by transceiver; `track.kind` is a fallback.
      if (transceiver === peer.screen) this.incoming(id, peer, track, stream, 'screenOf', 'onScreen');
      else if (transceiver === peer.camera) this.incoming(id, peer, track, stream, 'cameraOf', 'onCamera');
      else if (transceiver === peer.screenAudio) this.play(id, peer, stream, 'screenAudioEl', false);
      else if (track.kind === 'video') this.incoming(id, peer, track, stream, 'screenOf', 'onScreen');
      else this.play(id, peer, stream);
    };
    return peer;
  }

  /// Playback uses an `<audio>` element in the document (a detached one is silent in Safari); Chrome only feeds the analyser while an element consumes the stream.
  play(id, peer, stream, slot = 'audio', analyse = true) {
    if (!peer[slot]) {
      peer[slot] = document.createElement('audio');
      peer[slot].autoplay = true;
      peer[slot].hidden = true;
      document.body.appendChild(peer[slot]);
    }
    const el = peer[slot];
    const screen = slot === 'screenAudioEl';
    const streamSlot = screen ? 'screenAudioStream' : 'audioStream';
    const graphSlot = screen ? 'screenAudioGraph' : 'audioGraph';
    peer[streamSlot] = stream;
    el.srcObject = stream;
    el.muted = this.deafened;
    const level = screen
      ? (this.shareVolumes.get(id) ?? this.volumes.get(id) ?? 100)
      : (this.volumes.get(id) ?? 100);
    peer[graphSlot] = setPlaybackVolume(this.context, stream, el, peer[graphSlot], level);
    // The graph's own element needs the deafen flag too.
    setPlaybackMuted(peer[graphSlot], el, this.deafened);
    if (analyse) this.attachAnalyser(id, stream);
    Promise.resolve(el.play()).catch((e) => {
      // Autoplay policy rejection would otherwise be silent.
      this.onError(new Error(`${id} cannot be played back: ${e.message}`));
    });
  }

  attachAnalyser(id, stream) {
    if (!this.context) return;
    const peer = id === this.me ? this.self : this.peers.get(id);
    if (!peer) return;
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaStreamSource(stream).connect(analyser);
    peer.analyser = analyser;
    peer.buffer = new Uint8Array(analyser.frequencyBinCount);
  }

  tick = () => {
    if (!this.live) return;
    const now = performance.now();
    const next = new Set();
    const each = [[this.me, this.self], ...this.peers];
    for (const [id, peer] of each) {
      if (!peer?.analyser) continue;
      peer.analyser.getByteTimeDomainData(peer.buffer);
      let peak = 0;
      for (const v of peer.buffer) peak = Math.max(peak, Math.abs(v - 128));
      const loud = peak > SPEAKING_LEVEL
        && !(id === this.me && (this.muted || this.deafened));
      if (loud) this.since.set(id, now);
      if (now - (this.since.get(id) ?? -Infinity) < SPEAKING_HANG_MS) next.add(id);
    }
    if (!sameSet(next, this.speaking)) {
      this.speaking = next;
      this.onSpeaking(next);
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /// A later call replaces an earlier one: one timer per peer.
  watch(id, peer, after = MESH_STALL_MS) {
    clearTimeout(peer.watch);
    // Jitter so both sides don't offer in step.
    peer.watch = setTimeout(() => this.recover(id, peer), after + Math.random() * 500);
  }

  /// Rollback plus ICE restart, queued in the inbox.
  recover(id, peer) {
    peer.watch = null;
    if (!this.live || this.peers.get(id) !== peer || peer.connected) return;
    peer.inbox = peer.inbox.then(async () => {
      if (!this.live || this.peers.get(id) !== peer || peer.connected) return;
      peer.recoveries += 1;
      if (peer.recoveries > MESH_RECOVERIES_BEFORE_REPORT && !peer.reported) {
        peer.reported = true;
        this.onError(new Error(
          `no media path to ${id} -- this call may need a TURN server to relay it`,
        ));
      }
      try {
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setLocalDescription({ type: 'rollback' });
        }
        peer.pc.restartIce();
      } catch { /* closed under us, or mid-change: the next turn tries again */ }
      const backoff = Math.min(MESH_STALL_MS * 2 ** (peer.recoveries - 1), MESH_RECOVERY_CEILING_MS);
      if (this.peers.get(id) === peer && !peer.connected) this.watch(id, peer, backoff);
    });
  }

  /// In-flight signals were lost.
  recoverAll() {
    for (const [id, peer] of this.peers) if (!peer.connected) this.watch(id, peer, 0);
  }

  drop(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.watch);
    peer.watch = null;
    this.peers.delete(id);
    this.since.delete(id);
    if (peer.screenOf) { peer.screenOf = null; this.onScreen(id, null); }
    if (peer.cameraOf) { peer.cameraOf = null; this.onCamera(id, null); }
    stopPlaybackGraph(peer.audioGraph);
    stopPlaybackGraph(peer.screenAudioGraph);
    peer.audioGraph = null;
    peer.screenAudioGraph = null;
    if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); peer.audio = null; }
    if (peer.screenAudioEl) {
      peer.screenAudioEl.srcObject = null;
      peer.screenAudioEl.remove();
      peer.screenAudioEl = null;
    }
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    try { peer.pc.close(); } catch { /* already closed */ }
  }

  measurePing() {
    for (const peer of this.peers.values()) {
      if (!peer.connected || !peer.pc) continue;
      return rttFromPc(peer.pc);
    }
    return Promise.resolve(null);
  }
}
