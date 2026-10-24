import { dayOf, timeOf } from '../../lib/util.js';
import { BellIcon, BellOffIcon, MenuItem, MenuSub } from '../../components/index.js';

export const subLabel = (Glyph, text) => (
  <span className="flex min-w-0 items-center gap-2">
    <Glyph className="size-4 shrink-0 opacity-80" />
    <span className="truncate">{text}</span>
  </span>
);

const MUTE_DURATIONS = [
  { label: 'For 15 minutes', ms: 15 * 60_000 },
  { label: 'For 1 hour', ms: 60 * 60_000 },
  { label: 'For 3 hours', ms: 3 * 60 * 60_000 },
  { label: 'For 8 hours', ms: 8 * 60 * 60_000 },
  { label: 'For 24 hours', ms: 24 * 60 * 60_000 },
  { label: 'Until I turn it back on', ms: null },
];

const muteUntilLabel = (at) => (
  new Date(at).toDateString() === new Date().toDateString()
    ? timeOf(at)
    : `${dayOf(at)}, ${timeOf(at)}`
);

export const muteItems = (env, id, noun) => {
  const { store } = env;
  const until = store.prefs.muted?.[id];
  if (store.isMuted(id)) {
    return (
      <MenuItem icon={BellIcon} onAction={() => store.setMuted(id, null)}>
        {until === true ? `Unmute ${noun}` : `Unmute ${noun} — muted until ${muteUntilLabel(until)}`}
      </MenuItem>
    );
  }
  return (
    <MenuSub label={subLabel(BellOffIcon, `Mute ${noun}`)}>
      {MUTE_DURATIONS.map(({ label, ms }) => (
        <MenuItem
          key={label}
          onAction={() => store.setMuted(id, ms ? Date.now() + ms : true)}
        >
          {label}
        </MenuItem>
      ))}
    </MenuSub>
  );
};
