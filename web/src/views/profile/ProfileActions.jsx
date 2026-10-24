import { useRef, useState } from 'react';
import {
  BanIcon, Button, CheckIcon, ClockIcon, CloseIcon, CopyIcon, EditIcon,
  FullscreenIcon, IconButton, KeyIcon, MenuButton, MenuItem, MenuSeparator, MessageIcon, MoreIcon,
  FriendPendingFilledIcon, FriendsFilledIcon, AddFriendFilledIcon, PhoneIcon, PhoneOffIcon, RemoveFriendIcon, ShieldIcon, TagIcon, useDialogs,
} from '../../components/index.js';
import { useModal } from '../../hooks/useModal.jsx';
import { useVoice } from '../../hooks/useVoice.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { UserSettings } from '../settings.jsx';
import { ModerationDialog } from './ModerationDialog.jsx';
import { publicProfileLink } from '../PublicProfileLanding.jsx';
import { RolePanel, useRolePanel } from './RoleChips.jsx';
import { requestNote } from './ProfileFacts.jsx';

export function EditProfileButton({ className }) {
  const modal = useModal();
  return (
    <Button
      variant="secondary"
      className={className}
      title="Edit your profile"
      onClick={() => modal.open(
        (closeSettings) => <UserSettings close={closeSettings} initial="profile" />,
        { fullscreen: true },
      )}
    >
      <EditIcon className="size-4" />
      Edit profile
    </Button>
  );
}

