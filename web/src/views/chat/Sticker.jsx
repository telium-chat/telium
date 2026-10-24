import { useStore } from '../../hooks/useStore.jsx';
import { AnimatedImage } from '../../components/AnimatedImage.jsx';

export function Sticker({ sticker, guildId }) {
  const store = useStore();
  const api = sticker.origin ? store.apiFor(sticker.origin) : store.apiForGuild(guildId);
  if (!api?.base) {
    return <div className="pt-1.5 text-sm text-muted">{`:${sticker.name}: (from ${sticker.origin})`}</div>;
  }
  return (
    <AnimatedImage
      src={`${api.base}/_telium/v1/sticker/${sticker.id}`}
      alt={sticker.name}
      title={sticker.name}
      loading="lazy"
      animated={sticker.animated}
      className="mt-1.5 size-[152px] object-contain"
    />
  );
}
