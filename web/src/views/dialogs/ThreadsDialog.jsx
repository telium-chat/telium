import { useState } from 'react';
import { useAsync, useStore, useStoreEventFor } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { faceOf } from '../../lib/faces.js';
import { enterThread, startThread } from '../../lib/threads.js';
import { dayOf, relative, shortName, timeOf } from '../../lib/util.js';
import {
  Avatar, Button, ContextMenu, EmojiText, IconButton, MenuButton, ModalShell, MoreIcon, Pill,
  SearchField, ThreadIcon, useDialogs,
} from '../../components/index.js';
import { useModal } from '../../hooks/useModal.jsx';
import { useMenus } from '../menus.jsx';
import { HeaderPanel, PanelEmpty, PanelSkeleton } from './HeaderPanel.jsx';
import { NewPostDialog } from './NewPostDialog.jsx';

const FACES = 3;

function useThreads(parentId) {
  const store = useStore();
  useStoreEventFor((id) => id === parentId, 'threads');
  const api = () => store.apiForChannel(parentId);
  const state = useAsync(
    () => Promise.all([
      api().threads(parentId, false).then((r) => r.threads || []),
      api().threads(parentId, true).then((r) => r.threads || []),
    ]).then(([active, archived]) => ({ active, archived })),
    [parentId],
  );

  const cached = store.threads.get(parentId);
  const seeded = cached?.length
    ? { active: cached.filter((t) => !t.archived), archived: cached.filter((t) => t.archived) }
    : null;
  let data = state.data || seeded;
  if (state.data && cached) {
    const fresh = new Map(cached.map((t) => [t.id, t]));
    const all = [...state.data.active, ...state.data.archived].map((t) => ({ ...t, ...fresh.get(t.id) }));
    const seen = new Set(all.map((t) => t.id));
    for (const t of cached) if (!seen.has(t.id)) all.unshift(t);
    data = { active: all.filter((t) => !t.archived), archived: all.filter((t) => t.archived) };
  }
  return { data, error: data ? null : state.error, loading: !data && state.loading, reload: state.reload };
}

function useStarter(guildId, userId) {
  const store = useStore();
  if (!userId) return null;
  const member = store.members.get(guildId)?.get(userId);
  const face = faceOf(store, userId, { guildId });
  return {
    id: userId,
    name: member?.nickname || member?.display_name || face?.name || shortName(userId),
    colour: store.colourFor(guildId, userId),
    face,
  };
}

function useVoices(t) {
  const store = useStore();
  const ids = [];
  const add = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  add(t.owner);
  add(t.opening?.author);
  for (const m of store.messages.get(t.id) || []) add(m.author);
  return ids.length > 1 ? ids.slice(0, FACES) : [];
}

function ThreadCard({ t, onOpen, menu }) {
  const store = useStore();
  const starter = useStarter(t.guild_id, t.owner);
  const voices = useVoices(t);
  const faces = (id) => faceOf(store, id, { guildId: t.guild_id });

  return (
    <ContextMenu content={menu}>
      <div className="group relative">
        <button
          type="button"
          data-panel-row
          onClick={onOpen}
          className="panel-card thread-card rise-in flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-start focus-outside"
        >
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-base font-semibold"><EmojiText>{t.title}</EmojiText></span>
              {t.locked ? <Pill tone="warn">locked</Pill> : null}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {starter ? (
                <>
                  <Avatar
                    size="xxs"
                    id={starter.id}
                    name={starter.name}
                    mediaRef={starter.face?.avatarRef}
                    base={starter.face?.base}
                    mediaOrigin={starter.face?.mediaOrigin}
                  />
                  <span className="min-w-0 truncate">
                    {'Started by '}
                    <span
                      className={starter.colour ? 'font-medium role-ink' : 'font-medium text-foreground'}
                      style={starter.colour ? { '--role': starter.colour } : undefined}
                    >
                      <EmojiText>{starter.name}</EmojiText>
                    </span>
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              ) : null}
              <span
                className="tnum shrink-0"
                title={t.last_active ? `${dayOf(t.last_active)} at ${timeOf(t.last_active)}` : undefined}
              >
                {`Last active ${relative(t.last_active)}`}
              </span>
            </span>
          </span>
          {voices.length ? (
            <span className="thread-card__faces" aria-hidden="true">
              {voices.map((id) => {
                const f = faces(id);
                return (
                  <Avatar
                    key={id}
                    size="xs"
                    id={id}
                    name={f?.name}
                    mediaRef={f?.avatarRef}
                    base={f?.base}
                    mediaOrigin={f?.mediaOrigin}
                  />
                );
              })}
            </span>
          ) : <span className="thread-card__spacer" aria-hidden="true" />}
        </button>
        <MenuButton
          label={`Actions for ${t.title}`}
          placement="bottom end"
          className="popup-icon-button thread-card__more size-7"
          content={menu()}
        >
          <MoreIcon className="size-4" />
        </MenuButton>
      </div>
    </ContextMenu>
  );
}

