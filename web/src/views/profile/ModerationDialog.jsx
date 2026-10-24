import { useStore } from '../../hooks/useStore.jsx';
import { Button, ModalShell, Notice, useDialogs } from '../../components/index.js';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { has } from '../../lib/perms.js';
import { domainOf, shortName } from '../../lib/util.js';

export function ModerationDialog({ guildId, userId, close, closeParent }) {
  const store = useStore();
  const dialogs = useDialogs();
  const api = store.apiForGuild(guildId);
  const myPerms = store.guildPermissions(guildId);

  return (
    <ModalShell
      title={`Moderate ${shortName(userId)}`}
      footer={<Button variant="ghost" onClick={close}>Done</Button>}
    >
      <Notice>
        {'These actions change this guild only. They do not affect the account on '
          + `${domainOf(userId)}, and they do not follow the user anywhere else.`}
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!has(myPerms, 'MODERATE_MEMBERS')} onClick={() => dialogs.prompt({
          title: 'Set nickname',
          label: 'Nickname in this guild',
          onSubmit: async (nickname) => {
            try { await api.patchMember(guildId, userId, { nickname }); toast('Nickname set.'); }
            catch (e) { reportError(e, 'Could not set nickname'); }
          },
        })}
        >
          Set nickname
        </Button>
        <Button disabled={!has(myPerms, 'MODERATE_MEMBERS')} onClick={() => dialogs.prompt({
          title: 'Timeout',
          label: 'Minutes',
          value: '10',
          onSubmit: async (mins) => {
            const until = Date.now() + Math.max(1, Number(mins) || 10) * 60000;
            try { await api.patchMember(guildId, userId, { timeout_until: until }); toast('Timed out.'); }
            catch (e) { reportError(e, 'Could not time out'); }
          },
        })}
        >
          Timeout
        </Button>
        <Button disabled={!has(myPerms, 'KICK_MEMBERS')} onClick={() => dialogs.confirm({
          title: 'Kick',
          body: 'They can rejoin with a new invite.',
          confirmLabel: 'Kick',
          onConfirm: async () => {
            try { await api.kick(guildId, userId); toast('Kicked.'); close(); closeParent(); }
            catch (e) { reportError(e, 'Could not kick'); }
          },
        })}
        >
          Kick
        </Button>
        <Button variant="danger" disabled={!has(myPerms, 'BAN_MEMBERS')} onClick={() => dialogs.prompt({
          title: 'Ban',
          label: 'Reason (recorded in the audit log)',
          confirmLabel: 'Ban',
          onSubmit: async (reason) => {
            try { await api.ban(guildId, userId, { reason }); toast('Banned.'); close(); closeParent(); }
            catch (e) { reportError(e, 'Could not ban'); }
          },
        })}
        >
          Ban
        </Button>
      </div>
    </ModalShell>
  );
}
