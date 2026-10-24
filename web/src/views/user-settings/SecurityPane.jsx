import { useMemo, useState } from 'react';
import { useAsync, useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { codeOf, errorMessage } from '../../lib/i18n/errors.js';
import { Trans, useT } from '../../lib/i18n/react.jsx';
import { qrMatrix } from '../../lib/qr.js';
import { copyToClipboard } from '../../lib/clipboard.js';
import { forgetTrustedHost, trustedDomains } from '../../lib/link-trust.js';
import {
  Async, Button, CloseIcon, Field, Hint, IconButton, Notice, Section, TextInput,
} from '../../components/index.js';
import { Advanced, Detail, downloadText } from './RecoveryParts.jsx';


function QrCode({ value }) {
  const t = useT();
  const matrix = useMemo(() => qrMatrix(value), [value]);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const path = useMemo(() => {
    const parts = [];
    for (let row = 0; row < matrix.length; row += 1) {
      for (let col = 0; col < matrix.length; col += 1) {
        if (matrix[row][col]) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
    return parts.join('');
  }, [matrix]);

  return (
    <svg
      role="img"
      aria-label={t('security.mfa.qrLabel')}
      viewBox={`0 0 ${size} ${size}`}
      className="mx-auto w-[315px] max-w-full rounded-xl bg-white p-2"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

function TrustedLinks() {
  const store = useStore();
  const t = useT();
  useStoreEvent('prefs');
  const domains = trustedDomains(store);

  return (
    <Section
      title={t('security.trustedLinks.title')}
      description={t('security.trustedLinks.description')}
    >
      {domains.length ? (
        <ul className="flex flex-col gap-1">
          {domains.map((domain) => (
            <li
              key={domain}
              className="flex min-h-11 items-center gap-2 rounded-[var(--radius-row)] bg-surface-secondary px-3 py-1.5"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm">{domain}</span>
              <IconButton
                title={t('security.trustedLinks.forget', { domain })}
                onClick={() => forgetTrustedHost(store, domain)}
              >
                <CloseIcon className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <Hint>{t('security.trustedLinks.empty')}</Hint>
      )}
    </Section>
  );
}

export function SecurityPane() {
  const store = useStore();
  const t = useT();
  const state = useAsync(() => store.home.mfaStatus(), []);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [recovery, setRecovery] = useState([]);
  const [busy, setBusy] = useState(false);

  const fail = (e, contextKey) => {
    toast(codeOf(e) ? errorMessage(e) : t(contextKey, { reason: errorMessage(e) }), { error: true });
  };

  const begin = async () => {
    setBusy(true);
    try {
      const proof = await store.reauthProof(password);
      setSetup(await store.home.mfaSetup(proof));
      setPassword('');
      setCode('');
    } catch (e) { fail(e, 'security.mfa.setupFailed'); }
    finally { setBusy(false); }
  };

  const enable = async () => {
    setBusy(true);
    try {
      const result = await store.home.mfaEnable(code.trim());
      setRecovery(result.recovery_codes || []);
      setSetup(null);
      setCode('');
      state.reload();
      toast(t('security.mfa.enabledToast'));
    } catch (e) { fail(e, 'security.mfa.enableFailed'); }
    finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true);
    try {
      const proof = await store.reauthProof(disablePassword);
      await store.home.mfaDisable(proof, disableCode.trim());
      setDisablePassword('');
      setDisableCode('');
      state.reload();
      toast(t('security.mfa.disabledToast'));
    } catch (e) { fail(e, 'security.mfa.disableFailed'); }
    finally { setBusy(false); }
  };

  return (
    <Async state={state}>
      {(mfa) => {
        const remaining = typeof mfa.recovery_codes_remaining === 'number'
          ? mfa.recovery_codes_remaining
          : null;
        const codesExhausted = remaining === 0;

        return (
          <>
            <TrustedLinks />
            <Section title={t('security.mfa.title')}>
              <Hint>{t('security.mfa.appHint')}</Hint>
              {mfa.enabled ? (
                <>
                  <Notice tone={codesExhausted ? 'warn' : 'success'}>
                    {remaining === null
                      ? t('security.mfa.enabledNoCount')
                      : t('security.mfa.enabled', { remaining })}
                  </Notice>
                  <Field label={t('common.password')}>
                    <TextInput
                      type="password"
                      autoComplete="current-password"
                      value={disablePassword}
                      onChange={(e) => setDisablePassword(e.target.value)}
                    />
                  </Field>
                  <Field label={t('security.mfa.codeLabel')}>
                    <TextInput
                      autoComplete="one-time-code"
                      value={disableCode}
                      onChange={(e) => setDisableCode(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="danger-soft"
                    className="self-start"
                    disabled={busy || !disablePassword || !disableCode}
                    onClick={disable}
                  >
                    {t('security.mfa.disable')}
                  </Button>
                </>
              ) : setup ? (
                <>
                  <Notice tone="warn">{t('security.mfa.scanWarning')}</Notice>
                  <QrCode value={setup.otpauth_uri} />
                  <Field
                    label={t('security.mfa.manualLabel')}
                    hint={t('security.mfa.manualHint')}
                  >
                    <TextInput readOnly value={setup.secret || ''} onClick={(e) => e.target.select()} />
                  </Field>
                  <Field label={t('security.mfa.codeFieldLabel')}>
                    <TextInput
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </Field>
                  <Button variant="primary" className="self-start" disabled={busy || !code} onClick={enable}>
                    {t('security.mfa.verifyEnable')}
                  </Button>
                </>
              ) : (
                <>
                  <Field
                    label={t('common.password')}
                    hint={t('security.mfa.reauthHint')}
                  >
                    <TextInput
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                  <Button variant="primary" className="self-start" disabled={busy || !password} onClick={begin}>
                    {t('security.mfa.setUp')}
                  </Button>
                  <Advanced>
                    <Detail name={t('security.mfa.whyPasswordTitle')}>
                      {t('security.mfa.whyPasswordBody')}
                    </Detail>
                  </Advanced>
                </>
              )}
            </Section>

            {recovery.length ? (
              <Section title={t('security.codes.title')}>
                <Notice tone="warn">
                  <Trans k="security.codes.warning" components={{ b: <strong /> }} />
                </Notice>
                <ol
                  className="ekey-key flex-col font-mono"
                  tabIndex={0}
                  aria-label={t('security.codes.listLabel', { count: recovery.length })}
                >
                  {recovery.map((codeValue) => (
                    <li key={codeValue} className="ekey-key__group">{codeValue}</li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => copyToClipboard(recovery.join('\n'), t('security.codes.clipboardName'))}
                  >
                    {t('security.codes.copy')}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => downloadText(
                      `telium-recovery-codes-${(store.me?.user_id || 'account').replace(/[^a-zA-Z0-9._-]/g, '-')}.txt`,
                      `${t('security.codes.fileHeading')}\n\n${recovery.join('\n')}\n`,
                    )}
                  >
                    {t('security.codes.download')}
                  </Button>
                </div>
              </Section>
            ) : null}
          </>
        );
      }}
    </Async>
  );
}
