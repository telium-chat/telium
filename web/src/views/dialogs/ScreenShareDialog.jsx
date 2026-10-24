import { useId, useMemo, useState } from 'react';
import {
  AdvancedIcon, Button, ChevronDownIcon, ChoiceCard, ChoiceList, CodeIcon,
  ModalShell, PlayIcon, Switch,
} from '../../components/index.js';
import { cn } from '../../lib/cn.js';
import {
  DEFAULT_SCREEN_SHARE_CONTENT, SCREEN_SHARE_CONTENT, SCREEN_SHARE_FPS, SCREEN_SHARE_QUALITIES,
  contentPreset, displayAudioSupport, screenShareSettings,
} from '../../lib/screenShare.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';

function OptionStrip({ label, value, onChange, options }) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-xs font-medium text-muted">{label}</legend>
      <div
        className="grid overflow-hidden rounded-lg bg-surface-tertiary"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <label key={optionValue} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name={name}
              value={optionValue}
              checked={value === optionValue}
              onChange={() => onChange(optionValue)}
              className="peer sr-only"
            />
            <span className="flex min-h-9 items-center justify-center px-2 text-sm font-semibold tabular-nums text-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-accent/15 hover:text-foreground peer-checked:bg-accent peer-checked:text-accent-foreground peer-checked:hover:bg-accent peer-checked:hover:text-accent-foreground peer-focus-visible:relative peer-focus-visible:z-10 peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-inset peer-focus-visible:ring-accent">
              {optionLabel}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const CONTENT_ICONS = { detail: CodeIcon, motion: PlayIcon };

export function ScreenShareDialog({ close, onStart }) {
  useT();
  const [content, setContent] = useState(DEFAULT_SCREEN_SHARE_CONTENT);
  const [quality, setQuality] = useState('1080p');
  const [fps, setFps] = useState(null);
  const audio = useMemo(() => displayAudioSupport(), []);
  const [wantsAudio, setWantsAudio] = useState(true);
  const [tuning, setTuning] = useState(false);
  const tuningId = useId();

  const preset = contentPreset(content);
  const frameRate = fps ?? preset.fps;

  return (
    <ModalShell
      title={t('voice.share.title')}
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => {
              onStart(screenShareSettings(quality, frameRate, content, wantsAudio));
              close();
            }}
          >
            {t('voice.share.choose')}
          </Button>
        </>
      )}
    >
      <ChoiceList
        value={content}
        onChange={(next) => { setContent(next); setFps(null); }}
        aria-label={t('voice.share.contentLabel')}
      >
        {SCREEN_SHARE_CONTENT.map((item) => (
          <ChoiceCard
            key={item.value}
            value={item.value}
            icon={CONTENT_ICONS[item.value]}
            label={t(`voice.share.content.${item.value}.label`)}
            description={t(`voice.share.content.${item.value}.description`)}
          />
        ))}
      </ChoiceList>

      <Switch
        label={t('voice.share.audio')}
        hint={audio.likely
          ? undefined
          : t(audio.capture ? 'voice.share.audioUnlikely' : 'voice.share.noCapture')}
        checked={wantsAudio}
        onChange={setWantsAudio}
      />

      <div className="overflow-hidden rounded-card bg-surface-secondary">
        <button
          type="button"
          aria-expanded={tuning}
          aria-controls={tuningId}
          onClick={() => setTuning((open) => !open)}
          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-start transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-surface-tertiary"
        >
          <AdvancedIcon className="size-4 shrink-0 text-muted" />
          <span className="flex-1 text-sm font-medium text-foreground">{t('voice.share.quality')}</span>
          <span className="tnum text-sm text-muted">
            {t('voice.share.summary', { quality, fps: frameRate })}
          </span>
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 text-muted transition-transform duration-[var(--dur-2)] ease-[var(--ease)]',
              tuning && 'rotate-180',
            )}
          />
        </button>
        {tuning ? (
          <div id={tuningId} className="grid gap-3 px-3 pb-3 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <OptionStrip
              label={t('voice.share.resolution')}
              value={quality}
              onChange={setQuality}
              options={SCREEN_SHARE_QUALITIES.map((item) => [
                item.value,
                item.value.replace('p', ''),
              ])}
            />
            <OptionStrip
              label={t('voice.share.frameRate')}
              value={String(frameRate)}
              onChange={(value) => setFps(Number(value))}
              options={SCREEN_SHARE_FPS.map((value) => [String(value), String(value)])}
            />
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}
