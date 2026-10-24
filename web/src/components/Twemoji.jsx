import { useState } from 'react';
import { cn } from '../lib/cn.js';
import { emojiUrl, splitEmoji } from '../lib/emoji.js';

export function Twemoji({ emoji, className, jumbo }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={cn('emoji-native', jumbo && 'text-[2.6em]', className)}>{emoji}</span>;
  return (
    <img
      src={emojiUrl(emoji)}
      alt={emoji}
      draggable={false}
      onError={() => setBroken(true)}
      className={cn('emoji', jumbo && 'emoji-jumbo', className)}
    />
  );
}

export function EmojiText({ children, className }) {
  const text = typeof children === 'string' ? children : '';
  if (!text) return children ?? null;
  const parts = splitEmoji(text);
  if (parts.length === 1 && parts[0].text !== undefined) {
    return className ? <span className={className}>{text}</span> : text;
  }
  return (
    <span className={className}>
      {parts.map((p, i) => (p.emoji
        ? <Twemoji key={i} emoji={p.emoji} />
        : <span key={i}>{p.text}</span>))}
    </span>
  );
}
