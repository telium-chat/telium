import { useEffect, useMemo, useState } from 'react';
import { Api, discover } from '../lib/api.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { mediaUrl } from '../lib/media.js';
import { isNativeShell } from '../lib/platform.js';
import { AnimatedImage } from '../components/AnimatedImage.jsx';
import { RichActivityCard } from '../components/RichActivityCard.jsx';
import { activityLine, colourOf, domainOf, shortName, themeOf, tint } from '../lib/util.js';
import { themeStyle } from './profile/ProfileBody.jsx';
import { richActivitiesOf } from '../lib/activity.js';
import { useMediaSrc } from '../hooks/useMediaSrc.jsx';
import { useStore } from '../hooks/useStore.jsx';
import { reportError, toast } from '../hooks/useToast.jsx';
import { Section } from './profile/ProfileFacts.jsx';
import {
  AddFriendIcon, Avatar, BioText, Button, CheckIcon, MessageIcon, PRESENCE,
  Skeleton, StatusText, TeliumMark,
} from '../components/index.js';

async function loadPublicProfile(initialUserId) {
  let userId = initialUserId;
  const seen = new Set();

  for (let hop = 0; hop < 5; hop += 1) {
    if (seen.has(userId)) throw new Error('This account migration points in a loop.');
    seen.add(userId);

    const domain = domainOf(userId);
    if (!domain) throw new Error('That is not a valid Telium user address.');

    const home = await discover(domain);
    const api = new Api({ base: home.api, domain: home.server_name || domain });
    const status = await api.userStatus(userId);

    if (status?.status === 'moved' && status.moved_to) {
      userId = status.moved_to;
      continue;
    }
    if (status?.status === 'gone') {
      throw new Error('This account is no longer available.');
    }
    if (status?.status === 'unknown') {
      throw new Error('That Telium account does not exist.');
    }
    if (status?.status === 'deactivated') {
      throw new Error('This account is deactivated.');
    }

    const page = await api.publicProfilePage(userId);
    return {
      profile: page.profile || {},
      presence: page.presence || {},
      presenceKnown: page.presence_known !== false,
      home,
      userId,
      movedFrom: userId === initialUserId ? null : initialUserId,
      accountStatus: status?.status || 'active',
    };
  }

  throw new Error('This account has moved too many times to resolve safely.');
}

export function publicProfilePath(userId) {
  return `/u/${encodeURIComponent(userId).replace(/%40/gi, '@').replace(/%3A/gi, ':')}`;
}

export function publicProfileLink(userId) {
  const webOrigin = typeof window !== 'undefined'
    && !isNativeShell
    && /^https?:$/.test(window.location.protocol)
    ? window.location.origin
    // A copied profile link names the public site, not the app host.
    : 'https://telium.chat';
  return `${webOrigin}${publicProfilePath(userId)}`;
}

