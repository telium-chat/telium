import { useEffect, useState } from 'react';
import { Button, CloseIcon, IconButton } from '../../components/index.js';
import { useModal } from '../../hooks/useModal.jsx';
import { useProfileCard } from '../../hooks/useProfileCard.js';
import { profileActivitiesFor } from '../../lib/voice-activity.js';
import { VerifyDialog } from '../dialogs/VerifyDialog.jsx';
import { Composer } from './ProfileComposer.jsx';
import { ProfileAbout } from './ProfileAbout.jsx';
import { EditProfileButton, ProfileActions } from './ProfileActions.jsx';
import { ProfileHeader } from './ProfileHeader.jsx';
import { ProfileTabs } from './ProfileTabs.jsx';
import { useMutuals } from './useMutuals.js';
import { useProfileTarget } from './useProfileTarget.js';

export function ProfileBody({
  guildId, userId, close, surface = 'popover', initialTab = 'activity', nameId,
}) {
  const full = surface === 'full';
  const modal = useModal();
  const profiles = useProfileCard();
  const {
    store, member, guild, live, domain, isMe, guest, identity, displayName, alias,
    avatarRef, accent, theme, bannerRef, mediaBase, mediaOrigin,
    roles, roleBusy, setRole, verification, setVerification, mayManageRoles, mayModerate,
  } = useProfileTarget(guildId, userId);
  const { mutualFriends, mutualGuilds, reserveMutuals } = useMutuals(store, userId, isMe);
  const [tab, setTab] = useState(initialTab);

  useEffect(() => {
    setTab(initialTab);
    // Only a change of person resets the tab, not a new `initialTab`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const expand = (openOn = 'activity') => {
    close();
    openFullProfile(modal, userId, { guildId, openOn });
  };

  const openPerson = (otherId, anchor) => {
    if (full) close();
    profiles.open(otherId, { guildId, anchor });
  };

  const openGuild = (otherGuildId) => {
    const channels = store.channelsOf(otherGuildId);
    const first = channels.find((c) => c.type === 'text')
      || channels.find((c) => c.type !== 'category');
    close();
    store.navigate({ view: 'chat', guildId: otherGuildId, channelId: first?.id || null });
  };

  const openVerify = () => modal.open((closeVerify) => (
    <VerifyDialog userId={userId} close={closeVerify} />
  ));

  const activities = profileActivitiesFor(store, userId, live);
  const timedOut = member?.timeout_until && member.timeout_until > Date.now();
  const friend = store.friends.get(userId);
  const friendship = friend?.state;
  const friendSince = friendship === 'accepted'
    ? (friend.updated_at || friend.created_at || null)
    : null;
  const showTrust = Boolean(store.trust && !isMe && verification);

  const dm = isMe ? null : store.dmWith(userId);

  const mayMessage = !isMe && friendship !== 'blocked';
  const showRoles = Boolean(guildId && (roles.length || mayManageRoles));
  const mutualsShown = Boolean(
    (mutualFriends?.friends || []).length || (mutualGuilds?.guilds || []).length,
  );

  const facts = (
    <ProfileAbout
      store={store}
      guildId={guildId}
      guild={guild}
      member={member}
      identity={identity}
      domain={domain}
      displayName={displayName}
      surface={surface}
      mutualFriends={mutualFriends}
      mutualGuilds={mutualGuilds}
      mutualsShown={mutualsShown}
      reserveMutuals={reserveMutuals}
      expand={expand}
      showRoles={showRoles}
      roles={roles}
      mayManageRoles={mayManageRoles}
      roleBusy={roleBusy}
      setRole={setRole}
      activities={activities}
      friendSince={friendSince}
      timedOut={timedOut}
    />
  );

  const actions = (
    <ProfileActions
      store={store}
      userId={userId}
      guildId={guildId}
      displayName={displayName}
      isMe={isMe}
      surface={surface}
      close={close}
      expand={expand}
      openVerify={openVerify}
      friendship={friendship}
      dm={dm}
      mayModerate={mayModerate}
      showTrust={showTrust}
      verification={verification}
      setVerification={setVerification}
      roles={roles}
      roleBusy={roleBusy}
      setRole={setRole}
      mayManageRoles={mayManageRoles}
    />
  );

  return (
    <div
      className="pc"
      data-surface={surface}
      data-full={full ? 'true' : 'false'}
      data-themed={theme ? 'true' : undefined}
      style={themeStyle(accent, theme)}
    >
      {full ? (
        <IconButton title="Close" onClick={close} className="pc__close">
          <CloseIcon className="size-4" />
        </IconButton>
      ) : null}

      <div className="pc__left">
        <ProfileHeader
          store={store}
          userId={userId}
          displayName={displayName}
          nameId={nameId}
          surface={surface}
          accent={accent}
          bannerRef={bannerRef}
          mediaBase={mediaBase}
          mediaOrigin={mediaOrigin}
          avatarRef={avatarRef}
          live={live}
          isMe={isMe}
          friendship={friendship}
          timedOut={timedOut}
          guest={guest}
          domain={domain}
          alias={alias}
          identity={identity}
          expand={expand}
          showTrust={showTrust}
          verification={verification}
          onVerify={openVerify}
          bannerActions={full ? null : actions}
        />

        {full ? actions : null}
        {facts}

        {!full && mayMessage && surface !== 'panel' ? (
          <Composer
            store={store}
            userId={userId}
            displayName={displayName}
            dm={dm}
            close={close}
          />
        ) : null}
        {!full && isMe ? <EditProfileButton className="pc__edit" /> : null}
        {surface === 'panel' && !isMe ? (
          <Button variant="secondary" className="pc__edit" onClick={() => expand()}>
            View full profile
          </Button>
        ) : null}
      </div>

      {full ? (
        <ProfileTabs
          store={store}
          tab={tab}
          setTab={setTab}
          isMe={isMe}
          mutualFriends={mutualFriends}
          mutualGuilds={mutualGuilds}
          openPerson={openPerson}
          openGuild={openGuild}
          activities={activities}
          displayName={displayName}
          userId={userId}
          avatarRef={avatarRef}
        />
      ) : null}
    </div>
  );
}

export function openFullProfile(modal, userId, { guildId, openOn = 'activity' } = {}) {
  modal.open(
    (closeFull) => (
      <ProfileBody
        guildId={guildId}
        userId={userId}
        close={closeFull}
        surface="full"
        initialTab={openOn}
      />
    ),
    { bare: true, wide: true },
  );
}

export function themeStyle(accent, theme) {
  return theme
    ? { '--pc-accent': accent, '--pc-theme-top': theme[0], '--pc-theme-bottom': theme[1] }
    : { '--pc-accent': accent };
}
