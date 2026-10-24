import { useEffect, useState } from 'react';
import { shortName } from '../lib/util.js';

export function TypingIndicator({ ids = [], className = '' }) {
  const people = (Array.isArray(ids) ? ids : []).filter(Boolean);
  const names = people.map((id) => shortName(id));
  const text = names.length === 1
    ? `${names[0]} is typing`
    : names.length
      ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''} are typing`
      : '';

  const key = people.join(' ');
  const [held, setHeld] = useState(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (text) {
      setHeld((prev) => (prev && prev.key === key ? prev : { key, text }));
      setLeaving(false);
      return undefined;
    }
    if (!held) return undefined;
    setLeaving(true);
    const timer = setTimeout(() => {
      setHeld(null);
      setLeaving(false);
    }, 180);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, key, held]);

  return (
    <div className={`typing-row ${className}`.trim()} aria-live="polite">
      {held ? (
        <span
          key={held.key}
          className={`typing-line${leaving ? ' is-leaving' : ''}`}
          role="status"
        >
          <span className="typing-dots" aria-hidden="true">
            <i className="typing-dot" />
            <i className="typing-dot" />
            <i className="typing-dot" />
          </span>
          <span className="typing-text typing-indicator-label">{held.text}</span>
        </span>
      ) : null}
    </div>
  );
}
