import { Avatar, ContextMenu, EmojiText, StatusLine } from '../components/index.js';
import { useStore } from '../hooks/useStore.jsx';
import { useProfileCard } from '../hooks/useProfileCard.js';
import { useConversationPeer } from '../hooks/useConversationPeer.js';
import { dmPeer } from '../lib/conversations.js';
import { faceOf } from '../lib/faces.js';
import { cn } from '../lib/cn.js';
import { ProfileBody } from './profile/ProfileBody.jsx';
import { useMenus } from './menus.jsx';

export function dmPanelShown(store) {
  return store.prefs.dmPanel !== false;
}

export function DmSidePanel({ convo }) {
  const store = useStore();
  const { peer, peers, typing } = useConversationPeer(convo);
  if (!convo) return null;

  if (convo.kind === 'dm') {
    if (!peer) return null;
    return (
      <aside
        aria-label="Profile"
        className="dm-panel hidden w-[320px] shrink-0 flex-col overflow-hidden bg-rail p-2 xl:flex"
      >
        <ProfileBody key={peer.id} guildId={null} userId={peer.id} close={() => {}} surface="panel" />
      </aside>
    );
  }

  return <DmMembers store={store} peers={peers} typing={typing} />;
}

const offline = (p) => !p.presence || p.presence === 'offline' || p.presence === 'invisible';

function DmMembers({ store, peers, typing }) {
  const profiles = useProfileCard();
  const menus = useMenus();
  const me = store.me?.user_id;
  const self = me ? faceOf(store, me) : null;
  const everyone = [
    ...(self ? [{
      ...self,
      presence: store.prefs.presence || 'online',
      live: { status: store.prefs.presence || 'online', custom_status: store.prefs.status?.text },
    }] : []),
    ...peers.map((id) => dmPeer(store, id)).filter(Boolean),
  ];
  const online = everyone.filter((p) => !offline(p));
  const away = everyone.filter(offline);

  const section = (label, list) => (list.length ? (
    <>
      <div className="flex items-baseline gap-1.5 px-2 pt-4 pb-1 text-xs font-medium text-muted first:pt-1">
        <span className="min-w-0 truncate">{label}</span>
        <span className="tnum shrink-0">{`— ${list.length}`}</span>
      </div>
      {list.map((p) => (
        <ContextMenu
          key={p.id}
          content={() => menus.member(p.id, null, {
            onMention: (id) => store.emit('compose', `<${id}>`),
          })}
        >
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={(e) => profiles.open(p.id, { anchor: e.currentTarget })}
            onPointerEnter={() => profiles.prefetch(p.id)}
            onPointerLeave={profiles.cancel}
            className={cn(
              'nav-row nav-row--person text-muted hover:bg-rail-hover hover:text-foreground',
              offline(p) && 'opacity-55',
            )}
          >
            <Avatar
              id={p.id}
              name={p.name}
              size="sm"
              mediaRef={p.avatarRef}
              base={p.base}
              mediaOrigin={p.mediaOrigin}
              presence={p.presence}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate"><EmojiText>{p.name || p.id}</EmojiText></span>
              <StatusLine presence={p.live} store={store} className="nav-note" typing={typing.includes(p.id)} />
            </span>
          </button>
        </ContextMenu>
      ))}
    </>
  ) : null);

  return (
    <aside
      aria-label="Members"
      className="dm-panel hidden w-[240px] shrink-0 flex-col gap-0.5 overflow-y-auto bg-rail px-2 py-2 xl:flex"
    >
      {section('Online', online)}
      {section('Offline', away)}
    </aside>
  );
}
