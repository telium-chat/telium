import { useMemo, useRef, useState } from 'react';
import { IconButton, SendIcon } from '../../components/index.js';
import { reportError } from '../../hooks/useToast.jsx';
import { shortName } from '../../lib/util.js';
import { MarkdownInk, useAutosize } from '../chat/MarkdownInk.jsx';
import { AutocompletePopup, useAutocomplete } from '../chat/Autocomplete.jsx';

export function Composer({ store, userId, displayName, dm, close }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const inkRef = useRef(null);
  const syncInkScroll = useAutosize(inputRef, inkRef);

  const surface = useMemo(() => ({ id: null, guildId: null, people: () => [] }), []);
  const complete = useAutocomplete({
    store, surface, text: draft, setText: setDraft, textareaRef: inputRef,
  });

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const convo = dm || await store.startConversation([userId]);
      const id = convo.id || convo.conversation_id;
      await store.sendDm(id, text);
      setDraft('');
      close();
      store.navigate({ view: 'dms', conversationId: id });
    } catch (e) {
      reportError(e, 'Could not send that message');
    } finally { setBusy(false); }
  };

  return (
    <div className="pc__composer">
      <AutocompletePopup
        items={complete.items}
        index={complete.index}
        onPick={complete.accept}
        onHover={complete.setIndex}
      />
      <div className="composer-field">
        <MarkdownInk text={draft} inkRef={inkRef} />
        <textarea
          ref={inputRef}
          rows={1}
          className="composer-input composer-text"
          value={draft}
          disabled={busy}
          maxLength={4000}
          aria-label={`Message ${displayName}`}
          placeholder={`Message @${shortName(userId)}`}
          onScroll={syncInkScroll}
          onChange={(e) => {
            setDraft(e.target.value);
            complete.sync(e.target);
          }}
          onKeyUp={(e) => complete.sync(e.target)}
          onClick={(e) => complete.sync(e.target)}
          onKeyDown={(e) => {
            if (complete.onKeyDown(e)) return;
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent?.isComposing) return;
            e.preventDefault();
            send();
          }}
        />
      </div>
      <IconButton
        title="Send"
        className="pc__composer-send"
        disabled={busy || !draft.trim()}
        onClick={send}
      >
        <SendIcon className="size-4" />
      </IconButton>
    </div>
  );
}
