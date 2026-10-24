import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { ok, reportError } from '../../hooks/useToast.jsx';
import { collect, toMarkdown } from '../../lib/diagnostics.js';
import { buildReport, reportText, reportUrl } from '../../lib/feedback.js';
import { openExternal } from '../../lib/platform.js';
import { useUnsavedChanges } from '../../components/SettingsLayout.jsx';
import {
  Button, Checkbox, Hint, Section, Select, Spinner, TextArea, TextInput,
} from '../../components/index.js';

const KIND_OPTIONS = [
  ['bug', 'Something is broken'],
  ['idea', 'A feature idea'],
  ['other', 'Something else'],
];

const PROMPTS = {
  bug: {
    title: 'Short summary of what went wrong',
    context: {
      label: 'What were you doing?',
      hint: 'What were you doing when it went wrong, and what did you expect to happen?',
    },
    description: 'What went wrong instead?',
  },
  idea: {
    title: 'Short summary of the idea',
    context: {
      label: "What's the problem?",
      hint: 'What are you trying to do that this would help with?',
    },
    description: 'What would you like to happen? "How" is useful but optional.',
  },
  other: {
    title: 'Short summary',
    description: "What's on your mind?",
  },
};

export function FeedbackPane() {
  const store = useStore();
  const [kind, setKind] = useState('bug');
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [description, setDescription] = useState('');
  const [contact, setContact] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  useUnsavedChanges(Boolean(description.trim() || context.trim()));

  const ready = Boolean(description.trim());

  const assemble = () => buildReport({
    store, kind, title, description, context, contact, includeDiagnostics,
  });

  const switchKind = (e) => {
    const next = e.target.value;
    setKind(next);
    setIncludeDiagnostics(next === 'bug');
    setPreview(null);
  };

  const copy = async () => {
    setBusy(true);
    try {
      const text = reportText(await assemble());
      await navigator.clipboard.writeText(text);
      ok('Report copied. It is yours to paste wherever you like.');
    } catch (e) {
      reportError(e, 'Could not copy the report');
    } finally { setBusy(false); }
  };

  const file = async () => {
    setBusy(true);
    try {
      const report = await assemble();
      await openExternal(reportUrl({ kind, ...report }));
      ok('Opening GitHub with the report filled in.');
    } catch (e) {
      reportError(e, 'Could not open GitHub');
    } finally { setBusy(false); }
  };

  const showPreview = async (open) => {
    if (!open || preview) return;
    setPreview('…');
    try { setPreview(toMarkdown(await collect(store))); } catch { setPreview(null); }
  };

  const prompt = PROMPTS[kind] || PROMPTS.other;

  return (
    <Section
      title="Help & feedback"
      description="Tell the people building Telium what broke, or what you wish it did. Nothing is sent until you say so."
    >
      <div className="flex flex-col gap-4">
        <Select
          label="What is this about?"
          options={KIND_OPTIONS}
          value={kind}
          onChange={switchKind}
        />
        <TextInput
          label="Title"
          placeholder={prompt.title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {prompt.context ? (
          <TextArea
            label={prompt.context.label}
            hint={prompt.context.hint}
            rows={3}
            value={context}
            onChange={(e) => setContext(e.target.value)}
          />
        ) : null}
        <TextArea
          label="Details"
          hint={prompt.description}
          rows={6}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <TextInput
          label="Contact (optional)"
          hint="Only if you want a reply -- an email or a handle. Left out entirely when empty."
          value={contact}
          onChange={(e) => setContact(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <Checkbox
            label="Attach diagnostics"
            hint="This device and its connections: versions, close codes, storage health, recent failures. No messages, no drafts, no names, nothing that could sign in as you."
            checked={includeDiagnostics}
            onChange={(next) => setIncludeDiagnostics(Boolean(next))}
          />
          {includeDiagnostics ? (
            <details
              className="ml-6 border-l-2 border-border pl-3"
              onToggle={(e) => showPreview(e.currentTarget.open)}
            >
              <summary className="cursor-pointer text-sm text-muted">Show what would be attached</summary>
              {preview === null ? null : preview === '…' ? (
                <Spinner className="mt-2" />
              ) : (
                <pre className="panel mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-xs">
                  {preview}
                </pre>
              )}
            </details>
          ) : null}
        </div>
        <Hint>
          {kind === 'other'
            ? 'This opens a blank issue on GitHub with your text filled in. Copy keeps the full report either way.'
            : 'This opens a pre-filled issue on GitHub with everything above already in it -- nothing to edit there. A free account is needed to post one; Copy keeps the full report either way.'}
        </Hint>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={!ready || busy} onClick={file}>
            Open GitHub
          </Button>
          <Button disabled={!ready || busy} onClick={copy}>
            Copy report
          </Button>
        </div>
      </div>
    </Section>
  );
}
