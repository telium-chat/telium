import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { Button, Field, ModalShell, Notice, Select, TextInput } from '../../components/index.js';
import { conversationTitle } from '../../lib/conversations.js';

export function PromoteDialog({ convo, close }) {
  const store = useStore();
  const domains = Object.keys(store.session.servers);

  const [name, setName] = useState(conversationTitle(store, convo));
  const home = store.session?.home?.domain;
  const [host, setHost] = useState(domains.includes(home) ? home : domains[0] || '');
  const [busy, setBusy] = useState(false);

  const promote = async () => {
    const guildName = name.trim();
    if (!guildName || !host) return;
    setBusy(true);
    try {
      const { guild, invite } = await store.promoteConversation(
        convo.id, { domain: host, name: guildName },
      );
      close();
      toast(invite?.code
        ? `Created ${guild.name}. The invite is in the conversation.`
        : `Created ${guild.name}.`);
    } catch (e) { reportError(e, 'Could not convert'); }
    finally { setBusy(false); }
  };

  if (!domains.length) {
    return (
      <ModalShell
        title="Convert to a guild"
        footer={<Button variant="ghost" onClick={close}>Close</Button>}
      >
        <Notice tone="warn">
          {'A guild has to live on a server you hold a session with, and this '
            + 'client has none. Connect to one first.'}
        </Notice>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      title="Convert to a guild"
      subtitle="The group stays where it is. A guild is created next to it and everyone is invited."
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" isDisabled={busy || !name.trim()} onClick={promote}>
            Create the guild
          </Button>
        </>
      )}
    >
      <Field label="Guild name">
        <TextInput
          autoFocus
          value={name}
          placeholder="My guild"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') promote(); }}
        />
      </Field>
      <Field
        label="Hosted on"
        hint={'A guild lives on exactly one server, and that server holds its '
          + 'messages, members and permissions. Unlike this conversation, they '
          + 'will not be end-to-end encrypted.'}
      >
        <Select value={host} options={domains} onChange={(e) => setHost(e.target.value)} />
      </Field>
      <Notice tone="warn">
        {'History stays behind. Everything said in this group was encrypted to '
          + 'this group, and moving it would mean decrypting every author’s '
          + 'messages into a guild without their consent — so nothing here is '
          + 'republished. The conversation stays open and readable where it is; '
          + 'the guild starts empty.'}
      </Notice>
    </ModalShell>
  );
}
