import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { participants } from '../../lib/util.js';
import { Button, ModalShell } from '../../components/index.js';
import { PeoplePicker, pickedWithTyped } from './PeoplePicker.jsx';

export function AddPeopleDialog({ convo, close, refresh }) {
  const store = useStore();
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [here] = useState(() => new Set(participants(convo).map((m) => m.user_id)));
  const members = pickedWithTyped(picked, query, store.home?.domain).filter((id) => !here.has(id));
  const oneToOne = convo.kind !== 'gc';
  const me = store.me?.user_id;

  const startGroup = async () => {
    if (!members.length || busy) return;
    setBusy(true);
    try {
      const others = [...here].filter((id) => id !== me);
      const group = await store.startConversation([...others, ...members], 'gc');
      close();
      store.navigate({ view: 'dms', conversationId: group.id || group.conversation_id });
    } catch (e) {
      reportError(e, 'Could not start the group');
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!members.length || busy) return;
    setBusy(true);
    const done = [];
    try {
      for (const id of members) {
        await store.addToConversation(convo.id, id);
        done.push(id);
      }
      close();
      toast(done.length === 1 ? 'Added' : `Added ${done.length} people`);
    } catch (e) {
      setPicked((prev) => prev.filter((id) => !done.includes(id)));
      reportError(e, `Could not add ${members[done.length]}`);
    } finally {
      setBusy(false);
      if (done.length) refresh?.();
    }
  };

  return (
    <ModalShell
      title={oneToOne ? 'Start a group' : 'Add people'}
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!members.length}
            loading={busy}
            onClick={oneToOne ? startGroup : add}
          >
            {oneToOne ? 'Start group' : (members.length > 1 ? `Add ${members.length}` : 'Add')}
          </Button>
        </>
      )}
    >
      <PeoplePicker
        query={query}
        setQuery={setQuery}
        picked={picked}
        setPicked={setPicked}
        exclude={here}
        onSubmit={oneToOne ? startGroup : add}
      />
    </ModalShell>
  );
}
