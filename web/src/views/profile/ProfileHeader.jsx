import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import {
  Avatar, BotBadge, EmojiText, FriendsFilledIcon, Pill, StatusText
} from '../../components/index.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { mediaUrl } from '../../lib/media.js';
import { shortName } from '../../lib/util.js';
import { TrustMark } from './ProfileFacts.jsx';

export function trustMarkShown(showTrust, verification) {
  if (!showTrust || !verification) return false;
  return verification.status === 'verified' || verification.status === 'changed';
}

export function ProfileHeader({
  store, userId, displayName, nameId, surface, accent, bannerRef, mediaBase, mediaOrigin,
  avatarRef, live, isMe, friendship, timedOut, guest, domain, alias, identity, expand,
  showTrust, verification, onVerify, bannerActions,
}) {
  const full = surface === 'full';
  const status = live.custom_status || '';
  const presence = live.status || null;
  const local = shortName(userId);

  const avatar = (
    <Avatar
      id={userId}
      name={displayName}
      size={full ? '2xl' : 'xl'}
      mediaRef={avatarRef}
      base={mediaBase}
      mediaOrigin={mediaOrigin}
      presence={presence}
    />
  );

  const face = full ? avatar : (
    <button
      type="button"
      className="pc__avatar-open focus-outside"
      aria-label={`Open ${displayName}'s full profile`}
      title="Open full profile"
      onClick={() => expand()}
    >
      {avatar}
    </button>
  );

  return (
    <>
      <div className="pc__banner" style={{ background: accent }}>
        {bannerRef && mediaBase ? (
          <AnimatedImage
            src={mediaUrl(mediaBase, bannerRef, mediaOrigin)}
            alt=""
            animated
            className="size-full object-cover"
          />
        ) : null}
      </div>

      <div className="pc__face">
        <div className="pc__cut" style={{ '--presence-ring': 'var(--pc-fill)' }}>
          {face}
        </div>
        {status ? (
          <p className="pc__bubble">
            <StatusText store={store}>{status}</StatusText>
          </p>
        ) : null}

        <div className="pc__tags">
          {isMe ? <Pill>You</Pill> : null}
          {friendship === 'blocked' ? <Pill tone="danger">Blocked</Pill> : null}
          {timedOut ? <Pill tone="warn">Timed out</Pill> : null}
        </div>
      </div>

      <div className="pc__head">
        <div className="pc__ident">
          <h2 className="pc__name" id={nameId}><EmojiText>{displayName}</EmojiText></h2>
          <BotBadge userId={userId} className="ms-1" />
        </div>

        <div className="pc__meta">
          <button
            type="button"
            className="pc__handle"
            data-guest={guest ? 'true' : 'false'}
            title={`${userId} — copy`}
            aria-label={`${userId}, copy username`}
            onClick={() => copyToClipboard(userId, 'Username copied.')}
          >
            <span className="pc__handle-local">{full ? `@${local}` : local}</span>
            <span className="pc__handle-domain">{`:${domain}`}</span>
          </button>
          {friendship === 'accepted' || trustMarkShown(showTrust, verification) ? (
            <span className="pc__badges">
              {friendship === 'accepted' ? (
                <span
                  className="pc__friend-mark"
                  role="img"
                  aria-label={`You and ${displayName} are friends`}
                  title="Friend"
                >
                  <FriendsFilledIcon className="size-3.5" />
                </span>
              ) : null}
              {trustMarkShown(showTrust, verification) ? (
                <TrustMark verification={verification} onVerify={onVerify} />
              ) : null}
            </span>
          ) : null}
          {identity?.pronouns ? (
            <span className="pc__fact"><span>{identity.pronouns}</span></span>
          ) : null}
          {alias ? <span className="pc__fact"><span>{`aka ${alias}`}</span></span> : null}
        </div>
      </div>

      {bannerActions}
    </>
  );
}
