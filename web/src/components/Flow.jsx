import { useEffect, useRef } from 'react';
import { cn } from '../lib/cn.js';
import { StageSwap } from './Swap.jsx';
import { BackIcon, ChevronRightIcon } from './icons.jsx';

export function Flow({ step, depth = 0, className, children }) {
  const was = useRef(depth);
  const dir = depth >= was.current ? 1 : -1;
  useEffect(() => { was.current = depth; }, [depth]);
  return (
    <StageSwap k={step} dir={dir} className={cn('flow', className)}>
      {children}
    </StageSwap>
  );
}

export function Crumb({ label, onClick }) {
  return (
    <button type="button" className="crumb" onClick={onClick}>
      <BackIcon className="size-3.5 shrink-0" />
      <span className="crumb-label">{label}</span>
    </button>
  );
}

export function Dots({ steps, at }) {
  const here = steps.indexOf(at);
  return (
    <div className={cn('dots', here < 0 && 'is-off')}>
      <span className="sr-only">
        {here < 0 ? 'Aside from the main steps' : `Step ${here + 1} of ${steps.length}`}
      </span>
      <span className="contents" aria-hidden="true">
        {steps.map((name, i) => (
          <i key={name} className={cn(i < here && 'is-done', i === here && 'is-here')} />
        ))}
      </span>
    </div>
  );
}

export function Way({ icon: Icon, name, description, tone, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn('way', tone === 'accent' && 'is-accent')}
      onClick={onClick}
    >
      <span className="way-icon">{Icon ? <Icon className="size-4" /> : null}</span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{name}</span>
        {description ? <span className="block text-xs text-muted">{description}</span> : null}
      </span>
      <ChevronRightIcon className="way-caret size-3.5 text-muted" />
    </button>
  );
}

export function Ways({ children }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}
