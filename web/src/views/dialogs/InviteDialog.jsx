import { useEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { copyToClipboard } from '../../lib/clipboard.js';
import { faceOf } from '../../lib/faces.js';
import { DEFAULT_INVITE_EXPIRY, INVITE_EXPIRY_OPTIONS, inviteCreateBody } from '../../lib/invites.js';
import { shortName } from '../../lib/util.js';
import {
  Avatar, Button, CheckIcon, CopyIcon, Hint, ModalShell, Pill, Select, TextInput,
} from '../../components/index.js';

function lasts(expiresAt) {
  if (!expiresAt) return 'Never expires';
  const mins = Math.round((expiresAt - Date.now()) / 60000);
  if (mins <= 0) return 'Expired';
  if (mins < 60) return `Expires in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Expires in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.round(hours / 24);
  return `Expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

function admits(maxUses) {
  if (!maxUses) return 'Unlimited uses';
  return maxUses === 1 ? 'One use' : `${maxUses} uses`;
}

export function InviteDialog({ guild, invite: initialInvite = null, close }) {
  const store = useStore();
  useStoreEvent('friends', 'members', 'presence');
  const [invited, setInvited] = useState(() => new Set());
  const [sending, setSending] = useState(null);
  const [invite, setInvite] = useState(initialInvite);
  const [maxUses, setMaxUses] = useState('');
  const [expiry, setExpiry] = useState(DEFAULT_INVITE_EXPIRY);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  const urlRef = useRef(null);

  const url = invite ? (invite.url || `${guild.domain}/invite/${invite.code}`) : '';
  const members = store.members.get(guild.id);
  const friends = store.friendsIn('accepted');

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (!url) return;
    urlRef.current?.select?.();
  }, [url]);

  const mint = async () => {
    const created = await store.apiForGuild(guild.id).createInvite(
      guild.id,
      inviteCreateBody(maxUses, expiry),
    );
    setInvite(created);
    return created.url || `${guild.domain}/invite/${created.code}`;
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await mint();
      setInvited(new Set());
    } catch (e) {
      reportError(e, 'Could not create invite');
    } finally {
      setCreating(false);
    }
  };

  const copy = async () => {
    if (!(await copyToClipboard(url, 'Invite link'))) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const send = async (friend) => {
    const id = friend.user_id;
    if (invited.has(id) || sending === id) return;
    setSending(id);
    try {
      const link = invite ? url : await mint();
      const convo = await store.startConversation([id]);
      await store.sendDm(convo.id, link);
      setInvited((prev) => new Set(prev).add(id));
      toast('Invite sent.');
    } catch (e) {
      reportError(e, 'Could not send the invite');
    } finally {
      setSending(null);
    }
  };

  return (
    <ModalShell
      title={`Invite to ${guild.name}`}
      footer={<Button variant="primary" onClick={close}>Done</Button>}
    >
      {invite ? (
        <div className="invite-share">
          <div className="invite-link">
            <TextInput
              aria-label="Invite link"
              className="invite-link__url"
              size="lg"
              value={url}
              readOnly
              inputRef={urlRef}
              onFocus={(e) => e.target.select()}
              onClick={(e) => e.target.select()}
            />
            <Button
              variant="primary"
              size="lg"
              className="invite-link__copy"
              onClick={copy}
            >
              {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Hint>Anyone with this link can join.</Hint>
          <div className="invite-terms">
            <Pill>{lasts(invite.expires_at)}</Pill>
            <Pill>{admits(invite.max_uses)}</Pill>
            <Button
              variant="tertiary"
              size="sm"
              className="invite-terms__new"
              onClick={() => {
                setInvite(null);
                setInvited(new Set());
                setCopied(false);
              }}
            >
              New link
            </Button>
          </div>
        </div>
      ) : (
        <div className="invite-share">
          <div className="invite-fields">
            <Select
              label="Expires"
              value={expiry}
              options={INVITE_EXPIRY_OPTIONS}
              onChange={(e) => setExpiry(e.target.value)}
            />
            <TextInput
              label="Maximum uses"
              inputMode="numeric"
              placeholder="Unlimited"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            className="invite-go"
            loading={creating}
            onClick={create}
          >
            Create invite
          </Button>
        </div>
      )}

      <div className="invite-friends">
        <div className="eyebrow px-1">Send to a friend</div>
        {friends.length ? (
          <div className="invite-list">
            {friends.map((f) => {
              const id = f.user_id;
              const here = Boolean(members?.has(id));
              const face = faceOf(store, id);
              return (
                <div key={id} className="invite-friend">
                  <Avatar
                    id={id}
                    name={f.display_name}
                    size="sm"
                    mediaRef={face?.avatarRef}
                    base={face?.base}
                    mediaOrigin={face?.mediaOrigin}
                    presence={store.statusOf(id)}
                  />
                  <span className="invite-friend__name">
                    {f.display_name || shortName(id)}
                  </span>
                  {here ? (
                    <span className="invite-friend__state">Already here</span>
                  ) : (
                    <Button
                      variant="secondary"
                      loading={sending === id}
                      disabled={invited.has(id)}
                      onClick={() => send(f)}
                    >
                      {invited.has(id) ? 'Invited' : 'Invite'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Hint className="px-1">No friends yet. Add someone by their full ID from Friends.</Hint>
        )}
      </div>
    </ModalShell>
  );
}
