import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn.js';
import { normalizeComponents } from '../../lib/interactions.js';
import { CheckIcon, ChevronDownIcon, EmojiText, LinkIcon, SpinnerIcon } from '../index.js';
import { useInteractions } from './useInteraction.jsx';

export function MessageComponents({ msg, rows: given, appName }) {
  const own = useMemo(
    () => (given ? null : normalizeComponents(msg.components)),
    [given, msg.components],
  );
  const rows = given || own;
  const { send, phaseOf } = useInteractions(msg, { appName });

  if (!rows?.length) return null;
  return (
    <div
      className="mc-rows"
      role="group"
      aria-label={appName ? `Controls from ${appName}` : 'Message controls'}
    >
      {rows.map((row, at) => (
        // Rows are positional in the contract.
        // eslint-disable-next-line react/no-array-index-key
        <div className="mc-row" key={at}>
          {row.components.map((item) => (item.type === 'select' ? (
            <AppSelect
              key={item.customId}
              item={item}
              phase={phaseOf(item.customId)}
              onChoose={(values) => send({ customId: item.customId, values })}
            />
          ) : (
            <AppButton
              key={item.customId || `link-${item.url}-${item.label}`}
              item={item}
              phase={item.customId ? phaseOf(item.customId) : 'idle'}
              onPress={() => send({ customId: item.customId })}
            />
          )))}
        </div>
      ))}
    </div>
  );
}

function AppButton({ item, phase, onPress }) {
  const busy = phase !== 'idle';
  const face = (
    <span className="mc-btn__label">
      {item.emoji ? <EmojiText>{item.emoji}</EmojiText> : null}
      {item.label ? <span className="mc-btn__text">{item.label}</span> : null}
    </span>
  );

  if (item.style === 'link') {
    if (!item.url) {
      return (
        <button
          type="button"
          className="mc-btn mc-btn--link"
          disabled
          title="This link was refused: it does not point at an ordinary web address."
        >
          {face}
        </button>
      );
    }
    return (
      <a
        className={cn('mc-btn mc-btn--link', item.disabled && 'mc-btn--off')}
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        title={item.url}
        aria-disabled={item.disabled || undefined}
        onClick={item.disabled ? (e) => e.preventDefault() : undefined}
      >
        {face}
        <LinkIcon className="mc-btn__glyph" aria-hidden="true" />
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cn('mc-btn', `mc-btn--${item.style}`)}
      disabled={item.disabled || busy}
      aria-busy={busy || undefined}
      data-phase={busy ? phase : undefined}
      title={phase === 'deferred' ? 'Waiting for the application to answer' : undefined}
      onClick={onPress}
    >
      <span className={cn('mc-btn__stack', busy && 'is-busy')}>
        {face}
        {busy ? (
          <SpinnerIcon className="mc-btn__spinner animate-spin motion-reduce:animate-none" aria-label="Working" />
        ) : null}
      </span>
    </button>
  );
}

function AppSelect({ item, phase, onChoose }) {
  const busy = phase !== 'idle';
  const multiple = item.max > 1;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState(() => new Set(
    item.options.filter((o) => o.default).map((o) => o.value).slice(0, item.max),
  ));
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const triggerRef = useRef(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.focus();
  }, [open]);

  const close = useCallback(({ restore = true } = {}) => {
    setOpen(false);
    if (restore) triggerRef.current?.focus();
  }, []);

  const take = useCallback((option) => {
    if (!multiple) {
      setChosen(new Set([option.value]));
      close();
      onChoose([option.value]);
      return;
    }
    setChosen((held) => {
      const next = new Set(held);
      if (next.has(option.value)) next.delete(option.value);
      else if (next.size < item.max) next.add(option.value);
      return next;
    });
  }, [multiple, item.max, close, onChoose]);

  const onKeyDown = (e) => {
    const last = item.options.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(last, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); take(item.options[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close({ restore: false });
  };

  const picked = item.options.filter((o) => chosen.has(o.value));
  const summary = picked.length
    ? picked.map((o) => o.label).join(', ')
    : (item.placeholder || 'Choose an option');
  const short = picked.length > 2 ? `${picked.length} chosen` : summary;
  const enough = chosen.size >= item.min && chosen.size <= item.max;

  return (
    <div className="mc-select" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mc-select__trigger"
        disabled={item.disabled || busy}
        aria-busy={busy || undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <span className={cn('mc-select__value', !picked.length && 'is-placeholder')}>
          <EmojiText>{short}</EmojiText>
        </span>
        {busy
          ? <SpinnerIcon className="mc-btn__spinner animate-spin motion-reduce:animate-none" aria-label="Working" />
          : <ChevronDownIcon className="mc-select__glyph" aria-hidden="true" />}
      </button>

      {open ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-multiselectable={multiple || undefined}
          aria-activedescendant={`${listId}-${active}`}
          aria-label={item.placeholder || 'Options'}
          className="mc-select__list"
          onKeyDown={onKeyDown}
        >
          {item.options.map((option, at) => (
            <div
              key={option.value}
              id={`${listId}-${at}`}
              role="option"
              aria-selected={chosen.has(option.value)}
              className={cn('mc-option', at === active && 'is-active')}
              onMouseEnter={() => setActive(at)}
              onClick={() => take(option)}
            >
              <span className="mc-option__body">
                <span className="mc-option__label">
                  {option.emoji ? <EmojiText>{option.emoji}</EmojiText> : null}
                  <EmojiText>{option.label}</EmojiText>
                </span>
                {option.description ? (
                  <span className="mc-option__hint">{option.description}</span>
                ) : null}
              </span>
              {chosen.has(option.value) ? <CheckIcon className="mc-option__tick" aria-hidden="true" /> : null}
            </div>
          ))}
          {multiple ? (
            <div className="mc-select__foot">
              <span className="mc-select__count">
                {item.min ? `${chosen.size} of ${item.min}-${item.max}` : `${chosen.size} of ${item.max}`}
              </span>
              <button
                type="button"
                className="mc-btn mc-btn--primary mc-btn--sm"
                disabled={!enough}
                onClick={() => { close(); onChoose([...chosen]); }}
              >
                <span className="mc-btn__label"><span className="mc-btn__text">Send</span></span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
