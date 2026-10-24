import { useEffect, useMemo, useState } from 'react';
import { HeadphonesIcon, MicIcon, SignalIcon } from './index.js';
import { reportError } from '../hooks/useToast.jsx';
import { tOrNull } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';

export const DESKTOP_AUDIO_INPUT_KEY = 'telium.desktop.audioInput';
export const DESKTOP_AUDIO_OUTPUT_KEY = 'telium.desktop.audioOutput';

function remembered(key) {
  try { return localStorage.getItem(key) || 'default'; } catch { return 'default'; }
}

function labelFor(device, fallback) {
  return device.label?.trim() || fallback;
}

export function DesktopAudioDevices({
  active, onInput, onOutput, noiseMode, noiseSupport, onNoise,
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState(() => remembered(DESKTOP_AUDIO_INPUT_KEY));
  const [output, setOutput] = useState(() => remembered(DESKTOP_AUDIO_OUTPUT_KEY));
  const [measuring, setMeasuring] = useState(false);

  const inputs = useMemo(
    () => devices.filter((device) => (
      device.kind === 'audioinput' && device.label !== 'vencord-screen-share'
    )),
    [devices],
  );
  const outputs = useMemo(
    () => devices.filter((device) => device.kind === 'audiooutput'),
    [devices],
  );

  const refresh = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    setLoading(true);
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch (error) {
      reportError(error, t('voice.error.listDevices'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!active) {
      setOpen(false);
      return undefined;
    }
    refresh();
    const changed = () => refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', changed);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', changed);
  }, [active]);

  if (!active) return null;

  const chooseInput = async (event) => {
    const next = event.target.value || 'default';
    setInput(next);
    localStorage.setItem(DESKTOP_AUDIO_INPUT_KEY, next);
    try {
      await onInput(next);
      await refresh();
    } catch (error) {
      reportError(error, t('voice.error.switchMic'));
    }
  };

  const chooseNoise = async (event) => {
    const next = event.target.value;
    setMeasuring(next === 'neural');
    try {
      await onNoise?.(next);
    } catch (error) {
      reportError(error, t('voice.error.noiseChange'));
    } finally {
      setMeasuring(false);
    }
  };

  const chooseOutput = async (event) => {
    const next = event.target.value || 'default';
    setOutput(next);
    localStorage.setItem(DESKTOP_AUDIO_OUTPUT_KEY, next);
    try {
      await onOutput(next);
    } catch (error) {
      reportError(error, t('voice.error.switchOutput'));
    }
  };

  return (
    <div className="fixed bottom-24 end-5 z-[80] flex flex-col items-end gap-2">
      {open ? (
        <div className="popup popup--panel w-[320px]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-foreground">{t('voice.devices.title')}</div>
              <div className="text-xs text-muted">{t('voice.devices.subtitle')}</div>
            </div>
            {loading ? <span className="text-xs text-muted">{t('voice.devices.refreshing')}</span> : null}
          </div>

          <label className="mb-3 block text-xs font-medium text-muted">
            <span className="mb-1.5 flex items-center gap-1.5">
              <MicIcon className="size-3.5" /> {t('voice.devices.input')}
            </span>
            <select
              value={input}
              onChange={chooseInput}
              className="telium-field min-h-10 w-full px-2.5 text-sm text-foreground"
            >
              <option value="default">{t('voice.devices.defaultMic')}</option>
              {inputs
                .filter((device) => device.deviceId && device.deviceId !== 'default')
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {labelFor(device, t('voice.devices.unnamedMic', {
                      n: index + 1,
                      id: device.deviceId.slice(0, 6),
                    }))}
                  </option>
                ))}
            </select>
          </label>

          <label className="mb-3 block text-xs font-medium text-muted">
            <span className="mb-1.5 flex items-center gap-1.5">
              <SignalIcon className="size-3.5" /> {t('voice.devices.noise')}
            </span>
            <select
              value={noiseMode || 'browser'}
              onChange={chooseNoise}
              disabled={measuring}
              className="telium-field min-h-10 w-full px-2.5 text-sm text-foreground"
            >
              <option value="off">{t('voice.devices.noiseOff')}</option>
              <option value="browser">{t('voice.devices.noiseBrowser')}</option>
              <option value="neural" disabled={noiseSupport && !noiseSupport.ok}>
                {t('voice.devices.noiseNeural', { state: measuring ? 'measuring' : 'ready' })}
              </option>
            </select>
            {noiseSupport && !noiseSupport.ok ? (
              <span className="mt-1.5 block text-[0.6875rem] text-muted">
                {tOrNull(`voice.noise.reason.${noiseSupport.reason}`) || t('voice.noise.cannot')}
              </span>
            ) : null}
          </label>

          <label className="block text-xs font-medium text-muted">
            <span className="mb-1.5 flex items-center gap-1.5">
              <HeadphonesIcon className="size-3.5" /> {t('voice.devices.output')}
            </span>
            <select
              value={output}
              onChange={chooseOutput}
              disabled={!('setSinkId' in HTMLMediaElement.prototype)}
              className="telium-field min-h-10 w-full px-2.5 text-sm text-foreground"
            >
              <option value="default">{t('voice.devices.defaultSpeakers')}</option>
              {outputs
                .filter((device) => device.deviceId && device.deviceId !== 'default')
                .map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {labelFor(device, t('voice.devices.unnamedOutput', {
                      n: index + 1,
                      id: device.deviceId.slice(0, 6),
                    }))}
                  </option>
                ))}
            </select>
            {!('setSinkId' in HTMLMediaElement.prototype) ? (
              <span className="mt-1.5 block text-[0.6875rem] text-muted">
                {t('voice.devices.noSinkId')}
              </span>
            ) : null}
          </label>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => { setOpen((value) => !value); if (!open) refresh(); }}
        className="popup-chip flex min-h-10 items-center gap-2 rounded-full px-3.5 text-sm font-medium text-foreground"
        title={t('voice.devices.open')}
      >
        <HeadphonesIcon className="size-4" />
        {t('voice.devices.title')}
      </button>
    </div>
  );
}
