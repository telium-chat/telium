import { useEffect, useMemo, useRef, useState } from 'react';
import { DndProvider, useDrag } from 'react-dnd';
import { cn } from '../../lib/cn.js';
import { useAsync, useStore } from '../../hooks/useStore.jsx';
import { useDragRoot } from '../../hooks/useDragRoot.js';
import { useZones } from '../../hooks/useZones.js';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { n } from '../../lib/i18n/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import {
  PERMISSION_GROUPS, PERMISSIONS, permissionInfo,
} from '../../lib/perms.js';
import {
  mayDropAt, mayHold, moveRole, rankedRoles, roleMoves,
} from '../../lib/roles.js';
import { remoteMediaOrigin } from '../../lib/media.js';
import { colourOf, colourToInt, shortName } from '../../lib/util.js';
import {
  Async, Avatar, BackIcon, Button, DropLine, EditIcon, EmojiText, EmptyState, Hint,
  IconButton, Loading, MembersIcon, Notice, PlusIcon, Section, ShieldIcon, SwatchRow, Switch,
  Tabs, TextInput, TrashIcon, useDialogs, WarnIcon
} from '../../components/index.js';

const swatches = (t) => [
  [t('roles.colour.indigo'), '#5865f2'],
  [t('roles.colour.green'), '#57f287'],
  [t('roles.colour.yellow'), '#fee75c'],
  [t('roles.colour.pink'), '#eb459e'],
  [t('roles.colour.red'), '#ed4245'],
  [t('roles.colour.teal'), '#1abc9c'],
  [t('roles.colour.orange'), '#e67e22'],
  [t('roles.colour.purple'), '#9b59b6'],
  [t('roles.colour.blue'), '#3498db'],
  [t('roles.colour.grey'), '#95a5a6'],
  [t('roles.colour.emerald'), '#2ecc71'],
  [t('roles.colour.gold'), '#f1c40f'],
];

const DRAG = 'settings-role';

export function RolesPane({ guildId, api }) {
  const store = useStore();
  const fetched = useAsync(() => api.roles(guildId).then((r) => r.roles || []), [guildId]);
  const [roles, setRoles] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { if (fetched.data) setRoles(fetched.data); }, [fetched.data]);

  const open = roles?.find((r) => r.id === openId);
  useEffect(() => { if (openId && roles && !open) setOpenId(null); }, [openId, roles, open]);

  if (!roles) {
    return <Async state={fetched} empty={null}>{() => <Loading />}</Async>;
  }

  return open ? (
    <RoleEditor
      key={open.id}
      guildId={guildId}
      api={api}
      role={open}
      onBack={() => setOpenId(null)}
      saved={fetched.reload}
    />
  ) : (
    <RoleList
      guildId={guildId}
      api={api}
      roles={roles}
      me={store.myMember(guildId)}
      setRoles={setRoles}
      onOpen={setOpenId}
      reload={fetched.reload}
    />
  );
}


