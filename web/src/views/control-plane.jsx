import { lazy, Suspense } from 'react';
import { useStore } from '../hooks/useStore.jsx';
import { ServerIcon, Skeleton, TeliumMark } from '../components/index.js';

let chunk = null;
const load = () => { chunk ||= import('./control-plane/ControlPlane.jsx'); return chunk; };

export function prefetchControlPlane() {
  load().catch(() => {});
}

const Plane = lazy(() => load().then((m) => ({ default: m.ControlPlane })));

export function ControlPlane(props) {
  const store = useStore();
  return (
    <Suspense fallback={<Frame value={store.session?.home?.domain} />}>
      <Plane {...props} />
    </Suspense>
  );
}

function Frame({ value }) {
  return (
    <div className="settings" data-view="pane" aria-busy="true">
      <div className="settings__nav">
        <div className="settings__head">
          <div className="settings__host">
            <div className="eyebrow">Operating</div>
            <div className="settings__host-value">
              <ServerIcon className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{value}</span>
            </div>
            <div className="settings__host-title truncate">Control plane</div>
          </div>
        </div>
        <div className="settings__find" />
        <div className="settings__list">
          {['w-[58%]', 'w-[64%]', 'w-[52%]', 'w-[70%]', 'w-[66%]', 'w-[60%]'].map((width, i) => (
            <div key={i} className="settings-item">
              <Skeleton className={`h-3.5 rounded-md ${width}`} />
            </div>
          ))}
        </div>
        <div className="settings__mark">
          <TeliumMark className="size-4" gradient={false} />
          <span className="text-xs font-semibold text-foreground/80">Telium</span>
        </div>
      </div>
      <div className="settings__pane">
        <div className="settings__body">
          <div className="settings__sheet">
            <Skeleton className="mb-4 h-7 w-44 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
