import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { has } from '../../lib/perms.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { faceOf } from '../../lib/faces.js';
import { mediaUrl } from '../../lib/media.js';
import { colourOf, participants, shortName, tint } from '../../lib/util.js';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import {
  AddFriendIcon, AdvancedIcon, Avatar, BanIcon, CheckIcon, CloseIcon, CopyIcon, DeafenIcon, EditIcon,
  EmojiIcon, EmojiText, HeadphonesIcon, StatusText, KeyIcon, KickIcon, ListIcon, MentionIcon, MenuItem,
  MenuSection, MenuSeparator, MenuSub, MessageIcon, MicIcon, MicOffIcon, PrivacyNote, PRESENCE,
  PRESENCE_STATES, PlusIcon, ServerIcon, SettingsIcon, SignOutIcon, SwitchAccountIcon, UserIcon,
  botMember,
} from '../../components/index.js';
import { GuildSettings, UserSettings } from '../settings.jsx';
import { PromoteDialog } from '../dialogs/PromoteDialog.jsx';
import { ConversationDialog } from '../dialogs/ConversationDialog.jsx';
import { CustomStatusDialog } from '../dialogs/CustomStatusDialog.jsx';
import { AccountFace, AccountsDialog } from '../dialogs/AccountsDialog.jsx';
import { MAX_ACCOUNTS } from '../../lib/accounts.js';
import { openFullProfile } from '../profile/ProfileBody.jsx';
import { subLabel } from './common.jsx';

function AccountCard() {
  const store = useStore();
  useStoreEvent('me', 'prefs');
  const me = store.me;
  const profile = me?.profile || {};
  const name = profile.display_name || shortName(me?.user_id);
  const banner = profile.banner_ref || null;
  const custom = (store.prefs.status?.text || '').trim();
  const face = faceOf(store, me?.user_id);
  return (
    <div className="account-card">
      <div
        className="account-card__banner"
        style={{ background: colourOf(profile.accent_color) || tint(me?.user_id) }}
      >
        {banner && store.home?.base ? (
          <AnimatedImage
            src={mediaUrl(store.home.base, banner)}
            alt=""
            animated
            className="size-full object-cover"
          />
        ) : null}
      </div>
      <div className="account-card__body">
        <div className="account-card__avatar">
          <Avatar
            id={me?.user_id}
            name={name}
            size="lg"
            mediaRef={face?.avatarRef}
            base={face?.base}
            mediaOrigin={face?.mediaOrigin}
            presence={store.prefs.presence || 'online'}
          />
        </div>
        <div className="account-card__text">
          <div className="account-card__name"><EmojiText>{name}</EmojiText></div>
          <div className="account-card__handle">{me?.user_id}</div>
          {custom ? (
            <div className="account-card__status"><StatusText store={store}>{custom}</StatusText></div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export const member = (env, userId, guildId, { onMention } = {}) => {
  const { store, modal, dialogs } = env;
  const perms = guildId ? store.guildPermissions(guildId) : 0;
  const isMe = userId === store.me?.user_id;
  const api = () => (guildId ? store.apiForGuild(guildId) : null);
  const isBot = Boolean(botMember(store, userId, guildId)?.is_bot);

  return (
    <>
      <MenuItem
        icon={UserIcon}
        onAction={() => openFullProfile(modal, userId, { guildId })}
      >
        View profile
      </MenuItem>
      {isMe ? null : (
        <MenuItem
          icon={MessageIcon}
          onAction={async () => {
            try {
              const convo = await store.startConversation([userId]);
              store.navigate({ view: 'dms', conversationId: convo.id });
            } catch (e) { reportError(e, 'Could not open a conversation'); }
          }}
        >
          Message
        </MenuItem>
      )}
      {!isMe && !store.friends.has(userId) ? (
        <MenuItem
          icon={AddFriendIcon}
          onAction={async () => {
            try {
              await store.addFriend(userId);
              toast('Request sent.');
            } catch (e) { reportError(e, 'Could not send that request'); }
          }}
        >
          Add friend
        </MenuItem>
      ) : null}
      {onMention ? (
        <MenuItem icon={MentionIcon} onAction={() => onMention(userId)}>Mention</MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(userId, 'User ID')}>Copy user ID</MenuItem>
      {isBot && guildId && has(perms, 'MANAGE_GUILD') ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={SettingsIcon}
            onAction={() => modal.open(
              (c) => <GuildSettings guildId={guildId} close={c} initial="bots" />,
              { fullscreen: true },
            )}
          >
            Manage this bot
          </MenuItem>
        </>
      ) : null}
      {!isMe && !isBot && guildId && has(perms, 'KICK_MEMBERS') ? (
        <>
          <MenuSeparator />
          <MenuItem
            icon={KickIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: 'Kick from this guild',
              body: `${userId} can be invited back.`,
              confirmLabel: 'Kick',
              danger: true,
              onConfirm: async () => {
                try { await api().kick(guildId, userId); toast('Kicked.'); }
                catch (e) { reportError(e, 'Could not kick'); }
              },
            })}
          >
            Kick member
          </MenuItem>
        </>
      ) : null}
      {!isMe && !isBot && guildId && has(perms, 'BAN_MEMBERS') ? (
        <MenuItem
          icon={BanIcon}
          tone="danger"
          onAction={() => dialogs.prompt({
            title: 'Ban from this guild',
            label: 'Reason (recorded in the audit log)',
            onSubmit: async (reason) => {
              try { await api().ban(guildId, userId, { reason }); toast('Banned.'); }
              catch (e) { reportError(e, 'Could not ban'); }
            },
          })}
        >
          Ban member
        </MenuItem>
      ) : null}
    </>
  );
};

export const friend = (env, row) => {
  const { store, t, dialogs } = env;
  const userId = row.user_id;
  const act = (what, run) => async () => {
    try { await run(); } catch (e) { reportError(e, what); }
  };

  return (
    <>
      {row.state === 'accepted' ? (
        <MenuItem
          icon={MessageIcon}
          onAction={act('Could not open a conversation', async () => {
            const convo = await store.startConversation([userId]);
            store.navigate({ view: 'dms', conversationId: convo.id });
          })}
        >
          Message
        </MenuItem>
      ) : null}
      {row.state === 'pending_in' ? (
        <MenuItem
          icon={CheckIcon}
          onAction={act('Could not accept', () => store.acceptFriend(userId))}
        >
          Accept request
        </MenuItem>
      ) : null}
      <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(userId, 'User ID')}>Copy user ID</MenuItem>
      <MenuSeparator />
      {row.state === 'blocked' ? (
        <MenuItem
          icon={CloseIcon}
          onAction={act('Could not unblock', () => store.unblockUser(userId))}
        >
          Unblock
        </MenuItem>
      ) : (
        <>
          <MenuItem
            icon={KickIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: row.state === 'accepted' ? 'Remove friend' : 'Withdraw request',
              body: `${userId} is not told which of you ended it.`,
              confirmLabel: row.state === 'accepted' ? 'Remove' : 'Withdraw',
              danger: true,
              onConfirm: act('Could not update that', () => store.removeFriend(userId)),
            })}
          >
            {row.state === 'accepted' ? 'Remove friend' : 'Withdraw request'}
          </MenuItem>
          <MenuItem
            icon={BanIcon}
            tone="danger"
            onAction={() => dialogs.confirm({
              title: 'Block',
              body: t('privacy.block.body'),
              confirmLabel: 'Block',
              danger: true,
              onConfirm: act('Could not block', () => store.blockUser(userId)),
            })}
          >
            Block
          </MenuItem>
        </>
      )}
    </>
  );
};

