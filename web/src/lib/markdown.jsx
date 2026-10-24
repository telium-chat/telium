// Small markdown renderer that returns React elements, never an HTML string.

import { useState } from 'react';
import { AnimatedImage } from '../components/AnimatedImage.jsx';
import { EmojiText, Twemoji } from '../components/Twemoji.jsx';
import { ForwardIcon } from '../components/icons.jsx';
import { toast } from '../hooks/useToast.jsx';
import { CUSTOM_EMOJI, isJumbo, isPictorial, splitEmoji } from './emoji.js';
import { channelGlyph, channelRoute, isLinkable } from './channels.js';
import { conversationTitle } from './conversations.js';
import { BROADCAST, CHANNEL, LEGACY_USER, ROLE, USER, resolveMention } from './mentions.js';

const CUSTOM = CUSTOM_EMOJI;

const FORWARD_GUILD = /^telium:\/\/forward\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)[ \t]*(?:\n|$)/;
// Conversation forwards show where they came from but can't be jumped to (ids are encrypted).
const FORWARD_CONVO = /^telium:\/\/forward\/convo\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)[ \t]*(?:\n|$)/;
const FORWARD_BARE = /^telium:\/\/forwarded[ \t]*(?:\n|$)/;

// Each text shape forbids its own delimiter inside itself, so `**a **b** c**` stays honest.
const TOKEN = new RegExp(
  `(\`[^\`]+\`)|(\\*\\*[^*]+\\*\\*)|(\\*[^*]+\\*)|(~~[^~]+~~)|(\\|\\|[^|]+\\|\\|)`
  + `|(${ROLE})|(${CHANNEL})|(${CUSTOM})|(${USER}|${LEGACY_USER})|(${BROADCAST})`
  + `|(https?:\\/\\/\\S+)`,
  'g',
);

export function forwardLine(origin) {
  if (origin && typeof origin === 'object') {
    if (origin.kind === 'conversation') {
      return `telium://forward/convo/${origin.conversationId}/${origin.messageId}`;
    }
    return `telium://forward/${origin.guildId}/${origin.channelId}/${origin.messageId}`;
  }
  return 'telium://forwarded';
}

export function takeForwards(content) {
  let rest = content == null ? '' : String(content);
  let origin;
  for (;;) {
    const guild = FORWARD_GUILD.exec(rest);
    if (guild) {
      if (origin === undefined) {
        origin = { guildId: guild[1], channelId: guild[2], messageId: guild[3] };
      }
      rest = rest.slice(guild[0].length);
      continue;
    }
    const convo = FORWARD_CONVO.exec(rest);
    if (convo) {
      if (origin === undefined) {
        origin = { kind: 'conversation', conversationId: convo[1], messageId: convo[2] };
      }
      rest = rest.slice(convo[0].length);
      continue;
    }
    const bare = FORWARD_BARE.exec(rest);
    if (bare) {
      if (origin === undefined) origin = null;
      rest = rest.slice(bare[0].length);
      continue;
    }
    return { origin, body: rest };
  }
}

/// Bios are attacker-controlled: they withhold custom emoji, fenced blocks and role/channel/@everyone pills.
export const BIO = { bio: true };

