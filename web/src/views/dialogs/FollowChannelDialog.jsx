import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { has } from '../../lib/perms.js';
import {
  Button, Field, Hint, ModalShell, Notice, Select,
} from '../../components/index.js';

export function FollowChannelDialog({ channel, close }) {
  const store = useStore();
  const targets = store.channelsOf(channel.guild_id).filter((c) => (
    c.id !== channel.id
    && (c.type === 'text' || c.type === 'announcement')
    && has(store.permissionsIn(c.id), 'MANAGE_CHANNELS')
  ));

  const [target, setTarget] = useState(targets[0]?.id || '');
  const [busy, setBusy] = useState(false);

  const apply = async (on) => {
    if (!target) return;
    setBusy(true);
    const name = store.channels.get(target)?.name || 'that channel';
    try {
      const api = store.apiForChannel(channel.id);
      if (on) await api.follow(channel.id, target);
      else await api.unfollow(channel.id, target);
      toast(on
        ? `#${name} now receives posts from #${channel.name}.`
        : `#${name} no longer receives posts from #${channel.name}.`);
      close();
    } catch (e) { reportError(e, on ? 'Could not follow' : 'Could not unfollow'); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell
      title={`Follow #${channel.name}`}
      subtitle="Posts published here are copied into the channel you pick."
      footer={(
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button variant="ghost" isDisabled={busy || !target} onClick={() => apply(false)}>
            Stop following
          </Button>
          <Button variant="primary" isDisabled={busy || !target} onClick={() => apply(true)}>
            Follow
          </Button>
        </>
      )}
    >
      {targets.length ? (
        <Field
          label="Copy posts into"
          hint="Only channels you can manage, since this is a decision about them."
        >
          <Select
            value={target}
            options={targets.map((c) => [c.id, `#${c.name}`])}
            onChange={(e) => setTarget(e.target.value)}
          />
        </Field>
      ) : (
        <Notice tone="warn">
          {'There is no channel in this guild you can manage, so there is nowhere '
            + 'to put the posts.'}
        </Notice>
      )}
      <Hint>
        {'The copy is made by the guild server when a post is published, so it '
          + 'happens whether or not anyone is connected.'}
      </Hint>
    </ModalShell>
  );
}
