import { useCallback, useEffect, useMemo, useState } from 'react';
import { cn } from '../lib/cn.js';
import { AnimatedImage } from '../components/AnimatedImage.jsx';
import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useModal } from '../hooks/useModal.jsx';
import { useMenus } from './menus.jsx';
import { relative, shortName } from '../lib/util.js';
import { clipContent } from '../lib/emoji.js';
import { renderContent, takeForwards } from '../lib/markdown.jsx';
import {
  Avatar, Button, ContextMenu, EmojiText, EmptyState, ForumIcon, GalleryIcon, IconButton,
  Loading, PinIcon, RowsIcon, SearchField, Select, SortIcon,
} from '../components/index.js';
import { MobileContextMenu } from './mobile/MobileNavigation.jsx';
import { NewPostDialog } from './dialogs/NewPostDialog.jsx';

const SORTS = [
  ['activity', 'Recent activity'],
  ['creation', 'Date posted'],
];

const EXCERPT = 180;

function excerptOf(thread) {
  const { body } = takeForwards(thread.opening?.content || '');
  const text = clipContent(body.trim(), EXCERPT);
  if (text.trim()) return text;
  const count = thread.opening?.attachments?.length || 0;
  if (count) return count === 1 ? 'Sent an attachment' : `Sent ${count} attachments`;
  return '';
}

function Excerpt({ post }) {
  const store = useStore();
  const text = excerptOf(post);
  if (!text) return null;
  return (
    <p className="msg-preview line-clamp-2 text-sm text-muted">
      {renderContent(text, { me: store.me?.user_id, store, guildId: post.guild_id })}
    </p>
  );
}

function previewOf(thread, base) {
  const att = (thread.opening?.attachments || []).find((a) => (a.mime || '').startsWith('image/'));
  if (!att) return null;
  return { url: att.url || `${base}/_telium/v1/media/${att.ref || att.hash}`, name: att.name };
}

function TagPill({ tag, active, onClick, mobile = false }) {
  const content = (
    <>
      {tag.emoji ? <EmojiText>{tag.emoji}</EmojiText> : null}
      <span className="truncate"><EmojiText>{tag.name}</EmojiText></span>
    </>
  );
  const className = cn(
    'flex max-w-[160px] shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium',
    mobile && onClick && 'min-h-9 rounded-lg px-2.5 py-1.5 text-sm',
    active
      ? 'bg-accent text-accent-foreground'
      : 'bg-surface-secondary text-muted',
    onClick && !active && 'hover:bg-surface-tertiary hover:text-foreground',
  );
  if (!onClick) return <span className={className}>{content}</span>;
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={className}>
      {content}
    </button>
  );
}

