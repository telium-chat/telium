import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { cn } from '../../lib/cn.js';
import { dateOrdered, dateTime, dateTimeOrdered } from '../../lib/i18n/index.js';
import { Trans, useLocale, useT } from '../../lib/i18n/react.jsx';
import { beforeToday, shortName, timeOf } from '../../lib/util.js';
import { has } from '../../lib/perms.js';
import { channelRoute } from '../../lib/channels.js';
import { renderContent, Emoji } from '../../lib/markdown.jsx';
import {
  expandShortcodes, loadEmoji, mayHoldShortcode, quickEmoji, rememberEmoji, shortcodeBefore,
} from '../../lib/emoji.js';
import { displayText, hasDisplayOnly, wireText } from '../../lib/mentions.js';
import {
  Avatar, BotBadge, ContextMenu, EmojiIcon, EmojiText, EditIcon, IconButton, LockIcon, MenuButton,
  MoreIcon, Pill, PinIcon, ReactionPill, ReplyIcon, ThreadIcon, TrashIcon,
} from '../../components/index.js';
import { watchShift } from './shiftHeld.js';
import { MarkdownInk, useAutosize } from './MarkdownInk.jsx';
import { FormatBar } from './FormatBar.jsx';
import { useSwipeGesture } from '../../hooks/useSwipeGesture.jsx';
import { MobileMessageActionSheet } from '../mobile/MobileNavigation.jsx';
import { useProfileCard } from '../../hooks/useProfileCard.js';
import { EmojiPopover } from './EmojiPicker.jsx';
import { useMenus } from '../menus.jsx';
import { Attachments } from './Attachments.jsx';
import { QuotePreview } from './QuotePreview.jsx';
import { Embeds } from './Embeds.jsx';
import { GifEmbeds, isGifOnlyContent } from './GifEmbed.jsx';
import { Sticker } from './Sticker.jsx';
import { invitesIn, InviteCards } from './InviteCard.jsx';
import { PlayableLinkEmbeds } from './PlayableLinkEmbeds.jsx';
import { klipyConfig } from '../../lib/gifs.js';
import { AppMessage } from '../../components/message-ui/index.js';

