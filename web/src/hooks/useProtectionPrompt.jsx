import { useCallback } from 'react';
import { ConfirmDialog } from '../components/index.js';
import { useModal } from './useModal.jsx';
import { refusalCopy } from '../lib/net/policy.js';
import { ProtectionRefused, permitDirectOnce } from '../lib/net/transport.js';
import { reportError, toast } from './useToast.jsx';

const asked = new Set();

export function clearProtectionPrompts() {
  asked.clear();
}

export function isProtectionRefusal(error) {
  return error instanceof ProtectionRefused
    || (error?.protection === true && typeof error?.domain === 'string');
}

export function protectionPromptFor(modal) {
  return (error, { context = 'Could not connect', retry = null } = {}) => {
    if (!isProtectionRefusal(error)) {
      reportError(error, context);
      return;
    }

    const { domain } = error;
    const copy = refusalCopy(error.refusal, { domain });

    if (asked.has(domain)) {
      toast(copy.title, { error: true });
      return;
    }
    asked.add(domain);

    modal.open((close) => (
      <ConfirmDialog
        close={close}
        title={copy.title}
        body={copy.body}
        confirmLabel="Connect directly this time"
        danger
        onConfirm={async () => {
          permitDirectOnce(domain);
          if (!retry) return;
          try {
            await retry();
          } catch (e) {
            reportError(e, context);
          }
        }}
      />
    ));
  };
}

export function useProtectionPrompt() {
  const modal = useModal();
  return useCallback((error, options) => protectionPromptFor(modal)(error, options), [modal]);
}
