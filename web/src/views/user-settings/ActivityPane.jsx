import { useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { Hint, Notice, Section, Switch } from '../../components/index.js';
import { RichActivityCard } from '../../components/RichActivityCard.jsx';
import { richPresenceKinds } from '../../lib/rich-presence.js';

function wineBridgeMessage(status) {
  if (!status) return 'Wine/Proton bridge: starting…';

  const reasons = {
    'proxy-auth-missing': 'the Wine service did not receive its private Telium connection token',
    'proxy-start-failed': 'Telium could not start its private localhost RPC proxy',
    'spawn-failed': 'Telium could not run the short-lived Wine service starter',
    'auto-install-failed': 'Telium could not install the Proton RPC service while the prefix was idle',
    'auto-install-marker-failed': 'the Proton RPC service installed, but Telium could not record the installation state',
    'config-write-failed': 'Telium could not give the installed Proton RPC service fresh connection credentials',
    'steam-auto-service-not-ready': 'the installed Proton RPC service did not appear in the game’s Wine server; close the game once and Telium will repair the installation',
    'service-path-failed': 'Wine could not resolve the Telium RPC service executable path',
    'service-manager-failed': 'Wine’s service manager could not be opened for the Telium RPC service',
    'service-stop-failed': 'Wine could not stop the existing Telium RPC service before refreshing it',
    'service-copy-failed': 'Wine could not replace the Telium RPC service executable in the Proton prefix',
    'service-register-failed': 'Wine could not register the Telium RPC service in the Proton prefix',
    'service-config-failed': 'Wine could not refresh the Telium RPC service configuration',
    'service-install-failed': 'Telium could not register or refresh its Wine RPC service',
    'service-start-failed': 'Wine could not start Telium’s RPC service',
    'service-ready-timeout': 'Wine accepted the service start but the service did not prove that its Discord named pipe was created',
    'scan-failed': 'Telium could not scan running Wine processes',
    'rpc-socket-unavailable': 'Telium’s local arRPC socket is unavailable',
    'bridge-missing': 'the packaged Wine helper is missing',
  };

  if (status.reason) {
    return `Wine/Proton bridge problem: ${reasons[status.reason] || status.reason}.`;
  }

  if (status.state === 'disabled') return 'Wine/Proton bridge: disabled.';
  if (status.state === 'watching') return 'Wine/Proton bridge: ready; waiting for a Wine/Proton game.';
  if (status.state === 'wine-detected') return 'Wine/Proton application detected; preparing Rich Presence…';
  if (status.state === 'steam-install-pending') {
    return 'First-time Steam/Proton RPC setup is queued. Close the game once; Telium will install the bridge only after the Proton prefix is idle.';
  }
  if (status.state === 'steam-installing') {
    return 'Installing Telium’s auto-start RPC service in the idle Proton prefix…';
  }
  if (status.state === 'steam-restart-required') {
    return 'Steam/Proton RPC service installed. Restart the game once to enable full Rich Presence.';
  }
  if (status.state === 'bridge-starting') {
    if (status.launchMode === 'steam-auto-service') {
      return 'Steam/Proton RPC service is starting inside the game’s Wine server and authenticating with Telium…';
    }
    return 'Wine detected; starting Telium’s short-lived RPC service starter…';
  }
  if (status.state === 'bridge-ready') {
    if (status.launchMode === 'steam-auto-service') {
      return 'Steam/Proton RPC service created the Discord pipe in the game’s Wine server and is waiting for the game to connect.';
    }
    return 'Wine/Proton RPC service created the Discord pipe and is waiting for the game to connect.';
  }
  if (status.state === 'relaying') return 'Wine/Proton Rich Presence is connected and relaying to Telium.';
  return 'Wine/Proton bridge: waiting for a supported game.';
}

function mprisMessage(status) {
  if (!status) return 'Linux music detector: starting…';
  if (status.state === 'disabled') return 'Linux music detector: disabled.';
  if (status.state === 'starting') return 'Linux music detector: connecting to the MPRIS session bus…';
  if (status.state === 'unsupported') return 'Native MPRIS music detection is available on Linux desktop builds.';

  if (status.state === 'unavailable') {
    const reasons = {
      'dependency-missing': 'the packaged D-Bus library could not be loaded',
      'session-bus-error': 'the Linux session D-Bus connection failed',
      'session-bus-unavailable': 'Telium could not connect to the Linux session D-Bus',
      'startup-failed': 'the MPRIS detector failed to start',
      'worker-exited': 'the desktop activity worker exited',
      'worker-not-ready': 'the desktop activity worker exited before it was ready',
    };
    return `Linux music detector problem: ${reasons[status.reason] || status.reason || 'unknown error'}.`;
  }

  if (status.state === 'stopped') return 'Linux music detector: stopped.';
  if (status.state === 'no-players' || status.players === 0) {
    return 'MPRIS is connected, but no media players are advertising themselves on the session bus.';
  }

  const names = Array.isArray(status.names) && status.names.length
    ? ` Detected: ${status.names.join(', ')}.`
    : '';
  if (status.readable < status.players) {
    return `MPRIS sees ${status.players} media player${status.players === 1 ? '' : 's'}, but Telium can read ${status.readable}. ${status.playing || 0} report playing.${names}`;
  }
  if (status.playing > 0) {
    return `MPRIS is connected: ${status.players} media player${status.players === 1 ? '' : 's'} visible, ${status.playing} playing.${names}`;
  }
  return `MPRIS is connected: ${status.players} media player${status.players === 1 ? '' : 's'} visible; none currently reports Playing.${names}`;
}

function windowsMediaMessage(status) {
  if (!status) return 'Windows media detector: starting…';
  if (status.state === 'disabled') return 'Windows media detector: disabled.';
  if (status.state === 'starting') return 'Windows media detector: connecting to Windows audio sessions…';
  if (status.state === 'unsupported') return 'Windows media detection is available on Windows desktop builds.';
  if (status.state === 'unavailable') {
    const reasons = {
      'spawn-failed': 'the packaged Windows media helper could not start',
      'helper-error': 'the Windows media helper reported an error',
      'helper-exited': 'the Windows media helper exited unexpectedly',
      'startup-failed': 'the Windows media detector failed to start',
      'worker-exited': 'the desktop activity worker exited',
      'worker-not-ready': 'the desktop activity worker exited before it was ready',
    };
    const detail = status.detail ? ` (${status.detail})` : '';
    return `Windows media detector problem: ${reasons[status.reason] || status.reason || 'unknown error'}.${detail}`;
  }
  if (status.state === 'stopped') return 'Windows media detector: stopped.';
  if (status.state === 'no-players' || status.playing === 0) {
    return 'Windows audio-session detection is ready, but no media app is actively playing audio.';
  }
  const names = Array.isArray(status.names) && status.names.length
    ? ` Detected: ${status.names.join(', ')}.`
    : '';
  return `Windows media detector: ${status.playing} active audio session${status.playing === 1 ? '' : 's'}.${names}`;
}

function rpcMessage(status) {
  if (!status) return 'Game Rich Presence RPC: starting…';
  if (status.state === 'disabled') return 'Game Rich Presence RPC: disabled.';
  if (!status.available) return 'Game Rich Presence RPC is unavailable.';
  if (status.state === 'relaying') return 'Full game Rich Presence is connected and relaying to Telium.';
  if (status.state === 'connected') {
    return 'A Discord RPC client is connected to Telium; waiting for its Rich Presence activity.';
  }
  if (status.earlierPipeOccupied) {
    return `Telium is listening on Discord RPC pipe ${status.slot}. Another Discord-compatible app owns pipe 0. Close that app; Telium will automatically reclaim pipe 0 within a few seconds. You can then reopen the other app, but restart any game that was already running so its RPC reconnects to Telium.`;
  }
  return `Game Rich Presence RPC is ready on pipe ${status.slot ?? 0}; waiting for a game to connect.`;
}

export function ActivityPane() {
  const store = useStore();
  useStoreEvent('prefs', 'rich-presence');
  const current = store.desktopRichActivities || (store.desktopRichActivity ? [store.desktopRichActivity] : []);
  const kinds = richPresenceKinds(store);
  const enabled = kinds.game || kinds.music || kinds.video;
  const [wineStatus, setWineStatus] = useState(null);
  const [mprisStatus, setMprisStatus] = useState(null);
  const [windowsMediaStatus, setWindowsMediaStatus] = useState(null);
  const [rpcStatus, setRpcStatus] = useState(null);
  const platform = window.teliumDesktop?.platform || null;

  useEffect(() => {
    let disposed = false;
    window.teliumDesktop?.wineRichPresenceStatus?.()
      .then((status) => { if (!disposed) setWineStatus(status || null); })
      .catch(() => {});
    window.teliumDesktop?.mprisStatus?.()
      .then((status) => { if (!disposed) setMprisStatus(status || null); })
      .catch(() => {});
    window.teliumDesktop?.windowsMediaStatus?.()
      .then((status) => { if (!disposed) setWindowsMediaStatus(status || null); })
      .catch(() => {});
    window.teliumDesktop?.rpcStatus?.()
      .then((status) => { if (!disposed) setRpcStatus(status || null); })
      .catch(() => {});
    const offWine = window.teliumDesktop?.onWineRichPresenceStatusChanged?.((status) => {
      if (!disposed) setWineStatus(status || null);
    }) || (() => {});
    const offMpris = window.teliumDesktop?.onMprisStatusChanged?.((status) => {
      if (!disposed) setMprisStatus(status || null);
    }) || (() => {});
    const offWindowsMedia = window.teliumDesktop?.onWindowsMediaStatusChanged?.((status) => {
      if (!disposed) setWindowsMediaStatus(status || null);
    }) || (() => {});
    const offRpc = window.teliumDesktop?.onRpcStatusChanged?.((status) => {
      if (!disposed) setRpcStatus(status || null);
    }) || (() => {});
    return () => {
      disposed = true;
      offWine();
      offMpris();
      offWindowsMedia();
      offRpc();
    };
  }, []);

  const setKind = (key) => (next) => {
    store.prefs[key] = Boolean(next);
    store.savePrefs();
  };

  return (
    <>
      <Section
        title="Desktop activity"
        description="Show games, apps, and media players detected by the Telium desktop app."
      >
        <div className="divide-y divide-border panel px-3">
          <Switch
            label="Game presence"
            hint="Share games and detected desktop applications."
            checked={kinds.game}
            onChange={setKind('richPresenceGameEnabled')}
          />
          <Switch
            label="Music presence"
            hint="Share Listening activity from media players and apps."
            checked={kinds.music}
            onChange={setKind('richPresenceMusicEnabled')}
          />
          <Switch
            label="Video presence"
            hint="Share Watching or Streaming activity, including detected video titles."
            checked={kinds.video}
            onChange={setKind('richPresenceVideoEnabled')}
          />
        </div>
        {enabled && current.length ? (
          <div className="mt-3 grid gap-2">
            {current.map((activity) => (
              <RichActivityCard
                key={`${activity.type}:${activity.application_id || ''}:${activity.name}`}
                activity={activity}
                allowDirectExternal
              />
            ))}
          </div>
        ) : enabled ? (
          <Notice tone="default">
            Activity sharing is on. Nothing is detected right now.
          </Notice>
        ) : null}
        {(kinds.music || kinds.video) && platform === 'linux' && window.teliumDesktop?.mprisStatus ? (
          <Notice tone={mprisStatus?.state === 'unavailable' ? 'warn' : 'default'}>
            {mprisMessage(mprisStatus)}
          </Notice>
        ) : null}
        {(kinds.music || kinds.video) && platform === 'win32' && window.teliumDesktop?.windowsMediaStatus ? (
          <Notice tone={windowsMediaStatus?.state === 'unavailable' ? 'warn' : 'default'}>
            {windowsMediaMessage(windowsMediaStatus)}
          </Notice>
        ) : null}
        {kinds.game && platform === 'linux' && window.teliumDesktop?.wineRichPresenceStatus ? (
          <Notice tone={wineStatus?.reason ? 'warn' : 'default'}>
            {wineBridgeMessage(wineStatus)}
          </Notice>
        ) : null}
        {kinds.game && platform === 'win32' && window.teliumDesktop?.rpcStatus ? (
          <Notice tone={rpcStatus?.earlierPipeOccupied || rpcStatus?.available === false ? 'warn' : 'default'}>
            {rpcMessage(rpcStatus)}
          </Notice>
        ) : null}
        {platform === 'linux' ? (
          <Hint>
            On Linux, music and video detection uses MPRIS. A player that does not publish
            MPRIS metadata cannot be detected.
          </Hint>
        ) : null}
        {platform === 'win32' ? (
          <Hint>
            On Windows, Telium detects active playback through ordinary WASAPI audio sessions
            and window/process metadata. This works in the unsigned installer without requiring
            Windows' restricted global-media-control capability.
          </Hint>
        ) : null}
        {platform === 'linux' ? (
          <Hint>
            Steam/Proton needs a one-time setup per prefix, and one game restart after it.
          </Hint>
        ) : null}
        <Hint>
          Servers where status sharing is hidden are not sent your desktop activity.
        </Hint>
      </Section>

      <Section title="Privacy">
        <Hint>
          Process ids, RPC secrets, socket identifiers and local file paths are stripped
          before any activity leaves this device.
        </Hint>
      </Section>
    </>
  );
}
