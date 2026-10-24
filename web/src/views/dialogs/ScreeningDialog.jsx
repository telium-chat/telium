import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { Button, Field, ModalShell, Notice, TextArea } from '../../components/index.js';

export function ScreeningDialog({ domain, resp, close }) {
  const store = useStore();
  const questions = resp.screening?.questions || resp.screening || [];
  const [answers, setAnswers] = useState(() => questions.map(() => ''));

  const submit = async () => {
    try {
      await store.apiFor(domain).screening(resp.guild_id, answers);
      close();
      toast('Application sent. You will appear in the guild once a moderator approves it.');
    } catch (e) { reportError(e, 'Could not submit'); }
  };

  return (
    <ModalShell
      title="This guild screens new members"
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Submit</Button>
        </>
      )}
    >
      <Notice>
        {'Your answers go to this guild’s moderators. You are not a member '
          + 'until they approve you.'}
      </Notice>
      {questions.map((q, i) => (
        <Field key={i} label={typeof q === 'string' ? q : q.text || q.question}>
          <TextArea
            rows={2}
            placeholder="Your answer"
            value={answers[i]}
            onChange={(e) => setAnswers((a) => a.map((v, at) => (at === i ? e.target.value : v)))}
          />
        </Field>
      ))}
    </ModalShell>
  );
}
