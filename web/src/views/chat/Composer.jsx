import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarkdownInk, useAutosize } from './MarkdownInk.jsx';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import {
  expandShortcodes, loadEmoji, mayHoldShortcode, rememberEmojiIn, shortcodeBefore,
} from '../../lib/emoji.js';
import { displayText, hasDisplayOnly, wireText } from '../../lib/mentions.js';
import { shortName } from '../../lib/util.js';
import { describeRequest } from '../../lib/failure.js';
import { defaultExpiry, expiryOptions } from '../../lib/upload.js';
import {
  AttachIcon, CloseIcon, ContextMenu, CopyIcon, CutIcon, EmojiIcon, IconButton, ImageIcon,
  LockIcon, MenuItem, MenuSeparator, Notice, PlusIcon, ReplyIcon, SendIcon,
} from '../../components/index.js';
import { useModal } from '../../hooks/useModal.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { AutocompletePopup, useAutocomplete } from './Autocomplete.jsx';
import { DropHint, StagedAttachments } from './StagedAttachments.jsx';
import { useFileDrop, useStagedFiles } from './useStaging.jsx';
import { GifPopover } from './GifPicker.jsx';
import { QuotePreview } from './QuotePreview.jsx';
import { EmojiPickerDialog } from '../dialogs/EmojiPickerDialog.jsx';
import { EmojiPopover } from './EmojiPicker.jsx';
import { GifPickerDialog } from '../dialogs/GifPickerDialog.jsx';
import { MobileActionSheet } from '../mobile/MobileNavigation.jsx';
import { FORMATS, chordFor, chordHint, formatEdit } from './formatting.js';
import { FormatBar } from './FormatBar.jsx';

function FormatMenu({ mobile, content, opensOn, children }) {
  if (mobile) return children;
  return <ContextMenu content={content} opensOn={opensOn}>{children}</ContextMenu>;
}

