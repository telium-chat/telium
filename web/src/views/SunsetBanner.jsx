import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { Banner } from '../components/index.js';
import { describeSunset } from '../lib/sunset.js';

export function SunsetBanner() {
  const store = useStore();
  useStoreEvent('sunset');
  const text = describeSunset(store.sunset);
  if (!text) return null;

  return (
    <Banner tone="warning" role="status">
      {text}
      {store.sunset?.message ? <span>{store.sunset.message}</span> : null}
    </Banner>
  );
}
