import { useEffect } from 'react';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { relative } from '../../lib/util.js';
import { Async, Button, Hint, Notice, Section } from '../../components/index.js';
import { ControlPlane, prefetchControlPlane } from '../control-plane.jsx';

export function AdminPane() {
  const store = useStore();
  const modal = useModal();
  const state = useAsync(() => store.home.adminStatus(), []);

  useEffect(() => { prefetchControlPlane(); }, []);

  const open = () => modal.open((c) => <ControlPlane close={c} />, { fullscreen: true });

  return (
    <>
      <Section
        title="Control plane"
        description="Live statistics, the report queue, federation, storage and the effective
          configuration of this server — in one screen, at full width."
      >
        <Button className="self-start" onFocus={prefetchControlPlane} onClick={open}>
          Open the control plane
        </Button>
        <Hint>
          Operator controls, not guild ones. Everything behind this button changes behaviour for
          the whole server and is authorised per request against this account, not against any
          role in any guild.
        </Hint>
      </Section>

      <Async state={state}>
        {(status) => (
          <Section title="Right now">
            <div className="grid gap-2 sm:grid-cols-3">
              <Notice tone={status.open_reports ? 'warn' : 'default'}>
                {`${status.open_reports} open reports`}
              </Notice>
              <Notice>{`${status.defederated} defederated domains`}</Notice>
              <Notice tone={status.backup?.stale ? 'warn' : 'success'}>
                {!status.backup?.enabled
                  ? 'Scheduled backups disabled'
                  : (status.backup.age_ms == null
                    ? 'No backup found'
                    : `Latest backup ${relative(Date.now() - status.backup.age_ms)}`)}
              </Notice>
            </div>
            <Hint>
              These three are the ones worth a glance from inside settings. Everything else is a
              click away.
            </Hint>
          </Section>
        )}
      </Async>

      <Section title="What the console will not show you">
        <Hint>
          Telium direct messages are end-to-end encrypted and the server cannot read them, so
          nothing in the control plane does. The statistics are aggregate counters — how many
          messages, not whose; how many people are connected, not which; how much is queued for a
          peer, not what. Where a number would have been more useful but more invasive, the less
          invasive one was taken and the reason is written next to it.
        </Hint>
      </Section>
    </>
  );
}
