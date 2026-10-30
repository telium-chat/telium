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
  const { store, dialogs, t: tr } = env;
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
          title: tr('chat.menu.deleteFileTitle'),
          body: tr('chat.menu.deleteFileBody', { name: att.name || att.hash }),
          confirmLabel: tr('chat.menu.deleteFileConfirm'),
          danger: true,
          onConfirm: async () => {
            try {
              await store.home.deleteMedia(att.hash);
              toast(tr('chat.menu.fileDeleted'));
            } catch (e) { reportError(e, e.message || tr('chat.menu.fileDeleteFailed')); }
          },
        })}
      >
        {tr('chat.menu.deleteFileItem', { name: att.name || att.hash })}
      </MenuItem>
    ));
}

export const post = (env, thread, { onGone } = {}) => {
  const { store, t: tr, dialogs } = env;
  const api = () => store.apiForChannel(thread.parent_id);
  const moderator = has(store.permissionsIn(thread.parent_id), 'MANAGE_MESSAGES');
  const mine = thread.owner === store.me?.user_id;

  const patch = (body, failure) => async () => {
    try {
      const saved = await api().patchThread(thread.id, body);
      const list = store.threads.get(thread.parent_id) || [];
      store.threads.set(
        thread.parent_id,
        list.map((x) => (x.id === thread.id ? { ...x, ...saved } : x)),
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
            onAction={patch({ pinned: !thread.pinned }, tr('chat.menu.postPinFailed'))}
          >
            {thread.pinned ? tr('chat.menu.unpinPost') : tr('chat.menu.pinPost')}
          </MenuItem>
          <MenuItem
            icon={thread.locked ? ThreadIcon : CloseIcon}
            onAction={patch({ locked: !thread.locked }, tr('chat.menu.postLockFailed'))}
          >
            {thread.locked ? tr('chat.menu.unlockPost') : tr('chat.menu.lockPost')}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(thread.id, tr('chat.menu.copyPostId'))}>
        {tr('chat.menu.copyPostIdItem')}
      </MenuItem>
      {moderator || mine ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: tr('chat.menu.deleteNamed', { name: thread.title }),
            body: tr('chat.menu.deleteRepliesBody'),
            confirmLabel: tr('chat.menu.deleteConfirm'),
            danger: true,
            onConfirm: async () => {
              try {
                await api().deleteThread(thread.id);
                store.dropThread(thread.parent_id, thread.id);
                onGone?.();
              } catch (e) { reportError(e, tr('chat.menu.postDeleteFailed')); }
            },
          })}
        >
          {tr('chat.menu.deletePost')}
        </MenuItem>
      ) : null}
    </>
  );
};

