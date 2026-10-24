import { Emoji } from '../lib/markdown.jsx';
import { activityStatus, splitStatus } from '../lib/util.js';
import { ACTIVITY_ICONS } from './icons.jsx';
import { EmojiText } from './Twemoji.jsx';

export function StatusText({ children, store, className }) {
  const { emoji, text } = splitStatus(children);
  if (!emoji && !text) return null;
  return (
    <span className={className}>
      {emoji ? <Emoji emoji={emoji} store={store} /> : null}
      {emoji && text ? ' ' : null}
      {text ? <EmojiText>{text}</EmojiText> : null}
    </span>
  );
}

export function StatusLine({
  presence, store, className, fallback = null, priorityActivity = null, typing = false,
}) {
  if (typing) {
    return (
      <span className={className}>
        <span className="typing-dots status-typing" aria-hidden="true">
          <i className="typing-dot" />
          <i className="typing-dot" />
          <i className="typing-dot" />
        </span>
        typing
      </span>
    );
  }
  const custom = presence?.custom_status;
  if (!priorityActivity && custom) {
    return <StatusText store={store} className={className}>{custom}</StatusText>;
  }

  const activity = priorityActivity || activityStatus(presence);
  if (!activity) return fallback === null ? null : <span className={className}>{fallback}</span>;
  const Glyph = ACTIVITY_ICONS[activity.kind] || ACTIVITY_ICONS.playing;
  return (
    <span className={className}>
      <Glyph className="activity-note__glyph" />
      <span className="activity-note__verb">{activity.verb}</span>
      {' '}
      <EmojiText>{activity.name}</EmojiText>
    </span>
  );
}
