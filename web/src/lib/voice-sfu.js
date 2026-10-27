import {
  DisconnectReason, Room, RoomEvent, Track, VideoPreset, VideoQuality,
} from 'livekit-client';
import {
  applyContentHint, contentPreset, publishBudget, simulcastLadder, watchQualityLayer,
} from './screenShare.js';
import { micConstraints, normalizeNoiseMode } from './denoise.js';
import {
  CAMERA_CAPTURE, clampPlaybackVolume, createPlaybackContext, displayMedia, micLive,
  openDenoiser, setPlaybackMuted, setPlaybackVolume, stopPlaybackGraph, userMedia, sameSet,
  rttFromPc, MAX_BITRATE_ATTRIBUTE, WATCH_TOPIC, preferredScreenCodec,
} from './voice-media.js';
import {
  KeyTrouble, keyFailure, unopenedMedia,
} from './voice-keys.js';

// SFU voice via the LiveKit engine behind `telium-sfu`; the guild join token is spent at `POST {endpoint}/session`. Same surface as `MeshCall`.

/// A renewal that could not land is retried after this long, so the grant the
/// call resumes with never expires.
const RENEW_RETRY_MS = 30_000;

export class SfuCall {
  constructor({
    me, onSpeaking, onPeers, onScreen, onCamera, onScreenEnd, onCameraEnd, onError,
    onAudioBlocked, onNoiseFallback, onDropped, onRemoved, onKeyTrouble, endpoint, joinToken,
    iceServers, maxBitrate, policy, e2ee, noiseMode, tokenTtl, renewToken,
  }) {
    this.me = me;
    this.endpoint = endpoint;
    // 'relay' hides this device's address from the SFU operator too.
    this.policy = policy === 'relay' ? 'relay' : 'all';
    this.e2ee = e2ee || null;
    // Media we can't open, reported once it outlasts a key-rotation lag, once per person per key.
    this.unopened = new KeyTrouble({
      report: (e, who) => {
        // The report is the symptom of this device sitting behind the group;
        // the caller asks the server where the group stands before the toast
        // is even read.
        try { this.onKeyTrouble?.(who); } catch { /* a UI callback must not break the call */ }
        this.onError(new Error(unopenedMedia(e, who)));
      },
    });
    this.cryptorTrouble = new Set();
    // Who has sent media in the clear, reported once.
    this.plainRefused = new Set();
    this.joinToken = joinToken;
    this.ice = Array.isArray(iceServers) ? iceServers : [];
    // The guild's ceiling; `budget` is settled from the smallest figure once connected.
    this.maxBitrate = Number(maxBitrate) > 0 ? Number(maxBitrate) : null;
    this.budget = null;
    this.onSpeaking = onSpeaking || (() => {});
    this.onPeers = onPeers || (() => {});
    this.onScreen = onScreen || (() => {});
    this.onCamera = onCamera || (() => {});
    this.onScreenEnd = onScreenEnd || (() => {});
    this.onCameraEnd = onCameraEnd || (() => {});
    this.onError = onError || (() => {});
    this.onAudioBlocked = onAudioBlocked || (() => {});
    this.onNoiseFallback = onNoiseFallback || (() => {});
    // Called when the connection is gone for good, instead of reporting.
    this.onDropped = onDropped || null;
    // The server removed this seat (a moderator, or a sweep that raced a
    // reconnect); the caller checks with the guild server before reacting.
    this.onRemoved = onRemoved || null;
    // Media failed to open for longer than a key-rotation lag; the caller
    // asks the encryption group where it stands.
    this.onKeyTrouble = onKeyTrouble || null;
    // The join token TTL in seconds; `renewToken` mints a fresh one for the
    // session this call already holds. LiveKit checks the token on every
    // resume, so an expired one turns the first network blip into a drop.
    this.tokenTtl = Number(tokenTtl) > 0 ? Number(tokenTtl) : 0;
    this.renewToken = renewToken || null;
    this.renewTimer = null;
    // Set once `renew` finds the room engine without its token property: the
    // grant was minted but could not be installed, said once rather than
    // silently on every renewal.
    this.renewInstallBroken = false;

    this.room = null;
    this.live = false;
    // Handed to LiveKit as a track processor, which owns the capture track.
    this.denoiser = null;
    this.noiseMode = normalizeNoiseMode(noiseMode);
    this.muted = false;
    this.deafened = false;
    this.micError = null;
    this.speaking = new Set();
    this.connected = new Set();
    this.roster = new Set();
    this.audioEls = new Map();
    this.context = null;
    this.volumes = new Map();
    this.shareVolumes = new Map();
    this.screens = new Map();
    this.cameras = new Map();
    // Screen shares are not auto-subscribed; the viewer presses Watch.
    this.screenSubscriptions = new Set();
    // Requested layer per streamer ('auto' when unset); the SFU pushes it back on Watch.
    this.watchQualities = new Map();
    this.cameraFacing = 'user';
  }

