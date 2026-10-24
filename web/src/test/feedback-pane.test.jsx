import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { UserSettings } from '../views/user-settings/UserSettings.jsx';
import { FeedbackPane } from '../views/user-settings/FeedbackPane.jsx';
import { mount, signedInStore } from './harness.jsx';

const clipboard = vi.fn();
const opened = [];

function pane() {
  const store = signedInStore();
  const view = mount(<FeedbackPane />, store);
  clipboard.mockClear();
  opened.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard },
  });
  window.open = (url) => { opened.push(url); return null; };
  return view;
}

const setDetails = async (user, text) => {
  await user.type(screen.getByLabelText(/Details/), text);
};

const chooseKind = async (user, label) => {
  await user.click(screen.getByRole('combobox', { name: /What is this about/ }));
  await user.click(within(await screen.findByRole('listbox')).getByRole('option', { name: label }));
};

describe('FeedbackPane', () => {
  it('arms the buttons only once there is something to send', async () => {
    const { user } = pane();
    const open = screen.getByRole('button', { name: 'Open GitHub' });
    const copy = screen.getByRole('button', { name: 'Copy report' });
    expect(open.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
    await setDetails(user, 'It broke when I opened settings.');
    expect(open.disabled).toBe(false);
    expect(copy.disabled).toBe(false);
  });

  it('a bug attaches diagnostics by default; an idea does not', async () => {
    const { user } = pane();
    const state = () => screen.getByRole('checkbox', { name: /Attach diagnostics/ }).getAttribute('aria-checked');
    expect(state()).toBe('true');

    await chooseKind(user, 'A feature idea');
    expect(state()).toBe('false');

    await chooseKind(user, 'Something is broken');
    expect(state()).toBe('true');
  });

  it('copy hands the reporter the whole report, headings first', async () => {
    const { user } = pane();
    await setDetails(user, 'It broke when I opened settings.');
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    const text = clipboard.mock.calls[0][0];
    expect(text).toContain('### What happened');
    expect(text).toContain('It broke when I opened settings.');
    expect(text).toContain('### Diagnostics');
    expect(text).toContain('```json');
  });

  it('open hands a pre-filled bug link to the browser, and nothing is sent from here', async () => {
    const { user } = pane();
    await setDetails(user, 'It broke when I opened settings.');
    await user.click(screen.getByRole('button', { name: 'Open GitHub' }));
    await waitFor(() => expect(opened.length).toBe(1));
    const url = new URL(opened[0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/telium-chat/telium/issues/new');
    expect(url.searchParams.get('labels')).toBe('bug');
    expect(url.searchParams.get('body')).toContain('It broke when I opened settings.');
  });

  it('the doing field files under its own heading, complete on arrival', async () => {
    const { user } = pane();
    await setDetails(user, 'It broke when I opened settings.');
    await user.type(
      screen.getByLabelText('What were you doing?'),
      'I was renaming a channel the moment the socket dropped.',
    );
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    const text = clipboard.mock.calls[0][0];
    expect(text).toContain(
      '### What I was doing\n\nI was renaming a channel the moment the socket dropped.',
    );
    expect(text).not.toContain('<!-- Replace this line');
  });

  it('the doing field follows the kind: a problem for ideas, nothing for other', async () => {
    const { user } = pane();
    expect(screen.getByLabelText('What were you doing?')).toBeTruthy();

    await chooseKind(user, 'A feature idea');
    expect(screen.getByLabelText("What's the problem?")).toBeTruthy();
    expect(screen.queryByLabelText('What were you doing?')).toBeNull();

    await chooseKind(user, 'Something else');
    expect(screen.queryByLabelText("What's the problem?")).toBeNull();
  });

  it('a checkbox unticked is a report without diagnostics', async () => {
    const { user } = pane();
    await setDetails(user, 'It broke.');
    fireEvent.click(screen.getByRole('checkbox', { name: /Attach diagnostics/ }));
    expect(screen.getByRole('checkbox', { name: /Attach diagnostics/ }).getAttribute('aria-checked')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    expect(clipboard.mock.calls[0][0]).not.toContain('### Diagnostics');
  });

  it('the preview shows exactly what would be attached before anything happens', async () => {
    const { user } = pane();
    await user.click(screen.getByText('Show what would be attached'));
    await waitFor(() => expect(screen.getByText(/"generated_at"/)).toBeTruthy());
  });

  it('the settings dialog lists the pane, finds it, and opens it from the footer', async () => {
    const { user } = mount(<UserSettings close={() => {}} />, signedInStore());
    const filter = screen.getByLabelText('Filter settings');
    await user.type(filter, 'feedback');
    await user.click(await screen.findByText('Help & feedback'));
    expect(await screen.findByText('What is this about?')).toBeTruthy();
    await user.click(screen.getByTitle(/open Help & feedback/));
    expect(screen.getByText('What is this about?')).toBeTruthy();
  });
});