function ThreadsList({ channelId, query, threads, reload, close }) {
  const store = useStore();
  const menus = useMenus();

  const open = (t) => { close(); enterThread(store, t, channelId); };

  const withParent = (t) => (t.parent_id ? t : { ...t, parent_id: channelId });

  const q = query.trim().toLowerCase();
  const match = (t) => !q || (t.title || '').toLowerCase().includes(q);
  const active = threads.active.filter(match);
  const archived = threads.archived.filter(match);

  if (!active.length && !archived.length) {
    return <PanelEmpty icon={ThreadIcon}>{q ? 'No threads match.' : 'No threads yet.'}</PanelEmpty>;
  }

  const section = (label, list) => (list.length ? (
    <section aria-label={label} className="flex flex-col gap-1.5">
      <h3 className="panel-eyebrow">{label}</h3>
      {list.map((raw) => {
        const t = withParent(raw);
        const menu = () => menus.thread(t, { onOpen: () => open(t), onGone: reload, onChanged: reload });
        return <ThreadCard key={t.id} t={t} onOpen={() => open(t)} menu={menu} />;
      })}
    </section>
  ) : null);

  return (
    <div className="flex flex-col gap-1">
      {section('Active', active)}
      {section('Archived', archived)}
    </div>
  );
}

function useCreate(channelId, close) {
  const store = useStore();
  const dialogs = useDialogs();
  const modal = useModal();
  const parent = store.channels.get(channelId);
  if (!parent || !store.can(channelId, 'SEND_MESSAGES')) return null;
  if (parent.type === 'forum') {
    return () => {
      close();
      modal.open((c) => (
        <NewPostDialog channel={parent} close={c} onCreated={(post) => enterThread(store, post, channelId)} />
      ));
    };
  }
  return () => {
    close();
    dialogs.prompt({
      title: 'Start a thread',
      label: 'Thread title',
      confirmLabel: 'Create',
      onSubmit: async (title) => {
        if (!title.trim()) return;
        try { await startThread(store, channelId, { title }); }
        catch (e) { reportError(e, 'Could not start a thread'); }
      },
    });
  };
}

function ThreadsBody({ channelId, query, state, close }) {
  if (state.loading) return <PanelSkeleton label="Loading threads" />;
  if (!state.data) {
    return (
      <div className="flex flex-col items-center gap-2 py-4 text-sm text-muted">
        <span>Could not load threads.</span>
        <Button variant="ghost" size="sm" onClick={state.reload}>Retry</Button>
      </div>
    );
  }
  return (
    <ThreadsList channelId={channelId} query={query} threads={state.data} reload={state.reload} close={close} />
  );
}

export function ThreadsPopover({ channelId, anchor, close }) {
  const [query, setQuery] = useState('');
  const state = useThreads(channelId);
  const create = useCreate(channelId, close);
  return (
    <HeaderPanel
      anchor={anchor}
      close={close}
      label="Threads"
      icon={ThreadIcon}
      title="Threads"
      search={{ value: query, onChange: setQuery, placeholder: 'Search threads', label: 'Search threads' }}
      action={create ? <Button variant="primary" size="sm" onClick={create}>Create</Button> : null}
      watch={[channelId, query]}
    >
      <ThreadsBody channelId={channelId} query={query} state={state} close={close} />
    </HeaderPanel>
  );
}

export function ThreadsButton({ channelId, className }) {
  const [anchor, setAnchor] = useState(null);
  return (
    <>
      <IconButton
        title="Threads"
        className={className}
        active={Boolean(anchor)}
        aria-haspopup="dialog"
        aria-expanded={Boolean(anchor)}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <ThreadIcon />
      </IconButton>
      {anchor ? <ThreadsPopover channelId={channelId} anchor={anchor} close={() => setAnchor(null)} /> : null}
    </>
  );
}

export function ThreadsDialog({ channelId, close }) {
  const [query, setQuery] = useState('');
  const state = useThreads(channelId);
  const create = useCreate(channelId, close);
  return (
    <ModalShell
      title={<span className="header-panel-title"><ThreadIcon className="size-4 text-muted" />Threads</span>}
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Close</Button>
          {create ? <Button variant="primary" onClick={create}>Create</Button> : null}
        </>
      )}
    >
      <SearchField
        label="Search threads"
        placeholder="Search threads"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
      />
      <ThreadsBody channelId={channelId} query={query} state={state} close={close} />
    </ModalShell>
  );
}
