import { useLayoutEffect, useMemo } from 'react';
import { previewSpans } from '../../lib/markdown-preview.js';
import { splitStandIns } from '../../lib/emoji.js';
import { parseMention, resolveMention, splitMentions } from '../../lib/mentions.js';
import { useOptionalStore } from '../../hooks/useStore.jsx';

export function useAutosize(textareaRef, inkRef) {
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;

    const before = node.scrollTop;
    const wasAtBottom = node.scrollHeight - before - node.clientHeight < 2;
    const caretAtEnd = node.selectionStart === node.value.length;

    node.style.height = '0px';
    node.style.height = `${node.scrollHeight}px`;
    node.scrollTop = wasAtBottom || caretAtEnd ? node.scrollHeight : before;

    if (inkRef?.current) {
      inkRef.current.scrollTop = node.scrollTop;
      inkRef.current.scrollLeft = node.scrollLeft;
    }
  });

  return (e) => {
    const ink = inkRef?.current;
    if (!ink) return;
    ink.scrollTop = e.target.scrollTop;
    ink.scrollLeft = e.target.scrollLeft;
  };
}

export function MarkdownInk({ text, inkRef, guildId }) {
  const spans = useMemo(() => previewSpans(text), [text]);
  const store = useOptionalStore();
  return (
    <div className="composer-ink composer-text" aria-hidden="true" ref={inkRef}>
      {spans.map((span) => (
        <span
          key={span.start}
          className={span.kinds.map((k) => `ink-${k}`).join(' ') || undefined}
        >
          {inkRun(text.slice(span.start, span.end), span, store, guildId)}
        </span>
      ))}
      {'​'}
    </div>
  );
}

function inkRun(raw, span, store, guildId) {
  if (span.kinds.includes('code') || span.kinds.includes('codeblock')) return raw;
  if (span.kinds.includes('mention')) {
    const parts = splitMentions(raw);
    if (parts.some((p) => p.run)) {
      return parts.map((part, i) => (part.run
        ? <InkMention key={i} part={part} store={store} guildId={guildId} />
        : <span key={i}>{part.text}</span>));
    }
  }
  const parts = splitStandIns(raw);
  if (parts.length === 1 && parts[0].text !== undefined) return raw;
  return parts.map((part, i) => (part.standIn
    ? <InkEmoji key={i} part={part} store={store} guildId={guildId} />
    : <span key={i}>{part.text}</span>));
}

function InkMention({ part, store, guildId }) {
  const who = resolveMention(parseMention(part.token), { store, guildId, me: store?.me?.user_id });
  return (
    <span
      className="ink-mention"
      style={who?.colour
        ? { color: who.colour, background: `color-mix(in oklab, ${who.colour} 14%, transparent)` }
        : undefined}
    >
      {part.run}
    </span>
  );
}

function InkEmoji({ part, store, guildId }) {
  const api = part.origin ? store?.apiFor?.(part.origin) : store?.apiForGuild?.(guildId);
  const base = api?.base;
  return (
    <span className="ink-emoji">
      <span className="ink-emoji-stand-in">{part.standIn}</span>
      {base
        ? (
          <img
            className="ink-emoji-image"
            src={`${base}/_telium/v1/emoji/${part.id}`}
            alt=""
            draggable={false}
          />
        )
        : <span className="ink-emoji-image ink-emoji-blank" />}
    </span>
  );
}
