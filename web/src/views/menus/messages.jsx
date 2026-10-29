import { reportError, toast } from '../../hooks/useToast.jsx';
import { has } from '../../lib/perms.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import {
  CheckIcon, CloseIcon, CopyIcon, EditIcon, EmojiIcon, FlagIcon, ForwardIcon, LinkIcon, MenuItem,
  MenuSeparator, PinIcon, ReplyIcon, ThreadIcon, TrashIcon,
} from '../../components/index.js';
import { MenuReactions } from '../../components/Menu.jsx';
import { ForwardDialog } from '../chat/ForwardDialog.jsx';
import { ReportDialog } from '../dialogs/ReportDialog.jsx';
import { EmojiPickerDialog } from '../dialogs/EmojiPickerDialog.jsx';
import { quickEmoji } from '../../lib/emoji.js';
import { muteItems } from './common.jsx';


/// One "Delete file" item per attachment this account hosted on its own
/// homeserver and may still remove. Files on another origin are not ours to
/// delete from here; external providers are not either.
function attachmentDeleteItems(env, msg) {
  const { store, dialogs } = env;
  const home = store.session?.home?.domain;
  const mine = msg.author === store.me?.user_id;
  if (!mine || !store.home) return [];
  return (msg.attachments || [])
    .filter((att) => !att.external && att.hash && (!att.origin || att.origin === home))
    .map((att) => (
      <MenuItem
        key={att.hash}
        icon={TrashIcon}
        tone="danger"
        onAction={() => dialogs.confirm({
          title: 'Delete file',
          body: `"${att.name || att.hash}" is removed from your homeserver. The message stays, showing the file as gone. If the same bytes were uploaded more than once here, the copy is shared and this will be refused.`,
          confirmLabel: 'Delete file',
          danger: true,
          onConfirm: async () => {
            try {
              await store.home.deleteMedia(att.hash);
              toast('File deleted.');
            } catch (e) { reportError(e, e.message || 'Could not delete the file'); }
          },
        })}
      >
        {`Delete file: ${att.name || att.hash}`}
      </MenuItem>
    ));
}

export const post = (env, thread, { onGone } = {}) => {
  const { store, t, dialogs } = env;
  const api = () => store.apiForChannel(thread.parent_id);
  const moderator = has(store.permissionsIn(thread.parent_id), 'MANAGE_MESSAGES');
  const mine = thread.owner === store.me?.user_id;

  const patch = (body, failure) => async () => {
    try {
      const saved = await api().patchThread(thread.id, body);
      const list = store.threads.get(thread.parent_id) || [];
      store.threads.set(
        thread.parent_id,
        list.map((t) => (t.id === thread.id ? { ...t, ...saved } : t)),
      );
      store.emit('threads', thread.parent_id);
    } catch (e) { reportError(e, failure); }
  };

  return (
    <>
      {moderator ? (
        <>
          <MenuItem
            icon={PinIcon}
            onAction={patch({ pinned: !thread.pinned }, 'Could not pin the post')}
          >
            {thread.pinned ? 'Unpin post' : 'Pin post'}
          </MenuItem>
          <MenuItem
            icon={thread.locked ? ThreadIcon : CloseIcon}
            onAction={patch({ locked: !thread.locked }, 'Could not lock the post')}
          >
            {thread.locked ? 'Unlock post' : 'Lock post'}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(thread.id, 'Post id')}>
        Copy post id
      </MenuItem>
      {moderator || mine ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: `Delete ${thread.title}`,
            body: 'Replies go with it. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              try {
                await api().deleteThread(thread.id);
                store.dropThread(thread.parent_id, thread.id);
                onGone?.();
              } catch (e) { reportError(e, 'Could not delete the post'); }
            },
          })}
        >
          Delete post
        </MenuItem>
      ) : null}
    </>
  );
};

