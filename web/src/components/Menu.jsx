import { useCallback, useState } from 'react';
import { DropdownMenu } from '@cloudflare/kumo/components/dropdown';
import { ContextMenu as BaseContextMenu } from '@cloudflare/kumo/primitives/context-menu';
import { cn } from '../lib/cn.js';
import { EmojiText, Twemoji } from './Twemoji.jsx';

function placementOf(placement) {
  const [side = 'bottom', align = 'start'] = String(placement).split(/\s+/);
  return { side, align };
}

const POPUP = cn(
  'popup min-w-56 max-h-[min(28rem,var(--available-height))] overflow-y-auto',
);

export function MenuButton({
  children, content, placement = 'bottom start', className = '', label,
  isDisabled = false,
}) {
  const { side, align } = placementOf(placement);

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        aria-label={label}
        className={className}
        disabled={isDisabled}
        render={<button type="button" />}
      >
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content
        className={POPUP}
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
      >
        {content}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

export function ContextMenu({ children, content, isDisabled = false, opensOn }) {
  const [open, setOpen] = useState(false);
  const [renderContent, setRenderContent] = useState(false);

  const onContextMenu = useCallback((e) => {
    if (isDisabled) {
      e.preventDefault();
      return;
    }
    if (opensOn && !opensOn(e)) {
      e.preventBaseUIHandler?.();
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
  }, [isDisabled, opensOn]);

  const onTouchStart = useCallback((e) => {
    if (opensOn) e.preventBaseUIHandler?.();
  }, [opensOn]);

  return (
    <BaseContextMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setRenderContent(true);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setRenderContent(false);
      }}
    >
      <BaseContextMenu.Trigger
        disabled={isDisabled}
        render={children}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
      />
      <BaseContextMenu.Portal>
        <BaseContextMenu.Positioner collisionPadding={8}>
          <BaseContextMenu.Popup className={POPUP}>
            {renderContent ? content() : null}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

const ITEM = 'group/mi menu-row';

export function MenuItem({
  children, icon: Glyph, hint, tone, onAction, isDisabled, ...rest
}) {
  return (
    <DropdownMenu.Item
      className={ITEM}
      data-tone={tone}
      icon={Glyph ? <Glyph className="size-4 shrink-0 opacity-80" /> : undefined}
      onClick={onAction}
      disabled={isDisabled}
      {...rest}
    >
      <span className="flex-1 truncate text-start"><EmojiText>{children}</EmojiText></span>
      {hint ? <span className="menu-hint">{hint}</span> : null}
    </DropdownMenu.Item>
  );
}

export function MenuReactions({ emojis, onPick }) {
  if (!emojis?.length) return null;
  return (
    <div className="menu-reactions" role="group" aria-label="Quick reactions">
      {emojis.map((emoji) => (
        <DropdownMenu.Item
          key={emoji}
          className="menu-reaction"
          title={`React with ${emoji}`}
          onClick={() => onPick?.(emoji)}
        >
          <Twemoji emoji={emoji} />
        </DropdownMenu.Item>
      ))}
    </div>
  );
}

export function MenuSub({ label, icon: Glyph, children, isDisabled }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        className={ITEM}
        icon={Glyph}
        disabled={isDisabled}
      >
        <span className="flex-1 truncate text-start"><EmojiText>{label}</EmojiText></span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent className={POPUP}>{children}</DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}

export function MenuSlider({
  label, value, onChange, min = 0, max = 100, step = 1,
}) {
  const stop = (event) => event.stopPropagation();
  const numeric = Math.max(min, Math.min(max, Number(value) || 0));
  return (
    <div
      role="group"
      aria-label={label}
      className="cursor-default px-2 py-[5px]"
    >
      <div
        className="flex w-full min-w-[210px] flex-col gap-1.5 px-0.5 py-0.5"
        onPointerDown={stop}
        onPointerUp={stop}
        onClick={stop}
        onKeyDown={stop}
      >
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">{label}</span>
          <span className="tnum text-muted">{numeric}%</span>
        </div>
        <input
          type="range"
          aria-label={label}
          min={min}
          max={max}
          step={step}
          value={numeric}
          onChange={(event) => onChange?.(Number(event.target.value))}
          className="h-4 w-full cursor-pointer accent-[var(--accent)]"
        />
      </div>
    </div>
  );
}

export function extractMenuItemProps(element) {
  if (!element?.props) return null;
  if (element.type === MenuSeparator) return { kind: 'separator' };
  const { icon, children, tone, onAction, isDisabled } = element.props;
  if (!onAction) return null;
  return { kind: 'item', icon, label: children, tone, onAction, isDisabled };
}

export function MenuSection({ title, children }) {
  return (
    <DropdownMenu.Group>
      {title ? (
        <DropdownMenu.Label className="menu-label">
          {title}
        </DropdownMenu.Label>
      ) : null}
      {children}
    </DropdownMenu.Group>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="menu-separator" />;
}
