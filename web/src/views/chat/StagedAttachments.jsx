import { FileArchive, FileAudio, FileCode, FileText, FileVideo } from 'lucide-react';
import { bytes } from '../../lib/util.js';
import { useModal } from '../../hooks/useModal.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import {
  AttachIcon, ClockIcon, CloseIcon, EditIcon, EmojiText, GlobeIcon, IconButton,
  ImageIcon, MenuButton, MenuItem, PromptDialog, TrashIcon, VisibilityIcon,
} from '../../components/index.js';

const GLYPHS = [
  [/^image\//, ImageIcon],
  [/^video\//, FileVideo],
  [/^audio\//, FileAudio],
  [/(zip|tar|gzip|compressed|7z|rar)/, FileArchive],
  [/(javascript|json|xml|html|css|typescript|x-sh|x-python|x-c)/, FileCode],
  [/^text\//, FileText],
];

function glyphFor(mime = '', name = '') {
  for (const [pattern, Glyph] of GLYPHS) if (pattern.test(mime)) return Glyph;
  if (/\.(zip|tar|gz|tgz|7z|rar)$/i.test(name)) return FileArchive;
  if (/\.(js|jsx|ts|tsx|py|rs|go|rb|sh|css|html|json|toml|yml|yaml)$/i.test(name)) return FileCode;
  return FileText;
}

export function StagedAttachments({
  items = [], sticker = null, onRemove, onRemoveSticker, onRename,
  expiries = [], expiry, onExpiryChange,
  tier = 1, externalHosts = [], externalHost = null, onExternalHostChange,
}) {
  const t = useT();
  if (!items.length && !sticker) return null;
  return (
    <div className="upload-tray">
      <div className="upload-cards">
        {sticker ? (
          <span className="composer-chip">
            <ImageIcon className="size-3 text-muted" />
            <span className="max-w-[180px] truncate"><EmojiText>{sticker.name}</EmojiText></span>
            <IconButton title={t('chat.staged.removeSticker')} className="size-5 rounded-row" onClick={onRemoveSticker}>
              <CloseIcon className="size-3" />
            </IconButton>
          </span>
        ) : null}
        {items.map((item) => (
          <AttachmentCard
            key={item.key}
            item={item}
            onRemove={() => onRemove(item.key)}
            onRename={(name) => onRename(item.key, name)}
          />
        ))}
      </div>
      {items.length ? (
        <div className="upload-options">
          {tier === 3 ? (
            <HostChip
              hosts={externalHosts}
              chosen={externalHost}
              onChange={onExternalHostChange}
            />
          ) : (
            <ExpiryChip expiries={expiries} chosen={expiry} onChange={onExpiryChange} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentCard({ item, onRemove, onRename }) {
  const modal = useModal();
  const t = useT();
  const image = item.preview && item.mime.startsWith('image/');
  const media = Boolean(item.preview);
  const Glyph = glyphFor(item.mime, item.name);

  const preview = () => modal.open(
    (close) => <StagedPreview item={item} close={close} />,
    { fullscreen: true, backdrop: 'transparent' },
  );

  const rename = () => modal.open((close) => (
    <PromptDialog
      title={t('chat.staged.renameTitle')}
      label={t('chat.staged.renameLabel')}
      value={item.name}
      confirmLabel={t('chat.staged.renameConfirm')}
      onSubmit={onRename}
      close={close}
    />
  ));

  const Body = media ? 'button' : 'div';
  return (
    <div className="upload-card" data-status={item.status}>
      <Body
        {...(media
          ? { type: 'button', onClick: preview, 'aria-label': t('chat.staged.previewOf', { name: item.name }) }
          : {})}
        className="upload-card-body"
        data-zoom={media ? 'true' : undefined}
      >
        {image ? (
          <img className="upload-card-image" src={item.preview} alt={item.name} />
        ) : item.preview ? (
          <video className="upload-card-image" src={item.preview} muted playsInline preload="metadata" />
        ) : (
          <Glyph className="size-8" strokeWidth={1.5} aria-hidden />
        )}
      </Body>

      <div className="upload-card-foot">
        <span className="upload-card-name" title={item.name}><EmojiText>{item.name}</EmojiText></span>
        {image ? null : <span className="upload-card-size">{bytes(item.size)}</span>}
      </div>

      <div className="popup upload-card-actions">
        {media ? (
          <button
            type="button"
            className="popup-icon-button"
            title={t('chat.staged.preview')}
            aria-label={t('chat.staged.previewOf', { name: item.name })}
            onClick={preview}
          >
            <VisibilityIcon className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          className="popup-icon-button"
          title={t('chat.staged.rename')}
          aria-label={t('chat.staged.renameOf', { name: item.name })}
          onClick={rename}
        >
          <EditIcon className="size-3.5" />
        </button>
        <button
          type="button"
          className="popup-icon-button"
          data-tone="danger"
          title={t(item.status === 'uploading' ? 'chat.staged.cancelUpload' : 'chat.staged.remove')}
          aria-label={t(item.status === 'uploading'
            ? 'chat.staged.cancelUploadOf'
            : 'chat.staged.removeOf', { name: item.name })}
          onClick={onRemove}
        >
          <TrashIcon className="size-3.5" />
        </button>
      </div>

      {item.status === 'uploading' ? (
        <div
          className="upload-card-progress"
          role="progressbar"
          aria-label={t('chat.staged.uploadingOf', { name: item.name })}
          aria-valuenow={item.progress}
          style={{ '--progress': `${item.progress}%` }}
        />
      ) : null}

      {item.status === 'error' && item.error ? (
        <span className="upload-card-error" role="alert">{item.error}</span>
      ) : null}
    </div>
  );
}

function StagedPreview({ item, close }) {
  const t = useT();
  const video = item.mime.startsWith('video/');
  return (
    <div
      role="document"
      onClick={close}
      className="relative flex h-full w-full items-center justify-center bg-black/45 p-6 backdrop-blur-[2px]"
    >
      <IconButton
        title={t('chat.staged.closePreview')}
        onClick={close}
        className="absolute z-10 size-11 rounded-xl bg-white/10 text-white hover:bg-white/20"
        style={{
          top: 'max(1rem, var(--safe-area-top))',
          insetInlineEnd: 'max(1rem, var(--safe-area-end))',
        }}
      >
        <CloseIcon className="size-5" />
      </IconButton>
      {video ? (
        <video
          src={item.preview}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded-xl"
        />
      ) : (
        <img
          src={item.preview}
          alt={item.name}
          className="max-h-full max-w-full rounded-xl object-contain"
        />
      )}
    </div>
  );
}

function ExpiryChip({ expiries, chosen, onChange }) {
  const t = useT();
  const current = expiries.find((o) => o.secs === chosen) || expiries[expiries.length - 1];
  const clamped = expiries.length > 0 && !expiries.some((o) => o.secs === null);
  const cap = expiries.reduce(
    (max, o) => (o.secs !== null && (max === null || o.secs > max) ? o.secs : max),
    null,
  );

  return (
    <MenuButton
      className="upload-chip"
      label={t('chat.staged.keepFor')}
      placement="top start"
      content={(
        <>
          {expiries.map((option) => (
            <MenuItem
              key={option.secs === null ? 'never' : option.secs}
              data-selected={option.secs === current?.secs ? '' : undefined}
              onAction={() => onChange?.(option.secs)}
            >
              {option.secs === null
                ? t('chat.staged.keepsForever')
                : t('chat.staged.expiresIn', { duration: option.label })}
            </MenuItem>
          ))}
          {clamped && cap !== null ? (
            <p className="upload-note">
              {t('chat.staged.cappedNote', { duration: describeCap(t, cap) })}
            </p>
          ) : null}
        </>
      )}
    >
      <ClockIcon className="size-3.5" />
      <span>
        {current?.secs === null
          ? t('chat.staged.keepsForever')
          : t('chat.staged.expiresIn', { duration: current?.label })}
      </span>
    </MenuButton>
  );
}

function HostChip({ hosts, chosen, onChange }) {
  const t = useT();
  const current = hosts.find((h) => h.id === chosen) || hosts[0] || null;
  if (!current) {
    return (
      <span className="upload-chip" data-tone="warn">
        <GlobeIcon className="size-3.5" />
        <span>{t('chat.staged.noHosts')}</span>
      </span>
    );
  }
  return (
    <MenuButton
      className="upload-chip"
      label={t('chat.staged.uploadHost')}
      placement="top start"
      content={(
        <>
          {hosts.map((host) => (
            <MenuItem
              key={host.id}
              data-selected={host.id === current.id ? '' : undefined}
              onAction={() => onChange?.(host.id)}
            >
              {t('chat.staged.hostOption', { name: host.name || host.id, domain: host.domain })}
            </MenuItem>
          ))}
          <p className="upload-note">
            {current.description || t('chat.staged.hostPolicy')}
            {' '}
            {t('chat.staged.hostPublic')}
          </p>
        </>
      )}
    >
      <GlobeIcon className="size-3.5" />
      <span>{current.name || current.domain}</span>
    </MenuButton>
  );
}

export function DropHint({ where }) {
  const t = useT();
  return (
    <div className="upload-drop">
      <div className="upload-drop-inner">
        <div className="upload-drop-glyph">
          <AttachIcon className="size-6" />
        </div>
        <p className="upload-drop-title">{where || t('chat.staged.dropTargetFallback')}</p>
        <p className="upload-drop-line">{t('chat.staged.dropLine')}</p>
      </div>
    </div>
  );
}

function describeCap(t, secs) {
  if (secs % 86400 === 0) return t('chat.staged.capDays', { count: secs / 86400 });
  if (secs % 3600 === 0) return t('chat.staged.capHours', { count: secs / 3600 });
  return t('chat.staged.capMinutes', { count: Math.max(1, Math.round(secs / 60)) });
}