function RoleList({ guildId, api, roles, me, setRoles, onOpen, reload }) {
  const dialogs = useDialogs();
  const t = useT();
  const [query, setQuery] = useState('');
  const [setRoot, manager] = useDragRoot();

  const everyone = roles.find((r) => r.id === guildId);
  const ranked = useMemo(() => rankedRoles(roles, guildId), [roles, guildId]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? ranked.filter((r) => r.name.toLowerCase().includes(needle)) : ranked;

  const place = async (id, at) => {
    const next = moveRole(ranked, id, at);
    const moves = roleMoves(next);
    if (!moves.length) return;
    const before = roles;
    const positions = new Map(moves.map((m) => [m.id, m.position]));
    setRoles(roles.map((r) => (positions.has(r.id) ? { ...r, position: positions.get(r.id) } : r)));
    try {
      const out = await api.reorderRoles(guildId, moves);
      if (out?.roles) setRoles(out.roles);
    } catch (e) {
      setRoles(before);
      reportError(e, t('roles.reorder.failed'));
    }
  };

  const create = () => dialogs.prompt({
    title: t('roles.create.title'),
    label: t('roles.create.nameLabel'),
    confirmLabel: t('roles.create.confirm'),
    onSubmit: async (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const role = await api.createRole(guildId, { name: trimmed });
        reload();
        if (role?.id) onOpen(role.id);
      } catch (e) { reportError(e, t('roles.create.failed')); }
    },
  });

  const remove = (role) => dialogs.confirm({
    title: t('roles.delete.title', { role: role.name }),
    body: t('roles.delete.body'),
    confirmLabel: t('common.delete'),
    danger: true,
    onConfirm: async () => {
      try { await api.deleteRole(guildId, role.id); reload(); }
      catch (e) { reportError(e, t('roles.delete.failed')); }
    },
  });

  const rows = shown.map((role, i) => (
    <RoleRow
      key={role.id}
      role={role}
      at={ranked.indexOf(role)}
      me={me}
      ranked={ranked}
      draggable={!needle && mayHold(me, role)}
      onOpen={() => onOpen(role.id)}
      onDelete={() => remove(role)}
      onPlace={place}
      first={i === 0}
    />
  ));

  return (
    <>
      <Section className="pb-4">
        <Hint>{t('roles.list.hint')}</Hint>
      </Section>

      <Section title={t('roles.everyone.title')} description={t('roles.everyone.description')}>
        {everyone ? (
          <button
            type="button"
            onClick={() => onOpen(everyone.id)}
            className="flex items-center gap-3 panel px-3 py-2.5 text-start transition-colors hover:bg-rail-hover"
          >
            <MembersIcon className="size-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold">@everyone</span>
              <span className="block truncate text-xs text-muted">
                {t('roles.memberCount', { count: everyone.member_count ?? 0 })}
              </span>
            </span>
            <span className="text-xs text-muted">{t('common.edit')}</span>
          </button>
        ) : null}
      </Section>

      <Section
        title={t('roles.list.title', { count: ranked.length })}
        description={t('roles.list.description')}
        actions={(
          <Button variant="primary" onClick={create}>
            <PlusIcon className="size-3.5" />
            {t('roles.list.create')}
          </Button>
        )}
      >
        <div className="w-full max-w-[280px]">
          <TextInput
            aria-label={t('roles.list.search')}
            placeholder={t('roles.list.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div ref={setRoot} className="flex flex-col">
          {ranked.length === 0 ? (
            <EmptyState icon={ShieldIcon} title={t('roles.list.empty.title')}>
              {t('roles.list.empty.body')}
            </EmptyState>
          ) : shown.length === 0 ? (
            <Hint className="py-3">{t('roles.list.noMatch', { query: query.trim() })}</Hint>
          ) : manager ? (
            <DndProvider manager={manager}>{rows}</DndProvider>
          ) : null}
        </div>
      </Section>
    </>
  );
}

function RoleRow({ role, at, me, ranked, draggable, onOpen, onDelete, onPlace, first }) {
  const t = useT();
  const ref = useRef(null);
  const [{ lifted }, drag] = useDrag({
    type: DRAG,
    item: { id: role.id },
    canDrag: draggable,
    collect: (m) => ({ lifted: m.isDragging() }),
  }, [role.id, draggable]);

  const zone = useZones(ref, {
    accept: DRAG,
    canDrop: (item) => item.id !== role.id
      && (mayDropAt(me, ranked, item.id, at) || mayDropAt(me, ranked, item.id, at + 1)),
    before: (item) => { if (mayDropAt(me, ranked, item.id, at)) onPlace(item.id, at); },
    after: (item) => { if (mayDropAt(me, ranked, item.id, at + 1)) onPlace(item.id, at + 1); },
  }, [at, ranked, me]);

  const colour = colourOf(role.color);
  const editable = !role.managed && mayHold(me, role);

  return (
    <div
      ref={(el) => { ref.current = el; if (draggable) drag(el); }}
      className={cn(
        'group/role relative flex items-center gap-3 border-b border-border px-3 py-2.5',
        first && 'border-t',
        draggable && 'cursor-grab',
        lifted && 'opacity-40',
      )}
    >
      <DropLine edge={zone} />
      <span
        aria-hidden="true"
        className="size-3 shrink-0 rounded-full border border-border"
        style={colour ? { background: colour, borderColor: colour } : undefined}
      />
      <button
        type="button"
        onClick={onOpen}
        className={cn('min-w-0 flex-1 truncate text-start text-base font-semibold', colour && 'role-ink')}
        style={colour ? { '--role': colour } : undefined}
      >
        <EmojiText>{role.name}</EmojiText>
      </button>
      <span
        className="flex shrink-0 items-center gap-1 text-xs text-muted tnum"
        aria-label={t('roles.memberCount', { count: role.member_count ?? 0 })}
      >
        <MembersIcon className="size-3.5" aria-hidden="true" />
        {n(role.member_count ?? 0)}
      </span>
      <span className="touch-visible-action pointer-events-none flex w-[88px] shrink-0 items-center justify-end gap-1 opacity-0 transition-opacity group-hover/role:pointer-events-auto group-hover/role:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 sm:w-[52px]">
        <IconButton
          title={t('roles.row.edit', { role: role.name })}
          className="size-10 rounded-xl sm:size-6 sm:rounded-md"
          onClick={onOpen}
        >
          <EditIcon className="size-3.5" />
        </IconButton>
        <IconButton
          title={t('roles.row.delete', { role: role.name })}
          className="size-10 rounded-xl sm:size-6 sm:rounded-md"
          disabled={!editable}
          onClick={onDelete}
        >
          <TrashIcon className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}


const tabsOf = (t) => [
  ['display', t('roles.tab.display')],
  ['permissions', t('roles.tab.permissions')],
  ['members', t('roles.tab.members')],
];

function RoleEditor({ guildId, api, role, onBack, saved }) {
  const store = useStore();
  const t = useT();
  const everyone = role.id === guildId;
  const [tab, setTab] = useState(everyone ? 'permissions' : 'display');
  const [draft, setDraft] = useState(() => draftOf(role));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft((d) => (dirty(d, role) ? d : draftOf(role)));
  }, [role]);

  const changed = dirty(draft, role);
  const editable = everyone
    ? store.canInGuild(guildId, 'MANAGE_ROLES')
    : !role.managed && mayHold(store.myMember(guildId), role);

  const save = async () => {
    setSaving(true);
    try {
      await api.patchRole(guildId, role.id, {
        name: draft.name.trim() || role.name,
        permissions: [...draft.held],
        hoist: draft.hoist,
        mentionable: draft.mentionable,
        color: draft.colour ? colourToInt(draft.colour) : 0,
      });
      saved();
      toast(t('common.saved'));
    } catch (e) { reportError(e, t('roles.editor.saveFailed')); }
    finally { setSaving(false); }
  };

  const colour = draft.colour || colourOf(role.color);

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2 pb-4">
        <IconButton title={t('roles.editor.back')} className="size-7" onClick={onBack}>
          <BackIcon className="size-4" />
        </IconButton>
        <span
          aria-hidden="true"
          className="size-3 shrink-0 rounded-full border border-border"
          style={colour ? { background: colour, borderColor: colour } : undefined}
        />
        <h3 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
          {everyone ? t('roles.everyone.title') : draft.name || role.name}
        </h3>
      </div>

      {everyone ? (
        <Hint className="pb-3">{t('roles.everyone.locked')}</Hint>
      ) : null}
      {role.managed ? (
        <Notice tone="accent" className="mb-3">
          {store.canInGuild(guildId, 'MANAGE_GUILD')
            ? t('roles.managed.canManageGuild')
            : t('roles.managed.needsManageGuild', {
              permission: t('perms.manage_guild.label'),
            })}
        </Notice>
      ) : null}
      {!editable && !role.managed ? (
        <Notice tone="warn" className="mb-3">{t('roles.editor.notEditable')}</Notice>
      ) : null}

      {everyone ? null : (
        <Tabs value={tab} options={tabsOf(t)} onChange={setTab} className="pb-4" />
      )}

      {tab === 'display' && !everyone ? (
        <DisplayTab draft={draft} setDraft={setDraft} disabled={!editable} />
      ) : null}
      {tab === 'permissions' ? (
        <PermissionsTab
          guildId={guildId}
          draft={draft}
          setDraft={setDraft}
          disabled={!editable}
        />
      ) : null}
      {tab === 'members' && !everyone ? (
        <MembersTab guildId={guildId} api={api} role={role} disabled={!editable} onChanged={saved} />
      ) : null}

      {changed ? (
        <SaveBar saving={saving} onReset={() => setDraft(draftOf(role))} onSave={save} />
      ) : null}
    </div>
  );
}

