import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { bytes, relative } from '../../lib/util.js';
import { fetchEncrypted } from '../../lib/upload.js';
import { saveObjectUrl } from '../../lib/download.js';
import { gofilePlaybackUrl, isGofileDownloadUrl } from '../../lib/external-media.js';
import { isAndroid, isTauriRuntime, openExternal } from '../../lib/platform.js';
import { AttachIcon, EmojiText, LockIcon } from '../../components/index.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { ImagePreview } from './ImagePreview.jsx';
import { isGofileAttachment, playableKind, PlayableAttachment } from './PlayableAttachment.jsx';

const opened = new Map();

const GOFILE = 'Gofile';

function open(store, att) {
  const key = att.ref || att.hash;
  if (!opened.has(key)) {
    opened.set(key, fetchEncrypted(store.home.base, att)
      .then((blob) => URL.createObjectURL(blob))
      .catch((e) => { opened.delete(key); throw e; }));
  }
  return opened.get(key);
}

function useNativeSave() {
  return isAndroid && isTauriRuntime();
}

async function saveTo(att, url) {
  try {
    const saved = await saveObjectUrl(
      url,
      att.name || att.filename || att.ref || 'attachment',
      att.mime || 'application/octet-stream',
    );
    const name = att.name || att.filename;
    if (saved) {
      toast(name
        ? t('chat.attachment.saved', { name })
        : t('chat.attachment.savedUnnamed'));
    }
  } catch (error) {
    reportError(error, t('chat.attachment.saveFailed'));
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return t('chat.attachment.unknownHost'); }
}

export function Attachments({ msg, base, encrypted }) {
  const list = msg.attachments || [];
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap gap-2 pt-1.5">
      {list.map((att, i) => (encrypted
        ? <SealedAttachment key={att.ref || i} att={att} />
        : <PlainAttachment key={att.ref || i} att={att} base={base} />
      ))}
    </div>
  );
}

/// An attachment's remaining life, for files the origin will sweep. Null
/// means the origin keeps it — there is nothing to count down.
export function ExpiryNote({ att, now = Date.now() }) {
  const tr = useT();
  const at = att.expires_at;
  if (at == null) return null;
  if (at <= now) {
    return <span className="text-2xs text-muted">{tr('chat.attachment.expired')}</span>;
  }
  return (
    <span className="text-2xs text-muted">{tr('chat.attachment.expiresIn', { when: relative(at) })}</span>
  );
}

function shapeOf(att) {
  if (playableKind(att)) return 'playable';
  if ((att.mime || '').startsWith('image/')) return 'image';
  return 'file';
}

function Media({
  att, url, host, save, shape, fallbackUrl = null, onOpenOriginal = null,
}) {
  if (shape === 'playable') {
    return (
      <PlayableAttachment
        att={att}
        url={url}
        host={host}
        onSave={save}
        fallbackUrl={fallbackUrl}
        onOpenOriginal={onOpenOriginal}
      />
    );
  }
  if (shape === 'image') {
    return (
      <div className="flex max-w-full flex-col gap-0.5">
        <ImagePreview
          src={url}
          alt={att.name}
          href={fallbackUrl || url}
          onSave={save}
          onOpenOriginal={onOpenOriginal}
          animated={att.mime ? /^image\/(?:gif|webp)$/i.test(att.mime) : null}
          className="overflow-hidden rounded-xl border border-border"
          imageClassName="max-h-[320px] object-contain"
        />
        {host ? <span className="px-1 text-2xs text-muted">{`Hosted on ${host}`}</span> : null}
        <ExpiryNote att={att} />
      </div>
    );
  }
  return null;
}


