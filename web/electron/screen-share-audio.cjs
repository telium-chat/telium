'use strict';

const VIRTUAL_MIC_LABEL = 'vencord-screen-share';

function createScreenShareAudioService({
  electronApp,
  platform = process.platform,
  loadVenmic = () => require('@vencord/venmic'),
  logger = console,
} = {}) {
  let PatchBay = null;
  let patchBay = null;
  let loadAttempted = false;
  let loadError = null;
  let hasPipewirePulse = null;

  function audioServicePid() {
    try {
      const proc = electronApp?.getAppMetrics?.()
        ?.find((entry) => entry?.name === 'Audio Service');
      return proc?.pid == null ? null : String(proc.pid);
    } catch {
      return null;
    }
  }

  function ensurePatchBay() {
    if (platform !== 'linux') return null;
    if (patchBay) return patchBay;
    if (loadAttempted && !PatchBay) return null;
    loadAttempted = true;

    try {
      const venmic = loadVenmic();
      PatchBay = venmic?.PatchBay || null;
      if (!PatchBay) throw new Error('@vencord/venmic did not expose PatchBay.');
      hasPipewirePulse = Boolean(PatchBay.hasPipeWire?.());
      patchBay = new PatchBay();
      return patchBay;
    } catch (error) {
      loadError = error;
      logger.warn?.(
        '[Telium desktop] Linux screenshare audio is unavailable:',
        error?.message || error,
      );
      PatchBay = null;
      patchBay = null;
      return null;
    }
  }

  function stop() {
    if (!patchBay) return false;
    try {
      patchBay.unlink();
      return true;
    } catch (error) {
      logger.warn?.(
        '[Telium desktop] Could not stop Linux screenshare audio:',
        error?.message || error,
      );
      return false;
    }
  }

  function shareablePlaybackTargets(instance) {
    if (typeof instance?.list !== 'function') return null;
    try {
      const rendererPid = audioServicePid();
      return (instance.list([]) || []).filter((node) => {
        if (!node || typeof node !== 'object') return false;
        // Diagnostics only see node properties, so this count is looser than the native routing below.
        if (node['media.class'] !== 'Stream/Output/Audio') return false;
        if (node['device.id']) return false;
        if (node['node.virtual'] === 'true') return false;
        if (rendererPid && node['application.process.id'] === rendererPid) return false;
        const name = String(node['node.name'] || node['node.description'] || '');
        if (name.includes('vencord-screen-share') || name.includes('vencord-sink')) return false;
        if (name.startsWith('venmic-loopback')) return false;
        return true;
      });
    } catch (error) {
      logger.warn?.(
        '[Telium desktop] Could not inspect Linux screenshare audio targets:',
        error?.message || error,
      );
      return null;
    }
  }

  function startSystem() {
    if (platform !== 'linux') {
      return {
        available: false,
        reason: 'unsupported-platform',
        deviceLabel: null,
        hasPipewirePulse: null,
        targetCount: null,
      };
    }

    const instance = ensurePatchBay();
    if (!instance) {
      return {
        available: false,
        reason: loadError?.message || 'venmic-unavailable',
        deviceLabel: null,
        hasPipewirePulse,
        targetCount: null,
      };
    }

    try {
      // A stale link can survive a failed getDisplayMedia; clear it first.
      try { instance.unlink(); } catch { /* nothing was linked */ }

      const exclude = [
        // Never feed microphone/input streams back into the screenshare.
        { 'media.class': 'Stream/Input/Audio' },
      ];
      const rendererPid = audioServicePid();
      if (rendererPid) {
        // Echo prevention (as in Vesktop): viewers must not hear the call routed back through shared system audio.
        exclude.push({ 'application.process.id': rendererPid });
      }

      // only_speakers=true accepts nodes feeding a speaker; start unmuted, since a permanently muted source was seen on real hardware.
      const linked = instance.link({
        mute: false,
        include: [],
        exclude: [
          ...exclude,
          { 'node.virtual': 'true' },
        ],
        ignore_devices: true,
        only_speakers: true,
        only_default_speakers: false,
      });
      if (linked === false) throw new Error('PipeWire refused the screenshare audio graph.');

      // venmic's list() is blocking, so the preceding link request has populated the graph by then.
      const targets = shareablePlaybackTargets(instance);
      return {
        available: true,
        reason: null,
        deviceLabel: VIRTUAL_MIC_LABEL,
        hasPipewirePulse,
        targetCount: targets?.length ?? null,
      };
    } catch (error) {
      try { instance.unlink(); } catch { /* best effort cleanup */ }
      logger.warn?.(
        '[Telium desktop] Could not route Linux screenshare audio:',
        error?.message || error,
      );
      return {
        available: false,
        reason: error?.message || 'venmic-link-failed',
        deviceLabel: null,
        hasPipewirePulse,
        targetCount: null,
      };
    }
  }

  return {
    startSystem,
    stop,
    dispose: stop,
    virtualMicLabel: VIRTUAL_MIC_LABEL,
  };
}

module.exports = {
  VIRTUAL_MIC_LABEL,
  createScreenShareAudioService,
};