function draftOf(role) {
  return {
    name: role.name || '',
    hoist: Boolean(role.hoist),
    mentionable: Boolean(role.mentionable),
    colour: colourOf(role.color) || '',
    held: new Set(role.permission_names || []),
  };
}

function dirty(draft, role) {
  const base = draftOf(role);
  if (draft.name !== base.name) return true;
  if (draft.hoist !== base.hoist || draft.mentionable !== base.mentionable) return true;
  if (draft.colour !== base.colour) return true;
  if (draft.held.size !== base.held.size) return true;
  for (const p of draft.held) if (!base.held.has(p)) return true;
  return false;
}

function SaveBar({ saving, onReset, onSave }) {
  const t = useT();
  return (
    <div className="sticky bottom-0 z-20 mt-6 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-lg">
      <WarnIcon className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 text-sm">{t('roles.editor.unsaved')}</span>
      <Button variant="ghost" onClick={onReset} disabled={saving}>
        {t('roles.editor.reset')}
      </Button>
      <Button variant="primary" onClick={onSave} disabled={saving}>
        {saving ? t('common.saving') : t('roles.editor.save')}
      </Button>
    </div>
  );
}

function DisplayTab({ draft, setDraft, disabled }) {
  const t = useT();
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Section>
      <TextInput
        label={t('roles.create.nameLabel')}
        value={draft.name}
        disabled={disabled}
        onChange={(e) => set({ name: e.target.value })}
      />

      <div className="flex flex-col gap-1.5">
        <div className="text-sm font-medium">{t('roles.display.colour')}</div>
        <p className="text-xs leading-[1.5] text-muted">{t('roles.display.colourHint')}</p>
        <SwatchRow
          className="pt-1"
          label={t('roles.display.colour')}
          options={swatches(t)}
          value={draft.colour}
          onChange={(hex) => set({ colour: hex })}
          none={t('roles.display.noColour')}
          fallback="#99aab5"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col divide-y divide-border panel px-3">
        <Switch
          label={t('roles.display.hoist')}
          hint={t('roles.display.hoistHint')}
          checked={draft.hoist}
          disabled={disabled}
          onChange={(next) => set({ hoist: next })}
        />
        <Switch
          label={t('roles.display.mentionable')}
          hint={t('roles.display.mentionableHint', {
            permission: t('perms.mention_everyone.label'),
          })}
          checked={draft.mentionable}
          disabled={disabled}
          onChange={(next) => set({ mentionable: next })}
        />
      </div>
    </Section>
  );
}

