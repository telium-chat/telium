import { useEffect, useState } from 'react';
import { Notice, Section, Switch } from '../../components/index.js';

export function DesktopPane() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    const desktop = window.teliumDesktop;
    const readIntegration = desktop?.desktopIntegration || desktop?.linuxDesktopIntegration;
    readIntegration?.()
      .then((next) => { if (!disposed) setState(next); })
      .catch((reason) => { if (!disposed) setError(reason?.message || String(reason)); });
    return () => { disposed = true; };
  }, []);

  const update = async (kind, enabled) => {
    setBusy(kind);
    setError('');
    try {
      const desktop = window.teliumDesktop;
      let next;
      if (kind === 'launcher') {
        const setLauncher = desktop.setDesktopLauncherInstalled || desktop.setLinuxLauncherInstalled;
        next = await setLauncher(enabled);
      } else {
        const setStartOnLogin = desktop.setDesktopStartOnLogin || desktop.setLinuxStartOnLogin;
        next = await setStartOnLogin(enabled);
      }
      setState(next);
    } catch (reason) {
      setError(reason?.message || String(reason));
    } finally {
      setBusy(null);
    }
  };

  const supported = state?.supported === true;
  const windows = state?.platform === 'windows';

  return (
    <>
      <Section
        title={windows ? 'Windows desktop' : 'Linux desktop'}
        description={windows
          ? 'Choose how Telium integrates with your Windows session.'
          : 'Choose how the Telium AppImage integrates with your desktop session.'}
      >
        {!supported && state ? (
          <Notice tone="default">
            {windows
              ? 'These options are available when Telium is running from an installed Windows build.'
              : 'These options are available when Telium is running from a packaged Linux AppImage.'}
          </Notice>
        ) : null}
        {state?.startupDisabledBySystem ? (
          <Notice tone="default">
            Windows has disabled Telium in Startup Apps. Turn the setting on below to enable it again.
          </Notice>
        ) : null}
        {error ? <Notice tone="warn">{error}</Notice> : null}
        <div className="divide-y divide-border panel px-3">
          {!windows ? (
            <Switch
              label="Show Telium in my application launcher"
              hint="Adds Telium to your Linux app menu for this user."
              checked={Boolean(state?.launcherInstalled)}
              disabled={!supported || busy !== null}
              onChange={(next) => update('launcher', next)}
            />
          ) : null}
          <Switch
            label="Start Telium when I log in"
            hint="Starts Telium hidden in the system tray. The main window stays closed until you open it."
            checked={Boolean(state?.startOnLogin)}
            disabled={!supported || busy !== null}
            onChange={(next) => update('autostart', next)}
          />
        </div>
      </Section>
    </>
  );
}
