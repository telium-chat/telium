import { useEffect, useState } from 'react';
import { Button, ChevronRightIcon, ServerIcon } from '../components/index.js';
import { copyToClipboard } from '../lib/clipboard.js';
import { discover } from '../lib/api.js';
import { hasPinnedRecommendationKey } from '../lib/account-home-recommendations.js';
import { Trans, useT } from '../lib/i18n/react.jsx';

export function HomeChip({ host, onClick = null }) {
  const t = useT();
  const inner = (
    <>
      <ServerIcon className="size-3.5 shrink-0 text-muted" />
      <span className="truncate">{host}</span>
      {onClick ? <ChevronRightIcon className="auth-host-caret size-3 shrink-0 text-muted" /> : null}
    </>
  );
  return onClick
    ? (
      <button
        type="button"
        className="auth-host is-live"
        aria-label={t('onboarding.home.chipAction', { host })}
        onClick={onClick}
      >
        {inner}
      </button>
    )
    : <span className="auth-host">{inner}</span>;
}

export function AccountAddress({ userId }) {
  const t = useT();
  if (!userId) return null;
  return (
    <div className="flex flex-col gap-2 rounded-row bg-surface-secondary p-3.5" data-testid="account-address">
      <p className="text-sm leading-[1.6]">
        <Trans
          k="onboarding.address.yours"
          values={{ user: userId }}
          components={{ b: <strong className="select-all break-all font-semibold text-foreground" /> }}
        />
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => copyToClipboard(userId, t('onboarding.address.clipboardLabel'))}
      >
        {t('onboarding.address.copy')}
      </Button>
    </div>
  );
}

export function useAlternativeHomesOffered(home) {
  const [offered, setOffered] = useState(false);

  useEffect(() => {
    if (!home || !hasPinnedRecommendationKey()) return undefined;
    let live = true;
    discover(home)
      .then((doc) => { if (live) setOffered(doc.suggest_alternatives === true); })
      .catch(() => { if (live) setOffered(false); });
    return () => { live = false; };
  }, [home]);

  return offered;
}
