import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { domainOf } from '../../lib/util.js';
import { Button, Field, Hint, ModalShell, Select, TextArea } from '../../components/index.js';

const CATEGORIES = ['abuse', 'spam', 'csam', 'illegal', 'other'];

export function ReportDialog({ msg, close }) {
  const store = useStore();
  const [category, setCategory] = useState('abuse');
  const [detail, setDetail] = useState('');
  const destination = domainOf(msg.author);

  const submit = async () => {
    try {
      await store.home.report({
        target_type: 'message',
        target_id: msg.id,
        category,
        detail,
        destination,
        evidence: [{ content: msg.content, author: msg.author, created_at: msg.created_at }],
      });
      close();
      toast('Report sent to the author’s server.');
    } catch (e) { reportError(e, 'Could not send report'); }
  };

  return (
    <ModalShell
      title="Report this message"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Send report</Button>
        </>
      )}
    >
      <Field label="Category">
        <Select value={category} options={CATEGORIES} onChange={(e) => setCategory(e.target.value)} />
      </Field>
      <Field label="What is wrong with it?">
        <TextArea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} />
      </Field>
      <Hint>
        {`Your home server forwards this to ${destination}, with a copy of the message as `
          + 'evidence. The guild’s own moderators are a separate route: use the guild '
          + 'settings if you want them to act instead.'}
      </Hint>
    </ModalShell>
  );
}
