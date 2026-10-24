import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tabs } from '../components/index.js';

const pairs = [['general', 'General'], ['roles', 'Roles'], ['bans', 'Bans']];

describe('Tabs', () => {
  it('draws a tab per option, labelled by the second half of the pair', () => {
    render(<Tabs value="general" options={pairs} onChange={() => {}} />);

    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'General' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Roles' })).toBeTruthy();
  });

  it('marks the one that is selected, and only that one', () => {
    render(<Tabs value="roles" options={pairs} onChange={() => {}} />);

    expect(screen.getByRole('tab', { name: 'Roles' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
  });

  it('hands back the key, which is what the pane switches on', () => {
    const change = vi.fn();
    render(<Tabs value="general" options={pairs} onChange={change} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Bans' }));

    expect(change).toHaveBeenCalledWith('bans');
  });

  it('takes a bare string as both the key and the label', () => {
    const change = vi.fn();
    render(<Tabs value="General" options={['General', 'Roles']} onChange={change} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Roles' }));

    expect(change).toHaveBeenCalledWith('Roles');
  });

  it('matches a numeric key against the value it was given', () => {
    render(<Tabs value="2" options={[[1, 'One'], [2, 'Two']]} onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
  });

  it('draws nothing but an empty strip for no options', () => {
    render(<Tabs value="" options={[]} onChange={() => {}} />);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });
});