export function ProfileActions({
  store, userId, guildId, displayName, isMe, surface, close, expand, openVerify,
  friendship, dm, mayModerate, showTrust, verification, setVerification,
  roles, roleBusy, setRole, mayManageRoles,
}) {
  const full = surface === 'full';
  const modal = useModal();
  const dialogs = useDialogs();
  const voice = useVoice();
  const [acting, setActing] = useState(false);

  const onCall = Boolean(dm && voice.channelId === dm.id);
  const callLive = Boolean(dm && (store.voice.get(dm.id) || []).length);
  const [calling, setCalling] = useState(false);

  const toggleCall = async () => {
    if (onCall) { voice.leave(dm.id); return; }
    setCalling(true);
    try {
      const convo = dm || await store.startConversation([userId]);
      const id = convo.id || convo.conversation_id;
      close();
      store.navigate({ view: 'dms', conversationId: id });
      await voice.join(id);
    } catch (e) {
      reportError(e, callLive ? 'Could not join that call' : 'Could not start that call');
    } finally { setCalling(false); }
  };

  const friendAction = isMe || friendship === 'accepted' || friendship === 'blocked'
    ? null
    : friendship === 'pending_in'
      ? {
        icon: FriendsFilledIcon,
        label: 'Accept',
        title: `Accept ${displayName}'s friend request`,
        run: () => store.acceptFriend(userId),
        said: 'Friends now.',
        failed: 'Could not accept that request',
      }
      : friendship === 'pending_out'
        ? { icon: FriendPendingFilledIcon, label: 'Request sent', title: 'Friend request sent', run: null, pending: true }
        : {
          icon: AddFriendFilledIcon,
          label: 'Add friend',
          title: `Add ${displayName} as a friend`,
          run: () => store.addFriend(userId),
          said: 'Request sent.',
          failed: 'Could not send that request',
        };
  const FriendIcon = friendAction?.icon;

  const act = async () => {
    if (!friendAction?.run) return;
    setActing(true);
    try {
      await friendAction.run();
      toast(friendAction.said);
    } catch (e) {
      reportError(e, friendAction.failed);
    } finally { setActing(false); }
  };

  const callTitle = onCall
    ? 'Leave call'
    : callLive ? `Join the call with ${displayName}` : `Call ${displayName}`;
  const CallGlyph = onCall ? PhoneOffIcon : PhoneIcon;

  const mayMessage = !isMe && friendship !== 'blocked';
  const [opening, setOpening] = useState(false);
  const openDm = async () => {
    setOpening(true);
    try {
      const convo = dm || await store.startConversation([userId]);
      const id = convo.id || convo.conversation_id;
      close();
      store.navigate({ view: 'dms', conversationId: id });
    } catch (e) {
      reportError(e, 'Could not open that conversation');
    } finally { setOpening(false); }
  };

  const rolePanel = useRolePanel();
  const moreRef = useRef(null);
  const mayRole = Boolean(guildId && mayManageRoles && setRole);

  const trustStatus = showTrust ? verification.status : null;
  const trustRequest = showTrust ? verification.request || null : null;

  const retract = async () => {
    setActing(true);
    try {
      await store.removeFriend(userId);
      toast('Request cancelled.');
    } catch (e) {
      reportError(e, 'Could not cancel that request');
    } finally { setActing(false); }
  };

  const friendButton = friendAction?.pending ? (
    <MenuButton
      label={friendAction.title}
      placement="bottom end"
      className="pc__icon"
      isDisabled={acting}
      content={(
        <MenuItem icon={CloseIcon} tone="danger" onAction={retract}>
          Cancel request
        </MenuItem>
      )}
    >
      <FriendIcon className={full ? 'size-5' : 'size-4'} />
    </MenuButton>
  ) : friendAction ? (
    <IconButton
      title={friendAction.title}
      className="pc__icon"
      disabled={acting || !friendAction.run}
      onClick={act}
    >
      <FriendIcon className={full ? 'size-5' : 'size-4'} />
    </IconButton>
  ) : null;

  const removeFriendItem = (
    <MenuItem
      icon={RemoveFriendIcon}
      tone="danger"
      onAction={() => dialogs.confirm({
        title: `Remove ${displayName}?`,
        body: `${userId} is not told which of you ended it.`,
        confirmLabel: 'Remove',
        onConfirm: async () => {
          try { await store.removeFriend(userId); toast('Removed.'); }
          catch (e) { reportError(e, 'Could not update that'); }
        },
      })}
    >
      Remove friend
    </MenuItem>
  );

  const friendsButton = surface === 'panel' && friendship === 'accepted' ? (
    <MenuButton label="Friends" placement="bottom end" className="pc__icon" content={removeFriendItem}>
      <FriendsFilledIcon className="size-4" />
    </MenuButton>
  ) : null;

  const callButton = isMe || friendship === 'blocked' || surface === 'panel' ? null : (
    <IconButton
      title={callTitle}
      className="pc__icon"
      data-live={callLive && !onCall ? 'true' : undefined}
      data-danger={onCall ? 'true' : undefined}
      disabled={calling}
      onClick={toggleCall}
    >
      <CallGlyph className={full ? 'size-5' : 'size-4'} />
    </IconButton>
  );

  const more = (
    <span ref={moreRef} className="pc__more-wrap">
      <MenuButton
        label="More actions"
        placement="bottom end"
        className="pc__more pc__icon"
        content={
          <>
            <MenuItem icon={CopyIcon} onAction={() => copyToClipboard(userId, 'Username')}>
              Copy username
            </MenuItem>
            <MenuItem
              icon={CopyIcon}
              onAction={() => copyToClipboard(publicProfileLink(userId), 'Profile link')}
            >
              Copy profile link
            </MenuItem>
            {mayRole || (guildId && mayModerate && !isMe) ? <MenuSeparator /> : null}
            {mayRole ? (
              <MenuItem
                icon={TagIcon}
                onAction={() => setTimeout(() => rolePanel.toggle(moreRef.current), 0)}
              >
                Manage roles
              </MenuItem>
            ) : null}
            {guildId && mayModerate && !isMe ? (
              <MenuItem
                icon={ShieldIcon}
                onAction={() => modal.open((closeMod) => (
                  <ModerationDialog
                    guildId={guildId}
                    userId={userId}
                    close={closeMod}
                    closeParent={close}
                  />
                ))}
              >
                Moderate
              </MenuItem>
            ) : null}
            {trustStatus && trustStatus !== 'verified' && trustStatus !== 'unsigned' ? (
              <>
                <MenuSeparator />
                {trustRequest ? (
                  <MenuItem icon={ClockIcon} isDisabled title={requestNote(trustRequest)}>
                    Verification requested
                  </MenuItem>
                ) : (
                  <MenuItem icon={KeyIcon} onAction={openVerify}>
                    {trustStatus === 'changed' ? 'Verify again' : `Verify ${displayName}`}
                  </MenuItem>
                )}
              </>
            ) : null}
            {trustStatus === 'verified' ? (
              <>
                <MenuSeparator />
                <MenuItem icon={KeyIcon} onAction={openVerify}>Verify again</MenuItem>
                <MenuItem
                  icon={CloseIcon}
                  onAction={async () => {
                    try {
                      await store.trust.withdraw(userId);
                      setVerification({ ...verification, status: 'unverified' });
                      toast('Verification withdrawn.');
                    } catch (e) { reportError(e, 'Could not withdraw'); }
                  }}
                >
                  Withdraw verification
                </MenuItem>
              </>
            ) : null}
            {isMe ? null : (
              <>
                <MenuSeparator />
                {friendship === 'accepted' && !friendsButton ? removeFriendItem : null}
                {friendship === 'blocked' ? (
                  <MenuItem
                    icon={CheckIcon}
                    onAction={async () => {
                      try { await store.unblockUser(userId); toast('Unblocked.'); }
                      catch (e) { reportError(e, 'Could not unblock'); }
                    }}
                  >
                    Unblock
                  </MenuItem>
                ) : (
                  <MenuItem
                    icon={BanIcon}
                    tone="danger"
                    onAction={() => dialogs.confirm({
                      title: `Block ${displayName}?`,
                      body: 'They cannot message you, and you will not see them.',
                      confirmLabel: 'Block',
                      onConfirm: async () => {
                        try { await store.blockUser(userId); toast('Blocked.'); close(); }
                        catch (e) { reportError(e, 'Could not block'); }
                      },
                    })}
                  >
                    Block
                  </MenuItem>
                )}
              </>
            )}
          </>
        }
      >
        <MoreIcon className={full ? 'size-5' : 'size-4'} />
      </MenuButton>
      <RolePanel
        panel={rolePanel}
        store={store}
        guildId={guildId}
        held={roles || []}
        busy={roleBusy}
        onToggle={setRole}
      />
    </span>
  );

  if (!full) {
    return (
      <div className="pc__top-actions">
        {friendButton}
        {friendsButton}
        {callButton}
        {surface === 'panel' ? null : (
          <IconButton title="Open full profile" className="pc__icon" onClick={() => expand()}>
            <FullscreenIcon className="size-4" />
          </IconButton>
        )}
        {more}
      </div>
    );
  }

  return (
    <div className="pc__actions">
      {isMe ? <EditProfileButton className="pc__actions-primary" /> : null}
      {mayMessage ? (
        <Button
          variant="primary"
          className="pc__actions-primary pc__message"
          title={`Message ${displayName}`}
          disabled={opening}
          onClick={openDm}
        >
          <MessageIcon className="size-4" />
          Message
        </Button>
      ) : null}
      {friendButton}
      {callButton}
      {more}
    </div>
  );
}
