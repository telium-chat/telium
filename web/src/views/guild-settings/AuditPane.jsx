import { useAsync } from '../../hooks/useStore.jsx';
import { relative, shortName } from '../../lib/util.js';
import { useT } from '../../lib/i18n/react.jsx';
import { Async, DataTable, Meta, Section } from '../../components/index.js';

export function AuditPane({ guildId, api }) {
  const t = useT();
  const state = useAsync(() => api.auditLog(guildId).then((r) => r.entries || []), [guildId]);
  return (
    <>
      <Section>
        <Async state={state}>
          {(entries) => (
            <DataTable
              rows={entries}
              rowKey={(e) => e.id || `${e.created_at}-${e.action}`}
              label={t('guild.audit.tableLabel')}
              empty={t('guild.audit.empty')}
              columns={[
                {
                  key: 'when',
                  header: t('guild.audit.colWhen'),
                  render: (e) => relative(e.created_at),
                },
                {
                  key: 'actor',
                  header: t('guild.audit.colActor'),
                  render: (e) => shortName(e.actor),
                },
                {
                  key: 'action',
                  header: t('guild.audit.colAction'),
                  render: (e) => <code>{e.action}</code>,
                },
                {
                  key: 'target',
                  header: t('guild.audit.colTarget'),
                  render: (e) => (e.target ? shortName(e.target) : <Meta>{t('common.empty')}</Meta>),
                },
              ]}
            />
          )}
        </Async>
      </Section>
    </>
  );
}