function joinedLabel(createdAt) {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

function PublicProfileBrand() {
  return (
    <div className="ppl__brand">
      <TeliumMark className="size-7 shrink-0" aria-hidden="true" />
      <span className="ppl__wordmark">Telium</span>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <main className="ppl">
      <div className="ppl__frame" aria-busy="true" aria-label="Loading profile">
        <PublicProfileBrand />
        <Skeleton className="ppl__ghost-banner" />
        <div className="ppl__ghost-body">
          <div className="ppl__ghost-face">
            <Skeleton className="ppl__ghost-avatar" />
          </div>
          <Skeleton className="ppl__ghost-name" />
          <Skeleton className="ppl__ghost-handle" />
          <Skeleton className="ppl__ghost-prose" />
          <Skeleton className="ppl__ghost-prose-end" />
        </div>
      </div>
    </main>
  );
}

export function PublicProfileLanding({
  userId,
  sessionReady,
  pendingAction,
  onQueueAction,
  onRequireAuth,
  onActionHandled,
}) {
  const store = useStore();
  const [state, setState] = useState({ status: 'loading' });
  const [acting, setActing] = useState('');

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadPublicProfile(userId)
      .then((resolved) => {
        if (live) setState({ status: 'ready', ...resolved });
      })
      .catch((error) => {
        if (live) setState({
          status: 'error',
          message: error?.message || 'This profile could not be reached.',
        });
      });
    return () => { live = false; };
  }, [userId]);

  const targetUserId = state.userId || userId;
  const relation = store.friends.get(targetUserId)?.state || null;
  const isMe = store.me?.user_id === targetUserId;

  const perform = async (action) => {
    if (!store.signedIn) {
      onRequireAuth?.(action);
      return;
    }
    if (!sessionReady) {
      onQueueAction?.(action);
      return;
    }
    if (acting) return;

    setActing(action);
    try {
      if (action === 'friend') {
        const friendship = store.friends.get(targetUserId)?.state;
        if (friendship === 'accepted' || friendship === 'pending_out') {
          toast(friendship === 'accepted' ? 'You are already friends.' : 'Friend request already sent.');
        } else if (friendship === 'pending_in') {
          await store.acceptFriend(targetUserId);
          toast('Friends now.');
        } else if (friendship === 'blocked') {
          await store.unblockUser(targetUserId);
          toast('Unblocked.');
        } else {
          await store.addFriend(targetUserId);
          toast('Friend request sent.');
        }
      } else if (action === 'message') {
        let convo = store.dmWith(targetUserId);
        if (convo?.request_state === 'pending') {
          convo = await store.acceptMessageRequest(convo.id) || convo;
        }
        if (!convo) convo = await store.startConversation([targetUserId]);
        onActionHandled?.();
        store.navigate({ view: 'dms', conversationId: convo.id || convo.conversation_id });
        return;
      }
      onActionHandled?.();
    } catch (error) {
      reportError(error, action === 'friend' ? 'Could not send that friend request' : 'Could not open a conversation');
    } finally {
      setActing('');
    }
  };

  useEffect(() => {
    if (state.status !== 'ready'
      || !pendingAction || !sessionReady || !store.signedIn || acting) return;
    perform(pendingAction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAction, sessionReady, store.signedIn, state.status, targetUserId]);

  const profile = state.profile;
  const homeBase = state.home?.api || '';
  const accent = colourOf(profile?.accent_color) || tint(targetUserId);
  const theme = themeOf(profile?.theme_colors);
  const banner = useMediaSrc(
    profile?.banner_ref && homeBase ? mediaUrl(homeBase, profile.banner_ref) : null,
    { purpose: 'profile banner' },
  );
  const avatar = useMediaSrc(
    profile?.avatar_ref && homeBase ? mediaUrl(homeBase, profile.avatar_ref) : null,
    { purpose: 'profile picture' },
  );
  const displayName = profile?.display_name || shortName(targetUserId);
  const publicPresence = state.presence || {};
  const presenceKnown = state.presenceKnown !== false;
  const presenceShape = publicPresence.status ? PRESENCE[publicPresence.status] : null;
  const PresenceIcon = presenceShape?.icon;
  const joined = joinedLabel(profile?.created_at);
  const richActivities = richActivitiesOf(publicPresence);
  const plainActivity = richActivities.length ? '' : activityLine(publicPresence);
  const friendLabel = useMemo(() => {
    if (relation === 'accepted') return 'Friends';
    if (relation === 'pending_out') return 'Request sent';
    if (relation === 'pending_in') return 'Accept Friend';
    if (relation === 'blocked') return 'Unblock';
    return 'Add Friend';
  }, [relation]);

  const foreignHome = !store.me?.user_id
    || domainOf(store.me.user_id) !== domainOf(targetUserId);

  if (state.status === 'loading') return <ProfileSkeleton />;

  if (state.status === 'error') {
    return (
      <main className="ppl">
        <div className="ppl__frame">
          <PublicProfileBrand />
          <section className="ppl__panel">
            <h1 className="ppl__panel-title">Profile unavailable</h1>
            <p className="ppl__panel-note">{state.message}</p>
            <p className="ppl__panel-id">{userId}</p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="ppl">
      <div className="ppl__frame">
        <PublicProfileBrand />
        <section
          className="pc"
          data-surface="public"
          data-themed={theme ? 'true' : undefined}
          style={themeStyle(accent, theme)}
        >
          <div className="pc__banner">
            {banner ? (
              <AnimatedImage src={banner} alt="" animated className="size-full object-cover" />
            ) : null}
          </div>
          <div className="ppl__accent" />

          <div className="pc__face">
            <div className="pc__cut">
              <Avatar
                id={targetUserId}
                name={displayName}
                size="2xl"
                src={avatar}
                presence={publicPresence.status || null}
              />
            </div>
            {publicPresence.custom_status ? (
              <p className="pc__bubble">
                <StatusText store={store}>{publicPresence.custom_status}</StatusText>
              </p>
            ) : null}
          </div>

          <div className="pc__head">
            <div className="pc__ident">
              <h1 className="pc__name">{displayName}</h1>
            </div>
            <div className="pc__meta">
              <button
                type="button"
                className="pc__handle"
                data-guest={foreignHome ? 'true' : 'false'}
                title="Copy username"
                aria-label={`Copy username ${targetUserId}`}
                onClick={() => copyToClipboard(targetUserId, 'Username')}
              >
                <span className="pc__handle-local">{`@${shortName(targetUserId)}`}</span>
                <span className="pc__handle-domain">{`:${domainOf(targetUserId)}`}</span>
              </button>
              {presenceShape ? (
                <span className="pc__fact" data-presence={publicPresence.status}>
                  {PresenceIcon ? (
                    <PresenceIcon className="pc__fact-mark size-3" aria-hidden="true" />
                  ) : null}
                  <span>{presenceShape.label}</span>
                </span>
              ) : !presenceKnown ? (
                <span className="pc__fact"><span>Status unavailable</span></span>
              ) : null}
              {profile?.pronouns ? (
                <span className="pc__fact"><span>{profile.pronouns}</span></span>
              ) : null}
            </div>
            {state.movedFrom ? (
              <div className="ppl__moved">Moved from {state.movedFrom}</div>
            ) : null}
          </div>

          {profile?.bio || richActivities.length || plainActivity || joined ? (
            <div className="pc__body">
              {profile?.bio ? <BioText className="pc__prose">{profile.bio}</BioText> : null}

              {richActivities.length ? (
                <div className="grid gap-2">
                  {richActivities.map((activity) => (
                    <RichActivityCard
                      key={`${activity.type}:${activity.application_id || ''}:${activity.name}`}
                      activity={activity}
                    />
                  ))}
                </div>
              ) : plainActivity ? (
                <div className="pc__prose">{plainActivity}</div>
              ) : null}

              {joined ? (
                <Section label="On Telium since">
                  <div className="pc__dates">
                    <span className="pc__date">
                      <img
                        src="/brand/telium-mark-gradient.svg"
                        alt="Telium"
                        className="pc__date-mark"
                      />
                      <span>{joined}</span>
                    </span>
                  </div>
                </Section>
              ) : null}
            </div>
          ) : null}

          {!isMe ? (
            <div className="pc__actions">
              <Button
                variant="primary"
                disabled={acting === 'friend' || relation === 'accepted' || relation === 'pending_out'}
                onClick={() => perform('friend')}
              >
                {relation === 'accepted' ? <CheckIcon className="size-4" /> : <AddFriendIcon className="size-4" />}
                {friendLabel}
              </Button>
              <Button
                variant="secondary"
                disabled={acting === 'message' || relation === 'blocked'}
                onClick={() => perform('message')}
              >
                <MessageIcon className="size-4" />
                {acting === 'message' ? 'Opening…' : 'Message'}
              </Button>
            </div>
          ) : null}

          {!store.signedIn ? (
            <p className="ppl__note">
              You can view this profile without an account. Sign in or create one only when you want to interact.
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}
