import { useRef, useState } from 'react';
import { useDrop } from 'react-dnd';

const EDGE = 0.34;

export function useZones(ref, {
  accept, canDrop, canCombine, before, after, combine: onCombine,
}, deps) {
  const [zone, setZone] = useState(null);
  const last = useRef(null);

  const read = (monitor) => {
    const box = ref.current?.getBoundingClientRect();
    const point = monitor.getClientOffset();
    if (!box || !point || !monitor.canDrop()) return null;
    const at = (point.y - box.top) / (box.height || 1);
    if (at < EDGE) return 'before';
    if (at > 1 - EDGE) return 'after';
    if (canCombine ? canCombine(monitor.getItem()) : false) return 'combine';
    return at < 0.5 ? 'before' : 'after';
  };

  const [{ over }, drop] = useDrop({
    accept,
    canDrop: canDrop || (() => true),
    hover: (item, monitor) => {
      const next = monitor.isOver({ shallow: true }) ? read(monitor) : null;
      if (next === last.current) return;
      last.current = next;
      setZone(next);
    },
    drop: (item, monitor) => {
      const at = read(monitor);
      last.current = null;
      setZone(null);
      if (at === 'before') before(item);
      else if (at === 'after') after(item);
      else if (at === 'combine') onCombine?.(item);
    },
    collect: (m) => ({ over: m.isOver({ shallow: true }) && m.canDrop() }),
  }, deps);
  drop(ref);
  return over ? zone : null;
}
