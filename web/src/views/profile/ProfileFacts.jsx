import { AnimatedImage } from '../../components/AnimatedImage.jsx';
import {
  CheckIcon, ClockIcon, KeyIcon, LockIcon, MembersIcon, ShieldAlertIcon,
} from '../../components/index.js';
import { dayOf, relative, timeOf, tint } from '../../lib/util.js';

export function Section({ label, children }) {
  return (
    <section className="pc__section">
      {label ? <h3 className="pc__label">{label}</h3> : null}
      {children}
    </section>
  );
}

const TRUST = {
  verified: {
    state: 'ok',
    icon: CheckIcon,
    title: 'Verified',
    act: null,
  },
  changed: {
    state: 'attention',
    icon: ShieldAlertIcon,
    title: 'Account key changed',
    note: 'This is not the key you verified. Ask them out of band before trusting it.',
    act: 'Verify again',
  },
  unverified: {
    state: 'todo',
    icon: LockIcon,
    title: 'Not verified',
    note: 'Verify once and every device they sign is covered, now and later.',
    act: 'Verify',
  },
  unsigned: {
    state: 'none',
    icon: KeyIcon,
    title: 'No account key',
    note: 'Nothing to verify against yet. Their devices are trusted on their home server’s word.',
    act: null,
  },
};

const PENDING = {
  state: 'waiting',
  icon: ClockIcon,
  title: 'Verification requested',
};

export function requestNote(request) {
  return request.message
    || `You asked ${relative(request.requested_at)} and they have not answered yet.`
      + (request.may_ask_again_at
        ? ` You can ask again after ${timeOf(request.may_ask_again_at)}.`
        : '');
}

export function TrustMark({ verification, onVerify }) {
  const request = verification.request || null;
  const shape = request ? PENDING : (TRUST[verification.status] || TRUST.unverified);
  const Mark = shape.icon;
  const devices = verification.devices || 0;
  const when = verification.signedAt ? dayOf(verification.signedAt) : null;
  let why;
  if (request) {
    why = requestNote(request);
  } else if (shape.note) {
    why = shape.note;
  } else if (devices) {
    why = `You confirmed their account key${when ? ` on ${when}` : ''}, and that one `
      + `signature covers ${devices} of their device${devices === 1 ? '' : 's'}.`;
  } else {
    why = 'You have confirmed their account key.';
  }

  const glyph = <Mark className="size-3" strokeWidth={2.25} />;
  const act = request ? null : shape.act;

  if (!act) {
    return (
      <span
        className="pc__trust"
        data-state={shape.state}
        role="img"
        aria-label={shape.title}
        title={`${shape.title} — ${why}`}
      >
        {glyph}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="pc__trust"
      data-state={shape.state}
      aria-label={`${shape.title}. ${act}`}
      title={`${shape.title} — ${why} Press to ${act.toLowerCase()}.`}
      onClick={onVerify}
    >
      {glyph}
    </button>
  );
}

export function JoinDates({ store, guild, member, identity }) {
  const guildApi = guild ? store.apiForGuild(guild.id) : null;
  const guildIcon = guild?.icon_ref && guildApi?.base
    ? `${guildApi.base}/_telium/v1/media/${guild.icon_ref}`
    : null;
  const telium = identity?.created_at ? dayOf(identity.created_at) : null;
  const here = member?.joined_at ? dayOf(member.joined_at) : null;
  const guildName = guild?.name || 'this guild';

  const teliumMark = (
    <img src="/brand/telium-mark-gradient.svg" alt="Telium" className="pc__date-mark" />
  );
  const guildMark = guildIcon ? (
    <AnimatedImage src={guildIcon} alt={guild?.name || 'Guild'} animated className="pc__date-mark" />
  ) : (
    <span
      aria-label={guild?.name || 'Guild'}
      data-letter="true"
      className="pc__date-mark"
      style={{ background: tint(guild?.id || 'guild') }}
    >
      {(guild?.name || '?').slice(0, 1).toUpperCase()}
    </span>
  );

  if (telium && here && telium === here) {
    return (
      <div className="pc__dates">
        <span className="pc__date" title={`On Telium and in ${guildName} since ${telium}`}>
          <span className="pc__date-marks">{teliumMark}{guildMark}</span>
          <span>{telium}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="pc__dates">
      {telium ? (
        <span className="pc__date" title={`On Telium since ${telium}`}>
          {teliumMark}
          <span>{telium}</span>
        </span>
      ) : null}
      {here ? (
        <span className="pc__date" title={`Joined ${guildName} ${here}`}>
          {guildMark}
          <span>{here}</span>
        </span>
      ) : null}
    </div>
  );
}

export function FriendSince({ since, displayName }) {
  return (
    <div className="pc__dates">
      <span
        className="pc__date"
        title={`You and ${displayName} have been friends since ${dayOf(since)}`}
      >
        <span className="pc__date-mark" data-glyph="true" aria-hidden="true">
          <MembersIcon className="size-3" />
        </span>
        <span>{dayOf(since)}</span>
      </span>
    </div>
  );
}
