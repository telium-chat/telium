import { RichActivityCard, VoiceActivityCard } from '../../components/RichActivityCard.jsx';
import { AppsIcon, EmojiText, EmptyState } from '../../components/index.js';
import { MutualFriendsPanel, MutualGuildsPanel } from './Mutuals.jsx';

function tabsFor(isMe, friends, guilds) {
  const count = (value, list) => (value && !value.error && !value.off ? list.length : null);
  const tabs = [['activity', 'Activity']];
  if (isMe) return tabs;
  const friendsN = count(friends, friends?.friends || []);
  const guildsN = count(guilds, guilds?.guilds || []);
  tabs.push([
    'friends',
    friendsN === null ? 'Mutual friends' : `${friendsN} mutual friend${friendsN === 1 ? '' : 's'}`,
  ]);
  tabs.push([
    'guilds',
    guildsN === null ? 'Mutual servers' : `${guildsN} mutual server${guildsN === 1 ? '' : 's'}`,
  ]);
  return tabs;
}

function TabBar({ tab, setTab, tabs }) {
  return (
    <div className="pc__tabs" role="tablist" aria-label="Profile sections">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => setTab(key)}
          className="pc__tab"
        >
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function ActivityPanel({ activities, displayName, isMe }) {
  const voice = activities?.voice || null;
  const rich = activities?.rich || [];
  if (voice || rich.length) {
    return (
      <div className="grid gap-2">
        {voice ? <VoiceActivityCard activity={voice} /> : null}
        {rich.map((activity) => (
          <RichActivityCard
            key={`${activity.type}:${activity.application_id || ''}:${activity.name}`}
            activity={activity}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="pc__panel-empty">
      <EmptyState icon={AppsIcon} title="Nothing right now">
        {isMe ? (
          'Voice calls you can share here, plus what you are playing, listening to or watching,'
          + ' appear while they are active.'
        ) : (
          <EmojiText>
            {`${displayName} is not sharing an activity you can see right now.`}
          </EmojiText>
        )}
      </EmptyState>
    </div>
  );
}

export function ProfileTabs({
  store, tab, setTab, isMe, mutualFriends, mutualGuilds, openPerson, openGuild,
  activities, displayName, userId, avatarRef,
}) {
  const tabs = tabsFor(isMe, mutualFriends, mutualGuilds);
  const active = tabs.some(([key]) => key === tab) ? tab : tabs[0][0];

  return (
    <div className="pc__right">
      <TabBar tab={active} setTab={setTab} tabs={tabs} />
      <div className="pc__panel" role="tabpanel">
        {active === 'friends' ? (
          <MutualFriendsPanel
            store={store}
            value={mutualFriends}
            onOpenPerson={openPerson}
            target={{ user_id: userId, display_name: displayName, avatar_ref: avatarRef }}
          />
        ) : active === 'guilds' ? (
          <MutualGuildsPanel store={store} value={mutualGuilds} onOpenGuild={openGuild} />
        ) : (
          <ActivityPanel activities={activities} displayName={displayName} isMe={isMe} />
        )}
      </div>
    </div>
  );
}
