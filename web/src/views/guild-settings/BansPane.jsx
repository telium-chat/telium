import { useAsync } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { relative } from '../../lib/util.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { Async, Button, DataTable, Hint, Meta, Section, useDialogs } from '../../components/index.js';

export function BansPane({ guildId, api }) {
  const dialogs = useDialogs();
  const tr = useT();
  const state = useAsync(() => api.bans(guildId).then((r) => r.bans || []), [guildId]);

  return (
    <>
      <Section>
        <Hint>
          {tr('guild.bans.hint')}
        </Hint>
        <Async state={state}>
          {(bans) => (
            <DataTable
              rows={bans}
              rowKey={(ban) => ban.user_id}
              label={tr('guild.bans.tableLabel')}
              empty={tr('guild.bans.empty')}
              columns={[
                {
                  key: 'account',
                  header: tr('guild.bans.colAccount'),
                  render: (ban) => ban.user_id,
                },
                {
                  key: 'reason',
                  header: tr('guild.bans.colReason'),
                  render: (ban) => ban.reason || <Meta>{tr('guild.bans.noReason')}</Meta>,
                },
                {
                  key: 'when',
                  header: tr('guild.bans.colWhen'),
                  render: (ban) => relative(ban.created_at),
                },
                {
                  key: 'unban',
                  header: '',
                  render: (ban) => (
                    <Button
                      variant="ghost"
                      aria-label={tr('guild.bans.unbanAccount', { account: ban.user_id })}
                      onClick={async () => {
                        try { await api.unban(guildId, ban.user_id); state.reload(); }
                        catch (e) { reportError(e, tr('guild.bans.unbanFailed')); }
                      }}
                    >
                      {tr('guild.bans.unban')}
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Async>
        <Button
          className="self-start"
          onClick={() => dialogs.prompt({
            title: t('guild.bans.dialogTitle'),
            label: t('guild.bans.dialogLabel'),
            confirmLabel: t('guild.bans.confirm'),
            onSubmit: async (id) => {
              try { await api.ban(guildId, id.trim(), {}); state.reload(); }
              catch (e) { reportError(e, t('guild.bans.banFailed')); }
            },
          })}
        >
          {tr('guild.bans.add')}
        </Button>
      </Section>
    </>
  );
}