export const thread = (env, t, { onOpen, onGone, onChanged } = {}) => {
  const { store, dialogs } = env;
  const parentId = t.parent_id;
  const api = () => store.apiForChannel(parentId);
  const moderator = has(store.permissionsIn(parentId), 'MANAGE_MESSAGES');
  const mine = t.owner === store.me?.user_id;
  const domain = store.channels.get(t.id)?.domain || store.channels.get(parentId)?.domain || '';

  const go = () => {
    if (onOpen) { onOpen(); return; }
    store.channels.set(t.id, {
      id: t.id, name: t.title, type: 'thread', parent_id: parentId,
      guild_id: t.guild_id, domain,
    });
    store.navigate({ view: 'chat', channelId: t.id });
  };

  const patch = (body, failure) => async () => {
    try {
      const saved = await api().patchThread(t.id, body);
      const list = store.threads.get(parentId) || [];
      store.threads.set(parentId, list.map((x) => (x.id === t.id ? { ...x, ...saved } : x)));
      store.emit('threads', parentId);
      onChanged?.();
    } catch (e) { reportError(e, failure); }
  };

  return (
    <>
      <MenuItem icon={ThreadIcon} onAction={go}>Open thread</MenuItem>
      {muteItems(env, t.id, 'thread')}
      <MenuItem icon={CheckIcon} onAction={() => store.ack(t.id)}>Mark read</MenuItem>
      <MenuItem icon={LinkIcon} onAction={() => copyToClipboard(`${domain}/${t.id}`, 'Thread link')}>
        Copy link
      </MenuItem>
      {moderator || mine ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={EditIcon}
            onAction={() => dialogs.prompt({
              title: 'Rename thread',
              label: 'Thread title',
              value: t.title || '',
              confirmLabel: 'Rename',
              onSubmit: async (title) => {
                if (!title.trim() || title.trim() === t.title) return;
                await patch({ title: title.trim() }, 'Could not rename the thread')();
              },
            })}
          >
            Rename thread
          </MenuItem>
          <MenuItem
            icon={t.archived ? ThreadIcon : CheckIcon}
            onAction={patch({ archived: !t.archived }, 'Could not archive the thread')}
          >
            {t.archived ? 'Unarchive thread' : 'Archive thread'}
          </MenuItem>
        </>
      ) : null}
      {moderator ? (
        <>
          <MenuItem
            icon={PinIcon}
            onAction={patch({ pinned: !t.pinned }, 'Could not pin the thread')}
          >
            {t.pinned ? 'Unpin thread' : 'Pin thread'}
          </MenuItem>
          <MenuItem
            icon={t.locked ? ThreadIcon : CloseIcon}
            onAction={patch({ locked: !t.locked }, 'Could not lock the thread')}
          >
            {t.locked ? 'Unlock thread' : 'Lock thread'}
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(t.id, 'Thread id')}>
        Copy thread id
      </MenuItem>
      {moderator || mine ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: `Delete ${t.title}`,
            body: 'Replies go with it. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              try {
                await api().deleteThread(t.id);
                store.dropThread(parentId, t.id);
                onGone?.();
              } catch (e) { reportError(e, 'Could not delete the thread'); }
            },
          })}
        >
          Delete thread
        </MenuItem>
      ) : null}
    </>
  );
};

