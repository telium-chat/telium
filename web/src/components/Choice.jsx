import { createContext, useContext } from 'react';
import { RadioGroup } from '@cloudflare/kumo/primitives/radio-group';
import { Radio } from '@cloudflare/kumo/primitives/radio';
import { Text } from '@cloudflare/kumo/components/text';
import { cn } from '../lib/cn.js';

const InRadioGroup = createContext(false);

export function ChoiceList({ value, onChange, className, children, ...rest }) {
  const classes = cn('flex flex-col gap-1.5', className);
  if (value === undefined) return <div className={classes}>{children}</div>;
  return (
    <InRadioGroup.Provider value>
      <RadioGroup value={value} onValueChange={onChange} className={classes} {...rest}>
        {children}
      </RadioGroup>
    </InRadioGroup.Provider>
  );
}

const CARD = cn(
  'flex w-full items-center gap-3 rounded-card bg-surface-secondary px-3.5 py-3',
  'text-start transition-colors hover:bg-surface-tertiary',
  'data-checked:bg-accent/14 data-checked:hover:bg-accent/14',
  'data-disabled:cursor-not-allowed data-disabled:opacity-55',
);

const ICON = cn(
  'flex size-8 shrink-0 items-center justify-center rounded-2xl bg-surface-tertiary',
  'text-muted transition-colors group-hover:text-foreground',
  'group-data-checked:bg-accent group-data-checked:text-accent-foreground',
  'group-data-checked:group-hover:text-accent-foreground',
);

const DOT = cn(
  'flex size-4 shrink-0 items-center justify-center rounded-full bg-surface',
  'transition-colors group-data-checked:bg-accent',
);

function Body({ icon: Glyph, label, description }) {
  return (
    <>
      {Glyph ? <span className={ICON}><Glyph className="size-[17px]" /></span> : null}
      <span className="min-w-0 flex-1">
        <Text as="span" bold>{label}</Text>
        {description ? (
          <span className="block pt-px">
            <Text as="span" variant="secondary" size="sm">{description}</Text>
          </span>
        ) : null}
      </span>
    </>
  );
}

export function ChoiceCard({
  value, icon, label, description, onClick, disabled, trailing, className,
}) {
  const chooses = useContext(InRadioGroup);
  const body = <Body icon={icon} label={label} description={description} />;

  if (chooses) {
    return (
      <Radio.Root value={value} disabled={disabled} className={cn('group', CARD, className)}>
        {body}
        {trailing ?? (
          <span className={DOT}>
            <Radio.Indicator className="size-1.5 rounded-full bg-accent-foreground" />
          </span>
        )}
      </Radio.Root>
    );
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cn('group', CARD, className)}>
      {body}
      {trailing}
    </button>
  );
}
