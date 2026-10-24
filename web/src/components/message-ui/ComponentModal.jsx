import { useEffect, useMemo, useRef, useState } from 'react';
import { ModalShell } from '../Modal.jsx';
import { Button } from '../Button.jsx';
import { TextArea, TextInput } from '../Field.jsx';
import { AppsIcon, ShieldAlertIcon } from '../icons.jsx';
import { plainText, LIMITS } from '../../lib/interactions.js';

function complaintFor(input, raw) {
  const value = raw.trim();
  if (input.required && !value) return 'This one is required.';
  if (input.min && value.length < input.min) {
    return `At least ${input.min} character${input.min === 1 ? '' : 's'}.`;
  }
  if (value.length > input.max) return `At most ${input.max} characters.`;
  return null;
}

export function ComponentModal({ modal, appName, close, onSubmit }) {
  const [values, setValues] = useState(() => Object.fromEntries(
    modal.inputs.map((input) => [input.customId, plainText(input.value, input.max, {
      multiline: input.style === 'paragraph',
    })]),
  ));
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const fields = useRef({});

  useEffect(() => { fields.current[modal.inputs[0]?.customId]?.focus(); }, [modal]);

  const complaints = useMemo(() => Object.fromEntries(
    modal.inputs.map((input) => [input.customId, complaintFor(input, values[input.customId] || '')]),
  ), [modal.inputs, values]);
  const held = Object.values(complaints).some(Boolean);

  const submit = async () => {
    if (held) {
      setShown(true);
      const first = modal.inputs.find((input) => complaints[input.customId]);
      if (first) fields.current[first.customId]?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(modal.inputs.map((input) => ({
        custom_id: input.customId,
        value: (values[input.customId] || '').trim().slice(0, LIMITS.inputValue),
      })));
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mc-modal">
      <ModalShell
        title={modal.title}
        footer={(
          <>
            <Button variant="tertiary" onClick={close}>Cancel</Button>
            <Button variant="primary" isDisabled={busy} onClick={submit}>Submit</Button>
          </>
        )}
      >
        <div className="mc-modal__origin">
          <AppsIcon className="mc-modal__origin-glyph" aria-hidden="true" />
          <span>
            A form from
            {' '}
            <b>{appName || 'an application'}</b>
            , not from Telium.
          </span>
        </div>

        {modal.inputs.map((input) => {
          const value = values[input.customId] || '';
          const complaint = shown ? complaints[input.customId] : null;
          const Control = input.style === 'paragraph' ? TextArea : TextInput;
          return (
            <Control
              key={input.customId}
              inputRef={(el) => { fields.current[input.customId] = el; }}
              label={input.label}
              hint={complaint || (input.required ? 'Required' : undefined)}
              maxLength={input.max}
              rows={input.style === 'paragraph' ? 5 : undefined}
              value={value}
              placeholder={input.placeholder || undefined}
              aria-required={input.required || undefined}
              aria-invalid={complaint ? true : undefined}
              className={complaint ? 'mc-field--bad' : undefined}
              onChange={(e) => setValues((held) => ({
                ...held,
                [input.customId]: e.target.value,
              }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && input.style !== 'paragraph') submit();
              }}
            />
          );
        })}

        <p className="mc-modal__warn">
          <ShieldAlertIcon className="mc-modal__warn-glyph" aria-hidden="true" />
          <span>
            Telium will never ask for your password, your recovery phrase or a
            login code in a form like this one. Only type what you would be
            happy for this application&rsquo;s owner to read.
          </span>
        </p>
      </ModalShell>
    </div>
  );
}
