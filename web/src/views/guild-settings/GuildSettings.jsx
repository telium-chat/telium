import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { has } from '../../lib/perms.js';
import { useT } from '../../lib/i18n/react.jsx';
import { SettingsLayout } from '../../components/index.js';
import { OverviewPane } from './OverviewPane.jsx';
import { RolesPane } from './RolesPane.jsx';
import { ChannelPermissionsPane } from './ChannelPermissionsPane.jsx';
import { GatesPane } from './GatesPane.jsx';
import { QueuePane } from './QueuePane.jsx';
import { BansPane } from './BansPane.jsx';
import { ExpressionsPane } from './ExpressionsPane.jsx';
import { AuditPane } from './AuditPane.jsx';
import { VoicePane } from './VoicePane.jsx';
import { InvitesPane } from './InvitesPane.jsx';
import { BotsPane } from './BotsPane.jsx';
import { PurgePane } from './PurgePane.jsx';
import { EmptyState } from '../../components/index.js';

export function GuildSettings({ guildId, close, initial = 'overview' }) {
  const store = useStore();
  const t = useT();
  useStoreEvent('guilds');
  const guild = store.guilds.get(guildId);
  const api = store.apiForGuild(guildId);

  if (!api) {
    return <EmptyState>{t('guild.unreachable')}</EmptyState>;
  }

  const bind = (Pane) => function Bound(props) {
    return <Pane guildId={guildId} api={api} close={close} {...props} />;
  };

  const perms = store.guildPermissions(guildId);
  const when = (name, pane) => (has(perms, name) ? pane : null);

  const panes = {
    overview: { label: t('guild.nav.overview'), component: bind(OverviewPane) },
    roles: when('MANAGE_ROLES', { label: t('guild.nav.roles'), component: bind(RolesPane) }),
    channels: when('MANAGE_ROLES', { label: t('guild.nav.channels'), component: bind(ChannelPermissionsPane) }),
    bots: when('MANAGE_GUILD', { label: t('guild.nav.bots'), component: bind(BotsPane) }),
    gates: when('MANAGE_GUILD', { label: t('guild.nav.gates'), component: bind(GatesPane) }),
    queue: when('MODERATE_MEMBERS', { label: t('guild.nav.queue'), component: bind(QueuePane) }),
    purge: when('MANAGE_MESSAGES', { label: t('guild.nav.purge'), component: bind(PurgePane) }),
    bans: when('BAN_MEMBERS', { label: t('guild.nav.bans'), component: bind(BansPane) }),
    invites: when('MANAGE_GUILD', { label: t('guild.nav.invites'), component: bind(InvitesPane) }),
    expressions: when('MANAGE_EXPRESSIONS', { label: t('guild.nav.expressions'), component: bind(ExpressionsPane) }),
    voice: when('MANAGE_GUILD', { label: t('guild.nav.voice'), component: bind(VoicePane) }),
    audit: when('VIEW_AUDIT_LOG', { label: t('guild.nav.audit'), component: bind(AuditPane) }),
  };
  for (const [key, pane] of Object.entries(panes)) if (!pane) delete panes[key];

  return (
    <SettingsLayout
      title={guild?.name || t('guild.title.fallback')}
      panes={panes}
      initial={initial}
      footerLabel={t('guild.hostedBy')}
      footerValue={guild?.domain}
      onClose={close}
    />
  );
}
