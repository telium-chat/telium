import { reportError } from '../../hooks/useToast.jsx';
import { has } from '../../lib/perms.js';
import { channelRoute } from '../../lib/channels.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { FOLLOW_ACCOUNT, MODES, MODE_COPY, guildExplanation } from '../../lib/net/policy.js';
import {
  AddChannelIcon, AnnouncementIcon, BellIcon, BellOffIcon, CheckIcon, CopyIcon, GlobeIcon,
  CategoryIcon, LinkIcon, MenuItem, MenuSeparator, MenuSub, MessageIcon, SettingsIcon, ShieldIcon,
  SignOutIcon, TrashIcon,
} from '../../components/index.js';
import { GuildSettings } from '../settings.jsx';
import { CreateChannelDialog } from '../dialogs/CreateChannelDialog.jsx';
import { CreateCategoryDialog } from '../dialogs/CreateCategoryDialog.jsx';
import { EditChannelDialog } from '../dialogs/EditChannelDialog.jsx';
import { FollowChannelDialog } from '../dialogs/FollowChannelDialog.jsx';
import { InviteDialog } from '../dialogs/InviteDialog.jsx';
import { VoiceStatusDialog, canSetVoiceStatus } from '../dialogs/VoiceStatusDialog.jsx';
import { muteItems, subLabel } from './common.jsx';

const sharesHere = (store, g) => store.sharesStatus(g.domain);

export const networkItems = (env, g) => {
  const { store } = env;
  const prefs = store.networkPrefs();
  const chosen = prefs.guilds[g.id] || null;
  const why = guildExplanation(prefs, [...store.guilds.values()], g.id);
  return (
    <MenuSub label={subLabel(GlobeIcon, 'Network privacy')}>
      {MODES.map((mode) => (
        <MenuItem
          key={mode}
          icon={chosen === mode ? CheckIcon : undefined}
          onAction={() => store.setGuildNetworkMode(g.id, mode)}
        >
          {MODE_COPY[mode].label}
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem
        icon={chosen ? undefined : CheckIcon}
        onAction={() => store.setGuildNetworkMode(g.id, null)}
      >
        {FOLLOW_ACCOUNT.label}
      </MenuItem>
      <div className="netpriv-menu-why">{why.sentence}</div>
    </MenuSub>
  );
};

export const guild = (env, g) => {
  const { store, modal, dialogs } = env;
  const perms = store.guildPermissions(g.id);
  const isOwner = Boolean(store.myMember(g.id)?.is_owner);
  const api = () => store.apiForGuild(g.id);
  return (
    <>
      {has(perms, 'CREATE_INVITE') ? (
        <MenuItem
          icon={LinkIcon}
          onAction={() => modal.open((c) => <InviteDialog guild={g} close={c} />)}
        >
          Invite people
        </MenuItem>
      ) : null}
      {has(perms, 'MANAGE_CHANNELS') ? (
        <MenuItem
          icon={AddChannelIcon}
          onAction={() => modal.open((c) => <CreateChannelDialog guild={g} close={c} />)}
        >
          Create channel
        </MenuItem>
      ) : null}
      {has(perms, 'MANAGE_CHANNELS') ? (
        <MenuItem
          icon={CategoryIcon}
          onAction={() => modal.open((c) => <CreateCategoryDialog guild={g} close={c} />)}
        >
          Create category
        </MenuItem>
      ) : null}
      {has(perms, 'MANAGE_GUILD') ? (
        <MenuItem
          icon={SettingsIcon}
          onAction={() => modal.open(
            (c) => <GuildSettings guildId={g.id} close={c} />, { fullscreen: true },
          )}
        >
          Server settings
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={sharesHere(store, g) ? BellOffIcon : BellIcon}
        onAction={() => store.setPresence({ guild: g.id, hide: sharesHere(store, g) })}
      >
        {sharesHere(store, g) ? 'Hide my status here' : 'Show my status here'}
      </MenuItem>
      {networkItems(env, g)}
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(g.id, 'Guild ID')}>Copy guild ID</MenuItem>
      {isOwner ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.prompt({
            title: `Delete ${g.name}`,
            label: 'Type the name to confirm',
            hint: 'Channels, messages and roles go with it. This cannot be undone.',
            require: g.name,
            placeholder: g.name,
            confirmLabel: 'Delete guild',
            danger: true,
            onSubmit: async () => {
              try {
                await api().deleteGuild(g.id);
                store.dropGuild(g.id);
              } catch (e) { reportError(e, 'Could not delete the guild'); }
            },
          })}
        >
          Delete guild
        </MenuItem>
      ) : (
        <MenuItem
          icon={SignOutIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: `Leave ${g.name}`,
            body: 'Your messages stay; your membership does not.',
            confirmLabel: 'Leave',
            danger: true,
            onConfirm: async () => {
              try {
                await api().leaveGuild(g.id);
                store.dropGuild(g.id);
              } catch (e) { reportError(e, 'Could not leave'); }
            },
          })}
        >
          Leave guild
        </MenuItem>
      )}
    </>
  );
};

