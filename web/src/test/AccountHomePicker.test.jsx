import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountHomePicker } from '../views/AccountHomePicker.jsx';

const homes = [
  {
    domain: 'alpha.example', api_origin: 'https://api.alpha.example',
    name: 'Alpha', region: 'na-west', region_label: 'Oregon, US',
    operator_name: 'Alpha Cooperative', operator_contact: 'https://alpha.example/about',
    uptime_30d: 99.9, weight: 1,
  },
  {
    domain: 'beta.example', api_origin: 'https://accounts.beta.example:8443',
    name: 'Beta', region: 'na-east', region_label: 'Virginia, US',
    operator_name: 'Beta Foundation', operator_contact: 'mailto:ops@beta.example',
    uptime_30d: 99.8, weight: 1,
  },
  {
    domain: 'gamma.example', api_origin: 'https://gamma.example',
    name: 'Gamma', region: 'eu-west', region_label: 'Dublin, IE',
    operator_name: 'Gamma Community', operator_contact: 'https://gamma.example/contact',
    uptime_30d: 100, weight: 1,
  },
];

describe('AccountHomePicker', () => {
  it('preselects a verified community home locally and lets the user change it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSelect = vi.fn();
    const loadRecommendations = vi.fn().mockResolvedValue({ servers: homes, reason: null });

    render(
      <AccountHomePicker
        value=""
        onChange={onChange}
        onSelect={onSelect}
        loadRecommendations={loadRecommendations}
        random={() => 0.4}
      />,
    );

    await screen.findByText('Beta');
    expect(loadRecommendations).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('');
    expect(onChange).toHaveBeenCalledWith('https://accounts.beta.example:8443');
    expect(onSelect).toHaveBeenLastCalledWith(homes[1]);
    expect(screen.queryByLabelText('Home server')).toBeNull();
    expect(screen.getByText('Virginia, US · 99.8% recent uptime')).toBeTruthy();
    const operator = screen.getByRole('link', { name: 'Beta Foundation' });
    expect(operator.getAttribute('href')).toBe('mailto:ops@beta.example');

    await user.click(screen.getByRole('button', { name: 'Choose a different one' }));
    await user.click(screen.getByRole('button', { name: /Gamma/ }));
    expect(onChange).toHaveBeenLastCalledWith('https://gamma.example');
    expect(onSelect).toHaveBeenLastCalledWith(homes[2]);
    expect(screen.getByText('Dublin, IE · 100% recent uptime')).toBeTruthy();
  });

  it('falls back to an explicit homeserver field when no verified recommendation exists', async () => {
    const onChange = vi.fn();
    const loadRecommendations = vi.fn().mockResolvedValue({
      servers: [],
      reason: 'no_pinned_key',
    });

    render(
      <AccountHomePicker
        value=""
        onChange={onChange}
        loadRecommendations={loadRecommendations}
      />,
    );

    await screen.findByText(/No verified community recommendation is available/);
    expect(screen.getByLabelText('Home server')).toBeTruthy();
    expect(screen.getByText(/has not pinned the recommendation signing key/)).toBeTruthy();
  });

  it('does not keep a previous implicit home while recommendation loading is in flight', async () => {
    let resolve;
    const loadRecommendations = vi.fn(() => new Promise((done) => { resolve = done; }));
    const onChange = vi.fn();

    render(
      <AccountHomePicker
        value="https://old.example"
        onChange={onChange}
        loadRecommendations={loadRecommendations}
        random={() => 0}
      />,
    );

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
    resolve({ servers: homes, reason: null });
    await screen.findByText('Alpha');
  });

  it('restores the existing-account home when registration mode ends', async () => {
    const onChange = vi.fn();
    const loadRecommendations = vi.fn().mockResolvedValue({ servers: homes, reason: null });
    const { unmount } = render(
      <AccountHomePicker
        value="https://existing-home.example"
        onChange={onChange}
        loadRecommendations={loadRecommendations}
        random={() => 0}
      />,
    );

    await screen.findByText('Alpha');
    expect(onChange).toHaveBeenLastCalledWith('https://api.alpha.example');

    unmount();
    expect(onChange).toHaveBeenLastCalledWith('https://existing-home.example');
  });
});
