import { useEffect, useRef } from 'react';
import { cn } from '../../lib/cn.js';

export function Picture({ stream, label, className, mirrored, videoRef = null }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (videoRef) videoRef.current = el;
    el.srcObject = stream;
    Promise.resolve(el.play?.()).catch(() => {});
    return () => {
      if (videoRef?.current === el) videoRef.current = null;
      el.srcObject = null;
    };
  }, [stream, videoRef]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      aria-label={label}
      className={cn(className, mirrored && '-scale-x-100')}
    />
  );
}
