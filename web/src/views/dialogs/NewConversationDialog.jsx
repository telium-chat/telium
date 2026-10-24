import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { Button, Hint, ModalShell } from '../../components/index.js';
import { PeoplePicker, pickedWithTyped } from './PeoplePicker.jsx';

export function NewConversationDialog({ close }) {
  const store = useStore();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const members = pickedWithTyped(picked, query, store.home?.domain);

  const start = async () => {
    if (!members.length) return;
    try {
      const convo = await store.startConversation(members, members.length > 1 ? 'gc' : 'dm');
      close();
      if (convo.rejected_devices?.length) {
        toast(
          `${convo.rejected_devices.length} device(s) were skipped because their encryption identity could not be verified.`,
          { ms: 10_000 },
        );
      }
      if (convo.missing_devices?.length) {
        toast(
          `${convo.missing_devices.length} device(s) had no key packages left and `
          + 'will not see this conversation until they come back online.',
          { ms: 10_000 },
        );
      }
      store.navigate({ view: 'dms', conversationId: convo.id || convo.conversation_id });
    } catch (e) { reportError(e, 'Could not start conversation'); }
  };

  return (
    <ModalShell
      title="New conversation"
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!members.length} onClick={start}>Start</Button>
        </>
      )}
    >
      <PeoplePicker
        query={query}
        setQuery={setQuery}
        picked={picked}
        setPicked={setPicked}
        onSubmit={start}
      />
      <Hint>End-to-end encrypted</Hint>
    </ModalShell>
  );
}
