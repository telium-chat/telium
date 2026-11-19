import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AudioQuickMenu } from '../components/AudioQuickMenu.jsx';

const base = { onInput: vi.fn(), onOutput: vi.fn(), noiseMode: 'browser', noiseSupport: { ok: true } };

describe('the call bar audio menu', () => {
  it('offers noise suppression alone where the call cannot switch devices', () => {
    render(<AudioQuickMenu {...base} devicePicking={false} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('adds the microphone and output pickers where it can', () => {
    render(<AudioQuickMenu {...base} devicePicking />);
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
  });

  it('changes the mode through the callback', () => {
    const onNoise = vi.fn();
    render(<AudioQuickMenu {...base} onNoise={onNoise} devicePicking={false} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'off' } });
    expect(onNoise).toHaveBeenCalledWith('off');
  });

  it('says so when the neural model has stood aside', () => {
    render(<AudioQuickMenu {...base} noiseMode="neural" noiseState="paused" devicePicking={false} />);
    expect(screen.getByText(/Paused while this device is busy/)).toBeTruthy();
  });
});
