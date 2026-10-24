import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PasswordInput } from '../components/index.js';

describe('PasswordInput', () => {
  it('toggles without changing the password, submitting, or moving the caret', async () => {
    const submitted = vi.fn((event) => event.preventDefault());

    render(
      <form onSubmit={submitted}>
        <PasswordInput label="Password" value="correct horse battery" onChange={() => {}} />
      </form>,
    );

    const input = screen.getByLabelText('Password');
    expect(input.getAttribute('type')).toBe('password');
    expect(input.value).toBe('correct horse battery');

    await act(async () => {
      input.focus();
      input.setSelectionRange(7, 7);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Show password' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(input.getAttribute('type')).toBe('text');
    expect(input.value).toBe('correct horse battery');
    expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true');
    expect(submitted).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(7);
      expect(input.selectionEnd).toBe(7);
    });

    await act(async () => {
      input.setSelectionRange(3, 12);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Hide password' }));
      fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(input.getAttribute('type')).toBe('password');
    expect(input.value).toBe('correct horse battery');
    expect(submitted).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(3);
      expect(input.selectionEnd).toBe(12);
    });
  });
});
