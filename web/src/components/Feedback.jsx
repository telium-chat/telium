import { Banner } from '@cloudflare/kumo/components/banner';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Empty } from '@cloudflare/kumo/components/empty';
import { Loader } from '@cloudflare/kumo/components/loader';
import { Progress } from '@cloudflare/kumo/primitives/progress';
import { Text } from '@cloudflare/kumo/components/text';
import { cn } from '../lib/cn.js';
import { InboxIcon, WarnIcon } from './icons.jsx';

const NOTICE_VARIANTS = {
  default: 'secondary',
  warn: 'alert',
  danger: 'error',
  success: 'secondary',
  accent: 'secondary',
};

export function Notice({ tone = 'default', children, className, ...rest }) {
  return (
    <Banner
      size="sm"
      variant={NOTICE_VARIANTS[tone] || NOTICE_VARIANTS.default}
      data-tone={tone}
      role={tone === 'danger' ? 'alert' : 'note'}
      className={cn('telium-notice', className)}
      {...rest}
    >
      <div className="min-w-0 flex-1">{children}</div>
    </Banner>
  );
}

export function Hint({ children, className, ...rest }) {
  return (
    <Text
      variant="secondary"
      size="sm"
      DANGEROUS_className={className}
      {...rest}
    >
      {children}
    </Text>
  );
}

export function FormStatus({ children, tone = 'muted', className, ...rest }) {
  return (
    <p
      role="alert"
      className={cn(
        'text-xs',
        tone === 'danger' ? 'text-danger' : 'text-muted',
        className,
      )}
      {...rest}
    >
      {children}
    </p>
  );
}

export function Meta({ children, className, ...rest }) {
  return (
    <Text variant="secondary" size="xs" DANGEROUS_className={cn('tnum', className)} {...rest}>
      {children}
    </Text>
  );
}

const PILL_VARIANTS = {
  default: 'secondary',
  accent: 'secondary',
  warn: 'warning',
  danger: 'error',
  success: 'success',
};

export function Pill({ tone = 'default', children, className }) {
  return (
    <Badge
      variant={PILL_VARIANTS[tone] || PILL_VARIANTS.default}
      data-tone={tone}
      className={cn('telium-pill', className)}
    >
      {children}
    </Badge>
  );
}

export function EmptyState({ icon: IconComponent = InboxIcon, title, children }) {
  const sentence = title ?? children;
  return (
    <Empty
      size="sm"
      className="telium-empty"
      icon={<IconComponent className="size-7 text-muted opacity-50" />}
      title={sentence}
      description={title ? children : undefined}
    />
  );
}

export function Spinner({ className }) {
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0 opacity-60', className)}>
      <Loader size={16} />
    </span>
  );
}

export function Loading({ label = 'Loading...' }) {
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center gap-2.5 py-12 text-sm text-muted"
    >
      <Spinner />
      {label}
    </div>
  );
}

export function ProgressBar({ value, label = 'Upload progress', className }) {
  return (
    <Progress.Root
      value={value}
      aria-label={label}
      className={cn('h-1 overflow-hidden rounded-full bg-border', className)}
    >
      <Progress.Track className="h-full w-full">
        <Progress.Indicator className="h-full rounded-full bg-accent transition-[width]" />
      </Progress.Track>
    </Progress.Root>
  );
}

export function Skeleton({ className }) {
  return <div aria-hidden="true" className={cn('skeleton rounded-lg', className)} />;
}

export function RowSkeleton({ rows = 4 }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-2.5 py-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-[38%]" />
            <Skeleton className="h-3 w-[72%]" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Async({ state, children, empty = null, emptyIcon, skeleton = 4 }) {
  if (state.loading) return <RowSkeleton rows={skeleton} />;
  if (state.error) {
    return (
      <EmptyState icon={WarnIcon} title="That did not load">
        {state.error?.body?.message || state.error?.message || String(state.error)}
      </EmptyState>
    );
  }
  if (empty && (!state.data || (Array.isArray(state.data) && !state.data.length))) {
    return <EmptyState icon={emptyIcon}>{empty}</EmptyState>;
  }
  return children(state.data);
}
