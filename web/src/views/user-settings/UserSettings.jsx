import { useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import {
  AdvancedIcon, BellIcon, GlobeIcon, HelpIcon, HomeIcon, KeyIcon, MembersIcon, MessageIcon, MicIcon,
  PlayIcon, ScreenIcon, ServerIcon, SettingsIcon, SettingsLayout, ShieldIcon, SunIcon, UserIcon,
} from '../../components/index.js';
import { isElectronRuntime } from '../../lib/platform.js';
import { storage } from '../../lib/util.js';
import { ProfilePane } from './ProfilePane.jsx';
import { AppearancePane } from './AppearancePane.jsx';
import { DevicesPane } from './DevicesPane.jsx';
import { ServersPane } from './ServersPane.jsx';
import { NetworkPrivacyPane } from './NetworkPrivacyPane.jsx';
import { NotificationsPane } from './NotificationsPane.jsx';
import { ActivityPane } from './ActivityPane.jsx';
import { DesktopPane } from './DesktopPane.jsx';
import { ConversationSignalsPane } from './ConversationSignalsPane.jsx';
import { ProfileLookupsPane } from './ProfileLookupsPane.jsx';
import { AccountPane } from './AccountPane.jsx';
import { RecoveryPane } from './RecoveryPane.jsx';
import { SecurityPane } from './SecurityPane.jsx';
import { DeveloperPane } from './DeveloperPane.jsx';
import { AdminPane } from './AdminPane.jsx';
import { LocalDataPane } from './LocalDataPane.jsx';
import { CallsPane } from './CallsPane.jsx';
import { GifFavoritesPane } from './GifFavoritesPane.jsx';
import { FeedbackPane } from './FeedbackPane.jsx';

const BASE_PANES = {
  profile: {
    label: 'Profile',
    component: ProfilePane,
    group: 'Profile & presence',
    icon: UserIcon,
    wide: true,
    keywords: [
      'avatar', 'banner', 'bio', 'about', 'display name', 'pronouns', 'colour', 'color',
      'public profile', 'profile link', 'share profile', 'online status', 'custom status', 'activity',
    ],
  },
  account: {
    label: 'Account',
    component: AccountPane,
    group: 'Account',
    icon: HomeIcon,
    keywords: ['email', 'password', 'storage', 'move', 'migrate', 'delete', 'deactivate'],
  },
  developer: {
    label: 'Developer',
    component: DeveloperPane,
    group: 'Developer',
    icon: AdvancedIcon,
    keywords: ['bots', 'applications', 'developer', 'token', 'api'],
  },
  appearance: {
    label: 'Appearance',
    component: AppearancePane,
    group: 'App',
    icon: SunIcon,
    keywords: ['theme', 'dark', 'light', 'language', 'locale'],
  },
  calls: {
    label: 'Calls & audio',
    component: CallsPane,
    group: 'Communication',
    icon: MicIcon,
    keywords: ['microphone', 'noise', 'noise cancellation', 'suppression', 'audio', 'call', 'call privacy'],
  },
  notifications: {
    label: 'Notifications',
    component: NotificationsPane,
    group: 'App',
    icon: BellIcon,
    keywords: ['push', 'sound', 'badge', 'mute'],
  },
  signals: {
    label: 'Messages',
    component: ConversationSignalsPane,
    group: 'Communication',
    icon: MessageIcon,
    keywords: ['read receipts', 'typing', 'seen'],
  },
  lookups: {
    label: 'Profile lookups',
    component: ProfileLookupsPane,
    group: 'Privacy',
    icon: MembersIcon,
    keywords: [
      'mutual friends', 'mutuals', 'in common', 'profile', 'hover', 'fan-out',
      'who knows i looked', 'privacy',
    ],
  },
  activity: {
    label: 'Activity sharing',
    component: ActivityPane,
    group: 'Profile & presence',
    icon: PlayIcon,
    keywords: ['game', 'rich presence', 'status', 'playing'],
  },
  extras: {
    label: 'Extras',
    component: GifFavoritesPane,
    group: 'App',
    icon: PlayIcon,
    keywords: ['gif', 'gifs', 'favorites', 'favorites import', 'favorites export', 'discord', 'tenor', 'extras'],
  },
  storage: {
    label: 'Local data',
    component: LocalDataPane,
    group: 'App data',
    icon: AdvancedIcon,
    keywords: [
      'cache', 'clear', 'reset', 'storage', 'offline', 'corrupt', 'broken',
      'stuck', 'blank screen', 'wipe', 'indexeddb',
    ],
  },
  desktop: {
    label: 'Desktop',
    component: DesktopPane,
    group: 'App',
    icon: SettingsIcon,
    keywords: ['linux', 'appimage', 'launcher', 'startup', 'autostart', 'login', 'tray'],
  },
  recovery: {
    labelKey: 'settings.nav.recovery',
    component: RecoveryPane,
    group: 'Security & access',
    icon: KeyIcon,
    keywords: ['recovery', 'backup', 'e2ee', 'vault', 'keyring'],
  },
  devices: {
    label: 'Devices',
    component: DevicesPane,
    group: 'Security & access',
    icon: ScreenIcon,
    keywords: ['sessions', 'verify', 'sign out', 'logout'],
  },
  security: {
    label: 'Security',
    component: SecurityPane,
    group: 'Security & access',
    icon: ShieldIcon,
    keywords: ['2fa', 'mfa', 'totp', 'authenticator', 'password'],
  },
  network: {
    label: 'Network privacy',
    component: NetworkPrivacyPane,
    group: 'Privacy',
    icon: GlobeIcon,
    keywords: ['ip', 'ip address', 'hide my ip', 'vpn', 'proxy', 'anonymous', 'privacy'],
  },
  servers: {
    label: 'Connected servers',
    component: ServersPane,
    group: 'Servers',
    icon: ServerIcon,
    keywords: ['federation', 'guild hosts', 'homeserver'],
  },
  feedback: {
    label: 'Help & feedback',
    component: FeedbackPane,
    group: 'App',
    icon: HelpIcon,
    keywords: [
      'help', 'feedback', 'bug', 'report', 'issue', 'broken', 'crash',
      'problem', 'feature request', 'suggestion', 'support', 'contact', 'github',
    ],
  },
};

export function UserSettings({ close, initial }) {
  const store = useStore();
  const t = useT();
  const requestedInitial = initial === 'voice' ? 'calls' : initial;
  if (storage.get('telium.settings.user.pane', null) === 'voice') {
    storage.set('telium.settings.user.pane', 'calls');
  }
  const panes = {};
  for (const [id, pane] of Object.entries(BASE_PANES)) {
    panes[id] = pane.labelKey ? { ...pane, label: t(pane.labelKey) } : pane;
  }
  if (!isElectronRuntime()) {
    delete panes.activity;
    delete panes.desktop;
  }
  if (store.me?.admin) {
    panes.admin = {
      label: 'Server administration',
      component: AdminPane,
      group: 'Servers',
      icon: AdvancedIcon,
      keywords: ['reports', 'blocks', 'moderation', 'instance'],
    };
  }
  return (
    <SettingsLayout
      id="user"
      title={store.session?.home?.user_id || 'Account'}
      panes={panes}
      initial={requestedInitial}
      footerLabel="Home server"
      footerValue={store.session?.home?.domain || ''}
      onClose={close}
    />
  );
}
