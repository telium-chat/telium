import { memo, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { dateTime } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { faceOf } from '../../lib/faces.js';
import { shortName } from '../../lib/util.js';
import { PinIcon } from '../../components/index.js';
import { PinsDialog, PinsPopover } from '../dialogs/PinsDialog.jsx';

export const PinNoticeRow = memo(function PinNoticeRow({ entry, surface, mobile }) {
  const t = useT();
  const store = useStore();
  const modal = useModal();
  const [anchor, setAnchor] = useState(null);
  const dm = surface.kind === 'dm';
  const channelId = dm ? null : surface.id;
  const conversationId = dm ? surface.id : null;

  const face = entry?.by ? faceOf(store, entry.by, { guildId: surface.guildId }) : null;
  const who = face?.name || (entry?.by ? shortName(entry.by) : null);
  const text = who
    ? t('chat.timeline.pinNotice.named', { name: who })
    : t('chat.timeline.pinNotice.anonymous');

  const open = (e) => {
    if (mobile) {
      modal.open((close) => (
        <PinsDialog channelId={channelId} conversationId={conversationId} close={close} />
      ));
      return;
    }
    const ask = { channelId, conversationId, taken: false };
    store.emit('open-pins', ask);
    if (!ask.taken) setAnchor((a) => (a ? null : e.currentTarget));
  };

  return (
    <div className="flex justify-center px-2 py-1" data-pin-notice={entry?.id}>
      <span
        title={entry?.created_at ? dateTime(entry.created_at) : undefined}
        className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-secondary px-2.5 py-1 text-xs text-muted"
      >
        <PinIcon className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{text}</span>
        <button
          type="button"
          className="shrink-0 rounded-full font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-haspopup={mobile ? undefined : 'dialog'}
          onClick={open}
        >
          {t('chat.timeline.pinNotice.seeAll')}
        </button>
      </span>
      {!mobile && anchor ? (
        <PinsPopover
          channelId={channelId}
          conversationId={conversationId}
          anchor={anchor}
          close={() => setAnchor(null)}
        />
      ) : null}
    </div>
  );
});