export const thread = (env, thread, { onOpen, onGone, onChanged } = {}) => {
  const { store, dialogs, t: tr } = env;
  const parentId = thread.parent_id;
  const api = () => store.apiForChannel(parentId);
  const moderator = has(store.permissionsIn(parentId), 'MANAGE_MESSAGES');
  const mine = thread.owner === store.me?.user_id;
  const domain = store.channels.get(thread.id)?.domain || store.channels.get(parentId)?.domain || '';

  const go = () => {
    if (onOpen) { onOpen(); return; }
    store.channels.set(thread.id, {
      id: thread.id, name: thread.title, type: 'thread', parent_id: parentId,
      guild_id: thread.guild_id, domain,
    });
    store.navigate({ view: 'chat', channelId: thread.id });
  };

  const patch = (body, failure) => async () => {
    try {
      const saved = await api().patchThread(thread.id, body);
      const list = store.threads.get(parentId) || [];
      store.threads.set(parentId, list.map((x) => (x.id === thread.id ? { ...x, ...saved } : x)));
      store.emit('threads', parentId);
      onChanged?.();
    } catch (e) { reportError(e, failure); }
  };

  return (
    <>
      <MenuItem icon={ThreadIcon} onAction={go}>{tr('chat.menu.openThread')}</MenuItem>
      {muteItems(env, thread.id, 'thread')}
      <MenuItem icon={CheckIcon} onAction={() => store.ack(thread.id)}>{tr('chat.menu.markRead')}</MenuItem>
      <MenuItem
        icon={LinkIcon}
        onAction={() => copyToClipboard(`${domain}/${thread.id}`, tr('chat.menu.copyThreadLink'))}
      >
        {tr('chat.menu.copyLink')}
      </MenuItem>
      {moderator || mine ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={EditIcon}
            onAction={() => dialogs.prompt({
              title: tr('chat.menu.renameThread'),
              label: tr('chat.menu.threadTitle'),
              value: thread.title || '',
              confirmLabel: tr('chat.menu.rename'),
              onSubmit: async (title) => {
                if (!title.trim() || title.trim() === thread.title) return;
                await patch({ title: title.trim() }, tr('chat.menu.renameFailed'))();
              },
            })}
          >
            {tr('chat.menu.renameThread')}
          </MenuItem>
          <MenuItem
            icon={thread.archived ? ThreadIcon : CheckIcon}
            onAction={patch({ archived: !thread.archived }, tr('chat.menu.archiveFailed'))}
          >
            {thread.archived ? tr('chat.menu.unarchiveThread') : tr('chat.menu.archiveThread')}
          </MenuItem>
        </>
      ) : null}
      {moderator ? (
        <>
          <MenuItem
            icon={PinIcon}
            onAction={patch({ pinned: !thread.pinned }, tr('chat.menu.threadPinFailed'))}
          >
            {thread.pinned ? tr('chat.menu.unpinThread') : tr('chat.menu.pinThread')}
          </MenuItem>
          <MenuItem
            icon={thread.locked ? ThreadIcon : CloseIcon}
            onAction={patch({ locked: !thread.locked }, tr('chat.menu.threadLockFailed'))}
          >
            {thread.locked ? tr('chat.menu.unlockThread') : tr('chat.menu.lockThread')}
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(thread.id, tr('chat.menu.copyThreadId'))}>
        {tr('chat.menu.copyThreadIdItem')}
      </MenuItem>
      {moderator || mine ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: tr('chat.menu.deleteNamed', { name: thread.title }),
            body: tr('chat.menu.deleteRepliesBody'),
            confirmLabel: tr('chat.menu.deleteConfirm'),
            danger: true,
            onConfirm: async () => {
              try {
                await api().deleteThread(thread.id);
                store.dropThread(parentId, thread.id);
                onGone?.();
              } catch (e) { reportError(e, tr('chat.menu.threadDeleteFailed')); }
            },
          })}
        >
          {tr('chat.menu.deleteThread')}
        </MenuItem>
      ) : null}
    </>
  );
};

