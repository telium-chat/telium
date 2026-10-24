import { useState } from 'react';
import { useAsync } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { relative } from '../../lib/util.js';
import { DEFAULT_INVITE_EXPIRY, INVITE_EXPIRY_OPTIONS, inviteCreateBody } from '../../lib/invites.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { Async, Button, DataTable, Hint, Section, Select, TextInput } from '../../components/index.js';

const EXPIRY_LABELS = {
  '3600': 'guild.duration.hour',
  '86400': 'guild.duration.day',
  '604800': 'guild.duration.week',
  '2592000': 'guild.duration.thirtyDays',
  '': 'common.never',
};

export function InvitesPane({ guildId, api }) {
  const tr = useT();
  const state = useAsync(() => api.invites(guildId).then((r) => r.invites || []), [guildId]);
  const [maxUses, setMaxUses] = useState('');
  const [expiry, setExpiry] = useState(DEFAULT_INVITE_EXPIRY);

  const create = async () => {
    try {
      const invite = await api.createInvite(guildId, inviteCreateBody(maxUses, expiry));
      const copied = await copyToClipboard(invite.url, t('guild.invites.clipboardName'));
      if (!copied) toast(t('guild.invites.created'));
      state.reload();
    } catch (e) { reportError(e, t('guild.invites.createFailed')); }
  };

  return (
    <>
      <Section title={tr('guild.invites.create.title')}>
        <Hint>
          {tr('guild.invites.create.hint')}
        </Hint>
        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput
            label={tr('guild.invites.maxUses')}
            inputMode="numeric"
            placeholder={tr('guild.invites.maxUsesPlaceholder')}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))}
          />
          <Select
            label={tr('guild.invites.expires')}
            value={expiry}
            options={INVITE_EXPIRY_OPTIONS.map(([value]) => [value, tr(EXPIRY_LABELS[value])])}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </div>
        <Button className="self-start" onClick={create}>{tr('guild.invites.create.button')}</Button>
      </Section>
      <Section title={tr('guild.invites.list.title')}>
        <Async state={state}>
          {(invites) => (
            <DataTable
              rows={invites}
              rowKey={(i) => i.code}
              label={tr('guild.invites.tableLabel')}
              empty={tr('guild.invites.empty')}
              columns={[
                { key: 'code', header: tr('guild.invites.colCode'), render: (i) => i.code },
                {
                  key: 'uses',
                  header: tr('guild.invites.colUses'),
                  render: (i) => (i.max_uses
                    ? tr('guild.invites.usesOf', { used: i.uses, max: i.max_uses })
                    : tr('guild.invites.uses', { used: i.uses })),
                },
                {
                  key: 'expires',
                  header: tr('guild.invites.colExpires'),
                  render: (i) => {
                    if (i.expired) return tr('guild.invites.expired');
                    return i.expires_at ? relative(i.expires_at) : tr('common.never');
                  },
                },
                { key: 'creator', header: tr('guild.invites.colCreator'), render: (i) => i.creator },
                {
                  key: 'actions',
                  header: '',
                  render: (i) => (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => copyToClipboard(i.url, t('guild.invites.clipboardName'))}
                      >
                        {tr('common.copy')}
                      </Button>
                      <Button
                        variant="danger-soft"
                        aria-label={tr('guild.invites.revokeInvite', { code: i.code })}
                        onClick={async () => {
                          try { await api.revokeInvite(guildId, i.code); state.reload(); }
                          catch (e) { reportError(e, t('guild.invites.revokeFailed')); }
                        }}
                      >
                        {tr('guild.invites.revoke')}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </Async>
      </Section>
    </>
  );
}
