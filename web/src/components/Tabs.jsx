import { Tabs as KumoTabs } from '@cloudflare/kumo/components/tabs';
import { cn } from '../lib/cn.js';

export function Tabs({
  value, options, onChange, className, indicatorClassName, variant = 'underline', ...rest
}) {
  const tabs = options.map((o) => {
    const [key, label] = Array.isArray(o) ? o : [o, o];
    return { value: String(key), label };
  });
  return (
    <KumoTabs
      tabs={tabs}
      value={value}
      onValueChange={onChange}
      variant={variant}
      className={className}
      indicatorClassName={cn('telium-tabs-indicator', indicatorClassName)}
      {...rest}
    />
  );
}
