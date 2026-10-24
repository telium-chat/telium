import { Text } from '@cloudflare/kumo/components/text';
import {
  CheckIcon, ChevronRightIcon, LockIcon, WarnIcon,
} from '../../components/index.js';
import { useT } from '../../lib/i18n/react.jsx';
import { t as translate } from '../../lib/i18n/index.js';

export function Verdict({ state = 'ok', title, children }) {
  const Mark = state === 'attention' ? WarnIcon : state === 'ok' ? CheckIcon : LockIcon;
  return (
    <div className="ekey-verdict" role="status" data-state={state}>
      <span className="ekey-verdict__mark" aria-hidden="true">
        <Mark className="size-[19px]" />
      </span>
      <div className="min-w-0">
        <div className="ekey-verdict__title">{title}</div>
        {children ? <div className="ekey-verdict__note">{children}</div> : null}
      </div>
    </div>
  );
}

function DotIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

export function Fact({ tone = 'neutral', label, value }) {
  const t = useT();
  const Mark = tone === 'todo' ? WarnIcon : tone === 'ok' ? CheckIcon : DotIcon;
  return (
    <div className="ekey-fact" data-tone={tone}>
      <span className="ekey-fact__mark" aria-hidden="true">
        <Mark className="size-4" />
      </span>
      <span className="ekey-fact__label">{label}</span>
      <span className="ekey-fact__value">
        {tone === 'todo' ? <span className="sr-only">{t('auth.parts.needsAttention')}</span> : null}
        {value}
      </span>
    </div>
  );
}

export function RecoveryKeyText({ value, label = null }) {
  const t = useT();
  const name = label ?? t('auth.parts.recoveryKeyLabel');
  const text = String(value || '');
  const cut = Math.max(text.lastIndexOf('-'), text.lastIndexOf('_')) + 1;
  const prefix = cut > 0 ? text.slice(0, cut) : '';
  const secret = text.slice(cut);
  const groups = secret.match(/.{1,4}/g) || [];
  return (
    <div
      className="ekey-key font-mono"
      tabIndex={0}
      role="group"
      aria-label={t('auth.parts.keyGroups', { label: name, count: groups.length })}
    >
      {prefix ? (
        <span className="ekey-key__group" data-fixed="true">{prefix}</span>
      ) : null}
      {groups.map((group, index) => (
        <span key={index} className="ekey-key__group">{group}</span>
      ))}
    </div>
  );
}

export function Advanced({ label = null, children }) {
  const t = useT();
  return (
    <details className="ekey-more">
      <summary className="ekey-more__summary">
        <ChevronRightIcon className="ekey-more__chevron size-4" aria-hidden="true" />
        {label ?? t('auth.parts.advanced')}
      </summary>
      <div className="ekey-more__body">{children}</div>
    </details>
  );
}

export function Detail({ name, children }) {
  return (
    <div className="ekey-detail">
      <div className="ekey-detail__name">{name}</div>
      <div className="ekey-detail__value">{children}</div>
    </div>
  );
}

export function Explain({ children }) {
  return (
    <Text variant="secondary" size="sm">{children}</Text>
  );
}

export function downloadText(filename, body) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke next turn: Safari reads the blob after the handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function recoveryKeyNote(value, userId) {
  const host = typeof userId === 'string' && userId.includes(':')
    ? userId.slice(userId.indexOf(':') + 1)
    : null;
  return [
    translate('auth.parts.download.title'),
    userId ? translate('auth.parts.download.account', { user: userId }) : null,
    host ? translate('auth.parts.download.server', { host }) : null,
    '',
    value,
    '',
    translate('auth.parts.download.body1'),
    translate('auth.parts.download.body2'),
    '',
  ].filter((line) => line !== null).join('\n');
}

export function downloadRecoveryKey(value, userId) {
  const who = String(userId || 'telium').replace(/[^a-zA-Z0-9._-]/g, '-');
  downloadText(`telium-recovery-key-${who}.txt`, recoveryKeyNote(value, userId));
}
