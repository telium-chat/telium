import { cloneElement, isValidElement, useId, useRef, useState } from 'react';
import { Field as KumoField } from '@cloudflare/kumo/components/field';
import {
  Input as KumoInput, InputArea as KumoInputArea,
  InputGroup,
} from '@cloudflare/kumo/components/input';
import { Select as KumoSelect } from '@cloudflare/kumo/components/select';
import { Checkbox as KumoCheckbox } from '@cloudflare/kumo/components/checkbox';
import { Switch as KumoSwitch } from '@cloudflare/kumo/components/switch';
import { buttonVariants } from '@cloudflare/kumo/components/button';
import { Text } from '@cloudflare/kumo/components/text';
import { cn } from '../lib/cn.js';
import { CloseIcon, SearchIcon, VisibilityIcon, VisibilityOffIcon } from './icons.jsx';

export function Field({ label, hint, children, ...rest }) {
  if (isValidElement(children) && labelsItself(children.type)) {
    return cloneElement(children, {
      label: children.props.label ?? label,
      hint: children.props.hint ?? hint,
      ...rest,
    });
  }
  const names = isValidElement(children)
    && (children.props['aria-label'] || children.props['aria-labelledby']);
  const named = isValidElement(children) && !names && typeof label === 'string'
    ? cloneElement(children, { 'aria-label': label })
    : children;

  return (
    <KumoField label={label} description={hint || undefined} {...rest}>
      {named}
    </KumoField>
  );
}

const labelsItself = (type) => (
  type === TextInput || type === TextArea || type === Select
  || type === Checkbox || type === Switch || type === PasswordInput
  || type === SearchField
);

export function TextInput({
  label, hint, value, onChange, type = 'text', disabled,
  size = 'base', className, inputClassName, endContent, inputRef, ...rest
}) {
  const named = label ? undefined : (rest['aria-label'] || rest.placeholder);
  const groupedName = rest['aria-label']
    || (typeof label === 'string' ? label : undefined)
    || rest.placeholder;

  if (endContent) {
    return (
      <InputGroup
        size={size}
        label={label || undefined}
        description={hint || undefined}
        disabled={Boolean(disabled)}
        className={cn('telium-field w-full', className)}
      >
        <InputGroup.Input
          ref={inputRef}
          type={type}
          value={value ?? ''}
          onChange={onChange}
          aria-label={groupedName}
          className={inputClassName}
          {...rest}
        />
        <InputGroup.Addon align="end">{endContent}</InputGroup.Addon>
      </InputGroup>
    );
  }

  return (
    <KumoInput
      ref={inputRef}
      type={type}
      size={size}
      label={label || undefined}
      description={hint || undefined}
      value={value ?? ''}
      onChange={onChange}
      disabled={Boolean(disabled)}
      aria-label={named}
      className={cn('telium-field w-full', className, inputClassName)}
      {...rest}
    />
  );
}

export function PasswordInput({ label = 'Password', inputRef: callerRef, ...rest }) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef(null);
  const action = visible ? 'Hide password' : 'Show password';

  const attachRef = (el) => {
    inputRef.current = el;
    if (typeof callerRef === 'function') callerRef(el);
    else if (callerRef) callerRef.current = el;
  };

  const toggleVisibility = () => {
    const input = inputRef.current;
    const selectionStart = input?.selectionStart ?? null;
    const selectionEnd = input?.selectionEnd ?? null;
    const selectionDirection = input?.selectionDirection ?? 'none';

    setVisible((current) => !current);

    // Chromium/WebView resets the caret when type switches; restore the selection.
    requestAnimationFrame(() => {
      const current = inputRef.current;
      if (!current) return;
      current.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) {
        current.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
      }
    });
  };

  return (
    <TextInput
      {...rest}
      inputRef={attachRef}
      label={label}
      type={visible ? 'text' : 'password'}
      endContent={(
        <InputGroup.Button
          type="button"
          variant="ghost"
          aria-label={action}
          aria-pressed={visible}
          tooltip={action}
          onPointerDown={(event) => event.preventDefault()}
          onClick={toggleVisibility}
        >
          {visible
            ? <VisibilityOffIcon className="size-4" />
            : <VisibilityIcon className="size-4" />}
        </InputGroup.Button>
      )}
    />
  );
}

