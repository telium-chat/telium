import { ColorPicker } from './ColorPicker.jsx';
import { CheckIcon } from './icons.jsx';
import { cn } from '../lib/cn.js';

const same = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

export function SwatchRow({
  value, options, onChange, label, none = null, fallback, disabled = false, className,
}) {
  const preset = options.some(([, hex]) => same(value, hex));
  return (
    <div className={cn('swatches', className)} role="group" aria-label={label}>
      {options.map(([name, hex]) => (
        <button
          key={hex}
          type="button"
          aria-pressed={same(value, hex)}
          aria-label={name}
          title={name}
          disabled={disabled}
          className="swatch"
          style={{ '--swatch': hex }}
          onClick={() => onChange(hex)}
        >
          {same(value, hex) ? <CheckIcon className="size-3.5" /> : null}
        </button>
      ))}

      {none ? (
        <button
          type="button"
          aria-pressed={!value}
          aria-label={none}
          title={none}
          disabled={disabled}
          className="swatch swatch--none"
          onClick={() => onChange('')}
        >
          {value ? null : <CheckIcon className="size-3.5" />}
        </button>
      ) : null}

      <ColorPicker
        value={value}
        fallback={fallback}
        onChange={onChange}
        isDisabled={disabled}
        label={`Custom ${label.toLowerCase()}`}
        title="Custom colour"
        className="swatch swatch--custom"
      >
        {preset || !value ? null : (
          <span className="color-picker__held">
            <CheckIcon className="size-3.5" />
          </span>
        )}
      </ColorPicker>
    </div>
  );
}
