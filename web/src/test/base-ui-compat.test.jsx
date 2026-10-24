import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { twMerge } from 'tailwind-merge';
import { buttonVariants } from '@cloudflare/kumo/components/button';
import { Button, Hint, Select, Tabs } from '../components/index.js';

describe('Base UI compatibility seams', () => {
  it('keeps the old danger-soft name on the destructive secondary Kumo variant', () => {
    render(
      <>
        <Button variant="danger-soft">Reject</Button>
        <Button variant="secondary-destructive">Deny</Button>
      </>,
    );
    const aliased = screen.getByRole('button', { name: 'Reject' }).className;
    const spelled = screen.getByRole('button', { name: 'Deny' }).className;

    expect(aliased).toBe(spelled);

    const expected = buttonVariants({
      variant: 'secondary-destructive',
      size: 'base',
      shape: 'base',
    }).split(/\s+/).filter(Boolean);
    const present = new Set(aliased.split(/\s+/).filter(Boolean));

    for (const className of expected) {
      const displaced = twMerge(`${className} ${aliased}`) === aliased;
      expect(
        present.has(className) || displaced,
        `Kumo class ${className} is neither kept nor overridden`,
      ).toBe(true);
    }
  });

  it('renders the selected option label instead of its raw value', () => {
    const { container } = render(
      <Select
        aria-label="Expires"
        value="604800"
        options={[['3600', '1 hour'], ['604800', '1 week']]}
      />,
    );
    const trigger = container.querySelector(
      '[data-kumo-component="Select"][data-kumo-part="trigger"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('1 week');
    expect(trigger.textContent).not.toContain('604800');
  });

  it('accepts isDisabled on Select while old call sites finish migrating', () => {
    const { container } = render(
      <Select
        aria-label="Upload host"
        value="one"
        options={[['one', 'One'], ['two', 'Two']]}
        isDisabled
      />,
    );
    const trigger = container.querySelector(
      '[data-kumo-component="Select"][data-kumo-part="trigger"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger.disabled).toBe(true);
  });

  it('keeps layout classes on Hint through Kumo Text', () => {
    render(<Hint className="px-2 self-center">Helpful text</Hint>);
    const hint = screen.getByText('Helpful text');
    expect(hint.className.split(/\s+/)).toContain('px-2');
    expect(hint.className.split(/\s+/)).toContain('self-center');
  });

  it('marks the Kumo tab indicator for the initial transition workaround', () => {
    const { container } = render(
      <Tabs
        value="one"
        options={[['one', 'One'], ['two', 'Two']]}
        onChange={() => {}}
      />,
    );
    expect(container.querySelector('.telium-tabs-indicator')).toBeTruthy();
  });
});
