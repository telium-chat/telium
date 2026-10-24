import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IconButton } from '../components/Button.jsx';
import { TooltipProvider } from '../components/Tooltip.jsx';

const mount = () => render(
  <TooltipProvider delay={0} closeDelay={0}>
    <IconButton title="Close image preview">x</IconButton>
  </TooltipProvider>,
);

describe('the tooltip', () => {
  it('lends the title to the tip on hover, and gives it back on the way out', async () => {
    const user = userEvent.setup();
    mount();

    const button = screen.getByTitle('Close image preview');
    await user.hover(button);

    expect(await screen.findAllByText('Close image preview')).toHaveLength(1);
    expect(button.getAttribute('title')).toBeNull();

    await user.unhover(button);
    expect(button.getAttribute('title')).toBe('Close image preview');
  });

  it('leaves the title alone for focus, which is where the name comes from', async () => {
    const user = userEvent.setup();
    mount();

    const button = screen.getByTitle('Close image preview');
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('title')).toBe('Close image preview');
  });

  it('is still just the button when there is nothing to say', () => {
    render(<TooltipProvider><IconButton>x</IconButton></TooltipProvider>);
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