function PlainAttachment({ att, base }) {
  const tr = useT();
  const store = useStore();
  const url = att.url || `${base || ''}/_telium/v1/media/${att.ref || att.hash}`;
  const host = att.origin || hostOf(url);
  const gofile = isGofileAttachment(att, url) && isGofileDownloadUrl(url);
  const native = useNativeSave();
  const tauri = isTauriRuntime();
  const [deliveryUrl, setDeliveryUrl] = useState(gofile ? null : url);

  useEffect(() => {
    let live = true;
    if (!gofile) {
      setDeliveryUrl(url);
      return () => { live = false; };
    }

    if (!tauri && store.gofilePlaybackProxy === false) {
      setDeliveryUrl(false);
      return () => { live = false; };
    }

    setDeliveryUrl(null);
    gofilePlaybackUrl(store.home, url)
      .then((playback) => { if (live) setDeliveryUrl(playback); })
      .catch(() => { if (live) setDeliveryUrl(false); });
    return () => { live = false; };
  }, [gofile, url, store.home, store.gofilePlaybackProxy, tauri]);

  const shape = shapeOf(att);
  const readyUrl = gofile ? (deliveryUrl || null) : url;
  const save = native && readyUrl && !gofile ? () => saveTo(att, readyUrl) : null;
  const openProvider = tauri && gofile
    ? async () => {
      try {
        await openExternal(url);
      } catch (error) {
        reportError(error, tr('chat.attachment.openProviderFailed', { provider: GOFILE }));
      }
    }
    : null;

  // WebViews cache the failed request; wait for the cookie-aware bridge.
  if (gofile && !readyUrl && shape !== 'file') {
    return (
      <FileChip
        href={deliveryUrl === false && !tauri ? url : undefined}
        onClick={deliveryUrl === false ? openProvider || undefined : undefined}
        name={att.name || att.ref}
        size={att.size}
        note={deliveryUrl === false
          ? tr('chat.attachment.openOnProvider', { provider: GOFILE })
          : tr('chat.attachment.preparing')}
      />
    );
  }

  if (shape !== 'file') {
    return (
      <Media
        att={att}
        url={readyUrl || url}
        host={host}
        save={save}
        shape={shape}
        fallbackUrl={gofile ? url : null}
        onOpenOriginal={openProvider}
      />
    );
  }

  const fileUrl = readyUrl || (deliveryUrl === false ? url : null);
  return (
    <div className="flex max-w-full flex-col gap-0.5">
      <FileChip
        href={!native && fileUrl ? fileUrl : undefined}
        download={!native && gofile && fileUrl ? (att.name || att.ref || 'attachment') : undefined}
        onClick={save || openProvider || undefined}
        name={att.name || att.ref}
        size={att.size}
        note={
          openProvider
            ? tr('chat.attachment.openOnProvider', { provider: GOFILE })
            : native
              ? (fileUrl ? tr('chat.attachment.save') : tr('chat.attachment.preparing'))
              : (gofile && !fileUrl ? tr('chat.attachment.preparing') : host)
        }
      />
      <ExpiryNote att={att} />
    </div>
  );
}

export function SealedAttachment({ att }) {
  const tr = useT();
  const store = useStore();
  const [href, setHref] = useState(null);
  const image = (att.mime || '').startsWith('image/');
  const native = useNativeSave();
  const shape = shapeOf(att);

  useEffect(() => {
    let live = true;
    open(store, att)
      .then((url) => { if (live) setHref(url); })
      .catch(() => { if (live) setHref(false); });
    return () => { live = false; };
  }, [store, att.ref || att.hash]);

  if (href === false) {
    return (
      <div className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm text-muted">
        <LockIcon className="size-3.5 shrink-0" />
        <EmojiText>
          {att.name
            ? tr('chat.attachment.decryptFailed', { name: att.name })
            : tr('chat.attachment.decryptFailedUnnamed')}
        </EmojiText>
      </div>
    );
  }

  if (href && shape !== 'file') {
    return (
      <Media
        att={att}
        url={href}
        host={null}
        save={native ? () => saveTo(att, href) : null}
        shape={shape}
      />
    );
  }

  if (image) {
    return <div className="h-[120px] w-[180px] animate-pulse rounded-xl bg-foreground/6" />;
  }

  return (
    <div className="flex max-w-full flex-col gap-0.5">
      <FileChip
        href={href && !native ? href : undefined}
        onClick={href && native ? () => saveTo(att, href) : undefined}
        download={href && !native ? (att.name || undefined) : undefined}
        name={att.name}
        size={href ? att.size : null}
        note={href ? (native ? tr('chat.attachment.save') : null) : tr('chat.attachment.decrypting')}
      />
      <ExpiryNote att={att} />
    </div>
  );
}

function FileChip({ href, download, name, size, note, onClick }) {
  const tr = useT();
  const inside = (
    <>
      <AttachIcon className="size-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{name || tr('chat.attachment.unnamed')}</span>
      {note ? <span className="shrink-0 text-xs text-muted">{note}</span> : null}
      {size ? <span className="tnum shrink-0 text-xs text-muted">{bytes(size)}</span> : null}
    </>
  );

  const chip = 'flex min-h-11 min-w-[220px] max-w-full items-center gap-2 rounded-xl'
    + ' border border-border px-3 py-2 text-start text-sm transition-colors hover:bg-foreground/6';

  if (onClick) {
    return <button type="button" onClick={onClick} className={`${chip} active:bg-foreground/12`}>{inside}</button>;
  }
  return (
    <a
      href={href}
      download={download}
      target={download ? undefined : '_blank'}
      rel="noreferrer noopener"
      className={chip}
    >
      {inside}
    </a>
  );
}
