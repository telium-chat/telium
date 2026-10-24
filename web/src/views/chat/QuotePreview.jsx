import { useStore } from '../../hooks/useStore.jsx';
import { cn } from '../../lib/cn.js';
import { clipContent } from '../../lib/emoji.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { renderContent, takeForwards } from '../../lib/markdown.jsx';

const CLIP = 90;

export function QuotePreview({ leadKey, name, content, guildId, empty, className }) {
  const t = useT();
  const store = useStore();
  const { body } = takeForwards(content || '');
  const text = clipContent(body.trim(), CLIP);
  const quoted = text
    ? renderContent(text, { me: store.me?.user_id, store, guildId })
    : (empty ?? t('chat.quote.attachment'));
  return (
    <span className={cn('msg-preview', className)}>
      <Trans
        k={leadKey || 'chat.quote.line'}
        values={{ name }}
        components={{ quoted: <>{quoted}</> }}
      />
    </span>
  );
}
