import { useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { faceOf } from '../../lib/faces.js';
import { participants, shortName } from '../../lib/util.js';
import { Avatar, Button, ModalShell, useDialogs } from '../../components/index.js';
import { useDmItems } from '../chat/surface.jsx';

function peerId(store, convo) {
  return participants(convo)
    .map((m) => m.user_id || m)
    .find((id) => id && id !== store.me?.user_id) || null;
}

function RequestRow({ convo, close, announce }) {
  const store = useStore();
  const dialogs = useDialogs();
  useStoreEvent('dm', 'peers', 'friends', 'conversations');
  const id = peerId(store, convo);
  const [opened, setOpened] = useState(convo);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (id) store.ensureProfile(id);
    let live = true;
    store.openConversation(convo.id)
      .then((value) => { if (live) setOpened(value); })
      .catch(() => {});
    return () => { live = false; };
  }, [store, convo.id, id]);

  const frames = store.dmFrames.get(convo.id) || [];
  const items = useDmItems(frames, opened, store.mls, store.me?.user_id);
  const first = items.find((item) => item.author === id) || items[0] || null;
  const face = id ? faceOf(store, id) : null;
  const name = face?.name || shortName(id) || 'Unknown user';

  const accept = async () => {
    if (busy) return;
    setBusy('accept');
    try {
      const accepted = await store.acceptMessageRequest(convo.id);
      close();
      store.navigate({ view: 'dms', conversationId: accepted?.id || convo.id });
    } catch (e) {
      reportError(e, 'Could not accept that message request');
      setBusy('');
    }
  };

  const decline = async () => {
    if (busy) return;
    setBusy('decline');
    try {
      await store.declineMessageRequest(convo.id);
      announce(`Declined the message request from ${name}. They are not told.`);
    } catch (e) {
      reportError(e, 'Could not decline that message request');
    } finally {
      setBusy('');
    }
  };

  const runBlock = async () => {
    setBusy('block');
    try {
      await store.blockUser(id);
      announce(`Blocked ${name}. They are not told.`);
    } catch (e) {
      reportError(e, 'Could not block that user');
    } finally {
      setBusy('');
    }
  };

  const block = () => {
    if (busy || !id) return;
    dialogs.confirm({
      title: `Block ${name}?`,
      body: 'They stop being able to message or call you anywhere on Telium. They are not told, and you can undo this later.',
      confirmLabel: 'Block',
      danger: true,
      onConfirm: runBlock,
    });
  };

  return (
    <li className="rounded-xl bg-surface-secondary p-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar
          id={id}
          name={name}
          size="md"
          mediaRef={face?.avatarRef}
          base={face?.base}
          mediaOrigin={face?.mediaOrigin}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{name}</div>
          <div className="truncate text-xs text-muted">{id}</div>
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
        {first?.content || (frames.length ? 'Encrypted message unavailable on this device.' : 'Sent you a message request.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" disabled={Boolean(busy)} onClick={accept}>
          {busy === 'accept' ? 'Accepting…' : 'Accept'}
        </Button>
        <Button variant="secondary" disabled={Boolean(busy)} onClick={decline}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </Button>
        <Button variant="danger-soft" disabled={Boolean(busy)} onClick={block}>
          {busy === 'block' ? 'Blocking…' : 'Block'}
        </Button>
      </div>
    </li>
  );
}

export function MessageRequestsDialog({ close }) {
  const store = useStore();
  useStoreEvent('conversations');
  const requests = store.messageRequests();
  const [announcement, setAnnouncement] = useState('');

  return (
    <ModalShell
      title="Message requests"
      close={close}
      footer={<Button variant="secondary" onClick={close}>Done</Button>}
    >
      <ul className="space-y-2" aria-label="Message requests">
        {requests.length ? requests.map((convo) => (
          <RequestRow key={convo.id} convo={convo} close={close} announce={setAnnouncement} />
        )) : (
          <li className="py-8 text-center text-sm text-muted">No message requests.</li>
        )}
      </ul>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    </ModalShell>
  );
}
