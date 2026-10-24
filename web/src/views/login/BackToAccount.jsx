import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';

export function BackToAccount() {
  const store = useStore();
  const [last] = useState(() => (store.session?.home?.token ? null : store.accounts?.()[0] || null));
  if (!last) return null;
  const name = last.card?.name || last.user_id;
  return (
    <div className="mt-4 w-full self-stretch text-center">
      <button
        type="button"
        className="auth-back-account text-sm text-muted transition-colors duration-(--dur-2) hover:text-foreground"
        onClick={() => store.switchAccount(last.user_id)}
      >
        {`Back to ${name}`}
      </button>
    </div>
  );
}
