import { Text } from '@cloudflare/kumo/components/text';
import { cn } from '../lib/cn.js';
import { EmojiText } from './Twemoji.jsx';

export function ActionList({ children, className }) {
  return <div className={cn('flex flex-col gap-1', className)}>{children}</div>;
}

export function ActionRow({ icon: Glyph, label, description, danger, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="menu-row menu-row--stacked"
      data-tone={danger ? 'danger' : undefined}
    >
      {Glyph ? (
        <span
          className={cn(
            'menu-chip mt-px',
            danger ? 'text-danger' : 'text-muted',
          )}
        >
          <Glyph className="size-[15px]" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <Text as="span" bold><EmojiText>{label}</EmojiText></Text>
        {description ? (
          <span className="block pt-px">
            <Text as="span" variant="secondary" size="sm"><EmojiText>{description}</EmojiText></Text>
          </span>
        ) : null}
      </span>
    </button>
  );
}