export const category = (env, ch) => {
  const { store, modal, dialogs } = env;
  const guild = store.guilds.get(ch.guild_id);
  const mayManage = has(store.guildPermissions(ch.guild_id), 'MANAGE_CHANNELS');
  if (!mayManage) {
    return (
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(ch.id, 'Category id')}>
        Copy category id
      </MenuItem>
    );
  }
  return (
    <>
      <MenuItem
        icon={AddChannelIcon}
        onAction={() => modal.open(
          (c) => <CreateChannelDialog guild={guild} parentId={ch.id} close={c} />,
        )}
      >
        Create channel here
      </MenuItem>
      <MenuItem
        icon={CategoryIcon}
        onAction={() => modal.open((c) => <CreateCategoryDialog guild={guild} close={c} />)}
      >
        Create category
      </MenuItem>
      <MenuItem
        icon={SettingsIcon}
        onAction={() => modal.open((c) => <EditChannelDialog channel={ch} close={c} />)}
      >
        Edit category
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(ch.id, 'Category id')}>
        Copy category id
      </MenuItem>
      <MenuItem
        icon={TrashIcon}
        tone="danger"
        onAction={() => dialogs.confirm({
          title: `Delete ${ch.name}`,
          body: 'The channels under it stay, and move to the top of the list.',
          confirmLabel: 'Delete',
          danger: true,
          onConfirm: async () => {
            try {
              await store.apiForChannel(ch.id).deleteChannel(ch.id);
              store.channels.delete(ch.id);
              store.emit('channels', ch.guild_id);
            } catch (e) { reportError(e, 'Could not delete'); }
          },
        })}
      >
        Delete category
      </MenuItem>
    </>
  );
};

export const channel = (env, ch) => {
  const { store, modal, dialogs } = env;
  const api = () => store.apiForChannel(ch.id);
  const mayManage = has(store.permissionsIn(ch.id), 'MANAGE_CHANNELS');
  const maySetStatus = ch.type === 'voice' && canSetVoiceStatus(store, ch);
  return (
    <>
      {muteItems(env, ch.id, 'channel')}
      <MenuItem icon={LinkIcon} onAction={() => copyToClipboard(`${ch.domain}/${ch.id}`, 'Channel link')}>
        Copy link
      </MenuItem>
      {ch.type === 'voice' ? (
        <MenuItem
          icon={MessageIcon}
          onAction={() => store.navigate({ ...channelRoute(ch), chat: true })}
        >
          Open chat
        </MenuItem>
      ) : null}
      {maySetStatus ? (
        <MenuItem
          icon={MessageIcon}
          onAction={() => modal.open((c) => <VoiceStatusDialog channel={ch} close={c} />)}
        >
          {ch.voice_status ? 'Edit voice status' : 'Set voice status'}
        </MenuItem>
      ) : null}
      {ch.type === 'announcement' ? (
        <MenuItem
          icon={AnnouncementIcon}
          onAction={() => modal.open((c) => <FollowChannelDialog channel={ch} close={c} />)}
        >
          Follow announcements
        </MenuItem>
      ) : null}
      {mayManage ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={SettingsIcon}
            onAction={() => modal.open((c) => <EditChannelDialog channel={ch} close={c} />)}
          >
            Edit channel
          </MenuItem>
          <MenuItem
            icon={ShieldIcon}
            onAction={() => modal.open(
              (c) => <EditChannelDialog channel={ch} tab="permissions" close={c} />,
            )}
          >
            Edit permissions
          </MenuItem>
        </>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(ch.id, 'Channel ID')}>
        Copy channel ID
      </MenuItem>
      {mayManage ? (
        <MenuItem
          icon={TrashIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: `Delete #${ch.name}`,
            body: 'Messages are not recoverable.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
              try {
                await api().deleteChannel(ch.id);
                store.channels.delete(ch.id);
                store.emit('channels', ch.guild_id);
              } catch (e) { reportError(e, 'Could not delete'); }
            },
          })}
        >
          Delete channel
        </MenuItem>
      ) : null}
    </>
  );
};
