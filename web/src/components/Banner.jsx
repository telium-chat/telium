import { cn } from '../lib/cn.js';

const TONE = {
  danger: 'border-danger/25 bg-danger/10 text-danger',
  warning: 'border-warning/25 bg-warning/10 text-warning',
};

export function Banner({ tone, role, children, className }) {
  return (
    <div className="banner-in grid shrink-0">
      <div className="min-h-0 overflow-hidden">
        <div
          role={role}
          className={cn(
            'flex min-h-9 flex-wrap items-center justify-center gap-x-2 gap-y-1',
            'overflow-wrap-anywhere border-b px-3 py-2 text-center text-sm leading-[1.4]',
            TONE[tone] || 'border-separator bg-surface text-muted',
            className,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
