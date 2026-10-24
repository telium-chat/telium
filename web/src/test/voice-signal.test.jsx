import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { store, voice } = vi.hoisted(() => ({
  store: {
    me: { user_id: '@alice:home.example' },
    channels: new Map([['voice-1', { name: 'General', guild_id: 'guild-1' }]]),
    guilds: new Map([['guild-1', { name: 'Telium' }]]),
    conversations: [],
    members: new Map(),
    voice: new Map(),
    on: () => () => {},
  },
  voice: {
    active: true,
    phase: 'connected',
    channelId: 'voice-1',
    joinedAt: Date.now(),
    ping: null,
    pingHistory: [],
    speaking: new Set(),
    local: { self_mute: false, self_deaf: false, self_video: false, streaming: false },
    leave: vi.fn(),
    toggle: vi.fn(),
    toggleStream: vi.fn(),
  },
}));

vi.mock('../hooks/useVoice.jsx', async (importOriginal) => ({
  ...(await importOriginal()),
  useVoice: () => voice,
}));

import { VoiceBar, connectionLevel } from '../views/VoiceBar.jsx';
import { StoreProvider } from '../hooks/useStore.jsx';
import { PING_WINDOW, recordPing } from '../hooks/useVoice.jsx';
import { expectNoViolations } from './a11y.js';

function meter(ping) {
  voice.ping = ping;
  const { container, unmount } = render(
    <StoreProvider store={store}><VoiceBar /></StoreProvider>,
  );
  const svg = container.querySelector('.signal');
  const result = {
    level: svg.dataset.level,
    lit: svg.querySelectorAll('.signal__rung[data-lit]').length,
    ink: svg.parentElement.className,
  };
  unmount();
  return result;
}

describe('connectionLevel', () => {
  it('reports nothing measured until a sample lands', () => {
    expect(connectionLevel(null)).toEqual({ bars: 0, level: 'unknown', tip: 'Measuring' });
    expect(connectionLevel(undefined)).toEqual({ bars: 0, level: 'unknown', tip: 'Measuring' });
  });

  it('calls anything under a tenth of a second good, at four rungs then three', () => {
    expect(connectionLevel(12)).toMatchObject({ bars: 4, level: 'ok' });
    expect(connectionLevel(59.4)).toMatchObject({ bars: 4, level: 'ok' });
    expect(connectionLevel(60)).toMatchObject({ bars: 3, level: 'ok' });
    expect(connectionLevel(119)).toMatchObject({ bars: 3, level: 'ok' });
  });

  it('escalates once the delay is one you would notice, then mention', () => {
    expect(connectionLevel(120)).toMatchObject({ bars: 2, level: 'fair' });
    expect(connectionLevel(249)).toMatchObject({ bars: 2, level: 'fair' });
    expect(connectionLevel(250)).toMatchObject({ bars: 1, level: 'poor' });
    expect(connectionLevel(4000)).toMatchObject({ bars: 1, level: 'poor' });
  });

  it('shows the round-trip time itself as the tooltip', () => {
    expect(connectionLevel(41.7).tip).toBe('42 ms');
  });
});

describe('the voice bar meter', () => {
  it('draws a healthy connection in the success colour, not as absent', () => {
    const good = meter(35);
    expect(good.level).toBe('ok');
    expect(good.lit).toBe(4);
    expect(good.ink).toContain('text-success');
  });

  it('keeps an unmeasured connection visually apart from a good one', () => {
    const asking = meter(null);
    expect(asking.level).toBe('unknown');
    expect(asking.lit).toBe(0);
    expect(asking.ink).not.toContain('text-success');
    expect(asking.ink).toContain('text-muted');
  });

  it('keeps the degraded tiers amber and red', () => {
    expect(meter(180).ink).toContain('text-warning');
    expect(meter(600).ink).toContain('text-danger');
  });

  it('leaves the sentence beside the meter in the plain foreground', () => {
    voice.ping = 30;
    render(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
    const line = screen.getByText('Voice connected');
    expect(line.className).toContain('text-foreground');
    expect(line.className).not.toContain('text-success');
  });

  it('says the round trip to a pointer, and holds its tongue while the panel is open', async () => {
    const user = userEvent.setup();
    voice.ping = 60;
    voice.pingHistory = [30, 45, 60];
    render(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
    const trigger = screen.getByRole('button', { name: '60 ms' });
    const meter = () => trigger.querySelector('svg');

    await user.hover(meter());
    expect(await screen.findAllByText('60 ms')).toHaveLength(1);
    expect(document.querySelector('.kumo-tooltip-popup')).toBeTruthy();

    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Ping history' });
    expect(trigger.querySelector('[data-base-ui-tooltip-trigger]')).toBeNull();

    await user.hover(meter());
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 600); });
    });
    expect(document.querySelector('.kumo-tooltip-popup')).toBeNull();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.unhover(meter());
    await user.hover(meter());
    expect(await screen.findAllByText('60 ms')).toHaveLength(1);
  });
});