  /// Smallest positive ceiling of the SFU attribute, the `/session` response and the guild join response.
  settleBudget(session) {
    const attribute = Number(this.room?.localParticipant?.attributes?.[MAX_BITRATE_ATTRIBUTE]);
    const caps = [attribute, Number(session?.max_bitrate), this.maxBitrate]
      .filter((n) => Number.isFinite(n) && n > 0);
    this.budget = caps.length ? publishBudget(Math.min(...caps)) : null;
    return this.budget;
  }

  /// `content` is the screenshare preset ('detail'/'motion'); a camera has none.
  videoPublishOptions(kind, capture, content = null) {
    const slice = this.budget?.[kind];
    // No ceiling: LiveKit's ladder, but content still steers the encoder.
    if (!slice) {
      const fallback = content ? contentPreset(content).degradation : null;
      const codec = kind === 'screen' ? preferredScreenCodec() : null;
      return {
        simulcast: true,
        ...(codec ? { videoCodec: codec } : {}),
        ...(fallback ? { degradationPreference: fallback } : {}),
      };
    }
    const ladder = simulcastLadder(capture, slice, content);
    const layers = ladder.layers.map((l) => new VideoPreset(
      l.width, l.height, l.encoding.maxBitrate, l.encoding.maxFramerate,
    ));
    const encodingKey = kind === 'screen' ? 'screenShareEncoding' : 'videoEncoding';
    const layersKey = kind === 'screen' ? 'screenShareSimulcastLayers' : 'videoSimulcastLayers';
    // With simulcast on and no layers named, LiveKit would add presets exceeding the ceiling.
    const codec = kind === 'screen' ? preferredScreenCodec() : null;
    return {
      simulcast: layers.length > 0,
      ...(codec ? { videoCodec: codec } : {}),
      [encodingKey]: ladder.top,
      ...(layers.length ? { [layersKey]: layers } : {}),
      ...(ladder.degradationPreference
        ? { degradationPreference: ladder.degradationPreference }
        : {}),
    };
  }

  audioPublishOptions() {
    const audio = this.budget?.audio;
    return audio ? { audioPreset: { maxBitrate: audio } } : undefined;
  }

