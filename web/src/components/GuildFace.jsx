import { useStore } from '../hooks/useStore.jsx';
import { cn } from '../lib/cn.js';
import { tint } from '../lib/util.js';
import { AnimatedImage } from './AnimatedImage.jsx';

export function GuildFace({ guild, size = 'size-10', radius = 'rounded-2xl', letters = true, className }) {
  const store = useStore();
  if (!guild) return <span className={cn(size, radius, 'bg-surface', className)} />;

  const icon = guild.icon_ref
    ? `${store.apiForGuild(guild.id)?.base || ''}/_telium/v1/media/${guild.icon_ref}`
    : null;
  if (icon) {
    return (
      <AnimatedImage
        src={icon}
        alt=""
        animated
        draggable={false}
        className={cn(size, radius, 'object-cover', className)}
      />
    );
  }
  return (
    <span
      className={cn(size, radius, 'flex items-center justify-center font-semibold text-white', className)}
      style={{ background: tint(guild.id) }}
    >
      {letters ? (guild.name || '?').slice(0, 2).toUpperCase() : null}
    </span>
  );
}
