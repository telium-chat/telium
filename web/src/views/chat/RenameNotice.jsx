import { memo } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { dateTime } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { faceOf } from '../../lib/faces.js';
import { shortName } from '../../lib/util.js';
import { EditIcon } from '../../components/index.js';

/// A line in the timeline saying who renamed the group, kept in the group's own state so it is there for everyone who opens it later.
export const RenameNoticeRow = memo(function RenameNoticeRow({ entry }) {
  const t = useT();
  const store = useStore();
  const face = entry?.author ? faceOf(store, entry.author) : null;
  const name = face?.name || shortName(entry?.author || '');
  const text = entry?.name
    ? t('chat.timeline.renameNotice.named', { name, group: entry.name })
    : t('chat.timeline.renameNotice.cleared', { name });
  return (
    <div className="flex justify-center px-2 py-1" data-rename-notice={entry?.id}>
      <span
        title={entry?.created_at ? dateTime(entry.created_at) : undefined}
        className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-secondary px-2.5 py-1 text-xs text-muted"
      >
        <EditIcon className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{text}</span>
      </span>
    </div>
  );
});