export const message = (env, msg, { onReply, onEdit }) => {
  const { store, modal, dialogs } = env;
  const api = () => store.apiForChannel(msg.channel_id);
  const perms = store.permissionsIn(msg.channel_id);
  const mine = msg.author === store.me?.user_id;
  const mayManage = has(perms, 'MANAGE_MESSAGES');
  const maySend = has(perms, 'SEND_MESSAGES');
  const mayReact = has(perms, 'ADD_REACTIONS');
  const quick = quickEmoji(store.sync, 4);

  const toggleReaction = async (emoji) => {
    try {
      const held = (msg.reactions || []).find((r) => r.emoji === emoji)?.me;
      if (held) await api().unreact(msg.id, emoji);
      else await api().react(msg.id, emoji);
    } catch (e) { reportError(e, 'Reaction failed'); }
  };

  return (
    <>
      {mayReact ? (
        <>
          <MenuReactions emojis={quick} onPick={toggleReaction} />
          <MenuItem
            icon={EmojiIcon}
            onAction={() => modal.open((c) => (
              <EmojiPickerDialog
                guildId={msg.guild_id}
                close={c}
                onPick={toggleReaction}
              />
            ), { wide: true, desktopSize: 'emoji' })}
          >
            Add reaction
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {maySend ? (
        <MenuItem icon={ReplyIcon} onAction={() => onReply?.(msg)}>Reply</MenuItem>
      ) : null}
      {maySend ? (
        <MenuItem
          icon={ForwardIcon}
          onAction={() => modal.open((c) => (
            <ForwardDialog
              payload={{
                text: msg.content || '',
                attachments: msg.attachments || [],
                origin: { guildId: msg.guild_id, channelId: msg.channel_id, messageId: msg.id },
              }}
              close={c}
            />
          ))}
        >
          Forward
        </MenuItem>
      ) : null}
      {maySend ? (
        <MenuItem
          icon={ThreadIcon}
          onAction={() => dialogs.prompt({
            title: 'Start a thread',
            label: 'Thread title',
            value: (msg.content || '').slice(0, 60),
            confirmLabel: 'Create',
            onSubmit: async (title) => {
              if (!title.trim()) return;
              try {
                const thread = await api().createThread(msg.channel_id, {
                  title: title.trim(), message_id: msg.id,
                });
                store.channels.set(thread.id, {
                  id: thread.id,
                  name: thread.title,
                  type: 'thread',
                  parent_id: msg.channel_id,
                  guild_id: msg.guild_id,
                  domain: store.channels.get(msg.channel_id).domain,
                });
                store.emit('channels', msg.guild_id);
                store.navigate({ channelId: thread.id });
              } catch (e) { reportError(e, 'Could not start a thread'); }
            },
          })}
        >
          Start a thread
        </MenuItem>
      ) : null}
      {mine ? (
        <MenuItem icon={EditIcon} onAction={() => onEdit?.(msg.id)}>Edit message</MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(msg.content || '', 'Message text')}>
        Copy text
      </MenuItem>
      {mayManage ? (
        <MenuItem
          icon={PinIcon}
          onAction={async () => {
            try { await api().pin(msg.channel_id, msg.id); toast('Pinned.'); }
            catch (e) {
              if (e.status !== 409) { reportError(e, 'Could not pin'); return; }
              try { await api().unpin(msg.channel_id, msg.id); toast('Unpinned.'); }
              catch (err) { reportError(err, 'Could not unpin'); }
            }
          }}
        >
          Pin message
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={FlagIcon}
        tone="danger"
        onAction={() => modal.open((c) => <ReportDialog msg={msg} close={c} />)}
      >
        Report message
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(msg.id, 'Message id')}>
        Copy message id
      </MenuItem>
      {attachmentDeleteItems(env, msg)}
      {mine || mayManage ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={TrashIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: 'Delete message',
              body: 'This cannot be undone.',
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: async () => {
                try { await api().deleteMessage(msg.channel_id, msg.id); }
                catch (e) { reportError(e, 'Could not delete'); }
              },
            })}
          >
            Delete message
          </MenuItem>
        </>
      ) : null}
    </>
  );
};

export const conversationMessage = (env, convo, msg, { onReply, onEdit }) => {
  const { store, modal, dialogs } = env;
  const mine = msg.author === store.me?.user_id;
  const readable = !msg.unreadable && !msg.deleted;

  return (
    <>
      {readable ? (
        <MenuItem icon={ReplyIcon} onAction={() => onReply?.(msg)}>Reply</MenuItem>
      ) : null}
      {readable ? (
        <MenuItem
          icon={ForwardIcon}
          onAction={() => modal.open((c) => (
            <ForwardDialog
              payload={{
                text: msg.content || '',
                attachments: msg.attachments || [],
                origin: { kind: 'conversation', conversationId: convo.id, messageId: msg.id },
              }}
              close={c}
            />
          ))}
        >
          Forward
        </MenuItem>
      ) : null}
      {mine && readable ? (
        <MenuItem icon={EditIcon} onAction={() => onEdit?.(msg.id)}>Edit message</MenuItem>
      ) : null}
      {readable ? (
        <MenuItem
          icon={PinIcon}
          onAction={() => store.setPinDm(convo.id, msg.id, !msg.pinned)
            .catch((e) => reportError(e, 'Could not pin'))}
        >
          {msg.pinned ? 'Unpin message' : 'Pin message'}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      {readable ? (
        <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(msg.content || '', 'Message text')}>
          Copy text
        </MenuItem>
      ) : null}
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(msg.id, 'Message id')}>
        Copy message id
      </MenuItem>
      {readable ? attachmentDeleteItems(env, msg) : null}
      {mine ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={TrashIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: 'Delete message',
              body: 'This removes it for everyone.',
              confirmLabel: 'Delete',
              danger: true,
              onConfirm: async () => {
                try { await store.deleteDm(convo.id, msg.id); }
                catch (e) { reportError(e, 'Could not delete'); }
              },
            })}
          >
            Delete message
          </MenuItem>
        </>
      ) : null}
    </>
  );
};
