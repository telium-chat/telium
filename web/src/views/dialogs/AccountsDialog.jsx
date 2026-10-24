import { useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { MAX_ACCOUNTS } from '../../lib/accounts.js';
import { shortName } from '../../lib/util.js';
import {
  Avatar, Button, IconButton, ModalShell, PlusIcon, SignOutIcon, useDialogs,
} from '../../components/index.js';

export function AccountFace({ account, size = 'sm' }) {
  const card = account.card || {};
  return (
    <Avatar
      id={account.user_id}
      name={card.name || shortName(account.user_id)}
      size={size}
      mediaRef={card.avatar_ref}
      base={card.base || account.session?.home?.base}
    />
  );
}

export function AccountsDialog({ close }) {
  const store = useStore();
  const dialogs = useDialogs();
  useStoreEvent('accounts', 'me');
  const [busy, setBusy] = useState(false);
  const active = store.session?.home?.user_id;
  const accounts = store.accounts();
  const full = accounts.length >= MAX_ACCOUNTS;

  const go = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <ModalShell
      title="Accounts"
      footer={(
        <div className="flex w-full items-center gap-2">
          {full ? <span className="me-auto text-xs text-muted">{`${MAX_ACCOUNTS} at most`}</span> : null}
          <Button
            variant="secondary"
            className="ms-auto"
            disabled={full || busy}
            onClick={() => go(() => store.addAccount())}
          >
            <PlusIcon className="size-4" />
            Add an account
          </Button>
        </div>
      )}
    >
      <ul className="accounts-list flex flex-col gap-0.5" aria-label="Signed-in accounts">
        {accounts.map((account) => {
          const isActive = account.user_id === active;
          const name = account.card?.name || shortName(account.user_id);
          return (
            <li key={account.user_id} className="accounts-row flex items-center gap-3 rounded-md px-2 py-1.5">
              <AccountFace account={account} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{name}</div>
                <div className="truncate text-xs text-muted">{account.user_id}</div>
              </div>
              {isActive ? (
                <span className="px-2 text-xs text-muted">Active</span>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => go(() => store.switchAccount(account.user_id))}
                >
                  Switch
                </Button>
              )}
              <IconButton
                size="sm"
                title={`Sign out of ${name}`}
                disabled={busy}
                onClick={() => dialogs.confirm({
                  title: `Sign out of ${name}?`,
                  body: isActive
                    ? 'Conversations close on this device until you sign in again.'
                    : 'Its conversations close on this device until you sign in again.',
                  confirmLabel: 'Sign out',
                  danger: true,
                  onConfirm: () => (isActive
                    ? (close?.(), store.signOut())
                    : store.signOutOther(account.user_id)),
                })}
              >
                <SignOutIcon className="size-4" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </ModalShell>
  );
}