export const MessageRow = memo(function MessageRow({
  msg, surface, grouped, member, colour, parent, thread, mentionsMe, pinned = false,
  editing, flash, fresh, pending = false,
  dateOrder,
  onEdit, onReply, onOpenNavigation, mobile = false,
}) {
  const t = useT();
  const { dir } = useLocale();
  const rtl = dir === 'rtl';
  const store = useStore();
  const menus = useMenus();
  const profiles = useProfileCard();
  const me = store.me?.user_id;
  const gifOnly = isGifOnlyContent(msg.content, klipyConfig(store));

  const dated = beforeToday(msg.created_at);
  const when = dated
    ? dateTimeOrdered(msg.created_at, dateOrder)
    : timeOf(msg.created_at);

  const perms = surface.perms;
  const mine = msg.author === me;
  const mayReact = has(perms, 'ADD_REACTIONS') && !msg.deleted && !pending;
  const mayReply = has(perms, 'SEND_MESSAGES') && !msg.deleted && !msg.unreadable && !pending;
  const mayEdit = mine && surface.mayEdit(msg) && !msg.deleted && !msg.unreadable && !pending;

  const [reactOpen, setReactOpen] = useState(false);
  const reactRef = useRef(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const rowRef = useRef(null);
  const pressTimer = useRef(null);
  const pressedAt = useRef(null);
  const swipeFrom = useRef(null);
  const suppressClickUntil = useRef(0);

  const swipeToReply = () => {
    if (!mayReply) return;
    onReply?.(msg);
    navigator.vibrate?.(10);
  };
  const swipeToNavigation = () => {
    onOpenNavigation?.();
    navigator.vibrate?.(8);
  };
  const swipe = useSwipeGesture({
    onSwipeLeft: rtl ? swipeToNavigation : swipeToReply,
    onSwipeRight: rtl ? swipeToReply : swipeToNavigation,
    disabled: !mobile || Boolean(editing) || pending,
  });

  const onTouchStart = useCallback((e) => {
    if (mobile && !editing && !pending) {
      const touch = e.touches[0];
      pressedAt.current = { x: touch.clientX, y: touch.clientY };
      swipeFrom.current = touch.clientX;
      pressTimer.current = setTimeout(() => {
        if (!pressedAt.current) return;
        suppressClickUntil.current = Date.now() + 650;
        setSheetOpen(true);
        navigator.vibrate?.(15);
      }, 400);
    }
    swipe.onTouchStart(e);
  }, [mobile, editing, pending, swipe]);

  const onTouchMove = useCallback((e) => {
    if (!mobile || editing) return;
    const touch = e.touches[0];
    if (pressedAt.current) {
      const dx = Math.abs(touch.clientX - pressedAt.current.x);
      const dy = Math.abs(touch.clientY - pressedAt.current.y);
      if (dx > 8 || dy > 8) {
        clearTimeout(pressTimer.current);
        pressTimer.current = null;
      }
      if (dy > dx * 1.2) {
        swipeFrom.current = null;
        setSwipeOffset(0);
      }
    }
    if (swipeFrom.current == null) return;
    const travelled = touch.clientX - swipeFrom.current;
    setSwipeOffset(Math.sign(travelled) * Math.min(Math.abs(travelled) * 0.45, 55));
  }, [mobile, editing]);

  const resetTouch = useCallback(() => {
    clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressedAt.current = null;
    swipeFrom.current = null;
    setSwipeOffset(0);
  }, []);

  const onTouchEnd = useCallback((e) => {
    resetTouch();
    swipe.onTouchEnd(e);
  }, [resetTouch, swipe]);

  const onClickCapture = useCallback((e) => {
    if (Date.now() >= suppressClickUntil.current) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => () => clearTimeout(pressTimer.current), []);

  useEffect(watchShift, []);

  const quick = mayReact ? quickEmoji(store.sync, 3) : [];
  const actionable = !msg.deleted && !pending;
  const mayPin = actionable && Boolean(surface.mayPin?.(msg));
  const mayDelete = actionable && Boolean(surface.mayDelete?.(msg));
  const pinNow = async () => {
    try {
      const did = await surface.pin(msg);
      toast(t(did === 'unpinned' ? 'chat.message.unpinned' : 'chat.message.pinned'));
    } catch (e) { reportError(e, t('chat.message.pinFailed')); }
  };
  const deleteNow = async () => {
    try { await surface.remove(msg); }
    catch (e) { reportError(e, t('chat.message.deleteFailed')); }
  };

  const toggleReaction = async (emoji, held) => {
    try {
      if (held) await surface.unreact(msg, emoji);
      else { await surface.react(msg, emoji); rememberEmoji(store.sync, emoji); }
    } catch (e) { reportError(e, t('chat.message.reactionFailed')); }
  };

  const name = member?.nickname || member?.display_name || shortName(msg.author);

  const openProfile = (userId, anchor) => profiles.open(userId, {
    guildId: surface.guildId, anchor,
  });
  const warmProfile = () => profiles.prefetch(msg.author);
  const coolProfile = () => profiles.cancel();

  const quote = parent || msg.reply_to ? (
    <QuotedLine
      parent={parent}
      surface={surface}
      pinged={Boolean(parent && (msg.content || '').includes(`<@${parent.author}>`))}
      jump={surface.canJump ? () => {
        if (!surface.jump(msg)) toast(t('chat.message.replyGone'));
      } : null}
    />
  ) : null;

  const rowContent = (
    <div
      ref={rowRef}
      data-id={msg.id}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={(e) => {
        resetTouch();
        swipe.onTouchCancel();
      }}
      onClickCapture={onClickCapture}
      aria-busy={pending || undefined}
      className={cn(
        'msg-row group relative flex flex-wrap gap-x-4 -mx-4 px-4 py-0.5 transition-transform duration-100 ease-out',
        grouped ? 'msg-cont' : 'msg-head',
        'hover:bg-surface active:bg-surface/60',
        mentionsMe && 'bg-mention/8 hover:bg-mention/12 border-s-2 border-mention ps-[calc(1rem-2px)]',
        flash && 'msg-flash',
        pending && 'msg-pending',
        fresh && 'message-enter',
      )}
      style={swipeOffset ? { transform: `translateX(${swipeOffset}px)` } : undefined}
    >
      {(rtl ? swipeOffset > 15 : swipeOffset < -15) ? (
        <div
          className="pointer-events-none absolute top-0 end-2 bottom-0 flex items-center justify-center"
          style={{ opacity: Math.min(Math.abs(swipeOffset) / 45, 1) }}
        >
          <div className="flex size-7 items-center justify-center rounded-full bg-accent/20 text-accent">
            <ReplyIcon className="size-4 -scale-x-100" />
          </div>
        </div>
      ) : null}
      {quote}
      {grouped ? (
        <div className="relative w-10 shrink-0">
          <span
            className={cn(
              'absolute end-0 flex items-center gap-1 whitespace-nowrap',
              dated ? 'top-[0.5px] leading-[1.1]' : 'top-[3px]',
            )}
          >
            <span
              className={cn('tnum reveal text-2xs text-muted', dated && 'leading-[1.1]')}
              title={pending ? undefined : dateTime(msg.created_at, { date: 'full', time: 'withSeconds' })}
            >
              {dated ? (
                <>
                  {dateOrdered(msg.created_at, dateOrder, { year: false })}
                  <br />
                  {timeOf(msg.created_at)}
                </>
              ) : timeOf(msg.created_at)}
            </span>
            {pinned ? <PinMark /> : null}
          </span>
        </div>
      ) : (
        <button
          type="button"
          aria-label={t('chat.message.openProfile', { name })}
          title={t('chat.message.openProfile', { name: msg.author })}
          className="shrink-0 cursor-pointer self-start appearance-none rounded-full border-0 bg-transparent p-0 focus-outside"
          onClick={(e) => openProfile(msg.author, e.currentTarget)}
          onPointerEnter={warmProfile}
          onPointerLeave={coolProfile}
        >
          <Avatar
            size="chat"
            id={msg.author}
            {...surface.avatarFor(msg, member)}
          />
        </button>
      )}
      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <div className="flex min-w-0 items-baseline gap-2">
            <button
              type="button"
              title={msg.author}
              className={cn(
                'flex min-w-0 cursor-pointer rounded text-[length:var(--chat-text)] font-medium hover:underline',
                colour && 'role-ink',
              )}
              style={colour ? { '--role': colour } : undefined}
              onClick={(e) => openProfile(msg.author, e.currentTarget)}
              onPointerEnter={warmProfile}
              onPointerLeave={coolProfile}
            >
              <span className="truncate">
                <EmojiText>{name}</EmojiText>
              </span>
            </button>
            <BotBadge member={member} userId={msg.author} guildId={surface.guildId} />
            <span
              className="tnum shrink-0 text-2xs whitespace-nowrap text-muted"
              title={pending ? undefined : dateTime(msg.created_at, { date: 'full', time: 'withSeconds' })}
            >
              {pending && !msg.saving ? t('chat.message.sending') : when}
            </span>
            {pinned ? <PinMark /> : null}
          </div>
        )}

        {editing ? (
          <EditBox msg={msg} surface={surface} mobile={mobile} done={() => onEdit(null)} />
        ) : msg.deleted ? (
          <div className="py-[3px] text-sm text-muted italic">{t('chat.message.deleted')}</div>
        ) : msg.unreadable ? (
          <div className="flex items-center gap-1.5 py-[3px] text-sm text-muted italic">
            <LockIcon className="size-3.5 shrink-0" />
            {t('chat.message.unreadable')}
          </div>
        ) : (
          <div className="md msg-body text-[length:var(--chat-text)] leading-[var(--chat-line)] break-words">
            {gifOnly ? null : renderContent(msg.content || '', {
              me,
              store,
              guildId: surface.guildId,
              onNavigate: (ch) => store.navigate(channelRoute(ch)),
              onOpenUser: openProfile,
            })}
            {msg.edited_at ? <span className="text-2xs text-muted"> {t('chat.message.edited')}</span> : null}
          </div>
        )}

        {msg.deleted ? null : (
          <>
            <GifEmbeds content={msg.content} />
            <PlayableLinkEmbeds content={msg.content} />
          </>
        )}

        {msg.sticker ? <Sticker sticker={msg.sticker} guildId={surface.guildId} /> : null}

        <Attachments msg={msg} base={surface.avatarBase} encrypted={surface.encrypted} />

        {surface.encrypted
          ? (msg.deleted ? null : <InviteCards urls={invitesIn(msg.content || '')} />)
          : <Embeds msg={msg} />}

        {msg.deleted ? null : (
          <AppMessage msg={msg} member={member} base={surface.avatarBase} />
        )}

        {(msg.reactions || []).length ? (
          <div className="flex flex-wrap gap-1 pt-1.5">
            {msg.reactions.map((r) => (
              <ReactionPill
                key={`${r.emoji}:${r.count}:${r.me}`}
                emoji={r.emoji}
                count={r.count}
                reacted={r.me}
                reactors={surface.reactors(r)}
                onClick={() => toggleReaction(r.emoji, r.me)}
              >
                <Emoji emoji={r.emoji} store={store} guildId={surface.guildId} />
              </ReactionPill>
            ))}
          </div>
        ) : null}

        {thread ? (
          <ContextMenu content={() => menus.thread(thread)}>
            <button
              type="button"
              onClick={() => store.navigate({ channelId: thread.id })}
              className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-xs transition-colors hover:bg-surface"
            >
              <ThreadIcon className="size-3.5 text-muted" />
              <span className="font-medium"><EmojiText>{thread.title}</EmojiText></span>
              <span className="tnum text-muted">{t('chat.message.thread.count', { count: thread.message_count })}</span>
            </button>
          </ContextMenu>
        ) : null}
      </div>

      <div
        className="reveal msg-actions popup absolute -top-3 end-4"
        data-open={reactOpen ? 'true' : undefined}
      >
        {mayReact ? (
          <>
            {quick.map((emoji) => {
              const held = Boolean((msg.reactions || []).find((r) => r.emoji === emoji)?.me);
              return (
                <IconButton
                  key={emoji}
                  title={t('chat.message.actions.quickReact', { emoji })}
                  className="popup-icon-button msg-quick size-7"
                  active={held}
                  onClick={() => toggleReaction(emoji, held)}
                >
                  <Emoji emoji={emoji} store={store} guildId={surface.guildId} />
                </IconButton>
              );
            })}
            <span className="msg-actions-rule" aria-hidden />
          </>
        ) : null}
        <IconButton
          ref={reactRef}
          title={t('chat.message.actions.react')}
          className="popup-icon-button size-7"
          active={reactOpen}
          disabled={!mayReact}
          onClick={() => setReactOpen((open) => !open)}
        >
          <EmojiIcon className="size-3.5" />
        </IconButton>
        {mayReply ? (
          <IconButton title={t('chat.message.actions.reply')} className="popup-icon-button size-7" onClick={() => onReply(msg)}>
            <ReplyIcon className="size-3.5" />
          </IconButton>
        ) : null}
        {mayEdit ? (
          <IconButton title={t('chat.message.actions.edit')} className="popup-icon-button size-7" onClick={() => onEdit(msg.id)}>
            <EditIcon className="size-3.5" />
          </IconButton>
        ) : null}
        <MenuButton
          label={t('common.a11y.menu')}
          placement="bottom end"
          className="popup-icon-button size-7"
          content={surface.menu(msg, { onReply, onEdit })}
        >
          <MoreIcon className="size-3.5" />
        </MenuButton>
        {mayPin ? (
          <IconButton
            title={t(pinned ? 'chat.message.actions.unpin' : 'chat.message.actions.pin')}
            className="popup-icon-button shift-only size-7"
            onClick={pinNow}
          >
            <PinIcon className="size-3.5" />
          </IconButton>
        ) : null}
        {mayDelete ? (
          <IconButton
            title={t('chat.message.actions.delete')}
            className="popup-icon-button shift-only size-7"
            data-tone="danger"
            onClick={deleteNow}
          >
            <TrashIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </div>

      {mobile ? null : (
        <EmojiPopover
          open={reactOpen}
          onOpenChange={setReactOpen}
          anchor={reactRef}
          guildId={surface.guildId}
          onPick={(emoji) => {
            const held = (msg.reactions || []).find((r) => r.emoji === emoji)?.me;
            toggleReaction(emoji, !!held);
          }}
        />
      )}
    </div>
  );

  if (mobile) {
    return (
      <>
        {rowContent}
        {sheetOpen && !pending ? (
          <MobileMessageActionSheet
            surface={surface}
            msg={msg}
            onClose={() => setSheetOpen(false)}
            onReply={onReply}
            onEdit={onEdit}
          />
        ) : null}
      </>
    );
  }

  return (
    <ContextMenu
      isDisabled={Boolean(editing) || pending}
      content={() => surface.menu(msg, { onReply, onEdit })}
    >
      {rowContent}
    </ContextMenu>
  );
});

function PinMark() {
  const t = useT();
  return (
    <span
      className="inline-flex shrink-0 items-center text-muted"
      title={t('chat.message.pinnedMark')}
    >
      <PinIcon className="size-3" />
      <span className="sr-only">{t('chat.message.pinnedMark')}</span>
    </span>
  );
}

function QuotedLine({ parent, surface, pinged, jump }) {
  const t = useT();
  const guildId = surface.guildId;
  const gone = parent?.deleted;
  const member = parent && !gone ? surface.memberOf(parent.author) : undefined;
  const colour = parent && !gone ? surface.colourFor(parent.author) : undefined;
  const name = parent
    ? (member?.nickname || member?.display_name || shortName(parent.author))
    : null;
  const line = (
    <>
      {parent && !gone ? (
        <>
          <Avatar size="xxs" id={parent.author} {...surface.avatarFor(parent, member)} />
          <span
            className={cn('msg-reply-name shrink-0 font-medium', colour ? 'role-ink' : 'text-foreground')}
            style={colour ? { '--role': colour } : undefined}
          >
            {pinged ? '@' : null}
            <EmojiText>{name}</EmojiText>
          </span>
          <QuotePreview
            leadKey="chat.quote.body"
            content={parent.content}
            guildId={guildId}
            className="msg-reply-text min-w-0 truncate"
          />
        </>
      ) : (
        <span className="msg-reply-text min-w-0 truncate italic">
          {t(gone ? 'chat.message.quotedDeleted' : 'chat.message.quotedOlder')}
        </span>
      )}
    </>
  );
  if (!jump) return <div className="msg-reply">{line}</div>;
  return (
    <button type="button" title={t('chat.message.jumpToQuoted')} onClick={jump} className="msg-reply">
      {line}
    </button>
  );
}

export function EditBox({ msg, surface, done, mobile = false }) {
  const t = useT();
  const store = useStore();
  const toDisplay = useCallback(
    (wire) => displayText(wire, { store, guildId: surface.guildId, me: store.me?.user_id }),
    [store, surface.guildId],
  );
  const [text, setText] = useState(() => toDisplay(msg.content || ''));
  const ref = useRef(null);
  const inkRef = useRef(null);
  const syncInkScroll = useAutosize(ref, inkRef);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const replaceSelection = (node, replacement) => {
    if (typeof document.execCommand === 'function'
      && document.execCommand('insertText', false, replacement)) return;
    const from = node.selectionStart;
    const to = node.selectionEnd;
    setText(node.value.slice(0, from) + replacement + node.value.slice(to));
  };

  const applyFromBar = useCallback((edit) => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(edit.from, edit.to);
    if (!(typeof document.execCommand === 'function'
      && document.execCommand('insertText', false, edit.text))) {
      setText(node.value.slice(0, edit.from) + edit.text + node.value.slice(edit.to));
    }
    requestAnimationFrame(() => {
      const now = ref.current;
      if (!now) return;
      now.focus({ preventScroll: true });
      now.setSelectionRange(edit.select[0], edit.select[1]);
    });
  }, []);

  const clipWire = (e, cut) => {
    const node = ref.current;
    if (!node) return;
    const selected = node.value.slice(node.selectionStart, node.selectionEnd);
    if (!hasDisplayOnly(selected)) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', wireText(selected));
    if (cut) replaceSelection(node, '');
  };

  const keepFocus = (e) => e.preventDefault();

  const save = async () => {
    let content = wireText(text).trim();
    done();
    if (mayHoldShortcode(content)) {
      await loadEmoji();
      content = expandShortcodes(content);
    }
    if (!content || content === msg.content) return;
    try { await surface.edit(msg, content); }
    catch (e) { reportError(e, t('chat.message.editFailed')); }
  };

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="edit-box">
        <MarkdownInk text={text} inkRef={inkRef} guildId={surface.guildId} />
        {!mobile ? <FormatBar textareaRef={ref} apply={applyFromBar} /> : null}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={t('chat.message.editBox.label')}
          className="composer-input composer-text"
          onScroll={syncInkScroll}
          onChange={(e) => {
            const node = e.target;
            setText(node.value);
            const closed = shortcodeBefore(node.value, node.selectionStart);
            if (closed) {
              node.setSelectionRange(closed.from, closed.to);
              replaceSelection(node, closed.unicode);
            } else if (node.value.includes(':')) loadEmoji();
          }}
          onCopy={(e) => clipWire(e, false)}
          onCut={(e) => clipWire(e, true)}
          onPaste={(e) => {
            const pasted = e.clipboardData?.getData('text/plain') || '';
            const shown = toDisplay(pasted);
            if (shown === pasted) return;
            e.preventDefault();
            replaceSelection(e.currentTarget, shown);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
              e.preventDefault();
              save();
            }
            if (e.key === 'Escape') done();
          }}
        />
      </div>
      <div className="text-2xs text-muted">
        <Trans
          k="chat.message.editBox.hint"
          components={{
            save: <button type="button" className="edit-box-link" onMouseDown={keepFocus} onClick={save} />,
            cancel: <button type="button" className="edit-box-link" onMouseDown={keepFocus} onClick={done} />,
          }}
        />
      </div>
    </div>
  );
}
