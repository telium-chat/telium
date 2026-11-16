import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ContextMenu } from '../components/index.js';
import { MobileContextMenu } from '../views/mobile/MobileActionSheet.jsx';

// Issue #59: a call tile with no camera and no menu passes content={undefined}.
// Right-clicking it used to call undefined() and crash the whole screen.
describe('context menu without content', () => {
  it('does not crash when right-clicked', async () => {
    render(
      <ContextMenu content={undefined}>
        <div>Tile</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Tile'), { clientX: 80, clientY: 80 });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText('Tile')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not crash on mobile long-press', async () => {
    render(
      <MobileContextMenu content={undefined}>
        <div>Tile</div>
      </MobileContextMenu>,
    );
    const el = screen.getByText('Tile');
    fireEvent.touchStart(el, { touches: [{ clientX: 10, clientY: 10 }] });
    await new Promise((r) => setTimeout(r, 450));
    expect(screen.getByText('Tile')).toBeTruthy();
  });
});
