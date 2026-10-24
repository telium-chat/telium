import { useMemo } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  ChartIcon, CogIcon, DiskIcon, FlagIcon, GlobeIcon, ListIcon, MembersIcon,
  PulseIcon, ServerIcon, SettingsLayout, ShieldIcon, TagIcon,
} from '../../components/index.js';
import { ControlPlaneContext } from './context.js';
import { useLive } from './useLive.js';
import { useStepUp } from './StepUp.jsx';
import { OverviewPane } from './OverviewPane.jsx';
import { StatisticsPane } from './StatisticsPane.jsx';
import { AccountsPane } from './AccountsPane.jsx';
import { GuildsPane } from './GuildsPane.jsx';
import { ModerationPane } from './ModerationPane.jsx';
import { FederationPane } from './FederationPane.jsx';
import { HostingPane } from './HostingPane.jsx';
import { ContinuityPane } from './ContinuityPane.jsx';
import { AuditPane } from './AuditPane.jsx';
import { StoragePane } from './StoragePane.jsx';
import { ServerPane } from './ServerPane.jsx';

const POLL_MS = 15_000;

const HEALTH_MS = 60_000;

const PANES = {
  overview: {
    label: 'Overview',
    component: OverviewPane,
    group: 'Now',
    icon: PulseIcon,
    wide: true,
    keywords: ['health', 'incident', 'status', 'latency', 'errors', 'uptime', 'signals', 'warnings'],
  },
  statistics: {
    label: 'Statistics',
    component: StatisticsPane,
    group: 'Now',
    icon: ChartIcon,
    wide: true,
    keywords: ['history', 'graph', 'chart', 'throughput', 'bandwidth', 'percentile', 'trend'],
  },
  storage: {
    label: 'Storage and media',
    component: StoragePane,
    group: 'Now',
    icon: DiskIcon,
    wide: true,
    keywords: ['disk', 'files', 'archive', 'cold', 'cache', 'backup', 'sweep'],
  },
  settings: {
    label: 'Server settings',
    component: ServerPane,
    group: 'Now',
    icon: CogIcon,
    wide: true,
    keywords: ['config', 'toml', 'roles', 'limits', 'restart'],
  },
  accounts: {
    label: 'Accounts',
    component: AccountsPane,
    group: 'Who is here',
    icon: MembersIcon,
    wide: true,
    keywords: ['users', 'people', 'suspend', 'reinstate', 'deactivated', 'admins', 'search'],
  },
  guilds: {
    label: 'Guilds',
    component: GuildsPane,
    group: 'Who is here',
    icon: ServerIcon,
    wide: true,
    keywords: ['servers', 'communities', 'purge', 'moved', 'reclaim', 'owner', 'channels'],
  },
  moderation: {
    label: 'Moderation',
    component: ModerationPane,
    group: 'Who is here',
    icon: FlagIcon,
    wide: true,
    keywords: ['reports', 'abuse', 'queue', 'triage', 'resolve'],
  },
  federation: {
    label: 'Federation',
    component: FederationPane,
    group: 'The network',
    icon: GlobeIcon,
    wide: true,
    keywords: ['peers', 'defederation', 'blocklist', 'feeds', 'backlog', 'domains'],
  },
  hosting: {
    label: 'Hosting catalogs',
    component: HostingPane,
    group: 'The network',
    icon: TagIcon,
    wide: true,
    keywords: [
      'providers', 'marketplace', 'catalog', 'catalogue', 'managed', 'plans', 'prices', 'subscribe',
    ],
  },
  continuity: {
    label: 'Continuity',
    component: ContinuityPane,
    group: 'The network',
    icon: ShieldIcon,
    wide: true,
    keywords: ['standby', 'failover', 'mirror', 'replication', 'authority', 'sunset', 'tombstone'],
  },
  audit: {
    label: 'Audit log',
    component: AuditPane,
    group: 'What was done',
    icon: ListIcon,
    wide: true,
    keywords: ['history', 'who', 'actions', 'log', 'accountability', 'step-up'],
  },
};

export function ControlPlane({ close }) {
  const store = useStore();
  const home = store.home;

  const metrics = useLive(() => home.adminMetrics(), { interval: POLL_MS });
  const status = useLive(() => home.adminStatus(), { interval: 60_000 });
  const health = useLive(() => home.adminHealth(), { interval: HEALTH_MS });

  const stepUp = useStepUp();

  const value = useMemo(
    () => ({ home, metrics, status, health, stepUp, pollMs: POLL_MS }),
    [home, metrics, status, health, stepUp],
  );

  return (
    <ControlPlaneContext.Provider value={value}>
      <SettingsLayout
        id="control-plane"
        title="Control plane"
        panes={PANES}
        footerLabel="Operating"
        footerValue={metrics.data?.server_name || store.session?.home?.domain || ''}
        onClose={close}
      />
    </ControlPlaneContext.Provider>
  );
}
