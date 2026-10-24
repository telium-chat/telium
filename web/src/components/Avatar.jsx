import { useEffect, useState } from 'react';
import { cn } from '../lib/cn.js';
import { mediaUrl } from '../lib/media.js';
import { domainOf, shortName, tint } from '../lib/util.js';
import { AnimatedImage } from './AnimatedImage.jsx';
import { Presence } from './Presence.jsx';

const SIZES = {
  xxs: { box: 'size-4 text-[0.4375rem]', px: 16 },
  xs: { box: 'size-6 text-[0.5625rem]', px: 24 },
  sm: { box: 'size-7 text-2xs', px: 28 },
  md: { box: 'size-9 text-xs', px: 36 },
  row: { box: 'size-8 text-xs', px: 32 },
  chat: { box: 'size-10 text-sm', px: 40 },
  rail: { box: 'size-12 text-base', px: 48 },
  lg: { box: 'size-16 text-2xl', px: 64 },
  xl: { box: 'size-20 text-3xl', px: 80 },
  '2xl': { box: 'size-[104px] text-[2rem]', px: 104 },
};

export function Avatar({
  id, name, size = 'md', small = false, mediaRef = null, base = null,
  mediaOrigin = null, src = null,
  presence = null, typing = false, className, style,
}) {
  const [typingVisible, setTypingVisible] = useState(typing);
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [mediaRef, base, mediaOrigin, src]);

  const href = src || (mediaRef && base ? mediaUrl(base, mediaRef, mediaOrigin) : null);

  useEffect(() => {
    if (typing) {
      setTypingVisible(true);
      return undefined;
    }
    if (!typingVisible) return undefined;
    const timer = setTimeout(() => setTypingVisible(false), 400);
    return () => clearTimeout(timer);
  }, [typing, typingVisible]);

  const box = SIZES[small ? 'sm' : size] || SIZES.md;
  const label = (name || shortName(id) || '?').slice(0, 2).toUpperCase();
  const node = (
    <div
      className={cn(
        'avatar flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full',
        'font-medium text-white/95 ring-1 ring-black/5 dark:ring-white/10',
        box.box,
        className,
      )}
      style={{ background: tint(id || name), ...style }}
      title={id || name}
    >
      {href && !broken
        ? <AnimatedImage
            src={href}
            alt=""
            animated
            // Drag would leak the media URL (capability token); `shell.css` has the -webkit-user-drag half.
            draggable={false}
            onError={() => setBroken(true)}
            className="size-full object-cover"
          />
        : label}
    </div>
  );
  if (!presence && !typingVisible) return node;
  return (
    <div className="relative shrink-0">
      {node}
      <Presence status={presence} size={box.px} typing={typing} />
    </div>
  );
}

export function GroupAvatar({ faces = [], size = 'row', className }) {
  const box = SIZES[size] || SIZES.row;
  if (faces.length <= 1) {
    const face = faces[0];
    return face
      ? <Avatar id={face.id} name={face.name} size={size} mediaRef={face.avatarRef} base={face.base} mediaOrigin={face.mediaOrigin} className={className} />
      : <div className={cn('avatar shrink-0 rounded-full bg-surface-tertiary', box.box, className)} />;
  }
  const px = box.px;
  const f = Math.round(px * 0.66);
  const off = px - f;
  const cut = f / 2 + Math.max(1.5, px / 20);
  const centre = off + f / 2;
  const mask = `radial-gradient(circle at ${centre}px ${centre}px, transparent ${cut}px, #000 ${cut + 0.5}px)`;
  const face = (p, style) => (
    <Avatar
      id={p.id}
      name={p.name}
      mediaRef={p.avatarRef}
      base={p.base}
      mediaOrigin={p.mediaOrigin}
      className="absolute ring-0"
      style={style}
    />
  );
  return (
    <div className={cn('relative shrink-0', box.box, className)}>
      {face(faces[0], { top: 0, left: 0, width: f, height: f, fontSize: f * 0.36, WebkitMaskImage: mask, maskImage: mask })}
      {face(faces[1], { top: off, left: off, width: f, height: f, fontSize: f * 0.36 })}
    </div>
  );
}

export function UserLabel({ id, name, onClick, className }) {
  const domain = domainOf(id);
  const body = (
    <>
      {name || shortName(id)}
      {domain
        ? <span className="ms-0.5 font-normal text-muted opacity-80">{`:${domain}`}</span>
        : null}
    </>
  );
  if (!onClick) {
    return (
      <span className={cn('text-base font-medium text-foreground', className)}>{body}</span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'cursor-pointer rounded text-start text-base font-medium text-foreground',
        'hover:underline focus-outside',
        className,
      )}
    >
      {body}
    </button>
  );
}
