import { useEffect, useRef, useState } from 'react';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import {
  Async,
  BotCapabilityChecklist,
  BOT_INTENT_NAMES,
  BOT_PERMISSION_NAMES,
  Button,
  DataTable,
  Hint,
  Notice,
  Pill,
  Section,
  TextInput,
  useDialogs,
} from '../../components/index.js';
import { RecoveryKeyText, downloadText } from './RecoveryParts.jsx';

const DEFAULT_INTENTS = ['GUILD_MESSAGES', 'GUILD_STRUCTURE'];
const DEFAULT_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY'];

function downloadToken(appName, value) {
  const who = String(appName || 'application').replace(/[^a-zA-Z0-9._-]/g, '-');
  downloadText(`telium-bot-token-${who}.txt`, [
    'Telium bot token',
    `Application: ${appName}`,
    '',
    value,
    '',
    'This token is the bot. Anyone holding it can act as it on every server',
    'the bot is installed in. It is shown once and cannot be retrieved again;',
    'resetting it issues a new one and stops every deployment using this one.',
    '',
  ].join('\n'));
}

export function DeveloperPane() {
  const store = useStore();
  const dialogs = useDialogs();
  const state = useAsync(
    () => store.home.get('/_telium/v1/applications').then((r) => r.applications || []),
    [],
  );
  const [name, setName] = useState('');
  const [localpart, setLocalpart] = useState('');
  const [description, setDescription] = useState('');
  const [intents, setIntents] = useState(DEFAULT_INTENTS);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [token, setToken] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);

  const tokenBox = useRef(null);
  useEffect(() => {
    if (token) tokenBox.current?.querySelector('[role="group"]')?.focus();
  }, [token]);

  const overwriting = (whatNext, run) => {
    if (!token) { run(); return; }
    dialogs.confirm({
      title: 'Replace the token on screen?',
      body: `The ${token.app} token is still showing and exists nowhere else — Telium keeps only a `
        + 'hash of it. If you have not copied or saved it yet, it is lost the moment this one '
        + 'replaces it, and the only way to get another is a reset that stops every deployment '
        + 'already using it.',
      confirmLabel: whatNext,
      danger: true,
      onConfirm: run,
    });
  };

  const create = () => overwriting('Create anyway', async () => {
    if (creating) return;
    setCreating(true);
    try {
      const app = await store.home.post('/_telium/v1/applications', {
        name,
        localpart,
        description,
        allowed_intents: intents,
        default_permissions: permissions,
      });
      setToken({ app: app.name, value: app.token });
      setName('');
      setLocalpart('');
      setDescription('');
      setIntents([...DEFAULT_INTENTS]);
      setPermissions([...DEFAULT_PERMISSIONS]);
      state.reload();
    } catch (error) {
      reportError(error, 'Could not create application');
    } finally {
      setCreating(false);
    }
  });

  const resetToken = (app) => dialogs.confirm({
    title: `Reset the token for ${app.name}?`,
    body: 'The current token stops working immediately. Every bot process running on it — every '
      + 'server, every container, every script — is signed out at that moment and stays down until '
      + 'you deploy the new one. The replacement is shown once and cannot be retrieved afterwards.'
      + (token ? ` The ${token.app} token currently on screen will be replaced by it.` : ''),
    confirmLabel: 'Reset the token',
    danger: true,
    onConfirm: async () => {
      try {
        const result = await store.home.post(
          `/_telium/v1/applications/${encodeURIComponent(app.id)}/token/reset`,
          {},
        );
        setToken({ app: app.name, value: result.token });
        state.reload();
      } catch (error) {
        reportError(error, 'Could not reset bot token');
      }
    },
  });

  const beginEdit = (app) => {
    setEditing({
      id: app.id,
      name: app.name,
      description: app.description || '',
      intents: [...(app.allowed_intent_names || [])],
      permissions: [...(app.default_permission_names || [])],
      install_enabled: app.install_enabled,
    });
  };

  const saveEdit = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      await store.home.patch(`/_telium/v1/applications/${encodeURIComponent(editing.id)}`, {
        name: editing.name,
        description: editing.description,
        allowed_intents: editing.intents,
        default_permissions: editing.permissions,
        install_enabled: editing.install_enabled,
      });
      setEditing(null);
      state.reload();
    } catch (error) {
      reportError(error, 'Could not update application');
    } finally {
      setSaving(false);
    }
  };

  const retire = (app) => dialogs.confirm({
    title: `Retire ${app.name}?`,
    body: 'This is permanent. Telium revokes the bot token, stops new installations, and reserves '
      + `${app.bot_user_id} so nobody can later inherit the bot's old identity. Existing guilds can `
      + 'still remove the inactive bot from their member list.',
    confirmLabel: 'Retire permanently',
    danger: true,
    onConfirm: async () => {
      try {
        await store.home.del(`/_telium/v1/applications/${encodeURIComponent(app.id)}`);
        setToken((current) => (current?.app === app.name ? null : current));
        state.reload();
      } catch (error) {
        reportError(error, 'Could not retire application');
      }
    },
  });

  const dismissToken = () => dialogs.confirm({
    title: 'Hide this token?',
    body: `Telium cannot show the ${token.app} token again. If it is not already in your password `
      + 'manager, your deployment’s secrets, or a file you have saved, hiding it now means '
      + 'resetting to get another — which stops every deployment running on this one.',
    confirmLabel: 'I have saved it',
    danger: true,
    onConfirm: () => setToken(null),
  });

  return (
    <>
      <Section title="Bot applications">
        <Hint>
          {'Bot identities are separate from your human account. Their long-lived token is accepted only '
            + 'by this home server; guild servers receive short-lived, audience-bound sessions instead.'}
        </Hint>
        {token ? (
          <Notice tone="warn" role="status" aria-live="assertive">
            <div className="flex min-w-0 flex-col gap-2">
              <div>
                <strong>{`${token.app} token — copy it now. It will not be shown again.`}</strong>
              </div>
              <div ref={tokenBox}>
                <RecoveryKeyText value={token.value} label={`${token.app} bot token`} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() => copyToClipboard(token.value, 'Bot token')}
                >
                  Copy token
                </Button>
                <Button variant="ghost" onClick={() => downloadToken(token.app, token.value)}>
                  Download as a file
                </Button>
                <Button variant="ghost" onClick={dismissToken}>Hide</Button>
              </div>
            </div>
          </Notice>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <TextInput label="Application name" value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput
            label="Bot ID"
            value={localpart}
            placeholder="weather"
            onChange={(e) => setLocalpart(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))}
          />
        </div>
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <BotCapabilityChecklist
          kind="intent"
          title="Allowed intents"
          names={BOT_INTENT_NAMES}
          value={intents}
          onChange={setIntents}
          disabled={creating}
          hint="Choose the event categories this application may ever request. Message content is intentionally separate."
        />
        <BotCapabilityChecklist
          kind="permission"
          title="Permission ceiling"
          names={BOT_PERMISSION_NAMES}
          value={permissions}
          onChange={setPermissions}
          disabled={creating}
          hint="These are the most permissions any server may grant this bot. Server admins can always choose less."
        />
        <Button
          className="self-start"
          disabled={creating || !name.trim() || !localpart.trim()}
          onClick={create}
        >
          {creating ? 'Creating…' : 'Create application'}
        </Button>
      </Section>

      {editing ? (
        <Section title={`Edit ${editing.name}`}>
          <div className="flex flex-col gap-3">
            <TextInput
              label="Application name"
              value={editing.name}
              onChange={(e) => setEditing((current) => ({ ...current, name: e.target.value }))}
            />
            <TextInput
              label="Description"
              value={editing.description}
              onChange={(e) => setEditing((current) => ({ ...current, description: e.target.value }))}
            />
            <BotCapabilityChecklist
              kind="intent"
              title="Allowed intents"
              names={BOT_INTENT_NAMES}
              value={editing.intents}
              onChange={(next) => setEditing((current) => ({ ...current, intents: next }))}
              disabled={saving}
              hint="Lowering this ceiling converges on fresh short-lived bot sessions."
            />
            <BotCapabilityChecklist
              kind="permission"
              title="Permission ceiling"
              names={BOT_PERMISSION_NAMES}
              value={editing.permissions}
              onChange={(next) => setEditing((current) => ({ ...current, permissions: next }))}
              disabled={saving}
              hint="Lowering this ceiling can only remove powers from installed bots; raising it never grants powers automatically."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => setEditing((current) => ({
                  ...current,
                  install_enabled: !current.install_enabled,
                }))}
              >
                {editing.install_enabled ? 'Pause new installs' : 'Allow new installs'}
              </Button>
              <Button onClick={saveEdit} disabled={saving || !editing.name.trim()}>
                {saving ? 'Saving…' : 'Save application'}
              </Button>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </Button>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="Your applications">
        <Async state={state}>
          {(apps) => (
            <DataTable
              rows={apps}
              rowKey={(app) => app.id}
              empty="You have not created any bot applications."
              columns={[
                {
                  key: 'app',
                  header: 'Application',
                  render: (app) => (
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        <span>{app.name}</span>
                        {app.retired ? <Pill>retired</Pill> : null}
                        {!app.retired && !app.install_enabled ? <Pill>installs off</Pill> : null}
                      </div>
                      <div className="truncate text-xs text-muted">{app.bot_user_id}</div>
                    </div>
                  ),
                },
                {
                  key: 'intents',
                  header: 'Intents',
                  render: (app) => (app.allowed_intent_names || []).join(', ') || 'None',
                },
                {
                  key: 'actions',
                  header: '',
                  render: (app) => (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => copyToClipboard(
                          `${app.origin}/${app.id}`,
                          'Application reference',
                        )}
                      >
                        Copy reference
                      </Button>
                      {!app.retired ? (
                        <>
                          <Button variant="ghost" onClick={() => beginEdit(app)}>Edit</Button>
                          <Button variant="danger-soft" onClick={() => resetToken(app)}>
                            Reset token
                          </Button>
                          <Button variant="danger-soft" onClick={() => retire(app)}>
                            Retire
                          </Button>
                        </>
                      ) : null}
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
