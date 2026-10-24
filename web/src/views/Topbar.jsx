import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { PersistentAudioTopbar } from '../hooks/usePersistentAudio.jsx';
import { Status } from '../lib/gateway.js';
import { buttonVariants } from '@cloudflare/kumo/components/button';
import {
  BackIcon, EmojiText, ForumIcon, HashIcon, IconButton, LockIcon,
  MembersIcon, MenuButton, MoreIcon, Pill, PinIcon,
} from '../components/index.js';
import { useMenus } from './menus.jsx';
import { HeaderSearch } from './search.jsx';
import { ThreadsButton } from './dialogs/ThreadsDialog.jsx';
import { threadParentOf } from '../lib/threads.js';
import { PinsButton } from './dialogs/PinsDialog.jsx';

export function Topbar({ route }) {
  const store = useStore();
  useStoreEvent('channels', 'guilds', 'status', 'prefs', 'threads');
  const menus = useMenus();

  const ch = store.channels.get(route.channelId);
  const guild = store.guilds.get(route.guildId);
  const parent = ch?.type === 'thread' ? store.channels.get(ch.parent_id) : null;
  const post = parent?.type === 'forum'
    ? (store.threads.get(parent.id) || []).find((t) => t.id === ch.id)
    : null;
  const status = guild ? store.gw.statusOf(guild.domain) : Status.Closed;
  const membersShown = store.prefs.members !== false;

  return (
    <header className="topbar flex h-12 shrink-0 items-center gap-2 border-b border-separator px-4">
      {parent ? (
        <IconButton
          title={`Back to ${parent.name}`}
          onClick={() => store.navigate({
            view: parent.type === 'forum' ? 'forum' : 'chat',
            channelId: parent.id,
          })}
        >
          <BackIcon />
        </IconButton>
      ) : null}

      {ch || guild ? (
        <h1 className="flex min-w-0 shrink-0 items-center gap-1.5 text-base font-semibold tracking-tight">
          {ch && ch.type !== 'thread'
            ? <HashIcon className="size-4 shrink-0 text-muted" />
            : null}
          {post?.pinned ? <PinIcon className="size-3.5 shrink-0 text-accent" /> : null}
          <span className="truncate"><EmojiText>{ch ? ch.name : guild.name}</EmojiText></span>
          {post?.locked ? (
            <span title="Locked" className="shrink-0 text-muted">
              <LockIcon className="size-3.5" />
              <span className="sr-only">Locked</span>
            </span>
          ) : null}
        </h1>
      ) : null}

      <PersistentAudioTopbar />

      {post ? <PostTags post={post} forum={parent} /> : null}

      {ch?.topic ? (
        <>
          <span className="h-4 w-px shrink-0 bg-separator" />
          <p className="min-w-0 flex-1 truncate text-sm text-muted" title={ch.topic}>
            <EmojiText>{ch.topic}</EmojiText>
          </p>
        </>
      ) : <div className="flex-1" />}

      {status !== Status.Ready && guild
        ? (
          <span title={`${guild.domain} is ${status}`} className="flex shrink-0">
            <Pill tone="warn">{status}</Pill>
          </span>
        )
        : null}

      <div className="flex shrink-0 items-center gap-0.5">
        {guild ? (
          <IconButton
            active={membersShown}
            title={membersShown ? 'Hide member list' : 'Show member list'}
            onClick={() => {
              store.prefs.members = !membersShown;
              store.savePrefs();
            }}
          >
            <MembersIcon />
          </IconButton>
        ) : null}

        {post ? (
          <MenuButton
            label="Post actions"
            placement="bottom end"
            className={`${buttonVariants({ variant: 'ghost', shape: 'square', size: 'base' })} text-muted hover:text-foreground`}
            content={menus.post(post)}
          >
            <MoreIcon className="size-4" />
          </MenuButton>
        ) : null}

        {ch && ch.type === 'forum' ? (
          <IconButton
            title="Open the board"
            onClick={() => store.navigate({ view: 'forum', channelId: ch.id })}
          >
            <ForumIcon />
          </IconButton>
        ) : null}

        {ch && ch.type !== 'voice' && ch.type !== 'forum' && store.supports(ch.domain, 'threads') ? (
          <ThreadsButton channelId={threadParentOf(ch)} />
        ) : null}

        {ch && ch.type !== 'voice' && ch.type !== 'forum' ? (
          <PinsButton channelId={ch.id} />
        ) : null}

      </div>

      {guild && store.supportsForGuild(guild.id, 'search') ? (
        <HeaderSearch guildId={guild.id} name={guild.name} />
      ) : null}
    </header>
  );
}

function PostTags({ post, forum }) {
  const worn = (post.tags || [])
    .map((id) => (forum.available_tags || []).find((t) => t.id === id))
    .filter(Boolean);
  if (!worn.length) return null;
  return (
    <>
      <span className="h-4 w-px shrink-0 bg-separator" />
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {worn.map((tag) => (
          <span
            key={tag.id}
            className="flex max-w-[140px] shrink-0 items-center gap-1 rounded-md bg-surface-secondary px-1.5 py-0.5 text-xs font-medium text-muted"
          >
            {tag.emoji ? <EmojiText>{tag.emoji}</EmojiText> : null}
            <span className="truncate"><EmojiText>{tag.name}</EmojiText></span>
          </span>
        ))}
      </div>
    </>
  );
}
