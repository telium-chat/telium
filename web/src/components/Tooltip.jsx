import { cloneElement, isValidElement, useCallback, useRef } from 'react';
import { Tooltip as KumoTooltip, TooltipProvider } from '@cloudflare/kumo/components/tooltip';
import { Tooltip as BaseTooltip } from '@cloudflare/kumo/primitives/tooltip';

export { TooltipProvider };

export function Tooltip({ label, children, delay = 400, side = 'bottom' }) {
  const titleRef = useRef(null);

  const suppressTitle = useCallback((e) => {
    const el = e.currentTarget;
    const title = el.getAttribute('title');
    if (title) {
      titleRef.current = title;
      el.removeAttribute('title');
    }
  }, []);

  const restoreTitle = useCallback((e) => {
    if (titleRef.current) e.currentTarget.setAttribute('title', titleRef.current);
  }, []);

  if (!label || !isValidElement(children)) return children;

  const trigger = cloneElement(children, {
    onMouseEnter: suppressTitle,
    onMouseLeave: restoreTitle,
  });

  return <KumoTooltip content={label} render={trigger} side={side} delay={delay} />;
}

export function RichTooltip({ content, children, side = 'top', delay = 200 }) {
  if (!isValidElement(children)) return children;
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger delay={delay} render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner
          side={side}
          sideOffset={9}
          className="max-w-[var(--available-width)]"
        >
          <BaseTooltip.Popup className="rich-tooltip">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
