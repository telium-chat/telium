import { useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import { participants, shortName } from '../../lib/util.js';
import { POSTURE_COPY, POSTURES } from '../../lib/callmode.js';
import {
  Avatar, Button, ChoiceCard, ChoiceList, Hint, IconButton, isBotAccount, ModalShell, Notice,
  PlusIcon, RemoveFriendIcon, Switch, useDialogs,
} from '../../components/index.js';
import { Advanced, Verdict } from '../user-settings/RecoveryParts.jsx';
import { useProfileCard } from '../../hooks/useProfileCard.js';
import { VerifyDialog } from './VerifyDialog.jsx';
import { AddPeopleDialog } from './AddPeopleDialog.jsx';
import { custodyNote, ESCROWED_NOTE, useDeviceTrust } from '../chat/encryption.jsx';

const POLICY_ROWS = [
  { rule: 'add', label: 'Who can add people' },
  { rule: 'remove', label: 'Who can remove people' },
  { rule: 'policy', label: 'Who can change these rules' },
];

const RULE_COPY = {
  creator: 'Only the creator',
  admins: 'The creator and admins',
  anyone: 'Anyone in the group',
};

export function ConversationDialog({ convo: opened, close, refresh }) {
  const store = useStore();
  const t = useT();
  useStoreEvent('conversations');
  const convo = store.conversations.find((c) => c.id === opened.id) || opened;
  const modal = useModal();
  const dialogs = useDialogs();
  const profiles = useProfileCard();
  const [, bump] = useState(0);
  const set = (fn) => { fn(); bump((n) => n + 1); };
  const trustRows = useDeviceTrust(convo.id);

  const devices = new Map();
  for (const device of store.mls?.devicesIn(convo.id) || []) {
    devices.set(device.userId, (devices.get(device.userId) || 0) + 1);
  }
  const verified = new Map();
  for (const row of trustRows) {
    if (row.status === 'verified') verified.set(row.userId, (verified.get(row.userId) || 0) + 1);
  }
  const changed = new Set(trustRows.filter((d) => d.status === 'changed' || d.status === 'revoked').map((d) => d.userId));
  const unverified = trustRows.filter((d) => d.status !== 'verified').length;

  const me = store.me?.user_id;
  const group = convo.kind === 'gc';
  const canVerify = Boolean(store.trust);
  const verifiable = (id) => canVerify && !isBotAccount(store, id);
  const openVerify = (userId) => modal.open((closeVerify) => (
    <VerifyDialog userId={userId} close={closeVerify} />
  ));
  const pending = participants(convo)
    .map((m) => m.user_id)
    .filter((id) => (verified.get(id) || 0) < (devices.get(id) || 0) && verifiable(id));
  const next = pending[0];
  const verifyLabel = (id) => (id === me
    ? 'Verify your other device'
    : `Verify ${shortName(id) || id}`);

  const policy = group ? (store.mls?.policyOf?.(convo.id) || null) : null;
  const can = (rule) => (store.mls?.permits ? store.mls.permits(convo.id, rule) : true);
  const admins = new Set(policy?.admins || []);
  const changePolicy = async (nextPolicy, whenItFails = 'Could not change who runs this group') => {
    try {
      await store.setConversationPolicy(convo.id, { ...policy, ...nextPolicy });
      bump((n) => n + 1);
      refresh();
    } catch (e) { reportError(e, whenItFails); }
  };
  const adoptPolicy = () => changePolicy(
    { add: 'anyone', remove: 'anyone', policy: 'creator', admins: [] },
    'Could not set up rules for this group',
  );

  const addSomeone = () => modal.open((closeAdd) => (
    <AddPeopleDialog convo={convo} close={closeAdd} refresh={refresh} />
  ));

  const leave = () => dialogs.confirm({
    title: 'Leave this conversation?',
    body: 'You stop receiving new messages here, and this device forgets the keys to it.',
    confirmLabel: 'Leave',
    danger: true,
    onConfirm: async () => {
      try {
        await store.leaveConversation(convo.id);
        close();
        store.navigate({ view: 'dms', conversationId: null });
      } catch (e) { reportError(e, 'Could not leave'); }
    },
  });

  const escrowed = store.custody?.mode === 'escrowed';
  let state = 'plain';
  let title = 'Encrypted end to end';
  let note = null;
  if (changed.size) {
    state = 'attention';
    const who = [...changed][0];
    title = changed.size === 1
      ? `${shortName(who) || who} is signing with a different key`
      : `${changed.size} people are signing with different keys`;
    note = 'That is what a key reset looks like. It is also what an impersonation looks like.';
  } else if (unverified) {
    state = 'todo';
    title = `${unverified} device${unverified === 1 ? '' : 's'} you have not verified`;
    note = 'They can read what you send here. This is a check, not a gate.';
  } else if (escrowed) {
    state = 'attention';
    title = 'Your home server can read this';
  } else if (devices.size) {
    state = 'ok';
    title = 'Everyone here is verified';
  }
  const act = next ? (
    <div className="pt-2.5">
      <Button variant="primary" onClick={() => openVerify(next)}>{verifyLabel(next)}</Button>
    </div>
  ) : null;

  return (
    <ModalShell
      title="Conversation"
      footerClassName="justify-between"
      footer={(
        <>
          <Button variant="danger-soft" onClick={leave}>Leave</Button>
          <Button variant="ghost" onClick={close}>Close</Button>
        </>
      )}
    >
      <Verdict state={state} title={title}>
        {note || act ? <>{note}{act}</> : null}
      </Verdict>
      {escrowed ? <Notice tone="warn">{ESCROWED_NOTE}</Notice> : null}

      <div className="flex flex-col rounded-card bg-surface-secondary p-1">
        {participants(convo).map((m) => {
          const count = devices.get(m.user_id) || 0;
          const ok = verified.get(m.user_id) || 0;
          const role = policy?.creator === m.user_id
            ? 'creator'
            : (policy && admins.has(m.user_id) ? 'admin' : null);
          const [word, tone] = changed.has(m.user_id)
            ? ['Key changed', 'text-danger']
            : !count
              ? ['No keys yet', 'text-muted']
              : ok === count
                ? ['Verified', 'text-success']
                : [`${ok}/${count} verified`, 'text-warning'];
          return (
            <div key={m.user_id} className="flex items-center gap-2.5 rounded-row px-2 py-1.5">
              <Avatar id={m.user_id} size="sm" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="block max-w-full cursor-pointer truncate text-start font-mono text-sm hover:underline"
                  onClick={(e) => profiles.open(m.user_id, { anchor: e.currentTarget })}
                  onPointerEnter={() => profiles.prefetch(m.user_id)}
                  onPointerLeave={profiles.cancel}
                >
                  {m.user_id}
                </button>
                <div className="truncate text-2xs leading-[1.5] text-muted">
                  <span className={tone}>{word}</span>
                  {count ? ` · ${count} device${count === 1 ? '' : 's'}` : ''}
                  {role ? ` · ${role}` : ''}
                </div>
              </div>
              {ok < count && verifiable(m.user_id) ? (
                <Button size="sm" onClick={() => openVerify(m.user_id)}>Verify</Button>
              ) : null}
              {group && m.user_id !== me && can('remove') ? (
                <IconButton
                  size="sm"
                  title={`Remove ${shortName(m.user_id) || m.user_id}`}
                  onClick={() => dialogs.confirm({
                    title: 'Remove from this group?',
                    body: `${m.user_id} stops receiving new messages. What they already have stays with them.`,
                    confirmLabel: 'Remove',
                    danger: true,
                    onConfirm: async () => {
                      try {
                        await store.removeFromConversation(convo.id, [m.user_id]);
                        toast('Removed.');
                        refresh();
                      } catch (e) { reportError(e, 'Could not remove'); }
                    },
                  })}
                >
                  <RemoveFriendIcon />
                </IconButton>
              ) : null}
            </div>
          );
        })}
        {!group || can('add') ? (
          <button
            type="button"
            onClick={addSomeone}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-row px-2 py-1.5 text-start text-sm text-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-surface-tertiary hover:text-foreground"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-tertiary">
              <PlusIcon className="size-3.5" />
            </span>
            {group ? 'Add people' : 'Start a group'}
          </button>
        ) : null}
      </div>

      {group ? (
        <Advanced label="Group rules">
          {policy ? (
            <>
              {POLICY_ROWS.map(({ rule, label }) => (
                can('policy') ? (
                  <ChoiceList
                    key={rule}
                    aria-label={label}
                    value={policy[rule]}
                    onChange={(chosen) => changePolicy({ [rule]: chosen })}
                  >
                    <div className="eyebrow px-1 pt-1">{label}</div>
                    {(rule === 'policy' ? ['creator', 'admins'] : ['creator', 'admins', 'anyone']).map((who) => (
                      <ChoiceCard key={who} value={who} label={RULE_COPY[who]} />
                    ))}
                  </ChoiceList>
                ) : (
                  <div key={rule} className="flex items-center justify-between gap-2 text-sm">
                    <span>{label}</span>
                    <span className="text-muted">{RULE_COPY[policy[rule]] || policy[rule]}</span>
                  </div>
                )
              ))}
              {can('policy') ? (
                <div className="divide-y divide-border rounded-row bg-surface-secondary px-3">
                  {participants(convo)
                    .filter((m) => m.user_id !== policy.creator)
                    .map((m) => (
                      <Switch
                        key={m.user_id}
                        label={`${shortName(m.user_id) || m.user_id} is an admin`}
                        checked={admins.has(m.user_id)}
                        onChange={(on) => {
                          const kept = new Set(admins);
                          if (on) kept.add(m.user_id); else kept.delete(m.user_id);
                          changePolicy({ admins: [...kept] });
                        }}
                      />
                    ))}
                </div>
              ) : null}
              <Hint>Every member’s client enforces this, and the creator never changes.</Hint>
            </>
          ) : (
            <>
              <Hint>Anyone here can add and remove people.</Hint>
              <div><Button onClick={adoptPolicy}>Set rules</Button></div>
            </>
          )}
        </Advanced>
      ) : null}

      <Advanced label="Signals and calls">
        <div className="divide-y divide-border rounded-row bg-surface-secondary px-3">
          <Switch
            label="Read receipts here"
            hint="Both directions at once."
            checked={store.readReceiptsIn(convo.id)}
            onChange={(on) => set(() => store.setSignal('read', on, convo.id))}
          />
          <Switch
            label="Acknowledge delivery here"
            hint="Also both directions."
            checked={store.deliveryAcksIn(convo.id)}
            onChange={(on) => set(() => store.setSignal('delivered', on, convo.id))}
          />
          <Switch
            label="Show when I am typing here"
            checked={store.typingSignalsIn(convo.id)}
            onChange={(on) => set(() => store.setSignal('typing', on, convo.id))}
          />
        </div>
        <Hint>
          {'Read receipts and delivery acknowledgements override your account settings, '
            + 'here only, and travel inside the encryption.'}
        </Hint>
        {store.typingSignalsIn(convo.id) ? <Hint>{t('privacy.typing.inEncrypted')}</Hint> : null}
        <div>
          <div className="eyebrow pb-1.5">Call privacy</div>
          <ChoiceList
            aria-label="Call privacy"
            value={store.callPrivacyFor(convo.id)}
            onChange={(chosen) => set(() => store.setCallPrivacy(chosen, convo.id))}
          >
            {POSTURES.map((p) => (
              <ChoiceCard
                key={p}
                value={p}
                label={POSTURE_COPY[p].label}
                description={POSTURE_COPY[p].description}
              />
            ))}
          </ChoiceList>
          {store.prefs.signals?.conversations?.[convo.id]?.call !== undefined ? (
            <div className="pt-1">
              <Button variant="ghost" className="-ms-2" onClick={() => set(() => store.setCallPrivacy(null, convo.id))}>
                Use my account setting
              </Button>
            </div>
          ) : null}
          <Hint>In a call the strictest choice among the people in it wins.</Hint>
        </div>
        <div>
          <div className="eyebrow pb-1.5">SFU</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {store.callSfuIn(convo.id)
                ? <span className="font-mono">{store.callSfuIn(convo.id)}</span>
                : 'No SFU of its own'}
            </span>
            <Button
              size="sm"
              onClick={() => dialogs.prompt({
                title: 'This conversation’s SFU',
                label: 'SFU address',
                value: store.callSfuIn(convo.id) || '',
                onSubmit: async (text) => {
                  try {
                    await store.setCallSfu(convo.id, String(text || '').trim() || null);
                    bump((n) => n + 1);
                  } catch (e) { reportError(e, 'Could not set the SFU'); }
                },
              })}
            >
              {store.callSfuIn(convo.id) ? 'Change' : 'Set an SFU'}
            </Button>
            {store.callSfuIn(convo.id) ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => store.setCallSfu(convo.id, null)
                  .then(() => bump((n) => n + 1))
                  .catch((e) => reportError(e, 'Could not remove the SFU'))}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <Hint>Kept in the conversation’s encrypted state, and every member can change it.</Hint>
        </div>
      </Advanced>

      <Advanced label="How this conversation works">
        <div>
          <div className="eyebrow pb-1.5">Sequencer</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm">{convo.sequencer}</span>
          </div>
        </div>
        <Hint>{custodyNote(store.custody?.mode)}</Hint>
        <Hint>
          {'Device counts come from this conversation’s own key tree, not from the '
            + 'server’s member list. The server can add a row to the list; it cannot '
            + 'add a leaf to the tree.'}
        </Hint>
      </Advanced>
    </ModalShell>
  );
}

