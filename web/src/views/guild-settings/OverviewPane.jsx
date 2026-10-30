import { useEffect, useState } from 'react';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { uploadGuildIcon } from '../../lib/upload.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { portalInviteLink } from '../../lib/invites.js';
import { t } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  Async, Avatar, Button, Field, FilePicker, Hint, Notice, Section, Select, Switch, TextArea,
  TextInput, useDialogs,
} from '../../components/index.js';
import { useImageCrop } from '../dialogs/CropImageDialog.jsx';
import { MigrationDialog } from '../user-settings/MigrationDialog.jsx';

const CAP_CHOICES = [
  ['', 'guild.duration.unlimited'],
  ['3600', 'guild.duration.hour'],
  ['21600', 'guild.duration.sixHours'],
  ['86400', 'guild.duration.day'],
  ['259200', 'guild.duration.threeDays'],
  ['604800', 'guild.duration.week'],
  ['2592000', 'guild.duration.thirtyDays'],
];

export function OverviewPane({ guildId, api, close }) {
  const store = useStore();
  const modal = useModal();
  const tr = useT();
  const state = useAsync(() => api.guild(guildId), [guildId]);
  const guildDomain = store.guilds.get(guildId)?.domain;

  return (
    <Async state={state}>
      {(guild) => (
        <>
          <Editor guildId={guildId} api={api} guild={guild} />
          <VanityLinkEditor
            guildId={guildId}
            api={api}
            guild={guild}
            onChanged={state.reload}
          />
          <ExpiryLimitEditor guildId={guildId} api={api} guild={guild} />
          <FileSizeLimitEditor guildId={guildId} api={api} guild={guild} />
          <TransferPane guildId={guildId} api={api} guild={guild} onTransferred={state.reload} />
          <Section title={tr('guild.overview.move.title')}>
            <Hint>
              {tr('guild.overview.move.hint')}
            </Hint>
            {guild.owner !== store.me?.user_id ? (
              <Notice>
                {tr('guild.overview.move.ownerOnly')}
              </Notice>
            ) : store.session?.home?.domain === guildDomain ? (
              <Button
                className="self-start"
                onClick={() => modal.open((close) => (
                  <MigrationDialog
                    subjectType="guild"
                    subjectId={guildId}
                    subjectName={guild.name}
                    close={close}
                  />
                ))}
              >
                {tr('guild.overview.move.button')}
              </Button>
            ) : (
              <Notice>
                {tr('guild.overview.move.elsewhere', { domain: guildDomain })}
              </Notice>
            )}
          </Section>
          <DeletePane guildId={guildId} api={api} guild={guild} close={close} />
        </>
      )}
    </Async>
  );
}

function TransferPane({ guildId, api, guild, onTransferred }) {
  const store = useStore();
  const dialogs = useDialogs();
  const tr = useT();
  if (guild.owner !== store.me?.user_id) return null;
  return (
    <Section title={tr('guild.overview.transfer.title')}>
      <Hint>
        {tr('guild.overview.transfer.hint')}
      </Hint>
      <Button
        variant="danger-soft"
        className="self-start"
        onClick={() => dialogs.prompt({
          title: t('guild.overview.transfer.dialogTitle', { name: guild.name }),
          label: t('guild.overview.transfer.label'),
          hint: t('guild.overview.transfer.dialogHint'),
          placeholder: t('guild.overview.transfer.placeholder'),
          confirmLabel: t('guild.overview.transfer.confirm'),
          danger: true,
          onSubmit: async (value) => {
            try {
              await api.transferOwnership(guildId, value.trim());
              toast(t('guild.overview.transfer.done'));
              onTransferred?.();
            } catch (e) { reportError(e, t('guild.overview.transfer.failed')); }
          },
        })}
      >
        {tr('guild.overview.transfer.button')}
      </Button>
    </Section>
  );
}

