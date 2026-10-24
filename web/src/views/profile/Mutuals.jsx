import { useModal } from '../../hooks/useModal.jsx';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import {
  Avatar, Button, EmojiText, EmptyState, Hint, MembersIcon, ServerIcon, StatusText,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { remoteMediaOrigin } from '../../lib/media.js';
import { shortName, tint } from '../../lib/util.js';
import { MutualFriendGraphDialog } from '../MutualFriendGraphDialog.jsx';

function LookupsOff({ icon, titleKey, bodyKey }) {
  const t = useT();
  return (
    <div className="pc__panel-empty">
      <EmptyState icon={icon} title={t(titleKey)}>
        {t(bodyKey)}
      </EmptyState>
    </div>
  );
}

const FACES = 3;

function GuildMark({ store, guild }) {
  const api = store.apiForGuild(guild.id);
  const icon = guild.icon_ref && api?.base
    ? `${api.base}/_telium/v1/media/${guild.icon_ref}`
    : null;
  if (icon) return <AnimatedImage src={icon} alt="" animated className="pc__mark" />;
  return (
    <span className="pc__mark" style={{ background: tint(guild.id) }}>
      {(guild.name || '?').slice(0, 2).toUpperCase()}
    </span>
  );
}

export function MutualLine({ store, friends, guilds, onFriends, onGuilds }) {
  const people = friends?.friends || [];
  const places = guilds?.guilds || [];
  if (!people.length && !places.length) return null;

  const saidPeople = `${people.length} mutual friend${people.length === 1 ? '' : 's'}`;
  const saidPlaces = `${places.length} mutual server${places.length === 1 ? '' : 's'}`;

  return (
    <div className="pc__mutuals">
      {people.length ? (
        <button type="button" className="pc__mutual" onClick={onFriends}>
          <span className="pc__faces" aria-hidden="true">
            {people.slice(0, FACES).map((friend) => (
              <Avatar
                key={friend.user_id}
                id={friend.user_id}
                name={friend.display_name}
                size="xxs"
                mediaRef={friend.avatar_ref}
                base={store.home?.base}
                mediaOrigin={remoteMediaOrigin(friend.user_id, store.home?.domain)}
              />
            ))}
          </span>
          <span className="pc__mutual-text">{saidPeople}</span>
        </button>
      ) : null}
      {people.length && places.length ? (
        <span className="pc__mutual-dot" aria-hidden="true">·</span>
      ) : null}
      {places.length ? (
        <button type="button" className="pc__mutual" onClick={onGuilds}>
          {people.length ? null : (
            <span className="pc__marks" aria-hidden="true">
              {places.slice(0, FACES).map((guild) => (
                <GuildMark key={guild.id} store={store} guild={guild} />
              ))}
            </span>
          )}
          <span className="pc__mutual-text">{saidPlaces}</span>
        </button>
      ) : null}
    </div>
  );
}

export function MutualSlot() {
  return (
    <div className="pc__mutuals" data-reserved="true" aria-hidden="true">
      <span className="pc__mutual">
        <span className="pc__faces">
          <span className="pc__mark" />
        </span>
        <span className="pc__mutual-text">&nbsp;</span>
      </span>
    </div>
  );
}

export function MutualFriendsPanel({ store, value, target, onOpenPerson }) {
  const modal = useModal();
  if (value?.off) {
    return (
      <LookupsOff
        icon={MembersIcon}
        titleKey="settings.lookups.off.friendsTitle"
        bodyKey="settings.lookups.off.body"
      />
    );
  }
  if (value === undefined || value === null) {
    return <p className="pc__empty">Finding mutual friends…</p>;
  }
  if (value.error) {
    return <Hint>Could not load mutual friends right now.</Hint>;
  }
  const rows = value.friends || [];
  if (!rows.length) {
    return (
      <div className="pc__panel-empty">
        <EmptyState icon={MembersIcon} title="No friends in common">
          {'Nobody you are both friends with — yet.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <>
      {rows.map((friend) => (
        <button
          key={friend.user_id}
          type="button"
          className="pc__row"
          aria-label={`Open ${friend.display_name || shortName(friend.user_id)}’s profile`}
          title={`Open ${friend.display_name || shortName(friend.user_id)}’s profile`}
          onClick={(event) => onOpenPerson(friend.user_id, event.currentTarget)}
        >
          <Avatar
            id={friend.user_id}
            name={friend.display_name}
            size="chat"
            mediaRef={friend.avatar_ref}
            base={store.home?.base}
            mediaOrigin={remoteMediaOrigin(friend.user_id, store.home?.domain)}
          />
          <span className="pc__row-text">
            <span className="pc__row-name">
              <EmojiText>{friend.display_name || shortName(friend.user_id)}</EmojiText>
            </span>
            {store.presence.get(friend.user_id)?.custom_status ? (
              <span className="pc__row-sub">
                <StatusText store={store}>
                  {store.presence.get(friend.user_id).custom_status}
                </StatusText>
              </span>
            ) : null}
          </span>
        </button>
      ))}
      <Button
        variant="ghost"
        className="mt-1 w-full"
        onClick={() => modal.open((closeGraph) => (
          <MutualFriendGraphDialog
            close={closeGraph}
            store={store}
            target={target}
            mutuals={rows}
            onOpenPerson={onOpenPerson}
          />
        ), { wide: true })}
      >
        See how you are connected
      </Button>
      {value.complete === false ? (
        <p className="pc__note">
          Some friends’ homeservers could not be reached, so this may be incomplete.
        </p>
      ) : null}
    </>
  );
}

export function MutualGuildsPanel({ store, value, onOpenGuild }) {
  if (value?.off) {
    return (
      <LookupsOff
        icon={ServerIcon}
        titleKey="settings.lookups.off.guildsTitle"
        bodyKey="settings.lookups.off.body"
      />
    );
  }
  if (value === undefined || value === null) {
    return <p className="pc__empty">Finding mutual servers…</p>;
  }
  if (value.error) {
    return <Hint>Could not load mutual servers right now.</Hint>;
  }
  const rows = value.guilds || [];
  if (!rows.length) {
    return (
      <div className="pc__panel-empty">
        <EmptyState icon={ServerIcon} title="No servers in common">
          {'You are not in any of the same servers.'}
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      {rows.map((guild) => {
        const api = store.apiForGuild(guild.id);
        const icon = guild.icon_ref && api?.base
          ? `${api.base}/_telium/v1/media/${guild.icon_ref}`
          : null;
        return (
          <button
            key={guild.id}
            type="button"
            className="pc__row"
            aria-label={`Open ${guild.name}`}
            title={guild.domain ? `Open ${guild.name} (${guild.domain})` : `Open ${guild.name}`}
            onClick={() => onOpenGuild(guild.id)}
          >
            {icon ? (
              <AnimatedImage src={icon} alt="" animated className="pc__guild-mark" />
            ) : (
              <span
                aria-hidden="true"
                className="pc__guild-mark"
                style={{ background: tint(guild.id) }}
              >
                {(guild.name || '?').slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="pc__row-text">
              <span className="pc__row-name">{guild.name}</span>
            </span>
          </button>
        );
      })}
      {value.complete === false ? (
        <p className="pc__note">
          Some guild servers could not be reached, so this may be incomplete.
        </p>
      ) : null}
    </>
  );
}
