import { useEffect, useState } from 'react';
import { useStore } from './useStore.jsx';

/// The homeserver's release, read once per signed-in home from the public capabilities document. '' while unknown or if the server doesn't say.
const cache = new Map();

export function cleanServerVersion(caps) {
  const raw = typeof caps?.server_version === 'string' ? caps.server_version.trim() : '';
  return /^[\w.+-]{1,32}$/.test(raw) ? raw : '';
}

export function useServerVersion() {
  const store = useStore();
  const home = store.home;
  const key = home?.base || '';
  const [version, setVersion] = useState(() => cache.get(key) || '');

  useEffect(() => {
    if (!home || !key) { setVersion(''); return undefined; }
    if (cache.has(key)) { setVersion(cache.get(key)); return undefined; }
    let live = true;
    home.capabilities()
      .then((caps) => {
        const value = cleanServerVersion(caps);
        cache.set(key, value);
        if (live) setVersion(value);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [home, key]);

  return version;
}
