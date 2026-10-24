import { cn } from '../../lib/cn.js';
import { WATCH_QUALITIES } from '../../lib/screenShare.js';
import { useT } from '../../lib/i18n/react.jsx';

export function WatchQualitySelect({ value, onChange, className }) {
  const t = useT();
  return (
    <select
      aria-label={t('voice.quality.label')}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'telium-field min-h-10 px-2.5 text-sm text-foreground',
        className,
      )}
    >
      {WATCH_QUALITIES.map((quality) => (
        <option key={quality} value={quality}>{t(`voice.quality.${quality}`)}</option>
      ))}
    </select>
  );
}