export const voice = (env, state, guildId, { onMention } = {}) => {
  const { store } = env;
  const userId = state.user_id;
  const perms = guildId ? store.guildPermissions(guildId) : 0n;
  const mayMute = has(perms, 'MUTE_MEMBERS');
  const mayDeafen = has(perms, 'DEAFEN_MEMBERS');
  const mayMove = has(perms, 'MOVE_MEMBERS');
  const moderate = async (body, done) => {
    try {
      await store.apiForGuild(guildId).voiceModerate(guildId, userId, body);
      toast(done);
    } catch (e) { reportError(e, 'Could not apply that in voice'); }
  };

  return (
    <>
      {member(env, userId, guildId, { onMention })}
      {mayMute || mayDeafen || mayMove ? <MenuSeparator /> : null}
      {mayMute ? (
        <MenuItem
          icon={state.server_mute ? MicIcon : MicOffIcon}
          onAction={() => moderate(
            { mute: !state.server_mute },
            state.server_mute ? 'Server mute lifted.' : 'Server muted.',
          )}
        >
          {state.server_mute ? 'Remove server mute' : 'Server mute'}
        </MenuItem>
      ) : null}
      {mayDeafen ? (
        <MenuItem
          icon={state.server_deaf ? HeadphonesIcon : DeafenIcon}
          onAction={() => moderate(
            { deaf: !state.server_deaf },
            state.server_deaf ? 'Server deafen lifted.' : 'Server deafened.',
          )}
        >
          {state.server_deaf ? 'Remove server deafen' : 'Server deafen'}
        </MenuItem>
      ) : null}
      {mayMove ? (
        <MenuItem
          icon={CloseIcon}
          tone="danger"
          onAction={() => moderate({ disconnect: true }, 'Disconnected from voice.')}
        >
          Disconnect from voice
        </MenuItem>
      ) : null}
    </>
  );
};

