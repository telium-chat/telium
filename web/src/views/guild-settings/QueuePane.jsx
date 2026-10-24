import { useEffect } from 'react';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { relative, shortName } from '../../lib/util.js';
import { n } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Async, Avatar, Button, EmptyState, InboxIcon, MembersIcon, Pill, Section,
} from '../../components/index.js';
export function QueuePane({ guildId, api }) {
  const store = useStore();
  const t = useT();
  const state = useAsync(() => Promise.all([
    api.held(guildId).then((r) => r.held || []).catch(() => []),
    api.applicants(guildId).then((r) => r.applicants || []).catch(() => []),
  ]).then(([held, applicants]) => ({ held, applicants })), [guildId]);

  const { reload } = state;

  useEffect(() => store.on('held', (d) => {
    if (d.guild_id === guildId) reload();
  }), [store, guildId, state]);

  useEffect(() => store.on('applicant', (d) => {
    if (d.guild_id === guildId) reload();
  }), [store, guildId, state]);

  const decideHeld = async (id, decision) => {
    try { await api.decideHeld(guildId, id, decision); }
    catch (e) { reportError(e, t('guild.queue.heldFailed')); }
    finally { reload(); }
  };
  const decideApplicant = async (userId, decision) => {
    try { await api.decideApplicant(guildId, userId, decision); }
    catch (e) { reportError(e, t('guild.queue.applicantFailed')); }
    finally { reload(); }
  };

  return (
    <Async state={state}>
      {({ held, applicants }) => (
        <>
          <Section
            title={t('guild.queue.held.title')}
            description={t('guild.queue.held.description')}
            actions={<Pill tone={held.length ? 'warn' : 'default'}>{n(held.length)}</Pill>}
          >
            {held.length ? (
              <div className="flex flex-col gap-2">
                {held.map((item) => (
                  <Card key={item.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Avatar id={item.author} name={shortName(item.author)} size="sm" base={api.base} />
                      <span className="min-w-0 flex-1 truncate text-base font-medium">
                        {shortName(item.author)}
                      </span>
                      <Pill tone="warn">{item.reason || t('guild.queue.held.reason')}</Pill>
                      <span className="tnum shrink-0 text-xs text-muted">
                        {relative(item.created_at)}
                      </span>
                    </div>
                    <p className="rounded-lg bg-surface px-3 py-2 text-base leading-[1.55] whitespace-pre-wrap">
                      {item.payload?.content || t('guild.queue.held.noText')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => decideHeld(item.id, 'approve')}>
                        {t('guild.queue.approve')}
                      </Button>
                      <Button variant="danger-soft" onClick={() => decideHeld(item.id, 'reject')}>
                        {t('guild.queue.reject')}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState icon={InboxIcon} title={t('guild.queue.held.emptyTitle')}>
                {t('guild.queue.held.emptyBody')}
              </EmptyState>
            )}
          </Section>

          <Section
            title={t('guild.queue.applicants.title')}
            description={t('guild.queue.applicants.description')}
            actions={<Pill tone={applicants.length ? 'warn' : 'default'}>{n(applicants.length)}</Pill>}
          >
            {applicants.length ? (
              <div className="flex flex-col gap-2">
                {applicants.map((app) => (
                  <Card key={app.user_id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Avatar id={app.user_id} size="sm" base={api.base} />
                      <span className="min-w-0 flex-1 truncate text-base font-medium">
                        {shortName(app.user_id)}
                      </span>
                      <span className="tnum shrink-0 text-xs text-muted">
                        {relative(app.created_at)}
                      </span>
                    </div>
                    {(app.answers || []).map((qa, i) => (
                      <div key={i} className="border-s-2 border-border ps-3">
                        <div className="eyebrow">{qa.question}</div>
                        <div className="pt-0.5 text-base leading-[1.55]">{qa.answer}</div>
                      </div>
                    ))}
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={() => decideApplicant(app.user_id, 'approve')}>
                        {t('guild.queue.admit')}
                      </Button>
                      <Button variant="danger-soft" onClick={() => decideApplicant(app.user_id, 'reject')}>
                        {t('guild.queue.reject')}
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <EmptyState icon={MembersIcon} title={t('guild.queue.applicants.emptyTitle')}>
                {t('guild.queue.applicants.emptyBody')}
              </EmptyState>
            )}
          </Section>
        </>
      )}
    </Async>
  );
}

function Card({ children }) {
  return (
    <div className="rise-in flex flex-col gap-2 panel px-3 py-3">
      {children}
    </div>
  );
}
