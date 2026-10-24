import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { EmojiText, TypingIndicator } from '../../components/index.js';
import { Composer } from './Composer.jsx';
import { Timeline } from './Timeline.jsx';

export function Conversation({
  surface, items, typing = [], loading = false, error = null,
  notices = null, intro = null, empty = null,
  hasMore = false, fetchingOlder = false, onLoadOlder = null,
  firstUnread = null, send = null, above = null, mobile = false,
  onOpenNavigation = null,
}) {
  const store = useStore();
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [pending, setPending] = useState([]);
  const surfaceId = surface?.id ?? null;

  useEffect(() => { setReplyTo(null); setEditing(null); setPending([]); }, [surfaceId]);

  const post = useCallback(async (body, content) => {
    const nonce = `pending-${nextNonce()}`;
    setPending((p) => [...p, {
      nonce,
      content,
      author: store.me?.user_id,
      created_at: Date.now(),
      reply_to: body?.reply_to || null,
    }]);
    try { return await send(body, content, nonce); }
    finally { setPending((p) => p.filter((g) => g.nonce !== nonce)); }
  }, [store, send]);

  const editLast = useCallback(() => {
    const mine = [...items].reverse().find((m) => (
      (m.kind ? m.kind === 'msg' : true)
      && m.author === store.me?.user_id
      && !m.deleted
      && !m.unreadable
    ));
    if (mine) setEditing(mine.id);
  }, [items, store]);

  return (
    <div className="relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {above}
      <Timeline
        surface={surface}
        items={items}
        pending={pending}
        loading={loading}
        error={error}
        notices={notices}
        intro={intro}
        empty={empty}
        hasMore={hasMore}
        fetchingOlder={fetchingOlder}
        onLoadOlder={onLoadOlder}
        firstUnread={firstUnread}
        editing={editing}
        onEdit={setEditing}
        onReply={setReplyTo}
        mobile={mobile}
        onOpenNavigation={onOpenNavigation}
      />

      <div className="typing-dock">
        <TypingIndicator ids={typing} className="typing-float text-xs text-muted" />
      </div>

      {send ? (
        <Composer
          surface={surface}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onEditLast={editLast}
          send={post}
          mobile={mobile}
        />
      ) : null}
    </div>
  );
}

let nonceCounter = 0;
function nextNonce() {
  nonceCounter += 1;
  let tail = '';
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(8);
    c.getRandomValues(bytes);
    tail = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
  } else {
    tail = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  }
  return `${Date.now().toString(36)}-${nonceCounter}-${tail}`;
}

export function ConversationStart({ mark, title, blurb }) {
  return (
    <div className="px-2 pt-8 pb-4">
      <div className="pb-3">{mark}</div>
      <h2 className="text-3xl font-semibold tracking-tight"><EmojiText>{title}</EmojiText></h2>
      <p className="max-w-[64ch] pt-1 text-base leading-[1.6] text-muted"><EmojiText>{blurb}</EmojiText></p>
    </div>
  );
}
