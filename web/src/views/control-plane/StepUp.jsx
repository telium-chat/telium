import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useModal } from '../../hooks/useModal.jsx';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError, toast } from '../../hooks/useToast.jsx';
import {
  Button, Hint, ModalShell, Notice, PasswordInput, useDialogs,
} from '../../components/index.js';
import { duration } from './format.js';
import { useControlPlane } from './context.js';
import { useLive, useNow } from './useLive.js';

const STATE_POLL_MS = 60_000;

const STEP_UP_REQUIRED = 'step_up_required';

export const needsStepUp = (e) => e?.status === 403 && e?.code === STEP_UP_REQUIRED;

export function StepUpDialog({ onDone, close }) {
  const store = useStore();
  const home = store.home;
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => () => done.current(null), []);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setFailed(null);
    try {
      const proof = await store.reauthProof(password);
      const granted = await home.adminStepUp(proof);
      onDone(granted);
      close();
    } catch (e) {
      setFailed(e?.body?.message || e?.message || 'That password was not accepted.');
      setPassword('');
      setBusy(false);
    }
  };

  return (
    <ModalShell
      title="Confirm it is you"
      subtitle="Your password, once, for the next few minutes of destructive work."
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button variant="primary" isDisabled={busy || !password} onClick={submit}>
            Unlock
          </Button>
        </>
      )}
    >
      {failed ? <Notice tone="danger">{failed}</Notice> : null}
      <PasswordInput
        autoFocus
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <Hint>
        You are signed in already; this is the separate question of whether the
        person at this keyboard is you. It unlocks every destructive control in
        the control plane for a few minutes, and you can end it early from the
        lock beside them.
      </Hint>
    </ModalShell>
  );
}

export function useStepUp() {
  const store = useStore();
  const home = store.home;
  const modal = useModal();

  const poll = useLive(() => home.adminStepUpState(), { interval: STATE_POLL_MS });

  const [local, setLocal] = useState(null);

  const latest = useMemo(() => {
    const fromPoll = poll.data
      ? { expiresAt: poll.data.expires_at ?? null, at: poll.at ?? 0 }
      : null;
    if (!local) return fromPoll;
    if (!fromPoll) return local;
    return local.at >= fromPoll.at ? local : fromPoll;
  }, [poll.data, poll.at, local]);

  const expiresAt = latest?.expiresAt ?? null;

  const [, tick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return undefined;
    const left = expiresAt - Date.now();
    if (left <= 0) return undefined;
    const id = setTimeout(() => tick((n) => n + 1), left + 250);
    return () => clearTimeout(id);
  }, [expiresAt]);

  const elevated = Boolean(expiresAt && expiresAt > Date.now());

  const expiryRef = useRef(expiresAt);
  expiryRef.current = expiresAt;
  const isElevated = useCallback(
    () => Boolean(expiryRef.current && expiryRef.current > Date.now()),
    [],
  );

  const elevate = useCallback(() => new Promise((resolve) => {
    let settled = false;
    const finish = (granted) => {
      if (settled) return;
      settled = true;
      if (granted) setLocal({ expiresAt: granted.expires_at ?? null, at: Date.now() });
      resolve(Boolean(granted));
    };
    modal.open((close) => <StepUpDialog onDone={finish} close={close} />);
  }), [modal]);

  const drop = useCallback(async () => {
    try {
      await home.adminEndStepUp();
      setLocal({ expiresAt: null, at: Date.now() });
      toast('Destructive controls locked.');
    } catch (e) {
      reportError(e, 'Could not end the elevated window');
    }
  }, [home]);

  return useMemo(
    () => ({ elevated, expiresAt, isElevated, elevate, drop, reload: poll.reload }),
    [elevated, expiresAt, isElevated, elevate, drop, poll.reload],
  );
}

export function Elevation({ stepUp }) {
  const now = useNow();
  if (!stepUp?.elevated) return null;
  const left = Math.max(0, stepUp.expiresAt - now);
  return (
    <span className="cp-elevation" role="status">
      <span aria-hidden="true" className="cp-elevation__dot" />
      <span>{`Unlocked for ${duration(left)}`}</span>
      <button type="button" className="cp-elevation__end" onClick={() => stepUp.drop()}>
        Lock now
      </button>
    </span>
  );
}

export function useElevatedRun() {
  const { stepUp } = useControlPlane();
  return async (label, run, done) => {
    if (!stepUp.isElevated() && !(await stepUp.elevate())) return false;
    try {
      try {
        await run();
      } catch (e) {
        if (!needsStepUp(e)) throw e;
        if (!(await stepUp.elevate())) return false;
        await run();
      }
      toast(done || `${label} done.`);
      return true;
    } catch (e) {
      reportError(e, `Could not ${label.toLowerCase()}`);
      return false;
    }
  };
}

export function DangerAction({
  label, title, body, confirmLabel, run, onDone, done, disabled, disabledReason, size = 'sm',
}) {
  const dialogs = useDialogs();
  const elevatedRun = useElevatedRun();
  const [busy, setBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const act = async () => {
    setBusy(true);
    const happened = await elevatedRun(label, run, done);
    if (mounted.current) setBusy(false);
    if (happened) onDone?.();
  };

  return (
    <Button
      size={size}
      variant="danger"
      disabled={busy || disabled}
      title={disabled ? disabledReason : undefined}
      onClick={() => dialogs.confirm({
        title,
        body,
        confirmLabel: confirmLabel || label,
        danger: true,
        onConfirm: act,
      })}
    >
      {label}
    </Button>
  );
}
