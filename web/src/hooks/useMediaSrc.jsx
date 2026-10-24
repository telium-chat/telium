import { useEffect, useState } from 'react';
import { teliumMediaSrc } from '../lib/net/transport.js';

export function useMediaSrc(url, { purpose = 'media' } = {}) {
  const [src, setSrc] = useState(null);

  useEffect(() => {
    if (!url) {
      setSrc(null);
      return undefined;
    }

    let alive = true;
    let release = null;
    setSrc(null);

    teliumMediaSrc(url, { purpose })
      .then((handle) => {
        if (!alive) {
          handle.release();
          return;
        }
        release = handle.release;
        setSrc(handle.src);
      })
      .catch(() => {
        if (alive) setSrc(null);
      });

    return () => {
      alive = false;
      release?.();
    };
  }, [url, purpose]);

  return src;
}