function DeletePane({ guildId, api, guild, close }) {
  const store = useStore();
  const dialogs = useDialogs();
  const tr = useT();
  if (guild.owner !== store.me?.user_id) return null;
  return (
    <Section title={tr('guild.overview.delete.title')}>
      <Hint>
        {tr('guild.overview.delete.hint')}
      </Hint>
      <Button
        variant="danger"
        className="self-start"
        onClick={() => dialogs.prompt({
          title: t('guild.overview.delete.dialogTitle', { name: guild.name }),
          label: t('guild.overview.delete.label'),
          hint: t('guild.overview.delete.dialogHint'),
          require: guild.name,
          placeholder: guild.name,
          confirmLabel: t('guild.overview.delete.confirm'),
          danger: true,
          onSubmit: async () => {
            try {
              await api.deleteGuild(guildId);
              close?.();
              store.dropGuild(guildId);
            } catch (e) { reportError(e, t('guild.overview.delete.failed')); }
          },
        })}
      >
        {tr('guild.overview.delete.button')}
      </Button>
    </Section>
  );
}

function Editor({ guildId, api, guild }) {
  const store = useStore();
  const cropImage = useImageCrop();
  const tr = useT();
  const [name, setName] = useState(guild.name);
  const [description, setDescription] = useState(guild.description || '');
  const [iconRef, setIconRef] = useState(guild.icon_ref || null);
  const [iconNote, setIconNote] = useState(
    guild.icon_ref ? 'guild.overview.iconSet' : 'guild.overview.iconNone',
  );
  const [iconBusy, setIconBusy] = useState(false);
  useEffect(() => {
    setName(guild.name);
    setDescription(guild.description || '');
    setIconRef(guild.icon_ref || null);
    setIconNote(guild.icon_ref ? 'guild.overview.iconSet' : 'guild.overview.iconNone');
  }, [guild]);

  const pickIcon = async (picked) => {
    if (!picked || iconBusy) return;
    const file = await cropImage(picked, 'icon');
    if (!file) return;
    setIconBusy(true);
    try {
      const nextRef = await uploadGuildIcon(api, guildId, file);
      setIconRef(nextRef);
      setIconNote('guild.overview.iconSet');
    } catch (e) {
      reportError(e, t('guild.overview.iconFailed'));
    } finally {
      setIconBusy(false);
    }
  };

  return (
    <Section>
      <div className="flex items-center gap-3 panel px-3 py-3">
        <Avatar
          id={guild.id}
          name={name}
          size="lg"
          mediaRef={iconRef}
          base={api.base}
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <FilePicker
            accept="image/*"
            label={iconBusy ? tr('guild.overview.savingIcon') : tr('guild.overview.chooseIcon')}
            onPick={pickIcon}
            className={iconBusy ? 'pointer-events-none opacity-60' : undefined}
          />
          <p className="text-xs text-muted">{tr(iconNote)}</p>
        </div>
      </div>
      <Field label={tr('guild.overview.name')}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={tr('guild.overview.description')}>
        <TextArea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Hint>
        {guild.member_count == null
          ? tr('guild.overview.memberCountUnknown')
          : tr('guild.overview.memberCount', { count: guild.member_count })}
        {' '}
        {guild.created_at
          ? tr('guild.overview.created', { at: guild.created_at })
          : tr('guild.overview.createdUnknown')}
      </Hint>
      <Button
        variant="primary"
        className="self-start"
        onClick={async () => {
          try {
            await api.patchGuild(guildId, { name: name.trim(), description, icon_ref: iconRef });
            toast(t('common.saved'));
          } catch (e) { reportError(e, t('guild.overview.saveFailed')); }
        }}
      >
        {tr('common.save')}
      </Button>
    </Section>
  );
}

