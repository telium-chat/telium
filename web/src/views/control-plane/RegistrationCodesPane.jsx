import { useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard.js';
import {
  Button, Field, Hint, Notice, Pill, Section, TextInput,
} from '../../components/index.js';
import { useControlPlane } from './context.js';
import { useElevatedRun, DangerAction, Elevation } from './StepUp.jsx';
import { useLive } from './useLive.js';
import { clock } from './format.js';

function statusOf(code) {
  if (code.revoked_at) return 'revoked';
  if (code.uses >= code.max_uses) return 'used up';
  if (code.expires_at && code.expires_at <= Date.now()) return 'expired';
  return 'active';
}

export function RegistrationCodesPane() {
  const { home, stepUp } = useControlPlane();
  const codes = useLive(() => home.adminRegistrationCodes(), { interval: 30_000 });
  const elevatedRun = useElevatedRun();
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('1');
  const [expiresInHours, setExpiresInHours] = useState('168');
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    const uses = Number(maxUses);
    const hours = Number(expiresInHours);
    if (!Number.isInteger(uses) || uses < 1 || uses > 10000
      || !Number.isInteger(hours) || hours < 0 || hours > 8760) {
      setError('Allowed uses must be between 1 and 10,000, and expiry must be 0–8,760 hours.');
      return;
    }
    setError('');
    setBusy(true);
    try {
      await elevatedRun('Create registration code', async () => {
        const result = await home.adminCreateRegistrationCode({
          label: label.trim(),
          max_uses: uses,
          expires_in_hours: hours,
        });
        setIssued(result);
        codes.reload();
      }, 'Registration code created. Copy it now; it cannot be shown again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Registration codes"
        description="Admit selected people to a private homeserver without opening registration to everyone. Each code has an expiry and a maximum number of account creations. The secret is shown once; the server saves only its hash."
        actions={<Elevation stepUp={stepUp} />}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Description">
            <TextInput value={label} placeholder="Friends, family, launch invites..." onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Maximum uses">
            <TextInput inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
          </Field>
          <Field label="Expires after (hours)">
            <TextInput inputMode="numeric" value={expiresInHours} onChange={(e) => setExpiresInHours(e.target.value)} />
          </Field>
        </div>
        <Hint>Defaults: one use and seven days. Enter 0 hours for no expiry. Creating and revoking codes requires administrator reauthentication.</Hint>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div>
          <Button size="sm" variant="primary" disabled={busy} onClick={create}>
            {busy ? 'Creating…' : 'Create code'}
          </Button>
        </div>
        {issued?.code ? (
          <Notice tone="warn">
            <strong>Copy this code now. It cannot be displayed again.</strong>
            <code className="mt-2 block select-all break-all font-mono text-sm">{issued.code}</code>
            <Button size="sm" variant="secondary" onClick={() => copyToClipboard(issued.code, 'Registration code')}>
              Copy code
            </Button>
            <p>Allowed uses: {issued.max_uses}. {issued.expires_at ? 'Expires ' + clock(issued.expires_at, true) + '.' : 'Never expires.'}</p>
          </Notice>
        ) : null}
      </Section>

      <Section
        title="Issued codes"
        description="Plaintext codes are never stored or listed. Revocation prevents a registration already started but not yet completed."
        actions={<Button size="sm" variant="ghost" onClick={codes.reload}>Refresh</Button>}
      >
        {codes.error ? (
          <Notice tone="danger">
            {codes.error?.body?.message || codes.error?.message || String(codes.error)}
          </Notice>
        ) : null}
        {codes.loading && !codes.data ? <Hint>Reading admission codes…</Hint> : null}
        {!codes.loading && !codes.error && !codes.data?.codes?.length ? (
          <Notice>No registration codes have been issued yet.</Notice>
        ) : null}
        <div className="cp-reports">
          {(codes.data?.codes || []).map((code) => {
            const status = statusOf(code);
            return (
              <div key={code.id} className="cp-report">
                <div className="cp-report__body">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{code.label || (code.kind === 'setup' ? 'Initial server setup' : 'Registration code')}</strong>
                      <Pill tone={status === 'active' ? 'accent' : 'default'}>{status}</Pill>
                    </div>
                    {status === 'active' ? (
                      <DangerAction
                        label="Revoke"
                        title="Revoke registration code?"
                        body="No new account can redeem this code after revocation. Existing accounts remain active."
                        run={() => home.adminRevokeRegistrationCode(code.id)}
                        onDone={codes.reload}
                      />
                    ) : null}
                  </div>
                  <p className="text-sm text-muted">
                    {code.uses} / {code.max_uses} uses · Created {clock(code.created_at, true)}
                    {code.expires_at ? ' · Expires ' + clock(code.expires_at, true) : ' · No expiry'}
                  </p>
                  <p className="text-xs text-muted">Issued by {code.created_by} · ID {code.id}</p>
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </>
  );
}