export const message = (env, msg, { onReply, onEdit }) => {
  const { store, modal, dialogs, t: tr } = env;
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
    } catch (e) { reportError(e, tr('chat.menu.reactionFailed')); }
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
            {tr('chat.menu.addReaction')}
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {maySend ? (
        <MenuItem icon={ReplyIcon} onAction={() => onReply?.(msg)}>{tr('chat.menu.reply')}</MenuItem>
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
          {tr('chat.menu.forward')}
        </MenuItem>
      ) : null}
      {maySend ? (
        <MenuItem
          icon={ThreadIcon}
          onAction={() => dialogs.prompt({
            title: tr('chat.menu.startThread'),
            label: tr('chat.menu.threadTitle'),
            value: (msg.content || '').slice(0, 60),
            confirmLabel: tr('chat.menu.create'),
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
              } catch (e) { reportError(e, tr('chat.menu.startThreadFailed')); }
            },
          })}
        >
          {tr('chat.menu.startThread')}
        </MenuItem>
      ) : null}
      {mine ? (
        <MenuItem icon={EditIcon} onAction={() => onEdit?.(msg.id)}>{tr('chat.menu.editMessage')}</MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={CopyIcon}
        onAction={() => copyToClipboard(msg.content || '', tr('chat.menu.copyTextLabel'))}
      >
        {tr('chat.menu.copyText')}
      </MenuItem>
      {mayManage ? (
        <MenuItem
          icon={PinIcon}
          onAction={async () => {
            try { await api().pin(msg.channel_id, msg.id); toast(tr('chat.menu.pinnedToast')); }
            catch (e) {
              if (e.status !== 409) { reportError(e, tr('chat.menu.pinFailed')); return; }
              try { await api().unpin(msg.channel_id, msg.id); toast(tr('chat.menu.unpinnedToast')); }
              catch (err) { reportError(err, tr('chat.menu.unpinFailed')); }
            }
          }}
        >
          {tr('chat.menu.pinMessage')}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={FlagIcon}
        tone="danger"
        onAction={() => modal.open((c) => <ReportDialog msg={msg} close={c} />)}
      >
        {tr('chat.menu.reportMessage')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={CopyIcon}
        onAction={() => copyToClipboard(msg.id, tr('chat.menu.copyMessageId'))}
      >
        {tr('chat.menu.copyMessageIdItem')}
      </MenuItem>
      {attachmentDeleteItems(env, msg)}
      {mine || mayManage ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={TrashIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: tr('chat.menu.deleteMessage'),
              body: tr('chat.menu.deleteMessageBody'),
              confirmLabel: tr('chat.menu.deleteConfirm'),
              danger: true,
              onConfirm: async () => {
                try { await api().deleteMessage(msg.channel_id, msg.id); }
                catch (e) { reportError(e, tr('chat.menu.deleteFailed')); }
              },
            })}
          >
            {tr('chat.menu.deleteMessage')}
          </MenuItem>
        </>
      ) : null}
    </>
  );
};

export const conversationMessage = (env, convo, msg, { onReply, onEdit }) => {
  const { store, modal, dialogs, t: tr } = env;
  const mine = msg.author === store.me?.user_id;
  const readable = !msg.unreadable && !msg.deleted;

  return (
    <>
      {readable ? (
        <MenuItem icon={ReplyIcon} onAction={() => onReply?.(msg)}>{tr('chat.menu.reply')}</MenuItem>
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
          {tr('chat.menu.forward')}
        </MenuItem>
      ) : null}
      {mine && readable ? (
        <MenuItem icon={EditIcon} onAction={() => onEdit?.(msg.id)}>{tr('chat.menu.editMessage')}</MenuItem>
      ) : null}
      {readable ? (
        <MenuItem
          icon={PinIcon}
          onAction={() => store.setPinDm(convo.id, msg.id, !msg.pinned)
            .catch((e) => reportError(e, tr('chat.menu.pinFailed')))}
        >
          {msg.pinned ? tr('chat.menu.unpinMessage') : tr('chat.menu.pinMessage')}
        </MenuItem>
      ) : null}
      <MenuSeparator />
      {readable ? (
        <MenuItem
          icon={CopyIcon}
          onAction={() => copyToClipboard(msg.content || '', tr('chat.menu.copyTextLabel'))}
        >
          {tr('chat.menu.copyText')}
        </MenuItem>
      ) : null}
      <MenuItem
        icon={CopyIcon}
        onAction={() => copyToClipboard(msg.id, tr('chat.menu.copyMessageId'))}
      >
        {tr('chat.menu.copyMessageIdItem')}
      </MenuItem>
      {readable ? attachmentDeleteItems(env, msg) : null}
      {mine ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={TrashIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: tr('chat.menu.deleteMessage'),
              body: tr('chat.menu.deleteDmBody'),
              confirmLabel: tr('chat.menu.deleteConfirm'),
              danger: true,
              onConfirm: async () => {
                try { await store.deleteDm(convo.id, msg.id); }
                catch (e) { reportError(e, tr('chat.menu.deleteFailed')); }
              },
            })}
          >
            {tr('chat.menu.deleteMessage')}
          </MenuItem>
        </>
      ) : null}
    </>
  );
};