export const conversation = (env, convo) => {
  const { store, modal, dialogs } = env;
  const peerId = convo.kind === 'dm'
    ? participants(convo)
      .map((member) => member.user_id || member)
      .find((userId) => userId && userId !== store.me?.user_id)
    : null;
  return (
  <>
    <MenuItem
      icon={MessageIcon}
      onAction={() => store.navigate({ view: 'dms', conversationId: convo.id })}
    >
      Open
    </MenuItem>
    {peerId ? (
      <MenuItem icon={UserIcon} onAction={() => openFullProfile(modal, peerId)}>
        View profile
      </MenuItem>
    ) : null}
    <MenuItem
      icon={ListIcon}
      onAction={() => modal.open((c) => (
        <ConversationDialog
          convo={convo}
          close={c}
          refresh={() => store.refreshConversations()}
        />
      ))}
    >
      Conversation details
    </MenuItem>
    {convo.kind === 'gc' && !convo.promoted_to ? (
      <MenuItem
        icon={ServerIcon}
        onAction={() => modal.open((c) => <PromoteDialog convo={convo} close={c} />)}
      >
        Convert to a guild
      </MenuItem>
    ) : null}
    <MenuSeparator />
    <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(convo.id, 'Conversation id')}>
      Copy conversation id
    </MenuItem>
    <MenuSeparator />
    <MenuItem
      icon={SignOutIcon}
      tone="danger"
      onAction={() => dialogs.confirm({
        title: 'Leave conversation',
        body: 'Nothing sent afterwards is readable here.',
        confirmLabel: 'Leave',
        danger: true,
        onConfirm: async () => {
          try {
            await store.leaveConversation(convo.id);
            store.navigate({ view: 'dms', conversationId: null });
          } catch (e) { reportError(e, 'Could not leave'); }
        },
      })}
    >
      Leave conversation
    </MenuItem>
  </>
  );
};

export const account = (env) => {
  const { store, t, modal, dialogs } = env;
  const presence = store.prefs.presence || 'online';
  const current = PRESENCE[presence] || PRESENCE.online;
  const hasCustom = !!(store.prefs.status?.text || '').trim();
  const accounts = store.accounts?.() || [];
  const others = accounts.filter((a) => a.user_id !== store.me?.user_id);
  const settings = (initial) => modal.open(
    (c) => <UserSettings close={c} initial={initial} />, { fullscreen: true },
  );

  return (
    <>
      <AccountCard />
      <MenuItem
        icon={EmojiIcon}
        onAction={() => modal.open((c) => <CustomStatusDialog close={c} />)}
      >
        {hasCustom ? 'Edit custom status' : 'Set a custom status'}
      </MenuItem>
      <MenuSub label={subLabel(current.icon, current.label)}>
        <MenuSection title="Active status">
          {PRESENCE_STATES.map((key) => (
            <MenuItem
              key={key}
              icon={PRESENCE[key].icon}
              onAction={() => store.setPresence({ status: key })}
            >
              {PRESENCE[key].label}
              {PRESENCE[key].note ? (
                <span className="text-muted">{` \u2014 ${PRESENCE[key].note}`}</span>
              ) : null}
            </MenuItem>
          ))}
          <PrivacyNote
            className="privacy-note--menu"
            head={t('privacy.presence.invisible')}
          />
        </MenuSection>
      </MenuSub>
      <MenuItem icon={EditIcon} onAction={() => settings('profile')}>
        Edit profile
      </MenuItem>
      <MenuSeparator />
      <MenuSub label={subLabel(SwitchAccountIcon, 'Switch accounts')}>
        {others.map((a) => (
          <MenuItem key={a.user_id} onAction={() => store.switchAccount(a.user_id)}>
            <span className="flex min-w-0 items-center gap-2">
              <AccountFace account={a} size="xxs" />
              <span className="truncate">{a.card?.name || shortName(a.user_id)}</span>
              <span className="truncate text-muted">{a.user_id}</span>
            </span>
          </MenuItem>
        ))}
        {others.length ? <MenuSeparator /> : null}
        {accounts.length < MAX_ACCOUNTS ? (
          <MenuItem icon={PlusIcon} onAction={() => store.addAccount()}>
            Add an account
          </MenuItem>
        ) : null}
        <MenuItem icon={UserIcon} onAction={() => modal.open((c) => <AccountsDialog close={c} />)}>
          Manage accounts
        </MenuItem>
      </MenuSub>
      <MenuSub label={subLabel(AdvancedIcon, 'Advanced')}>
        <MenuItem
          icon={CopyIcon}
          onAction={() => copyToClipboard(store.me?.user_id || '', 'Your user ID')}
        >
          Copy user ID
        </MenuItem>
        <MenuItem icon={KeyIcon} onAction={() => settings('recovery')}>
          Manage encryption key
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={SignOutIcon}
          tone="danger"
          onAction={() => dialogs.confirm({
            title: 'Sign out',
            body: 'Conversations close on this device until you sign in again.',
            confirmLabel: 'Sign out',
            danger: true,
            onConfirm: () => store.signOut(),
          })}
        >
          Sign out
        </MenuItem>
      </MenuSub>
    </>
  );
};
