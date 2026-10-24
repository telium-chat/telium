import { useState } from 'react';
import { Button as KumoButton, buttonVariants } from '@cloudflare/kumo/components/button';
import { cn } from '../lib/cn.js';
import { SpinnerIcon } from './icons.jsx';
import { Tooltip } from './Tooltip.jsx';

const VARIANT_ALIASES = {
  tertiary: 'ghost',
  flat: 'secondary',
  danger: 'destructive',
  'danger-soft': 'secondary-destructive',
};

const emphasis = (token) => ({
  '--kumo-button-emphasis-bg': `var(${token})`,
  '--kumo-button-emphasis-gradient-start': `var(${token})`,
  '--kumo-button-emphasis-gradient-end': `var(${token})`,
  '--kumo-button-emphasis-ring': 'transparent',
});

const EMPHASIS = {
  primary: emphasis('--accent-solid'),
  destructive: emphasis('--danger'),
};

const EMPHASIS_INK = {
  primary: 'text-accent-solid-foreground!',
  destructive: 'text-danger-foreground!',
};

const RADIUS = {
  xs: 'rounded-(--radius-lg)',
  sm: 'rounded-(--radius-lg)',
  base: 'rounded-(--radius-row)',
  lg: 'rounded-(--radius-row)',
};

const SOFT = 'bg-(--surface-secondary) not-disabled:hover:bg-(--surface-tertiary)'
  + ' disabled:bg-(--surface-secondary) data-[state=open]:bg-(--surface-tertiary)';

const SOFT_KINDS = new Set(['secondary', 'secondary-destructive']);

export function Button({
  variant = 'secondary', size = 'base', shape = 'base',
  onClick, disabled, isDisabled, loading = false,
  className, children, type = 'button', style, ...rest
}) {
  const kind = VARIANT_ALIASES[variant] ?? variant;
  return (
    <KumoButton
      type={type}
      onClick={onClick}
      variant={kind}
      size={size}
      shape={shape}
      disabled={loading || (disabled ?? isDisabled ?? false)}
      style={{ ...EMPHASIS[kind], ...style }}
      className={cn(
        'justify-center',
        shape !== 'circle' && RADIUS[size],
        'shadow-none',
        kind !== 'outline' && 'ring-0',
        SOFT_KINDS.has(kind) && SOFT,
        EMPHASIS[kind] && 'not-disabled:hover:brightness-110',
        'disabled:opacity-50',
        EMPHASIS_INK[kind],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span className="grid place-items-center">
          <span className="invisible col-start-1 row-start-1">{children}</span>
          <SpinnerIcon
            className="col-start-1 row-start-1 size-4 animate-spin"
            aria-label="Working"
          />
        </span>
      ) : children}
    </KumoButton>
  );
}

const SQUARE = {
  xs: 'size-5 rounded-md',
  sm: 'size-6 rounded-lg',
  base: 'size-8 rounded-row',
  lg: 'size-9 rounded-row',
};

export function IconButton({
  title, onClick, disabled, isDisabled, className, children,
  active, size = 'base', variant = 'ghost', ...rest
}) {
  const button = (
    <button
      type="button"
      data-kumo-component="Button"
      title={title || undefined}
      aria-label={title}
      onClick={onClick}
      disabled={disabled ?? isDisabled ?? false}
      className={cn(
        buttonVariants({ variant, shape: 'square', size }),
        SQUARE[size] || SQUARE.base,
        'text-muted hover:text-foreground',
        active && 'bg-surface text-foreground',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return title ? <Tooltip label={title}>{button}</Tooltip> : button;
}

export function AsyncButton({ onClick, children, ...rest }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try { await onClick?.(); } finally { setBusy(false); }
      }}
      {...rest}
    >
      {children}
    </Button>
  );
}