  async start() {
    this.live = true;

    // Session failures propagate; only a microphone failure returns false.
    const session = await this.fetchSession();
    const { url, token } = session;
    const rtcConfig = {};
    if (this.ice.length) rtcConfig.iceServers = this.ice;
    if (this.policy === 'relay') rtcConfig.iceTransportPolicy = 'relay';
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      rtcConfig: Object.keys(rtcConfig).length ? rtcConfig : undefined,
      ...(this.e2ee ? { e2ee: { keyProvider: this.e2ee.keyProvider, worker: this.e2ee.worker } } : {}),
    });
    this.wireEvents();
    if (this.e2ee) {
      this.room.on(RoomEvent.EncryptionError, (e, participant) => this.encryptionError(e, participant));
      // Before connecting, so not one frame is published in the clear.
      await this.room.setE2EEEnabled(true);
    }
    await this.room.connect(url, token, { autoSubscribe: false });
    this.settleBudget(session);
    this.scheduleRenew();
    // TrackPublished only fires for later publications; reconcile existing ones.
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        this.onTrackPublished(pub, participant);
      }
    }
    this.onAudioBlocked(!this.room.canPlaybackAudio);

    // The mic is best-effort: a denied or absent mic is one silent tile, not a failed call.
    try {
      const publication = await this.room.localParticipant.setMicrophoneEnabled(
        true,
        micConstraints(this.noiseMode),
        this.audioPublishOptions(),
      );
      if (!publication) {
        this.micError = new Error('LiveKit did not publish a microphone track.');
        return false;
      }
      this.micError = null;
      // Failing to denoise is not failing to publish; `route` already reported via `onNoiseFallback`.
      await this.route();
      // Publishing enables the mic; someone who joined muted or deafened is owed it off again before a word leaves.
      if (!micLive(this)) this.applyMute();
      return true;
    } catch (e) {
      this.micError = e;
      return false;
    }
  }

  micTrack() {
    const publication = this.room?.localParticipant?.getTrackPublication?.(Track.Source.Microphone);
    return publication?.audioTrack || null;
  }

  /// Via LiveKit's `TrackProcessor` (no renegotiation). Failures fall back to the browser's suppressor.
  async route() {
    const track = this.micTrack();
    if (!track) return;

    if (this.noiseMode !== 'neural') {
      if (this.denoiser) {
        await track.stopProcessor?.().catch?.(() => {});
        this.denoiser = null;
      }
      return;
    }
    if (this.denoiser) return;

    try {
      const { neuralProcessor } = await import('./denoise-chain.js');
      const chain = await openDenoiser((reason) => this.surrender(reason));
      // `setProcessor` needs an AudioContext already on the track; ours is 48 kHz, which the model needs.
      await chain.open();
      track.setAudioContext?.(chain.context);
      const processor = neuralProcessor(chain);
      await track.setProcessor(processor);
      this.denoiser = chain;
    } catch (error) {
      this.denoiser = null;
      this.surrender(error?.reason || 'load-failed');
    }
  }

  async setNoiseMode(mode) {
    const next = normalizeNoiseMode(mode);
    if (next === this.noiseMode) return;
    this.noiseMode = next;
    if (!this.live) return;
    const track = this.micTrack();
    if (track) {
      try {
        await track.applyConstraints(micConstraints(next));
      } catch {
        // The engine can't reconfigure in place; reopen the device.
        await track.restartTrack?.(micConstraints(next))?.catch?.(() => {});
      }
    }
    await this.route();
  }

  surrender(reason) {
    if (this.noiseMode !== 'neural') return;
    this.noiseMode = 'browser';
    const track = this.micTrack();
    this.denoiser?.setBypass?.(true);
    track?.applyConstraints?.(micConstraints('browser'))?.catch?.(() => {});
    try { this.onNoiseFallback(reason); } catch { /* a UI callback must not break the call */ }
  }

  async fetchSession() {
    const base = this.endpoint.replace(/\/$/, '');
    const resp = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.joinToken }),
    });
    if (!resp.ok) {
      const failed = new Error(`SFU /session returned ${resp.status}`);
      // So a caller can tell an SFU that answered 'no' from one that is down.
      failed.status = resp.status;
      throw failed;
    }
    const data = await resp.json();
    if (!data.url || !data.token) throw new Error('SFU /session returned no url/token');
    return data;
  }

  /// Mid-call: swap in a fresh grant so the resume after the next network blip
  /// is not refused as expired. A failed renewal is retried after a short
  /// pause rather than at the next half-TTL, so the grant never lapses.
  scheduleRenew(after) {
    clearTimeout(this.renewTimer);
    if (!this.renewToken || !this.tokenTtl || !this.live) return;
    const wait = after ?? Math.max(60_000, (this.tokenTtl / 2) * 1000);
    this.renewTimer = setTimeout(() => {
      this.renewTimer = null;
      if (!this.live) return;
      this.renew()
        .then((ok) => this.scheduleRenew(ok ? undefined : RENEW_RETRY_MS))
        .catch(() => this.scheduleRenew(RENEW_RETRY_MS));
    }, wait);
  }

  /// True when the call is holding a fresh grant.
  async renew() {
    if (!this.room) return false;
    try {
      this.joinToken = await this.renewToken();
      const session = await this.fetchSession();
      if (!this.live || !this.room) return false;
      // livekit-client re-reads `engine.token` on every resume and full
      // reconnect; the property is public on both classes. If an upgrade
      // takes it away, say so once — a silent skip here would leave the call
      // renewing grants it can never install, and the first blip after the
      // token's expiry would drop it for no visible reason.
      const engine = this.room.engine;
      if (engine && typeof engine === 'object' && 'token' in engine) {
        engine.token = session.token;
      } else if (!this.renewInstallBroken) {
        this.renewInstallBroken = true;
        console.warn('livekit-client no longer exposes engine.token; the renewed join token could not be installed on the live session');
      }
      this.settleBudget(session);
      return true;
    } catch {
      // The next tick tries again; nothing is lost until a blip forces a resume.
      return false;
    }
  }

  /// The ring keeps earlier keys for peers a commit behind.
  async rekey(raw, epoch) {
    await this.e2ee?.keyProvider?.setEpochKey(raw, epoch);
    this.keyArrived();
  }

  /// A new key may unblock whoever we couldn't open.
  keyArrived() {
    this.unopened.keyArrived();
    this.cryptorTrouble.clear();
  }

  /// A key failure waits to see whether it lasts (`KeyTrouble`); anything else is the worker's to explain.
  encryptionError(e, participant) {
    const who = participant?.identity || null;
    if (keyFailure(e)) {
      this.unopened.note(who, e);
      return;
    }
    if (who) {
      if (this.cryptorTrouble.has(who)) return;
      this.cryptorTrouble.add(who);
    }
    this.onError(new Error(unopenedMedia(e, who)));
  }

  wireEvents() {
    this.room
      .on(RoomEvent.ParticipantConnected, () => this.recompute())
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.unopened.forget(p.identity);
        this.detach(p.identity);
        this.recompute();
      })
      .on(RoomEvent.TrackPublished, (pub, participant) => this.onTrackPublished(pub, participant))
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => this.onTrack(track, pub, participant))
      .on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
        this.detach(participant.identity, pub?.source ?? track?.source);
        this.recompute();
      })
      // The browser's "Stop sharing" bar unpublishes without our button.
      .on(RoomEvent.LocalTrackPublished, (pub) => this.onLocalTrack(pub))
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        const source = pub?.source;
        if (source !== Track.Source.ScreenShare && source !== Track.Source.Camera) return;
        this.detach(this.me, source);
        if (this.live) {
          if (source === Track.Source.ScreenShare) this.onScreenEnd();
          else this.onCameraEnd();
        }
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const ids = new Set(speakers.map((s) => s.identity));
        this.speaking = ids;
        this.onSpeaking(ids);
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        this.onAudioBlocked(!this.room?.canPlaybackAudio);
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        this.onData(payload, participant, topic);
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (!this.live) return;
        // Deliberate teardowns are not voice trouble.
        if (
          reason === DisconnectReason.CLIENT_INITIATED
          || reason === DisconnectReason.ROOM_CLOSED
          || reason === DisconnectReason.ROOM_DELETED
        ) {
          return;
        }
        // The server removed the seat: a moderator, or the sweeper racing a
        // reconnect. The caller asks the guild server which, then rejoins or
        // leaves — staying connected to nothing is the one wrong answer.
        if (reason === DisconnectReason.PARTICIPANT_REMOVED) {
          this.onRemoved?.();
          return;
        }
        // LiveKit already tried to resume; another device taking the seat is not a drop, and rejoining would take it back.
        const error = new Error(`LiveKit disconnected: ${reason}`);
        if (this.onDropped && reason !== DisconnectReason.DUPLICATE_IDENTITY) this.onDropped(error);
        else this.onError(error);
      });
  }

  audioKey(identity, source) {
    return `${identity}\u0000${String(source ?? 'audio')}`;
  }

  isScreenSource(source) {
    return source === Track.Source.ScreenShare || source === Track.Source.ScreenShareAudio;
  }

  /// LiveKit passes unencrypted frames through unvouched, so they must not be subscribed. Only an explicit `false` is refused.
  plainInSealedCall(pub) {
    return Boolean(this.e2ee) && pub?.isEncrypted === false;
  }

  refusePlain(pub, participant) {
    pub?.setSubscribed?.(false);
    const who = participant?.identity || null;
    console.warn('refused an unencrypted track in an encrypted call', who, pub?.source);
    if (this.plainRefused.has(who)) return;
    this.plainRefused.add(who);
    this.onError(new Error(
      `${who ? `${who}’s` : 'Somebody’s'} media arrived unencrypted in an encrypted call, so it was not played.`,
    ));
  }

  onTrackPublished(pub, participant) {
    if (this.plainInSealedCall(pub)) {
      this.refusePlain(pub, participant);
      return;
    }
    const screen = this.isScreenSource(pub?.source);
    const wanted = screen ? this.screenSubscriptions.has(participant.identity) : true;
    const audio = pub?.kind === Track.Kind.Audio;
    pub?.setSubscribed?.(wanted && !(audio && this.deafened));
  }

  /// Only the server (no participant) may speak on `telium.watch`.
  onData(payload, participant, topic) {
    if (participant != null || topic !== WATCH_TOPIC) return;
    let message;
    try {
      message = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return;
    }
    if (!message || typeof message.streamer !== 'string') return;
    this.setWatchQuality(message.streamer, message.quality);
  }

  setScreenSubscription(identity, on, quality) {
    if (!identity || identity === this.me) return;
    if (on) this.screenSubscriptions.add(identity);
    else this.screenSubscriptions.delete(identity);
    if (on && quality !== undefined) this.watchQualities.set(identity, quality);
    if (!on) this.watchQualities.delete(identity);
    const participant = this.room?.remoteParticipants.get(identity);
    if (!participant) return;
    for (const pub of participant.trackPublications.values()) {
      if (!this.isScreenSource(pub?.source)) continue;
      if (this.plainInSealedCall(pub)) continue;
      const audio = pub?.kind === Track.Kind.Audio;
      pub.setSubscribed(on && !(audio && this.deafened));
    }
    if (on) this.applyWatchQuality(identity);
    else {
      this.detach(identity, Track.Source.ScreenShare);
      this.detach(identity, Track.Source.ScreenShareAudio);
    }
  }

  setWatchQuality(identity, quality) {
    if (!identity || identity === this.me) return;
    this.watchQualities.set(identity, quality || 'auto');
    this.applyWatchQuality(identity);
  }

  /// `auto` is the highest layer (adaptive stream trims it); a named quality caps it.
  applyWatchQuality(identity) {
    const participant = this.room?.remoteParticipants.get(identity);
    if (!participant) return;
    const layer = watchQualityLayer(this.watchQualities.get(identity) ?? 'auto');
    for (const pub of participant.trackPublications.values()) {
      if (pub?.source !== Track.Source.ScreenShare || pub?.kind !== Track.Kind.Video) continue;
      pub.setVideoQuality?.(layer ?? VideoQuality.HIGH);
    }
  }

  screenShareHasAudio() {
    if (!this.room) return false;
    return [...this.room.localParticipant.audioTrackPublications.values()]
      .some((pub) => pub.source === Track.Source.ScreenShareAudio && Boolean(pub.track));
  }

  onTrack(track, pub, participant) {
    // Local screen audio must never become a playback element on the sharer's device.
    if (participant?.identity === this.me) return;
    if (this.plainInSealedCall(pub)) {
      this.refusePlain(pub, participant);
      return;
    }
    if (track.kind === Track.Kind.Audio) {
      // In the document (detached is silent in Safari); one element per source.
      const source = pub?.source ?? track.source ?? 'audio';
      const el = document.createElement('audio');
      el.autoplay = true;
      el.hidden = true;
      document.body.appendChild(el);
      track.attach(el);
      const stream = el.srcObject;
      const audio = {
        identity: participant.identity, source, el, stream, graph: null,
      };
      this.audioEls.set(this.audioKey(participant.identity, source), audio);
      el.muted = this.deafened;
      const level = this.isScreenSource(source)
        ? (this.shareVolumes.get(participant.identity)
          ?? this.volumes.get(participant.identity) ?? 100)
        : (this.volumes.get(participant.identity) ?? 100);
      if (level > 100 && !this.context) this.context = createPlaybackContext();
      audio.graph = setPlaybackVolume(this.context, stream, el, audio.graph, level);
      setPlaybackMuted(audio.graph, el, this.deafened);
      Promise.resolve(el.play()).catch(() => {
        // Subscription may outlive its gesture; surface the Resume-audio control.
        this.onAudioBlocked(true);
      });
    } else if (track.kind === Track.Kind.Video) {
      // Screen and camera are told apart only by source.
      this.show(participant.identity, track, pub?.source ?? track.source);
      // Apply a quality picked before the share arrived.
      if ((pub?.source ?? track.source) === Track.Source.ScreenShare) {
        this.applyWatchQuality(participant.identity);
      }
    }
    this.recompute();
  }

  onLocalTrack(pub) {
    if (!pub?.track) return;
    this.show(this.me, pub.track, pub.source);
  }

  slot(source) {
    if (source === Track.Source.ScreenShare) return ['screens', 'onScreen'];
    if (source === Track.Source.Camera) return ['cameras', 'onCamera'];
    return null;
  }

  show(identity, track, source) {
    const slot = this.slot(source);
    if (!slot) return this.recompute();
    const raw = track.mediaStreamTrack;
    // Build from the current track: restartTrack() swaps the MediaStreamTrack under the same object.
    const stream = raw ? new MediaStream([raw]) : (track.mediaStream || null);
    if (!stream) return;
    const [map, notify] = slot;
    // Skip a track already shown: a second stream would blank the element; `show` is reached from both caller and publish event.
    const held = this[map].get(identity);
    if (raw && held?.getVideoTracks?.()[0] === raw) return;
    this[map].set(identity, stream);
    this[notify](identity, stream);
  }

  detach(identity, source) {
    // No source: the participant left, drop everything.
    for (const [map, notify] of [['screens', 'onScreen'], ['cameras', 'onCamera']]) {
      const mine = source === undefined || this.slot(source)?.[0] === map;
      if (mine && this[map].delete(identity)) this[notify](identity, null);
    }
    if (source !== undefined) {
      const key = this.audioKey(identity, source);
      const audio = this.audioEls.get(key);
      if (audio) {
        stopPlaybackGraph(audio.graph);
        audio.el.srcObject = null;
        audio.el.remove();
        this.audioEls.delete(key);
      }
      return;
    }
    for (const [key, audio] of [...this.audioEls]) {
      if (audio.identity !== identity) continue;
      stopPlaybackGraph(audio.graph);
      audio.el.srcObject = null;
      audio.el.remove();
      this.audioEls.delete(key);
    }
  }

  recompute() {
    const ids = new Set();
    for (const p of this.room.remoteParticipants.values()) {
      const tracks = [
        ...p.audioTrackPublications.values(),
        ...p.videoTrackPublications.values(),
      ];
      if (tracks.some((t) => t.isSubscribed)) ids.add(p.identity);
    }
    if (!sameSet(ids, this.connected)) {
      this.connected = ids;
      this.onPeers(ids);
    }
  }

  sync(userIds) {
    if (!this.live) return;
    this.roster = new Set(userIds.filter((id) => id !== this.me));
  }

  accept() { return Promise.resolve(); }

  applyMute() {
    this.room?.localParticipant
      .setMicrophoneEnabled(micLive(this))
      .catch((e) => this.onError(e));
  }

  setMuted(muted) {
    this.muted = muted;
    this.applyMute();
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    this.applyMute();
    // Screen audio follows the explicit Watch choice, as its video does.
    for (const p of this.room?.remoteParticipants.values() || []) {
      for (const pub of p.audioTrackPublications.values()) {
        if (this.plainInSealedCall(pub)) continue;
        const screen = this.isScreenSource(pub.source);
        const wanted = !screen || this.screenSubscriptions.has(p.identity);
        pub.setSubscribed(!deafened && wanted);
      }
    }
    for (const audio of this.audioEls.values()) setPlaybackMuted(audio.graph, audio.el, deafened);
  }

  setVolume(userId, percent) {
    const value = clampPlaybackVolume(percent);
    this.volumes.set(userId, value);
    if (value > 100 && !this.context) this.context = createPlaybackContext();
    const carries = !this.shareVolumes.has(userId);
    for (const audio of this.audioEls.values()) {
      if (audio.identity !== userId) continue;
      if (!this.isScreenSource(audio.source) || carries) {
        audio.graph = setPlaybackVolume(this.context, audio.stream, audio.el, audio.graph, value);
      }
    }
  }

  setShareVolume(userId, percent) {
    const value = clampPlaybackVolume(percent);
    this.shareVolumes.set(userId, value);
    if (value > 100 && !this.context) this.context = createPlaybackContext();
    for (const audio of this.audioEls.values()) {
      if (audio.identity === userId && this.isScreenSource(audio.source)) {
        audio.graph = setPlaybackVolume(this.context, audio.stream, audio.el, audio.graph, value);
      }
    }
  }

  async resumeAudio() {
    if (!this.room) return false;
    await this.room.startAudio();
    const ready = this.room.canPlaybackAudio;
    this.onAudioBlocked(!ready);
    return ready;
  }

  /// Throws if permission is refused or there is no camera, so the caller can revert.
  async setVideoEnabled(on, { facingMode = this.cameraFacing } = {}) {
    if (!this.room) return false;
    if (on) userMedia();
    const publication = await this.room.localParticipant.setCameraEnabled(
      on,
      on ? {
        facingMode,
        resolution: {
          width: CAMERA_CAPTURE.width, height: CAMERA_CAPTURE.height, frameRate: CAMERA_CAPTURE.fps,
        },
      } : undefined,
      on ? this.videoPublishOptions('camera', CAMERA_CAPTURE) : undefined,
    );
    if (on && !publication) return false;
    if (on) {
      this.cameraFacing = facingMode;
      // Shown here, not via `LocalTrackPublished`: LiveKit mutes a camera off, so re-enabling yields a new track with no publish event. `show` dedupes.
      if (publication.track) this.show(this.me, publication.track, Track.Source.Camera);
    } else this.detach(this.me, Track.Source.Camera);
    return on;
  }

  async switchCamera(facingMode = 'environment') {
    if (!this.room) return false;
    const publications = [...this.room.localParticipant.videoTrackPublications.values()];
    const publication = publications.find((pub) => pub.source === Track.Source.Camera);
    const track = publication?.track;
    if (!track?.restartTrack) return false;
    await track.restartTrack({ facingMode });
    this.cameraFacing = facingMode;
    this.show(this.me, track, Track.Source.Camera);
    return true;
  }

  /// Throws if the picker is dismissed. The simulcast ladder is sized from `settings`.
  async setScreenShareEnabled(on, settings = { width: 1920, height: 1080, fps: 30 }) {
    if (!this.room) return false;
    // Checked first so an insecure origin gets a clear error.
    if (on) displayMedia();
    // A request only; callers check `screenShareHasAudio`.
    const wantsAudio = settings?.audio !== false;
    const publication = await this.room.localParticipant.setScreenShareEnabled(
      on,
      on ? { audio: wantsAudio } : undefined,
      on
        ? {
          ...this.videoPublishOptions('screen', settings, settings?.content),
          ...this.audioPublishOptions(),
        }
        : undefined,
    );
    if (on && !publication) return false;
    // LiveKit captured the track itself, so stamp the hint on the published track.
    if (on) applyContentHint(publication?.track?.mediaStreamTrack, settings?.content);
    // Also shown here, for parity with the camera; `show` drops the duplicate.
    if (on && publication.track) this.show(this.me, publication.track, Track.Source.ScreenShare);
    if (!on) {
      this.detach(this.me, Track.Source.ScreenShare);
      this.detach(this.me, Track.Source.ScreenShareAudio);
    }
    return on;
  }

  measurePing() {
    try {
      const pc = this.room?.engine?.pcManager?.publisher
        || this.room?.engine?.pcManager?.subscriber;
      return pc ? rttFromPc(pc) : Promise.resolve(null);
    } catch {
      return Promise.resolve(null);
    }
  }

  stop() {
    // Idempotent; a throwing UI callback must not abort teardown.
    this.live = false;
    clearTimeout(this.renewTimer);
    this.renewTimer = null;
    const room = this.room;
    this.room = null;
    // The processor and its AudioContext are ours; LiveKit won't close them.
    const denoiser = this.denoiser;
    this.denoiser = null;
    denoiser?.stop?.().catch?.(() => {});

    try { this.onAudioBlocked(false); } catch { /* UI callback must not block teardown */ }
    for (const audio of this.audioEls.values()) {
      stopPlaybackGraph(audio.graph);
      audio.el.srcObject = null;
      audio.el.remove();
    }
    this.audioEls.clear();
    this.context?.close?.().catch?.(() => {});
    this.context = null;
    this.screenSubscriptions.clear();
    this.watchQualities.clear();
    for (const identity of [...this.screens.keys()]) {
      try { this.onScreen(identity, null); } catch { /* keep tearing down */ }
    }
    this.screens.clear();
    for (const identity of [...this.cameras.keys()]) {
      try { this.onCamera(identity, null); } catch { /* keep tearing down */ }
    }
    this.cameras.clear();

    try {
      const disconnecting = room?.disconnect();
      disconnecting?.catch?.(() => {});
    } catch { /* already gone */ }
    try { this.e2ee?.worker?.terminate?.(); } catch { /* already gone */ }
    try { this.e2ee?.keyProvider?.dispose?.(); } catch { /* already gone */ }

    this.speaking = new Set();
    this.connected = new Set();
    try { this.onSpeaking(new Set()); } catch { /* keep teardown total */ }
    try { this.onPeers(new Set()); } catch { /* keep teardown total */ }
  }
}

// Conversation-call E2EE on an SFU: every group member exports the same secret per epoch; the epoch picks the slot in LiveKit's key ring so frames sealed just before a membership change still open.