function focusIsSpare() {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (!active || active === document.body) return true;
  if (active.closest?.('[role="dialog"], [aria-modal="true"]')) return false;
  if (active.isContentEditable) return false;
  return !['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
}

export function Composer({ surface, replyTo, onCancelReply, onEditLast, send, mobile = false }) {
  const store = useStore();
  const t = useT();
  useStoreEvent('media-preference', 'media-registry', 'fallback');
  const modal = useModal();
  const [text, setText] = useState('');
  const toDisplay = useCallback(
    (wire) => displayText(wire, { store, guildId: surface.guildId, me: store.me?.user_id }),
    [store, surface.guildId],
  );
  const draftKey = `${surface.kind === 'dm' ? 'conversation' : 'channel'}:${surface.id}`;
  const setDraftText = useCallback((next) => {
    setText((previous) => {
      const value = typeof next === 'function' ? next(previous) : next;
      store.saveDraft(draftKey, wireText(value));
      return value;
    });
  }, [store, draftKey]);
  const staging = useStagedFiles(surface);
  const staged = staging.staged;
  const fileInputRef = useRef(null);
  const [sticker, setSticker] = useState(null);
  const [note, setNote] = useState(null);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const textareaRef = useRef(null);
  const rootRef = useRef(null);
  const gifButtonRef = useRef(null);
  const [gifOpen, setGifOpen] = useState(false);
  const emojiButtonRef = useRef(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const inkRef = useRef(null);

  const syncInkScroll = useAutosize(textareaRef, inkRef);

  const shownHeight = useRef(0);
  useLayoutEffect(() => {
    const height = rootRef.current?.offsetHeight ?? 0;
    const delta = height - shownHeight.current;
    shownHeight.current = height;
    if (delta) {
      const scroller = rootRef.current?.parentElement
        ?.querySelector(':scope > .chat-scroller');
      if (scroller) scroller.scrollTop += delta;
    }
  });

  useEffect(() => {
    setText(toDisplay(store.draftFor(draftKey)));
    staging.drop();
    setSticker(null);
    setNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, draftKey]);

  const complete = useAutocomplete({ store, surface, text, setText: setDraftText, textareaRef });

  const replaceRange = useCallback((from, to, replacement, select) => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(from, to);
    if (typeof document.execCommand === 'function'
      && document.execCommand('insertText', false, replacement)) {
      if (select) node.setSelectionRange(select[0], select[1]);
      return;
    }
    const next = node.value.slice(0, from) + replacement + node.value.slice(to);
    setDraftText(next);
    if (select) requestAnimationFrame(() => node.setSelectionRange(select[0], select[1]));
  }, [setDraftText]);

  const copyWire = useCallback((e, cut) => {
    const node = textareaRef.current;
    if (!node) return;
    const from = node.selectionStart;
    const to = node.selectionEnd;
    const selected = node.value.slice(from, to);
    if (!hasDisplayOnly(selected)) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', wireText(selected));
    if (cut) replaceRange(from, to, '');
  }, [replaceRange]);

  const applyFormat = useCallback((format, range) => {
    const node = textareaRef.current;
    if (!node) return null;
    const start = range ? range[0] : node.selectionStart;
    const end = range ? range[1] : node.selectionEnd;
    const edit = formatEdit(format, node.value, start, end);
    replaceRange(edit.from, edit.to, edit.text, edit.select);
    return edit;
  }, [replaceRange]);

  const applyFromBar = useCallback((edit) => {
    replaceRange(edit.from, edit.to, edit.text, edit.select);
  }, [replaceRange]);

  const menuRange = useRef(null);

  const wantsFormatMenu = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return false;
    const from = node.selectionStart;
    const to = node.selectionEnd;
    if (from == null || to == null || from === to) return false;
    menuRange.current = [from, to];
    return true;
  }, []);

  const applyFromMenu = useCallback((format) => {
    const edit = applyFormat(format, menuRange.current);
    if (!edit) return;
    menuRange.current = edit.select;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      node.setSelectionRange(edit.select[0], edit.select[1]);
    });
  }, [applyFormat]);

  const clip = useCallback((cut) => {
    const node = textareaRef.current;
    const range = menuRange.current;
    if (!node || !range || range[0] === range[1]) return;
    const [from, to] = range;
    node.focus({ preventScroll: true });
    node.setSelectionRange(from, to);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    if (!copied) {
      navigator.clipboard?.writeText(wireText(node.value.slice(from, to)))?.catch(() => {});
    }
    if (cut) replaceRange(from, to, '', [from, from]);
  }, [replaceRange]);

  const formatMenu = useCallback(() => (
    <>
      {FORMATS.map((format) => (
        <MenuItem
          key={format.id}
          icon={format.icon}
          hint={chordHint(format)}
          onAction={() => applyFromMenu(format)}
        >
          {t(format.labelKey)}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => clip(false)}>{t('chat.composer.copy')}</MenuItem>
      <MenuItem icon={CutIcon} onAction={() => clip(true)}>{t('chat.composer.cut')}</MenuItem>
    </>
  ), [applyFromMenu, clip, t]);

  useEffect(() => store.on('compose', (fragment) => {
    const shown = toDisplay(fragment);
    setDraftText((prev) => (prev && !prev.endsWith(' ') ? `${prev} ${shown} ` : `${prev}${shown} `));
    textareaRef.current?.focus();
  }), [store, setDraftText, toDisplay]);

  const replyToId = replyTo?.id ?? null;
  useEffect(() => {
    if (!replyToId) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, [replyToId]);

  const focusedFor = useRef(null);
  useEffect(() => {
    if (mobile) return;
    const node = textareaRef.current;
    if (!node) return;
    if (focusedFor.current === draftKey) return;
    if (text !== toDisplay(store.draftFor(draftKey))) return;
    focusedFor.current = draftKey;
    if (!focusIsSpare()) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, [draftKey, text, store, mobile, surface.sendBlock]);

  const expiries = useMemo(() => expiryOptions(surface.expiryCap), [surface.expiryCap, t]);
  const [expiry, setExpiry] = useState(undefined);
  const chosen = expiries.some((o) => o.secs === expiry) ? expiry : defaultExpiry(expiries);
  const [externalHost, setExternalHost] = useState(null);
  const host = surface.mediaTier === 3
    ? (surface.externalHosts.find((h) => h.id === externalHost) || surface.externalHosts[0] || null)
    : null;
  const attachBlock = !surface.mayAttach
    ? t('chat.composer.attachBlocked')
    : (surface.mediaTier === 3 && !surface.externalHosts.length
      ? t('chat.composer.noUploadHosts')
      : null);

  const submit = async () => {
    let content = wireText(text).trim();
    if (mayHoldShortcode(content)) {
      await loadEmoji();
      content = expandShortcodes(content);
    }
    if (!content && !staged.length && !sticker) return;
    const attachments = staged;
    const held = staging.items.filter((item) => item.att);
    const sent = sticker;
    surface.typing(false);
    setDraftText('');
    staging.clear();
    setSticker(null);
    setNote(null);
    const body = { content, attachments };
    if (sent) body.sticker = sent;
    if (replyTo) body.reply_to = replyTo.id;
    onCancelReply();

    try {
      const resp = await send(body, content);
      staging.release(held);
      rememberEmojiIn(store.sync, content);
      if (resp?.held) {
        setNote({
          text: t('chat.composer.heldForReview'),
          error: false,
        });
      }
    } catch (e) {
      setNote({ text: describeRequest(e, navigator.onLine !== false), error: true });
      setDraftText(toDisplay(content));
      staging.restore(held);
      setSticker(sent);
    }
  };

  const attach = useCallback((files) => {
    if (attachBlock) return;
    staging.add(files, { ttlSecs: chosen, externalHost: host });
  }, [staging, attachBlock, chosen, host]);

  const pickFiles = useCallback(() => fileInputRef.current?.click(), []);

  const dragging = useFileDrop({
    active: !attachBlock && !surface.sendBlock && !modal.stack.length,
    onFiles: attach,
  });

  const sendGif = async (gifUrl) => {
    const body = { content: gifUrl, attachments: [] };
    if (replyTo) body.reply_to = replyTo.id;
    try {
      await send(body, gifUrl);
      onCancelReply();
    } catch (e) {
      setNote({ text: e?.body?.message || e.message, error: true });
      throw e;
    }
  };

  const canSend = Boolean(text.trim() || staged.length || sticker);

  if (surface.sendBlock) {
    return (
      <div className={mobile ? 'shrink-0 px-4 pb-4' : 'shrink-0 px-4 pb-6'}>
        <Notice tone="warn">
          <span className="inline-flex items-center gap-1.5">
            <LockIcon className="size-3.5 shrink-0" />
            {surface.sendBlock}
          </span>
        </Notice>
      </div>
    );
  }

  const insert = (emoji) => {
    const node = textareaRef.current;
    const at = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? at;
    const shown = toDisplay(emoji);
    replaceRange(at, end, shown, [at + shown.length, at + shown.length]);
  };

  return (
    <div
      ref={rootRef}
      className="shrink-0 px-4"
      style={{ paddingBottom: mobile ? 'max(1rem, var(--safe-area-bottom))' : 'max(1.5rem, var(--safe-area-bottom))' }}
    >
      {dragging ? <DropHint where={surface.dropTarget} /> : null}

      <div className="composer-box">
        <AutocompletePopup
          items={complete.items}
          index={complete.index}
          searching={complete.searching}
          onPick={complete.accept}
          onHover={complete.setIndex}
        />
        {replyTo ? (
          <div className="composer-strip">
            <ReplyIcon className="size-3.5 shrink-0 -scale-x-100" />
            <QuotePreview
              leadKey="chat.quote.replyingTo"
              name={shortName(replyTo.author)}
              content={replyTo.content}
              guildId={surface.guildId}
              className="min-w-0 flex-1 truncate"
            />
            <IconButton title={t('chat.composer.cancelReply')} className="size-6 rounded-row" onClick={onCancelReply}>
              <CloseIcon className="size-3" />
            </IconButton>
          </div>
        ) : null}

        <StagedAttachments
          items={staging.items}
          sticker={sticker}
          onRemove={staging.remove}
          onRename={staging.rename}
          onRetry={staging.retry}
          onRemoveSticker={() => setSticker(null)}
          expiries={expiries}
          expiry={chosen}
          onExpiryChange={setExpiry}
          tier={surface.mediaTier}
          externalHosts={surface.externalHosts}
          externalHost={host?.id || null}
          onExternalHostChange={setExternalHost}
        />

        <div className="composer-row">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => {
              const files = [...e.target.files];
              e.target.value = '';
              attach(files);
            }}
          />
          <IconButton
            className="composer-control"
            title={mobile ? t('chat.composer.moreActions') : (attachBlock || t('chat.composer.attach'))}
            disabled={!mobile && Boolean(attachBlock)}
            onClick={() => (mobile ? setMobileActionsOpen(true) : pickFiles())}
          >
            {mobile ? <PlusIcon /> : <AttachIcon />}
          </IconButton>
          <FormatMenu mobile={mobile} content={formatMenu} opensOn={wantsFormatMenu}>
            <div className="composer-field">
              <MarkdownInk text={text} inkRef={inkRef} guildId={surface.guildId} />
              {!mobile ? <FormatBar textareaRef={textareaRef} apply={applyFromBar} /> : null}
              <textarea
                ref={textareaRef}
                rows={1}
                value={text}
                placeholder={surface.placeholder}
                className="composer-input composer-text"
                onScroll={syncInkScroll}
                onBlur={() => surface.typing(false)}
                onChange={(e) => {
                  setDraftText(e.target.value);
                  complete.sync(e.target);
                  const closed = shortcodeBefore(e.target.value, e.target.selectionStart);
                  if (closed) replaceRange(closed.from, closed.to, closed.unicode);
                  else if (e.target.value.includes(':')) loadEmoji();
                  surface.typing(Boolean(e.target.value));
                }}
                onPaste={(e) => {
                  const files = [...(e.clipboardData?.files || [])];
                  if (files.length && surface.mayAttach) {
                    e.preventDefault();
                    attach(files);
                    return;
                  }
                  const pasted = e.clipboardData?.getData('text/plain') || '';
                  const shown = toDisplay(pasted);
                  if (shown === pasted) return;
                  e.preventDefault();
                  replaceRange(e.currentTarget.selectionStart, e.currentTarget.selectionEnd, shown);
                }}
                onCopy={(e) => copyWire(e, false)}
                onCut={(e) => copyWire(e, true)}
                onKeyUp={(e) => complete.sync(e.target)}
                onClick={(e) => complete.sync(e.target)}
                onKeyDown={(e) => {
                  if (complete.onKeyDown(e)) return;
                  const chord = chordFor(e);
                  if (chord) {
                    e.preventDefault();
                    applyFormat(chord);
                    return;
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                  if (e.key === 'Escape' && replyTo) onCancelReply();
                  if (e.key === 'ArrowUp' && !text) {
                    e.preventDefault();
                    onEditLast();
                  }
                }}
              />
            </div>
          </FormatMenu>
          {!mobile ? (
            <IconButton
              ref={gifButtonRef}
              className="composer-control"
              title={t('chat.composer.gif')}
              active={gifOpen}
              onClick={() => setGifOpen((open) => !open)}
            >
              <span className="text-xs font-bold tracking-tight">{t('chat.composer.gif')}</span>
            </IconButton>
          ) : null}
          <IconButton
            ref={emojiButtonRef}
            className="composer-control"
            title={t('chat.composer.emoji')}
            active={emojiOpen}
            onClick={() => {
              if (!mobile) { setEmojiOpen((open) => !open); return; }
              modal.open((close) => (
                <EmojiPickerDialog
                  guildId={surface.guildId}
                  close={close}
                  onPick={insert}
                  onPickSticker={surface.stickers ? setSticker : undefined}
                />
              ), { wide: true, desktopSize: 'emoji' });
            }}
          >
            <EmojiIcon />
          </IconButton>
          <IconButton
            className="composer-control"
            title={t('chat.composer.send')}
            onClick={submit}
            data-send-ready={canSend ? 'true' : undefined}
          >
            <SendIcon />
          </IconButton>
        </div>
      </div>

      {!mobile ? (
        <GifPopover
          open={gifOpen}
          onOpenChange={setGifOpen}
          anchor={gifButtonRef}
          onPick={sendGif}
          encrypted={surface.kind === 'dm'}
          onClosed={() => textareaRef.current?.focus()}
        />
      ) : null}

      {!mobile ? (
        <EmojiPopover
          open={emojiOpen}
          onOpenChange={setEmojiOpen}
          anchor={emojiButtonRef}
          guildId={surface.guildId}
          onPick={insert}
          onPickSticker={surface.stickers ? setSticker : undefined}
          onClosed={() => textareaRef.current?.focus()}
        />
      ) : null}

      {note ? (
        <p className={`px-1 pt-1.5 text-xs ${note.error ? 'text-danger' : 'text-muted'}`}>
          {note.text}
        </p>
      ) : null}

      {mobileActionsOpen ? (
        <MobileActionSheet title={t('chat.composer.actionSheet')} onClose={() => setMobileActionsOpen(false)}>
          <MenuItem
            icon={AttachIcon}
            isDisabled={Boolean(attachBlock)}
            onAction={pickFiles}
          >
            {t('chat.composer.attach')}
          </MenuItem>
          <MenuItem
            icon={ImageIcon}
            onAction={() => modal.open((close) => (
              <GifPickerDialog
                close={close}
                onPick={sendGif}
                encrypted={surface.kind === 'dm'}
              />
            ), { wide: true })}
          >
            {t('chat.composer.gif')}
          </MenuItem>
        </MobileActionSheet>
      ) : null}
    </div>
  );
}