export function renderContent(text, ctx = {}) {
  const c = typeof ctx === 'string' ? { me: ctx } : ctx;
  if (c.bio) return inline(text == null ? '' : String(text), c, 'b');
  const { origin, body } = takeForwards(text);
  const scope = { ...c, jumbo: isJumbo(body) };
  const out = origin === undefined ? [] : [<ForwardedChip key="fwd" origin={origin} ctx={scope} />];
  const fence = /```(?:[a-zA-Z0-9+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let match;
  let key = 0;
  while ((match = fence.exec(body))) {
    if (match.index > last) out.push(...inline(body.slice(last, match.index), scope, `i${key++}`));
    out.push(<pre key={`f${key++}`}><code>{match[1]}</code></pre>);
    last = match.index + match[0].length;
  }
  if (last < body.length) out.push(...inline(body.slice(last), scope, `i${key++}`));
  return out;
}

export function ForwardedChip({ origin, ctx = {} }) {
  const store = ctx.store;
  const isConvo = origin?.kind === 'conversation';
  const isGuild = origin && origin.guildId && origin.channelId && origin.messageId;
  const jumpable = Boolean(isGuild && store?.channels.has(origin.channelId));

  let originLabel = 'Forwarded';
  let originDetail = '';
  if (isGuild) {
    const guild = store?.guilds.get(origin.guildId);
    const channel = store?.channels.get(origin.channelId);
    if (guild && channel) {
      originLabel = `Forwarded from ${guild.name}`;
      originDetail = `#${channel.name}`;
    } else if (guild) {
      originLabel = `Forwarded from ${guild.name}`;
    } else {
      originLabel = 'Forwarded from unknown server';
    }
  } else if (isConvo) {
    const convo = store?.conversations?.find(c => c.id === origin.conversationId);
    if (convo) {
      originLabel = `Forwarded from ${conversationTitle(store, convo)}`;
    } else {
      originLabel = 'Forwarded from a conversation';
    }
  }

  if (!jumpable) {
    return (
      <span className="mb-0.5 flex w-fit items-center gap-1 rounded text-xs font-medium text-muted">
        <ForwardIcon className="size-3 shrink-0" />
        <span title={originDetail || originLabel}>
          <EmojiText>{originLabel}</EmojiText>
        </span>
        {originDetail && (
          <span className="text-2xs opacity-70"><EmojiText>{originDetail}</EmojiText></span>
        )}
      </span>
    );
  }
  const jump = () => {
    if (!store.jumpTo(origin.channelId, origin.messageId)) {
      toast('That message is not available any more.');
    }
  };
  return (
    <button
      type="button"
      title={`Jump to message in ${originDetail || originLabel}`}
      onClick={jump}
      className="mb-0.5 flex w-fit cursor-pointer items-center gap-1 rounded text-xs font-medium text-muted transition-colors hover:text-accent hover:underline"
    >
      <ForwardIcon className="size-3 shrink-0" />
      <span><EmojiText>{originLabel}</EmojiText></span>
      {originDetail && <span className="text-2xs opacity-70"><EmojiText>{originDetail}</EmojiText></span>}
    </button>
  );
}

function inline(text, ctx, prefix) {
  const nodes = [];
  let quote = null;
  const flushQuote = () => {
    if (!quote) return;
    nodes.push(<blockquote key={`${prefix}q${quote.at}`}>{quote.nodes}</blockquote>);
    quote = null;
  };
  text.split('\n').forEach((line, i) => {
    if (line.startsWith('> ')) {
      if (!quote) quote = { at: i, nodes: [] };
      else quote.nodes.push(<span key={`${prefix}qb${i}`}>{'\n'}</span>);
      quote.nodes.push(...spans(line.slice(2), ctx, `${prefix}-${i}`));
    } else {
      flushQuote();
      if (i) nodes.push(<span key={`${prefix}-br${i}`}>{'\n'}</span>);
      nodes.push(...spans(line, ctx, `${prefix}-${i}`));
    }
  });
  flushQuote();
  return nodes;
}

function text(str, ctx, key) {
  const parts = splitEmoji(str);
  if (parts.length === 1 && parts[0].text !== undefined) return <span key={key}>{str}</span>;
  return parts.map((p, i) => (p.emoji
    ? <Twemoji key={`${key}e${i}`} emoji={p.emoji} jumbo={ctx.jumbo} />
    : <span key={`${key}e${i}`}>{p.text}</span>));
}

