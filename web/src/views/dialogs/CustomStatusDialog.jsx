import { useState } from 'react';
import { cn } from '../../lib/cn.js';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { MAX_CUSTOM_STATUS } from '../../lib/gateway.js';
import { splitStatus } from '../../lib/util.js';
import {
  Button, EmojiIcon, EmojiText, Hint, IconButton, ModalShell, StatusText, Switch, TextInput,
} from '../../components/index.js';
import { Advanced } from '../user-settings/RecoveryParts.jsx';
import { EmojiPickerDialog } from './EmojiPickerDialog.jsx';

const PRESETS = [
  '🎮 Gaming', '💻 Working', '🌴 Vacationing', '😴 Sleeping', '📚 Reading', '🧑‍🍳 Cooking',
];

const COUNT_FROM = MAX_CUSTOM_STATUS - 20;

export function CustomStatusDialog({ close }) {
  const store = useStore();
  useStoreEvent('prefs');
  const modal = useModal();
  const saved = splitStatus(store.prefs.status?.text);
  const [emoji, setEmoji] = useState(saved.emoji);
  const [text, setText] = useState(saved.text);
  const draft = (emoji ? `${emoji} ${text}` : text).trim();
  const hasStatus = !!(store.prefs.status?.text || '').trim();
  const share = (store.prefs.shareStatus ?? store.prefs.shareActivity) !== false;

  const hidden = store.prefs.statusHidden || store.prefs.activityHidden || {};
  const quiet = [...store.guilds.values()].filter((g) => hidden[g.id]);

  const save = () => {
    store.setPresence({ text: draft });
    close();
  };

  const pickEmoji = () => modal.open(
    (c) => <EmojiPickerDialog close={c} onPick={setEmoji} />,
    { wide: true, desktopSize: 'emoji' },
  );

  return (
    <ModalShell
      title="Custom status"
      footerClassName="-mt-2 pt-4"
      footer={(
        <div className="flex w-full items-center gap-2">
          {hasStatus ? (
            <Button
              variant="ghost"
              className="me-auto"
              onClick={() => { store.setPresence({ text: '' }); close(); }}
            >
              Clear
            </Button>
          ) : null}
          <Button variant="ghost" className={hasStatus ? '' : 'ms-auto'} onClick={close}>Cancel</Button>
          <Button variant="primary" isDisabled={!draft} onClick={save}>Save</Button>
        </div>
      )}
    >
      <div className="flex items-center gap-2">
        <div className="relative shrink-0">
          <IconButton title={emoji ? 'Change emoji' : 'Add emoji'} onClick={pickEmoji}>
            {emoji
              ? <StatusText store={store} className="[&_.emoji]:size-[1.25em] [&_.emoji]:align-[-0.3em]">{emoji}</StatusText>
              : <EmojiIcon />}
          </IconButton>
          {emoji ? (
            <button
              type="button"
              aria-label="Remove emoji"
              onClick={() => setEmoji('')}
              className={cn(
                'absolute -top-1 -end-1 grid size-4 place-items-center rounded-full',
                'bg-surface-tertiary text-[0.625rem] leading-none text-muted',
                'transition-colors hover:text-foreground',
              )}
            >
              ×
            </button>
          ) : null}
        </div>
        <TextInput
          aria-label="Status"
          autoFocus
          value={text}
          maxLength={MAX_CUSTOM_STATUS}
          placeholder="What's happening?"
          className="flex-1"
          endContent={(
            <span
              aria-hidden={text.length <= COUNT_FROM}
              className={cn(
                'text-xs tabular-nums text-muted',
                text.length <= COUNT_FROM && 'invisible',
              )}
            >
              {MAX_CUSTOM_STATUS - text.length}
            </span>
          )}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && draft) save(); }}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => {
          const parts = splitStatus(p);
          const picked = emoji === parts.emoji && text === parts.text;
          return (
            <button
              key={p}
              type="button"
              onClick={() => { setEmoji(parts.emoji); setText(parts.text); }}
              className={cn(
                'min-h-10 rounded-full border border-border px-3 py-2 text-sm text-muted transition-colors sm:min-h-0 sm:px-2.5 sm:py-1',
                'hover:border-accent hover:text-foreground',
                picked && 'border-accent text-foreground',
              )}
            >
              <EmojiText>{p}</EmojiText>
            </button>
          );
        })}
      </div>

      <Advanced label="Who sees it">
        <Switch
          label="Share with my servers"
          hint="Off tells every server only the dot."
          checked={share}
          onChange={(next) => store.setPresence({ share: next })}
        />
        <Switch
          label="Keep it while offline"
          checked={!!store.prefs.showCustomStatusOffline}
          onChange={(next) => store.setShowCustomStatusOffline(next)}
        />
        {quiet.length ? (
          <Hint>{`Already hidden from ${quiet.map((g) => g.name).join(', ')}.`}</Hint>
        ) : null}
      </Advanced>
    </ModalShell>
  );
}
