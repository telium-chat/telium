import { useEffect } from 'react';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { b64url } from '../../lib/util.js';
import { isAnimated } from '../../lib/image.js';
import { useImageCrop } from '../dialogs/CropImageDialog.jsx';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Async, EmojiIcon, EmojiText, EmptyState, FilePicker, IconButton, ImageIcon, Section,
  TrashIcon
} from '../../components/index.js';

export function ExpressionsPane({ guildId, api }) {
  const store = useStore();
  const tr = useT();
  const cropImage = useImageCrop();
  const state = useAsync(() => api.expressions(guildId), [guildId]);

  const { reload } = state;

  useEffect(() => store.on('expressions', (id) => {
    if (id === guildId) reload();
  }), [store, guildId, state]);

  const assetFrom = async (picked, preset) => {
    if (!picked) return null;
    const file = await cropImage(picked, preset);
    if (!file) return null;
    const name = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { name, data: b64url(bytes), mime: file.type, animated: isAnimated(bytes) };
  };

  const uploadEmoji = async (file) => {
    const body = await assetFrom(file, 'emoji');
    if (!body) return;
    try {
      await api.createEmoji(guildId, {
        name: body.name,
        data: body.data,
        mime: body.mime,
        animated: body.animated,
      });
      reload();
    } catch (e) { reportError(e, t('guild.expressions.emoji.addFailed')); }
  };

  const uploadSticker = async (file) => {
    const body = await assetFrom(file, 'sticker');
    if (!body) return;
    try {
      await api.createSticker(guildId, {
        name: body.name,
        data: body.data,
        mime: body.mime,
        format: body.animated ? 'gif' : 'png',
      });
      reload();
    } catch (e) { reportError(e, t('guild.expressions.stickers.addFailed')); }
  };

  return (
    <Async state={state}>
      {(resp) => (
        <>
          <Section
            title={tr('guild.expressions.emoji.title')}
            actions={(
              <FilePicker
                accept="image/*"
                label={tr('guild.expressions.emoji.add')}
                onPick={uploadEmoji}
              />
            )}
          >
            {(resp.emojis || []).length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2">
                {resp.emojis.map((emoji) => (
                  <div
                    key={emoji.id}
                    className="group relative flex flex-col items-center gap-1.5 panel px-2 py-3 transition-colors hover:bg-surface-tertiary"
                  >
                    <AnimatedImage
                      src={emoji.url}
                      alt={emoji.name}
                      animated={emoji.animated}
                      className="size-10 object-contain"
                    />
                    <span className="w-full truncate text-center font-mono text-xs text-muted">
                      {`:${emoji.name}:`}
                    </span>
                    <IconButton
                      title={tr('guild.expressions.emoji.remove', { name: emoji.name })}
                      className="reveal absolute top-1 end-1 size-6"
                      onClick={async () => {
                        try { await api.deleteEmoji(guildId, emoji.id); reload(); }
                        catch (e) { reportError(e, t('guild.expressions.removeFailed')); }
                      }}
                    >
                      <TrashIcon className="size-3.5" />
                    </IconButton>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={EmojiIcon} title={tr('guild.expressions.emoji.emptyTitle')}>
                {tr('guild.expressions.emoji.emptyBody')}
              </EmptyState>
            )}
          </Section>

          <Section
            title={tr('guild.expressions.stickers.title')}
            actions={(
              <FilePicker
                accept="image/*"
                label={tr('guild.expressions.stickers.add')}
                onPick={uploadSticker}
              />
            )}
          >
            {(resp.stickers || []).length ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(108px,1fr))] gap-2">
                {resp.stickers.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-col items-center gap-1.5 panel px-2 py-3"
                  >
                    <AnimatedImage
                      src={s.url}
                      alt={s.name}
                      animated={s.animated}
                      className="size-[72px] object-contain"
                    />
                    <span className="w-full truncate text-center text-xs text-muted">
                      <EmojiText>{s.name}</EmojiText>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState icon={ImageIcon} title={tr('guild.expressions.stickers.emptyTitle')}>
                {tr('guild.expressions.stickers.emptyBody')}
              </EmptyState>
            )}
          </Section>
        </>
      )}
    </Async>
  );
}
