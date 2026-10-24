import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { uploadAttachment } from '../../lib/upload.js';
import {
  AttachIcon, Button, CloseIcon, EmojiText, Field, Hint, ModalShell, ProgressBar,
  ShieldIcon, Select, TextArea, TextInput,
} from '../../components/index.js';

const MAX_TAGS = 5;

export function NewPostDialog({ channel, close, onCreated }) {
  const store = useStore();
  useStoreEvent('media-preference', 'media-registry');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chosen, setChosen] = useState([]);
  const [staged, setStaged] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [externalHost, setExternalHost] = useState(store.externalMediaHosts?.[0]?.id || '');
  const [busy, setBusy] = useState(false);

  const moderator = store.can(channel.id, 'MANAGE_MESSAGES');
  const mayAttach = store.can(channel.id, 'ATTACH_FILES');
  const tags = (channel.available_tags || []).filter((t) => !t.moderated || moderator);
  const tier = store.mediaPreference?.tier || 1;
  const externalHosts = store.externalMediaHosts || [];

  useEffect(() => {
    if (!externalHost && externalHosts[0]) setExternalHost(externalHosts[0].id);
  }, [externalHost, externalHosts]);

  const toggle = (id) => setChosen((was) => {
    if (was.includes(id)) return was.filter((t) => t !== id);
    if (was.length >= MAX_TAGS) return was;
    return [...was, id];
  });

  const pick = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const media = await uploadAttachment(store, channel, file, {
          externalHost: externalHosts.find((host) => host.id === externalHost) || null,
          onProgress: (loaded, total) => setUploadProgress(total ? Math.round((loaded / total) * 100) : 0),
        });
        setStaged((was) => [...was, media]);
      }
    } catch (e) { reportError(e, 'Could not upload that file'); }
    finally { setUploading(false); setUploadProgress(0); }
  };

  const ready = title.trim() && (body.trim() || staged.length);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const post = await store.apiForChannel(channel.id).createThread(channel.id, {
        title: title.trim(),
        content: body.trim(),
        tags: chosen,
        attachments: staged,
      });
      const list = store.threads.get(channel.id) || [];
      store.threads.set(channel.id, [post, ...list.filter((t) => t.id !== post.id)]);
      store.emit('threads', channel.id);
      close();
      onCreated?.(post);
    } catch (e) { reportError(e, 'Could not create the post'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell
      title="New Post"
      subtitle={channel.name}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="primary" isDisabled={!ready || busy || uploading} onClick={submit}>
            Post
          </Button>
        </>
      )}
    >
      <TextInput
        label="Title"
        placeholder="What is this post about?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      {tags.length ? (
        <Field
          label="Tags"
          hint={`Up to ${MAX_TAGS}. Tags are the forum's, so renaming one later renames it here too.`}
        >
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const on = chosen.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(tag.id)}
                  className={cn(
                    'flex min-h-10 items-center gap-1 rounded-xl px-3 py-2 text-sm font-medium sm:min-h-0 sm:rounded-md sm:px-2 sm:py-1',
                    on
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-surface-secondary text-muted hover:bg-surface-tertiary hover:text-foreground',
                  )}
                >
                  {tag.emoji ? <EmojiText>{tag.emoji}</EmojiText> : null}
                  <span><EmojiText>{tag.name}</EmojiText></span>
                  {tag.moderated ? <ShieldIcon className="size-3 opacity-70" /> : null}
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      <TextArea
        label="Message"
        rows={6}
        placeholder="Write the first message. Replies go underneath it."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      {mayAttach ? (
        <Field label="Attachments">
          <div className="flex flex-wrap items-center gap-1.5">
            {staged.map((att, i) => (
              <span
                key={att.ref || i}
                className="flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-xs"
              >
                <AttachIcon className="size-3 text-muted" />
                <span className="max-w-[180px] truncate">{att.name || att.ref}</span>
                <span className="max-w-[130px] truncate text-2xs text-muted">
                  {att.origin || hostOf(att.url)}
                </span>
                <button
                  type="button"
                  title="Remove"
                  aria-label={`Remove ${att.name || 'attachment'}`}
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted hover:text-foreground active:bg-surface-tertiary sm:size-6 sm:rounded-md"
                  onClick={() => setStaged((was) => was.filter((_, at) => at !== i))}
                >
                  <CloseIcon className="size-3" />
                </button>
              </span>
            ))}
            {tier === 3 ? (
              externalHosts.length ? (
                <div className="flex flex-col gap-1">
                  <Select
                    aria-label="External upload host"
                    className="min-w-[190px]"
                    value={externalHost}
                    options={externalHosts.map((host) => [host.id, `${host.name || host.id} (${host.domain})`] )}
                    onChange={(e) => setExternalHost(e.target.value)}
                    disabled={uploading}
                  />
                  <span className="max-w-[360px] text-2xs text-muted">
                    {externalHosts.find((host) => host.id === externalHost)?.description
                      || 'External uploads are public provider URLs with provider-managed retention.'}
                  </span>
                </div>
              ) : <Hint>No external upload hosts are enabled.</Hint>
            ) : null}
            <label className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-muted hover:bg-surface hover:text-foreground sm:min-h-0 sm:rounded-lg sm:px-2.5 sm:py-1">
              <AttachIcon className="size-3.5" />
              <span>{uploading ? 'Uploading...' : 'Add a file'}</span>
              <input
                type="file"
                multiple
                className="hidden"
                disabled={uploading || (tier === 3 && !externalHost)}
                onChange={pick}
              />
            </label>
          </div>
          {uploading ? (
            <ProgressBar value={uploadProgress} className="mt-1" />
          ) : null}
        </Field>
      ) : null}

      <Hint>The title names the post; everything you write here is its first message.</Hint>
    </ModalShell>
  );
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'unknown host'; }
}