function PermissionsTab({ guildId, draft, setDraft, disabled }) {
  const store = useStore();
  const t = useT();
  const [query, setQuery] = useState('');

  const mine = useMemo(
    () => new Set(PERMISSIONS.filter((p) => store.canInGuild(guildId, p))),
    [store, guildId],
  );

  const toggle = (perm, on) => setDraft((d) => {
    const held = new Set(d.held);
    if (on) held.add(perm); else held.delete(perm);
    return { ...d, held };
  });

  const needle = query.trim().toLowerCase();
  const matches = (name) => {
    if (!needle) return true;
    const info = permissionInfo(name);
    return info.label.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
  };

  const admin = draft.held.has('ADMINISTRATOR');

  return (
    <Section>
      <div className="w-full max-w-[280px]">
        <TextInput
          aria-label={t('roles.permissions.search')}
          placeholder={t('roles.permissions.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {admin ? (
        <Notice tone="warn">
          {t('roles.permissions.adminNotice', {
            permission: t('perms.administrator.label'),
          })}
        </Notice>
      ) : null}

      {PERMISSION_GROUPS.map(([group, title]) => {
        const names = PERMISSIONS.filter((p) => permissionInfo(p).group === group && matches(p));
        if (!names.length) return null;
        return (
          <div key={group} className="flex flex-col gap-1.5">
            <div className="eyebrow pt-2">{title}</div>
            <div className="flex flex-col divide-y divide-border panel px-3">
              {names.map((name) => {
                const info = permissionInfo(name);
                return (
                  <Switch
                    key={name}
                    label={info.label}
                    hint={info.hint}
                    checked={draft.held.has(name)}
                    disabled={disabled || !mine.has(name) || (admin && name !== 'ADMINISTRATOR')}
                    onChange={(next) => toggle(name, next)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {needle && !PERMISSIONS.some(matches) ? (
        <Hint>{t('roles.permissions.noMatch', { query: query.trim() })}</Hint>
      ) : null}
    </Section>
  );
}

function MembersTab({ guildId, api, role, disabled, onChanged }) {
  const store = useStore();
  const t = useT();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(null);
  const [generation, setGeneration] = useState(0);

  const holders = useAsync(
    () => api.members(guildId, { role: role.id, limit: 100 }).then((r) => r.members || []),
    [guildId, role.id, generation],
  );

  const needle = query.trim();
  const found = useAsync(
    () => (needle
      ? api.members(guildId, { q: needle, limit: 25 }).then((r) => r.members || [])
      : Promise.resolve(null)),
    [guildId, needle, generation],
  );

  const base = store.apiForGuild(guildId)?.base;

  const change = async (userId, add) => {
    setBusy(userId);
    try {
      await api.patchMember(guildId, userId, add
        ? { add_roles: [role.id] }
        : { remove_roles: [role.id] });
      setGeneration((g) => g + 1);
      onChanged();
    } catch (e) {
      reportError(e, add ? t('roles.members.addFailed') : t('roles.members.removeFailed'));
    } finally { setBusy(null); }
  };

  const row = (member, held) => (
    <div key={member.user_id} className="flex items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0">
      <Avatar
        id={member.user_id}
        name={member.display_name}
        size="sm"
        mediaRef={member.avatar_ref}
        base={base}
        mediaOrigin={remoteMediaOrigin(member.user_id, store.guilds.get(guildId)?.domain)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base">
          <EmojiText>{member.nickname || member.display_name || shortName(member.user_id)}</EmojiText>
        </span>
        <span className="block truncate font-mono text-xs text-muted">{member.user_id}</span>
      </span>
      <Button
        variant={held ? 'danger-soft' : 'secondary'}
        disabled={disabled || busy === member.user_id}
        onClick={() => change(member.user_id, !held)}
      >
        {held ? t('common.remove') : t('roles.members.add')}
      </Button>
    </div>
  );

  return (
    <Section>
      <div className="w-full max-w-[320px]">
        <TextInput
          aria-label={t('roles.members.search')}
          placeholder={t('roles.members.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {needle ? (
        <Async state={found} empty={null}>
          {(members) => (
            <div className="flex flex-col gap-1.5">
              <div className="eyebrow">{t('roles.members.matching', { query: needle })}</div>
              {members?.length ? (
                <div className="panel">
                  {members.map((m) => row(m, (m.roles || []).includes(role.id)))}
                </div>
              ) : (
                <Hint>{t('roles.members.noMatch')}</Hint>
              )}
            </div>
          )}
        </Async>
      ) : null}

      <Async state={holders} empty={null}>
        {(members) => (
          <div className="flex flex-col gap-1.5">
            <div className="eyebrow pt-2">
              {t('roles.members.holding', { role: role.name, count: members.length })}
            </div>
            {members.length ? (
              <div className="panel">
                {members.map((m) => row(m, true))}
              </div>
            ) : (
              <EmptyState icon={MembersIcon} title={t('roles.members.empty.title')}>
                {t('roles.members.empty.body')}
              </EmptyState>
            )}
          </div>
        )}
      </Async>
    </Section>
  );
}