function aliasLocalpart(address) {
  if (!address) return '';
  const text = String(address).replace(/^#/, '');
  const split = text.indexOf(':');
  return split < 0 ? text : text.slice(0, split);
}

function VanityLinkEditor({ guildId, api, guild, onChanged }) {
  const tr = useT();
  const [enabled, setEnabled] = useState(Boolean(guild.alias));
  const [alias, setAlias] = useState(aliasLocalpart(guild.alias));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEnabled(Boolean(guild.alias));
    setAlias(aliasLocalpart(guild.alias));
  }, [guild]);

  const localpart = alias.trim().replace(/^#/, '').toLowerCase();
  const address = enabled && localpart
    ? `#${localpart}:${guild.origin}`
    : null;
  const publicBase = String(guild.public_base_url || api.base || '').replace(/\/+$/, '');
  const browserLink = enabled && localpart
    ? (portalInviteLink(guild.invite_portal, guild.origin, localpart)
      || (publicBase ? `${publicBase}/invite/${encodeURIComponent(localpart)}` : null))
    : null;

  return (
    <Section title={tr('guild.overview.vanity.title')}>
      <div className="panel px-3">
        <Switch
          label={tr('guild.overview.vanity.toggle')}
          hint={tr('guild.overview.vanity.hint')}
          checked={enabled}
          disabled={busy}
          onChange={setEnabled}
        />
      </div>
      {enabled ? (
        <>
          <Field label={tr('guild.overview.vanity.label')}>
            <TextInput
              value={alias}
              placeholder={tr('guild.overview.vanity.placeholder')}
              disabled={busy}
              onChange={(e) => setAlias(e.target.value)}
            />
          </Field>
          {address ? <Hint>{tr('guild.overview.vanity.address', { address })}</Hint> : null}
          {browserLink ? (
            <Field label={tr('guild.overview.vanity.linkLabel')}>
              <div className="flex items-center gap-2">
                <TextInput value={browserLink} readOnly />
                <Button
                  variant="secondary"
                  onClick={() => copyToClipboard(
                    browserLink,
                    tr('guild.overview.vanity.linkClipboard'),
                  )}
                >
                  {tr('common.copy')}
                </Button>
              </div>
            </Field>
          ) : null}
        </>
      ) : null}
      <Button
        variant="primary"
        className="self-start"
        loading={busy}
        isDisabled={busy || (enabled && !alias.trim())}
        onClick={async () => {
          setBusy(true);
          try {
            if (enabled) {
              await api.setGuildAlias(guildId, alias.trim().replace(/^#/, ''));
            } else if (guild.alias) {
              await api.clearGuildAlias(guildId);
            }
            toast(t('common.saved'));
            onChanged?.();
          } catch (e) {
            reportError(e, t('guild.overview.vanity.saveFailed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr('common.save')}
      </Button>
    </Section>
  );
}

function FileSizeLimitEditor({ guildId, api, guild }) {
  const tr = useT();
  const [cap, setCap] = useState(
    guild.media_max_file_bytes == null ? '' : String(guild.media_max_file_bytes),
  );
  useEffect(() => {
    setCap(guild.media_max_file_bytes == null ? '' : String(guild.media_max_file_bytes));
  }, [guild]);

  return (
    <Section title={tr('guild.overview.fileSize.title')}>
      <Hint>
        {tr('guild.overview.fileSize.hint')}
      </Hint>
      <Field label={tr('guild.overview.fileSize.label')}>
        <TextInput
          value={cap}
          placeholder={tr('guild.overview.fileSize.placeholder')}
          onChange={(e) => setCap(e.target.value)}
        />
      </Field>
      <Button
        variant="primary"
        className="self-start"
        onClick={async () => {
          const value = cap.trim() === '' ? null : Number(cap);
          try {
            await api.patchGuild(guildId, { media_max_file_bytes: value });
            toast(t('common.saved'));
          } catch (e) { reportError(e, t('guild.overview.saveFailed')); }
        }}
      >
        {tr('common.save')}
      </Button>
    </Section>
  );
}

function ExpiryLimitEditor({ guildId, api, guild }) {
  const tr = useT();
  const [cap, setCap] = useState(
    guild.media_expiry_limit_secs == null ? '' : String(guild.media_expiry_limit_secs),
  );
  useEffect(() => {
    setCap(guild.media_expiry_limit_secs == null ? '' : String(guild.media_expiry_limit_secs));
  }, [guild]);

  return (
    <Section title={tr('guild.overview.expiry.title')}>
      <Hint>
        {tr('guild.overview.expiry.hint')}
      </Hint>
      <Field label={tr('guild.overview.expiry.label')}>
        <Select
          value={cap}
          options={CAP_CHOICES.map(([value, key]) => [value, tr(key)])}
          onChange={(e) => setCap(e.target.value)}
        />
      </Field>
      <Button
        variant="primary"
        className="self-start"
        onClick={async () => {
          const value = cap === '' ? null : Number(cap);
          try {
            await api.patchGuild(guildId, { media_expiry_limit_secs: value });
            toast(t('common.saved'));
          } catch (e) { reportError(e, t('guild.overview.saveFailed')); }
        }}
      >
        {tr('common.save')}
      </Button>
    </Section>
  );
}