function spans(line, ctx, prefix) {
  const out = [];
  let last = 0;
  let m;
  let key = 0;
  // The shared regex's cursor is borrowed and restored: emphasis re-enters this function.
  const resume = TOKEN.lastIndex;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(line))) {
    if (m.index > last) out.push(text(line.slice(last, m.index), ctx, `${prefix}t${key++}`));
    const [raw, code, bold, italic, strike, spoiler, role, channel, custom, mention, broadcast, url] = m;
    const k = `${prefix}m${key++}`;
    const withheld = ctx.bio && (custom || role || channel || broadcast);
    if (withheld) out.push(<span key={k}>{raw}</span>);
    else if (code) out.push(<code key={k}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={k}>{spans(bold.slice(2, -2), ctx, `${k}b`)}</strong>);
    else if (italic) out.push(<em key={k}>{spans(italic.slice(1, -1), ctx, `${k}i`)}</em>);
    else if (strike) out.push(<s key={k}>{spans(strike.slice(2, -2), ctx, `${k}s`)}</s>);
    else if (spoiler) out.push(<Spoiler key={k}>{spans(spoiler.slice(2, -2), ctx, `${k}p`)}</Spoiler>);
    else if (role) out.push(<RoleMention key={k} token={role} ctx={ctx} />);
    else if (channel) out.push(<ChannelMention key={k} token={channel} ctx={ctx} />);
    else if (custom) out.push(<Emoji key={k} emoji={custom} store={ctx.store} guildId={ctx.guildId} jumbo={ctx.jumbo} />);
    else if (mention) out.push(<UserMention key={k} token={mention} ctx={ctx} />);
    else if (broadcast) out.push(<span key={k} className="mention self" title="Notifies the channel">{broadcast}</span>);
    // noreferrer so the referrer doesn't name the guild host.
    else if (url) out.push(<a key={k} href={url} target="_blank" rel="noreferrer noopener">{url}</a>);
    else out.push(<span key={k}>{raw}</span>);
    last = m.index + raw.length;
  }
  if (last < line.length) out.push(text(line.slice(last), ctx, `${prefix}t${key++}`));
  TOKEN.lastIndex = resume;
  return out;
}

/// Hides behind paint, not absence; revealing is one-way so selected text isn't snatched away.
function Spoiler({ children }) {
  const [revealed, setRevealed] = useState(false);
  if (revealed) return <span className="spoiler revealed">{children}</span>;
  const reveal = () => setRevealed(true);
  return (
    <span
      className="spoiler"
      role="button"
      tabIndex={0}
      title="Spoiler"
      onClick={reveal}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        reveal();
      }}
    >
      {children}
    </span>
  );
}

function UserMention({ token, ctx }) {
  const who = resolveMention({ kind: 'user', id: token.startsWith('<') ? token.slice(1, -1) : token }, ctx);
  const className = who.mine ? 'mention self' : 'mention';
  if (!ctx.onOpenUser) {
    return <span className={className} title={who.title}><EmojiText>{who.label}</EmojiText></span>;
  }
  return (
    <button
      type="button"
      className={className}
      title={who.title}
      onClick={(e) => ctx.onOpenUser(who.id, e.currentTarget)}
    >
      <EmojiText>{who.label}</EmojiText>
    </button>
  );
}

function RoleMention({ token, ctx }) {
  const role = resolveMention({ kind: 'role', id: token.slice(3, -1) }, ctx);
  const base = role.mine ? 'mention self' : 'mention';
  return (
    <span
      className={role.colour ? `${base} role-ink` : base}
      title={role.title}
      style={role.colour ? { '--role': role.colour } : undefined}
    >
      <EmojiText>{role.label}</EmojiText>
    </span>
  );
}

function ChannelMention({ token, ctx }) {
  const where = resolveMention({ kind: 'channel', id: token.slice(2, -1) }, ctx);
  const channel = where.channel;
  if (!channel) return <span className="mention" title={where.title}>{where.label}</span>;
  const Glyph = channelGlyph(channel);
  const body = (
    <>
      <Glyph className="me-[0.15em] inline size-[1em] align-[-0.15em]" />
      <EmojiText>{channel.name}</EmojiText>
    </>
  );
  if (!ctx.onNavigate || !isLinkable(channel)) {
    return <span className="mention" title={where.title}>{body}</span>;
  }
  const go = () => {
    if (ctx.store?.navigate) ctx.store.navigate(channelRoute(channel));
    else ctx.onNavigate(channel);
  };
  return (
    <button type="button" className="mention" title={where.title} onClick={go}>
      {body}
    </button>
  );
}

export function Emoji({ emoji, store, guildId, jumbo }) {
  const m = /^<([A-Za-z0-9._-]+):([A-Z0-9]{26})(?:@([A-Za-z0-9.-]+))?>$/.exec(emoji);
  if (!m) {
    return isPictorial(emoji)
      ? <Twemoji emoji={emoji} jumbo={jumbo} />
      : <span>{emoji}</span>;
  }
  const [, name, id, origin] = m;
  const api = origin ? store?.apiFor(origin) : store?.apiForGuild(guildId);
  const base = api?.base || '';
  return (
    <AnimatedImage
      src={`${base}/_telium/v1/emoji/${id}`}
      alt={`:${name}:`}
      animated
      className={jumbo ? 'emoji emoji-jumbo' : 'emoji'}
    />
  );
}