export function TextArea({
  label, hint, value, onChange, rows = 3, disabled, size = 'base', className, inputRef, ...rest
}) {
  return (
    <KumoInputArea
      ref={inputRef}
      rows={rows}
      size={size}
      label={label || undefined}
      description={hint || undefined}
      value={value ?? ''}
      onChange={onChange}
      disabled={Boolean(disabled)}
      aria-label={label ? undefined : (rest['aria-label'] || rest.placeholder)}
      className={cn('telium-field w-full resize-y', className)}
      {...rest}
    />
  );
}

export function SearchField({
  label = 'Search',
  value,
  onChange,
  onClear,
  placeholder,
  size = 'base',
  className,
  inputClassName,
  ...rest
}) {
  return (
    <InputGroup size={size} className={cn('telium-field w-full', className)}>
      <InputGroup.Addon align="start">
        <SearchIcon className="shrink-0" />
      </InputGroup.Addon>
      <InputGroup.Input
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value ?? ''}
        onChange={onChange}
        // Safari draws its own clear button in search inputs.
        className={cn('[&::-webkit-search-cancel-button]:appearance-none', inputClassName)}
        {...rest}
      />
      {onClear && value ? (
        <InputGroup.Addon align="end">
          <InputGroup.Button aria-label="Clear search" onClick={onClear}>
            <CloseIcon />
          </InputGroup.Button>
        </InputGroup.Addon>
      ) : null}
    </InputGroup>
  );
}

const NONE = '\u0000';
const wrap = (v) => (v === '' ? NONE : v);
const unwrap = (v) => (v === NONE ? '' : v);

export function Select({
  label, hint, options = [], value, onChange, disabled, isDisabled, className, ...rest
}) {
  const items = options.map((opt) => (Array.isArray(opt) ? opt : [opt, opt]));
  return (
    <KumoSelect
      label={label || undefined}
      description={hint || undefined}
      aria-label={label ? undefined : rest['aria-label']}
      value={value == null ? null : wrap(value)}
      renderValue={(selected) => {
        const chosen = unwrap(selected);
        const match = items.find(([optionValue]) => String(optionValue) === String(chosen));
        return match?.[1] ?? String(chosen ?? '');
      }}
      onValueChange={(next) => onChange?.({ target: { value: unwrap(next) } })}
      disabled={Boolean(disabled ?? isDisabled)}
      className={cn('telium-field w-full', className)}
      {...rest}
    >
      {items.map(([v, text]) => (
        <KumoSelect.Option key={String(v)} value={wrap(v)}>{text}</KumoSelect.Option>
      ))}
    </KumoSelect>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled, className, ...rest }) {
  const hintId = useId();
  return (
    <div className="flex flex-col gap-1">
      <KumoCheckbox
        label={label}
        checked={Boolean(checked)}
        disabled={Boolean(disabled)}
        onCheckedChange={(next) => onChange?.(next)}
        aria-describedby={hint ? hintId : undefined}
        className={cn('telium-check', className)}
        {...rest}
      />
      {hint ? (
        <div className="check-indent">
          <Text id={hintId} variant="secondary" size="sm">{hint}</Text>
        </div>
      ) : null}
    </div>
  );
}

export function Switch({
  label, hint, checked, onChange, disabled, hideLabel, className, ...rest
}) {
  const hintId = useId();
  const control = (
    <KumoSwitch
      label={hideLabel ? undefined : label}
      aria-label={hideLabel ? label : undefined}
      controlFirst={false}
      checked={Boolean(checked)}
      disabled={Boolean(disabled)}
      onCheckedChange={(next) => onChange?.(next)}
      aria-describedby={hint ? hintId : undefined}
      className={cn('telium-switch', className)}
      {...rest}
    />
  );

  if (hideLabel) return <div className="w-full py-1">{control}</div>;

  return (
    <div className="telium-switch-row w-full py-2.5">
      {control}
      {hint ? (
        <div className="mt-0.5 pe-14">
          <Text id={hintId} variant="secondary" size="sm">{hint}</Text>
        </div>
      ) : null}
    </div>
  );
}

export function FilePicker({ label = 'Choose a file', accept, multiple, onPick, className }) {
  return (
    <label
      className={cn(
        buttonVariants({ variant: 'secondary', size: 'base' }),
        'min-h-11 cursor-pointer sm:min-h-0',
        className,
      )}
    >
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          const files = [...e.target.files];
          e.target.value = '';
          if (files.length) onPick?.(multiple ? files : files[0]);
        }}
      />
      {label}
    </label>
  );
}
