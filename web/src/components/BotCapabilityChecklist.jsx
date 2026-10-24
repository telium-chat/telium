import { Checkbox } from './Field.jsx';
import { Pill } from './Feedback.jsx';
import { t } from '../lib/i18n/index.js';
import { useT } from '../lib/i18n/react.jsx';
import { PERMISSIONS, PERMISSION_GROUPS, permissionInfo } from '../lib/perms.js';

const intent = (name, group, danger = false) => {
  const key = name.toLowerCase();
  return {
    group,
    danger,
    get label() { return t(`bots.intent.${key}.label`); },
    get hint() { return t(`bots.intent.${key}.hint`); },
  };
};

const INTENT_INFO = {
  GUILD_MESSAGES: intent('GUILD_MESSAGES', 'activity'),
  GUILD_MEMBERS: intent('GUILD_MEMBERS', 'people'),
  GUILD_PRESENCES: intent('GUILD_PRESENCES', 'people'),
  GUILD_TYPING: intent('GUILD_TYPING', 'activity'),
  GUILD_EXPRESSIONS: intent('GUILD_EXPRESSIONS', 'structure'),
  GUILD_STRUCTURE: intent('GUILD_STRUCTURE', 'structure'),
  GUILD_VOICE_STATES: intent('GUILD_VOICE_STATES', 'activity'),
  MESSAGE_CONTENT: intent('MESSAGE_CONTENT', 'privileged', true),
};

const groupPair = (key, read) => Object.defineProperty([key, ''], 1, {
  get: read,
  enumerable: true,
});

const INTENT_GROUPS = [
  groupPair('activity', () => t('bots.intent.group.activity')),
  groupPair('people', () => t('bots.intent.group.people')),
  groupPair('structure', () => t('bots.intent.group.structure')),
  groupPair('privileged', () => t('bots.intent.group.privileged')),
];

function unknownInfo(name) {
  return {
    label: name,
    group: 'unknown',
    get hint() { return t('bots.capability.unknown.hint', { capability: name }); },
  };
}

const UNKNOWN_GROUP = groupPair('unknown', () => t('bots.capability.unknownGroup'));

export const BOT_INTENT_NAMES = Object.keys(INTENT_INFO);

export const BOT_PERMISSION_NAMES = PERMISSIONS;

export function BotCapabilityChecklist({
  kind = 'permission',
  title,
  names,
  value,
  onChange,
  hint,
  empty,
  disabled = false,
  retained,
  blocked,
}) {
  const t = useT();
  const catalogue = kind === 'intent' ? INTENT_INFO : null;
  const info = (name) => (
    catalogue
      ? (catalogue[name] || unknownInfo(name))
      : (PERMISSIONS.includes(name) ? permissionInfo(name) : unknownInfo(name))
  );
  const groups = kind === 'intent' ? INTENT_GROUPS : PERMISSION_GROUPS;

  const selected = new Set(value || []);
  const held = new Set(retained || []);
  const refusals = blocked || {};

  const rows = [...names, ...(value || []).filter((name) => !names.includes(name))];

  const toggle = (name) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(rows.filter((candidate) => next.has(candidate)));
  };

  const drawn = [...groups, UNKNOWN_GROUP]
    .map(([group, label]) => [label, rows.filter((name) => info(name).group === group)])
    .filter(([, list]) => list.length);
  const headed = drawn.length > 1;

  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{title}</legend>
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
      {rows.length ? drawn.map(([label, list]) => (
        <div key={label} className="flex flex-col gap-1.5">
          {headed ? <div className="eyebrow pt-1.5">{label}</div> : null}
          <div className="grid gap-2 sm:grid-cols-2">
            {list.map((name) => {
              const detail = info(name);
              const on = selected.has(name);
              const refusal = refusals[name];
              const retired = held.has(name);
              const locked = (retired || Boolean(refusal)) && !on;
              return (
                <div
                  key={name}
                  data-danger={detail.danger ? 'true' : undefined}
                  data-locked={locked ? 'true' : undefined}
                  className="bot-cap"
                >
                  <Checkbox
                    label={detail.label}
                    hint={detail.hint}
                    checked={on}
                    disabled={disabled || locked}
                    onChange={() => toggle(name)}
                  />
                  <div className="check-indent flex flex-wrap items-center gap-1.5 pt-1">
                    <code className="min-w-0 truncate text-[0.625rem] text-muted">{name}</code>
                    {detail.danger ? <Pill tone="danger">{t('bots.capability.powerful')}</Pill> : null}
                    {retired ? <Pill tone="warn">{t('bots.capability.withdrawnBadge')}</Pill> : null}
                  </div>
                  {retired ? (
                    <p className="check-indent pt-1 text-xs text-muted">
                      {on
                        ? t('bots.capability.withdrawnHeld')
                        : t('bots.capability.withdrawnRemoved')}
                    </p>
                  ) : null}
                  {refusal && !retired ? (
                    <p className="check-indent pt-1 text-xs text-muted">{refusal}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )) : (
        <div className="text-sm text-muted">{empty || t('bots.capability.emptyDefault')}</div>
      )}
    </fieldset>
  );
}