export function ForumView({ channelId, mobile = false }) {
  const store = useStore();
  useStoreEvent('channels', 'threads');
  const modal = useModal();
  const menus = useMenus();

  const channel = store.channels.get(channelId);
  const tags = useMemo(() => channel?.available_tags || [], [channel?.available_tags]);
  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const [sort, setSort] = useState(channel?.default_sort || 'activity');
  const [layout, setLayout] = useState(channel?.default_layout || 'list');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const resp = await store.apiForChannel(channelId).threads(channelId, false, sort);
      store.threads.set(channelId, resp.threads || []);
      store.emit('threads', channelId);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [store, channelId, sort]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const posts = store.threads.get(channelId) || [];
  const base = store.apiForChannel(channelId)?.base || '';

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return posts.filter((p) => {
      if (p.archived) return false;
      if (filter.length && !filter.every((id) => (p.tags || []).includes(id))) return false;
      if (!needle) return true;
      return (p.title || '').toLowerCase().includes(needle)
        || (p.opening?.content || '').toLowerCase().includes(needle);
    });
  }, [posts, query, filter]);

  const open = (post) => {
    store.channels.set(post.id, {
      id: post.id,
      name: post.title,
      type: 'thread',
      parent_id: channelId,
      guild_id: post.guild_id,
      domain: channel.domain,
    });
    store.navigate({ view: 'chat', channelId: post.id });
  };

  const compose = () => modal.open((close) => (
    <NewPostDialog channel={channel} close={close} onCreated={open} />
  ), { wide: true });

  const toggleTag = (id) => setFilter(
    (was) => (was.includes(id) ? was.filter((t) => t !== id) : [...was, id]),
  );

  if (!channel) return <Loading label="Opening the forum..." />;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className={cn(
        'flex shrink-0 flex-col gap-2 border-b border-border',
        mobile ? 'px-3 py-2.5' : 'px-4 py-3',
      )}>
        <div className={cn('flex gap-2', mobile ? 'flex-col' : 'items-center')}>
          <SearchField
            label="Search posts"
            placeholder="Search posts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery('')}
            size={mobile ? 'base' : 'sm'}
            className={cn('min-w-0 flex-1', mobile ? 'min-h-11 max-w-none' : 'max-w-[280px]')}
          />

          <div className={cn('flex min-w-0 items-center gap-2', !mobile && 'ms-auto')}>
            <div className={cn(
              'flex min-w-0 items-center gap-1.5 text-muted',
              mobile ? 'flex-1' : 'shrink-0',
            )}>
              <SortIcon className="size-4 shrink-0" />
              <Select
                aria-label="Sort posts"
                options={SORTS}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className={cn('w-auto text-sm', mobile ? 'min-h-10 flex-1' : 'py-1')}
              />
            </div>
            <IconButton
              title={layout === 'gallery' ? 'List view' : 'Gallery view'}
              className={mobile ? 'size-10 shrink-0 rounded-xl' : undefined}
              onClick={() => setLayout(layout === 'gallery' ? 'list' : 'gallery')}
            >
              {layout === 'gallery' ? <RowsIcon /> : <GalleryIcon />}
            </IconButton>
            {store.can(channelId, 'SEND_MESSAGES') ? (
              <Button
                variant="primary"
                size="sm"
                className={mobile ? 'min-h-10 shrink-0 rounded-xl px-3' : undefined}
                onClick={compose}
              >
                New Post
              </Button>
            ) : null}
          </div>
        </div>

        {tags.length ? (
          <div className={cn(
            'flex items-center gap-1.5',
            mobile ? 'overflow-x-auto overscroll-contain pb-0.5' : 'flex-wrap',
          )}>
            {tags.map((tag) => (
              <TagPill
                key={tag.id}
                tag={tag}
                active={filter.includes(tag.id)}
                onClick={() => toggleTag(tag.id)}
                mobile={mobile}
              />
            ))}
            {filter.length ? (
              <button
                type="button"
                onClick={() => setFilter([])}
                className={cn(
                  'shrink-0 text-muted hover:text-foreground',
                  mobile ? 'min-h-9 rounded-lg px-2.5 text-sm active:bg-surface-tertiary' : 'text-xs',
                )}
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        data-mobile-scroll={mobile ? '' : undefined}
        className={cn('min-h-0 flex-1 overflow-y-auto py-3', mobile ? 'px-3' : 'px-4')}
      >
        {loading && !posts.length ? <Loading label="Loading posts..." /> : null}
        {error && !posts.length ? (
          <EmptyState icon={ForumIcon} title="Could not load this forum">
            {error.message || 'The server did not answer.'}
          </EmptyState>
        ) : null}
        {!loading && !error && !shown.length ? (
          <EmptyState icon={ForumIcon} title={posts.length ? 'No posts match' : 'No posts yet'}>
            {posts.length
              ? 'Nothing here wears all of those tags. Try clearing a filter.'
              : 'Start the first one and it becomes a thread anyone can reply in.'}
          </EmptyState>
        ) : null}

        <div
          className={cn(
            layout === 'gallery'
              ? cn('grid gap-3', mobile ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))]')
              : 'flex flex-col gap-2',
          )}
        >
          {shown.map((post) => {
            const ContextWrapper = mobile ? MobileContextMenu : ContextMenu;
            return (
              <ContextWrapper key={post.id} content={() => menus.post(post)}>
                <PostCard
                  post={post}
                  layout={layout}
                  base={base}
                  tagsById={byId}
                  mobile={mobile}
                  onOpen={() => open(post)}
                />
              </ContextWrapper>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function PostCard({ post, layout, base, tagsById, onOpen, mobile = false, ...rest }) {
  const preview = previewOf(post, base);
  const worn = (post.tags || []).map((id) => tagsById.get(id)).filter(Boolean);
  const author = post.opening?.author?.user_id || post.owner;

  const heading = (
    <div className="flex min-w-0 items-center gap-1.5">
      {post.pinned ? (
        <span title="Pinned" className="shrink-0 text-accent">
          <PinIcon className="size-3.5" />
          <span className="sr-only">Pinned</span>
        </span>
      ) : null}
      <span className="min-w-0 truncate text-base font-semibold"><EmojiText>{post.title}</EmojiText></span>
    </div>
  );

  const meta = (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
      <Avatar id={author} size="xs" />
      <span className="truncate">{shortName(author)}</span>
      <span aria-hidden>·</span>
      <span>{relative(post.last_active)}</span>
      <span aria-hidden>·</span>
      <span className="tnum">
        {`${post.message_count} ${post.message_count === 1 ? 'message' : 'messages'}`}
      </span>
    </div>
  );

  const pills = worn.length ? (
    <div className="flex flex-wrap items-center gap-1">
      {worn.map((tag) => <TagPill key={tag.id} tag={tag} />)}
    </div>
  ) : null;

  if (layout === 'gallery') {
    return (
      <button
        type="button"
        data-post={post.id}
        aria-label={post.title}
        onClick={onOpen}
        className={cn(
          'flex flex-col overflow-hidden rounded-xl border border-border text-start transition-colors hover:bg-surface',
          mobile && 'active:bg-surface',
        )}
        {...rest}
      >
        <div className="flex h-[130px] w-full items-center justify-center bg-surface-secondary">
          {preview ? (
            <AnimatedImage
              src={preview.url}
              alt={preview.name || post.title}
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <ForumIcon className="size-6 text-muted" />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 p-3">
          {heading}
          <Excerpt post={post} />
          {pills}
          {meta}
        </div>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-post={post.id}
      aria-label={post.title}
      onClick={onOpen}
      className={cn(
        'flex items-start gap-3 rounded-xl border border-border px-3.5 py-3 text-start transition-colors hover:bg-surface',
        mobile && 'min-h-20 active:bg-surface',
      )}
      {...rest}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {heading}
        <Excerpt post={post} />
        {pills}
        {meta}
      </div>
      {preview ? (
        <AnimatedImage
          src={preview.url}
          alt={preview.name || post.title}
          loading="lazy"
          className="size-[68px] shrink-0 rounded-lg object-cover"
        />
      ) : null}
    </button>
  );
}
