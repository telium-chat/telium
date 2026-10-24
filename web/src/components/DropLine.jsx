import { cn } from '../lib/cn.js';

export function DropLine({ edge }) {
  if (!edge) return null;
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-1 z-10 h-[2px] rounded-full bg-accent',
        edge === 'before' ? '-top-px' : '-bottom-px',
      )}
    />
  );
}
