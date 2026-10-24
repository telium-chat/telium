import { useCallback, useState } from 'react';
import { CloseIcon, EmojiText, PlusIcon } from '../../components/index.js';
import { colourOf } from '../../lib/util.js';
import { outranks } from '../../lib/perms.js';
import { RolesPopover } from './RolesPopover.jsx';

export function useRolePanel() {
  const [anchor, setAnchor] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const open = Boolean(anchor) && !leaving;
  const close = useCallback(() => setLeaving(true), []);
  const onLeft = useCallback(() => {
    setAnchor(null);
    setLeaving(false);
  }, []);
  const toggle = (el) => {
    if (open) setLeaving(true);
    else {
      setLeaving(false);
      setAnchor(el);
    }
  };
  return { anchor, leaving, open, close, onLeft, toggle };
}

export function RolePanel({ panel, store, guildId, held, busy, onToggle }) {
  if (!panel.anchor) return null;
  return (
    <RolesPopover
      store={store}
      guildId={guildId}
      anchor={panel.anchor}
      held={held}
      busy={busy}
      onToggle={onToggle}
      close={panel.close}
      leaving={panel.leaving}
      onLeft={panel.onLeft}
    />
  );
}

function RoleAddButton({ store, guildId, displayName, held, busy, onToggle, labelled }) {
  const panel = useRolePanel();
  return (
    <>
      <button
        type="button"
        className="pc__role-add"
        data-labelled={labelled ? 'true' : undefined}
        data-open={panel.open ? 'true' : 'false'}
        aria-haspopup="dialog"
        aria-expanded={panel.open}
        aria-label={`Add a role to ${displayName}`}
        title={`Add a role to ${displayName}`}
        onClick={(e) => panel.toggle(e.currentTarget)}
      >
        <PlusIcon className="size-3" />
        {labelled ? <span>Add role</span> : null}
      </button>
      <RolePanel
        panel={panel}
        store={store}
        guildId={guildId}
        held={held}
        busy={busy}
        onToggle={onToggle}
      />
    </>
  );
}

export function RoleChips({ store, guildId, displayName, roles, mayManage, busy, onToggle }) {
  const me = store.myMember(guildId);
  return (
    <div className="pc__roles" data-manage={mayManage ? 'true' : undefined}>
      {roles.map((id) => {
        const role = store.roles.get(guildId)?.get(id);
        const colour = colourOf(role?.color);
        const name = store.roleName(guildId, id);
        const mayDrop = mayManage && outranks(me, role?.position ?? 0);
        return (
          <span
            key={id}
            className={colour ? 'pc__role role-ink role-fill' : 'pc__role'}
            data-coloured={colour ? 'true' : 'false'}
            data-busy={busy === id ? 'true' : 'false'}
            style={colour ? { '--role': colour } : undefined}
          >
            <span className="pc__role-dot" aria-hidden="true" />
            <span className="pc__role-name"><EmojiText>{name}</EmojiText></span>
            {mayDrop ? (
              <button
                type="button"
                className="pc__role-drop"
                disabled={busy === id}
                aria-label={`Remove ${name} from ${displayName}`}
                title={`Remove ${name}`}
                onClick={() => onToggle(id, false)}
              >
                <CloseIcon className="size-2.5" strokeWidth={3} />
              </button>
            ) : null}
          </span>
        );
      })}
      {mayManage ? (
        <RoleAddButton
          store={store}
          guildId={guildId}
          displayName={displayName}
          held={roles}
          busy={busy}
          onToggle={onToggle}
          labelled={!roles.length}
        />
      ) : null}
    </div>
  );
}
