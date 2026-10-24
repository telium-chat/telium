import { lazy, Suspense } from 'react';
import { useStore } from '../hooks/useStore.jsx';
import { EmojiText, ServerIcon, Skeleton, TeliumMark, UpdateStatus } from '../components/index.js';
import { buildTitle } from '../lib/build.js';

let userChunk = null;
let guildChunk = null;
const loadUser = () => { userChunk ||= import('./user-settings/UserSettings.jsx'); return userChunk; };
const loadGuild = () => { guildChunk ||= import('./guild-settings/GuildSettings.jsx'); return guildChunk; };

export function prefetchSettings() {
  loadUser();
  loadGuild();
}

if (typeof window !== 'undefined') {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1500));
  idle(() => { loadUser().then(() => idle(() => loadGuild())).catch(() => {}); });
}

const Guild = lazy(() => loadGuild().then((m) => ({ default: m.GuildSettings })));
const User = lazy(() => loadUser().then((m) => ({ default: m.UserSettings })));

export function GuildSettings(props) {
  const store = useStore();
  const guild = store.guilds.get(props.guildId);
  return (
    <Suspense fallback={<Frame label="Hosted by" value={guild?.domain} title={guild?.name} />}>
      <Guild {...props} />
    </Suspense>
  );
}

export function UserSettings(props) {
  const store = useStore();
  return (
    <Suspense
      fallback={(
        <Frame
          label="Home server"
          value={store.session?.home?.domain}
          title={store.session?.home?.user_id}
        />
      )}
    >
      <User {...props} />
    </Suspense>
  );
}

function Frame({ label, value, title }) {
  return (
    <div className="settings" data-view="pane" aria-busy="true">
      <div className="settings__nav">
        <div className="settings__head">
          <div className="settings__host">
            <div className="eyebrow">{label}</div>
            <div className="settings__host-value">
              <ServerIcon className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{value}</span>
            </div>
            <div className="settings__host-title truncate"><EmojiText>{title}</EmojiText></div>
          </div>
        </div>
        <div className="settings__find" />
        <div className="settings__list">
          {['w-[62%]', 'w-[48%]', 'w-[74%]', 'w-[56%]', 'w-[66%]', 'w-[50%]', 'w-[70%]', 'w-[58%]']
            .map((width, i) => (
              <div key={i} className="settings-item">
                <Skeleton className={`h-3.5 rounded-md ${width}`} />
              </div>
            ))}
        </div>
        <div className="settings__mark">
          <TeliumMark className="size-4" gradient={false} />
          <span className="text-xs font-semibold text-foreground/80">Telium</span>
          <span
            className="select-all text-2xs font-mono opacity-60"
            title={buildTitle()}
          >
            v{__APP_VERSION__}
            <span className="opacity-60"> · {__BUILD_ID__ ?? 'dev'}</span>
          </span>
        </div>
        <UpdateStatus />
      </div>
      <div className="settings__pane">
        <div className="settings__body">
          <div className="settings__sheet">
            <Skeleton className="mb-4 h-7 w-44 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
