import { useEffect, useState } from 'react';
import { useAsync } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { PERMISSIONS, PERMISSION_MASKS, permissionInfo } from '../../lib/perms.js';
import { Async, Button, Field, Hint, Section, Select } from '../../components/index.js';

export function ChannelPermissionsPane({ guildId, api }) {
  const state = useAsync(
    () => Promise.all([api.channels(guildId), api.roles(guildId)])
      .then(([channelResp, roleResp]) => ({
        channels: (channelResp.channels || []).filter((c) => c.type !== 'category'),
        roles: roleResp.roles || [],
      })),
    [guildId],
  );

  return (
    <>
      <Async state={state}>
        {(data) => <Editor api={api} channels={data.channels} roles={data.roles} />}
      </Async>
    </>
  );
}

function Editor({ api, channels: loaded, roles }) {
  const t = useT();
  const [channels, setChannels] = useState(loaded);
  const [channelId, setChannelId] = useState(channels[0]?.id || '');
  const [roleId, setRoleId] = useState(roles[0]?.id || '');
  const [state, setState] = useState({});

  const states = [
    ['inherit', t('roles.overwrite.inherit')],
    ['allow', t('roles.overwrite.allow')],
    ['deny', t('roles.overwrite.deny')],
  ];

  useEffect(() => {
    const channel = channels.find((c) => c.id === channelId);
    const existing = (channel?.permission_overwrites || []).find(
      (o) => o.target_id === roleId && (o.target_type || 'role') === 'role',
    );
    const next = {};
    if (existing) {
      const allow = BigInt(existing.allow || '0');
      const deny = BigInt(existing.deny || '0');
      for (const [name, bit] of PERMISSION_MASKS) {
        if (allow & bit) next[name] = 'allow';
        else if (deny & bit) next[name] = 'deny';
      }
    }
    setState(next);
  }, [channels, channelId, roleId]);

  const save = async () => {
    let allow = 0n;
    let deny = 0n;
    for (const [name, bit] of PERMISSION_MASKS) {
      if (state[name] === 'allow') allow |= bit;
      else if (state[name] === 'deny') deny |= bit;
    }
    try {
      const saved = await api.setOverwrite(channelId, 'role', roleId, allow, deny);
      setChannels((list) => list.map((c) => (c.id === saved.id ? saved : c)));
      toast(t('roles.overwrite.saved'));
    } catch (e) { reportError(e, t('roles.overwrite.saveFailed')); }
  };

  return (
    <Section>
      <Hint>{t('roles.overwrite.hint')}</Hint>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('roles.overwrite.channel')}>
          <Select
            value={channelId}
            options={channels.map((c) => [c.id, `#${c.name}`])}
            onChange={(e) => setChannelId(e.target.value)}
          />
        </Field>
        <Field label={t('roles.overwrite.role')}>
          <Select
            value={roleId}
            options={roles.map((r) => [r.id, r.name])}
            onChange={(e) => setRoleId(e.target.value)}
          />
        </Field>
      </div>
      <div className="divide-y divide-border overflow-hidden panel">
        {PERMISSIONS.map((name) => {
          const info = permissionInfo(name);
          return (
            <div key={name} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:py-2">
              <span className="min-w-0 flex-1 break-words text-sm">{info.label}</span>
              <Select
                className="w-full shrink-0 sm:w-[200px]"
                aria-label={t('roles.overwrite.control', { permission: info.label })}
                value={state[name] || 'inherit'}
                options={states}
                onChange={(e) => setState((s) => ({ ...s, [name]: e.target.value }))}
              />
            </div>
          );
        })}
      </div>
      <Button variant="primary" className="self-start" onClick={save}>
        {t('roles.overwrite.save')}
      </Button>
    </Section>
  );
}
