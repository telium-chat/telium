import { useEffect, useRef, useState } from 'react';
import { TextInput } from '../components/index.js';
import {
  chooseAccountHome,
  loadAccountHomeRecommendations,
  secureRandom,
} from '../lib/account-home-recommendations.js';
import { Trans, useT } from '../lib/i18n/react.jsx';

const describeHome = (t, server) => {
  const details = [];
  if (server.region_label) details.push(server.region_label);
  else if (server.region) details.push(server.region);
  if (typeof server.uptime_30d === 'number') {
    details.push(t('onboarding.home.uptime', { rate: server.uptime_30d }));
  }
  return details.join(t('onboarding.home.detailSeparator'));
};

export function RecommendedHome({
  selected,
  servers,
  disabled = false,
  onChoose,
  onElsewhere = null,
  elsewhereLabel = null,
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const others = servers.filter((server) => server.domain !== selected.domain);
  const detail = describeHome(t, selected);
  return (
    <div className="flex flex-col gap-2" data-testid="recommended-home">
      <div className="rounded-lg border border-border bg-field-background p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm text-foreground">
              <Trans
                k="onboarding.home.picked"
                values={{ name: selected.name }}
                components={{ b: <strong className="font-medium" /> }}
              />
            </div>
            <div className="mt-0.5 truncate text-xs text-muted">{selected.domain}</div>
            {detail ? <div className="mt-1 text-xs text-muted">{detail}</div> : null}
            {selected.operator_name ? (
              <div className="mt-1 text-xs text-muted">
                <Trans
                  k="onboarding.home.operatedBy"
                  values={{ operator: selected.operator_name }}
                  components={{
                    a: selected.operator_contact ? (
                      <a
                        href={selected.operator_contact}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-accent hover:underline"
                      />
                    ) : undefined,
                  }}
                />
              </div>
            ) : null}
          </div>
          <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-[0.6875rem] font-medium text-accent">
            {t('onboarding.home.communityBadge')}
          </span>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted">{t('onboarding.home.why')}</p>
      </div>
      {others.length || onElsewhere ? (
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
          className="self-start rounded text-sm font-medium text-link hover:underline disabled:opacity-50"
        >
          {open ? t('common.done') : t('onboarding.home.chooseOther')}
        </button>
      ) : null}
      {open ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-2"
          role="group"
          aria-label={t('onboarding.home.otherChoices')}
        >
          {others.map((server) => {
            const line = describeHome(t, server);
            return (
              <button
                key={server.domain}
                type="button"
                disabled={disabled}
                onClick={() => { setOpen(false); onChoose(server); }}
                className="press rounded-md border border-border px-3 py-2 text-start hover:bg-surface-secondary disabled:opacity-50"
              >
                <span className="block text-sm font-medium text-foreground">{server.name}</span>
                <span className="mt-0.5 block text-xs text-muted">
                  {line ? `${server.domain}${t('onboarding.home.detailSeparator')}${line}` : server.domain}
                </span>
                {server.operator_name ? (
                  <span className="mt-0.5 block text-xs text-muted">
                    <Trans k="onboarding.home.operatedBy" values={{ operator: server.operator_name }} />
                  </span>
                ) : null}
              </button>
            );
          })}
          {onElsewhere ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => { setOpen(false); onElsewhere(); }}
              className="press rounded-md px-3 py-2 text-start text-sm font-medium text-link hover:bg-surface-secondary disabled:opacity-50"
            >
              {elsewhereLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AccountHomePicker({
  value,
  onChange,
  onSelect = null,
  disabled = false,
  inputRef = null,
  loadRecommendations = loadAccountHomeRecommendations,
  random = secureRandom,
  restoreOnUnmount = true,
}) {
  const t = useT();
  const started = useRef(false);
  const displacedValue = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSelectRef = useRef(onSelect);
  const loadRef = useRef(loadRecommendations);
  const randomRef = useRef(random);
  onChangeRef.current = onChange;
  onSelectRef.current = onSelect;
  const [phase, setPhase] = useState('loading');
  const [reason, setReason] = useState(null);
  const [servers, setServers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (started.current) return undefined;
    started.current = true;
    let cancelled = false;

    onSelectRef.current?.(null);
    onChangeRef.current('');

    loadRef.current().then((result) => {
      if (cancelled) return;
      const candidates = Array.isArray(result?.servers) ? result.servers : [];
      if (!candidates.length) {
        setReason(result?.reason || 'no_usable_servers');
        setPhase('unavailable');
        setAdvanced(true);
        return;
      }

      const choice = chooseAccountHome(candidates, randomRef.current);
      if (!choice) {
        setReason('no_usable_servers');
        setPhase('unavailable');
        setAdvanced(true);
        return;
      }

      setServers(candidates);
      setSelected(choice);
      setPhase('ready');
      onSelectRef.current?.(choice);
      onChangeRef.current(choice.api_origin);
    }).catch(() => {
      if (cancelled) return;
      setReason('unavailable');
      setPhase('unavailable');
      setAdvanced(true);
      onSelectRef.current?.(null);
    });

    return () => {
      cancelled = true;
      started.current = false;
      if (restoreOnUnmount) {
        onSelectRef.current?.(null);
        onChangeRef.current(displacedValue.current);
      }
    };
  }, []);

  const choose = (server) => {
    setSelected(server);
    setAdvanced(false);
    onSelect?.(server);
    onChange(server.api_origin);
  };

  const useDomain = () => {
    setSelected(null);
    setAdvanced(true);
    onSelect?.(null);
    onChange('');
    queueMicrotask(() => inputRef?.current?.focus?.());
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid="account-home-picker">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{t('onboarding.home.title')}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted">
            {t('onboarding.home.explainer')}
          </p>
        </div>
      </div>

      {phase === 'loading' ? (
        <div className="rounded-lg border border-border bg-field-background px-3 py-3 text-sm text-muted">
          {t('onboarding.home.finding')}
        </div>
      ) : null}

      {phase === 'ready' && selected && !advanced ? (
        <RecommendedHome
          selected={selected}
          servers={servers}
          disabled={disabled}
          onChoose={choose}
        />
      ) : null}

      {phase === 'unavailable' ? (
        <p className="text-xs leading-5 text-muted">
          {t('onboarding.home.unavailable')}
          {reason === 'no_pinned_key' ? ` ${t('onboarding.home.noPinnedKey')}` : ''}
        </p>
      ) : null}

      {advanced ? (
        <TextInput
          inputRef={inputRef}
          label={t('onboarding.home.label')}
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          disabled={disabled}
          hint={t('onboarding.home.advancedHint')}
          value={value}
          placeholder={t('onboarding.home.advancedPlaceholder')}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {!advanced ? (
          <button
            type="button"
            disabled={disabled}
            onClick={useDomain}
            className="font-medium text-accent hover:underline disabled:opacity-50"
          >
            {t('onboarding.home.useDomain')}
          </button>
        ) : null}
        <a
          href="https://telium.chat/servers"
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent hover:underline"
        >
          {t('onboarding.home.browseAll')}
        </a>
      </div>
    </div>
  );
}
