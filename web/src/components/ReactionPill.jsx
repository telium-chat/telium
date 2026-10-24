import { cn } from '../lib/cn.js';
import { RichTooltip } from './Tooltip.jsx';
import { EmojiText } from './Twemoji.jsx';
import { Avatar } from './Avatar.jsx';

export function ReactionPill({ emoji, count, reacted = false, reactors = [], onClick, children }) {
  const shown = reactors.slice(0, 6);
  const hidden = Math.max(0, count - shown.length);
  const summary = count === 1 ? '1 reaction' : `${count} reactions`;

  return (
    <RichTooltip
      content={(
        <>
          <span className="reaction-tooltip-head">
            <span className="reaction-tooltip-emoji">{children}</span>
            <span>{summary}</span>
          </span>
          <span className="reaction-tooltip-list">
            {shown.map((person) => (
              <span key={person.id || person.name} className="reaction-tooltip-person">
                <Avatar
                  id={person.id}
                  name={person.name}
                  size="xxs"
                  mediaRef={person.avatarRef}
                  base={person.avatarBase}
                  mediaOrigin={person.mediaOrigin}
                  className="reaction-tooltip-avatar"
                />
                <span><EmojiText>{person.name}</EmojiText></span>
                {person.me ? <span className="reaction-tooltip-you">you</span> : null}
              </span>
            ))}
            {hidden ? <span className="reaction-tooltip-more">and {hidden} more</span> : null}
            {!shown.length ? <span className="reaction-tooltip-more">Someone reacted</span> : null}
          </span>
        </>
      )}
    >
      <button
        type="button"
        aria-label={`${emoji}, ${summary}${reacted ? ', reacted by you' : ''}`}
        onClick={onClick}
        className={cn('reaction-pill', reacted && 'is-mine')}
      >
        {children}
        <span className="tnum reaction-count">{String(count)}</span>
      </button>
    </RichTooltip>
  );
}