function bar({ local = {}, mine = null } = {}) {
  voice.ping = 30;
  voice.local = { self_mute: false, self_deaf: false, self_video: false, streaming: false, ...local };
  store.voice = new Map([['voice-1', mine ? [{ user_id: '@alice:home.example', ...mine }] : []]]);
  const { unmount } = render(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
  return { unmount };
}

function mic() {
  const buttons = screen.getAllByRole('button');
  return buttons.find((b) => /mute|muted/i.test(b.getAttribute('aria-label') || ''));
}

function glyphOf(button) {
  return button.querySelector('svg').getAttribute('class') || '';
}

describe('the voice bar microphone square', () => {
  it('draws an open microphone when nothing is holding it shut', () => {
    const { unmount } = bar();
    const button = mic();
    expect(button.getAttribute('aria-label')).toBe('Mute');
    expect(glyphOf(button)).not.toContain('mic-off');
    expect(button.disabled).toBe(false);
    unmount();
  });

  it('draws a closed microphone once you mute yourself', () => {
    const { unmount } = bar({ local: { self_mute: true } });
    const button = mic();
    expect(button.getAttribute('aria-label')).toBe('Unmute');
    expect(glyphOf(button)).toContain('mic-off');
    unmount();
  });

  it('closes the microphone when a moderator has, and stops offering the press', () => {
    const { unmount } = bar({ mine: { server_mute: true } });
    const button = mic();
    expect(glyphOf(button)).toContain('mic-off');
    expect(button.getAttribute('aria-label')).toBe('Server muted');
    expect(button.disabled).toBe(true);
    unmount();
  });

  it('closes the microphone when you deafen yourself, because deafening does', () => {
    const { unmount } = bar({ local: { self_deaf: true } });
    const button = mic();
    expect(glyphOf(button)).toContain('mic-off');
    expect(button.getAttribute('aria-label')).toBe('Muted');
    expect(button.disabled).toBe(true);
    unmount();
  });

  it('closes the microphone when a moderator deafens you', () => {
    const { unmount } = bar({ mine: { server_deaf: true } });
    expect(glyphOf(mic())).toContain('mic-off');
    unmount();
  });

  it('reads the roster row for this account and not somebody else muted', () => {
    voice.ping = 30;
    voice.local = { self_mute: false, self_deaf: false, self_video: false, streaming: false };
    store.voice = new Map([['voice-1', [
      { user_id: '@bob:home.example', server_mute: true, server_deaf: true },
      { user_id: '@alice:home.example' },
    ]]]);
    const { unmount } = render(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
    const button = mic();
    expect(button.getAttribute('aria-label')).toBe('Mute');
    expect(glyphOf(button)).not.toContain('mic-off');
    unmount();
  });
});

describe('the voice bar headphone square', () => {
  function deaf() {
    return screen.getAllByRole('button')
      .find((b) => /deafen/i.test(b.getAttribute('aria-label') || ''));
  }

  it('offers the deafen it is not holding', () => {
    const { unmount } = bar();
    expect(deaf().getAttribute('aria-label')).toBe('Deafen');
    expect(deaf().disabled).toBe(false);
    unmount();
  });

  it('shows a moderator deafen as set, and not as yours to undo', () => {
    const { unmount } = bar({ mine: { server_deaf: true } });
    expect(deaf().getAttribute('aria-label')).toBe('Server deafened');
    expect(deaf().disabled).toBe(true);
    unmount();
  });
});

describe('the ping window', () => {
  it('keeps measurements in order and drops the oldest once the window is full', () => {
    let history = [];
    for (let i = 1; i <= PING_WINDOW + 5; i += 1) history = recordPing(history, i * 3);
    expect(history).toHaveLength(PING_WINDOW);
    expect(history[0]).toBe(6 * 3);
    expect(history[history.length - 1]).toBe((PING_WINDOW + 5) * 3);
  });

  it('leaves out a measurement that never arrived rather than charting it as zero', () => {
    expect(recordPing([40], null)).toEqual([40]);
    expect(recordPing([40], undefined)).toEqual([40]);
    expect(recordPing([], null)).toEqual([]);
  });
});

function renderMeter(history, ping) {
  voice.ping = ping;
  voice.pingHistory = history;
  voice.local = { self_mute: false, self_deaf: false, self_video: false, streaming: false };
  return render(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
}

function figure(dialog, label) {
  const dt = within(dialog).getByText(label);
  return dt.parentElement.querySelector('dd').textContent;
}

describe('the ping history panel', () => {
  it('opens off the meter and states the window average and the newest sample', async () => {
    const user = userEvent.setup();
    renderMeter([30, 45, 60], 60);
    const trigger = screen.getByRole('button', { name: '60 ms' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Ping history' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(figure(dialog, 'Average')).toBe('45 ms');
    expect(figure(dialog, 'Last ping')).toBe('60 ms');
    expect([...dialog.querySelectorAll('dt')].map((dt) => dt.textContent))
      .toEqual(['Average', 'Last ping']);
    expect([...dialog.querySelectorAll('dd')].map((dd) => dd.textContent))
      .toEqual(['45 ms', '60 ms']);
    expect(within(dialog).queryByText('100 ms')).toBeNull();
    expect(dialog.querySelectorAll('rect')).toHaveLength(3);
    expect(dialog.querySelector('.ping-graph__avg')).toBeTruthy();
  });

  it('closes on a second press and on Escape, with focus back on the meter', async () => {
    const user = userEvent.setup();
    renderMeter([40], 40);
    const trigger = screen.getByRole('button', { name: '40 ms' });

    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Ping history' });
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Ping history' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('counts a sample that lands while the panel is open', async () => {
    const user = userEvent.setup();
    const view = renderMeter([40], 40);
    await user.click(screen.getByRole('button', { name: '40 ms' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ping history' });
    expect(figure(dialog, 'Average')).toBe('40 ms');

    voice.pingHistory = [40, 60];
    view.rerender(<StoreProvider store={store}><VoiceBar /></StoreProvider>);
    expect(figure(dialog, 'Average')).toBe('50 ms');
    expect(figure(dialog, 'Last ping')).toBe('60 ms');
    expect(dialog.querySelectorAll('rect')).toHaveLength(2);
  });

  it('answers a window with nothing in it the way the meter does, not with a zero', async () => {
    const user = userEvent.setup();
    renderMeter([], null);
    await user.click(screen.getByRole('button', { name: 'Measuring' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ping history' });
    expect(within(dialog).getByText('Measuring')).toBeTruthy();
    expect(within(dialog).queryByText('Average')).toBeNull();
    expect(within(dialog).queryByText('Last ping')).toBeNull();
    expect(dialog.querySelector('dl')).toBeNull();
    expect(dialog.querySelectorAll('rect')).toHaveLength(0);
    expect(dialog.querySelector('.ping-graph__avg')).toBeNull();
  });

  it('draws a single sample against the newest slot, with the two figures equal', async () => {
    const user = userEvent.setup();
    renderMeter([42], 42);
    await user.click(screen.getByRole('button', { name: '42 ms' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ping history' });
    const bars = dialog.querySelectorAll('rect');
    expect(bars).toHaveLength(1);
    expect(Number(bars[0].getAttribute('x'))).toBeGreaterThan(98);
    expect(figure(dialog, 'Average')).toBe('42 ms');
    expect(figure(dialog, 'Last ping')).toBe('42 ms');
  });

  it('is free of accessibility violations, open on the meter', async () => {
    const user = userEvent.setup();
    const view = renderMeter([30, 45, 60], 60);
    await user.click(screen.getByRole('button', { name: '60 ms' }));
    await screen.findByRole('dialog', { name: 'Ping history' });
    await expectNoViolations(view, 'the open ping history panel');
  });
});
