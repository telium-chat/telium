import { useEffect, useMemo, useRef, useState } from 'react';
import { useAsync, useOptionalStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { list } from '../../lib/i18n/index.js';
import {
  Async, BotCapabilityChecklist, Button, DataTable, Hint, Notice, Pill, Section, TextInput,
} from '../../components/index.js';
import { PERMISSIONS, permissionInfo } from '../../lib/perms.js';

function parseReference(value) {
  const text = value.trim();
  const slash = text.lastIndexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  const origin = text.slice(0, slash);
  const id = text.slice(slash + 1);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return null;
  return { origin, id };
}

function mergeNames(primary = [], secondary = []) {
  return [...new Set([...primary, ...secondary])];
}

function withdrawn(ceiling = [], current = []) {
  const offered = new Set(ceiling);
  return current.filter((name) => !offered.has(name));
}

export function BotsPane({ guildId, api }) {
  const store = useOptionalStore();
  const t = useT();
  const state = useAsync(
    () => api.get(`/_telium/v1/guilds/${guildId}/bots`).then((r) => r.bots || []),
    [guildId],
  );
  const [reference, setReference] = useState('');
  const [review, setReview] = useState(null);
  const [intents, setIntents] = useState([]);
  const [permissions, setPermissions] = useState([]);
  const [reviewing, setReviewing] = useState(false);
  const previewRequest = useRef(0);
  const [installing, setInstalling] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  const cannotGrant = useMemo(() => {
    if (!store) return {};
    const out = {};
    for (const name of PERMISSIONS) {
      if (!store.canInGuild(guildId, name)) {
        out[name] = t('bots.install.cannotGrant');
      }
    }
    return out;
  }, [store, guildId, t]);

  useEffect(() => {
    const parsed = parseReference(reference);
    const requestId = ++previewRequest.current;

    setReview(null);
    setIntents([]);
    setPermissions([]);
    if (!parsed) {
      setReviewing(false);
      return undefined;
    }

    const timer = setTimeout(async () => {
      setReviewing(true);
      try {
        const descriptor = await api.post(`/_telium/v1/guilds/${guildId}/bots/preview`, {
          application_id: parsed.id,
          application_origin: parsed.origin,
        });
        if (previewRequest.current !== requestId) return;
        setReview(descriptor);
        setIntents([...(descriptor.allowed_intent_names || [])]);
        setPermissions((descriptor.default_permission_names || []).filter((name) => (
          !permissionInfo(name).danger && !(store && !store.canInGuild(guildId, name))
        )));
      } catch (error) {
        if (previewRequest.current !== requestId) return;
        setReview(null);
        setIntents([]);
        setPermissions([]);
        reportError(error, t('bots.install.previewFailed'));
      } finally {
        if (previewRequest.current === requestId) setReviewing(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [api, guildId, reference, store, t]);

  const install = async () => {
    if (!review || installing) return;
    setInstalling(true);
    try {
      await api.post(`/_telium/v1/guilds/${guildId}/bots`, {
        application_id: review.application_id,
        application_origin: review.application_origin,
        intents,
        permissions,
      });
      setReference('');
      setReview(null);
      setIntents([]);
      setPermissions([]);
      state.reload();
    } catch (error) {
      reportError(error, t('bots.install.failed'));
    } finally {
      setInstalling(false);
    }
  };

  const beginEdit = async (bot) => {
    setEditing({
      bot_user_id: bot.bot_user_id,
      application_id: bot.application_id,
      display_name: bot.display_name || bot.bot_user_id,
      intents: [...(bot.allowed_intent_names || [])],
      permissions: [...(bot.permission_names || [])],
      available_intents: [...(bot.allowed_intent_names || [])],
      available_permissions: [...(bot.permission_names || [])],
      withdrawn_intents: [],
      withdrawn_permissions: [],
      loading_capabilities: true,
      limited_to_current: false,
    });
    try {
      const descriptor = await api.post(`/_telium/v1/guilds/${guildId}/bots/preview`, {
        application_id: bot.application_id,
        application_origin: bot.application_origin,
      });
      setEditing((current) => (
        current?.bot_user_id === bot.bot_user_id
          ? {
            ...current,
            available_intents: mergeNames(
              descriptor.allowed_intent_names,
              bot.allowed_intent_names,
            ),
            available_permissions: mergeNames(
              descriptor.default_permission_names,
              bot.permission_names,
            ),
            withdrawn_intents: withdrawn(
              descriptor.allowed_intent_names,
              bot.allowed_intent_names,
            ),
            withdrawn_permissions: withdrawn(
              descriptor.default_permission_names,
              bot.permission_names,
            ),
            loading_capabilities: false,
          }
          : current
      ));
    } catch {
      setEditing((current) => (
        current?.bot_user_id === bot.bot_user_id
          ? { ...current, loading_capabilities: false, limited_to_current: true }
          : current
      ));
    }
  };

  const saveEdit = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await api.patch(
        `/_telium/v1/guilds/${guildId}/bots/${encodeURIComponent(editing.bot_user_id)}`,
        {
          intents: editing.intents,
          permissions: editing.permissions,
        },
      );
      setEditing(null);
      state.reload();
    } catch (error) {
      reportError(error, t('bots.edit.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Section title={t('bots.install.title')}>
        <Hint>{t('bots.install.intro')}</Hint>
        <TextInput
          label={t('bots.install.referenceLabel')}
          placeholder={t('bots.install.referencePlaceholder')}
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          hint={reviewing ? t('bots.install.loading') : t('bots.install.referenceHint')}
        />

        {review ? (
          <div className="flex flex-col gap-4 rounded-card bg-surface-secondary p-4">
            <div className="min-w-0">
              <div className="eyebrow">{t('bots.install.thirdParty')}</div>
              <div className="min-w-0 pt-0.5 text-base font-semibold break-words">
                {review.application_origin}
              </div>
              <div className="min-w-0 pt-1 text-sm break-words text-muted">
                <Trans
                  k="bots.install.callsItself"
                  values={{ name: clamp(review.name) || t('bots.install.unnamed') }}
                  components={{ name: <span className="font-medium text-foreground" /> }}
                />
              </div>
              <div className="min-w-0 truncate pt-0.5 text-xs text-muted">{review.bot_user_id}</div>
              {review.description ? (
                <div className="mt-2 text-sm break-words text-muted">{clamp(review.description, 400)}</div>
              ) : null}
            </div>

            {!review.install_enabled ? (
              <Notice tone="warn">{t('bots.install.closed')}</Notice>
            ) : null}

            <BotCapabilityChecklist
              kind="intent"
              title={t('bots.install.intentsTitle')}
              names={review.allowed_intent_names || []}
              value={intents}
              onChange={setIntents}
              hint={t('bots.install.intentsHint')}
              empty={t('bots.install.intentsEmpty')}
            />
            <BotCapabilityChecklist
              kind="permission"
              title={t('bots.install.permissionsTitle')}
              names={review.default_permission_names || []}
              value={permissions}
              onChange={setPermissions}
              blocked={cannotGrant}
              hint={t('bots.install.permissionsHint')}
              empty={t('bots.install.permissionsEmpty')}
            />

            <Button
              className="self-start"
              onClick={install}
              disabled={installing || !review.install_enabled}
            >
              {installing
                ? t('bots.install.installing')
                : clamp(review.name, 40)
                  ? t('bots.install.submit', { name: clamp(review.name, 40) })
                  : t('bots.install.submitUnnamed')}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title={t('bots.list.title')}>
        <Notice>{t('bots.list.notice')}</Notice>

        {editing ? (
          <div className="flex flex-col gap-3 rounded-card bg-surface-secondary p-3">
            <div className="min-w-0">
              <div className="font-medium break-words">
                {t('bots.edit.heading', { name: editing.display_name })}
              </div>
              <div className="truncate text-xs text-muted">{editing.bot_user_id}</div>
            </div>
            {editing.limited_to_current ? (
              <Notice tone="warn">{t('bots.edit.offline')}</Notice>
            ) : null}
            <BotCapabilityChecklist
              kind="intent"
              title={t('bots.edit.intentsTitle')}
              names={editing.available_intents}
              value={editing.intents}
              retained={editing.withdrawn_intents}
              onChange={(next) => setEditing((current) => ({ ...current, intents: next }))}
              disabled={saving}
              hint={editing.loading_capabilities
                ? t('bots.edit.ceilingLoading')
                : t('bots.edit.intentsHint')}
            />
            <BotCapabilityChecklist
              kind="permission"
              title={t('bots.edit.permissionsTitle')}
              names={editing.available_permissions}
              value={editing.permissions}
              retained={editing.withdrawn_permissions}
              blocked={cannotGrant}
              onChange={(next) => setEditing((current) => ({ ...current, permissions: next }))}
              disabled={saving}
              hint={editing.loading_capabilities
                ? t('bots.edit.ceilingLoading')
                : t('bots.edit.permissionsHint')}
            />
            <div className="flex gap-2">
              <Button onClick={saveEdit} disabled={saving}>
                {saving ? t('common.saving') : t('bots.edit.save')}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        ) : null}

        <Async state={state}>
          {(bots) => (
            <DataTable
              rows={bots}
              rowKey={(bot) => bot.bot_user_id}
              empty={t('bots.list.empty')}
              label={t('bots.list.tableLabel')}
              columns={[
                {
                  key: 'bot',
                  header: t('bots.list.colBot'),
                  render: (bot) => (
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-medium">
                          {bot.display_name || bot.bot_user_id}
                        </span>
                        <Pill tone="accent">{t('bots.list.badge')}</Pill>
                      </div>
                      <div className="truncate text-xs text-muted">{bot.bot_user_id}</div>
                    </div>
                  ),
                },
                {
                  key: 'permissions',
                  header: t('bots.list.colPermissions'),
                  render: (bot) => list(bot.permission_names || [], 'unit') || t('common.none'),
                },
                {
                  key: 'intents',
                  header: t('bots.list.colIntents'),
                  render: (bot) => list(bot.allowed_intent_names || [], 'unit') || t('common.none'),
                },
                {
                  key: 'actions',
                  header: '',
                  render: (bot) => (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="secondary" onClick={() => beginEdit(bot)}>
                        {t('common.edit')}
                      </Button>
                      <Button
                        variant="danger-soft"
                        onClick={async () => {
                          try {
                            await api.del(
                              `/_telium/v1/guilds/${guildId}/bots/${encodeURIComponent(bot.bot_user_id)}`,
                            );
                            if (editing?.bot_user_id === bot.bot_user_id) setEditing(null);
                            state.reload();
                          } catch (error) {
                            reportError(error, t('bots.list.removeFailed'));
                          }
                        }}
                      >
                        {t('common.remove')}
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

function clamp(value, max = 120) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
