import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu, MenuSlider } from '../components/index.js';

describe('context menu volume slider', () => {
  it('changes continuously without dismissing the context menu', async () => {
    const changed = vi.fn();
    render(
      <ContextMenu
        content={() => (
          <MenuSlider label="Volume" value={73} onChange={changed} />
        )}
      >
        <button type="button">Person</button>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Person' }), {
      clientX: 80,
      clientY: 80,
    });
    const slider = await screen.findByRole('slider', { name: 'Volume' });
    expect(slider.value).toBe('73');

    fireEvent.change(slider, { target: { value: '41' } });
    expect(changed).toHaveBeenCalledWith(41);
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeTruthy();
  });
});
