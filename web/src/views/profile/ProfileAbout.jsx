import { RichActivityCard, VoiceActivityCard } from '../../components/RichActivityCard.jsx';
import { BioText, Hint, Notice } from '../../components/index.js';
import { MutualLine, MutualSlot } from './Mutuals.jsx';
import { FriendSince, JoinDates, Section } from './ProfileFacts.jsx';
import { RoleChips } from './RoleChips.jsx';

export function ProfileAbout({
  store, guildId, guild, member, identity, domain, displayName, surface,
  mutualFriends, mutualGuilds, mutualsShown, reserveMutuals, expand,
  showRoles, roles, mayManageRoles, roleBusy, setRole, activities, friendSince, timedOut,
}) {
  const full = surface === 'full';
  const roomy = surface !== 'popover';
  const mutualsPending = mutualFriends === undefined && mutualGuilds === undefined;
  const holdingMutuals = Boolean(reserveMutuals && !full && !mutualsShown && mutualsPending);
  const activityShown = Boolean(!full && (activities?.voice || activities?.rich?.length));
  const datesShown = Boolean(roomy && (identity?.created_at || member?.joined_at));

  const bodyHas = Boolean(
    identity?.bio
    || (!full && mutualsShown)
    || activityShown
    || holdingMutuals
    || datesShown
    || (roomy && friendSince)
    || showRoles || timedOut || identity === false,
  );

  if (!bodyHas) return null;

  const bio = identity?.bio || '';
  const bioClamped = surface === 'panel' && (bio.length > 180 || bio.split('\n').length > 4);

  const roleChips = showRoles ? (
    <RoleChips
      store={store}
      guildId={guildId}
      displayName={displayName}
      roles={roles}
      mayManage={mayManageRoles}
      busy={roleBusy}
      onToggle={setRole}
    />
  ) : null;

  return (
    <div className="pc__body">
      {full || !mutualsShown ? null : (
        <MutualLine
          store={store}
          friends={mutualFriends}
          guilds={mutualGuilds}
          onFriends={() => expand('friends')}
          onGuilds={() => expand('guilds')}
        />
      )}
      {holdingMutuals ? <MutualSlot /> : null}

      {identity?.bio ? (
        <div className="pc__prose" data-clamped={bioClamped ? 'true' : undefined}>
          <BioText>{identity.bio}</BioText>
        </div>
      ) : null}
      {bioClamped ? (
        <button type="button" className="pc__more-link" onClick={() => expand()}>View full bio</button>
      ) : null}

      {activityShown ? (
        <div className="grid gap-2">
          {activities.voice ? <VoiceActivityCard activity={activities.voice} /> : null}
          {(activities.rich || []).map((activity) => (
            <RichActivityCard
              key={`${activity.type}:${activity.application_id || ''}:${activity.name}`}
              activity={activity}
            />
          ))}
        </div>
      ) : null}

      {datesShown ? (
        <Section label="Member since">
          <JoinDates store={store} guild={guild} member={member} identity={identity} />
        </Section>
      ) : null}

      {roomy && friendSince ? (
        <Section label="Friends since">
          <FriendSince since={friendSince} displayName={displayName} />
        </Section>
      ) : null}

      {roomy ? (showRoles ? <Section label="Roles">{roleChips}</Section> : null) : roleChips}

      {timedOut ? (
        <Notice tone="warn">
          {`Timed out until ${new Date(member.timeout_until).toLocaleString()}`}
        </Notice>
      ) : null}

      {identity === false ? (
        <Hint>{`Could not reach ${domain} for the rest of this profile.`}</Hint>
      ) : null}
    </div>
  );
}
